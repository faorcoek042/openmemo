/**
 * 数据目录的**定义 / 修改 / 移动**（用户点名的「空间管理」）。
 *
 * 路径名与 `architect` 的设置页对齐：`GET|POST /api/settings/data-dir`。
 * 他刻意没有猜着接、让 404 可见 —— 这是对的，所以这里按他建好的那个路径实现。
 *
 * ## 权威来源
 * **路径的唯一权威是 daemon**。前端不许自己拼 `~/.local/share/openmemo` ——
 * 那样一旦用户搬过家，界面显示的位置就是错的，而且没有任何报错。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AppPaths } from '../../config/paths.js';
import { pointerFile, writeDataDirPointer } from '../../config/paths.js';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DatabaseHandle } from '@openmemo/db';

import { migrateMediaAssets } from '../../storage/migrateAssets.js';

import { looksLikeDataDir, measureTree, moveDataDir, planMove } from '../../storage/move.js';
import { moveDataDirWithDatabase } from '../../storage/moveWithDb.js';
import { readJsonBody, sendError, sendJson } from '../respond.js';

export interface StorageRoutesDeps {
  readonly paths: AppPaths;
  /** 搬家后要就地迁 `media_assets` 的路径引用。 */
  readonly db: DatabaseHandle;
  /** 有任务在跑就不能搬 —— 搬到一半任务还在写文件，必然不一致。 */
  readonly runningJobs: () => number;
  /**
   * 搬迁前关库、搬迁后重开。**必填，不给可选兜底。**
   *
   * `[CI 实测 run 31296921806]` Windows 的 SQLite 共享模式不含 `FILE_SHARE_DELETE`，
   * 开着库搬 ⇒ 删源**必然**失败 ⇒ 用户每次搬迁都留下一份含明文 `secrets.json` 的旧目录。
   *
   * 为什么不设成可选：可选就意味着存在一条"没注入时照旧开着库搬"的路径，
   * 而它平时在 POSIX 上**完全看不出区别** —— 正是本仓反复栽的那种
   * 「写了但从没触发 / 触发了也没人发现」的形状。必填让漏接线变成编译错误。
   */
  readonly closeDatabase: () => void;
  /** 在指定 dataDir 重新打开库，返回新句柄（搬完要用它迁 `media_assets`）。 */
  readonly reopenDatabase: (dataDir: string) => DatabaseHandle;
  /** 搬完要重启才能挂到新位置（复用 T-061 的自我重启）。 */
  readonly requestRestart?: (reason: string, opts?: { dataDir?: string }) => void;
}

/**
 * 每个子目录**是干什么的** —— 用户要"描述清楚"才敢删。
 *
 * ## T-135：`purpose` / `purposeZh` **必须成对**
 *
 * 这里原来只有 `purposeZh` 一份。后果不在 daemon 这边，在界面上：
 * `/settings` 跑完 i18n 之后，英文界面上**仍然剩着 81 个汉字**，逐条追下去
 * 全部来自这个函数 —— 前端拿不到英文，**没有任何可回落的东西**，
 * 它既不能翻译也不能省掉（少了这句用户就不知道哪个目录能删）。
 *
 * 仓库里既有的做法本来就是成对的：`vendor/manifests/*.json` 的
 * `displayName` / `displayNameZh`、模型的 `descriptionEn` / `descriptionZh`，
 * 前端用 `lib/format/localized.ts` 的 `pickLocalized()` 挑一份。
 * 这条只是把 `purpose` 补齐，让它落进同一套。
 *
 * ⚠️ 判据是「**这段文字描述的是内容**」，不是「这段文字里有汉字」：
 * 语言切换器里的选项名「中文」**本来就该是中文**（语言名用它自己的语言写），
 * 那不是缺陷，不要顺手"修"掉。
 */
