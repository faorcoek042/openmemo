/**
 * `extractPlainText` 测试。
 *
 * 关注三件事，其余都是次要的：
 *   1. **块之间不许粘连** —— 粘连会往 FTS 索引里灌入跨块的假词，且无法察觉
 *   2. **恶意输入不许把进程搞死** —— 输入直接来自 HTTP 请求体
 *   3. **用户在正文里看得见的字，必须进得了这份投影** —— 否则他搜不到，
 *      而且不会有任何一处报错（时间锚点那一族，见下面带 ★ 的那个 describe）
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { timeAnchorText } from '@openmemo/shared';

import { extractPlainText } from './richText.js';

describe('extractPlainText / 正常文档', () => {
  it('一篇像样的 TipTap 文档（标题、段落、列表、加粗斜体、代码块、软换行）', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: '会议纪要' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '今天讨论了 ' },
            { type: 'text', marks: [{ type: 'bold' }], text: '存储层' },
            { type: 'text', text: ' 与 ' },
            { type: 'text', marks: [{ type: 'italic' }], text: '索引' },
            { type: 'text', text: ' 的取舍。' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一条' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '第二条' }] }],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '上半行' },
            { type: 'hardBreak' },
            { type: 'text', text: '下半行' },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [{ type: 'text', text: 'const x = 1;' }],
        },
      ],
    };

    assert.equal(
      extractPlainText(doc),
      [
        '会议纪要',
        '',
        '今天讨论了 存储层 与 索引 的取舍。',
        '',
        '第一条',
        '',
        '第二条',
        '',
        '上半行',
        '下半行',
        '',
        'const x = 1;',
      ].join('\n'),
    );
  });

  it('marks 不影响文字本身（加粗的字和普通的字一样进索引）', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '这是' },
            {
              type: 'text',
              marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com' } }],
              text: '重点',
            },
          ],
        },
      ],
    };
    const out = extractPlainText(doc);
    assert.equal(out, '这是重点');
    assert.ok(!out.includes('example.com'), 'link 的 href 不该进索引');
  });

  it('中文正文原样往返，不做任何转义或规范化', () => {
    const original = '本项目的主要语言是中文，标点也要留着：逗号、句号。还有「引号」和（括号）。';
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: original }] }],
    };
    assert.equal(extractPlainText(doc), original);
  });

  it('中英混排与 emoji 也不丢字', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '用 whisper.cpp 跑 ASR 🎙️ 延迟 300ms' }],
        },
      ],
    };
    assert.equal(extractPlainText(doc), '用 whisper.cpp 跑 ASR 🎙️ 延迟 300ms');
  });

  it('不认识的自定义节点：能拿到文字就拿，不因 schema 陌生而整篇丢掉', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'someFutureExtension', content: [{ type: 'text', text: '未来节点里的字' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '正常段落' }] },
      ],
    };
    const out = extractPlainText(doc);
    assert.ok(out.includes('未来节点里的字'));
    assert.ok(out.includes('正常段落'));
  });
});

describe('extractPlainText / 块级分隔', () => {
  it('相邻两段之间必须断开，"结束"和"开始"不能粘成一个词', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '第一段到此结束' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '开始讲第二段' }] },
      ],
    };
    const out = extractPlainText(doc);
    assert.ok(
      !out.includes('结束开始'),
      `跨块粘连会污染 FTS 索引，实际得到：${JSON.stringify(out)}`,
    );
    assert.equal(out, '第一段到此结束\n\n开始讲第二段');
  });

  it('列表项之间同样要断开', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '甲' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '乙' }] }],
            },
          ],
        },
      ],
    };
    assert.ok(!extractPlainText(doc).includes('甲乙'));
  });

  it('表格单元格之间要断开', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '左格' }] }],
                },
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '右格' }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    assert.ok(!extractPlainText(doc).includes('左格右格'));
  });

  it('hardBreak 落成换行', () => {
    const doc = {
      type: 'paragraph',
      content: [{ type: 'text', text: '上' }, { type: 'hardBreak' }, { type: 'text', text: '下' }],
    };
    assert.equal(extractPlainText(doc), '上\n下');
  });

  it('连续空行收敛到最多两个，首尾空白去掉', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '甲' }] },
        { type: 'paragraph' },
        { type: 'paragraph' },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: '乙' }] },
      ],
    };
    const out = extractPlainText(doc);
    assert.equal(out, '甲\n\n乙');
    assert.ok(!/\n{3,}/.test(out));
    assert.equal(out, out.trim());
  });
});

describe('extractPlainText / attrs 里的文字', () => {
  it('图片 alt 与 title 进索引，src 不进', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '看这张图' },
            {
              type: 'image',
              attrs: {
                src: 'blob:http://localhost/8f3c-deadbeef',
                alt: '日落时的海岸线',
                title: '摄于三亚',
              },
            },
          ],
        },
      ],
    };
    const out = extractPlainText(doc);
    assert.ok(out.includes('日落时的海岸线'), 'alt 是正当的可搜索内容');
    assert.ok(out.includes('摄于三亚'));
    assert.ok(!out.includes('blob:'), 'URL 不该往索引里灌无意义 token');
    assert.ok(!out.includes('看这张图日落'), 'attrs 文字不能和正文粘连');
  });

  it('label 也读；有 text 时以 text 为准，不再看 attrs', () => {
    assert.ok(extractPlainText({ type: 'mention', attrs: { label: '@张三' } }).includes('@张三'));
    const both = extractPlainText({ type: 'text', text: '真正的文字', attrs: { alt: '不该出现' } });
    assert.equal(both, '真正的文字');
  });
});

/*
 * ═════════════════════════════════════════════════════════════════════════════
 * ★ 时间锚点：用户屏幕上看得见的那个 `0:04`，必须进得了 `body_text`
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ## 这条守的是后果，不是形式
 *
 * `notes.body_text` 唯一的用途是喂 `notes_fts`（`notes_fts_ai` / `notes_fts_au`
 * 两个触发器直接读这一列）。所以"某样东西进不了 `body_text`" = "用户搜不到它"。
 *
 * `[实测]` 浏览器审计的 A/B 对照，两次都是真的 `/api/search` 请求：
 *
 * | 页面上看到的 | 它在 `body_json` 里是什么 | 命中 |
 * | --- | --- | --- |
 * | `0:04` | `timeAnchor` 节点 | **0** |
 * | 同一段里的普通文字 | `text` 节点 | 1 |
 * | `0:04`（当纯文本再打一遍） | `text` 节点 | 1 |
 *
 * ⇒ 分词器与索引都是好的，就是这个节点进不了投影。
 *
 * ## 为什么用现场那条笔记的原样 JSON
 *
 * 手写一个"干净的"锚点会把最要命的两个细节洗掉：`startMs` 是**浮点**
 *（`4706.022`，来自播放器的 `currentTime * 1000`），`quote` 是 **null**
 *（那条录音的转写稿一段都没有 ⇒ `quoteAt()` 找不到覆盖该毫秒的段）。
 * "锚点总是带 quote"这个想当然的前提站不住，而下游真有代码信了它
 *（见 `segmentRepo.ts` 的 `replaceAnchors()`）。
 *
 * ## 把修法退回去它会红吗
 *
 * 会。删掉 `richText.ts` 里 `atomNodeText()` 那个口子（退回只认 `text` 与
 * `alt`/`title`/`label`），下面第一条当场红 —— 那正是审计前的代码。
 */
