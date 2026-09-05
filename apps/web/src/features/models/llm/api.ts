import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { LlmDetectResponse, LlmModelsResponse, PurposeBindings } from '@openmemo/shared';

import { api } from '../../../lib/api/client';
import { qk } from '../../../app/query';

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
  /**
   * 协议族。daemon 的 `resolveConfiguredProvider()` 实际是按 **providerId**
   * 分支的（`'gemini'` / `'anthropic'` 各有原生实现，其余走 OpenAI 兼容），
   * 这里跟着把 `gemini` 列出来，免得类型比后端少认一种而挡住合法配置。
   */
  kind: 'openai-compatible' | 'anthropic' | 'gemini';
  label: string;
  baseUrl: string;
  model: string;
  isLocal: boolean;
}

/** settings 里的存放位置（点分 key，符合服务端的 `KEY_RE`）。 */
export const LLM_PROVIDERS_KEY = 'llm.providers';
/**
 * ⚠️ **订正**：这里原来是 `'llm.activeProviderId'` —— 一个 **daemon 从来不读的键**。
 *
 * 全仓核对（exhaustive grep）的结果是零重叠：
 *
 * | 前端写 | daemon 读 |
 * |---|---|
 * | `llm.providers`、`llm.activeProviderId` | `llm.defaultProviderId`、`llm.defaultModelId`、`llm.purposes`、`llm.baseUrl.<id>` |
 *
 * 也就是说**整个 LLM 配置界面是一次死写**：用户配好 provider、填了 Key、
 * 界面显示"已启用"，而 `resolveConfiguredProvider()` 永远解析不出 provider，
 * F4 的摘要与导图一直是"未配置"。填了等于没填，且没有任何提示。
 *
 * 改成直接用 daemon 读的那个键，**而不是同时写两个** ——
 * 两个键表示同一件事就是下一个不一致的来源。
 * `llm.providers` 保留：它是**前端自己的清单**（label / kind / isLocal），
 * daemon 不需要也不读，但用户得能在界面上管理多个 provider。
 */
export const LLM_ACTIVE_KEY = 'llm.defaultProviderId';

/** daemon 用它决定"用哪个模型"。必须与 active provider 的 model 同步写入。 */
export const LLM_DEFAULT_MODEL_KEY = 'llm.defaultModelId';

/** 每个 provider 一条 baseUrl，daemon 按 `llm.baseUrl.<providerId>` 取。 */
export function baseUrlKeyFor(providerId: string): string {
  return `llm.baseUrl.${providerId}`;
}

/** 按用途分档的绑定表。形状见 `@openmemo/shared` 的 `PurposeBindings`。 */
export const LLM_PURPOSES_KEY = 'llm.purposes';

export function readDefaultModelId(settings: SettingsMap | undefined): string | null {
  const raw = settings?.[LLM_DEFAULT_MODEL_KEY];
  return typeof raw === 'string' ? raw : null;
}

export function readPurposeBindings(settings: SettingsMap | undefined): PurposeBindings {
  const raw = settings?.[LLM_PURPOSES_KEY];
  // 服务端存的是任意 JSON，这里只认对象；数组/字符串一律当"没配"，不让脏数据把设置页炸掉
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PurposeBindings) : {};
}

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

/**
 * 生成**一份完整的、daemon 真读得到的** LLM 设置补丁。
 *
 * ## 为什么必须收敛到一个函数
 *
 * 保存和「设为默认」原本各自拼各自的 patch，于是漂移了：
 * 「设为默认」写全了三个键，而**保存只写 `providers` + `baseUrl`** ——
 * 用户加了 provider、填了 key、点保存，`llm.defaultProviderId` **一次都没被写过**，
 * 而那是 `resolveConfiguredProvider()` **唯一认的键**。
 * 结果 F4 直接 `blocked / LLM_NOT_CONFIGURED`，而设置页显示得好好的。
 *
 * 两个入口拼同一组键，就一定会有一个先忘。所以只留一个函数。
 *
 * ## 首个 provider 自动成为默认
 *
 * 用户的心智是"我配好了就该能用"，而不是"我还得再点一次设为默认"。
 * 没有任何 provider 生效时，保存哪个就让哪个生效 —— 这也正是用户实际走的那条路。
 */
export function buildLlmSettingsPatch(opts: {
  providers: LlmProviderConfig[];
  provider: LlmProviderConfig;
  /** 当前生效的 provider id（`llm.defaultProviderId`），没有则为 null。 */
  activeId: string | null;
  /** true = 显式设为默认；省略时「当前没有默认」会自动把它设为默认。 */
  makeActive?: boolean;
}): SettingsMap {
  const { providers, provider, activeId } = opts;
  const next = providers.some((x) => x.id === provider.id)
    ? providers.map((x) => (x.id === provider.id ? provider : x))
    : [...providers, provider];

  const becomesActive = opts.makeActive === true || activeId === null || activeId === provider.id;

  const patch: SettingsMap = {
    [LLM_PROVIDERS_KEY]: next,
    // baseUrl 按 provider 存：daemon 取的是 `llm.baseUrl.<providerId>`
    [baseUrlKeyFor(provider.id)]: provider.baseUrl,
  };
  if (becomesActive) {
    // ★ 这两个键才是 daemon 唯一读的。少写任何一个都会 LLM_NOT_CONFIGURED
    patch[LLM_ACTIVE_KEY] = provider.id;
    patch[LLM_DEFAULT_MODEL_KEY] = provider.model;
  }
  return patch;
}

/* ───────────── T-153：本地服务探测 + 模型列表枚举（daemon 端点终于存在了）───────────── */

/**
 * 探测本机 LLM 服务（ADR-003 档 2 / D-10 #3）。
 *
 * **用 mutation 不是 query，是有意的**：它会让 daemon 真去敲三个本机端口。
 * `useQuery` 天生带重取（挂载、窗口聚焦、重连），那等于用户每切一次标签页
 * 就替他敲一遍端口 —— 与 T-150 给自检定的那条同一个理由
 * （「每 15 秒替用户跑一遍，是拿他的 CPU 换一个他没在看的数字」）。
 * 这件事只该在他**按下按钮**时发生。
 */
export function useLlmDetectMutation() {
  return useMutation({
    mutationFn: () => api<LlmDetectResponse>('settings', '/llm/detect', { method: 'POST' }),
  });
}

/**
 * 枚举某家现在真正有哪些模型（D-10 #26 的按钮打的就是它）。
 *
 * ⚠️ **不传 baseUrl**：daemon 一律用**已保存的**地址（`llm.baseUrl.<id>` 或目录默认值）。
 * 一个"接受任意 URL 然后带着你的 Key 去 fetch"的端点是从浏览器可达的 SSRF 原语，
 * 服务端因此拒绝读请求体里的地址 —— 前端也就不要发它，免得下一个人以为发了有用。
 */
export function useLlmModelsMutation() {
  return useMutation({
    mutationFn: (providerId: string) =>
      api<LlmModelsResponse>('settings', '/llm/models', {
        method: 'POST',
        body: { providerId },
      }),
  });
}
