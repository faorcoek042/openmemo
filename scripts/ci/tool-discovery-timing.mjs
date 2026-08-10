#!/usr/bin/env node
/**
 * `discoverTools()` 到底多贵 —— **一个只产出数字的脚本**。
 *
 * ## 它回答的是哪个决策
 *
 * #87：用户自己 `brew install ffmpeg` 之后界面不变，因为 `pipeline.missing` 是
 * **daemon 启动时的一份快照**。修法 A 是「`/api/health` 按需重算」，
 * 而它成立的唯一前提是**重算够便宜**：`/api/health` 被 `ReadinessBanner` 每 30 s 轮询一次。
 *
 * `[实测 Linux, 本机, 热页缓存]` 11.5 ms/次 —— 可接受。
 * 但那是 Linux。**Windows 上反复 stat PATH 目录是经典的杀软/电池投诉**，
 * 而这是唯一可能推翻 A 的因素。所以要在 Windows 上量一次，而不是猜一次。
 *
 * ## ⚠️ 这个数字**不是**用户机器的证据
 *
 * CI runner 上**没有装实时防护的第三方杀软**，Defender 的实时扫描在 runner 镜像上
 * 也与用户机器不同。所以本脚本产出的 Windows 数字只能回答
 * **「这件事本身的量级」**（几毫秒？几十？几百？），
 * **不能**回答「装着 Norton 的那台用户机器上是多少」——那一格仍然是 `UNKNOWN`。
 * 报告时必须把这句话一起报出去，否则它会被当成用户机器的实测值。
 *
 * ## 判据
 *
 * **不设阈值、不会把 CI 弄红。** 它是一次性的事实问题，不是需要每次 push 复核的性质
 * （与 `probe-cold-timing.mjs` 同类）。拿不到结论就如实说拿不到，不拿环境问题冒充失败。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as os from 'node:os';

/*
 * ★ 按**文件 URL** 引工作区产物，不用包名。
 * `scripts/` 不是工作区包，`@openmemo/pipeline` 在这里解析不到 ——
 * 写成包名的话本地与 CI 都只会打印 SKIP，而**一个恒 SKIP 的测量脚本
 * 看起来和"量过了"一模一样**。这是 `scripts/selfcheck.mjs:77` 的同一条约定。
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distUrl = (rel) => pathToFileURL(join(REPO_ROOT, rel)).href;

const N = Number(process.env['SAMPLES'] ?? '50');

/** 中位数比均值抗离群：CI 上偶发的一次 200 ms 抖动不该改变结论。 */
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return {
    min: s[0],
    p50: at(0.5),
    p90: at(0.9),
    max: s[s.length - 1],
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  };
}

const fmt = (n) => `${n.toFixed(2)}ms`;

async function main() {
  let discoverTools;
  try {
    ({ discoverTools } = await import(distUrl('packages/pipeline/dist/index.js')));
  } catch (e) {
    console.log(
      `SKIP: 拿不到 @openmemo/pipeline（先 pnpm build:safe）——不拿环境问题冒充结论。${String(e)}`,
    );
    return;
  }

  // 空 store：走完整条解析链（pack 落空 → bundle 落空 → **PATH 那一档真的去查**），
  // 也就是 `/api/health` 在一台"用户自己装了 ffmpeg"的机器上会走的那条路。
  const storeRoot = join(mkdtempSync(join(tmpdir(), 'om-tdt-')), 'models');

  console.log(`platform=${process.platform}/${process.arch} node=${process.version}`);
  console.log(`cpus=${String(os.cpus().length)} samples=${String(N)} storeRoot=<empty tmp>`);
  console.log(
    `PATH entries=${String((process.env['PATH'] ?? '').split(/[:;]/).filter(Boolean).length)}`,
  );

  // 预热一次：第一次调用要付模块初始化与目录元数据的钱，那不是稳态成本。
  await discoverTools({ storeRoot });

  const samples = [];
  for (let i = 0; i < N; i += 1) {
    const t0 = process.hrtime.bigint();
    await discoverTools({ storeRoot });
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const s = stats(samples);
  console.log(
    `discoverTools(): min=${fmt(s.min)} p50=${fmt(s.p50)} p90=${fmt(s.p90)} ` +
      `max=${fmt(s.max)} mean=${fmt(s.mean)}`,
  );
  console.log(
    `\n判读：/api/health 被 ReadinessBanner 每 30 s 轮询一次。` +
      `p50=${fmt(s.p50)} ⇒ 每分钟约 ${(2 * s.p50).toFixed(1)}ms 的文件系统工作。`,
  );
  console.log(
    `⚠️ 这是 CI runner，**不是装着实时防护的用户机器** —— 用户机器上的值仍然是 UNKNOWN。`,
  );
}

await main();
