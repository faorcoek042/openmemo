import { useLocation, useNavigate } from 'react-router';
import { ArrowRight, HardDrive, KeyRound, PackagePlus, RefreshCw, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { remediationTarget, type RemediationLike } from '../../lib/remediation/routes';
import { Button } from './Button';

/**
 * `remediation` → 一个用户能点的按钮。
 *
 * ★ 这是章程要求 2.1「用户不碰命令行」能否成立的最后一环。
 *
 * 一个只有文字的错误（"缺少 ASR 模型"）读完仍然不知道该点哪里，用户只能去翻文档或命令行 ——
 * 那要求 2.1 在错误路径上就没达成。`ApiErrorBody.error.remediation` 与
 * `JobBlockedEvent.remediation` 携带的是**机器可读的动作**（ADR-007 决策 2），
 * 前端把它渲染成按钮，点一下就修好。
 *
 * ## T-140：它此前有 0 个 importer
 *
 * 这个文件从写完那天起就没有任何人 import 过 —— 26 个 `<ErrorBlock>` 全部没传
 * `onRemediate`，`JobToaster` 自己另写了一张路由表。「要求 2.1 的最后一环」
 * 从来没有渲染进任何一个页面。现在 `ErrorBlock` 与 `JobToaster` 都走它，
 * **路由表也收拢成 `lib/remediation/routes.ts` 一份**（原先两份给同一个 action 两个答案）。
 *
 * ## 两种模式
 *
 * - 默认：按表跳转。表里明确"没有落点"的 action（见 `UNROUTED_ACTIONS`）**不渲染**
 *   —— 一个点了到不了任何地方的按钮，比没有按钮更糟。
 * - 传了 `onAct`：就地处理，不跳转。`useExistingDataDir`（重发一次请求）这类
 *   本来就不是"去某一页"的动作走这条。**此时无论表里有没有路由都会渲染** ——
 *   调用方已经明确说了它能处理。
 */

const ACTION_ICON: Record<string, ReactNode> = {
  install_model: <PackagePlus className="size-3.5" aria-hidden />,
  installModel: <PackagePlus className="size-3.5" aria-hidden />,
  install_backend: <PackagePlus className="size-3.5" aria-hidden />,
  installSiteExtractor: <PackagePlus className="size-3.5" aria-hidden />,
  free_disk: <HardDrive className="size-3.5" aria-hidden />,
  configureLlm: <KeyRound className="size-3.5" aria-hidden />,
  retry_probe: <RefreshCw className="size-3.5" aria-hidden />,
  useExistingDataDir: <Wrench className="size-3.5" aria-hidden />,
};

export interface RemediationButtonProps {
  remediation: RemediationLike;
  /** 覆盖默认的路由跳转（例如就地重试，不必离开当前页） */
  onAct?: (r: RemediationLike) => void;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary';
  /**
   * 服务端没给 `labelZh`/`label` 时用的兜底文案。
   *
   * 服务端**总是**该给（daemon 现有 15 个发出点全都给了），所以这只是保险丝；
   * 但兜底文案属于产品面，不该像原来那样在组件里硬编码一个中文串 ——
   * 那在 en 界面上会漏出中文。由调用方从 i18n 取。
   */
  fallbackLabel?: string;
}

export function RemediationButton({
  remediation,
  onAct,
  size = 'sm',
  variant = 'primary',
  fallbackLabel,
}: RemediationButtonProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const target = remediationTarget(remediation);

  /*
   * ★ 用户 2026-08-09（Windows v0.5.0）：自检报
   *   `409 SELF_TEST_BLOCKED`，点「去安装后端包」——**无反应**。
   *
   * 成因是同一个死法的第三次：那条引导的 action 是 `install_backend`，
   * 落点是 `/runtime`，而**自检本来就是在 `/runtime` 上点的** ——
   * `navigate` 到你已经在的那一页，什么都不会发生。
   * （前两次分别是 `AsrModelPicker` 的「去安装模型」与 `ReadinessBanner` 的「诊断」。）
   *
   * 这次修在**通用层**而不是某一个按钮上：任何 remediation，只要落点就是当前页，
   * 就不再渲染一个点不动的按钮，而是给一句"就在本页"。
   * 判据仍是那条：**点了要么发生该发生的事，要么给出看得懂的话，没有第三种。**
   */
  const alreadyThere = target !== null && location.pathname === target.split('?')[0];

  // 没有落点、调用方也不接手 → 什么都不渲染（理由逐条写在 UNROUTED_ACTIONS 里）
  if (!onAct && target === null) return null;

  // 落点就是当前页：给一句话，而不是一个点不动的按钮
  if (!onAct && alreadyThere) {
    return (
      <span className="text-xs text-ink-secondary" data-testid="remediation-already-here">
        {remediation.labelZh || remediation.label || fallbackLabel || remediation.action}
        {' —— '}
        {'就在本页'}
      </span>
    );
  }

  const icon = ACTION_ICON[remediation.action] ?? <ArrowRight className="size-3.5" aria-hidden />;
  // 最后一层兜底用原始 action 名：难看，但**看得见** —— 空按钮才是无从排查的那种
  const label = remediation.labelZh || remediation.label || fallbackLabel || remediation.action;

  return (
    <Button
      variant={variant}
      size={size}
      data-testid={`remediation-${remediation.action}`}
      onClick={() => {
        if (onAct) onAct(remediation);
        else if (target !== null) void navigate(target);
      }}
    >
      {icon}
      {/* labelZh 由服务端给，前端不猜文案 —— 后端最清楚缺的是什么 */}
      {label}
    </Button>
  );
}
