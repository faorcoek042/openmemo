/**
 * `materializeSqliteExtensions` —— 冷启动实测出来的那个洞的回归测试（T-093 / T-147）。
 *
 * 背景（不是假设，是 T-093 全新 dataDir 冷启动跑出来的）：
 * 三个 sqlite-ext 包全部下载 + sha256 校验通过，daemon 起来仍然
 * `tokenizer=trigram, vec=off` —— **中文双字词搜不到，且没有任何报错**。
 * 原因是 ADR-015 之后每个上游包解包到自己的 `by-name/backend/<archive>/`，
 * libsimple 的 zip 还多嵌一层，而所有消费方（`defaultExtensionPaths(root)`、
 * `OPENMEMO_EXT_DIR`、清单里的 `linkInto: "bin/ext"`）都假设"一个目录装齐"。
 *
 * ★ T-147：**同一个洞在 Windows 上原样复现了一次**，而这个文件当时是绿的 ——
 * 因为造假数据的那几行和产品代码犯的是同一个错：都按 `libsimple${suffix}` 拼名字。
 * 上游 Windows 包里那个文件**叫 `simple.dll`**（MSVC 不加 `lib` 前缀）。
 * 所以现在 fixture 用的是**上游归档里真实的文件名**（见 `ARCHIVE`），
 * 并且三个平台的映射都在 Linux 上跑得到 —— 否则"在别的平台上什么都没断言"。
 *
 * 判据一律是**功能**：事后 `<extDir>/libsimple.<ext>` 与 `<extDir>/vec0.<ext>`
 * 必须双双能读到真实内容。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, lstat, readFile, readlink, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  findFileInBackendPacks,
  materializeSqliteExtensions,
  sqliteExtensionSources,
} from '../tools.js';

/** 仓库根 —— `dist/__tests__/` 上溯 4 层。 */
const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));

/**
 * ★ 上游归档里的**真实**布局，逐条来自 `[实测]`：把 `vendor/manifests/sqlite-ext.json`
 * 里那三个 URL 下下来 unzip 列出来的（v0.7.1，sha256 与清单一致）。
 *
 * ```
 * libsimple-linux-ubuntu-22.04.zip → libsimple-linux-ubuntu-22.04/libsimple.so
 * libsimple-osx-arm64.zip          → libsimple-osx-arm64/libsimple.dylib
 * libsimple-windows-x64.zip        → libsimple-windows-x64/simple.dll   ← ★ 没有 lib 前缀
 * ```
 *
 * **不要把这张表改成用 `${suffix}` 拼出来** —— 那正是产品代码当初犯的错，
 * 抄进 fixture 就等于让这个文件永远同意产品的错误。
 */
const ARCHIVE: Record<string, { pack: string; libsimple: string; vec: string; vecFile: string }> = {
  linux: {
    pack: 'libsimple-linux-ubuntu-22.04',
    libsimple: 'libsimple.so',
    vec: 'sqlite-vec-0.1.9-loadable-linux-x86_64',
    vecFile: 'vec0.so',
  },
  darwin: {
    pack: 'libsimple-osx-arm64',
    libsimple: 'libsimple.dylib',
    vec: 'sqlite-vec-0.1.9-loadable-macos-aarch64',
    vecFile: 'vec0.dylib',
  },
  win32: {
    pack: 'libsimple-windows-x64',
    libsimple: 'simple.dll',
    vec: 'sqlite-vec-0.1.9-loadable-windows-x86_64',
    vecFile: 'vec0.dll',
  },
};

const roots: string[] = [];
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** 复刻真实解包布局：libsimple 多嵌一层、sqlite-vec 是平的。 */
async function fakeStore(
  platform: NodeJS.Platform = process.platform,
): Promise<{ dataDir: string; storeRoot: string; extDir: string }> {
  const a = ARCHIVE[platform] ?? ARCHIVE['linux']!;
  const dataDir = await mkdtemp(join(tmpdir(), 'om-ext-test-'));
  roots.push(dataDir);
  const storeRoot = join(dataDir, 'models');
  const backend = join(storeRoot, 'by-name', 'backend');

  const nested = join(backend, a.pack, a.pack);
  await mkdir(join(nested, 'dict'), { recursive: true });
  await writeFile(join(nested, a.libsimple), 'LIBSIMPLE');
  await writeFile(join(nested, 'dict', 'jieba.dict.utf8'), 'DICT');

  const flat = join(backend, a.vec);
  await mkdir(flat, { recursive: true });
  await writeFile(join(flat, a.vecFile), 'VEC0');

  return { dataDir, storeRoot, extDir: join(dataDir, 'bin', 'ext') };
}

