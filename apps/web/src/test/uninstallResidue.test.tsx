/**
 * ★★ **「卸载成了，但有 N 个文件没删掉」—— 这句话在界面上到底有没有说出来。**
 *
 * ## 它和 `silentFailures.test.tsx` 是同一族，但不是同一条规则
 *
 * 那份守的是「**写操作失败了**，界面必须说话」。这一份守的是它的**第三档**：
 *
 *   > **写操作成功了，但结果和用户以为的不一样 —— 界面同样必须说话。**
 *
 * `795f091` 让两个卸载端点在有拒绝时回 `200 + filesNotRemoved`（干净的那条路仍是 204），
 * **而两个 web 调用方都是 `api<void>(…)`** —— body 被整个丢掉，界面上一个字都没有。
 * 用户点了卸载：卡片消失了，磁盘一个字节没回来，产品从头到尾没提过这件事（#109）。
 * 这不是"失败没说话"，所以上面那份用例一条都抓不到它；它需要自己的腿。
 *
 * ## 🔴 第一条断言钉的是 #107 的教训，不是文案
 *
 * 那一轮的结论写在契约注释里：
 *
 *   > 用户点卸载看到「有 N 个文件没能删」，最自然的解读是「卸载失败了，我再点一次」
 *   > —— 而记录其实已经走了，**再点会拿到 404**。
 *
 * 所以断言不是"横幅出现了"，是**横幅最先说的那一句必须是"记录已经清掉了"**
 * （`said.startsWith(...)`）。一个只说残留、不说卸载已生效的横幅**照样是 bug**，
 * 而"有没有横幅"那种断言看不出这个区别。
 *
 * ## 为什么钉**整句词条**，而不是钉关键词
 *
 * 本仓对关键词判据有过明确结论（见 `silentFailures.test.tsx` 文件头的 B11）：
 * **文案写得越好，关键词判据越判不出来**。所以这里把两份 locale 里那句话
 * 原样读出来、自己做一遍插值，再要求它逐字出现在渲染结果里。
 * 这不是循环论证：期望值来自 **JSON 文件**，被测的是**组件的渲染结果**，
 * 中间隔着"有没有把 `filesNotRemoved` 接出来、参数传没传对、tone 选没选对"这几件事
 * —— 也正是 #109 断掉的那几米。
 *
 * ⚠️ 用中文那一份：宿主把 `openmemo.locale` 钉成了 `zh-CN`（见 `dom-env.ts` 末尾），
 *   所有组件测试都在中文界面上跑。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { render, click, stubApi } from './host';
import ModelsPage from '../features/models/ModelsPage';
import RuntimePage from '../features/runtime/RuntimePage';
import zhLocale from '../app/i18n/locales/zh-CN.json';

const UNINSTALL = (zhLocale as unknown as { uninstall: Record<string, string> }).uninstall;

/**
 * 自己做一遍 i18next 的插值。
 *
 * ⚠️ 缺参数时**留着占位符**（不是替成空串）—— 下面有一条断言专门检查渲染结果里
 * 没有 `{{…}}` 残留，而"参数名写错了"正是这一族最常见的半成品：
 * 句子出现了、数字和文件名却还是两个花括号。
 */
function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? `{{${k}}}`);
}

const squash = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 服务端拒绝删除的那两条 —— **形状照抄 `RefusedFileReport`**。
 *
 * `reason` 用的是 `packages/downloader/src/store.ts` 里 `assertInsideInstallRoots()`
 * 真的会抛出来的那句英文原话（带绝对路径）。契约刻意没有把它收成枚举，
 * 界面必须原样照登 —— 而**那串路径就是"那几个文件在哪儿"唯一的答案**。
 * 两条而不是一条：这样 `{{n}}` 是 2、`{{names}}` 是两个名字用 ', ' 接起来，
 * 一条的话"数错了""没接起来"都看不出来。
 */
