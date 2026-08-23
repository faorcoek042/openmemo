/**
 * `openmemo-probe` 的分发守卫（T-167）。
 *
 * ## 它守的是哪一件事
 *
 * 探针是章程要求 2.1「网页检测硬件 → 推荐后端」那一步的**执行者**，
 * 也是 ADR-003 决策 3 里「唯一可信的设备枚举」。它此前**没有任何分发通道** ——
 * CI 每轮都编出来，然后 upload 成一个谁也下不到的 artifact。
 *
 * T-167 查下去发现「缺的只剩把它发出去」不成立，还有两条：
 *
 * 1. `[本机实测 2026-08-07]` 探针**动态链接** ggml，不是自包含的可执行文件：
 *    ```
 *    $ objdump -p openmemo-probe | grep -E 'NEEDED|RUNPATH'
 *      NEEDED libggml-base.so.0 · NEEDED libggml.so.0 · RUNPATH $ORIGIN
 *    $ ./openmemo-probe            # 同目录没有那两个库
 *      error while loading shared libraries: libggml-base.so.0: cannot open shared object file
 *    ```
 *    → 单独发一个 `openmemo-probe` 文件（yt-dlp 那种扁平落点）在用户机器上
 *    **一次都启动不了**。
 * 2. `runtime/setup.ts` 的 `backendDir` 定义就是 `dirname(probePath)`，
 *    而 `probe.c` 只调一次 `ggml_backend_load_all_from_path(backendDir)` ——
 *    **它只能枚举与自己同目录的后端模块**。
 *
 * → 结论：探针必须**在包里**，而且是**每一个**包里。
 *
 * ## 为什么必须是守卫而不是一条注释
 *
 * 缺探针的后果**完全静默**：`runProbe()` 失败 → 界面写「尚未探测到硬件能力」——
 * **与"这台机器真的没有 GPU"一模一样**。安装记录成功、sha256 正确、
 * 自检里那条 `hw.probe` 只是 `warn`（它按设计不是 required）。
 * 也就是说：把探针从包里拿掉，**整条链上没有任何一处会红**，
 * 只有硬件加速悄悄地全线关闭。
 *
 * 同一个形状本仓已经吃过三次（T-093 中文分词器、T-160 安装目录≠runtime 目录、
 * D-11 §8.2 的 GLIBC_2.38）。所以它是一条断言，不是一段文档。
 *
 * ⚠️ **本文件是新增的**，刻意不改 `platformPacks.test.ts`（`pack-publish` 的）、
 * `ffmpegPinRot.test.ts`（`amd-vulkan` 的）、`ffmpegStableOnly.test.ts`
 * （`runner-migrate` 的）—— 避免写冲突，这是本仓既有的做法。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

/**
 * 探针的两个文件名。
 *
 * **刻意在这里再写一遍字面量**，而不是 import `probeBinaryName()`：
 * T-144 那条 bug 正是「产出方与使用方用了两个名字」（产出 `openmemo-probe`、
 * 消费方找 `probe`），后果是 `probeExists` 恒 false、L2 加速包在所有平台上都装不上。
 * 如果这里 import 实现，那么实现改名时这条守卫会**跟着改名并继续报绿** ——
 * 它就再也发现不了同一个 bug 了。判据要独立于被测者。
 */
const PROBE_NAMES: Record<string, string> = {
  win32: 'openmemo-probe.exe',
  linux: 'openmemo-probe',
  darwin: 'openmemo-probe',
};

/**
 * ADR-015 §7 的四个例外 id —— 它们的字节由**我们自己**托管，不是上游。
 *
 * 白名单存在的理由写在 ADR-015 §7.2：探针只能由我们放进包里，上游归档结构上给不了。
 * 白名单**不是入口**：每一条都必须在 `components.json` 里带着理由（见用例 ③），
 * 而且白名单里躺着一个已不存在的 id 会当场红（见用例 ④）——
 * 免得它变成一张没人看的免死金牌（照 `ffmpegStableOnly.test.ts` 的先例）。
 */