/** 该平台上 `bin/ext` 里**必须**出现的那两个名字（消费方查的就是这两个）。 */
const dstNames = (platform: NodeJS.Platform): { lib: string; vec: string } => {
  const s = sqliteExtensionSources(platform);
  return { lib: s[0]!.dst, vec: s[1]!.dst };
};

describe('materializeSqliteExtensions', () => {
  /*
   * ★★ 这一组在**三个平台的映射上各跑一遍**，而不是只跑宿主那一份。
   * 之前它只跑宿主：Windows 的映射在这台 Linux 开发机上从来没有被执行过一行，
   * 而它恰好是坏的（T-147）。
   */
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    it(`[${platform}] 把嵌套包和扁平包里的扩展汇到同一个 bin/ext —— 内容真的读得到`, async () => {
      const { storeRoot, extDir } = await fakeStore(platform);
      const r = await materializeSqliteExtensions(storeRoot, extDir, platform);
      const { lib, vec } = dstNames(platform);

      assert.deepEqual(r.missing, [], `三样都该找到（${platform}）`);
      assert.equal(await readFile(join(extDir, lib), 'utf8'), 'LIBSIMPLE');
      assert.equal(await readFile(join(extDir, vec), 'utf8'), 'VEC0');
      assert.equal(await readFile(join(extDir, 'dict', 'jieba.dict.utf8'), 'utf8'), 'DICT');
    });
  }

  /*
   * ★ T-147 的那条：**上游 Windows 包里的文件不叫 `libsimple.dll`。**
   * 单独写一条，是因为上面那组即使被"顺手简化"回按后缀拼名字，也要有一条明确点名的红。
   */
  it('★ Windows：包里叫 simple.dll，bin/ext 里必须变成 libsimple.dll', async () => {
    const { storeRoot, extDir } = await fakeStore('win32');
    // 先证明 fixture 里**没有** libsimple.dll —— 否则这条钉的是零
    assert.equal(await findFileInBackendPacks(storeRoot, 'libsimple.dll'), null);
    assert.notEqual(await findFileInBackendPacks(storeRoot, 'simple.dll'), null);

    const r = await materializeSqliteExtensions(storeRoot, extDir, 'win32');
    assert.deepEqual(r.missing, [], 'win32 上找不到 libsimple = 中文检索静默退回 trigram');
    assert.equal(await readFile(join(extDir, 'libsimple.dll'), 'utf8'), 'LIBSIMPLE');
  });

  it('宿主平台：链接策略与平台一致（POSIX 用相对软链，win32 用拷贝）', async () => {
    const { storeRoot, extDir } = await fakeStore();
    await materializeSqliteExtensions(storeRoot, extDir);
    const dst = join(extDir, dstNames(process.platform).lib);
    const st = await lstat(dst);

    if (process.platform === 'win32') {
      // Windows 上建软链需要开发者模式或提权，所以这里必须是**真拷贝**。
      assert.equal(st.isSymbolicLink(), false, 'win32 上不许留下软链 —— 普通用户建不出来');
      assert.equal(st.isFile(), true);
    } else {
      assert.equal(st.isSymbolicLink(), true);
      /*
       * RELATIVE，不是绝对：数据目录可以被 `/api/settings/data-dir` 搬走，
       * 绝对链接搬完仍指向旧位置 —— 中文检索会在用户挪完数据目录之后悄悄失效。
       */
      assert.equal(isAbsolute(await readlink(dst)), false, '绝对链接搬家后会断');
    }
  });

  it('win32 的拷贝分支在任何宿主上都可达（不是"Windows 上没人测"）', async () => {
    const { storeRoot, extDir } = await fakeStore('win32');
    await materializeSqliteExtensions(storeRoot, extDir, 'win32');
    const st = await lstat(join(extDir, 'libsimple.dll'));
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isFile(), true);
  });

  it('链接是相对的 —— 整棵数据目录被搬走后仍然解得开', async () => {
    const { dataDir, storeRoot, extDir } = await fakeStore();
    await materializeSqliteExtensions(storeRoot, extDir);

    // 模拟 /api/settings/data-dir 的 rename 搬迁
    const moved = `${dataDir}-moved`;
    roots.push(moved);
    const { rename } = await import('node:fs/promises');
    await rename(dataDir, moved);

    /*
     * 绝对链接在这一步就会断掉；相对链接不会。
     * ⚠️ 在 Windows 上这条本来就成立（走的是拷贝），所以它在那儿钉住的是
     * "拷贝没有反过来引入别的问题"，强度确实较低 —— 上一条用例负责钉住
     * "各平台用的策略对不对"，两条合起来才完整。
     */
    assert.equal(
      await readFile(join(moved, 'bin', 'ext', dstNames(process.platform).lib), 'utf8'),
      'LIBSIMPLE',
      '搬完还要读得到 —— 否则中文搜索会在用户挪完数据目录后悄悄失效',
    );
  });

  it('可重复执行：升级换了包目录也要指向新的那个', async () => {
    const { storeRoot, extDir } = await fakeStore();
    await materializeSqliteExtensions(storeRoot, extDir);

    // 装了个"新版本"，旧的删掉
    const a = ARCHIVE[process.platform] ?? ARCHIVE['linux']!;
    const backend = join(storeRoot, 'by-name', 'backend');
    await rm(join(backend, a.vec), { recursive: true });
    const v2 = join(backend, a.vec.replace('0.1.9', '0.2.0'));
    await mkdir(v2, { recursive: true });
    await writeFile(join(v2, a.vecFile), 'VEC0-V2');

    await materializeSqliteExtensions(storeRoot, extDir);
    assert.equal(await readFile(join(extDir, dstNames(process.platform).vec), 'utf8'), 'VEC0-V2');
  });

  it('一个都没装：如实报 missing，不建空目录也不抛', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'om-ext-empty-'));
    roots.push(dataDir);
    const r = await materializeSqliteExtensions(join(dataDir, 'models'), join(dataDir, 'bin', 'ext'));
    assert.equal(Object.keys(r.linked).length, 0);
    assert.equal(r.missing.length, 3);
  });

  it('findFileInBackendPacks 找得到没有可执行位的 .so（findInBackendPacks 找不到）', async () => {
    const { storeRoot } = await fakeStore();
    const a = ARCHIVE[process.platform] ?? ARCHIVE['linux']!;
    const hit = await findFileInBackendPacks(storeRoot, a.libsimple);
    assert.ok(hit !== null && hit.endsWith(a.libsimple));
  });

  it('目标已存在一个坏链接：覆盖掉，而不是留着坏的', async () => {
    if (process.platform === 'win32') {
      /*
       * 允许的 skip，理由可检验：这条要先**造**一条悬空软链当前置条件，
       * 而在没开开发者模式的 Windows 上 `symlink()` 本身就会 EPERM ——
       * 造不出前置条件的用例在那儿断言的只会是"造失败了"。
       * 对应的 Windows 语义（拷贝会覆盖旧文件）由上一条 `可重复执行` 覆盖，
       * 它在 win32 宿主上跑的就是拷贝分支。
       */
      return;
    }
    const { storeRoot, extDir } = await fakeStore();
    const { lib } = dstNames(process.platform);
    await mkdir(extDir, { recursive: true });
    await symlink('/nonexistent/old-pack/libsimple.so', join(extDir, lib));

    await materializeSqliteExtensions(storeRoot, extDir);
    assert.equal(await readFile(join(extDir, lib), 'utf8'), 'LIBSIMPLE');
  });
});

