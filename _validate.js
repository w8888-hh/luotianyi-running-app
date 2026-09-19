const fs = require('fs');
const vm = require('vm');

const ENG = 'G:/wcx18/Documents/workbuddy/running_app/core/engine.js';
const HTML = 'G:/wcx18/Documents/workbuddy/running_app/integrated.html';

let fail = 0;
const ok = (m) => console.log('  [OK] ' + m);
const bad = (m) => { console.log('  [!!] ' + m); fail++; };

// ---- 1. engine.js 语法 ----
const eng = fs.readFileSync(ENG, 'utf8');
try {
  new vm.Script(eng, { filename: 'engine.js' });
  ok('engine.js 语法 OK');
} catch (e) {
  bad('engine.js 语法错误: ' + e.message);
}

// ---- 2. integrated.html 内联脚本语法 ----
const html = fs.readFileSync(HTML, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
console.log('  内联 <script> 块数量: ' + scripts.length);
scripts.forEach((s, i) => {
  try {
    new vm.Script(s, { filename: 'inline-' + i + '.js' });
    ok('inline script #' + i + ' 语法 OK (' + s.length + ' 字符)');
  } catch (e) {
    bad('inline script #' + i + ' 语法错误: ' + e.message);
  }
});
const allJs = scripts.join('\n');

// ---- 3. 必需标识符存在性 ----
const needEng = ['orderedIndices', '_sortedByHr', 'setMode', 'hrToTargetBpm', '_smartNext',
  'setRunMode', 'FOLLOW_STAGES', 'totalDurationSec', 'hrSeries',
  // 引导跑占比 / 跟随跑渐进
  'DEFAULT_STAGE_RATIOS', 'FOLLOW_BPM_SLACK', 'stageRatios', 'setStageRatios', 'stageDurations',
  // 本轮新增引擎能力
  'probeDurations', 'removeTrack', 'restoreTrack', 'addToRemoved', 'isRemoved',
  'removedNames', 'resetPlayLog', 'playedNames', 'onSeek', 'PlaylistStore',
  // 自定义跑（第三种跑法）
  'customStages', 'customBpm', 'setCustomBpm', '_clampBpm', '_tickCustom', 'CUSTOM_BPM_RANGE',
  'stageRemain', 'nextStageIn', 'isLastStage'];
console.log('\n[engine.js 关键成员]');
needEng.forEach(k => (eng.includes(k) ? ok : bad)('engine 含 ' + k));

const needUi = ['RUNMODE_LABEL', 'runmode-badge', 'syncRunModeUI', 'renderMusicList',
  '跟天依跑', '天依跟你跑', 'orderedIndices', 'refreshHrCard', 'hrChartSVG', 'Kalman1D',
  // 阶段占比设置界面
  'stageRatioBtn', 'ratioOverlay', 'openStageRatio', 'buildStageRatioOverlay',
  'renderRatioRows', 'syncRatioRows', 'onRatioInput', 'updateRunModeHint',
  // 本轮新增：阶段提示 / 移除 / 批量导入 / 结束存歌单 / 我的歌单 / 通知条
  'stage-time', 'updateStageTime', 'fmtClock', 'refreshStageTime',
  'remove-btn', 'removedBox', 'renderRemovedBox', 'restore-btn',
  'tabSaved', 'savedView', 'renderSavedPlaylists', 'fmtDate', 'todayStr',
  'bindLongPress', 'albumSel', 'importSelectedAlbumSongs',
  'savePlaylistBlockHTML', 'wireSavePlaylist', 'playedTracksThisRun',
  'RunNotify', 'syncRunNotify',
  'persistRatios', 'stageDurations', 'converging',
  // 自定义跑：模式按钮 / 设定浮层 / 跑步页胶囊
  'modeCustom', 'RUNMODE_COLOR', 'customBpmBtn', 'bpmOverlay', 'openCustomBpm',
  'buildCustomBpmOverlay', 'setBpmValue', 'syncBpmUI', 'BPM_PRESETS',
  'persistCustomBpm', 'custom-bpm-chip', 'stopBpmPreview'];
// 跟随跑渐进时不能去调引擎上不存在的 hrToTargetBpm（那是 MusicPlayer 的方法）。
// 只在 RunnerEngine 之后检查：MusicPlayer 内部用 this.hrToTargetBpm 是对的。
const engTail = eng.slice(eng.indexOf('class RunnerEngine'));
(/this\.hrToTargetBpm\(/.test(engTail) ? bad : ok)('RunnerEngine 内没有误用 this.hrToTargetBpm');
// 每行歌都必须先创建 row 元素，曾因漏掉这行导致整个歌单渲染不出来
const rowCreated = /const\s+row\s*=\s*document\.createElement\('div'\)/.test(allJs);
(rowCreated ? ok : bad)('renderMusicList 内有 const row = document.createElement');
console.log('\n[integrated.html 关键成员]');
needUi.forEach(k => ((html.includes(k) || allJs.includes(k)) ? ok : bad)('页面含 ' + k));

// ---- 4. badge 数量 ----
const badgeCount = (html.match(/runmode-badge/g) || []).length;
console.log('\n[runmode-badge 出现次数] ' + badgeCount);
if (badgeCount >= 3) ok('徽章已出现在高/低性能跑步页 + 样式/脚本引用');
else bad('徽章出现次数不足 (>=3)，实际 ' + badgeCount);

// ---- 4b. 自定义跑 ----
console.log('\n[自定义跑]');
// setRunMode 必须放行 custom，否则第三种跑法永远选不中（曾写成只认 follow）
(/this\.runMode\s*=\s*\(m\s*===\s*'follow'\s*\|\|\s*m\s*===\s*'custom'\)\s*\?\s*m\s*:\s*'guide'/.test(eng)
  ? ok : bad)('setRunMode 接受 custom');
// _tick 必须把 custom 分派到 _tickCustom，否则会掉进 _tickGuide 走四阶段渐变
(/runMode === 'custom'\) this\._tickCustom\(\)/.test(eng)
  ? ok : bad)('_tick 已分派 _tickCustom');
// 只数页面里的元素定义：JS 里的选择器引用不算（setAll 用了 3 次）
const chipCount = (html.match(/class="custom-bpm-chip"/g) || []).length;
console.log('  步频胶囊出现次数: ' + chipCount);
(chipCount === 2 ? ok : bad)('两个跑步页各有一个步频胶囊（高/低性能）');
// 关浮层必须停试听，否则节拍器会在用户退出后一直响
(/function closeCustomBpm\(\)[\s\S]{0,200}?stopBpmPreview\(\)/.test(allJs)
  ? ok : bad)('关闭浮层会停掉试听');
// 跑步中不能开试听：那会把正在跑的节拍器停掉
(/if \(engine\.state === 'running' \|\| engine\.state === 'paused'\) return;/.test(allJs)
  ? ok : bad)('跑步中禁止试听（不会把节拍器停掉）');

// ---- 5. 模式按钮是否触发 renderMusicList ----
console.log('\n[模式切换刷新歌单]');
const modeBlock = allJs.match(/function\s+setMusicMode[\s\S]{0,600}/);
if (modeBlock) {
  const b = modeBlock[0];
  (b.includes('renderMusicList') ? ok : bad)('setMusicMode 内调用 renderMusicList');
  (b.includes('syncModeUI') ? ok : bad)('setMusicMode 内调用 syncModeUI');
} else {
  // 可能叫别的名字，搜一下谁调用了 setMode
  const callers = [...allJs.matchAll(/(\w+)\s*=\s*function[^{]*\{[^]{0,400}?setMode\(/g)].map(m => m[1]);
  console.log('  未找到 setMusicMode，找到可能的调用者: ' + JSON.stringify(callers));
  const idx = allJs.indexOf('.setMode(');
  if (idx > 0) {
    const around = allJs.slice(Math.max(0, idx - 700), idx + 300);
    (around.includes('renderMusicList') ? ok : bad)('setMode 调用上下文附近存在 renderMusicList');
  } else bad('页面未调用 engine.music.setMode');
}

console.log('\n结果: ' + (fail === 0 ? '全部通过 ✅' : fail + ' 项未通过 ❌'));
process.exit(fail === 0 ? 0 : 1);
