import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Search as SearchIcon } from 'lucide-react';

/**
 * 顶栏搜索入口 + `⌘K` / `Ctrl+K` 快捷键。
 *
 * 之前这个入口**完全不存在** —— 章程 F5 明确要求搜索，后端 FTS5 也早就就绪，
 * 但用户在界面上没有任何地方可以发起搜索。这属于"功能有入口才算有"的典型缺口。
 */
export function SearchBox() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative w-64">
      <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-muted" aria-hidden />
      <input
        ref={ref}
        placeholder={`${t('app.search')}  ⌘K`}
        aria-label={t('app.search')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const v = (e.target as HTMLInputElement).value.trim();
            if (v) navigate(`/search?q=${encodeURIComponent(v)}`);
          }
        }}
        className="h-7 w-full rounded-md border border-line bg-surface-0 pr-2 pl-7 text-xs text-ink placeholder:text-ink-muted"
      />
    </div>
  );
}
