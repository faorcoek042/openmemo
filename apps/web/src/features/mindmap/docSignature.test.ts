/**
 * T-139 C10 —— 「屏幕上这张图该不该换掉」。
 *
 * ## 先读断言：这些用例什么时候会失败
 *
 * 1. 两份**内容不同**的文档必须给出不同签名 → 否则重新生成之后页面永远不更新
 *    （这就是 C10 的用户症状：LLM 真的跑完了、缓存也真的重取了，图还是旧的）。
 * 2. 同一份文档换了节点 key / 样式 / 折叠状态，签名必须**不变** → 否则用户拖一个节点、
 *    600ms 后自己的保存回来一趟，渲染器就在他手底下重建一次（缩放、选中、撤销栈全丢）。
 *    原来那条 `[doc.uid]` 依赖的注释担心的正是这个，担心是对的，只是修法选错了。
 * 3. 环 / 悬空引用不许打死进程 —— 签名函数拿到的是**服务端给什么就是什么**，
 *    不能假设它一定通过了 `validate()`。
 *
 * fixture 是从真 daemon `GET /api/notes/:uid/mindmap` 抓下来的真产物（LLM 生成 + 落库 + 读回），
 * 不是手写的想象形状。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MindMapDoc } from '@openmemo/mindmap';
import { docSignature } from './docSignature';

/** ★ 取证：真 daemon 上一次真实生成的产物（`generatedBy: "llm:fakevendor"`），结构一字未改。 */
const REAL_DOC = {
  schemaVersion: 1,
  uid: '01KZ47V1X2YB402JKD60KRHK97',
  title: '契约验证用笔记',
  rootKey: 'n0',
  revision: 2,
  nodes: {
    n0: { key: 'n0', text: '契约验证用笔记', children: ['n1', 'n3'] },
    n1: {
      key: 'n1',
      text: '第8次生成的主题',
      children: ['n2'],
      refs: [{ transcriptUid: 't', startMs: 0, endMs: 2000, quote: '第一段', matchScore: 1 }],
      meta: { generatedBy: 'llm:fakevendor', window: 0 },
    },
    n2: { key: 'n2', text: '第8次生成的要点', children: [] },
    n3: { key: 'n3', text: '取舍与后续计划', children: ['n4'] },
    n4: { key: 'n4', text: '先做能用的那一半', children: [] },
  },
} as unknown as MindMapDoc;

/** 同一条笔记**重新生成**一次：uid 不变、rootKey 不变，只有文本换了。 */
const REGENERATED = {
  ...REAL_DOC,
  revision: 3,
  nodes: {
    ...REAL_DOC.nodes,
    n1: { ...REAL_DOC.nodes['n1'], text: '第9次生成的主题' },
  },
} as unknown as MindMapDoc;

describe('T-139 C10 —— 导图内容签名', () => {
  it('★ 重新生成后内容变了 → 签名必须变（否则页面永远停在旧图上）', () => {
    assert.notEqual(docSignature(REAL_DOC), docSignature(REGENERATED));
  });

  it('★ uid 与 revision 都不是判据 —— 只有用户看得见的内容才是', () => {
    // 这是 C10 的正主：doc.uid 是**笔记**的 uid，同一条笔记里它永远不变，
    // 拿它当重建条件等于永远不重建。
    assert.equal(REAL_DOC.uid, REGENERATED.uid);
    assert.notEqual(docSignature(REAL_DOC), docSignature(REGENERATED));

    // 反过来：revision 变了但内容没变（比如自己保存了一次样式）→ 不该打断用户
    const sameContentNewRevision = { ...REAL_DOC, revision: 99 } as unknown as MindMapDoc;
    assert.equal(docSignature(REAL_DOC), docSignature(sameContentNewRevision));
  });

  it('节点 key 换了但树长得一样 → 签名不变（往返里 key 抖动不该重置视图）', () => {
    const renamed = {
      ...REAL_DOC,
      rootKey: 'r',
      nodes: {
        r: { key: 'r', text: '契约验证用笔记', children: ['a', 'c'] },
        a: { key: 'a', text: '第8次生成的主题', children: ['b'] },
        b: { key: 'b', text: '第8次生成的要点', children: [] },
        c: { key: 'c', text: '取舍与后续计划', children: ['d'] },
        d: { key: 'd', text: '先做能用的那一半', children: [] },
      },
    } as unknown as MindMapDoc;
    assert.equal(docSignature(renamed), docSignature(REAL_DOC));
  });

  it('样式 / 折叠 / refs / meta 变化不进签名（它们变了不需要打断用户）', () => {
    const restyled = {
      ...REAL_DOC,
      nodes: {
        ...REAL_DOC.nodes,
        n1: {
          ...REAL_DOC.nodes['n1'],
          style: { color: '#f00', bold: true },
          collapsed: true,
          refs: [],
          meta: {},
        },
      },
    } as unknown as MindMapDoc;
    assert.equal(docSignature(restyled), docSignature(REAL_DOC));
  });

  it('★ 换了顺序 = 换了内容（children 的数组顺序就是显示顺序）', () => {
    const reordered = {
      ...REAL_DOC,
      nodes: { ...REAL_DOC.nodes, n0: { ...REAL_DOC.nodes['n0'], children: ['n3', 'n1'] } },
    } as unknown as MindMapDoc;
    assert.notEqual(docSignature(reordered), docSignature(REAL_DOC));
  });

  it('标题变了也算变了（用户看得见它）', () => {
    assert.notEqual(
      docSignature({ ...REAL_DOC, title: '换了个名字' } as unknown as MindMapDoc),
      docSignature(REAL_DOC),
    );
  });

  it('环 / 悬空 child / 空文档：只准返回字符串，不准抛也不准爆栈', () => {
    const cyclic = {
      ...REAL_DOC,
      nodes: {
        n0: { key: 'n0', text: 'a', children: ['n1'] },
        n1: { key: 'n1', text: 'b', children: ['n0', 'ghost'] },
      },
    } as unknown as MindMapDoc;
    assert.equal(typeof docSignature(cyclic), 'string');
    assert.equal(docSignature(null), '');
    assert.equal(docSignature(undefined), '');
    assert.equal(docSignature({ nodes: {} } as unknown as MindMapDoc), '');
  });
});
