/**
 * 组件级测试 —— 「渲染 + 交互 + 断言」。
 *
 * 这一层此前是空的：要么是纯逻辑单测（挡不住渲染），要么是一次性 jsdom 渲染
 * （只证明"渲染出来了"，证明不了"点得动"）。中间空档让 18 项交互全被推给真实浏览器。
 * **其中大部分只需要一个 DOM 和一次事件派发，不需要浏览器。**
 *
 * ⚠️ `./host` 保持**第一个 import**（它在模块顶层装 jsdom 全局）。
 * 但**别把这一行当成保证**：T-133 实测，`vite build --ssr` 会把 `react` /
 * `@testing-library/react` 这类**外部依赖**的 import 提升到包体最顶部，
 * 排到 `dom-env` 的 `new JSDOM(...)` **前面**去 —— 源码里的 import 顺序管不住它们。
 * 真正的保证在 `host.tsx` 里（RTL 改成动态 import + `type()` 的一次性自检），
 * 详见那边的 T-133 一节。
 */
import { render, click, type, pressKey, text, buttonByText, stubApi } from './host';

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useLocation } from 'react-router';

import { TagEditor } from '../features/notes/TagEditor';
import { SearchBox } from '../features/search/SearchBox';
import { JobList } from '../features/tasks/JobList';
import { LlmSettingsSection } from '../components/common/llm/LlmSettingsSection';
import { buildLlmSettingsPatch, LLM_PURPOSES_KEY } from '../components/common/llm/api';
import {
  LLM_PRESETS,
  LLM_CATALOG_STATS,
  catalogProviderFor,
} from '../components/common/llm/llm-catalog';
import { useSaveMindmapMutation } from '../features/mindmap/api';
import { applyCaption, RECORD_SAMPLE_RATE } from '../features/recorder/asrStream';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * 直接读源码断言"某段代码已被删除" —— 有些保证只能在源码层面表达。
 *
 * ⚠️ 用 **cwd 相对路径**而不是 `import.meta.url`：组件测试是 vite 打包到
 * `.test-out/` 之后再跑的，`import.meta.url` 指向产物目录而不是源码目录。
 * （第一版就是这么写错的，报了 ENOENT 指着 `.test-out/features/...`。）
 */
async function readSource(rel: string): Promise<string> {
  return readFileSync(`${process.cwd()}/src/${rel}`, 'utf8');
}
import { StatusChip } from '../components/common/StatusChip';
import { ProgressMeter } from '../components/common/ProgressMeter';
import type { MergedJob } from '../features/tasks/api';
import { arr } from '../lib/safe';
import { ApiError, api, setCsrf, clearCsrf, hasCsrf } from '../lib/api/client';
import { PanelBoundary } from '../components/common/PanelBoundary';
import { resolveErrorText } from '../components/common/ErrorBlock';
import { ASR_ENGINE_IDS } from '@openmemo/shared';
import { ASR_ENGINE_LABELS, isValidAsrLanguage } from '../lib/asr';
import { AsrModelPicker } from '../components/common/AsrModelPicker';
import { AsrEngineStatus } from '../components/common/AsrEngineStatus';
import { useImportUrlMutation } from '../features/notes';
import { DataLocationSection, StaleLinksWarning } from '../features/settings/DataLocationSection';
import { RetranscribeButton, isSegmentEdited } from '../features/notes/RetranscribeButton';
import { WordLevelBadge } from '../features/transcript';
import { WordHighlight, findActiveWord } from '../features/transcript/WordHighlight';
import { DEFAULT_PROXY_CONFIG, LLM_SETTING_KEYS } from '@openmemo/shared';
import { ProxySettingsSection } from '../features/settings/ProxySettingsSection';
import ComponentsPage from '../features/components/ComponentsPage';
import { getPositionMs, setPositionMs, subscribePosition } from '../lib/stores/player.store';
import { useConnectionStore } from '../lib/stores/connection.store';
import { PurposeBindingsSection, mergePurposeBinding } from '../components/common/llm/PurposeBindingsSection';
import { ReadinessBanner } from '../components/common/ReadinessBanner';
import RecorderPage from '../features/recorder/RecorderPage';
import {
  copyText,
  detectBlockedCapabilities,
  isMicrophoneAvailable,
  isSecureContext,
  isSessionStorageAvailable,
} from '../lib/secure-context';
import zhLocale from '../app/i18n/locales/zh-CN.json';
import enLocale from '../app/i18n/locales/en.json';
import i18nInstance from '../app/i18n';
import ModelsPage from '../features/models/ModelsPage';
import NotesListPage from '../features/notes/NotesListPage';
import RuntimePage from '../features/runtime/RuntimePage';
import { splitEmphasis } from '../components/common/Emphasis';
import { ConnectivitySummary } from '../components/common/MockNotice';
import { useSurfaceStore, SURFACES } from '../lib/api/surfaces';

/** 直接读 locale 文件断言文案 —— 归因错误是内容问题，不是渲染问题。 */
function readLocale(_code: string): Record<string, Record<string, unknown>> {
  return zhLocale as unknown as Record<string, Record<string, unknown>>;
}
import { resolvePurpose } from '@openmemo/shared';

/* ─────────────────────────── 标签增删 ─────────────────────────── */

