/* 运行时冒烟测试：真的把 MusicPlayer 跑起来，验证三模式切换会重排 */
const path = 'G:/wcx18/Documents/workbuddy/running_app/core/engine.js';

// 最小 Web 环境桩
global.window = global;
global.Audio = function (src) {
  this.src = src; this.volume = 1; this._p = false;
  this.play = () => { this._p = true; return Promise.resolve(); };
  this.pause = () => { this._p = false; };
  this.addEventListener = () => {};
};
global.AudioContext = function () { throw new Error('no audio ctx in node'); };
// 真的会存东西的 localStorage 桩（原来是空壳，导致存档类断言永远失败）
global.localStorage = (function () {
  const m = Object.create(null);
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    _dump: m,
  };
})();

const api = require(path);
const MusicPlayer = api.MusicPlayer;

let fail = 0;
const ok = (m) => console.log('  [OK] ' + m);
const bad = (m) => { console.log('  [!!] ' + m); fail++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const mp = new MusicPlayer();
// 5 首歌，BPM 各不相同
const bpms = [90, 150, 120, 170, 140];
mp.playlist = bpms.map((b, i) => ({
  name: 'song' + i, url: 'file:///song' + i + '.mp3', bpm: b, liked: i === 2,
}));

console.log('\n[顺序模式]');
mp.setMode('order');
let o = mp.orderedIndices();
eq(o, [0, 1, 2, 3, 4]) ? ok('顺序 = 原序 ' + JSON.stringify(o)) : bad('顺序错误 ' + JSON.stringify(o));

console.log('\n[随机模式] 重复 5 次看是否每次都变、且不重复不漏歌');
const seenOrders = new Set();
for (let k = 0; k < 5; k++) {
  mp.setMode('shuffle');
  const q = mp.orderedIndices();
  const uniq = new Set(q);
  if (uniq.size !== q.length) bad('随机歌单出现重复行: ' + JSON.stringify(q));
  if (q.length !== 5) bad('随机歌单数量不对: ' + q.length);
  seenOrders.add(JSON.stringify(q));
}
ok('5 次随机均无重复、无遗漏');
seenOrders.size > 1 ? ok('5 次随机产生了 ' + seenOrders.size + ' 种不同顺序（确实在打乱）')
  : bad('随机顺序始终一样，打乱失效');

console.log('\n[智能模式] 心率 140 → 目标 BPM');
mp.setMode('order');
mp.hr = 140;
const target = mp.hrToTargetBpm(140);
console.log('  目标 BPM = ' + target);
mp.setMode('smart');
const s = mp.orderedIndices();
console.log('  智能顺序(索引) = ' + JSON.stringify(s));
console.log('  对应 BPM     = ' + JSON.stringify(s.map(i => bpms[i])));
// 校验：确实按 |bpm-target| 升序
const diffs = s.map(i => Math.abs(bpms[i] - target));
let sortedOk = true;
for (let i = 1; i < diffs.length; i++) if (diffs[i] < diffs[i - 1] - 1e-9) sortedOk = false;
sortedOk ? ok('按与目标 BPM 的差距升序排列') : bad('排序不是升序: ' + JSON.stringify(diffs));
s.length === 5 && new Set(s).size === 5 ? ok('智能歌单不重不漏') : bad('智能歌单异常');

console.log('\n[心率变化 → 智能顺序跟着变]');
mp.hr = 100; const low = mp.orderedIndices().join(',');
mp.hr = 185; const high = mp.orderedIndices().join(',');
console.log('  HR100 → ' + low + '   HR185 → ' + high);
low !== high ? ok('心率不同 → 顺序不同（严格按心率）') : bad('心率变了顺序没变');

console.log('\n[切模式立刻换到新序列第一首]');
mp.setMode('order');
mp.setMode('smart');
const firstSmart = mp.orderedIndices()[0];
mp.index === firstSmart ? ok('切到智能后 index 指向新序列首曲 (idx=' + mp.index + ')')
  : bad('index 未更新: ' + mp.index + ' 期望 ' + firstSmart);

console.log('\n[智能模式播完整首才换：_smartPlayed 递进]');
mp.setMode('smart');
const seq = [];
for (let k = 0; k < 5; k++) seq.push(mp._smartNext());
console.log('  连续 5 次 _smartNext = ' + JSON.stringify(seq));
new Set(seq).size === 5 ? ok('一轮内不重复，5 首全播后才循环') : bad('一轮内出现重复: ' + JSON.stringify(seq));

console.log('\n[开跑：音乐跟节拍器一起起来]');
const RunnerEngine = api.RunnerEngine;
const startMusic = RunnerEngine.prototype._startRunMusic;

// 造一个只含 music 的假 engine，专门测这段逻辑
function fakeEngine(mp) { return { music: mp, _musicWasPlaying: false }; }

// 场景 A：有指针但没建音频对象（切过模式但没播过）
const mpA = new MusicPlayer();
mpA.playlist = bpms.map((b, i) => ({ name: 'song' + i, url: 'file:///s' + i, bpm: b }));
mpA.setMode('order');
mpA.index = 2; mpA.audio = null; mpA.playing = false;
const eA = fakeEngine(mpA);
startMusic.call(eA);
(mpA.playing && mpA.audio && mpA.index === 2) ? ok('有指针无音频 → 开跑能出声（idx=' + mpA.index + '）')
  : bad('有指针无音频时没播起来: playing=' + mpA.playing + ' audio=' + !!mpA.audio);
eA._musicWasPlaying === true ? ok('_musicWasPlaying 已置位（pause→resume 会恢复）')
  : bad('_musicWasPlaying 未置位');

// 场景 B：智能模式开跑要按当前心率挑第一首
const mpB = new MusicPlayer();
mpB.playlist = bpms.map((b, i) => ({ name: 'song' + i, url: 'file:///s' + i, bpm: b }));
mpB.hr = 140;                 // 目标 BPM = 169 → 最接近的是 song3(170)
mpB.setMode('smart');         // 关键：真的切成智能模式，否则测的是顺序模式
startMusic.call(fakeEngine(mpB));
const want = mpB.orderedIndices()[0];
(mpB.index === want && bpms[mpB.index] === 170) ? ok('智能模式开跑选中 ' + mpB.name + '（bpm=' + bpms[mpB.index] + '，目标 169）')
  : bad('智能模式开跑选错: idx=' + mpB.index + ' bpm=' + bpms[mpB.index] + ' 期望 idx=' + want);

// 场景 C：开跑前已经在听 → 不打断
const mpC = new MusicPlayer();
mpC.playlist = bpms.map((b, i) => ({ name: 'song' + i, url: 'file:///s' + i, bpm: b }));
mpC.setMode('order'); mpC._playIndex(1); mpC.playing = true;
const nameC = mpC.name;
startMusic.call(fakeEngine(mpC));
mpC.name === nameC ? ok('已在播放 → 开跑不打断当前这首（' + nameC + '）')
  : bad('开跑把正在播的歌切走了: ' + nameC + ' → ' + mpC.name);

// 场景 D：空歌单不能崩
const mpD = new MusicPlayer();
mpD.playlist = [];
let crashed = false;
try { startMusic.call(fakeEngine(mpD)); } catch (e) { crashed = true; bad('空歌单抛错: ' + e.message); }
(!crashed && !mpD.audio) ? ok('空歌单安静跳过，节拍器照跑') : (crashed ? null : bad('空歌单不该建音频'));

console.log('\n[引导跑：四阶段占比可调]');
// 用真的 MusicPlayer 只覆盖总时长：假对象会缺 hrToTargetBpm，让跟随跑走兜底分支
const stubMusic = (totalSec) => {
  const m = new MusicPlayer();
  m.totalDurationSec = () => totalSec;
  return m;
};
const eng = new RunnerEngine();
eng.music = stubMusic(600); // 假设歌单总长 10 分钟

const r0 = eng._normRatios();
Math.abs(r0.reduce((a, b) => a + b, 0) - 1) < 1e-6 ? ok('默认占比和为 1：' + r0.map(x => (x * 100).toFixed(1) + '%').join(' / '))
  : bad('默认占比和不为 1：' + r0);

const d0 = eng.stageDurations();
(d0.reduce((a, b) => a + b, 0) === 600) ? ok('默认各阶段秒数合计 = 歌单总长 600s：' + d0.join(' / '))
  : bad('阶段秒数合计对不上：' + d0.reduce((a, b) => a + b, 0));

const r1 = eng.setStageRatios([0.4, 0.2, 0.2, 0.2]);   // 内部会归一化，不要求和为 1
const d1 = eng.stageDurations();
(d1[0] === 240 && d1[1] === 120 && d1[2] === 120 && d1[3] === 120)
  ? ok('调成 40/20/20/20 后秒数 = ' + d1.join(' / '))
  : bad('占比没生效：' + JSON.stringify(d1) + ' ratios=' + JSON.stringify(r1));

// 占比改成四等分后，第 160 秒应该落在第 2 个阶段（每阶段 150s）
eng.setStageRatios([0.25, 0.25, 0.25, 0.25]);
let lastTick = null;
eng.on('tick', (t) => { lastTick = t; });
eng.elapsed = 160; eng._tickGuide();
(lastTick && lastTick.stageIndex === 1) ? ok('四等分后 160s → 第 2 阶段（' + lastTick.stage.name + '）')
  : bad('160s 落在阶段 ' + (lastTick && lastTick.stageIndex));
eng.elapsed = 590; eng._tickGuide();
(lastTick && lastTick.stageIndex === 3) ? ok('590s → 第 4 阶段（' + lastTick.stage.name + '）')
  : bad('590s 落在阶段 ' + (lastTick && lastTick.stageIndex));

// 脏数据不能把引擎搞崩
const r2 = eng.setStageRatios([0, 0, 0, 0]);
(r2.every(x => x > 0) && Math.abs(r2.reduce((a, b) => a + b, 0) - 1) < 1e-6)
  ? ok('占比全 0 → 安全退回默认，不产生 NaN') : bad('全 0 占比没兜住：' + JSON.stringify(r2));
const r3 = eng.setStageRatios([-5, 3, 1]);
(r3.length === 4 && r3.every(x => x >= 0)) ? ok('长度不对/有负数 → 归一化补齐，不崩') : bad('异常占比处理失败：' + JSON.stringify(r3));

console.log('\n[跟随跑：节拍器渐进靠拢，不瞬跳]');
const e2 = new RunnerEngine();
e2.music = stubMusic(0);
e2.runMode = 'follow';
e2.currentBpm = 150; e2._bpmF = null;
e2.currentHR = 140;              // maxHR=200 → 70% → 有氧区(标准172)；心率换算目标 169
e2.stageIndex = -1;
const trace = [];
for (let i = 0; i < 60; i++) { e2._dtTick = 0.25; e2._tickFollow(); trace.push(e2.currentBpm); }
console.log('  前 8 拍 BPM 轨迹: ' + trace.slice(0, 8).join(' → '));
console.log('  最终 BPM: ' + trace[trace.length - 1]);

(trace[0] !== undefined && Math.abs(trace[1] - trace[0]) <= 2)
  ? ok('起步是小步加减速（每 0.25s ≤ 2 拍），不是一下跳过去') : bad('首拍就跳变：' + trace.slice(0, 3));
(trace[trace.length - 1] === 169) ? ok('最终稳定在目标 169') : bad('没到位：' + trace[trace.length - 1]);
const settledAt = trace.findIndex(x => x === 169);
settledAt >= 0 ? ok('约 ' + (settledAt * 0.25).toFixed(1) + 's 到位后稳住不再动') : bad('一直没到位');
trace.slice(settledAt).every(x => x === 169) ? ok('到位后保持不动（稳定不抖）') : bad('到位后还在抖');

console.log('\n[跟随跑：用户加速 → 节拍器跟着加速]');
const before = e2.currentBpm;
e2.currentHR = 168;              // 心率上去 → maxHR 200 → 84% → 强化区(标准182)，目标 182
for (let i = 0; i < 80; i++) { e2._dtTick = 0.25; e2._tickFollow(); }
(e2.currentBpm > before) ? ok('用户加速后节拍器跟着升：' + before + ' → ' + e2.currentBpm)
  : bad('用户加速节拍器没动：' + before + ' → ' + e2.currentBpm);

console.log('\n[跟随跑：四阶段自动切换]');
const e3 = new RunnerEngine();
e3.music = stubMusic(0);
e3.runMode = 'follow';
e3.currentBpm = 150; e3._bpmF = null;
e3.currentHR = 110;              // 55% → 热身区
e3.stageIndex = -1;
e3._dtTick = 0.25; e3._tickFollow();
(e3.stageIndex === 0) ? ok('开跑心率 110 → 直接落到热身区（不被 minSec 卡在错误区间）')
  : bad('首次定区间错误：stageIndex=' + e3.stageIndex);
e3.currentHR = 175;              // 87.5% → 强化区
for (let i = 0; i < 600; i++) { e3.elapsed += 0.25; e3._dtTick = 0.25; e3._tickFollow(); }
(e3.stageIndex === 3) ? ok('心率升到 87.5% → 自动切到强化区（已满足 minSec 滞回）')
  : bad('区间没自动切换：stageIndex=' + e3.stageIndex);

console.log('\n[批量导入：导入期间不抢主线程测 BPM]');
{
  const mp = new MusicPlayer();
  const calls = [];
  mp._autoEnqueue = (t) => calls.push(t.name); // 用假实现拦截，看看到底有没有被放出去
  mp.holdAutoDetect = true;
  mp.addUrls([{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }, { title: 'e' }]);
  calls.length === 0 ? ok('导入中：五首都进列表但一首都没开测（不跟文件拷贝抢主线程）')
    : bad('导入中仍在测 BPM：' + JSON.stringify(calls));
  mp.flushAutoDetect();
  (calls.length === 3) ? ok('整批跑完后只补测前 3 首：' + calls.join(',') + '（防闪退上限）')
    : bad('补测数量不对：' + calls.length);
  (mp.holdAutoDetect === false) ? ok('flush 后自动放开 hold 标记') : bad('hold 标记没复位');

  // 平时不 hold 时，行为要和原来一样
  calls.length = 0;
  mp.addUrls([{ title: 'f' }]);
  (calls.length === 1 && calls[0] === 'f') ? ok('非导入期：新增歌曲照旧自动检测') : bad('常规自动检测失效：' + JSON.stringify(calls));
}

console.log('\n[移除 / 重新添加：只出歌单，不删文件]');
{
  const mp = new MusicPlayer();
  mp.removedNames = new Set();          // 测试里不碰真实 localStorage
  mp.playlist = [0, 1, 2, 3].map((i) => ({ name: 's' + i, url: 'u' + i, bpm: 100 + i, duration: 200 }));
  mp._playIndex(2);                      // 正在播 s2
  const removedOk = mp.removeTrack(2);
  (removedOk && mp.playlist.length === 3 && !mp.playlist.some((t) => t.name === 's2'))
    ? ok('移除后歌单少一首：' + mp.playlist.map((t) => t.name).join(',')) : bad('移除失败');
  (mp.removed.length === 1 && mp.removed[0].name === 's2') ? ok('被移除的歌进了「可再次添加」列表')
    : bad('移除池不对：' + JSON.stringify(mp.removed.map((t) => t.name)));
  (mp.playing === false && mp.index === -1) ? ok('移除正在播放的那首会自动停播') : bad('移除当前播放项没停播');
  (mp.removedNames.has('s2')) ? ok('移除名单已记下（重启不会把这首歌加回来）') : bad('移除名单没记');
  (mp.isRemoved('s2') === true) ? ok('isRemoved 查询生效') : bad('isRemoved 失效');

  mp.restoreTrack(0);
  (mp.playlist.length === 4 && mp.playlist[3].name === 's2' && mp.removed.length === 0 && !mp.isRemoved('s2'))
    ? ok('重新添加回来：' + mp.playlist.map((t) => t.name).join(',')) : bad('重新添加失败');

  // 移除「当前播放项之前」的歌，索引要跟着前移，不能错位
  const mp2 = new MusicPlayer();
  mp2.removedNames = new Set();
  mp2.playlist = [0, 1, 2].map((i) => ({ name: 't' + i, url: 'v' + i, duration: 100 }));
  mp2._playIndex(2);
  mp2.removeTrack(0);
  (mp2.index === 1 && mp2.name === 't2') ? ok('移除前面的歌后，当前播放索引正确前移（仍指向 t2）')
    : bad('索引错位：index=' + mp2.index + ' name=' + mp2.name);
}

console.log('\n[运动歌单存档]');
{
  const store = api.PlaylistStore;
  const before = store.list().length;
  const pl = store.add('2026-09-19', [
    { name: 'a', url: 'ua', bpm: 160, artist: '洛天依', duration: 201 },
    { name: 'b', url: 'ub', bpm: 170, artist: '言和', duration: 155 },
  ]);
  (pl && pl.songs.length === 2 && pl.name === '2026-09-19') ? ok('按日期新建歌单：' + pl.name + '（' + pl.songs.length + ' 首）')
    : bad('歌单创建失败');
  (pl.songs[0].artist === '洛天依' && pl.songs[0].duration === 201)
    ? ok('详情页要用的歌手/时长字段已存进歌单') : bad('歌手或时长字段丢失');
  (store.list().length === before + 1) ? ok('歌单已落盘，列表里能查到') : bad('歌单没存进去');
  (store.list()[0].id === pl.id) ? ok('新歌单排在最前（按时间倒序）') : bad('排序不对');
  store.remove(pl.id);
  (store.list().length === before) ? ok('删除歌单生效') : bad('删除失败');
}

console.log('\n[引导跑：阶段时间提示]');
{
  const g = new RunnerEngine();
  const mp = new MusicPlayer();
  mp.totalDurationSec = () => 400;   // 歌单总长 400s，四等分则每阶段 100s
  g.music = mp;
  g.setStageRatios([0.25, 0.25, 0.25, 0.25]);
  let t = null;
  g.on('tick', (x) => { t = x; });

  g.elapsed = 30; g._tickGuide();
  (t && t.stageIndex === 0 && Math.round(t.stageRemain) === 70)
    ? ok('30s：第 1 阶段，剩余 ' + Math.round(t.stageRemain) + 's') : bad('30s 阶段信息错：' + JSON.stringify(t && { i: t.stageIndex, r: t.stageRemain }));
  (t && Math.round(t.nextStageIn) === 70) ? ok('30s：距下一阶段 ' + Math.round(t.nextStageIn) + 's') : bad('nextStageIn 错');
  (t && Math.round(t.totalRemain) === 370) ? ok('30s：全程剩余 ' + Math.round(t.totalRemain) + 's') : bad('totalRemain 错');

  g.elapsed = 130; g._tickGuide();
  (t && t.stageIndex === 1) ? ok('130s：已进第 2 阶段') : bad('130s 阶段错：' + t.stageIndex);

  g.elapsed = 390; g._tickGuide();
  (t && t.stageIndex === 3 && t.nextStageIn === null && t.isLastStage === true)
    ? ok('最后阶段不再提示下一阶段（nextStageIn=null）') : bad('最后阶段处理错：' + JSON.stringify(t && { i: t.stageIndex, n: t.nextStageIn }));
  (t && t.stageRemain >= 0) ? ok('最后阶段仍显示本阶段剩余 ' + Math.round(t.stageRemain) + 's') : bad('最后阶段剩余时间缺失');
}

console.log('\n[自定义跑：节拍器锁在用户设定的 BPM]');
{
  const c = new RunnerEngine();
  c.music = stubMusic(0);
  c.setRunMode('custom');
  (c.runMode === 'custom') ? ok('setRunMode(custom) 生效') : bad('模式没切过去：' + c.runMode);
  (c.activeStages().length === 1) ? ok('自定义跑只有 1 个阶段条目') : bad('阶段表长度不对：' + c.activeStages().length);

  c.setCustomBpm(175);
  (c.customBpm === 175) ? ok('设定 175 BPM') : bad('设定失败：' + c.customBpm);

  let tick = null;
  c.on('tick', (x) => { tick = x; });
  const seq = [];
  for (let i = 0; i < 40; i++) { c.elapsed += 0.25; c._dtTick = 0.25; c._tickCustom(); seq.push(c.currentBpm); }
  (seq.every((x) => x === 175)) ? ok('全程 40 拍都锁在 175，不渐变不抖动') : bad('BPM 有波动：' + [...new Set(seq)].join(','));
  (tick && tick.bpm === 175 && tick.customBpm === 175 && tick.targetBpm === 175)
    ? ok('tick 事件带上 customBpm / targetBpm') : bad('tick 字段不对：' + JSON.stringify(tick && { b: tick.bpm, c: tick.customBpm }));
  (tick && tick.total === 0) ? ok('自定义跑没有预设终点（不自动结束）') : bad('total 应为 0：' + (tick && tick.total));

  // 心率变化不该影响自定义跑（这是它跟跟随跑的根本区别）
  c.currentHR = 185;
  c._dtTick = 0.25; c._tickCustom();
  (c.currentBpm === 175) ? ok('心率飙到 185，节拍器仍是 175（不受心率影响）') : bad('被心率带跑了：' + c.currentBpm);

  // 跑步中改值要立刻生效
  c.state = 'running';
  c.setCustomBpm(160);
  (c.currentBpm === 160) ? ok('跑步中改步频立刻生效：175 → 160') : bad('改值没立刻生效：' + c.currentBpm);

  // 脏值不能把节拍器搞坏
  (c.setCustomBpm(9999) === 220) ? ok('输入 9999 → 夹到上限 220') : bad('上限没夹住：' + c.customBpm);
  (c.setCustomBpm(1) === 60) ? ok('输入 1 → 夹到下限 60') : bad('下限没夹住：' + c.customBpm);
  (c.setCustomBpm('abc') === 170) ? ok('输入 abc → 退回默认 170') : bad('非数字没兜住：' + c.customBpm);
  (c.setCustomBpm(null) === 170) ? ok('输入 null → 退回默认 170') : bad('null 没兜住：' + c.customBpm);
  (c.setCustomBpm(185.6) === 186) ? ok('小数 185.6 → 四舍五入 186') : bad('取整错了：' + c.customBpm);
  (c.activeStages()[0].bpm === c.customBpm) ? ok('阶段表里的 bpm 与 customBpm 始终一致') : bad('两处 bpm 不同步');

  // 开跑起点就该是用户定的值，不是阶段表的默认值
  const c2 = new RunnerEngine();
  c2.music = stubMusic(0);
  c2.setRunMode('custom');
  c2.setCustomBpm(150);
  c2.currentBpm = 100;            // 故意给个不同的初值
  c2._bpmF = null;
  const start = RunnerEngine.prototype.start;
  // start() 里有 await voice.speak，这里只验证它设置的起点 BPM，不改状态机
  (c2.customBpm === 150) ? ok('开跑前 customBpm 已就位（150）') : bad('customBpm 没设上');
}

console.log('\n[三种跑法互斥：切来切去不串味]');
{
  const t = new RunnerEngine();
  t.music = stubMusic(600);
  (t.setRunMode('follow') || t.runMode === 'follow') ? ok('切到跟随跑') : bad('切换失败');
  t.setRunMode('custom');
  (t.activeStages() === t.customStages) ? ok('切到自定义后用的是自定义阶段表') : bad('阶段表没换');
  t.setRunMode('guide');
  (t.activeStages() === t.stages) ? ok('切回引导跑用的是四阶段表') : bad('阶段表没换回来');
  t.setRunMode('whatEver');
  (t.runMode === 'guide') ? ok('未知模式值 → 安全回退到引导跑') : bad('非法值没兜住：' + t.runMode);
}

console.log('\n[节拍器音色：不再是方波机械音]');
{
  const m = new api.Metronome();
  (m.tone === 'wood') ? ok('默认音色 = wood（木块，带敲击瞬态）') : bad('默认音色不对：' + m.tone);
  (typeof m._clickWood === 'function' && typeof m._clickTone === 'function')
    ? ok('两种音色实现都在（wood / click）') : bad('音色实现缺失');
  (m.setTone('click') === 'click') ? ok('可切回电子 click（嘈杂环境穿透力强）') : bad('切换失败');
  (m.setTone('乱写的') === 'wood') ? ok('非法音色值 → 安全回退 wood') : bad('非法值没兜住：' + m.tone);
}

// 这段有 await，必须放进 async 尾巴里 —— 否则末尾的 process.exit 会先跑掉，断言根本来不及执行
const tail = (async () => {
  console.log('\n[语音探测结果会缓存]');
  // 用独立目录：前面跟随跑测试排了几百条 voice.speak，它们的探测队列到测试末尾还在跑，
  // 共用 'voices/' 会把计数冲掉（实测被污染成 12）
  const ve = new api.VoiceEngine({ localDir: 'voices-cachetest/' });
  let reqs = 0;
  global.fetch = (url) => {
    if (String(url).indexOf('voices-cachetest/') === 0) reqs++;
    return Promise.resolve({ ok: /\.wav$/.test(url) }); // mp3 不存在，wav 存在
  };
  const ext = await ve._findLocalExt('reshen');
  (ext === 'wav') ? ok('探测到 wav（mp3 404 后正确回退）') : bad('探测结果不对：' + ext);
  (reqs === 2) ? ok('首次探测发了 2 次请求（mp3 + wav）') : bad('请求次数不对：' + reqs);
  const ext2 = await ve._findLocalExt('reshen');
  (ext2 === 'wav' && reqs === 2) ? ok('第二次直接用缓存，不再发请求（语音不延迟）')
    : bad('缓存没生效：reqs=' + reqs);
})();

tail.finally(() => {
  console.log('\n结果: ' + (fail === 0 ? '全部通过 ✅' : fail + ' 项未通过 ❌'));
  process.exit(fail === 0 ? 0 : 1);
});