const REFUSED = [
  {
    name: 'ggml-tiny-q5_1.bin',
    reason:
      'Legacy installed-file record "/opt/OpenMemo/runtime/probe/ggml-tiny-q5_1.bin" resolves to ' +
      '/opt/OpenMemo/runtime/probe/ggml-tiny-q5_1.bin, which is outside every allowed root ' +
      '(/home/u/.openmemo/models) — refusing to hand out a path we do not own',
  },
  {
    name: 'ggml-tiny-encoder.mlmodelc',
    reason:
      'Unpack directory derived from ggml-tiny-encoder.mlmodelc resolves to ' +
      '/opt/OpenMemo/runtime/probe/ggml-tiny-encoder.mlmodelc, which is outside every allowed ' +
      'root (/home/u/.openmemo/models) — refusing to hand out a path we do not own',
  },
] as const;

const EXPECTED_TITLE = fill(UNINSTALL['recordRemovedFilesKept']!, {
  n: String(REFUSED.length),
  names: REFUSED.map((f) => f.name).join(', '),
});

/** 204 —— 全删干净了，客户端拿到的是 `undefined`。 */
const cleanUninstall = (): Response => new Response(null, { status: 204 });

/** 替换 `window.confirm`（jsdom 那个是"未实现"存根，返回 undefined ⇒ 永远不会真的删）。 */
function withConfirm(answer: boolean): () => void {
  const w = window as unknown as { confirm: (m?: string) => boolean };
  const prev = w.confirm;
  w.confirm = () => answer;
  return () => {
    w.confirm = prev;
  };
}

/**
 * 一条横幅要同时说清三件事，**顺序是判据的一部分**。
 * 抽出来是因为两个页面说的必须是同一句话 —— 各写一份断言，两边就会各自漂。
 */
function assertSaysRecordRemovedButFilesKept(root: Element): void {
  const banner = root.querySelector('[data-testid="uninstall-files-kept"]');
  assert.ok(
    banner,
    '卸载回了 200 + filesNotRemoved，界面上却没有任何东西 —— 这正是 #109：' +
      '服务端算好了"哪几个文件没删掉、它们在哪"，最后一米被丢掉。' +
      `页面全文：${squash(root.textContent)}`,
  );

  const said = squash(banner.textContent);

  /*
   * ① 🔴 **最先读到的那一句必须是"记录已经清掉了"**（#107 的教训）。
   *   只说残留的横幅会把用户推去再点一次 —— 而再点一次拿到的是 404。
   */
  assert.ok(
    said.startsWith(EXPECTED_TITLE),
    '横幅开头那句不是"卸载已生效、记录已清掉" —— 用户会把它读成"卸载失败了，我再点一次"，' +
      `而记录其实已经走了，再点会拿到 404（#107）。\n  期望开头：${EXPECTED_TITLE}\n  实际全文：${said}`,
  );

  // ② 数量与文件名真的被插进去了（`{{n}}` / `{{names}}` 传错名字时句子还在、数字没了）
  for (const f of REFUSED) {
    assert.ok(said.includes(f.name), `没说是哪几个文件（缺 ${f.name}）：${said}`);
  }

  /*
   * ③ **那几个文件在哪儿** —— 只有解析层的英文原话答得出来（它带着绝对路径），
   *   而且必须被标成"原文、未翻译"，不许伪装成我们自己的话。
   */
  for (const f of REFUSED) {
    assert.ok(
      said.includes(fill(UNINSTALL['verbatimReason']!, { reason: f.reason })),
      `没有原样照登解析层那句话（它是"文件在哪儿"唯一的出处）：\n  缺：${f.reason}\n  实际：${said}`,
    );
  }
  assert.ok(
    said.includes(UNINSTALL['filesKeptHint']!),
    `没说"这里不需要再做什么" —— 那一句是 ① 的兑现方式：${said}`,
  );

  // ④ 插值真的发生了。半成品的形状是"句子在、花括号还在"。
  assert.equal(
    /\{\{\w+\}\}/.test(said),
    false,
    `渲染结果里还留着 {{…}} 占位符 —— 参数名传错了：${said}`,
  );

  /*
   * ⑤ 🔴 **不是错误态。** 卸载**成功了**，只是有残留。
   *   渲染成故障（`ErrorBlock` 是 `role="alert"`；`Banner` 的 critical 档会把
   *   `aria-live` 换成 `assertive`、左边那道色条换成 `border-l-critical`）
   *   会把一次成功说成失败，用户的下一步动作又变回"再点一次"。
   */
  assert.equal(
    banner.getAttribute('role'),
    'status',
    '这条横幅被渲染成了警报（`role="alert"`）—— 卸载是成功的，只有残留',
  );
  assert.equal(
    banner.getAttribute('aria-live'),
    'polite',
    'assertive 是故障级播报 —— tone 被改成 critical 了？卸载并没有失败',
  );
  assert.equal(
    /border-l-(critical|serious)/.test(banner.className),
    false,
    `用了故障级色条：${banner.className}`,
  );
  const inErrorBlock = [...root.querySelectorAll('[data-testid="error-block"]')].some(
    (el) => el.contains(banner) || squash(el.textContent).includes(REFUSED[0].name),
  );
  assert.equal(
    inErrorBlock,
    false,
    '这句话被塞进了错误块里 —— 那需要先编一个 ApiError 出来，而根本没有错误发生',
  );
}

