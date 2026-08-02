import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Redo2, Undo2 } from 'lucide-react';
import MindElixir, { type MindElixirInstance } from 'mind-elixir';
import 'mind-elixir/style';

import { toMindElixir, fromMindElixir, markmapLoss, type MindMapDoc } from '@openmemo/mindmap';

import { Button } from '../../components/common/Button';
import { downloadMindmapImage } from './export';

/**
 * F4 思维导图渲染 + **编辑**（ADR-002 决策 3）。
 *
 * ## 为什么是 mind-elixir 而不是 markmap
 *
 * 用户的原话是"**整理**思维导图"——整理 = 编辑，是主路径。
 * markmap 是 Markdown → 图的单向渲染器，编辑能力弱（这正是竞品的局限）。
 * mind-elixir 自带拖拽、右键菜单、撤销/重做、节点样式、自由连线，
 * **这就是当初选它的全部理由**；不真的把这些接上，这个选型就白做了。
 *
 * ## 库无关性怎么守住
 *
 * 本组件是**唯一** import `mind-elixir` 的地方。
 * 数据进出都经 `packages/mindmap` 的适配器（`toMindElixir` / `fromMindElixir`），
 * 业务侧只见 `MindMapDoc`。换渲染器 = 换这一个文件。
 */
/** 形状完整才交给渲染器 —— `toMindElixir` 会 `Object.keys(doc.nodes)`，nodes 缺失即崩。 */
function isRenderableDoc(d: MindMapDoc | null | undefined): d is MindMapDoc {
  return Boolean(d && typeof d === 'object' && d.nodes && typeof d.nodes === 'object' && d.rootKey);
}

export function MindmapView({
  doc,
  editable = true,
  onChange,
}: {
  doc: MindMapDoc;
  editable?: boolean;
  onChange?: (next: MindMapDoc) => void;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const meRef = useRef<MindElixirInstance | null>(null);
  const [ready, setReady] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !isRenderableDoc(doc)) return;

    const me = new MindElixir({
      el,
      direction: MindElixir.RIGHT,
      editable,
      // 这三个就是"整理"能力的本体，全部打开
      contextMenu: true,
      toolBar: true,
      keypress: true,
      allowUndo: true,
    });

    // 适配器把库无关的 MindMapDoc 转成 mind-elixir 的形状
    me.init(toMindElixir(doc) as never);
    meRef.current = me;
    setReady(true);

    // 任何编辑操作 → 转回 MindMapDoc 交给上层保存
    // （D-05 §2.5：导图编辑走乐观更新，等往返会让拖拽卡顿）
    me.bus.addListener('operation', () => {
      if (!onChangeRef.current) return;
      try {
        const next = fromMindElixir(me.getData() as never, { uid: doc.uid });
        onChangeRef.current(next);
      } catch (err) {
        console.error('[mindmap] fromMindElixir 失败', err);
      }
    });

    return () => {
      me.destroy();
      meRef.current = null;
      setReady(false);
    };
    // doc.uid 变化才重建；doc 内容变化由外部走 refresh，避免编辑时被自己覆盖
  }, [doc.uid, editable]);

  if (!isRenderableDoc(doc)) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-ink-muted">
        {t('mindmap.empty')}
      </div>
    );
  }

  const loss = markmapLoss(doc);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={!ready}
          onClick={() => meRef.current?.undo()}
          title={t('mindmap.undo')}
        >
          <Undo2 className="size-3.5" />
          {t('mindmap.undo')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!ready}
          onClick={() => meRef.current?.redo()}
          title={t('mindmap.redo')}
        >
          <Redo2 className="size-3.5" />
          {t('mindmap.redo')}
        </Button>

        <span className="mx-1 h-4 w-px bg-line" aria-hidden />

        <Button
          size="sm"
          variant="ghost"
          disabled={!ready}
          onClick={() => meRef.current && void downloadMindmapImage(meRef.current, doc, 'svg')}
        >
          <Download className="size-3.5" />
          SVG
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!ready}
          onClick={() => meRef.current && void downloadMindmapImage(meRef.current, doc, 'png')}
        >
          <Download className="size-3.5" />
          PNG
        </Button>

        <span className="ml-auto text-xs text-ink-muted">{t('mindmap.editHint')}</span>
      </div>

      <div ref={hostRef} className="min-h-0 flex-1" />

      {/* 切到只读视图会丢东西时必须明示（D-02 §2.3 损失矩阵），不静默丢弃 */}
      {loss.edges > 0 || loss.summaries > 0 ? (
        <p className="border-t border-line px-3 py-1.5 text-xs text-ink-muted">
          {t('mindmap.markmapLoss', { edges: loss.edges, summaries: loss.summaries })}
        </p>
      ) : null}
    </div>
  );
}
