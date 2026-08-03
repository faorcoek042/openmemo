import { Fragment, type ReactElement } from 'react';

/**
 * 把文案里的 `**强调**` 渲染成 `<strong>`，而不是把星号原样吐给用户。
 *
 * ## 为什么需要这个东西
 *
 * 仓库里有**两类**文案会带 Markdown 强调标记，而**两类都不是我们能就地改掉的**：
 *
 * 1. **服务端下发的原文**。最典型的是 `GET /api/secrets` 的 `disclosure.messageZh`
 *    （`packages/llm/src/secrets.ts:68`）：`API Key 以**明文**保存在 …`。
 *    ADR-006 决策 1 要求这句话**由服务端给**（路径随 `OPENMEMO_DATA_DIR` 变，
 *    前端硬编码必然说错），所以前端只能照单渲染 —— 于是用户在
 *    `/models?tab=llm` 上真的看见 `以**明文**保存`。
 * 2. **locale 文件里的词条**。`settings.llmIntro` 等 5 处同样带 `**`。
 *
 * 逐处删星号能治当下这一处，治不了下一个人再写一处 —— 而且删掉之后
 * "明文"这个必须被看见的词就跟正文一样平了，**信息是有损的**。
 * 所以选另一条：**给强调一个真的渲染器**，写的人得到他要的效果，
 * 用户永远看不到裸标记。
 *
 * ## 刻意的限制
 *
 * 这**不是** Markdown 渲染器，只认 `**…**` 一种记号，其余字符原样输出。
 * 不引入 markdown 依赖、不做 `dangerouslySetInnerHTML` —— 这里的输入包含
 * **服务端字符串**，把它当 HTML 解释就是一条注入面；拆成文本节点则完全没有这个面。
 * 未闭合的 `**` 原样保留（宁可显示一个星号，也不要吃掉半句话）。
 */
export function Emphasis({ text, className }: { text: string; className?: string }): ReactElement {
  const parts = splitEmphasis(text);
  return (
    <span className={className}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p.strong ? <strong className="font-semibold text-ink">{p.text}</strong> : p.text}
        </Fragment>
      ))}
    </span>
  );
}

/** 导出以便直接测规则（比断言渲染结果稳）。 */
export function splitEmphasis(text: string): { text: string; strong: boolean }[] {
  const out: { text: string; strong: boolean }[] = [];
  // 非贪婪 + 不允许跨越另一个 `**`：`a**b**c**d**e` 应得到 b 与 d 两段强调
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), strong: false });
    out.push({ text: m[1] as string, strong: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), strong: false });
  return out;
}
