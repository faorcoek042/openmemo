/**
 * T-149 回归守卫：**模型目录不许向用户承诺一件不存在的事。**
 *
 * ── 事故本体（两条，形状相同） ─────────────────────────────────────────────────
 *
 * ① `required-core`（「必需核心」）**一共标着 2 个模型，全是 VAD，零个 ASR**。
 *    `[CI 实测]`（D-11 §7.3 #1 / `ci-runner` 经 `/api/models/pull` 真装了一遍）：
 *
 *        拉模型：vad/silero-vad-onnx succeeded / vad/silero-vad-ggml succeeded
 *        model.vad  ok
 *        model.asr  fail required   无可用 ASR 模型
 *
 *    也就是**装完了、绿了、用不了** —— 用户按"必需核心"装齐，仍然一个字都转不出来。
 *    这个标签还有两件事让它更糟：
 *      · **没有任何产品消费者**。daemon 只把 `tags` 原样透传（`state.ts:354`），
 *        网页只读 `recommended-default`（`ModelCard.tsx:52`）。唯一的消费方是
 *        `scripts/ci/cold-start-audit.mjs` —— 它照字面意思装了一遍，然后撞上了上面那个红。
 *      · **T-148 之后连"必需"这两个字也不成立**：VAD 缺失只会让切分降级成固定窗口
 *        （`packages/pipeline/src/audio/vad.ts` + `vadStatus.ts`），转写照样出字。
 *
 * ② `hf-mirror` 条目提供的冗余是 **0（对境外出口而言）**。
 *    `[本机实测 2026-08-06]` `https://hf-mirror.com/**` 一律 `HTTP/2 308` +
 *    `location: https://huggingface.co/**`，`/resolve/<sha>/`、`/resolve/main/`、
 *    `/api/models/`、仓库页四种路径都试过；跟着跳过去落在 huggingface.co 上，
 *    而 huggingface.co 从这台机器 **20s 超时**。
 *    ⚠️ **但这不等于"它不是镜像"**：hf-mirror.com 首页自述是「帮助**国内用户**无障碍访问
 *    Hugging Face」的公益镜像，`packages/downloader/src/probe.ts` 的注释也早就写着
 *    「it 308-redirects **non-CN** traffic straight back to huggingface.co」。
 *    所以真正的缺陷不是"这条镜像是假的"，是**清单把一条有地域条件的来源当成了无条件的冗余**
 *    —— 从境外看它和主源是同一个源，主源一挂两条一起挂。
 *
 * ── 这个文件钉的东西 ─────────────────────────────────────────────────────────
 *
 *   ① 每个进入目录的标签**必须先有定义**；声称"这一组装完就够用"的标签必须真的够用。
 *      （含**一比一复现**：把事故当天的 `required-core` 喂给同一个判定函数，必须被判否。）
 *   ② mirror 列表里的"备份"必须真的是**另一个来源**；折叠成同一个来源之后
 *      只剩一条来源的文件，必须逐字出现在下面那份记录在案的清单里 ——
 *      **"我们知道这些文件没有备份"要写下来，不能靠没人发现。**
 *
 * 反向验证的真实输出贴在 `coordination/inbox/catalog-truth.md`。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { validateModelManifest } from '@openmemo/shared';

/** 仓库根 —— dist/pipeline/ 上溯 4 层（与 platformPacks.test.ts 同一算法）。 */
const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

/** 模型清单文件名。**写死是有意的**：新增一份模型清单必须来这里加一行，否则它不受本文件保护。 */
const MODEL_MANIFESTS = ['models-asr-support.json', 'models-whisper.json', 'models-llm.json'];

interface CatalogFile {
  name: string;
  sha256: string;
  sizeBytes: number;
  mirrors: { provider: string; url: string; official: boolean }[];
}
interface CatalogModel {
  id: string;
  role: string;
  tags: string[];
  engines: string[];
  files: CatalogFile[];
}

