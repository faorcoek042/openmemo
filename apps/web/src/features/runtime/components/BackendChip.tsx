import { useTranslation } from 'react-i18next';
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  Cpu,
  Download,
  HelpCircle,
  PackageCheck,
  XCircle,
  Zap,
} from 'lucide-react';
import type { Backend } from '@openmemo/shared';
import { cn } from '../../../lib/utils';

/**
 * 加速后端状态芯片（CUDA / Vulkan / ROCm / Metal / CoreML / CPU）。
 *
 * 建在 `components/common/` 而不是 `features/runtime/components/`：D-05 §3.1 目录树注释
 * 已标出这是提升项 —— 模型详情页要显示"这台机器当前用哪个后端跑"，任务中心的
 * blocked 任务也要显示"因为后端未安装"。三处都要用，一开始就放共享区。
 *
 * ★ 状态三态必须**图标 + 文字**同时出现，不能只变色（features/runtime/README.md 明确要求）。
 *
 * ── T-114：色彩语义与模型侧对齐 ──
 *
 * 之前这里是「已安装 = 灰 / 使用中 = 绿」，而 `ModelCard` / `ComponentCard` 是
 * 「已安装 = 绿 / 使用中 = 蓝」—— **同一对语义，两处的颜色恰好互换**，
 * 用户在两页之间切换时学到的规则是反的。
 *
 * 现按 `statusTone.ts` 的唯一判据统一：
 * 「已安装」与「使用中」**同为 good**（都属于"没问题、不用管"），
 * 区分交给图标（✓ 对 ⚡）与文字 —— 这正是那条"不许只用颜色"的规则想要的形态。
 * 「可安装」是**动作邀请不是状态**，不占状态色（旁边的下载按钮才是动作）。
 */

/**
 * ★ T-165：`not-installed` 这一档原来一个人扛着「不可用」的**三种不同含义**。
 *
 * daemon 早就把它们分开了（`InapplicableKind`：`platform` / `undetermined` /
 * `unsupported`），而界面把三档一律渲染成「不可用」。
 * `[实测 :10000]` `whispercpp-vulkan-linux-x64` 的档位是 `undetermined`
 * （probe 还没跑成，与这台机器支不支持 Vulkan 无关），显示出来却是「不可用」——
 * 这正是那个字段的注释写明要防的事："用户看到不可用会以为自己机器不支持，然后就不装了"。
 *
 * `not-installed` 保留，含义收窄成「不可用，但不知道属于哪一档」——
 * 那是 daemon 没告诉我们时唯一诚实的说法。
 */
export type BackendChipState =
  | 'active'
  | 'installed'
  /**
   * 装在盘上，但**这一轮探测没有加载它**（`installed:true, probed:false`）。
   *
   * ⚠️ 这一档是 T-168 精心建立的区分，而它此前**在最后一跳上死掉了**：
   * `HardwareCard` 的芯片分支是 `selected → installed → available → 未安装`，
   * 于是没被探测到的后端与真正加载成功的后端**显示同一个「已安装」**，
   * 那句"这一轮没有去加载它"只躺在折叠的 `<details>` 里。
   * 界面从头到尾**不读 `probed`** —— 类型层辛苦区分出来的东西，用户看不到。
   */
  | 'installed-unprobed'
  /**
   * **不装任何包就能用** —— 随产品出厂的那份（今天只有 CPU 基线运行时）。
   *
   * ⚠️ 这一档不许并进 `installed`：那是"装了一个包"，这是"根本不需要包"。
   * 并了就回到 T-197 那个现场 —— 干净机器上顶部说「CPU 已安装/使用中」，
   * 同一页的 `BackendPackCard` 说「CPU 可安装 · 42 MB」，两句话都来自产品自己。
   * 分开之后这两句同时为真且不打架：自带的那份在跑，那个**包**确实还没装。
   */
  | 'bundled'
  | 'available'
  | 'not-installed'
  | 'failed'
  /** os/arch 对不上：别的平台的包 */
  | 'other-platform'
  /** 还没探测到能力，**不是**"不支持" */
  | 'undetermined'
  /** 探测完成，确认本机没有可用设备 */
  | 'unsupported';

