/**
 * #112 第 11 / 16 / 17 处 —— **英文界面上那三处半句中文，钉在渲染出来的那段字上。**
 *
 * ## 缺陷原状（逐字，英文界面）
 *
 * ```
 * Semantic / Hybrid search is unavailable: sqlite-vec 未加载              ← ⑪ 搜索页
 * ✗ proxy unreachable  YouTube  12ms  via proxy  · 连不上代理 http://127.0.0.1:7890/ —— 未向 YouTube 发出请求   ← ⑯
 * ⚠️ 2 download source(s) are unreachable: hf-mirror 镜像、Hugging Face    ← ⑰ 摘要句
 * hf-mirror 镜像    unreachable    via proxy                              ← ⑰ 源表格（同一个名字的第二处）
 * ```
 *
 * 三处都符合「CJK 只出现在数据里」的表面判据（`en.json` 里一个汉字都没有），
 * **但对英文用户就是半句中文**：daemon / 目录把措辞拼好了发过来，界面原样插进英文句子。
 *
 * ## 为什么单独一个 bundle 而不是并进 `components.test.tsx`
 *
 * 那份是别人在改的文件（本轮的文件归属），而这三条要断的东西必须**渲染**才看得见 ——
 * `src/test/` 下的组件套件是 `vite build --ssr` 单文件打包那条道，
 * 一个 bundle 一个入口，所以这里照 `silentFailures.test.tsx` 的先例另起一个。
 *
 * ## 这一组每一条都过一遍那四种守卫失效形态
 *
 *   ① **空转**：每条"不许有汉字"旁边都有一条**正面**断言（那句英文真的在屏幕上），
 *      且循环前先自检夹具非空 —— 整段没渲染出来时，"没有汉字"照样成立。
 *   ② **把缺陷钉成正确**：任何地方都不许断言"英文界面上出现了中文"。
 *   ③ **量错东西**：断的一律是 DOM 里的文字，不是 `t()` 的返回值、不是 locale JSON 往返。
 *   ④ **注释型断言**：每一条声称的性质都有一句跑得起来的 assert。
 *
 * ## 反悔测试（逐条问过：把修改删掉，这条会不会红？）
 *
 * 会。三处断的都是「**英文词条里那几段字出现在屏幕上**」+「那几段中文原状不在」：
 * 改回渲染 daemon 的散文 / 目录的 `label`，英文那几段字当场不存在。
 */

// ⚠️ 必须第一个 import：它在模块顶层装 jsdom 全局（见 host.tsx 的 T-133 一节）
import { render, click, text, stubApi } from './host';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_PROXY_CONFIG,
  type ProxyProbeDetail,
  type SemanticUnavailableReason,
} from '@openmemo/shared';

import i18nInstance from '../app/i18n';
import enLocale from '../app/i18n/locales/en.json';
import zhLocale from '../app/i18n/locales/zh-CN.json';
import SearchPage from '../features/search/SearchPage';
import { SEMANTIC_UNAVAILABLE_KEYS } from '../features/search/modes';
import { ProxySettingsSection } from '../features/settings/ProxySettingsSection';
import { PROXY_PROBE_DETAIL_KEYS, SOURCE_NAME_KEYS } from '../features/settings/proxyReasonText';

/* ── 小工具（`components.test.tsx` 里那几个的同形复制；那份文件本轮不归我动）──── */

/**
 * CJK 表意文字。
 *
 * ⚠️ **只判表意文字**，不含全角标点区：`settings.proxy.sourcesSomeUnreachable` 那句
 * 摘要里的分隔符今天仍是顿号（`、`，U+3001）—— 它是 #105 ⑥ 留下的、**不在本轮
 * 三处范围内**的另一处，硬把它算进来会让这一组红在一个我这轮不该改的地方。
 * 所以那一处另有一条**点名**的断言（不许出现「镜像」二字），不靠这个正则兜。
 */
const CJK = /[一-鿿]/;