/* ═══════════ T-147：名字这件事本身要有守卫 ═══════════════════════════════════════ */

/**
 * SQLite 在**没有显式入口点**时怎么从文件名推入口点 —— 逐字照抄 `sqlite3.c` 的
 * `zAltEntry` 那段（better-sqlite3 13.0.2 内置的那份，第 143837-143859 行）：
 *
 *   去掉目录 → 跳过开头的 `lib` → 取到第一个 `.` 之前的**字母**（首轮不含数字）
 *   → 拼成 `sqlite3_<X>_init`。
 *
 * 之所以要在测试里重写一遍：`bin/ext` 里那个名字是**我们**起的，而能不能加载
 * 由这条规则决定。两者之间没有任何编译期约束 —— 把 `libsimple.dll` 改名成
 * `chinese.dll`，产品代码一行不用改，扩展当场加载不了（`no entry point`）。
 */
function sqliteEntryPoint(fileName: string): string {
  let base = fileName.slice(fileName.lastIndexOf('/') + 1);
  base = base.slice(base.lastIndexOf('\\') + 1);
  if (base.slice(0, 3).toLowerCase() === 'lib') base = base.slice(3);
  const upToDot = base.split('.')[0] ?? '';
  return `sqlite3_${upToDot.replace(/[^a-zA-Z]/g, '').toLowerCase()}_init`;
}

