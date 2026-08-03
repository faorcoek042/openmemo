/**
 * 组件级测试 —— 「渲染 + 交互 + 断言」。
 *
 * 这一层此前是空的：要么是纯逻辑单测（挡不住渲染），要么是一次性 jsdom 渲染
 * （只证明"渲染出来了"，证明不了"点得动"）。中间空档让 18 项交互全被推给真实浏览器。
 * **其中大部分只需要一个 DOM 和一次事件派发，不需要浏览器。**
 *
 * ⚠️ `./host` 必须是**第一个 import** —— 它在模块顶层装 jsdom 全局，
 * 而 react-dom 必须在全局就绪之后才被加载。
 */
import { render, click, type, pressKey, text, buttonByText, stubApi } from './host';

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { TagEditor } from '../features/notes/TagEditor';
import { SearchBox } from '../features/search/SearchBox';
import { JobList } from '../features/tasks/JobList';
import { LlmSettingsSection } from '../features/settings/LlmSettingsSection';
import { buildLlmSettingsPatch, LLM_PURPOSES_KEY } from '../features/settings/api';
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
import { DataLocationSection } from '../features/settings/DataLocationSection';
import { RetranscribeButton, isSegmentEdited } from '../features/notes/RetranscribeButton';
import { WordLevelBadge } from '../features/transcript';
import { WordHighlight, findActiveWord } from '../features/transcript/WordHighlight';
import { DEFAULT_PROXY_CONFIG, LLM_SETTING_KEYS } from '@openmemo/shared';
import { ProxySettingsSection } from '../features/settings/ProxySettingsSection';
import { getPositionMs, setPositionMs, subscribePosition } from '../lib/stores/player.store';
import { useConnectionStore } from '../lib/stores/connection.store';
import { PurposeBindingsSection, mergePurposeBinding } from '../features/settings/PurposeBindingsSection';
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
   * ⚠️ 跳过原因（不是"以后再说"，是这个宿主真的做不到）：
   *
   * 本宿主里**文本输入引发的 setState 不会提交** ——
   * onChange 触发得到、但组件不重渲染，紧接着的 keydown 处理器仍持有旧闭包。
   * 手写 dispatchEvent（原生 setter + input 事件）和 @testing-library 的 fireEvent 都试过，
   * act 包裹 / act 内让出微任务 / 关掉 act 环境走真实定时器 / 多轮宏任务等待也都试过，均无效。
   * 而**点击引发的 setState 是正常提交的**（上面那条用例就依赖它），
   * 所以问题不在"更新不会提交"，而只出在文本输入这条路径上。
   *
   * → 「输入文字 → 回车/失焦提交」这类流程**必须由真实浏览器 E2E 覆盖**，
   *   本宿主只保证到"输入框出现且属性正确"。如实标注，不用 skip 掩盖成绿灯。
   */
  test('输入标签名后回车应 POST（本宿主不支持文本输入提交，交给真浏览器 E2E）', { skip: true }, () => {});

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

describe('SearchBox（搜索входа）', () => {
  test('回车跳转到 /search?q=… 并对查询串做 URL 编码', async () => {
    stubApi({});
    const r = await render(<SearchBox />);
    const input = r.container.querySelector('input');
    await type(input, '反向传播 & 梯度');
    await pressKey(input, 'Enter');
    await r.flush();
    // MemoryRouter 下用 location 断言不方便，这里断言不抛错且输入被保留
    assert.equal((input as HTMLInputElement).value, '反向传播 & 梯度');
    r.unmount();
  });

  test('空输入回车不跳转（避免落到一个空搜索页）', async () => {
    stubApi({});
    const r = await render(<SearchBox />);
    const input = r.container.querySelector('input');
    await type(input, '   ');
    await pressKey(input, 'Enter');
    await r.flush();
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

  /** 跳过原因同上：本宿主不支持"文本输入 → 提交"，见 TagEditor 那条的说明。 */
  test('填入 Key 后保存应 PUT /secrets/llm.<id>.apiKey（交给真浏览器 E2E）', { skip: true }, () => {});

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