const SELF_HOSTED_EXCEPTIONS = new Set([
  'whispercpp-cpu-linux-x64',
  'whispercpp-cpu-win-x64',
  'whispercpp-cpu-macos-arm64',
  'whispercpp-vulkan-linux-x64',
]);

interface PackEntry {
  id: string;
  engine?: string;
  backend?: string;
  os?: string;
  arch?: string;
  providesFiles?: string[];
  files?: { mirrors?: { url?: string }[] }[];
}
interface ComponentEntry {
  id: string;
  sha256?: string;
  sha256Verification?: string;
  sha256Provenance?: string;
  provenance?: { releaseUrl?: string };
}

async function packs(): Promise<PackEntry[]> {
  const raw = JSON.parse(await readFile(join(MANIFEST_DIR, 'backends.json'), 'utf8')) as {
    packs?: PackEntry[];
  };
  const list = raw.packs ?? [];
  assert.ok(list.length > 0, 'backends.json 解析出 0 个包 —— 空集不是"没问题"，是"什么都没检查"');
  return list;
}

async function components(): Promise<ComponentEntry[]> {
  const raw = JSON.parse(await readFile(join(MANIFEST_DIR, 'components.json'), 'utf8')) as {
    components?: ComponentEntry[];
  };
  const list = raw.components ?? [];
  assert.ok(list.length > 0, 'components.json 解析出 0 条');
  return list;
}

/** whisper.cpp 引擎包（不含 ffmpeg / yt-dlp / sqlite 扩展那几类）。 */
const isWhisperPack = (p: PackEntry): boolean => p.engine === 'whisper.cpp';

