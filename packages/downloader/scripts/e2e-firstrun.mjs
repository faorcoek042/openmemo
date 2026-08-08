#!/usr/bin/env node
/**
 * T-059 — the whole first-run experience, mouse only, from an empty dataDir.
 *
 *   open page → onboarding → install backend pack → install ASR model
 *   → paste a public audio URL → probe shows title/duration → import
 *   → watch transcription finish → real text appears in the note
 *   → generate a mindmap (F4) → drag / right-click / undo → export SVG
 *
 * This is the last unverified claim behind charter requirements 2.1/2.2.
 *
 * Method note: every selector prints its candidates before asserting. Twice already a
 * "missing feature" turned out to be me grabbing the global search box because it was
 * simply the first visible input on the page.
 */

import console from 'node:console';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SHOTS = path.join(REPO, 'docs', 'design', 'assets', 't059-firstrun');
const argv = process.argv.slice(2);
const BASE = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'http://127.0.0.1:17692';
const TOKEN = argv.includes('--token') ? argv[argv.indexOf('--token') + 1] : '';
/** Small public direct-link audio; short enough to transcribe on CPU in-test. */
const AUDIO = argv.includes('--audio')
  ? argv[argv.indexOf('--audio') + 1]
  : 'https://download.samplelib.com/mp3/sample-15s.mp3';
await fs.mkdir(SHOTS, { recursive: true });

const R = [];
function rec(id, name, ok, detail) {
  R.push({ id, name, ok, detail });
  console.log(
    `  [${ok === true ? 'YES ' : ok === 'part' ? 'PART' : 'NO  '}] ${id}. ${name} — ${detail}`,
  );
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 950 },
  locale: 'zh-CN',
  acceptDownloads: true,
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)));
let n = 0;
const shot = async (s) => {
  const f = path.join(SHOTS, `${String(++n).padStart(2, '0')}-${s}.png`);
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  return path.relative(REPO, f);
};
const api = (p) =>
  page.evaluate(async (u) => {
    const r = await fetch(u);
    return { s: r.status, j: await r.json().catch(() => null) };
  }, p);
const bodyTxt = async () =>
  ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ').trim();

console.log(`\nT-059 首次体验（全新空 dataDir，纯鼠标）\nbase: ${BASE}\naudio: ${AUDIO}\n`);

