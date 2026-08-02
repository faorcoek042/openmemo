#!/usr/bin/env node
/**
 * T-057 — verify the three mutations `architect` could not click, plus the full
 * first-run experience.
 *
 * Context: the mutations were never broken. A single missing route
 * (`PATCH /notes/:uid/mindmap` → 404) poisoned the whole `notes` surface in the
 * frontend's fallback bookkeeping, so every later call on that surface silently used the
 * in-memory mock and never hit the network. That is why the controls rendered, clicking
 * did nothing, a packet capture was empty, and direct daemon calls all returned 200.
 *
 * So the question here is not "does the button exist" but "does clicking it CHANGE THE
 * DATABASE". Every check below reads the value back from the daemon afterwards.
 *
 * Usage: node packages/downloader/scripts/e2e-t057.mjs --base URL --token T
 */

import console from 'node:console';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SHOTS = path.join(REPO, 'docs', 'design', 'assets', 't057-e2e');
const argv = process.argv.slice(2);
const BASE = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'http://127.0.0.1:17681';
const TOKEN = argv.includes('--token') ? argv[argv.indexOf('--token') + 1] : '';
await fs.mkdir(SHOTS, { recursive: true });

const out = [];
function R(id, name, ok, detail) {
  out.push({ id, name, status: ok, detail });
  console.log(`  [${ok === true ? 'YES ' : ok === 'part' ? 'PART' : 'NO  '}] ${id}. ${name} — ${detail}`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, locale: 'zh-CN', permissions: ['microphone'], acceptDownloads: true });
const page = await ctx.newPage();
const net = [];
page.on('request', (r) => {
  if (r.url().includes('/api/') && r.method() !== 'GET') net.push(`${r.method()} ${r.url().split(new URL(BASE).port)[1] ?? r.url()}`);
});
let n = 0;
const shot = async (s) => {
  const f = path.join(SHOTS, `${String(++n).padStart(2, '0')}-${s}.png`);
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  return f;
};
const api = (p) => page.evaluate(async (u) => { const r = await fetch(u); return { s: r.status, j: await r.json().catch(() => null) }; }, p);

console.log(`\nT-057 复验\nbase: ${BASE}\n`);

// Enter on a non-redirecting route (root /#t= has the known fragment-stripping bug).
await page.goto(`${BASE}/models#t=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const notes = await api('/api/notes');
let noteUid = notes.j?.notes?.[0]?.uid ?? null;
console.log(`  auth=${(await ctx.cookies()).length > 0} note=${noteUid ?? '(none)'}\n`);

/* ═════════ 1. 星标（契约订正为 PUT） ═════════ */
if (noteUid) {
  await page.goto(`${BASE}/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  net.length = 0;
  const star = page.locator('[data-testid*="star"], button[aria-label*="星"], button[title*="星"]').first();
  if (await star.count()) {
    await star.click();
    await page.waitForTimeout(2500);
    const after = await api(`/api/notes/${noteUid}`);
    const ok = after.j?.starred === true;
    R('1', '星标点击真落库', ok, `${ok ? 'starred=true' : `starred=${after.j?.starred}`} · 网络: ${net.join(', ') || '(无非 GET 请求 → 仍走 mock)'}`);
  } else R('1', '星标点击真落库', false, '列表页找不到星标按钮');
  await shot('star');
}