export function layout(paths: AppPaths): Array<Record<string, string>> {
  return [
    {
      path: paths.dbFile,
      name: 'openmemo.db',
      purpose: 'Notes, transcripts, tags and mindmaps (the main SQLite database)',
      purposeZh: '笔记、转写稿、标签、导图（SQLite 主库）',
    },
    {
      path: paths.mediaDir,
      name: 'media',
      purpose: 'Original audio/video you imported or recorded',
      purposeZh: '导入与录制的音视频原件',
    },
    {
      path: paths.modelsDir,
      name: 'models',
      purpose: 'Downloaded models and backend packs (can be downloaded again)',
      purposeZh: '下载的模型与后端包（可重新下载）',
    },
    {
      path: paths.logsDir,
      name: 'logs',
      purpose: 'Runtime logs (safe to delete at any time)',
      purposeZh: '运行日志（可随时删）',
    },
    {
      path: paths.tmpDir,
      name: 'tmp',
      // 说"可随时删"必须是真的：转写产物现在会**归档进 media/**，
      // 不再有已入库的资产留在这里（此前留了，照这句话删就会删掉笔记的音频）
      purpose: 'Scratch files from transcription (safe to delete; holds no stored assets)',
      purposeZh: '转写过程的临时文件（可随时删，不含已入库资产）',
    },
    {
      path: paths.backupsDir,
      name: 'backups',
      purpose: 'Database backups',
      purposeZh: '数据库备份',
    },
    {
      path: paths.runtimeDir,
      name: 'runtime',
      purpose: 'Runtime state and the access token',
      purposeZh: '运行时状态与访问令牌',
    },
  ];
}

/**
 * 数据目录**外面**还有哪些文件属于本程序 —— 用户要"删干净"就必须知道它们。
 *
 * ## 为什么单独抽成函数
 *
 * 与 `layout()` 同一个理由：这段文字是「删数据目录时还要删什么」的唯一答案，
 * 抽出来才能被 `storageLayout.test.ts` 的**中英成对**断言守住。
 * 只有中文一份时英文界面拿不到任何可回落的东西 —— 前端既不能翻译
 * （路径随 dataDir 变，权威在 daemon），又不能省掉（省掉的代价见 `riskZh`：
 * 用户删了数据目录却留下指针，daemon 下次启动按它去建空目录，表现为"笔记全没了"）。
 *
 * ⚠️ 这个字段 daemon 一直在返回，但前端的响应类型里**根本没有它** ——
 * 也就是说这条警告写出来之后从来没有到达过任何一个用户。本轮一并接上。
 */
export function externalFiles(): Array<Record<string, string>> {
  return [
    {
      path: pointerFile(),
      purpose: 'Pointer file recording where the data directory was moved to',
      purposeZh: '记录"数据目录搬到哪了"的指针文件',
      whyOutside:
        'It must live **outside** the data directory — put it inside and it would move along with the data, after which the new location could never be found again.',
      whyOutsideZh:
        '它必须在数据目录**外面** —— 放进去就会跟着一起搬走，搬完就再也找不到新位置了。',
      risk: 'If it points at a directory you have deleted, the daemon will **recreate an empty directory at that missing location** on its next start (including self-restart), which looks exactly like "all my notes are gone". Delete this file together with the data directory.',
      riskZh:
        '如果它指向一个已被删除的目录，daemon 下次启动（含自我重启）会**按它去那个不存在的位置建空目录**，表现为"笔记全没了"。删除数据目录时请连同它一起删。',
    },
  ];
}

/** 本端点认识的**全部**请求字段。多一个都要当场报错 —— 理由见 `parseChangeRequest`。 */
const KNOWN_FIELDS = new Set(['path', 'moveExisting', 'move', 'dryRun']);

export type ChangeRequest =
  | { readonly ok: true; readonly move: boolean; readonly dryRun: boolean }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly messageZh: string;
    };

