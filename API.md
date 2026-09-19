# RUN·陪跑 后端引擎接口文档（供 UI 层对接）

> 本引擎是**纯逻辑层**，不碰任何 DOM / 样式。UI（另一个 AI 负责）只需：
> 1. 引入 `core/engine.js`
> 2. `new RunnerEngine(配置)` 创建实例
> 3. 调用方法 + 订阅事件渲染界面

---

## 一、引入

```html
<script src="core/engine.js"></script>
```

```js
const engine = new RunnerEngine({ ...配置 });
```

---

## 二、快速开始（最小可运行示例）

```js
const engine = new RunnerEngine({
  // UI 订阅事件（可选，也可用 engine.on(...)）
  onState:  (s)  => console.log('状态:', s),
  onStage:  (stage, i) => console.log('阶段:', stage?.name, i),
  onBpm:    (bpm) => console.log('目标BPM:', bpm),
  onBeat:   (beat, accent) => { /* 驱动节拍动画 */ },
  onVoice:  ({ type, text, voiceId, local }) => console.log('语音:', type, text, '本地音频?', local),
  onCheer:  (text) => console.log('鼓励:', text),
  onHeartRate: (d) => console.log('心率:', d.bpm, 'BPM'),
  onTick:   ({ elapsed, stage, progress, bpm }) => { /* 每秒渲染进度 */ },
});

// 开始 / 暂停 / 恢复 / 停止
engine.start();
engine.pause();
engine.resume();
engine.stop();

// 音乐
engine.music.load(file); engine.music.play(); engine.music.pause();

// 心率
engine.heartRate.connect();     // 弹蓝牙选择框
engine.heartRate.disconnect();

// 心率区间（bpm + 年龄）
engine.setAge(20);
engine.zoneOf(150); // { key, label, color, pct }

// 手动播一句（测试语音）
engine.voice.speak('test', '加油！', 'jiayou');
```

---

## 三、配置项（构造参数）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `stages` | Array | 见下 | 训练阶段（`{id,name,startBpm,endBpm,dur,voiceId,voice,hr}`）|
| `startVoice` | Object | 见下 | 开场白 `{voiceId, voice}` |
| `endVoice` | Object | 见下 | 结束语 `{voiceId, voice}` |
| `pauseVoice` | Object | `zanting` | 暂停提示语 `{voiceId, voice}` |
| `resumeVoice` | Object | `kaishi` | 继续提示语 `{voiceId, voice}` |
| `cheers` | Array | 8 句 | 中间随机鼓励语 `{voiceId, voice}` |
| `cheerInterval` | [min,max] | `[35,55]` | 鼓励语间隔（秒，随机区间）|
| `hrMode` | Boolean | `true` | 心率驱动阶段切换（见 §九）|
| `voice.localDir` | String | `'voices/'` | 洛天依音频目录 |
| `voice.useLocal` | Boolean | `true` | 是否优先用本地音频 |

**默认训练方案（可整段替换）：**

```js
stages: [
  { id:'warmup',   name:'热身', startBpm:100, endBpm:115, dur:120, voiceId:'reshen',  voice:'先慢慢跑哦，跟着天依的节奏，深呼吸～', hr:{ nextAbovePct:60, minSec:20, maxSec:240 } },
  { id:'build',    name:'燃脂', startBpm:125, endBpm:145, dur:180, voiceId:'ranzhi',  voice:'进入燃脂区啦，保持节奏，脂肪在燃烧哦～', hr:{ nextAbovePct:80, minSec:30, maxSec:480 } },
  { id:'peak',     name:'冲刺', startBpm:160, endBpm:175, dur:240, voiceId:'chongci', voice:'冲刺时间到！全力以赴，天依陪你冲——！', hr:{ nextBelowPct:85, minSec:60, maxSec:300 } },
  { id:'cooldown', name:'放松', startBpm:130, endBpm:105, dur:150, voiceId:'fangsong', voice:'最后啦，放慢脚步深呼吸，我们一起慢慢来～', hr:{ minSec:30, maxSec:180 } },
]
```

---

## 四、方法

| 方法 | 说明 |
|------|------|
| `engine.start()` | 开始训练（先播开场白→起节拍→进阶段→BPM 渐升→插鼓励语）|
| `engine.pause()` | 暂停（停节拍/音乐/计时）|
| `engine.resume()` | 恢复 |
| `engine.stop()` | 停止并复位 |
| `engine.finish()` | 立即结束（播结束语）|
| `engine.setAge(n)` | 设置年龄（影响心率区间）|
| `engine.zoneOf(bpm)` | 计算心率区间 |
| `engine.totalDuration()` | 总时长（秒）|
| `engine.heartRate.connect()/disconnect()` | 心率连接/断开 |
| `engine.music.load(file)/loadList(files)/play()/pause()/toggle()/next()/prev()/stop()/setVolume(0-1)` | 音乐（歌单 + 自动切歌）|
| `engine.music.setMode('order'\|'shuffle'\|'smart')` | 播放模式：顺序 / 随机（喜欢歌×2）/ 智能（按阶段自动推荐）|
| `engine.music.toggleLike(i)` / `recommendForBpm(bpm, range)` | 喜欢切换 / 按 BPM 推荐（喜欢优先）|
| `engine.setVolume(channel, 0-1)` | 音量：channel ∈ `master`/`voice`/`music`/`metronome` |
| `engine.getVolumes()` | 返回当前四通道音量 |
| `engine.metronome.start()/stop()/setBpm(n)` | 节拍器（手动控制）|
| `engine.voice.speak(type, text, voiceId)` | 播一句语音（入队串行）|
| `engine.voice.cancel()` | 停止所有语音 |