describe('TagEditor（标签增删）', () => {
  test('点「加标签」出现可输入的文本框', async () => {
    stubApi({});
    const r = await render(<TagEditor noteUid="n1" tags={[]} />);
    assert.equal(r.container.querySelectorAll('input').length, 0, '初始不应有输入框');

    await click(buttonByText(r.container, '加标签'));
    const input = r.container.querySelector('input');
    assert.ok(input, '点击后应出现输入框');
    assert.equal(input!.getAttribute('placeholder'), '标签名');
    r.unmount();
  });

  /**
   * ★ 这条曾经是 `{ skip: true }` 的空壳（T-133 已恢复）。
   *
   * **旧的跳过理由写错了根因，方向还是反的** —— 原文说「onChange **触发得到**、
   * 但组件不重渲染，紧接着的 keydown 处理器仍持有旧闭包」，于是后来的人一直在
   * `act` 包裹 / 让出微任务 / 真实定时器 这些"提交时机"的方向上试，全都无效。
   * 实测：**onChange 一次都没触发**（调用次数 = 0），问题根本不在提交时机。
   *
   * 真正的根因在**事件到达之前**：`vite build --ssr` 把外部依赖的 import 提升到包体顶部，
   * react-dom 于是在 `window` 还不存在时完成模块初始化（`canUseDOM=false`），
   * 文本输入被路由进 IE 的 `onpropertychange` polyfill 分支，`input`/`change` 被整段丢弃。
   * 详见 `test/host.tsx` 文件头 T-133 一节。宿主修好后这条用例**可以真的跑**。
   *
   * ⚠️ 断言必须钉到**请求真的发出去了**，不能只看输入框里有字：
   * 缺陷状态下 `input.value` 照样是新值（原生 setter 写进去的），
   * 而 `calls` 是**空数组** —— 那正是这个 bug 的形状。
   */
  test('★ 输入标签名后回车：两条请求都要真的发出去', async () => {
    const { calls } = stubApi({
      // 真实链路是两步：先建标签拿 uid，再把整张 uid 表挂到笔记上
      'POST /tags': { uid: 't9', name: '播客', color: null },
      'POST /notes/n1/tags': { ok: true },
    });
    const r = await render(<TagEditor noteUid="n1" tags={[]} />);

    await click(buttonByText(r.container, '加标签'));
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

  test('Esc 关闭输入框且不发任何请求 —— 误触不该产生副作用', async () => {
    const { calls } = stubApi({});
    const r = await render(<TagEditor noteUid="n1" tags={[]} />);

    await click(buttonByText(r.container, '加标签'));
    await pressKey(r.container.querySelector('input'), 'Escape');
    await r.flush();

    assert.equal(calls.length, 0, 'Esc 之后不应有任何请求');
    r.unmount();
  });

  test('空白标签名不发请求（直接回车，draft 为空）', async () => {
    const { calls } = stubApi({});
    const r = await render(<TagEditor noteUid="n1" tags={[]} />);
    await click(buttonByText(r.container, '加标签'));
    await pressKey(r.container.querySelector('input'), 'Enter');
    await r.flush();
    assert.equal(calls.length, 0, '空内容不该产生请求');
    r.unmount();
  });

  test('已有标签渲染出来，点 × 发 DELETE', async () => {
    const { calls } = stubApi({ 'DELETE /notes/n1/tags/t1': { ok: true } });
    const r = await render(
      <TagEditor noteUid="n1" tags={[{ uid: 't1', name: '播客', color: null }]} />,
    );
    assert.ok(text(r.container).includes('播客'));

    const removeBtn = r.container.querySelector('button[aria-label*="播客"]');
    await click(removeBtn);
    await r.flush();

    const del = calls.find((c) => c.method === 'DELETE');
    assert.ok(del, '应发起 DELETE');
    assert.equal(del!.path, '/notes/n1/tags/t1');
    r.unmount();
  });
});

/* ─────────────────────────── 搜索输入 ─────────────────────────── */

/**
 * 读出当前 location 的探针 —— 用来断言"到底跳没跳"。
 *
 * ★ T-133：这两条用例原本**一条都没断言过 URL**。
 * 第一条名叫「回车跳转到 `/search?q=…` 并对查询串做 URL 编码」，实际只断言了
 * `input.value` 还在（原注释：「MemoryRouter 下用 location 断言不方便」）；
 * 第二条名叫「空输入回车不跳转」，**整条用例一个 assert 都没有**。
 *
 * `[实测]` 把 `SearchBox` 里的 `navigate(...)` **整句删掉**，其余一字不改，
 * 这两条**照样全绿** —— 它们钉住的是零。
 * 换成下面这种断言 location 的写法，同一个变异体当场变红：
 * `AssertionError: + '/' - '/search?q=%E5%8F%8D%E5%90%91…'`。
 *
 * 「MemoryRouter 下不方便」这个前提也是错的：往树里塞一个读 `useLocation` 的探针就行。
 *
 * → 由此立的规矩：**测试的名字不构成任何证据。**
 *   名字说"跳转 + URL 编码"，断言里却连 `/search` 三个字都没出现过，
 *   而没有任何机制会发现这件事 —— 名字和断言的偏离，编译器、类型、覆盖率全都看不见。
 */
function LocationProbe() {
  const loc = useLocation();
  return <i data-probe="loc">{loc.pathname + loc.search}</i>;
}

const locOf = (c: HTMLElement): string | undefined =>
  c.querySelector('[data-probe="loc"]')?.textContent ?? undefined;

describe('SearchBox（搜索входа）', () => {
  test('★ 回车真的跳到 /search?q=…，且查询串被 URL 编码', async () => {
    stubApi({});
    const r = await render(
      <div>
        <SearchBox />
        <LocationProbe />
      </div>,
    );
    const input = r.container.querySelector('input');
    assert.equal(locOf(r.container), '/', '前提：还没跳转');

    await type(input, '反向传播 & 梯度');
    await pressKey(input, 'Enter');
    await r.flush();

    assert.equal(
      locOf(r.container),
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

    assert.equal(locOf(r.container), '/', '空白查询不该离开当前页 —— 旧用例这里一条断言都没有');
    r.unmount();
  });
});

/* ─────────────────────── 任务中心分组与动作 ─────────────────────── */

const job = (over: Partial<MergedJob> = {}): MergedJob => ({
  jobId: 'j1',
  displayName: '下载模型',
  type: 'download.model',
  state: 'running',
  step: 'downloading',
  progress: 0.42,
  completedBytes: 42,
  totalBytes: 100,
  speedBps: 1000,
  etaSeconds: 30,
  attempt: 0,
  maxAttempts: 5,
  error: null,
  transientOnly: false,
  ...over,
});

describe('JobList（任务分组与动作）', () => {
  beforeEach(() => stubApi({}));

  test('★「需要处理」排在「已完成」之前 —— 需要用户动手的一类不能埋底下', async () => {
    const r = await render(
      <JobList
        jobs={[
          job({ jobId: 'done1', state: 'succeeded', displayName: '已完成任务' }),
          job({ jobId: 'blk1', state: 'blocked', displayName: '被阻塞任务' }),
        ]}
      />,
    );
    const t = text(r.container);
    assert.ok(t.includes('需要处理'), '应有「需要处理」分组');
    assert.ok(t.includes('已完成'), '应有「已完成」分组');
    assert.ok(
      t.indexOf('需要处理') < t.indexOf('已完成'),
      '「需要处理」必须排在「已完成」之前',
    );
    r.unmount();
  });

  test('running 显示暂停与取消；blocked 显示重试', async () => {
    const r1 = await render(<JobList jobs={[job({ state: 'running' })]} />);
    assert.ok(buttonByText(r1.container, '暂停'), 'running 应有暂停');
    assert.ok(buttonByText(r1.container, '取消'), 'running 应有取消');
    assert.ok(!buttonByText(r1.container, '重试'), 'running 不该有重试');
    r1.unmount();

    const r2 = await render(<JobList jobs={[job({ jobId: 'j2', state: 'blocked' })]} />);
    assert.ok(buttonByText(r2.container, '重试'), 'blocked 必须给可点击的修复动作');
    r2.unmount();
  });

  test('点「取消」发出 POST /jobs/:id/cancel', async () => {
    const { calls } = stubApi({ 'POST /jobs/j1/cancel': { ok: true } });
    const r = await render(<JobList jobs={[job()]} />);
    await click(buttonByText(r.container, '取消'));
    await r.flush();
    assert.ok(
      calls.some((c) => c.method === 'POST' && c.path === '/jobs/j1/cancel'),
      `期望 POST /jobs/j1/cancel，实际：${JSON.stringify(calls)}`,
    );
    r.unmount();
  });

  test('错误信息按中文 messageZh 显示，并带重试计数', async () => {
    const r = await render(
      <JobList
        jobs={[
          job({
            state: 'failed',
            attempt: 2,
            maxAttempts: 5,
            error: {
              code: 'RESOURCE_DISK_FULL',
              message: 'disk full',
              messageZh: '磁盘空间不足',
              retryable: false,
            } as MergedJob['error'],
          }),
        ]}
      />,
    );
    const t = text(r.container);
    assert.ok(t.includes('磁盘空间不足'), '应显示中文错误');
    assert.ok(t.includes('2/5'), '应显示重试计数');
    r.unmount();
  });

  test('已完成任务不显示进度条（进度条只对未完成有意义）', async () => {
    const r = await render(<JobList jobs={[job({ state: 'succeeded' })]} />);
    assert.equal(r.container.querySelectorAll('[role="progressbar"]').length, 0);
    r.unmount();
  });
});

/* ─────────────────────── 设置页 API Key 输入 ─────────────────────── */

describe('LlmSettingsSection（API Key 输入）', () => {
  const baseRoutes = {
    '/settings': {
      settings: {
        'llm.providers': [
          {
            id: 'openai',
            kind: 'openai-compatible',
            label: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
            isLocal: false,
          },
          {
            id: 'ollama',
            kind: 'openai-compatible',
            label: 'Ollama（本地）',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'qwen3:8b',
            isLocal: true,
          },
        ],
        'llm.activeProviderId': 'openai',
      },
    },
    '/secrets': {
      secrets: [],
      disclosure: {
        storage: 'plaintext-file',
        path: '/tmp/x/secrets.json',
        filePermission: '0600',
        dirPermission: '0700',
        messageZh: 'API Key 以明文保存在 /tmp/x/secrets.json（文件权限 0600）。',
        message: 'stored in plain text',
      },
    },
  };

  test('★ 明文告知用服务端下发的原文（含真实路径），不是前端硬编码', async () => {
    stubApi(baseRoutes);
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    assert.ok(
      text(r.container).includes('/tmp/x/secrets.json'),
      '必须显示服务端给的真实路径 —— 前端猜路径必然说错',
    );
    r.unmount();
  });

  test('★ 本地 provider 不显示 Key 输入框（绝不逼用户为 Ollama 编假 key）', async () => {
    stubApi(baseRoutes);
    const r = await render(<LlmSettingsSection />);
    await r.flush();

    const rows = Array.from(r.container.querySelectorAll('li'));
    const ollamaRow = rows.find((li) => (li.textContent ?? '').includes('Ollama'));
    assert.ok(ollamaRow, '应渲染出 Ollama 那一行');

    await click(Array.from(ollamaRow!.querySelectorAll('button')).find((b) => b.textContent?.includes('编辑')) ?? null);
    await r.flush();
    assert.equal(
      ollamaRow!.querySelectorAll('input[type="password"]').length,
      0,
      '本地 provider 不该出现 Key 输入框',
    );
    r.unmount();
  });

  test('★ 云 provider 有 Key 输入框，且是 password 类型（不明文回显）', async () => {
    stubApi(baseRoutes);
    const r = await render(<LlmSettingsSection />);
    await r.flush();

    const rows = Array.from(r.container.querySelectorAll('li'));
    const openaiRow = rows.find((li) => (li.textContent ?? '').includes('OpenAI'));
    await click(
      Array.from(openaiRow!.querySelectorAll('button')).find((b) => b.textContent?.includes('编辑')) ??
        null,
    );
    await r.flush();

    const keyInput = openaiRow!.querySelector('input[type="password"]');
    assert.ok(keyInput, '云 provider 必须有 Key 输入框');
    assert.equal(
      keyInput!.getAttribute('autocomplete'),
      'off',
      'Key 输入框必须关掉自动填充，否则浏览器会把它存进密码管理器',
    );
    r.unmount();
  });

  /**
   * ★ 这条也曾经是 `{ skip: true }` 的空壳（T-133 已恢复），根因同 TagEditor 那条。
   *
   * 值得单独说一句它为什么重要：这是**用户的 API Key 唯一的写入路径**。
   * 它被 skip 掉的这段时间里，"填了 Key 点确定"这个动作
   * **在任何自动化里都没有被走过一次** —— 包括"Key 有没有被 trim 掉"、
   * "有没有发到对的 secret 键名"这些错了就直接导致用户配不通的细节。
   */
  test('★ 填入 Key 后保存：真的 PUT /secrets/llm.<id>.apiKey，且请求体是原样的 key', async () => {
    const { calls } = stubApi({
      ...baseRoutes,
      'PATCH /settings': { ok: true },
      'PUT /secrets/llm.openai.apiKey': { ok: true },
    });
    const r = await render(<LlmSettingsSection />);
    await r.flush();

    const openaiRow = Array.from(r.container.querySelectorAll('li')).find((li) =>
      (li.textContent ?? '').includes('OpenAI'),
    );
    await click(
      Array.from(openaiRow!.querySelectorAll('button')).find((b) => b.textContent?.includes('编辑')) ??
        null,
    );
    await r.flush();

    const keyInput = openaiRow!.querySelector('input[type="password"]');
    assert.ok(keyInput, '前提：云 provider 要有 Key 输入框');

    await type(keyInput, 'sk-test-12345');
    await click(r.container.querySelector('[data-testid="llm-save"]'));
    await r.flush();

    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put, `应发出 PUT，实际写请求：${JSON.stringify(calls.filter((c) => c.method !== 'GET'))}`);
    assert.equal(put!.path, '/secrets/llm.openai.apiKey');
    assert.deepEqual(put!.body, { value: 'sk-test-12345' }, 'Key 要原样写进去');
    r.unmount();
  });

  test('★ 不填 Key 直接保存：不许发 PUT，也不许发 DELETE（别把已有的 Key 删了）', async () => {
    const { calls } = stubApi({ ...baseRoutes, 'PATCH /settings': { ok: true } });
    const r = await render(<LlmSettingsSection />);
    await r.flush();

    const openaiRow = Array.from(r.container.querySelectorAll('li')).find((li) =>
      (li.textContent ?? '').includes('OpenAI'),
    );
    await click(
      Array.from(openaiRow!.querySelectorAll('button')).find((b) => b.textContent?.includes('编辑')) ??
        null,
    );
    await r.flush();
    await click(r.container.querySelector('[data-testid="llm-save"]'));
    await r.flush();

    const writes = calls.filter((c) => c.method !== 'GET');
    assert.ok(
      !writes.some((c) => c.method === 'PUT' || c.method === 'DELETE'),
      `留空 = 保持原样，实际写请求：${JSON.stringify(writes)}`,
    );
    r.unmount();
  });

  test('未设置 Key 的云 provider 显示「未设置 Key」提示', async () => {
    stubApi(baseRoutes);
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    assert.ok(text(r.container).includes('未设置 Key'));
    r.unmount();
  });
});

/* ─────────── 用户实测事故回归（T-074）─────────── */

describe('局部失败不塌 + 错误信息可用', () => {
  test('★ 面板内抛异常只坏那一块，兄弟面板照常渲染', async () => {
    stubApi({});
    const Boom = (): never => {
      throw new Error('故意炸给你看');
    };
    const r = await render(
      <div>
        <PanelBoundary name="左栏">
          <Boom />
        </PanelBoundary>
        <p>右栏还活着</p>
      </div>,
    );
    const t = text(r.container);
    assert.ok(t.includes('右栏还活着'), '兄弟面板必须不受影响');
    assert.ok(t.includes('「左栏」加载失败'), '要说清是哪一块坏了');
    assert.ok(t.includes('故意炸给你看'), '要显示真实 message，而不是"未知错误"');
    assert.ok(buttonByText(r.container, '重试'), '必须给可点的动作');
    r.unmount();
  });

  test('★ 未知错误不再吞掉 message —— "发生了未知错误"是最没用的一句话', () => {
    const t = ((k: string, o?: { defaultValue?: string }) =>
      o && 'defaultValue' in o ? (o.defaultValue as string) : k) as never;
    const out = resolveErrorText(new Error('ompk: magic 不匹配'), t, 'zh-CN');
    assert.equal(out.title, 'ompk: magic 不匹配');
  });

  test('★ 401 走认证文案，并告诉用户不必重开浏览器', () => {
    const zh: Record<string, string> = {
      'errors.UNAUTHENTICATED.title': '与本地服务的连接已失效',
      'errors.UNAUTHENTICATED.detail': '通常是本地服务重启过。点「重新连接」即可，无需重开浏览器。',
      'errors.UNAUTHENTICATED.action': '重新连接',
    };
    const t = ((k: string, o?: { defaultValue?: string }) =>
      zh[k] ?? (o && 'defaultValue' in o ? (o.defaultValue as string) : '')) as never;
    const err = new ApiError(401, { code: 'UNAUTHENTICATED', message: 'no credentials' });
    const out = resolveErrorText(err, t, 'zh-CN');
    assert.match(out.title, /连接已失效/);
    assert.match(out.detail, /无需重开浏览器/);
    assert.equal(out.action, '重新连接');
  });
});

/* ────────────── 端点级回落（真浏览器"点了没用"事故回归）────────────── */

describe('一条缺失路由不能毒化整个面', () => {
  /**
   * 真浏览器实测：星标/标签/段落编辑「渲染是绿的，点了没用，抓包一个非 GET 都没有」，
   * 而 daemon 侧这三个端点直连全部 200。
   *
   * 根因：`PATCH /notes/:uid/mindmap` 不存在 → 一个 404 → **整个 notes 面被标成 mock**
   * → 之后该面所有调用直接走内存实现、不发网络请求。
   * 这两条用例把"按端点记账"和"写不回落"两个不变量锁住。
   */
  test('★ 一个 404 之后，同面的其它写操作仍然真的发出请求', async () => {
    const { calls } = stubApi({
      'DELETE /notes/n1/tags/t1': { ok: true },
      // 故意不打桩 /notes/n1/mindmap → 触发 404
    });

    // 先制造一次 404（模拟导图保存打到不存在的路由）
    await api('notes', '/notes/n1/mindmap', { method: 'PATCH', body: {} }).catch(() => {});

    // 同一个面的另一个端点必须照常发出真实请求
    const r = await render(
      <TagEditor noteUid="n1" tags={[{ uid: 't1', name: '播客', color: null }]} />,
    );
    await click(r.container.querySelector('button[aria-label*="播客"]'));
    await r.flush();

    assert.ok(
      calls.some((c) => c.method === 'DELETE' && c.path === '/notes/n1/tags/t1'),
      `404 不应牵连同面其它端点，实际调用：${JSON.stringify(calls.map((c) => `${c.method} ${c.path}`))}`,
    );
    r.unmount();
  });

  test('★ 写操作遇到不存在的路由必须抛错，绝不静默"成功"', async () => {
    stubApi({}); // 全部未打桩 → 一律 404
    await assert.rejects(
      () => api('notes', '/notes/n1/star', { method: 'PUT', body: { starred: true } }),
      '写操作回落 mock 会让用户以为保存了，比报错糟得多',
    );
  });
});

/* ────────────────── 服务端坏数据的防御（真浏览器事故回归）────────────────── */

describe('服务端数组缺失时不崩溃', () => {
  /**
   * 真浏览器实测里，服务端在没有标签时回的是 `tags: undefined` 而不是 `[]`，
   * `n.tags.map(...)` 直接让**笔记详情整页崩溃**，连带挡住 6 项待验交互。
   * 契约侧要修，但前端也必须兜住 —— 这条用例把"兜住"固化下来。
   */
  test('★ TagEditor 收到 undefined 也要正常渲染，不能整页炸', async () => {
    stubApi({});
    const r = await render(
      <TagEditor noteUid="n1" tags={undefined as unknown as never} />,
    );
    assert.ok(buttonByText(r.container, '加标签'), '应正常渲染出「加标签」入口');
    r.unmount();
  });

  test('arr() 对各种非数组输入都回退为空数组，且引用稳定', async () => {
    assert.deepEqual([...arr(undefined)], []);
    assert.deepEqual([...arr(null)], []);
    assert.deepEqual([...arr('nope' as unknown as never[])], []);
    assert.deepEqual([...arr({} as unknown as never[])], []);
    // 引用稳定：每次返回新 [] 会让 useMemo/依赖数组失效，甚至引发重渲染循环
    assert.strictEqual(arr(undefined), arr(null));
    assert.deepEqual([...arr([1, 2])], [1, 2]);
  });
});

/* ─────────────────────── 状态呈现的 a11y 不变量 ─────────────────────── */

describe('状态呈现', () => {
  test('★ StatusChip 永远同时给出图标与文字 —— 状态绝不只用颜色', async () => {
    stubApi({});
    const r = await render(<StatusChip tone="warning" label="需要处理" />);
    assert.ok(text(r.container).includes('需要处理'), '必须有文字标签');
    assert.ok(r.container.querySelector('svg'), '必须有图标');
    r.unmount();
  });

  test('ProgressMeter 暴露 role=progressbar 与 aria 值', async () => {
    stubApi({});
    const r = await render(<ProgressMeter value={0.37} label="下载中" />);
    const bar = r.container.querySelector('[role="progressbar"]');
    assert.ok(bar);
    assert.equal(bar!.getAttribute('aria-valuenow'), '37');
    assert.equal(bar!.getAttribute('aria-label'), '下载中');
    r.unmount();
  });

  test('ProgressMeter 夹紧越界值，不产出 aria-valuenow=-20 这种', async () => {
    stubApi({});
    const r1 = await render(<ProgressMeter value={-0.2} label="x" />);
    assert.equal(r1.container.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow'), '0');
    r1.unmount();
    const r2 = await render(<ProgressMeter value={5} label="x" />);
    assert.equal(r2.container.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow'), '100');
    r2.unmount();
  });
});

/* ───────────────── 引擎 / 模型 / 语言：选中的值必须真发出去 ───────────────── */

/**
 * T-075 的回归钉子。
 *
 * 原来的 `RecorderPage` 有一个 `useState<'paraformer' | 'turbo'>` 的引擎切换器，
 * 三重假：列表写死（装再多模型也不变）、`'turbo'` 后端不存在、**选中的值从不发送**。
 * 用户看到的是"识别引擎只有两个可选"。
 *
 * 这一组测试钉住的不是某个像素，而是这条规则本身：
 * **UI 里能选的东西，要么真的进请求体，要么就别画成可选。**
 */
describe('转写选项：选中的值真的发给后端', () => {
  test('★ 引擎标识来自 shared 联合，"turbo" 不是合法引擎', () => {
    assert.ok(!(ASR_ENGINE_IDS as readonly string[]).includes('turbo'), '"turbo" 是模型名片段，不是引擎 id');
    assert.deepEqual([...ASR_ENGINE_IDS], ['whisper.cpp', 'paraformer', 'sherpa-onnx']);
    // 展示名的键就是联合本身 —— 编不出后端没有的引擎
    for (const id of ASR_ENGINE_IDS) assert.ok(ASR_ENGINE_LABELS[id], `${id} 缺展示名`);
  });

  test('★ 语言校验与 daemon 正则一致 —— 非法值在后端会被静默改成 auto，所以前端必须先说', () => {
    for (const ok of ['auto', 'zh', 'en', 'yue', 'zh-Hans', 'pt-BR']) {
      assert.ok(isValidAsrLanguage(ok), `${ok} 应合法`);
    }
    for (const bad of ['', 'Chinese', '中文', 'zh_CN', 'z', 'auto-detect']) {
      assert.ok(!isValidAsrLanguage(bad), `${bad} 应判为非法`);
    }
  });

  test('★ 导入时 language 必须进请求体（这是本轮修的核心断链）', async () => {
    const { calls } = stubApi({
      'POST /notes/import': { noteUid: 'n1', jobUid: 'j1', status: 'queued' },
    });

    function Harness() {
      const m = useImportUrlMutation();
      return (
        <button onClick={() => m.mutate({ url: 'https://example.com/a.mp4', language: 'zh' })}>
          go
        </button>
      );
    }
    const r = await render(<Harness />);
    await click(buttonByText(r.container, 'go'));
    await r.flush();

    const post = calls.find((c) => c.method === 'POST' && c.path === '/notes/import');
    assert.ok(post, '应发出 import 请求');
    assert.deepEqual(post!.body, { input: 'https://example.com/a.mp4', language: 'zh' });
    r.unmount();
  });

  test('语言为空时不发 language 键 —— 空串会被 daemon 当成"用户指定了空语言"存起来', async () => {
    const { calls } = stubApi({
      'POST /notes/import': { noteUid: 'n1', jobUid: 'j1', status: 'queued' },
    });
    function Harness() {
      const m = useImportUrlMutation();
      return <button onClick={() => m.mutate({ url: 'https://e.com/a.mp4' })}>go</button>;
    }
    const r = await render(<Harness />);
    await click(buttonByText(r.container, 'go'));
    await r.flush();
    const post = calls.find((c) => c.path === '/notes/import');
    assert.ok(post && !('language' in (post.body as object)), '不该出现 language 键');
    r.unmount();
  });

  test('★ 没装 ASR 模型时给"去安装"，而不是一个空下拉框', async () => {
    stubApi({ 'GET /models/installed': { models: [], active: { asr: null } } });
    const r = await render(<AsrModelPicker />);
    await r.flush();
    assert.equal(r.container.querySelector('select'), null, '没模型就不该有下拉框');
    assert.ok(text(r.container).includes('去安装模型'), '应给出安装入口');
    r.unmount();
  });

  test('★ 模型列表来自后端，且只列 role=asr 的已装模型', async () => {
    stubApi({
      'GET /models/installed': {
        models: [
          { id: 'asr/a', role: 'asr', displayName: 'Whisper A', quantization: 'q5_0', integrity: 'ok' },
          { id: 'llm/b', role: 'llm', displayName: '不该出现的 LLM', integrity: 'ok' },
          { id: 'asr/c', role: 'asr', displayName: 'Paraformer C', quantization: null, integrity: 'ok' },
        ],
        active: { asr: 'asr/c' },
      },
    });
    const r = await render(<AsrModelPicker />);
    await r.flush();

    const opts = [...r.container.querySelectorAll('option')].map((o) => o.textContent ?? '');
    assert.equal(opts.length, 2, `应只有两个 ASR 选项，实际 ${JSON.stringify(opts)}`);
    assert.ok(opts.some((o) => o.includes('Whisper A')));
    assert.ok(!opts.some((o) => o.includes('LLM')), 'LLM 不该混进识别模型列表');
    assert.equal(r.container.querySelector('select')!.value, 'asr/c', '应选中后端的 active');
    r.unmount();
  });

  test('★ 引擎可用性来自 daemon 实测；后端没给的引擎不显示，认不出的 id 丢弃', async () => {
    stubApi({
      // 实测：daemon 只列构造成功的候选，缺席的引擎压根不出现
      'GET /health': {
        pipeline: {
          engines: [
            { id: 'whisper.cpp', available: true },
            { id: 'paraformer', available: false, reason: '未设置 OPENMEMO_PARAFORMER_DIR' },
            { id: 'turbo', available: true },
          ],
        },
      },
    });
    const r = await render(<AsrEngineStatus />);
    await r.flush();
    const shown = text(r.container);

    assert.ok(shown.includes('Whisper.cpp'));
    assert.ok(shown.includes('Paraformer'));
    assert.ok(!shown.includes('turbo'), '认不出的引擎 id 应被丢弃，不能照抄进 UI');
    // 用不了的要说原因 + 给出路，而不是灰掉了事
    assert.ok(shown.includes('OPENMEMO_PARAFORMER_DIR'), '应展示 daemon 给的真实原因');
    assert.ok(shown.includes('去安装运行时'));
    r.unmount();
  });

  test('★ daemon 没报告的引擎要显示为"未安装"并给安装入口，而不是当它不存在', async () => {
    // 实测 demo 上就是这样：engines 只有 whisper.cpp 一条
    stubApi({ 'GET /health': { pipeline: { engines: [{ id: 'whisper.cpp', available: true }] } } });
    const r = await render(<AsrEngineStatus />);
    await r.flush();
    const shown = text(r.container);

    // 全集来自 shared 联合，不是 daemon 返回什么就只显示什么
    assert.ok(shown.includes('Paraformer'), '缺席的引擎也要露出来，否则用户不知道它存在');
    assert.ok(shown.includes('Sherpa-ONNX'));
    assert.ok(shown.includes('去安装运行时'), '没装的要给出路，而不是灰掉或隐藏');
    r.unmount();
  });
});

/* ─────────────────────────── 数据位置 ─────────────────────────── */

/**
 * 路径是**要念给用户听**的东西，念错比不念更糟 ——
 * 用户会照着去 `rm -rf` 一个不是数据目录的地方。
 * 所以这一组钉的是：路径只能来自 daemon，拿不到就说拿不到。
 */
describe('设置 · 数据位置', () => {
  test('★ 数据目录路径来自 daemon 的 /health，不是前端拼的默认值', async () => {
    stubApi({
      'GET /health': { dataDir: '/tmp/omdemo' },
      'GET /models/storage': {
        modelsRoot: '/tmp/omdemo/models',
        volume: { freeBytes: 10_000_000_000, totalBytes: 50_000_000_000 },
        usedBytes: 1_500_000_000,
        breakdown: [],
        reclaimable: { orphanBlobsBytes: 0, stalePartialsBytes: 0, inactiveModelsBytes: 0 },
      },
    });
    const r = await render(<DataLocationSection />);
    await r.flush();

    assert.equal(r.container.querySelector('[data-testid="data-dir-path"]')?.textContent, '/tmp/omdemo');
    // 容量分项要出现，且是模型占用而不是含糊的"总计"
    assert.ok(text(r.container).includes('模型占用'));
    assert.ok(text(r.container).includes('1.5 GB'), '应换算成人类可读单位');
    r.unmount();
  });

  /*
   * ★ T-128：daemon 报了"链接失效"，界面就必须显示出来。
   *
   * 钉的是本项目反复出现的那个形状 —— **后端返回了，前端没读**：
   * `build` 字段后端给了、前端逐字段手抄时漏掉，界面写着"构建信息未知"；
   * `job.blocked` 的 toast 接收方一直在等一个从来没人发的事件。
   * 移动数据目录这条更要紧：它是修复本身的唯一出口，不显示就等于没修 ——
   * 用户看到的依然是一句"移动成功"，而转写已经不能用了。
   *
   * ⚠️ 这里**直接渲染 `StaleLinksWarning`**，而不是"打开表单→输路径→点应用"。
   * 原因是宿主驱动不了受控文本输入框（`fireEvent.change`/`input` 都到不了 React 的
   * onChange，state 恒为空 —— 已实测确认，见 inbox）。整条点击链路改为对
   * **真 daemon 发真 HTTP** 验证（响应确实带 warningZh + staleLinks），
   * 两边合起来才算真的验过；只做其中一边我都不会说它通了。
   */
  test('★ 有失效链接时：警告文案与具体是哪几条都要渲染出来', async () => {
    const r = await render(
      <StaleLinksWarning
        warningZh="数据已全部移动到新位置，但有 1 个符号链接仍指向旧位置，旧位置删除后它们会失效。"
        staleLinks={[{ rel: 'models/libx.so', target: '/old/models/libx.so.1' }]}
      />,
    );
    const warn = r.container.querySelector<HTMLElement>('[data-testid="data-dir-stale-links"]');
    assert.ok(warn, '警告块没有渲染 —— daemon 报了链接失效而界面只说"移动成功"');
    assert.ok(text(warn).includes('仍指向旧位置'), `实际文案: ${text(warn)}`);
    // 只给一句概括不够：用户要知道是哪一条，否则不知道该重装哪个后端
    assert.ok(text(warn).includes('models/libx.so'), '必须列出具体是哪条链接');
    assert.ok(text(warn).includes('/old/models/libx.so.1'), '要显示它指向了哪里');
    r.unmount();
  });

  test('链接很多时折叠成计数，不把整页刷满（但不能把"还有多少条"藏掉）', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      rel: `models/lib${i}.so`,
      target: `/old/lib${i}.so.1`,
    }));
    const r = await render(<StaleLinksWarning warningZh="8 个链接失效" staleLinks={many} />);
    const shown = text(r.container);
    assert.ok(shown.includes('models/lib0.so') && shown.includes('models/lib4.so'));
    assert.ok(!shown.includes('models/lib5.so'), '超出 5 条应折叠');
    assert.ok(shown.includes('共 8 条'), '折叠了也必须说清一共多少条');
    r.unmount();
  });

  /**
   * 上面那条证明"组件会显示"，这条证明"它真的被接上了"。
   * 两者缺一不可 —— 本项目出过的正是"组件写好了但没人渲染它"这一类。
   */
  test('★ DataLocationSection 确实把 daemon 的 warningZh 接进了这个组件', async () => {
    const src = await readSource('features/settings/DataLocationSection.tsx');
    assert.match(src, /changeDir\.data\?\.warningZh/, 'mutation 的返回没有被读取');
    assert.match(src, /<StaleLinksWarning/, '警告组件没有被渲染');
    assert.match(src, /staleLinks: changeDir\.data\.staleLinks/, '具体链接列表没有传下去');
  });

  test('★ 拿不到 dataDir 时绝不编一个"看起来对"的路径', async () => {
    stubApi({}); // /health 未打桩 → 404
    const r = await render(<DataLocationSection />);
    await r.flush();
    const shown = r.container.querySelector('[data-testid="data-dir-path"]')?.textContent ?? '';
    assert.ok(!shown.includes('/'), `不该出现任何猜测路径，实际渲染了 ${JSON.stringify(shown)}`);
    r.unmount();
  });

  test('★ 明确告知"删掉这个目录不会弄坏程序"，但同时说清丢什么', async () => {
    stubApi({ 'GET /health': { dataDir: '/tmp/omdemo' } });
    const r = await render(<DataLocationSection />);
    await r.flush();
    const shown = text(r.container);
    assert.ok(shown.includes('不会影响程序运行'), '实测结论要写进 UI');
    assert.ok(shown.includes('自动重建'));
    // 只说"安全"是半句真话 —— 代价必须同时出现
    assert.ok(shown.includes('丢失'), '必须同时说明笔记与模型会丢失');
    r.unmount();
  });
});