/**
 * 「要不要把现有数据一起搬过去」—— 这个选择的**唯一解析点**。
 *
 * ## 它修的是什么（实测，不是推断）
 *
 * 前端一直发 `moveExisting`，这里一直读 `move`，**两个名字从来没有对上过**。
 * 而缺省是 `body?.move !== false`，也就是**字段缺席 = 搬**。合起来的后果实测如下：
 *
 * | 用户在界面上做的事 | 请求体 | 实际发生 |
 * |---|---|---|
 * | 取消勾选「把现有数据一并移动过去」后点应用 | `{path, moveExisting:false}` | **202 `moved:true`，源目录被清空**，`openmemo.db` / `secrets.json` / 媒体全部 `rename` 到新位置 |
 * | 勾选着点应用 | `{path, moveExisting:true}` | 同上，**逐字节一模一样** |
 *
 * 也就是说那个复选框**在传输层上根本不存在**：勾与不勾产生同一个请求结果。
 * 用户以为自己选了「只改指向」，系统做的是「搬走几十 GB 且不可逆」。
 * （另一条路径：错误提示里那个「直接使用此目录」按钮发的也是 `moveExisting:false`，
 * 它在 `TARGET_ALREADY_DATA_DIR` 那道闸上被挡回来 → 反复 409，
 * 按钮**永远点不成**。同一个键名错误，两种截然不同的症状。）
 *
 * ## 三条规则，以及为什么是这三条
 *
 * **① 缺省 = 不搬。** 判据是**两种缺省的失败代价不对称**：
 * 缺省不搬，最坏结果是指针指向一个不是数据目录的地方 → 下面 `NOT_A_DATA_DIR`
 * 当场 409，**一个字节都没动**，用户重发一次即可；
 * 缺省搬，最坏结果是几十 GB 跨盘搬迁 + 数据库路径改写 + 强制重启，
 * 而且它连"原样搬回去"都做不到（实测目标目录会多出 `openmemo.db-wal` / `-shm`）。
 *
 * 更关键的一层：**缺省值决定了「键名写错」这个 bug 是一份缺陷报告还是一次数据事故。**
 * 同样这个错误，在「缺省不搬」下的表现是：用户勾着框点应用，却看到
 * 「已记录新位置（未搬运数据）」—— 不对，但**可见、可逆、当天就会被报上来**。
 * 在「缺省搬」下它安静了不知道多久，`docs/DEPLOYMENT.md` 与两份 inbox 里
 * 甚至留着「`moveExisting:true` 搬迁成功」的记录 —— 那几次成功**全是靠缺省蒙对的**，
 * 字段一次都没被读到过。
 *
 * ⚠️ 这与界面复选框默认**勾着**并不矛盾，别把两者"统一"掉：
 * 界面每次都**显式**发这个字段，缺省值管的是「没人表达过意图」的情形，
 * 而那正是绝不该替用户做不可逆决定的时刻。
 *
 * **② 认识但形状不对 → 400，不猜。** `moveExisting:"false"`（字符串）在旧写法下
 * 是"搬"（因为它 `!== false`）。一个拼错的值不许被解释成破坏性的那一档。
 *
 * **③ 不认识的字段 → 400。** 这条才是真正治本的：本 bug 的形状是
 * **"一边写、一边不读，而且没有任何人会知道"**。字段名一旦写错，
 * 在宽松解析下等价于"用户什么都没说"，于是缺省值替他做了决定。
 * 严格解析把它变成传输层上的一声硬报错 —— 意图送不到，就绝不假装送到了。
 * 只对本端点做（它是全仓唯一一个会不可逆地动用户全部数据的写端点），
 * 不推广成全局规则。
 */