async function catalogModels(): Promise<CatalogModel[]> {
  const out: CatalogModel[] = [];
  for (const name of MODEL_MANIFESTS) {
    const raw: unknown = JSON.parse(await readFile(join(MANIFEST_DIR, name), 'utf8'));
    const v = validateModelManifest(raw);
    assert.equal(v.ok, true, v.ok ? '' : `${name} schema 不过：\n${v.errors.slice(0, 5).join('\n')}`);
    out.push(...(raw as { models: CatalogModel[] }).models);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * ① 标签：先有定义，才准进目录
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 目录里允许出现的标签，**以及每一个到底是什么意思**。
 *
 * 存在的理由很具体：`required-core` 这个名字读起来是一句承诺（「装完这些就够了」），
 * 而**从来没有任何地方定义过它**，也没有任何代码执行它。名字自己长出了含义，
 * 然后那个含义是假的。这张表把「加一个标签」变成「必须写下它是什么意思」。
 *
 * `claimsSufficiency = true` 的含义是**唯一有力的那种**：
 * 「把带这个标签的模型全装上，产品就能转写了」。带上它就要接受下面那条断言的检验。
 */
interface TagMeaning {
  /** 这个标签对用户/代码到底说了什么。 */
  zh: string;
  /** 是否声称"带这个标签的一组装完就够用"。 */
  claimsSufficiency: boolean;
}
const TAG_MEANINGS: Readonly<Record<string, TagMeaning>> = {
  // —— 能力/形态描述，纯信息，不承诺任何完整性 ——
  multilingual: { zh: '多语种权重', claimsSufficiency: false },
  'english-only': { zh: '仅英语权重（.en）', claimsSufficiency: false },
  'chinese-native': { zh: '中文原生训练', claimsSufficiency: false },
  streaming: { zh: '流式（边说边出字）', claimsSufficiency: false },
  offline: { zh: '离线批量转写', claimsSufficiency: false },
  vad: { zh: '语音活动检测权重', claimsSufficiency: false },
  punctuation: { zh: '标点恢复', claimsSufficiency: false },
  'cpu-friendly': { zh: '纯 CPU 也跑得动', claimsSufficiency: false },
  'high-accuracy': { zh: '同族里更准的档', claimsSufficiency: false },
  'high-quality': { zh: '同族里更大更好的档', claimsSufficiency: false },
  'long-context': { zh: '长上下文', claimsSufficiency: false },
  superseded: { zh: '已被更新的版本取代，保留只为可复现', claimsSufficiency: false },

  // —— 推荐，指的是"同类里先选它"，不是"只要它就够" ——
  'recommended-default': { zh: '该 role 的默认推荐（`ModelCard.tsx` 会打星）', claimsSufficiency: false },
  'recommended-default-zh': { zh: '中文场景的默认推荐', claimsSufficiency: false },
  'recommended-with-zh': { zh: '做中文时建议一起装', claimsSufficiency: false },

  // —— 与具体功能绑定：说的是"少了它那个功能不成立"，不是"有它就成立" ——
  'required-for-f3': { zh: 'F3 实时录音字幕所需（少了它 F3 不成立）', claimsSufficiency: false },

  // —— 内部用途 ——
  'benchmark-default': { zh: '跑基准时的默认样本模型', claimsSufficiency: false },
  'smoke-test': { zh: '冒烟测试用的最小权重', claimsSufficiency: false },
};

/**
 * 「把这一组装上，产品能转写吗」——**判据是后果，不是标签**。
 *
 * 判定：存在某个引擎 E，使这一组里有 ≥1 个 `role='asr'` 且 `engines` 含 E 的模型。
 * **VAD 刻意不算必需**：T-148 之后 VAD 缺失只让切分降级为固定窗口，转写照样出字，
 * 把它写成必需就是一盏假红灯。
 *
 * @returns 空字符串 = 够用；非空 = 缺什么（拿来当断言的 message，别只说 false）
 */
function whyNotTranscribeReady(models: CatalogModel[]): string {
  const asr = models.filter((m) => m.role === 'asr');
  if (asr.length === 0) {
    const roles = [...new Set(models.map((m) => m.role))].sort().join('/') || '（空集）';
    return `一个 role='asr' 的模型都没有（这一组里只有：${roles}）—— 装完仍然不能转写`;
  }
  const engines = new Set(asr.flatMap((m) => m.engines));
  if (engines.size === 0) return '有 ASR 模型但没有一个写了 engines，无法判断谁加载得了它';
  return '';
}

describe('T-149 ① 目录里的标签不许承诺一件不存在的事', () => {
  it('三份模型清单都通过 schema 校验，且模型数量够多到让后面的断言有意义', async () => {
    const models = await catalogModels();
    assert.ok(models.length >= 30, `目录里只有 ${models.length} 个模型，断言会失去意义`);
  });

  it('★ 每个出现在清单里的标签，都必须在 TAG_MEANINGS 里写明含义', async () => {
    const models = await catalogModels();
    const used = new Set(models.flatMap((m) => m.tags));
    // 集合非空守卫：筛空了的断言等于没写。
    assert.ok(used.size >= 15, `清单里只用到 ${used.size} 个标签，断言失去意义`);

    const undeclared = [...used].filter((t) => !(t in TAG_MEANINGS)).sort();
    assert.deepEqual(
      undeclared,
      [],
      '这些标签出现在目录里、却没有任何地方定义过它是什么意思 —— ' +
        `required-core 就是这么长出一句假承诺的：${undeclared.join(', ')}`,
    );
  });

  it('TAG_MEANINGS 里不许有清单中已经不存在的标签（这张表自己也会腐烂）', async () => {
    const models = await catalogModels();
    const used = new Set(models.flatMap((m) => m.tags));
    const stale = Object.keys(TAG_MEANINGS).filter((t) => !used.has(t)).sort();
    assert.deepEqual(
      stale,
      [],
      `这些标签只活在表里、清单里已经没有了。留着会让下一个人以为目录里还有这一类：${stale.join(', ')}`,
    );
  });

  it('★ 声称"这一组装完就够用"的标签，必须真的凑得出一条完整的转写链', async () => {
    const models = await catalogModels();
    const claiming = Object.entries(TAG_MEANINGS)
      .filter(([, v]) => v.claimsSufficiency)
      .map(([k]) => k);

    for (const tag of claiming) {
      const set = models.filter((m) => m.tags.includes(tag));
      assert.ok(set.length > 0, `标签 ${tag} 声称是一个可用集合，但清单里一个模型都没标它`);
      const why = whyNotTranscribeReady(set);
      assert.equal(why, '', `标签 ${tag} 说"装完就够用"，实际上：${why}`);
    }
    /*
     * ⚠️ 今天 `claiming` 是**空的**（`required-core` 已删，没有别的标签声称完整性）。
     * 空集会让上面这个 for 一条都不跑 —— 那正是本仓已经踩过四次的坑。
     * 所以判定函数本身的活性由下一条用例证明，它跑的是**事故当天的真实数据**。
     */
    assert.deepEqual(claiming, [], '有标签开始声称完整性了 —— 上面那段循环这时才真正开始工作');
  });

  it('★ 一比一复现：事故当天的 `required-core`（2 个 VAD / 0 个 ASR）必须被判为"不够用"', async () => {
    const models = await catalogModels();
    // 事故当天 required-core 标的就是这两个 —— 从真清单里按 id 取，不手写夹具。
    const asOfIncident = models.filter(
      (m) => m.id === 'vad/silero-vad-onnx' || m.id === 'vad/silero-vad-ggml',
    );
    assert.equal(asOfIncident.length, 2, '这两个 VAD 条目不见了，这条复现就落空了');

    const why = whyNotTranscribeReady(asOfIncident);
    assert.notEqual(why, '', '判定函数把"两个 VAD、零个 ASR"判成了够用 —— 那正是事故当天的假绿灯');
    assert.match(why, /role='asr'/, `判定理由要说清缺的是什么，实得：${why}`);

    // 反面：补上任意一个 ASR 之后必须判为够用，否则这个判定函数是"永远说不够"的死结论。
    const oneAsr = models.find((m) => m.role === 'asr' && m.engines.includes('whisper.cpp'));
    assert.ok(oneAsr, '目录里没有 whisper.cpp 的 ASR 模型');
    assert.equal(whyNotTranscribeReady([...asOfIncident, oneAsr]), '');
  });

  it('★ role=vad 的条目不许再被标成"必需"（T-148 之后缺 VAD 只降级，不致命）', async () => {
    const models = await catalogModels();
    const vad = models.filter((m) => m.role === 'vad');
    assert.ok(vad.length >= 2, `role=vad 只有 ${vad.length} 个，断言失去意义`);

    // 判据是"这个标签有没有声称完整性"，不是"名字里有没有 required" —— 钉后果不钉字面。
    const offenders = vad
      .flatMap((m) => m.tags.map((t) => ({ id: m.id, t })))
      .filter((x) => TAG_MEANINGS[x.t]?.claimsSufficiency === true)
      .map((x) => `${x.id}:${x.t}`)
      .sort();
    assert.deepEqual(
      offenders,
      [],
      `VAD 权重缺失只会让切分降级成固定窗口（vad.ts / vadStatus.ts），把它标成"装完就够用"是假承诺：${offenders.join(', ')}`,
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ② 镜像：列成"备份"的，必须真的是另一个来源
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * **实测记录**：这些主机名不是独立来源，它们会把请求送到右边那个主机上。
 *
 * | 主机 | 折叠到 | 证据 | 日期 |
 * |---|---|---|---|
 * | `hf-mirror.com` | `huggingface.co` | `HTTP/2 308` + `location: https://huggingface.co/…`；`/resolve/<40位sha>/`、`/resolve/main/`、`/api/models/`、仓库页四种路径全部如此 | 2026-08-06 |
 *
 * ⚠️ **这条记录成立的范围要说清楚**：测量点是一台**境外出口**的机器。
 * hf-mirror.com 首页自述是给「国内用户」用的公益镜像，`probe.ts` 的注释也写着它
 * 只把 **non-CN** 流量 308 回源。所以正确的说法是
 * 「**从境外出口看，它与 huggingface.co 是同一个来源**」——
 * 而不是「它是个假镜像」。清单里保留它是对的（国内用户真的靠它），
 * 但**不许把它算成一份冗余**：主源挂了、境外用户跟着挂。
 */
const ORIGIN_ALIASES: Readonly<Record<string, string>> = {
  'hf-mirror.com': 'huggingface.co',
};
const effectiveOrigin = (host: string): string => ORIGIN_ALIASES[host] ?? host;

/**
 * **只有一个独立来源的文件** —— 也就是"主源一挂就装不上"的那些。
 *
 * 这份清单是断言的对象，不是注释：多一个、少一个都会红，
 * 逼着改动的人当场回答「我是加了一条真镜像，还是把一条真镜像弄丢了」。
 * 上一次这件事没人回答，结果是 39 个 `hf-mirror` 条目被当成了 39 份备份。
 */
const SINGLE_ORIGIN_FILES: readonly string[] = [
  'asr/paraformer-zh-small  am.mvn  [huggingface.co]',
  'asr/paraformer-zh-small  model.int8.onnx  [huggingface.co]',
  'asr/paraformer-zh-small  tokens.txt  [huggingface.co]',
  'asr/sherpa-streaming-zh-14m  decoder-epoch-99-avg-1.int8.onnx  [huggingface.co]',
  'asr/sherpa-streaming-zh-14m  encoder-epoch-99-avg-1.int8.onnx  [huggingface.co]',
  'asr/sherpa-streaming-zh-14m  joiner-epoch-99-avg-1.int8.onnx  [huggingface.co]',
  'asr/sherpa-streaming-zh-14m  tokens.txt  [huggingface.co]',
  'asr/whisper-base-q8_0  ggml-base-q8_0.bin  [huggingface.co]',
  'asr/whisper-large-v2-q8_0  ggml-large-v2-q8_0.bin  [huggingface.co]',
  'asr/whisper-large-v3-turbo-f16  ggml-large-v3-turbo-encoder.mlmodelc.zip  [huggingface.co]',
  /*
   * ★ T-153：turbo 的 CoreML encoder 现在挂在**三个**量化档上（f16 / q5_0 / q8_0）。
   *
   * 这不是新增文件，是**同一个归档**（sha256、字节数、镜像全部逐字相同）挂到了另外两个条目上 ——
   * 上游拼 `.mlmodelc` 路径时会剥掉 `-qX_X` 后缀（`whisper.cpp:3336-3342`），
   * 所以一份 encoder 服务该模型的所有量化档。此前只有 f16 挂了它，而产品默认推荐的是
   * `whisper-large-v3-turbo-q5_0` —— **装了默认模型的 Mac 用户拿不到 ANE**。
   *
   * 它仍然是"只有一个来源"：那个 zip 在 ModelScope 上没有对应文件（`-q5_0` 的那份也是同一个），
   * 所以这两行是**新增的单来源条目**，不是丢了镜像。
   * （非 turbo 的 `ggml-large-v3-encoder.mlmodelc.zip` 有 hf + modelscope 两个来源，
   *  所以 `whisper-large-v3-q5_0` 挂上之后不会出现在这份清单里 —— 那正是这条断言的价值。）
   */
  'asr/whisper-large-v3-turbo-q5_0  ggml-large-v3-turbo-encoder.mlmodelc.zip  [huggingface.co]',
  'asr/whisper-large-v3-turbo-q8_0  ggml-large-v3-turbo-encoder.mlmodelc.zip  [huggingface.co]',
  'asr/whisper-large-v3-turbo-q8_0  ggml-large-v3-turbo-q8_0.bin  [huggingface.co]',
  'asr/whisper-medium-q8_0  ggml-medium-q8_0.bin  [huggingface.co]',
  'asr/whisper-small-q8_0  ggml-small-q8_0.bin  [huggingface.co]',
  'asr/whisper-tiny-q8_0  ggml-tiny-q8_0.bin  [huggingface.co]',
  'punctuation/ct-transformer-zh-en  model.onnx  [huggingface.co]',
  'punctuation/ct-transformer-zh-en  tokens.json  [huggingface.co]',
  'vad/silero-vad-onnx  silero_vad.onnx  [raw.githubusercontent.com]',
];

function originsOf(f: CatalogFile): string[] {
  return [...new Set(f.mirrors.map((m) => effectiveOrigin(new URL(m.url).hostname)))].sort();
}

describe('T-149 ② 清单里列成"备份"的来源，必须真的是另一个来源', () => {
  it('别名折叠：hf-mirror.com 与 huggingface.co 算同一个来源（实测 308，见上方记录）', () => {
    assert.equal(effectiveOrigin('hf-mirror.com'), effectiveOrigin('huggingface.co'));
    // 反面：真镜像不许被折叠掉，否则这条规则会把有效冗余也一起吃掉。
    assert.notEqual(effectiveOrigin('www.modelscope.cn'), effectiveOrigin('huggingface.co'));
    assert.notEqual(effectiveOrigin('raw.githubusercontent.com'), effectiveOrigin('huggingface.co'));
  });

  it('★ "只有一个来源"的文件清单必须与记录在案的逐字相同', async () => {
    const models = await catalogModels();
    const all = models.flatMap((m) => m.files.map((f) => ({ m, f })));
    assert.ok(all.length >= 40, `只数到 ${all.length} 个文件，断言失去意义`);

    const single = all
      .filter(({ f }) => originsOf(f).length <= 1)
      .map(({ m, f }) => `${m.id}  ${f.name}  [${originsOf(f).join()}]`)
      .sort();

    assert.deepEqual(
      single,
      [...SINGLE_ORIGIN_FILES],
      '「哪些文件没有备份」这件事变了。' +
        '多出来的 = 有人删掉/写错了一条真镜像；少掉的 = 加了一条真镜像（那就把它从清单里划掉）。' +
        '⚠️ 加一条 hf-mirror 是**不会**让文件从这份清单里消失的 —— 它折叠回 huggingface.co。',
    );
  });

  it('每个文件至少有一条来源，且 provider 与 URL 主机名对得上（写错了会挑到错的镜像）', async () => {
    const models = await catalogModels();
    const expectHost: Readonly<Record<string, RegExp>> = {
      hf: /^huggingface\.co$/,
      'hf-mirror': /^hf-mirror\.com$/,
      modelscope: /^(www\.)?modelscope\.cn$/,
      github: /^(github\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)$/,
    };
    let checked = 0;
    const bad: string[] = [];
    for (const m of models) {
      for (const f of m.files) {
        assert.ok(f.mirrors.length > 0, `${m.id} 的 ${f.name} 一条下载地址都没有`);
        for (const mi of f.mirrors) {
          const host = new URL(mi.url).hostname;
          const re = expectHost[mi.provider];
          if (!re) {
            bad.push(`${m.id}/${f.name}: 未知 provider ${mi.provider}`);
            continue;
          }
          if (!re.test(host)) bad.push(`${m.id}/${f.name}: provider=${mi.provider} 但 host=${host}`);
          checked += 1;
        }
      }
    }
    // 数了几个就说几个 —— 零个也能"全部通过"。
    assert.ok(checked >= 60, `只核对了 ${checked} 条镜像，说明筛选写错了`);
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  it('ModelScope 镜像的 URL 形状必须是 /models/<org>/<repo>/resolve/<rev>/<file>', async () => {
    const models = await catalogModels();
    const ms = models.flatMap((m) =>
      m.files.flatMap((f) =>
        f.mirrors.filter((x) => x.provider === 'modelscope').map((x) => ({ id: m.id, f, url: x.url })),
      ),
    );
    // 本轮新增 12 条 + 原有 14 条；少于 20 说明有人整批删了。
    assert.ok(ms.length >= 20, `ModelScope 镜像只有 ${ms.length} 条，断言失去意义`);
    for (const x of ms) {
      const p = new URL(x.url).pathname;
      assert.match(
        p,
        /^\/models\/[^/]+\/[^/]+\/resolve\/[^/]+\/.+$/,
        `${x.id} 的 ModelScope 地址形状不对：${x.url}`,
      );
      // 文件名必须落在路径末尾 —— 拼错了会 404，而 404 只在用户点下载时才看得见。
      assert.ok(
        decodeURIComponent(p).endsWith(`/${x.f.name}`),
        `${x.id} 的 ModelScope 地址末尾不是 ${x.f.name}：${x.url}`,
      );
    }
  });
});
