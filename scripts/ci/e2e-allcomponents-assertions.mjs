/**
 * `e2e-allcomponents` 的判据 —— **纯函数，与网络无关**，好让它们能被喂坏数据。
 *
 * ## 为什么这轮必须补上（我记了三次的债）
 *
 * 上一轮我差点把一条**自己判据写错**的红报成产品缺陷（枚举拿总数硬比，
 * 差的正好是 5 个 `role=llm`）。而同一轮里另一条红**是真的**
 * （whispercpp 全平台装不上）。**两者在台账上长得一模一样。**
 *
 * 分不清"腿看见了"和"腿坏了"的唯一办法，就是给每条判据喂一份
 * **本该让它变红**的输入，看它红不红。没有这一步，一条恒真的判据
 * 与一条真的护栏在输出里没有任何区别。
 */

/** 归档/权重的魔数。判据是"它还是不是原来那种东西"，不是精确格式解析。 */
export function magicOf(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  const b = buf;
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
  if (b.subarray(0, 4).toString('ascii') === 'GGUF') return 'gguf';
  if (b.readUInt32LE(0) === 0x67676d6c) return 'ggml';
  if (b[0] === 0x08 || b[0] === 0x0a) return 'onnx-ish';
  if (b.subarray(0, 5).toString('ascii') === '<?xml' || b[0] === 0x7b) return 'text/json';
  return 'other';
}

/** 文件名 → 期望的魔数。`any` = 这种后缀不强求（例如没有扩展名的裸二进制）。 */
export function kindByExt(name) {
  const n = String(name ?? '');
  if (/\.tar\.gz$|\.tgz$/.test(n)) return 'gzip';
  if (/\.zip$/.test(n)) return 'zip';
  if (/\.gguf$/.test(n)) return 'gguf';
  if (/\.bin$/.test(n)) return 'ggml';
  if (/\.onnx$/.test(n)) return 'onnx-ish';
  return 'any';
}

/**
 * 把 A 层的探测结果分类。
 *
 * 每一行是一个**文件**（一个组件可能有多个文件），`mirrors` 是它每个镜像的探测结果。
 *
 * ★ **空输入必须报"前提不成立"**，不能报"全都好"。
 *   这是本仓反复发作的那一类：`[].every(...)` 恒真，于是"一个都没坏"
 *   与"一个都没测"在输出里长得一模一样 —— 我自己已经栽过不止一次。
 */
export function classifyProbeRows(rows) {
  if (!Array.isArray(rows)) return { ok: false, reason: `rows 不是数组（${typeof rows}）` };
  if (rows.length === 0) {
    return {
      ok: false,
      reason: '前提不成立：一个文件都没探测到 —— "全部可达"在空集上恒真，那不是结论',
      empty: true,
      noMirror: [],
      sizeMismatch: [],
      kindMismatch: [],
      githubOnly: [],
    };
  }
  const noMirror = [];
  const sizeMismatch = [];
  const kindMismatch = [];
  const githubOnly = [];
  for (const row of rows) {
    const mirrors = row.mirrors ?? [];
    if (mirrors.length === 0) {
      // 一个镜像都没配 = 用户根本无从下载，与"配了但都不可达"同等严重
      noMirror.push(row);
      continue;
    }
    const okMirrors = mirrors.filter((m) => m.ok);
    if (okMirrors.length === 0) noMirror.push(row);
    for (const m of okMirrors) {
      if (row.sizeBytes && m.total !== undefined && m.total !== null && m.total !== row.sizeBytes) {
        sizeMismatch.push({ row, mirror: m });
      }
      const want = kindByExt(row.file);
      if (want !== 'any' && m.gotKind && m.gotKind !== want) kindMismatch.push({ row, mirror: m });
    }
    const hosts = mirrors.map((m) => String(m.host ?? ''));
    if (hosts.every((h) => /(^|\.)github(usercontent)?\.com$/.test(h))) githubOnly.push(row);
  }
  return { ok: true, empty: false, noMirror, sizeMismatch, kindMismatch, githubOnly };
}

/**
 * 包内清单与当前 checkout 的清单**漂开了哪些**。
 *
 * 漂开本身不判红（新包总会比旧包新）；它的价值是**一句话诊断**：
 * 本轮那个「A 层 206 / B 层 NOT_FOUND」的矛盾，根因就是两层读的不是同一份清单，
 * 而漂开清单直接把 `whispercpp-*: 包内 v0.3.0 → 目录 v0.4.0` 打在脸上。
 */
export function driftedPacks(inBundle, inCheckout) {
  const out = [];
  for (const id of Object.keys(inBundle ?? {})) {
    if (inCheckout?.[id] && inCheckout[id] !== inBundle[id]) {
      out.push({ id, bundle: inBundle[id], checkout: inCheckout[id] });
    }
  }
  return out;
}

/** 从 release 下载 URL 里取出 tag（`…/download/<tag>/<file>`）。取不到回 `'?'`。 */
export function tagOf(url) {
  return /download\/([^/]+)\//.exec(String(url ?? ''))?.[1] ?? '?';
}