/* ══════════════════════════ /models ══════════════════════════ */

const VARIANT_ID = 'asr/dummy-q5';
const DELETE_MODEL = `DELETE /models/${encodeURIComponent(VARIANT_ID)}`;

/**
 * `/models` 四个 query 的最小桩 + 一个**已安装**的变体（不然卡片上是「下载」不是「卸载」）。
 * 形状照 `components.test.tsx` 里那份已经跑通的夹具，只加"已安装"这一件事。
 */
function stubModelsPage(deleteHandler: unknown) {
  const variant = {
    id: VARIANT_ID,
    groupId: 'asr/dummy',
    role: 'asr',
    arch: 'whisper',
    format: 'ggml',
    quantization: 'q5_1',
    speedClass: 'balance',
    languages: ['multi'],
    tags: [],
    totalSizeBytes: 60_000_000,
    catalogVersion: '2026.08.14',
    license: { id: 'MIT', url: 'https://example.invalid', requiresAcceptance: false, gated: false },
    files: [{ name: 'a.bin', sha256: 'x'.repeat(64), sizeBytes: 60_000_000, optional: false }],
    requirements: { ramRequiredMB: 512, vramRequiredMB: 0, computedAtContext: null },
    fitness: {
      tier: 'recommended',
      // 契约里 reasonZh / reasonEn 成对（#106）—— 夹具只写一份就是造一个生产者产不出的形状
      reasonZh: 'dummy reason',
      reasonEn: 'dummy reason',
      notRecommendedForLanguage: false,
      speedTier: 'unknown',
      speedSource: 'none',
      estMinutesPerAudioHour: null,
      estGpuLayers: null,
    },
  };
  const catalog = {
    stale: false,
    fetchedAt: '2026-08-14T00:00:00.000Z',
    groups: [
      {
        groupId: 'asr/dummy',
        role: 'asr',
        displayName: 'Dummy ASR',
        displayNameZh: '假装的转写模型',
        descriptionZh: '一段用来占位的中文描述',
        descriptionEn: 'a stub group',
        // `recommended-default` 让它落进「推荐」那一组（分组规则见 asrSections.ts）
        tags: ['recommended-default'],
        variants: [variant],
      },
    ],
  };
  return stubApi({
    '/models/catalog?role=all&lang=zh': catalog,
    '/models/catalog?role=all&lang=en': catalog,
    '/models/installed': {
      models: [
        {
          id: VARIANT_ID,
          /*
           * ⚠️ `groupId` / `displayName` 不是可有可无的装饰：本页的 `AsrModelPicker`
           * 会拿它们去拼下拉里那一行（`optionLabel()` 在 `quantization` 存在时
           * 直接 `displayName.toLowerCase()`）。少写一个，整页在渲染时就抛，
           * 而这条用例会变成"页面根本没起来"。
           */
          groupId: 'asr/dummy',
          displayName: 'Dummy ASR (Q5_1)',
          role: 'asr',
          arch: 'whisper',
          format: 'ggml',
          quantization: 'q5_1',
          sizeBytes: 60_000_000,
          installedAt: '2026-08-01T00:00:00.000Z',
          verifiedAt: '2026-08-01T00:00:00.000Z',
          integrity: 'ok',
          files: [],
        },
      ],
      active: { asr: null, llm: null },
    },
    '/models/storage': {
      usedBytes: 60_000_000,
      volume: { freeBytes: 1_000_000_000, totalBytes: 2_000_000_000 },
      breakdown: [],
      reclaimable: { orphanBlobsBytes: 0, stalePartialsBytes: 0 },
    },
    '/jobs': { jobs: [] },
    '/settings': { settings: {} },
    '/secrets': { secrets: [], disclosure: null },
    [DELETE_MODEL]: deleteHandler,
  });
}

