#!/usr/bin/env node
/**
 * 「这个自检**只在某些平台上有意义**」—— 把这件事说出来，并且让它**数得出来**。
 *
 * ## 它治的病
 *
 * `[实测 run 32651393827 / 32656407764]` 跨平台探针把 35 个 CI 自检原样搬到
 * macOS 与 Windows 上跑，其中有几个是**范畴错误**，不是回归：
 *
 *   · `selftest-elf-glibc` —— 它验的是 `check-elf-glibc.mjs`，一个**读 ELF 的**
 *     检查器；夹具靠桩掉 `objdump` 造出来，而那个桩在 Windows 上不生效，
 *     真 objdump 上场，对着 Linux ELF 说 `file format not recognized`。
 *   · `selftest-pack-deps` —— `copyFileSync('/bin/true', …)`，而 macOS 上
 *     `true` 在 `/usr/bin/true`。
 *   · `selftest-buildbox.sh` —— 验的是**Linux 容器**的 docker argv 组装。
 *   · `selftest-build-whisper.sh` —— 桩造出来的是 Linux 形状的产物，
 *     而 `build-whisper.sh` 按**宿主**平台决定该找什么名字。
 *
 * 这四条在非 Linux 上红，说明的不是"产品在 macOS 上坏了"，而是
 * **"我们把一把 Linux 的尺子架到了 macOS 上"**。判据本来就写错了平台。
 *
 * ## ⚠️ 为什么不是简单 `process.exit(0)`
 *
 * 「跳过」和「通过」在结果里必须**分得开**。一个悄悄 exit 0 的自检，
 * 和一个真跑过并且全绿的自检，在调用方眼里一模一样 ——
 * 那正是本仓一直在清的那个形状（"没跑"和"跑了并通过"长得一样）。
 *
 * 所以这里用一个**专用退出码 250**：`run-selftests-all.mjs` 认得它，
 * 在汇总里记成 `◐ 跳过`，与 `✔ 绿` 分开计数，并写进 JSON 结果里。
 * 谁要是把这个机制拆了，汇总里的"绿"数会当场变多 —— 那是看得见的。
 *
 * ## ⚠️ 收窄不许悄悄扩散
 *
 * `scripts/ci/lint-workflows.mjs` 钉住了"哪些脚本可以收窄"这份名单。
 * 想给第五个脚本加 `narrowTo()`，得同时改那份名单 ⇒ 出现在 diff 里 ⇒ 有人看得见。
 * **不许有"运行时自动豁免"的路径。**
 */

/** 「这条自检在本平台上无意义」的专用退出码。0 是通过、1 是失败，250 是跳过。 */
export const SKIP_EXIT_CODE = 250;

/**
 * 只在 `platforms` 里的平台上继续；否则大声说明理由并以 250 退出。
 *
 * @param {string[]} platforms `process.platform` 的取值，如 `['linux']`
 * @param {{subject: string, why: string, lost: string}} o
 *   - `subject` 被测的是谁（不是本文件，是它验的那个脚本）
 *   - `why`     为什么在别的平台上跑它是范畴错误
 *   - `lost`    ⚠️ 收窄之后**损失了什么**。不许写"无"——写不出来说明还没想清楚。
 */
export function narrowTo(platforms, { subject, why, lost }) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    console.error('✘ platform-scope: narrowTo() 收到空的平台列表 —— 那会让这条自检在哪儿都不跑');
    process.exit(1);
  }
  for (const k of ['subject', 'why', 'lost']) {
    if (!{ subject, why, lost }[k]) {
      console.error(`✘ platform-scope: narrowTo() 缺 ${k} —— 收窄必须说得出理由和代价`);
      process.exit(1);
    }
  }
  if (platforms.includes(process.platform)) return;

  console.log(
    `◐ platform-scope: 在 ${process.platform} 上**跳过**（只在 ${platforms.join('/')} 上有意义）\n` +
      `   被测：${subject}\n` +
      `   理由：${why}\n` +
      `   ⚠️ 收窄的代价：${lost}\n` +
      `   —— 这是「跳过」，不是「通过」。汇总里它记在 ◐ 那一栏，不进 ✔。`,
  );
  process.exit(SKIP_EXIT_CODE);
}
