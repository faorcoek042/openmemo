import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * 面板级错误边界 —— **一块坏掉不该让整页白屏**。
 *
 * ## 为什么需要它
 *
 * 我在文件夹树那里写过"一条坏数据不该让整个侧栏白屏"，但那只是**那一个组件**的防御。
 * 真实使用中用户报的是"很多地方都报错"——一个面板抛异常，React 会把**整棵树**卸载，
 * 于是一处 `undefined.map` 就能让整页变空白，用户连"哪里坏了"都看不出来。
 *
 * 防御性读取（`arr()`）挡的是**已知形状问题**；错误边界挡的是**所有没预料到的**。
 * 两者都要有：前者让常见情况不出错，后者保证出错时损失被限制在一个面板内。
 *
 * ## 刻意的选择
 *
 * - **不吞错**：`componentDidCatch` 里照常 `console.error`，排障时栈还在。
 * - **可重试**：重置 key 让子树重新挂载，不必刷新整页。
 * - **说人话 + 给动作**：标题说明是哪块坏了，附「重试」按钮（`remediation` 原则）。
 */
interface Props {
  /** 出错时显示"「<name>」加载失败"，让用户知道是哪一块 */
  name: string;
  children: ReactNode;
  /** 可选：自定义降级内容 */
  fallback?: (error: Error, retry: () => void) => ReactNode;
}

interface State {
  error: Error | null;
  /** 变更它会让子树整体重挂 */
  attempt: number;
}

export class PanelBoundary extends Component<Props, State> {
  override state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 不吞错：控制台仍然拿得到完整栈，否则排障会更难
    console.error(`[PanelBoundary] ${this.props.name} 崩溃`, error, info.componentStack);
  }

  #retry = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  override render(): ReactNode {
    const { error, attempt } = this.state;
    const { name, children, fallback } = this.props;

    if (!error) return <div key={attempt}>{children}</div>;
    if (fallback) return fallback(error, this.#retry);

    return (
      <div
        role="alert"
        className="m-3 rounded-lg border border-line border-l-4 border-l-critical bg-surface-1 p-3"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">「{name}」加载失败</div>
            {/* 直接显示 message：比"发生了未知错误"有用得多 */}
            <p className="mt-1 break-words text-xs text-ink-secondary">{error.message}</p>
            <p className="mt-1 text-xs text-ink-muted">页面其余部分仍可正常使用。</p>
            <button
              type="button"
              onClick={this.#retry}
              className="mt-2 inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-fill-hover hover:text-ink"
            >
              <RotateCcw className="size-3" aria-hidden />
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }
}
