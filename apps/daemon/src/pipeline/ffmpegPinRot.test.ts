/**
 * ★★ T-161：**「钉死」不等于「不会消失」。**
 *
 * ## 这个文件存在的理由（一条实测出来的、带日期的缺陷）
 *
 * 我们把 ffmpeg 钉在 `github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-<日期>/...`
 * 上，理由写在 `packages/downloader/src/upstream.ts:94-97`：
 *
 * > BtbN's FFmpeg-Builds publishes both a moving `latest` tag and **immutable**
 * > `autobuild-<date>` tags from the same repo.
 *
 * **那句 "immutable" 是错的。** `[实测]` 上游自己的清理脚本
 * （`util/prunetags.sh`，`raw.githubusercontent.com` 上取的原文）：
 *
 * ```bash
 * KEEP_LATEST=14      # 只保留最近 14 个 autobuild tag
 * KEEP_MONTHLY=24     # 外加每月**最后一个** build，保留 24 个月
 * ...
 * gh release delete --cleanup-tag --yes "${TAG}"
 * ```
 *
 * `[实测]` 拉 `api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=100`：
 * **全仓库只有 37 个 release** —— 22 个月末 tag（2024-09-30 一路到 2026-06-30，
 * 每月恰好一个）+ 最近 14 个日构建。中间的日构建**一个都不剩**。
 * 策略不是写着玩的，它在执行。
 *
 * 后果的形状与本仓最贵的那一类完全一致：
 *
 * > 清单校验通过、sha256 正确、代码一行没改，
 * > 而某一天之后**所有新用户的 ffmpeg 下载变成 HTTP 404** ——
 * > 已经装过的人毫无感觉，所以不会有人报障。
 *
 * ## 判据
 *
 * **只允许钉「每月最后一天」的 autobuild tag**（`KEEP_MONTHLY` 保护它 24 个月）。
 * 钉任何一个非月末的日构建，保质期都只有约 14 天。
 *
 * 判据钉的是**结构**（tag 里的日期是不是它那个月的最后一天），不是关键词 ——
 * 换一个月份、换一个版本号，这条守卫照样成立。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { validateBackendManifest, type BackendPack } from '@openmemo/shared';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

const readJson = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(join(MANIFEST_DIR, name), 'utf8'));

async function backendPacks(): Promise<BackendPack[]> {
  const v = validateBackendManifest(await readJson('backends.json'));
  assert.ok(v.ok, v.ok ? '' : v.errors.slice(0, 5).join('\n'));
  return (v.data as { packs: BackendPack[] }).packs;
}

interface ComponentEntry {
  id: string;
  pinnedVersion?: string;
  upstream?: { kind?: string; repo?: string; tagPattern?: string; stableOnly?: boolean };
}

async function components(): Promise<ComponentEntry[]> {
  const raw = (await readJson('components.json')) as
    { components?: ComponentEntry[] } | ComponentEntry[];
  const list = Array.isArray(raw) ? raw : (raw.components ?? []);
  assert.ok(list.length > 0, 'components.json 解析出 0 条 —— 这是"工具返回空集被读成没有"的形状');
  return list;
}

/** `.../releases/download/<tag>/<file>` 里的 `<tag>`；取不到返回 null。 */
const tagFromUrl = (url: string): string | null =>
  url.split('/releases/download/')[1]?.split('/')[0] ?? null;

/** 该月最后一天（`new Date(y, m, 0)` 里 day=0 = 上个月最后一天）。 */
const lastDayOfMonth = (year: number, month1to12: number): number =>
  new Date(Date.UTC(year, month1to12, 0)).getUTCDate();

/**
 * BtbN autobuild tag 形如 `autobuild-2026-07-31-14-10`。
 * 返回 `{ ok, why }` —— `ok=false` 时 `why` 要能直接读懂，不需要读代码。
 */
export function btbnTagSurvives(tag: string): { ok: boolean; why: string } {
  if (tag === 'latest') {
    return {
      ok: false,
      why: '`latest` 是滚动 tag：上游每天 `gh release delete --cleanup-tag` 之后重建，资产会被原地换掉（体积都不一样）。这正是当年否掉 eugeneware/ffmpeg-static 的同一条理由。',
    };
  }
  const m = /^autobuild-(\d{4})-(\d{2})-(\d{2})-\d{2}-\d{2}$/.exec(tag);
  if (m === null) {
    return {
      ok: false,
      why: `tag "${tag}" 不是 autobuild-YYYY-MM-DD-HH-MM 形态，无法判断它会不会被清理`,
    };
  }
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const last = lastDayOfMonth(year, month);
  if (day !== last) {
    return {
      ok: false,
      why: `tag "${tag}" 不是 ${year}-${String(month).padStart(2, '0')} 的最后一天（应为 ${last} 日）。上游 util/prunetags.sh 只保留「最近 14 个日构建」+「每月最后一个（24 个月）」，所以这个 tag 会在约 14 个日构建之后连同它的资产一起被删除，URL 变 404 —— 而清单校验、sha256、代码全都不会有任何反应。`,
    };
  }
  return { ok: true, why: '' };
}

