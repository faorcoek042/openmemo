#!/usr/bin/env node
/**
 * 把**产品自己的** CPU 探测跑一遍，把结果原样打出来。
 *
 * ## 为什么必须在真 Windows 上跑
 *
 * `detectCpuWin32()` 原来无条件返回 `features: []`，于是每台 Windows 机器都被告知
 * 「无法确认是否支持 AVX2」。补上 `IsProcessorFeaturePresent` 之后，
 * **"写完了"和"真的能查出来"是两件事**：`Add-Type` 可能被执行策略挡、
 * PowerShell 可能不在 PATH 上、P/Invoke 的签名可能对不上 ——
 * **这些失败模式只有在真机上才看得见**，而它们的共同表现是"安静地返回空集合"。
 *
 * 所以这个脚本刻意**调产品自己的 `detectCpu()`**，不另写一份探测：
 * 另写一份的话，绿灯证明的是这个脚本，不是产品。
 *
 * ⚠️ 它**只报告、不断言**（永远 exit 0）。判据在人眼里：
 * Windows 上 `features` 仍然为空 = 这次改动没成。
 */
/*
 * 按仓库根的相对路径取**已构建的产物** —— `scripts/ci/` 不是 workspace 包，
 * 解析不到 `@openmemo/runtime`（`cold-start-audit.mjs` 也是这么取的）。
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { detectCpu } = await import(
  pathToFileURL(join(REPO, 'packages', 'runtime', 'dist', 'index.js')).href
);

const cpu = await detectCpu();
console.log('─'.repeat(72));
console.log(`── CPU 探测实测（${process.platform}/${process.arch}）`);
console.log('─'.repeat(72));
console.log(`   brand          : ${cpu.brand}`);
console.log(`   physicalCores  : ${cpu.physicalCores}`);
console.log(`   logicalCores   : ${cpu.logicalCores}`);
console.log(
  `   features (${String(cpu.features.length).padStart(2)})  : ${cpu.features.join(', ') || '(空集合 ＝ 没测到，不是"没有")'}`,
);
console.log('');
console.log(
  `   ★ avx2 : ${cpu.features.includes('avx2') ? '探到了 ✔' : '没探到（界面会显示"无法确认"）'}`,
);
