/**
 * T-135：`GET /api/settings/data-dir` 的目录用途文案**必须成对**（`purpose` + `purposeZh`）。
 *
 * ## 这条测试挡的是什么
 *
 * 这几行文案是**"这个目录能不能删"的唯一答案**，而它只有中文一份时，
 * 英文界面拿不到任何可回落的东西 —— 前端既不能翻译（文案的权威在 daemon，
 * 路径随 dataDir 变），又不能省掉（省掉用户就不知道删哪个）。
 * 实测后果：`/settings` 整页搬进 i18n 之后，英文界面上**仍然剩着 81 个汉字**，
 * 逐条追下去全部来自这里。
 *
 * 仓库里既有的做法本来就是成对的（`displayName`/`displayNameZh`、
 * `descriptionEn`/`descriptionZh`），前端用 `lib/format/localized.ts` 挑一份。
 * 这条断言只是让"再加一个目录时也得给两份"变成会红的事，而不是靠人记得。
 *
 * ⚠️ 判据是「**这段文字描述的是内容**」，不是「这段文字里有汉字」。
 * 反例（不要顺手"修"）：语言切换器里的选项名「中文」本来就该是中文 ——
 * 语言名用它自己的语言写才认得出来。所以这条只管 `purpose*`，
 * 不是"全仓不许出现汉字"。
 *
 * ## ⚠️ 为什么这个文件在 `src/http/` 而不是 `src/http/rest/` 被测对象旁边
 *
 * `apps/daemon` 的 test 脚本给 `node --test` 传了一个**没有加引号**的
 * 双星号 glob，于是 sh 先展开它 —— 而 sh 不认双星号，它等价于「恰好两层」，
 * 只匹配 `dist/<一层目录>/<文件>.test.js`。放在 `rest/` 下面编出来是三层，
 * 那样这个文件**一次都不会被跑到，而且不报错**。
 * 放在这里是为了它真的会跑；根子（那个 glob）不归本轮改，已单独报给 Manager。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppPaths } from '../config/paths.js';
import { layout } from './rest/storage.js';

const CJK = /[一-鿿]/;

/** 只有 `layout()` 用得到的那几个字段，其余按 AppPaths 的形状补齐即可。 */
const PATHS = {
  dataDir: '/tmp/om',
  dbFile: '/tmp/om/openmemo.db',
  mediaDir: '/tmp/om/media',
  modelsDir: '/tmp/om/models',
  logsDir: '/tmp/om/logs',
  tmpDir: '/tmp/om/tmp',
  backupsDir: '/tmp/om/backups',
  runtimeDir: '/tmp/om/runtime',
} as unknown as AppPaths;

describe('T-135 数据目录用途文案：中英必须成对', () => {
  it('每一条都同时有 purpose 与 purposeZh，且都不是空的', () => {
    const entries = layout(PATHS);
    assert.ok(entries.length >= 7, `目录条目太少（${entries.length}），八成拿错了对象`);

    const missing = entries
      .filter((e) => !(e['purpose'] ?? '').trim() || !(e['purposeZh'] ?? '').trim())
      .map((e) => e['name']);
    assert.deepEqual(
      missing,
      [],
      `这些目录缺一份用途文案 —— 前端在那个语言下没有任何可回落的东西：${missing.join(', ')}`,
    );
  });

  /*
   * 光有字段不够：字段在、内容却是把中文原样抄过去，界面上还是中文。
   * 所以判的是**内容**：英文那份不许含汉字，中文那份必须含汉字
   * （后者防的是反过来抄）。
   */
  it('purpose 里不许出现汉字，purposeZh 里必须有汉字（防两边互相抄）', () => {
    for (const e of layout(PATHS)) {
      assert.ok(
        !CJK.test(e['purpose'] as string),
        `${e['name']} 的 purpose 里有汉字，等于没给英文：${e['purpose']}`,
      );
      assert.ok(
        CJK.test(e['purposeZh'] as string),
        `${e['name']} 的 purposeZh 里没有汉字：${e['purposeZh']}`,
      );
    }
  });

  it('name 与 path 不重复 —— 界面按 path 做 key', () => {
    const entries = layout(PATHS);
    assert.equal(new Set(entries.map((e) => e['path'])).size, entries.length);
  });
});
