/**
 * 「这条笔记现在还重跑得了吗」——**唯一那份判据**（#95）。
 *
 * ─── 这个模块是为了消灭一句谎话而存在的 ───────────────────────────────────────────
 *
 * 在此之前，`GET /api/notes/:uid` 的 `canRetranscribe` 是这么算的：
 *
 * ```ts
 * canRetranscribe: repos.primarySourceOf(note.id)?.input_url != null
 * ```
 *
 * 也就是**只判这一列非空**，从不问「这个路径今天还打得开吗」。而
 * `media_sources.input_url` 存的是一个**绝对路径**，且全仓**没有任何一处**在数据目录
 * 搬家时更新它（`storage/move.ts` / `moveWithDb.ts` / `migrateAssets.ts` 里 grep
 * `input_url` 零命中 —— `migrateAssets` 只迁 `media_assets.rel_path`）。
 *
 * 于是搬完家的后果是一条**完整闭合、全程不报错**的链：
 *   ① 音频照播（`rel_path` 迁过了）→ 用户看不出有任何问题；
 *   ② `input_url` 仍指着老数据目录 → 但它"非空"，所以 `canRetranscribe` 恒 `true`；
 *   ③ 按钮**亮着**（`RetranscribeButton` 只在 `=== false` 时禁用）；
 *   ④ `POST …/retranscribe` 回 **202**，面板关闭，看起来"排上了"；
 *   ⑤ job 随后死在 `no media source can handle this input`。
 *
 * `[实测]` 这不是推演：demo 库（4 条笔记）里 note 1/2 的 `input_url` 分别指着
 * `/tmp/dd55/media/long.wav` 与 `/tmp/omdemo/jfk.wav`，两个都在当前数据目录之外，
 * 而它们的音频好好地躺在 `<dataDir>/media/` 里。**现在就是坏的。**
 *
 * ─── 判据必须"真去解析一次"，而不是只把字段迁一迁 ─────────────────────────────────
 *
 * 「字段非空」冒充「这条路走得通」是本仓这一周反复在治的同一个病
 * （「0 个包可用」其实是目录没读到；「CPU 不支持指令集」其实是从没查过；
 * 「这家没有模型」其实是断网/401）。只迁字段不改判据，换个形态它就会回来 ——
 * 用户手动删掉源文件、外置盘没挂上、把文件重命名，每一种都能重现同一句谎话。
 *
 * ─── 但"变灰"本身也可以是一句谎话，所以这里有第二档 ───────────────────────────────
 *
 * 只改判据不做别的，会把**一批本来重跑得了的笔记永久变灰** —— 因为那个源文件
 * 往往**就在库里**：转写跑完时 `transcribe.ts` 会把原件归档成 `role='original'`
 * 资产，而那一列**是**搬家时会被迁的（`migrateAssets.ts:312`）。
 * 也就是说「原始输入去哪了」这个问题，库里已经有答案了，只是没人去问。
 *
 * 所以判据分两档，顺序即优先级：
 *   ① `input_url` 本身还打得开 → 用它（与改动前**逐字节相同**的行为，零回归）；
 *   ② 打不开，但这条笔记的 `role='original'` 资产打得开 → **用那份归档原件**。
 * 两档都落空才判 `false`，并把**找过的每个位置**一起报出去。
 *
 * 这一档同时也是「已经坏掉的库怎么办」的答案：**不需要任何一次性 DB 修复**。
 * 上面那两条 demo 笔记走 ② 就自愈了，一个字节都不用写；而"搬家时迁 `input_url`"
 * 那条路反而更差 —— 它得再发明一份 old→new 的路径映射（而 `migrateAssets` 已经
 * 把等价的映射做对了一次），还得处理"迁不动怎么办"，并且会**抹掉一个事实**：
 * D-02 对 `input_url` 的定义是「用户原始输入」，覆写它就再也答不出用户当初给的是什么。
 *
 * ─── URL 一律放行，而且这不是偷懒 ─────────────────────────────────────────────────
 *
 * 链接类来源（`kind='url'`）**不做网络探测**：那会让一个笔记详情请求挂在别人的
 * 服务器上，而且断网/限流/防盗链都会被误报成"这条不能重跑"。
 * 我们不知道 = 不许替用户下结论（⑤A-20）。所以 URL 直接 `ok`，
 * 失败仍由 job 事后暴露 —— 这一档是**如实的"未知"**，不是"已验证可用"。
 *
 * ⚠️ 同理，第 ① 档也**不跑 ffprobe**：这里只回答"打得开吗"，不回答"解得了码吗"。
 * 后者是 runner 的活，在这里做等于把一次转码探测塞进详情接口。
 */