export function parseChangeRequest(body: unknown): ChangeRequest {
  const rec = (body ?? {}) as Record<string, unknown>;

  const unknown = Object.keys(rec).filter((k) => !KNOWN_FIELDS.has(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      code: 'UNKNOWN_FIELD',
      message: `unknown field(s): ${unknown.join(', ')}`,
      messageZh:
        `请求里有本端点不认识的字段：${unknown.join('、')}。` +
        `这里刻意不忽略它 —— 忽略一个写错名字的字段，等于让缺省值替你决定要不要搬运数据。`,
    };
  }

  if ('dryRun' in rec && typeof rec['dryRun'] !== 'boolean') {
    return {
      ok: false,
      code: 'BAD_DRY_RUN',
      message: 'dryRun must be a boolean',
      messageZh: 'dryRun 必须是布尔值。',
    };
  }

  /*
   * `move` 是**旧别名**：daemon 自己的 `TARGET_ALREADY_DATA_DIR` 补救载荷一直发它。
   * 留着是为了不在修这个 bug 的同时制造同一个 bug（把一个真有人发的字段悄悄丢掉）。
   * 新代码一律用 `moveExisting` —— 它是 `docs/DEPLOYMENT.md`、界面状态与本仓
   * 各份实测记录共用的那个名字。
   */
  const hasNew = 'moveExisting' in rec;
  const hasOld = 'move' in rec;
  for (const k of ['moveExisting', 'move'] as const) {
    if (k in rec && typeof rec[k] !== 'boolean') {
      return {
        ok: false,
        code: 'BAD_MOVE_FLAG',
        message: `${k} must be a boolean, got ${typeof rec[k]}`,
        messageZh: `${k} 必须是布尔值（收到的是 ${typeof rec[k]}）。这里不做真值转换：一个写错的值不该被当成"搬运"。`,
      };
    }
  }
  if (hasNew && hasOld && rec['moveExisting'] !== rec['move']) {
    return {
      ok: false,
      code: 'CONFLICTING_MOVE_FLAG',
      message: `moveExisting=${String(rec['moveExisting'])} conflicts with move=${String(rec['move'])}`,
      messageZh: 'moveExisting 与旧别名 move 给了相反的值，无法判断你要哪个。请只发 moveExisting。',
    };
  }

  return {
    ok: true,
    // ★ 缺省 false：没有表达过的意图，绝不解释成"搬"
    move: hasNew ? (rec['moveExisting'] as boolean) : hasOld ? (rec['move'] as boolean) : false,
    dryRun: rec['dryRun'] === true,
  };
}

/**
 * 搬完之后给用户的那句话。**纯函数**，因为它是"界面说的和实际发生的一致吗"
 * 这条判据的唯一落点，而那条判据值得被单独测。
 *
 * ## 为什么它不能恒说"已移动"
 *
 * `[CI 实测 2026-08-08 run 31250730491，windows-2025]`：复制路径走完之后
 * `fs.rm(from)` 失败了（Windows 删不掉仍被 daemon 打开的 `openmemo.db`），
 * 而这里照旧回「已移动 54 个文件到新位置」——
 * 数据其实**被复制了一份留在原地**，其中包含**明文的 `secrets.json`**。
 * 用户据此以为旧位置已经空了。
 *
 * Manager 2026-08-08 裁定：判据**不是**"让 Windows 也用 rename"
 * （跨卷 rename 本来就会失败，`copy` 是必要退路），
 * 判据是**"界面说的和实际发生的必须一致"**。两条路都可接受：
 * 复制完真的删掉源，或者如实说"已复制，源目录仍在，需要你确认后删除"。
 * 这里选后者 —— 删源发生在**逐文件校验**（`verifyTreesMatch`：路径集合 +
 * 文件字节数 + 符号链接目标）之后，删不掉时不再赌第二次，
 * 而是把旧目录的位置原样交还给用户。
 */
export function moveMessageZh(
  result: {
    files: number;
    links: number;
    sourceRemoved: boolean;
    sourceResidue?: readonly string[];
  },
  from: string,
): string {
  const what = `${result.files} 个文件` + (result.links > 0 ? `与 ${result.links} 个符号链接` : '');
  if (result.sourceRemoved) return `已移动 ${what}到新位置，正在重启以生效。`;
  /*
   * ★ 旧目录里剩什么，**必须照着念，不许照着猜**。
   *
   * 这句原来无条件写着「其中包含 secrets.json」。
   * `[CI 实测 2026-08-09 run 31296921806, windows-2025]` 删源是**删到一半**失败的：
   * 实际剩下的是 `models` 与 `openmemo.db`，**`secrets.json` 已经被删掉了**。
   * 方向虽然保守，**但保守的假话仍然是假话** —— 它会让用户去找一个不在那里的文件，
   * 然后开始怀疑别的提示是不是也在瞎说。
   *
   * 判据仍是 Manager 2026-08-08 那条：**界面说的和实际发生的必须一致**。
   */
  const residue = result.sourceResidue ?? [];
  const tail =
    residue.length > 0
      ? `**里面还剩下：${residue.join('、')}**，请自行确认后删除。` +
        (residue.includes('secrets.json')
          ? '（`secrets.json` 是明文的 API Key，注意别外传。）'
          : '')
      : `目录本身还在，但里面已经空了。`;
  return (
    `已复制 ${what}到新位置并逐文件校验通过，正在重启以生效。` +
    `⚠️ 旧目录 ${from} **没能删掉，仍留在原地**。${tail}`
  );
}

