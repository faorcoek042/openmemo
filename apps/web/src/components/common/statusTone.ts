import type { JobState, JobStep } from '@openmemo/shared';

/**
 * ★ 状态色的**唯一**判定表（T-114）。
 *
 * ── 为什么需要这个文件 ──
 *
 * 清点结果（`/tmp/ui-polish/status-inventory.md`）：同一组语义在六个渲染点各写各的，
 * 而且互相矛盾。三条实例：
 *
 *   1. **「已安装 / 使用中」在两处是反的**：`ModelCard` 是「绿 / 蓝」，
 *      `BackendChip` 是「灰 / 绿」。同一对语义，两套色彩语言。
 *   2. **同一张卡里 `verifying` 是两个颜色**：`DownloadRow` 的芯片走 `running`（蓝），
 *      正下方的进度条却写死 `good`（绿）。
 *   3. **`JobList` 的进度条没有 verifying 分支**，是六个渲染点里唯一漏掉的；
 *      而它的 fallback 分支直接把机器枚举值（`queued` / `cancelled`）当标签显示。
 *
 * 分散的 `switch` 不会自己收敛，只会继续分叉 —— 所以判定收在这里，
 * 渲染点只负责"给我 tone"，不再自己决定颜色。
 *
 * ── 判据（一句话说得清才是好规则）──
 *
 * **色相编码的是「要不要你管、急不急」，不是「好坏排名」。**
 *
 * | tone       | 含义                       | 典型状态 |
 * |------------|----------------------------|---------|
 * | `good`     | 没问题，不用管             | 已安装、已完成、就绪、使用中 |
 * | `info`     | 正在发生，等着就行         | 下载中、安装中、校验中、运行中 |
 * | `warning`  | **要你处理，但不是失败**   | blocked、能力降级、需重启 |
 * | `serious`  | 能用但结果会变差           | 走了降级路径、模拟数据 |
 * | `critical` | 坏了，必须处理             | failed、自检失败、能力缺失 |
 * | `neutral`  | 不适用 / 还没开始          | 未安装、排队中、已取消、已暂停 |
 *
 * 推论：**「已安装」和「使用中」同为 `good`**（都属于"没问题"），
 * 靠**图标**（✓ 对 ⚡）与文字区分，不靠颜色 ——
 * 这正好是 `StatusChip` 那条"永远同时给图标与文字"断言要求的形态：
 * 颜色少扛一点区分职责，可读性反而更高。
 */
export type StatusTone = 'good' | 'info' | 'warning' | 'serious' | 'critical' | 'neutral';

/** 作业粗粒度生命周期 → tone。`leased` 与 `running` 同义（已被调度，正在跑）。 */
export function jobStateTone(state: JobState | string): StatusTone {
  switch (state) {
    case 'succeeded':
      return 'good';
    case 'running':
    case 'leased':
      return 'info';
    case 'blocked':
      // blocked 不是失败：它在等依赖，条件满足会自动继续（D-09 §1.3）。
      // 画成红色会让用户以为要重来一次。
      return 'warning';
    case 'failed':
      return 'critical';
    case 'queued':
    case 'paused':
    case 'cancelled':
    default:
      return 'neutral';
  }
}

/**
 * 作业细粒度步骤 → tone。四个步骤**全部是 `info`**。
 *
 * ⚠️ `verifying` 曾被单独染成绿色（`DownloadRow` / `JobToaster` 各一处），
 * 意图是"下完了、快好了"，但它把"进行中"讲成了"已完成"，
 * 而且两个渲染点还不一致。**verifying 的特殊性靠脉动条 + 那句
 * "进度条不动是正常的，不是卡死"来表达，不靠换色。**
 */
export function jobStepTone(_step: JobStep | string | null | undefined): StatusTone {
  return 'info';
}

/** 模型 / 组件 / 后端包的安装态。 */
export type InstallState = 'not-installed' | 'downloading' | 'installed' | 'in-use' | 'failed';

export function installStateTone(state: InstallState): StatusTone {
  switch (state) {
    case 'in-use':
    case 'installed':
      return 'good'; // 同色，靠 ⚡ / ✓ 图标区分（见文件头）
    case 'downloading':
      return 'info';
    case 'failed':
      return 'critical';
    case 'not-installed':
    default:
      return 'neutral';
  }
}

/** 能力 / 流水线就绪度。与 `DiagnosticsPage` 的 `ok|warn|fail` 同构。 */
export type CapabilityLevel = 'ready' | 'degraded' | 'missing';

export function capabilityTone(level: CapabilityLevel | 'ok' | 'warn' | 'fail'): StatusTone {
  switch (level) {
    case 'ready':
    case 'ok':
      return 'good';
    case 'degraded':
    case 'warn':
      return 'warning';
    case 'missing':
    case 'fail':
    default:
      return 'critical';
  }
}

/**
 * 一组条目的汇总严重度：**取最严重的那个**。
 *
 * 修的是这个实例：就绪条幅的汇总图标写死 `text-warning`（琥珀，"该修一下"），
 * 而同一个「流水线缺件」在诊断页是 `fail`（红，"这坏了"）。
 * 用户在条幅看到的严重度和点进去看到的对不上，条幅就失去了预警作用。
 */
const SEVERITY: Record<StatusTone, number> = {
  neutral: 0,
  good: 1,
  info: 2,
  warning: 3,
  serious: 4,
  critical: 5,
};

export function worstTone(tones: readonly StatusTone[]): StatusTone {
  return tones.reduce<StatusTone>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'neutral');
}
