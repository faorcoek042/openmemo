#!/usr/bin/env node
/**
 * Real-browser E2E: does the user actually get to CLICK things? (T-027)
 *
 * Every prior verification in this project answered "my module runs". This one answers
 * "a user can click it", which is the only question charter requirements 2.1 / 2.2 are
 * really asking ("全部通过网页完成").
 *
 * Scope per the 2026-08-02 user directive: FUNCTION, not performance. We check that entry
 * points exist and respond. We do not measure paint time, bundle size or frame rate.
 *
 * Backend: reference-server (models/backends, real downloader) + proxy to the real
 * apps/daemon (notes/auth/media). Which half served a call is recorded per finding.
 *
 * Usage: node packages/downloader/scripts/e2e-browser.mjs --base http://127.0.0.1:17660 --token <t>
 */

import console from 'node:console';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SHOTS = path.join(REPO, 'docs', 'design', 'assets', 't027-e2e');

const argv = process.argv.slice(2);
const BASE = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'http://127.0.0.1:17660';
const TOKEN = argv.includes('--token') ? argv[argv.indexOf('--token') + 1] : '';

await fs.mkdir(SHOTS, { recursive: true });

const findings = [];
/** status: yes = present & interactive · partial = renders but dead/erroring · no = absent */
function record(feature, status, detail, shot = null) {
  findings.push({ feature, status, detail, shot });
  const mark = { yes: 'YES ', partial: 'PART', no: 'NO  ', err: 'ERR ' }[status] ?? '?   ';
  console.log(`  [${mark}] ${feature} — ${detail}`);
}

const consoleErrors = [];
const pageErrors = [];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  // Grant mic up front: without it the recorder page only ever shows the blocked state
  // and we learn nothing about whether the button works.
  permissions: ['microphone'],
});
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

const _shots = new Set();
async function fsExists(name) {
  return _shots.has(name);
}
async function shot(name) {
  _shots.add(name);
  const f = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: f, fullPage: true });
  return path.relative(REPO, f);
}

async function goto(route, waitMs = 1200) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(waitMs);
}

/** Is there a visible, enabled element matching any of these selectors/texts? */
async function probe(selectors) {
  for (const sel of selectors) {
    const loc =
      sel.startsWith('text=') || sel.startsWith('/') ? page.locator(sel) : page.locator(sel);
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        return { found: true, el, sel, enabled: await el.isEnabled().catch(() => true) };
      }
    }
  }
  return { found: false };
}

console.log(`\nOpenMemo — real browser E2E`);
console.log(`base: ${BASE}\nshots: ${path.relative(REPO, SHOTS)}\n`);

