import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { activeNavTarget, NAV_FILTER_KEYS } from './activeNav';

/** 侧栏当前的全部条目（与 `App.tsx` 的 collectionNav + systemNav 同序无关）。 */
const SIDEBAR = [
  '/notes',
  '/notes?starred=1',
  '/record',
  '/runtime',
  '/models',
  '/tasks',
  '/settings',
];

/** 与 `App.tsx` 的调用形态一致 —— 少传 filterKeys 就测的是另一条路。 */
const at = (pathname: string, search = '') =>
  activeNavTarget(SIDEBAR, { pathname, search }, NAV_FILTER_KEYS);

describe('T-138b 侧栏高亮：哪一项该亮', () => {
  test('★ 详情页只亮「全部笔记」—— 它是 /notes 的子路径，不属于「星标」这个筛选视图', () => {
    /*
     * 这是被报上来的那条：`/notes/<uid>` 上「全部笔记」与「星标」**同时亮**。
     * 成因是上一版判据 `pathname === linkPath` 在子路径上不成立 → 交回 NavLink 的前缀匹配，
     * 而两个链接的 pathname 都是 /notes。
     */
    assert.equal(at('/notes/01KZ1H8YABCDEFGHJKMNPQRST'), '/notes');
    assert.equal(at('/notes/01KZ1H8YABCDEFGHJKMNPQRST', '?tab=mindmap'), '/notes');
    assert.equal(
      at('/notes/01KZ1H8YABCDEFGHJKMNPQRST/mindmap'),
      '/notes',
      '导图全屏页更深一层，仍然归「全部笔记」管',
    );
  });

  test('★ 页内视图状态（?tab=）不许把区域的灯弄灭', () => {
    /*
     * 反方向的同一个 bug：上一版在 pathname 相同时**精确**比查询串，
     * 于是 `/models?tab=llm` 上「模型」自己灭了（一项都不亮）。
     * `?tab=` 是页内状态，不是导航目标的一部分 —— 它不该参与判定。
     */
    assert.equal(at('/models', '?tab=llm'), '/models');
    assert.equal(at('/models', '?tab=asr'), '/models');
    assert.equal(at('/notes/01KZ1H8YABCDEFGHJKMNPQRST', '?tab=notes'), '/notes');
  });

  test('★ 两个筛选视图彼此互斥（这一半是上一版做对的，不许改坏）', () => {
    assert.equal(at('/notes'), '/notes', '「全部笔记」上不该轮到「星标」');
    assert.equal(at('/notes', '?starred=1'), '/notes?starred=1', '「星标」上不该轮到「全部笔记」');
  });

  test('★ 区域仍然管辖子路径 —— /settings/* 需要的正是前缀语义', () => {
    assert.equal(at('/settings'), '/settings');
    assert.equal(at('/settings/general'), '/settings');
    assert.equal(at('/settings/storage'), '/settings');
    assert.equal(at('/models/asr%2Fwhisper-large-v3'), '/models');
  });

  test('★ 前缀必须按段边界，不能是字符串前缀', () => {
    assert.equal(
      activeNavTarget(['/notes'], { pathname: '/notesomething', search: '' }),
      undefined,
      '/notesomething 不是 /notes 的子路径 —— 字符串 startsWith 会把它算进去',
    );
  });

  test('★ 不归任何侧栏项管的地址：一项都不亮，而不是随便挑一个', () => {
    assert.equal(at('/capture'), undefined, '「新建捕获」是侧栏顶部那个按钮，不是 SideLink');
    assert.equal(at('/search', '?q=x'), undefined);
    assert.equal(at('/onboarding'), undefined);
  });

  test('★ 更长的区域赢 —— 免得将来加子导航时依赖数组顺序', () => {
    const nested = ['/settings', '/settings/advanced'];
    assert.equal(
      activeNavTarget(nested, { pathname: '/settings/advanced/keys', search: '' }),
      '/settings/advanced',
    );
    assert.equal(
      activeNavTarget([...nested].reverse(), { pathname: '/settings/advanced/keys', search: '' }),
      '/settings/advanced',
      '换个数组顺序结果就变，等于这条规则只是碰巧对',
    );
  });

  test('★ 查询串参数顺序不同仍是同一个地址', () => {
    assert.equal(
      activeNavTarget(['/notes?starred=1&sort=new'], {
        pathname: '/notes',
        search: '?sort=new&starred=1',
      }),
      '/notes?starred=1&sort=new',
    );
  });

  test('★ 兄弟筛选视图的键出现时，区域不许抢高亮（文件夹树那条在别的组件里）', () => {
    /*
     * `/notes?folder=<uid>` 该亮的是文件夹树里那一条 —— 它是动态的，不在这张清单上。
     * 区域若照常赢下前缀匹配，「全部笔记」就会和那个文件夹**同时**被标成当前页，
     * 正是 T-138b 刚修掉的形状，只是跨了两个组件所以更难看见。
     */
    assert.equal(
      activeNavTarget(SIDEBAR, { pathname: '/notes', search: '?folder=abc' }, NAV_FILTER_KEYS),
      undefined,
      '一级导航该让位给文件夹树那一条',
    );
    // 不传 filterKeys 时就是旧行为 —— 这条钉的是"声明确实起作用了"，不是零
    assert.equal(
      activeNavTarget(SIDEBAR, { pathname: '/notes', search: '?folder=abc' }),
      '/notes',
      '没有声明就认不出 folder 是筛选视图 —— 这正是必须显式声明的理由',
    );
  });

  test('★ 页内视图状态的键不许被当成筛选视图（否则退回"一项都不亮"）', () => {
    assert.equal(
      activeNavTarget(SIDEBAR, { pathname: '/models', search: '?tab=llm' }, NAV_FILTER_KEYS),
      '/models',
      'tab 被写进 NAV_FILTER_KEYS 了？那 /models?tab=llm 又会一项都不亮',
    );
    assert.equal(
      activeNavTarget(
        SIDEBAR,
        { pathname: '/notes/01KZ1H8YABCDEFGHJKMNPQRST', search: '?tab=mindmap' },
        NAV_FILTER_KEYS,
      ),
      '/notes',
    );
  });

  test('★ NAV_FILTER_KEYS 里只放"代表另一个导航目标"的键', () => {
    assert.deepEqual([...NAV_FILTER_KEYS].sort(), ['folder', 'starred']);
    assert.equal(
      (NAV_FILTER_KEYS as readonly string[]).includes('tab'),
      false,
      'tab 是页内视图状态，进了这张表就会把区域的灯弄灭',
    );
  });

  /**
   * ★ 这条守的是**性质本身**，不是某一个地址。
   *
   * 「至多一项高亮」原先没有任何地方在管它 —— 每项各判各的，全对只是巧合，
   * 而实测那个巧合在详情页破了。函数返回单个 target 之后它由类型保证，
   * 这条用例是那句保证的可执行版本：**穷举产品里真实走得到的地址，逐个数灯。**
   */
  test('★ 穷举真实地址：每一个都恰好亮 0 或 1 项，绝不同时亮两项', () => {
    const ADDRESSES: [string, string][] = [
      ['/notes', ''],
      ['/notes', '?starred=1'],
      ['/notes/01KZ1H8YABCDEFGHJKMNPQRST', ''],
      ['/notes/01KZ1H8YABCDEFGHJKMNPQRST', '?tab=mindmap'],
      ['/notes/01KZ1H8YABCDEFGHJKMNPQRST/mindmap', ''],
      ['/record', ''],
      ['/runtime', ''],
      ['/models', ''],
      ['/models', '?tab=llm'],
      ['/models/asr%2Fwhisper', ''],
      ['/tasks', ''],
      ['/settings', ''],
      ['/settings/storage', ''],
      ['/capture', ''],
      ['/search', '?q=x'],
      ['/notes', '?folder=01FOLDERUID'],
    ];
    for (const [pathname, search] of ADDRESSES) {
      const hit = activeNavTarget(SIDEBAR, { pathname, search }, NAV_FILTER_KEYS);
      // 返回值必须真的是侧栏里的一项（不能凭空造一个）
      assert.equal(
        hit === undefined || SIDEBAR.includes(hit),
        true,
        `${pathname}${search} 返回了一个不在侧栏里的 target：${String(hit)}`,
      );
    }
    // 有主区内容的地址不该"一项都不亮"（`/capture` `/search` 例外，它们没有侧栏项）
    for (const [pathname, search] of ADDRESSES) {
      // `?folder=` 该亮的那一条在文件夹树里，不在这张清单上 —— 这里返回 undefined 是对的
      if (pathname.startsWith('/capture') || pathname.startsWith('/search')) continue;
      if (new URLSearchParams(search).has('folder')) continue;
      assert.notEqual(
        activeNavTarget(SIDEBAR, { pathname, search }, NAV_FILTER_KEYS),
        undefined,
        `${pathname}${search} 上侧栏一项都不亮 —— 用户不知道自己在哪`,
      );
    }
  });
});
