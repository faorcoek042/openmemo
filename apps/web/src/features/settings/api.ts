import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';

/**
 * 设置与密钥 —— **按 daemon 的真实契约重写**（T-041）。
 *
 * ## 我最初猜错的地方
 *
 * B-3 那一版我按 `/settings/llm` 一个聚合端点写（当时 daemon 还没有任何设置端点，
 * 我照 D-05 的设计猜了形状）。实际落地的是**两个正交的端点**：
 *
 * | 端点 | 存什么 | 为什么分开 |
 * |---|---|---|
 * | `/api/settings` | 普通配置（点分 key → JSON 值） | 可读可回显 |
 * | `/api/secrets`  | API Key | **服务端刻意不提供 `get()`** —— 路由层无权读明文 |
 *
 * 这个拆分比我原来的设计好：把"能回显的"和"永远不该回显的"放进**不同的存储与不同的接口**，
 * 比在一个 DTO 里靠 `hasKey`/`keyMask` 字段自律要可靠得多。前端按它改。
 */

/* ─────────────────────────── settings（键值）─────────────────────────── */

export interface SettingsMap {
  [key: string]: unknown;
}

export function useSettingsQuery() {
  return useQuery({
    queryKey: qk.settings,
    queryFn: () => api<{ settings: SettingsMap }>('settings', '/settings'),
    select: (d) => d.settings,
  });
}

/**
 * 部分更新。服务端要求 key 是**字母开头的点分命名**（`ui.theme` 这种），
 * 值必须可 JSON 序列化且不能是 `undefined`（要清空得显式传 `null`）。
 */
export function usePatchSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsMap) =>
      api<{ settings: SettingsMap }>('settings', '/settings', { method: 'PATCH', body: patch }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.settings }),
  });
}

/* ──────────────────────────── secrets（密钥）──────────────────────────── */

export interface MaskedSecret {
  key: string;
  /** 例 `sk-…4f2a`。**服务端永不回传明文**，这是它唯一能给的确认线索。 */
  masked: string;
  enc: string;
  updatedAt: number;
}

/**
 * 明文存储告知 —— **由服务端下发，前端不自己编**。
 *
 * ADR-006 决策 1 要求"显式告知路径与权限，不许含糊"。
 * 而路径只有 daemon 知道（随 `OPENMEMO_DATA_DIR` 变），前端硬编码必然会说错 ——
 * 我上一版就硬编码了 `~/.local/share/openmemo/openmemo.db`，
 * 实测这个实例的真实路径是 `/tmp/openmemo-t038/secrets.json`，**连文件都不是同一个**。
 * 所以这段文案的权威来源必须是服务端，前端只负责显示。
 */
export interface SecretsDisclosure {
  storage: string;
  path: string;
  filePermission: string;
  dirPermission: string;
  messageZh: string;
  message: string;
}

export interface SecretsResponse {
  secrets: MaskedSecret[];
  disclosure: SecretsDisclosure;
}

export function useSecretsQuery() {
  return useQuery({
    queryKey: [...qk.settings, 'secrets'],
    queryFn: () => api<SecretsResponse>('settings', '/secrets'),
  });
}

export function useSetSecretMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { key: string; value: string }) =>
      api<{ secret: MaskedSecret; disclosure: SecretsDisclosure }>(
        'settings',
        `/secrets/${encodeURIComponent(v.key)}`,
        { method: 'PUT', body: { value: v.value } },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...qk.settings, 'secrets'] }),
  });
}

export function useDeleteSecretMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      api<{ ok: true }>('settings', `/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...qk.settings, 'secrets'] }),
  });
}

/* ─────────────────────── LLM provider：由上面两者组合 ─────────────────────── */

export interface LlmProviderConfig {
  id: string;
  kind: 'openai-compatible' | 'anthropic';
  label: string;
  baseUrl: string;
  model: string;
  isLocal: boolean;
}

/** settings 里的存放位置（点分 key，符合服务端的 `KEY_RE`）。 */
export const LLM_PROVIDERS_KEY = 'llm.providers';
export const LLM_ACTIVE_KEY = 'llm.activeProviderId';

/** 某 provider 的 API Key 在 secrets 里的 key。 */
export function secretKeyFor(providerId: string): string {
  return `llm.${providerId}.apiKey`;
}

export function readProviders(settings: SettingsMap | undefined): LlmProviderConfig[] {
  const raw = settings?.[LLM_PROVIDERS_KEY];
  return Array.isArray(raw) ? (raw as LlmProviderConfig[]) : [];
}

export function readActiveProviderId(settings: SettingsMap | undefined): string | null {
  const raw = settings?.[LLM_ACTIVE_KEY];
  return typeof raw === 'string' ? raw : null;
}