describe('T-161 ffmpeg 的 pin 会不会烂掉（上游会删 tag，"钉死"≠"不会消失"）', () => {
  it('★ 所有 BtbN 的 pin 必须钉在「每月最后一天」的 autobuild tag 上', async () => {
    const packs = await backendPacks();
    const btbn = packs.flatMap((p) =>
      p.files.flatMap((f) =>
        f.mirrors
          .filter((m) => m.url.includes('/BtbN/FFmpeg-Builds/'))
          .map((m) => ({ id: p.id, url: m.url })),
      ),
    );
    /*
     * ⚠️ 非空守卫**只加在"我要遍历的集合"上，不加在"被检查的量"上**。
     * pack-publish 在 T-146 / T-150 连续两次栽在这上面：给被检查的量也加了阈值，
     * 于是真出问题时先炸的是守卫，而真正该说的那句话一个字都没印出来。
     * 这里守的是"backends.json 里一个 BtbN 链接都没找到"（= 什么都没检查），
     * 而不是"有几个链接是坏的"。
     */
    assert.ok(
      btbn.length >= 2,
      `backends.json 里只找到 ${btbn.length} 个 BtbN 链接 —— 这条守卫等于没在检查`,
    );

    const rotten = btbn
      .map(({ id, url }) => {
        const tag = tagFromUrl(url);
        if (tag === null) return `${id}: URL 里没有 /releases/download/<tag>/ —— ${url}`;
        const v = btbnTagSurvives(tag);
        return v.ok ? null : `${id}: ${v.why}`;
      })
      .filter((x): x is string => x !== null);

    assert.deepEqual(
      rotten,
      [],
      `以下 pin 会在上游被删掉（届时下载变 404，而这里的校验全都会照常通过）：\n  ${rotten.join('\n  ')}`,
    );
  });

  it('★ components.json 的 pinnedVersion 与升级检查器也不许推荐会被删的 tag', async () => {
    const list = await components();
    const btbn = list.filter((c) => c.upstream?.repo === 'BtbN/FFmpeg-Builds');
    assert.ok(
      btbn.length >= 2,
      `components.json 里只有 ${btbn.length} 条 BtbN 组件 —— 守卫等于没在检查`,
    );

    for (const c of btbn) {
      assert.ok(c.pinnedVersion, `${c.id} 没有 pinnedVersion`);
      const v = btbnTagSurvives(c.pinnedVersion);
      assert.ok(v.ok, `${c.id}: ${v.why}`);

      /*
       * `tagPattern` 决定升级检查器会把**哪些** tag 当作"可以升到的目标"。
       * 原来是 `^autobuild-`，也就是任何日构建都算 —— 它不知道保质期，
       * 于是每次"跟进最新"都会给出一个 14 天后失效的 pin。
       * 收紧成"日 ≥ 28"：这是月末的**超集**（regex 表达不了"该月最后一天"），
       * 但它足以把 01–27 那些必被删的排除掉；剩下的由上面那条守卫兜底。
       */
      const pat = c.upstream?.tagPattern ?? '';
      assert.ok(
        pat.includes('2[89]') && pat.includes('3[01]'),
        `${c.id} 的 tagPattern 是 ${JSON.stringify(pat)} —— 它会把任意日构建当成可升级目标，而那些 tag 约 14 天后就会被上游删掉`,
      );
      // 反向：确认这个 pattern 真的会拒掉一个非月末的 tag（不能只看它长得对）
      const re = new RegExp(pat);
      assert.equal(
        re.test('autobuild-2026-08-02-13-17'),
        false,
        `${c.id} 的 tagPattern 仍然接受非月末的 autobuild-2026-08-02-13-17`,
      );
      assert.equal(
        re.test('autobuild-2026-07-31-14-10'),
        true,
        `${c.id} 的 tagPattern 拒掉了合法的月末 tag`,
      );
      assert.equal(re.test('latest'), false, `${c.id} 的 tagPattern 接受了滚动的 latest`);
    }
  });

  it('判据自身的正反用例（守卫写错了也要当场红）', () => {
    // 月末 —— 受 KEEP_MONTHLY 保护
    assert.equal(btbnTagSurvives('autobuild-2026-07-31-14-10').ok, true);
    assert.equal(btbnTagSurvives('autobuild-2026-06-30-13-34').ok, true);
    assert.equal(
      btbnTagSurvives('autobuild-2026-02-28-12-59').ok,
      true,
      '2026 不是闰年，2 月最后一天是 28',
    );
    assert.equal(
      btbnTagSurvives('autobuild-2024-02-29-00-00').ok,
      true,
      '2024 是闰年，2 月有 29 日',
    );
    // 非月末 —— 会被删
    assert.equal(
      btbnTagSurvives('autobuild-2026-08-02-13-17').ok,
      false,
      '这就是 T-161 之前我们钉的那个',
    );
    assert.equal(btbnTagSurvives('autobuild-2026-02-29-00-00').ok, false, '2026 年 2 月没有 29 日');
    assert.equal(btbnTagSurvives('autobuild-2026-07-30-13-32').ok, false, '差一天也不行');
    // 滚动 / 形态不对
    assert.equal(btbnTagSurvives('latest').ok, false);
    assert.equal(btbnTagSurvives('v7.1.5').ok, false);
    // 理由必须说人话（错误消息本身也是产物）
    assert.match(btbnTagSurvives('autobuild-2026-08-02-13-17').why, /最后一天/);
    assert.match(btbnTagSurvives('latest').why, /滚动/);
  });
});
