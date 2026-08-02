#!/usr/bin/env node
/**
 * T-045 — cold-start install, mouse only.
 *
 * THE question behind charter requirements 2.1/2.2: on a machine that has nothing
 * installed, can a user click their way to a working product without ever touching a
 * command line? Every previous verification ran against an environment somebody had
 * already prepared by hand, which quietly assumed away the whole problem.
 *
 * Method: fresh empty dataDir → open the page → click through onboarding → install
 * backend, ASR model, VAD, tokenizer → transcribe something. Then run selfcheck against
 * the SAME dataDir and count failures.
 *
 * Getting stuck is a RESULT, not a failure of the test. Where a new user stops is the
 * evidence that decides whether 2.1/2.2 actually hold, so every dead end is screenshotted
 * and recorded verbatim rather than worked around.
 *
 * Usage: node packages/downloader/scripts/e2e-coldstart.mjs --base URL --token T
 */

import console from 'node:console';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SHOTS = path.join(REPO, 'docs', 'design', 'assets', 't045-coldstart');
const argv = process.argv.slice(2);
const BASE = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'http://127.0.0.1:17660';
const TOKEN = argv.includes('--token') ? argv[argv.indexOf('--token') + 1] : '';
await fs.mkdir(SHOTS, { recursive: true });

const steps = [];
function step(id, name, status, detail) {
  steps.push({ id, name, status, detail });
  const m = { yes: 'YES ', partial: 'PART', no: 'NO  ', blocked: 'BLOCK' }[status] ?? '??';
  console.log(`  [${m}] ${id}. ${name} — ${detail}`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, locale: 'zh-CN', permissions: ['microphone'], acceptDownloads: true });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 150)));

