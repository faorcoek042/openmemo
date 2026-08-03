import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * 基础按钮。
 *
 * ⚠️ **为什么放在 `components/common/` 而不是 `components/ui/`**：
 * `components/ui/` 是 ADR-002 决策 2 的 shadcn 豁免区，规则是"只能通过 CLI 添加，
 * 且必须在 SOURCE.md 登记来源"。手写组件放进去会让那份豁免的可追溯性失效。
 * 我们自己写的基础件一律放 `common/`。
 */

const button = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium ' +
    'transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 select-none',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:opacity-90',
        secondary: 'border border-line bg-surface-1 text-ink hover:bg-surface-2',
        ghost: 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
        danger: 'bg-critical-solid text-white hover:opacity-90',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-9 px-3.5',
        lg: 'h-11 px-5 text-base',
        icon: 'size-8',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export function Button({ className, variant, size, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={cn(button({ variant, size }), className)} {...rest} />;
}
