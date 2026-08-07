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

import { useState } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useLocation } from 'react-router';

import { TagEditor } from '../features/notes/TagEditor';
import { NoteActionsMenu } from '../features/notes/NoteActionsMenu';
import { useMoveNoteMutation } from '../features/folders/api';
import { SearchBox } from '../features/search/SearchBox';
import { JobList } from '../features/tasks/JobList';
import { LlmSettingsSection } from '../components/common/llm/LlmSettingsSection';
import { buildLlmSettingsPatch, LLM_PURPOSES_KEY } from '../components/common/llm/api';
import {
  CATALOG_PRESETS,
  LLM_CATALOG_STATS,
  WIRE_KIND_BY_CATALOG_KIND,
  adapterBaseUrl,
  baseUrlFieldMode,
  catalogProviderFor,
  presetConfigFor,
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
import { ErrorBlock, resolveErrorText } from '../components/common/ErrorBlock';
import { ASR_ENGINE_IDS } from '@openmemo/shared';
import { ASR_ENGINE_LABELS, isValidAsrLanguage } from '../lib/asr';
import { AsrModelPicker } from '../components/common/AsrModelPicker';
import { AsrEngineStatus } from '../components/common/AsrEngineStatus';
import { useImportUrlMutation } from '../features/notes';
import { DataLocationSection, StaleLinksWarning } from '../features/settings/DataLocationSection';
import { RetranscribeButton, isSegmentEdited } from '../features/notes/RetranscribeButton';
import { WordLevelBadge } from '../features/transcript';
import { WordHighlight, findActiveWord } from '../features/transcript/WordHighlight';
import { DEFAULT_PROXY_CONFIG, LLM_SETTING_KEYS, MAINSTREAM_PROVIDER_IDS, PROVIDER_KINDS } from '@openmemo/shared';
import { ProxySettingsSection } from '../features/settings/ProxySettingsSection';
import ComponentsPage from '../features/components/ComponentsPage';
import { getPositionMs, setPositionMs, subscribePosition, usePlayerStore } from '../lib/stores/player.store';
import { MindmapExportMenu } from '../features/mindmap/MindmapExportMenu';
import NoteDetailPage from '../features/notes/NoteDetailPage';
import { Route, Routes } from 'react-router';
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
import { SourcesSection } from '../features/models/components/SourcesSection';
import App from '../App';
import { GenerateMindmapButton } from '../features/mindmap/GenerateMindmapButton';
import { MindmapView } from '../features/mindmap/MindmapView';
import type { MindMapDoc } from '@openmemo/mindmap';
import type { PipelineJob } from '@openmemo/shared';
import RuntimePage from '../features/runtime/RuntimePage';
import { BackendPackCard } from '../features/runtime/components/BackendPackCard';
import { isMeaningfulRecommendation } from '../features/runtime/packStatus';
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
  /*
   * ⚠️ **这条断言换过一次方向，说明一下免得下一个人以为是弄丢了**（HANDOFF ⑤A-15 的做法）。
   *
   * 旧版断的是写死的 `LLM_PRESETS` 里 `tier==='online'` 排在 `'local'` 前面 ——
   * 那张写死清单在 T-150 已经**整个作废**（D-10 #24 / R-P1：24 家 > 11 家）。
   * 「在线优先」这条取向没有变，只是它的出处换成了目录的 `MAINSTREAM_PROVIDER_IDS`
   * （openai → claude → gemini → deepseek → ollama → lmstudio，与 memo.ac 那份数组逐字相同），
   * 本地两家天然排在置顶六家的**最后两位**。所以判据改成断那个顺序。
   */
  test('★ 在线优先：置顶六家里本地服务排在最后（ADR-016）', () => {
    const pinned = MAINSTREAM_PROVIDER_IDS;
    const localIds = new Set(
      CATALOG_PRESETS.filter((p) => p.config?.isLocal).map((p) => p.spec.id),
    );
    assert.ok(localIds.size > 0, '前提不成立：目录里一个本地服务都认不出来');
    const firstLocal = pinned.findIndex((id) => localIds.has(id));
    assert.ok(firstLocal > 0, '默认答案不该是本地');
    // 第一个本地之后不许再出现在线的 —— 本地必须是连续的尾巴
    for (let i = firstLocal; i < pinned.length; i++) {
      assert.ok(localIds.has(pinned[i]!), `置顶顺序里 ${pinned[i]} 排在本地服务后面`);
    }
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
   * 它上一版的注释里写着「目录 24 家 / 520 条，能进下拉的只有写死的 11 家 …
   * 剩下 13 家 237 条用户根本加不进来 —— 那是 D-10 #24，本轮没做」。
   * **T-150 把 #24 做了**，所以这条断言的范围从"11 个预设"扩到"整份目录"。
   *
   * 它锁死的性质没变，而且现在管得更宽：**任何一家都不许是空清单**。
   * 预设 id 与目录 id 对不上（`anthropic`≠`claude` 等）时，用户打开下拉会看到零个候选，
   * 看起来像"我们不支持这家" —— 加预设的人不会想到去核对目录 id，所以让测试去核对。
   */
  test('★ 目录里每一家都必须有候选 —— id 对不上就是一个空下拉', () => {
    const empty = CATALOG_PRESETS.filter(
      (p) => (catalogProviderFor(p.spec.id)?.models.length ?? 0) === 0,
    );
    assert.deepEqual(
      empty.map((p) => p.spec.id),
      [],
      '这些服务商在目录里找不到模型（多半是 id 不一致），下拉会是空的',
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
        for (const p of CATALOG_PRESETS) t = t.split(p.spec.displayName).join('');
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

  /**
   * ⚠️ **T-138 ③ 改写了这三条的桩，说明原委**（"旧断言写错了方向"是本项目的老账，
   * 所以这里写清楚哪一半是修正、哪一半原样保留）。
   *
   * T-129 那版是**前端过滤**：只打 `GET /notes`，拿回整页再 `filter(n => n.starred)`。
   * 用例因此只需要一个 `/notes` 桩，断言"渲染出来的条数变少了"。
   * 那一半仍然成立，**但它挡不住真正的缺陷** —— 列表是 `limit=50` 的一页，
   * 第 51 条之外的星标笔记会被无声地漏掉，而用例喂的永远是 2 条。
   *
   * 现在筛选在端点里（`GET /api/notes?starred=1`，daemon 的 SQL WHERE），于是桩必须分成两条：
   * **两条桩返回不同的内容，是这组用例唯一的红灯来源** ——
   * 前端如果不带那个查询串，就会命中 `/notes` 那条桩、拿到全部 2 条，条数断言当场变红。
   */
  const STARRED_ONLY = { notes: [NOTES.notes[0]] };

  test('★ /notes?starred=1 只列星标笔记；/notes 列全部', async () => {
    const a = stubApi({ '/notes': NOTES, '/notes?starred=1': STARRED_ONLY });
    const all = await render(<NotesListPage />, { route: '/notes' });
    await all.flush();
    const allItems = [...all.container.querySelectorAll('[data-testid="notes-list"] > li')];
    assert.equal(allItems.length, 2, '「全部笔记」应列出全部 2 条');
    assert.equal(
      a.calls.some((c) => c.path === '/notes?starred=1'),
      false,
      '「全部笔记」不该带 starred 参数 —— 带了就意味着两个入口共用一条查询',
    );
    all.unmount();

    const b = stubApi({ '/notes': NOTES, '/notes?starred=1': STARRED_ONLY });
    const starred = await render(<NotesListPage />, { route: '/notes?starred=1' });
    await starred.flush();
    /*
     * 先断"请求带上了参数"再断"渲染结果"。
     * 只断渲染结果的话，一个"前端拿全部再自己过滤"的实现同样能通过 ——
     * 而那正是这次要换掉的东西（它在 50 条之后会漏，且漏得无声无息）。
     */
    assert.equal(
      b.calls.some((c) => c.method === 'GET' && c.path === '/notes?starred=1'),
      true,
      `星标页必须把筛选交给端点（实际请求：${JSON.stringify(b.calls.map((c) => c.path))}）` +
        ' —— 在前端筛只能筛已取回的那一页，笔记超过 limit 之后会静默漏掉',
    );
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
    stubApi({ '/notes': NOTES, '/notes?starred=1': STARRED_ONLY });
    const r = await render(<NotesListPage />, { route: '/notes?starred=1' });
    await r.flush();
    const title = r.container.querySelector('[data-testid="notes-list-title"]');
    assert.ok(title, '找不到列表标题');
    assert.equal(title!.textContent, zhNav.starred);
    assert.notEqual(title!.textContent, zhNotes.title, '星标页的标题仍写着「全部笔记」');
    r.unmount();
  });

  test('★ 有笔记但一条都没加星时，给星标专属空态（而不是"还没有笔记"）', async () => {
    // 端点筛完是空的；`/notes` 那条桩仍有一条，用来区分"没有笔记"与"没有星标笔记"
    stubApi({ '/notes': { notes: [NOTES.notes[1]] }, '/notes?starred=1': { notes: [] } });
    const r = await render(<NotesListPage />, { route: '/notes?starred=1' });
    await r.flush();
    const t = text(r.container);
    assert.ok(t.includes(zhNotes.starredEmpty), `空态文案不对：${t}`);
    assert.ok(!t.includes(zhNotes.empty), '不该说"还没有笔记" —— 他明明有笔记');
    r.unmount();
  });

  /**
   * ★ 星标页上点星星，请求必须真的发出去。
   *
   * 乐观更新之后缓存该怎么变（星标页要不要把它移出去）**不在这里断言** ——
   * 那条规则被抽成了纯函数 `lib/api/notesCache.ts`，由单测逐条钉。
   * 原因是诚实的：在组件里断言它必须"抢在 onSettled 的重取回来之前"看一眼，
   * 那是一条依赖时序的用例，绿说明不了什么、红也未必是产品坏了。
   * 这里只钉**组件确实把动作发出去了**这一半（它不依赖时序）。
   */
  test('★ 星标页上的星标按钮仍然是真的写入路径（PUT 真的发出去了）', async () => {
    const s = stubApi({
      '/notes': NOTES,
      '/notes?starred=1': STARRED_ONLY,
      'PUT /notes/01AAAAAAAAAAAAAAAAAAAAAAAA/star': { uid: '01AAAAAAAAAAAAAAAAAAAAAAAA', starred: false },
    });
    const r = await render(<NotesListPage />, { route: '/notes?starred=1' });
    await r.flush();
    assert.equal(
      r.container.querySelectorAll('[data-testid="notes-list"] > li').length,
      1,
      '前置条件：星标页此刻应有 1 条',
    );

    await click(r.container.querySelector('button[aria-pressed="true"]'));
    await r.flush();
    const put = s.calls.find((c) => c.method === 'PUT');
    assert.ok(put, `星标按钮没有发出任何写请求（实际请求：${JSON.stringify(s.calls.map((c) => `${c.method} ${c.path}`))}）`);
    assert.equal(put!.path, '/notes/01AAAAAAAAAAAAAAAAAAAAAAAA/star');
    assert.deepEqual(put!.body, { starred: false }, '点的是已加星的那条，应该是取消星标');
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

  /**
   * ★ T-157 ②：**「旧版本会保留，出问题可以一键回滚」是假话，而它每次点更新都会说。**
   *
   * 三处同时坏着：`stashForRollback` 零调用方（`.prev-` 目录从没被创建过）、
   * `readRollbackVersions` 用目录名建索引而 `listComponents` 用组件 id 查表
   * （这台机器上 4 个里 3 个对不上）、`rollback()` 也按 id 拼路径。
   * 于是 `rollbackVersion` 恒为 null，那个回滚按钮**一次都没渲染过** ——
   * 用户唯一能接触到的"回滚"，就是这句承诺。
   *
   * 判据钉的是**送到用户眼前的那串字**，不是"页面上有没有出现回滚两个字"。
   */
  const INSTALLED_WITH_UPDATE = {
    ...YTDLP,
    installedVersion: '2026.06.01',
    latestVersion: '2026.07.04',
    updateAvailable: true,
  };

  /** 替换 confirm 并把它收到的那句话录下来。 */
  function captureConfirm(answer: boolean): { messages: string[]; restore: () => void } {
    const w = window as unknown as { confirm: (m?: string) => boolean };
    const prev = w.confirm;
    const messages: string[] = [];
    w.confirm = (m?: string) => {
      messages.push(String(m ?? ''));
      return answer;
    };
    return { messages, restore: () => { w.confirm = prev; } };
  }

  test('★ 更新确认框不许承诺"可以一键回滚"—— 那件事在代码里被保证永远做不到', async () => {
    const cap = captureConfirm(false);
    try {
      stubApi({ '/components': { components: [INSTALLED_WITH_UPDATE], online: false, checkedAt: null } });
      const r = await render(<ComponentsPage />);
      await r.flush();
      await click(r.container.querySelector('[data-testid="component-update-ytdlp-linux-x64"]'));
      await r.flush();

      assert.equal(cap.messages.length, 1, `确认框没被调用（拿到 ${cap.messages.length} 次）—— 这条用例就什么都没验`);
      const msg = cap.messages[0] as string;
      assert.equal(
        /回滚/.test(msg),
        false,
        `更新确认框仍在承诺回滚，而回滚在代码里被保证永远不可用：\n${msg}`,
      );
      assert.equal(
        /无法回退/.test(msg),
        true,
        `没有把"更新成功之后回不去"说出来 —— 用户会在不知情的前提下点下去：\n${msg}`,
      );
      r.unmount();
    } finally {
      cap.restore();
    }
  });

  test('★ 卡片上不许再出现回滚按钮（它此前恒不渲染，是一张空头支票的另一半）', async () => {
    stubApi({
      '/components': {
        // 连 daemon 真的报了 rollbackVersion 都不许画 —— 今天没有任何东西会产出它，
        // 画出来点下去只会拿到 409。要恢复它，先做完 components.ts 上写的四件事。
        components: [{ ...INSTALLED_WITH_UPDATE, rollbackVersion: '2026.06.01' }],
        online: false,
        checkedAt: null,
      },
    });
    const r = await render(<ComponentsPage />);
    await r.flush();
    /*
     * ⚠️ 先证明这条"不存在"断言不是空的：同一张卡上的**更新**按钮必须在。
     * 缺了这一句，卡片根本没渲染出来时它照样绿 —— ⑤A 那一族，一条永远不会失败的断言。
     */
    assert.equal(
      r.container.querySelector('[data-testid="component-update-ytdlp-linux-x64"]') === null,
      false,
      '卡片本身就没渲染出来 —— 下面那条"没有回滚按钮"于是什么都没验',
    );
    assert.equal(
      r.container.querySelector('[data-testid="component-rollback-ytdlp-linux-x64"]') === null,
      true,
      '回滚按钮又回来了 —— 它对应的备份从来没有被任何代码创建过',
    );
    r.unmount();
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
  /* T-153：D-10 #3「本地模型」折叠组的两句说明（`POST /api/llm/detect` 的消费方）。 */
  'settings.local.intro': ['components/common/llm/LocalLlmSection.tsx'],
  'settings.local.falsePositiveNote': ['components/common/llm/LocalLlmSection.tsx'],
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
  /* T-157 ④：「优先」不是「只用」—— 这一句要防的正是"以为自己关掉了别的源"。 */
  'models.sources.hint': ['features/models/components/SourcesSection.tsx'],
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
      /*
       * ⚠️ T-165 订正：这个键原来写的是 `'/hardware'`，而 `useHardwareQuery()` 打的是
       * **`/runtime/hardware`**（T-153 把它提升到 `lib/api/hardware.ts` 时换的路径）。
       * 于是这份桩**一次都没命中过** → 查询 404 → `hw` 恒为 undefined →
       * `<HardwareCard>` 在这两条用例里**从来没有被渲染过**。
       * 下面那条"英文界面不许出现中文"因此一直在一个缺了一大块的页面上通过。
       * （HANDOFF ⑤A-18 的同一形状：断言跑过了，但跑的不是它以为的那段。）
       */
      '/runtime/hardware': {
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

  /**
   * ★ T-165 补的**探针的探针**。
   *
   * 上面两条用的桩里，硬件那一格的键写的是 `/hardware`，而 `useHardwareQuery()`
   * 打的是 `/runtime/hardware` —— 桩**一次都没命中过**，`<HardwareCard>` 因此
   * 在这两条用例里从来没有被渲染过。也就是说「/runtime 不许中英混排」这条
   * 一直只覆盖了页面的一部分，而**少覆盖的那部分不会有任何东西告诉你**。
   *
   * 这条前提自检钉的就是"桩真的接上了"：断的是硬件卡里那些**只可能来自桩数据**
   * 的字段，不是"页面渲染出来了"。
   */
  test('前提自检：硬件卡真的渲染了（桩键写错时它是静默不渲染的）', async () => {
    stubRuntimePage();
    const r = await render(<RuntimePage />, { route: '/runtime' });
    await r.flush();
    const shown = text(r.container);
    assert.ok(shown.includes('你的硬件'), `硬件卡没渲染 —— 桩没命中 → ${shown.slice(0, 200)}`);
    assert.ok(shown.includes('Stub CPU'), `渲染的不是桩给的那台机器 → ${shown.slice(0, 300)}`);
    r.unmount();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * T-135 —— 三条「算出来了 / 数据齐了，却没给出去」
 *
 * 这三条是同一个形状的三种形态，都不是"文案没写好"：
 *   ① `secureContext.caps.*`：逐项算出来了，渲染时只取了 `.length`
 *   ② `purposeZh`：daemon 只给了一份中文，前端**没有可回落的东西**
 *   ③ `displayNameZh`：两份都在手上，渲染时写死挑了中文那一份
 * 判据统一是：**信息在系统里存在，用户却拿不到。**
 * ════════════════════════════════════════════════════════════════════════════ */

describe('T-135 ① 安全上下文：逐项说明必须真的渲染出来', () => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const win = globalThis.window as unknown as Record<string, unknown>;
  let saved: Record<string, unknown> = {};

  /**
   * 造一个 `http://<IP>` 的浏览器。
   * （与上面「非安全上下文」那组同型，刻意各写一份：两组的生命周期互不干扰，
   *   共用一份可变的 `saved` 反而会在并发/失败时互相污染。）
   */
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
      Object.defineProperty(k === 'isSecureContext' ? win : nav, k, { value: v, configurable: true });
    }
  }

  const HEALTHY = {
    'GET /health': { db: { extensions: { libsimple: true, sqliteVec: true } }, pipeline: { missing: [] } },
  };

  /** 展开横幅，返回明细区。 */
  async function openBanner() {
    stubApi(HEALTHY);
    const r = await render(<ReadinessBanner />);
    await r.flush();
    await click(r.container.querySelector('[data-testid="readiness-toggle"]'));
    await r.flush();
    return r;
  }

  /**
   * ★ 这条钉的是「信息算出来了又扔掉」。
   *
   * `detectBlockedCapabilities()` 逐项算出了"你具体失去哪几项能力"，
   * 而横幅此前**只用了 `blocked.length`**：用户看到「有 3 项能力不可用」，
   * 却看不到是哪 3 项 —— 而四项里只有「麦克风」是**功能级不可用**
   * （F3 录音在这个地址下根本跑不了），其余三项只是体验降级。
   * 一个数字回答不了"我到底还能不能用它"，而那正是用户唯一要问的问题。
   */
  test('★ 展开后逐项列出失去的能力，且与 detectBlockedCapabilities() 逐条对齐', async () => {
    makeInsecure();
    try {
      const blocked = detectBlockedCapabilities();
      assert.ok(blocked.length >= 3, `前提不成立：只算出 ${blocked.length} 项`);

      const r = await openBanner();
      const caps = r.container.querySelector('[data-testid="readiness-caps-secure-context"]');
      assert.ok(caps, '展开后没有任何逐项明细 —— 计数之外一个字都没有');

      // 只取说明本身，不含那颗装饰用的项目符号（它是 aria-hidden 的）
      const rows = [...caps.querySelectorAll('li')].map(
        (li) => li.querySelector('span:not([aria-hidden])')?.textContent ?? '',
      );
      assert.equal(
        rows.length,
        blocked.length,
        `算出 ${blocked.length} 项、只渲染了 ${rows.length} 行：${JSON.stringify(rows)}`,
      );

      // 逐条比对**词条本身**，而不是我手打的一句话 —— 词条改了断言自动跟着改
      const caps4 = (zhLocale as unknown as { secureContext: { caps: Record<string, string> } })
        .secureContext.caps;
      blocked.forEach((c, i) => {
        const expected = (caps4[c.key] ?? '').replace(/\*\*/g, '');
        assert.ok(expected.length > 0, `secureContext.caps.${c.key} 词条不存在`);
        assert.equal(rows[i], expected, `第 ${i + 1} 行不是 caps.${c.key}`);
      });

      // 顺序即优先级：麦克风是唯一功能级不可用的一项，必须在最前
      assert.equal(blocked[0]?.key, 'microphone', '麦克风不在第一项');
      r.unmount();
    } finally {
      restore();
    }
  });

  /**
   * 词条里的 `**录音转文字不可用**` 是写文案的人挑出来的重点。
   * 直接吐给用户就是两颗裸星号；删掉标记又会把"这一项是功能级不可用"
   * 降回和其余三项一样平 —— 所以只能渲染它（`Emphasis.tsx` 的原话）。
   */
  test('★ 麦克风那条的 ** 必须渲染成 <strong>，页面上看不到裸星号', async () => {
    makeInsecure();
    try {
      const r = await openBanner();
      const shown = text(r.container);
      assert.ok(!shown.includes('**'), `页面上仍能看到裸的 ** → ${shown.slice(0, 200)}`);
      const strong = [...r.container.querySelectorAll('strong')].map((e) => e.textContent);
      assert.ok(
        strong.includes('录音转文字不可用'),
        `「录音转文字不可用」应渲染成 <strong>，实际 strong = ${JSON.stringify(strong)}`,
      );
      r.unmount();
    } finally {
      restore();
    }
  });

  /**
   * 加明细不许把 T-107 那条约束吃掉：**折叠态仍然只占一行**。
   * 「七行文字不是动作，是墙」—— 逐项说明属于展开态。
   */
  test('★ 折叠态一个字都不许多 —— 明细只在展开后出现', async () => {
    makeInsecure();
    try {
      stubApi(HEALTHY);
      const r = await render(<ReadinessBanner />);
      await r.flush();
      assert.ok(
        !r.container.querySelector('[data-testid="readiness-caps-secure-context"]'),
        '折叠态就把逐项明细铺出来了',
      );
      assert.ok(!text(r.container).includes('麦克风'), '原因属于展开态，不该占首屏');
      r.unmount();
    } finally {
      restore();
    }
  });

  /**
   * ⚠️ 判据是 **import 语句**，不是"源码里出现过 Emphasis 这个词"。
   * 上一轮 `models-page-fix` 写 `/\bEmphasis\b/.test(src)`，结果匹到了
   * 自己旁边注释里的那句「走 `<Emphasis>`」—— 一条断言被自己的文档骗过去了。
   */
  test('★ ReadinessBanner 必须真的 import Emphasis（注释里提一句不算）', async () => {
    const src = await readSource('components/common/ReadinessBanner.tsx');
    // ⚠️ 用 assert.ok(regex.test(...))，不用 assert.match ——
    // 后者失败时会把**整份源码**打进报告，几十 KB 的噪声会盖掉真正的结论。
    assert.ok(
      /^import \{[^}]*\bEmphasis\b[^}]*\} from '[^']*\/Emphasis';$/m.test(src),
      '没有 import Emphasis —— 词条里的 ** 会原样吐给用户',
    );
    assert.ok(
      /details:\s*blocked\.map/.test(src),
      '逐项说明没有从 detectBlockedCapabilities() 接出来',
    );
  });
});

describe('T-135 ② 数据目录用途：daemon 必须给成对的 purpose / purposeZh', () => {
  /**
   * 桩用**目录的真实形状**（两份都给），否则测到的只有"我们自己的文案"。
   * 上一轮的教训：原来的桩全是 ASCII，`displayNameZh` 那条缺陷因此测不出来。
   */
  const DATA_DIR = {
    'GET /health': { dataDir: '/tmp/omdemo' },
    'GET /settings/data-dir': {
      dataDir: '/tmp/omdemo',
      usage: { bytes: 1234, files: 7 },
      entries: [
        {
          path: '/tmp/omdemo/openmemo.db',
          name: 'openmemo.db',
          purpose: 'Notes, transcripts, tags and mindmaps (the main SQLite database)',
          purposeZh: '笔记、转写稿、标签、导图（SQLite 主库）',
        },
        {
          path: '/tmp/omdemo/logs',
          name: 'logs',
          purpose: 'Runtime logs (safe to delete at any time)',
          purposeZh: '运行日志（可随时删）',
        },
      ],
    },
  };

  const CJK = /[一-鿿]/;

  test('★ 英文界面下目录清单不许出现汉字 —— 它此前是 /settings 上 81 个汉字的来源', async () => {
    await i18nInstance.changeLanguage('en');
    try {
      stubApi(DATA_DIR);
      const r = await render(<DataLocationSection />);
      await r.flush();
      const box = r.container.querySelector<HTMLElement>('[data-testid="data-dir-layout"]');
      assert.ok(box, '目录清单没渲染 —— 前提不成立');
      const shown = text(box);
      const bad = shown.match(new RegExp(`.{0,24}${CJK.source}.{0,24}`, 'g'));
      assert.equal(bad, null, `英文界面上出现了 daemon 下发的中文 → ${JSON.stringify(bad?.slice(0, 3))}`);
      assert.ok(shown.includes('Runtime logs'), `英文用途没渲染出来：${shown}`);
      r.unmount();
    } finally {
      await i18nInstance.changeLanguage('zh-CN');
    }
  });

  test('★ 中文界面下仍然是中文（回落方向不许反过来）', async () => {
    stubApi(DATA_DIR);
    const r = await render(<DataLocationSection />);
    await r.flush();
    const box = r.container.querySelector<HTMLElement>('[data-testid="data-dir-layout"]');
    assert.ok(box, '目录清单没渲染 —— 前提不成立');
    const shown = text(box);
    assert.ok(shown.includes('运行日志'), `中文界面上该显示中文用途：${shown}`);
    assert.ok(!shown.includes('Runtime logs'), `中文界面上不该出现英文用途：${shown}`);
    r.unmount();
  });

  /**
   * ★ 老 daemon 只会给 `purposeZh`。那时**中文才是唯一有的那一份**，
   * 显示它远好过显示一片空白 —— `pickLocalized` 的空串回落就是为这个写的。
   * 前端可以比 daemon 新，这条把那个前提钉住。
   */
  test('★ daemon 没有 purpose 字段时回落到中文，而不是渲染出一片空白', async () => {
    await i18nInstance.changeLanguage('en');
    try {
      stubApi({
        'GET /health': { dataDir: '/tmp/omdemo' },
        'GET /settings/data-dir': {
          dataDir: '/tmp/omdemo',
          usage: null,
          entries: [{ path: '/tmp/omdemo/logs', name: 'logs', purposeZh: '运行日志（可随时删）' }],
        },
      });
      const r = await render(<DataLocationSection />);
      await r.flush();
      const box = r.container.querySelector<HTMLElement>('[data-testid="data-dir-layout"]');
      assert.ok(box, '目录清单没渲染 —— 前提不成立');
      const shown = text(box);
      assert.ok(shown.includes('运行日志'), `缺英文时必须回落到中文，实际：${JSON.stringify(shown)}`);
      r.unmount();
    } finally {
      await i18nInstance.changeLanguage('zh-CN');
    }
  });

  /**
   * ⚠️ 这条与 daemon 侧的 `apps/daemon/src/http/storageLayout.test.ts` 是**一对**。
   * 只测前端等于只测"我发了什么"：桩里写着 `purpose`，daemon 真的给不给是另一回事
   * —— 本项目「写得进读不回」出过五次，全是这个形状。
   */
  test('★ 前端确实走了 pickLocalized，而不是又写死一份', async () => {
    const src = await readSource('features/settings/DataLocationSection.tsx');
    assert.ok(
      /^import \{[^}]*\bpickLocalized\b[^}]*\} from '[^']*\/localized';$/m.test(src),
      '没有 import pickLocalized',
    );
    assert.ok(
      !/\{e\.purposeZh\}/.test(src),
      '仍有地方直接渲染 e.purposeZh —— 英文界面会退回中文',
    );
  });
});

describe('T-135 ③ 组件卡片：displayNameZh 是两份里的一份，不是唯一那份', () => {
  /** 目录里的真实形状：8 条组件**每一条**都同时有 displayName / displayNameZh。 */
  const COMP = {
    id: 'libsimple-linux-x64',
    displayName: 'libsimple Chinese FTS5 tokenizer (Linux x64)',
    displayNameZh: '中文分词器 libsimple（Linux x64）',
    category: 'sqlite-ext',
    pinnedVersion: 'v0.5.2',
    installedVersion: 'v0.5.2',
    latestVersion: 'v0.5.2',
    updateAvailable: false,
    checkError: null,
    checkedAt: null,
    provenance: {
      repoUrl: 'https://github.com/wangfenjin/simple',
      releaseUrl: 'https://github.com/wangfenjin/simple/releases/tag/v0.5.2',
      license: 'MIT',
      licenseUrl: 'https://opensource.org/licenses/MIT',
    },
    upstream: { kind: 'github-release' as const, repo: 'wangfenjin/simple' },
    sizeBytes: 1_234_567,
    sha256: 'aa'.repeat(32),
    sha256Provenance: null,
    rollbackVersion: null,
  };

  test('★ 英文界面下卡片标题用 displayName，不是 displayNameZh', async () => {
    await i18nInstance.changeLanguage('en');
    try {
      stubApi({ '/components': { components: [COMP], online: false, checkedAt: null } });
      const r = await render(<ComponentsPage />);
      await r.flush();
      const h3 = r.container.querySelector(
        '[data-testid="component-card-libsimple-linux-x64"] h3',
      );
      assert.ok(h3, '组件卡片没渲染出来 —— 前提不成立');
      assert.equal(
        h3.textContent,
        COMP.displayName,
        '英文界面上仍然显示中文名 —— 英文版一直就在目录里，只是没被挑出来',
      );
      r.unmount();
    } finally {
      await i18nInstance.changeLanguage('zh-CN');
    }
  });

  test('★ 中文界面下仍然是中文名（这一半不许被改坏）', async () => {
    stubApi({ '/components': { components: [COMP], online: false, checkedAt: null } });
    const r = await render(<ComponentsPage />);
    await r.flush();
    const h3 = r.container.querySelector('[data-testid="component-card-libsimple-linux-x64"] h3');
    assert.equal(h3?.textContent, COMP.displayNameZh);
    r.unmount();
  });

  test('★ ComponentCard 真的 import 了 localizedName（不是注释里提一句）', async () => {
    const src = await readSource('features/components/components/ComponentCard.tsx');
    assert.ok(
      /^import \{[^}]*\blocalizedName\b[^}]*\} from '[^']*\/localized';$/m.test(src),
      '没有 import localizedName',
    );
    assert.ok(!/\{c\.displayNameZh\}/.test(src), '仍有地方直接渲染 c.displayNameZh');
  });
});

/* ────────────────────────── T-138 三条「代码写了但用户到不了」 ────────────────────────── */

/** 一条流水线 job，形状与 daemon 的 `PipelineJob` 一致（`GET /api/jobs` 就是这么发的）。 */
function pipelineJob(over: Partial<PipelineJob> & { noteUid: string }): PipelineJob {
  return {
    jobId: 'job_1',
    kind: 'transcribe',
    type: 'transcribe',
    displayName: 'demo note',
    state: 'running',
    step: 'asr',
    progress: 0.42,
    attempt: 0,
    maxAttempts: 5,
    error: null,
    blockedCode: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

describe('T-138 ① 思维导图的生成入口', () => {
  const NOTE = '01AAAAAAAAAAAAAAAAAAAAAAAA';
  const zhMindmap = (zhLocale as unknown as { mindmap: Record<string, string> }).mindmap;

  test('★ 空闲时给出可点的按钮，点下去真的 POST /notes/:uid/mindmap', async () => {
    const s = stubApi({
      '/jobs': { jobs: [], concurrencyLimit: 2 },
      [`POST /notes/${NOTE}/mindmap`]: { jobUid: 'job_1', noteUid: NOTE },
    });
    const r = await render(<GenerateMindmapButton noteUid={NOTE} />);
    await r.flush();

    const btn = r.container.querySelector('[data-testid="generate-mindmap"]') as HTMLButtonElement | null;
    assert.ok(btn, 'F4 是章程点名的功能之一，界面上必须有地方能触发它');
    assert.equal(btn!.hasAttribute('disabled'), false, '没有任务在跑时按钮应该是可点的');
    assert.ok(text(r.container).includes(zhMindmap.generate));

    await click(btn);
    await r.flush();
    const post = s.calls.find((c) => c.method === 'POST');
    assert.ok(
      post,
      `点了生成按钮但一个写请求都没发出去（实际请求：${JSON.stringify(s.calls.map((c) => `${c.method} ${c.path}`))}）`,
    );
    assert.equal(post!.path, `/notes/${NOTE}/mindmap`, '路径必须是 daemon 真实存在的那条（content.ts:310）');
    r.unmount();
  });

  test('★ 点完之后按钮立刻不可点 —— 生成要几秒，这几秒里必须挡住重复提交', async () => {
    /*
     * 桩会在 POST 之后才把这条 job 放进 `/jobs`：这正是真实时序
     * （202 返回 → 前端 invalidate → 任务列表里才出现）。
     * 如果"进行中"是靠 mutation 的 isPending 判的，它在这一刻已经结束了，
     * 按钮会恢复可点 —— 而 LLM 还要跑几秒，用户必然再点一次，
     * 每一次都会真的多排一条任务（端点没有幂等键，那是刻意的：重新生成是合法操作）。
     */
    let posted = false;
    stubApi({
      '/jobs': () => ({
        jobs: posted ? [pipelineJob({ noteUid: NOTE, kind: 'mindmap', type: 'mindmap', state: 'queued', step: null, progress: 0 })] : [],
        concurrencyLimit: 2,
      }),
      [`POST /notes/${NOTE}/mindmap`]: () => {
        posted = true;
        return { jobUid: 'job_1', noteUid: NOTE };
      },
    });
    const r = await render(<GenerateMindmapButton noteUid={NOTE} />);
    await r.flush();
    await click(r.container.querySelector('[data-testid="generate-mindmap"]'));
    await r.flush();

    const btn = r.container.querySelector('[data-testid="generate-mindmap"]') as HTMLButtonElement;
    assert.equal(btn.hasAttribute('disabled'), true, '生成已经排上队了，按钮却还可以点');
    assert.ok(
      text(r.container).includes(zhMindmap.generating),
      `按钮上没有"进行中"的说法（实际：${text(r.container)}）—— 用户看不出它在干活`,
    );
    r.unmount();
  });

  test('★ 进行中状态来自任务流，所以刷新页面它还在（不是本地 state）', async () => {
    // 全新挂载 + 从没点过：只要服务端说这条笔记有一条导图任务在跑，就得显示"正在生成"
    stubApi({
      '/jobs': {
        jobs: [pipelineJob({ noteUid: NOTE, kind: 'mindmap', type: 'mindmap', state: 'running', step: 'structure' })],
        concurrencyLimit: 2,
      },
    });
    const r = await render(<GenerateMindmapButton noteUid={NOTE} />);
    await r.flush();
    const btn = r.container.querySelector('[data-testid="generate-mindmap"]') as HTMLButtonElement;
    assert.equal(
      btn.hasAttribute('disabled'),
      true,
      '生成中途刷新页面，按钮又变回"生成" —— 用户会再点一次，于是同一条笔记跑两遍 LLM',
    );
    r.unmount();
  });

  test('★ 别的笔记 / 别的类型的任务不许把这个按钮锁住', async () => {
    stubApi({
      '/jobs': {
        jobs: [
          // 同一条笔记，但那是转写任务
          pipelineJob({ noteUid: NOTE, kind: 'transcribe' }),
          // 导图任务，但那是别人的笔记
          pipelineJob({ jobId: 'job_2', noteUid: '01BBBBBBBBBBBBBBBBBBBBBBBB', kind: 'mindmap', type: 'mindmap' }),
        ],
        concurrencyLimit: 2,
      },
    });
    const r = await render(<GenerateMindmapButton noteUid={NOTE} />);
    await r.flush();
    const btn = r.container.querySelector('[data-testid="generate-mindmap"]') as HTMLButtonElement;
    assert.equal(btn.hasAttribute('disabled'), false, '按钮被一条不相干的任务锁住了');
    r.unmount();
  });

  test('★ blocked 要说出 daemon 给的原因，而不是干瞪着一个禁用按钮', async () => {
    stubApi({
      '/jobs': {
        jobs: [
          pipelineJob({
            noteUid: NOTE,
            kind: 'mindmap',
            type: 'mindmap',
            state: 'blocked',
            step: null,
            progress: 0,
            blockedCode: 'LLM_NOT_CONFIGURED',
          }),
        ],
        concurrencyLimit: 2,
      },
    });
    const r = await render(<GenerateMindmapButton noteUid={NOTE} />);
    await r.flush();
    const t = text(r.container);
    assert.ok(t.includes(zhMindmap.generateBlocked), `没说它被挂起了（实际：${t}）`);
    const reason = (zhLocale as unknown as { mindmap: { blocked: Record<string, string> } }).mindmap.blocked;
    assert.ok(
      t.includes(reason['LLM_NOT_CONFIGURED']!),
      `没说原因（实际：${t}）—— 一个不说为什么的禁用按钮和坏了没有区别`,
    );
    assert.ok(!t.includes(reason['NO_TRANSCRIPT']!), '原因不该串档');
    r.unmount();
  });

  test('★ 认不出的 blockedCode 回落到通用说法，不许渲染成空白', async () => {
    stubApi({
      '/jobs': {
        jobs: [pipelineJob({ noteUid: NOTE, kind: 'mindmap', type: 'mindmap', state: 'blocked', step: null, blockedCode: 'SOMETHING_NEW' })],
        concurrencyLimit: 2,
      },
    });
    const r = await render(<GenerateMindmapButton noteUid={NOTE} />);
    await r.flush();
    const hint = r.container.querySelector('[data-testid="generate-mindmap-blocked"]');
    assert.equal(!!hint, true, '认不出的 code 让提示整块消失了');
    const reason = (zhLocale as unknown as { mindmap: { blocked: Record<string, string> } }).mindmap.blocked;
    assert.equal(hint!.textContent, reason['UNKNOWN']);
    r.unmount();
  });

  test('★ 两个空态都真的接上了这个按钮（组件造出来没人用 = 入口仍然不存在）', async () => {
    for (const rel of ['features/mindmap/MindmapPage.tsx', 'features/notes/NoteDetailPage.tsx']) {
      const src = await readSource(rel);
      assert.ok(
        /^import \{[^}]*\bGenerateMindmapButton\b[^}]*\} from '[^']+';$/m.test(src),
        `${rel} 没有 import GenerateMindmapButton —— 注释里提一句不算（T-129b 的教训）`,
      );
      assert.ok(
        /<GenerateMindmapButton\b/.test(src),
        `${rel} import 了但没渲染 —— 用户仍然点不到`,
      );
    }
  });

  test('★ 文案不许再承诺一个不存在的动作', async () => {
    // 旧 emptyHint 写着"转写完成后可以让 AI 生成，也可以从空白开始手动整理"，
    // 而当时**两件事都没有入口**。生成已经接上了；"从空白开始手动整理"仍然没有，
    // 所以那半句必须从文案里消失，而不是留着等下一个人去实现。
    const zhHint = zhMindmap.emptyHint ?? '';
    assert.ok(!zhHint.includes('从空白开始'), `emptyHint 仍在承诺没有入口的动作：${zhHint}`);
    assert.ok(
      (enLocale as unknown as { mindmap: Record<string, string> }).mindmap['emptyHint'],
      'en 少了 mindmap.emptyHint',
    );
  });
});