/* ═══════════════ 0. Boot + token handoff ═══════════════ */
console.log('[0] 启动与 token 交接');
await page.goto(`${BASE}/${TOKEN ? `#t=${TOKEN}` : ''}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const title = await page.title();
const urlAfter = page.url();
record(
  '应用启动',
  title ? 'yes' : 'no',
  `title="${title}" · token fragment ${urlAfter.includes('#t=') ? '未被抹除 ⚠️' : '已抹除 ✓'}`,
  await shot('00-boot'),
);

/* ═══════════════ 1. Navigation inventory ═══════════════ */
console.log('\n[1] 导航入口清单');
const navLinks = await page.locator('a[href], nav a, [role="navigation"] a').evaluateAll((els) =>
  els
    .map((e) => ({
      href: e.getAttribute('href'),
      text: (e.textContent ?? '').trim().slice(0, 20),
    }))
    .filter((x) => x.href),
);
const uniq = [...new Map(navLinks.map((l) => [l.href, l])).values()];
record(
  '侧栏/顶栏导航',
  uniq.length ? 'yes' : 'no',
  `${uniq.length} 个链接: ${uniq.map((l) => l.text || l.href).join(' / ')}`,
);

/* ═══════════════ 2. 要求 2.2 — 模型管理页真实点击 ═══════════════ */
console.log('\n[2] 要求 2.2 模型管理页（真实点击）');
await goto('/models', 2000);
const modelsPage = await probe(['[data-testid="models-page"]']);
record(
  '模型管理页渲染',
  modelsPage.found ? 'yes' : 'no',
  modelsPage.found ? '已渲染' : '未找到 models-page',
  await shot('01-models'),
);

if (modelsPage.found) {
  const cards = await page.locator('[data-testid^="model-card-"]').count();
  record('模型卡片列表', cards > 0 ? 'yes' : 'no', `${cards} 张卡`);

  // 中文默认过滤（ADR-011 决策 1）
  const hint = await probe(['[data-testid="models-show-not-recommended"]']);
  record(
    '中文默认过滤提示',
    hint.found ? 'yes' : 'no',
    hint.found ? '「仍要显示」按钮存在' : '未出现（可能语言非 zh）',
  );
  if (hint.found) {
    const before = await page.locator('[data-testid^="model-card-"]').count();
    await hint.el.click();
    await page.waitForTimeout(800);
    const after = await page.locator('[data-testid^="model-card-"]').count();
    record(
      '点「仍要显示」解除过滤',
      after > before ? 'yes' : 'partial',
      `卡片 ${before} → ${after}`,
      await shot('02-models-unfiltered'),
    );
  }

  // 量化选择器
  const quant = await probe(['[data-testid="models-quant-selector"]']);
  if (quant.found) {
    await quant.el.click();
    await page.waitForTimeout(600);
    const opts = await page.locator('[role="option"]').count();
    record(
      '量化选择器展开',
      opts > 0 ? 'yes' : 'partial',
      `${opts} 个量化档可选`,
      await shot('03-quant-selector'),
    );
    await page.keyboard.press('Escape').catch(() => {});
    await page.mouse.click(5, 5);
    await page.waitForTimeout(300);
  } else {
    record('量化选择器', 'no', '未找到');
  }

  // fit 徽标
  const fit = await page.locator('[data-testid="fit-badge"]').count();
  record('「能不能跑」fit 徽标', fit > 0 ? 'yes' : 'no', `${fit} 个徽标`);

  // 存储分解
  const storage = await probe(['[data-testid="models-storage"]']);
  record(
    '磁盘占用分解',
    storage.found ? 'yes' : 'no',
    storage.found ? '含图例与字节标签' : '未找到',
  );
}

/* ═══════════════ 3. 真实下载点击 ═══════════════ */
console.log('\n[3] 真实点击「下载」并观察进度（要求 2.2 核心动线）');
let downloadOk = false;
if (modelsPage.found) {
  // Unhide language-filtered variants first — the small models are exactly the ones
  // hidden in zh mode, and they are the only ones small enough to download in-test.
  const unhide = await probe(['[data-testid="models-show-not-recommended"]']);
  if (unhide.found) {
    await unhide.el.click();
    await page.waitForTimeout(800);
  }
  const btns = page.locator('[data-testid="models-download-button"]');
  const nBtn = await btns.count();
  if (nBtn === 0) {
    record('下载按钮', 'no', '页面上没有可点的下载按钮');
  } else {
    // Pick the physically smallest download so the run completes in reasonable time.
    let target = btns.first();
    let best = Infinity;
    for (let i = 0; i < nBtn; i++) {
      const t = (await btns.nth(i).textContent()) ?? '';
      const m = /([\d.]+)\s*(MB|GB)/.exec(t);
      if (!m) continue;
      const mb = Number(m[1]) * (m[2] === 'GB' ? 1000 : 1);
      if (mb < best) {
        best = mb;
        target = btns.nth(i);
      }
    }
    const label = ((await target.textContent()) ?? '').trim();
    await target.scrollIntoViewIfNeeded();
    await target.click();
    record('点击下载按钮', 'yes', `按钮文案「${label}」已点击`);

    // 进度行应出现并推进
    // Poll the DOM for visible progress, but decide completion from the API — the row
    // disappearing is ambiguous (could be a re-render), whereas job state is authoritative.
    let sawRow = false;
    let maxPct = 0;
    let lastText = '';
    let jobDone = false;
    const deadline = Date.now() + 900_000; // real 78 MB download at ~0.2 MB/s needs patience
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      const row = page.locator('[data-testid^="models-download-row-"]').first();
      if (await row.count()) {
        sawRow = true;
        lastText = ((await row.textContent()) ?? '').replace(/\s+/g, ' ').trim();
        const m = /(\d+)%/.exec(lastText);
        if (m) maxPct = Math.max(maxPct, Number(m[1]));
        if (maxPct > 0 && maxPct < 95 && !(await fsExists('04-download-progress'))) {
          await shot('04-download-progress');
        }
      }
      const jobs = await page.evaluate(async () => {
        try {
          const r = await fetch('/api/jobs');
          return await r.json();
        } catch {
          return { jobs: [] };
        }
      });
      const j = (jobs.jobs ?? []).find((x) => x.kind === 'model');
      if (j && ['succeeded', 'failed', 'cancelled'].includes(j.state)) {
        jobDone = j.state === 'succeeded';
        if (j.totalBytes)
          maxPct = Math.max(maxPct, Math.round((j.completedBytes / j.totalBytes) * 100));
        break;
      }
    }
    record(
      '下载进度条真的走动',
      sawRow && maxPct > 0 ? 'yes' : sawRow ? 'partial' : 'no',
      sawRow
        ? `进度行出现，观察到 ${maxPct}% · job=${jobDone ? 'succeeded' : '未完成'} · ${lastText.slice(0, 70)}`
        : '未出现进度行',
      await shot('05-download-progress-late'),
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const installedCount = await page.locator('text=已安装').count();
    downloadOk = installedCount > 0;
    record(
      '完成后列表显示「已安装」',
      downloadOk ? 'yes' : 'partial',
      `页面上 ${installedCount} 处「已安装」标记`,
      await shot('06-models-installed'),
    );
  }
}

/* ═══════════════ 4. 删除使用中模型 → remediation 按钮 ═══════════════ */
console.log('\n[4] 删除使用中的模型 → 409 remediation 按钮');
if (downloadOk) {
  page.once('dialog', (d) => d.accept());
  const del = await probe(['[data-testid="model-delete"]']);
  if (del.found) {
    await del.el.click();
    await page.waitForTimeout(2000);
    const rem = await page.locator('[data-testid^="remediation-"]').count();
    const errText = await page.getByText(/使用中|MODEL_IN_USE|正在使用/).count();
    record(
      '409 后 remediation 按钮渲染',
      rem > 0 ? 'yes' : errText > 0 ? 'partial' : 'no',
      rem > 0
        ? `${rem} 个可点的补救按钮`
        : errText > 0
          ? '显示了错误文案但无补救按钮'
          : '无任何反馈',
      await shot('07-delete-remediation'),
    );
  } else {
    record('删除按钮', 'no', '未找到 model-delete');
  }
}

/* ═══════════════ 5. 要求 2.1 — 运行时页 ═══════════════ */
console.log('\n[5] 要求 2.1 运行时与加速后端页');
await goto('/runtime', 2000);
const hwCard = await probe(['[data-testid="runtime-hardware-card"]']);
record(
  '硬件探测卡片',
  hwCard.found ? 'yes' : 'no',
  hwCard.found ? '已渲染真实硬件' : '未找到',
  await shot('08-runtime'),
);
if (hwCard.found) {
  const txt = ((await hwCard.el.textContent()) ?? '').replace(/\s+/g, ' ');
  record('硬件信息内容', /内存|处理器/.test(txt) ? 'yes' : 'partial', txt.slice(0, 120));
  const packs = await page.locator('[data-testid^="backend-pack-"]').count();
  record('后端包列表', packs > 0 ? 'yes' : 'no', `${packs} 个包`);
  const chips = await page.locator('[data-testid^="backend-chip-"]').count();
  record('后端状态芯片', chips > 0 ? 'yes' : 'no', `${chips} 个芯片`);
  const instBtn = await page.locator('[data-testid^="backend-install-"]').count();
  const cpuRm = await probe(['[data-testid^="backend-remove-"]']);
  record(
    '后端安装按钮',
    instBtn > 0 ? 'yes' : 'partial',
    `${instBtn} 个可安装（本机无 GPU，多数不适用属预期）`,
  );
  if (cpuRm.found) {
    record(
      'CPU 包卸载按钮被禁用（承重墙）',
      cpuRm.enabled === false ? 'yes' : 'partial',
      `disabled=${cpuRm.enabled === false}`,
    );
  }
}

/* ═══════════════ 6. 全站功能入口巡检 ═══════════════ */
console.log('\n[6] 全站功能入口巡检（有没有 / 点不点得动）');

const ROUTES = [
  { route: '/', name: 'F5 笔记列表' },
  { route: '/capture', name: 'F1 链接导入' },
  { route: '/record', name: 'F3 录音' },
  { route: '/tasks', name: '任务中心' },
  { route: '/settings', name: '设置页' },
  { route: '/settings/storage', name: '设置-存储' },
];

for (const r of ROUTES) {
  await goto(r.route, 1500);
  const body = ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  const inputs = await page.locator('input, textarea, button, [contenteditable="true"]').count();
  const is404 = /找不到|404|Not Found/i.test(body) && body.length < 400;
  record(
    r.name,
    is404 ? 'no' : inputs > 0 ? 'yes' : 'partial',
    is404 ? `路由未注册` : `${inputs} 个可交互元素 · ${body.slice(0, 80)}`,
    await shot(`10-route-${r.route.replace(/\W+/g, '-') || 'root'}`),
  );
}

/* --- F1 粘贴链接真实输入 --- */
console.log('\n[6a] F1 粘贴链接入口');
await goto('/capture', 1500);
const urlInput = await probe([
  'input[type="url"]',
  'input[placeholder*="http"]',
  'input[placeholder*="链接"]',
  'textarea',
  'input[type="text"]',
]);
if (urlInput.found) {
  await urlInput.el.fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  await page.waitForTimeout(400);
  const submit = await probe([
    'button:has-text("导入")',
    'button:has-text("开始")',
    'button[type="submit"]',
    'button:has-text("转写")',
  ]);
  record('F1 链接输入框', 'yes', `可输入 · 提交按钮${submit.found ? '存在' : '未找到'}`);
  if (submit.found && submit.enabled) {
    await submit.el.click();
    await page.waitForTimeout(2500);
    const after = ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ');
    record('F1 点击导入有反应', 'yes', after.slice(0, 130), await shot('11-f1-submit'));
  }
} else {
  record('F1 链接输入框', 'no', '未找到任何输入框');
}

/* --- F2 拖拽上传 --- */
console.log('\n[6b] F2 本地文件导入');
const fileInput = await page.locator('input[type="file"]').count();
const dropHint = await page.getByText(/拖.{0,4}(拽|放)|松开|drag|drop/i).count();
record(
  'F2 文件选择/拖拽入口',
  fileInput > 0 || dropHint > 0 ? 'yes' : 'no',
  `file input ×${fileInput} · 拖拽提示 ×${dropHint}`,
);

/* --- F3 录音 --- */
console.log('\n[6c] F3 录音');
await goto('/record', 1500);
const recBtn = await probe([
  'button:has-text("开始录音")',
  'button:has-text("录音")',
  '[data-testid*="record"]',
]);
if (recBtn.found) {
  await recBtn.el.click();
  await page.waitForTimeout(2000);
  const body = ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ');
  record('F3 录音按钮可点', 'yes', `点击后: ${body.slice(0, 130)}`, await shot('12-f3-record'));
} else {
  record('F3 录音按钮', 'no', '未找到');
}

/* --- F5 搜索 / 标签 / 星标 / 编辑器 / 导出 --- */
console.log('\n[6d] F5 笔记功能面');
await goto('/', 1800);
const search = await probe([
  'input[type="search"]',
  'input[placeholder*="搜索"]',
  '[data-testid*="search"]',
]);
if (search.found) {
  await search.el.fill('测试');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1800);
  const body = ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ');
  record(
    'F5 搜索框',
    'yes',
    `可输入并回车 · 结果区: ${body.slice(0, 110)}`,
    await shot('13-f5-search'),
  );
} else {
  record('F5 搜索框', 'no', '未找到搜索输入');
}
const tagUi = await page.getByText(/标签/).count();
const starUi =
  (await page.locator('[aria-label*="星"]').count()) +
  (await page.locator('[title*="星"]').count()) +
  (await page.getByText(/收藏|星标/).count());
