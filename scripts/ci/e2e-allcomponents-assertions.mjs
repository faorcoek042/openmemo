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

/**
 * 从一堆 `{id, file, url}` 里挑出**指向我们自己 release** 的那些，并带上 tag。
 *
 * 判据是"这条地址会不会因为我们删掉一个 release 而失效" —— 所以只认
 * `<owner>/<repo>/releases/download/<tag>/`，**不认上游的 release**
 * （BtbN 的 ffmpeg、yt-dlp 的官方包也长这个形状，但删不删由不得我们，
 *   把它们算进来会让"我们能不能删"这个问题得到一个错误的答案）。
 *
 * `ownerRepo` 默认本仓；测试可以传别的来验判据本身。
 */
export function collectReleaseRefs(urls, ownerRepo = 'faorcoek042/openmemo') {
  const out = [];
  const re = new RegExp(
    `^https://github\\.com/${ownerRepo.replace('/', '\\/')}/releases/download/([^/]+)/`,
  );
  for (const u of urls ?? []) {
    const m = re.exec(String(u?.url ?? ''));
    if (m) out.push({ ...u, tag: m[1] });
  }
  return out;
}

/**
 * 一个文件"只有单一来源"吗（按**不同主机数**算，不是按主机名长相）。
 *
 * ⚠️ 判据是**主机去重后 < 2**，不是"是不是 github"。
 * 上一版写的是"所有镜像都在 github 系" —— 那会把
 * `media-tools`（指上游 BtbN 的 GitHub release）和我们自建的包混为一谈，
 * 也答不了"某个模型从两个源掉到一个源"这种真正的意外。
 */
export function isSingleSource(row) {
  const hosts = new Set((row?.mirrors ?? []).map((m) => String(m.host ?? '')));
  return hosts.size < 2;
}

/**
 * 单一来源的**棘轮**判据（2026-08-09，用户裁决之后重写）。
 *
 * ## 为什么不再是"有单一来源就红"
 *
 * 用户 2026-08-09 原话：**「不管什么中国托管，有代理作为兜底就行，你不应该操心这么多。」**
 * 所以"后端包没有中国可达兜底"从此是**已知且已接受的状态**，不是缺口。
 *
 * 而我此前把它挂成永久红 —— **那是本仓反复在治的那个反模式**：
 * 一条为已被接受的状态永远亮着的红灯，等于一条被删掉的守卫，
 * 而且会训练所有人忽略红灯。
 *
 * ## 但判据的**能力**不许一起删掉
 *
 * 变的是"这个数是几时该红"，不是"要不要数"。所以改成**棘轮**
 * （与 `check:orphans` 的基线 70 同一个形状）：
 *
 *   · 基线里已有的单一来源 → **接受**，只计数、不红；
 *   · **基线之外**出现新的单一来源 → **红**。
 *
 * 那才是"意外"：一个**本来有镜像**的组件掉到了单一来源
 * （典型：上游把 hf-mirror / ModelScope 那一份撤了），
 * 或者有人新加了一个组件却只配了一个源 —— 后者也该被逼着做一次显式决定。
 *
 * · 基线里有、现在却不是单一来源了 → 说明它变好了，报"基线过期"提醒收紧，不红。
 */
export function ratchetSingleSource(rows, baseline) {
  const keyOf = (r) => `${r.id}::${r.file}`;
  const accepted = new Set(baseline ?? []);
  const current = (rows ?? []).filter(isSingleSource).map(keyOf);
  const currentSet = new Set(current);
  const unexpected = current.filter((k) => !accepted.has(k));
  const stale = [...accepted].filter((k) => !currentSet.has(k));
  return {
    ok: unexpected.length === 0,
    total: (rows ?? []).length,
    singleCount: current.length,
    acceptedCount: accepted.size,
    unexpected,
    stale,
  };
}
