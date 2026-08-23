/**
 * 「那条被删掉的正则，到底误判了几条」—— **重放它，而不是记住一个数字。**
 *
 * ## 这条腿存在的理由是一次真实的翻车
 *
 * `ProvenanceNote` 上一版用 `/API|digest|upstream/i` 嗅探 `sha256Provenance` 那段
 * 自由散文，去判"这份摘要的证据强不强"。换掉它的那个 PR 在**三个地方**写下了
 * 「**5** 条被判成警告色，全部误判」并盖了 `[实测 2026-08-24]` 的戳。
 *
 * **真值是 8。** 当时那个一次性脚本打印的就是 8，是人在誊进注释时写错了。
 *
 * 方向无害（8 条全是假阳性，"判据不该落在散文上"这个结论一个字都不用改），
 * 但它**长着一副被测量过的样子却偏了 60%**，而且：
 *
 * > **没有任何门禁管得住「我们说了一个我们没量过的数」** —— 只有人去问
 * > 「这个数哪来的」。
 *
 * 所以这里不是再抄一遍 `8`，而是**把算法钉下来**：清单改了这个数自己会变，
 * 变了就红，人回来重新看一眼那几段注释还成不成立。
 *
 * ## ⚠️ 它守的不是产品行为
 *
 * 那条正则**已经从产品里删掉了**，这里重新构造它只是为了**量一个历史事实**。
 * 所以这条腿红的时候，要改的是注释里的数（和这份夹具），不是产品代码。
 * 这一点必须写明，否则下一个人会以为产品又在嗅散文了。
 */

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** 逐字就是被删掉的那条判据（`ComponentCard.tsx` 上一版）。 */
const DELETED_HEURISTIC = /API|digest|upstream/i;

interface ManifestComponent {
  id: string;
  sha256?: string;
  sha256Verification?: string;
  sha256Provenance?: string | null;
  caveats?: readonly string[];
}

/**
 * `cwd` 是 `apps/web`（`pnpm -r test` 逐包跑）—— 与 `lib/remediation/routes.test.ts`
 * 读仓内文件的做法一致。
 */
function components(): ManifestComponent[] {
  const raw = readFileSync('../../vendor/manifests/components.json', 'utf8');
  const list = (JSON.parse(raw) as { components?: ManifestComponent[] }).components ?? [];
  assert.ok(list.length > 0, 'components.json 解析出 0 条 —— 空集不是"没问题"，是"什么都没检查"');
  return list;
}

describe('那条被删掉的 sha256 散文启发式：重放它，量出误判数', () => {
  it('★★ 注释里引用的三个数，与对清单重放的结果一致', () => {
    const all = components();
    const withNote = all.filter((c) => (c.sha256Provenance ?? '') !== '');
    const hits = withNote.filter((c) => DELETED_HEURISTIC.test(c.sha256Provenance!));

    /*
     * 这三个数逐字出现在：
     *   · `apps/web/src/features/components/components/ComponentCard.tsx` 的 ProvenanceNote 注释
     *   · `packages/shared/src/components.ts` 的 `sha256Verification` 注释
     * 改清单导致它们变了 ⇒ 这条红 ⇒ 回去把那两处一并改掉。
     */
    assert.equal(all.length, 27, `清单组件数变了（${all.length}）—— 上面两处注释里的 27 要跟着改`);
    assert.equal(
      withNote.length,
      13,
      `带 sha256Provenance 的条目数变了（${withNote.length}）—— 注释里的 13 要跟着改`,
    );
    assert.equal(
      hits.length,
      8,
      `那条正则今天误判 ${hits.length} 条，而注释里写着 8 —— 两处注释要跟着改。\n` +
        `  命中的是：${hits.map((c) => c.id).join(', ')}`,
    );
  });

  it('★★ 那 8 条**全部**是假阳性（这才是"判据不该落在散文上"的依据）', () => {
    const hits = components()
      .filter((c) => (c.sha256Provenance ?? '') !== '')
      .filter((c) => DELETED_HEURISTIC.test(c.sha256Provenance!));
    assert.ok(hits.length > 0, '一条都没命中 —— 这条腿在对着空集判绿');

    /*
     * 「假阳性」的定义在这里是可判的：那条正则把它判成**弱证据**（upstream-provided），
     * 而清单里那一格机器可读的结论是 `local-recomputed`（**强**证据）。
     * 两者相反 = 误判。不去读散文措辞，避免这条腿自己又变成一个嗅散文的判据。
     */
    const notFalsePositive = hits.filter((c) => c.sha256Verification !== 'local-recomputed');
    assert.deepEqual(
      notFalsePositive.map((c) => `${c.id}=${c.sha256Verification ?? '缺失'}`),
      [],
      '有命中项的枚举结论不是 local-recomputed —— 那它就不是误判，' + '「8 条全部误判」这句话要改',
    );
  });

  /*
   * ★★ 交叉核对：**散文里承认了「未验证」，`caveats` 那一格就必须登记。**
   *
   * 这条腿是 `caveats` 这个设计成立的另一半。产品**不许**读 `sha256Provenance`
   * 去发现"我们没验过"（那正好是本文件开头那次翻车的形状）；判断只走字段。
   * 但那样一来就多了一个新的失败模式：**作者在散文里写了，却忘了登记字段** ——
   * 界面于是一声不吭，而卡片正面还是一个干净的「安装」。
   *
   * 所以让**测试**去读散文：测试量的是「作者登记全了没有」这个**编写期事实**，
   * 不是运行期判断。两边职责分清楚，drift 就有人管。
   */
  it('★★ 散文里承认「未验证」的条目，caveats 里必须登记 e2e-unverified', () => {
    const all = components();
    const admits = all.filter((c) => /⚠️\s*\*{0,2}未验证/.test(c.sha256Provenance ?? ''));
    assert.ok(
      admits.length > 0,
      '没有任何条目在散文里承认未验证 —— 这条腿在对着空集判绿（清单变了就重想它）',
    );

    const unregistered = admits
      .filter((c) => !(c.caveats ?? []).includes('e2e-unverified'))
      .map((c) => c.id);
    assert.deepEqual(
      unregistered,
      [],
      `这些条目在 sha256Provenance 里写着「⚠️ 未验证」，但 caveats 没登记：\n` +
        `  ${unregistered.join(', ')}\n` +
        `  后果：那句承认只活在折叠区里，卡片正面还是一个干净的「安装」——` +
        `「我们不知道」被收回成了沉默。`,
    );

    // 反方向也钉：登记了却在散文里找不到依据 ⇒ 要么散文被删了，要么登记错了
    const groundless = all
      .filter((c) => (c.caveats ?? []).includes('e2e-unverified'))
      .filter((c) => !/⚠️\s*\*{0,2}未验证/.test(c.sha256Provenance ?? ''))
      .map((c) => c.id);
    assert.deepEqual(
      groundless,
      [],
      `这些条目登记了 e2e-unverified，但散文里已经找不到那句承认了：${groundless.join(', ')}\n` +
        `  要么是端到端真的验过了（那就把登记删掉），要么是依据被误删了。`,
    );
  });

  it('★ 反向自检：确实存在**没被**误判的条目，否则上面两条测的是"全集"', () => {
    const withNote = components().filter((c) => (c.sha256Provenance ?? '') !== '');
    const missed = withNote.filter((c) => !DELETED_HEURISTIC.test(c.sha256Provenance!));
    assert.ok(
      missed.length > 0,
      '13 条带散文的条目全部命中了那条正则 —— 那"误判 8 条"就不是一个有信息量的数，' +
        '这条腿的形状要重想',
    );
  });
});
