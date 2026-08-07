import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Redo2, Undo2 } from 'lucide-react';
import MindElixir, { type MindElixirInstance } from 'mind-elixir';
import 'mind-elixir/style';

import { toMindElixir, fromMindElixir, type MindMapDoc } from '@openmemo/mindmap';

import { Button } from '../../components/common/Button';
import { downloadMindmapImage } from './export';
import { docSignature } from './docSignature';

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
  /** 屏幕上这张图当前的内容签名 —— 见 `docSignature.ts` 的文件头。 */
  const shownRef = useRef<string>('');

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
    shownRef.current = docSignature(doc);
    setReady(true);

    // 任何编辑操作 → 转回 MindMapDoc 交给上层保存
    // （D-05 §2.5：导图编辑走乐观更新，等往返会让拖拽卡顿）
    me.bus.addListener('operation', () => {
      try {
        const next = fromMindElixir(me.getData() as never, { uid: doc.uid });
        /*
         * ★ 屏幕已经变了，签名必须跟着变 —— 哪怕上层没给 onChange（只读视图）。
         * 不更新的话，自己这次编辑存回服务端、再拉回来时会被判成"别人改的"，
         * 于是渲染器**在用户手底下被重建一次**（缩放、选中、撤销栈全丢）。
         */
        shownRef.current = docSignature(next);
        onChangeRef.current?.(next);
      } catch (err) {
        console.error('[mindmap] fromMindElixir 失败', err);
      }
    });

    return () => {
      me.destroy();
      meRef.current = null;
      shownRef.current = '';
      setReady(false);
    };
    /*
     * ⚠️ 这里的依赖**只管"要不要换一个实例"**，不管内容 —— 内容变化由下面那个
     * effect 用 `refresh()` 就地更新，这样编辑中的视图状态不会被整个推倒重建。
     *
     * 原来这条依赖后面跟着一句注释：「doc.uid 变化才重建；doc 内容变化由外部走 refresh」。
     * 前半句成立，**后半句描述的机制根本不存在**（全仓没有任何一处 refresh），
     * 而且 `doc.uid` **是笔记的 uid**（生成时传的就是 `note.uid`），在同一条笔记里恒定不变 ——
     * 于是"重新生成之后页面不更新"（T-139 C10）：数据到了、缓存换了、图没换。
     */
  }, [doc.uid, editable]);

  /*
   * 外部把文档换掉了（重新生成 / 别的标签页改了 / SSE 触发的重拉）→ 就地换图。
   *
   * 判据是**内容签名**而不是对象引用，也不是 `revision`：
   * react-query 每次重取都给一个新对象（引用比会疯狂重建），
   * 而 `revision` 在用户自己保存后同样会 +1（那会在编辑中途重置视图）。
   * 只有"屏幕上显示的内容 ≠ 刚拿到的内容"时才动它。
   */
  useEffect(() => {
    const me = meRef.current;
    if (!me || !isRenderableDoc(doc)) return;
    const sig = docSignature(doc);
    if (sig === shownRef.current) return;
    me.refresh(toMindElixir(doc) as never);
    shownRef.current = sig;
  }, [doc]);

  if (!isRenderableDoc(doc)) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-ink-muted">
        {t('mindmap.empty')}
      </div>
    );
  }

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
      {/*
        ★ T-165：这里原来有一句「切到**大纲视图**将不显示 N 条关联线与 M 个概要」。
        **删掉了，不是改写。**

        产品里没有大纲视图 —— `markmap-lib` / `markmap-view` 全仓零 import，
        `toMarkmap` / `markmapLoss` 零调用方（本轮连同适配器一起摘掉）。
        也就是说那句话在描述**用户做不到的一个动作**的后果。

        为什么不改写成一句"真话"：那两样东西（自由连线、概要）在现有的**任何**一条
        路径上都不会丢 —— SVG/PNG 导出走的是 mind-elixir 的实时画布，它们都在。
        改写只会产生第二句需要读者自己判断真假的话，而那正是本仓最贵的那一类。
      */}
    </div>
  );
}