describe('★ T-147 sqliteExtensionSources —— 名字映射', () => {
  it('每个平台的后缀与目标名', () => {
    assert.deepEqual(
      sqliteExtensionSources('linux').map((s) => s.dst),
      ['libsimple.so', 'vec0.so', 'dict'],
    );
    assert.deepEqual(
      sqliteExtensionSources('darwin').map((s) => s.dst),
      ['libsimple.dylib', 'vec0.dylib', 'dict'],
    );
    assert.deepEqual(
      sqliteExtensionSources('win32').map((s) => s.dst),
      ['libsimple.dll', 'vec0.dll', 'dict'],
    );
  });

  it('★ win32 必须去找 simple.dll —— 上游包里没有 libsimple.dll', () => {
    const win = sqliteExtensionSources('win32')[0]!;
    assert.equal(
      win.candidates.includes('simple.dll'),
      true,
      '只找 libsimple.dll = 在 Windows 上永远找不到 = tokenizer 静默退回 trigram',
    );
    // 另外两个平台不该被这条顺手带上（它们的包里确实叫 libsimple.*）
    assert.deepEqual([...sqliteExtensionSources('linux')[0]!.candidates], ['libsimple.so']);
    assert.deepEqual([...sqliteExtensionSources('darwin')[0]!.candidates], ['libsimple.dylib']);
  });

  /**
   * ★ 把「上游归档里到底叫什么」这个**实测事实**直接钉在查找候选上。
   *
   * 这是本组里唯一能拦住 T-147 重犯的一条：`ARCHIVE` 表是从三个真实 zip 里
   * 列出来的（见文件头），任何一个平台的候选漏了它，这里当场红。
   */
  it('★ 三个平台上游归档里的真实文件名，逐个都在查找候选里', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const { candidates } = sqliteExtensionSources(platform)[0]!;
      assert.equal(
        candidates.includes(ARCHIVE[platform]!.libsimple),
        true,
        `${platform}: 归档里是 ${ARCHIVE[platform]!.libsimple}，代码只找 ${candidates.join(' / ')}`,
      );
      const vecCandidates = sqliteExtensionSources(platform)[1]!.candidates;
      assert.equal(vecCandidates.includes(ARCHIVE[platform]!.vecFile), true, platform);
    }
  });

  /**
   * ★ 这条钉的是**后果**：改名之后 SQLite 还认不认得出入口点。
   * `simple.dll` 只导出一个 `sqlite3_*` 符号 —— `sqlite3_simple_init`
   * （`[实测]` v0.7.1 Windows 包的 PE 导出表：2623 个导出，匹配 `sqlite3*` 的只有这一个），
   * 所以落地名字必须仍然能推导出它。
   */
  it('★ 落地的名字必须仍然能推出 sqlite3_simple_init / sqlite3_vec_init', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const [lib, vec] = sqliteExtensionSources(platform);
      assert.equal(sqliteEntryPoint(lib!.dst), 'sqlite3_simple_init', platform);
      assert.equal(sqliteEntryPoint(vec!.dst), 'sqlite3_vec_init', platform);
      // 我们**找**的每一个候选也必须推得出同一个入口点，否则找到了也加载不了
      for (const c of lib!.candidates) assert.equal(sqliteEntryPoint(c), 'sqlite3_simple_init', c);
    }
  });

  it('推导规则本身：带不带 lib 前缀、带不带路径，都推到同一个入口点', () => {
    // 这几条是上面那条断言的前置条件；规则写错了会让上面那条变成永远绿。
    assert.equal(sqliteEntryPoint('simple.dll'), 'sqlite3_simple_init');
    assert.equal(sqliteEntryPoint('libsimple.dll'), 'sqlite3_simple_init');
    assert.equal(sqliteEntryPoint('C:\\d\\bin\\ext\\libsimple.dll'), 'sqlite3_simple_init');
    assert.equal(sqliteEntryPoint('/d/bin/ext/libsimple.so'), 'sqlite3_simple_init');
    assert.equal(sqliteEntryPoint('chinese.dll'), 'sqlite3_chinese_init'); // ← 改名就加载不了
  });
});