describe('★ extractPlainText / 时间锚点（进不了这里 = 用户搜不到）', () => {
  /** 审计现场 `audit-long.wav` 那条笔记 `body_json` 的原样片段（uid 01M1RY1FZ38EWNX5GQVW7ZYKBE）。 */
  const AUDITED_DOC = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'AUDITMARKanchors:' },
          {
            type: 'timeAnchor',
            attrs: {
              anchorKey: 'anc_62373cbc-c4fd-41cc-9f46-4f35d075ef66',
              startMs: 4706.022,
              transcriptUid: '01M1RY1G6E7QHRXFYHGNQ7F2EN',
              quote: null,
            },
          },
          { type: 'text', text: ' ' },
          {
            type: 'timeAnchor',
            attrs: {
              anchorKey: 'anc_11ee5cd3-0cbd-4f10-a352-3d5e9060c539',
              startMs: 39854.604999999996,
              transcriptUid: '01M1RY1G6E7QHRXFYHGNQ7F2EN',
              quote: null,
            },
          },
          { type: 'text', text: ' ' },
          {
            type: 'timeAnchor',
            attrs: {
              anchorKey: 'anc_6fe2d951-3378-4baa-b71d-04477568fcbb',
              startMs: 88305.031,
              transcriptUid: '01M1RY1G6E7QHRXFYHGNQ7F2EN',
              quote: null,
            },
          },
          { type: 'text', text: ' TIMECODEPROBE0:04literal' },
        ],
      },
    ],
  };

  it('★ 审计现场那条笔记：三个锚点的时间码都得出现在投影里', () => {
    const out = extractPlainText(AUDITED_DOC);
    // 审计当天 DB 里逐字是：'AUDITMARKanchors:   TIMECODEPROBE0:04literal'
    assert.ok(out.includes('[0:04]'), `4706.022ms 的锚点没进投影：${JSON.stringify(out)}`);
    assert.ok(out.includes('[0:39]'), `39854.6ms 的锚点没进投影：${JSON.stringify(out)}`);
    assert.ok(out.includes('[1:28]'), `88305ms 的锚点没进投影：${JSON.stringify(out)}`);
    // 同段的普通文字本来就进得去 —— 一并钉住，免得哪天"修好锚点"是靠把别的搞坏
    assert.ok(out.includes('AUDITMARKanchors:'));
  });

  it('★ 投影里那个字符串与前端画在屏幕上的，是同一个函数产的', () => {
    /*
     * 不是同义反复：它钉的是"daemon 没有另外拼一份"。有人把 `timeAnchorText()`
     * 换成就地 `` `[${…}]` ``、或者去掉方括号，这条会红 —— 而那种改动的真实后果
     * 是"用户照着屏幕上的字搜、搜不到"，除此之外没有任何地方会报错。
     */
    for (const ms of [0, 4706.022, 88305.031, 3_600_000, 4_354_000]) {
      const doc = { type: 'paragraph', content: [{ type: 'timeAnchor', attrs: { startMs: ms } }] };
      assert.equal(extractPlainText(doc), timeAnchorText(ms), `startMs=${ms}`);
    }
  });

  it('锚点与两侧的文字不粘成一个词', () => {
    const doc = {
      type: 'paragraph',
      content: [
        { type: 'text', text: '他在这里说' },
        { type: 'timeAnchor', attrs: { startMs: 88_000 } },
        { type: 'text', text: '那句话' },
      ],
    };
    assert.equal(extractPlainText(doc), '他在这里说[1:28]那句话');
  });

  it('attrs 缺失 / startMs 是垃圾值时降级成 [0:00]，不抛也不消失', () => {
    // 提取器的失败模式必须是"降级"：一个坏锚点不该让整篇笔记搜不到
    assert.equal(extractPlainText({ type: 'timeAnchor' }), '[0:00]');
    assert.equal(extractPlainText({ type: 'timeAnchor', attrs: {} }), '[0:00]');
    assert.equal(extractPlainText({ type: 'timeAnchor', attrs: { startMs: 'x' } }), '[0:00]');
    assert.equal(extractPlainText({ type: 'timeAnchor', attrs: { startMs: -5 } }), '[0:00]');
    assert.equal(extractPlainText({ type: 'timeAnchor', attrs: null }), '[0:00]');
  });

  it('反面：别的节点不许被顺手认成锚点', () => {
    // 口子是**具名**的，只对 timeAnchor 开。写成"凡是带 startMs 的都收"，
    // 将来任何一个带时间戳的内部节点都会被灌进索引。
    assert.equal(extractPlainText({ type: 'someOtherAtom', attrs: { startMs: 4706 } }), '');
  });
});