async function clickModelDelete(r: Awaited<ReturnType<typeof render>>): Promise<void> {
  const btn = r.container.querySelector('[data-testid="model-delete"]');
  assert.ok(
    btn,
    '卡片上没有卸载按钮 —— 夹具没把这个变体标成已安装，后面的断言测的是别的东西。' +
      `页面全文：${squash(r.container.textContent)}`,
  );
  await click(btn);
  await r.flush();
}

describe('#109 /models 卸载：记录清掉了，但有文件留下', () => {
  test('★★ 服务端回 200 + filesNotRemoved ⇒ 界面必须说清"记录已清 + 哪几个没删 + 在哪"', async () => {
    const restore = withConfirm(true);
    const { calls } = stubModelsPage({
      modelId: VARIANT_ID,
      freedBytes: 0,
      filesNotRemoved: REFUSED,
    });
    try {
      const r = await render(<ModelsPage />, { route: '/models' });
      await r.flush();
      await clickModelDelete(r);

      // 前提先自证：请求真的发出去了（没发出去的话下面断的是"什么都没发生"）
      assert.ok(
        calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/models/')),
        `卸载请求根本没发出去：${JSON.stringify(calls)}`,
      );

      assertSaysRecordRemovedButFilesKept(r.container);
      r.unmount();
    } finally {
      restore();
    }
  });

  test('★★ 反面：干净卸载（204）时不许冒出这条横幅', async () => {
    /*
     * 没有这一条，把渲染条件写成恒真也能让上面那条绿 —— 而那会让**每一次**卸载
     * 都对用户说一句"有文件被留下"，比不说更坏。
     */
    const restore = withConfirm(true);
    stubModelsPage(cleanUninstall);
    try {
      const r = await render(<ModelsPage />, { route: '/models' });
      await r.flush();
      await clickModelDelete(r);

      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-kept"]'),
        null,
        '全都删干净了（204），界面却说有文件被留下 —— 那是凭空造出来的一句假话',
      );
      r.unmount();
    } finally {
      restore();
    }
  });

  test('★★ 先拒绝、再干净卸载 ⇒ 上一条横幅必须消失（陈旧的它是一句新的假话）', async () => {
    /*
     * 🔴 这一条钉的是"横幅存在哪儿"。用组件自己的 `useState` 存这份结果时，
     * 成功路径上忘了清它，界面就会在一次**干净**卸载之后继续挂着
     * 「有文件被留下」—— 用户会去找几个根本不存在的残留文件。
     * 现在读的是 `del.data`（react-query 一进入 pending 就把它清成 undefined），
     * 但这条断言钉的是**后果**，不是那个实现：换回 state 也照样必须绿。
     */
    const restore = withConfirm(true);
    let nth = 0;
    stubModelsPage(() => {
      nth += 1;
      return nth === 1
        ? { modelId: VARIANT_ID, freedBytes: 0, filesNotRemoved: REFUSED }
        : cleanUninstall();
    });
    try {
      const r = await render(<ModelsPage />, { route: '/models' });
      await r.flush();

      await clickModelDelete(r);
      assert.ok(
        r.container.querySelector('[data-testid="uninstall-files-kept"]'),
        '第一次（有拒绝）就没出现，这条用例的前提不成立',
      );

      await clickModelDelete(r);
      assert.equal(
        nth,
        2,
        `第二次卸载请求没发出去（发出去 ${String(nth)} 次）—— 那么下面断的是"它自己消失了"`,
      );
      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-kept"]'),
        null,
        '上一次卸载留下的横幅，在一次干净卸载之后还挂着 —— 这不是"旧信息"，是一句新的假话：' +
          '用户会去盘上找几个已经不存在的残留文件',
      );
      r.unmount();
    } finally {
      restore();
    }
  });
});

