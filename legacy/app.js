'use strict';

const $ = (id) => document.getElementById(id);

/* 后端引擎实例（纯数据源，UI 只订阅渲染） */
const engine = new RunnerEngine();

const CIRC = 527.79; // 心率环周长
let manualBpm = false; // 用户是否手动覆盖了 BPM

/* ---------- 工具 ---------- */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 1800);
}

function showVoice(text) {
  const v = $('voiceToast');
  v.textContent = '天依：' + text;
  v.classList.add('show');
  clearTimeout(v._t);
  v._t = setTimeout(() => v.classList.remove('show'), 4200);
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
}

/* ---------- 阶段条 ---------- */
function buildPhaseBar() {
  const bar = $('phaseBar');
  bar.innerHTML = '';
  engine.stages.forEach((s) => {
    const d = document.createElement('div');
    d.className = 'phase';
    d.id = 'phase-' + s.id;
    d.textContent = s.name;
    bar.appendChild(d);
  });
}

/* ---------- 心率环 ---------- */
function renderHR(pct, bpm, zone) {
  const p = Math.min(1, (pct || 0) / 100);
  $('hrRing').style.strokeDashoffset = (CIRC * (1 - p)).toFixed(2);
  $('hrValue').textContent = (bpm === null || bpm === undefined) ? '--' : bpm;
  if (zone) $('hrZone').textContent = zone;
}

/* ---------- 订阅引擎事件 ---------- */
engine.on('state', (s) => {
  const chip = $('stateChip');
  const btn = $('btnStart');
  if (s === 'running') {
    chip.textContent = '训练中'; chip.classList.add('active');
    btn.textContent = '暂停'; btn.classList.add('pause');
    $('btnStop').disabled = false;
  } else if (s === 'paused') {
    chip.textContent = '已暂停'; chip.classList.add('active');
    btn.textContent = '继续'; btn.classList.add('pause');
    $('btnStop').disabled = false;
  } else if (s === 'finished') {
    chip.textContent = '已完成'; chip.classList.add('active');
    btn.textContent = '开始训练'; btn.classList.remove('pause');
    $('btnStop').disabled = true;
  } else {
    chip.textContent = '待机'; chip.classList.remove('active');
    btn.textContent = '开始训练'; btn.classList.remove('pause');
    $('btnStop').disabled = true;
  }
});

engine.on('stage', (stage, index) => {
  engine.stages.forEach((s, i) => {
    const el = $('phase-' + s.id);
    if (!el) return;
    el.classList.toggle('active', i === index);
    el.classList.toggle('done', index >= 0 && i < index);
  });
});

engine.on('bpm', (bpm) => { $('curBpm').textContent = bpm; });

engine.on('beat', (beat, accent, time) => {
  const ctx = engine.metronome.ctx;
  if (!ctx) return;
  const delay = Math.max(0, (time - ctx.currentTime) * 1000);
  setTimeout(() => {
    const dot = $('beatDot');
    dot.classList.remove('hit', 'accent');
    void dot.offsetWidth;
    dot.classList.add(accent ? 'accent' : 'hit');
  }, delay);
});

engine.on('voice', ({ text }) => { if (text) showVoice(text); });
engine.on('cheer', (text) => { if (text) showVoice(text); });

engine.on('heartrate', (d) => {
  const z = engine.zoneOf(d.bpm);
  renderHR(z.pct, d.bpm, z.label);
});

engine.on('hrstate', (on) => {
  $('btnConnectHR').textContent = on ? '已连接' : '连接手表';
  if (!on) renderHR(0, null, '未连接手表');
});

engine.on('tick', ({ elapsed, bpm }) => {
  $('timer').textContent = fmt(elapsed);
  $('curBpm').textContent = bpm;
  $('metroBpm').textContent = bpm;
  if (!manualBpm) $('bpmSlider').value = bpm;
});

/* ---------- 训练控制 ---------- */
$('btnStart').onclick = () => {
  if (engine.state === 'running') engine.pause();
  else if (engine.state === 'paused') engine.resume();
  else { manualBpm = false; engine.start(); }
};

$('btnStop').onclick = () => {
  engine.stop();
  $('timer').textContent = '00:00';
  $('curBpm').textContent = engine.stages[0].startBpm;
};

/* ---------- 年龄 ---------- */
$('ageInput').onchange = () => engine.setAge(parseInt($('ageInput').value, 10) || 20);

/* ---------- 节拍器手动微调 ---------- */
$('bpmSlider').oninput = () => {
  manualBpm = true;
  const v = parseInt($('bpmSlider').value, 10);
  $('metroBpm').textContent = v;
  engine.metronome.setBpm(v);
};

/* ---------- 心率连接 ---------- */
$('btnConnectHR').onclick = async () => {
  if (!engine.heartRate.supported) { toast('当前浏览器不支持蓝牙'); return; }
  try {
    await engine.heartRate.connect();
  } catch (e) {
    toast('连接失败：' + (e && e.message ? e.message : e));
  }
};

/* ---------- 音乐 ---------- */
const fileInput = $('musicFile');
$('musicCover').onclick = () => fileInput.click();
$('musicInfo').onclick = () => fileInput.click();
fileInput.onchange = () => { if (fileInput.files[0]) loadMusic(fileInput.files[0]); };

function loadMusic(file) {
  engine.music.load(file);
  $('musicInfo').textContent = file.name;
  $('btnPlayMusic').disabled = false;
  $('musicCover').textContent = '♪';
  engine.music.audio.onended = () => {
    engine.music.playing = false;
    $('btnPlayMusic').textContent = '▶';
  };
}

$('btnPlayMusic').onclick = () => {
  engine.music.toggle();
  $('btnPlayMusic').textContent = engine.music.playing ? '❚❚' : '▶';
};

$('btnSyncBpm').onclick = () => {
  const b = parseInt($('musicBpm').value, 10);
  if (b) {
    manualBpm = true;
    $('bpmSlider').value = b;
    $('metroBpm').textContent = b;
    engine.metronome.setBpm(b);
    toast('节拍器已同步到 ' + b + ' BPM');
  }
};

/* ---------- 语音试听 ---------- */
$('btnTestVoice').onclick = () => {
  engine.voice.speak('test', '加油哦，天依相信你！', 'jiayou');
};

/* ---------- Tab Bar ---------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => { if (tab.dataset.tab !== 'train') toast('预览版仅开放「训练」页'); };
});

/* ---------- 初始化 ---------- */
buildPhaseBar();
$('curBpm').textContent = engine.stages[0].startBpm;
$('metroBpm').textContent = $('bpmSlider').value;