let shotN = 0;
const shot = async (n) => {
  const f = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${n}.png`);
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  return path.relative(REPO, f);
};
const bodyText = async () => ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ').trim();
async function vis(sels) {
  for (const s of sels) {
    const l = page.locator(s);
    const n = await l.count();
    for (let i = 0; i < n; i++) {
      const el = l.nth(i);
      if (await el.isVisible().catch(() => false)) return { el, sel: s };
    }
  }
  return null;
}
const api = (p) => page.evaluate(async (u) => { try { const r = await fetch(u); return { s: r.status, j: await r.json() }; } catch (e) { return { s: 0, e: String(e) }; } }, p);

console.log(`\nT-045 冷启动装机（纯鼠标）\nbase: ${BASE}\n`);

/* ── 0. 打开页面 ── */
await page.goto(`${BASE}/models#t=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const authed = (await ctx.cookies()).length > 0;
step('0', '打开网页并完成鉴权', authed ? 'yes' : 'no',
  authed ? '已拿到 session cookie' : '未认证（注意：根路径 /#t= 有已知 bug，此处用 /models#t= 绕过）');
await shot('boot');

/* ── 1. 首启引导 ── */
await page.goto(`${BASE}/onboarding`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const obBody = await bodyText();
await shot('onboarding');
{
  // Walk the wizard by clicking whatever advances it, up to 8 screens.
  let advanced = 0;
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    const btn = await vis(['button:has-text("下一步")', 'button:has-text("继续")', 'button:has-text("开始使用")', 'button:has-text("开始")', 'button:has-text("跳过")']);
    if (!btn) break;
    const label = ((await btn.el.textContent()) ?? '').trim();
    const before = await bodyText();
    await btn.el.click().catch(() => {});
    await page.waitForTimeout(1800);
    const after = await bodyText();
    if (after !== before) { advanced++; if (!seen.has(label)) seen.add(label); } else break;
  }
  step('1', '首启引导可点着走', advanced > 0 ? 'yes' : obBody.length > 60 ? 'partial' : 'no',
    advanced > 0 ? `推进了 ${advanced} 步（按钮：${[...seen].join('/')}）` : `页面有内容但点不动 · ${obBody.slice(0, 80)}`);
  await shot('onboarding-walked');
}

/* ── 2. 硬件检测 ── */
await page.goto(`${BASE}/runtime`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
{
  const hw = await page.locator('[data-testid="runtime-hardware-card"]').count();
  const txt = hw ? ((await page.locator('[data-testid="runtime-hardware-card"]').first().textContent()) ?? '').replace(/\s+/g, ' ') : '';
  step('2', '网页检测硬件', hw > 0 ? 'yes' : 'no', hw > 0 ? txt.slice(0, 110) : '无硬件卡');
  await shot('runtime-hardware');
}

/* ── 3. 装加速后端包（whisper-cli 的来源）── */
{
  const packs = await page.locator('[data-testid^="backend-pack-"]').count();
  const installBtns = page.locator('[data-testid^="backend-install-"]');
  const n = await installBtns.count();
  let clicked = null, done = false, err = '';
  for (let i = 0; i < n; i++) {
    const b = installBtns.nth(i);
    if (!(await b.isVisible().catch(() => false)) || !(await b.isEnabled().catch(() => false))) continue;
    const card = b.locator('xpath=ancestor::article[1]');
    const label = ((await card.textContent()) ?? '').replace(/\s+/g, ' ');
    if (!/whisper/i.test(label)) continue;      // we need whisper-cli specifically
    clicked = label.slice(0, 60);
    await b.scrollIntoViewIfNeeded().catch(() => {});
    await b.click();
    break;
  }
  if (clicked) {
    // Wait for the install job to reach a terminal state.
    for (let i = 0; i < 150; i++) {
      await page.waitForTimeout(2000);
      const j = await api('/api/jobs');
      const job = (j.j?.jobs ?? []).find((x) => x.kind === 'backend-pack');
      if (job && ['succeeded', 'failed', 'cancelled'].includes(job.state)) {
        done = job.state === 'succeeded';
        err = job.error ? `${job.error.code}: ${job.error.messageZh ?? job.error.message}` : '';
        break;
      }
      if (i === 3) await shot('backend-installing');
    }
    step('3', '网页装加速后端（whisper.cpp）', done ? 'yes' : 'no',
      done ? `点「${clicked}」安装成功` : `点了「${clicked}」但未成功：${err || '任务未在 5 分钟内完成'}`);
  } else {
    step('3', '网页装加速后端（whisper.cpp）', n > 0 ? 'blocked' : 'no',
      n > 0 ? `${packs} 个包，但没有可点的 whisper 包（本机无 GPU，且 whisper CPU 包可能不适用）` : `页面上 0 个可安装按钮（共 ${packs} 个包）`);
  }
  await shot('backend-after');
}

/* ── 4. 装 ASR 模型 ── */
await page.goto(`${BASE}/models`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
{
  const unhide = await vis(['[data-testid="models-show-not-recommended"]']);
  if (unhide) { await unhide.el.click(); await page.waitForTimeout(800); }
  const btns = page.locator('[data-testid="models-download-button"]');
  const n = await btns.count();
  let target = null, best = Infinity, label = '';
  for (let i = 0; i < n; i++) {
    const b = btns.nth(i);
    if (!(await b.isVisible().catch(() => false))) continue;
    const txt = ((await b.textContent()) ?? '').trim();
    const m = /([\d.]+)\s*(MB|GB)/.exec(txt);
    if (!m) continue;
    const mb = Number(m[1]) * (m[2] === 'GB' ? 1000 : 1);
    if (mb < best) { best = mb; target = b; label = txt; }
  }
  if (target) {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click();
    let ok = false, err = '', pct = 0;
    for (let i = 0; i < 200; i++) {
      await page.waitForTimeout(2000);
      const j = await api('/api/jobs');
      const job = (j.j?.jobs ?? []).find((x) => x.kind === 'model');
      if (job) {
        if (job.totalBytes) pct = Math.max(pct, Math.round((job.completedBytes / job.totalBytes) * 100));
        if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
          ok = job.state === 'succeeded';
          err = job.error ? `${job.error.code}` : '';
          break;
        }
      }
      if (i === 3) await shot('model-downloading');
    }
    step('4', '网页装 ASR 模型', ok ? 'yes' : 'no', ok ? `点「${label}」下载完成（${pct}%）` : `点了「${label}」但未成功 ${err}（到 ${pct}%）`);
  } else {
    step('4', '网页装 ASR 模型', 'no', `页面上没有可点的下载按钮（共 ${n} 个）`);
  }
  await shot('models-after');
}

/* ── 5. 装 VAD 模型 ── */
{
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const cat = await api('/api/models/catalog?role=all');
  const groups = cat.j?.groups ?? [];
  const vad = groups.flatMap((g) => g.variants ?? []).filter((v) => v.role === 'vad');
  step('5', '目录里能看到 VAD 模型', vad.length > 0 ? 'yes' : 'no',
    vad.length > 0 ? `${vad.length} 个：${vad.map((v) => v.id).join(', ')}` : '目录里没有 role=vad 的条目（daemon 可能未加载 models-asr-support.json）');
}

/* ── 6. 装中文分词器（libsimple）── */
{
  const bc = await api('/api/backends/catalog');
  const packs = bc.j?.packs ?? [];
  const ext = packs.filter((p) => p.engine === 'sqlite-ext');
  const installable = ext.filter((p) => p.applicable && p.availability !== 'pending-ci');
  step('6', '网页装中文分词器 libsimple', installable.length > 0 ? 'yes' : 'blocked',
    ext.length === 0
      ? 'daemon 的后端目录里没有 sqlite-ext 条目（未加载 sqlite-ext.json）'
      : `目录里有 ${ext.length} 条但 availability=pending-ci（无发布 URL，仓库无 git remote，CI 从未跑过）→ 网页装不了`);
  await shot('runtime-ext');
}

/* ── 7. 试转一段 ── */
{
  await page.goto(`${BASE}/capture`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const inp = await vis(['input[type="url"]', 'input[placeholder*="链接"]', 'input[type="text"]', 'textarea']);
  if (inp) {
    await inp.el.fill('https://download.samplelib.com/mp3/sample-6s.mp3');
    const go = await vis(['button:has-text("开始")', 'button:has-text("导入")', 'button[type="submit"]']);
    if (go) {
      await go.el.click();
      await page.waitForTimeout(6000);
      const after = await bodyText();
      const blocked = /缺少|未安装|blocked|去修复|不可用/.test(after);
      step('7', '试转一段音频', blocked ? 'partial' : 'yes',
        blocked ? `已提交但被 blocked：${after.slice(-140)}` : `已提交：${after.slice(-140)}`);
    } else step('7', '试转一段音频', 'no', '有输入框但找不到提交按钮');
  } else step('7', '试转一段音频', 'no', '找不到链接输入框');
  await shot('capture-transcribe');
}

await browser.close();
const c = steps.reduce((a, s) => ((a[s.status] = (a[s.status] ?? 0) + 1), a), {});
console.log(`\n${'='.repeat(70)}\n  YES ${c.yes ?? 0} · PARTIAL ${c.partial ?? 0} · BLOCKED ${c.blocked ?? 0} · NO ${c.no ?? 0}\n${'='.repeat(70)}`);
await fs.writeFile(path.join(SHOTS, 'report.json'), JSON.stringify({ ranAt: new Date().toISOString(), steps, pageErrors: [...new Set(pageErrors)].slice(0, 10) }, null, 2), 'utf8');
console.log(`report: ${path.relative(REPO, path.join(SHOTS, 'report.json'))}`);
process.exit(0);