describe('T-138 ② 笔记进度行在真实响应下必须渲染', () => {
  const NOTE = '01AAAAAAAAAAAAAAAAAAAAAAAA';
  /**
   * ⚠️ 这条 note **就是 daemon 真实返回的形状**（`http/rest/notes.ts` 的序列化逐字段对过）：
   * **没有 `activeJobId`**。这正是缺陷的本体 —— 组件原来的渲染条件是 `n.activeJobId ?`，
   * 而这个字段全仓只有 `lib/api/mock.ts` 提供，于是进度行**在生产环境里一次都没出现过**。
   * 桩里绝不能补这个字段，补了就等于把 mock 的世界当成真实世界来测。
   */
  const NOTES = {
    notes: [
      {
        uid: NOTE,
        title: 'demo note',
        status: 'processing',
        kind: 'media',
        language: 'zh',
        durationMs: 1000,
        starred: false,
        tags: [],
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  };

  test('★ 列表页：daemon 说这条笔记有任务在跑，进度行就必须出现', async () => {
    stubApi({
      '/notes': NOTES,
      '/jobs': { jobs: [pipelineJob({ noteUid: NOTE })], concurrencyLimit: 2 },
    });
    const r = await render(<NotesListPage />, { route: '/notes' });
    await r.flush();
    assert.equal(
      !!r.container.querySelector('[data-testid="note-progress-line"]'),
      true,
      '笔记响应里没有 activeJobId（daemon 从来就不发它），进度行于是一次都没渲染过 —— ' +
        '"有没有任务在跑"必须去问任务流，不是问笔记 DTO',
    );
    const line = text(r.container);
    assert.ok(line.includes('转写中'), `没显示当前步骤（实际：${line}）`);
    assert.ok(/42\s*%/.test(line), `没显示进度百分比（实际：${line}）`);
    r.unmount();
  });

  test('★ 没有任务时一个像素都不占', async () => {
    stubApi({ '/notes': NOTES, '/jobs': { jobs: [], concurrencyLimit: 2 } });
    const r = await render(<NotesListPage />, { route: '/notes' });
    await r.flush();
    assert.equal(!!r.container.querySelector('[data-testid="note-progress-line"]'), false);
    r.unmount();
  });

  test('★ 终态任务不算"在跑"（否则转写完了进度条还挂着）', async () => {
    stubApi({
      '/notes': NOTES,
      '/jobs': { jobs: [pipelineJob({ noteUid: NOTE, state: 'succeeded', progress: 1 })], concurrencyLimit: 2 },
    });
    const r = await render(<NotesListPage />, { route: '/notes' });
    await r.flush();
    assert.equal(!!r.container.querySelector('[data-testid="note-progress-line"]'), false);
    r.unmount();
  });

  test('★ 排队中 / 阻塞中也要说话 —— 这两种状态一条 job.progress 都不会发', async () => {
    /*
     * 旧实现只读 `progressStore`（由 `job.progress` 喂养），所以就算补上 activeJobId，
     * queued / blocked 的任务仍然什么都不显示 —— 而那正是用户最想知道"它在等什么"的时刻。
     */
    const zhState = (zhLocale as unknown as { progress: { state: Record<string, string> } }).progress.state;
    for (const [state, expected] of [
      ['queued', zhState['queued']!],
      ['blocked', zhState['blocked']!],
    ] as const) {
      stubApi({
        '/notes': NOTES,
        '/jobs': {
          jobs: [pipelineJob({ noteUid: NOTE, state, step: null, progress: 0 })],
          concurrencyLimit: 2,
        },
      });
      const r = await render(<NotesListPage />, { route: '/notes' });
      await r.flush();
      const t = text(r.container);
      assert.equal(
        !!r.container.querySelector('[data-testid="note-progress-line"]'),
        true,
        `state=${state} 时进度行整块消失了`,
      );
      assert.ok(t.includes(expected), `state=${state} 没有可读的状态说明（实际：${t}）`);
      r.unmount();
    }
  });

  test('★ `activeJobId` 不许回来 —— 它是这个 bug 的本体', async () => {
    /*
     * ⚠️ 断的是**代码**，不是"文件里出现过这个词"。
     * 第一版写的是 `/activeJobId/.test(src)`，当场被自己旁边那句
     * 「mock 在 note.activeJobId 上记了一个 job id」的注释匹到 —— 与 T-129b 那次
     * `/\bEmphasis\b/` 匹到注释是同一个坑。两份注释都值得留着（它们记录了这个 bug 为什么藏得住），
     * 所以正确的做法是**先把注释去掉再断**，而不是把注释改写成不像代码的样子。
     */
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const rel of ['lib/api/types.ts', 'lib/api/mock.ts']) {
      const code = stripComments(await readSource(rel));
      assert.equal(
        /activeJobId/.test(code),
        false,
        `${rel} 里又出现了 activeJobId。daemon 从来不发这个字段：` +
          '要让它真的存在，就得在笔记 DTO 里再答一遍"这条笔记在忙什么"，' +
          '而 /api/jobs 已经在答了 —— 两个来源迟早会互相矛盾（见 lib/jobs/noteJobs.ts 文件头）。',
      );
    }
  });
});

describe('T-138b 侧栏高亮不许在详情页上失灵', () => {
  /**
   * ⚠️ 这一条**必须渲染真的 `App`**，不能只测 `activeNavTarget`。
   *
   * 纯函数那 9 条（`lib/nav/activeNav.test.ts`）证明的是**规则对**；
   * 这一条证明的是**规则被接上了**。上一版的缺陷恰恰不是规则写错，
   * 而是判定散在每个 `SideLink` 里、谁也不管"至多一项"这条性质。
   * 只测纯函数的话，把 `App.tsx` 改回逐项判断，纯函数那 9 条**照样全绿**。
   *
   * 判据用 `aria-current="page"`：它既是无障碍语义（读屏用户靠它知道"你在这一页"），
   * 也是这里唯一不依赖配色类名的判据 —— 钉 `bg-accent-tint` 的话，
   * 换一次主题就得改测试，而"高亮"这件事跟具体是哪个色号无关。
   */
  const NAV_LABELS = (zhLocale as unknown as { nav: Record<string, string> }).nav;

  async function sidebarCurrent(route: string): Promise<string[]> {
    stubApi({});
    const r = await render(<App />, { route });
    await r.flush();
    const nav = r.container.querySelector('nav');
    assert.ok(nav, '侧栏没渲染出来 —— 前提不成立');
    const on = [...nav!.querySelectorAll('[aria-current="page"]')].map((el) =>
      (el.textContent ?? '').trim(),
    );
    r.unmount();
    return on;
  }

  test('★ 笔记详情页只高亮「全部笔记」（此前它和「星标」同时亮）', async () => {
    const on = await sidebarCurrent('/notes/01KZ1H8YABCDEFGHJKMNPQRST?tab=mindmap');
    assert.deepEqual(
      on,
      [NAV_LABELS['allNotes']],
      `详情页上的侧栏高亮不对（实际：${JSON.stringify(on)}）。` +
        '两项一起亮 = 判定交回了 NavLink 的前缀匹配；一项都不亮 = 判定把 ?tab= 当成了导航的一部分',
    );
  });

  test('★ 「星标」页只高亮「星标」', async () => {
    assert.deepEqual(await sidebarCurrent('/notes?starred=1'), [NAV_LABELS['starred']]);
  });

  test('★ /models?tab=llm 上「模型」不许自己灭掉', async () => {
    const on = await sidebarCurrent('/models?tab=llm');
    assert.deepEqual(
      on,
      [NAV_LABELS['models']],
      '页内 Tab 状态把区域的灯弄灭了 —— 用户切个 Tab 就不知道自己在哪一页了',
    );
  });

  test('★ /settings 的子路由仍然要高亮「设置」（前缀语义不许被改没）', async () => {
    assert.deepEqual(await sidebarCurrent('/settings/storage'), [NAV_LABELS['settings']]);
  });

  /**
   * ★ T-138c：判据要覆盖**整个侧栏**，不只是一级导航。
   *
   * 上一轮我把范围划在 `nav` 的直接子链接上，于是文件夹树漏在外面 ——
   * `[实测]` 每个文件夹在每个 `/notes*` 地址上都被标成「当前页」。
   * 这里改成数**整个 nav 里**的 `aria-current`：一级导航与文件夹树用的是同一份
   * `activeNavTarget` + `NAV_FILTER_KEYS`，那"至多一项"就该跨组件成立。
   */
  const FOLDERS = {
    folders: [
      { uid: '01FOLDERAAAAAAAAAAAAAAAAAA', name: '课程', parentUid: null, color: null, noteCount: 2 },
      { uid: '01FOLDERBBBBBBBBBBBBBBBBBB', name: '播客', parentUid: null, color: null, noteCount: 1 },
    ],
  };

  async function wholeSidebarCurrent(route: string): Promise<string[]> {
    stubApi({ '/folders': FOLDERS });
    const r = await render(<App />, { route });
    await r.flush();
    const nav = r.container.querySelector('nav');
    assert.ok(nav, '侧栏没渲染出来 —— 前提不成立');
    const on = [...nav!.querySelectorAll('[aria-current="page"]')].map((el) =>
      (el.textContent ?? '').trim(),
    );
    r.unmount();
    return on;
  }

  test('★ 文件夹不许在"没选中任何文件夹"的地址上自称当前页', async () => {
    for (const route of ['/notes', '/notes?starred=1', '/notes/01KZ1H8YABCDEFGHJKMNPQRST']) {
      const on = await wholeSidebarCurrent(route);
      assert.equal(
        on.some((s) => s.startsWith('课程') || s.startsWith('播客')),
        false,
        `${route} 上文件夹自称当前页了（整条侧栏：${JSON.stringify(on)}）—— ` +
          'NavLink 的 isActive 只比 pathname，所有文件夹的 pathname 都是 /notes',
      );
    }
  });

  test('★ 选中某个文件夹时：只有它一个当前页，一级导航要让位', async () => {
    const on = await wholeSidebarCurrent('/notes?folder=01FOLDERAAAAAAAAAAAAAAAAAA');
    assert.equal(on.length, 1, `整条侧栏高亮了 ${on.length} 项：${JSON.stringify(on)}`);
    assert.equal(
      on[0]?.startsWith('课程'),
      true,
      `当前页应该是被选中的那个文件夹，实际是 ${JSON.stringify(on[0])}`,
    );
  });

  test('★ 兄弟文件夹不许跟着一起亮', async () => {
    const on = await wholeSidebarCurrent('/notes?folder=01FOLDERAAAAAAAAAAAAAAAAAA');
    assert.equal(on.some((s) => s.startsWith('播客')), false, '另一个文件夹也被标成了当前页');
  });

  test('★ 穷举：真实地址上**整条侧栏**高亮数永远 ≤ 1（含文件夹树）', async () => {
    for (const route of [
      '/notes',
      '/notes?starred=1',
      '/notes?folder=01FOLDERAAAAAAAAAAAAAAAAAA',
      '/notes/01KZ1H8YABCDEFGHJKMNPQRST',
      '/notes/01KZ1H8YABCDEFGHJKMNPQRST?tab=mindmap',
      '/models?tab=llm',
      '/settings/storage',
      '/tasks',
    ]) {
      const on = await wholeSidebarCurrent(route);
      assert.equal(
        on.length <= 1,
        true,
        `${route} 上整条侧栏有 ${on.length} 项自称当前页：${JSON.stringify(on)}`,
      );
    }
  });

  test('★ 穷举：真实地址上侧栏高亮数永远 ≤ 1', async () => {
    for (const route of [
      '/notes',
      '/notes?starred=1',
      '/notes/01KZ1H8YABCDEFGHJKMNPQRST',
      '/notes/01KZ1H8YABCDEFGHJKMNPQRST/mindmap',
      '/record',
      '/runtime',
      '/models?tab=llm',
      '/models/asr-whisper',
      '/tasks',
      '/settings/general',
      '/capture',
    ]) {
      const on = await sidebarCurrent(route);
      assert.equal(on.length <= 1, true, `${route} 上有 ${on.length} 项同时高亮：${JSON.stringify(on)}`);
    }
  });
});

describe('T-138 ④ 文件夹筛选：链接的目的地不能是空的', () => {
  const FOLDER = '01FOLDERAAAAAAAAAAAAAAAAAA';
  const zhNav = (zhLocale as unknown as { nav: Record<string, string> }).nav;
  const zhNotes = (zhLocale as unknown as { notes: Record<string, string> }).notes;
  const FOLDERS = [
    { uid: FOLDER, name: '课程', parentUid: null, color: null, noteCount: 3, children: [] },
  ];
  const NOTE = {
    uid: '01AAAAAAAAAAAAAAAAAAAAAAAA',
    title: 'in folder',
    status: 'ready',
    kind: 'media',
    language: 'zh',
    durationMs: 1000,
    starred: false,
    tags: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };

  test('★ 点开文件夹要把 folder 交给端点 —— 此前这个查询串全仓无人读取', async () => {
    const s = stubApi({
      '/folders': FOLDERS,
      '/notes': { notes: [NOTE, { ...NOTE, uid: '01BBBBBBBBBBBBBBBBBBBBBBBB', title: 'elsewhere' }] },
      [`/notes?folder=${FOLDER}`]: { notes: [NOTE] },
    });
    const r = await render(<NotesListPage />, { route: `/notes?folder=${FOLDER}` });
    await r.flush();
    assert.equal(
      s.calls.some((c) => c.method === 'GET' && c.path === `/notes?folder=${FOLDER}`),
      true,
      `筛选没交给端点（实际请求：${JSON.stringify(s.calls.map((c) => c.path))}）—— ` +
        '点开一个空文件夹会照常列出全部笔记，而侧栏高亮却言之凿凿地说你在这个文件夹里',
    );
    assert.equal(r.container.querySelectorAll('[data-testid="notes-list"] > li').length, 1);
    assert.equal(text(r.container).includes('elsewhere'), false, '不属于这个文件夹的笔记不该出现');
    r.unmount();
  });

  test('★ 标题要跟着走 —— 在文件夹里却顶着「全部笔记」是同一种谎，只换了位置', async () => {
    stubApi({ '/folders': FOLDERS, [`/notes?folder=${FOLDER}`]: { notes: [NOTE] } });
    const r = await render(<NotesListPage />, { route: `/notes?folder=${FOLDER}` });
    await r.flush();
    const title = r.container.querySelector('[data-testid="notes-list-title"]');
    assert.equal(title?.textContent, '课程');
    assert.notEqual(title?.textContent, zhNotes['title'], '文件夹页的标题仍写着「全部笔记」');
    assert.notEqual(title?.textContent, zhNav['starred']);
    r.unmount();
  });

  test('★ 文件夹名还没拉回来时退到「文件夹」，而不是说「全部笔记」', async () => {
    // 故意不打桩 /folders（404）：宁可笼统，不可说错
    stubApi({ [`/notes?folder=${FOLDER}`]: { notes: [NOTE] } });
    const r = await render(<NotesListPage />, { route: `/notes?folder=${FOLDER}` });
    await r.flush();
    const title = r.container.querySelector('[data-testid="notes-list-title"]')?.textContent;
    assert.equal(title, zhNav['folders']);
    assert.notEqual(title, zhNotes['title'], '拿不到名字就退回「全部笔记」= 又一次说错话');
    r.unmount();
  });

  test('★ 空文件夹给它自己的空态（而不是"还没有笔记"）', async () => {
    stubApi({ '/folders': FOLDERS, [`/notes?folder=${FOLDER}`]: { notes: [] } });
    const r = await render(<NotesListPage />, { route: `/notes?folder=${FOLDER}` });
    await r.flush();
    /*
     * ⚠️ 判据是**标题那一整句**，不是"页面里有没有出现『还没有笔记』这几个字"。
     * 第一版就是后者，当场被自己的文案匹到：`notes.empty` = 「还没有笔记」
     * 恰好是 `notes.folderEmpty` = 「『X』里还没有笔记」的子串 ——
     * 与本轮那次 `/activeJobId/` 匹到注释、T-129b 那次 `/\bEmphasis\b/` 匹到注释同族。
     * **钉整句、钉结构，别钉关键词。**
     */
    const title = r.container.querySelector('h2')?.textContent;
    assert.equal(title, '「课程」里还没有笔记', `空态标题不对（实际：${String(title)}）`);
    assert.notEqual(title, zhNotes['empty'], '不该说"还没有笔记" —— 他别处还有笔记');
    assert.notEqual(title, zhNotes['starredEmpty']);
    r.unmount();
  });

  test('★ 「含子孙」这件事要在界面上说出来，别让用户自己猜', async () => {
    // 裁决定的是含子孙；用户看到父级列出子级的笔记时，界面得先讲过这件事
    const hint = (zhLocale as unknown as { notes: Record<string, string> }).notes['folderEmptyHint'];
    assert.ok(hint && /子文件夹/.test(hint), `文案没有交代"含子孙"：${String(hint)}`);
    const en = (enLocale as unknown as { notes: Record<string, string> }).notes['folderEmptyHint'];
    assert.ok(en && /sub-folder/i.test(en), `en 没有交代"含子孙"：${String(en)}`);
  });
});

/* ══════════ T-157 ④ 下载源（镜像）UI ══════════ */

/**
 * 修之前：daemon 的三个端点全是真的（`GET /api/models/sources`、`POST …/probe`、
 * `POST …/select`），而前端 `useModelsSourcesQuery` / `useSourceProbeMutation`
 * **零调用方**，**连一个 select 的 hook 都没有**。
 *
 * 后果不是"少一个高级设置"：HuggingFace 连不上时用户看到「所有下载源均失败」，
 * 而他既看不到自动回退到底选了谁、也没法钉一个能通的源。
 * `[实测]` 这台机器就连不上 HuggingFace、自动回落到了 ModelScope ——
 * **回退是有效的，只是用户看不到也选不了。**
 *
 * 断言一律钉后果：**请求真的发出去了**、**回退的结果真的渲染出来了**。
 * "按钮在不在"在缺陷状态下也能绿。
 */
describe('T-157 ④ 下载源（镜像）', () => {
  const SOURCES = {
    selected: 'auto' as const,
    effective: 'modelscope' as const,
    available: ['hf', 'hf-mirror', 'modelscope'] as const,
    probes: [
      {
        id: 'hf' as const,
        ok: false,
        ttfbMs: null,
        throughputKbps: null,
        probedAt: '2026-08-06T12:00:00.000Z',
        error: 'timeout after 5000ms',
      },
      {
        id: 'modelscope' as const,
        ok: true,
        ttfbMs: 120,
        throughputKbps: 8800,
        probedAt: '2026-08-06T12:00:00.000Z',
        error: null,
      },
    ],
  };

  test('★ 自动回退到底选了谁必须看得见 —— 这是这块 UI 存在的主要理由', async () => {
    stubApi({ '/models/sources': SOURCES });
    const r = await render(<SourcesSection locale="zh-CN" />);
    await r.flush();
    const line = r.container.querySelector('[data-testid="models-sources-effective"]')?.textContent ?? '';
    assert.equal(
      line.includes('ModelScope'),
      true,
      `没有把实际生效的源说出来（实际：${line}）—— 用户只会看到"所有下载源均失败"而不知道发生了什么`,
    );
    r.unmount();
  });

  test('★ 没测过速就说没测过，不许拿"自动"充数', async () => {
    // "不知道"和"就是它"是两件事，混在一起就是又一个假绿灯。
    stubApi({ '/models/sources': { ...SOURCES, effective: null, probes: [] } });
    const r = await render(<SourcesSection locale="zh-CN" />);
    await r.flush();
    const line = r.container.querySelector('[data-testid="models-sources-effective"]')?.textContent ?? '';
    const zhSources = (zhLocale as unknown as { models: { sources: Record<string, string> } }).models.sources;
    assert.equal(line, zhSources['effectiveUnknown'], `没测过时说了别的话：${line}`);
    r.unmount();
  });

  test('★ 点一个源要真的把它发给 daemon（此前根本没有这个 hook）', async () => {
    const s = stubApi({
      '/models/sources': SOURCES,
      'POST /models/sources/select': { ...SOURCES, selected: 'hf-mirror' },
    });
    const r = await render(<SourcesSection locale="zh-CN" />);
    await r.flush();

    await click(r.container.querySelector('[data-testid="models-source-hf-mirror"]'));
    await r.flush();

    const call = s.calls.find((c) => c.method === 'POST' && c.path === '/models/sources/select');
    assert.equal(
      call === undefined,
      false,
      `没有发出 select 请求（实际请求：${JSON.stringify(s.calls.map((c) => `${c.method} ${c.path}`))}）`,
    );
    assert.deepEqual(call?.body, { provider: 'hf-mirror' });
    // 选中态要真的跟着服务端的回执走，而不是本地自己记一份
    assert.equal(
      r.container.querySelector('[data-testid="models-source-hf-mirror"]')?.getAttribute('aria-checked'),
      'true',
    );
    r.unmount();
  });

  test('★ 「立即测速」要真的打 probe，并把每个源的结果（含失败原因原文）渲染出来', async () => {
    const s = stubApi({
      '/models/sources': { ...SOURCES, effective: null, probes: [] },
      'POST /models/sources/probe': SOURCES,
    });
    const r = await render(<SourcesSection locale="zh-CN" />);
    await r.flush();
    assert.equal(r.container.querySelector('[data-testid="models-sources-probes"]') === null, true);

    await click(r.container.querySelector('[data-testid="models-sources-probe"]'));
    await r.flush();

    assert.equal(
      s.calls.some((c) => c.method === 'POST' && c.path === '/models/sources/probe'),
      true,
      `没有发出 probe 请求（实际：${JSON.stringify(s.calls.map((c) => `${c.method} ${c.path}`))}）`,
    );
    const body = text(r.container);
    assert.equal(
      body.includes('timeout after 5000ms'),
      true,
      '失败原因被翻成了一句废话 —— detail 是用户唯一的线索',
    );
    assert.equal(body.includes('8,800') || body.includes('8800'), true, '没把实测速度显示出来');
    r.unmount();
  });

  test('★ 可选项来自 daemon 的 available，不是前端写死一张表', async () => {
    // 清单里没有的源不该出现：一个点了没用的选项，和写死一张会漂移的表是同一个病。
    stubApi({ '/models/sources': { ...SOURCES, available: ['hf', 'modelscope'] } });
    const r = await render(<SourcesSection locale="zh-CN" />);
    await r.flush();
    assert.equal(r.container.querySelector('[data-testid="models-source-hf"]') === null, false);
    assert.equal(r.container.querySelector('[data-testid="models-source-modelscope"]') === null, false);
    assert.equal(
      r.container.querySelector('[data-testid="models-source-hf-mirror"]') === null,
      true,
      'available 里没有的 provider 不该出现',
    );
    assert.equal(
      r.container.querySelector('[data-testid="models-source-custom"]') === null,
      true,
      '不许提供「自定义源」—— T-171(A-6) 已拆掉这半个功能，daemon 收到 provider:"custom" 直接 400',
    );
    r.unmount();
  });
});

/* ══════════ T-157 ③ 笔记列表的翻页 ══════════ */

/**
 * 修之前：`GET /api/notes` 没有 offset/cursor，前端连 `limit` 都不传，端点默认 50 ——
 * 列表**恒定只有前 50 条**，没有翻页、没有"加载更多"、没有总数、一个字的提示都没有。
 * 第 51 条起在界面上永远不存在。
 *
 * 判据是「**要么真的能翻到第 51 条，要么明确告诉用户还有更多**」，
 * 所以断言钉的是：① 第二页的笔记标题**真的进了 DOM**；② 请求里**真的带了 offset**。
 * 只断言"按钮在"或"页脚有字"在缺陷状态下同样能绿。
 */
describe('T-157 ③ 笔记列表：一页装不下时', () => {
  const mkNote = (uid: string, title: string) => ({
    uid,
    title,
    status: 'ready' as const,
    kind: 'media' as const,
    language: 'zh',
    durationMs: 1000,
    starred: false,
    tags: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });

  const PAGE1 = {
    notes: [mkNote('01P1AAAAAAAAAAAAAAAAAAAAAA', '第一条'), mkNote('01P1BBBBBBBBBBBBBBBBBBBBBB', '第二条')],
    total: 3,
    limit: 2,
    offset: 0,
    hasMore: true,
  };
  const PAGE2 = {
    notes: [mkNote('01P2CCCCCCCCCCCCCCCCCCCCCC', '第五十一条')],
    total: 3,
    limit: 2,
    offset: 2,
    hasMore: false,
  };

  test('★ 点「加载更多」要真的带着 offset 去拿下一页，并把它接到列表后面', async () => {
    const s = stubApi({ '/notes': PAGE1, '/notes?offset=2': PAGE2, '/jobs': { jobs: [], concurrencyLimit: 2 } });
    const r = await render(<NotesListPage />, { route: '/notes' });
    await r.flush();

    assert.equal(r.container.querySelectorAll('[data-testid="notes-list"] > li').length, 2);
    assert.equal(
      text(r.container).includes('第五十一条'),
      false,
      '第二页的内容不该在点之前就出现（那样这条用例证明不了任何事）',
    );

    const more = r.container.querySelector('[data-testid="notes-load-more"]');
    assert.equal(more === null, false, '还有更多时必须给一个能翻页的入口');
    await click(more);
    await r.flush();

    assert.equal(
      s.calls.some((c) => c.method === 'GET' && c.path === '/notes?offset=2'),
      true,
      `没有带 offset 去拿下一页（实际请求：${JSON.stringify(s.calls.map((c) => c.path))}）` +
        ' —— 那就还是"第 51 条永远看不到"',
    );
    assert.equal(r.container.querySelectorAll('[data-testid="notes-list"] > li').length, 3);
    assert.equal(text(r.container).includes('第五十一条'), true, '第二页的笔记必须真的渲染出来');
    // 翻到底之后不许再留着入口（否则会拉回空数组）
    assert.equal(r.container.querySelector('[data-testid="notes-load-more"]') === null, true);
    r.unmount();
  });

  test('★ 还有更多时页脚必须说出"已显示几 / 共几"—— 静默截断比显示错的更难发现', async () => {
    stubApi({ '/notes': PAGE1, '/jobs': { jobs: [], concurrencyLimit: 2 } });
    const r = await render(<NotesListPage />, { route: '/notes' });
    await r.flush();
    const footer = r.container.querySelector('[data-testid="notes-list-count"]')?.textContent ?? '';
    assert.equal(footer.includes('2'), true, `页脚没说已显示几条：${footer}`);
    assert.equal(footer.includes('3'), true, `页脚没说一共几条：${footer}`);
    r.unmount();
  });

  test('★ 一页装得下时不许出现「加载更多」，但仍要说"已全部显示"', async () => {
    // "刚好一页"和"被截断了"必须能分辨 —— 分不出来正是这条缺陷的本体。
    stubApi({
      '/notes': { ...PAGE1, notes: PAGE1.notes, total: 2, hasMore: false },
      '/jobs': { jobs: [], concurrencyLimit: 2 },
    });
    const r = await render(<NotesListPage />, { route: '/notes' });
    await r.flush();
    assert.equal(r.container.querySelector('[data-testid="notes-load-more"]') === null, true);
    const footer = r.container.querySelector('[data-testid="notes-list-count"]')?.textContent ?? '';
    assert.equal(footer.length > 0, true, '一页装得下时页脚也要说话，否则用户分不出"就这些"和"被截断了"');
    r.unmount();
  });
});

/* ══════════ T-140 补救链：从"服务端算好了"到"用户点得到" ══════════ */

/**
 * 这一族用例守的是**要求 2.1 的最后一米**。
 *
 * 修之前的现状（`[实测]`）：
 * - 26 个 `<ErrorBlock>` 调用点，传 `onRemediate` 的是 **0 个** →
 *   渲染条件 `api?.remediation && onRemediate` 恒假 → **一个补救按钮都不存在**；
 * - `RemediationButton.tsx` 的 importer 是 **0 个**；
 * - 两张 `action → 路由` 表加起来认识 5 个 action，daemon 真正会发的 15 个里
 *   **只对得上 3 个**；`installSiteExtractor`（yt-dlp 缺失）两边都不认识。
 *
 * ⚠️ 断言里出现的错误信封**逐字照抄 daemon 源码**（`rest/notes.ts:120-136` /
 * `rest/storage.ts:257-273`），不是我编的形状 —— 编一个形状出来测，
 * 测的就是我自己的想象（⑤A-11 那次就是这么过的）。
 */
describe('T-140 ① /components 在界面上到得了', () => {
  /* 形状照抄本文件 T-129b 那组（真实 `GET /api/hardware` 的字段名） —— 自己编一份就是测自己的想象 */
  const RUNTIME_STUB = {
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
        backends: [{ id: 'cpu', installed: true, available: true, unavailableReason: null }],
        selectedBackend: 'cpu',
      },
    },
    '/backends/catalog': { stale: false, packs: [] },
    '/backends/installed': { selectedBackend: 'cpu', packs: [] },
    '/components': { components: [], online: false, checkedAt: null },
  };

  test('★ 从 /runtime 点得到 /components —— 且落地的真是那一页，不只是 URL 变了', async () => {
    stubApi(RUNTIME_STUB);
    const r = await render(
      <div>
        <RuntimePage />
        <LocationProbe />
      </div>,
      { route: '/runtime' },
    );
    await r.flush();

    const link = r.container.querySelector('[data-testid="runtime-components-link"]');
    assert.ok(link, '/runtime 上没有通往 /components 的入口 —— 那一页又回到"只能手敲 URL"');
    assert.equal(
      link!.getAttribute('href'),
      '/components',
      `入口指向 ${String(link!.getAttribute('href'))}，不是 /components`,
    );
    r.unmount();
  });

  /**
   * ★ 这一条钉的是**路由注册**，不是链接。
   *
   * `componentsRoutes` 从 `routes.tsx` 里删掉的话，上面那条仍然全绿（href 还在），
   * 但点下去是一个空白页。两件事得分开钉。
   */
  test('★ /components 这个地址真的渲染出组件页（路由被摘掉时必须红）', async () => {
    stubApi(RUNTIME_STUB);
    const { routes } = await import('../routes');
    const shell = routes[0]?.children ?? [];
    const hit = shell.filter((rt) => rt.path === 'components');
    assert.equal(hit.length, 1, `路由表里 path==='components' 的条目有 ${hit.length} 条，应为 1`);

    const r = await render(<ComponentsPage />, { route: '/components' });
    await r.flush();
    assert.equal(
      !!r.container.querySelector('[data-testid="components-page"]'),
      true,
      '路由指到的组件不是组件页',
    );
    r.unmount();
  });

  test('入口文案两种语言都有（只写中文 = en 界面上漏一个键名出来）', () => {
    for (const [name, loc] of [
      ['zh-CN', zhLocale],
      ['en', enLocale],
    ] as const) {
      const rt = (loc as unknown as { runtime: Record<string, string> }).runtime;
      assert.ok(rt['componentsLink'], `${name} 缺 runtime.componentsLink`);
      assert.ok(rt['componentsLinkHint'], `${name} 缺 runtime.componentsLinkHint`);
    }
  });
});