/* ─────────────────────────── 重新转写 ─────────────────────────── */

/**
 * 这是"中文被翻译成英文"那个灾难的**唯一补救通道**。
 * 端点一直在，只是没有路 —— 所以这里钉的第一条就是"点得到、且语言真的发出去"。
 */
describe('重新转写入口', () => {
  const noEdits = [{ seq: 1, text: 'a', edited: false }];

  test('★ 语言真的进请求体 —— 否则这个入口等于没补', async () => {
    const { calls } = stubApi({
      'POST /notes/n1/retranscribe': { jobUid: 'j9', noteUid: 'n1' },
      'GET /models/installed': { models: [], active: { asr: null } },
    });
    const r = await render(
      <RetranscribeButton noteUid="n1" segments={noEdits} currentLanguage="en" />,
    );
    await click(r.container.querySelector('[data-testid="retranscribe-open"]'));
    await click(r.container.querySelector('[data-testid="retranscribe-submit"]'));
    await r.flush();

    const post = calls.find((c) => c.path === '/notes/n1/retranscribe');
    assert.ok(post, '应发出 retranscribe 请求');
    // 默认带上转写稿当前语言（用户来这儿就是因为它判错了，得让他看见并能改）
    assert.deepEqual(post!.body, { language: 'en' });
    r.unmount();
  });

  /**
   * 这条用例**改写过**（T-082 → T-084），保留在这里是有意的。
   *
   * 原来它断言的是"你编辑过的 N 段**会被覆盖**" —— 当时属实：REST 重跑不传
   * `mergeWithTranscriptId`，合并分支整段跳过。后端补上并实测连跑两次编辑仍在之后，
   * 那句警告就从"诚实"变成了"吓唬人"，断言必须跟着翻面。
   *
   * 没有删掉它，是因为**计数准确性**与措辞是两件事：3 段里编辑过 2 段就得报 2，
   * 报错了的话，说"保留"还是说"覆盖"都一样没意义。
   */
  test('★ 编辑段数要报准 —— 3 段里编辑过 2 段就是 2', async () => {
    stubApi({ 'GET /models/installed': { models: [], active: { asr: null } } });
    const r = await render(
      <RetranscribeButton
        noteUid="n1"
        segments={[
          { seq: 1, text: 'a', editedAt: 1 },
          { seq: 2, text: 'b', editedAt: 2 },
          { seq: 3, text: 'c', editedAt: null },
        ]}
        currentLanguage="zh"
      />,
    );
    await click(r.container.querySelector('[data-testid="retranscribe-open"]'));
    await r.flush();
    const shown = text(r.container);
    assert.ok(shown.includes('已保留你编辑过的 2 段'), `应准确报出 2 段，实际：${shown.slice(0, 200)}`);
    assert.ok(!shown.includes('会被覆盖'), '后端已能保留，事前警告必须撤掉');
    r.unmount();
  });

  test('没有编辑过就不弹警告，别制造无谓的恐慌', async () => {
    stubApi({ 'GET /models/installed': { models: [], active: { asr: null } } });
    const r = await render(
      <RetranscribeButton noteUid="n1" segments={noEdits} currentLanguage="zh" />,
    );
    await click(r.container.querySelector('[data-testid="retranscribe-open"]'));
    await r.flush();
    assert.ok(!text(r.container).includes('会被覆盖'));
    r.unmount();
  });

  test('★ 两条通道的"编辑过"字段名不同，必须都认', () => {
    // REST 发 edited:boolean，SSE 增量发 editedAt:number|null —— 只认一个就会静默失效
    assert.equal(isSegmentEdited({ edited: true }), true, 'REST 形状');
    assert.equal(isSegmentEdited({ edited: false }), false);
    assert.equal(isSegmentEdited({ editedAt: 1_700_000_000_000 }), true, 'SSE 形状');
    assert.equal(isSegmentEdited({ editedAt: null }), false);
    assert.equal(isSegmentEdited({}), false, '两个都没有时不能瞎猜成 true');
  });

  test('★ 409 NO_SOURCE_INPUT 要说人话，而不是抛一个原始错误', async () => {
    stubApi({
      'GET /models/installed': { models: [], active: { asr: null } },
      // 真的返回一个 409 信封，让 client.ts 自己解析成 ApiError ——
      // 手工 new 一个 ApiError 只会测到我自己的构造函数，测不到解析链路
      'POST /notes/n1/retranscribe': () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'NO_SOURCE_INPUT',
              message: 'note has no recorded source input',
              messageZh: '这条笔记没有记录原始输入，无法重跑',
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    });
    const r = await render(
      <RetranscribeButton noteUid="n1" segments={noEdits} currentLanguage="zh" />,
    );
    await click(r.container.querySelector('[data-testid="retranscribe-open"]'));
    await click(r.container.querySelector('[data-testid="retranscribe-submit"]'));
    await r.flush();
    assert.ok(
      text(r.container).includes('没有记录原始输入'),
      '应给出可读解释，说明什么情况下才能重跑',
    );
    r.unmount();
  });
});

/* ──────────────── 逐字高亮 + 重跑保留编辑（T-084） ──────────────── */

/**
 * 这一组钉的是两个**互相掩护**的 bug：
 * `words` 后端没发 → 降级徽标恒亮；而即使发了，前端也没有按词渲染的代码。
 * 任何一个单独修好都看不出变化，所以两个都得有测试压着。
 */
describe('逐字高亮', () => {
  const W = [
    { w: 'Hello', s: 0, e: 500, p: 0.9 },
    { w: ' world', s: 500, e: 1000, p: 0.9 },
  ];

  test('★ 有 words 时降级徽标必须消失 —— 之前它恒亮，用户从没见过词级高亮', async () => {
    const r = await render(
      <WordLevelBadge
        segments={[{ seq: 1, startMs: 0, endMs: 1000, text: 'Hello world', words: W }] as never}
      />,
    );
    assert.equal(text(r.container).trim(), '', '有词级时间戳就不该显示降级提示');
    r.unmount();
  });

  test('★ words 为 null（中文 Paraformer）时降级徽标要亮 —— 这个降级得留着', async () => {
    const r = await render(
      <WordLevelBadge
        segments={[{ seq: 1, startMs: 0, endMs: 1000, text: '你好世界', words: null }] as never}
      />,
    );
    assert.ok(text(r.container).length > 0, 'Paraformer 路径必须说明为何不能逐字高亮');
    r.unmount();
  });

  test('★ 按词切分渲染，播放位置落在哪个词就高亮哪个', () => {
    assert.equal(findActiveWord(W, 0), 0);
    assert.equal(findActiveWord(W, 499), 0);
    assert.equal(findActiveWord(W, 500), 1, '边界归属后一个词，避免两个同时亮');
    assert.equal(findActiveWord(W, 999), 1);
  });

  test('★ 落在词与词之间的静音里不吸附 —— 换气处不该有词滞留高亮', () => {
    const gapped = [
      { w: 'a', s: 0, e: 100, p: 1 },
      { w: 'b', s: 900, e: 1000, p: 1 },
    ];
    assert.equal(findActiveWord(gapped, 500), -1);
    assert.equal(findActiveWord(gapped, 1500), -1, '播完之后也不该有词亮着');
  });

  test('有 words 就逐词出 span；没有就整句一个节点', async () => {
    const r = await render(<WordHighlight words={W} fallbackText="Hello world" />);
    const host = r.container.querySelector('[data-testid="word-highlight"]');
    assert.ok(host, '应进入逐字渲染分支');
    assert.equal(host!.querySelectorAll('span').length, 2, '两个词应各自成 span');
    // 拼回去必须和原句一致，否则用户看到的文本被渲染逻辑改写了
    assert.equal(host!.textContent, 'Hello world');
    r.unmount();

    const r2 = await render(<WordHighlight words={null} fallbackText="你好世界" />);
    assert.equal(r2.container.querySelector('[data-testid="word-highlight"]'), null);
    assert.equal(text(r2.container), '你好世界');
    r2.unmount();
  });
});

describe('重跑保留编辑（换回「已保留」）', () => {
  const edited = [
    { seq: 1, text: 'a', editedAt: 1_785_700_531_018 },
    { seq: 2, text: 'b', editedAt: null },
  ];

  test('★ 现在说「已保留」，不再说「会被覆盖」—— 后端实测连跑两次 editedAt 都还在', async () => {
    stubApi({ 'GET /models/installed': { models: [], active: { asr: null } } });
    const r = await render(
      <RetranscribeButton noteUid="n1" segments={edited} currentLanguage="zh" />,
    );
    await click(r.container.querySelector('[data-testid="retranscribe-open"]'));
    await r.flush();
    const shown = text(r.container);
    assert.ok(shown.includes('已保留你编辑过的 1 段'), `实际：${shown.slice(0, 200)}`);
    assert.ok(!shown.includes('会被覆盖'), '事前警告必须撤掉，否则是在吓唬用户');
    r.unmount();
  });

  test('★ editedAt 是权威判据（不是文本比对）—— 它丢了会在第二次重跑才暴露', () => {
    assert.equal(isSegmentEdited({ editedAt: 1_785_700_531_018 }), true);
    assert.equal(isSegmentEdited({ editedAt: null }), false);
    // 旧形状仍认，缓存里可能残留
    assert.equal(isSegmentEdited({ edited: true }), true);
    assert.equal(isSegmentEdited({}), false);
  });

  test('★ canRetranscribe=false 时按钮事前禁用并说明原因', async () => {
    stubApi({});
    const r = await render(
      <RetranscribeButton noteUid="n1" segments={[]} currentLanguage="zh" canRetranscribe={false} />,
    );
    const btn = r.container.querySelector('[data-testid="retranscribe-open"]') as HTMLButtonElement;
    assert.equal(btn.disabled, true);
    assert.ok((btn.getAttribute('title') ?? '').includes('没有记录原始输入'), '禁用要自带解释');
    r.unmount();
  });

  test('★ canRetranscribe 缺失要当成「可以」—— 字段不在不等于不能重跑', async () => {
    stubApi({});
    const r = await render(<RetranscribeButton noteUid="n1" segments={[]} currentLanguage="zh" />);
    const btn = r.container.querySelector('[data-testid="retranscribe-open"]') as HTMLButtonElement;
    assert.equal(btn.disabled, false, '老响应不带这个键，不能把功能藏起来');
    r.unmount();
  });
});

/* ──────────── 零宽词：每段第一个词永远不亮（T-086 ①） ──────────── */

/**
 * 真浏览器实测暴露的：25 个真实词级时间戳里高亮只经过 9 个，
 * 第 0 个 `' And'` 的时间戳是 **`220-220`** —— 零宽。
 * 半开区间 `[s, e)` 在 `s === e` 时是空集，`pos >= 220 && pos < 220` 恒为 false。
 * 这不是"边界差一毫秒"，是**整类词从来不亮**，而且专挑段首。
 */
describe('零宽词兜底', () => {
  test('★ 段首零宽词必须能亮 —— 修的就是"每段第一个词永远不高亮"', () => {
    const words = [
      { w: ' And', s: 220, e: 220, p: 1 },
      { w: ' so', s: 533, e: 700, p: 1 },
    ];
    assert.equal(findActiveWord(words, 220), 0, '零宽词在其起点必须亮');
    assert.equal(findActiveWord(words, 260), 0, '最小显示时长内仍亮');
    assert.equal(findActiveWord(words, 533), 1, '下一个词照常接管');
  });

  test('★ 末尾零宽词同样要修 —— 没有后继词也不能恒不亮', () => {
    const words = [
      { w: 'a', s: 0, e: 100, p: 1 },
      { w: ' end', s: 900, e: 900, p: 1 },
    ];
    assert.equal(findActiveWord(words, 900), 1);
    assert.equal(findActiveWord(words, 950), 1);
    assert.equal(findActiveWord(words, 1200), -1, '兜底时长过后就该熄灭，不能永久滞留');
  });

  test('★ 兜底不能抢下一个词的时间 —— 否则会出现两个词同时亮', () => {
    // 零宽词后 20ms 下一个词就开始，兜底 80ms 必须被夹到 20
    const words = [
      { w: 'x', s: 100, e: 100, p: 1 },
      { w: 'y', s: 120, e: 300, p: 1 },
    ];
    assert.equal(findActiveWord(words, 110), 0);
    assert.equal(findActiveWord(words, 120), 1, '到点必须交棒，不许并亮');
    assert.equal(findActiveWord(words, 150), 1);
  });

  test('★ 正常词的行为一个都不许改 —— 静音仍然不吸附', () => {
    const gapped = [
      { w: 'a', s: 0, e: 100, p: 1 },
      { w: 'b', s: 900, e: 1000, p: 1 },
    ];
    assert.equal(findActiveWord(gapped, 500), -1, '兜底只对零宽词生效，不许填平正常间隙');
    assert.equal(findActiveWord(gapped, 1500), -1);
    assert.equal(findActiveWord(gapped, 99), 0);
  });

  test('end 早于 start 的畸形数据也当退化处理，而不是直接不亮', () => {
    const bad = [{ w: 'z', s: 500, e: 200, p: 1 }];
    assert.equal(findActiveWord(bad, 500), 0);
    assert.equal(findActiveWord(bad, 700), -1);
  });
});

/* ─────────────────────── 代理配置（T-086 ②） ─────────────────────── */

/**
 * 用户点名的缺口 5：后端 43/43 全过，但**用户点不到**。
 * 对中文用户这是刚需 —— 没代理 HF/GitHub 下不动，
 * 而失败现象最坑：浏览器能上网，应用说"下载失败"，两者之间没有任何提示。
 */
describe('代理配置', () => {
  /*
   * ⚠️ 真实响应是**带壳**的 `{config, active, media, modes, defaultModeZh}`，
   * 而且 `config` 里的 URL 已被服务端 `redactProxyUrl()` 脱敏。
   * 这些桩最初写成了裸 `ProxyConfig` —— 是我按想当然写的，
   * 后来照 `rest/proxy.ts` 改组件时被测试直接顶出来了。桩的形状必须照抄实现。
   */
  const wrap = (config: unknown, media?: unknown) => ({
    'GET /settings/proxy': { config, active: null, media: media ?? { supported: true, reason: null, noteZh: null } },
  });
  const cfgRoute = wrap(DEFAULT_PROXY_CONFIG);

  test('★ 默认跟随系统，不是"不使用代理"', async () => {
    stubApi(cfgRoute);
    const r = await render(<ProxySettingsSection />);
    await r.flush();
    const system = r.container.querySelector('[data-testid="proxy-mode-system"]') as HTMLInputElement;
    assert.equal(system.checked, true, 'off 作默认会让最难懂的失败成为默认体验');
    r.unmount();
  });

  test('★ 测试代理与测试下载源是两个独立按钮 —— 合成一个会丢掉镜像间的比较', async () => {
    const { calls } = stubApi({
      ...cfgRoute,
      'POST /settings/proxy/test': { ok: true, proxyReachable: true, probes: [] },
      'POST /settings/proxy/sources': { measuredAt: 'now', rows: [], fastest: null },
    });
    const r = await render(<ProxySettingsSection />);
    await r.flush();

    await click(r.container.querySelector('[data-testid="proxy-test"]'));
    await r.flush();
    await click(r.container.querySelector('[data-testid="proxy-test-sources"]'));
    await r.flush();

    assert.ok(calls.some((c) => c.path === '/settings/proxy/test'), '「测试代理」应打中立主机');
    assert.ok(calls.some((c) => c.path === '/settings/proxy/sources'), '「测试下载源」应出延迟表');
    r.unmount();
  });

  test('★ "代理不通"与"代理通但目标站不可达"必须给不同结论 —— 两者指向完全不同的修法', async () => {
    stubApi({
      ...cfgRoute,
      'POST /settings/proxy/test': {
        ok: false,
        proxyReachable: true,
        probes: [
          {
            target: 'Hugging Face',
            url: 'https://huggingface.co',
            result: 'upstream_unreachable',
            viaProxy: true,
            elapsedMs: 5000,
          },
        ],
      },
    });
    const r = await render(<ProxySettingsSection />);
    await r.flush();
    await click(r.container.querySelector('[data-testid="proxy-test"]'));
    await r.flush();

    const shown = text(r.container);
    assert.ok(shown.includes('问题不在你的代理'), '代理是通的就不该让用户去查代理');
    assert.ok(shown.includes('目标站不可达'), '逐条结果也要给出来');
    assert.ok(shown.includes('经代理'), '每条探测走没走代理必须可见');
    r.unmount();
  });

  test('★ 选 SOCKS 要提示 ffmpeg 链路直连 —— 别让用户以为全走代理了', async () => {
    // media 判定由 daemon 给（ffmpegProxySupport），前端不再自己猜"填了 socks5 就降级"
    stubApi(
      wrap(
        { ...DEFAULT_PROXY_CONFIG, mode: 'manual', socks5: 'socks5://127.0.0.1:1080' },
        {
          supported: false,
          reason: 'ffmpeg does not support SOCKS',
          noteZh:
            'ffmpeg 不支持 SOCKS 代理（libavformat 只识别 http_proxy）。选择 SOCKS 时，模型下载会走代理，但**在线媒体拉流会直连**。如需媒体也走代理，请改填 HTTP 代理地址。',
        },
      ),
    );
    const r = await render(<ProxySettingsSection />);
    await r.flush();
    const shown = text(r.container);
    // 直接渲染 daemon 给的 noteZh —— 能力边界由做判定的那一方描述
    assert.ok(shown.includes('在线媒体拉流会直连'), 'SOCKS 的真实边界必须说出来');
    assert.ok(shown.includes('模型下载会走代理'), '同时要说清哪条链路仍然走代理，否则像是整个功能坏了');
    r.unmount();
  });

  test('HTTP 代理不该弹 SOCKS 警告', async () => {
    stubApi(wrap({ ...DEFAULT_PROXY_CONFIG, mode: 'manual', httpProxy: 'http://127.0.0.1:7890' }));
    const r = await render(<ProxySettingsSection />);
    await r.flush();
    assert.ok(!text(r.container).includes('在线媒体拉流会直连'));
    r.unmount();
  });

  test('★ 展示当前生效地址时必须脱敏 —— 密码不能出现在界面上', async () => {
    stubApi(
      wrap({ ...DEFAULT_PROXY_CONFIG, mode: 'manual', httpProxy: 'http://alice:hunter2@127.0.0.1:7890' }),
    );
    const r = await render(<ProxySettingsSection />);
    await r.flush();
    const eff = r.container.querySelector('[data-testid="proxy-effective"]')?.textContent ?? '';
    assert.ok(!eff.includes('hunter2'), `密码泄漏到界面：${eff}`);
    assert.ok(eff.includes('***'), '应显示脱敏占位而不是整段省略');
    r.unmount();
  });

  test('★ 端点还没上线时如实说，且不假装保存成功', async () => {
    stubApi({}); // GET 未打桩 → 404
    const r = await render(<ProxySettingsSection />);
    await r.flush();
    const shown = text(r.container);
    assert.ok(shown.includes('尚未提供代理配置接口'));
    // 表单仍可见（不藏不灰），且给出真能用的替代办法
    assert.ok(shown.includes('HTTPS_PROXY'), '应给出环境变量这条真能用的退路');
    assert.ok(r.container.querySelector('[data-testid="proxy-mode-manual"]'), '表单不该被藏起来');
    r.unmount();
  });
});