const BACKEND_LABEL: Record<Backend, string> = {
  cuda: 'CUDA',
  vulkan: 'Vulkan',
  rocm: 'ROCm',
  metal: 'Metal',
  coreml: 'CoreML',
  cpu: 'CPU',
};

/** ⚠️ 表里存**词条 key** 不存文案：这是模块级常量，存文案的话切语言不会重算它（T-129b）。 */
const STATE_STYLE: Record<
  BackendChipState,
  { text: string; labelKey: string; icon: React.ReactNode }
> = {
  active: {
    text: 'text-good',
    labelKey: 'runtime.chip.active',
    icon: <Zap className="size-3.5 shrink-0" aria-hidden />,
  },
  installed: {
    text: 'text-good',
    labelKey: 'runtime.chip.installed',
    icon: <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />,
  },
  'installed-unprobed': {
    // 不用 text-good：它**不是**一个已经验证可用的状态，颜色不该和「已安装」一样
    text: 'text-warning',
    labelKey: 'runtime.chip.installedUnprobed',
    icon: <CircleDashed className="size-3.5 shrink-0" aria-hidden />,
  },
  bundled: {
    // 与「已安装」同为可用绿：它**真的能用**，只是来路不同（出厂自带，不是装的包）
    text: 'text-good',
    labelKey: 'runtime.chip.bundled',
    icon: <PackageCheck className="size-3.5 shrink-0" aria-hidden />,
  },
  available: {
    text: 'text-ink-secondary',
    labelKey: 'runtime.chip.available',
    icon: <Download className="size-3.5 shrink-0" aria-hidden />,
  },
  'not-installed': {
    text: 'text-ink-muted',
    labelKey: 'runtime.chip.notInstalled',
    icon: <CircleDashed className="size-3.5 shrink-0" aria-hidden />,
  },
  failed: {
    text: 'text-critical',
    labelKey: 'runtime.chip.failed',
    icon: <XCircle className="size-3.5 shrink-0" aria-hidden />,
  },
  'other-platform': {
    text: 'text-ink-muted',
    labelKey: 'runtime.chip.otherPlatform',
    icon: <CircleDashed className="size-3.5 shrink-0" aria-hidden />,
  },
  /* 「待检测」是**中性偏进行中**，不是坏消息 —— 用 info 而不是 muted，
       否则它在视觉上与「本机不支持」还是一个样子，拆开就白拆了。 */
  undetermined: {
    text: 'text-info',
    labelKey: 'runtime.chip.undetermined',
    icon: <HelpCircle className="size-3.5 shrink-0" aria-hidden />,
  },
  unsupported: {
    text: 'text-ink-muted',
    labelKey: 'runtime.chip.unsupported',
    icon: <Ban className="size-3.5 shrink-0" aria-hidden />,
  },
};

export interface BackendChipProps {
  backend: Backend;
  state: BackendChipState;
  className?: string;
}

export function BackendChip({ backend, state, className }: BackendChipProps) {
  const { t } = useTranslation();
  const s = STATE_STYLE[state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-1 px-2 py-1 text-xs font-medium',
        s.text,
        className,
      )}
      data-testid={`backend-chip-${backend}`}
    >
      {backend === 'cpu' ? <Cpu className="size-3.5 shrink-0" aria-hidden /> : s.icon}
      <span className="text-ink">{BACKEND_LABEL[backend]}</span>
      <span className={cn('text-[11px]', s.text)}>{t(s.labelKey)}</span>
    </span>
  );
}

export function backendLabel(b: Backend): string {
  return BACKEND_LABEL[b] ?? b;
}
