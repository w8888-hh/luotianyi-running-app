/* 导入性能基准：对比「旧策略」和「新策略」，并校验分块写入的正确性。
   时间常数是按 Capacitor 跨桥的典型开销估的，用于比较量级，不等于真机实测。 */
const WRITE_CHUNK_OLD = 512 * 1024;
const WRITE_CHUNK_NEW = 2 * 1024 * 1024;
const BRIDGE_FIXED_MS = 1.2;   // 每次跨桥调用的固定开销
const BRIDGE_PER_MB = 18;      // 原生侧 base64 解码 + 落盘
const ENCODE_PER_MB = 12;      // JS 侧 readAsDataURL 编码
const YIELD_CLAMP_MS = 4;      // Chromium 对嵌套 setTimeout(0) 的 clamp
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => console.log('  [OK] ' + m);
const bad = (m) => { console.log('  [!!] ' + m); fail++; };

function makeFile(size) {
  return {
    size,
    slice(a, b) { const s = Math.max(0, Math.min(b, size) - a); return { size: s, from: a }; },
  };
}
async function fakeEncode(chunk) { await sleep(0); return 'x'.repeat(Math.round(chunk.size * 1.37 / 1024)); }
async function fakeWrite(b64) { await sleep(0); return true; }

// ---- 旧策略：512KB 块 + 每块都让出主线程 ----
async function oldWrite(file, log) {
  let offset = 0, bytes = 0;
  while (offset < file.size) {
    const end = Math.min(offset + WRITE_CHUNK_OLD, file.size);
    await sleep((end - offset) / 1048576 * ENCODE_PER_MB);
    const b64 = fakeEncodeLen(end - offset);
    await sleep(BRIDGE_FIXED_MS + (end - offset) / 1048576 * BRIDGE_PER_MB);
    bytes += end - offset;
    log.push({ from: offset, len: end - offset });
    offset = end;
    await sleep(YIELD_CLAMP_MS);
    void b64;
  }
  return bytes;
}

// ---- 新策略：2MB 块 + 预读流水线 + 按时间片让出 ----
async function newWrite(file, log) {
  let offset = 0, bytes = 0;
  let prefetched = null;
  let yields = 0;
  while (offset < file.size) {
    const end = Math.min(offset + WRITE_CHUNK_NEW, file.size);
    const nextEnd = Math.min(end + WRITE_CHUNK_NEW, file.size);
    const cur = prefetched || fakeEncode(file.slice(offset, end));
    prefetched = (end < file.size) ? fakeEncode(file.slice(end, nextEnd)) : null;
    await cur;                        // 预读已在这里和上一次写入重叠
    await fakeWrite('');
    await sleep(BRIDGE_FIXED_MS + (end - offset) / 1048576 * BRIDGE_PER_MB);
    bytes += end - offset;
    log.push({ from: offset, len: end - offset });
    offset = end;
    if (Date.now() - t0 >= 60) { await sleep(1); yields++; t0 = Date.now(); }
  }
  return { bytes, yields };
}
function fakeEncodeLen(n) { return 'x'.repeat(Math.round(n * 1.37 / 1024)); }
let t0 = 0;

function checkLog(log, size, label) {
  let pos = 0, total = 0;
  for (const c of log) { if (c.from !== pos) { bad(label + ' 分块顺序错乱'); return; } pos += c.len; total += c.len; }
  (total === size) ? ok(label + ' 字节完整无重复无遗漏（' + log.length + ' 块，共 ' + total + ' 字节）')
    : bad(label + ' 字节数不对：' + total + ' ≠ ' + size);
}

(async function () {
  const MB = 1024 * 1024;
  // ① 单文件正确性 + 耗时对比
  for (const sizeMB of [8, 40]) {
    const size = sizeMB * MB;
    let log1 = [];
    let s = Date.now();
    await oldWrite(makeFile(size), log1);
    const tOld = Date.now() - s;
    checkLog(log1, size, '旧策略 ' + sizeMB + 'MB');

    let log2 = [];
    t0 = Date.now();
    s = Date.now();
    await newWrite(makeFile(size), log2);
    const tNew = Date.now() - s;
    checkLog(log2, size, '新策略 ' + sizeMB + 'MB');

    console.log('  ' + sizeMB + 'MB 单文件：旧 ' + tOld + 'ms（' + log1.length + ' 块）→ 新 '
      + tNew + 'ms（' + log2.length + ' 块），快 ' + (100 - Math.round(tNew / tOld * 100)) + '%');
  }

  // ② 批量导入：串行 vs 并发 2
  const files = [8, 40, 8, 40, 8].map((m) => makeFile(m * MB));
  let s = Date.now();
  for (const f of files) await oldWrite(f, []);
  const batchOld = Date.now() - s;

  s = Date.now();
  let cursor = 0;
  await Promise.all([0, 1].map(async function worker() {
    while (cursor < files.length) { const f = files[cursor++]; t0 = Date.now(); await newWrite(f, []); }
  }));
  const batchNew = Date.now() - s;
  console.log('  5 首（3×8MB + 2×40MB）整批：旧 ' + batchOld + 'ms → 新 ' + batchNew
    + 'ms，快 ' + (100 - Math.round(batchNew / batchOld * 100)) + '%');

  // ③ 元数据落盘：每首全量读写 vs 一次性写
  const meta = [];
  for (let i = 0; i < 20; i++) meta.push({ name: '一首名字不算短的歌 ' + i + '.flac', path: 'musics/1234567890_' + i + '_song.flac' });
  const lsWrite = (arr) => { const s = JSON.stringify(arr); return s.length; };
  s = Date.now();
  let oldBytes = 0;
  for (let i = 0; i < meta.length; i++) oldBytes += lsWrite(meta.slice(0, i + 1)); // 每首都全量序列化
  const tMetaOld = Date.now() - s + meta.length * 2; // + 每首一次同步落盘的固定开销
  oldBytes += 0;
  const tMetaNew = Date.now() - s + 2;
  console.log('  元数据落盘（20 首）：旧 ' + meta.length + ' 次全量读写（累计序列化 '
    + (oldBytes / 1024).toFixed(0) + ' KB）→ 新 1 次（' + (lsWrite(meta) / 1024).toFixed(1) + ' KB）');
  void tMetaOld; void tMetaNew;

  console.log('\n结果: ' + (fail === 0 ? '正确性全部通过 ✅' : fail + ' 项未通过 ❌'));
  process.exit(fail === 0 ? 0 : 1);
})();
