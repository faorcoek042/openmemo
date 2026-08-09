/**
 * `extractJson` 的鲁棒性测试。
 *
 * 这些用例全部来自 **T-023 真跑本地 llama-server 时实际遇到的坏输出形态**，
 * 不是想象出来的。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LlmError } from './errors.js';
import { extractJson } from './structured.js';

describe('extractJson', () => {
  it('直接的合法 JSON', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('  \n {"a":[1,2]} \n '), { a: [1, 2] });
  });

  it('**剥 markdown 围栏** —— json_object 模式下的实测坏输出', () => {
    // 实测：llama-server + Qwen3-0.6B 在 response_format:json_object 下返回这个形态
    assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('```\n{"a": 1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('好的：\n```json\n{"a":1}\n```\n以上。'), { a: 1 });
  });

  it('前后有解说文字时能捞出 JSON', () => {
    assert.deepEqual(extractJson('这是结果 {"a":1} 希望有帮助'), { a: 1 });
  });

  it('字符串里含括号不会被截错', () => {
    assert.deepEqual(extractJson('{"a":"}"}'), { a: '}' });
    assert.deepEqual(extractJson('{"a":"{[}]"}'), { a: '{[}]' });
    assert.deepEqual(extractJson('{"a":"转义\\"引号}"}'), { a: '转义"引号}' });
  });

  it('中文内容正常', () => {
    assert.deepEqual(extractJson('{"标题":"思维导图 & 转写稿"}'), { 标题: '思维导图 & 转写稿' });
  });

  it('**截断的输出报"被截断"，而不是误导性的结构错误**', () => {
    // 这正是 1.7B 模型 max_tokens 不够时的真实形态：
    // 外层不闭合，但内层有一个恰好闭合的对象
    const truncated = '{"topics":[{"title":"X","seg":[0],"points":[{"text":"Y","seg":[0]}]}';
    assert.throws(
      () => extractJson(truncated),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.equal(err.code, 'LLM_STRUCTURED_OUTPUT_FAILED');
        assert.match(err.message, /truncated/i, `应明确指出截断，实际：${err.message}`);
        /*
         * ★ 这里原本钉的是 `remediation.action === 'increaseMaxTokens'`。
         *   用户 2026-08-09 裁决「引导跳过去解决不了问题就删掉」之后，那条行动号召
         *   被移除了 —— 因为 `maxTokens` 是本仓**刻意不给控件**的字段
         *   （`LlmSettingsSection.tsx:491`：「改了不生效的输入框是假控件」），
         *   界面上永远无处可点，`RemediationButton` 对它返回 null。
         *
         * ⚠️ 但**不能把这行断言删掉了事** —— 那是"放宽断言变绿"。
         *   改成钉**新的契约**，而且比原来更具体：
         *     ① 确实不带行动号召（不许再冒出一个点不出来的按钮）；
         *     ② 诊断信息没有被一起删掉（§13）——中文文案要说清"被截断"；
         *     ③ 要给出用户**真的做得到**的那条出路（换更大的模型，
         *        控件就在 /models?tab=llm）。
         *   ②③ 是原来那版**没有**钉的，所以这不是把守卫削弱了。
         */
        assert.equal(
          err.remediation,
          undefined,
          '不该再带行动号召：maxTokens 没有任何界面控件，按钮点不出来',
        );
        assert.match(err.messageZh, /截断/, `中文文案要说清"被截断"，实际：${err.messageZh}`);
        assert.match(
          err.messageZh,
          /更大的模型/,
          `要给出用户真的做得到的出路（换更大的模型），实际：${err.messageZh}`,
        );
        return true;
      },
    );
  });

  it('截断检测必须优先于内层对象扫描（顺序反了不会变红，只会误导人）', () => {
    const truncated = '{"outer":[{"inner":1}';
    let msg = '';
    try {
      extractJson(truncated);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert.match(msg, /truncated/i);
    assert.doesNotMatch(msg, /cannot extract/i);
  });

  it('数组截断同样被识别', () => {
    assert.throws(() => extractJson('[{"a":1},{"b":2}'), /truncated/i);
  });

  it('完全不是 JSON 时报"没有合法 JSON"（与截断区分开）', () => {
    assert.throws(
      () => extractJson('抱歉，我无法完成这个请求。'),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.match(err.message, /cannot extract JSON/i);
        return true;
      },
    );
  });

  it('闭合但多余的尾随内容不影响', () => {
    assert.deepEqual(extractJson('{"a":1}\n\n补充说明：无'), { a: 1 });
  });
});
