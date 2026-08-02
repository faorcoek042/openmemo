/**
 * `materializeSqliteExtensions` —— 冷启动实测出来的那个洞的回归测试（T-093）。
 *
 * 背景（不是假设，是 T-093 全新 dataDir 冷启动跑出来的）：
 * 三个 sqlite-ext 包全部下载 + sha256 校验通过，daemon 起来仍然
 * `tokenizer=trigram, vec=off` —— **中文双字词搜不到，且没有任何报错**。
 * 原因是 ADR-015 之后每个上游包解包到自己的 `by-name/backend/<archive>/`，
 * libsimple 的 zip 还多嵌一层，而所有消费方（`defaultExtensionPaths(root)`、
 * `OPENMEMO_EXT_DIR`、清单里的 `linkInto: "bin/ext"`）都假设"一个目录装齐"。
 *
 * 所以这里测的是**功能**：给一棵和真实解包结果同形的目录树，
 * 事后 `<extDir>/libsimple.so` 与 `<extDir>/vec0.so` 必须双双能读到真实内容。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { findFileInBackendPacks, materializeSqliteExtensions } from '../tools.js';

const suffix =
  process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';

const roots: string[] = [];
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** 复刻真实解包布局：libsimple 多嵌一层、sqlite-vec 是平的。 */
async function fakeStore(): Promise<{ dataDir: string; storeRoot: string; extDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'om-ext-test-'));
  roots.push(dataDir);
  const storeRoot = join(dataDir, 'models');
  const backend = join(storeRoot, 'by-name', 'backend');

  const nested = join(backend, 'libsimple-linux-ubuntu-22.04', 'libsimple-linux-ubuntu-22.04');
  await mkdir(join(nested, 'dict'), { recursive: true });
  await writeFile(join(nested, `libsimple${suffix}`), 'LIBSIMPLE');
  await writeFile(join(nested, 'dict', 'jieba.dict.utf8'), 'DICT');

  const flat = join(backend, 'sqlite-vec-0.1.9-loadable-linux-x86_64');
  await mkdir(flat, { recursive: true });
  await writeFile(join(flat, `vec0${suffix}`), 'VEC0');

  return { dataDir, storeRoot, extDir: join(dataDir, 'bin', 'ext') };
}

describe('materializeSqliteExtensions', () => {
  it('把嵌套包和扁平包里的扩展汇到同一个 bin/ext —— 内容真的读得到', async () => {
    const { storeRoot, extDir } = await fakeStore();
    const r = await materializeSqliteExtensions(storeRoot, extDir);

    assert.deepEqual(r.missing, [], '三样都该找到');
    assert.equal(await readFile(join(extDir, `libsimple${suffix}`), 'utf8'), 'LIBSIMPLE');
    assert.equal(await readFile(join(extDir, `vec0${suffix}`), 'utf8'), 'VEC0');
    assert.equal(await readFile(join(extDir, 'dict', 'jieba.dict.utf8'), 'utf8'), 'DICT');
  });

  it('链接是相对的 —— 整棵数据目录被搬走后仍然解得开', async function () {
    if (process.platform === 'win32') return; // Windows 走拷贝，本条不适用
    const { dataDir, storeRoot, extDir } = await fakeStore();
    await materializeSqliteExtensions(storeRoot, extDir);

    // 模拟 /api/settings/data-dir 的 rename 搬迁
    const moved = `${dataDir}-moved`;
    roots.push(moved);
    await mkdir(moved, { recursive: true });
    await rm(moved, { recursive: true, force: true });
    const { rename } = await import('node:fs/promises');
    await rename(dataDir, moved);

    // 绝对链接在这一步就会断掉；相对链接不会。
    assert.equal(
      await readFile(join(moved, 'bin', 'ext', `libsimple${suffix}`), 'utf8'),
      'LIBSIMPLE',
      '搬完还要读得到 —— 否则中文搜索会在用户挪完数据目录后悄悄失效',
    );
  });

  it('可重复执行：升级换了包目录也要指向新的那个', async () => {
    const { storeRoot, extDir } = await fakeStore();
    await materializeSqliteExtensions(storeRoot, extDir);

    // 装了个"新版本"，旧的删掉
    const backend = join(storeRoot, 'by-name', 'backend');
    await rm(join(backend, 'sqlite-vec-0.1.9-loadable-linux-x86_64'), { recursive: true });
    const v2 = join(backend, 'sqlite-vec-0.2.0-loadable-linux-x86_64');
    await mkdir(v2, { recursive: true });
    await writeFile(join(v2, `vec0${suffix}`), 'VEC0-V2');

    await materializeSqliteExtensions(storeRoot, extDir);
    assert.equal(await readFile(join(extDir, `vec0${suffix}`), 'utf8'), 'VEC0-V2');
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
    const hit = await findFileInBackendPacks(storeRoot, `libsimple${suffix}`);
    assert.ok(hit !== null && hit.endsWith(`libsimple${suffix}`));
  });

  it('目标已存在一个坏链接：覆盖掉，而不是留着坏的', async () => {
    if (process.platform === 'win32') return;
    const { storeRoot, extDir } = await fakeStore();
    await mkdir(extDir, { recursive: true });
    await symlink('/nonexistent/old-pack/libsimple.so', join(extDir, `libsimple${suffix}`));

    await materializeSqliteExtensions(storeRoot, extDir);
    assert.equal(await readFile(join(extDir, `libsimple${suffix}`), 'utf8'), 'LIBSIMPLE');
  });
});