/* ────────── 位置分辨率：短词必须能亮（T-091） ────────── */

/**
 * `model-mgmt` 用 rAF 逐帧记录器实测出来的：
 * - 段首零宽词兜底窗口 `[220, 300)` 只有 80ms，从 0 起播 8 次**只亮 7 次**；
 * - 真实短词 `' for'` 只有 **60ms**（**不是**退化词，`effectiveEnd` 救不了）→ **一次都没亮过**。
 *
 * 根因不是阈值太小，是**位置值本身只有 100ms 分辨率** ——
 * `PlayerBar` 在 rAF 里节流后才写值，比采样周期短的词会被整个跳过。
 * 单纯调大 `MIN_WORD_MS` 会篡改 `' for'` 的真实时长，还是救不了它。
 */
describe('播放位置的分辨率', () => {
  test('★ 值每帧都更新 —— 这是短词能被看见的前提', () => {
    setPositionMs(1000);
    assert.equal(getPositionMs(), 1000);
    // 紧接着再写（远快于 100ms 通知周期），值必须立刻跟上而不是等节流窗口
    setPositionMs(1016);
    assert.equal(getPositionMs(), 1016, '值不该被通知节流拖住');
    setPositionMs(1032);
    assert.equal(getPositionMs(), 1032);
  });

  test('★ 通知仍然节流 —— 拆开的意义就在于只提高分辨率、不提高推送成本', () => {
    let hits = 0;
    const stop = subscribePosition(() => {
      hits += 1;
    });
    /*
     * 节流窗口是模块级状态，会跨用例残留 —— 先用 immediate 显式确立一个窗口起点，
     * 否则本用例的通过与否取决于前面几个用例跑了多久（又一个"测一次通过"的坑）。
     */
    setPositionMs(5000, { immediate: true });
    // 紧接着连写 50 帧（模拟同一个 100ms 窗口内的 rAF），不该再通知
    for (let i = 1; i <= 50; i += 1) setPositionMs(5000 + i * 16);
    stop();
    assert.equal(hits, 1, `同一窗口内应只通知 1 次，实际 ${hits} 次`);
  });

  test('★ 60ms 的真实短词在逐帧分辨率下必然被采样到', () => {
    // `' for'`：真实时长 60ms，非退化词
    const words = [
      { w: ' for', s: 9000, e: 9060, p: 1 },
      { w: ' us', s: 9200, e: 9400, p: 1 },
    ];
    // 以 16ms 步长（rAF）扫过，必须至少命中一次
    let seen = 0;
    for (let t = 8950; t < 9100; t += 16) {
      if (findActiveWord(words, t) === 0) seen += 1;
    }
    assert.ok(seen >= 3, `逐帧扫描只命中 ${seen} 次，60ms 的词应有 3 帧以上`);

    /*
     * 反面钉死：100ms 采样（旧的节流分辨率）下，命中与否**取决于相位**。
     *
     * 我第一版把它写成"必然一次都不中"，跑出来是 1 次 —— 断言错了，
     * 因为从 8950 起步恰好在 9050 落进 [9000, 9060)。
     * 真正的缺陷不是"一定miss"，而是"**能不能看见取决于起播时刻**"：
     * 这正好解释了实测里同一个词有时亮有时不亮（段首词 8 次只亮 7 次）。
     * 所以断言改成：**存在完全错过它的相位**。
     */
    const phasesThatMiss = [];
    for (let phase = 0; phase < 100; phase += 10) {
      let hit = false;
      for (let t = 8900 + phase; t < 9100; t += 100) {
        if (findActiveWord(words, t) === 0) hit = true;
      }
      if (!hit) phasesThatMiss.push(phase);
    }
    assert.ok(
      phasesThatMiss.length > 0,
      '100ms 采样下应存在完全看不见这个词的相位 —— 这就是"有时亮有时不亮"的来源',
    );
  });

  test('seek 是跳变，必须绕过节流立刻通知', () => {
    let last = -1;
    const stop = subscribePosition((ms) => {
      last = ms;
    });
    setPositionMs(2000); // 先占满一个节流窗口
    setPositionMs(30_000, { immediate: true });
    stop();
    assert.equal(last, 30_000, 'seek 后游标不该滞后到下一个窗口才跟上');
  });
});

/* ─────────────── 按用途分档 + LLM 键对齐（T-090） ─────────────── */

/**
 * ⚠️ 做这一屏时发现了一个更大的问题：**整个 LLM 配置界面是一次死写**。
 *
 * 全仓核对零重叠 —— 前端写 `llm.providers` / `llm.activeProviderId`，
 * 而 daemon 的 `resolveConfiguredProvider()` 只读
 * `llm.defaultProviderId` / `llm.defaultModelId` / `llm.purposes` / `llm.baseUrl.<id>`。
 * 用户配好 provider、填了 Key、界面显示"已启用"，而 F4 的摘要与导图一直是"未配置"。
 * 分档 UI 建在这之上，不先修等于在一个不通电的插座上加分路开关。
 */
describe('LLM 设置键必须与 daemon 对齐', () => {
  test('★ 设为默认要写 daemon 真正读的三个键 —— 少一个就解析不出 provider', async () => {
    const { calls } = stubApi({
      'GET /settings': {
        settings: {
          'llm.providers': [
            { id: 'openai', kind: 'openai-compatible', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', isLocal: false },
          ],
        },
      },
      'GET /secrets': { secrets: [], disclosure: null },
      'PATCH /settings': { settings: {} },
    });
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    await click(buttonByText(r.container, '设为默认'));
    await r.flush();

    const body = calls.find((c) => c.method === 'PATCH')?.body as Record<string, unknown>;
    assert.ok(body, '应发出 PATCH');
    assert.equal(body['llm.defaultProviderId'], 'openai', 'daemon 只认这个键，不认 activeProviderId');
    assert.equal(body['llm.defaultModelId'], 'gpt-4o-mini', '模型缺了同样解析不出 provider');
    assert.equal(body['llm.baseUrl.openai'], 'https://api.openai.com/v1');
    r.unmount();
  });
});

describe('按用途分档', () => {
  const base = {
    'llm.providers': [
      { id: 'openai', kind: 'openai-compatible', label: 'OpenAI', baseUrl: 'u', model: 'gpt-4o-mini', isLocal: false },
      { id: 'deepseek', kind: 'openai-compatible', label: 'DeepSeek', baseUrl: 'u2', model: 'deepseek-chat', isLocal: false },
    ],
    'llm.defaultProviderId': 'openai',
    'llm.defaultModelId': 'gpt-4o-mini',
  };

  test('★ 三档都在，摘要与导图合成一档（不拆）', async () => {
    stubApi({ 'GET /settings': { settings: base } });
    const r = await render(<PurposeBindingsSection />);
    await r.flush();
    for (const p of ['chat', 'summarize', 'translate']) {
      assert.ok(r.container.querySelector(`[data-testid="purpose-${p}"]`), `缺少 ${p} 档`);
    }
    assert.ok(text(r.container).includes('摘要 + 思维导图'), '两者能力要求同类，拆开只会多一栏没人会填的');
    r.unmount();
  });

  test('★ 逐字段显示继承/覆盖 —— 只换 model 不换 provider 是最常见的填法', async () => {
    stubApi({
      'GET /settings': {
        settings: { ...base, 'llm.purposes': { translate: { model: 'deepseek-chat' } } },
      },
    });
    const r = await render(<PurposeBindingsSection />);
    await r.flush();

    const row = r.container.querySelector('[data-testid="purpose-translate"]')!;
    const tags = [...row.querySelectorAll('[data-inherited]')].map((e) => e.getAttribute('data-inherited'));
    // provider 继承、model 已覆盖 —— 两个字段各自独立，不是整体回退
    assert.deepEqual(tags, ['true', 'false'], `translate 档应为 provider 继承 / model 覆盖，实际 ${tags}`);

    // 最终生效值要写出来：provider 用的是全局的 openai，model 是自己填的
    const eff = row.querySelector('[data-testid="purpose-translate-effective"]')!.textContent ?? '';
    assert.ok(eff.includes('OpenAI'), `应显示继承来的 provider，实际：${eff}`);
    assert.ok(eff.includes('deepseek-chat'), `应显示覆盖后的 model，实际：${eff}`);
    r.unmount();
  });

  test('★ 没覆盖时三档都显示为继承，且生效值等于全局默认', async () => {
    stubApi({ 'GET /settings': { settings: base } });
    const r = await render(<PurposeBindingsSection />);
    await r.flush();
    const row = r.container.querySelector('[data-testid="purpose-chat"]')!;
    const tags = [...row.querySelectorAll('[data-inherited]')].map((e) => e.getAttribute('data-inherited'));
    assert.deepEqual(tags, ['true', 'true']);
    assert.ok(row.textContent!.includes('gpt-4o-mini'));
    r.unmount();
  });

  test('★ 全局默认为空时要明说"没有可继承的值"，别让人以为留空就行', async () => {
    stubApi({ 'GET /settings': { settings: { 'llm.providers': [] } } });
    const r = await render(<PurposeBindingsSection />);
    await r.flush();
    assert.ok(r.container.querySelector('[data-testid="purposes-no-default"]'));
    // 每档也要说明这样凑不出可用配置 —— daemon 要求 provider 与 model 都有值
    assert.ok(text(r.container).includes('配置不完整'));
    r.unmount();
  });

  /**
   * ⚠️ 这条本来想用"在输入框里打字 → onBlur → 断言 PATCH 体"来测，跑不通：
   * 组件宿主里**文本输入到不了 React**（vite 打包 hoist 了 import，
   * dom-env 的全局装配跑在 react-dom 模块初始化之后，React 于是走 IE 的
   * `attachEvent` polyfill 路径）—— 与那两条早就 skip 的用例同一个根因。
   *
   * 所以改成直接测**规则本身**。这不是退而求其次：
   * 容易写错的是合并规则，不是 `onBlur` 有没有接上。
   */
  test('★ 只填 model 时写入的绑定只含 model —— 不替用户把 provider 也钉死', () => {
    const out = mergePurposeBinding({}, 'translate', { model: 'deepseek-chat' });
    assert.deepEqual(out, { translate: { model: 'deepseek-chat' } });
  });

  test('★ 清空某一项 = 恢复继承，不留空串', () => {
    const before = { translate: { providerId: 'deepseek', model: 'deepseek-chat' } };
    // 只清 model，provider 的覆盖必须留着 —— 逐字段，与 daemon 的逐字段回退对称
    const out = mergePurposeBinding(before, 'translate', { model: '   ' });
    assert.deepEqual(out, { translate: { providerId: 'deepseek' } });
  });

  test('★ 整档清空就删掉这一档，不留 {} —— 免得"有没有覆盖"多一种等价形态', () => {
    const before = { translate: { model: 'x' }, chat: { model: 'y' } };
    const out = mergePurposeBinding(before, 'translate', { model: '' });
    assert.deepEqual(out, { chat: { model: 'y' } });
    assert.ok(!('translate' in out));
  });

  test('★ 逐字段回退的解析规则与 daemon 的 bindingFor() 一致', () => {
    const defaults = { providerId: 'openai', model: 'gpt-4o-mini' };
    // 只覆盖 model：provider 继承
    const a = resolvePurpose({ translate: { model: 'cheap' } }, 'translate', defaults);
    assert.deepEqual(a, {
      providerId: 'openai',
      model: 'cheap',
      inherited: { providerId: true, model: false },
    });
    // 整体回退（错误做法）会得到 gpt-4o-mini —— 固化这个反面
    assert.notEqual(a.model, 'gpt-4o-mini', '整体回退会让"只填 model"静默失效');

    // 全局默认为空 + 只填 model → 凑不出可用配置，daemon 会当作没配
    const b = resolvePurpose({ translate: { model: 'cheap' } }, 'translate', {});
    assert.equal(b.providerId, null, 'provider 无处可继承时必须是 null，不能假装配好了');
  });
});

/* ────────── 非安全上下文（T-099）：本机测试永远看不见的一族 ────────── */

/**
 * ★ 这一组的存在本身就是结论。
 *
 * 用户从 `http://100.64.135.105:10000` 访问，看到「当前浏览器不支持标签页选主」——
 * 这句话把他引向"换浏览器"，而换任何浏览器都没用：真因是 `http://<IP>`
 * **不是安全上下文**。更要命的是它掩盖了 `getUserMedia` 同样不可用，
 * **F3 录音在这个地址下根本跑不了，而产品一个字都没说**。
 *
 * 全员没发现的原因是：**开发与测试全在 127.0.0.1 上，而 localhost 恰好是安全上下文** ——
 * 开发环境恰好满足了生产环境不满足的前提。
 * 与"ffmpeg 自检一直绿是因为本机装了 /usr/bin/ffmpeg"同族。
 * 所以这里显式把"非安全上下文"造出来，让它以后不能再靠运气躲过去。
 */
describe('非安全上下文', () => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const win = globalThis.window as unknown as Record<string, unknown>;
  let saved: Record<string, unknown> = {};

  /** 造一个 `http://<IP>` 的浏览器：无 mediaDevices / locks / clipboard。 */
  function makeInsecure() {
    saved = {
      mediaDevices: nav.mediaDevices,
      locks: nav.locks,
      clipboard: nav.clipboard,
      isSecureContext: win.isSecureContext,
    };
    for (const k of ['mediaDevices', 'locks', 'clipboard']) {
      Object.defineProperty(nav, k, { value: undefined, configurable: true });
    }
    Object.defineProperty(win, 'isSecureContext', { value: false, configurable: true });
  }
  function restore() {
    for (const [k, v] of Object.entries(saved)) {
      const target = k === 'isSecureContext' ? win : nav;
      Object.defineProperty(target, k, { value: v, configurable: true });
    }
  }

  test('★ 逐项报出失去的能力，且录音排在最前 —— 它是唯一功能级不可用的', () => {
    makeInsecure();
    try {
      assert.equal(isSecureContext(), false);
      const blocked = detectBlockedCapabilities().map((c) => c.key);
      assert.deepEqual(blocked, ['microphone', 'webLocks', 'clipboard']);
      assert.equal(isMicrophoneAvailable(), false);
    } finally {
      restore();
    }
  });

  test('★ 一切就绪时横幅一个像素都不占 —— 默认状态就该是"什么都不说"', async () => {
    stubApi({ 'GET /health': { db: { extensions: { libsimple: true, sqliteVec: true } }, pipeline: { missing: [] } } });
    const r = await render(<ReadinessBanner />);
    await r.flush();
    assert.equal(text(r.container), '', `不该渲染任何内容，实际：${text(r.container)}`);
    r.unmount();
  });

  test('★ 非安全上下文只占一行，且默认折叠 —— 七行文字不是动作，是墙', async () => {
    makeInsecure();
    try {
      stubApi({ 'GET /health': { db: { extensions: { libsimple: true, sqliteVec: true } }, pipeline: { missing: [] } } });
      const r = await render(<ReadinessBanner />);
      await r.flush();

      // 折叠态：只有一行摘要，明细一个字都不该出现
      assert.equal(r.container.querySelector('[data-testid="readiness-details"]'), null, '默认必须折叠');
      assert.ok(text(r.container).includes('未就绪'), '折叠态要给出结论');
      assert.ok(!text(r.container).includes('麦克风'), '原因属于展开态，不该占首屏');

      // 展开后才给明细与动作
      await click(r.container.querySelector('[data-testid="readiness-toggle"]'));
      await r.flush();
      assert.ok(r.container.querySelector('[data-testid="readiness-details"]'), '点开要有明细');
      assert.ok(text(r.container).includes('录音'), '展开后要点名录音不可用');
      r.unmount();
    } finally {
      restore();
    }
  });

  test('★ 安全上下文的后果只说一遍 —— multiTab 不再单独占一行', async () => {
    makeInsecure();
    try {
      // 即便 SSE 层也报了多标签降级，非安全上下文下也只应合并成一条
      useConnectionStore.getState().setMultiTabDegraded(true);
      stubApi({ 'GET /health': { db: { extensions: { libsimple: true, sqliteVec: true } }, pipeline: { missing: [] } } });
      const r = await render(<ReadinessBanner />);
      await r.flush();
      await click(r.container.querySelector('[data-testid="readiness-toggle"]'));
      await r.flush();
      const rows = r.container.querySelectorAll('[data-testid="readiness-details"] > li');
      assert.equal(rows.length, 1, `同一件事不许说两遍，实际 ${rows.length} 行`);
      r.unmount();
    } finally {
      useConnectionStore.getState().setMultiTabDegraded(false);
      restore();
    }
  });

  test('★ 后端能力未就绪时每项都带可点的修复动作，而不是只陈述', async () => {
    stubApi({
      'GET /health': {
        db: { extensions: { tokenizer: 'trigram', libsimple: false, sqliteVec: false } },
        pipeline: { missing: ['whisper-cli', 'asr-model'] },
      },
    });
    const r = await render(<ReadinessBanner />);
    await r.flush();
    await click(r.container.querySelector('[data-testid="readiness-toggle"]'));
    await r.flush();
    for (const k of ['tokenizer', 'vec', 'pipeline']) {
      assert.ok(
        r.container.querySelector(`[data-testid="readiness-action-${k}"]`),
        `${k} 缺少可点的修复动作 —— 只陈述等于让用户干着急`,
      );
    }
    r.unmount();
  });
  /**
   * 这条**换了断言目标**：顶层 `banner.multiTab` 已随横幅合并删除，
   * 文案搬到 `readiness.items.secureContextHint`。
   * 保留用例是因为要守的性质没变 —— **不许把真因归给"浏览器不支持"**，
   * 那会把用户送去换浏览器，而换了也没用。归错因比不报更浪费时间。
   */
  test('★ 归因必须是安全上下文，不许说"浏览器不支持"', () => {
    const zh = readLocale('zh-CN');
    const items = (zh.readiness as Record<string, Record<string, string>>).items;
    const hint = items.secureContextHint;
    assert.ok(!hint.includes('浏览器不支持'), `旧归因仍在：${hint}`);
    assert.ok(hint.includes('localhost'), '要给出满足条件的地址形式');
    assert.ok(hint.includes('换浏览器不会有帮助'), '要主动挡掉"换个浏览器试试"这条弯路');
    // 旧的顶层键必须真的没了，否则两处文案会各自漂移
    assert.equal((zh.banner as Record<string, unknown>).multiTab, undefined, '旧键应随横幅一起删除');
  });
  test('★ 录音页在点击之前就拦住，不是点了报 undefined', async () => {
    makeInsecure();
    try {
      stubApi({ 'GET /health': { pipeline: { engines: [] } } });
      const r = await render(<RecorderPage />);
      await r.flush();
      assert.ok(r.container.querySelector('[data-testid="recorder-insecure"]'), '应显示不可用说明');
      const shown = text(r.container);
      assert.ok(shown.includes('此地址下无法录音'));
      // 仍要告诉用户哪条路是通的 —— 只说"不行"等于把人堵死
      assert.ok(shown.includes('导入本地音视频文件'), '要给出仍然可用的替代路径');
      r.unmount();
    } finally {
      restore();
    }
  });

  test('★ 复制在非安全上下文下走 execCommand 回退，而不是静默失败', async () => {
    makeInsecure();
    const doc = globalThis.document as unknown as { execCommand?: unknown };
    const hadExec = 'execCommand' in doc;
    let called = '';
    Object.defineProperty(doc, 'execCommand', {
      value: (cmd: string) => {
        called = cmd;
        return true;
      },
      configurable: true,
    });
    try {
      const ok = await copyText('/tmp/omdemo');
      assert.equal(ok, true, '有回退就该成功，而不是可选链短路后什么都没发生');
      assert.equal(called, 'copy');
    } finally {
      if (!hadExec) delete (doc as Record<string, unknown>)['execCommand'];
      restore();
    }
  });
});