export function createStorageRoutes(deps: StorageRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  return {
    async handle(req, res, url, method): Promise<boolean> {
      if (url.pathname !== '/api/settings/data-dir') return false;

      // ---- 定义：当前在哪、每个子目录干什么、各占多大 ----
      if (method === 'GET') {
        let usage: { bytes: number; files: number } | null = null;
        try {
          usage = await measureTree(deps.paths.dataDir);
        } catch {
          /* 读不到就报 null，不猜 */
        }
        /*
         * **逐目录统计**：用户要的"统计大小"不是一个总数就够了 ——
         * 只给总数，他知道"占了 3GB"却不知道该删哪个；
         * 而这几个目录的可删性差别极大（models 可重新下载、logs/tmp 随便删、
         * openmemo.db 是全部笔记）。没有分解就等于没有可操作性。
         * 成本很低：这个端点只在设置页打开时调一次，实测 421MB 的 models 目录瞬时返回。
         */
        const entries = await Promise.all(
          layout(deps.paths).map(async (e) => {
            try {
              const st = await stat(e['path'] as string);
              if (st.isDirectory()) {
                const m = await measureTree(e['path'] as string);
                return { ...e, bytes: m.bytes, files: m.files };
              }
              return { ...e, bytes: Number(st.size), files: 1 };
            } catch {
              // 目录还不存在（没用过这个功能）→ 如实报 0，而不是省掉字段
              return { ...e, bytes: 0, files: 0 };
            }
          }),
        );
        sendJson(res, 200, {
          dataDir: deps.paths.dataDir,
          /*
           * 「自包含」要说得**准**：几乎全部数据都在这个目录里，但有**一个必须在外面**的例外。
           * 只说 true 而不列出它，用户删完数据目录仍会被那个残留文件影响。
           */
          selfContained: true,
          externalFiles: externalFiles(),
          noteZh:
            '这是一个独立文件夹，删除它不会影响程序本体运行（下次启动会重建空目录）。' +
            '但请注意 externalFiles 里列出的那个指针文件也需要一并删除。',
          usage,
          entries,
        });
        return true;
      }

      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET or POST', '方法不允许');
        return true;
      }

      // ---- 修改 / 移动 ----
      const body = (await readJsonBody(req).catch(() => undefined)) as
        { path?: unknown; moveExisting?: unknown; move?: unknown; dryRun?: unknown } | undefined;

      /*
       * ★ 先校验**信封**，再校验 path。
       *
       * 顺序是有意的：「你发的字段我不认识」是对整个请求的判断，
       * 而它恰恰是本 bug 的形状 —— 字段名写错时，宽松解析会让请求
       * "看起来完全合法"，然后由缺省值替用户做掉那个不可逆的决定。
       */
      const parsed = parseChangeRequest(body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.code, parsed.message, parsed.messageZh);
        return true;
      }

      const target = typeof body?.path === 'string' ? body.path.trim() : '';
      if (!target) {
        sendError(res, 400, 'BAD_REQUEST', 'path is required', '请提供新的数据目录路径');
        return true;
      }

      const plan = planMove(deps.paths.dataDir, target);
      if (!plan.ok) {
        sendError(
          res,
          400,
          'INVALID_TARGET',
          plan.reason ?? 'invalid',
          plan.reasonZh ?? '目标路径不合法',
        );
        return true;
      }

      /*
       * 试算：只回计划，不动任何文件。
       * `willMove` **必须回**：试算的全部意义就是让调用方在动手之前看见
       * "这一发到底会不会搬"，而那正是本轮修的那件事。
       */
      if (parsed.dryRun) {
        sendJson(res, 200, {
          ok: true,
          dryRun: true,
          from: plan.from,
          to: plan.to,
          willMove: parsed.move,
        });
        return true;
      }

      /*
       * 在途任务：**有任务在跑就拒绝**。
       *
       * 也可以像 T-054 那样把它们置回 `queued` 再搬，但那样要先停 scheduler、
       * 等 whisper 子进程真的退出、还要保证没有半写的分片文件 ——
       * 在"搬用户全部数据"这件事上，**多等几分钟远比多一条竞态路径便宜**。
       * 所以这里选择直接拒绝并告诉用户还剩几个任务。
       */
      const running = deps.runningJobs();
      if (running > 0) {
        sendError(
          res,
          409,
          'JOBS_RUNNING',
          `${running} job(s) still running`,
          `还有 ${running} 个任务在进行中，请等它们完成或暂停后再移动数据目录`,
        );
        return true;
      }

      const doMove = parsed.move; // 见 parseChangeRequest：缺省 false（没表达过的意图不解释成"搬"）

      if (!doMove) {
        /*
         * 只改指向也要**先确认那边真的是我们的数据目录**。
         * 指向一个随便的空目录，daemon 下次启动会在那儿建一套全新的空库，
         * 用户看到的就是"笔记全没了"（他的数据其实还在旧位置，但没人告诉他）。
         */
        if (!(await looksLikeDataDir(plan.to))) {
          sendError(
            res,
            409,
            'NOT_A_DATA_DIR',
            `${plan.to} does not contain openmemo.db`,
            '该目录里没有 openmemo.db，不是一个 OpenMemo 数据目录。直接指过去会得到一个空的新库（原数据仍在旧位置）。',
          );
          return true;
        }
        writeDataDirPointer(plan.to);
        sendJson(res, 202, {
          ok: true,
          moved: false,
          from: plan.from,
          to: plan.to,
          restartRequired: true,
          messageZh: '已记录新位置（未搬运数据）。重启后生效。',
        });
        // 迁移场景：**显式**告诉重启走新路径，不让它去猜指针
        setTimeout(() => deps.requestRestart?.('data-dir changed', { dataDir: plan.to }), 50);
        return true;
      }

      /*
       * ---- 「目标非空」必须分成两种，不能一律硬拒 ----
       *
       * 用户实际撞到的场景：他**上一次迁移已经成功了**，数据就在那边；
       * 界面还显示旧路径，于是他又点了一次同样的迁移 → 目标非空 → 409，
       * 而文案还说"原数据完好" —— 他完全不知道数据其实早就过去了。
       *
       * 所以：目标如果**就是一个有效的 OpenMemo 数据目录**，那不是错误，
       * 是"你已经搬过了"，应该给他「直接使用此目录」；
       * 目标如果装着**别的东西**，才是真的要拦（保护他的文件）。
       */
      if (await looksLikeDataDir(plan.to)) {
        sendError(
          res,
          409,
          'TARGET_ALREADY_DATA_DIR',
          `${plan.to} already contains an OpenMemo data directory`,
          '该位置已经是一个 OpenMemo 数据目录（很可能你上次已经迁移成功了）。可以直接使用它，无需再次搬运。',
          {
            retryable: false,
            remediation: {
              action: 'useExistingDataDir',
              // UI 点「直接使用此目录」时按这个再发一次即可
              // params 只能是标量：把"怎么再发一次"表达成扁平字段
              //
              // ★ 这里原本发的是 `move: false`，而前端一直发 `moveExisting` ——
              // 于是这个补救载荷把**第三个名字**引进了同一件事。实测后果：
              // 前端原样转发 `moveExisting:false` → 解析不到 → 缺省 true → 又撞回
              // 上面这道 `TARGET_ALREADY_DATA_DIR` 闸 → **同一个 409 无限循环**，
              // 这个按钮从上线起就没有成功过一次。名字统一到 `moveExisting`。
              params: { path: plan.to, moveExisting: false, endpoint: '/api/settings/data-dir' },
              label: 'Use this directory',
              labelZh: '直接使用此目录',
            },
          },
        );
        return true;
      }

      /*
       * 目标非空、而且**不是**我们的目录 —— 拒绝，但要说清楚拦的是什么。
       * 通用的"新位置已存在且不是空目录"没告诉用户里面是啥，
       * 他会以为是我们的残留而去手动删掉，那可能删的是他自己的文件。
       */
      try {
        const existing = await readdir(plan.to);
        if (existing.length > 0) {
          const sample = existing.slice(0, 3).join('、');
          sendError(
            res,
            409,
            'TARGET_NOT_EMPTY',
            `${plan.to} is not empty and is not an OpenMemo data directory`,
            `新位置里已经有别的内容（例如：${sample}${existing.length > 3 ? ' 等' : ''}），` +
              `而且它不是 OpenMemo 数据目录。为避免覆盖你自己的文件，这里不做搬运。` +
              `请换一个空目录，或先手动清空它。原数据完好，未做任何改动。`,
          );
          return true;
        }
      } catch {
        /* 目标不存在 = 最好的情况，继续搬 */
      }

      /*
       * ★★ 搬迁**必须在库关着的时候**进行 —— 否则 Windows 上删不掉源。
       *
       * `[CI 实测 run 31296921806, windows-2025]` 搬迁本身在 Windows 上没问题
       * （同卷真 rename、跨卷真删源）；出问题的是**谁还攥着 `openmemo.db`**：
       * POSIX 允许 unlink 已打开的文件，Windows 的 SQLite 共享模式不含
       * `FILE_SHARE_DELETE`。所以此前"开着库搬"在 Linux/macOS 上毫无症状，
       * 而 **Windows 用户每一次搬迁都必然留下一份旧数据**。
       *
       * 顺序编排（含"失败要把库开回原位"）抽在 `moveWithDb.ts`，那里有穷举测试 ——
       * 危险的不是搬迁，是搬迁失败之后库还开不开得起来。
       */
      let dbAfterMove = deps.db;
      const outcome = await moveDataDirWithDatabase(plan.from, plan.to, {
        closeDb: deps.closeDatabase,
        reopenDb: (dir) => {
          dbAfterMove = deps.reopenDatabase(dir);
        },
        move: () => moveDataDir(plan.from, plan.to),
        succeeded: (r) => r.ok,
      });

      /*
       * 库彻底开不回来 —— 唯一一个"用户必须重启才能继续"的状态。**不许静默。**
       * 这时不谈搬迁成没成功，先把这件事说清楚。
       */
      if (outcome.databaseLost) {
        sendError(
          res,
          500,
          'DATABASE_REOPEN_FAILED',
          `database could not be reopened: ${outcome.reopenError ?? outcome.closeError ?? 'unknown'}`,
          `数据库在搬迁后没能重新打开（${outcome.reopenError ?? outcome.closeError ?? '原因未知'}）。` +
            `**你的数据没有丢**，但这个进程已经用不了了，请重启 OpenMemo。`,
        );
        deps.requestRestart?.('database reopen failed', { dataDir: plan.from });
        return true;
      }

      // 关库就失败 ⇒ 根本没搬。如实说"没动过"。
      if (!outcome.attempted) {
        sendError(
          res,
          409,
          'DB_CLOSE_FAILED',
          `cannot close database: ${outcome.closeError ?? 'unknown'}`,
          `搬迁前没能关闭数据库（${outcome.closeError ?? '原因未知'}），因此**没有做任何搬迁** ——` +
            `原数据完好，未做任何改动。请先停掉正在进行的操作再试。`,
        );
        return true;
      }

      const result = outcome.result;
      if (result === undefined || !result.ok) {
        sendError(
          res,
          409,
          'MOVE_FAILED',
          result?.error ?? outcome.moveError ?? 'move failed',
          // sourceIntact 必须如实回报 —— 用户最关心的就是"我的数据还在吗"
          `${result?.errorZh ?? '移动失败'}${result?.sourceIntact ? '（原数据完好，未做任何改动）' : ''}`,
        );
        /*
         * ★ 库已经在原位置重开了（`moveWithDb` 保证），但**本进程里还有 11 处
         *   持有旧句柄的消费方**（Repos / JobQueue / MindMapRepo 都缓存了 prepared
         *   statement），它们手上那个已经作废了。只有重启才能把它们全部重建。
         *   所以失败路径也要重启 —— 回到**原来的** dataDir。
         */
        deps.requestRestart?.('data-dir move failed, reopening at original location', {
          dataDir: plan.from,
        });
        return true;
      }

      /*
       * ★ 搬完文件**必须同时迁数据库里的引用** —— 迁移是「文件 + 记录」一件事。
       *
       * 只搬文件的后果实测过：文件到了新家，`media_assets.rel_path` 还指着老家的
       * 绝对路径；随后有人清理旧目录，用户的录音就真的没了，而且不报错。
       * 这里在**重启之前**就地迁好，新进程起来读到的已经是正确路径。
       */
      try {
        // ★ 用**重开之后**的句柄：`deps.db` 已经在搬迁前被关掉了
        const am = await migrateMediaAssets(dbAfterMove, plan.to, join(plan.to, 'media'));
        if (am.migrated > 0) console.log(`[storage] 搬家后重挂媒体资产 ${am.migrated} 条`);
        for (const u of am.unresolved) console.warn(`[storage] ⚠️ 媒体资产无法解析：${u}`);
      } catch (err) {
        console.warn('[storage] 搬家后迁移媒体资产失败:', err);
      }

      // 搬成功后才改指向。反过来会指向一个还没搬完的位置
      writeDataDirPointer(plan.to);
      /*
       * ★ `staleLinks` / `warningZh` **必须回给前端**（T-128）。
       *
       * 这个字段存在的全部意义就是「移动数据目录会静默弄坏转写功能」这件事不再静默。
       * 算出来却不透出去，等于把一盏假绿灯换成一盏没接线的红灯 —— 本项目已经栽过
       * 同一形状的跟头（`build` 字段后端返回了、前端逐字段手抄时漏掉，界面写"构建信息未知"；
       * `job.blocked` 的 toast 接收方一直在等一个从来没人发的事件）。
       * 所以这里回、`DataLocationSection.tsx` 那边渲染，两头都必须有。
       */
      sendJson(res, 202, {
        ok: true,
        moved: true,
        strategy: result.strategy,
        bytes: result.bytes,
        files: result.files,
        links: result.links,
        staleLinks: result.staleLinks,
        ...(result.warningZh ? { warningZh: result.warningZh } : {}),
        /*
         * ★ 结构化地告诉调用方「源目录还在不在」。
         *   前端不该去正则匹配 `warningZh` —— 那是 T-144「产出方与使用方用了两个名字」那一族。
         */
        sourceRemoved: result.sourceRemoved,
        from: plan.from,
        to: plan.to,
        restartRequired: true,
        /*
         * ★★ 文案必须跟着**实际发生的事**变，不许恒说"已移动"。
         *
         * `[CI 实测 run 31250730491，windows-2025]` 复制路径走完、`fs.rm(from)` 失败
         * （Windows 删不掉仍被打开的 `openmemo.db`），而这里照旧回
         * 「已移动 54 个文件到新位置」—— 数据**被复制了一份留在原地**，
         * 其中包含明文的 `secrets.json`。用户据此以为旧位置空了。
         *
         * Manager 裁定：判据不是"让 Windows 也用 rename"（跨卷 rename 本来就会失败，
         * copy 是必要退路），**判据是"界面说的和实际发生的必须一致"**。
         * 这里选的是"如实说" —— 删源发生在逐文件校验之后，删不掉时不再赌第二次，
         * 而是把旧目录的位置原样交还给用户。
         */
        messageZh: moveMessageZh(result, plan.from),
      });
      setTimeout(() => deps.requestRestart?.('data-dir moved', { dataDir: plan.to }), 50);
      return true;
    },
  };
}
