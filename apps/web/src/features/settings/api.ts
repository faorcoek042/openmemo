import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';

/**
 * LLM provider 配置（对齐 `packages/llm` 的 `ProviderConfig`）。
 *
 * ⚠️ **`apiKey` 从不回传明文** —— 服务端只回 `hasKey` + 掩码尾部四位。
 * 这是最基本的一条：配置页刷新一次就把 Key 打印在 DOM 里，等于白做存储权限。
 */
export interface LlmProviderConfigDto {
  id: string;
  kind: 'openai-compatible' | 'anthropic';
  label: string;
  baseUrl: string;
  model: string;
  isLocal: boolean;
  /** 已配置 Key（服务端判定），前端据此显示"已设置/未设置" */
  hasKey: boolean;
  /** 例 `sk-…4f2a`。只用于让用户确认"是不是我想的那把 Key" */
  keyMask: string | null;
}

export interface LlmSettings {
  providers: LlmProviderConfigDto[];
  activeProviderId: string | null;
  /** secrets 实际落盘位置，**必须显示给用户**（ADR-006 决策 1 的强制条件） */
  secretsPath: string;
  /** 存储方式：v1 是明文 + 0600，不许含糊其辞 */
  secretsEncryption: 'plain' | 'os-keychain-ref' | 'aes-gcm';
}

export function useLlmSettingsQuery() {
  return useQuery({
    queryKey: [...qk.settings, 'llm'],
    queryFn: () => api<LlmSettings>('settings', '/settings/llm'),
  });
}

export interface SaveProviderInput {
  id: string;
  kind: 'openai-compatible' | 'anthropic';
  label: string;
  baseUrl: string;
  model: string;
  isLocal: boolean;
  /** 留空 = 不改动已存的 Key；显式传空字符串 = 清除 */
  apiKey?: string;
}

export function useSaveProviderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveProviderInput) =>
      api<{ ok: true }>('settings', '/settings/llm/providers', {
        method: 'PUT',
        body: input,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...qk.settings, 'llm'] }),
  });
}

export function useActivateProviderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>('settings', '/settings/llm/active', { method: 'POST', body: { id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...qk.settings, 'llm'] }),
  });
}

export interface TestResult {
  ok: boolean;
  latencyMs: number | null;
  model: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * 连通性自测。
 *
 * 为什么必须有：填完 Key 用户唯一想知道的是"这下能用了吗"。
 * 没有自测，他只能去点"生成思维导图"然后等一个失败 —— 反馈链条长得离谱。
 */
export function useTestProviderMutation() {
  return useMutation({
    mutationFn: (id: string) =>
      api<TestResult>('settings', '/settings/llm/test', { method: 'POST', body: { id } }),
  });
}