/* ─────────── 配置保存必须可见（T-100）─────────── */

/**
 * 用户设了 DeepSeek key，**库里 0 行**。四步收窄的结论：
 *
 * | 步骤 | 结论 |
 * |---|---|
 * | 请求形状对不对 | ✅ 对。daemon 的 PATCH 收**裸 map**，前端发的就是裸 map（隔离实例实测 200 且落库） |
 * | 有没有发出去 | ✅ 发了 |
 * | 服务端接不接受 | ⚠️ **缺 CSRF 头 → 403**（实测） |
 * | 失败有没有告诉用户 | ❌ **完全没有** —— 三个写 mutation 的错误一个都没渲染，表单还无条件收起 |
 *
 * 所以用户看到的信号只有"表单关了"，他会合理理解为保存成功。
 * `client.ts` 那条「写操作永不静默回落 mock」**是生效的**（错误确实抛出来了），
 * 但**规则本身不够** —— 得有人把错误接住并画出来。
 */
describe('LLM 配置保存的可见反馈', () => {
  const settingsRoute = {
    'GET /settings': {
      settings: {
        'llm.providers': [
          { id: 'deepseek', kind: 'openai-compatible', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', isLocal: false },
        ],
      },
    },
    'GET /secrets': { secrets: [], disclosure: null },
  };

  test('★ 保存失败（403）必须显示错误，且表单不许关 —— 关了就等于说"成功了"', async () => {
    stubApi({
      ...settingsRoute,
      // 实测：缺 CSRF 头的写请求就是这个响应
      'PATCH /settings': () =>
        new Response(
          JSON.stringify({
            error: { code: 'CSRF_FAILED', message: 'missing or bad CSRF token', messageZh: 'CSRF 校验失败' },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    });
    const r = await render(<LlmSettingsSection />);
    await r.flush();

    await click(buttonByText(r.container, '编辑'));
    await click(r.container.querySelector('[data-testid="llm-save"]'));
    await r.flush();

    // 1) 错误必须可见
    assert.ok(
      text(r.container).includes('CSRF') || text(r.container).includes('校验失败'),
      `保存失败必须说出来，实际渲染：${text(r.container).slice(0, 200)}`,
    );
    // 2) 表单必须还开着 —— 用户刚填的内容不能丢
    assert.ok(r.container.querySelector('[data-testid="llm-save"]'), '失败后表单不该收起');
    // 3) 绝不能同时显示成功
    assert.equal(r.container.querySelector('[data-testid="llm-saved"]'), null, '失败了还报成功是最坏的情况');
    r.unmount();
  });

  test('★ 保存成功要有明确信号，而不是靠"表单关了"让用户自己猜', async () => {
    const { calls } = stubApi({ ...settingsRoute, 'PATCH /settings': { settings: {} } });
    const r = await render(<LlmSettingsSection />);
    await r.flush();

    await click(buttonByText(r.container, '编辑'));
    await click(r.container.querySelector('[data-testid="llm-save"]'));
    await r.flush();

    assert.ok(r.container.querySelector('[data-testid="llm-saved"]'), '成功要看得见');
    // 顺带钉住请求体是**裸 map**（daemon 收的就是这个；包一层 {settings:…} 会存成嵌套键）
    const body = calls.find((c) => c.method === 'PATCH')?.body as Record<string, unknown>;
    assert.ok(body, '应发出 PATCH');
    assert.ok(!('settings' in body), '不许多包一层 —— 那会存出 settings.settings 这种键');
    assert.ok('llm.providers' in body, '应直接是设置键 → 值');
    r.unmount();
  });

  test('★ 写操作遇到不存在的端点必须抛错，绝不回落 mock（这条规则要真的生效）', async () => {
    stubApi({ ...settingsRoute }); // PATCH 未打桩 → 404
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    await click(buttonByText(r.container, '编辑'));
    await click(r.container.querySelector('[data-testid="llm-save"]'));
    await r.flush();

    assert.equal(r.container.querySelector('[data-testid="llm-saved"]'), null, '端点不存在时绝不能显示已保存');
    assert.ok(r.container.querySelector('[data-testid="llm-save"]'), '表单保持打开');
    r.unmount();
  });
});

/* ─────────── CSRF 令牌不许静默丢失（T-103）─────────── */

/**
 * ★ 事故复盘钉死在这里。
 *
 * 原实现把 CSRF 令牌**只**写进 `sessionStorage`，写失败就 `catch {}` 吞掉，
 * 注释说「降级为无 CSRF 头，**由 Origin 校验兜底**」——
 * **服务端没有这个兜底，它是硬拒**：持有效 cookie 但不带 CSRF 头时
 * GET 200、PATCH/PUT 全 403（隔离实例实测）。
 *
 * 两个错必须同时存在才会酿成事故：
 * ① 假设了一个**对端并不存在**的兜底；② 降级是**静默**的。
 * 所以这一组同时钉住两件事：令牌不许丢、失败不许静默。
 */
describe('CSRF 令牌', () => {
  test('★ sessionStorage 写失败也不能丢令牌 —— 权威副本必须在内存', () => {
    const ss = globalThis.sessionStorage as unknown as Record<string, unknown>;
    const realSet = ss.setItem;
    const realGet = ss.getItem;
    // 模拟无痕模式：读写都抛
    ss.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    ss.getItem = () => {
      throw new Error('SecurityError');
    };
    try {
      setCsrf('tok-abc');
      assert.equal(hasCsrf(), true, '存储不可用时令牌必须仍在内存中，否则所有写操作会静默 403');
    } finally {
      ss.setItem = realSet;
      ss.getItem = realGet;
      clearCsrf();
    }
  });

  test('★ 清除后确实没有令牌 —— hasCsrf 不能只看内存而漏掉缓存', () => {
    setCsrf('tok-xyz');
    assert.equal(hasCsrf(), true);
    clearCsrf();
    assert.equal(hasCsrf(), false, 'clearCsrf 必须同时清内存与缓存');
  });

  test('★ CSRF 403 会自动重握手一次后重试成功 —— 用户不该被要求"重新打开应用"', async () => {
    let attempt = 0;
    const { calls } = stubApi({
      'GET /settings': { settings: {} },
      'GET /secrets': { secrets: [], disclosure: null },
      // 重握手是完整链路：先 GET /health 再 POST /auth/session，两个都得打桩
      'GET /health': { app: 'openmemo', version: '0.1.0', contractVersion: 1, instanceId: 'i', dataDir: '/tmp', host: '127.0.0.1', port: 17650, pid: 1 },
      'POST /auth/session': { csrf: 'fresh-token' },
      'PATCH /settings': () => {
        attempt += 1;
        // 第一次：令牌过期 → 403；重握手之后第二次应当放行
        if (attempt === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'CSRF_FAILED',
                message: 'missing or bad CSRF token',
                messageZh: 'CSRF 校验失败',
                retryable: true,
                remediation: { action: 'reauth' },
              },
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          );
        }
        return { settings: {} };
      },
    });

    setCsrf('stale-token');
    try {
      await api('settings', '/settings', { method: 'PATCH', body: { 'ui.theme': 'dark' } });
    } catch {
      assert.fail('403 CSRF 应当自愈后成功，而不是抛给用户');
    }
    assert.equal(attempt, 2, '应当重试恰好一次');
    assert.ok(
      calls.some((c) => c.path === '/auth/session'),
      '重试之前必须真的重新握手，否则带着同一个坏令牌重试毫无意义',
    );
    clearCsrf();
  });

  test('★ sessionStorage 不可用要如实归类，不能栽给"非安全上下文"', () => {
    // 这一条是防止排查被引偏：http://<IP> 下 sessionStorage 其实照常可用
    assert.equal(isSessionStorageAvailable(), true, 'jsdom 环境下应可用');
  });
});

/* ────── 保存后 daemon 读得到吗（T-108）：测对面，不测自己 ────── */

/**
 * ★ 这一组断言的**视角是反的，这正是重点**。
 *
 * 以往的测试问"我发了什么"，于是同一个形状栽了五次：
 * `textRaw` / `words` / `installPath` / `settings` 嵌套 / `defaultProviderId`。
 * 每次都是"我这边发得好好的、对面读的是另一个键"，而测试全绿。
 *
 * 所以这里改成问：**对面会读的那几个键，有没有被写上。**
 * 键名来自 `@openmemo/shared` 的 `LLM_SETTING_KEYS` —— 与 daemon 的
 * `resolveConfiguredProvider()` 同一份清单。daemon 以后新增一个必读键，
 * 这条测试会**立刻变红**，而不是等用户去撞 `LLM_NOT_CONFIGURED`。
 */
describe('保存后 daemon 读得到（键对齐）', () => {
  const provider = {
    id: 'deepseek',
    kind: 'openai-compatible' as const,
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    isLocal: false,
  };

  test('★ 首次保存必须写上 daemon 唯一认的两个键 —— 否则 F4 直接 LLM_NOT_CONFIGURED', () => {
    // 用户实际走的路：加一个 provider、填 key、点保存，**没有**另外点"设为默认"
    const patch = buildLlmSettingsPatch({ providers: [], provider, activeId: null });

    assert.equal(patch[LLM_SETTING_KEYS.defaultProviderId], 'deepseek', '缺它 daemon 解析不出 provider');
    assert.equal(patch[LLM_SETTING_KEYS.defaultModelId], 'deepseek-chat', '缺它同样解析不出');
    assert.equal(patch[`${LLM_SETTING_KEYS.baseUrlPrefix}deepseek`], 'https://api.deepseek.com/v1');
  });

  test('★ daemon 必读键清单一旦变化，这里要立刻红 —— 别再等用户去撞', () => {
    const patch = buildLlmSettingsPatch({ providers: [], provider, activeId: null });
    // 逐条对照 shared 的清单，而不是我手写的字符串
    for (const [name, key] of Object.entries(LLM_SETTING_KEYS)) {
      if (name === 'baseUrlPrefix' || name === 'purposes') continue;
      assert.ok(key in patch, `daemon 会读 ${key}，但保存时没写 —— 这正是第五次栽的那个形状`);
    }
  });

  test('已有默认 provider 时保存另一个，不许悄悄改默认', () => {
    const other = { ...provider, id: 'openai', label: 'OpenAI', model: 'gpt-4o-mini' };
    const patch = buildLlmSettingsPatch({ providers: [provider], provider: other, activeId: 'deepseek' });
    assert.ok(!(LLM_SETTING_KEYS.defaultProviderId in patch), '编辑非默认项不该改动默认 provider');
    // 但它自己的 baseUrl 仍要落库，否则换默认时又缺键
    assert.equal(patch[`${LLM_SETTING_KEYS.baseUrlPrefix}openai`], 'https://api.deepseek.com/v1');
  });

  test('★ 改当前默认 provider 的模型，defaultModelId 必须跟着变', () => {
    const edited = { ...provider, model: 'deepseek-reasoner' };
    const patch = buildLlmSettingsPatch({ providers: [provider], provider: edited, activeId: 'deepseek' });
    assert.equal(patch[LLM_SETTING_KEYS.defaultModelId], 'deepseek-reasoner', '否则会用着上一个模型名');
  });

  test('★ 分档配置写的键就是 daemon 读的 llm.purposes', () => {
    assert.equal(LLM_PURPOSES_KEY, LLM_SETTING_KEYS.purposes);
    const out = mergePurposeBinding({}, 'summarize', { model: 'deepseek-chat' });
    // daemon 的 bindingFor() 期望 Partial<Record<purpose, {providerId?, model?}>>
    assert.deepEqual(out, { summarize: { model: 'deepseek-chat' } });
  });

  test('★ UI 要显示"当前生效"，且它读的是 daemon 那两个键', async () => {
    stubApi({
      'GET /settings': { settings: { 'llm.providers': [provider] } }, // 只有清单，缺 default* 键
      'GET /secrets': { secrets: [], disclosure: null },
    });
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    const eff = r.container.querySelector('[data-testid="llm-effective"]')?.textContent ?? '';
    assert.ok(eff.includes('未生效'), `清单里有 provider 但缺 default* 键时必须显示未生效，实际：${eff}`);
    r.unmount();
  });
});

/* ── 两处共用同一份模型数据 + 在线优先（T-108 ①②） ── */

/**
 * 用户原话：「**该统一和复用的地方要统一复用啊**」。
 * 「AI 模型」的模型名与「按用途分别配置」里的模型此前**不是同一套** ——
 * 前者是每个 provider 自带的字符串，后者是个自由文本框，两边毫无关系。
 *
 * 这就是我删 `HealthBanner`/`SecureContextBanner` 时说的那句话的数据版：
 * **留着两处迟早各自漂移**。
 */
describe('LLM 服务商与模型：单一数据源', () => {
  test('★ 在线优先：预设里在线服务数量与顺序都排在本地之前（ADR-016）', () => {
    const online = LLM_PRESETS.filter((p) => p.tier === 'online');
    const local = LLM_PRESETS.filter((p) => p.tier === 'local');
    assert.ok(online.length > local.length, '在线是主路径，不该被本地淹没');
    // 顺序：第一个必须是在线，最后一个才是本地
    assert.equal(LLM_PRESETS[0]!.tier, 'online', '默认答案不该是本地');
    assert.equal(LLM_PRESETS[LLM_PRESETS.length - 1]!.tier, 'local');
    // base URL 一律可改（国内常走中转网关，写死会把人挡在门外）
    for (const p of LLM_PRESETS) assert.ok(p.baseUrl.length > 0, `${p.id} 缺 baseUrl`);
  });

  test('★ 用户自己填的模型名必须出现在分档配置的候选里 —— 这正是"两处不统一"的本体', async () => {
    stubApi({
      'GET /settings': {
        settings: {
          'llm.providers': [
            { id: 'deepseek', kind: 'openai-compatible', label: 'DeepSeek', baseUrl: 'u', model: 'my-custom-model', isLocal: false },
          ],
          'llm.defaultProviderId': 'deepseek',
          'llm.defaultModelId': 'my-custom-model',
        },
      },
      'GET /secrets': { secrets: [], disclosure: null },
    });
    const r = await render(<PurposeBindingsSection />);
    await r.flush();
    const opts = modelOptions(r.container, 'purpose-chat-model');
    assert.ok(
      opts.includes('my-custom-model'),
      `用户在「AI 模型」里填的模型必须能在分档里选到，实际候选：${JSON.stringify(opts)}`,
    );
    r.unmount();
  });

  test('★ 两个区块的候选来自同一个 modelsFor —— 不许那边有这边没有', async () => {
    const settings = {
      'llm.providers': [
        { id: 'deepseek', kind: 'openai-compatible', label: 'DeepSeek', baseUrl: 'u', model: 'deepseek-reasoner', isLocal: false },
      ],
      'llm.defaultProviderId': 'deepseek',
      'llm.defaultModelId': 'deepseek-reasoner',
    };
    stubApi({ 'GET /settings': { settings }, 'GET /secrets': { secrets: [], disclosure: null } });

    const a = await render(<PurposeBindingsSection />);
    await a.flush();
    const purposeOpts = new Set(modelOptions(a.container, 'purpose-chat-model'));
    a.unmount();

    const b = await render(<LlmSettingsSection />);
    await b.flush();
    await click(buttonByText(b.container, '编辑'));
    await b.flush();
    const llmOpts = modelOptions(b.container, 'llm-model-select');
    b.unmount();

    assert.ok(llmOpts.length > 0, '「AI 模型」也要给候选');
    for (const m of llmOpts) {
      assert.ok(purposeOpts.has(m), `模型 ${m} 在「AI 模型」有、在分档里没有 —— 两处又漂了`);
    }
  });
});

/* ── T-126：模型选择 = 真下拉 + 逃生口，两处复用同一个组件 ── */

/**
 * 用户原话：「**模型的下拉框还是能选择也能填写，这个和 memo 里面还是不一样，也要改**」。
 * 他看过 memo.ac 实物，那边是纯 `<select>`。
 *
 * 前任把它做成 `<input list=…>`（自由输入 + datalist 提示），注释里的理由是
 * 「厂商上新模型比我们发版快」——**这个顾虑是真的**（24 家里 20 家的清单是人工从文档
 * 转录的，没有端点可调），但它把**例外做成了默认**：既与 memo 不一致，
 * 又让用户可以打错一个字符打出一个不存在的型号而**毫无反馈**。
 *
 * 所以这一族用例锁三件事：① 默认是真下拉；② 逃生口仍在但不是默认；
 * ③ 两处是**同一个组件、同一份数据**（用户："该统一和复用的地方要统一复用啊"）。
 */

/** 某个模型下拉的候选值（排除空值项与「自定义…」这两个功能项）。 */
function modelOptions(c: HTMLElement, testId: string): string[] {
  const sel = c.querySelector(`select[data-testid="${testId}"]`);
  assert.ok(sel, `找不到模型下拉 ${testId} —— 它必须是 <select>，不是 <input>`);
  return [...sel!.querySelectorAll('option')]
    .map((o) => (o as HTMLOptionElement).value)
    .filter((v) => v !== '' && v !== '__custom__');
}

describe('LLM 模型选择：真下拉（T-126）', () => {
  const settingsWith = (model: string, bindings?: Record<string, unknown>) => ({
    'llm.providers': [
      { id: 'deepseek', kind: 'openai-compatible', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model, isLocal: false },
    ],
    'llm.defaultProviderId': 'deepseek',
    'llm.defaultModelId': model,
    ...(bindings ? { 'llm.purposes': bindings } : {}),
  });

  test('★ 两处都必须是 <select>，且全仓不许再有 datalist 自由输入', async () => {
    stubApi({
      'GET /settings': { settings: settingsWith('deepseek-v4-flash') },
      'GET /secrets': { secrets: [], disclosure: null },
    });

    const a = await render(<PurposeBindingsSection />);
    await a.flush();
    assert.ok(a.container.querySelector('select[data-testid="purpose-chat-model"]'), '分档配置的模型必须是下拉');
    assert.equal(a.container.querySelectorAll('datalist').length, 0, '不许再有 datalist');
    a.unmount();

    const b = await render(<LlmSettingsSection />);
    await b.flush();
    await click(buttonByText(b.container, '编辑'));
    await b.flush();
    assert.ok(b.container.querySelector('select[data-testid="llm-model-select"]'), '「AI 模型」的模型必须是下拉');
    assert.equal(b.container.querySelectorAll('datalist').length, 0, '不许再有 datalist');
    b.unmount();
  });

  test('★ 两处复用同一个组件 —— 不许各写一遍（用户："该统一和复用的地方要统一复用"）', async () => {
    const a = await readSource('components/common/llm/LlmSettingsSection.tsx');
    const b = await readSource('components/common/llm/PurposeBindingsSection.tsx');
    for (const [name, src] of [['LlmSettingsSection', a], ['PurposeBindingsSection', b]] as const) {
      assert.ok(src.includes('LlmModelSelect'), `${name} 必须复用共享的 LlmModelSelect`);
      assert.ok(!src.includes('<datalist'), `${name} 里还留着 datalist 自由输入`);
    }
  });

  test('★ 候选来自 vendor/manifests 的目录，不是前端手写的第二份清单', async () => {
    // `deepseek-v4-flash` 只存在于目录里；前任手写的那份只有 chat/reasoner 两个 ——
    // 用户实际配的正是 v4-flash，也就是说他配的型号在旧下拉里**根本不存在**。
    assert.ok(LLM_CATALOG_STATS.providers >= 24, '目录应有 24 家');
    assert.ok(LLM_CATALOG_STATS.models >= 520, '目录应有 520 条模型');

    stubApi({
      'GET /settings': { settings: settingsWith('deepseek-v4-flash') },
      'GET /secrets': { secrets: [], disclosure: null },
    });
    const r = await render(<PurposeBindingsSection />);
    await r.flush();
    const opts = modelOptions(r.container, 'purpose-chat-model');
    assert.ok(opts.includes('deepseek-v4-flash'), `目录里的型号必须进候选，实际：${JSON.stringify(opts)}`);
    assert.ok(opts.includes('deepseek-reasoner'), '目录里的其余型号也要在');
    r.unmount();
  });

  test('★ id 桥接：目录里 Anthropic 叫 claude，前端预设叫 anthropic —— 不桥接就是空清单', () => {
    assert.ok((catalogProviderFor('anthropic')?.models.length ?? 0) > 0, 'anthropic → claude');
    assert.ok((catalogProviderFor('zhipu')?.models.length ?? 0) > 0, 'zhipu → zhipuai');
    assert.ok((catalogProviderFor('dashscope')?.models.length ?? 0) > 0, 'dashscope → qwen');
    assert.ok((catalogProviderFor('siliconflow')?.models.length ?? 0) > 0, 'siliconflow → siliconcloud');
    // 不在目录里的一律回 undefined —— 不编一个"看起来像"的
    assert.equal(catalogProviderFor('my-own-gateway'), undefined);
  });

  /**
   * ★ 这条防的是**报喜不报忧**。
   *
   * 目录有 24 家 / 520 条，但真正能出现在下拉里的只有 `LLM_PRESETS` 那 11 家能覆盖到的
   * （11 家 / 283 条）—— 剩下 13 家（237 条）用户**根本加不进来**，因为「+ 添加」按钮只有 11 个。
   * 那一步是 D-10 #24，归 `architect`，本轮没做。
   *
   * 这里能锁死的是另一件事，也是真正会坏的那件：**任何一个预设都不许是空清单**。
   * 预设 id 与目录 id 不一致（`anthropic`≠`claude` 等）时，用户打开下拉会看到零个候选，
   * 看起来像"我们不支持这家" —— 加预设的人不会想到去核对目录 id，所以让测试去核对。
   */
  test('★ 每个预设都必须有候选 —— 预设 id 与目录 id 对不上就是一个空下拉', () => {
    const empty = LLM_PRESETS.filter((p) => (catalogProviderFor(p.id)?.models.length ?? 0) === 0);
    assert.deepEqual(
      empty.map((p) => p.id),
      [],
      '这些预设在目录里找不到对应项（多半是 id 不一致），下拉会是空的',
    );
  });

  test('★ 逃生口仍在，但不是默认：最后一项是「自定义…」，选中后才出现文本框', async () => {
    stubApi({
      'GET /settings': { settings: settingsWith('deepseek-v4-flash') },
      'GET /secrets': { secrets: [], disclosure: null },
    });
    const r = await render(<PurposeBindingsSection />);
    await r.flush();

    const sel = r.container.querySelector('select[data-testid="purpose-chat-model"]') as HTMLSelectElement;
    const values = [...sel.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value);
    assert.equal(values.at(-1), '__custom__', '「自定义…」必须是最后一项');
    assert.equal(
      r.container.querySelector('[data-testid="purpose-chat-model-custom"]'),
      null,
      '没选「自定义…」时不该有文本框 —— 自由输入不是默认路径',
    );

    await type(sel, '__custom__');
    await r.flush();
    assert.ok(
      r.container.querySelector('[data-testid="purpose-chat-model-custom"]'),
      '选了「自定义…」之后才出现文本框',
    );
    r.unmount();
  });

  /**
   * ★ 换控件最容易犯的错，也是这次唯一会**丢用户数据**的错。
   *
   * `<select>` 遇到不在 options 里的 value 会**显示成空**。用户配的若是清单里没有的
   * 型号（自定义网关 / 刚上新的型号），换控件的瞬间他会看到一个空下拉，
   * 再点一次保存就真的写空了。所以：不认识的值 ⇒ 自动进自定义模式，原值一个字符不改。
   */
  test('★ 值不在候选里时自动进自定义模式，绝不把它显示成空（= 悄悄丢配置）', async () => {
    stubApi({
      'GET /settings': {
        settings: settingsWith('deepseek-v4-flash', { chat: { model: 'gateway/未来的型号-v9' } }),
      },
      'GET /secrets': { secrets: [], disclosure: null },
    });
    const r = await render(<PurposeBindingsSection />);
    await r.flush();

    const sel = r.container.querySelector('select[data-testid="purpose-chat-model"]') as HTMLSelectElement;
    assert.equal(sel.value, '__custom__', '不认识的值必须落到自定义模式，而不是被显示成空');
    const box = r.container.querySelector('[data-testid="purpose-chat-model-custom"]') as HTMLInputElement;
    assert.ok(box, '必须出现文本框把原值托住');
    assert.equal(box.value, 'gateway/未来的型号-v9', '原值必须一个字符都不改');
    r.unmount();
  });

  /**
   * ★★ **一次无害的交互，不许静默改掉用户的配置。**
   *
   * 用户库里（`/root/data-memo`）是这个真实状态：
   *   `llm.defaultModelId   = deepseek-v4-flash`   ← daemon 唯一认的，**权威**
   *   `llm.providers[0].model = deepseek-chat`     ← daemon 从不读，只是"上次选的"记忆
   *
   * 修复前：表单从**记忆**取初值 → 同一屏上「当前生效」写 v4-flash、表单写 chat；
   * 且**只要为别的事（改 base URL / 换 Key）打开表单点一次「确定」**，
   * `buildLlmSettingsPatch` 就会把 `defaultModelId` 写成 `deepseek-chat` —— 无提示。
   * 用户明说过"等环境稳定了再重新 set api key"，他不打算碰这个表单，可这一下就把他配的模型换了。
   *
   * 这与「`<select>` 遇到不认识的值渲染成空」是同一族缺陷：**一次无害交互静默改配置**。
   *
   * ⚠️ 这条用例做过**反向验证**：把修复（`initialModel` 取权威值）撤回成 `provider.model` 后，
   * 它确实变红（实际收到 `deepseek-chat`）。不是一条永远绿的护栏。
   */
  test('★ 打开表单什么都不改直接「确定」，绝不许改掉 defaultModelId', async () => {
    const { calls } = stubApi({
      'GET /settings': {
        settings: {
          'llm.providers': [
            { id: 'deepseek', kind: 'openai-compatible', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', isLocal: false },
          ],
          'llm.defaultProviderId': 'deepseek',
          'llm.defaultModelId': 'deepseek-v4-flash',
        },
      },
      'GET /secrets': { secrets: [], disclosure: null },
      'PATCH /settings': { settings: {} },
    });
    const r = await render(<LlmSettingsSection />);
    await r.flush();

    // 表单的型号初值必须是**权威值**，不是 providers[].model —— 否则同屏自相矛盾
    await click(buttonByText(r.container, '编辑'));
    await r.flush();
    const sel = r.container.querySelector('select[data-testid="llm-model-select"]') as HTMLSelectElement;
    assert.equal(
      sel.value,
      'deepseek-v4-flash',
      '表单该显示 daemon 真正在用的型号，而不是 llm.providers 里那份记忆',
    );

    // 什么都不改，直接确定
    await click(r.container.querySelector('[data-testid="llm-save"]'));
    await r.flush();

    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, '应发出 PATCH');
    const body = patch!.body as Record<string, unknown>;
    assert.equal(
      body['llm.defaultModelId'],
      'deepseek-v4-flash',
      `一次"什么都没改"的保存把用户的模型换掉了 —— 实际写入 ${String(body['llm.defaultModelId'])}`,
    );
    // 顺带：记忆值被更新成权威值（是用户显式点了确定的结果，不是隐藏同步）
    const savedProviders = body['llm.providers'] as Array<{ id: string; model: string }>;
    assert.equal(savedProviders[0]!.model, 'deepseek-v4-flash', '记忆值应向权威值靠拢，而不是反过来');
    r.unmount();
  });

  /**
   * ★ 用户 `:10000` 实例上的真实配置（`/root/data-memo`）：
   * `llm.defaultProviderId=deepseek` / `llm.defaultModelId=deepseek-v4-flash`，
   * 而 `llm.providers[0].model` 是 `deepseek-chat`（两者本就不同步，是既有状态）。
   * 换控件之后：**权威值必须仍然生效、且下拉里选得中**；记忆值也不许从候选里消失
   * （它是"这家上次选的型号"，切换 provider 时还要用）。
   */
  test('★ 真实用户配置换控件后仍在：当前生效与下拉都是 deepseek-v4-flash', async () => {
    stubApi({
      'GET /settings': {
        settings: {
          'llm.providers': [
            { id: 'deepseek', kind: 'openai-compatible', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', isLocal: false },
          ],
          'llm.defaultProviderId': 'deepseek',
          'llm.defaultModelId': 'deepseek-v4-flash',
        },
      },
      'GET /secrets': { secrets: [{ key: 'llm.deepseek.apiKey', masked: 'sk-b…0e11', enc: 'plain', updatedAt: 1 }], disclosure: null },
    });
    const r = await render(<LlmSettingsSection />);
    await r.flush();

    const eff = r.container.querySelector('[data-testid="llm-effective"]')?.textContent ?? '';
    assert.ok(eff.includes('deepseek-v4-flash'), `当前生效必须仍是 deepseek-v4-flash，实际：${eff}`);

    await click(buttonByText(r.container, '编辑'));
    await r.flush();
    const sel = r.container.querySelector('select[data-testid="llm-model-select"]') as HTMLSelectElement;
    assert.equal(sel.value, 'deepseek-v4-flash', '表单必须选中权威值，且绝不许变空');
    const values = [...sel.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value);
    assert.ok(values.includes('deepseek-chat'), '这家"上次选的型号"也不许从候选里消失');
    r.unmount();
  });
});

/* ── 导图保存 + "临时关闭的开关"（T-108 ①②） ── */

/**
 * ★ 同一形状**今天第二次**：
 * `showModel={false}`（录音页）和 `MINDMAP_SAVE_SUPPORTED = false`（导图页）——
 * 都是"当时后端没有 → 关掉 → 后端做好了没人回来开"。
 * 导图渲染 ✅ 拖拽 ✅ 导出 ✅，**只有保存零请求**，还挂着一条"编辑尚未持久化"误导用户。
 *
 * 我把常量**删掉**而不是改成 `true`：改成 true 只还这一次的债，下个功能还会重演。
 * 让"后端有没有"自己说话 —— 直接发请求，端点不存在就如实报错。
 * 与我删 `App.tsx` 那个 `pending` 分支同一条原则：
 * **没有这个开关，"忘了打开"就不可能再发生。**
 */
describe('导图保存', () => {
  const doc = { nodes: { root: { id: 'root', text: '根', children: [] } }, rootId: 'root' };

  test('★ 保存必须真的发出 PATCH，且落在 daemon 实现的那条路由上', async () => {
    const { calls } = stubApi({ 'PATCH /notes/n1/mindmap': { revision: 2, mindmapUid: 'm1' } });
    function Harness() {
      const m = useSaveMindmapMutation('n1');
      return <button onClick={() => m.mutate(doc as never)}>save</button>;
    }
    const r = await render(<Harness />);
    await click(buttonByText(r.container, 'save'));
    await r.flush();

    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, '之前这里是零写请求 —— 一个布尔常量把它挡住了');
    assert.equal(patch!.path, '/notes/n1/mindmap');
    // daemon 的 PATCH 收 `{doc}`（`content.ts:329`），不是裸文档
    assert.deepEqual(patch!.body, { doc });
    r.unmount();
  });

  test('★ 不许再出现"等后端做好再手动打开"的布尔开关', async () => {
    const mod = (await import('../features/mindmap/api')) as Record<string, unknown>;
    assert.equal(
      mod['MINDMAP_SAVE_SUPPORTED'],
      undefined,
      '这个常量必须保持删除状态 —— 它正是"后端好了却没人回来开"的载体',
    );
  });

  test('★ 端点不存在时如实报错，绝不静默成功', async () => {
    stubApi({}); // PATCH 未打桩 → 404
    function Harness() {
      const m = useSaveMindmapMutation('n1');
      return (
        <div>
          <button onClick={() => m.mutate(doc as never)}>save</button>
          {m.isError ? <span data-testid="save-err">err</span> : null}
        </div>
      );
    }
    const r = await render(<Harness />);
    await click(buttonByText(r.container, 'save'));
    await r.flush();
    assert.ok(
      r.container.querySelector('[data-testid="save-err"]'),
      '写操作遇到不存在的端点必须抛错 —— 这正是删掉常量后仍然安全的原因',
    );
    r.unmount();
  });
});

/* ──────── F3 实时录音接真通道（T-117） ──────── */

/**
 * ★ 章程五功能里**唯一 UI 层造假**的一处，已拆除。
 *
 * 原来 `RecorderPage` 用 `setInterval` 轮播 `MOCK_LINES`，
 * 停止后弹「已更新 47 段 · 已保留 3 段」——**数字是常量**。
 * 而 `/ws/recorder` 后端一直是真的。这一组钉住冻结契约（D-06 §15）的合并语义，
 * 以及"拿不到的数字不许再编"。
 */
describe('实时字幕合并（D-06 §15 语义）', () => {
  const partial = (uid: string, text: string, startMs = 0) =>
    ({ type: 'partial', utteranceId: uid, text, startMs }) as const;

  test('★ 语义 4：同一句内整句替换，不做 diff 拼接', () => {
    let rows = applyCaption([], partial('u1', '今天'));
    rows = applyCaption(rows, partial('u1', '今天我们'));
    rows = applyCaption(rows, partial('u1', '今天我们讨论'));
    assert.equal(rows.length, 1, '同一 utteranceId 只能占一行');
    assert.equal(rows[0]!.text, '今天我们讨论', '必须整句替换');
    assert.equal(rows[0]!.final, false);
  });

  test('★ 换了 utteranceId 就是新的一句', () => {
    let rows = applyCaption([], partial('u1', '第一句'));
    rows = applyCaption(rows, partial('u2', '第二句'));
    assert.equal(rows.length, 2);
  });

  test('★ final 到达即定稿：未定稿行不许留下', () => {
    let rows = applyCaption([], partial('u1', '今天我们讨'));
    rows = applyCaption(rows, {
      type: 'final',
      seq: 0,
      startMs: 0,
      endMs: 1200,
      text: '今天我们讨论。',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.final, true, '定稿行必须是 final —— UI 靠它决定灰斜体还是正常');
    assert.equal(rows[0]!.text, '今天我们讨论。');

    // 定稿之后来的新 partial 不能覆盖已定稿的内容
    rows = applyCaption(rows, partial('u2', '下一句'));
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.final, true);
    assert.equal(rows[1]!.final, false);
  });

  test('★ overrun / error / stopped 不动字幕 —— 它们是状态，不是内容', () => {
    const base = applyCaption([], partial('u1', 'x'));
    for (const m of [
      { type: 'overrun', droppedSamples: 100 } as const,
      { type: 'error', code: 'E', messageZh: '出错' } as const,
      { type: 'stopped', segmentCount: 3, rerunJobUid: null } as const,
    ]) {
      assert.deepEqual(applyCaption(base, m), base, `${m.type} 不该改动字幕`);
    }
  });

  test('★ 采样率必须与 daemon 的 RECORD_SAMPLE_RATE 一致 —— 不一致会整体错位', () => {
    assert.equal(RECORD_SAMPLE_RATE, 16_000);
  });

  test('★ 录音页不许再有写死的字幕与合并数字', async () => {
    const src = await readSource('features/recorder/RecorderPage.tsx');
    assert.ok(!src.includes('MOCK_LINES'), '硬编码字幕轮播必须已删除');
    assert.ok(!/updated:\s*47/.test(src), '「已更新 47 段」这类写死数字不许再出现');
    assert.ok(src.includes('startRecording'), '必须走真实的 /ws/recorder 通道');
  });
});

/* ────────── D-10 信息架构不变量（T-123） ────────── */

describe('D-10 不变量', () => {
  test('★ ① 录音页不许再写死具体模型名 —— 环境一变就成了谎', async () => {
    const src = await readSource('features/recorder/RecorderPage.tsx');
    /*
     * 只查**非空字面量**：`model: ''` 是进度条标签故意留空（那里不需要名字），
     * 真正的危险是 `model: 'large-v3-turbo'` 这种说出一个没核对过的具体名字。
     * 注释里把型号作为论据提到则完全可以 —— 那不是说给用户听的。
     */
    assert.ok(
      !/model:\s*'[^']+'/.test(src),
      '重跑提示的 model 必须来自真实激活的模型，不能是非空字面量',
    );
    assert.ok(src.includes('useActiveAsrModel'), '应从后端取当前激活模型');
  });

  test('★ INV-1：按用途分档的服务商下拉 ⊆ 已配置服务商清单', async () => {
    const providers = [
      { id: 'deepseek', kind: 'openai-compatible', label: 'DeepSeek', baseUrl: 'u', model: 'm1', isLocal: false },
      { id: 'openai', kind: 'openai-compatible', label: 'OpenAI', baseUrl: 'u2', model: 'm2', isLocal: false },
    ];
    stubApi({
      'GET /settings': {
        settings: { 'llm.providers': providers, 'llm.defaultProviderId': 'deepseek', 'llm.defaultModelId': 'm1' },
      },
      'GET /secrets': { secrets: [], disclosure: null },
    });
    const r = await render(<PurposeBindingsSection />);
    await r.flush();

    const configured = new Set(providers.map((p) => p.id));
    /*
     * ⚠️ T-126 起这一栏有**两个** `<select>`（服务商 + 模型），
     * 所以必须按 testid 定位到服务商那一个 —— 否则会把模型型号当成服务商 id 来断言，
     * 断言看起来还在跑，测的却是另一件事（比直接报错更坏）。
     */
    const providerSelect = r.container.querySelector('select[data-testid="purpose-chat-provider"]');
    assert.ok(providerSelect, '找不到服务商下拉');
    const options = [...providerSelect!.querySelectorAll('option')]
      .map((o) => (o as HTMLOptionElement).value)
      .filter((v) => v !== ''); // 空值 = "继承全局"
    assert.ok(options.length > 0, '应渲染出服务商选项');
    for (const v of options) {
      assert.ok(configured.has(v), `下拉里出现了未配置的服务商 ${v} —— INV-1 被破坏`);
    }
    r.unmount();
  });

  test('★ D-10 #8：语言模型的"当前使用"不许再读 active.llm（它恒为 null，在谎报不可用）', async () => {
    const src = await readSource('features/models/ModelsPage.tsx');
    assert.ok(
      !src.includes('m.id === active.llm'),
      '在线 provider 从不进 installed 表，读 active.llm 必然显示"未配置"',
    );
    assert.ok(src.includes('useLlmConfig'), '应改读 llm.defaultProviderId / llm.defaultModelId');
  });

  test('★ D-10 §1.2：/models 只有一条路由，Tab 走 ?tab=，不开子路由', async () => {
    const src = await readSource('features/models/Models.routes.tsx');
    assert.ok(!src.includes("'models/asr'"), '不许为 Tab 开子路由');
    assert.ok(!src.includes("'models/llm'"), '不许为 Tab 开子路由');
    const page = await readSource('features/models/ModelsPage.tsx');
    assert.ok(page.includes("sp.get('tab')"), 'Tab 状态必须进 URL query（可分享）');
  });

  test('★ D-10 #20：D-05 规划过但从未实现的设置分页词条必须删除', () => {
    const zh = readLocale('zh-CN');
    const st = zh.settings as Record<string, unknown>;
    assert.equal(st['asr'], undefined, '留着下一个人会照它建页');
    assert.equal(st['storage'], undefined);
  });
});

/* ───────────────────── T-129：/models Tab 切换条 + 混语言 ───────────────────── */

/**
 * `/models` 页的四个 query 的最小桩。
 * 目录里刻意放**非中文**的展示名：下面要断言"英文界面上不许出现中文"，
 * 如果桩数据自带中文，那条断言就永远红，测的也不是我们的文案。
 */
function stubModelsPage(opts: { withCatalog?: boolean } = {}) {
  const variant = {
    id: 'asr/dummy-q5',
    groupId: 'asr/dummy',
    role: 'asr',
    arch: 'whisper',
    format: 'ggml',
    quantization: 'q5_1',
    languages: ['multi'],
    totalSizeBytes: 60_000_000,
    catalogVersion: '2026.08.03',
    license: { id: 'MIT', url: 'https://example.invalid', requiresAcceptance: false, gated: false },
    files: [{ name: 'a.bin', sha256: 'x'.repeat(64), sizeBytes: 60_000_000, optional: false }],
    requirements: { ramRequiredMB: 512, vramRequiredMB: 0, computedAtContext: null },
    fitness: {
      tier: 'recommended',
      reasonZh: 'dummy reason',
      notRecommendedForLanguage: false,
      speedTier: 'unknown',
      speedSource: 'none',
      estMinutesPerAudioHour: null,
      estGpuLayers: null,
    },
  };
  return stubApi({
    '/models/catalog?role=all&lang=en': {
      stale: false,
      fetchedAt: '2026-08-03T00:00:00.000Z',
      groups: opts.withCatalog
        ? [
            {
              groupId: 'asr/dummy',
              role: 'asr',
              // ★ 真实形状：目录里 displayName/displayNameZh、descriptionEn/descriptionZh 成对
              displayName: 'Dummy ASR',
              displayNameZh: '假装的转写模型',
              descriptionZh: '一段用来占位的中文描述',
              descriptionEn: 'a stub group',
              tags: [],
              variants: [variant],
            },
          ]
        : [],
    },
    '/models/catalog?role=all&lang=zh': {
      stale: false,
      fetchedAt: '2026-08-03T00:00:00.000Z',
      groups: [],
    },
    '/models/installed': { models: [], active: { asr: null, llm: null } },
    '/models/storage': {
      usedBytes: 0,
      volume: { freeBytes: 1_000_000_000, totalBytes: 2_000_000_000 },
      breakdown: [],
      reclaimable: { orphanBlobsBytes: 0, stalePartialsBytes: 0 },
    },
    '/jobs': { jobs: [] },
    '/settings': {
      settings: {
        'llm.providers': [
          {
            id: 'deepseek',
            kind: 'openai-compatible',
            label: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            isLocal: false,
          },
        ],
        'llm.defaultProviderId': 'deepseek',
        'llm.defaultModelId': 'deepseek-chat',
      },
    },
    '/secrets': { secrets: [], disclosure: null },
  });
}

describe('T-129 /models Tab 切换条', () => {
  test('★ ?tab=llm 时切换条必须仍在页面上，且不在任何被隐藏的面板里', async () => {
    stubModelsPage();
    const r = await render(<ModelsPage />, { route: '/models?tab=llm' });
    await r.flush();

    // 前提：确实落在「语言模型」Tab 上（不然下面断的是另一件事）
    assert.ok(
      r.container.querySelector('[data-testid="models-llm-tab"]'),
      '?tab=llm 应渲染语言模型面板',
    );

    const tabs = r.container.querySelector('[data-testid="models-tabs"]');
    assert.ok(tabs, '切换条整个不见了 —— 用户切过来就再也切不回去');

    /*
     * ★ 这两条才是真正的判据，不能只靠"点得动"。
     *
     * jsdom 不加载 CSS，Tailwind 的 `hidden`（display:none）对它**不生效** ——
     * 于是"点一下切换按钮"在有 bug 的版本里**照样能通过**。
     * 缺陷的本体是**结构**：tablist 被写成了某个 tabpanel 的后代，
     * 所以断言必须断在结构上（已反向验证：把切换条塞回 section 内，这两条真的红）。
     */
    /*
     * ⚠️ 用 `assert.ok(x === null)` 而不是 `assert.equal(x, null)`。
     * `assert.equal` 失败时会把 `actual` 原样塞进 AssertionError，而这里的 actual 是一个
     * **jsdom 元素** —— node:test 的报告器要为它算 diff，`util.inspect` 会顺着
     * parentNode/ownerDocument/React fiber 把整棵 DOM 连同 window 一起展开。
     * 实测：这一条断言一红，测试进程涨到 **10.5 GB** 后被 OOM killer 打死
     * （`✖ components.test.js 'test failed'`，57 秒，后面的用例一个都没跑）。
     * 于是"反向验证"看到的不是红，而是整个文件炸掉 —— 比不红更难查。
     * 换成布尔比较后 actual 是 `false`，红得干干净净。
     */
    assert.ok(
      tabs!.closest('.hidden') === null,
      '切换条被一个 hidden 的祖先包住了（切到另一个 Tab 就会连它一起消失）',
    );
    assert.ok(
      tabs!.closest('[role="tabpanel"]') === null,
      '切换条被塞进了某个 Tab 面板内部 —— 它属于页面骨架，必须是面板的兄弟',
    );

    // 行为：点得回去，且面板真的换了
    await click(r.container.querySelector('[data-testid="models-tab-asr"]'));
    await r.flush();
    assert.ok(
      r.container.querySelector('[data-testid="models-llm-tab"]') === null,
      '切回「转写」后语言模型面板应消失',
    );
    const asrPanel = r.container.querySelector('#models-panel-asr');
    assert.ok(asrPanel, '转写面板应存在');
    assert.ok(!asrPanel!.className.includes('hidden'), '切回「转写」后转写面板应可见');
    r.unmount();
  });

  test('★ 两个 Tab 下切换条都在，且 aria-selected 跟着 ?tab= 走', async () => {
    for (const [route, selected] of [
      ['/models', 'asr'],
      ['/models?tab=asr', 'asr'],
      ['/models?tab=llm', 'llm'],
    ] as const) {
      stubModelsPage();
      const r = await render(<ModelsPage />, { route });
      await r.flush();
      const asr = r.container.querySelector('[data-testid="models-tab-asr"]');
      const llm = r.container.querySelector('[data-testid="models-tab-llm"]');
      assert.ok(asr && llm, `${route}：两个 Tab 按钮都必须在`);
      assert.equal(asr!.getAttribute('aria-selected'), String(selected === 'asr'), route);
      assert.equal(llm!.getAttribute('aria-selected'), String(selected === 'llm'), route);
      r.unmount();
    }
  });
});

describe('T-129 /models 不许中英混排', () => {
  const CJK = /[一-鿿]/;

  /*
   * 成因不是"缺 zh-CN 词条"，也不是"键名对不上"，更不是"搬迁漏了 t()" ——
   * 搬过来的 LLM 两块**恰恰是唯一做对了 i18n 的部分**。
   * 混语言的来源是：`/models` 的页面骨架与卡片**整片硬编码中文、根本不走 i18n**，
   * 而 `detectLocale()` 在非中文浏览器上返回 `en`（jsdom 的 navigator.language 就是 en-US）。
   * 于是同一屏 = 硬编码的中文 + i18n 出来的英文。
   *
   * 所以判据只有一条：**英文界面下这一页不许出现任何汉字**（桩数据全是 ASCII）。
   */
  test('★ 英文界面下 /models 不许渲染出硬编码中文（两个 Tab 都查）', async () => {
    /*
     * 宿主被 `dom-env.ts:88` 钉死成 zh-CN（那是对的：别的用例断言中文文案），
     * 所以这里**临时**切到 en，用完必还原 —— 不还原会让后面的用例莫名其妙变红。
     */
    await i18nInstance.changeLanguage('en');
    try {
      for (const route of ['/models', '/models?tab=llm']) {
        stubModelsPage({ withCatalog: true });
        const r = await render(<ModelsPage />, { route });
        await r.flush();
        /*
         * ⚠️ 服务商的**品牌名**要摘掉再查：`月之暗面 Kimi` / `智谱 GLM` /
         * `阿里云百炼（通义）` / `硅基流动` 是这些厂商的中文注册名，
         * 英文界面下照写是对的（memo.ac 同样照写），把它们翻译过去反而认不出。
         * 摘的是 `LLM_PRESETS` 里的**数据**，不是我手打的白名单 ——
         * 名单变了这条断言自动跟着变，不会退化成一张过期的例外表。
         * 品牌名归 `llm-catalog.ts` 的 owner，本轮一个字没动。
         */
        let t = text(r.container);
        for (const p of LLM_PRESETS) t = t.split(p.label).join('');
        assert.ok(t.length > 0, `${route}：页面应渲染出内容`);
        const bad = t.match(new RegExp(`.{0,24}${CJK.source}.{0,24}`, 'g'));
        assert.equal(
          bad,
          null,
          `${route}：英文界面上出现了硬编码中文 → ${JSON.stringify(bad?.slice(0, 4))}`,
        );
        r.unmount();
      }
    } finally {
      await i18nInstance.changeLanguage('zh-CN');
    }
  });

  test('★ zh-CN 与 en 的 models.* 词条必须一一对应（少一条就会静默回落成另一种语言）', () => {
    const flat = (o: unknown, p = ''): string[] =>
      typeof o === 'object' && o !== null
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
            flat(v, p ? `${p}.${k}` : k),
          )
        : [p];
    const zh = flat((zhLocale as Record<string, unknown>)['models']).sort();
    const en = flat((enLocale as Record<string, unknown>)['models']).sort();
    assert.ok(zh.length > 60, '词条数明显偏少，八成是没落盘');
    assert.deepEqual(zh, en, 'models.* 两份词条不对称');
  });
});

