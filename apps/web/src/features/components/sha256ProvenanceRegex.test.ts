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
 *
 * ## 🔴 那条界线：**测试可以读散文，产品不许从散文里推导语义**
 *
 * 本文件（还有下面那条 `caveats` 交叉核对腿）都在**正则匹配 `sha256Provenance`
 * 那段中文散文**。这看起来正是本文件开头刚骂过的那件事，所以界线必须写在这里 ——
 * 否则下一个人会把它读成"我们默许嗅散文"，然后抄回产品里去。
 *
 * **病灶从来不是「读散文」，是「产品从散文里推导语义」。** 区别在失败模式，
 * 而且这个区别是不对称的：
 *
 * | 谁在读 | 读错了会怎样 | 谁会发现 |
 * |---|---|---|
 * | **产品**（旧的 `ProvenanceNote`） | 界面上一个**安静的假色** | **没有人**。它绿着、不报错、没人点开对账 |
 * | **测试**（这里） | **构建变红** | 下一个提交的人，当场 |
 *
 * > **假红看得见，假绿看不见。** 这个仓已经为这条付过好几次学费了。
 *
 * 所以判据不是"允不允许出现正则"，是**读错的那一刻，代价落在谁头上**：
 * 落在用户屏幕上 ⇒ 不许；落在 CI 上 ⇒ 那正是 CI 的用途。
 *
 * ### 为什么**不**换成对那 4 个 id 的显式清单（认真考虑过，更坏）
 *
 * 「别用正则，直接列出那四条 id」听上去更稳，其实坏在最不容易察觉的方向：
 * **那份清单当天是对的，以后会安静地过期。** 第五条组件在散文里写下
 * `⚠️ 未验证` 而忘了登记 `caveats` 时，显式清单**不会红，它会继续绿着** ——
 * 而这条腿存在的全部理由就是抓那一刻。
 *
 * 那是形态⑥（陈旧的结论过期成假话）最恶劣的版本，因为它长着一副
 * **"我们显式列举过"** 的样子。本文件开头记的 F1 正是同一个形态咬了两次
 * （一个数被复制到四处、订正时只想起两处；`ComponentCard` 那句「8 条组件」
 * 如今是 27）。**不要在治它的同一份文件里再造一个。**
 *
 * 正则在这里是**动态判据**：散文里多一条承认，它自己就多数出一条，
 * 不需要谁记得回来更新名单。
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
   *
   * ⚠️ 这一段为什么允许出现正则匹配中文散文 —— 界线写在**本文件抬头**
   * 「那条界线：测试可以读散文，产品不许从散文里推导语义」那一节。
   * **落在用户屏幕上的假绿不许，落在 CI 上的假红正是 CI 的用途。**
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