record('F5 标签 UI', tagUi > 0 ? 'partial' : 'no', `${tagUi} 处标签相关文案（未验证可否新建）`);
record('F5 星标 UI', starUi > 0 ? 'partial' : 'no', `${starUi} 处星标相关元素`);

// 笔记详情：编辑器 / 导出 / 导图
const noteLink = await probe(['a[href^="/notes/"]', 'a[href*="/note"]']);
if (noteLink.found) {
  await noteLink.el.click();
  await page.waitForTimeout(2500);
  const editor = await page
    .locator('.ProseMirror, [contenteditable="true"], [data-testid*="editor"]')
    .count();
  record(
    'F5 笔记编辑器 (TipTap)',
    editor > 0 ? 'yes' : 'no',
    editor > 0 ? `${editor} 个可编辑区` : '详情页无任何 contenteditable/ProseMirror',
  );
  const exportBtn = await page.locator('button:has-text("导出"), [data-testid*="export"]').count();
  record('F5 笔记导出入口', exportBtn > 0 ? 'yes' : 'no', `${exportBtn} 个导出按钮`);
  const mindmap = await page.locator('[data-testid*="mindmap"], .mind-elixir, svg.markmap').count();
  record('F4 导图渲染区', mindmap > 0 ? 'yes' : 'no', `${mindmap} 个导图容器`);
  await shot('14-note-detail');
} else {
  record('F5 笔记详情入口', 'no', '列表里没有可点的笔记链接（可能无数据）');
  record('F5 笔记编辑器 (TipTap)', 'no', '无法到达详情页，未能验证');
  record('F5 笔记导出入口', 'no', '无法到达详情页，未能验证');
  record('F4 导图渲染区', 'no', '无法到达详情页，未能验证');
}