/* ══════════════════════════ /runtime ══════════════════════════ */

const PACK_ID = 'ytdlp-linux-x64';

/**
 * `/runtime` 的最小桩。
 *
 * ⚠️ 包故意选 **yt-dlp**：`whisper.cpp` 的 CPU 包是承重墙
 * （`isLoadBearingPack()` ⇒ 卸载按钮 `disabled`），拿它当夹具的话这条用例
 * 会在"按钮点不动"上静默变成什么都没测。
 */
function stubRuntimePage(deleteHandler: unknown) {
  const pack = {
    id: PACK_ID,
    backend: 'cpu',
    engine: 'yt-dlp',
    engineVersion: '2026.07.04',
    os: 'linux',
    arch: 'x64',
    tier: 'downloadable',
    displayName: 'yt-dlp',
    displayNameZh: 'yt-dlp',
    totalSizeBytes: 12_000_000,
    installed: true,
    applicable: true,
    recommended: false,
    priority: 42,
    requiresDriver: null,
    inapplicability: null,
  };
  return stubApi({
    '/runtime/hardware': {
      hardware: {
        detectedAt: '2026-08-14T00:00:00.000Z',
        os: { platform: 'linux', arch: 'x64', version: '6.1' },
        cpu: { brand: 'Stub CPU', physicalCores: 4, logicalCores: 8, features: ['avx2'] },
        ram: { totalMB: 16000, availableMB: 8000 },
        gpus: [],
        selectedGpuIndex: null,
        unifiedMemory: false,
        disks: [{ path: '/tmp/stub', pathFor: 'models_root', freeMB: 10000, totalMB: 50000 }],
        backends: [
          { id: 'cpu', installed: true, available: true, probed: true, unavailableReason: null },
        ],
        selectedBackend: 'cpu',
      },
    },
    '/backends/catalog': { stale: false, packs: [pack] },
    '/backends/installed': { selectedBackend: 'cpu', packs: [{ id: PACK_ID, selfTest: null }] },
    '/jobs': { jobs: [] },
    [`DELETE /backends/${PACK_ID}`]: deleteHandler,
  });
}

async function clickPackRemove(r: Awaited<ReturnType<typeof render>>): Promise<void> {
  const btn = r.container.querySelector(`[data-testid="backend-remove-${PACK_ID}"]`);
  assert.ok(btn, `卡片上没有卸载按钮。页面全文：${squash(r.container.textContent)}`);
  assert.equal(
    (btn as HTMLButtonElement).disabled,
    false,
    '卸载按钮是灰的 —— 这条用例会变成"点了个点不动的按钮"，什么都没测',
  );
  await click(btn);
  await r.flush();
}

describe('#109 /runtime 卸载：同一句话，不许两个页面各说各的', () => {
  test('★★ 后端包卸载回 200 + filesNotRemoved ⇒ 界面必须说同样的三件事', async () => {
    const restore = withConfirm(true);
    const { calls } = stubRuntimePage({
      packId: PACK_ID,
      freedBytes: 0,
      filesNotRemoved: REFUSED,
    });
    try {
      const r = await render(<RuntimePage />, { route: '/runtime' });
      await r.flush();
      await clickPackRemove(r);

      assert.ok(
        calls.some((c) => c.method === 'DELETE' && c.path === `/backends/${PACK_ID}`),
        `卸载请求根本没发出去：${JSON.stringify(calls)}`,
      );

      assertSaysRecordRemovedButFilesKept(r.container);
      r.unmount();
    } finally {
      restore();
    }
  });

  test('★★ 反面：干净卸载（204）时不许冒出这条横幅', async () => {
    const restore = withConfirm(true);
    stubRuntimePage(cleanUninstall);
    try {
      const r = await render(<RuntimePage />, { route: '/runtime' });
      await r.flush();
      await clickPackRemove(r);

      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-kept"]'),
        null,
        '全都删干净了（204），界面却说有文件被留下',
      );
      r.unmount();
    } finally {
      restore();
    }
  });
});