describe('extractPlainText / 恶意与畸形输入', () => {
  it('原始值与空容器一律返回空串，绝不抛异常', () => {
    for (const bad of [null, undefined, 42, NaN, 'a string', true, [], {}, Symbol('x')]) {
      let out: string | undefined;
      assert.doesNotThrow(
        () => {
          out = extractPlainText(bad);
        },
        `输入 ${String(bad)} 不该抛`,
      );
      assert.equal(out, '', `输入 ${String(bad)} 应得到空串`);
    }
  });

  it('自引用对象不会死循环', () => {
    const cyclic: Record<string, unknown> = {
      type: 'paragraph',
      content: [{ type: 'text', text: '有环' }],
    };
    (cyclic['content'] as unknown[]).push(cyclic);
    cyclic['self'] = cyclic;

    let out = '';
    assert.doesNotThrow(() => {
      out = extractPlainText(cyclic);
    });
    assert.equal(out, '有环');
  });

  it('数组自引用同样不会死循环', () => {
    const arr: unknown[] = [{ type: 'text', text: '甲' }];
    arr.push(arr);
    assert.doesNotThrow(() => extractPlainText(arr));
    assert.equal(extractPlainText(arr), '甲');
  });

  it('一万层嵌套：深度上限兜住，不爆栈', () => {
    let deep: Record<string, unknown> = { type: 'text', text: '最底层的字' };
    for (let i = 0; i < 10_000; i++) deep = { type: 'paragraph', content: [deep] };

    let out: string | undefined;
    assert.doesNotThrow(() => {
      out = extractPlainText(deep);
    }, '递归实现会在这里 RangeError；迭代实现不会');
    assert.equal(typeof out, 'string');
    // 文字在第 10000 层，早已超过默认 100 层上限 —— 拿不到是预期行为，重点是没崩
    assert.equal(out, '');
  });

  it('深度上限之内的文字照常取到', () => {
    let deep: Record<string, unknown> = { type: 'text', text: '够得着' };
    for (let i = 0; i < 20; i++) deep = { type: 'blockquote', content: [deep] };
    assert.equal(extractPlainText(deep), '够得着');
  });

  it('属性 getter 抛异常时降级，不把异常抛给调用方', () => {
    const hostile = {
      type: 'paragraph',
      get content(): unknown {
        throw new Error('boom');
      },
    };
    let out: string | undefined;
    assert.doesNotThrow(() => {
      out = extractPlainText(hostile);
    });
    assert.equal(typeof out, 'string');
  });

  it('字段类型错乱（content 是字符串、attrs 是数组、text 是数字）不影响其余部分', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: '这不是数组' },
        { type: 'image', attrs: ['也不是对象'] },
        { type: 'text', text: 12345 },
        { type: 'paragraph', content: [{ type: 'text', text: '这段是好的' }] },
      ],
    };
    assert.equal(extractPlainText(doc), '这段是好的');
  });
});