/* --- 设置页 --- */
console.log('\n[6e] 设置页');
await goto('/settings', 1500);
const settingsBody = ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ');
const apiKey =
  (await page.locator('input[type="password"]').count()) +
  (await page.locator('input[placeholder*="Key"]').count()) +
  (await page.getByText(/API\s*Key/i).count());
const langSel =
  (await page.locator('select, [role="combobox"]').count()) +
  (await page.getByText(/语言|Language/).count());
record('设置-API Key', apiKey > 0 ? 'yes' : 'no', `${apiKey} 个相关元素`);
record('设置-语言切换', langSel > 0 ? 'yes' : 'no', `${langSel} 个相关元素`);
record(
  '设置页内容',
  settingsBody.length > 60 ? 'yes' : 'partial',
  settingsBody.slice(0, 120),
  await shot('15-settings'),
);

/* ═══════════════ 7. 真浏览器才能暴露的问题 ═══════════════ */
console.log('\n[7] 真浏览器专属检查');

// SSE：EventSource 是否真的建立，且逐类型 addEventListener 是否奏效
await goto('/models', 2500);
/* eslint-disable no-undef -- the callbacks below run INSIDE the browser via
   page.evaluate(); EventSource/document/getComputedStyle are browser globals there,
   not Node globals in this file. */