describe('T-129 `**强调**` 不许把裸 Markdown 吐给用户', () => {
  test('★ 服务端下发的 disclosure 里的 ** 必须渲染成 <strong>，页面上看不到星号', async () => {
    stubApi({
      '/settings': { settings: {} },
      '/secrets': {
        secrets: [],
        disclosure: {
          message: 'API keys are stored in **PLAINTEXT** at /tmp/x/secrets.json.',
          messageZh: 'API Key 以**明文**保存在 /tmp/x/secrets.json。',
        },
      },
    });
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    // 宿主是中文界面（dom-env.ts:88）→ 渲染的是 messageZh 那一支
    const t = text(r.container);
    assert.ok(t.includes('secrets.json'), '告知原文必须仍然完整');
    assert.ok(t.includes('明文'), '"明文"这个词一个字都不许丢');
    assert.ok(!t.includes('**'), `页面上仍能看到裸的 ** → ${t.slice(0, 200)}`);
    const strong = [...r.container.querySelectorAll('strong')].map((e) => e.textContent);
    assert.ok(strong.includes('明文'), '强调段应渲染成 <strong>');
    r.unmount();
  });

  test('★ splitEmphasis 规则', () => {
    assert.deepEqual(splitEmphasis('a**b**c'), [
      { text: 'a', strong: false },
      { text: 'b', strong: true },
      { text: 'c', strong: false },
    ]);
    // 两段强调，中间那段不许被吞成一整块
    assert.deepEqual(
      splitEmphasis('a**b**c**d**e').filter((p) => p.strong).map((p) => p.text),
      ['b', 'd'],
    );
    // 未闭合：原样保留，宁可显示一个星号也不要吃掉半句话
    assert.deepEqual(splitEmphasis('a**b'), [{ text: 'a**b', strong: false }]);
    assert.deepEqual(splitEmphasis(''), []);
  });

  test('★ 词条里还带 ** 的地方必须都有渲染器接着（防下一处又变裸标记）', () => {
    const flat = (o: unknown, p = ''): [string, string][] =>
      typeof o === 'object' && o !== null
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
            flat(v, p ? `${p}.${k}` : k),
          )
        : [[p, String(o)]];
    const withMarkers = flat(zhLocale as unknown)
      .filter(([, v]) => /\*\*[^*]+\*\*/.test(v))
      .map(([k]) => k);
    // 这一条不是"不许再写 **"，而是"写了就得有人渲染" ——
    // 本轮接上的两处必须在名单里，别的属于别的页面（已在回执里列出，未动）。
    assert.ok(
      withMarkers.includes('settings.llmIntro'),
      'settings.llmIntro 应仍带 **（它是被 <Emphasis> 渲染的，不是被删星号的）',
    );
    assert.ok(withMarkers.includes('models.detail.benchNone'));
  });
});

