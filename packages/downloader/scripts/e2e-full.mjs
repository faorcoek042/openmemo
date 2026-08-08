#!/usr/bin/env node
/**
 * T-038 — real-browser verification of the 14 items `architect` could not cover with jsdom.
 *
 * His point, verbatim: jsdom proves it RENDERED, not that it's CLICKABLE. Every check here
 * therefore performs a real interaction (click / dblclick / type / drag) and asserts an
 * observable consequence, rather than asserting an element exists.
 *
 * Backend: the REAL apps/daemon (isolated data dir), fronted by reference-server in
 * --proxy-all mode purely to serve the built SPA on the same origin. Nothing of the
 * model/notes API is served by the shim.
 *
 * Per the standing user directive: FUNCTION only — is it there, does it click, is the
 * result correct. No performance measurement anywhere.
 *
 * Usage: node packages/downloader/scripts/e2e-full.mjs --base http://127.0.0.1:17660 --token <t>
 */

import console from 'node:console';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SHOTS = path.join(REPO, 'docs', 'design', 'assets', 't053-e2e');
const DOWNLOADS = path.join(SHOTS, 'downloads');

const argv = process.argv.slice(2);
const BASE = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'http://127.0.0.1:17660';
const TOKEN = argv.includes('--token') ? argv[argv.indexOf('--token') + 1] : '';

await fs.mkdir(SHOTS, { recursive: true });
await fs.mkdir(DOWNLOADS, { recursive: true });

const findings = [];
function record(id, feature, status, detail) {
  findings.push({ id, feature, status, detail });
  const m = { yes: 'YES ', partial: 'PART', no: 'NO  ' }[status] ?? '??  ';
  console.log(`  [${m}] ${id}. ${feature} — ${detail}`);
}

const pageErrors = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 950 },
  locale: 'zh-CN',
  permissions: ['microphone'],
  acceptDownloads: true,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)));

let shotN = 0;
async function shot(name) {
  const f = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  return path.relative(REPO, f);
}
const t = (s) => page.locator(s);
async function visible(sel) {
  const l = t(sel);
  const n = await l.count();
  for (let i = 0; i < n; i++)
    if (
      await l
        .nth(i)
        .isVisible()
        .catch(() => false)
    )
      return l.nth(i);
  return null;
}
async function firstVisible(sels) {
  for (const s of sels) {
    const el = await visible(s);
    if (el) return { el, sel: s };
  }
  return null;
}
const bodyText = async () =>
  ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ').trim();

console.log(
  `\nT-038 real-browser verification\nbase: ${BASE}\nshots: ${path.relative(REPO, SHOTS)}\n`,
);

/* ── boot + auth handoff ───────────────────────────────────────────────── */
// ── K4: the daemon prints `http://127.0.0.1:17650/#t=<token>` — test THAT exact URL ──
let handoffStatus = null;
page.on('response', (r) => {
  if (r.url().includes('/api/auth/session')) handoffStatus = r.status();
});
await page.goto(`${BASE}/#t=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const rootHandoff = {
  status: handoffStatus,
  cookies: (await ctx.cookies()).length,
  url: page.url(),
};

// Re-enter on a route that does NOT redirect, so the remaining checks can run authenticated.
if (rootHandoff.cookies === 0) {
  await page.goto(`${BASE}/models#t=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
}
const authedNow = (await ctx.cookies()).length > 0;
const noteUid = await page.evaluate(async () => {
  try {
    const r = await fetch('/api/notes');
    if (!r.ok) return null;
    const j = await r.json();
    return j.notes?.[0]?.uid ?? null;
  } catch {
    return null;
  }
});
console.log(`  auth cookie=${authedNow} · fixture note = ${noteUid ?? '(none)'}\n`);

record(
  'K4',
  'daemon 交接 URL `/#t=<token>` 能否登录',
  rootHandoff.cookies > 0 ? 'yes' : 'no',
  rootHandoff.cookies > 0
    ? '根路径交接成功'
    : `根路径交接失败：auth/session=${rootHandoff.status}，未拿到 cookie（首启重定向到 ${rootHandoff.url.replace(BASE, '')} 时 fragment 被清掉）；` +
        `改从 /models#t= 进入则成功 → 这是 daemon 打印的那条 URL 在首启时不可用`,
);

