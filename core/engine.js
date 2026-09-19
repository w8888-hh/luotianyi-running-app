/* =========================================================
   RUN·陪跑 后端引擎 v0.2
   —— 纯逻辑层，不依赖任何 DOM，UI 由另一套前端对接。

   职责：
   1. 节拍器（Web Audio 前瞻调度，支持 BPM 实时渐变）
   2. 音乐播放
   3. 语音引导（洛天依本地音频优先 + 系统 TTS 回退 + 队列串行）
   4. 心率采集（Web Bluetooth / Heart Rate Service）
   5. 训练流程（阶段推进、BPM 线性渐升、阶段提示 + 随机鼓励语）

   使用：
   <script src="core/engine.js"></script>
   const engine = new RunnerEngine({ ...见 API.md });
   ========================================================= */
(function (global) {
  'use strict';

  /* ---------- 事件发射器 ---------- */
  class Emitter {
    constructor() { this._h = Object.create(null); }
    on(ev, fn) { (this._h[ev] || (this._h[ev] = [])).push(fn); return this; }
    off(ev, fn) {
      const a = this._h[ev];
      if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
      return this;
    }
    emit(ev, ...args) { (this._h[ev] || []).slice().forEach((fn) => fn(...args)); }
  }

  /* ---------- 默认数据 ---------- */
  const DEFAULT_STAGES = [
    { id: 'warmup',   name: '热身', startBpm: 100, endBpm: 115, dur: 120, voiceId: 'reshen',  voice: '先慢慢跑哦，跟着天依的节奏，深呼吸～', hr: { nextAbovePct: 60, minSec: 20, maxSec: 240 } },
    { id: 'build',    name: '燃脂', startBpm: 125, endBpm: 145, dur: 180, voiceId: 'ranzhi',  voice: '进入燃脂区啦，保持节奏，脂肪在燃烧哦～', hr: { nextAbovePct: 80, minSec: 30, maxSec: 480 } },
    { id: 'peak',     name: '冲刺', startBpm: 160, endBpm: 175, dur: 240, voiceId: 'chongci', voice: '冲刺时间到！全力以赴，天依陪你冲——！', hr: { nextBelowPct: 85, minSec: 60, maxSec: 300 } },
    { id: 'cooldown', name: '放松', startBpm: 130, endBpm: 105, dur: 150, voiceId: 'fangsong', voice: '最后啦，放慢脚步深呼吸，我们一起慢慢来～', hr: { minSec: 30, maxSec: 180 } },
  ];

  /* 跟随跑的心率四区间：区间由「心率 / 最大心率」的百分比决定，
     每个区间给一个固定目标步频 —— 节拍器按这个固定值打，
     用户步频被锁住，配速就不会忽快忽慢（区间内不随心率连续变化）。*/
  const FOLLOW_STAGES = [
    { id: 'z1', name: '热身', hrBand: [0, 60],   bpm: 150, minSec: 120, voiceId: 'reshen',   voice: '先慢慢跑哦，跟着天依的节奏，深呼吸～' },
    { id: 'z2', name: '燃脂', hrBand: [60, 70],  bpm: 162, minSec: 180, voiceId: 'ranzhi',   voice: '进入燃脂区啦，保持这个节奏，脂肪在燃烧哦～' },
    { id: 'z3', name: '有氧', hrBand: [70, 80],  bpm: 172, minSec: 180, voiceId: 'maikaibu', voice: '有氧区间，迈开步子，稳住呼吸和步频～' },
    { id: 'z4', name: '强化', hrBand: [80, 200], bpm: 182, minSec: 120, voiceId: 'chongci',  voice: '强度上来啦，跟着节拍全力以赴！' },
  ];

  // 引导跑四阶段的默认占比（由 DEFAULT_STAGES 的固定时长换算，和为 1）
  const DEFAULT_STAGE_RATIOS = (function () {
    const s = DEFAULT_STAGES.reduce((a, x) => a + x.dur, 0);
    return DEFAULT_STAGES.map((x) => x.dur / s);
  }());

  // 跟随跑：心率换算出的目标步频允许在本区间标准值上下波动的幅度。
  // 有它，用户加速时节拍会跟着加速；有上界，就不会越界跑到下一个区间去。
  const FOLLOW_BPM_SLACK = 6;

  /* 自定义跑：用户自己定一个固定步频。
     全程就是这一个值 —— 不分阶段、不随心率变、不自动结束，跑多久由用户自己按「结束」。
     只有一个阶段条目，是为了让 _applyStage / 语音播报这套已有机制能原样复用。*/
  const CUSTOM_STAGE = {
    id: 'custom', name: '自定义', bpm: 170,
    voiceId: 'maikaibu', voice: '按你定好的步频跑，天依全程陪着你～',
  };
  // 步频允许的上下限：低于 60 不像跑步，高于 220 没人跟得上（也防止手滑输成 1700）
  const CUSTOM_BPM_RANGE = [60, 220];
  const DEFAULT_CUSTOM_BPM = 170;

  const DEFAULT_START_VOICE = { voiceId: 'zhunbei', voice: '准备好啦～三、二、一，跟天依一起出发吧！' };
  const DEFAULT_END_VOICE   = { voiceId: 'jieshu',  voice: '训练完成啦！天依觉得你好棒，记得拉伸放松哦～' };
  const DEFAULT_PAUSE_VOICE = { voiceId: 'zanting', voice: '运动暂停！休息一下再继续吧！' };
  const DEFAULT_RESUME_VOICE = { voiceId: 'kaishi', voice: '运动开始！加油呀！' };

  /* 中间穿插的鼓励语（随机、不重复） */
  const DEFAULT_CHEERS = [
    { voiceId: 'jiayou',    voice: '加油哦，天依相信你！' },
    { voiceId: 'jianchi',   voice: '再坚持一下下，就快到啦～' },
    { voiceId: 'huxi',      voice: '稳住呼吸，跟着节拍一起哦～' },
    { voiceId: 'henbang',   voice: '很棒很棒，就是这个节奏！' },
    { voiceId: 'songjian',  voice: '肩膀放松，天依陪你跑～' },
    { voiceId: 'zaiyici',   voice: '再坚持一下，胜利就在前面啦！' },
    { voiceId: 'maikaibu',  voice: '迈开步子，跑出属于自己的节奏呀！' },
    { voiceId: 'chongya',   voice: '快到了，冲鸭——！' },
  ];

  /* ---------- 节拍器 ---------- */
  class Metronome {
    constructor() {
      this.ctx = null;
      this.masterGain = null;
      this.volume = 1;
      this.bpm = 120;
      this.beatsPerBar = 4;
      this.nextNoteTime = 0;
      this.currentBeat = 0;
      this.timer = null;
      this.running = false;
      this.lookahead = 25;        // 调度间隔 ms
      this.scheduleAhead = 0.12;  // 提前调度秒
      this.onBeat = null;         // (beatIndex, isAccent, audioTime) => void
      // 音色：wood=木块/木鱼（默认，有敲击感）；click=纯电子方波（穿透力强，嘈杂环境下更听得清）
      this.tone = 'wood';
      this._nb = null;            // 预生成的白噪声 buffer（复用，避免每拍都现造）
    }

    ensureCtx() {
      if (!this.ctx) {
        const AC = global.AudioContext || global.webkitAudioContext;
        this.ctx = new AC();
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);
      }
      return this.ctx;
    }

    // 半秒白噪声，循环复用。“敲”的质感全靠它，方波是做不出木质感的。
    _noiseBuf() {
      if (this._nb) return this._nb;
      const ctx = this.ctx;
      const len = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._nb = buf;
      return buf;
    }

    setTone(t) { this.tone = (t === 'click') ? 'click' : 'wood'; return this.tone; }

    /* 木块音色：两层叠加，模拟真实打击乐
       ① 噪声瞬态过带通 —— 敲击那一瞬的“哒”，没有它听起来就是纯电子音
       ② 三角波 + 起音下滑（起始高 1.5 倍再滑到基频）—— 木块自身的共鸣体
       ③ 整体过低通 —— 削掉方波那种扎耳朵的高频
       两层各自独立包络，且都比原来的 50ms 长一点，才有“余韵”而不是“滴”一声就断。*/
    _clickWood(beatIndex, time) {
      const ctx = this.ctx;
      const out = this.masterGain || ctx.destination;
      const accent = beatIndex % this.beatsPerBar === 0;

      // ① 敲击瞬态
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuf();
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = accent ? 2600 : 1750;
      bp.Q.value = accent ? 1.6 : 2.2;
      const ng = ctx.createGain();
      const ndur = accent ? 0.038 : 0.024;
      ng.gain.setValueAtTime(0.0001, time);
      ng.gain.exponentialRampToValueAtTime(accent ? 0.34 : 0.22, time + 0.001);
      ng.gain.exponentialRampToValueAtTime(0.0001, time + ndur);
      src.connect(bp); bp.connect(ng); ng.connect(out);
      // 随机取一段噪声，避免每拍完全一致显得像机器复读
      src.start(time, Math.random() * 0.3);
      src.stop(time + ndur + 0.01);

      // ② 共鸣体
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const f0 = accent ? 1720 : 1060;
      osc.frequency.setValueAtTime(f0 * 1.5, time);
      osc.frequency.exponentialRampToValueAtTime(f0, time + 0.012); // 起音下滑 = 敲击感的关键
      const og = ctx.createGain();
      const odur = accent ? 0.09 : 0.058;
      og.gain.setValueAtTime(0.0001, time);
      og.gain.exponentialRampToValueAtTime(accent ? 0.34 : 0.20, time + 0.002);
      og.gain.exponentialRampToValueAtTime(0.0001, time + odur);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = accent ? 5200 : 3800;
      osc.connect(og); og.connect(lp); lp.connect(out);
      osc.start(time);
      osc.stop(time + odur + 0.01);
    }

    // 原来的方波：刺耳但穿透力强，环境嘈杂时可能反而更好用
    _clickTone(beatIndex, time) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(this.masterGain || ctx.destination);
      const accent = beatIndex % this.beatsPerBar === 0;
      osc.type = 'square';
      osc.frequency.value = accent ? 1560 : 1040;
      gain.gain.setValueAtTime(accent ? 0.5 : 0.3, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
      osc.start(time); osc.stop(time + 0.06);
    }

    _click(beatIndex, time) {
      if (this.tone === 'click') this._clickTone(beatIndex, time);
      else this._clickWood(beatIndex, time);
      const accent = beatIndex % this.beatsPerBar === 0;
      if (this.onBeat) this.onBeat(beatIndex, accent, time);
    }

    _scheduler = () => {
      while (this.nextNoteTime < this.ctx.currentTime + this.scheduleAhead) {
        this._click(this.currentBeat, this.nextNoteTime);
        this.nextNoteTime += 60 / this.bpm;
        this.currentBeat++;
      }
    };

    start() {
      this.ensureCtx();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (this.masterGain) {
        this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
      }
      this.currentBeat = 0;
      this.nextNoteTime = this.ctx.currentTime + 0.06;
      this._scheduler();
      this.timer = setInterval(this._scheduler, this.lookahead);
      this.running = true;
    }

    stop() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      // 立即静音，停掉已前瞻调度的残余节拍
      if (this.masterGain && this.ctx) {
        this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.masterGain.gain.setValueAtTime(0, this.ctx.currentTime);
      }
      this.running = false;
    }

    setBpm(bpm) { this.bpm = Math.max(30, Math.min(300, bpm)); }

    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      if (this.masterGain && this.ctx && this.running) {
        this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
      }
    }
  }

  /* ---------- 音乐 BPM 检测（能量包络 + 自相关） ---------- */
  function detectBPM(audioBuffer) {
    try {
      const full = audioBuffer.getChannelData(0);
      const sr = audioBuffer.sampleRate;
      // 只分析前 40 秒：足够判断节奏，又能大幅减少计算量
      const data = full.subarray(0, Math.min(full.length, Math.floor(sr * 40)));
      const frame = Math.floor(sr * 0.02); // 20ms 一帧
      const env = [];
      for (let i = 0; i + frame <= data.length; i += frame) {
        let e = 0;
        for (let j = 0; j < frame; j++) { const v = data[i + j]; e += v * v; }
        env.push(e / frame);
      }
      if (env.length < 64) return null;
      const onset = [];
      for (let i = 1; i < env.length; i++) onset.push(Math.max(0, env[i] - env[i - 1]));
      let bestBpm = 0, bestScore = -Infinity;
      const fps = sr / frame;
      for (let bpm = 60; bpm <= 180; bpm++) {
        const lag = Math.round((60 / bpm) * fps);
        if (lag <= 0 || lag >= onset.length) continue;
        let score = 0;
        const n = onset.length - lag;
        for (let i = 0; i < n; i++) score += onset[i] * onset[i + lag];
        if (score > bestScore) { bestScore = score; bestBpm = bpm; }
      }
      return bestBpm || null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- BPM 曲库：先按「名称+时长」匹配，命中就免去解码分析 ---------- */
  const DETECT_BYTES = 1200 * 1024; // 检测时最多读取的字节数（够覆盖高码率歌曲的 26 秒分析窗口）
  const LOSSLESS_RE = /\.(flac|wav|ape|alac|aiff?|wv|tta)$/i; // 无损：单位字节解出的音频更短
  const DETECT_TIMEOUT_MS = 15000; // 单首检测硬超时：超时就放弃，防止解码卡死拖崩整个 App
  const AUTO_DETECT_LIMIT = 3;     // 导入后最多自动检测前 N 首，其余等切到那首时再算

  const BpmLibrary = {
    builtin: null,   // 内置曲库 [[name, artist, durSec, bpm], ...]
    index: null,     // 规范化名称 -> 条目数组
    local: null,     // 本地学习库：检测过的歌下次直接命中（重启恢复也不用重算）
    loading: null,
    LOCAL_KEY: 'bpmLocalLib',

    // 单一规范化（去扩展名/括号/后缀/非字母数字中文）
    _norm(name) {
      let s = String(name || '');
      s = s.replace(/\.[a-z0-9]{2,5}$/i, '');  // 去扩展名
      s = s.replace(/\([^)]*\)/g, '');         // 去 (...)
      s = s.replace(/\[[^\]]*\]/g, '');        // 去 [...]
      s = s.split(' - ')[0];                   // 去 " - Remix" 之类后缀
      return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
    },

    _clean(s) {
      return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
    },

    // 拆「艺人 - 歌曲」：兼容 - – — − _ | / · 等分隔符，也兼容「01 - 歌名」序号前缀
    // 例：「洛天依 - 心音」→ {artist:'洛天依', title:'心音'}
    //     「周杰伦-七里香」→ {artist:'周杰伦', title:'七里香'}
    _splitArtistTitle(s) {
      let t = String(s || '').replace(/[–—−‐‑﹘]/g, '-');
      let parts = null;
      const spaced = t.split(' - ');
      if (spaced.length >= 2) {
        parts = [spaced[0], spaced.slice(1).join(' - ')];
      } else {
        // 无空格分隔：要求分隔符两侧都有内容，且不是纯数字连字符（如「A-1」）
        const m = t.match(/^(.+?)\s*[-_|/·]\s*(.+)$/);
        if (m && !/^\d+$/.test(m[1].trim()) && !/^\d+$/.test(m[2].trim())) parts = [m[1], m[2]];
      }
      if (!parts) return null;
      let a = String(parts[0] || '').trim();
      let b = String(parts[1] || '').trim();
      b = b.replace(/^\d{1,3}[.、)\s]+/, ''); // 去掉「01. 歌名」的序号
      if (!a || !b || a.length > 60 || b.length > 80) return null;
      if (/^\d{1,3}$/.test(a)) return null;   // 左边是纯序号（"01 - 歌名"），不算艺人
      return { artist: a, title: b };
    },

    // 多键匹配：应对「歌手 - 歌名」「歌名 - Remix」「歌名」等各种命名
    // 例："洛天依 - 心音" → [洛天依心音, 心音, 洛天依, 洛天依心音, 心音洛天依]
    _keys(name) {
      let s = String(name || '');
      s = s.replace(/\.[a-z0-9]{2,5}$/i, '')
           .replace(/\([^)]*\)/g, '')
           .replace(/\[[^\]]*\]/g, '');
      const keys = [this._clean(s)];
      const p = this._splitArtistTitle(s);
      if (p) {
        const cT = this._clean(p.title), cA = this._clean(p.artist);
        keys.push(cT, cA);
        keys.push(this._clean(p.artist + p.title));  // 「艺人歌名」连写（忽略分隔符）
        keys.push(this._clean(p.title + p.artist));  // 顺序反了也能命中
      }
      return Array.from(new Set(keys.filter((k) => k.length >= 2)));
    },

    _ensureLocal() {
      if (this.local) return;
      try { this.local = JSON.parse(localStorage.getItem(this.LOCAL_KEY) || '{}'); }
      catch (e) { this.local = {}; }
    },

    _saveLocal() {
      try { localStorage.setItem(this.LOCAL_KEY, JSON.stringify(this.local)); } catch (e) {}
    },

    // 懒加载内置曲库（首次需要时才拉，不拖慢启动）
    ready() {
      if (this.builtin) return Promise.resolve(this);
      if (this.loading) return this.loading;
      this._ensureLocal();
      this.loading = fetch('assets/bpm_library.json')
        .then((r) => r.json())
        .then((data) => {
          this.builtin = (data && data.songs) || [];
          this.index = new Map();
          for (const s of this.builtin) {
            const set = new Set(this._keys(s[0]));
            // 额外补「艺人+歌名」连写键：曲库按 [歌名, 艺人] 存，文件名却是「艺人 - 歌名」
            const at = this._clean(String(s[1] || '') + String(s[0] || ''));
            const ta = this._clean(String(s[0] || '') + String(s[1] || ''));
            if (at.length >= 2) set.add(at);
            if (ta.length >= 2) set.add(ta);
            for (const k of set) {
              if (!this.index.has(k)) this.index.set(k, []);
              this.index.get(k).push(s);
            }
          }
          return this;
        })
        .catch(() => { this.builtin = []; this.index = new Map(); return this; });
      return this.loading;
    },

    // 候选里按时长挑最接近的（±8 秒算匹配成功）
    // 拿不到时长时：只有一个候选就用它，多个候选则放弃（避免张冠李戴）
    _pick(cands, duration) {
      if (!cands || !cands.length) return null;
      if (!duration) return cands.length === 1 ? cands[0][3] : null;
      let best = null, bestDiff = Infinity;
      for (const c of cands) {
        const diff = Math.abs((c[2] || 0) - duration);
        if (diff <= 8 && diff < bestDiff) { best = c; bestDiff = diff; }
      }
      return best ? best[3] : null;
    },

    lookup(name, duration) {
      this._ensureLocal();
      const keys = this._keys(name);
      if (!keys.length) return null;
      // 1) 本地学习库（同一个 App 之前处理过的歌，最快）
      for (const k of keys) {
        const loc = this.local[k];
        if (!loc) continue;
        const items = Array.isArray(loc[0]) ? loc : [loc];
        const hit = this._pick(items.map((x) => [name, '', x[0], x[1]]), duration);
        if (hit) return hit;
      }
      // 2) 内置曲库
      if (this.index) {
        for (const k of keys) {
          const hit = this._pick(this.index.get(k), duration);
          if (hit) return hit;
        }
      }
      return null;
    },

    // 检测成功后记下来，下次（含重启恢复）直接命中
    remember(name, duration, bpm) {
      if (!name || !bpm || !duration) return;
      this._ensureLocal();
      for (const k of this._keys(name)) {
        const list = this.local[k] || [];
        if (!list.some((x) => Math.abs(x[0] - duration) <= 5)) {
          list.push([Math.round(duration), Math.round(bpm)]);
          this.local[k] = list;
        }
      }
      this._saveLocal();
    },
  };

  /* ---------- 音乐播放器（歌单 + BPM 检测 + 顺序/随机 + 喜欢 + 推荐） ---------- */
  class MusicPlayer {
    constructor() {
      this.audio = null;
      this.playlist = [];  // [{ name, file, url, bpm, liked }]
      this.index = -1;     // 当前播放的 track 索引
      this.name = '';
      this.playing = false;
      this.volume = 1;
      this.mode = 'order'; // 'order' | 'shuffle'
      this.queue = [];     // shuffle 播放序列（track 索引，喜欢歌×2）
      this.queuePos = -1;
      this.onTrack = null;      // (name, index) => void
      this.onListChange = null; // () => void
      this.onModeChange = null; // (mode, prevMode) => void —— 切模式时让 UI 给提示
      this.hr = null;           // 当前心率，智能排序用（由引擎每拍写入）
      this._smartPlayed = null; // 智能模式本轮已播过的索引，播完一轮重置实现循环
      this.holdAutoDetect = false; // 批量导入中：先攒着不测 BPM，跑完调 flushAutoDetect
      this._pendingAuto = [];
      this.removed = [];      // 被移除的歌（文件还在，可再次添加）
      this.playedNames = [];  // 本次运动实际播过的歌名，结束时用来存歌单
      this.removedNames = this._loadRemovedNames(); // 持久化的移除名单，重启后不会把移除的歌加回来
      this.onRemovedChange = null; // () => void
      this.onSeek = null;          // (currentTime) => void —— 拖动进度条跳转时通知 UI
    }

    // 心率 → 目标步频 BPM：跑步时步频与心率正相关，映射到常用步频区间 150~185
    hrToTargetBpm(hr) {
      if (!hr || hr < 70) return null;
      const t = Math.max(0, Math.min(1, (hr - 95) / (180 - 95)));
      return Math.round(150 + t * 35);
    }

    // 歌单总时长（秒）：引导跑用它决定训练总长
    totalDurationSec() {
      return this.playlist.reduce((s, t) => s + (t.duration || 0), 0);
    }

    /* ---- 时长探测：导入的歌 duration 是 0，不探测就没法按「总时长」划四个阶段 ---- */
    _probeOne(t) {
      return new Promise((resolve) => {
        if (!t || !t.url) return resolve(0);
        if (t.duration && t.duration > 0) return resolve(t.duration);
        let settled = false;
        const done = (d) => { if (settled) return; settled = true; resolve(d || 0); };
        try {
          const a = new (global.Audio || Object)();
          a.preload = 'metadata';
          a.src = t.url;
          if (a.addEventListener) {
            a.addEventListener('loadedmetadata', () => done(isFinite(a.duration) ? a.duration : 0));
            a.addEventListener('error', () => done(0));
          }
          // 兜底超时：拿不到就当 0，不能卡住整个导入流程
          setTimeout(() => done(0), 8000);
        } catch (e) { done(0); }
      });
    }

    // 并发探测（串行太慢，一次开太多又会把解码器打满）
    async probeDurations(concurrency = 3) {
      const todo = this.playlist.filter((t) => !t.duration);
      if (!todo.length) return;
      let cursor = 0;
      const worker = async () => {
        while (cursor < todo.length) {
          const t = todo[cursor++];
          const d = await this._probeOne(t);
          if (d > 0) t.duration = d;
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
      if (this.onListChange) this.onListChange();
      this.emitDurations && this.emitDurations();
    }

    /* ---- 移除 / 重新添加（只出歌单，不删本地文件） ---- */
    _loadRemovedNames() {
      try {
        const a = JSON.parse(global.localStorage.getItem('musicRemoved') || '[]');
        return new Set(Array.isArray(a) ? a : []);
      } catch (e) { return new Set(); }
    }
    _saveRemovedNames() {
      try { global.localStorage.setItem('musicRemoved', JSON.stringify([...this.removedNames])); } catch (e) {}
    }
    isRemoved(name) { return this.removedNames.has(this._cleanName(name)); }

    removeTrack(i) {
      const t = this.playlist[i];
      if (!t) return false;
      this.playlist.splice(i, 1);
      this.removed.push(t);
      this.removedNames.add(t.name);
      this._saveRemovedNames();
      // 正在播这首 → 停下来；播的是后面的歌 → 索引要跟着前移
      if (this.index === i) {
        if (this.audio) { try { this.audio.pause(); } catch (e) {} }
        this.audio = null; this.playing = false;
        this.index = -1; this.name = '';
      } else if (this.index > i) {
        this.index--;
      }
      // 队列/已播集合里存的都是索引，失效了直接重建
      this.queue = []; this.queuePos = -1; this._smartPlayed = null;
      this._refreshName();
      if (this.onListChange) this.onListChange();
      if (this.onRemovedChange) this.onRemovedChange();
      return true;
    }

    // 把「已移除」的某首加回歌单末尾
    restoreTrack(ri) {
      const t = this.removed[ri];
      if (!t) return false;
      this.removed.splice(ri, 1);
      this.removedNames.delete(t.name);
      this._saveRemovedNames();
      this.playlist.push(t);
      this.queue = []; this.queuePos = -1; this._smartPlayed = null;
      this._refreshName();
      if (this.onListChange) this.onListChange();
      if (this.onRemovedChange) this.onRemovedChange();
      return true;
    }

    // 启动时把持久化里的「已移除」条目填回 removed 列表（这样用户还能再加回来）
    addToRemoved(entry) {
      const t = this._mkTrack(entry.title || entry.name, null, entry.url, entry.bpm, entry.duration);
      this.removed.push(t);
      return true;
    }

    /* ---- 本次运动实际播过的歌（结束时可存成歌单） ---- */
    resetPlayLog() { this.playedNames = []; }
    _logPlayed(name) {
      if (!name) return;
      if (this.playedNames[this.playedNames.length - 1] !== name) this.playedNames.push(name);
    }

    load(file) { this.loadList([file]); }

    // 去掉扩展名，得到干净的歌曲名（Android 返回的文件名可能是 URL 编码，先解码）
    _cleanName(name) {
      let n = (name || '未知音乐');
      try { n = decodeURIComponent(n); } catch (e) {}
      return n.replace(/\.[^/.]+$/, '');
    }

    // 统一构造 track：顺带拆出「艺人 / 歌名」，方便曲库按任一段匹配
    _mkTrack(rawName, file, url, bpm, duration) {
      const name = this._cleanName(rawName);
      const p = BpmLibrary._splitArtistTitle(name);
      return {
        name: name,
        artist: p ? p.artist : '',
        title: p ? p.title : name,
        file: file || null,
        url: url || '',
        bpm: bpm || null,
        duration: duration || 0,
        liked: false,
        bpmTried: false, // 已尝试过检测（无论成败），避免重复解码
      };
    }

    _refreshName() {
      // 有正在播的歌就显示歌名，别把它覆盖成「N 首歌」（移除一首之后就会发生）
      const cur = (this.index >= 0 && this.playlist[this.index]) ? this.playlist[this.index].name : null;
      if (cur) { this.name = cur; return; }
      this.name = this.playlist.length
        ? (this.playlist.length === 1 ? this.playlist[0].name : this.playlist.length + ' 首歌')
        : '';
    }

    // 加载内置音乐（URL 列表）——替换当前歌单（播放专辑场景）
    // items 可带 bpm/duration（内置音乐 meta 里已算好），带了就直接用，不必再检测
    loadUrls(items) {
      this._clear();
      this.playlist = (items || []).map((it) => this._mkTrack(it.title || it.url, null, it.url, it.bpm, it.duration));
      this.index = -1;
      this._refreshName();
      if (this.onListChange) this.onListChange();
      // 内置歌已带 BPM；没带的延后检测（最多前几首，避免启动瞬间集中解码）
      this.playlist.forEach((t, i) => { if (!t.bpm && i < AUTO_DETECT_LIMIT) this._autoEnqueue(t); });
    }

    // 追加 URL 列表到当前歌单（本地导入场景，不覆盖已有歌曲），按名称去重
    addUrls(items) {
      const existing = new Set(this.playlist.map((t) => t.name));
      const added = [];
      (items || []).forEach((it) => {
        const name = this._cleanName(it.title || it.url);
        if (!existing.has(name)) {
          const t = this._mkTrack(name, null, it.url, null, it.duration);
          this.playlist.push(t);
          existing.add(name);
          added.push(t);
        }
      });
      this._refreshName();
      if (this.onListChange) this.onListChange();
      // 防闪退：一次只自动检测前几首，其余等用户切到那首时再算。
      // 批量导入时先攒着（holdAutoDetect），别和文件拷贝抢主线程，整批跑完再 flushAutoDetect。
      const pick = added.slice(0, AUTO_DETECT_LIMIT);
      if (this.holdAutoDetect) this._pendingAuto = (this._pendingAuto || []).concat(pick);
      else pick.forEach((t) => this._autoEnqueue(t));
    }

    // 批量导入结束：把攒下的自动检测放出去
    flushAutoDetect() {
      this.holdAutoDetect = false;
      const pend = (this._pendingAuto || []).filter((t) => !t.bpm && !t.bpmTried).slice(0, AUTO_DETECT_LIMIT);
      this._pendingAuto = [];
      pend.forEach((t) => this._autoEnqueue(t));
    }

    // ===== BPM 解析：曲库匹配优先，解码检测兜底（串行，避免多首同时解码卡主线程） =====

    // 只读元数据拿时长，比解码整段音频快得多
    _readDuration(track) {
      if (track.duration) return Promise.resolve(track.duration);
      return new Promise((resolve) => {
        let settled = false;
        let a = null;
        const done = (d) => {
          if (settled) return;
          settled = true;
          try { if (a) { a.src = ''; a.load(); } } catch (e) {} // 读完释放，避免堆积 Audio 元素
          resolve(d && isFinite(d) ? d : 0);
        };
        try {
          a = new Audio();
          a.preload = 'metadata';
          a.onloadedmetadata = () => done(a.duration);
          a.onerror = () => done(0);
          setTimeout(() => done(0), 8000); // 超时兜底
          a.src = track.url;
        } catch (e) { done(0); }
      });
    }

    // 手动触发全量识别（用户点按钮）：解除熔断、重置标记，逐首排队重算
    detectAll() {
      this._bpmAborted = false;
      this._bpmTimeouts = 0;
      this.playlist.forEach((t) => { if (!t.bpm) { t.bpmTried = false; this._enqueueBpm(t); } });
    }

    // 按需入队：顺序播放就是按列表顺序一首首来，用不上 BPM，
    // 没必要为一首歌去解码（FLAC 尤其贵），省下来的开销直接消除导入卡顿
    _autoEnqueue(track) {
      if (this.mode === 'order') return;
      this._enqueueBpm(track);
    }

    _enqueueBpm(track) {
      if (!track || track.bpm || track.bpmTried) return;
      this._bpmQueue = this._bpmQueue || [];
      if (this._bpmQueue.indexOf(track) >= 0) return;
      this._bpmQueue.push(track);
      if (!this._bpmRunning) this._drainBpm();
    }

    // 单次检测硬超时：解码在部分 Android WebView 上会卡死（JS 异常捕获不到，直接崩进程），
    // 所以对外层加一道超时闸门，超时就放弃这一首，不再等它
    _withTimeout(promise, ms) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
        const timer = setTimeout(() => finish('__timeout__'), ms);
        Promise.resolve(promise).then(finish).catch(() => finish(null));
      });
    }

    async _drainBpm() {
      this._bpmRunning = true;
      // 先让列表渲染 / 文件写入跑完再开工，避免和主线程抢资源（导入瞬间闪退的高发点）
      await new Promise((r) => setTimeout(r, 900));
      while (this._bpmQueue && this._bpmQueue.length) {
        if (this._bpmAborted) break;   // 连续超时已熔断，停止自动检测
        const t = this._bpmQueue.shift();
        if (!t || t.bpm || t.bpmTried) continue;
        const r = await this._withTimeout(this._resolveBpm(t), DETECT_TIMEOUT_MS);
        if (r === '__timeout__') {
          // 解码卡死：这一首放弃，连续两次就整体停手，防止反复把 App 拖崩
          t.bpmTried = true;
          this._bpmTimeouts = (this._bpmTimeouts || 0) + 1;
          if (this._bpmTimeouts >= 2) this._bpmAborted = true;
        }
        // 每首之间留出更长间隔，让 UI 与 GC 有喘息空间
        await new Promise((r) => setTimeout(r, 250));
      }
      this._bpmRunning = false;
    }

    async _resolveBpm(track) {
      track.bpmTried = true;
      track.duration = await this._withTimeout(this._readDuration(track), 9000) || 0;
      await BpmLibrary.ready();
      const hit = BpmLibrary.lookup(track.name, track.duration);
      if (hit) {   // 曲库命中：直接用，秒出结果
        track.bpm = hit;
        if (this.onListChange) this.onListChange();
        return hit;
      }
      await this._detectBpm(track); // 曲库没有才做本地检测
      return track.bpm;
    }

    // 兜底检测：开源库 bpm-detective（Joe Sullivan 经典算法）优先，失败回退自带 detectBPM
    // 防闪退：只取前 700KB 解码、只分析前 30 秒、用 OfflineAudioContext（不占音频设备）
    // 只取音频开头 N 字节：优先用 Range；不支持时改为「流式读到 N 字节就掐断」，
    // 绝不 arrayBuffer() 整首（一首 10MB 的歌直接进内存是闪退主因之一）
    async _readHead(url, maxBytes) {
      try {
        const res = await fetch(url, { headers: { Range: 'bytes=0-' + (maxBytes - 1) } });
        if (!res.body) {
          const full = await res.arrayBuffer();
          return full.byteLength > maxBytes ? full.slice(0, maxBytes) : full;
        }
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        while (got < maxBytes) {
          const r = await reader.read();
          if (r.done) break;
          chunks.push(r.value);
          got += r.value.length;
          if (got >= maxBytes) break;
        }
        try { await reader.cancel(); } catch (e) {}
        const out = new Uint8Array(Math.min(got, maxBytes));
        let off = 0;
        for (const c of chunks) {
          const n = Math.min(c.length, out.length - off);
          out.set(c.subarray(0, n), off);
          off += n;
          if (off >= out.length) break;
        }
        chunks.length = 0;
        return out.buffer;
      } catch (e) {
        return null;
      }
    }

    async _detectBpm(track) {
      try {
        const hasWin = (typeof window !== 'undefined');
        const AC = hasWin && (window.AudioContext || window.webkitAudioContext);
        const OAC = hasWin && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
        if (!AC && !OAC) { track.bpm = null; return; }

        let ab = null;
        // 无损格式（flac/wav/ape…）同样字节解出的音频短得多，按 3 倍取，否则凑不满分析窗口
        const bytes = LOSSLESS_RE.test(track.name || '') ? DETECT_BYTES * 3 : DETECT_BYTES;
        if (track.file) {
          ab = await track.file.slice(0, bytes).arrayBuffer();
        } else if (track.url) {
          ab = await this._readHead(track.url, bytes);
        }
        if (!ab || ab.byteLength < 16384) { track.bpm = null; return; }

        const decCtx = OAC ? new OAC(1, 1, 44100) : new AC();
        let buf = null;
        try { buf = await decCtx.decodeAudioData(ab); } catch (e) { buf = null; }
        ab = null; // 解码完立刻释放字节，降低内存峰值
        try { if (decCtx.close) decCtx.close(); } catch (e) {}
        if (!buf) { track.bpm = null; return; }

        const bpm = this._detectBpmCore(buf);
        buf = null;

        track.bpm = (bpm && bpm >= 60 && bpm <= 200) ? Math.round(bpm) : null;
        if (track.bpm) BpmLibrary.remember(track.name, track.duration, track.bpm);
      } catch (e) {
        track.bpm = null;
      }
      if (this.onListChange) this.onListChange();
    }

    // 检测核心：开源库 bpm-detective（Joe Sullivan 经典算法）+ 多段投票
    // 实测 12 首内置歌：「低通 150Hz + 归一化 + 8 段×8 秒投票」准确率最高（8/12），
    // 单段直出只有 7/12；全程只操作一段 Float32Array，内存压力极小
    _detectBpmCore(buf) {
      const sr = buf.sampleRate;
      const maxSec = Math.min(buf.duration || 0, 26);
      if (maxSec < 6) return null;
      const chs = buf.numberOfChannels || 1;
      const starts = [0, 2.5, 5, 7.5, 10, 12.5, 15, 18];
      const results = [];
      for (const st of starts) {
        if (st + 5 > maxSec) break;
        const seg = this._sliceMono(buf, chs, st, Math.min(8, maxSec - st));
        if (!seg) continue;
        let v = null;
        try {
          if (typeof window !== 'undefined' && typeof window.DetectBPM === 'function') v = window.DetectBPM(seg);
        } catch (e) { v = null; }
        if (!v) { try { v = detectBPM(seg); } catch (e) { v = null; } }
        if (v) results.push(this._normBpm(v));
      }
      if (!results.length) return null;
      // 聚类投票：±3 BPM 算同一结果，取成员最多的簇的中位数
      const buckets = [];
      for (const v of results) {
        let hit = null;
        for (const b of buckets) { if (Math.abs(b[0] - v) <= 3) { hit = b; break; } }
        if (hit) hit.push(v); else buckets.push([v]);
      }
      buckets.sort((a, b) => b.length - a.length);
      const top = buckets[0].slice().sort((a, b) => a - b);
      return top[Math.floor(top.length / 2)];
    }

    // BPM 规约到常见区间，修正算法常犯的「快一倍 / 慢一半」
    _normBpm(b) {
      let x = b;
      while (x > 185) x /= 2;
      while (x < 70) x *= 2;
      return Math.round(x);
    }

    // 取指定区间的单声道数据：混音 → 一阶低通 150Hz（突出底鼓）→ 峰值归一化
    // 返回 duck-typed 的轻量 buffer（bpm-detective 只读 length/sampleRate/getChannelData），
    // 不创建真实 AudioBuffer，省掉每段上 MB 级的内存分配
    _sliceMono(buf, chs, startSec, lenSec) {
      try {
        const sr = buf.sampleRate;
        const from = Math.floor(startSec * sr);
        const n = Math.min(Math.floor(lenSec * sr), buf.length - from);
        if (n < sr * 4) return null;
        const out = new Float32Array(n);
        if (chs === 1) {
          const d = buf.getChannelData(0);
          for (let i = 0; i < n; i++) out[i] = d[from + i];
        } else {
          const a = buf.getChannelData(0), b = buf.getChannelData(1);
          for (let i = 0; i < n; i++) out[i] = (a[from + i] + b[from + i]) * 0.5;
        }
        const alpha = 1 - Math.exp(-2 * Math.PI * 150 / sr); // 一阶 IIR 低通
        let prev = 0, peak = 0;
        for (let i = 0; i < n; i++) {
          prev += alpha * (out[i] - prev);
          out[i] = prev;
          const m = prev < 0 ? -prev : prev;
          if (m > peak) peak = m;
        }
        if (peak > 0) { const g = 1 / peak; for (let i = 0; i < n; i++) out[i] *= g; }
        return { length: n, numberOfChannels: 1, sampleRate: sr, duration: n / sr, getChannelData: function () { return out; } };
      } catch (e) { return null; }
    }

    // 本地导入音乐 ——追加到歌单（不覆盖已有歌曲），按名称去重
    loadList(files) {
      const newTracks = (files || []).map((f) => this._mkTrack(f.name, f, URL.createObjectURL(f), null, 0));
      const existing = new Set(this.playlist.map((t) => t.name));
      newTracks.forEach((t) => {
        if (!existing.has(t.name)) this.playlist.push(t);
      });
      this._refreshName();
      if (this.onListChange) this.onListChange();
      // 防闪退：只自动检测前几首，剩下的等切到那首再算
      newTracks.slice(0, AUTO_DETECT_LIMIT).forEach((t) => this._autoEnqueue(t));
    }

    _clear() {
      if (this.audio) { this.audio.pause(); this.audio = null; }
      this.playlist.forEach((t) => { try { URL.revokeObjectURL(t.url); } catch (e) {} });
      this.playlist = [];
      this.index = -1;
      this.playing = false;
      this.queue = [];
      this.queuePos = -1;
    }

    _buildQueue() {
      const q = [];
      this.playlist.forEach((t, i) => { q.push(i); if (t.liked) q.push(i); }); // 喜欢歌×2
      for (let i = q.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q[i], q[j]] = [q[j], q[i]];
      }
      this.queue = q;
      this.queuePos = -1;
    }

    _shuffleNext() {
      if (!this.queue.length) this._buildQueue();
      this.queuePos = (this.queuePos + 1) % this.queue.length;
      return this.queue[this.queuePos];
    }

    _playIndex(i) {
      if (i < 0 || i >= this.playlist.length) { this.playing = false; return; }
      this.index = i;
      if (this.audio) this.audio.pause();
      const track = this.playlist[i];
      const self = this;
      this.audio = new Audio(track.url);
      this.audio.volume = this.volume;
      this.audio.onended = () => this.next(); // 播完自动切下一首
      // 拖动进度条跳转时也通知一下 UI（阶段时间提示要跟着刷新）
      if (this.audio.addEventListener) {
        this.audio.addEventListener('seeked', () => { if (this.onSeek) this.onSeek(this.audio.currentTime); });
      }
      this.audio.play().catch(function (e) {
        // 播放失败不再静默：复位状态并通知 UI，方便定位（如格式不支持/URL 失效）
        self.playing = false;
        if (self.onListChange) self.onListChange();
        // 被浏览器的自动播放策略拦下不算真的失败（换个用户手势就能播），别吓用户
        const blocked = e && (e.name === 'NotAllowedError' || /not allowed|user gesture/i.test(e.message || ''));
        if (!blocked && self.onError) self.onError(track.name, (e && e.message) || String(e));
      });
      this.playing = true;
      this.name = track.name;
      this._logPlayed(track.name); // 记一笔：结束时可以存成本次运动的歌单
      // 没算出 BPM 的歌，切到它时才补测（按需，避免导入时一次性全解码）
      this._autoEnqueue(track);
      if (this.onTrack) this.onTrack(track.name, i);
    }

    playTrack(i) { this._playIndex(i); }

    play() {
      if (!this.playlist.length) return;
      if (this.index >= 0) {
        // 已有指针但还没建音频对象（例如切过模式但没播过）→ 先建，否则会静默无声
        if (this.audio) { this.audio.play().catch(() => {}); this.playing = true; }
        else this._playIndex(this.index);
        return;
      }
      this._playIndex(this.mode === 'smart' ? this._smartNext()
        : (this.mode === 'shuffle' ? this._shuffleNext() : 0));
    }
    pause() { if (this.audio) { this.audio.pause(); this.playing = false; } }
    toggle() { this.playing ? this.pause() : this.play(); }
    // 智能模式选下一首：按「与当前心率对应的目标 BPM 的差距」排序，喜欢优先。
    // 本轮播过的先排除，全部播完自动重置 —— 这样既是「随心率实时变顺序」，又能循环放完整张歌单。
    // 只有播完一首（onended）才会调用，不会中途打断当前歌。
    _smartNext() {
      if (!this.playlist.length) return -1;
      const target = this.hrToTargetBpm(this.hr);
      if (!this._smartPlayed) this._smartPlayed = new Set();
      if (this._smartPlayed.size >= this.playlist.length) this._smartPlayed.clear();

      let pool = this.playlist.map((t, i) => i).filter((i) => !this._smartPlayed.has(i));
      if (!pool.length) { this._smartPlayed.clear(); pool = this.playlist.map((t, i) => i); }
      pool.sort((a, b) => {
        const ta = this.playlist[a].bpm, tb = this.playlist[b].bpm;
        const da = (ta && target) ? Math.abs(ta - target) : 900;
        const db = (tb && target) ? Math.abs(tb - target) : 900;
        return (da - db) || ((this.playlist[b].liked ? 1 : 0) - (this.playlist[a].liked ? 1 : 0));
      });
      const pick = pool[0];
      this._smartPlayed.add(pick);
      return pick;
    }

    next() {
      if (this.mode === 'smart') this._playIndex(this._smartNext());
      else if (this.mode === 'shuffle') this._playIndex(this._shuffleNext());
      else this._playIndex(this.index + 1);
    }
    prev() {
      if (this.mode === 'shuffle') {
        if (this.queuePos > 0) { this.queuePos--; this._playIndex(this.queue[this.queuePos]); }
        else this._playIndex(this.queue[0] || 0);
      } else {
        this._playIndex(Math.max(0, this.index - 1));
      }
    }
    stop() { if (this.audio) { this.audio.pause(); this.playing = false; } }
    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      if (this.audio) this.audio.volume = this.volume;
    }

    // 智能模式：按与「当前心率对应目标 BPM」的差距排序，喜欢优先
    _sortedByHr() {
      const target = this.hrToTargetBpm(this.hr);
      return this.playlist
        .map((t, i) => i)
        .sort((a, b) => {
          const ta = this.playlist[a].bpm, tb = this.playlist[b].bpm;
          const da = (ta && target) ? Math.abs(ta - target) : 900;
          const db = (tb && target) ? Math.abs(tb - target) : 900;
          return (da - db) || ((this.playlist[b].liked ? 1 : 0) - (this.playlist[a].liked ? 1 : 0));
        });
    }

    // 当前模式下的播放顺序（索引数组）：歌单界面按它渲染，切模式时按它重排
    orderedIndices() {
      const n = this.playlist.length;
      if (!n) return [];
      if (this.mode === 'shuffle') {
        if (!this.queue.length) this._buildQueue();
        // 队列里「喜欢的歌」会出现两次（加权），展示要去重，否则歌单会有重复行
        const seen = new Set();
        return this.queue.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
      }
      if (this.mode === 'smart') return this._sortedByHr();
      return this.playlist.map((t, i) => i);
    }

    setMode(m) {
      const prev = this.mode;
      this.mode = (m === 'shuffle' || m === 'smart') ? m : 'order';
      this._smartPlayed = null;
      if (this.mode === 'shuffle') this._buildQueue();
      else { this.queue = []; this.queuePos = -1; }
      // 顺序播放用不上 BPM，切到随机/智能才需要，这时再补测（不浪费导入时的开销）
      if (prev === 'order' && this.mode !== 'order') this.detectAll();

      // 切模式要「看得见」：立刻按新模式重排，并跳到新序列的第一首
      const order = this.orderedIndices();
      if (order.length) {
        const first = order[0];
        if (this.mode === 'shuffle') this.queuePos = 0;
        if (this.mode === 'smart') this._smartPlayed = new Set([first]);
        if (this.playing || this.audio) {
          this._playIndex(first);   // 正在听 → 直接换到新序列开头
        } else {
          this.index = first;       // 没在听 → 只挪指针，不擅自开播
          this.name = this.playlist[first].name;
          if (this.onTrack) this.onTrack(this.name, first);
        }
      }
      if (this.onModeChange) this.onModeChange(this.mode, prev);
    }

    toggleLike(i) {
      const t = this.playlist[i];
      if (!t) return null;
      t.liked = !t.liked;
      if (this.onListChange) this.onListChange();
      return t.liked;
    }

    // 智能推荐：BPM 匹配 + 喜欢优先
    recommendForBpm(bpm, range) {
      range = range || 12;
      if (!bpm) return [];
      return this.playlist
        .filter((t) => t.bpm && Math.abs(t.bpm - bpm) <= range)
        .sort((a, b) => ((b.liked ? 1 : 0) - (a.liked ? 1 : 0)) || (Math.abs(a.bpm - bpm) - Math.abs(b.bpm - bpm)));
    }
  }

  /* ---------- 语音引擎 ---------- */
  class VoiceEngine {
    constructor(opts = {}) {
      this.localDir = opts.localDir || 'voices/';
      this.useLocal = opts.useLocal !== false;
      this.volume = (opts.volume !== undefined) ? opts.volume : 0.75; // 防止音量过大炸耳
      this._chain = Promise.resolve();
      this.onVoice = null; // (type, text, voiceId, local, duration) => void
      // 探测结果缓存：不缓存的话每句话都要先 404 一次 mp3 再找到 wav，
      // 在 WebView 里就是实打实的延迟（“天依”会慢半拍才开口）
      this._extCache = Object.create(null);
    }

    // 探测本地音频扩展名（mp3 优先），用 HEAD 请求确认存在，返回 ext 或 null
    _findLocalExt(voiceId) {
      if (!this.useLocal || !voiceId) return Promise.resolve(null);
      if (voiceId in this._extCache) return Promise.resolve(this._extCache[voiceId]);
      const exts = ['mp3', 'wav', 'ogg', 'm4a'];
      const probe = (i) => {
        if (i >= exts.length) { this._extCache[voiceId] = null; return Promise.resolve(null); }
        return fetch(this.localDir + voiceId + '.' + exts[i], { method: 'HEAD' })
          .then((r) => {
            if (r.ok) { this._extCache[voiceId] = exts[i]; return exts[i]; }
            return probe(i + 1);
          })
          .catch(() => probe(i + 1));
      };
      return probe(0);
    }

    // 播放本地音频；onStart(duration) 在元数据就绪、开始播放时回调
    _playAudio(url, onStart) {
      return new Promise((resolve) => {
        const a = new Audio(url);
        a.volume = this.volume;
        let settled = false;
        const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        a.onloadedmetadata = () => {
          const dur = (a.duration && isFinite(a.duration)) ? a.duration : null;
          if (onStart) onStart(dur);
        };
        a.onended = () => finish(true);
        a.onerror = () => finish(false);
        a.play().catch(() => finish(false));
        setTimeout(() => { if (!settled) finish(true); }, 60000); // 兜底，避免卡住
      });
    }

    _systemSpeak(text) {
      return new Promise((resolve) => {
        if (!('speechSynthesis' in global)) return resolve(false);
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.rate = 1.0;
        const zh = speechSynthesis.getVoices().find((v) => /zh|Chinese/i.test(v.lang));
        if (zh) u.voice = zh;
        u.onend = () => resolve(true);
        u.onerror = () => resolve(false);
        speechSynthesis.speak(u);
      });
    }

    async _play(type, text, voiceId) {
      const ext = await this._findLocalExt(voiceId);
      if (ext) {
        // 有本地音频 → 只播本地，不回退 TTS
        const url = this.localDir + voiceId + '.' + ext;
        await this._playAudio(url, (dur) => {
          if (this.onVoice) this.onVoice(type, text, voiceId, true, dur);
        });
      } else {
        // 无本地音频 → 回退系统 TTS
        if (this.onVoice) this.onVoice(type, text, voiceId, false, null);
        await this._systemSpeak(text);
      }
    }

    /* 入队串行播放（阶段提示、鼓励语都用这个，避免重叠） */
    speak(type, text, voiceId) {
      this._chain = this._chain.then(() => this._play(type, text, voiceId));
      return this._chain;
    }

    cancel() {
      if ('speechSynthesis' in global) speechSynthesis.cancel();
      this._chain = Promise.resolve();
    }

    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
    }
  }

  /* ---------- 心率（Web Bluetooth） ---------- */
  class HeartRateMonitor {
    constructor() { this.device = null; this.char = null; this.onData = null; this.onState = null; }

    get supported() { return 'bluetooth' in global.navigator; }

    async connect() {
      if (!this.supported) throw new Error('当前环境不支持 Web Bluetooth');
      this.device = await global.navigator.bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }],
        optionalServices: ['battery_service'],
      });
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService('heart_rate');
      this.char = await service.getCharacteristic('heart_rate_measurement');
      await this.char.startNotifications();
      this.char.addEventListener('characteristicvaluechanged', (e) => this._parse(e.target.value));
      this.device.addEventListener('gattserverdisconnected', () => this._disconnected());
      if (this.onState) this.onState(true, this.device.name || '已连接');
    }

    _parse(v) {
      const flags = v.getUint8(0);
      const u16 = flags & 0x01;
      let i = 1;
      const bpm = u16 ? v.getUint16(1, true) : v.getUint8(1);
      i += u16 ? 2 : 1;
      let contact = null;
      if (flags & 0x04) contact = !!(flags & 0x02);
      let energy = null;
      if (flags & 0x08) { energy = v.getUint16(i, true); i += 2; }
      const rr = [];
      if (flags & 0x10) {
        while (i + 1 < v.byteLength) { rr.push(v.getUint16(i, true) / 1024); i += 2; }
      }
      if (this.onData) this.onData({ bpm, contact, energy, rr });
    }

    _disconnected() {
      this.char = null;
      if (this.onState) this.onState(false, '已断开');
    }

    async disconnect() {
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
      this.char = null;
      if (this.onState) this.onState(false, '未连接');
    }
  }

  /* ---------- 心率区间（工具，供 UI 调用；只输出语义字段，颜色归 UI） ---------- */
  function heartRateZone(bpm, age) {
    const max = 220 - (age || 20);
    const p = Math.min(1, bpm / max);
    if (p < 0.6) return { key: 'recover',   label: '恢复 / 热身', pct: p * 100 };
    if (p < 0.7) return { key: 'fatburn',   label: '燃脂区间',     pct: p * 100 };
    if (p < 0.8) return { key: 'aerobic',   label: '有氧区间',     pct: p * 100 };
    if (p < 0.9) return { key: 'anaerobic', label: '无氧 / 阈值',  pct: p * 100 };
    return { key: 'max', label: '极限区间', pct: 100 };
  }

  /* ---------- 训练流程（总引擎） ---------- */
  class RunnerEngine extends Emitter {
    constructor(config = {}) {
      super();

      // 数据（可被 config 覆盖）
      this.stages = config.stages || DEFAULT_STAGES;
      this.followStages = config.followStages || FOLLOW_STAGES;
      // 自定义跑只有一个「阶段」，它的 bpm 永远跟着 customBpm 走
      this.customStages = config.customStages || [Object.assign({}, CUSTOM_STAGE)];
      this.customBpm = this._clampBpm(config.customBpm || DEFAULT_CUSTOM_BPM);
      this.customStages[0].bpm = this.customBpm;
      // 三种跑法：guide=App 主导（BPM 渐升，时长=歌单总长）；follow=用户主导（心率定区间，节拍锁步频）；
      // custom=自定义（节拍器全程固定在一个用户设定的 BPM）
      this.runMode = config.runMode || 'guide';
      this.startVoice = config.startVoice || DEFAULT_START_VOICE;
      this.endVoice = config.endVoice || DEFAULT_END_VOICE;
      this.pauseVoice = config.pauseVoice || DEFAULT_PAUSE_VOICE;
      this.resumeVoice = config.resumeVoice || DEFAULT_RESUME_VOICE;
      this.cheers = config.cheers || DEFAULT_CHEERS;
      this.cheerInterval = config.cheerInterval || [35, 55]; // 秒，随机区间

      // 音量系统：独立音量 × 总音量
      this.masterVolume = 1;
      this._volumes = { voice: 0.75, music: 1, metronome: 1 };

      // 子模块
      this.metronome = new Metronome();
      this.music = new MusicPlayer();
      this.voice = new VoiceEngine(config.voice || {});
      this.heartRate = new HeartRateMonitor();

      // 状态
      this.state = 'idle'; // idle | running | paused | finished
      this.stageIndex = -1;
      this.currentBpm = this.stages[0].startBpm;
      this.elapsed = 0;     // 已训练秒数
      this._timer = null;
      this._segStart = 0;
      this._accum = 0;
      this._nextCheerAt = 0;
      this._lastCheer = -1;
      this._age = 20;
      this._stageStartElapsed = 0; // 当前阶段开始的 elapsed（心率驱动用）
      this._hrZonePicked = false;  // 跟随跑：是否已经按心率定过区间（首次定区间不受滞回限制）
      // 引导跑：四阶段占总时长的比例（用户可调，和恒为 1）
      this.stageRatios = (config.stageRatios || DEFAULT_STAGE_RATIOS).slice();
      // 跟随跑：节拍器每秒最多变多少拍（渐进靠拢，不突跳）
      this.glideBpmPerSec = config.glideBpmPerSec || 2.5;
      this._bpmF = null;   // 节拍器当前 BPM 的浮点值（渐进用，避免取整把小步吃掉）
      this._dtTick = 0;    // 上一次 tick 到现在过了多少秒
      this._musicWasPlaying = false; // 暂停前音乐是否在播（用于恢复）
      this.hrSeries = [];        // 心率采样 [{t: 秒, hr: bpm}]，结束时画变化图
      this._hrSampleAt = -999;

      // 回调透传（也支持 config 里直接传）
      const map = {
        onStateChange: null, onBeat: null, onBpm: null, onStage: null,
        onVoice: null, onHeartRate: null, onTick: null, onCheer: null,
      };
      for (const k in map) if (config[k]) this.on(k.replace(/^on/, '').toLowerCase(), config[k]);

      // 内部事件 → 对外回调
      this.metronome.onBeat = (beat, accent, time) => this.emit('beat', beat, accent, time);
      this.voice.onVoice = (type, text, voiceId, local, duration) => this.emit('voice', { type, text, voiceId, local, duration });
      this.heartRate.onData = (d) => { this.currentHR = d.bpm; this.emit('heartrate', d); };
      this.heartRate.onState = (on, text) => this.emit('hrstate', on, text);
    }

    /* 事件别名，方便 UI 用 engine.on('beat', fn) 或 config 传 onBeat */
    // 已经在上面处理了 config 里的 onXxx（转小写事件名）
    // 例如 config.onBeat → engine.on('beat', fn)

    totalDuration() { return this.stages.reduce((s, x) => s + x.dur, 0); }

    setAge(age) { this._age = age; }

    // 音量：channel ∈ 'master' | 'voice' | 'music' | 'metronome'
    setVolume(channel, v) {
      v = Math.max(0, Math.min(1, v));
      if (channel === 'master') this.masterVolume = v;
      else if (Object.prototype.hasOwnProperty.call(this._volumes, channel)) this._volumes[channel] = v;
      this._applyVolumes();
    }

    getVolumes() {
      return {
        master: this.masterVolume,
        voice: this._volumes.voice,
        music: this._volumes.music,
        metronome: this._volumes.metronome,
      };
    }

    _applyVolumes() {
      const m = this.masterVolume;
      this.metronome.setVolume(this._volumes.metronome * m);
      this.music.setVolume(this._volumes.music * m);
      this.voice.setVolume(this._volumes.voice * m);
    }

    zoneOf(bpm) { return heartRateZone(bpm, this._age); }

    _maxHR() { return 220 - this._age; }

    _hrPct() {
      if (!this.currentHR) return 0;
      return (this.currentHR / this._maxHR()) * 100;
    }

    async start() {
      if (this.state === 'running') return;
      this.voice.cancel();

      this._setState('running');
      this.stageIndex = -1;
      this._accum = 0;
      this._stageStartElapsed = 0;
      this._segStart = now();
      this._lastCheer = -1;
      this._nextCheerAt = this._randCheerAt();
      this._hrZonePicked = false;  // 重新开跑：区间要按最新心率重定，不受上次影响
      this.hrSeries = [];          // 每次开跑重新开始记录心率曲线
      this._hrSampleAt = -999;
      this.music.resetPlayLog();   // 本次运动播过的歌从零记，结束时可以存成歌单

      // 开场白（等它播完再起节拍，体验更自然）
      await this.voice.speak('start', this.startVoice.voice, this.startVoice.voiceId);

      // 开场白期间可能被暂停/停止，检查状态，避免暂停后节拍器又被启动
      if (this.state !== 'running') return;

      this._applyStage(0);
      // 起点一步到位（不用渐进），之后心率/用户改值才靠对应逻辑慢慢带
      this._bpmF = null;
      // 自定义跑的起点就是用户设定的那个值，不是阶段表里的固定 BPM
      this._setBpm(this.runMode === 'custom' ? this.customBpm : (this.activeStages()[0].bpm || this.activeStages()[0].startBpm));
      this.metronome.start();
      this._startRunMusic(); // 节拍器一起，音乐立刻跟上

      this._timer = setInterval(() => this._tick(), 250);
    }

    // 开跑时让音乐跟着节拍器一起起来。
    // 没歌单就安静跳过（节拍器照样跑）；智能模式按当前心率挑第一首，严格贴合心率。
    _startRunMusic() {
      const m = this.music;
      if (!m || !m.playlist.length) return;
      if (m.playing) { this._musicWasPlaying = true; return; } // 用户开跑前已经在听，别打断
      if (m.mode === 'smart') {
        m._smartPlayed = null;
        m._playIndex(m._smartNext());
      } else {
        m.play();
      }
      this._musicWasPlaying = true; // 之后 pause→resume 才知道要恢复音乐
    }

    pause() {
      if (this.state !== 'running') return;
      this._accum += (now() - this._segStart) / 1000;
      this._musicWasPlaying = this.music.playing; // 记住暂停前音乐是否在播
      this.metronome.stop();
      this.music.pause();
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this._setState('paused');
      this.voice.cancel();
      this.voice.speak('pause', this.pauseVoice.voice, this.pauseVoice.voiceId);
    }

    resume() {
      if (this.state !== 'paused') return;
      this._segStart = now();
      this._setState('running');
      this.metronome.start();
      this._timer = setInterval(() => this._tick(), 250);
      if (this._musicWasPlaying) this.music.play(); // 音乐跟随恢复播放
      this.voice.cancel();
      this.voice.speak('resume', this.resumeVoice.voice, this.resumeVoice.voiceId);
    }

    stop() {
      this.metronome.stop();
      this.music.pause();
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this._setState('idle');
      this.stageIndex = -1;
      this.elapsed = 0;
      this.emit('stage', null, -1);
    }

    finish() {
      this.metronome.stop();
      this.music.pause(); // 跑完音乐也收，别压着结束语音和总结页
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this._setState('finished');
      // 收尾前再采一个点，保证曲线末端是最新心率
      if (this.currentHR) this.hrSeries.push({ t: Math.round(this.elapsed), hr: Math.round(this.currentHR) });
      // 把心率曲线一并抛出，UI 直接用它画结束页的变化图
      this.emit('finish', {
        elapsed: this.elapsed,
        hrSeries: this.hrSeries.slice(),
        runMode: this.runMode,
        avgHR: this.avgHR(),
        maxHR: this.maxHR(),
      });
      this.voice.cancel();
      this.voice.speak('end', this.endVoice.voice, this.endVoice.voiceId);
    }

    // 心率统计：结束时展示用
    avgHR() {
      if (!this.hrSeries.length) return null;
      const s = this.hrSeries.reduce((a, x) => a + x.hr, 0);
      return Math.round(s / this.hrSeries.length);
    }
    maxHR() {
      if (!this.hrSeries.length) return null;
      return Math.max.apply(null, this.hrSeries.map((x) => x.hr));
    }

    _setState(s) {
      this.state = s;
      this.emit('state', s);
    }

    _randCheerAt() {
      const [a, b] = this.cheerInterval;
      return now() + a + Math.random() * (b - a);
    }

    _pickCheer() {
      if (!this.cheers.length) return null;
      let i = Math.floor(Math.random() * this.cheers.length);
      if (i === this._lastCheer && this.cheers.length > 1) i = (i + 1) % this.cheers.length;
      this._lastCheer = i;
      return this.cheers[i];
    }

    // 当前跑法使用的阶段表
    activeStages() {
      if (this.runMode === 'follow') return this.followStages;
      if (this.runMode === 'custom') return this.customStages;
      return this.stages;
    }

    /* ---- 自定义跑：用户自己定步频 ---- */

    // 收进 [60,220]：NaN / 字符串 / 越界一律夹回合法范围，绝不把脏值喂给节拍器
    _clampBpm(v) {
      // null / undefined / 空串是「没设置」，回默认；注意 Number(null) === 0，
      // 不先挡掉的话会被当成「设了 0」再夹到下限，语义就错了。
      if (v == null || v === '') return DEFAULT_CUSTOM_BPM;
      const n = Math.round(Number(v));
      if (!isFinite(n) || n <= 0) return DEFAULT_CUSTOM_BPM;
      return Math.max(CUSTOM_BPM_RANGE[0], Math.min(CUSTOM_BPM_RANGE[1], n));
    }

    // 设定步频：跑步中改也立刻生效（下一拍就是新速度），不用停表
    setCustomBpm(v) {
      const b = this._clampBpm(v);
      this.customStages[0].bpm = b;      // 保持 activeStages() 与 customBpm 一致
      const changed = b !== this.customBpm;
      this.customBpm = b;
      if (this.runMode === 'custom' && (this.state === 'running' || this.state === 'paused')) {
        this._bpmF = null;               // 不走渐进：用户手动改就要立刻到
        this._setBpm(b);
      }
      if (changed) this.emit('custombpm', b);
      return b;
    }

    /* ---- 引导跑：四阶段占比（用户可调） ---- */

    // 归一化后的占比（防御脏数据：长度不对、负数、全 0）
    _normRatios() {
      const n = this.stages.length;
      let r = (this.stageRatios || []).slice(0, n).map((x) => (typeof x === 'number' && x > 0) ? x : 0);
      while (r.length < n) r.push(0);
      let s = r.reduce((a, x) => a + x, 0);
      if (!(s > 0)) return DEFAULT_STAGE_RATIOS.slice(); // 全是 0 → 退回默认
      return r.map((x) => x / s);
    }

    // 设置四阶段占比：内部自动归一化，不要求和恰好为 1
    setStageRatios(arr) {
      if (!Array.isArray(arr)) return this._normRatios();
      this.stageRatios = arr.slice(0, this.stages.length);
      const r = this._normRatios();
      this.stageRatios = r;
      this.emit('ratios', r.slice());
      return r.slice();
    }

    // 按当前总时长算出每阶段的实际秒数（设置界面显示用）
    stageDurations() {
      const total = this._guideTotal();
      return this._normRatios().map((x) => Math.round(x * total));
    }

    // 引导跑的总时长：有歌单用歌单总长，否则退回阶段表固定时长
    _guideTotal() {
      const t = this.music.totalDurationSec();
      return (t && t >= 60) ? t : this.totalDuration();
    }

    /* ---- 跟随跑：节拍器渐进靠拢目标步频 ---- */

    // 每秒最多变 glideBpmPerSec 拍：加一点速/减一点速慢慢带过去，到位就稳住
    _glideBpm(target, dt) {
      if (this._bpmF == null) this._bpmF = this.currentBpm || target;
      const step = Math.max(0, this.glideBpmPerSec) * Math.max(0, dt || 0);
      const diff = target - this._bpmF;
      this._bpmF = (Math.abs(diff) <= step) ? target : (this._bpmF + Math.sign(diff) * step);
      this._setBpm(Math.round(this._bpmF));
      return Math.round(this._bpmF);
    }

    setRunMode(m) {
      const prev = this.runMode;
      this.runMode = (m === 'follow' || m === 'custom') ? m : 'guide';
      if (prev !== this.runMode) {
        this.stageIndex = -1;              // 换跑法：阶段重新从第一个开始
        this._stageStartElapsed = this.elapsed;
        this._hrZonePicked = false;        // 换跑法：重新按心率定区间
        this._bpmF = null;                 // 换跑法：从当前节拍开始渐进，不瞬跳
        this.emit('runmode', this.runMode, prev);
      }
    }

    _applyStage(idx) {
      if (idx === this.stageIndex) return;
      this.stageIndex = idx;
      const st = this.activeStages()[idx];
      this.emit('stage', st, idx);
      if (st) {
        this.voice.speak('stage', st.voice, st.voiceId);
        // 这里刻意不切歌：智能模式要求「播完整首才换下一首」。
        // 换歌交给 _smartNext（歌自然播完时按最新心率挑），中途打断体验很差。
      }
    }

    // 智能推荐：按阶段目标 BPM 推荐音乐（喜欢优先），自动切过去
    _recommendMusic(stage) {
      if (!this.music.playlist.length) return;
      const rec = this.music.recommendForBpm(stage.endBpm);
      if (!rec.length) return;
      const idx = this.music.playlist.indexOf(rec[0]);
      if (idx >= 0 && this.music.index !== idx) {
        this.music.playTrack(idx);
        this.emit('recommend', rec[0].name, idx);
      }
    }

    _tick() {
      const prevElapsed = this.elapsed;
      this.elapsed = this._accum + (now() - this._segStart) / 1000;
      // 本次 tick 跨了多少秒（卡上限，防止切后台回来一下冲一大步）
      this._dtTick = Math.max(0, Math.min(2, this.elapsed - prevElapsed));
      this._sampleHr();
      if (this.music.mode === 'smart') this.music.hr = this.currentHR; // 智能排序跟着心率实时走
      if (this.runMode === 'follow') this._tickFollow();
      else if (this.runMode === 'custom') this._tickCustom();
      else this._tickGuide();
    }

    // 心率采样：约每 5 秒一个点，结束时用来画心率变化图
    _sampleHr() {
      if (!this.currentHR) return;
      if (this.hrSeries.length && this.elapsed - this._hrSampleAt < 5) return;
      this._hrSampleAt = this.elapsed;
      this.hrSeries.push({ t: Math.round(this.elapsed), hr: Math.round(this.currentHR) });
      if (this.hrSeries.length > 1500) this.hrSeries.shift(); // 兜底上限
    }

    /* 引导跑（App 主导）：BPM 由低到高渐升，总时长 = 歌单总时长 */
    _tickGuide() {
      const stages = this.stages;
      // 有歌单就用歌单总时长当训练长度；没有才退回阶段表自带的固定时长
      const total = this._guideTotal();
      if (this.elapsed >= total) { this.finish(); return; }

      // 总时长按用户调好的四阶段占比摊开（不是阶段表里的固定秒数）
      const ratios = this._normRatios();
      let acc = 0, idx = stages.length - 1;
      for (let i = 0; i < stages.length; i++) {
        const dur = ratios[i] * total;
        if (this.elapsed < acc + dur) { idx = i; break; }
        acc += dur;
      }
      const st = stages[idx];
      const r = Math.min(1, (this.elapsed - acc) / (ratios[idx] * total));

      this._applyStage(idx);
      const bpm = Math.round(st.startBpm + (st.endBpm - st.startBpm) * r);
      this._setBpm(bpm);

      this._maybeCheer();

      // 阶段时间提示要的数据：本阶段剩多久、距下一阶段开始还有多久、全程剩多久
      const stageEnd = acc + ratios[idx] * total;
      const stageRemain = Math.max(0, stageEnd - this.elapsed);
      const isLast = idx >= stages.length - 1;
      const nextIn = isLast ? null : stageRemain; // 下一阶段就在本阶段结束的那一刻开始

      this.emit('tick', {
        elapsed: this.elapsed, total, stage: st, stageIndex: idx, progress: r, bpm,
        stageRemain, nextStageIn: nextIn, totalRemain: Math.max(0, total - this.elapsed),
        stageCount: stages.length, isLastStage: isLast,
      });
    }

    /* 跟随跑（用户主导）：四个区间由心率决定，区间内目标步频固定 */
    _tickFollow() {
      const stages = this.followStages;
      if (this.stageIndex < 0) { this._applyStage(0); this._stageStartElapsed = this.elapsed; }

      const hrPct = this._hrPct();
      let want = this.stageIndex < 0 ? 0 : this.stageIndex;
      if (hrPct > 0) {
        for (let i = 0; i < stages.length; i++) {
          if (hrPct >= stages[i].hrBand[0] && hrPct < stages[i].hrBand[1]) { want = i; break; }
        }
      }
      // 首次定区间直接落到心率对应的区间，不受 minSec 限制：
      // 否则开跑时心率本来就偏高，用户会被按在「热身」区干等两分钟。
      if (!this._hrZonePicked && hrPct > 0) {
        this._hrZonePicked = true;
        this._applyStage(want);
        this._stageStartElapsed = this.elapsed;
      }
      // 之后才走滞回：必须在本区间待满 minSec 才允许换区间，
      // 否则心率在临界值上下抖动时，节拍器会跟着反复变速，跑起来很难受。
      const stageElapsed = this.elapsed - this._stageStartElapsed;
      const curMin = (stages[this.stageIndex] || stages[0]).minSec || 0;
      if (want !== this.stageIndex && this._hrZonePicked && stageElapsed >= curMin) {
        this._applyStage(want);
        this._stageStartElapsed = this.elapsed;
      }

      const st = stages[this.stageIndex < 0 ? 0 : this.stageIndex];

      // 目标步频 = 用户心率换算值，但夹在本区间标准值 ±FOLLOW_BPM_SLACK 内：
      // 用户加速 → 目标往上走 → 节拍器跟着加一点速；心率稳了 → 目标不动 → 节拍器稳住。
      // 再由 _glideBpm 限速，绝不会一步跳过去（原来直接 setBpm 会瞬跳十几拍）。
      let target = st.bpm;
      // 注意：hrToTargetBpm 是 MusicPlayer 的方法（BPM 相关换算都归它），别在引擎上找
      const byHr = (this.currentHR && this.music && this.music.hrToTargetBpm)
        ? this.music.hrToTargetBpm(this.currentHR) : null;
      if (byHr) {
        target = Math.max(st.bpm - FOLLOW_BPM_SLACK, Math.min(st.bpm + FOLLOW_BPM_SLACK, byHr));
      }
      const bpm = this._glideBpm(target, this._dtTick);

      // 跟随跑默认用智能歌单：按心率挑歌，播完整首才换下一首，播完一轮循环
      if (this.music.mode !== 'smart' && this.music.playlist.length) this.music.setMode('smart');

      this._maybeCheer();

      this.emit('tick', {
        elapsed: this.elapsed, total: 0, // 跟随跑没有预设终点，用户自己决定何时结束
        stage: st, stageIndex: this.stageIndex, progress: 0, bpm: bpm,
        targetBpm: target, converging: bpm !== target, hrPct: hrPct,
      });
    }

    /* 自定义跑（用户定步频）：节拍器全程锁在用户设定的 BPM，不渐变、不分阶段、不自动结束。
       音乐不强制切智能 —— 用户自己定的节奏，歌单模式也应该让他自己选。*/
    _tickCustom() {
      const st = this.customStages[0];
      if (this.stageIndex !== 0) { this._applyStage(0); this._stageStartElapsed = this.elapsed; }

      // 每 tick 读一次 customBpm：用户在跑步中改了值，最多 250ms 就跟上
      const bpm = this._clampBpm(this.customBpm);
      this._setBpm(bpm);

      this._maybeCheer();

      this.emit('tick', {
        elapsed: this.elapsed, total: 0, // 自定义跑没有预设终点，用户自己决定何时结束
        stage: st, stageIndex: 0, progress: 0, bpm: bpm,
        targetBpm: bpm, converging: false, hrPct: this._hrPct(),
        customBpm: bpm,
      });
    }

    _setBpm(bpm) {
      this.metronome.setBpm(bpm);
      if (bpm !== this.currentBpm) {
        this.currentBpm = bpm;
        this.emit('bpm', bpm);
      }
    }

    _maybeCheer() {
      if (this.cheers.length && this.elapsed >= this._nextCheerAt) {
        this._nextCheerAt = this._randCheerAt();
        const c = this._pickCheer();
        if (c) {
          this.voice.speak('cheer', c.voice, c.voiceId);
          this.emit('cheer', c.voice, c.voiceId);
        }
      }
    }
  }

  function now() { return (global.performance && performance.now()) || Date.now(); }

  /* ---------- 歌单存档（运动结束后按日期保存本次播放的歌） ---------- */
  const PlaylistStore = {
    KEY: 'savedPlaylists',
    _read() {
      try {
        const a = JSON.parse(global.localStorage.getItem(this.KEY) || '[]');
        return Array.isArray(a) ? a : [];
      } catch (e) { return []; }
    },
    _write(l) { try { global.localStorage.setItem(this.KEY, JSON.stringify(l)); } catch (e) {} },
    list() { return this._read(); },
    // name 一般用运动日期，例如「2026-09-19」
    add(name, tracks) {
      const l = this._read();
      const pl = {
        id: 'pl_' + Date.now(),
        name: name,
        createdAt: Date.now(),
        songs: (tracks || []).map((t) => ({
          name: t.name, url: t.url || '', bpm: t.bpm || null,
          artist: t.artist || '', duration: t.duration || 0, // 详情页要显示歌手和时长
        })),
      };
      l.unshift(pl);
      this._write(l);
      return pl;
    },
    get(id) { return this._read().find((x) => x.id === id) || null; },
    remove(id) { this._write(this._read().filter((x) => x.id !== id)); },
  };

  /* ---------- 导出 ---------- */
  const api = {
    RunnerEngine,
    Metronome,
    MusicPlayer,
    VoiceEngine,
    HeartRateMonitor,
    heartRateZone,
    PlaylistStore, // 运动结束后保存的歌单（按日期）
    BpmLibrary, // 暴露出来方便调试/扩充曲库
    DEFAULTS: {
      stages: DEFAULT_STAGES, startVoice: DEFAULT_START_VOICE, endVoice: DEFAULT_END_VOICE,
      cheers: DEFAULT_CHEERS, customBpm: DEFAULT_CUSTOM_BPM, customBpmRange: CUSTOM_BPM_RANGE.slice(),
    },
  };

  global.RunnerEngine = RunnerEngine;
  global.RunnerCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