import { mediaAssetRoots, probeAssetFile } from '@openmemo/runtime';

import type { Repos } from '../db/repos.js';

/**
 * 「这串输入是链接还是本地路径」。
 *
 * 与 `rest/notes.ts` 导入分支用的是**同一个**判据（那里原来是行内正则，已改为引用这里）。
 * `packages/pipeline` 的 `LocalFileSource.match()` 里还有一份形状相同的正则 ——
 * 那一份**不能**合并过来：pipeline 不许反向依赖 daemon。两处若要改，必须一起改。
 */
export function looksLikeUrl(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
}

export interface RetranscribeSourceDeps {
  readonly repos: Pick<Repos, 'primarySourceOf' | 'assetsOfNote'>;
  /** 允许读取的根由它推出（`mediaAssetRoots`）—— 与播放端 / 自检同一份。 */
  readonly dataDir: string;
}

/** 能重跑：`input` 就是该喂给 runner 的那个值。 */
export interface RetranscribeSourceOk {
  readonly ok: true;
  readonly input: string;
  /**
   * `media_sources.kind`（`recording` / `local` / `url` …）原样带出。
   *
   * 带出来是为了让调用方**不必再查一次 `primarySourceOf`** —— 查第二次就得处理
   * "如果这次查不到怎么办"，而那个分支在 `ok === true` 时根本不可能发生，
   * 只能靠 `!` 或一个编出来的默认值糊过去。两种都是在类型上撒谎。
   */
  readonly sourceKind: string;
  /**
   * 这个 `input` 是从哪来的 —— 三档语义完全不同，调用方（和日志）必须能分辨：
   * · `sourceInput`   已核验：`input_url` 是本地路径且真的打开读到了字节
   * · `originalAsset` 已核验：`input_url` 打不开，退回了本笔记的归档原件
   * · `url`           **未核验**：链接类来源，我们刻意不做网络探测
   */
  readonly from: 'sourceInput' | 'originalAsset' | 'url';
}

/** 不能重跑：`message` / `messageZh` 可以直接给用户看。 */
export interface RetranscribeSourceBlocked {
  readonly ok: false;
  readonly code: 'NO_SOURCE_INPUT' | 'SOURCE_UNREADABLE';
  readonly message: string;
  readonly messageZh: string;
  /**
   * **找过的每个位置**。只报一句"读不到"时，用户无从判断到底是文件没了
   * 还是我们找错了地方 —— `/media/asset/:uid` 已经为同一课付过账（T-136）。
   */
  readonly tried: readonly string[];
}

export type RetranscribeSource = RetranscribeSourceOk | RetranscribeSourceBlocked;

/**
 * 解析这条笔记的重跑输入。
 *
 * 代价：最多两次 `probeAssetFile`（每次 = 若干 `open()` + 读 4 字节）。
 * **刻意不缓存**：这个问题的答案随时会变（用户删文件、插拔外置盘），
 * 缓存一个"曾经能开"的结论，就是把这次要消灭的那句谎话换个地方再说一遍。
 *
 * ⚠️ 这个函数只在 `GET /api/notes/:uid`（**单条**笔记）和重跑端点里调。
 * `canRetranscribe` 不在 `NoteListItem` 上（列表走 `notes.ts` 的 `listNotes` 分支，
 * 不含此字段），所以这里的磁盘 IO **不会**落到笔记列表上 —— 列表接口一次都不调它。
 * 将来若有人想把这个字段加进列表，请先解决"N 条笔记 = N 次探测"，别直接搬。
 */