describe('T-129 侧栏「星标」筛选', () => {
  const zhNav = (zhLocale as unknown as { nav: Record<string, string> }).nav;
  const zhNotes = (zhLocale as unknown as { notes: Record<string, string> }).notes;
  const NOTES = {
    notes: [
      {
        uid: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        title: 'starred one',
        status: 'ready',
        kind: 'media',
        language: 'en',
        durationMs: 1000,
        starred: true,
        tags: [],
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        uid: '01BBBBBBBBBBBBBBBBBBBBBBBB',
        title: 'plain one',
        status: 'ready',
        kind: 'media',
        language: 'en',
        durationMs: 1000,
        starred: false,
        tags: [],
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  };

  test('★ /notes?starred=1 只列星标笔记；/notes 列全部', async () => {
    stubApi({ '/notes': NOTES });
    const all = await render(<NotesListPage />, { route: '/notes' });
    await all.flush();
    const allItems = [...all.container.querySelectorAll('[data-testid="notes-list"] > li')];
    assert.equal(allItems.length, 2, '「全部笔记」应列出全部 2 条');
    all.unmount();

    stubApi({ '/notes': NOTES });
    const starred = await render(<NotesListPage />, { route: '/notes?starred=1' });
    await starred.flush();
    const items = [...starred.container.querySelectorAll('[data-testid="notes-list"] > li')];
    assert.equal(
      items.length,
      1,
      '「星标」点进去和「全部笔记」一模一样 —— starred 查询参数没有被读',
    );
    assert.ok(text(starred.container).includes('starred one'));
    assert.ok(
      !text(starred.container).includes('plain one'),
      '未加星的笔记不该出现在星标列表里',
    );
    starred.unmount();
  });

  test('★ 标题必须跟着查询串走，不能两个入口都写「全部笔记」', async () => {
    stubApi({ '/notes': NOTES });
    const r = await render(<NotesListPage />, { route: '/notes?starred=1' });
    await r.flush();
    const title = r.container.querySelector('[data-testid="notes-list-title"]');
    assert.ok(title, '找不到列表标题');
    assert.equal(title!.textContent, zhNav.starred);
    assert.notEqual(title!.textContent, zhNotes.title, '星标页的标题仍写着「全部笔记」');
    r.unmount();
  });

  test('★ 有笔记但一条都没加星时，给星标专属空态（而不是"还没有笔记"）', async () => {
    stubApi({ '/notes': { notes: [NOTES.notes[1]] } });
    const r = await render(<NotesListPage />, { route: '/notes?starred=1' });
    await r.flush();
    const t = text(r.container);
    assert.ok(t.includes(zhNotes.starredEmpty), `空态文案不对：${t}`);
    assert.ok(!t.includes(zhNotes.empty), '不该说"还没有笔记" —— 他明明有笔记');
    r.unmount();
  });
});

/**
 * ★ 同族缺陷：**一个元素的显示条件，必须是它自己的条件。**
 *
 * 两个实例，形状一模一样 —— 嵌套让 A 继承了 B 的消失条件，而 A 与 B 本来毫无关系：
 *
 * | 实例 | A（被连累的） | B（条件的主人） | 后果 |
 * |---|---|---|---|
 * | T-129（本轮） | `/models` 的 Tab 切换条 | `tab === 'asr'` 的目录面板 | 切到「语言模型」后再也切不回来 |
 * | T-127b（`4b6ad6c`） | 顶栏 daemon 版本戳 | `mocked === 0` 的假数据摘要 | **所有面接通那天**版本戳一起消失 |
 *
 * 两条都必须是**渲染断言**，不能只查源码：
 * 结构断言挡得住有人把代码删回去，挡不住渲染层面的其他失效方式
 * （T-127b 修完只留了一条正则查源码的断言，这里把它补成真的渲染）。
 */
describe('T-129 同族：显示条件不许被别人的条件包住', () => {
  /** 逐面设状态 + 装 health，用完还原 —— 这个 store 是模块级单例，不还原会污染别的用例。 */
  async function withSurfaces<T>(
    states: Record<string, 'live' | 'mock'>,
    health: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    const before = useSurfaceStore.getState();
    const prevStates = { ...before.states };
    const prevHealth = before.health;
    for (const [s, v] of Object.entries(states)) {
      useSurfaceStore.getState().set(s as never, v as never);
    }
    useSurfaceStore.getState().setHealth(health as never);
    try {
      return await fn();
    } finally {
      useSurfaceStore.setState({ states: prevStates, health: prevHealth });
    }
  }

  const HEALTH = {
    version: '9.9.9',
    instanceId: '01TESTTESTTESTTESTTESTTEST',
    contractVersion: 1,
    dataDir: '/tmp/never-real',
    port: 65535,
    pid: 1,
    build: {
      commit: 'deadbee',
      commitTime: '2026-08-03T10:00:00.000Z',
      dirty: false,
      builtAt: '2026-08-03T10:05:00.000Z',
      startedAt: '2026-08-03T10:06:00.000Z',
    },
  };

  const allLive = Object.fromEntries(SURFACES.map((s) => [s, 'live' as const]));

  test('★ 所有 API 面都接通（mocked === 0）时，daemon 版本戳仍然渲染', async () => {
    await withSurfaces(allLive, HEALTH, async () => {
      const r = await render(<ConnectivitySummary />);
      await r.flush();
      const shown = text(r.container);
      assert.ok(
        shown.includes('daemon v9.9.9'),
        `全部接通后版本戳消失了 —— 而那正是最需要它的时刻（实际渲染："${shown}"）`,
      );
      // 同时确认前提成立：这一屏确实没有「假数据」摘要，不是"两个都还在"的假通过
      assert.ok(!shown.includes('模拟'), `mocked === 0 时不该再有假数据摘要："${shown}"`);
      r.unmount();
    });
  });

  test('★ 还有面在模拟时，假数据摘要与版本戳两个都在（改法不许把另一半弄丢）', async () => {
    await withSurfaces({ ...allLive, notes: 'mock' }, HEALTH, async () => {
      const r = await render(<ConnectivitySummary />);
      await r.flush();
      const shown = text(r.container);
      assert.ok(shown.includes('daemon v9.9.9'), `版本戳丢了："${shown}"`);
      assert.ok(shown.includes('模拟'), `假数据摘要丢了："${shown}"`);
      r.unmount();
    });
  });

  test('★ daemon 没连上（health === null）时不渲染任何版本戳 —— 不编一个假版本号', async () => {
    await withSurfaces(allLive, null, async () => {
      const r = await render(<ConnectivitySummary />);
      await r.flush();
      assert.equal(text(r.container), '', '连不上 daemon 时这一格应当整块不出现');
      r.unmount();
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * T-132 组件页：未安装的组件必须装得上，而且要发到 daemon 真的在监听的那个地址
 * ════════════════════════════════════════════════════════════════════════════ */
describe('T-132 组件与来源页', () => {
  const YTDLP = {
    id: 'ytdlp-linux-x64',
    displayName: 'yt-dlp site extractor (Linux x64)',
    displayNameZh: 'yt-dlp 站点解析器（Linux x64）',
    category: 'media-tool',
    pinnedVersion: '2026.07.04',
    installedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    checkError: null,
    checkedAt: null,
    provenance: {
      repoUrl: 'https://github.com/yt-dlp/yt-dlp',
      releaseUrl: 'https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04',
      license: 'GPL-3.0-or-later',
      licenseUrl: 'https://www.gnu.org/licenses/gpl-3.0.html',
    },
    upstream: { kind: 'github-release' as const, repo: 'yt-dlp/yt-dlp' },
    sizeBytes: 39924536,
    sha256: '6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae',
    sha256Provenance: null,
    rollbackVersion: null,
  };
  /** npm 依赖：清单里如实写着没有制品，所以它**不该**有安装按钮。 */
  const BUNDLED = {
    ...YTDLP,
    id: 'sherpa-onnx-node',
    displayNameZh: 'sherpa-onnx（流式 ASR / VAD）',
    category: 'backend-pack',
    pinnedVersion: 'v1.13.4',
    sizeBytes: 0,
    sha256: 'n/a',
  };

  /**
   * jsdom 的 `window.confirm` 是"未实现"存根：调用会往 stderr 打一条 Not implemented
   * 并返回 `undefined`（假值）—— 于是被测代码在 `if (!ok) return;` 处静默退出，
   * **一个请求都不会发**，测试看到的是"什么都没发生"而不是"发错了地址"。
   * 必须显式替换，否则这条用例测的是 jsdom 的空实现，不是我们的代码。
   */
  function stubConfirm(answer: boolean): () => void {
    const w = window as unknown as { confirm: (m?: string) => boolean };
    const prev = w.confirm;
    w.confirm = () => answer;
    return () => {
      w.confirm = prev;
    };
  }

  test('★ 未安装的组件有「安装」按钮 —— 以前这里只有"未安装"三个字，没有任何可点的东西', async () => {
    stubApi({ '/components': { components: [YTDLP], online: false, checkedAt: null } });
    const r = await render(<ComponentsPage />);
    await r.flush();
    const btn = r.container.querySelector('[data-testid="component-install-ytdlp-linux-x64"]');
    assert.ok(btn, `未安装的组件没有安装按钮，用户在网页上装不了它：${text(r.container)}`);
    assert.ok((btn.textContent ?? '').includes('2026.07.04'), '按钮要说清装的是哪个版本');
    r.unmount();
  });

  /*
   * ★★ 这条钉的是**发到哪个地址** ★★
   *
   * daemon 的路由是 `POST /api/components/:id/update`；前端此前发的是
   * `POST /api/components/update` + `{ id }` —— 少一段路径，实测 404
   * （`{"code":"NOT_FOUND","message":"no route for POST /api/components/update"}`）。
   * 清单拉得到、卡片渲染正常，只有真按下去才会失败，所以一直没人发现。
   * 断言必须钉"我们发出的 path"，不能只钉"发生了一次请求"。
   */
  test('★ 点安装发到 /components/:id/update（旧的 /components/update 是 404）', async () => {
    const restore = stubConfirm(true);
    try {
      const stub = stubApi({
        '/components': { components: [YTDLP], online: false, checkedAt: null },
        'POST /components/ytdlp-linux-x64/update': {
          ok: true,
          id: 'ytdlp-linux-x64',
          toVersion: '2026.07.04',
          jobId: 'job-1',
          deduplicated: false,
        },
      });
      const r = await render(<ComponentsPage />);
      await r.flush();
      await click(r.container.querySelector('[data-testid="component-install-ytdlp-linux-x64"]'));
      await r.flush();

      const posts = stub.calls.filter((c) => c.method === 'POST');
      assert.deepEqual(
        posts.map((c) => c.path),
        ['/components/ytdlp-linux-x64/update'],
        `安装请求发错地址了：${posts.map((c) => `${c.method} ${c.path}`).join(', ')}`,
      );
      r.unmount();
    } finally {
      restore();
    }
  });

  test('★ 随应用一起装的 npm 组件不画安装按钮（画了也只会拿到 409，比没有更糟）', async () => {
    stubApi({ '/components': { components: [BUNDLED], online: false, checkedAt: null } });
    const r = await render(<ComponentsPage />);
    await r.flush();
    assert.equal(
      r.container.querySelector('[data-testid="component-install-sherpa-onnx-node"]'),
      null,
      '没有下载制品的组件不该有安装按钮',
    );
    assert.ok(
      r.container.querySelector('[data-testid="component-bundled-sherpa-onnx-node"]'),
      '要说清它为什么没有按钮，而不是留一片空白',
    );
    r.unmount();
  });
});

/* ─────────────── T-129b：裸 `**` 的其余实例（Manager 决策 1） ─────────────── */

/**
 * 一张**登记表**，不是白名单。
 *
 * 键 = locale 里仍带 `**…**` 的词条；值 = 它被渲染的源文件（空数组 = 目前**没有**渲染点）。
 * 三条断言合起来的意思是：**写了强调标记，就必须有人负责渲染它**。
 *
 * 为什么用登记表而不是"全仓不许再出现 `**`"：
 * 强调本身是有用的（「明文」「重启后生效」「模型目录」这些词就该跳出来），
 * 禁掉标记等于把这些词降回正文。真正要挡的是**"写了没人渲染"**这个组合。
 */
const EMPHASIS_REGISTRY: Record<string, string[]> = {
  'settings.llmIntro': ['components/common/llm/LlmSettingsSection.tsx'],
  'models.detail.benchNone': ['features/models/ModelDetailPage.tsx'],
  'recorder.paraformerTradeoff': [
    'features/recorder/RecorderPage.tsx',
    'features/transcript/WordLevelBadge.tsx', // title= 属性 → stripEmphasis
  ],
  'settings.dataDir.needRestart': ['features/settings/DataLocationSection.tsx'],
  'settings.dataDir.sizeScopeNote': ['features/settings/DataLocationSection.tsx'],
  'settings.proxy.testUsesSaved': ['features/settings/ProxySettingsSection.tsx'],
  /*
   * T-129b：这句原本是 `RuntimePage.tsx` 里**硬编码**的 JSX 文本，标记就写在源码里
   * —— 也就是说它连"词条"都不是，页面上一直显示着两颗星号。
   * 搬进词条时**保留了标记**并接上 <Emphasis>：「本机实测值」与「估算」正是这句话
   * 要区分的两件事，删掉标记等于把它想说的重点抹平。
   */
  'runtime.rtfNote': ['features/runtime/RuntimePage.tsx'],
  /*
   * ⚠️ 这一条**没有渲染点**，而且不是我漏了 —— 是另一个缺陷：
   * `detectBlockedCapabilities()` 逐项算出了"你具体失去哪几项能力"
   * （`lib/secure-context.ts:60-86`，microphone / webLocks / storage / clipboard），
   * 但 `ReadinessBanner.tsx:103` 只用了 `blocked.length` 去填一个计数文案，
   * **每一项的具体说明连同 `caps.*` 四条词条一起被丢掉了**。
   * 所以这里的 `**` 今天用户看不见 —— 但只要有人把它接出来，就会看见。
   * 已报 Manager（inbox §8）。**不接线也不删词条**：删了等于替那个功能做决定。
   */
  'secureContext.caps.microphone': [],
};

describe('T-129b 写了 `**` 就必须有人渲染它', () => {
  const flat = (o: unknown, p = ''): [string, string][] =>
    typeof o === 'object' && o !== null
      ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k))
      : [[p, String(o)]];

  /*
   * ⚠️ 判据是**"每条带标记的都登记了"**（子集），不是"两份 locale 逐字相同"。
   * 实测两份并不对称，而且那是对的：
   *   - `settings.proxy.testUsesSaved` 中文用 `**已保存**`，英文用全大写 `SAVED`
   *     —— 英文排版本来就用大写做强调，硬塞 `**` 反而不地道；
   *   - `recorder.paraformerTradeoff` 英文干脆没做强调。
   * 要求逐字相同会把这条断言变成"逼别人按中文的排版习惯写英文"，那不是它该管的事。
   * 它要挡的只有一件：**有标记、却没人渲染。**
   */
  test('★ 任何带 `**` 的词条都必须在登记表里（新写一条就得在这里表态）', () => {
    for (const [name, loc] of [
      ['zh-CN', zhLocale],
      ['en', enLocale],
    ] as const) {
      const withMarkers = flat(loc as unknown)
        .filter(([, v]) => /\*\*[^*]+\*\*/.test(v))
        .map(([k]) => k);
      const registered = new Set(Object.keys(EMPHASIS_REGISTRY));
      const orphans = withMarkers.filter((k) => !registered.has(k));
      assert.deepEqual(
        orphans,
        [],
        `${name}.json 里这些词条带 ** 却没登记渲染点 —— 用户会看到裸星号。登记到 EMPHASIS_REGISTRY 里并接上 <Emphasis>`,
      );
    }
  });

  test('★ 登记表里不许留过期条目（词条已经不带 ** 了就该删掉登记）', () => {
    const marked = new Set(
      [...flat(zhLocale as unknown), ...flat(enLocale as unknown)]
        .filter(([, v]) => /\*\*[^*]+\*\*/.test(v))
        .map(([k]) => k),
    );
    const stale = Object.keys(EMPHASIS_REGISTRY).filter((k) => !marked.has(k));
    assert.deepEqual(stale, [], '登记表里这些条目在两份 locale 里都已经不带 ** 了');
  });

  /*
   * ⚠️ 判据是 **import 语句**，不是"源码里出现过 Emphasis 这个词"。
   *
   * 第一版我写的是 `/\bEmphasis\b/.test(src)` —— 反向验证时把 DataLocationSection 的
   * import 和两处 `<Emphasis>` 全撤掉，**它照样绿**：因为我在旁边留的那句注释里
   * 写着"走 <Emphasis>"，正则匹到了注释。
   * **一条断言可以被自己的文档骗过去**，这比没写更坏。
   * 改成断 import 之后：import 在 ⇒ 它一定被用了（未使用的 import 过不了 eslint）。
   */
  test('★ 登记的每个渲染点都必须真的 import Emphasis / stripEmphasis（不是注释里提一句）', async () => {
    for (const [key, files] of Object.entries(EMPHASIS_REGISTRY)) {
      for (const f of files) {
        const src = await readSource(f);
        assert.ok(
          /^import \{[^}]*\b(Emphasis|stripEmphasis)\b[^}]*\} from '[^']*\/Emphasis';$/m.test(src),
          `${f} 渲染了带 ** 的 ${key}，却没有 import Emphasis/stripEmphasis —— 用户会看到裸星号`,
        );
      }
    }
  });

  test('★ 登记为"无渲染点"的词条，必须真的没有任何地方引用（否则就是漏网的裸标记）', () => {
    const unrendered = Object.entries(EMPHASIS_REGISTRY)
      .filter(([, files]) => files.length === 0)
      .map(([k]) => k);
    assert.ok(unrendered.length > 0, '登记表结构变了？');

    const root = `${process.cwd()}/src`;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !p.includes('/test/')) files.push(p);
      }
    };
    walk(root);

    for (const key of unrendered) {
      const hits = files.filter((p) => readFileSync(p, 'utf8').includes(`'${key}'`));
      assert.deepEqual(
        hits,
        [],
        `${key} 在登记表里写着"没有渲染点"，但 ${hits.join(', ')} 引用了它 —— 要么接上 Emphasis，要么更新登记表`,
      );
    }
  });

  test('★ title= 这类属性位置只能脱标记：tooltip 里绝不许出现星号', async () => {
    const r = await render(
      <WordLevelBadge segments={[{ seq: 0, startMs: 0, endMs: 1000, text: 'x', words: [] } as never]} />,
    );
    const badge = r.container.querySelector('span[title]');
    assert.ok(badge, '徽标没渲染出来');
    const title = badge!.getAttribute('title') ?? '';
    assert.ok(title.length > 0, 'tooltip 是空的');
    assert.ok(!title.includes('**'), `tooltip 里出现了裸标记：${title}`);
    // 脱标记是**降级**不是删内容：那句话本身必须还在
    assert.ok(title.includes('没有逐字时间戳'), `文案被吃掉了：${title}`);
    r.unmount();
  });
});