describe('extractPlainText / 长度上限', () => {
  const bigDoc = {
    type: 'doc',
    content: Array.from({ length: 5000 }, () => ({
      type: 'paragraph',
      content: [{ type: 'text', text: '一二三四五六七八九十' }],
    })),
  };

  it('显式 maxLength 被严格遵守', () => {
    const out = extractPlainText(bigDoc, { maxLength: 100 });
    assert.ok(out.length > 0, '截断不等于清空');
    assert.ok(out.length <= 100, `实际长度 ${out.length}`);
    assert.ok(out.startsWith('一二三四五六七八九十'));
  });

  it('maxLength 为 0 或负数直接返回空串', () => {
    assert.equal(extractPlainText(bigDoc, { maxLength: 0 }), '');
    assert.equal(extractPlainText(bigDoc, { maxLength: -1 }), '');
  });

  it('非法 maxLength 回退到默认值', () => {
    const out = extractPlainText(bigDoc, { maxLength: Number.NaN });
    assert.ok(out.length > 100, '不该被 NaN 意外截断');
    assert.ok(out.length <= 1_000_000);
  });

  it('默认上限（100 万字符）兜住超大文档', () => {
    const huge = {
      type: 'doc',
      content: Array.from({ length: 30_000 }, () => ({
        type: 'paragraph',
        content: [{ type: 'text', text: '甲'.repeat(100) }],
      })),
    };
    const out = extractPlainText(huge);
    assert.ok(out.length <= 1_000_000, `实际长度 ${out.length}`);
    assert.ok(out.length > 900_000, '应该是被上限截断，而不是提前收工');
  });

  it('小文档不受上限影响', () => {
    const doc = { type: 'paragraph', content: [{ type: 'text', text: '短' }] };
    assert.equal(extractPlainText(doc), '短');
  });
});