describe('T-140 ② ErrorBlock 自己就把补救渲染出来（不再要求调用方传 prop）', () => {
  /** 逐字照抄 `apps/daemon/src/http/rest/notes.ts:120-136` 的 422 信封。 */
  const NO_MEDIA_SOURCE = {
    code: 'NO_MEDIA_SOURCE',
    message: 'no adapter can handle: https://www.youtube.com/watch?v=x',
    messageZh: '没有适配器能处理这个链接',
    remediation: {
      action: 'installSiteExtractor',
      params: { input: 'https://www.youtube.com/watch?v=x' },
      labelZh: '查看如何支持该站点',
      label: 'How to support this site',
    },
  };

  test('★ 一个 prop 都不传，补救按钮就得在（这正是 26 处全都不传的那个前提）', async () => {
    stubApi({});
    const err = new ApiError(422, NO_MEDIA_SOURCE);
    const r = await render(<ErrorBlock error={err} />);
    await r.flush();
    assert.equal(
      !!r.container.querySelector('[data-testid="remediation-installSiteExtractor"]'),
      true,
      '没渲染补救按钮 —— 旧条件是 `api?.remediation && onRemediate`，26 个调用点无一传 onRemediate',
    );
    r.unmount();
  });

  test('★ 按钮上写的是服务端那句话（labelZh 一度在 ApiError 构造函数里被解析掉）', async () => {
    stubApi({});
    const r = await render(<ErrorBlock error={new ApiError(422, NO_MEDIA_SOURCE)} />);
    await r.flush();
    const btn = r.container.querySelector('[data-testid="remediation-installSiteExtractor"]');
    assert.equal(
      (btn?.textContent ?? '').trim(),
      '查看如何支持该站点',
      '按钮文案不是服务端给的那句 —— ApiError 把 labelZh 丢了就会退化成 action 原名',
    );
    r.unmount();
  });

  test('★ 点下去落到 /components（不是 /models，也不是 /tasks）', async () => {
    stubApi({});
    const r = await render(
      <div>
        <ErrorBlock error={new ApiError(422, NO_MEDIA_SOURCE)} />
        <LocationProbe />
      </div>,
    );
    await r.flush();
    assert.equal(locOf(r.container), '/', '前提：还没跳转');
    await click(r.container.querySelector('[data-testid="remediation-installSiteExtractor"]'));
    await r.flush();
    assert.equal(
      locOf(r.container),
      '/components',
      '按钮点得动、跳得走，但到不了能装 yt-dlp 的那一页 —— 这正是修之前的状态',
    );
    r.unmount();
  });

  test('普通错误（服务端没给 remediation）不许凭空长出一个按钮', async () => {
    stubApi({});
    const r = await render(
      <ErrorBlock error={new ApiError(500, { code: 'BOOM', message: 'boom', messageZh: '炸了' })} />,
    );
    await r.flush();
    assert.equal(
      r.container.querySelectorAll('[data-testid^="remediation-"]').length,
      0,
      '没有真实补救动作的地方就该没有按钮 —— 造一个点了没用的按钮比不给更糟',
    );
    r.unmount();
  });

  test('★ 明确"没有落点"的 action 不渲染按钮（reauth 由重新连接那条路管）', async () => {
    stubApi({});
    const r = await render(
      <ErrorBlock
        error={
          new ApiError(403, {
            code: 'CSRF_FAILED',
            message: 'csrf',
            messageZh: '会话校验失败',
            remediation: { action: 'reauth', params: {}, labelZh: '重新握手', label: 'Re-auth' },
          })
        }
      />,
    );
    await r.flush();
    assert.equal(
      !!r.container.querySelector('[data-testid="remediation-reauth"]'),
      false,
      'reauth 没有任何页面能修，跳过去只会带着同一个失效令牌再撞一次',
    );
    r.unmount();
  });

  test('★ 调用方说"我能就地办"时，即使没有落点也要渲染，并且不跳转', async () => {
    stubApi({});
    const seen: string[] = [];
    const r = await render(
      <div>
        <ErrorBlock
          error={
            new ApiError(409, {
              code: 'TARGET_ALREADY_DATA_DIR',
              message: 'already',
              messageZh: '该位置已经是一个 OpenMemo 数据目录',
              remediation: {
                action: 'useExistingDataDir',
                params: { path: '/tmp/x', move: false, endpoint: '/api/settings/data-dir' },
                label: 'Use this directory',
                labelZh: '直接使用此目录',
              },
            })
          }
          onRemediate={(a) => seen.push(a)}
        />
        <LocationProbe />
      </div>,
    );
    await r.flush();
    await click(r.container.querySelector('[data-testid="remediation-useExistingDataDir"]'));
    await r.flush();
    assert.deepEqual(seen, ['useExistingDataDir'], '就地处理器没被调用');
    assert.equal(locOf(r.container), '/', '就地动作不该把用户带离当前页');
    r.unmount();
  });
});