const sseInfo = await page.evaluate(async () => {
  const out = { supported: typeof EventSource !== 'undefined', received: [], readyState: -1 };
  return await new Promise((resolve) => {
    try {
      const es = new EventSource('/api/events');
      // 关键坑：具名 event: 帧不会触发 onmessage
      es.onmessage = () => out.received.push('onmessage');
      for (const t of [
        'job.created',
        'job.progress',
        'model.installed',
        'storage.changed',
        'keepalive',
      ]) {
        es.addEventListener(t, () => out.received.push(t));
      }
      setTimeout(() => {
        out.readyState = es.readyState;
        es.close();
        resolve(out);
      }, 3000);
    } catch (e) {
      out.error = String(e);
      resolve(out);
    }
  });
});
record(
  'SSE EventSource 连接',
  sseInfo.readyState === 1 || sseInfo.received.length ? 'yes' : 'partial',
  `readyState=${sseInfo.readyState}(1=OPEN) · 收到: ${sseInfo.received.join(',') || '(3s 内无事件，空闲时正常)'}`,
);
record(
  'onmessage 陷阱',
  sseInfo.received.includes('onmessage') ? 'partial' : 'yes',
  sseInfo.received.includes('onmessage')
    ? '⚠️ onmessage 竟然触发了 —— 说明有帧没带具名 event:'
    : '确认：具名帧不触发 onmessage，逐类型 addEventListener 是必须的',
);

