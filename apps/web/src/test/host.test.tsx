/**
 * 组件测试宿主**自证**套件（T-133）。
 *
 * ## 它存在的理由
 *
 * 这一套不测任何产品组件，它测的是**测试宿主本身有没有在撒谎**。
 *
 * 起因：`host.tsx` 的 `type()` 曾经**驱动不了受控文本输入框** ——
 * `fireEvent.change` / `fireEvent.input` / 原型链原生 setter 三种写法都进不到 React 的
 * `onChange`，state 恒为初值。而它**不报错**：`input.value` 照样被原生 setter 写成新值，
 * 于是「输入 → 回车 → 断言请求发出去了」这类用例统统退化成
 * **在断言"什么都没发生"**，全绿。
 *
 * 根因不在事件派发写法，在 `vite build --ssr` 会把外部依赖的 `import` 提升到
 * `dom-env` 的包体之前，react-dom 于是在**没有 window 的时候**完成模块初始化
 * （`canUseDOM=false` → `isInputEventSupported=false` → 文本输入走 IE 的
 * `onpropertychange` polyfill 分支，`input`/`change` 被整段丢弃）。详见 `host.tsx` 文件头。
 *
 * ## 这些断言为什么长这样
 *
 * **一律断言"渲染出来的 state"，绝不断言 `input.value`。**
 * 受控组件在缺陷状态下这两者会分叉：DOM 值是对的、state 是空的 ——
 * 而 `input.value` 那一半在缺陷状态下**照样通过**。
 * 拿它做判据，就等于把这套护栏也写成假绿灯（HANDOFF ★ 规矩 7：断言要钉后果，不要钉形式）。
 *
 * 将来 `type()` 再退化，本文件必须变红。反向验证记录见
 * `coordination/inbox/test-host.md` T-133 §反向验证。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';

import { blur, click, pressKey, render, stubApi, type } from './host';

/** 受控文本输入框：state 的唯一出口是 `<b data-probe="state">`，不是 input 自己。 */
function ControlledInput({ onEnter }: { onEnter?: (v: string) => void } = {}) {
  const [v, setV] = useState('');
  return (
    <div>
      <input
        type="text"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter?.(v);
        }}
      />
      <b data-probe="state">{v}</b>
    </div>
  );
}

function ControlledTextarea() {
  const [v, setV] = useState('');
  return (
    <div>
      <textarea value={v} onChange={(e) => setV(e.target.value)} />
      <b data-probe="state">{v}</b>
    </div>
  );
}

function ControlledSelect() {
  const [v, setV] = useState('a');
  return (
    <div>
      <select value={v} onChange={(e) => setV(e.target.value)}>
        <option value="a">甲</option>
        <option value="b">乙</option>
      </select>
      <b data-probe="state">{v}</b>
    </div>
  );
}

const stateOf = (c: HTMLElement): string => c.querySelector('b[data-probe="state"]')?.textContent ?? '';

