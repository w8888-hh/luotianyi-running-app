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

    _click(beatIndex, time) {
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
      const data = audioBuffer.getChannelData(0);
      const sr = audioBuffer.sampleRate;
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
    }

    load(file) { this.loadList([file]); }

    // 加载内置音乐（URL 列表，无需 File）
    loadUrls(items) {
      this._clear();
      this.playlist = (items || []).map((it) => ({ name: it.title, file: null, url: it.url, bpm: null, liked: false }));
      this.index = -1;
      this.name = this.playlist.length
        ? (this.playlist.length === 1 ? this.playlist[0].name : this.playlist.length + ' 首歌')
        : '';
      if (this.onListChange) this.onListChange();
    }

    loadList(files) {
      this._clear();
      this.playlist = (files || []).map((f) => ({ name: f.name, file: f, url: URL.createObjectURL(f), bpm: null, liked: false }));
      this.index = -1;
      this.name = this.playlist.length
        ? (this.playlist.length === 1 ? this.playlist[0].name : this.playlist.length + ' 首歌')
        : '';
      if (this.onListChange) this.onListChange();
      this.playlist.forEach((t) => this._detectBpm(t)); // 后台检测 BPM
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

    async _detectBpm(track) {
      try {
        const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
        if (!AC) { track.bpm = null; return; }
        const ctx = new AC();
        const slice = track.file.slice(0, 2 * 1024 * 1024); // 取前 2MB 检测
        const ab = await slice.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        track.bpm = detectBPM(buf);
        ctx.close();
      } catch (e) {
        track.bpm = null;
      }
      if (this.onListChange) this.onListChange();
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
      this.audio = new Audio(track.url);
      this.audio.volume = this.volume;
      this.audio.onended = () => this.next(); // 播完自动切下一首
      this.audio.play().catch(() => {});
      this.playing = true;
      this.name = track.name;
      if (this.onTrack) this.onTrack(track.name, i);
    }

    playTrack(i) { this._playIndex(i); }

    play() {
      if (!this.playlist.length) return;
      if (this.index < 0) this._playIndex(this.mode === 'shuffle' ? this._shuffleNext() : 0);
      else if (this.audio) { this.audio.play().catch(() => {}); this.playing = true; }
    }
    pause() { if (this.audio) { this.audio.pause(); this.playing = false; } }
    toggle() { this.playing ? this.pause() : this.play(); }
    next() {
      if (this.mode === 'shuffle') this._playIndex(this._shuffleNext());
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

    setMode(m) {
      this.mode = (m === 'shuffle' || m === 'smart') ? m : 'order';
      if (this.mode === 'shuffle') this._buildQueue();
      else { this.queue = []; this.queuePos = -1; }
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
    }

    // 探测本地音频扩展名（mp3 优先），用 HEAD 请求确认存在，返回 ext 或 null
    _findLocalExt(voiceId) {
      if (!this.useLocal || !voiceId) return Promise.resolve(null);
      const exts = ['mp3', 'wav', 'ogg', 'm4a'];
      const probe = (i) => {
        if (i >= exts.length) return Promise.resolve(null);
        return fetch(this.localDir + voiceId + '.' + exts[i], { method: 'HEAD' })
          .then((r) => (r.ok ? exts[i] : probe(i + 1)))
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
      this.startVoice = config.startVoice || DEFAULT_START_VOICE;
      this.endVoice = config.endVoice || DEFAULT_END_VOICE;
      this.pauseVoice = config.pauseVoice || DEFAULT_PAUSE_VOICE;
      this.resumeVoice = config.resumeVoice || DEFAULT_RESUME_VOICE;
      this.cheers = config.cheers || DEFAULT_CHEERS;
      this.cheerInterval = config.cheerInterval || [35, 55]; // 秒，随机区间
      this.hrMode = config.hrMode !== false; // 心率驱动阶段切换（默认开启）

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
      this.currentHR = null;       // 最近一次心率读数（bpm）
      this._musicWasPlaying = false; // 暂停前音乐是否在播（用于恢复）

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

      // 开场白（等它播完再起节拍，体验更自然）
      await this.voice.speak('start', this.startVoice.voice, this.startVoice.voiceId);

      // 开场白期间可能被暂停/停止，检查状态，避免暂停后节拍器又被启动
      if (this.state !== 'running') return;

      this._applyStage(0);
      this.metronome.setBpm(this.stages[0].startBpm);
      this.metronome.start();

      this._timer = setInterval(() => this._tick(), 250);
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
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this._setState('finished');
      this.voice.cancel();
      this.voice.speak('end', this.endVoice.voice, this.endVoice.voiceId);
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

    _applyStage(idx) {
      if (idx === this.stageIndex) return;
      this.stageIndex = idx;
      this.emit('stage', this.stages[idx], idx);
      if (this.stages[idx]) {
        this.voice.speak('stage', this.stages[idx].voice, this.stages[idx].voiceId);
        // 智能模式：阶段切换时自动推荐匹配 BPM 的音乐
        if (this.music.mode === 'smart') this._recommendMusic(this.stages[idx]);
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
      this.elapsed = this._accum + (now() - this._segStart) / 1000;
      if (this.hrMode) {
        this._tickHeartRate();
      } else {
        this._tickTime();
      }
    }

    /* 时间驱动（hrMode=false）：按固定时长推进阶段，BPM 线性渐升 */
    _tickTime() {
      const total = this.totalDuration();
      if (this.elapsed >= total) { this.finish(); return; }

      let acc = 0, idx = 0;
      for (let i = 0; i < this.stages.length; i++) {
        if (this.elapsed < acc + this.stages[i].dur) { idx = i; break; }
        acc += this.stages[i].dur; idx = i + 1;
      }
      const st = this.stages[idx];
      const local = this.elapsed - acc;
      const r = Math.min(1, local / st.dur);

      this._applyStage(idx);

      const bpm = Math.round(st.startBpm + (st.endBpm - st.startBpm) * r);
      this._setBpm(bpm);

      this._maybeCheer();

      this.emit('tick', { elapsed: this.elapsed, total, stage: st, stageIndex: idx, progress: r, bpm });
    }

    /* 心率驱动（hrMode=true）：根据实时心率切换阶段，BPM 用目标节拍引导 */
    _tickHeartRate() {
      if (this.stageIndex < 0) { this._applyStage(0); this._stageStartElapsed = this.elapsed; }

      const idx = this.stageIndex;
      const st = this.stages[idx];
      const hr = st.hr || {};
      const stageElapsed = this.elapsed - this._stageStartElapsed;
      const hrPct = this._hrPct();

      // 判断是否推进到下一阶段
      let advance = false;
      if (stageElapsed >= (hr.maxSec || st.dur)) {
        advance = true; // 时间兜底：防止心率一直达不到/不回落而卡住
      } else if (stageElapsed >= (hr.minSec || 0)) {
        if (hr.nextAbovePct && hrPct >= hr.nextAbovePct) advance = true;         // 心率升到阈值 → 进下一阶段
        if (hr.nextBelowPct && this.currentHR && hrPct <= hr.nextBelowPct) advance = true; // 心率回落到阈值 → 进放松
      }

      if (advance) {
        if (idx >= this.stages.length - 1) { this.finish(); return; }
        this._applyStage(idx + 1);
        this._stageStartElapsed = this.elapsed;
      }

      // 心率驱动下：BPM = 当前阶段目标节拍（固定引导用户达到目标强度）
      const cur = this.stages[this.stageIndex];
      this._setBpm(cur.endBpm);

      this._maybeCheer();

      const total = this.stages.reduce((s, x) => s + ((x.hr && x.hr.maxSec) || x.dur), 0);
      const r = Math.min(1, stageElapsed / (hr.maxSec || st.dur));
      this.emit('tick', { elapsed: this.elapsed, total, stage: cur, stageIndex: this.stageIndex, progress: r, bpm: cur.endBpm });
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

  /* ---------- 导出 ---------- */
  const api = {
    RunnerEngine,
    Metronome,
    MusicPlayer,
    VoiceEngine,
    HeartRateMonitor,
    heartRateZone,
    DEFAULTS: { stages: DEFAULT_STAGES, startVoice: DEFAULT_START_VOICE, endVoice: DEFAULT_END_VOICE, cheers: DEFAULT_CHEERS },
  };

  global.RunnerEngine = RunnerEngine;
  global.RunnerCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
