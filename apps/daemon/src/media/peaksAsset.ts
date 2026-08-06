/**
 * 把一份音轨的波形算出来、落盘、登记成 `role='peaks'` 的资产、并广播（T-151 ③）。
 *
 * 纯计算在 `peaks.ts`（可单测、不碰 DB/SSE），副作用集中在这里。
 *
 * ## 落点是**每条笔记固定一个**：`<mediaRoot>/<noteUid>/peaks.ompk`
 *
 * 与 `transcribe.ts` 的 `archiveIntoMedia` 同一个目录，且**不带随机成分**。
 * 这一条是刻意的：`Repos.createAsset` 对 `rel_path` 是**幂等**的（撞了就返回已有那行），
 * 所以「录音结束先生成一次 → 离线重跑完再生成一次」不会长出**两条** peaks 资产。
 * 长出两条的后果不是"多一行"：前端 `pickPeaksAsset` 取的是 `find` 的第一条，
 * 于是画出来的可能是**上一次**的波形，而界面上没有任何迹象。
 *
 * ## 失败一律降级成"没有波形"，但**必须出声**
 *
 * 波形是派生产物，算不出来不该让整单转写失败（用户要的是稿子）。
 * 但也绝不能静默 —— 静默的降级正是本仓最贵的那类 bug。
 * 所以：`catch` → 打一条 `[peaks] ⚠️` 日志 → 返回 `null` → 前端如实画基线。
 * **不写一个半截的 `.ompk`**：半份波形和编出来的波形一样是谎
 * （与 `decodeOmpk` 那条"坏数据必须抛，不能尽力解出一点"同一条判据）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalAssetRelPath } from '@openmemo/runtime';
import { makeEvent, topics, type SseEvent } from '@openmemo/shared';

import type { Repos } from '../db/repos.js';
import type { SseHub } from '../http/sse.js';
import { computeWavPeaks } from './peaks.js';

export interface PeaksAssetDeps {
  readonly repos: Pick<Repos, 'createAsset'>;
  readonly sse: Pick<SseHub, 'publish'>;
  readonly mediaRoot: string;
  /** 只用于把落盘路径换算成规范的 `rel_path`（T-151 ①，绝不存绝对路径）。 */
  readonly dataDir: string;
}

export interface PeaksAssetResult {
  readonly uid: string;
  readonly relPath: string;
  readonly bytes: number;
  readonly buckets: number;
  readonly durationMs: number;
}

/**
 * 为 `noteUid` 这条笔记生成/刷新波形资产。
 *
 * @param wavPath 绝对路径，必须是 PCM16 的 WAV（流水线的 `audio16k.wav` 与录音的原始 WAV 都是）。
 * @returns 成功返回资产信息；**任何失败都返回 `null` 并已打过日志**，调用方不必再包一层 try。
 */
export async function generatePeaksAsset(
  deps: PeaksAssetDeps,
  p: { noteId: number; noteUid: string; wavPath: string },
): Promise<PeaksAssetResult | null> {
  try {
    const result = await computeWavPeaks(p.wavPath);
    const destDir = join(deps.mediaRoot, p.noteUid);
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, 'peaks.ompk');
    await writeFile(dest, result.bytes);

    const relPath = canonicalAssetRelPath(deps.dataDir, dest);
    if (relPath === null) {
      // 与 recorder 同一条：**宁可不登记，也不把绝对路径写进 rel_path**
      throw new Error(`波形落点不在数据目录内：${dest}（dataDir=${deps.dataDir}）`);
    }

    const asset = deps.repos.createAsset({
      noteId: p.noteId,
      role: 'peaks',
      relPath,
      displayName: 'peaks.ompk',
      mime: 'application/octet-stream',
      bytes: result.bytes.length,
      durationMs: result.durationMs,
    });

    /*
     * `media.asset.ready` —— 契约里早就有它，前端 `notesSse` 也早就订阅着并会
     * invalidate 详情查询。**在这之前它一次都没被发布过**（因为没有异步产物）。
     * 少了这一条，用户得手动刷新才看得到波形：转写完成时波形还没算出来。
     */
    deps.sse.publish(
      makeEvent('media.asset.ready', topics.note(p.noteUid), {
        noteUid: p.noteUid,
        assetUid: asset.uid,
        role: 'peaks',
        bytes: result.bytes.length,
      }) as SseEvent,
    );

    return {
      uid: asset.uid,
      relPath,
      bytes: result.bytes.length,
      buckets: result.buckets,
      durationMs: result.durationMs,
    };
  } catch (err) {
    console.warn(
      `[peaks] ⚠️ 波形生成失败，本条笔记按"无波形"处理（转写不受影响）：` +
        `${p.wavPath} —— ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
