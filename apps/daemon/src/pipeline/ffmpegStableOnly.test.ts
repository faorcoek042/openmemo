/**
 * ★★ T-163：**放宽一条既有约束时，写下"为什么这一条可以"比翻一个布尔值重要。**
 *
 * ## 这个文件在守什么
 *
 * `components.json` 里每条 `upstream` 有一个 `stableOnly` 布尔。它读起来像
 * 「只看稳定版」，很保守、很难有人反对。但在 macOS 的 ffmpeg 那一条上，它的**实际效果**
 * 是别的东西：
 *
 * `[实测 2026-08-07]` `api.github.com/repos/jellyfin/jellyfin-ffmpeg/releases?per_page=30`：
 *
 * ```
 * v8.1.2-2  prerelease=true      v7.1.4-3  prerelease=false   ← /releases/latest 返回的是它
 * v8.1.2-1  prerelease=true      v7.1.4-2  prerelease=false
 * v8.1.1-4  prerelease=true      v7.1.4-1  prerelease=false
 * v8.1.1-3  prerelease=true      v7.1.3-6  prerelease=false
 * v8.1.1-2  prerelease=true      …
 * v8.1.1-1  prerelease=true
 * ```
 *
 * **上游把整个 8.x 世代都标成了 prerelease。** 于是 `stableOnly: true` 过滤掉的不是
 * 「不稳定的版本」，而是**一整个大版本** —— 它把这个组件永久钉死在 7.x，
 * 而这件事从字段名上完全看不出来，从 diff 上更看不出来。
 *
 * T-161 注意到了这一点并**刻意没有改**，理由是「升它等于主动放松一条既有约束，要人拍板」。
 * 那个克制是对的。用户 2026-08-07 拍了板 —— 于是这一条被放松了。
 *
 * ## 判据（钉结构，不钉版本号）
 *
 * 这个文件**不**断言"版本必须是 8.1.2-2"（那种守卫下次升级就得改，等于没有）。
 * 它断言的是三条结构性质：
 *
 *   ① 例外必须**写下理由**：`stableOnly === false` 就必须有 `stableOnlyReason`，
 *      而且长到真的是一段解释（不是 "ok" 这种）。
 *   ② 例外必须**同时收窄别的维度**：拿掉 prerelease 过滤之后，`tagPattern` 是唯一
 *      还挡着"别的 tag 家族溜进来"的东西，所以它必须在，且必须真的匹配当前 pin。
 *   ③ 例外**不许扩散**：`github-release` 这一族里，显式 `stableOnly: false` 的条目
 *      必须逐条有理由。谁想再放松一条，就得在同一个位置写下同样的一段话。
 *
 * ## ⚠️ 一条不许被读错的事实（实测，写在这里免得下一个人信错）
 *
 * 本条**不是**全仓唯一不过滤 prerelease 的组件。`stableOnly` 缺省时
 * `upstream.ts:131` 的 `src.stableOnly ? … : true` 同样**不过滤**，而实测有 4 条缺省：
 * `media-tools-{linux,win}-x64`（有 tagPattern 收着）、`sherpa-onnx-node`（kind=npm）、
 * `asr/whisper-large-v3-turbo-q5_0`（kind=huggingface，后两者的 kind 根本不看这个字段）。
 * 另有 `whispercpp-cpu-macos-arm64` 显式 `false`（指向我们自己的仓库）。
 * → 所以 ③ 只对**显式 false 且 kind=github-release** 的条目要求理由：
 *   那是"有人动手放松过"的那一类，缺省的那几条是另一回事，混在一起会让这条守卫
 *   在一堆与它无关的东西上发表意见 —— 而一条会对不相干的东西发表意见的检查，
 *   说对的时候也不该被相信。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

interface UpstreamEntry {
  kind?: string;
  repo?: string;
  tagPattern?: string;
  stableOnly?: boolean;
  stableOnlyReason?: string;
}
interface ComponentEntry {
  id: string;
  pinnedVersion?: string;
  upstream?: UpstreamEntry;
}

async function components(): Promise<ComponentEntry[]> {
  const raw = JSON.parse(await readFile(join(MANIFEST_DIR, 'components.json'), 'utf8')) as
    { components?: ComponentEntry[] } | ComponentEntry[];
  const list = Array.isArray(raw) ? raw : (raw.components ?? []);
  // 空集不是"没问题"，是"什么都没检查"。
  assert.ok(list.length > 0, 'components.json 解析出 0 条 —— 这是"工具返回空集被读成没有"的形状');
  return list;
}

/**
 * T-163 之前就存在、**不在本任务范围**的那一条显式 `stableOnly: false`。
 *
 * 它没有理由这件事在这里被**列出来**，而不是被抹平 —— 抹平（顺手补一段我编的理由）
 * 会把"我不知道当初为什么这么写"伪装成"我知道"。
 *
 * ⚠️ 顺带查到一条**它是有用的**证据（`[实测 2026-08-07]`，匿名 API）：
 *     `api.github.com/repos/faorcoek042/openmemo/releases` 只有两个 release，
 *     `backend-packs-2026.08.06` 与 `model-mirror-2026.08.06`，
 *     **两个都是 `prerelease=true`**。
 *   → 也就是说那一条如果被"顺手统一"成 `stableOnly: true`，它的升级检查会
 *     **一个候选都找不到**，然后表现为 `latestVersion: null` + 一句安静的 checkError。
 *     这条守卫把它钉在这里，正是为了让那次"统一"不会静悄悄发生。
 */