function at(locale: unknown, key: string, which: string): string {
  const v = key
    .split('.')
    .reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], locale);
  assert.equal(typeof v, 'string', `${which} 里没有 ${key} —— 断言本身就落空了`);
  return v as string;
}
const enAt = (key: string): string => at(enLocale, key, 'en.json');
const zhAt = (key: string): string => at(zhLocale, key, 'zh-CN.json');

/**
 * 一条词条里**去掉插值洞与强调标记**之后，可以逐字断言的那几段。
 *
 * ⚠️ `min` 默认 8（英文那几条足够长），但**中文词条必须调小**：
 * 中文一个字顶好几个字母，`连不上代理 {{proxyUrl}} —— 未向 {{target}} 发出任何请求`
 * 拆出来最长的一段只有 6 个字 —— 按 8 过滤会得到**空数组**，
 * 于是那条镜像用例的循环一次都不跑、还报绿（第 ① 类：空转）。
 * 所以这里**自己先自检非空**：取不出可断言的片段时当场红，而不是安静地什么都不判。
 */
function literalChunks(entry: string, min = 8): string[] {
  const chunks = entry
    .replace(/\*\*/g, '')
    .split(/\{\{[^}]+\}\}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= min);
  assert.ok(chunks.length > 0, `这条词条取不出可断言的片段（min=${min}）：${entry}`);
  return chunks;
}

/** 中文词条用的阈值 —— 理由见上。 */
const ZH_MIN = 4;

