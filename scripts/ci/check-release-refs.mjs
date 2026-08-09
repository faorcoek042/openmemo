#!/usr/bin/env node
/**
 * 「目录里还有没有地址指向某个 release」+「它们是不是还活着」。
 *
 * ## 为什么需要它（Manager 2026-08-09 裁决「从现在起不删 release」）
 *
 * 预编译包**内嵌** `vendor/manifests`（为的是修「组件页是空的」）。
 * 内嵌的代价是：**包出厂那一刻，它要下载的 URL 就被冻住了。**
 * 于是删掉一个 release，就**永久打死所有还指着它的、已经在用户机器上的包** ——
 * 用户看不到"某个 tag 没了"，他只看到「点安装没反应 / 下载失败」。
 *
 * `[实测 2026-08-09]` 这件事已经真的发生过一次：
 *   · 包 `openmemo-0.4.0`（commit 99995b8，01:00）内嵌清单指向 **v0.3.0**
 *   · `ddccef4`（03:58）把目录重指 v0.4.0；随后 **v0.3.0 被删**
 *   · `curl` 实测：v0.3.0 → **404**、v0.4.0 → 206
 *   · 结果：三平台 whisper.cpp 一族（含 GPU 加速包）全部装不上
 *
 * ## 判据不是"记得别删"
 *
 * 本仓立过一条：**"跑错了也不会造成后果"** 才算修好（PROTOCOL §7 补充）。
 * 一条要人时刻记住的规则，等价于一条迟早会被违反的规则。
 *
 * ⚠️ **但要如实说清这个守卫的边界**：删 release 是**人在本地敲的一条 `gh` 命令**，
 * 仓库里没有任何东西能在服务端拦住它（没有 release 的分支保护，也没有服务端钩子）。
 * 所以这个脚本做的是**另外两件真的做得到的事**：
 *
 *   ① `--tag <tag>`：删之前问一句「还有谁指着它」。有人指着就 **exit 1**，
 *      把"我以为没人用了"变成一个当场的、有名有姓的清单。
 *   ② `--assert-live`：**发包之前**把目录里指向我们自己 release 的地址逐个探一遍，
 *      死了一个就红。这一条不依赖任何人记得什么 —— 就算真有人删了，
 *      **它也会在包发出去之前就红**，而不是等用户装不上。
 *
 * ①是给人的，②是给机器的。**只有②满足"跑错了也不会造成后果"。**
 *
 * 用法：
 *   node scripts/ci/check-release-refs.mjs --assert-live          # 发布前闸门用
 *   node scripts/ci/check-release-refs.mjs --tag v0.3.0           # 删之前问一句
 *   node scripts/ci/check-release-refs.mjs --manifests <dir>      # 指定清单目录（默认仓库的）
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectReleaseRefs } from './e2e-allcomponents-assertions.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const MANIFESTS = arg('--manifests', join(REPO, 'vendor', 'manifests'));
const TAG = arg('--tag', null);
const ASSERT_LIVE = argv.includes('--assert-live');

const say = (s = '') => console.log(s);

if (!existsSync(MANIFESTS)) {
  console.error(`✘ 清单目录不存在：${MANIFESTS}`);
  process.exit(2);
}

/** 读清单目录，收集所有 URL。 */
function readAllUrls(dir) {
  const urls = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    let j;
    try {
      j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    const push = (id, files) => {
      for (const file of files ?? []) {
        for (const m of file.mirrors ?? []) {
          if (m.url) urls.push({ id, file: file.name ?? '?', url: m.url });
        }
      }
    };
    for (const p of j.packs ?? []) push(p.id, p.files);
    for (const m of j.models ?? []) push(m.id, m.files);
  }
  return urls;
}

/** 只探头 1 KB，够回答"它还在不在"。跟随重定向。 */
function probe(url, hops = 5) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve({ ok: false, status: 0, reason: 'URL 不合法' });
      return;
    }
    const req = httpsRequest(
      {
        host: u.host,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { range: 'bytes=0-1023', 'user-agent': 'openmemo-check-release-refs' },
        timeout: 45_000,
      },
      (res) => {
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          hops > 0
        ) {
          res.resume();
          resolve(probe(new URL(res.headers.location, url).href, hops - 1));
          return;
        }
        res.resume();
        resolve({ ok: res.statusCode === 200 || res.statusCode === 206, status: res.statusCode });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, status: 0, reason: e.message }));
    req.end();
  });
}

const all = readAllUrls(MANIFESTS);
const ours = collectReleaseRefs(all);

say(`清单目录：${MANIFESTS}`);
say(`共 ${all.length} 个下载地址，其中指向**我们自己 release** 的 ${ours.length} 个。`);

/* ── ①「删之前问一句」 ── */
if (TAG) {
  const hits = ours.filter((r) => r.tag === TAG);
  say('');
  say(`── 还有谁指着 ${TAG} ──`);
  if (hits.length === 0) {
    say(`   （没有）→ 删除 ${TAG} 不会打死任何还指着它的包。`);
    process.exit(0);
  }
  for (const h of hits) say(`   ${String(h.id).padEnd(34)} ${h.file}`);
  say('');
  say(
    `✘ **${hits.length} 个组件仍然指向 ${TAG}** —— 删掉它会永久打死所有内嵌了这份清单的已发出的包。`,
  );
  say('   （包出厂那一刻 URL 就冻住了：用户不会看到"tag 没了"，只看到"点安装没反应"。）');
  say('   Manager 2026-08-09 裁决：**从现在起不删 release。**');
  process.exit(1);
}

/* ── ②「发包之前，指向我们自己 release 的地址必须都活着」 ── */
if (ASSERT_LIVE) {
  if (ours.length === 0) {
    /*
     * ★ 空集必须出声。`[].every()` 恒真 —— "一个都没死"与"一个都没查"
     *   在输出里长得一模一样，本仓已经在别处栽过不止一次。
     */
    say('');
    say('✘ 前提不成立：清单里**一个**指向我们自己 release 的地址都没有。');
    say('   要么清单读错了，要么全都换成上游了 —— 无论哪种，这一轮都没有验到东西。');
    process.exit(1);
  }
  say('');
  say(`── 逐个探测（${ours.length} 个）──`);
  const dead = [];
  for (const r of ours) {
    const res = await probe(r.url);
    if (!res.ok) dead.push({ ...r, status: res.status, reason: res.reason });
    say(
      `   ${res.ok ? '✔' : '✘'} ${String(r.tag).padEnd(10)} ${String(r.id).padEnd(32)} ${res.ok ? res.status : `**${res.status || res.reason}**`}`,
    );
  }
  say('');
  if (dead.length > 0) {
    const tags = [...new Set(dead.map((d) => d.tag))];
    say(`✘ **${dead.length} 个地址已经死了**，涉及 tag：${tags.join(', ')}`);
    for (const d of dead) say(`     ${d.id} → ${d.url}（${d.status || d.reason}）`);
    say('');
    say('   这意味着：**所有内嵌了这份清单的已发出的包，这些组件永久装不上。**');
    say('   如果这个 tag 是被删掉的 —— 那正是 2026-08-09 那次事故的形状，请把它恢复回来。');
    process.exit(1);
  }
  say(`✔ ${ours.length} 个指向我们自己 release 的地址全部还活着。`);
  process.exit(0);
}

say('');
say('（没给 --tag / --assert-live，只做了统计。）');
for (const t of [...new Set(ours.map((r) => r.tag))]) {
  say(`   ${t}: ${ours.filter((r) => r.tag === t).length} 个组件`);
}