const GRANDFATHERED_WITHOUT_REASON = new Set(['whispercpp-cpu-macos-arm64']);

describe('stableOnly 的例外必须是写下来的，不是翻过来的', () => {
  it('① 显式 stableOnly:false 的 github-release 组件，每一条都要有 stableOnlyReason', async () => {
    const list = await components();
    const relaxed = list.filter(
      (c) => c.upstream?.kind === 'github-release' && c.upstream?.stableOnly === false,
    );
    // 数到 0 条就说明这条守卫在空跑 —— 而它守的正是"有人把它翻成 false"。
    assert.ok(
      relaxed.length > 0,
      'components.json 里一条显式 stableOnly:false 的 github-release 组件都没有 —— ' +
        '这条守卫等于没在检查（ci-prep C5 那一族）',
    );

    const ids = new Set(list.map((c) => c.id));
    for (const id of GRANDFATHERED_WITHOUT_REASON) {
      // 白名单里躺着一个已经不存在的 id = 这条守卫在替一个不存在的东西开后门。
      assert.ok(
        ids.has(id),
        `GRANDFATHERED_WITHOUT_REASON 里的 ${id} 在 components.json 里已经不存在了 —— ` +
          `把它从白名单里删掉，别让白名单变成一张没人看的免死金牌`,
      );
    }

    for (const c of relaxed) {
      if (GRANDFATHERED_WITHOUT_REASON.has(c.id)) continue;
      const reason = c.upstream?.stableOnlyReason ?? '';
      assert.ok(
        reason.length >= 120,
        `${c.id}: upstream.stableOnly 是 false，但没有（或只有一句敷衍的）stableOnlyReason。\n` +
          `  放松一条既有的保守约束时，"为什么这一条可以"必须和那个布尔值写在一起 ——\n` +
          `  否则半年后没有人分得清它是深思熟虑还是顺手改的。\n` +
          `  实得 ${reason.length} 字。\n` +
          `  （要加新的例外就写理由；GRANDFATHERED_WITHOUT_REASON 是 T-163 之前的存量，不是入口。）`,
      );
    }
  });

  it('② macOS 的 ffmpeg：拿掉 prerelease 过滤之后，tagPattern 必须接住', async () => {
    const list = await components();
    const c = list.find((x) => x.id === 'media-tools-macos-arm64');
    assert.ok(c, 'components.json 里没有 media-tools-macos-arm64');
    const u = c.upstream ?? {};

    assert.equal(u.repo, 'jellyfin/jellyfin-ffmpeg');
    assert.equal(
      u.stableOnly,
      false,
      'stableOnly 又变回 true 了 —— 那会把这个组件重新钉死在 7.x（上游的 8.x 全是 prerelease）。' +
        '要退回去是可以的，但请连同 stableOnlyReason 一起改，别只翻布尔值。',
    );
    assert.ok(
      typeof u.tagPattern === 'string' && u.tagPattern.length > 0,
      'stableOnly 放松成 false 之后，tagPattern 是唯一还挡着"别的 tag 家族溜进来"的东西，它不许缺席',
    );

    // 钉的是结构：pin 必须被自己的 tagPattern 匹配。换版本号这条照样成立。
    const pin = c.pinnedVersion ?? '';
    assert.match(
      pin,
      new RegExp(u.tagPattern as string),
      `pinnedVersion ${pin} 不匹配它自己的 tagPattern ${u.tagPattern} —— ` +
        `升级检查器会因此永远找不到"当前版本"，而那表现为"一直有新版本可升"`,
    );
  });

  it('③ backends.json 与 components.json 说的是同一个版本（ffmpeg 那回踩过）', async () => {
    const list = await components();
    const comp = list.find((x) => x.id === 'media-tools-macos-arm64');
    assert.ok(comp);

    const packs = (
      JSON.parse(await readFile(join(MANIFEST_DIR, 'backends.json'), 'utf8')) as {
        packs: { id: string; engineVersion?: string; files?: { name?: string }[] }[];
      }
    ).packs;
    const pack = packs.find((p) => p.id === 'media-tools-macos-arm64');
    assert.ok(pack, 'backends.json 里没有 media-tools-macos-arm64 —— 组件页看得见、点安装拿 409');

    // components.json 用 `v8.1.2-2`（git tag），backends.json 用 `8.1.2-2`（版本号）。
    // 两个命名空间不同是**刻意**的，所以这里比的是"去掉前导 v 之后相等"，不是字符串相等。
    assert.equal(
      (comp.pinnedVersion ?? '').replace(/^v/, ''),
      pack.engineVersion,
      'components.json 的 pinnedVersion 与 backends.json 的 engineVersion 对不上 —— ' +
        '这正是 ytdlpInstall.test.ts 文件头记的那个陷阱：只改了一份清单',
    );

    // 归档文件名里也带着版本号。改了版本号却忘了改文件名 = 404，而 sha256 校验之前就死了。
    const archive = pack.files?.[0]?.name ?? '';
    const version = pack.engineVersion ?? '';
    assert.notEqual(version, '', 'backends.json 里 media-tools-macos-arm64 没有 engineVersion');
    assert.ok(
      archive.includes(version),
      `backends.json 的归档名 ${archive} 里没有版本号 ${version} —— 大概率是漏改了一处`,
    );
  });
});