/** 英文界面下跑一段用例，跑完一定切回中文（默认语言是 zh-CN，别污染别人）。 */
async function inEnglish(fn: () => Promise<void>): Promise<void> {
  await i18nInstance.changeLanguage('en');
  try {
    await fn();
  } finally {
    await i18nInstance.changeLanguage('zh-CN');
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════
 * ⑯ 探针细节：四格每一格在英文界面上都得说出一句英文
 * ══════════════════════════════════════════════════════════════════════════════════ */

const REDACTED = 'http://***:***@127.0.0.1:7890/';

/**
 * 四格各一条**真实形状**的样本。
 *
 * ⚠️ 声明成 `readonly ProxyProbeDetail[]`：某一格少写一个字段，`tsc` 当场红；
 * 而**少写一整格**由下面那条前提自检对着 `PROXY_PROBE_DETAIL_KEYS`（产品那张总表）判红。
 * 契约加一条腿 ⇒ 总表加一格 ⇒ 这里的 `deepEqual` 立刻不成立 ——
 * 「悄悄加一格而没人给它写用例」在结构上做不到。
 */
const DETAIL_ARMS: readonly ProxyProbeDetail[] = [
  { kind: 'proxy_unreachable_not_sent', proxyUrl: REDACTED, target: 'YouTube' },
  { kind: 'proxy_rejected_credentials', proxyUrl: REDACTED },
  { kind: 'proxy_refused_tunnel', proxyUrl: REDACTED, target: 'Cloudflare' },
  { kind: 'probe_error_text', text: 'ENOTFOUND api.github.com' },
];

/** 每一格配一个**唯一的探针目标**：行的 key 与 testid 都按它来。 */
const probeFor = (d: ProxyProbeDetail, i: number) => ({
  target: `Probe${i}`,
  url: `https://probe-${i}.example/`,
  result: 'unclassified',
  viaProxy: true,
  elapsedMs: 12,
  detail: d,
});

async function renderProbes(details: readonly unknown[]) {
  stubApi({
    '/settings/proxy': { config: DEFAULT_PROXY_CONFIG, active: null, media: null },
    'POST /settings/proxy/test': {
      ok: false,
      proxyReachable: null,
      probes: details.map((d, i) => probeFor(d as ProxyProbeDetail, i)),
    },
  });
  const r = await render(<ProxySettingsSection />);
  await r.flush();
  await click(r.container.querySelector('[data-testid="proxy-test"]'));
  await r.flush();
  return r;
}

const detailText = (c: HTMLElement, i: number): string => {
  const el = c.querySelector(`[data-testid="proxy-probe-detail-Probe${i}"]`);
  assert.ok(el, `第 ${i} 格的细节整段没渲染出来 —— 后面的断言会空转`);
  return text(el as HTMLElement);
};

describe('#112 ⑯ 代理探针细节：英文界面上四格全说英文', () => {
  test('★ 前提自检：四格一个不少，且与产品那张总表逐格对齐', () => {
    assert.ok(DETAIL_ARMS.length > 0, '夹具是空的 —— 下面的循环一次都不会跑（① 空转）');
    assert.equal(
      DETAIL_ARMS.length,
      Object.keys(PROXY_PROBE_DETAIL_KEYS).length,
      '夹具的格数与 PROXY_PROBE_DETAIL_KEYS 对不上 —— 有一格没人给它写用例',
    );
    assert.deepEqual(
      DETAIL_ARMS.map((d) => d.kind).sort(),
      Object.keys(PROXY_PROBE_DETAIL_KEYS).sort(),
      '契约里增/改了一种细节，而这里没跟上',
    );
  });

  test('★★ 四格全部：英文界面上没有汉字，且插值洞真的被填上了', async () => {
    await inEnglish(async () => {
      const r = await renderProbes(DETAIL_ARMS);
      DETAIL_ARMS.forEach((arm, i) => {
        const said = detailText(r.container, i);

        // ① 先证明"我真的看到东西了"，再谈"里面没有汉字"
        assert.ok(said.length > 20, `「${arm.kind}」这一格短得可疑（${said.length} 字）→ ${said}`);
        assert.equal(CJK.test(said), false, `★ 缺陷原状：英文界面上这一格是中文 → ${said}`);

        // ② 那句话确实是 en.json 里那一条（逐段取自词条，不是我在这里另写英文）
        for (const chunk of literalChunks(enAt(PROXY_PROBE_DETAIL_KEYS[arm.kind]))) {
          assert.ok(said.includes(chunk), `「${arm.kind}」缺了一段：「${chunk}」→ ${said}`);
        }

        // ③ 最像"通过"的两种失败：key 原样吐出来 / 插值洞没被填上
        assert.ok(!said.includes('settings.proxy.'), `渲染成了原始 key 串 → ${said}`);
        assert.ok(!said.includes('{{'), `插值洞没被填上 → ${said}`);
        assert.ok(!said.includes('[object Object]'), `★ 结构体被原样塞进模板 → ${said}`);
      });

      // ④ 数据那几格必须真的出现在句子里 —— 否则这句话虽然是英文，却什么都没说
      assert.ok(
        detailText(r.container, 0).includes(REDACTED),
        '没说清连不上的是哪个代理（脱敏后的地址）',
      );
      assert.ok(detailText(r.container, 0).includes('YouTube'), '没说清"没往哪个目标站发请求"');
      assert.ok(detailText(r.container, 1).includes(REDACTED), '407 那句没点名是哪个代理');
      assert.ok(detailText(r.container, 2).includes('Cloudflare'), '拒绝隧道那句没说清目标站');
      assert.ok(
        detailText(r.container, 3).includes('ENOTFOUND api.github.com'),
        '原始错误串被吃掉了 —— 那是这一格唯一的内容',
      );
      r.unmount();
    });
  });

  test('★ 镜像用例：中文界面上这四格必须是中文（防"到处写死英文"的反向退化）', async () => {
    const r = await renderProbes(DETAIL_ARMS);
    DETAIL_ARMS.forEach((arm, i) => {
      const said = detailText(r.container, i);
      for (const chunk of literalChunks(zhAt(PROXY_PROBE_DETAIL_KEYS[arm.kind]), ZH_MIN)) {
        assert.ok(said.includes(chunk), `中文界面上「${arm.kind}」缺了一段：「${chunk}」→ ${said}`);
      }
    });
    r.unmount();
  });

  test('★ 认不出的细节：那一行不带细节，绝不渲染 `[object Object]` 或一段中文散文', async () => {
    /*
     * 这一条钉的是**跨版本**那一格：旧 daemon 在这里发的是一个 `string`
     *（一句中文散文），字段本身还一直是可选的。收不住的后果不是少一句话，
     * 是把内部表示或一整段中文贴到英文面板上。
     */
    await inEnglish(async () => {
      const r = await renderProbes([
        '连不上代理 http://127.0.0.1:7890/ —— 未向 YouTube 发出请求',
        { kind: 'from_the_future' },
        { kind: 'proxy_refused_tunnel', proxyUrl: REDACTED }, // 少了 target 的半条
      ]);
      const shown = text(r.container);
      assert.ok(shown.length > 40, '整个面板都没渲染出来 —— 这条会空转');
      /*
       * ⚠️ 这里**点名**那句中文散文，而不是对整块面板判"有没有汉字"：
       * 整块面板上还有别人的字（源表格摘要句的顿号分隔符就是一个，见文件头 CJK 的注释），
       * 拿一个大范围正则去兜，会让这条红在一个它并不负责的地方。
       */
      assert.ok(!shown.includes('连不上代理'), `★ 旧 daemon 那句中文散文被原样贴上来了 → ${shown}`);
      assert.ok(!shown.includes('[object Object]'), `★ 内部表示泄漏到界面上 → ${shown}`);
      for (let i = 0; i < 3; i += 1) {
        assert.equal(
          r.container.querySelector(`[data-testid="proxy-probe-detail-Probe${i}"]`),
          null,
          `第 ${i} 格认不出来却仍然渲染了细节`,
        );
      }
      // 反面：认不出细节不等于整行消失 —— 状态与目标仍然要在
      assert.ok(shown.includes('Probe0'), '连探针那一行本身都没了 —— 那是过度防御');
      r.unmount();
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════
 * ⑰ 下载源的名字：**两个渲染点**，缺一个只修一半
 * ══════════════════════════════════════════════════════════════════════════════════ */

const SOURCE_ROWS = [
  {
    // 目录里这一条的 label 逐字含中文 —— 这正是要治的那一格
    provider: 'hf-mirror',
    label: 'hf-mirror 镜像',
    url: 'https://hf-mirror.com',
    reachable: false,
    latencyMs: null,
    viaProxy: true,
  },
  {
    provider: 'modelscope',
    label: 'ModelScope 魔搭',
    url: 'https://www.modelscope.cn',
    reachable: true,
    latencyMs: 189,
    viaProxy: true,
  },
];

async function renderSources(rows: unknown[]) {
  stubApi({
    '/settings/proxy': { config: DEFAULT_PROXY_CONFIG, active: null, media: null },
    'POST /settings/proxy/sources': {
      measuredAt: '2026-08-12T00:00:00.000Z',
      fastest: 'modelscope',
      rows,
    },
  });
  const r = await render(<ProxySettingsSection />);
  await r.flush();
  await click(r.container.querySelector('[data-testid="proxy-test-sources"]'));
  await r.flush();
  return r;
}

const cellText = (c: HTMLElement, provider: string): string => {
  const el = c.querySelector(`[data-testid="proxy-source-name-${provider}"]`);
  assert.ok(el, `源表格里没有「${provider}」这一行 —— 断言会空转`);
  return text(el as HTMLElement);
};
const summaryText = (c: HTMLElement): string => {
  const el = c.querySelector('[data-testid="proxy-source-summary"]');
  assert.ok(el, '这张表旁边一句摘要都没有 —— 断言会空转');
  return text(el as HTMLElement);
};

describe('#112 ⑰ 下载源的名字：表格与摘要句是两个渲染点', () => {
  test('★ 前提自检：内置源那张总表四格齐（少一格 ⇒ 界面上会有一行没名字）', () => {
    assert.deepEqual(
      Object.keys(SOURCE_NAME_KEYS).sort(),
      ['github', 'hf', 'hf-mirror', 'modelscope'],
      'DOWNLOAD_SOURCE_PROVIDERS 变了而措辞表没跟上',
    );
  });

  test('★★ 英文界面：不可达的 hf-mirror 在**表格**与**摘要句**里都是 `hf-mirror (mirror)`', async () => {
    await inEnglish(async () => {
      const r = await renderSources(SOURCE_ROWS);
      const want = enAt('settings.proxy.sourceName.hf-mirror');
      assert.ok(want.length >= 3, '词条短到取不出可断言的片段 —— 这条会空转');

      // ── 渲染点 1：表格那一格
      const cell = cellText(r.container, 'hf-mirror');
      assert.ok(cell.includes(want), `表格里那一格不是词条里的名字（期望「${want}」）→ ${cell}`);
      assert.equal(CJK.test(cell), false, `★ 缺陷原状：表格里逐字是「hf-mirror 镜像」→ ${cell}`);

      // ── 渲染点 2：摘要句的 {{list}}（#105 ⑥ 加的那一句）
      const said = summaryText(r.container);
      assert.ok(said.length > 20, '摘要句没渲染出来 —— 下面这条会空转');
      assert.ok(
        said.includes(want),
        `★ 只修了表格没修摘要句 —— 这正是 #112 ⑰ 点名的那一半（期望「${want}」）→ ${said}`,
      );
      assert.ok(!said.includes('镜像'), `★ 缺陷原状：摘要句里逐字是「hf-mirror 镜像」→ ${said}`);

      // 反面：可达的那个不许被算进"不可达"名单（别把这条修成"摘要句列出所有源"）
      assert.ok(
        !said.includes(enAt('settings.proxy.sourceName.modelscope')),
        `把可达的那个也算成不可达了 → ${said}`,
      );
      r.unmount();
    });
  });

  test('★ 认不出的 provider（自定义源）：如实说这是按配置原样显示的名字', async () => {
    /*
     * 阳性对照 + 诚实性：`measureDownloadSources(cfg, {sources})` 允许调用方传自定义源，
     * 那时我们没有词条。**不许把那个名字装成产品文案**，也不许把它整个吞掉
     *（吞掉 ⇒ 表里出现一行没有名字的延迟数字）。
     */
    await inEnglish(async () => {
      const r = await renderSources([
        {
          provider: 'my-lan-cache',
          label: 'Office cache',
          url: 'http://cache.lan',
          reachable: false,
          latencyMs: null,
          viaProxy: false,
        },
      ]);
      const cell = cellText(r.container, 'my-lan-cache');
      assert.ok(cell.includes('Office cache'), `自定义源的名字整个没了 → ${cell}`);
      for (const chunk of literalChunks(enAt('settings.proxy.sourceNameVerbatim'))) {
        assert.ok(cell.includes(chunk), `没说清"这是按配置原样显示的" → ${cell}`);
      }
      r.unmount();
    });
  });

  test('★ 镜像用例：中文界面上仍然是中文那份（防"到处写死英文"的反向退化）', async () => {
    const r = await renderSources(SOURCE_ROWS);
    const want = zhAt('settings.proxy.sourceName.hf-mirror');
    assert.ok(cellText(r.container, 'hf-mirror').includes(want), '中文界面上表格那一格不是中文');
    assert.ok(summaryText(r.container).includes(want), '中文界面上摘要句那一处不是中文');
    r.unmount();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════
 * ⑪ 搜索页：「为什么没有语义检索」那半句
 * ══════════════════════════════════════════════════════════════════════════════════ */

const REASON_ARMS: readonly SemanticUnavailableReason[] = [
  { kind: 'no_embedding_stage' },
  { kind: 'vector_extension_not_loaded' },
];

async function renderSearch(semanticReason: unknown) {
  stubApi({
    '/search?q=': {
      modes: { keyword: true, semantic: false, hybrid: false, semanticReason, tokenizer: 'simple' },
    },
  });
  const r = await render(<SearchPage />, { route: '/search' });
  await r.flush();
  return r;
}

const unavailableText = (c: HTMLElement): string => {
  const el = c.querySelector('[data-testid="search-modes-unavailable"]');
  assert.ok(el, '「这几档不可用」那句话整段没渲染 —— 断言会空转');
  return text(el as HTMLElement);
};

describe('#112 ⑪ 搜索页：没有语义检索的原因，在英文界面上必须是英文', () => {
  test('★ 前提自检：两格一个不少，且与产品那张总表逐格对齐', () => {
    assert.deepEqual(
      REASON_ARMS.map((r) => r.kind).sort(),
      Object.keys(SEMANTIC_UNAVAILABLE_KEYS).sort(),
      '契约里增/改了一格成因，而这里没跟上',
    );
  });

  test('★★ 两格全部：英文界面上没有汉字，说的就是 en.json 里那一条', async () => {
    await inEnglish(async () => {
      assert.ok(REASON_ARMS.length > 0, '前提：夹具非空');
      for (const arm of REASON_ARMS) {
        const r = await renderSearch(arm);
        const said = unavailableText(r.container);

        assert.ok(said.length > 30, `「${arm.kind}」那句话短得可疑（${said.length} 字）→ ${said}`);
        assert.equal(
          CJK.test(said),
          false,
          `★ 缺陷原状：Semantic search is unavailable: sqlite-vec 未加载 → ${said}`,
        );
        for (const chunk of literalChunks(enAt(SEMANTIC_UNAVAILABLE_KEYS[arm.kind]))) {
          assert.ok(said.includes(chunk), `「${arm.kind}」缺了一段：「${chunk}」→ ${said}`);
        }
        assert.ok(!said.includes('search.semanticUnavailable'), `渲染成了原始 key 串 → ${said}`);
        assert.ok(!said.includes('{{'), `插值洞没被填上 → ${said}`);
        assert.ok(!said.includes('[object Object]'), `★ 结构体被原样塞进模板 → ${said}`);
        r.unmount();
      }
    });
  });

  test('★★ 两格说的**不是同一句话** —— 合并成一句就把"你能做什么"这条区别抹掉了', async () => {
    /*
     * 契约注释里写死的判据：扩展装上了只差链路 ⇒ 用户做什么都没用，等我们接通；
     * 没装上 ⇒ 那是一个环境问题。合并成一句「语义检索不可用」会把这条区别抹掉，
     * 而这一条恰好是"两格都指向同一个词条"这种偷懒修法唯一会红的地方。
     */
    await inEnglish(async () => {
      // ⚠️ 逐条串行：`stubApi` 打的是全局 `fetch`，并发跑两次会互相盖掉对方的桩。
      const said: string[] = [];
      for (const arm of REASON_ARMS) {
        const r = await renderSearch(arm);
        said.push(unavailableText(r.container));
        r.unmount();
      }
      assert.equal(said.length, 2, '前提：两格都跑到了');
      assert.notEqual(said[0], said[1], `两格渲染出了同一句话 → ${said[0]}`);
    });
  });

  test('★ 服务端没说为什么（或说了我们认不出的话）⇒ 如实说"服务端没说"，不猜一格', async () => {
    await inEnglish(async () => {
      for (const raw of [
        null,
        undefined,
        'sqlite-vec 已加载，但尚无 embedding 生成环节（链路未接通）', // 旧 daemon 发的那句
        { kind: 'from_the_future' },
      ]) {
        const r = await renderSearch(raw);
        const said = unavailableText(r.container);
        assert.ok(
          said.includes(enAt('search.modesUnavailableUnknown')),
          `没落到"服务端未说明原因"那一档 → ${said}`,
        );
        assert.equal(CJK.test(said), false, `★ 旧 daemon 那句中文被原样插进英文里 → ${said}`);
        r.unmount();
      }
    });
  });

  test('★ 镜像用例：中文界面上这句必须是中文（防"到处写死英文"的反向退化）', async () => {
    for (const arm of REASON_ARMS) {
      const r = await renderSearch(arm);
      const said = unavailableText(r.container);
      for (const chunk of literalChunks(zhAt(SEMANTIC_UNAVAILABLE_KEYS[arm.kind]), ZH_MIN)) {
        assert.ok(said.includes(chunk), `中文界面上「${arm.kind}」缺了一段：「${chunk}」→ ${said}`);
      }
      r.unmount();
    }
  });
});