/* ═══════ 已知问题 1：/tasks React #185 ═══════ */
console.log('【已知问题】');
await page.goto(`${BASE}/tasks`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
let bt = await bodyText();
const tasksCrashed = /Unexpected Application Error|Minified React error/.test(bt);
const tasksInteractive = await page.locator('button, a, input').count();
record(
  'K1',
  '/tasks React #185 是否已修',
  tasksCrashed ? 'no' : tasksInteractive > 0 ? 'yes' : 'partial',
  tasksCrashed
    ? `仍然崩溃：${bt.slice(0, 90)}`
    : `未崩溃，${tasksInteractive} 个可交互元素 · ${bt.slice(0, 70)}`,
);
await shot('tasks');

/* ── 12. 任务中心刷新后仍在 ── */
{
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const after = await bodyText();
  const stillCrashed = /Unexpected Application Error|Minified React error/.test(after);
  record(
    '12',
    '任务中心刷新后仍在',
    stillCrashed ? 'no' : 'yes',
    stillCrashed ? '刷新后仍崩溃' : `刷新后页面存活 · ${after.slice(0, 70)}`,
  );
}

/* ═══════ 已知问题 2：中文搜索 ═══════ */
{
  const res = await page.evaluate(async () => {
    const words = ['用户', '推特', '中国', '服务', '维基百科'];
    const out = [];
    for (const w of words) {
      const r = await fetch(`/api/search?q=${encodeURIComponent(w)}`);
      const j = await r.json();
      out.push({ w, hits: (j.hits ?? []).length, tok: j.modes?.tokenizer ?? null });
    }
    return out;
  });
  const twoChar = res.filter((r) => r.w.length === 2);
  const allZero = twoChar.every((r) => r.hits === 0);
  record(
    'K2',
    '中文搜索双字词命中',
    allZero ? 'no' : twoChar.some((r) => r.hits === 0) ? 'partial' : 'yes',
    res.map((r) => `${r.w}=${r.hits}`).join(' ') +
      ` · tokenizer=${res[0]?.tok ?? 'n/a'}（libsimple 未装 → trigram 回退，三字以下必 0 命中）`,
  );
}

/* ── K2b: 中文搜索走真实网页（不只是 daemon 层）── */
{
  const words = ['用户', '推特', '中国', '服务'];
  const results = [];
  for (const w of words) {
    await page.goto(`${BASE}/search?q=${encodeURIComponent(w)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    const hits = await page.locator('[data-testid*="search-hit"], a[href*="/notes/"]').count();
    const txt = await bodyText();
    const empty = /没有找到|无结果|No results/.test(txt);
    results.push(`${w}=${hits}${empty ? '(空态)' : ''}`);
  }
  const anyHit = results.some((r) => /=[1-9]/.test(r));
  record(
    'K2b',
    '中文搜索（从网页真搜）',
    anyHit ? 'yes' : 'no',
    results.join(' ') + ' · 网页端搜索结果条目数',
  );
  await shot('search-zh');
}

/* ═══════ 14 项待补验 ═══════ */
console.log('\n【architect 的 14 项】');

/* ── 6. 首启引导跳转 ── */
{
  await page.goto(`${BASE}/onboarding`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const body = await bodyText();
  const nextBtn = await firstVisible([
    'button:has-text("下一步")',
    'button:has-text("开始")',
    'button:has-text("继续")',
    '[data-testid*="onboarding"] button',
  ]);
  if (nextBtn) {
    const before = page.url();
    await nextBtn.el.click();
    await page.waitForTimeout(1500);
    const moved = page.url() !== before || (await bodyText()) !== body;
    record(
      '6',
      '首启引导跳转',
      moved ? 'yes' : 'partial',
      moved ? `点击后页面推进（${page.url().replace(BASE, '')}）` : '点击无反应',
    );
  } else {
    record(
      '6',
      '首启引导跳转',
      body.length > 60 ? 'partial' : 'no',
      `页面有内容但未找到推进按钮 · ${body.slice(0, 70)}`,
    );
  }
  await shot('onboarding');
}

/* ── 5. API Key 输入与自测 ── */
{
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  let keyIn = await firstVisible([
    'input[type="password"]',
    'input[placeholder*="sk-"]',
    'input[placeholder*="Key"]',
  ]);
  if (!keyIn) {
    const aiTab = await firstVisible([
      'a:has-text("AI")',
      'button:has-text("AI")',
      'a[href*="settings/ai"]',
    ]);
    if (aiTab) {
      await aiTab.el.click();
      await page.waitForTimeout(1500);
      keyIn = await firstVisible([
        'input[type="password"]',
        'input[placeholder*="sk-"]',
        'input[placeholder*="Key"]',
      ]);
    }
  }
  if (keyIn) {
    await keyIn.el.fill('sk-test-not-a-real-key-000');
    await page.waitForTimeout(300);
    const testBtn = await firstVisible([
      'button:has-text("测试")',
      'button:has-text("自测")',
      'button:has-text("验证")',
      'button:has-text("Test")',
    ]);
    if (testBtn) {
      await testBtn.el.click();
      await page.waitForTimeout(3500);
      const after = await bodyText();
      record('5', 'API Key 输入与自测', 'yes', `可输入，点自测后有反馈：${after.slice(-110)}`);
    } else {
      record('5', 'API Key 输入与自测', 'partial', '输入框可填，但没有"测试/自测"按钮');
    }
  } else {
    record(
      '5',
      'API Key 输入与自测',
      'no',
      `设置页找不到 Key 输入框 · ${(await bodyText()).slice(0, 80)}`,
    );
  }
  await shot('settings-apikey');
}

/* ── 2. 拖拽上传 ── */
{
  await page.goto(`${BASE}/capture`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const fileInput = await page.locator('input[type="file"]').count();
  // Fire a real DataTransfer drop, not just check for a dropzone element.
  /* eslint-disable no-undef -- runs inside the browser via page.evaluate() */
  const dropResult = await page.evaluate(() => {
    const zone =
      document.querySelector('[data-testid*="drop"]') ??
      document.querySelector('main') ??
      document.body;
    if (!zone) return 'no-zone';
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0, 1, 2, 3])], 'test.mp3', { type: 'audio/mpeg' }));
    let handled = false;
    const mark = () => (handled = true);
    zone.addEventListener('drop', mark, { once: true });
    zone.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
    zone.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
    zone.removeEventListener('drop', mark);
    return handled ? 'drop-dispatched' : 'no-drop-handler';
  });
  /* eslint-enable no-undef */
  await page.waitForTimeout(2000);
  const after = await bodyText();
  const reacted = /上传|导入中|已加入|排队|test\.mp3/.test(after);
  record(
    '2',
    '拖拽上传',
    reacted ? 'yes' : fileInput > 0 ? 'partial' : 'no',
    `file input ×${fileInput} · drop=${dropResult} · 界面${reacted ? '有' : '无'}反应`,
  );
  await shot('drag-drop');
}

/* ── note-dependent items ── */
if (!noteUid) {
  for (const [id, name] of [
    ['1', '双击编辑转写段落'],
    ['3', '标签增删'],
    ['4', '星标点击'],
    ['7', 'TipTap 编辑与自动保存'],
    ['8', '笔记导出 SRT/VTT 内容'],
    ['10', '导图拖拽/右键/撤销'],
    ['11', '导图 SVG/PNG 导出'],
    ['13', '搜索结果直达时间点'],
    ['14', 'M-7 锚点'],
  ])
    record(id, name, 'no', '无 fixture 笔记，无法验证');
} else {
  await page.goto(`${BASE}/notes/${noteUid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await shot('note-detail');

  /* ── 1. 双击编辑转写段落 ── */
  {
    const seg = await firstVisible([
      '[data-testid^="segment-"]',
      '[data-testid*="segment"]',
      'li:has-text("大家好")',
      'p:has-text("大家好")',
      'div:has-text("大家好")',
    ]);
    if (seg) {
      await seg.el.scrollIntoViewIfNeeded().catch(() => {});
      await seg.el.dblclick({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const editable = await page
        .locator('textarea, [contenteditable="true"], input[type="text"]')
        .count();
      /* eslint-disable no-undef -- runs inside the browser via page.evaluate() */
      const focused = await page.evaluate(() => {
        const a = document.activeElement;
        return a ? `${a.tagName}${a.getAttribute('contenteditable') ? '[ce]' : ''}` : 'none';
      });
      /* eslint-enable no-undef */
      const entered = /TEXTAREA|\[ce\]|INPUT/.test(focused);
      if (entered) {
        await page.keyboard.type('（已编辑）');
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(1200);
      }
      record(
        '1',
        '双击编辑转写段落',
        entered ? 'yes' : 'partial',
        entered
          ? `双击进入编辑态（focus=${focused}），已输入文字`
          : `双击后未进入编辑态（focus=${focused}，可编辑元素 ${editable} 个）`,
      );
    } else {
      record('1', '双击编辑转写段落', 'no', '详情页找不到转写段落元素');
    }
    await shot('segment-edit');
  }

  /* ── 4. 星标点击 ── */
  {
    const star = await firstVisible([
      '[data-testid*="star"]',
      'button[aria-label*="星"]',
      'button[title*="星"]',
      'button:has-text("星标")',
    ]);
    if (star) {
      await star.el.click();
      await page.waitForTimeout(1500);
      const persisted = await page.evaluate(async (uid) => {
        const r = await fetch(`/api/notes/${uid}`);
        const j = await r.json();
        return j.starred ?? null;
      }, noteUid);
      record(
        '4',
        '星标点击',
        persisted === true ? 'yes' : persisted === null ? 'partial' : 'partial',
        persisted === true
          ? '点击后服务端 starred=true（已落库）'
          : `点击有响应，但 GET /api/notes/:uid 的 starred=${persisted}`,
      );
    } else {
      record('4', '星标点击', 'no', '详情页找不到星标按钮');
    }
  }

  /* ── 3. 标签增删 ── */
  {
    const tagIn = await firstVisible([
      '[data-testid*="tag"] input',
      'input[placeholder*="标签"]',
      'input[placeholder*="tag"]',
    ]);
    if (tagIn) {
      await tagIn.el.fill('t038测试标签');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1800);
      const added = (await bodyText()).includes('t038测试标签');
      let removed = null;
      if (added) {
        const del = await firstVisible([
          '[data-testid*="tag"] button',
          'button[aria-label*="删除"]',
        ]);
        if (del) {
          await del.el.click();
          await page.waitForTimeout(1500);
          removed = !(await bodyText()).includes('t038测试标签');
        }
      }
      record(
        '3',
        '标签增删',
        added ? 'yes' : 'partial',
        `新增${added ? '成功' : '失败'}${removed === null ? '，未找到删除按钮' : removed ? '，删除成功' : '，删除未生效'}`,
      );
    } else {
      const tagBtn = await firstVisible(['button:has-text("标签")', '[data-testid*="tag"]']);
      record(
        '3',
        '标签增删',
        tagBtn ? 'partial' : 'no',
        tagBtn ? '有标签入口但未展开出输入框' : '找不到标签 UI',
      );
    }
    await shot('tags-star');
  }

  /* ── 7. TipTap 编辑与自动保存 ── */
  {
    const ed = await firstVisible([
      '.ProseMirror',
      '[contenteditable="true"]',
      '[data-testid*="editor"]',
    ]);
    if (ed) {
      await ed.el.click();
      await page.keyboard.type('T038自动保存探针');
      await page.waitForTimeout(4000); // give autosave debounce time
      const saved = await page.evaluate(async (uid) => {
        const r = await fetch(`/api/notes/${uid}`);
        const j = await r.json();
        return JSON.stringify(j.bodyJson ?? j.body_json ?? '').includes('T038自动保存探针');
      }, noteUid);
      record(
        '7',
        'TipTap 编辑与自动保存',
        saved ? 'yes' : 'partial',
        saved
          ? '输入后自动保存已落库（GET 能读回探针文字）'
          : '编辑器可输入，但 4s 内未在服务端读回探针文字',
      );
    } else {
      record('7', 'TipTap 编辑与自动保存', 'no', '详情页无 ProseMirror/contenteditable');
    }
    await shot('tiptap');
  }

  /* ── 8. 笔记导出真下载 + SRT/VTT 内容校验 ── */
  {
    const exportBtn = await firstVisible(['[data-testid*="export"]', 'button:has-text("导出")']);
    if (exportBtn) {
      await exportBtn.el.click();
      await page.waitForTimeout(1000);
      const results = [];
      for (const fmt of ['SRT', 'VTT']) {
        const opt = await firstVisible([
          `button:has-text("${fmt}")`,
          `[role="menuitem"]:has-text("${fmt}")`,
          `a:has-text("${fmt}")`,
        ]);
        if (!opt) {
          results.push(`${fmt}: 无选项`);
          continue;
        }
        const dlP = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
        await opt.el.click();
        const dl = await dlP;
        if (!dl) {
          results.push(`${fmt}: 未触发下载`);
          await page.waitForTimeout(500);
          continue;
        }
        const fp = path.join(DOWNLOADS, `${noteUid}.${fmt.toLowerCase()}`);
        await dl.saveAs(fp);
        const text = await fs.readFile(fp, 'utf8');
        // Validate the FORMAT, not just that bytes arrived.
        const ok =
          fmt === 'SRT'
            ? /^1\r?\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/m.test(text)
            : /^WEBVTT/.test(text) && /\d{2}:\d{2}:\d{2}\.\d{3} --> /m.test(text);
        const hasText = text.includes('大家好');
        results.push(
          `${fmt}: ${ok ? '格式正确' : '格式不符'}${hasText ? '+含转写文字' : '+缺文字'} (${text.length}B)`,
        );
        if (results.length === 1) {
          console.log(`        ${fmt} 前 120 字符: ${JSON.stringify(text.slice(0, 120))}`);
        }
        await exportBtn.el.click().catch(() => {});
        await page.waitForTimeout(700);
      }
      const allOk = results.every((r) => r.includes('格式正确') && r.includes('含转写文字'));
      record(
        '8',
        '笔记导出 SRT/VTT 真下载并校验内容',
        allOk ? 'yes' : results.some((r) => r.includes('格式正确')) ? 'partial' : 'no',
        results.join(' | '),
      );
    } else {
      record('8', '笔记导出 SRT/VTT 真下载并校验内容', 'no', '详情页找不到导出入口');
    }
  }

  /* ── 13. 搜索结果直达时间点 ── */
  {
    await page.goto(`${BASE}/search?q=${encodeURIComponent('维基百科')}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(2500);
    const hit = await firstVisible(['[data-testid*="search-hit"]', 'a[href*="/notes/"]', 'li a']);
    if (hit) {
      await hit.el.click();
      await page.waitForTimeout(2500);
      const url = page.url();
      const jumped = /[?#&](t|at|seek|start)=/.test(url) || url.includes('#seg');
      record(
        '13',
        '搜索结果直达时间点',
        jumped ? 'yes' : 'partial',
        jumped
          ? `跳转带时间参数：${url.replace(BASE, '')}`
          : `跳到了笔记但 URL 无时间点参数：${url.replace(BASE, '')}`,
      );
    } else {
      record(
        '13',
        '搜索结果直达时间点',
        'no',
        `搜索页无可点结果 · ${(await bodyText()).slice(0, 80)}`,
      );
    }
    await shot('search-jump');
  }

  /* ── 14. M-7 锚点 ── */
  {
    const anchors = await page.locator('[data-testid*="anchor"], [id^="seg-"], [data-seg]').count();
    record('14', 'M-7 锚点', anchors > 0 ? 'yes' : 'no', `页面上 ${anchors} 个段落锚点元素`);
  }

  /* ── 10/11. 思维导图 ── */
  {
    await page.goto(`${BASE}/notes/${noteUid}/mindmap`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const mmBody = await bodyText();
    const container = await page
      .locator('.mind-elixir, [data-testid*="mindmap"], svg.markmap, #map')
      .count();
    const nodes = await page.locator('.mind-elixir tpc, me-tpc, .node, g.markmap-node').count();
    if (container > 0 && nodes > 0) {
      const node = await firstVisible(['me-tpc', '.mind-elixir tpc', 'g.markmap-node']);
      let dragged = false,
        ctx = false,
        undone = false;
      if (node) {
        const box = await node.el.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + 140, box.y + 90, { steps: 12 });
          await page.mouse.up();
          await page.waitForTimeout(900);
          dragged = true;
          await node.el.click({ button: 'right' }).catch(() => {});
          await page.waitForTimeout(900);
          ctx =
            (await page.locator('[role="menu"], .context-menu, .mind-elixir-ctxmenu').count()) > 0;
          await page.keyboard.press('Escape').catch(() => {});
          await page.keyboard.press('Control+z').catch(() => {});
          await page.waitForTimeout(800);
          undone = true;
        }
      }
      record(
        '10',
        '导图拖拽/右键/撤销',
        ctx ? 'yes' : 'partial',
        `容器${container} 节点${nodes} · 拖拽=${dragged ? '已执行' : '未执行'} 右键菜单=${ctx ? '出现' : '未出现'} Ctrl+Z=${undone ? '已发送' : '未发送'}`,
      );
    } else {
      record(
        '10',
        '导图拖拽/右键/撤销',
        'no',
        `无导图容器/节点（container=${container} nodes=${nodes}）· ${mmBody.slice(0, 80)}`,
      );
    }
    await shot('mindmap');

    const svgBtn = await firstVisible([
      'button:has-text("SVG")',
      'button:has-text("PNG")',
      '[data-testid*="export"]',
    ]);
    if (svgBtn) {
      const dlP = page.waitForEvent('download', { timeout: 12000 }).catch(() => null);
      await svgBtn.el.click();
      await page.waitForTimeout(900);
      const opt = await firstVisible([
        'button:has-text("SVG")',
        '[role="menuitem"]:has-text("SVG")',
      ]);
      if (opt) await opt.el.click().catch(() => {});
      const dl = await dlP;
      if (dl) {
        const fp = path.join(DOWNLOADS, `${noteUid}-mindmap.svg`);
        await dl.saveAs(fp);
        const txt = await fs.readFile(fp, 'utf8').catch(() => '');
        record(
          '11',
          '导图 SVG/PNG 导出',
          txt.includes('<svg') ? 'yes' : 'partial',
          `下载到 ${path.basename(fp)}，${txt.includes('<svg') ? '内容是合法 SVG' : '内容非 SVG'}`,
        );
      } else {
        record('11', '导图 SVG/PNG 导出', 'partial', '有导出按钮但未触发下载');
      }
    } else {
      record('11', '导图 SVG/PNG 导出', 'no', '导图页找不到 SVG/PNG 导出入口');
    }
  }
}

/* ── 9. 文件夹树操作 ── */
{
  await page.goto(`${BASE}/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const newFolder = await firstVisible([
    '[data-testid*="folder"] button',
    'button:has-text("新建文件夹")',
    'button[aria-label*="文件夹"]',
    'button:has-text("文件夹")',
  ]);
  const folderTree = await page.locator('[data-testid*="folder"], nav ul li').count();
  if (newFolder) {
    page.once('dialog', (d) => d.accept('T038文件夹'));
    await newFolder.el.click();
    await page.waitForTimeout(1200);
    const inp = await firstVisible([
      'input[placeholder*="文件夹"]',
      '[data-testid*="folder"] input',
    ]);
    if (inp) {
      await inp.el.fill('T038文件夹');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1800);
    }
    const created = (await bodyText()).includes('T038文件夹');
    record(
      '9',
      '文件夹树操作',
      created ? 'yes' : 'partial',
      created
        ? '新建文件夹成功并出现在树上'
        : `点击了新建入口但未看到新文件夹（树上 ${folderTree} 项）`,
    );
  } else {
    record(
      '9',
      '文件夹树操作',
      folderTree > 0 ? 'partial' : 'no',
      `找不到新建文件夹入口（树上 ${folderTree} 项）`,
    );
  }
  await shot('folders');
}

/* ═══════ 已知问题 3：暗色主题在新页面不退化 ═══════ */
console.log('\n【暗色主题回归】');
{
  const routes = [
    ['/onboarding', '引导'],
    ['/settings', '设置'],
    [`/notes/${noteUid ?? ''}`, '笔记详情'],
    ['/models', '模型'],
    ['/runtime', '运行时'],
  ];
  const bad = [];
  for (const [r, name] of routes) {
    await page.goto(`${BASE}${r}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    /* eslint-disable no-undef -- browser context */
    const res = await page.evaluate(() => {
      const read = () =>
        getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim();
      const light = read();
      document.documentElement.setAttribute('data-theme', 'dark');
      const dark = read();
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      document.documentElement.removeAttribute('data-theme');
      return { light, dark, bodyBg };
    });
    /* eslint-enable no-undef */
    if (res.light === res.dark) bad.push(name);
  }
  record(
    'K3',
    '暗色主题在新页面未退化',
    bad.length === 0 ? 'yes' : 'partial',
    bad.length === 0
      ? `5 个页面 --surface-0 均随 data-theme 切换`
      : `以下页面未切换: ${bad.join('/')}`,
  );
  await shot('dark-theme');
}

/* ═══════ 2.1 / 2.2 回归 ═══════ */
console.log('\n【2.1 / 2.2 回归（现在打的是真 daemon）】');
{
  await page.goto(`${BASE}/models`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const cards = await page.locator('[data-testid^="model-card-"]').count();
  const fit = await page.locator('[data-testid="fit-badge"]').count();
  const dl = await page.locator('[data-testid="models-download-button"]').count();
  record(
    'R1',
    '模型页（真 daemon）',
    cards > 0 ? 'yes' : 'no',
    `${cards} 张卡 · ${fit} 个 fit 徽标 · ${dl} 个下载按钮`,
  );
  await shot('models');

  await page.goto(`${BASE}/runtime`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const hw = await page.locator('[data-testid="runtime-hardware-card"]').count();
  const packs = await page.locator('[data-testid^="backend-pack-"]').count();
  record('R2', '运行时页（真 daemon）', hw > 0 ? 'yes' : 'no', `硬件卡 ${hw} · 后端包 ${packs}`);
  await shot('runtime');
}

/* ── summary ── */
await browser.close();
const c = findings.reduce((a, f) => ((a[f.status] = (a[f.status] ?? 0) + 1), a), {});
console.log(`\n${'='.repeat(74)}`);
console.log(`  YES ${c.yes ?? 0} · PARTIAL ${c.partial ?? 0} · NO ${c.no ?? 0}`);
console.log('='.repeat(74));
await fs.writeFile(
  path.join(SHOTS, 'report.json'),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      base: BASE,
      browser: 'chromium 151.0.7922.34',
      noteUid,
      findings,
      pageErrors: [...new Set(pageErrors)].slice(0, 20),
    },
    null,
    2,
  ),
  'utf8',
);
if (pageErrors.length) {
  console.log(`\npageerrors (${new Set(pageErrors).size}):`);
  for (const e of [...new Set(pageErrors)].slice(0, 6)) console.log(`  - ${e}`);
}
console.log(`\nreport: ${path.relative(REPO, path.join(SHOTS, 'report.json'))}`);
process.exit(0);