/* ═════════ 2. 标签（两步：建 tag → 整表替换 tagUids） ═════════ */
if (noteUid) {
  await page.goto(`${BASE}/notes/${noteUid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  net.length = 0;
  const add = page.locator('[data-testid*="tag"] button, button:has-text("加标签")').first();
  if (await add.count()) {
    await add.click();
    await page.waitForTimeout(1000);
    const inp = page.locator('input:visible').first();
    if (await inp.count()) {
      await inp.fill('T057标签');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
      const after = await api(`/api/notes/${noteUid}`);
      const ok = JSON.stringify(after.j?.tags ?? []).includes('T057标签');
      R('2', '标签新增真落库', ok, `tags=${JSON.stringify(after.j?.tags ?? [])} · 网络: ${net.join(', ') || '(无非 GET 请求)'}`);

      // removal
      if (ok) {
        net.length = 0;
        const del = page.locator('[data-testid*="tag"] button, button[aria-label*="删除"]').last();
        if (await del.count()) {
          await del.click();
          await page.waitForTimeout(2500);
          const a2 = await api(`/api/notes/${noteUid}`);
          const gone = !JSON.stringify(a2.j?.tags ?? []).includes('T057标签');
          R('2b', '标签删除真落库', gone, `tags=${JSON.stringify(a2.j?.tags ?? [])}`);
        } else R('2b', '标签删除真落库', false, '找不到删除按钮');
      }
    } else R('2', '标签新增真落库', false, '点开后无输入框');
  } else R('2', '标签新增真落库', false, '找不到标签入口');
  await shot('tags');
}

/* ═════════ 3. 段落编辑（「编辑」按钮） ═════════ */
if (noteUid) {
  await page.goto(`${BASE}/notes/${noteUid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  net.length = 0;
  const ed = page.locator('button:has-text("编辑")').first();
  if (await ed.count()) {
    await ed.click();
    await page.waitForTimeout(1200);
    const box = page.locator('textarea:visible, [contenteditable="true"]').first();
    if (await box.count()) {
      await box.fill('T057段落已编辑');
      const save = page.locator('button:has-text("保存")').first();
      if (await save.count()) await save.click();
      else await page.keyboard.press('Control+Enter');
      await page.waitForTimeout(3000);
      const tr = await api(`/api/notes/${noteUid}/transcript`);
      const ok = (tr.j?.segments ?? []).some((s) => String(s.text).includes('T057段落已编辑'));
      R('3', '段落编辑真落库', ok, `${ok ? '已写回 transcript' : '未写回'} · 网络: ${net.join(', ') || '(无非 GET 请求)'}`);
    } else R('3', '段落编辑真落库', false, '点「编辑」后无输入框');
  } else R('3', '段落编辑真落库', false, '找不到「编辑」按钮');
  await shot('segment-edit');
}

/* ═════════ 4. 思维导图 ═════════ */
if (noteUid) {
  await page.goto(`${BASE}/notes/${noteUid}/mindmap`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const body = ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ');
  const crashed = /Unexpected Application Error/.test(body);
  const container = await page.locator('.mind-elixir, [data-testid*="mindmap"], svg.markmap, #map').count();
  const nodes = await page.locator('me-tpc, .mind-elixir tpc, g.markmap-node, .node').count();
  if (crashed) {
    R('4', '导图页不再崩溃', false, body.slice(body.indexOf('Unexpected'), body.indexOf('Unexpected') + 110));
  } else if (container > 0 && nodes > 0) {
    const node = page.locator('me-tpc, .mind-elixir tpc, g.markmap-node').first();
    const box = await node.boundingBox().catch(() => null);
    let ctxMenu = false;
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 130, box.y + 80, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(800);
      await node.click({ button: 'right' }).catch(() => {});
      await page.waitForTimeout(900);
      ctxMenu = (await page.locator('[role="menu"], .context-menu, .mind-elixir-ctxmenu, menu').count()) > 0;
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Control+z').catch(() => {});
      await page.waitForTimeout(600);
    }
    R('4', '导图渲染 + 拖拽/右键/撤销', ctxMenu ? true : 'part', `容器${container} 节点${nodes} · 拖拽已执行 · 右键菜单${ctxMenu ? '出现' : '未出现'}`);
  } else {
    R('4', '导图渲染 + 拖拽/右键/撤销', false, `未崩溃但无节点（container=${container} nodes=${nodes}）· ${body.slice(0, 90)}`);
  }
  await shot('mindmap');

  // SVG / PNG export
  const exp = page.locator('button:has-text("导出"), [data-testid*="export"]').first();
  if (await exp.count()) {
    const dlP = page.waitForEvent('download', { timeout: 12000 }).catch(() => null);
    await exp.click();
    await page.waitForTimeout(900);
    const opt = page.locator('button:has-text("SVG"), [role="menuitem"]:has-text("SVG")').first();
    if (await opt.count()) await opt.click().catch(() => {});
    const dl = await dlP;
    if (dl) {
      const f = path.join(SHOTS, 'mindmap.svg');
      await dl.saveAs(f);
      const txt = await fs.readFile(f, 'utf8').catch(() => '');
      R('5', '导图 SVG/PNG 导出', txt.includes('<svg'), `下载 ${(txt.length / 1024).toFixed(1)} KB，${txt.includes('<svg') ? '是合法 SVG' : '不是 SVG'}`);
    } else R('5', '导图 SVG/PNG 导出', false, '有导出按钮但未触发下载');
  } else R('5', '导图 SVG/PNG 导出', false, '导图页无导出入口');
}

/* ═════════ 6. 完整首次体验：引导 → 真转一段 ═════════ */
console.log('\n【完整首次体验：引导走完 → 真转一段】');
{
  await page.goto(`${BASE}/onboarding`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  let steps = 0;
  for (let i = 0; i < 8; i++) {
    const b = page.locator('button:has-text("下一步"), button:has-text("开始使用"), button:has-text("继续")').first();
    if (!(await b.count()) || !(await b.isVisible().catch(() => false))) break;
    const before = await page.locator('body').textContent();
    await b.click().catch(() => {});
    await page.waitForTimeout(1500);
    if ((await page.locator('body').textContent()) === before) break;
    steps++;
  }
  R('6', '引导走完', steps > 0, `推进 ${steps} 步`);
  await shot('onboarding');

  // The precise selector — the first input[type=text] is the global search box.
  await page.goto(`${BASE}/capture`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const urlIn = page.locator('[data-testid="capture-url-input"]');
  const found = (await urlIn.count()) > 0;
  R('7', 'capture 链接输入框（精确选择器）', found, found ? '[data-testid="capture-url-input"] 命中' : '仍找不到');

  if (found) {
    net.length = 0;
    await urlIn.fill('https://download.samplelib.com/mp3/sample-6s.mp3');
    await page.waitForTimeout(500);
    const go = page.locator('button:has-text("开始"), button:has-text("导入"), button[type="submit"]').first();
    if (await go.count()) {
      await go.click();
      await page.waitForTimeout(4000);
      await shot('capture-submitted');
      // Wait for a real transcript to appear.
      let noteOk = null, txt = '', state = '';
      for (let i = 0; i < 90; i++) {
        await page.waitForTimeout(3000);
        const nl = await api('/api/notes');
        const cand = (nl.j?.notes ?? []).find((x) => x.uid !== noteUid);
        if (cand) {
          noteOk = cand.uid;
          state = cand.status;
          const tr = await api(`/api/notes/${cand.uid}/transcript`);
          const segs = tr.j?.segments ?? [];
          if (segs.length > 0) { txt = segs.map((s) => s.text).join(' ').slice(0, 90); break; }
          if (cand.status === 'failed') break;
        }
      }
      R('8', '真转一段（导入 → 转写 → 有文字）', txt.length > 0, txt.length > 0 ? `note=${noteOk} status=${state} 首段: "${txt}"` : `note=${noteOk ?? '未创建'} status=${state || 'n/a'} 未产出转写文字 · 网络: ${net.slice(0, 3).join(', ')}`);
      await shot('transcribed');
    } else R('8', '真转一段', false, '找不到提交按钮');
  } else R('8', '真转一段', false, '无输入框，无法提交');
}

await browser.close();
const c = out.reduce((a, x) => ((a[String(x.status)] = (a[String(x.status)] ?? 0) + 1), a), {});
console.log(`\n${'='.repeat(66)}\n  YES ${c.true ?? 0} · PART ${c.part ?? 0} · NO ${c.false ?? 0}\n${'='.repeat(66)}`);
await fs.writeFile(path.join(SHOTS, 'report.json'), JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, results: out }, null, 2), 'utf8');
console.log(`report: ${path.relative(REPO, path.join(SHOTS, 'report.json'))}`);
process.exit(0);