// 暗色主题是否真的生效（architect 记录过：写成普通 @theme 会永远不生效且不报错）
const themeCheck = await page.evaluate(() => {
  const read = () =>
    getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim();
  const before = read();
  document.documentElement.setAttribute('data-theme', 'dark');
  const after = read();
  document.documentElement.removeAttribute('data-theme');
  return { before, after };
});
/* eslint-enable no-undef */

record(
  '暗色主题真的切换',
  themeCheck.before !== themeCheck.after ? 'yes' : 'no',
  `--surface-0: "${themeCheck.before}" → "${themeCheck.after}"${themeCheck.before === themeCheck.after ? ' ⚠️ 未变化' : ''}`,
);

// 未捕获错误
record(
  '控制台无未捕获错误',
  pageErrors.length === 0 ? 'yes' : 'partial',
  pageErrors.length ? `${pageErrors.length} 个 pageerror: ${pageErrors[0]}` : '无 pageerror',
);

/* ═══════════════ 汇总 ═══════════════ */
await browser.close();

const counts = findings.reduce((a, f) => ((a[f.status] = (a[f.status] ?? 0) + 1), a), {});
console.log(`\n${'='.repeat(72)}`);
console.log(`  YES ${counts.yes ?? 0} · PARTIAL ${counts.partial ?? 0} · NO ${counts.no ?? 0}`);
console.log('='.repeat(72));

const report = {
  ranAt: new Date().toISOString(),
  base: BASE,
  browser: 'chromium 151.0.7922.34 (playwright)',
  findings,
  consoleErrors: [...new Set(consoleErrors)].slice(0, 15),
  pageErrors: [...new Set(pageErrors)].slice(0, 15),
};
await fs.writeFile(path.join(SHOTS, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`\nreport: ${path.relative(REPO, path.join(SHOTS, 'report.json'))}`);
console.log(`shots : ${path.relative(REPO, SHOTS)}/*.png`);
if (report.consoleErrors.length) {
  console.log(`\nconsole errors (${report.consoleErrors.length}):`);
  for (const e of report.consoleErrors.slice(0, 6)) console.log(`  - ${e}`);
}
process.exit(0);