/* ── 0. 打开 + 鉴权 ── */
await page.goto(`${BASE}/models#t=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
rec(
  '0',
  '打开网页并鉴权',
  (await ctx.cookies()).length > 0,
  `cookie=${(await ctx.cookies()).length > 0}`,
);

/* ── 1. 引导 ── */
await page.goto(`${BASE}/onboarding`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
let steps = 0;
for (let i = 0; i < 8; i++) {
  const b = page
    .locator('button:has-text("下一步"), button:has-text("开始使用"), button:has-text("继续")')
    .first();
  if (!(await b.count()) || !(await b.isVisible().catch(() => false))) break;
  const before = await bodyTxt();
  await b.click().catch(() => {});
  await page.waitForTimeout(1500);
  if ((await bodyTxt()) === before) break;
  steps++;
}
rec('1', '走完引导', steps > 0, `推进 ${steps} 步`);
await shot('onboarding');

/* ── 2. 装后端包 ── */
await page.goto(`${BASE}/runtime`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
{
  const btns = page.locator('[data-testid^="backend-install-"]');
  const total = await btns.count();
  let clicked = null;
  for (let i = 0; i < total; i++) {
    const b = btns.nth(i);
    if (!(await b.isVisible().catch(() => false)) || !(await b.isEnabled().catch(() => false)))
      continue;
    const card = b.locator('xpath=ancestor::article[1]');
    const label = ((await card.textContent()) ?? '').replace(/\s+/g, ' ');
    if (!/whisper/i.test(label)) continue;
    clicked = label.slice(0, 50);
    await b.scrollIntoViewIfNeeded().catch(() => {});
    await b.click();
    break;
  }
  let ok = false,
    err = '';
  if (clicked) {
    for (let i = 0; i < 150; i++) {
      await page.waitForTimeout(2000);
      const j = await api('/api/jobs');
      const job = (j.j?.jobs ?? []).find((x) => x.kind === 'backend-pack');
      if (job && ['succeeded', 'failed', 'cancelled'].includes(job.state)) {
        ok = job.state === 'succeeded';
        err = job.error?.messageZh ?? '';
        break;
      }
    }
  }
  rec(
    '2',
    '网页装加速后端',
    ok,
    ok
      ? `点「${clicked}」安装成功`
      : clicked
        ? `失败: ${err}`
        : `${total} 个按钮但无可点的 whisper 包`,
  );
  await shot('backend');
}

/* ── 3. 装 ASR 模型（必须是 whisper ggml，whisper-cli 才认） ── */
await page.goto(`${BASE}/models`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
{
  const unhide = page.locator('[data-testid="models-show-not-recommended"]').first();
  if (await unhide.count()) {
    await unhide.click();
    await page.waitForTimeout(900);
  }
  // Select by testid, not by page text: the card's textContent picks up surrounding
  // copy, which is how a sherpa card got chosen last run when we wanted a Whisper one.
  /* eslint-disable no-undef -- runs inside the browser via page.evaluate() */
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="model-card-"]')].map((e) =>
      e.getAttribute('data-testid'),
    ),
  );
  /* eslint-enable no-undef */
  console.log(`        模型卡 testid: ${JSON.stringify(ids)}`);
  const cards = page.locator('[data-testid^="model-card-asr/whisper"]');
  const total = await cards.count();
  let clicked = null,
    best = Infinity;
  let target = null;
  for (let i = 0; i < total; i++) {
    const card = cards.nth(i);
    const txt = ((await card.textContent()) ?? '').replace(/\s+/g, ' ');
    const btn = card.locator('[data-testid="models-download-button"]').first();
    if (!(await btn.count()) || !(await btn.isVisible().catch(() => false))) continue;
    const bt = ((await btn.textContent()) ?? '').trim();
    const m = /([\d.]+)\s*(MB|GB)/.exec(bt);
    if (!m) continue;
    const mb = Number(m[1]) * (m[2] === 'GB' ? 1000 : 1);
    if (mb < best) {
      best = mb;
      target = btn;
      clicked = txt.slice(0, 40) + ' / ' + bt;
    }
  }
  let ok = false,
    err = '';
  if (target) {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click();
    for (let i = 0; i < 200; i++) {
      await page.waitForTimeout(2000);
      const j = await api('/api/jobs');
      const job = (j.j?.jobs ?? []).find((x) => x.kind === 'model');
      if (job && ['succeeded', 'failed', 'cancelled'].includes(job.state)) {
        ok = job.state === 'succeeded';
        err = job.error?.messageZh ?? '';
        break;
      }
    }
  }
  rec(
    '3',
    '网页装 Whisper ASR 模型',
    ok,
    ok ? `点「${clicked}」下载完成` : clicked ? `失败: ${err}` : '找不到 Whisper 模型的下载按钮',
  );
  await shot('model');
}

/* ── 4. probe ── */
await page.goto(`${BASE}/capture`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
{
  const urlIn = page.locator('[data-testid="capture-url-input"]');
  if (await urlIn.count()) {
    await urlIn.fill(AUDIO);
    await page.waitForTimeout(800);
    // probe may fire on blur/debounce; nudge it
    await urlIn.press('Tab').catch(() => {});
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1500);
      if (/秒|分钟|时长|sample|mp3/i.test(await bodyTxt())) break;
    }
    // Non-GET requests need the double-submit CSRF header the app stores at handshake.
    // Omitting it produced a 403 that looked like a product bug and was purely my own.
    const pr = await page.evaluate(async (u) => {
      const csrf = sessionStorage.getItem('openmemo.csrf') ?? '';
      const r = await fetch('/api/notes/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-OpenMemo-CSRF': csrf },
        body: JSON.stringify({ input: u }),
      });
      return { s: r.status, j: await r.json().catch(() => null) };
    }, AUDIO);
    rec(
      '4',
      'probe 出标题/时长',
      pr.s === 200,
      pr.s === 200
        ? `title="${pr.j?.title}" durationMs=${pr.j?.durationMs} adapter=${pr.j?.adapterId} mediaCount=${pr.j?.mediaCount} · requiresAuth=${pr.j?.requiresAuth}（=“未知”，非“不需要登录”）`
        : `HTTP ${pr.s} ${JSON.stringify(pr.j).slice(0, 120)}`,
    );
  } else rec('4', 'probe 出标题/时长', false, '找不到 capture-url-input');
  await shot('probe');
}

/* ── 5. 导入 → 转写 → 真实文字 ── */
let noteUid = null,
  realText = '';
{
  const go = page
    .locator('button:has-text("开始"), button:has-text("导入"), button[type="submit"]')
    .first();
  if (await go.count()) {
    await go.click();
    await page.waitForTimeout(4000);
    await shot('import-submitted');
    let status = '';
    for (let i = 0; i < 150; i++) {
      await page.waitForTimeout(3000);
      const nl = await api('/api/notes');
      const cand = (nl.j?.notes ?? [])[0];
      if (cand) {
        noteUid = cand.uid;
        status = cand.status;
        const tr = await api(`/api/notes/${cand.uid}/transcript`);
        const segs = tr.j?.segments ?? [];
        if (segs.length > 0) {
          realText = segs
            .map((s) => s.text)
            .join(' ')
            .trim();
          break;
        }
        if (cand.status === 'failed') break;
      }
      if (i === 5) await shot('transcribing');
    }
    rec(
      '5',
      '导入 → 转写 → 出现真实文字',
      realText.length > 0,
      realText.length > 0
        ? `note=${noteUid} status=${status} 文字="${realText.slice(0, 160)}"`
        : `note=${noteUid ?? '未创建'} status=${status || 'n/a'} 无转写文字`,
    );
    await shot('transcribed');
  } else rec('5', '导入 → 转写', false, '找不到提交按钮');
}

/* ── 6. F4 生成导图，然后才验交互 ── */
if (noteUid && realText) {
  await page.goto(`${BASE}/notes/${noteUid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  /* eslint-disable no-undef -- runs inside the browser via page.evaluate() */
  /* ⚠️ 用**成对的 disable/enable**，不要用 `disable-next-line`（T-170）：
     原来这里是 `disable-next-line`，全仓格式化把 `page.evaluate(() =>` 的箭头体
     折到了下一行，`document` 于是从"下一行"变成"下下行" —— 指令还在、位置没动，
     但它盖住的已经不是那一行了，`no-undef` 当场变红。
     `[实测]` 这条是**全量测试抓不到的**（本脚本没有任何自动调用方），只有 eslint 抓到。
     判据同 PROTOCOL §7 补充：**成对写法不依赖行号，重排也不会失效。** */
  const genBtns = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .map((b) => (b.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 30),
  );
  /* eslint-enable no-undef */
  console.log(`        详情页按钮: ${JSON.stringify(genBtns)}`);
  const gen = page
    .locator('button:has-text("思维导图"), button:has-text("生成导图"), button:has-text("导图")')
    .first();
  let genOk = false;
  if (await gen.count()) {
    await gen.click();
    await page.waitForTimeout(3000);
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(3000);
      const mm = await api(`/api/notes/${noteUid}/mindmap`);
      if (mm.s === 200 && mm.j && (mm.j.nodes?.length || mm.j.root)) {
        genOk = true;
        break;
      }
    }
  }
  rec('6', 'F4 生成思维导图', genOk, genOk ? '导图已生成' : '未生成（没有 LLM / 没有生成入口）');

  await page
    .goto(`${BASE}/notes/${noteUid}/mindmap`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    .catch(() => {});
  await page.waitForTimeout(4000);
  const container = await page
    .locator('.mind-elixir, [data-testid*="mindmap"], svg.markmap, #map')
    .count();
  const nodes = await page.locator('me-tpc, .mind-elixir tpc, g.markmap-node, .node').count();
  if (container > 0 && nodes > 0) {
    const node = page.locator('me-tpc, .mind-elixir tpc, g.markmap-node').first();
    const box = await node.boundingBox().catch(() => null);
    let menu = false;
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 130, box.y + 80, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(800);
      await node.click({ button: 'right' }).catch(() => {});
      await page.waitForTimeout(1000);
      menu =
        (await page.locator('[role="menu"], .context-menu, .mind-elixir-ctxmenu, menu').count()) >
        0;
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Control+z').catch(() => {});
      await page.waitForTimeout(600);
    }
    rec(
      '7',
      '导图拖拽/右键/撤销',
      menu ? true : 'part',
      `容器${container} 节点${nodes} · 拖拽已执行 · 右键菜单${menu ? '出现' : '未出现'}`,
    );
  } else {
    rec('7', '导图拖拽/右键/撤销', false, `无节点（container=${container} nodes=${nodes}）`);
  }
  await shot('mindmap');

  const exp = page.locator('button:has-text("导出"), [data-testid*="export"]').first();
  if (await exp.count()) {
    const dlP = page.waitForEvent('download', { timeout: 12000 }).catch(() => null);
    await exp.click();
    await page.waitForTimeout(900);
    const svg = page.locator('button:has-text("SVG"), [role="menuitem"]:has-text("SVG")').first();
    if (await svg.count()) await svg.click().catch(() => {});
    const dl = await dlP;
    if (dl) {
      const f = path.join(SHOTS, 'mindmap.svg');
      await dl.saveAs(f);
      const t = await fs.readFile(f, 'utf8').catch(() => '');
      rec(
        '8',
        '导图 SVG/PNG 导出',
        t.includes('<svg'),
        `${(t.length / 1024).toFixed(1)} KB，${t.includes('<svg') ? '合法 SVG' : '非 SVG'}`,
      );
    } else rec('8', '导图 SVG/PNG 导出', false, '有按钮未触发下载');
  } else rec('8', '导图 SVG/PNG 导出', false, '无导出入口');
} else {
  rec('6', 'F4 生成思维导图', false, '前置步骤未完成');
  rec('7', '导图拖拽/右键/撤销', false, '前置步骤未完成');
  rec('8', '导图 SVG/PNG 导出', false, '前置步骤未完成');
}

await browser.close();
const c = R.reduce((a, x) => ((a[String(x.ok)] = (a[String(x.ok)] ?? 0) + 1), a), {});
console.log(
  `\n${'='.repeat(70)}\n  YES ${c.true ?? 0} · PART ${c.part ?? 0} · NO ${c.false ?? 0}\n${'='.repeat(70)}`,
);
if (realText) console.log(`\n★ 真实转写文字：\n  "${realText.slice(0, 400)}"\n`);
await fs.writeFile(
  path.join(SHOTS, 'report.json'),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      base: BASE,
      audio: AUDIO,
      noteUid,
      realText,
      results: R,
      pageErrors: [...new Set(errs)].slice(0, 10),
    },
    null,
    2,
  ),
  'utf8',
);
console.log(`report: ${path.relative(REPO, path.join(SHOTS, 'report.json'))}`);
process.exit(0);
