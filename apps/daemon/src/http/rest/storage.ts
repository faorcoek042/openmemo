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
import { readJsonBody, sendError, sendJson } from '../respond.js';

export interface StorageRoutesDeps {
  readonly paths: AppPaths;
  /** 搬家后要就地迁 `media_assets` 的路径引用。 */
  readonly db: DatabaseHandle;
  /** 有任务在跑就不能搬 —— 搬到一半任务还在写文件，必然不一致。 */
  readonly runningJobs: () => number;
  /** 搬完要重启才能挂到新位置（复用 T-061 的自我重启）。 */
  readonly requestRestart?: (reason: string, opts?: { dataDir?: string }) => void;
}

/** 每个子目录**是干什么的** —— 用户要"描述清楚"才敢删。 */
function layout(paths: AppPaths): Array<Record<string, string>> {
  return [
    { path: paths.dbFile, name: 'openmemo.db', purposeZh: '笔记、转写稿、标签、导图（SQLite 主库）' },
    { path: paths.mediaDir, name: 'media', purposeZh: '导入与录制的音视频原件' },
    { path: paths.modelsDir, name: 'models', purposeZh: '下载的模型与后端包（可重新下载）' },
    { path: paths.logsDir, name: 'logs', purposeZh: '运行日志（可随时删）' },
    {
      path: paths.tmpDir,
      name: 'tmp',
      // 说"可随时删"必须是真的：转写产物现在会**归档进 media/**，
      // 不再有已入库的资产留在这里（此前留了，照这句话删就会删掉笔记的音频）
      purposeZh: '转写过程的临时文件（可随时删，不含已入库资产）',
    },
    { path: paths.backupsDir, name: 'backups', purposeZh: '数据库备份' },
    { path: paths.runtimeDir, name: 'runtime', purposeZh: '运行时状态与访问令牌' },
  ];
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
          externalFiles: [
            {
              path: pointerFile(),
              purposeZh: '记录"数据目录搬到哪了"的指针文件',
              whyOutsideZh:
                '它必须在数据目录**外面** —— 放进去就会跟着一起搬走，搬完就再也找不到新位置了。',
              riskZh:
                '如果它指向一个已被删除的目录，daemon 下次启动（含自我重启）会**按它去那个不存在的位置建空目录**，表现为"笔记全没了"。删除数据目录时请连同它一起删。',
            },
          ],
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
        | { path?: unknown; move?: unknown; dryRun?: unknown }
        | undefined;
      const target = typeof body?.path === 'string' ? body.path.trim() : '';
      if (!target) {
        sendError(res, 400, 'BAD_REQUEST', 'path is required', '请提供新的数据目录路径');
        return true;
      }

      const plan = planMove(deps.paths.dataDir, target);
      if (!plan.ok) {
        sendError(res, 400, 'INVALID_TARGET', plan.reason ?? 'invalid', plan.reasonZh ?? '目标路径不合法');
        return true;
      }

      // 试算：只回计划与占用，不动任何文件
      if (body?.dryRun === true) {
        sendJson(res, 200, { ok: true, dryRun: true, from: plan.from, to: plan.to });
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

      const doMove = body?.move !== false; // 默认搬；显式 false = 只改指向（"直接使用此目录"）

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
              params: { path: plan.to, move: false, endpoint: '/api/settings/data-dir' },
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

      const result = await moveDataDir(plan.from, plan.to);
      if (!result.ok) {
        sendError(
          res,
          409,
          'MOVE_FAILED',
          result.error ?? 'move failed',
          // sourceIntact 必须如实回报 —— 用户最关心的就是"我的数据还在吗"
          `${result.errorZh ?? '移动失败'}${result.sourceIntact ? '（原数据完好，未做任何改动）' : ''}`,
        );
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
        const am = await migrateMediaAssets(deps.db, plan.to, join(plan.to, 'media'));
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
        from: plan.from,
        to: plan.to,
        restartRequired: true,
        messageZh:
          `已移动 ${result.files} 个文件` +
          (result.links > 0 ? `与 ${result.links} 个符号链接` : '') +
          '到新位置，正在重启以生效。',
      });
      setTimeout(() => deps.requestRestart?.('data-dir moved', { dataDir: plan.to }), 50);
      return true;
    },
  };
}