describe('T-140 ③ 走产品真实路径：粘一个链接 → yt-dlp 缺失 → 点到能装它的页面', () => {
  /**
   * ★ 这一条是本轮的验收判据，且**走的是产品自己的那条路**（规矩 3）：
   * `CapturePage` 的输入框 → `POST /api/notes/probe` → daemon 422 → `<ErrorBlock>`。
   *
   * demo 上此刻 `GET /api/selfcheck` 里就是 `warn | tool.ytDlp | 未找到`，
   * 而这条 422 是那句 warn 在**界面上唯一会显形的地方** ——
   * 自检结果本身没有任何页面在读（`/diagnostics` 读的是 `/api/health`，
   * 而 `health.pipeline.missing` 里没有 ytDlp）。
   */
  test('★ 点「开始」→ 422 → 「查看如何支持该站点」→ /components', async () => {
    stubApi({
      'POST /notes/probe': () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'NO_MEDIA_SOURCE',
              message: 'no adapter can handle: https://www.youtube.com/watch?v=dQw4w9WgXcQ',
              messageZh: '没有适配器能处理这个链接',
              retryable: false,
              remediation: {
                action: 'installSiteExtractor',
                params: { input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
                labelZh: '查看如何支持该站点',
                label: 'How to support this site',
              },
            },
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
    });

    const { default: CapturePage } = await import('../features/capture/CapturePage');
    const r = await render(
      <div>
        <CapturePage />
        <LocationProbe />
      </div>,
      { route: '/capture' },
    );
    await r.flush();

    await type(r.container.querySelector('[data-testid="capture-url-input"]'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await click(buttonByText(r.container, '开始'));
    await r.flush();
    await r.flush();

    const btn = r.container.querySelector('[data-testid="remediation-installSiteExtractor"]');
    assert.ok(
      btn,
      'daemon 把「去装站点解析器」算出来发过来了，捕获页一个按钮都没渲染 —— 用户在界面上无路可走',
    );
    await click(btn);
    await r.flush();
    assert.equal(locOf(r.container), '/components', 'yt-dlp 装得回来的那一页到不了');
    r.unmount();
  });
});

/* ───────────────── MindmapView：重新生成之后屏幕要跟着换（T-139 C10）───────────────── */

describe('MindmapView（T-139 C10）', () => {
  /**
   * ## 这条用例钉的是什么
   *
   * 盘点把「导图生成完页面不刷新」记在 `mindmap.done` 没有订阅者头上。
   * 实测（真 daemon + 真浏览器）**那条链是通的**：daemon 在落库时同时发
   * `mindmap.done` 与 `note.updated{changed:['mindmap']}`，`notesSse` 订阅后者并
   * invalidate `qk.mindmap(noteUid)`，浏览器网络日志里那次
   * `GET /notes/:uid/mindmap` **真的发生了**，回来的也确实是新 revision。
   *
   * 断的是**渲染器**：`MindmapView` 的实例只在 `doc.uid` 变化时重建，
   * 而 `doc.uid` **是笔记的 uid**（生成时传的就是 `note.uid`），同一条笔记里恒定不变 ——
   * 于是"数据换了、图没换"，只有手动刷新才看得到新的。
   *
   * 所以判据必须是：**换一份内容不同、uid 相同的文档进去，屏幕上的字要跟着变。**
   * "组件没崩""渲染出来了"都不够 —— 出事那天它也渲染得好好的。
   */
  const docOf = (topic: string): MindMapDoc =>
    ({
      schemaVersion: 1,
      uid: '01KZ47V1X2YB402JKD60KRHK97', // ★ 两份文档共用 —— 重新生成不会换这个
      title: '一节课的录音',
      rootKey: 'n0',
      revision: 1,
      nodes: {
        n0: { key: 'n0', text: '一节课的录音', children: ['n1'] },
        n1: { key: 'n1', text: topic, children: [] },
      },
    }) as unknown as MindMapDoc;

  function Swapper({ a, b }: { a: MindMapDoc; b: MindMapDoc }) {
    const [doc, setDoc] = useState(a);
    return (
      <div>
        {/* 模拟 SSE → invalidate → 重取之后，react-query 把新文档交下来 */}
        <button onClick={() => setDoc(b)}>refetched</button>
        <MindmapView doc={doc} noteUid="01KZ47V1X2YB402JKD60KRHK97" editable={false} />
      </div>
    );
  }

  test('★ 重新生成（uid 不变、内容变了）→ 屏幕上的主题必须跟着换', async () => {
    const r = await render(<Swapper a={docOf('第一次生成的主题')} b={docOf('第二次生成的主题')} />);
    await r.flush();
    assert.ok(
      text(r.container).includes('第一次生成的主题'),
      '第一份文档就没渲染出来，后面的断言没有意义',
    );

    await click(buttonByText(r.container, 'refetched'));
    await r.flush();

    assert.ok(
      text(r.container).includes('第二次生成的主题'),
      '新文档到了，屏幕上还是旧的那张图 —— 这就是"生成成功但页面不更新"的真身：' +
        '缓存换了、渲染器没换（重建条件 doc.uid 在同一条笔记里永远不变）',
    );
    assert.equal(
      text(r.container).includes('第一次生成的主题'),
      false,
      '旧内容还留在屏幕上 —— 换图必须是替换，不是叠加',
    );
    r.unmount();
  });

  test('内容没变时不换图（用户正在编辑，不能被自己的保存往返打断）', async () => {
    /*
     * 这一半同样是判据的一部分：修法若改成"revision 变了就重建"，
     * 用户拖一个节点 → 600ms 防抖 → PATCH → revision +1 → 重取 → **视图在手底下被重置**
     * （缩放、选中、撤销栈全丢）。原代码那条注释担心的正是这个，担心是对的。
     * 所以判据是内容签名：内容一样就一个字都不动。
     */
    const same = docOf('同一个主题');
    const clone = JSON.parse(JSON.stringify(same)) as MindMapDoc; // 新对象、同内容
    const r = await render(<Swapper a={same} b={{ ...clone, revision: 99 } as MindMapDoc} />);
    await r.flush();
    const root = r.container.querySelector('me-main, .map-container');
    await click(buttonByText(r.container, 'refetched'));
    await r.flush();
    assert.equal(
      r.container.querySelector('me-main, .map-container') === root,
      true,
      '内容没变却把渲染容器换掉了 —— 用户编辑时会被自己的保存往返打断',
    );
    assert.ok(text(r.container).includes('同一个主题'));
    r.unmount();
  });
});

/* ══════════════ T-150 ① 诊断页必须真的展示功能自检（ok / warn / fail 三档）══════════════ */

/**
 * ## 这一族钉的是什么
 *
 * `GET /api/selfcheck` **早已存在**（`apps/daemon/src/http/rest/selfcheck.ts`，
 * `[实测]` demo 上返回 25 条 200），而在这几条用例之前，
 * **web 全仓没有任何一处读它**（两名 agent 各自实测到同一个洞）。
 * `/diagnostics` 读的是 `/api/health`，而 `health.pipeline.missing` 在 demo 上恒为 `[]`。
 *
 * 后果很具体：自检里那 20 多条结论（转写引擎缺失 / 中文分词退化 /
 * VAD 权重 whisper 加载不了 / yt-dlp 没装）**用户在界面上一条都看不到** ——
 * 而那正是"我的东西为什么不工作"的答案。
 *
 * 判据不是"页面渲染出来了"，是三条：
 *   ① 请求**真的发出去了**（行为，不是源码里出现过这个字符串）；
 *   ② 每一条的**档位**（ok/warn/fail）都渲染出来，且三档在视觉上互不相同；
 *   ③ **只靠 `/api/health` 看不到的那条**（`tool.ytDlp` warn）现在看得到 ——
 *      这条是"为什么必须换数据源"的判据，把自检区块整块删掉它就红。
 */
describe('T-150 ① /diagnostics 读 /api/selfcheck', () => {
  const REPORT = {
    ok: false,
    ranAt: '2026-08-06T05:50:23.158Z',
    dataDir: '/tmp/t150/data',
    storeRoot: '/tmp/t150/data/models',
    extensionsDir: '/tmp/t150/data/bin/ext',
    counts: { ok: 1, warn: 1, fail: 1 },
    results: [
      {
        layer: 'tools',
        id: 'tool.ytDlp',
        label: 'yt-dlp (optional, GPL)',
        labelZh: 'yt-dlp（可选，GPL）',
        status: 'warn',
        detail: '未找到',
        required: false,
        remediation: '在「运行时」页安装对应组件',
      },
      {
        layer: 'tools',
        id: 'model.vad',
        label: 'VAD model',
        labelZh: 'VAD 模型',
        status: 'fail',
        detail: '交出来的那份权重 whisper.cpp 加载不了',
        required: true,
        remediation: '在「模型」页安装 silero VAD（ggml 格式）',
      },
      {
        layer: 'ext',
        id: 'ext.chineseSearch',
        label: 'Chinese two-character search',
        labelZh: '中文双字词可搜索',
        status: 'ok',
        detail: '4/4 命中',
        required: true,
        remediation: null,
      },
    ],
  };

  /**
   * `/api/health` 的桩**刻意让每一项都正常**：`pipeline.missing` 为空、扩展都加载上了。
   * 于是"屏幕上出现 yt-dlp 那条 warn"只可能来自自检，不可能来自 health ——
   * 判据因此是干净的。
   */
  const HEALTH = {
    version: '0.1.0',
    instanceId: 'i',
    contractVersion: 1,
    dataDir: '/tmp/t150/data',
    port: 17650,
    pid: 1,
    db: {
      driver: 'better-sqlite3',
      sqliteVersion: '3.46',
      journalMode: 'wal',
      schemaVersion: 9,
      extensions: { libsimple: true, sqliteVec: true, tokenizer: 'simple' },
    },
    pipeline: { missing: [], ffmpeg: '/x/ffmpeg', whisperCli: '/x/whisper-cli', vad: { chunking: 'vad' } },
    scheduler: { running: 0 },
    sseClients: 1,
  };

  async function renderDiagnostics(routes: Record<string, unknown>) {
    const stub = stubApi(routes);
    const { default: DiagnosticsPage } = await import('../features/diagnostics/DiagnosticsPage');
    const r = await render(<DiagnosticsPage />, { route: '/diagnostics' });
    await r.flush();
    await r.flush();
    return { r, stub };
  }

  test('★ 页面真的发出了 GET /api/selfcheck（此前全仓零调用点）', async () => {
    const { r, stub } = await renderDiagnostics({ '/health': HEALTH, '/selfcheck': REPORT });
    /*
     * 断的是**请求**，不是源码里出现过 `/api/selfcheck` 这几个字 ——
     * 源码正则会被自己旁边的注释匹到（本仓已经在 `\bEmphasis\b` 上吃过一次）。
     */
    assert.ok(
      stub.calls.some((c) => c.method === 'GET' && c.path === '/selfcheck'),
      `诊断页没有请求过 /api/selfcheck，实际请求：${JSON.stringify(stub.calls.map((c) => `${c.method} ${c.path}`))}`,
    );
    r.unmount();
  });

  test('★ 三档必须逐条渲染出来，且 ok/warn/fail 在视觉上互不相同', async () => {
    const { r } = await renderDiagnostics({ '/health': HEALTH, '/selfcheck': REPORT });

    const rows = [...r.container.querySelectorAll('[data-testid="selfcheck-row"]')];
    assert.equal(rows.length, REPORT.results.length, '自检结果的条数与渲染出来的行数对不上');

    // ① 每一条的 id → 档位，逐条对齐（顺序也要对：runSelfCheck 承诺顺序稳定）
    assert.deepEqual(
      rows.map((el) => [el.getAttribute('data-check-id'), el.getAttribute('data-level')]),
      REPORT.results.map((x) => [x.id, x.status]),
    );

    /*
     * ② 三档不能长成一个样。
     *
     * 只断 `data-level` 是不够的：那是我自己写上去的属性，
     * 把三档的图标全画成绿勾它照样绿 —— 而"分不出哪个是坏的"正是这条要挡的事。
     * 所以再断一次**图标的 class**：三档必须给出三个互不相同的值。
     */
    const iconClass = rows.map((el) => el.querySelector('svg')?.getAttribute('class') ?? '');
    assert.equal(iconClass.filter((c) => c.length > 0).length, 3, '有行没渲染出状态图标');
    assert.equal(new Set(iconClass).size, 3, `三档共用了同一种画法 → ${JSON.stringify(iconClass)}`);
    r.unmount();
  });

  test('★ 只读 /api/health 时看不到的那条，现在看得到（含修复建议与必需项标记）', async () => {
    const { r } = await renderDiagnostics({ '/health': HEALTH, '/selfcheck': REPORT });
    const shown = text(r.container);

    // health 桩里一个字都没提 yt-dlp / VAD 权重 —— 它们只可能来自自检
    assert.ok(shown.includes('yt-dlp（可选，GPL）'), 'warn 档的自检项没出现在界面上');
    assert.ok(shown.includes('未找到'), '自检给的 detail 没显示');
    assert.ok(
      shown.includes('在「运行时」页安装对应组件'),
      'daemon 连修复建议都算好发过来了，界面上一个字都不显示',
    );
    assert.ok(shown.includes('交出来的那份权重 whisper.cpp 加载不了'), 'fail 档的 detail 没显示');

    // required 的失败项要标出来 —— "坏了"和"降级了"不是一回事
    const failRow = r.container.querySelector('[data-check-id="model.vad"]');
    assert.ok(failRow, '找不到 model.vad 那一行');
    assert.ok(
      (failRow!.textContent ?? '').includes('必需项'),
      'required 的失败项没有任何标记，读起来和一条普通告警一样',
    );

    // 计数也要出来：用户先看总数再决定要不要往下读
    const counts = r.container.querySelector('[data-testid="selfcheck-counts"]');
    assert.ok(counts, '没有计数');
    assert.ok(/1.*1.*1/s.test(counts!.textContent ?? ''), `计数没渲染 → ${counts!.textContent}`);
    r.unmount();
  });

  test('★ 端点拿不到时不许静默留白，而且不许把整页带塌（老 daemon）', async () => {
    // 只桩 /health：/selfcheck 未打桩 ⇒ 桩层回 404，正是老 daemon 的样子
    const { r } = await renderDiagnostics({ '/health': HEALTH });

    assert.ok(
      !!r.container.querySelector('[data-testid="selfcheck-unavailable"]'),
      '自检拿不到时页面上一个字都没说 —— 空白会被读成「没什么可报的」',
    );
    // 整页没塌：下面那几组仍在
    assert.ok(text(r.container).includes('ffmpeg'), '自检挂了不该带走 /api/health 那几组');
    assert.equal(
      !!r.container.querySelector('[data-testid="selfcheck-row"]'),
      false,
      '拿不到结果却渲染出了行',
    );
    r.unmount();
  });

  test('★ 自检返回空集不算「一切正常」', async () => {
    const { r } = await renderDiagnostics({
      '/health': HEALTH,
      '/selfcheck': { ok: true, ranAt: REPORT.ranAt, counts: { ok: 0, warn: 0, fail: 0 }, results: [] },
    });
    assert.ok(
      !!r.container.querySelector('[data-testid="selfcheck-empty"]'),
      '零条结果被当成了绿灯 —— 这是 ⑤A-2「node --test 对空集返回绿」的同族',
    );
    r.unmount();
  });

  test('★ 点「重新检测」两个数据源都要重新拉（只刷一半 = 半张过期的报告）', async () => {
    const { r, stub } = await renderDiagnostics({ '/health': HEALTH, '/selfcheck': REPORT });
    const before = stub.calls.filter((c) => c.path === '/selfcheck').length;
    assert.ok(before > 0, '前提不成立：初次渲染就没请求过自检');

    await click(buttonByText(r.container, '重新检测'));
    await r.flush();
    await r.flush();

    assert.ok(
      stub.calls.filter((c) => c.path === '/selfcheck').length > before,
      '「重新检测」只刷了 /api/health，自检那一半停在旧结果上',
    );
    r.unmount();
  });
});

/* ═══════════ T-150 ② D-10 #24 / #26 / #27 / #28 —— 服务商目录接进界面 ═══════════ */

/**
 * ## 这一族钉的是什么
 *
 * HANDOFF 的原话：「「+ 添加服务商」只有 11 个预设 —— 目录 24 家 / 520 条，
 * 实际接进下拉的是 11 家 / 283 条。**够不到的 13 家 / 237 条不是漏了，是用户加不进去**」。
 *
 * 判据不是"按钮变多了"，是几条各自独立的性质：
 *   #24 目录里**每一家**都在界面上有落点（能加，或者说明为什么不能加）；
 *   #24-bis 写进设置的那条记录，daemon **认得出来**（协议族要翻译，不能原样搬）；
 *   #27 表单字段由这家自己声明的 `configFieldKeys` 决定，不是三件套写死；
 *   #26 「清单从哪来」按 `canRefreshModelList()` 分流措辞；**按钮只给可枚举的那 4 家**
 *       （T-153 之前是"任何一档都不给"，因为当时没有 `POST /api/llm/models` —— 见该条用例）；
 *   #28 出厂空状态要说清为什么空，且**不预选任何一家**。
 */
describe('T-150 ② 服务商目录（D-10 #24 #26 #27 #28）', () => {
  const NO_PROVIDERS = {
    'GET /settings': { settings: {} },
    'GET /secrets': { secrets: [], disclosure: null },
  };

  const withProviders = (providers: unknown[], activeId?: string) => ({
    'GET /settings': {
      settings: {
        'llm.providers': providers,
        ...(activeId ? { 'llm.defaultProviderId': activeId } : {}),
      },
    },
    'GET /secrets': { secrets: [], disclosure: null },
  });

  /* ── #24 ────────────────────────────────────────────────────────────────── */

  test('★ #24：目录里的每一家在界面上都有落点（差额就是"用户加不进来的那几家"）', async () => {
    stubApi(NO_PROVIDERS);
    const r = await render(<LlmSettingsSection />);
    await r.flush();

    // 「更多服务商」默认折叠 —— 先证明它折叠着，再展开（否则下面数到的是别的东西）
    assert.equal(
      !!r.container.querySelector('[data-testid="llm-more"]'),
      false,
      '18 家应默认折叠，平铺 24 个按钮会把置顶六家淹掉',
    );
    await click(r.container.querySelector('[data-testid="llm-more-toggle"]'));
    await r.flush();

    const idsOf = (prefix: string) =>
      [...r.container.querySelectorAll(`[data-testid^="${prefix}"]`)].map(
        (el) => el.getAttribute('data-testid')!.slice(prefix.length),
      );
    const addable = idsOf('llm-add-');
    const explained = idsOf('llm-unsupported-');

    const missing = CATALOG_PRESETS.map((p) => p.spec.id).filter(
      (id) => !addable.includes(id) && !explained.includes(id),
    );
    assert.deepEqual(
      missing,
      [],
      '这些服务商在界面上没有任何落点 —— 用户加不进来，也没有一句话解释为什么',
    );
    assert.equal(
      addable.length + explained.length,
      CATALOG_PRESETS.length,
      '落点数与目录家数对不上（多半是重复渲染了）',
    );
    // 前提自检：目录本身得比旧的写死清单大，否则这条断言在证明一件已经成立的事
    assert.ok(CATALOG_PRESETS.length >= 24, `目录只有 ${CATALOG_PRESETS.length} 家，桩数据错了？`);
    r.unmount();
  });

  test('★ #24：已配置的那家不许在「常用」里再冒出一颗「加号」（老 id 也要认出来）', async () => {
    // 库里存的是**旧 id** `anthropic`，目录 id 是 `claude` —— 不桥接就会配出第二份
    stubApi(
      withProviders([
        {
          id: 'anthropic',
          kind: 'anthropic',
          label: 'Anthropic',
          baseUrl: 'https://api.anthropic.com',
          model: 'x',
          isLocal: false,
        },
      ]),
    );
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    assert.equal(
      !!r.container.querySelector('[data-testid="llm-add-claude"]'),
      false,
      '库里已经有 Anthropic 了（老 id），「常用」还列着 Claude —— 点下去就是第二份配置',
    );
    // 前提：别的家仍然该在（否则"什么都没渲染"也能过）
    assert.ok(r.container.querySelector('[data-testid="llm-add-openai"]'), '其余置顶家应仍可添加');
    r.unmount();
  });

  test('★ #24-bis：写进设置的 kind 必须是 daemon 认得的那三种，不是目录里的协议族名', async () => {
    const stub = stubApi(NO_PROVIDERS);
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    await click(r.container.querySelector('[data-testid="llm-add-claude"]'));
    await r.flush();

    const patchCall = stub.calls.find((c) => c.method === 'PATCH' && c.path === '/settings');
    assert.ok(patchCall, '点了添加 Claude 却什么都没写');
    const body = patchCall!.body as Record<string, unknown>;
    const written = (body['llm.providers'] as { id: string; kind: string }[]).find(
      (p) => p.id === 'claude',
    );
    assert.ok(written, `写进去的清单里没有 claude → ${JSON.stringify(body['llm.providers'])}`);
    /*
     * ★ 这一条是 D-10 §8-D1 那颗雷的**前端一半**。
     *
     * 目录里 Claude 的 kind 是 `anthropic-native`；而 daemon 的
     * `resolveConfiguredProvider()` 只 `switch` 三种（`anthropic`/`gemini`/`openai-compatible`），
     * 其余一律走 default：打一条 error 然后返回 undefined ——
     * 用户看到的是"没配 LLM"，**而他明明刚配完**。
     * daemon 侧已经改成按 kind 分派了，这半边（谁来翻译）到现在才补上。
     */
    assert.equal(written!.kind, 'anthropic', '把目录的协议族名原样写进去了，daemon 认不出来');
    assert.equal(body['llm.defaultProviderId'], 'claude', '第一家应当直接生效');
    r.unmount();
  });

  test('★ 目录 kind 到行为契约：全表覆盖，且确实做了翻译（不是恰好同名）', () => {
    // 总表：目录新增一种协议族而没人表态 → 这里当场红（TS 那层也会红，双保险）
    for (const k of PROVIDER_KINDS) {
      assert.ok(k in WIRE_KIND_BY_CATALOG_KIND, `协议族 ${k} 没有表态要映到哪个行为契约`);
    }
    const wire = new Set(['openai-compatible', 'anthropic', 'gemini']);
    for (const p of CATALOG_PRESETS) {
      if (!p.config) continue;
      assert.ok(
        wire.has(p.config.kind),
        `${p.spec.id} 写进设置的 kind=${p.config.kind}，daemon 的 switch 认不出来`,
      );
    }
    /*
     * 前提自检：**必须真的有需要翻译的**。
     * 目录里如果恰好每一家都是 `openai-compatible`，上面那条断言就是恒真的空话。
     */
    const translated = CATALOG_PRESETS.filter(
      (p) => p.config && (p.config.kind as string) !== (p.spec.kind as string),
    );
    assert.ok(translated.length > 0, '一家需要翻译的都没有 —— 那上面那条断言什么都没证明');
  });

  test('★ 目录给的接口地址与我们适配器要的地址不同，两处已知差异必须已经校正', () => {
    /*
     * 这两条各自钉一个**具体会坏的后果**，不是"字段存在"：
     *  · gemini：`GeminiProvider` 自己拼 `/v1beta`（gemini.ts:164）。
     *    目录给的地址已经带着它，原样用会拼成 `…/v1beta/v1beta/models/…`。
     *  · ollama：`OpenAiCompatibleProvider` 拼 `/chat/completions`（openai-compatible.ts:119），
     *    而 Ollama 的 OpenAI 兼容面在 `/v1` 下。少这一段就是 404。
     */
    const spec = (id: string) => {
      const s = catalogProviderFor(id);
      assert.ok(s, `目录里没有 ${id}`);
      return s!;
    };
    const gemini = spec('gemini');
    assert.ok(
      (gemini.baseUrl.default ?? '').endsWith('/v1beta'),
      '前提变了：目录里 gemini 的地址不再带 /v1beta，这条校正可能已经多余，请复核',
    );
    assert.equal(
      adapterBaseUrl(gemini).endsWith('/v1beta'),
      false,
      'GeminiProvider 会再拼一次 /v1beta —— 原样用会请求 …/v1beta/v1beta/models/…',
    );

    const ollama = spec('ollama');
    assert.ok(
      adapterBaseUrl(ollama).endsWith('/v1'),
      `Ollama 的 OpenAI 兼容面在 /v1 下，实际写进去的是 ${adapterBaseUrl(ollama)}`,
    );
    assert.equal(presetConfigFor(ollama)!.isLocal, true, '回环地址应认成本地服务');
  });

  test('★ 驱动不了的那家照样看得见，并且当场说明原因（不是悄悄抹掉）', async () => {
    const unsupported = CATALOG_PRESETS.filter((p) => !p.support.supported);
    assert.ok(
      unsupported.length > 0,
      '目录里每一家我们都驱动得了 —— 那这条用例没有被测对象，删掉它或换一个',
    );
    stubApi(NO_PROVIDERS);
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    await click(r.container.querySelector('[data-testid="llm-more-toggle"]'));
    await r.flush();

    for (const p of unsupported) {
      const el = r.container.querySelector(`[data-testid="llm-unsupported-${p.spec.id}"]`);
      assert.ok(el, `${p.spec.id} 从清单里消失了 —— 用户会以为"这个产品不支持它"`);
      assert.ok(
        (el!.textContent ?? '').includes(p.spec.displayName),
        `${p.spec.id} 只剩一句错误，连名字都没有`,
      );
      // 它不能是个点得动的按钮 —— 点下去必然配出一份坏配置
      assert.equal(el!.querySelector('button') === null, true, `${p.spec.id} 不该是可点的`);
    }
    r.unmount();
  });

  /* ── #27 configFieldKeys 驱动表单 ─────────────────────────────────────────── */

  async function openForm(providerId: string) {
    const preset = CATALOG_PRESETS.find((p) => p.spec.id === providerId);
    assert.ok(preset, `目录里没有 ${providerId}`);
    stubApi(withProviders([preset!.config], providerId));
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    await click(buttonByText(r.container, '编辑'));
    await r.flush();
    return r;
  }

  test('★ #27：Ollama 的表单里不许有 API Key 输入框（它的 configFieldKeys 里就没有）', async () => {
    // 前提取自数据，不是我记住的：目录说它不要 key
    const ollama = CATALOG_PRESETS.find((p) => p.spec.id === 'ollama')!;
    assert.equal(ollama.fields.includes('apiKey'), false, '前提变了：目录现在说 Ollama 要 key');

    const r = await openForm('ollama');
    assert.equal(
      !!r.container.querySelector('[data-testid="llm-field-apiKey"]'),
      false,
      '逼用户给 Ollama 编一个假 key —— 这正是竞品的已知 bug（R-01 §C11 #12）',
    );
    // 对照：它要的那两个字段得在（否则"整个表单没渲染"也能让上面那条过）
    assert.ok(r.container.querySelector('[data-testid="llm-field-baseURL"]'), 'baseURL 该在');
    assert.ok(r.container.querySelector('[data-testid="llm-model-select"]'), 'model 该在');
    // 卡片上也不许写「未设置 Key」—— 那对一个不收 key 的服务是撒谎
    const card = r.container.querySelector('[data-testid="llm-provider-ollama"]');
    assert.ok(card, '找不到 ollama 的卡片');
    assert.equal(
      (card!.textContent ?? '').includes('未设置 Key'),
      false,
      '给一个不收 Key 的本地服务写「未设置 Key」是撒谎',
    );
    r.unmount();
  });

  /**
   * ★ **这条才是 #27 真正的判据** —— 上一条（Ollama）其实分不开新旧两套规则。
   *
   * 旧规则是「`isLocal` 就不给 Key 框」，而 Ollama 恰好两条规则给出同一个答案
   * （它既是本地服务、目录里也确实没有 `apiKey`）。把实现退回旧规则跑一遍，
   * 上一条**照样绿** —— 那说明它钉住的是零（HANDOFF ⑤A-18 规矩 2）。
   *
   * LM Studio 是把两条规则分开的那个：**它是本地服务，但目录里它声明了 `apiKey`**
   * （较新的版本真的支持给 server 设 key）。
   *   · 旧规则 → Key 框被藏掉，设了 key 的用户配不上，界面一个字不说；
   *   · 新规则（R-P3）→ 照它自己声明的字段渲染。
   */
  test('★ #27：LM Studio 是本地服务但目录说它收 Key —— 判据是 configFieldKeys，不是 isLocal', async () => {
    const lm = CATALOG_PRESETS.find((p) => p.spec.id === 'lmstudio')!;
    // 前提两条都取自数据：它是本地的，而且目录说它收 key
    assert.equal(lm.config?.isLocal, true, '前提变了：LM Studio 不再是回环地址');
    assert.equal(lm.fields.includes('apiKey'), true, '前提变了：目录说 LM Studio 不收 key');

    const r = await openForm('lmstudio');
    assert.ok(
      r.container.querySelector('[data-testid="llm-field-apiKey"]'),
      '按 isLocal 把 Key 框藏掉了 —— 给 LM Studio 设过 key 的用户在界面上无路可走',
    );
    // 卡片上的 Key 状态同理：它收 key，就该说 key 配没配
    const card = r.container.querySelector('[data-testid="llm-provider-lmstudio"]');
    assert.ok(card, '找不到 lmstudio 的卡片');
    assert.ok(
      (card!.textContent ?? '').includes('未设置 Key'),
      `一家收 Key 的服务商没显示 Key 状态 → ${card!.textContent}`,
    );
    r.unmount();
  });

  test('★ #27 对照：要 Key 的那家必须有 Key 输入框', async () => {
    const deepseek = CATALOG_PRESETS.find((p) => p.spec.id === 'deepseek')!;
    assert.equal(deepseek.fields.includes('apiKey'), true, '前提变了：目录说 DeepSeek 不要 key');
    const r = await openForm('deepseek');
    assert.ok(
      r.container.querySelector('[data-testid="llm-field-apiKey"]'),
      'DeepSeek 没有 Key 输入框，用户配不上',
    );
    r.unmount();
  });

  test('★ #27：不许出现一个"改了不生效"的接口地址栏', async () => {
    const locked = CATALOG_PRESETS.filter((p) => !p.spec.baseUrl.editable);
    assert.ok(locked.length > 0, '目录里没有 editable=false 的了 —— 这条用例没有被测对象');
    const target = locked[0]!;
    /*
     * 这一家我们驱动不了（`config` 是 null），添加按钮加不进来 ——
     * 但用户库里可能已经存着一条（手改设置 / 老版本留下的）。
     * 表单**照样得按目录的规矩渲染**。
     *
     * ⚠️ 判据是**后果**（"不许有一个可编辑但改了不生效的地址栏"），
     * 不是形式（"必须有一个 readOnly 的 input"）：当前目录里这一家的
     * `configFieldKeys` 连 `baseURL` 都没有，正确做法是**根本不画**。
     * 上一版我把判据写成了后者，红在"地址栏不在" —— 而"地址栏不在"恰恰是对的行为。
     */
    stubApi(
      withProviders([
        {
          id: target.spec.id,
          kind: 'openai-compatible',
          label: target.spec.displayName,
          baseUrl: 'https://whatever.invalid',
          model: 'm',
          isLocal: false,
        },
      ]),
    );
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    await click(buttonByText(r.container, '编辑'));
    await r.flush();
    // 前提：表单确实打开了（否则下面那条对空表单恒真）
    assert.ok(r.container.querySelector('[data-testid="llm-save"]'), '表单没打开');
    const input = r.container.querySelector('[data-testid="llm-field-baseURL"]');
    assert.equal(
      input !== null && !(input as HTMLInputElement).readOnly,
      false,
      `${target.spec.id} 不接受自定义接口地址，界面却给了一个可编辑的框 —— 改了也不会生效`,
    );
    r.unmount();
  });

  test('★ #27：地址栏三档由两个正交字段决定（readonly 那档目前没有活体，单独测）', () => {
    const fake = (
      fields: readonly string[],
      editable: boolean,
    ): Parameters<typeof baseUrlFieldMode>[0] =>
      ({
        fields,
        spec: { baseUrl: { editable } },
      }) as unknown as Parameters<typeof baseUrlFieldMode>[0];

    assert.equal(baseUrlFieldMode(fake([], true)), 'hidden', '不收地址就别画那一栏');
    assert.equal(
      baseUrlFieldMode(fake(['baseURL'], false)),
      'readonly',
      '收地址但不许改 → 只读；给可编辑的框就是一个改了不生效的输入框',
    );
    assert.equal(baseUrlFieldMode(fake(['baseURL'], true)), 'editable');
    // 认不出这家（自定义网关 / 老 id）时宁可多给一栏，否则他配不上
    assert.equal(baseUrlFieldMode(null), 'editable');

    // 前提自检：目录里当前那一家走的确实是 hidden 而不是 readonly
    const locked = CATALOG_PRESETS.filter((p) => !p.spec.baseUrl.editable);
    assert.deepEqual(
      locked.map((p) => baseUrlFieldMode(p)),
      locked.map(() => 'hidden'),
      '目录变了：现在有一家"收地址但不许改"，组件层该给它补一条用例了',
    );
  });

  /* ── #26 刷新分流 ───────────────────────────────────────────────────────── */

  // ⚠️ 用例名跟着断言一起改（⑤A-18：名字与断言之间没有任何机制在约束，
  //    改了断言不改名字，下一个人读到的就是一句假话）。
  test('★ #26：两档说的话必须不一样；刷新按钮只给可枚举的那 4 家', async () => {
    const doc = CATALOG_PRESETS.find(
      (p) =>
        p.spec.modelListSource.type === 'official-doc' &&
        p.support.supported &&
        p.spec.configFieldKeys.includes('model'),
    );
    const api = CATALOG_PRESETS.find(
      (p) => p.refreshable && p.support.supported && p.spec.configFieldKeys.includes('model'),
    );
    assert.ok(doc, '目录里一家人工转录的都没有');
    assert.ok(api, '目录里一家可枚举的都没有 —— 这条用例没有被测对象');
    assert.equal(doc!.refreshable, false);

    const noteTextOf = async (id: string) => {
      const r = await openForm(id);
      const note = r.container.querySelector('[data-testid="llm-model-select-note"]');
      assert.ok(note, `${id} 的候选清单旁边一个字都没有`);
      const buttons = [...r.container.querySelectorAll('button')].map((b) => b.textContent ?? '');
      const txt = note!.textContent ?? '';
      r.unmount();
      return { txt, buttons };
    };

    const a = await noteTextOf(doc!.spec.id);
    const b = await noteTextOf(api!.spec.id);
    /*
     * ⚠️ **上一版这里只写了 `assert.notEqual(a.txt, b.txt)`，而它钉住的是零。**
     * 两家的条目数与核对日期本来就不同（30 / 2026-05-31 vs 4 / 2026-05-02），
     * 所以哪怕把分流整条拿掉、两边走同一句模板，这条断言**照样绿** ——
     * 反向验证时它真的没红。换成下面按"说了什么"断的两条。
     */
    assert.ok(
      a.txt.includes(doc!.spec.modelListSource.checkedAt ?? '__no_checked_at__'),
      `人工转录的那档必须把核对日期说出来 → ${a.txt}`,
    );
    assert.equal(
      b.txt.includes(api!.spec.modelListSource.checkedAt ?? '__no_checked_at__'),
      false,
      `可枚举的那档被套上了"人工核对于 X"的说法 → ${b.txt}`,
    );
    assert.notEqual(a.txt, b.txt, '两档说成了同一句话');
    /*
     * ★ **按钮只给可枚举的那 4 家 —— T-153 把这条改回了 R-P2 的原样。**
     *
     * 📝 **此前这里断的是"两档都不许有刷新按钮"**，理由写着：
     * > R-P2 只说"不给那 20 家"，实际情况更硬：全仓没有任何端点能替前端枚举
     * > （daemon 路由表里没有 /api/llm/models）。给那 4 家按钮同样是按不动的。
     *
     * 那个判断是对的 —— 在它成立的那一天。T-153 补上了 `POST /api/llm/models`，
     * **前提消失了**，所以这条断言换成 R-P2 的原文。
     * 保留旧文是因为它记录的是一次正确的克制，不是一个错误
     * （⑤A-15：旧断言写错方向时要说明白，这次是旧断言的**前提**变了）。
     */
    assert.deepEqual(
      a.buttons.filter((x) => x.includes('刷新')),
      [],
      '人工转录的那 20 家不许有刷新按钮 —— 它们没有端点可调，按了也不会有任何事发生',
    );
    assert.equal(
      b.buttons.filter((x) => x.includes('刷新')).length,
      1,
      `可枚举的那 4 家必须有刷新按钮（${api!.spec.id}）—— daemon 侧 POST /api/llm/models 已经存在`,
    );
  });

  /* ── #28 出厂空状态 ─────────────────────────────────────────────────────── */

  test('★ #28：出厂空状态说清为什么空、下一步点哪，且一家都不预选', async () => {
    const stub = stubApi(NO_PROVIDERS);
    const r = await render(<LlmSettingsSection />);
    await r.flush();

    const box = r.container.querySelector('[data-testid="llm-empty"]');
    assert.ok(box, '出厂什么都没配时，界面上只有一句"还没有配置"是不够的');
    const emptyCopy = (zhLocale as unknown as { settings: { empty: Record<string, string> } })
      .settings.empty;
    const boxText = box!.textContent ?? '';
    // 三条判据逐条对着词条查，不手抄文案（手抄的白名单会过期）
    assert.ok(boxText.includes(emptyCopy['title']!), '没说"还没配"');
    assert.ok(boxText.includes(emptyCopy['why']!), '没说清为什么空 —— 用户会以为是加载失败');
    assert.ok(boxText.includes(emptyCopy['local']!), '没给已装 Ollama/LM Studio 的人指路');

    // 下一步点哪：置顶六家就在眼前
    for (const id of MAINSTREAM_PROVIDER_IDS) {
      assert.ok(
        r.container.querySelector(`[data-testid="llm-add-${id}"]`),
        `置顶六家里的 ${id} 不在眼前`,
      );
    }
    // ★ 不预选、不假装：渲染一次没有发出过任何写请求
    assert.deepEqual(
      stub.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`),
      [],
      '出厂空状态发出了写请求 —— 那就是在替用户做决定',
    );
    // 「当前生效」必须说"未生效"，不许挑一个出来假装
    const eff = r.container.querySelector('[data-testid="llm-effective"]');
    assert.ok(eff, '没有"当前生效"这一行');
    assert.equal(
      /deepseek|openai|claude|gemini/i.test(eff!.textContent ?? ''),
      false,
      `一家都没配，"当前生效"却写了一个服务商名 → ${eff!.textContent}`,
    );
    r.unmount();
  });

  /* ── T-153 #3 「本地模型」折叠组（`POST /api/llm/detect` 的消费方）─────────── */

  /**
   * D-10 #3 在 T-150 时**整条卡死**：`POST /api/llm/detect` 不存在，
   * 做出来只能是个假按钮。T-153 补上了端点，这一组钉的是那个消费方。
   *
   * 三条判据，各挡一种"看起来做了"：
   *   ① 首屏说"还没探测过"，**不许说"未检测到"**（我们还没资格下这个结论）；
   *   ② 探不到时必须列出**探过哪几个地址** —— 只说"没探到"，用户分不清
   *      "我的 Ollama 改过端口"和"我压根没装"；
   *   ③ 探到的每条必须显示"它报了几个模型" —— 那是"真发请求确认"这条判据的证据。
   */
  const DETECT_EMPTY = {
    probed: [
      { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
      { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
    ],
    detected: [],
    timeoutMs: 2000,
    probedAt: '2026-08-06T00:00:00.000Z',
  };

  const openLocal = async (routes: Record<string, unknown>) => {
    const stub = stubApi({ ...NO_PROVIDERS, ...routes });
    const r = await render(<LlmSettingsSection />);
    await r.flush();
    await click(r.container.querySelector('[data-testid="llm-local-toggle"]') as HTMLElement);
    await r.flush();
    return { r, stub };
  };

  test('★ T-153 #3：还没点探测之前，不许说"未检测到" —— 那是我们还没资格下的结论', async () => {
    const { r, stub } = await openLocal({});
    const status = r.container.querySelector('[data-testid="llm-detect-status"]');
    assert.ok(status, '「本地模型」组里没有状态文字');
    const copy = (zhLocale as unknown as { settings: { local: Record<string, string> } }).settings
      .local;
    assert.equal(status!.textContent, copy['notProbedYet']);
    /*
     * ⚠️ 判据取"说了什么"，不取"有没有字" —— `none` 与 `notProbedYet` 都非空，
     * 只断非空的话把两者写成同一句照样绿。
     */
    assert.notEqual(copy['notProbedYet'], copy['none'], '「还没探」与「没探到」被写成了同一句话');
    // 而且**展开一个折叠组不该发请求**：探测要花 2 秒 × 3 个端口，只该在用户按下时发生
    assert.deepEqual(
      stub.calls.filter((c) => c.path.startsWith('/llm/')).map((c) => c.path),
      [],
      '光是展开「本地模型」就去敲了本机端口',
    );
    r.unmount();
  });

  test('★ T-153 #3：探不到时必须列出"探过哪几个地址"，且地址来自响应而不是文案', async () => {
    const { r, stub } = await openLocal({ 'POST /llm/detect': DETECT_EMPTY });
    await click(r.container.querySelector('[data-testid="llm-detect"]') as HTMLElement);
    await r.flush();

    assert.deepEqual(
      stub.calls.filter((c) => c.path === '/llm/detect').map((c) => c.method),
      ['POST'],
      'GET 会被浏览器/中间层预取与缓存 —— 一个"被预取就会敲三个端口"的端点不该是 GET',
    );

    const probed = r.container.querySelector('[data-testid="llm-detect-probed"]');
    assert.ok(probed, '探完了却没说探过哪几个地址');
    const txt = probed!.textContent ?? '';
    for (const c of DETECT_EMPTY.probed) {
      assert.ok(txt.includes(c.baseUrl), `没有把 ${c.baseUrl} 列出来 → ${txt}`);
    }
    // 超时值也来自响应：文案里写死"2 秒"就会变成第二处事实
    assert.ok(txt.includes('2'), `没有把超时值说出来 → ${txt}`);
    r.unmount();
  });

  test('★ T-153 #3：探到的每一条都要显示"它报了几个模型"，并且能一键加进列表', async () => {
    const { r, stub } = await openLocal({
      'POST /llm/detect': {
        ...DETECT_EMPTY,
        detected: [
          {
            id: 'ollama',
            label: 'Ollama',
            baseUrl: 'http://127.0.0.1:11434/v1',
            models: ['qwen3:8b', 'llama3.2'],
            latencyMs: 12,
          },
        ],
      },
      'PATCH /settings': { settings: {} },
    });
    await click(r.container.querySelector('[data-testid="llm-detect"]') as HTMLElement);
    await r.flush();

    const row = r.container.querySelector('[data-testid="llm-detected-ollama"]');
    assert.ok(row, '探到了却没列出来');
    /*
     * ★ "它报了几个模型"是**这条判据的证据**：探测的定义就是"真的问出了模型列表"
     * （端口开着不算）。只显示"检测到 Ollama"的话，用户没法区分
     * "探到了服务"和"探到了能用的服务"。
     *
     * ⚠️ **第一版我写的是 `.includes('2')`，它钉住的是零** —— 反向验证时把整段
     * "报了几个模型"删掉，这条**照样绿**：同一行里的 `http://127.0.0.1:11434/v1`
     * 自带一个 `2`（在 `127` 里）。换成整句词条渲染后的原文，那个变异当场红。
     * （今天第三次撞上同一族：断言必须钉住"说了什么"，不是"出现过某个字符"。）
     */
    const localCopy = (zhLocale as unknown as { settings: { local: Record<string, string> } })
      .settings.local;
    const expectModels = localCopy['models']!.replace('{{n}}', '2');
    assert.ok(
      (row!.textContent ?? '').includes(expectModels),
      `没说它报了几个模型（期望包含「${expectModels}」）→ ${row!.textContent}`,
    );

    await click(r.container.querySelector('[data-testid="llm-detected-add-ollama"]') as HTMLElement);
    await r.flush();

    const patch = stub.calls.find((c) => c.method === 'PATCH' && c.path === '/settings');
    assert.ok(patch, '点「+ 添加」什么都没发出去');
    const body = patch!.body as Record<string, unknown>;
    /*
     * ★ 写进去的必须是 **daemon 真读的那几个键**（HANDOFF ⑤C 的 `llm.defaultProviderId`
     * 那一条：前端曾经把 providers 写全了、唯独没写这个键，于是"填了等于没填"）。
     */
    assert.equal(body[LLM_SETTING_KEYS.defaultProviderId], 'ollama');
    assert.equal(body[LLM_SETTING_KEYS.defaultModelId], 'qwen3:8b');
    assert.equal(body[`${LLM_SETTING_KEYS.baseUrlPrefix}ollama`], 'http://127.0.0.1:11434/v1');
    // 协议族要能被 daemon 的 switch 认出来（D-10 §8-D1 那颗雷）
    const providers = body['llm.providers'] as { id: string; kind: string }[];
    assert.equal(providers.find((p) => p.id === 'ollama')?.kind, 'openai-compatible');
    r.unmount();
  });
});

/* ═══════════ T-150 ② D-10 #9 / #10 / #29 —— 转写 Tab 三分组与档位 ═══════════ */

/**
 * ## 这一族钉的是什么
 *
 * 分组规则本身由 `features/models/asrSections.test.ts` 逐条钉死（纯函数，10 条）。
 * 这里只钉**它真的被接上了**，以及三件只有渲染层能出错的事：
 *
 * ① `role=vad` / `role=punctuation` 的卡片**真的出现在页面上**。
 *    此前 `ModelsPage` 写死 `g.role === 'asr'` —— 它们一张都不渲染，
 *    而 daemon 的 `model.vad` 自检项发的 remediation 是
 *    「在「模型」页安装 `vad/silero-vad-ggml`」：**一条具体但无法执行的指引**。
 * ② `superseded` 是**折叠**不是删除：默认不平铺，但数得出来、展得开。
 * ③ VAD 那一组两个变体的 `quantization` **都是 f16**，差的是 engine。
 *    只按量化档标注 = 两行一模一样的「F16」，而选错的后果 T-148 已经付过一次
 *    （whisper 报 `bad magic`，整单转写死）。
 */
describe('T-150 ② 转写 Tab 三分组（D-10 #9 #10 #29）', () => {
  /** 一个覆盖三组的目录桩。**用真实标签**，不用 id 白名单 —— 判据本身就不看 id。 */
  function catalogGroups() {
    const v = (
      id: string,
      speedClass: string,
      tags: string[],
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      groupId: id,
      role: 'asr',
      arch: 'whisper',
      format: 'ggml',
      quantization: 'q5_1',
      speedClass,
      languages: ['multi'],
      tags,
      engines: ['whisper.cpp'],
      totalSizeBytes: 1_000_000,
      catalogVersion: '2026.08.06',
      license: { id: 'MIT', url: 'https://example.invalid', requiresAcceptance: false, gated: false },
      files: [{ name: 'a.bin', sha256: 'x'.repeat(64), sizeBytes: 1_000_000, optional: false }],
      requirements: { ramRequiredMB: 512, vramRequiredMB: 0, computedAtContext: null },
      fitness: {
        tier: 'recommended',
        reasonZh: 'stub reason',
        notRecommendedForLanguage: false,
        speedTier: 'unknown',
        speedSource: 'none',
        estMinutesPerAudioHour: null,
        estGpuLayers: null,
      },
      ...extra,
    });
    const g = (
      groupId: string,
      role: string,
      displayName: string,
      variants: ReturnType<typeof v>[],
    ) => ({
      groupId,
      role,
      displayName,
      displayNameZh: displayName,
      descriptionZh: 'stub',
      descriptionEn: 'stub',
      tags: [],
      variants: variants.map((x) => ({ ...x, groupId, role })),
    });

    return [
      g('asr/paraformer-zh-small', 'asr', 'Paraformer', [
        v('asr/paraformer-zh-small', 'fast', ['recommended-default-zh']),
      ]),
      g('asr/sherpa-streaming-zh-14m', 'asr', 'sherpa streaming', [
        v('asr/sherpa-streaming-zh-14m', 'fast', ['required-for-f3'], { engines: ['sherpa-onnx'] }),
      ]),
      // ★ 两个变体 quantization 完全相同，差的是 engine —— 这正是 T-148 那次事故的形状
      g('vad/silero-vad', 'vad', 'Silero VAD', [
        v('vad/silero-vad-onnx', 'fast', ['vad'], {
          quantization: 'f16',
          engines: ['sherpa-onnx'],
        }),
        v('vad/silero-vad-ggml', 'fast', ['vad'], {
          quantization: 'f16',
          engines: ['whisper.cpp'],
        }),
      ]),
      g('punctuation/ct-transformer-zh-en', 'punctuation', 'punctuation restore', [
        v('punctuation/ct-transformer-zh-en', 'balance', ['punctuation'], {
          engines: ['sherpa-onnx'],
        }),
      ]),
      g('asr/whisper-large-v3', 'asr', 'large v3', [v('asr/whisper-large-v3-q5_0', 'quality', [])]),
      g('asr/whisper-large-v2', 'asr', 'large v2', [
        v('asr/whisper-large-v2-q5_0', 'quality', ['superseded']),
      ]),
      g('asr/whisper-large-v1', 'asr', 'large v1', [
        v('asr/whisper-large-v1-f16', 'quality', ['superseded']),
      ]),
      g('asr/whisper-tiny', 'asr', 'tiny', [v('asr/whisper-tiny-q5_1', 'fast', [])]),
    ];
  }

  function stubAsrTab(extra: Record<string, unknown> = {}, mutate?: (g: unknown[]) => void) {
    const groups = catalogGroups();
    mutate?.(groups);
    return stubApi({
      '/models/catalog?role=all&lang=zh': {
        stale: false,
        fetchedAt: '2026-08-06T00:00:00.000Z',
        groups,
      },
      '/models/catalog?role=all&lang=en': {
        stale: false,
        fetchedAt: '2026-08-06T00:00:00.000Z',
        groups,
      },
      ...extra,
      '/models/installed': { models: [], active: { asr: null, llm: null } },
      '/models/storage': {
        usedBytes: 0,
        volume: { freeBytes: 1_000_000_000, totalBytes: 2_000_000_000 },
        breakdown: [],
        reclaimable: { orphanBlobsBytes: 0, stalePartialsBytes: 0 },
      },
      '/jobs': { jobs: [] },
      '/settings': { settings: {} },
      '/secrets': { secrets: [], disclosure: null },
    });
  }

  const cardIds = (root: Element | null) =>
    [...(root?.querySelectorAll('[data-testid^="model-card-"]') ?? [])].map((el) =>
      el.getAttribute('data-testid')!.replace('model-card-', ''),
    );

  test('★ #10：VAD 与标点的卡片真的渲染出来了（daemon 的修复指引指向这一页）', async () => {
    stubAsrTab();
    const r = await render(<ModelsPage />, { route: '/models' });
    await r.flush();

    const realtime = r.container.querySelector('[data-testid="models-section-realtime"]');
    assert.ok(realtime, '「实时字幕组件」那一组整块不在');
    /*
     * ⚠️ 上一版这里把期望值按 actual 的下标排了一次序 —— **那让它对任何排列都恒真**，
     * 也就是钉住了零。直接比数组，顺序跟着目录走。
     */
    assert.deepEqual(
      cardIds(realtime),
      ['asr/sherpa-streaming-zh-14m', 'vad/silero-vad', 'punctuation/ct-transformer-zh-en'],
      '这一组该装的是一条链路上的三个零件',
    );
    assert.ok(
      cardIds(realtime).includes('vad/silero-vad'),
      'daemon 让用户来这一页装 vad/silero-vad-ggml，而这一页上没有它 —— ' +
        '一条具体但无法执行的指引比没有指引更糟',
    );

    // 另一半：它们不许跑到别的组里去（"随手放宽过滤器"会让这条红）
    for (const other of ['models-section-recommended', 'models-section-more']) {
      const el = r.container.querySelector(`[data-testid="${other}"]`);
      assert.equal(
        cardIds(el).some((id) => id.startsWith('vad/') || id.startsWith('punctuation/')),
        false,
        `${other} 里出现了 VAD/标点 —— 它们不是可以替代 Whisper 的转写模型`,
      );
    }
    r.unmount();
  });

  test('★ #9：推荐只有两张卡，且不与别的组重复', async () => {
    stubAsrTab();
    const r = await render(<ModelsPage />, { route: '/models' });
    await r.flush();
    const rec = r.container.querySelector('[data-testid="models-section-recommended"]');
    assert.ok(rec, '「推荐」那一组不在');
    assert.deepEqual(cardIds(rec), ['asr/paraformer-zh-small']);

    const all = cardIds(r.container);
    assert.equal(
      new Set(all).size,
      all.length,
      `同一个组渲染了两次 → ${JSON.stringify(all)}（用户会以为是两个不同的模型）`,
    );
    r.unmount();
  });

  test('★ #29：档位三档都在，且 superseded 默认折叠、数得出来、展得开', async () => {
    stubAsrTab();
    const r = await render(<ModelsPage />, { route: '/models' });
    await r.flush();

    for (const c of ['fast', 'quality']) {
      assert.ok(
        r.container.querySelector(`[data-testid="models-speed-${c}"]`),
        `档位 ${c} 整块不在`,
      );
    }

    const quality = r.container.querySelector('[data-testid="models-speed-quality"]');
    assert.deepEqual(cardIds(quality), ['asr/whisper-large-v3'], '被取代的两个不该平铺');

    // 折叠 ≠ 隐藏：数字必须写出来，否则用户不知道自己没看见什么
    const toggle = r.container.querySelector('[data-testid="models-superseded-toggle-quality"]');
    assert.ok(toggle, '没有「已被新版本取代的 N 个」这一行');
    assert.ok(
      (toggle!.textContent ?? '').includes('2'),
      `折叠行必须说出有几个 → ${toggle!.textContent}`,
    );
    assert.equal(toggle!.getAttribute('aria-expanded'), 'false', '默认应折叠');

    await click(toggle);
    await r.flush();
    const after = cardIds(r.container.querySelector('[data-testid="models-speed-quality"]'));
    assert.deepEqual(
      after,
      ['asr/whisper-large-v3', 'asr/whisper-large-v2', 'asr/whisper-large-v1'],
      '展开后必须真的看得到 —— 折叠是表态"别选这个"，不是替用户删掉',
    );
    r.unmount();
  });

  test('★ 同一组里两个变体只差 engine 时，选择器必须把 engine 说出来', async () => {
    stubAsrTab();
    const r = await render(<ModelsPage />, { route: '/models' });
    await r.flush();

    const vadCard = r.container.querySelector('[data-testid="model-card-vad/silero-vad"]');
    assert.ok(vadCard, 'VAD 卡片不在');
    await click(vadCard!.querySelector('[data-testid="models-quant-selector"]'));
    await r.flush();

    const options = [...vadCard!.querySelectorAll('[role="option"]')].map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    assert.equal(options.length, 2, `应有两个变体 → ${JSON.stringify(options)}`);
    /*
     * ★ 判据是**分得开**，不是"出现了某个字符串"。
     * 这两个变体的 quantization 都是 f16 —— 只标量化档的话两行逐字相同，
     * 而 daemon 恰恰让用户来这里挑出 ggml 那一个。选错 = whisper 报 bad magic，整单转写死。
     */
    assert.equal(
      new Set(options).size,
      2,
      `两个互相加载不了的变体在选择器里长得一模一样 → ${JSON.stringify(options)}`,
    );
    assert.ok(
      options.some((o) => o.includes('whisper.cpp')) && options.some((o) => o.includes('sherpa')),
      `分得开还不够，得让用户知道分的是什么 → ${JSON.stringify(options)}`,
    );
    r.unmount();
  });

  test('★ 目录描述里的 Markdown 强调不许把裸星号吐给用户', async () => {
    /*
     * 实测：`vad/silero-vad` 的 `descriptionZh` 是
     * 「语音活动检测，**sherpa-onnx 引擎专用格式**。…whisper.cpp 用不了这个文件」。
     * 与 T-129 修掉的 `settings.llmIntro` 是同一族，只是这次文字来自 manifest ——
     * `EMPHASIS_REGISTRY` 那条护栏只扫 locale 文件，**扫不到 manifest**。
     */
    const groups = catalogGroups().map((g) =>
      g.groupId === 'vad/silero-vad'
        ? { ...g, descriptionZh: '语音活动检测，**sherpa-onnx 引擎专用格式**。' }
        : g,
    );
    stubApi({
      '/models/catalog?role=all&lang=zh': { stale: false, fetchedAt: 'x', groups },
      '/models/installed': { models: [], active: { asr: null, llm: null } },
      '/models/storage': {
        usedBytes: 0,
        volume: { freeBytes: 1, totalBytes: 2 },
        breakdown: [],
        reclaimable: { orphanBlobsBytes: 0, stalePartialsBytes: 0 },
      },
      '/jobs': { jobs: [] },
      '/settings': { settings: {} },
      '/secrets': { secrets: [], disclosure: null },
    });
    const r = await render(<ModelsPage />, { route: '/models' });
    await r.flush();

    const card = r.container.querySelector('[data-testid="model-card-vad/silero-vad"]');
    assert.ok(card, 'VAD 卡片不在');
    const shown = card!.textContent ?? '';
    assert.ok(shown.includes('sherpa-onnx 引擎专用格式'), '描述原文一个字都不许丢');
    assert.equal(shown.includes('**'), false, `页面上仍能看到裸的 ** → ${shown}`);
    assert.ok(
      [...card!.querySelectorAll('strong')].some((e) =>
        (e.textContent ?? '').includes('sherpa-onnx'),
      ),
      '强调段应渲染成 <strong>',
    );
    r.unmount();
  });

  /* ── T-153 ② CoreML encoder：用户第一次有办法装上它 ───────────────────────── */

  /**
   * ANE 那条链上的第 2 处断点（`pack-publish` T-146 §3.3 #2）。
   *
   * `libwhisper.coreml.dylib` 早就编进 macOS 包里了，清单里也有 encoder 条目 ——
   * 但它是 `optional`，daemon 只在收到 `includeOptional:['coreml-encoder']` 时才下载
   * （`installer.ts:129`），而 T-153 之前**全仓没有任何地方传过这个值**。
   * 净效果：`asr.coreml` 一直如实报 `warn 未启用 ANE`，
   * 而用户在界面上**没有任何办法**去装它。
   *
   * 三条判据：给不给这个选项 / 勾了传不传 / 不勾传不传。
   */
  const MAC_HARDWARE = {
    snapshotId: 'stub',
    hardware: {
      schemaVersion: 1,
      detectedAt: '2026-08-06T00:00:00.000Z',
      os: { platform: 'darwin', arch: 'arm64', version: '14.5' },
      cpu: { brand: 'Apple M1', physicalCores: 8, logicalCores: 8, features: [] },
      ram: { totalMB: 16384, availableMB: 8192 },
      unifiedMemory: true,
      gpus: [],
      backends: [],
      selectedBackend: 'cpu',
      selectedGpuIndex: null,
      disks: [],
    },
  };
  const LINUX_HARDWARE = {
    ...MAC_HARDWARE,
    hardware: {
      ...MAC_HARDWARE.hardware,
      os: { platform: 'linux', arch: 'x64', version: '6.1' },
      unifiedMemory: false,
    },
  };

  /** 给 tiny 那个组挂一份 coreml-encoder（形状照 `models-whisper.json` 里的真条目）。 */
  const withEncoder = (groups: unknown[]) => {
    const g = (groups as { groupId: string; variants: { files: unknown[] }[] }[]).find(
      (x) => x.groupId === 'asr/whisper-tiny',
    )!;
    g.variants[0]!.files.push({
      role: 'coreml-encoder',
      name: 'ggml-tiny-encoder.mlmodelc.zip',
      sha256: 'e'.repeat(64),
      sizeBytes: 15_000_000,
      optional: true,
      unpack: 'zip',
      platforms: [{ os: 'darwin', arch: 'arm64' }],
      mirrors: [],
    });
  };

  const tinyCard = (root: Element) =>
    root.querySelector('[data-testid="model-card-asr/whisper-tiny"]');

  test('★ T-153：Apple Silicon 上，挂了 encoder 的模型必须给出"同时下载 CoreML 编码器"的选项', async () => {
    stubAsrTab({ '/runtime/hardware': MAC_HARDWARE }, withEncoder);
    const r = await render(<ModelsPage />, { route: '/models' });
    await r.flush();

    const card = tinyCard(r.container);
    assert.ok(card, 'tiny 卡片不在');
    assert.equal(
      !!card!.querySelector('[data-testid="model-coreml-optin"]'),
      true,
      '用户在界面上没有任何办法装 CoreML encoder —— ANE 那条链在这里断掉',
    );
    // 默认**不勾**：它是额外的一大坨字节，勾上等于替用户决定花掉这份流量与磁盘
    const box = card!.querySelector('[data-testid="model-coreml-checkbox"]') as HTMLInputElement;
    assert.equal(box.checked, false, '默认勾上了 —— 那是替用户做决定');
    r.unmount();
  });

  test('★ T-153：勾上之后，POST /models/pull 必须真的带 includeOptional', async () => {
    const stub = stubAsrTab(
      { '/runtime/hardware': MAC_HARDWARE, 'POST /models/pull': { jobId: 'j1' } },
      withEncoder,
    );
    const r = await render(<ModelsPage />, { route: '/models' });
    await r.flush();

    const card = tinyCard(r.container)!;
    await click(card.querySelector('[data-testid="model-coreml-checkbox"]') as HTMLElement);
    await r.flush();
    await click(card.querySelector('[data-testid="models-download-button"]') as HTMLElement);
    await r.flush();

    const pull = stub.calls.find((c) => c.method === 'POST' && c.path === '/models/pull');
    assert.ok(pull, '点了下载却没有发出 POST /models/pull');
    /*
     * ★ 判据是**请求体里那个字段**，不是"勾选框变蓝了"。
     * `installer.ts:129` 的规则是「optional 且不在 includeOptional 里 ⇒ 跳过」——
     * 少了这个字段，勾选框就是一个纯粹的装饰品，而且不会有任何东西报错。
     */
    assert.deepEqual((pull!.body as { includeOptional?: unknown }).includeOptional, [
      'coreml-encoder',
    ]);
    r.unmount();
  });

  test('★ T-153：不勾就不许传 —— 免得替用户下载一大坨他没要的东西', async () => {
    const stub = stubAsrTab(
      { '/runtime/hardware': MAC_HARDWARE, 'POST /models/pull': { jobId: 'j1' } },
      withEncoder,
    );
    const r = await render(<ModelsPage />, { route: '/models' });
    await r.flush();
    await click(
      tinyCard(r.container)!.querySelector('[data-testid="models-download-button"]') as HTMLElement,
    );
    await r.flush();
    const pull = stub.calls.find((c) => c.method === 'POST' && c.path === '/models/pull');
    assert.deepEqual((pull!.body as { includeOptional?: unknown }).includeOptional, []);
    r.unmount();
  });

  test('★ T-153：非 Apple Silicon 上不许出现这个选项（勾了也会被 daemon 按 platforms 滤掉）', async () => {
    stubAsrTab({ '/runtime/hardware': LINUX_HARDWARE }, withEncoder);
    const r = await render(<ModelsPage />, { route: '/models' });
    await r.flush();
    assert.equal(
      !!tinyCard(r.container)!.querySelector('[data-testid="model-coreml-optin"]'),
      false,
      '在 Linux 上画了一个"勾了什么都不会发生"的框，比不画更糟',
    );
    r.unmount();
  });

  test('★ T-153：清单里没挂 encoder 的模型，不许凭空长出这个选项', async () => {
    // 同一台 Mac，只是这个模型的 files 里没有 coreml-encoder —— 判据必须来自清单
    stubAsrTab({ '/runtime/hardware': MAC_HARDWARE });
    const r = await render(<ModelsPage />, { route: '/models' });
    await r.flush();
    assert.equal(
      !!tinyCard(r.container)!.querySelector('[data-testid="model-coreml-optin"]'),
      false,
      '判据成了"是不是 Mac"而不是"这个模型有没有 encoder" —— 勾了会下载一个不存在的文件',
    );
    r.unmount();
  });
});

/* ───────────────── T-155 笔记的删除 / 重命名 —— 三条 mutation 的第一个调用方 ───────────────── */

/**
 * `useDeleteNoteMutation` / `useRenameNoteMutation` / `useMoveNoteMutation` 三条早就写好了，
 * daemon 端点也都是真的，**但全仓零调用方** —— 一条笔记建出来就删不掉、改不了名，
 * 而侧栏的「文件夹」反倒有删除按钮。连文案都写好了：`notes.rename` 在两份 locale 里
 * 躺了很多轮，零处 `t()` 读它。
 *
 * ★ 断言钉的是**请求真的发出去了**（`calls` 里有那一条），不是"菜单里有个删除字样"。
 *   后者在缺陷状态下也能绿：把 onClick 换成空函数，菜单照样长那样。
 */
describe('T-155 笔记的删除 / 重命名入口', () => {
  const NOTE = { uid: 'n1', title: '一条笔记' };
  /*
   * `surfaceState()` 会打一次 `GET /health` 探活（判断 daemon 在不在），
   * 它与"用户点了什么"无关。滤掉它，否则断言钉的就不是本组件的行为了。
   * **只滤这一条**：滤 `startsWith('/notes')` 之外的一切会把真正该被看见的请求也藏起来。
   */
  const acted = (calls: { path: string; method: string }[]) =>
    calls.filter((c) => c.path !== '/health');

  test('★ 点「删除」→ 二次确认 → 真的发出 DELETE /notes/:uid', async () => {
    const { calls } = stubApi({ 'DELETE /notes/n1': { ok: true } });
    const r = await render(<NoteActionsMenu note={NOTE} />);

    await click(r.container.querySelector('[data-testid="note-actions"]') as HTMLElement);
    await click(r.container.querySelector('[data-testid="note-delete"]') as HTMLElement);

    // 确认之前一个请求都不许发 —— 否则"二次确认"只是装饰
    assert.equal(acted(calls).length, 0, '还没确认就已经删了');

    await click(r.container.querySelector('[data-testid="note-delete-confirm"]') as HTMLElement);
    await r.flush();

    assert.deepEqual(
      acted(calls).map((c) => `${c.method} ${c.path}`),
      ['DELETE /notes/n1'],
    );
    r.unmount();
  });

  test('★ 确认框里必须出现这条笔记的标题 —— 删错东西是不可撤销的', async () => {
    stubApi({});
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await click(r.container.querySelector('[data-testid="note-actions"]') as HTMLElement);
    await click(r.container.querySelector('[data-testid="note-delete"]') as HTMLElement);
    assert.equal(text(r.container).includes('一条笔记'), true);
    r.unmount();
  });

  test('★ 重命名：输入新标题回车 → PATCH /notes/:uid 且 body.title 是新值', async () => {
    const { calls } = stubApi({ 'PATCH /notes/n1': { uid: 'n1', title: '改过的名字' } });
    const r = await render(<NoteActionsMenu note={NOTE} />);

    await click(r.container.querySelector('[data-testid="note-actions"]') as HTMLElement);
    await click(r.container.querySelector('[data-testid="note-rename"]') as HTMLElement);
    const input = r.container.querySelector('[data-testid="note-rename-input"]') as HTMLInputElement;
    assert.ok(input, '点重命名后应出现输入框');
    assert.equal(input.value, '一条笔记', '输入框初值必须是当前标题，否则用户得从零打一遍');

    await type(input, '改过的名字');
    await pressKey(input, 'Enter');
    await r.flush();

    const sent = acted(calls);
    assert.equal(sent.length, 1, `期望恰好一条请求，实际：${JSON.stringify(sent)}`);
    assert.equal(sent[0]!.method, 'PATCH');
    assert.equal(sent[0]!.path, '/notes/n1');
    assert.deepEqual((sent[0] as { body?: unknown }).body, { title: '改过的名字' });
    r.unmount();
  });

  test('标题没改 / 改成空白 → 不发请求（那是误操作，不是"把标题清空"）', async () => {
    const { calls } = stubApi({ 'PATCH /notes/n1': { ok: true } });
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await click(r.container.querySelector('[data-testid="note-actions"]') as HTMLElement);
    await click(r.container.querySelector('[data-testid="note-rename"]') as HTMLElement);
    const input = r.container.querySelector('[data-testid="note-rename-input"]') as HTMLInputElement;
    await type(input, '   ');
    await pressKey(input, 'Enter');
    await r.flush();
    assert.equal(acted(calls).length, 0);
    r.unmount();
  });

  test('前提自检：不点那个「⋯」按钮时，菜单里的两项一个都不在 DOM 上', async () => {
    stubApi({});
    const r = await render(<NoteActionsMenu note={NOTE} />);
    assert.equal(!!r.container.querySelector('[data-testid="note-delete"]'), false);
    assert.equal(!!r.container.querySelector('[data-testid="note-rename"]'), false);
    r.unmount();
  });

  /**
   * ★ 这条钉的是 `useMoveNoteMutation` 的端点。
   *
   * 它原来发 `PATCH /api/notes/:uid {folderUid}` —— 而 `rest/content.ts` 的 PATCH
   * 处理器**根本不读 `folderUid`**（只认 title/bodyJson/bodyText/summaryMd/language/anchors），
   * 然后照样回 200 `{ok:true}`。真实端点是 `PUT /api/notes/:uid/folder`
   * （`rest/organize.ts:419`）。**用一个最小组件把 hook 真的调一次**，
   * 而不是去 grep 源码里的字符串 —— 后者钉的是形式。
   */
  test('★ 移动笔记打的是 PUT /notes/:uid/folder，不是 PATCH /notes/:uid', async () => {
    const { calls } = stubApi({ 'PUT /notes/n1/folder': { uid: 'n1', folderUid: 'f1' } });
    function Probe() {
      const move = useMoveNoteMutation();
      return (
        <button type="button" onClick={() => move.mutate({ noteUid: 'n1', folderUid: 'f1' })}>
          移动
        </button>
      );
    }
    const r = await render(<Probe />);
    await click(buttonByText(r.container, '移动'));
    await r.flush();
    const sent = acted(calls);
    assert.deepEqual(
      sent.map((c) => `${c.method} ${c.path}`),
      ['PUT /notes/n1/folder'],
    );
    assert.deepEqual((sent[0] as { body?: unknown }).body, { folderUid: 'f1' });
    r.unmount();
  });
});

/* ══════════════════════════════ T-165 /runtime 三件 ══════════════════════════════ */

/**
 * 一份最小但**形状真实**的目录条目工厂。
 *
 * 默认值抄的是 `[实测 :10000]` 的真实响应：一台 linux/x64 机器上，
 * 目录里适用的包**全部** `recommended: true`、`backend: 'cpu'`。
 */
function pack(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p',
    backend: 'cpu',
    engine: 'whisper.cpp',
    engineVersion: 'v1.9.1',
    os: 'linux',
    arch: 'x64',
    tier: 'downloadable',
    displayName: 'Pack',
    displayNameZh: '包',
    totalSizeBytes: 9_379_235,
    installed: false,
    applicable: true,
    recommended: false,
    priority: 10,
    requiresDriver: null,
    inapplicableReason: null,
    ...over,
  };
}

const HW_LINUX_X64 = {
  hardware: {
    detectedAt: '2026-08-07T00:00:00.000Z',
    os: { platform: 'linux', arch: 'x64', version: '6.1' },
    cpu: { brand: 'Stub CPU', physicalCores: 4, logicalCores: 8, features: ['avx2'] },
    ram: { totalMB: 16000, availableMB: 8000 },
    gpus: [],
    selectedGpuIndex: null,
    unifiedMemory: false,
    disks: [{ path: '/tmp/stub', pathFor: 'models_root', freeMB: 10000, totalMB: 50000 }],
    backends: [{ id: 'cpu', installed: true, available: true, unavailableReason: null }],
    selectedBackend: 'cpu',
  },
  snapshotId: 'hw-local',
};

/**
 * ## T-165 ①「不可用」的三档不许长成同一个样子
 *
 * `apps/daemon/src/http/rest/backends.ts` 花了一整段注释把「不可用」拆成三档，
 * 并且**真的把 `inapplicableKind` 发出来**。它自己写明了这条区分要防什么：
 *
 * > 用户看到"不可用"会以为自己的机器不支持，然后就不装了。
 *
 * `[实测 :10000]` 这台机器上 `whispercpp-vulkan-linux-x64` 的档位是 `undetermined`
 * （probe 还没跑成），而界面给它渲染的是 **「不可用」** ——
 * **它想防的那件事，就是它自己造成的。**
 *
 * 为什么长期没人发现：契约类型 `GetBackendCatalogResponse` 里**根本没有这个字段**，
 * 于是"daemon 精心分了三档"与"前端零消费"可以共存，编译器一个字都不说
 * （`progress-audit §4⑪`；类型已在本轮补进 `packages/shared`）。
 *
 * ── 把名字遮住，这些断言什么时候会失败 ────────────────────────────────────────
 * 任何人把三档重新合并回一句话（含"顺手简化成 `applicable ? … : '不可用'`"），
 * 或者把缺档位时的兜底改成"本机不支持"（= 替 daemon 说一句它没说过的话）。
 */
describe('T-165 ①「不可用」的三档不许长成同一个样子', () => {
  const NOOP = {
    locale: 'zh-CN',
    isActive: false,
    selfTest: null,
    installing: false,
    onInstall: () => undefined,
    onRemove: () => undefined,
    onSelect: () => undefined,
    onSelfTest: () => undefined,
  } as const;

  async function renderKind(kind: string | undefined, reason: string) {
    const p = pack({
      id: 'whispercpp-vulkan-linux-x64',
      backend: 'vulkan',
      applicable: false,
      inapplicableReason: reason,
      ...(kind === undefined ? {} : { inapplicableKind: kind }),
    });
    const r = await render(
      <BackendPackCard {...NOOP} pack={p as never} />,
    );
    return { r, shown: text(r.container) };
  }

  test('★ `undetermined`（还没探测到）不许被说成「不可用」', async () => {
    const { r, shown } = await renderKind('undetermined', '尚未探测到硬件能力');
    assert.equal(
      shown.includes('不可用'),
      false,
      `probe 还没跑成 ≠ 你的机器不支持，界面却说了「不可用」→ ${shown}`,
    );
    assert.ok(shown.includes('待检测'), `没有说出「待检测」这一档 → ${shown}`);
    // daemon 的原话必须照抄，档位不是用来顶替它的
    assert.ok(shown.includes('尚未探测到硬件能力'), `daemon 给的原因被吃掉了 → ${shown}`);
    r.unmount();
  });

  test('★ `unsupported`（探测完成、确认没有设备）才可以说「本机不支持」', async () => {
    const { r, shown } = await renderKind('unsupported', 'no vulkan device enumerated');
    assert.ok(shown.includes('本机不支持'), `没说出「本机不支持」这一档 → ${shown}`);
    r.unmount();
  });

  test('★ `platform`（别的平台的包）说的是平台，不是能力', async () => {
    const { r, shown } = await renderKind('platform', '适用于 win32/x64，与本机不符');
    assert.ok(shown.includes('其它平台'), `没说出「其它平台」这一档 → ${shown}`);
    assert.equal(shown.includes('本机不支持'), false, `平台不匹配被说成了能力不支持 → ${shown}`);
    r.unmount();
  });

  test('★ 三档渲染出来的文本必须两两不同 —— 这条钉的正是「区分」这个后果本身', async () => {
    const a = await renderKind('undetermined', 'R');
    const b = await renderKind('unsupported', 'R');
    const c = await renderKind('platform', 'R');
    const set = new Set([a.shown, b.shown, c.shown]);
    assert.equal(
      set.size,
      3,
      `三档里有两档在屏幕上长得一模一样 → ${JSON.stringify([...set])}`,
    );
    a.r.unmount();
    b.r.unmount();
    c.r.unmount();
  });

  test('★ daemon 没给档位时不许替它说话（既不说"不支持"也不说"待检测"）', async () => {
    const { r, shown } = await renderKind(undefined, '原因由服务端给出');
    assert.equal(shown.includes('本机不支持'), false, `没有证据却断言用户的硬件不支持 → ${shown}`);
    assert.equal(shown.includes('待检测'), false, `同样是编出来的档位 → ${shown}`);
    assert.ok(shown.includes('原因由服务端给出'), `服务端的原话必须还在 → ${shown}`);
    r.unmount();
  });
});

/**
 * ## T-165 ②「推荐」徽章只在真的有得选时才出现
 *
 * daemon 算的是 `recommended = applicable && pack.backend === selectedBackend`。
 * `[实测 :10000]` 本机适用的 6 个包**全部** `recommended: true` ——
 * 因为它们的 `backend` 都是 `cpu`，而选中的后端就是 `cpu`。
 * 于是一页六个「推荐」徽章 + 六个主按钮，**没有区分任何东西**（`progress-audit §4⑩`）。
 *
 * 这里做的是**收窄**不是重算：服务端说不推荐的永远不会变成推荐。
 *
 * ── 把名字遮住，这些断言什么时候会失败 ────────────────────────────────────────
 * 有人把 `recommended` 直接怼回 `pack.recommended`（= 缺陷原状），
 * 或者把收窄写成"增加"（服务端说 false 却渲染出徽章）。
 */
describe('T-165 ②「推荐」徽章只在真的有得选时才出现', () => {
  /** `[实测 :10000]` 的形状：本机适用的包全是 cpu、全 recommended。 */
  const REAL_SHAPE = [
    pack({ id: 'whispercpp-cpu-linux-x64', engine: 'whisper.cpp', installed: true, recommended: true }),
    pack({
      id: 'whispercpp-vulkan-linux-x64',
      engine: 'whisper.cpp',
      backend: 'vulkan',
      applicable: false,
      inapplicableKind: 'undetermined',
      inapplicableReason: '尚未探测到硬件能力',
      recommended: false,
    }),
    pack({ id: 'media-tools-linux-x64', engine: 'ffmpeg', installed: true, recommended: true }),
    pack({ id: 'ytdlp-linux-x64', engine: 'yt-dlp', installed: true, recommended: true }),
    pack({ id: 'libsimple-linux-x64', engine: 'sqlite-ext', installed: true, recommended: true }),
    pack({ id: 'sqlite-vec-linux-x64', engine: 'sqlite-ext', installed: true, recommended: true }),
  ];

  test('★ 六个「推荐」里只有一个承载信息 —— 其余五个没有任何备选', () => {
    const kept = REAL_SHAPE.filter((p) =>
      isMeaningfulRecommendation(p as never, REAL_SHAPE as never),
    ).map((p) => p['id']);
    assert.deepEqual(
      kept,
      ['whispercpp-cpu-linux-x64'],
      'ffmpeg / yt-dlp / sqlite 扩展在这台机器上各只有一个包，"推荐"不回答任何问题',
    );
  });

  test('★ 只收窄不增加：服务端说不推荐的，这里永远不会说推荐', () => {
    const all = [
      pack({ id: 'a', backend: 'cpu', recommended: false }),
      pack({ id: 'b', backend: 'vulkan', recommended: false }),
    ];
    assert.equal(isMeaningfulRecommendation(all[0] as never, all as never), false);
    assert.equal(isMeaningfulRecommendation(all[1] as never, all as never), false);
  });

  test('★ 备选必须是同一个引擎、同一个平台 —— ffmpeg 不是 whisper 的备选', () => {
    const all = [
      pack({ id: 'w', engine: 'whisper.cpp', backend: 'cpu', recommended: true }),
      pack({ id: 'f', engine: 'ffmpeg', backend: 'cpu' }),
      pack({ id: 'w-mac', engine: 'whisper.cpp', backend: 'metal', os: 'darwin', arch: 'arm64' }),
    ];
    assert.equal(
      isMeaningfulRecommendation(all[0] as never, all as never),
      false,
      '别的引擎和别的平台的包都不是这台机器上的"另一个选项"',
    );
  });

  /**
   * ★ 这一条钉的是**接线**：`RuntimePage` 有没有真的算这一步。
   *
   * 只测纯函数的话，把 `recommended={…}` 那一行删掉（回到 `pack.recommended`），
   * 上面三条**照样全绿** —— 本仓最贵的形状就是"函数写好了没有人调它"。
   *
   * 判据是**逐张卡**而不是数总数：数总数会被 `StatusChip` 的嵌套 span 蒙对
   * （外层与内层 textContent 都是「推荐」，第一版就是这么把 1 数成 2 的）。
   */
  test('★ 接线：徽章只落在真有备选的那张卡上，另外四张一个都没有', async () => {
    stubApi({
      '/runtime/hardware': HW_LINUX_X64,
      '/backends/catalog': { catalogVersion: 'v', source: 'bundled', stale: false, packs: REAL_SHAPE },
      '/backends/installed': { selectedBackend: 'cpu', packs: [] },
    });
    const r = await render(<RuntimePage />, { route: '/runtime' });
    await r.flush();

    const badged = (id: string): boolean => {
      const card = r.container.querySelector(`[data-testid="backend-pack-${id}"]`);
      assert.ok(card, `卡片 ${id} 没渲染出来 —— 前提不成立`);
      return [...card!.querySelectorAll('[data-tone="good"]')].some(
        (e) => (e.textContent ?? '').trim() === '推荐',
      );
    };

    assert.equal(badged('whispercpp-cpu-linux-x64'), true, 'CPU 与 Vulkan 之间确实有得选');
    for (const id of [
      'media-tools-linux-x64',
      'ytdlp-linux-x64',
      'libsimple-linux-x64',
      'sqlite-vec-linux-x64',
    ]) {
      assert.equal(
        badged(id),
        false,
        `${id} 在这台机器上只有一个包，「推荐」不回答任何问题 —— ` +
          '这四张卡此前每张都戴着徽章',
      );
    }
    r.unmount();
  });
});

/**
 * ## T-165 ③ 自检结果的三条 UI 分支真的会亮
 *
 * `gates-fix §5.3` → `backlog-work §2.6`：自检早就跑得起来（用户实测 `passed:true / 18.6x`），
 * 但结果**没有人写回** `InstalledBackendPack.selfTest` —— 全仓写这个字段的
 * 只有 `backends.ts` 那句 `selfTest: null`。daemon 侧已在上一轮接上（`recordSelfTest`），
 * 这一族钉的是**界面这一半**：写回来了，屏幕上到底会不会变。
 *
 * ── 把名字遮住，这些断言什么时候会失败 ────────────────────────────────────────
 * ① 三条分支里任何一条被删或被合并；
 * ② 失败原因被换成笼统的"出错了"（daemon 已经给出具体原因，藏回黑箱是倒退）；
 * ③ **`useBackendSelfTestMutation` 的 `invalidateQueries` 被拿掉** ——
 *    那一刻自检仍然"成功"，只是刷新前什么都不会变，而这正是它此前的样子。
 */
describe('T-165 ③ 自检结果的三条 UI 分支真的会亮', () => {
  const PASSED = {
    passed: true,
    ranAt: '2026-08-07T01:02:03.000Z',
    devicesFound: 2,
    rtf: 0.054,
    errorMessage: null,
  };
  const FAILED = {
    passed: false,
    ranAt: '2026-08-07T01:02:03.000Z',
    devicesFound: 0,
    rtf: null,
    errorMessage: 'libggml-vulkan.so: 驱动过旧，需要 Vulkan 1.2+',
  };

  const CATALOG = {
    catalogVersion: 'v',
    source: 'bundled',
    stale: false,
    packs: [pack({ id: 'whispercpp-cpu-linux-x64', installed: true, recommended: true })],
  };

  test('★ 分支一：passed → 通过徽章 + 枚举到的设备数 + 实测 RTF + 出处时间', async () => {
    stubApi({
      '/runtime/hardware': HW_LINUX_X64,
      '/backends/catalog': CATALOG,
      '/backends/installed': {
        selectedBackend: 'cpu',
        packs: [{ id: 'whispercpp-cpu-linux-x64', selfTest: PASSED }],
      },
    });
    const r = await render(<RuntimePage />, { route: '/runtime' });
    await r.flush();
    const shown = text(r.container);
    assert.ok(shown.includes('自检通过'), `通过徽章没亮 → ${shown}`);
    assert.ok(shown.includes('枚举到 2 个设备'), `设备数没渲染 → ${shown}`);
    assert.ok(shown.includes('0.05'), `实测 RTF 没渲染 → ${shown}`);
    assert.ok(shown.includes('真实推理得出'), `出处（何时、怎么得出的）没渲染 → ${shown}`);
    r.unmount();
  });

  test('★ 分支二：failed → 失败徽章 + **daemon 给的具体原因**，不是"出错了"', async () => {
    stubApi({
      '/runtime/hardware': HW_LINUX_X64,
      '/backends/catalog': CATALOG,
      '/backends/installed': {
        selectedBackend: 'cpu',
        packs: [{ id: 'whispercpp-cpu-linux-x64', selfTest: FAILED }],
      },
    });
    const r = await render(<RuntimePage />, { route: '/runtime' });
    await r.flush();
    const shown = text(r.container);
    assert.ok(shown.includes('自检失败'), `失败徽章没亮 → ${shown}`);
    assert.ok(
      shown.includes('驱动过旧，需要 Vulkan 1.2+'),
      `已知的具体原因被藏回了黑箱 → ${shown}`,
    );
    assert.equal(shown.includes('未知原因'), false, `明明有原因却渲染成「未知原因」→ ${shown}`);
    r.unmount();
  });

  test('★ 分支三：anyFailed → 顶部横幅；全部通过时不许出现（阳性对照）', async () => {
    const withSelfTest = (st: unknown) => ({
      '/runtime/hardware': HW_LINUX_X64,
      '/backends/catalog': CATALOG,
      '/backends/installed': {
        selectedBackend: 'cpu',
        packs: [{ id: 'whispercpp-cpu-linux-x64', selfTest: st }],
      },
    });

    stubApi(withSelfTest(FAILED));
    const bad = await render(<RuntimePage />, { route: '/runtime' });
    await bad.flush();
    assert.ok(
      text(bad.container).includes('有加速后端自检未通过'),
      '有包自检失败，顶部横幅没出现 —— D-05 要求 passed:false 留一条持续的警告',
    );
    bad.unmount();

    stubApi(withSelfTest(PASSED));
    const good = await render(<RuntimePage />, { route: '/runtime' });
    await good.flush();
    assert.equal(
      text(good.container).includes('有加速后端自检未通过'),
      false,
      '全部通过却还挂着失败横幅 —— 假红灯和假绿灯一样要当 bug 修',
    );
    good.unmount();
  });

  test('★ 接线：点一次「自检」→ 结果落库 → 徽章当场从「没有」变成「自检通过」', async () => {
    /*
     * 判据钉的是**用户看得见的变化**，不是"请求发出去了"。
     * 缺陷形态是：请求发了、daemon 也写回了 manifest，而页面不重新拉
     * `/backends/installed` —— 于是"点了自检什么都没发生，刷新一下才看到"。
     * 那正是 `invalidateQueries` 这一行在负责的事，而它被删掉时
     * **所有只断言"POST 发出去了"的用例照样全绿**。
     */
    let recorded: unknown = null;
    const { calls } = stubApi({
      '/runtime/hardware': HW_LINUX_X64,
      '/backends/catalog': CATALOG,
      '/backends/installed': () => ({
        selectedBackend: 'cpu',
        packs: [{ id: 'whispercpp-cpu-linux-x64', selfTest: recorded }],
      }),
      'POST /backends/selftest': () => {
        recorded = PASSED; // daemon 的 recordSelfTest() 写回 manifest 的那一步
        return { status: 'ran', passed: true, recorded: true, recordedTo: 'whispercpp-cpu-linux-x64' };
      },
    });

    const r = await render(<RuntimePage />, { route: '/runtime' });
    await r.flush();
    assert.equal(
      text(r.container).includes('自检通过'),
      false,
      '前提自检：还没点自检时不该有通过徽章（否则下面那条断言恒真）',
    );

    await click(buttonByText(r.container, '自检'));
    await r.flush();
    await r.flush();

    assert.ok(
      calls.some((c) => c.method === 'POST' && c.path === '/backends/selftest'),
      `自检请求没发出去，实际请求：${JSON.stringify(calls.map((c) => `${c.method} ${c.path}`))}`,
    );
    assert.ok(
      text(r.container).includes('自检通过'),
      '结果已经落库，界面却没变 —— 缺的正是那一次 invalidateQueries(backends.installed)',
    );
    r.unmount();
  });
});

/**
 * ## T-165 ④ `/diagnostics` 得有一个常驻入口
 *
 * 全仓唯一指向它的是 `ReadinessBanner` 里那个按钮，而那条横幅**一切正常时渲染 null**
 * —— 只有已经出问题的人才找得到诊断页，而"我想看看现在到底怎么样"是它的主要用途。
 * 章程要求 2.1 的最后一步写的就是"显示状态"。与 T-140 补 `/components` 入口同族。
 *
 * ⚠️ `/components` **刻意不进侧栏**：它已经有一个入口（`/runtime` 页头），
 * 而 D-10 §3.2 的 R3 是"同一问题只准一个出处"。诊断页不同，它现在的出处数是 0。
 *
 * ── 把名字遮住，这条什么时候会失败 ────────────────────────────────────────────
 * 有人把那一项从侧栏拿掉，或者加进来却忘了让高亮判定认得它
 * （`activeNavTarget` 的入参就是这张清单，漏登记 = 那条链接永远不高亮且什么都不报）。
 */
describe('T-165 ④ /diagnostics 得有一个常驻入口', () => {
  test('★ 侧栏里有一条指向 /diagnostics 的链接，且在该地址上恰好它一个高亮', async () => {
    stubApi({});
    const r = await render(<App />, { route: '/diagnostics' });
    await r.flush();

    const nav = r.container.querySelector('nav');
    assert.ok(nav, '侧栏没渲染出来');
    const hrefs = [...nav!.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    assert.ok(
      hrefs.includes('/diagnostics'),
      `侧栏里没有诊断页入口 → ${JSON.stringify(hrefs)}`,
    );

    /*
     * 高亮是 `aria-current="page"`（SideLink 的实现）。
     * 断"恰好一项"而不是"这一项亮了"：`activeNav.ts` 存在的理由就是**至多一项**，
     * 而漏登记的症状恰恰是"它不亮、别人替它亮"。
     */
    const current = [...nav!.querySelectorAll('a[aria-current="page"]')].map((a) =>
      a.getAttribute('href'),
    );
    assert.deepEqual(
      current,
      ['/diagnostics'],
      `在 /diagnostics 上高亮的应当恰好是它自己 → ${JSON.stringify(current)}`,
    );
    r.unmount();
  });
});

/**
 * ## T-165 ⑤ markmap 整块摘除 —— **不许留半截**
 *
 * `MindmapView` 此前渲染「切到**大纲视图**将不显示 {{edges}} 条关联线与 {{summaries}} 个概要」，
 * 而**产品里没有大纲视图**：`markmap-lib` / `markmap-view` 全仓零 import，
 * `toMarkmap` / `markmapLoss` 零产品调用方。那句话在描述一个用户**做不到的动作**的后果。
 *
 * 它**只能删不能改写**：那两样东西（自由连线、概要）在现有的任何一条路径上都不会丢
 * ——SVG/PNG 导出走的是 mind-elixir 的实时画布。改写只会产生第二句需要读者判断真假的话。
 *
 * ── 这条守卫钉的是什么 ────────────────────────────────────────────────────────
 *
 * **"半截"是这一族真正的失败形态**，而且两个方向都真实存在过：
 *   · 删了依赖没删文案 → 界面继续提一个不存在的视图；
 *   · 删了文案没删依赖 → 两个零 import 的包继续挂在供应链与打包体积上，
 *     而且下一个人会以为"既然依赖还在，那视图大概是要做的"，把文案加回来。
 * 所以断言**同时**覆盖依赖、适配器导出、以及词条 —— 任何一半回来都红。
 *
 * 手法与 `peaks.test.ts` 那条「这个模块不许再导出 mockPeaks」同族。
 *
 * ⚠️ `toMarkdown` **刻意不在这条守卫里**：它不是 markmap 的一部分，
 * 而是 `GET /api/notes/:uid/export?what=mindmap&format=md` 的实现
 * （`apps/daemon/src/http/rest/content.ts` 的 `exportMindmap()`）。把它一起禁掉会打掉一个真功能。
 */
describe('T-165 ⑤ markmap 整块摘除，不许留半截', () => {
  test('★ `apps/web/package.json` 里不许再出现 markmap 依赖', () => {
    const pkg = JSON.parse(readFileSync(`${process.cwd()}/package.json`, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const back = Object.keys(all).filter((d) => d.startsWith('markmap'));
    assert.deepEqual(
      back,
      [],
      `markmap 依赖回来了：${JSON.stringify(back)} —— ` +
        '零 import 的依赖不会有任何东西报错，但它会让下一个人以为"大纲视图是要做的"',
    );
  });

  test('★ `@openmemo/mindmap` 不许再导出 markmap 适配器', async () => {
    const mod = (await import('@openmemo/mindmap')) as unknown as Record<string, unknown>;
    for (const name of ['toMarkmap', 'markmapLoss', 'escapeHtml']) {
      assert.equal(
        name in mod,
        false,
        `${name} 回来了 —— 适配器一旦回来，"提示切视图会丢什么"那句话就会跟着回来`,
      );
    }
    // 阳性对照：这个断言必须是在**真的检查一个活模块**，而不是在一个空对象上恒真
    assert.equal(typeof mod['toMindElixir'], 'function', '前提自检：mind-elixir 适配器应当还在');
    assert.equal(typeof mod['toMarkdown'], 'function', '前提自检：导出端点用的 toMarkdown 不许被误删');
  });

  test('★ 两份 locale 里都不许再有那条词条（留着它，下一个人会把它接回去）', () => {
    for (const loc of ['zh-CN', 'en']) {
      const raw = readFileSync(`${process.cwd()}/src/app/i18n/locales/${loc}.json`, 'utf8');
      const j = JSON.parse(raw) as { mindmap?: Record<string, unknown> };
      assert.equal(
        'markmapLoss' in (j.mindmap ?? {}),
        false,
        `${loc}.json 里 mindmap.markmapLoss 回来了`,
      );
    }
  });

  test('★ 导图面板上不许再出现那句提示（带自由连线与概要的文档也一样）', async () => {
    /*
     * 判据是**渲染出来的东西**，不是源码里有没有那个字符串。
     * 而且这份 doc **刻意带上 edges 与 summaries** —— 缺陷版本正是靠它们才显示那句话，
     * 拿一份空文档去测，把缺陷放回去也照样绿。
     */
    stubApi({});
    const { MindmapView } = await import('../features/mindmap/MindmapView');
    const doc = {
      schemaVersion: 1,
      uid: 'u',
      title: '根',
      rootKey: 'r',
      revision: 0,
      nodes: {
        r: { key: 'r', text: '根', children: ['a'] },
        a: { key: 'a', text: '子', children: [] },
      },
      edges: [{ key: 'e', from: 'r', to: 'a' }],
      summaries: [{ key: 's', parent: 'r', start: 0, end: 0, text: '概要' }],
    };
    const r = await render(<MindmapView doc={doc as never} noteUid="01KZ47V1X2YB402JKD60KRHK98" />);
    await r.flush();
    const shown = text(r.container);
    assert.equal(
      shown.includes('大纲视图'),
      false,
      `界面又在提一个不存在的视图 → ${shown}`,
    );
    r.unmount();
  });
});

/**
 * ## T-165b ★「跑通了」与「加速真的用上了」必须在卡片上分得开
 *
 * `daemon-backlog` T-166 把自检**钉到某一个包**上跑之后，出现了一种以前不存在的状态：
 * 跑的**确实**是 Vulkan 包里的 whisper-cli，而 ggml 没枚举到设备、
 * **优雅退回 CPU 算完了** —— `passed` 为真，加速一点没生效。
 *
 * > 一张 Vulkan 卡片写着「自检通过」、而它其实静默跑的是 CPU ——
 * > 这两种情况在界面上此前**无法区分**。
 *
 * ## 判据用 `devicesFound`，**一个字符串都不比**
 *
 * 这条是从 T-166 那个 bug 直接抄来的：`backendUsed` 是 whisper 的**日志文字**
 * （`'CPU'`、`'CPU (ggml-cpu-zen4)'`、GPU 设备名、null），**不是 `Backend` 枚举**。
 * T-164 拿它跟 `'cpu'` 比 → `'CPU' !== 'cpu'` 恒真 → 回写恒被拒 → 三条 UI 分支恒不亮，
 * **而它 6 条用例全绿，因为用例喂的是产品从不产出的形状**。
 * 所以下面每一条喂的都是 `parseBackendUsed()` **真会产出**的那几种字符串。
 *
 * ── 把名字遮住，这些断言什么时候会失败 ──────────────────────────────────────
 * 有人把两种"通过"合并回一句「自检通过」；或者反过来，
 * 对 CPU 包也报"加速没生效"（假红灯）；或者开始**解析** `backendUsed` 来做判断。
 */
describe('T-165b「跑通了」≠「加速用上了」', () => {
  const CARD = {
    locale: 'zh-CN',
    isActive: false,
    installing: false,
    onInstall: () => undefined,
    onRemove: () => undefined,
    onSelect: () => undefined,
    onSelfTest: () => undefined,
  } as const;

  async function card(
    packOver: Record<string, unknown>,
    selfTest: Record<string, unknown> | null,
  ) {
    const r = await render(
      <BackendPackCard
        {...CARD}
        pack={pack({ installed: true, ...packOver }) as never}
        selfTest={selfTest as never}
      />,
    );
    return { r, shown: text(r.container) };
  }

  const RAN_ON_CPU = {
    passed: true,
    ranAt: '2026-08-07T01:02:03.000Z',
    devicesFound: 0,
    rtf: 0.9,
    errorMessage: null,
    // parseBackendUsed() 在无 GPU 的机器上真正产出的那两种之一
    backendUsed: 'CPU (ggml-cpu-zen4)',
  };
  const RAN_ON_GPU = {
    passed: true,
    ranAt: '2026-08-07T01:02:03.000Z',
    devicesFound: 1,
    rtf: 0.05,
    errorMessage: null,
    backendUsed: 'NVIDIA GeForce RTX 4090',
  };

  test('★ Vulkan 卡片：跑通了但零设备 → 不许只写「自检通过」', async () => {
    const { r, shown } = await card({ id: 'v', backend: 'vulkan' }, RAN_ON_CPU);
    assert.ok(
      !!r.container.querySelector('[data-testid="selftest-no-accel-v"]'),
      `一张 Vulkan 卡片报了通过，却没说加速其实没生效 → ${shown}`,
    );
    assert.ok(
      shown.includes('CPU (ggml-cpu-zen4)'),
      `没有把"实际用上的后端"原样显示出来 → ${shown}`,
    );
    r.unmount();
  });

  test('★ 阳性对照：真枚举到设备时，两种情况渲染出的文本必须不同', async () => {
    const bad = await card({ id: 'v', backend: 'vulkan' }, RAN_ON_CPU);
    const good = await card({ id: 'v', backend: 'vulkan' }, RAN_ON_GPU);
    assert.equal(
      !!good.r.container.querySelector('[data-testid="selftest-no-accel-v"]'),
      false,
      `真跑在 GPU 上却报"加速没生效" —— 假红灯会训练人忽略告警 → ${good.shown}`,
    );
    assert.notEqual(
      bad.shown,
      good.shown,
      '「跑在 CPU 上」与「跑在 GPU 上」在屏幕上长得一模一样 —— 那就是这条要修的东西',
    );
    assert.ok(good.shown.includes('NVIDIA GeForce RTX 4090'), `设备名没显示 → ${good.shown}`);
    bad.r.unmount();
    good.r.unmount();
  });

  test('★ CPU 包枚举到 0 个 GPU 设备是正常的，不许报"加速没生效"', async () => {
    const { r, shown } = await card({ id: 'c', backend: 'cpu' }, RAN_ON_CPU);
    assert.equal(
      !!r.container.querySelector('[data-testid="selftest-no-accel-c"]'),
      false,
      `对 CPU 包报"加速没生效"是假红灯 → ${shown}`,
    );
    assert.ok(shown.includes('自检通过'), `CPU 包跑通了就该说通过 → ${shown}`);
    r.unmount();
  });

  test('★ 老记录没有 backendUsed 时不许编，也不许因此报警', async () => {
    /*
     * `backendUsed` 是 T-166 才加的可选字段。老记录里没有它 ——
     * 那时"实际用了哪个后端"这件事我们**确实不知道**，一个字都不该说。
     * （与 `inapplicableKind` 缺失时不许兜底成 "本机不支持" 是同一条判据。）
     */
    const { passed, ranAt, devicesFound, rtf, errorMessage } = RAN_ON_GPU;
    const { r, shown } = await card(
      { id: 'v', backend: 'vulkan' },
      { passed, ranAt, devicesFound, rtf, errorMessage },
    );
    assert.ok(shown.includes('自检通过'), `枚举到设备就该说通过 → ${shown}`);
    assert.equal(
      shown.includes('实际用上的后端'),
      false,
      `没有这个字段却渲染了那一行 → ${shown}`,
    );
    r.unmount();
  });

  test('★ 判据是 devicesFound，不是解析 backendUsed（喂一个没人认识的字符串照样对）', async () => {
    /*
     * 这条钉的是**实现手法**留下的后果：一旦有人改成"看 backendUsed 里有没有 CPU 字样"，
     * 上游哪天把日志文字改了（或者是 GPU 设备名里恰好带 CPU），判断就会静默出错。
     * 喂一个完全陌生的字符串 + 零设备 —— 正确实现必须仍然判成"加速没生效"。
     */
    const { r, shown } = await card(
      { id: 'v', backend: 'vulkan' },
      { ...RAN_ON_CPU, backendUsed: 'Llvmpipe (LLVM 17, 256 bits)' },
    );
    assert.ok(
      !!r.container.querySelector('[data-testid="selftest-no-accel-v"]'),
      `零设备就是没加速，与那串文字长什么样无关 → ${shown}`,
    );
    r.unmount();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   T-172 ② 思维导图的四种结构化导出 —— 「写了、测了、点不到」的那一半
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * ## 这一族钉的是什么
 *
 * `GET /api/notes/:uid/export?what=mindmap&format=md|opml|mm|json` 服务端早就实现了
 * （`apps/daemon/src/http/rest/content.ts:386` + `exportMindmap()`），而在这次接线之前，
 * **全 `apps/web/src` 搜 `what=mindmap` 命中数是 0** —— 唯一的导出调用点
 * `notes/ExportMenu.tsx:43` 只发 `?format=`，从不发 `what=`。
 *
 * 所以判据必须钉在**发出去的那个 URL 上**，不能是"菜单里有四个条目"：
 * 四个标签都对、`what=` 漏了，界面看起来完全正常，而服务端会按 `what=note`
 * 去导**转写稿**（`format=opml` / `mm` 在那条分支上不支持 → 400）。
 * 这正是"少一个查询参数"这类缺陷的典型形态：不报错，只是导出了另一样东西。
 */
describe('T-172 ② 导图导出：四种结构化格式必须真的点得到', () => {
  const NOTE_UID = '01KZ8N0T3D3TA1LPQ5J8XR9V2C';

  const menu = async () => {
    stubApi({});
    const r = await render(
      <MindmapExportMenu noteUid={NOTE_UID} onExportImage={() => {}} />,
    );
    await r.flush();
    await click(buttonByText(r.container, '导出'));
    await r.flush();
    return r;
  };

  const hrefs = (c: HTMLElement): string[] =>
    Array.from(c.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? '');

  test('★ 四种格式各有一条链接，且 `what=mindmap` 与 `format=` 都在里面', async () => {
    const r = await menu();
    const got = hrefs(r.container);

    for (const format of ['md', 'opml', 'mm', 'json']) {
      const want = `/api/notes/${NOTE_UID}/export?what=mindmap&format=${format}`;
      assert.ok(
        got.includes(want),
        `${format} 的导出链接不对。期望 ${want}，实际拿到 ${JSON.stringify(got)}`,
      );
    }
    r.unmount();
  });

  test('★ 漏掉 `what=mindmap` 会导出另一样东西 —— 每条链接都必须带上它', async () => {
    /*
     * 单独一条，因为这是**唯一**会静默出错的那一格：
     * `what` 缺省是 `'note'`（`content.ts:384`），于是 md/json 会导出转写稿
     * （用户拿到一份"内容不对但格式正确"的文件），opml/mm 则直接 400。
     */
    const r = await menu();
    const got = hrefs(r.container);
    assert.equal(got.length, 4, `结构化格式应当恰好 4 条链接 → ${JSON.stringify(got)}`);
    for (const h of got) {
      assert.ok(h.includes('what=mindmap'), `这条链接没带 what=mindmap，会导出转写稿：${h}`);
    }
    r.unmount();
  });

  test('图片导出（SVG / PNG）在合并进菜单之后仍然点得到，且走的是回调不是链接', async () => {
    /*
     * 这次改动把工具栏上两个平铺按钮收进了菜单。收进去容易连功能一起收没了 ——
     * 所以正反两面都钉：回调收到了正确的格式，且它们**不是** <a href>
     * （图片由渲染器在浏览器里现画，没有对应的服务端端点）。
     */
    stubApi({});
    const got: string[] = [];
    const r = await render(
      <MindmapExportMenu noteUid={NOTE_UID} onExportImage={(f) => got.push(f)} />,
    );
    await r.flush();
    await click(buttonByText(r.container, '导出'));
    await r.flush();

    await click(buttonByText(r.container, 'SVG'));
    await r.flush();
    await click(buttonByText(r.container, '导出'));
    await r.flush();
    await click(buttonByText(r.container, 'PNG'));
    await r.flush();

    assert.deepEqual(got, ['svg', 'png']);
    r.unmount();
  });

  test('★ 损耗必须写在菜单里：时间戳只有 md / json 带得走（实测，非照文档）', async () => {
    /*
     * 逐项跑过四个序列化器之后的事实：JSON 十项全保留；md 只保留时间戳与备注；
     * opml 只保留备注与折叠态；mm 保留备注与一条无标签的 arrowlink。
     * **时间戳是这张图与录音之间唯一的连接** —— 用户拿 OPML 导进别的软件后
     * 再也跳不回那一秒，而界面此前对此一个字都不说。
     */
    const r = await menu();
    const shown = text(r.container);
    assert.ok(shown.includes('JSON'), `菜单里应当点得出无损那一档 → ${shown}`);
    assert.ok(
      shown.includes('时间戳'),
      `没有把"时间戳会丢"说出来 —— 那是这四种格式之间唯一会咬人的差别 → ${shown}`,
    );
    r.unmount();
  });

  test('★ daemon 不可达时只禁用服务端那一组，图片仍可导（它不需要 daemon）', async () => {
    stubApi({});
    // notes 面标成离线：四种结构化格式由 daemon 产出，此时点了只会失败
    useSurfaceStore.getState().set('notes', 'offline');
    const r = await render(<MindmapExportMenu noteUid={NOTE_UID} onExportImage={() => {}} />);
    await r.flush();
    await click(buttonByText(r.container, '导出'));
    await r.flush();

    assert.equal(
      hrefs(r.container).length,
      0,
      'daemon 不可达时不该再给出可点的服务端导出链接',
    );
    // 阳性对照：图片那两个仍在 —— 否则这条用例只是在断言"菜单是空的"
    assert.ok(!!buttonByText(r.container, 'SVG'), 'SVG 不该跟着一起消失，它不经过 daemon');
    assert.ok(!!buttonByText(r.container, 'PNG'), 'PNG 不该跟着一起消失，它不经过 daemon');
    r.unmount();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   T-172 ③ 搜索结果直达时间点 —— `?t=` 的三个边界
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * ## 这一族钉的是什么
 *
 * `SearchPage.tsx:135` 一直在发 `?t=<startMs>`，而 `NoteDetailPage` **从不读**
 * （那个文件里唯一的 `params.get` 是 `'tab'`）—— 点任何转写命中都从 0:00 开始播。
 *
 * "能跳"只是第一格。真正会咬人的是另外三格，每一格都单独钉一条：
 *   ① 媒体还没加载完（`<audio>` 比 `?t=` 晚一个 render 才进 DOM）
 *   ② `?t=` 超出时长
 *   ③ 参数留在地址栏之后，**会话中途不许被反复拽回去**
 */
describe('T-172 ③ 搜索结果点进去要跳到那一秒', () => {
  const UID = '01KZ8N0T3D3TA1LPQ5J8XR9V2C';
  const HIT_MS = 754_000;
  const DURATION = 3_600_000;

  const stubs = (durationMs: number | null = DURATION) => ({
    [`/notes/${UID}`]: {
      uid: UID,
      title: '产品评审会',
      status: 'done',
      durationMs,
      tags: [],
      summaryMd: '这条笔记的摘要',
      bodyJson: null,
      canRetranscribe: false,
      assets: [
        { uid: 'asset-audio-1', role: 'audio16k', mime: 'audio/wav', bytes: 1, durationMs, state: 'ready' },
      ],
    },
    [`/notes/${UID}/transcript`]: {
      transcript: { uid: 'tr1', engineId: 'whisper', modelId: null, language: 'zh', status: 'done', progress: 1, durationMs, rtf: null },
      segments: [
        { seq: 0, startMs: 0, endMs: 5_000, text: '开场', speakerLabel: null, words: null },
        { seq: 1, startMs: 754_000, endMs: 761_000, text: '这里说到成本', speakerLabel: null, words: null },
      ],
    },
    [`/notes/${UID}/mindmap`]: { mindmap: null, doc: null },
  });

  /**
   * ★ 挂载过的页面**必须**被卸载，哪怕用例是红的。
   *
   * `PlayerBar` 与 `TranscriptList` 各有一个 `requestAnimationFrame` 自循环，只在
   * `unmount()` 时 `cancelAnimationFrame`。用例在 `r.unmount()` **之前**断言失败时，
   * 那两个循环就永远转下去 —— jsdom 的 rAF 会把 Node 的事件循环一直撑着，
   * `node --test` 于是**不报红、而是整个文件挂住**，直到外部超时把它杀掉。
   *
   * 这正是 PROTOCOL §8 那一族的形状：**一条断言失败伪装成环境问题**。
   * 实测确认过：把 `?t=` 的读取拿掉做反向验证时，套件不是变红，是卡死 300 秒后被 kill，
   * 而 spec reporter 缓冲在管道里的那几行 ✖ 一起丢了 —— 看起来像"测试环境坏了"。
   *
   * 所以卸载不能靠每条用例自己记得写，必须挂在 afterEach 上。
   */
  const mounted: { unmount: () => void }[] = [];
  afterEach(() => {
    while (mounted.length) {
      try {
        mounted.pop()?.unmount();
      } catch {
        /* 卸载失败不该掩盖用例本身的失败原因 */
      }
    }
  });

  const openAt = async (query: string, durationMs: number | null = DURATION) => {
    stubApi(stubs(durationMs));
    // 每条用例都从一个干净的播放器状态起步，否则上一条的 seek 会漏过来
    usePlayerStore.setState({ assetUid: null, durationMs: 0, seekRequest: null, activeSeq: null });
    setPositionMs(0, { immediate: true });
    const r = await render(
      <Routes>
        <Route path="/notes/:noteUid" element={<NoteDetailPage />} />
      </Routes>,
      { route: `/notes/${UID}${query}` },
    );
    mounted.push(r);
    await r.flush();
    await r.flush();
    return r;
  };

  /** jsdom 的 HTMLMediaElement 支持 currentTime 读写（readyState 恒 0、duration 恒 NaN）。 */
  const audioSeconds = (c: HTMLElement): number | null => {
    const el = c.querySelector('audio');
    return el ? (el as HTMLAudioElement).currentTime : null;
  };

  test('★ ①-a 音频要跳到命中的那一秒（这一格是"能跳"本身）', async () => {
    const r = await openAt(`?t=${HIT_MS}`);
    assert.equal(
      audioSeconds(r.container),
      HIT_MS / 1000,
      '音频没有跳到命中的那一秒',
    );
  });

  test('★ ①-b 元数据到达前那次 seek 若被浏览器丢掉，loadedmetadata 必须补回来', async () => {
    /*
     * **这一格才是"媒体还没加载完"的真身。**
     *
     * `readyState === HAVE_NOTHING` 时给 `currentTime` 赋值，规范说的是先记成
     * *default playback start position*、等加载开始再应用 —— 但各家实现是否都照做，
     * 本机没有浏览器、**没验证过**。所以代码不赌它：pending 一直留到元数据到达。
     *
     * 这里就地模拟"浏览器把那次赋值丢了"（把 currentTime 打回 0），再发 `loadedmetadata`。
     * 正确实现必须把它补回去；只赋一次就清掉 pending 的实现会停在 0 —— 也就是从头播。
     */
    const r = await openAt(`?t=${HIT_MS}`);
    const el = r.container.querySelector('audio') as HTMLAudioElement;
    assert.equal(el.currentTime, HIT_MS / 1000, '前提自检：第一次赋值就没成功，后面没有意义');

    el.currentTime = 0; // ← 假装这是一个"元数据没到就不认 seek"的浏览器
    el.dispatchEvent(new Event('loadedmetadata'));
    await r.flush();

    assert.equal(
      el.currentTime,
      HIT_MS / 1000,
      '元数据到了却没有把那次 seek 补上 —— 用户会从 0:00 开始播',
    );
  });

  test('★ ①-c seek 还没落到媒体上时，位置值不许被媒体的 0 盖回去', async () => {
    /*
     * `PlayerBar` 有一个每帧跑的 rAF 循环，把 `el.currentTime` 写进 `positionMs`。
     * 转写稿的高亮与滚动读的正是 `positionMs`。所以只要媒体还停在 0，
     * 那个循环就会把 `requestSeek` 设好的目标值**每帧盖回 0** ——
     * 表现是「命中段闪一下就弹回第一段」，比完全不跳更像"产品坏了"。
     */
    const r = await openAt(`?t=${HIT_MS}`);
    const el = r.container.querySelector('audio') as HTMLAudioElement;
    el.currentTime = 0; // 媒体还没跟上（元数据未到）

    await new Promise((res) => setTimeout(res, 60)); // 放几帧过去
    await r.flush();

    assert.equal(
      getPositionMs(),
      HIT_MS,
      '待落的 seek 期间，转写稿的位置值被媒体的 0 盖掉了',
    );
  });

  test('★ ①-d 转写稿不必等音频加载：位置值当场就位', async () => {
    /*
     * 高亮与滚动读的是 `getPositionMs()`（transient 通道），它不依赖媒体。
     * 所以哪怕音频还在下载，命中段也应当立刻高亮 —— 这是"直达"体感的一半。
     */
    const r = await openAt(`?t=${HIT_MS}`);
    assert.equal(getPositionMs(), HIT_MS, '位置值没被设到命中点，转写稿不会高亮那一段');
    r.unmount();
  });

  test('没有 `?t=` 时不许凭空跳 —— 播放器停在 0', async () => {
    const r = await openAt('');
    assert.equal(audioSeconds(r.container), 0);
    assert.equal(getPositionMs(), 0);
    r.unmount();
  });

  test('★ ② 超出时长 → 夹到末尾，并且把话说出来', async () => {
    const r = await openAt('?t=9999000');
    assert.equal(
      audioSeconds(r.container),
      DURATION / 1000,
      '越界时应当夹到末尾，而不是夹到 0（夹到 0 和"没接线"在界面上一模一样）',
    );
    assert.ok(
      !!r.container.querySelector('[data-testid="seek-clamped"]'),
      `越界了却一个字都不说 —— 用户只会以为搜索结果跳错了 → ${text(r.container)}`,
    );
    r.unmount();
  });

  test('② 没越界时那条提示不许出现（否则它就成了背景噪音）', async () => {
    const r = await openAt(`?t=${HIT_MS}`);
    // §8：DOM 存在性一律先转成布尔再比，绝不 assert.equal(node, null)
    assert.equal(!!r.container.querySelector('[data-testid="seek-clamped"]'), false);
    r.unmount();
  });

  test('② 时长未知（转写中的笔记）不夹取 —— 拿未知上界夹只会把对的值夹坏', async () => {
    const r = await openAt(`?t=${HIT_MS}`, null);
    assert.equal(audioSeconds(r.container), HIT_MS / 1000);
    assert.equal(!!r.container.querySelector('[data-testid="seek-clamped"]'), false);
    r.unmount();
  });

  test('坏掉的 `?t=` 不跳、也不打扰用户', async () => {
    const r = await openAt('?t=abc');
    assert.equal(audioSeconds(r.container), 0);
    assert.equal(!!r.container.querySelector('[data-testid="seek-clamped"]'), false);
    r.unmount();
  });

  test('③ 切 tab（`?t=` 仍留在地址栏）不许把播放头拽回去', async () => {
    /*
     * 留着 `?t=` 的理由是 URL 要能被分享/收藏（`/notes/X?t=754000` 理应还原成"这条笔记的 12:34"），
     * 与本页既有的 `?tab=` 同一约定。代价就是**这个 effect 还有机会再跑**。
     *
     * ⚠️ 诚实标注：这一条**当前不构成对闩的守卫** —— 反向验证实测，把闩去掉它照样绿。
     * 因为切 tab 只改 `?tab=`，effect 的依赖（`note.data` / `seekRaw` / `noteUid`）一个都没变。
     * 留着它是钉"用户可见的性质"（切 tab 播放头不动），真正钉闩的是下面那条。
     */
    const r = await openAt(`?t=${HIT_MS}`);
    const el = r.container.querySelector('audio') as HTMLAudioElement;
    assert.equal(el.currentTime, HIT_MS / 1000, '前提自检：第一次跳都没成功，后面的断言没有意义');

    el.currentTime = 42; // 用户自己拖到了别处
    await click(buttonByText(r.container, '思维导图'));
    await r.flush();

    assert.equal(el.currentTime, 42, '切个 tab 就被拽回命中点');
  });

  test('★ ③ 后台重取（SSE → 笔记变了）之后，播放头必须留在用户拖到的地方', async () => {
    /*
     * **这一条才是那个闩的守卫。**
     *
     * `note.data` 在 effect 的依赖里，而 SSE 触发的重取会给出一个**新对象** ——
     * effect 于是再跑一次。没有闩的话，用户听到 20 分钟时后台刷新一下，
     * 就会被拽回 12:34。这是"把 `?t=` 留在地址栏"真正要付的那笔代价。
     *
     * 注意必须让第二次响应**内容不同**：react-query 默认开 structural sharing，
     * 内容相同会原样返回旧对象引用，effect 根本不会重跑 —— 那样这条用例就又变成
     * 一条恒绿的摆设了（上面那条切 tab 的就是那样，已如实标注）。
     */
    let fetches = 0;
    const base = stubs(DURATION);
    stubApi({
      ...base,
      [`/notes/${UID}`]: () => {
        fetches += 1;
        return { ...base[`/notes/${UID}`], title: `产品评审会 v${fetches}` };
      },
    });
    usePlayerStore.setState({ assetUid: null, durationMs: 0, seekRequest: null, activeSeq: null });
    setPositionMs(0, { immediate: true });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } },
    });
    const r = await render(
      <Routes>
        <Route path="/notes/:noteUid" element={<NoteDetailPage />} />
      </Routes>,
      { route: `/notes/${UID}?t=${HIT_MS}`, queryClient: qc },
    );
    mounted.push(r);
    await r.flush();
    await r.flush();

    const el = r.container.querySelector('audio') as HTMLAudioElement;
    assert.equal(el.currentTime, HIT_MS / 1000, '前提自检：第一次跳都没成功，后面的断言没有意义');

    el.currentTime = 42; // 用户听到别处去了
    await qc.invalidateQueries();
    await r.flush();
    await r.flush();

    assert.ok(fetches >= 2, `前提自检：笔记没有被重取过（fetches=${fetches}），这条用例没测到东西`);
    assert.equal(
      el.currentTime,
      42,
      '后台重取把播放头拽回了命中点 —— 留在地址栏里的 `?t=` 必须一个值只消费一次',
    );
  });
});

/* ── 播放器 store：待落的 seek 不许漏到另一条录音上 ───────────────────────── */

describe('T-172 ③ setSource 与待落 seek 的关系', () => {
  test('★ 换了媒体 → 上一条的待落 seek 作废（否则会跳到另一条录音的中间）', () => {
    usePlayerStore.setState({ assetUid: 'asset-A', durationMs: 1000, seekRequest: null });
    usePlayerStore.getState().requestSeek(2_700_000);
    assert.ok(usePlayerStore.getState().seekRequest, '前提自检：seek 得先排上');

    usePlayerStore.getState().setSource('asset-B', 5000);
    assert.equal(
      usePlayerStore.getState().seekRequest === null,
      true,
      '换了音源还留着上一条的 seek —— 新笔记一挂载就会被拽到 45:00',
    );
  });

  test('★ 同一条媒体重复 setSource（后台重取）不许取消用户还没落地的那一跳', () => {
    /*
     * `setSource` 的 effect 依赖里有 `note.data`，SSE 触发的后台重取会拿到新对象、
     * 以**同样的参数**再调一次。若无条件清空 seekRequest，一次后台刷新就能把用户
     * 刚点开、音频还没加载完的那一跳悄悄取消掉 —— 表现又回到"从 0:00 开始播"。
     */
    usePlayerStore.setState({ assetUid: 'asset-A', durationMs: 1000, seekRequest: null });
    usePlayerStore.getState().requestSeek(754_000);
    const before = usePlayerStore.getState().seekRequest;

    usePlayerStore.getState().setSource('asset-A', 1000);

    assert.equal(usePlayerStore.getState().seekRequest?.nonce, before?.nonce);
    assert.equal(usePlayerStore.getState().seekRequest?.ms, 754_000);
  });
});