export async function resolveRetranscribeSource(
  deps: RetranscribeSourceDeps,
  noteId: number,
): Promise<RetranscribeSource> {
  const src = deps.repos.primarySourceOf(noteId);
  const input = src?.input_url;
  if (input == null || input.length === 0) {
    return {
      ok: false,
      code: 'NO_SOURCE_INPUT',
      message: 'this note has no recorded source input',
      messageZh: '这条笔记没有记录原始输入，无法重跑。',
      tried: [],
    };
  }

  const sourceKind = src?.kind ?? 'local';

  // 链接：不做网络探测（见文件头）。这一档是"未知"，不是"已验证"。
  if (looksLikeUrl(input)) return { ok: true, input, from: 'url', sourceKind };

  const roots = mediaAssetRoots(deps.dataDir);

  /*
   * ① 用户当初给的那个路径还打得开吗。
   *
   * 用 `probeAssetFile` 而不是 `existsSync`/`access`：判据必须是**真的打开读到字节**
   * （空文件 `bytesRead === 0` 转不了，悬空软链 `access` 也可能说"能"）。
   * 而且这三个根 `[<dataDir>/media, <dataDir>/tmp, <dataDir>]` 与
   * `LocalFileSource` 的 `allowedRoot = paths.dataDir` 是同一个范围 ——
   * 换句话说：这里说"能读"，runner 待会儿就真读得到，不是两套标准。
   */
  const direct = await probeAssetFile(roots, input);
  if (direct.abs !== null && direct.bytesRead > 0) {
    return { ok: true, input: direct.abs, from: 'sourceInput', sourceKind };
  }

  /*
   * ② 退回本笔记的归档原件。
   *
   * 取 `role='original'` 的**第一条**（`assetsOfNote` 按 id 升序）——
   * 与前端 `noteAssets.ts` 的 `pickByRole` 用 `.find()` 取第一条是同一条规矩：
   * 万一哪天真长出重复的 original，两边必须指向同一个，否则"界面在播 A、重跑读 B"。
   */
  const original = deps.repos.assetsOfNote(noteId).find((a) => a.role === 'original');
  if (original !== undefined) {
    const archived = await probeAssetFile(roots, original.rel_path);
    if (archived.abs !== null && archived.bytesRead > 0) {
      return { ok: true, input: archived.abs, from: 'originalAsset', sourceKind };
    }
    return blocked(input, [...direct.tried, ...archived.tried], direct, archived);
  }

  return blocked(input, [...direct.tried], direct, undefined);
}

/**
 * 把两次探测的结论合成一句**用户看得懂、而且能拿去核对**的话。
 *
 * 判据不是"好听"，是"照着它能自己确认一遍" —— 所以原始输入、找过的位置、
 * 以及探测器给的 errno / 越界原因都要在里面。
 */
function blocked(
  input: string,
  tried: readonly string[],
  direct: { readonly note: string; readonly escaped: readonly string[] },
  archived: { readonly note: string; readonly escaped: readonly string[] } | undefined,
): RetranscribeSourceBlocked {
  const escaped = [...direct.escaped, ...(archived?.escaped ?? [])];
  /*
   * 越界与"文件不在"是两码事，**不许混报**（同 `/media/asset/:uid` 的分档）：
   * 越界时文件明明在，只是不许从那里读；说成"文件没了"就是替用户下了个假诊断。
   */
  if (escaped.length > 0) {
    return {
      ok: false,
      code: 'SOURCE_UNREADABLE',
      message:
        `the source of this note is outside the data directory (a symlink on its path ` +
        `points out of it): ${escaped.join(', ')}`,
      messageZh: `这条笔记的源文件在数据目录之外（路径上的符号链接指了出去）：${escaped.join('、')}`,
      tried,
    };
  }

  const where =
    tried.length === 0
      ? 'no candidate path fell inside the data directory'
      : `tried: ${tried.join(', ')}`;
  const whereZh =
    tried.length === 0 ? '没有任何候选路径落在数据目录内' : `找过：${tried.join('、')}`;

  /*
   * 把"这条笔记连归档原件都没有"单独说出来 —— 它与"有原件但也读不到"的处置不同：
   * 前者只能重新导入，后者多半是文件被删/盘没挂上，接回去就好了。
   */
  const noArchive = archived === undefined;

  return {
    ok: false,
    code: 'SOURCE_UNREADABLE',
    message:
      `the recorded source input can no longer be read: ${input} (${direct.note}); ` +
      (noArchive
        ? 'and this note has no archived original asset to fall back on'
        : `the archived original could not be read either (${archived.note})`) +
      `. ${where}. The most likely cause is that the data directory was moved: ` +
      `media_sources.input_url is an absolute path and nothing migrates it.`,
    messageZh:
      `记录的原始输入已经读不到了：${input}（${direct.note}）；` +
      (noArchive ? '而这条笔记没有可回退的归档原件。' : `归档原件也读不到（${archived.note}）。`) +
      `${whereZh}。最可能的原因是数据目录搬过家：` +
      `media_sources.input_url 存的是绝对路径，而没有任何迁移会更新它。`,
    tried,
  };
}
