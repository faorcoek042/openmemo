/**
 * 密钥的**对外形状** —— `GET /api/settings/secrets` 的响应契约（ADR-006 决策 1）。
 *
 * ## 为什么在 shared 而不是在 `@openmemo/llm`
 *
 * 实现（`SecretStore`、明文文件、`chmodSync`）在 `packages/llm/src/secrets.ts`，那里必须留着 ——
 * 它要碰 `node:fs`。但**这三个形状是 API 契约，不是实现细节**：它们从 daemon 发出去、被前端读。
 * 而 `@openmemo/llm` 的 `.` 导出会把 `secrets.ts` 的 `chmodSync` 一起拉进浏览器 bundle
 * （那次「笔记详情页整页崩溃」就是这么来的），所以**前端够不着 llm** —— 契约放这里是唯一解。
 *
 * ## 它原来有**四份**，而且已经在分叉
 *
 * | 位置 | `storage` | `enc` |
 * |---|---|---|
 * | `packages/llm/src/secrets.ts` | `'plaintext-file'` | `SecretEncoding` |
 * | `apps/daemon/src/http/rest/settings.ts`（`*Like`） | `string` | `string` |
 * | `apps/web/src/components/common/llm/api.ts` | `string` | `string` |
 *
 * daemon 那两个 `*Like` 是**刻意**的结构化解耦（路由层不该依赖 `@openmemo/llm` 的类），
 * 理由成立 —— 但解耦的正确形状是**两边都指向同一个契约**，而不是各写一个"结构兼容"的影子：
 * 影子一旦写宽（`'plaintext-file'` → `string`），编译器就再也拦不住"发错值"这件事，
 * 而它宽了两次、每次都没人发现。
 *
 * ⚠️ web 那份还在另一路的地盘里，暂未收敛；登记在
 * `scripts/duplicate-declarations-baseline.json` 里等协调，**不是忘了**。
 */

/**
 * 密钥的存储编码。schema 保留这一字段，日后可无损升级到 keychain / aes-gcm。
 *
 * ⚠️ 别在契约里把它放宽成 `string`：整条链上只有它能拦住"发了一个谁也不认识的编码"。
 */
export type SecretEncoding = 'plain' | 'os-keychain-ref' | 'aes-gcm';

/** 掩码后的密钥信息 —— **API 响应与日志只能出现这个形状**（明文永不出库）。 */
export interface MaskedSecret {
  readonly key: string;
  /** 例 `sk-…4f2a`。**服务端永不回传明文**，这是它唯一能给的确认线索。 */
  readonly masked: string;
  readonly enc: SecretEncoding;
  readonly updatedAt: number;
}

/**
 * 明文存储告知 —— **由服务端下发，前端不自己编**。
 *
 * ADR-006 决策 1 要求"显式告知路径与权限，不许含糊"。而路径只有 daemon 知道
 * （随 `OPENMEMO_DATA_DIR` 变），前端硬编码必然会说错 —— 实测有一次硬编码写的是
 * `~/.local/share/openmemo/openmemo.db`，真实路径是 `/tmp/openmemo-t038/secrets.json`，
 * **连文件都不是同一个**。所以这段文案的权威来源必须是服务端，前端只负责显示。
 */
export interface SecretsDisclosure {
  /** 目前只有这一种。**字面量而不是 `string`** —— 见文件头那张分叉表。 */
  readonly storage: 'plaintext-file';
  readonly path: string;
  readonly filePermission: string;
  readonly dirPermission: string;
  readonly messageZh: string;
  readonly message: string;
}