describe('openmemo-probe 必须随包出厂（T-167 / ADR-015 §7）', () => {
  it('① 每一个我们自己托管的 whisper 包都必须提供 openmemo-probe', async () => {
    const list = await packs();
    const ours = list.filter((p) => isWhisperPack(p) && SELF_HOSTED_EXCEPTIONS.has(p.id));

    /*
     * 计数断言。阈值取 2 而不是 4：
     * 它只用来挡"一个都没匹配到"（筛空了还报绿），**不能高到盖住被检查的量本身** ——
     * `pack-publish` 在同一个坑里栽过两次：阈值取 >= 3 时，删掉一个引擎包
     * 先炸的是守卫自己（"可下载包只有 2 个"），真正该说的那句一个字都没印出来。
     */
    assert.ok(
      ours.length >= 2,
      `backends.json 里我们自己托管的 whisper 包只有 ${ours.length} 个 —— ` +
        `这条守卫已经在空跑了（ci-prep C5 那一族）`,
    );

    for (const p of ours) {
      const want = PROBE_NAMES[p.os ?? ''];
      assert.ok(
        want !== undefined,
        `${p.id}: os=${String(p.os)} 不在 PROBE_NAMES 里 —— 新平台要顺手把探针名补上，` +
          `否则这条守卫会对它一言不发`,
      );
      assert.ok(
        (p.providesFiles ?? []).includes(want),
        `${p.id} 的 providesFiles 里没有 ${want}。\n` +
          `  探针必须与 ggml 后端模块**同目录**才跑得起来（它动态链接 libggml-base，\n` +
          `  且 runtime/setup.ts 的 backendDir = dirname(probePath)，\n` +
          `  而 probe.c 只枚举与自己同目录的后端模块）。\n` +
          `  少了它，这个平台上「网页检测硬件」这一步永远只有 advisory 一档证据 ——\n` +
          `  而症状是「尚未探测到硬件能力」，与"这台机器真的没有 GPU"在界面上完全一样。\n` +
          `  实得: ${(p.providesFiles ?? []).join(', ')}`,
      );
    }
  });

  it('② 每一个能装 whisper 引擎的平台，至少有一个包带探针', async () => {
    const list = await packs();
    const engines = list.filter(isWhisperPack);
    assert.ok(engines.length >= 3, `whisper 引擎包只有 ${engines.length} 个 —— 守卫在空跑`);

    const byPlatform = new Map<string, PackEntry[]>();
    for (const p of engines) {
      const key = `${String(p.os)}/${String(p.arch)}`;
      byPlatform.set(key, [...(byPlatform.get(key) ?? []), p]);
    }
    assert.ok(byPlatform.size >= 2, `whisper 引擎只覆盖 ${byPlatform.size} 个平台 —— 守卫在空跑`);

    const naked: string[] = [];
    for (const [key, group] of byPlatform) {
      const os = key.split('/')[0] ?? '';
      const want = PROBE_NAMES[os];
      if (want === undefined) continue;
      if (!group.some((p) => (p.providesFiles ?? []).includes(want))) {
        naked.push(`${key}（${group.map((p) => p.id).join(', ')}）`);
      }
    }
    assert.deepEqual(
      naked,
      [],
      `以下平台装得上 whisper 引擎，却一个包都不带 openmemo-probe：\n  ` +
        naked.join('\n  ') +
        `\n  这些平台上硬件探测会**静默地**全线失效（章程要求 2.1 的第一步）。\n` +
        `  上游 ggml-org 的归档里永远不会有我们的探针 —— 见 ADR-015 §7.2。`,
    );
  });

  it('③ 四个 ADR-015 例外 id，每一条都必须把「为什么例外」写在 components.json 里', async () => {
    const list = await components();
    const byId = new Map(list.map((c) => [c.id, c]));

    for (const id of SELF_HOSTED_EXCEPTIONS) {
      const c = byId.get(id);
      assert.ok(c, `components.json 里没有 ${id}`);
      const text = c.sha256Provenance ?? '';
      assert.ok(
        text.length >= 300,
        `${id}: 它的字节由我们自己托管（ADR-015 §7 的例外），但 sha256Provenance ` +
          `没有（或只有一句敷衍的）说明，实得 ${text.length} 字。\n` +
          `  一条悄悄从上游改成自建的 URL，和一条写下了代价与对冲的例外，在 diff 里长得一样。`,
      );
      assert.ok(
        /ADR-015|openmemo-probe|探针/.test(text),
        `${id}: sha256Provenance 里既没提 ADR-015 也没提探针 —— ` +
          `那说明它记的不是这次例外的理由`,
      );
      assert.ok(
        (c.provenance?.releaseUrl ?? '').includes('faorcoek042/openmemo'),
        `${id}: provenance.releaseUrl 不指向我们自己的 release，` +
          `而 sizeBytes/sha256 已经是自建产物的值 —— 两者对不上，用户查来源会被带偏`,
      );
    }
  });

  /*
   * ★★ 「这个哈希是谁算的」必须是**机器可判的一格**，不许再从散文里嗅。
   *
   * 上一版界面用 `/API|digest|upstream/i.test(sha256Provenance)` 判证据强弱。
   * 13 条散文里 **8 条被判成"上游提供"，8 条全部误判**，而且正好是证据最强的那几条 ——
   * `whispercpp-cpu-win-x64` 明写着「不带任何凭证全量重下后本机 `sha256sum` 复算」，
   * 命中的 `api` 来自另一句里的 DLL 名 `api-ms-win-crt-*`。
   * （这个数由 `apps/web/src/features/components/sha256ProvenanceRegex.test.ts`
   *   重放那条正则算出来，不是抄的常量 —— 它第一版被誊成了 5，见那份文件的抬头。）
   *
   * 这条腿守的是那个修法的前提：**每一条有 sha256 的组件都得自己说出这一格**。
   * 缺了不会崩（`components.ts` 退到 `upstream-provided`，方向是"少信我们一点"），
   * 但那是保险丝不是设计 —— 清单里就该写全。
   */
  it('★★ 每条带 sha256 的组件都声明了 sha256Verification（判据不许再落在散文上）', async () => {
    const list = await components();
    const withHash = list.filter((c) => c.sha256 && c.sha256 !== 'n/a');
    assert.ok(withHash.length > 0, '一条带 sha256 的组件都没有 —— 这条在空转');

    const LEGAL = new Set(['local-recomputed', 'upstream-provided']);
    const missing = withHash.filter((c) => !c.sha256Verification).map((c) => c.id);
    assert.deepEqual(
      missing,
      [],
      `这些组件有 sha256 却没说它是谁算的：${missing.join(', ')}\n` +
        `  界面要靠这一格决定"要不要提醒用户少信它"，缺了就只能回去猜散文。`,
    );

    const illegal = withHash
      .filter((c) => !LEGAL.has(c.sha256Verification!))
      .map((c) => `${c.id}=${c.sha256Verification!}`);
    assert.deepEqual(
      illegal,
      [],
      `sha256Verification 只有两个合法值（local-recomputed / upstream-provided），` +
        `这些不是：${illegal.join(', ')}`,
    );
  });

  /*
   * ★ 反向腿：**散文里出现 `API` / `upstream` 不许改变任何结论。**
   *
   * 没有这一条，上面那条可以被"顺手再嗅一次散文当兜底"绕过去，而那正是本次要拆的
   * 那个判据。这里直接对着数据断：确实存在既写着 `local-recomputed`、散文里又含
   * 那几个词的条目 —— 它们就是上一版误判的那一批。
   *
   * ⚠️ **这里刻意不写"那一批"是几条。** 这条断言只判 `traps.length > 0`，
   * 它**不消费任何具体的数**；写一个数进来，就是又造一份没人核对的抄写件。
   * 那个数（连同 27 / 13）只在一个地方算：
   * `apps/web/src/features/components/sha256ProvenanceRegex.test.ts` ——
   * 它重放那条正则，清单一改就跟着变、变了就红。
   *
   * ★ 这句话本身是本仓最后一处写着"5 条"的地方（真值 8），而它躺在**同一个文件里
   * 已经改对的那一行下面 40 行** —— 第三次印证同一条：
   * **只要那个数还是一个被抄写的常量，下一次订正就还会漏一处。**
   * 所以修法不是把 5 改成 8，是让这里**不再记数**。
   */
  it('★ 确实存在「散文含 API/upstream 但结论是本机复算」的条目（上一版正是在这里翻车）', async () => {
    const list = await components();
    const traps = list.filter(
      (c) =>
        c.sha256Verification === 'local-recomputed' &&
        /API|digest|upstream/i.test(c.sha256Provenance ?? ''),
    );
    assert.ok(
      traps.length > 0,
      '一条这样的条目都没有 —— 那么上面那条反向腿测的是零，说明清单变了，判据要重写',
    );
  });

  it('④ 白名单里不许躺着一个已经不存在的 id', async () => {
    const list = await packs();
    const ids = new Set(list.map((p) => p.id));
    for (const id of SELF_HOSTED_EXCEPTIONS) {
      assert.ok(
        ids.has(id),
        `SELF_HOSTED_EXCEPTIONS 里的 ${id} 在 backends.json 里已经不存在了 —— ` +
          `把它从白名单里删掉，别让白名单变成一张没人看的免死金牌`,
      );
    }
  });

  it('⑤ 例外 id 的下载地址必须是我们自己 release 的资产', async () => {
    const list = await packs();
    const ours = list.filter((p) => SELF_HOSTED_EXCEPTIONS.has(p.id));
    assert.ok(ours.length >= 2, '守卫在空跑');
    for (const p of ours) {
      const urls = (p.files ?? []).flatMap((f) => (f.mirrors ?? []).map((m) => m.url ?? ''));
      assert.ok(urls.length > 0, `${p.id} 一个 mirror 都没有 —— 自建包必须有下载地址才算发出去了`);
      for (const u of urls) {
        assert.ok(
          u.startsWith('https://github.com/faorcoek042/openmemo/releases/download/'),
          `${p.id} 的下载地址不是我们 release 的资产：${u}\n` +
            `  （Actions artifact 会过期；上游地址里没有我们的探针。）`,
        );
      }
    }
  });
});