/* ─────────────── T-129b：/runtime 同样不许中英混排（Manager 决策 3） ─────────────── */

/**
 * 和 `/models` 是同一个缺陷的另一半（`ui-polish` 在 T-101 里报的 T-022）：
 * 整页硬编码中文 + 侧栏走 i18n → 英文用户看到"英文外壳 + 中文正文"，
 * 中文用户在非中文浏览器上看到的是反过来的那一半。
 */
describe('T-129b /runtime 不许中英混排', () => {
  const CJK = /[一-鿿]/;

  function stubRuntimePage() {
    return stubApi({
      '/hardware': {
        hardware: {
          detectedAt: '2026-08-03T00:00:00.000Z',
          os: { platform: 'linux', arch: 'x64', version: '6.1' },
          cpu: { brand: 'Stub CPU', physicalCores: 4, logicalCores: 8, features: ['avx2'] },
          ram: { totalMB: 16000, availableMB: 8000 },
          gpus: [],
          selectedGpuIndex: null,
          unifiedMemory: false,
          disks: [{ path: '/tmp/stub', pathFor: 'models_root', freeMB: 10000, totalMB: 50000 }],
          backends: [
            { id: 'cpu', installed: true, available: true, unavailableReason: null },
            { id: 'cuda', installed: false, available: false, unavailableReason: 'probe not found' },
          ],
          selectedBackend: 'cpu',
        },
      },
      '/backends/catalog': {
        stale: false,
        packs: [
          {
            id: 'whispercpp-cpu-linux-x64',
            backend: 'cpu',
            engine: 'whisper.cpp',
            engineVersion: '1.7.0',
            os: 'linux',
            arch: 'x64',
            tier: 'builtin',
            // ★ 真实形状：manifest 里 15 个包**每个都同时有**这两个字段
            displayName: 'whisper.cpp — CPU (Linux x64)',
            displayNameZh: 'whisper.cpp · CPU 后端（Linux x64）',
            totalSizeBytes: 9_400_000,
            installed: true,
            applicable: true,
            recommended: true,
            priority: 10,
            requiresDriver: null,
            inapplicableReason: null,
          },
          {
            id: 'whispercpp-cuda-win-x64',
            backend: 'cuda',
            engine: 'whisper.cpp',
            engineVersion: '1.7.0',
            os: 'win32',
            arch: 'x64',
            tier: 'optional',
            displayName: 'whisper.cpp — CUDA (Windows x64)',
            displayNameZh: 'whisper.cpp · CUDA 后端（Windows x64）',
            totalSizeBytes: 120_000_000,
            installed: false,
            applicable: false,
            recommended: false,
            priority: 5,
            requiresDriver: { nvidiaDriver: '535' },
            inapplicableReason: 'built for win32/x64',
          },
        ],
      },
      '/backends/installed': {
        selectedBackend: 'cpu',
        packs: [
          {
            id: 'whispercpp-cpu-linux-x64',
            selfTest: {
              passed: true,
              devicesFound: 1,
              rtf: 0.38,
              ranAt: '2026-08-03T00:00:00.000Z',
              errorMessage: null,
            },
          },
        ],
      },
    });
  }

  test('★ 英文界面下 /runtime 不许渲染出硬编码中文', async () => {
    await i18nInstance.changeLanguage('en');
    try {
      stubRuntimePage();
      const r = await render(<RuntimePage />, { route: '/runtime' });
      await r.flush();
      const shown = text(r.container);
      assert.ok(shown.length > 0, '页面应渲染出内容');
      const bad = shown.match(new RegExp(`.{0,24}${CJK.source}.{0,24}`, 'g'));
      assert.equal(
        bad,
        null,
        `英文界面上出现了硬编码中文 → ${JSON.stringify(bad?.slice(0, 4))}`,
      );
      r.unmount();
    } finally {
      await i18nInstance.changeLanguage('zh-CN');
    }
  });

  test('★ RTF 那句提示不许把裸 ** 吐给用户（它原本是硬编码在 JSX 里的）', async () => {
    stubRuntimePage();
    const r = await render(<RuntimePage />, { route: '/runtime' });
    await r.flush();
    const shown = text(r.container);
    assert.ok(!shown.includes('**'), `页面上仍能看到裸的 ** → ${shown.slice(-260)}`);
    const strong = [...r.container.querySelectorAll('strong')].map((e) => e.textContent);
    assert.ok(
      strong.includes('本机实测值') && strong.includes('估算'),
      `「实测」与「估算」应渲染成 <strong>，实际 strong = ${JSON.stringify(strong)}`,
    );
    r.unmount();
  });
});
