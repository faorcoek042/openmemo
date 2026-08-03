import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { CircleAlert, CircleCheck, Download } from 'lucide-react';

import { type AsrEngineId, ASR_ENGINE_IDS } from '@openmemo/shared';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';
import { arr } from '../../lib/safe';
import { ASR_ENGINE_LABELS } from '../../lib/asr';
import { Button } from './Button';

/** `GET /api/daemon/status` 里我们要用的那一小块（见 `apps/daemon/src/main.ts` 的 `pipeline`）。 */
interface DaemonStatusPipeline {
  engines?: { id: string; available: boolean; reason?: string }[];
  paraformerAvailable?: boolean;
  streamAvailable?: boolean;
  missing?: string[];
}
interface DaemonStatus {
  pipeline: DaemonStatusPipeline | null;
}

export interface EngineState {
  id: AsrEngineId;
  available: boolean;
  reason?: string;
}

/** 把 daemon 返回的字符串收窄回联合类型；不认识的 id 直接丢弃而不是硬转。 */
function toEngineId(raw: string): AsrEngineId | null {
  return (ASR_ENGINE_IDS as readonly string[]).includes(raw) ? (raw as AsrEngineId) : null;
}

export function useAsrEngines(): { engines: EngineState[]; isLoading: boolean; ready: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: qk.daemon.status,
    /**
     * 用 `/api/health` 而不是 `/api/daemon/status`。
     *
     * 两者的 `pipeline` 块是**同一个对象**（`server.ts` 把 `deps.status()` 摊进了 health），
     * 但 health 是**公开端点**（单实例探测要在拿到 token 之前调它），
     * 而 `/api/daemon/status` 需要鉴权 —— 实测未认证时返回 401。
     * 引擎可用性只是只读的能力描述，没有任何 secret，走公开那条更少一层失败可能。
     *
     * [实测 2026-08] `GET /api/health` 返回
     * `pipeline.engines: [{id:"whisper.cpp", available:true}]`。
     */
    queryFn: () => api<DaemonStatus>('health', '/health'),
    // 引擎可用性会随"装完运行时"而变，但不需要秒级新鲜
    staleTime: 30_000,
  });

  const reported = new Map<AsrEngineId, EngineState>();
  for (const e of arr(data?.pipeline?.engines)) {
    const id = toEngineId(e.id);
    if (id) reported.set(id, { id, available: e.available === true, ...(e.reason ? { reason: e.reason } : {}) });
  }

  /**
   * ★ 把**没被 daemon 报告**的引擎也补进来，标成不可用。
   *
   * [实测] daemon 只列**构造成功的候选**：demo 上 `engines` 只有 `whisper.cpp` 一条，
   * Paraformer 和 sherpa-onnx **根本不出现** —— 因为它们需要
   * `OPENMEMO_PARAFORMER_DIR` / `OPENMEMO_SHERPA_STREAM_DIR` 指向模型目录，没设就不进候选。
   *
   * 如果照抄 daemon 的列表，用户看到的是"引擎：Whisper.cpp ✓"，
   * 完全不知道还存在另外两个、更不知道怎么装 —— 那就又回到了
   * "只能看见系统替你决定的结果"。所以这里以 shared 的联合为全集，
   * 缺席即"未安装"，并给出安装入口。
   */
  const engines: EngineState[] = ASR_ENGINE_IDS.map(
    (id) => reported.get(id) ?? { id, available: false, reason: undefined as string | undefined },
  ).map((e) => (e.reason === undefined ? { id: e.id, available: e.available } : e));

  // isLoading 期间还没有数据，不要把"全都没装"当成结论
  return { engines, isLoading, ready: engines.some((e) => e.available) };
}

/**
 * ASR 引擎**真实状态**（只读）—— 替换掉录音页那个假的两项切换器。
 *
 * ## 为什么是只读，而不是选择器
 *
 * 这不是偷懒，是**后端目前不接受**：
 * - `TranscribePayload`（`jobs/runners/transcribe.ts`）只有
 *   `{noteId, input, language, sourceKind, mergeWithTranscriptId}` 五个键，没有 `engineId`
 * - `selectEngine()` 支持 `forceEngineId`，但**整个 daemon 零调用方**
 * - 引擎当前唯一的外部输入口是环境变量 `OPENMEMO_ASR_ENGINE`
 *
 * 在这种情况下画一个下拉框，选中的值只能扔掉 —— 那正是本轮要消灭的东西
 * （原来的 `'paraformer' | 'turbo'` 就是这么来的，而 `'turbo'` 后端根本不存在）。
 * 所以这里如实显示"**哪些引擎真的能用、用不了的原因是什么**"，
 * 并给出唯一真实的操作：去装缺的运行时。
 *
 * 用户能间接影响引擎选择的手段是**语言** —— 后端按语言自动选（中文走 Paraformer）。
 * 这条因果链写在 `TranscribeOptions` 的提示里。
 */
export function AsrEngineStatus({ className }: { className?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { engines, isLoading } = useAsrEngines();

  // 加载中不下结论：还没拿到 health 就渲染"三个都没装"是纯误报
  if (isLoading) return null;

  const missing = engines.filter((e) => !e.available);

  return (
    <div className={className} data-testid="asr-engine-status">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-ink">{t('recorder.engineLabel')}:</span>
        {engines.map((e) => (
          <span
            key={e.id}
            className={`inline-flex items-center gap-1 ${e.available ? 'text-ink-secondary' : 'text-ink-muted'}`}
            title={e.reason ?? ''}
          >
            {e.available ? (
              <CircleCheck className="size-3.5 text-good" aria-hidden />
            ) : (
              <CircleAlert className="size-3.5 text-warning" aria-hidden />
            )}
            {ASR_ENGINE_LABELS[e.id]}
          </span>
        ))}
      </p>

      {/* 装不上的不灰掉了事 —— 给出路。reason 是 daemon 实测给的，不是我编的文案 */}
      {missing.length > 0 ? (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-ink-muted">
          <span>{missing.map((e) => `${ASR_ENGINE_LABELS[e.id]}${e.reason ? `（${e.reason}）` : ''}`).join('；')}</span>
          <Button size="sm" variant="ghost" className="h-5 px-1.5 text-xs" onClick={() => navigate('/runtime')}>
            <Download className="size-3 " />
            {t('asr.goInstallRuntime')}
          </Button>
        </p>
      ) : null}
    </div>
  );
}
