/**
 * API Key 存储（**ADR-006 决策 1：明文 0600 + 显式告知**）。
 *
 * 用户已明确"仅个人自用"，且 `keytar` 已归档、我们是 web-first 无 Electron 架构，
 * 接 OS keychain 跨平台成本高且不合拍 → v1 用明文文件。
 *
 * **强制条件（不可省略）**：
 * > 设置页必须**显式告知**"API Key 以明文存储在 `<路径>`，权限 0600"，不许含糊。
 *
 * 所以本模块提供 `disclosure()` —— UI 必须调用它并把结果渲染出来。
 * schema 保留 `enc` 字段，日后可无损升级到 keychain / aes-gcm。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { MaskedSecret, SecretEncoding, SecretsDisclosure } from '@openmemo/shared';

/*
 * ★ 这三个是**对外契约**，权威定义搬到 `@openmemo/shared` 了；本文件留的是**实现**
 *   （明文文件、0600、`chmodSync`）—— 那部分必须留在这里，它要碰 `node:fs`。
 *
 *   搬家的理由：这三个形状要被 daemon 发出去、被浏览器读，而 `@openmemo/llm` 的 `.`
 *   导出会把本文件的 `chmodSync` 一起拉进浏览器 bundle，所以**前端够不着这里**。
 *   分叉的账（daemon 的 `*Like` 与 web 各把 `'plaintext-file'` 放宽成了 `string`）
 *   记在 `packages/shared/src/secrets.ts` 的文件头。
 */
export type { MaskedSecret, SecretEncoding, SecretsDisclosure };

export interface SecretRecord {
  readonly value: string;
  readonly enc: SecretEncoding;
  readonly updatedAt: number;
}

interface SecretsFile {
  schema: 1;
  secrets: Record<string, SecretRecord>;
}

export class SecretStore {
  readonly #path: string;

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'secrets.json');
  }

  get path(): string {
    return this.#path;
  }

  /**
   * 给设置页用的**明示文案**。ADR-006 决策 1 的强制条件靠这个落地。
   * UI 必须原样展示，不许改成"安全存储"之类的含糊说法。
   */
  disclosure(): SecretsDisclosure {
    return {
      storage: 'plaintext-file',
      path: this.#path,
      filePermission: '0600',
      dirPermission: '0700',
      messageZh:
        `API Key 以**明文**保存在 ${this.#path}（文件权限 0600、目录 0700）。` +
        `本机上有权限读取该文件的程序都能看到它。若不接受，请改用本地模型（无需 API Key）。`,
      message:
        `API keys are stored in PLAINTEXT at ${this.#path} (file mode 0600, dir mode 0700). ` +
        `Any program able to read that file can read your keys. ` +
        `If that is not acceptable, use a local model instead (no API key required).`,
    };
  }

  #read(): SecretsFile {
    if (!existsSync(this.#path)) return { schema: 1, secrets: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as SecretsFile;
      return parsed.secrets ? parsed : { schema: 1, secrets: {} };
    } catch {
      // 文件损坏时返回空而不是抛 —— 丢 key 比打不开应用好
      return { schema: 1, secrets: {} };
    }
  }

  #write(data: SecretsFile): void {
    const dir = dirname(this.#path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* Windows 上不适用 */
    }
    // 先写临时文件再 rename —— 原子替换，避免写到一半崩掉留下半个文件
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.#path);
    try {
      chmodSync(this.#path, 0o600);
    } catch {
      /* Windows 上不适用 */
    }
  }

  set(key: string, value: string): void {
    const data = this.#read();
    data.secrets[key] = { value, enc: 'plain', updatedAt: Date.now() };
    this.#write(data);
  }

  get(key: string): string | undefined {
    return this.#read().secrets[key]?.value;
  }

  delete(key: string): void {
    const data = this.#read();
    delete data.secrets[key];
    this.#write(data);
  }

  /**
   * 列出所有密钥（**掩码**）。
   * secrets 永不出现在日志、诊断包、API 响应里 —— 只回这个形状（D-02 §1.2）。
   */
  list(): MaskedSecret[] {
    const data = this.#read();
    return Object.entries(data.secrets).map(([key, rec]) => ({
      key,
      masked: mask(rec.value),
      enc: rec.enc,
      updatedAt: rec.updatedAt,
    }));
  }
}

/** `sk-abcd…wxyz` → `sk-a…wxyz`。短串一律全掩，避免泄露长度以外的信息。 */
export function mask(value: string): string {
  if (value.length <= 8) return '*'.repeat(Math.max(4, value.length));
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
