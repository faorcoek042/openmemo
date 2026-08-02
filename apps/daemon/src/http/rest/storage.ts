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
import { writeDataDirPointer } from '../../config/paths.js';
import { stat } from 'node:fs/promises';

import { measureTree, moveDataDir, planMove } from '../../storage/move.js';
import { readJsonBody, sendError, sendJson } from '../respond.js';

export interface StorageRoutesDeps {
  readonly paths: AppPaths;
  /** 有任务在跑就不能搬 —— 搬到一半任务还在写文件，必然不一致。 */
  readonly runningJobs: () => number;
  /** 搬完要重启才能挂到新位置（复用 T-061 的自我重启）。 */
  readonly requestRestart?: (reason: string) => void;
}

/** 每个子目录**是干什么的** —— 用户要"描述清楚"才敢删。 */
function layout(paths: AppPaths): Array<Record<string, string>> {
  return [
    { path: paths.dbFile, name: 'openmemo.db', purposeZh: '笔记、转写稿、标签、导图（SQLite 主库）' },
    { path: paths.mediaDir, name: 'media', purposeZh: '导入与录制的音视频原件' },
    { path: paths.modelsDir, name: 'models', purposeZh: '下载的模型与后端包（可重新下载）' },
    { path: paths.logsDir, name: 'logs', purposeZh: '运行日志（可随时删）' },
    { path: paths.tmpDir, name: 'tmp', purposeZh: '转写中间产物（可随时删）' },
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
          /** 数据目录是**独立文件夹**，删掉它不影响程序本体 —— 用户明确问过这一点。 */
          selfContained: true,
          noteZh: '这是一个独立文件夹，删除它不会影响程序本体运行（下次启动会重建空目录）。',
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

      const doMove = body?.move !== false; // 默认搬；显式 false = 只改指向

      if (!doMove) {
        // 只改指向：不搬数据，下次启动去新位置（新位置可能是用户手工拷过去的）
        writeDataDirPointer(plan.to);
        sendJson(res, 202, {
          ok: true,
          moved: false,
          from: plan.from,
          to: plan.to,
          restartRequired: true,
          messageZh: '已记录新位置（未搬运数据）。重启后生效。',
        });
        setTimeout(() => deps.requestRestart?.('data-dir changed'), 50);
        return true;
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

      // 搬成功后才改指向。反过来会指向一个还没搬完的位置
      writeDataDirPointer(plan.to);
      sendJson(res, 202, {
        ok: true,
        moved: true,
        strategy: result.strategy,
        bytes: result.bytes,
        files: result.files,
        from: plan.from,
        to: plan.to,
        restartRequired: true,
        messageZh: `已移动 ${result.files} 个文件到新位置，正在重启以生效。`,
      });
      setTimeout(() => deps.requestRestart?.('data-dir moved'), 50);
      return true;
    },
  };
}
