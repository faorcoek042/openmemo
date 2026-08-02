import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import { qk } from '../../app/query';
import type {
  AcceptedJob,
  ImportUrlRequest,
  NoteDetail,
  NoteSummary,
  ProbeResult,
  TranscriptDto,
} from '../../lib/api/types';

export function useNotesQuery() {
  return useQuery({
    queryKey: qk.notes.list(),
    queryFn: () => api<{ notes: NoteSummary[] }>('notes', '/notes'),
    select: (d) => d.notes,
  });
}

export function useNoteQuery(uid: string | undefined) {
  return useQuery({
    queryKey: qk.notes.detail(uid ?? ''),
    queryFn: () => api<NoteDetail>('notes', `/notes/${uid}`),
    enabled: Boolean(uid),
  });
}

export function useTranscriptQuery(uid: string | undefined) {
  return useQuery({
    queryKey: qk.transcript(uid ?? ''),
    queryFn: () => api<TranscriptDto | null>('transcript', `/notes/${uid}/transcript`),
    enabled: Boolean(uid),
  });
}

/** probe：秒级返回，**先于下载**。让"认对了没有"和"需要登录"都提前暴露（D-01 §5 F1）。 */
export function useProbeMutation() {
  return useMutation({
    mutationFn: (url: string) => api<ProbeResult>('import', '/import/probe', { method: 'POST', body: { url } }),
  });
}

/**
 * D-01 §3.2 规则 2：写操作一律异步化 —— 返回 202 + jobId，进度走 SSE。
 * 因此 `onSuccess` **只把 job 塞进缓存，不做乐观业务更新**（D-05 §2.5：
 * 触发转写/下载绝不乐观，它们会失败、会 blocked、会排队，假装成功是欺骗）。
 */
export function useImportUrlMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: ImportUrlRequest) =>
      api<AcceptedJob>('import', '/import/url', {
        method: 'POST',
        body: req,
        // SSE 断线重连后前端可能重发；用户也会狂点按钮
        idempotencyKey: `import:${req.url}`,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.notes.all });
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
    },
  });
}