---

## 五、事件

两种订阅方式等价：

```js
// 方式 A：构造时传回调
new RunnerEngine({ onBeat: fn, onStage: fn });

// 方式 B：事后 .on()
engine.on('beat', fn);
```

| 事件名 | 参数 | 说明 |
|--------|------|------|
| `state` | `(state)` | `'idle' \| 'running' \| 'paused' \| 'finished'` |
| `stage` | `(stage, index)` | 阶段切换（`stage` 为 null 表示复位）|
| `bpm` | `(bpm)` | 目标 BPM 变化 |
| `beat` | `(beatIndex, isAccent, audioTime)` | 每拍（重音 isAccent=true）|
| `voice` | `({type,text,voiceId,local,duration})` | 开始播报某句（type: start/stage/cheer/end/test；duration=音频时长秒，供字幕显示）|
| `cheer` | `(text, voiceId)` | 播鼓励语 |
| `heartrate` | `({bpm,contact,energy,rr})` | 心率数据 |
| `hrstate` | `(connected, label)` | 心率连接状态 |
| `tick` | `({elapsed,total,stage,stageIndex,progress,bpm})` | 每 250ms 训练心跳 |

---

## 六、心率区间（语义字段，颜色由 UI 决定）

`engine.zoneOf(bpm)` 或 `RunnerCore.heartRateZone(bpm, age)` 返回 `{ key, label, pct }`：

| key | label | 占最大心率 |
|-----|-------|-----------|
| recover | 恢复 / 热身 | < 60% |
| fatburn | 燃脂区间 | 60–70% |
| aerobic | 有氧区间 | 70–80% |
| anaerobic | 无氧 / 阈值 | 80–90% |
| max | 极限区间 | > 90% |

- `key` 是稳定语义标识，UI 据此映射到自己的色彩 token（如心率环统一用天依蓝 `#66CCFF`，或按 key 分色）。
- 最大心率按 `220 − 年龄` 估算。

> 约定：后端只输出结构化数据，不输出任何颜色/样式。颜色、字体、动画降级一律由 UI 层用前端 token 体系决定。

---

## 七、语音文件约定

- 洛天依本地音频放 `voices/`，命名 `{voiceId}.mp3`，完整清单见 `voice_script.md`。
- 某句缺文件时，引擎自动回退系统 TTS（`local=false`）。
- 鼓励语间隔由 `cheerInterval` 控制，默认每 35–55 秒随机一句。

---

## 八、注意事项

- **Web Bluetooth（心率）要求安全上下文**：必须 `http://localhost` 或 HTTPS，不能 `file://` 双击打开。仅 Chrome / Edge / 安卓 Chrome 支持。
- **首次播放需用户手势**：`AudioContext` / `Audio.play()` / TTS 都要求用户先点击。UI 上「开始训练」按钮会天然满足。
- **职责边界（后期好改的关键）**：引擎只输出结构化数据（`key`/`label`/`pct`/数值），不含颜色、字体、动画等任何渲染信息。颜色映射、三档渲染降级（高/中/低）等一律由 UI 层用前端 token 体系决定。
- **接口稳定**：新增功能走「新事件 / 新方法」，不要改动既有事件的数据结构，避免破坏 UI 层。

---

## 九、心率驱动阶段切换（hrMode）

`hrMode: true`（默认）时，阶段**由实时心率触发**，而不是固定时长。引擎自动保存最近一次心率读数（`engine.currentHR`），每 250ms 检查一次。

每个阶段用 `hr` 字段描述推进规则：

| 字段 | 含义 |
|------|------|
| `nextAbovePct` | 心率 ≥ 此百分比（相对最大心率）→ 进入下一阶段（热身→燃脂→冲刺）|
| `nextBelowPct` | 心率 ≤ 此百分比 → 进入下一阶段（冲刺→放松，需已连接心率）|
| `minSec` | 该阶段最短停留秒数（防止心率抖动快速切换）|
| `maxSec` | 该阶段最长秒数（**兜底**：心率一直达不到/不回落时，强制进入下一阶段）|

默认推进链（最大心率 = 220 − 年龄）：

1. **热身**：心率到 60% 进燃脂；最多 4 分钟兜底
2. **燃脂**：心率到 80% 进冲刺；最多 8 分钟兜底
3. **冲刺**：至少 60 秒后，心率回落到 85% 进放松；最多 5 分钟兜底
4. **放松**：最多 3 分钟结束

- **未连接心率**（`currentHR=null`）时，自动退化为纯时间兜底（每阶段按 `maxSec` 推进），不会卡住。
- 心率驱动下，节拍器 BPM = 当前阶段的 `endBpm`（固定目标节拍，引导用户达到目标强度），不再随时间线性渐升。