describe('宿主自证：type() 必须真的驱动受控输入框', () => {
  test('★ 受控 input：type() 之后 React 的 state 真的变了（不是只有 DOM 属性变了）', async () => {
    stubApi({});
    const r = await render(<ControlledInput />);
    const input = r.container.querySelector('input');

    assert.equal(stateOf(r.container), '', '前提：初始 state 必须是空的');

    await type(input, '反向传播');

    assert.equal(
      stateOf(r.container),
      '反向传播',
      'state 没变 —— onChange 没进到 React。这正是 T-133 那个假绿灯：' +
        '它不报错，只让所有输入相关的用例变成在断言"什么都没发生"',
    );
    r.unmount();
  });

  test('★ DOM 值与 state 必须**同时**对上 —— 只断言 DOM 值的写法在缺陷状态下照样绿', async () => {
    stubApi({});
    const r = await render(<ControlledInput />);
    const input = r.container.querySelector('input') as HTMLInputElement;

    await type(input, 'abc');

    // 这一半在缺陷状态下也成立（原生 setter 写的），单独用它做判据 = 假绿灯
    assert.equal(input.value, 'abc', 'DOM 值');
    // 这一半才是真判据
    assert.equal(stateOf(r.container), 'abc', 'React state —— 缺陷状态下这里会是空串');
    r.unmount();
  });

  test('★ 输入后紧接着按键：keydown 处理器必须拿到**新** state（闭包已随重渲染更新）', async () => {
    stubApi({});
    const seen: string[] = [];
    const r = await render(<ControlledInput onEnter={(v) => seen.push(v)} />);
    const input = r.container.querySelector('input');

    await type(input, '梯度');
    await pressKey(input, 'Enter');

    assert.deepEqual(
      seen,
      ['梯度'],
      '回车时拿到的应该是刚输入的值。旧宿主在这里拿到的是空串 —— ' +
        '「输入文字→回车提交」整类流程当年就是因此被标成 skip 的',
    );
    r.unmount();
  });

  test('★ 受控 textarea 同样能被驱动（isTextInputElement 的另一半）', async () => {
    stubApi({});
    const r = await render(<ControlledTextarea />);
    await type(r.container.querySelector('textarea'), '多行\n文本');
    assert.equal(stateOf(r.container), '多行\n文本');
    r.unmount();
  });

  test('受控 <select> 仍然可用（它走的是另一条分支，别在修 input 时把它弄坏）', async () => {
    stubApi({});
    const r = await render(<ControlledSelect />);
    await type(r.container.querySelector('select'), 'b');
    assert.equal(stateOf(r.container), 'b');
    r.unmount();
  });

  test('连续输入两次：第二次覆盖第一次，state 跟着走（不是只追加/只保留首次）', async () => {
    stubApi({});
    const r = await render(<ControlledInput />);
    const input = r.container.querySelector('input');
    await type(input, '一');
    await type(input, '一二');
    assert.equal(stateOf(r.container), '一二');
    r.unmount();
  });

  test('清空输入框：type(el, "") 必须让 state 变成空串（"改回空"是一次真实变更）', async () => {
    stubApi({});
    const r = await render(<ControlledInput />);
    const input = r.container.querySelector('input');
    await type(input, '临时');
    assert.equal(stateOf(r.container), '临时', '前提');
    await type(input, '');
    assert.equal(stateOf(r.container), '', '清空也必须传达到 state');
    r.unmount();
  });
});

describe('宿主自证：其它交互仍然成立（防止修 type 时误伤）', () => {
  test('click 能驱动 setState', async () => {
    stubApi({});
    function Counter() {
      const [n, setN] = useState(0);
      return (
        <button onClick={() => setN(n + 1)}>
          点了 <b data-probe="state">{String(n)}</b> 次
        </button>
      );
    }
    const r = await render(<Counter />);
    await click(r.container.querySelector('button'));
    assert.equal(stateOf(r.container), '1');
    r.unmount();
  });

  test('★ blur 触发 onBlur —— 而且**只触发一次**（RTL 的 fireEvent.blur 自带 focusOut）', async () => {
    stubApi({});
    let fired = 0;
    function OnBlur() {
      const [v, setV] = useState('');
      return (
        <div>
          <input
            type="text"
            onBlur={() => {
              fired += 1;
              setV(`blurred×${fired}`);
            }}
          />
          <b data-probe="state">{v}</b>
        </div>
      );
    }
    const r = await render(<OnBlur />);
    await blur(r.container.querySelector('input'));
    assert.equal(stateOf(r.container), 'blurred×1', 'onBlur 必须进且只进一次');
    assert.equal(fired, 1, 'host.blur() 再手工补一次 focusOut 就会变成 2 —— 那会让"失焦保存"发两条请求');
    r.unmount();
  });

  test('★ 输入 + 失焦提交：onBlur 处理器拿到的是输入后的值', async () => {
    stubApi({});
    const saved: string[] = [];
    function BlurSave() {
      const [v, setV] = useState('');
      return (
        <div>
          <input type="text" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => saved.push(v)} />
          <b data-probe="state">{v}</b>
        </div>
      );
    }
    const r = await render(<BlurSave />);
    const input = r.container.querySelector('input');
    await type(input, 'gpt-4o-mini');
    await blur(input);
    assert.deepEqual(saved, ['gpt-4o-mini'], '失焦保存拿到的必须是刚输入的值');
    r.unmount();
  });
});

/**
 * ★ 存量回收的去向（T-133，续办）：
 *
 * 这里原本还有两组用例 ——「因宿主缺陷被 skip 的用例现在能跑了」（TagEditor 回车 POST、
 * 填 Key → PUT secrets）与「SearchBox 回车跳转断言 URL」。
 * 当时 `components.test.tsx` 在别人手上，我只能在自己的文件里重建等价版本作为
 * "跳过/弱断言的理由已经不成立"的证据。
 *
 * 文件释放后**它们已经被搬回 `components.test.tsx` 的对应 describe 里**
 * （TagEditor 那组、LlmSettingsSection 那组、SearchBox 那组），此处删除以免重复覆盖。
 * 本文件只留**宿主自证**：产品行为归产品测试，宿主行为归这里，两者不该混在一处。
 */
