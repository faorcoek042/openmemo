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
import { useLocation } from 'react-router';

import { blur, click, pressKey, render, stubApi, type } from './host';
import { SearchBox } from '../features/search/SearchBox';
import { LlmSettingsSection } from '../components/common/llm/LlmSettingsSection';

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
 * 存量回收（T-133 §存量排查）。
 *
 * 这两条是 `components.test.tsx` 里因为本缺陷被写成 `{ skip: true }` 的用例
 * （原注释：「本宿主不支持文本输入提交，交给真浏览器 E2E」）。
 * 缺陷修好后它们**能跑了**，所以在这里重建等价版本，证明"跳过的理由已经不成立"。
 *
 * 我没有去改 `components.test.tsx` 里那两行 skip —— 那个文件 `models-page-fix` 正在改，
 * 处置权留给 Manager。这里的用例是**独立**的，不依赖那边怎么改。
 */
describe('存量回收：因宿主缺陷被 skip 的用例现在能跑了', () => {
  test('★ TagEditor：输入标签名后回车，两条请求都要真的发出去', async () => {
    const { TagEditor } = await import('../features/notes/TagEditor');
    const { calls } = stubApi({
      // 真实链路是两步：先建标签拿 uid，再把整张 uid 表挂到笔记上
      'POST /tags': { uid: 't9', name: '播客', color: null },
      'POST /notes/n1/tags': { ok: true },
    });
    const r = await render(<TagEditor noteUid="n1" tags={[]} />);

    const addBtn = Array.from(r.container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('加标签'),
    );
    await click(addBtn ?? null);

    const input = r.container.querySelector('input');
    assert.ok(input, '点「加标签」后应出现输入框');

    await type(input, '播客');
    await pressKey(input, 'Enter');
    await r.flush();

    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 2, `应发出两条 POST，实际：${JSON.stringify(calls)}`);
    assert.equal(posts[0]!.path, '/tags');
    assert.deepEqual(posts[0]!.body, { name: '播客' }, '建标签要带用户输入的名字');
    assert.equal(posts[1]!.path, '/notes/n1/tags');
    assert.deepEqual(posts[1]!.body, { tagUids: ['t9'] }, '挂载要用服务端回的 uid');
    r.unmount();
  });

  test('★ LlmSettingsSection：填入 Key 后保存，真的 PUT /secrets/llm.<id>.apiKey', async () => {
    const providers = [
      {
        id: 'openai',
        kind: 'openai-compatible',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        isLocal: false,
      },
    ];
    const { calls } = stubApi({
      '/settings': { settings: { 'llm.providers': providers, 'llm.activeProviderId': 'openai' } },
      '/secrets': {
        secrets: [],
        disclosure: {
          storage: 'plaintext-file',
          path: '/tmp/x/secrets.json',
          filePermission: '0600',
          dirPermission: '0700',
          messageZh: 'x',
          message: 'x',
        },
      },
      'PATCH /settings': { ok: true },
      'PUT /secrets/llm.openai.apiKey': { ok: true },
    });
    const r = await render(<LlmSettingsSection />);
    await r.flush();

    const row = Array.from(r.container.querySelectorAll('li')).find((li) =>
      (li.textContent ?? '').includes('OpenAI'),
    );
    await click(
      Array.from(row!.querySelectorAll('button')).find((b) => b.textContent?.includes('编辑')) ?? null,
    );
    await r.flush();

    const keyInput = row!.querySelector('input[type="password"]');
    assert.ok(keyInput, '前提：云 provider 要有 Key 输入框');

    await type(keyInput, 'sk-test-12345');
    await click(r.container.querySelector('[data-testid="llm-save"]'));
    await r.flush();

    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put, `应发出 PUT，实际写请求：${JSON.stringify(calls.filter((c) => c.method !== 'GET'))}`);
    assert.equal(put!.path, '/secrets/llm.openai.apiKey');
    assert.deepEqual(put!.body, { value: 'sk-test-12345' }, 'Key 要原样写进去，不能被 trim 掉或改名');
    r.unmount();
  });
});

/**
 * 存量修补（T-133 §存量排查）。
 *
 * `components.test.tsx` 里那条「回车跳转到 /search?q=… 并对查询串做 URL 编码」
 * **从来没有断言过 URL** —— 它只断言了 `input.value` 还在
 * （原注释：「MemoryRouter 下用 location 断言不方便」）。
 * `[实测]` 把 `SearchBox` 的 `navigate(...)` 整句删掉，那条用例**依然是绿的**；
 * 换成下面这种断言 URL 的写法，同一个变异体当场变红（`'/' !== '/search?q=…'`）。
 * 这是「假绿灯家族 #5：只断言前置条件的测试」的又一例。
 *
 * 用 `MemoryRouter` 断言 location 其实很方便：往树里塞一个读 `useLocation` 的探针即可。
 * 我没有去改那条旧用例（那个文件 `models-page-fix` 正在改），在这里补一条真的会红的。
 */
function LocationProbe() {
  const loc = useLocation();
  return <i data-probe="loc">{loc.pathname + loc.search}</i>;
}

describe('存量修补：SearchBox 回车跳转 —— 断言 URL，不是断言输入框还在', () => {
  test('★ 回车真的跳到 /search?q=…，且查询串被 URL 编码', async () => {
    stubApi({});
    const r = await render(
      <div>
        <SearchBox />
        <LocationProbe />
      </div>,
    );
    const input = r.container.querySelector('input');
    await type(input, '反向传播 & 梯度');
    await pressKey(input, 'Enter');
    await r.flush();

    assert.equal(
      r.container.querySelector('[data-probe="loc"]')?.textContent,
      '/search?q=%E5%8F%8D%E5%90%91%E4%BC%A0%E6%92%AD%20%26%20%E6%A2%AF%E5%BA%A6',
      '没跳转 —— 而旧断言（只看 input.value）在这种情况下照样是绿的',
    );
    r.unmount();
  });

  test('★ 只有空白的查询不跳转（跳过去只会得到一个空搜索页）', async () => {
    stubApi({});
    const r = await render(
      <div>
        <SearchBox />
        <LocationProbe />
      </div>,
    );
    const input = r.container.querySelector('input');
    await type(input, '   ');
    await pressKey(input, 'Enter');
    await r.flush();

    assert.equal(
      r.container.querySelector('[data-probe="loc"]')?.textContent,
      '/',
      '空白查询不该离开当前页 —— 旧用例这里一条断言都没有，只要不抛错就算过',
    );
    r.unmount();
  });
});