/**
 * ★ 清单与代码的对表。
 *
 * `providesFiles` 的定义是「装完之后必须存在、否则这个包不算能用的文件」
 * （`packages/shared/src/backends.ts:117`）。对 sqlite-ext 包来说"装完"包含
 * `materializeSqliteExtensions` 这一步，所以它既可能写归档里的名字（`simple.dll`）、
 * 也可能写 `bin/ext` 里的名字（`libsimple.dll`）—— **两种读法都说得通**，
 * 所以这里两边都接受，只拦住"两个名字都对不上"的漂移（比如后缀写错、平台写错）。
 *
 * ⚠️ 现状（如实记）：win32 那两行写的是 `libsimple.dll`，而**归档里不存在这个文件**。
 * 按"归档提供什么"的读法它是假的；按"装完 bin/ext 里有什么"的读法它是真的
 * （T-147 修完之后才真）。改成 `simple.dll` 会更准确，但 `vendor/manifests/`
 * 是 `pack-publish` 的领地 —— 已在 `coordination/inbox/win-fixes.md` 申报，**未擅自改**。
 * 拦住重犯的那条断言在上面（`三个平台上游归档里的真实文件名…`），不依赖这份清单。
 */
describe('★ T-147 vendor/manifests/sqlite-ext.json 与代码对得上', () => {
  const readManifest = async (): Promise<{
    packs: Array<{ id: string; os: string; providesFiles: string[] }>;
  }> =>
    JSON.parse(
      await readFile(join(REPO_ROOT, 'vendor', 'manifests', 'sqlite-ext.json'), 'utf8'),
    ) as { packs: Array<{ id: string; os: string; providesFiles: string[] }> };

  const accepted = (os: string, index: 0 | 1): string[] => {
    const src = sqliteExtensionSources(os as NodeJS.Platform)[index]!;
    return [src.dst, ...src.candidates];
  };

  it('每个 libsimple 包声明的文件名，都是该平台认得的名字', async () => {
    const packs = (await readManifest()).packs.filter((p) => p.id.startsWith('libsimple-'));
    // 集合非空，否则这条断言可以靠"筛出来是空的"永远通过
    assert.ok(packs.length >= 4, `libsimple 包太少（${packs.length}），这条断言失去意义`);
    for (const p of packs) {
      const ok = accepted(p.os, 0);
      for (const f of p.providesFiles) {
        assert.equal(
          ok.includes(f),
          true,
          `${p.id} 声明给出 ${f}，而代码在 ${p.os} 上认得的只有 ${ok.join(' / ')}` +
            ` —— 装完等于没装，且零报错`,
        );
      }
    }
  });

  it('每个 sqlite-vec 包声明的文件名同样对得上', async () => {
    const packs = (await readManifest()).packs.filter((p) => p.id.startsWith('sqlite-vec-'));
    assert.ok(packs.length >= 4, `sqlite-vec 包太少（${packs.length}）`);
    for (const p of packs) {
      const ok = accepted(p.os, 1);
      for (const f of p.providesFiles) {
        assert.equal(ok.includes(f), true, `${p.id}: ${f} 不在 ${ok.join(' / ')}`);
      }
    }
  });
});
