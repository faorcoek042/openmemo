/**
 * Runtime validation schemas (zod).
 *
 * These exist because a hand-maintained JSON registry rots. Concrete evidence from the
 * products surveyed in R-04:
 *   - GPT4All's models3.json:  `filesize` is a string, `disableGUI` is the string "true",
 *                              `embeddingModel` is a real boolean. Three type conventions
 *                              in one file.
 *   - ComfyUI-Manager's model-list.json: `size` is "4.71MB", and there is no hash field.
 *   - memo.ac's whisper-models.js: `size` is "77.7 MB", `sha` is a SHA-1.
 *
 * Every one of those is a hand-written JSON file with no schema gate. Ours is validated
 * in CI (`validateModelManifest`) and at load time, so it cannot drift silently.
 */

import { z } from 'zod';

/* ------------------------------ primitives -------------------------------- */

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex characters');

export const Sha1Schema = z
  .string()
  .regex(/^[a-f0-9]{40}$/, 'sha1 must be 40 lowercase hex characters');

/** Integer bytes, never a formatted string. */
export const ByteSizeSchema = z
  .number()
  .int('size must be an integer number of bytes')
  .nonnegative();

/**
 * Only https, and only from a compile-time host allowlist.
 * ComfyUI-Manager's registry allows arbitrary URLs and has needed repeated security
 * patches as a result; its own security_check.py is a post-hoc malware blocklist.
 */
export const ALLOWED_DOWNLOAD_HOSTS = [
  'huggingface.co',
  'hf-mirror.com',
  'www.modelscope.cn',
  'modelscope.cn',
  'github.com',
  // Verified 2026-08-02: github.com/<o>/<r>/releases/download/... 302s to
  // release-assets.githubusercontent.com, NOT the older objects.githubusercontent.com.
  // Both are listed because older assets still use the latter.
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  // sherpa/silero canonical ONNX files are served from raw.
  'raw.githubusercontent.com',
] as const;

/**
 * Loopback hosts allowed to serve LOCALLY BUILT artifacts over plain http.
 *
 * Rationale: some components have no upstream build for a given platform (e.g. whisper.cpp
 * has no official macOS CLI, Vulkan or ROCm binary), so they must be built on the user's
 * own machine. Rather than require a publication channel for a personal-use install, the
 * daemon can serve `<dataDir>/local-artifacts/**` on its own loopback port and the manifest
 * points there.
 *
 * Why this is not a weakening of the https rule:
 *   - loopback traffic never leaves the machine, so there is no transport to protect;
 *   - the sha256 is still pinned in a git-committed manifest, so a compromised local
 *     server cannot substitute content — the download would simply fail verification;
 *   - it reuses the SAME download path (Range, resume, verify, dedup, retry) instead of
 *     adding a second "local install" code path that would miss those guarantees.
 *
 * `file://` was rejected deliberately: Node's fetch cannot read it, so it would require a
 * separate branch in the downloader — exactly the second code path this avoids.
 *
 * ── IPv6：`::1` 为什么必须配 `unbracketHost` 才能命中（T-171 修）─────────────────
 *
 * 这张表存的是**裸**字面量 `'::1'`，而 `new URL('http://[::1]/x').hostname` 返回的是
 * **`'[::1]'`（带方括号）** —— WHATWG 的 host 序列化器**规定**要带。所以直接
 * `LOOPBACK_HOSTS.includes(parsed.hostname)` 时 `'::1'` 这一条**恒为 false**，
 * 是一条从写下来那天起就命中不了的死条目：IPv6 回环上的本机自建产物**永远下载不了**。
 *
 * ★ **这是同一个错误假设第二次咬人，不是新坑。** 第一次是 T-142（commit `7ff7e73`）：
 * `apps/daemon/src/http/guard.ts` 的同源校验以为 `URL.hostname` **不带**方括号，于是主动
 * **再包一层**拼成 `[[::1]]` → 与 Host 头恒不相等 → 谁用 `http://[::1]:port` 打开界面，
 * **页面发出的每一个带 Origin 的请求都 403，整页全死**。
 *
 * 两次的错误假设**逐字相同**（"`.hostname` 不带方括号"），只是猜错的方向不同：
 * guard.ts 是**多包一层**，这里是**存了裸的**。两次的后果也同为 fail-closed（恒拒，
 * 不是漏放），所以都不是安全洞、也都不会被安全测试抓到 —— 它们只是让功能静默消失。
 * 两次都没被及时发现，原因也一样：**daemon 打印的启动地址是 IPv4**，没人从 IPv6 走过。
 *
 * ⚠️ `guard.ts:119-120` 当年把教训写成了「改成两边都剥而不是两边都包，就**不会再被同一个
 * 假设坑一次**」—— 而那句话写下的时候，本文件已经在被同一个假设坑着了。所以这里照抄
 * **同一个方向**（剥，不包）：剥法对任何一边用哪种书写约定都成立。
 *
 * ⚠️ **剥的是包装，不是判据**：剥完仍然只放行 `LOOPBACK_HOSTS` 里那三个。
 * `[2001:db8::1]` 剥成 `2001:db8::1` 之后照样不在表里，照样拒绝 —— 有专门的用例守这一条
 * （见 `schemas.test.ts`）。不要把它"顺手"改成"含冒号就算回环"。
 *
 * ⚠️ **等价写法这里不用管，`new URL` 已经替我们归一化了** —— 这一点与 `guard.ts:123-125`
 * 的处理**不同，别照抄那一段的结论**。`[实测 Node 24]`：
 *   `new URL('http://[0:0:0:0:0:0:0:1]/x').hostname === '[::1]'`   ← 展开写法被压缩
 *   `new URL('http://[::ffff:127.0.0.1]/x').hostname === '[::ffff:7f00:1]'` ← 换了个形式
 * 差别的成因是**两边的输入不同**：本文件比的两侧**都**过 `new URL`，所以 WHATWG 的
 * 地址序列化器已经把等价写法压成同一个规范形式；而 `guard.ts` 比的是 `URL.hostname`
 * 与**原始 Host 头**（一个没被解析过的字符串），那边才需要"不猜等价"。
 *
 * 顺带一条**反直觉的**：IPv4 映射写法 `[::ffff:127.0.0.1]` 会被压成 `::ffff:7f00:1`，
 * 它**不在** `LOOPBACK_HOSTS` 里，因此**被拒绝**。这是有意的 —— 放行它需要单独论证
 * （它是不是真回环取决于内核栈配置），不在本次裁决范围内。有用例钉住。
 */
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

/**
 * 剥掉 IPv6 字面量主机名的首尾方括号，并小写化。
 *
 * 与 `apps/daemon/src/http/guard.ts:127-128` 的 `unbracket` 是**同一个修法的两处应用**
 * （T-142 / T-171）。两边刻意保持同形，改一处时请看另一处。
 */
const unbracketHost = (h: string): string =>
  (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h).toLowerCase();

export const DownloadUrlSchema = z
  .string()
  .url()
  .superRefine((u, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not a valid URL' });
      return;
    }
    // 比之前先剥方括号 —— 否则 `'::1'` 这一条永远命中不了（见 LOOPBACK_HOSTS 上方 ★）。
    const isLoopback = (LOOPBACK_HOSTS as readonly string[]).includes(
      unbracketHost(parsed.hostname),
    );
    if (parsed.protocol === 'http:' && isLoopback) return; // locally served artifact
    if (parsed.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'download URLs must use https (or http on loopback)' });
      return;
    }
    if (!(ALLOWED_DOWNLOAD_HOSTS as readonly string[]).includes(parsed.hostname)) {
      ctx.addIssue({ code: 'custom', message: `host must be one of: ${ALLOWED_DOWNLOAD_HOSTS.join(', ')}` });
    }
  });

export const ProviderIdSchema = z.enum(['hf', 'hf-mirror', 'modelscope', 'github', 'custom']);
export const BackendSchema = z.enum(['cuda', 'vulkan', 'rocm', 'metal', 'coreml', 'cpu']);
export const OsPlatformSchema = z.enum(['darwin', 'win32', 'linux']);
export const ArchSchema = z.enum(['x64', 'arm64']);

/* ------------------------------- artifacts -------------------------------- */

export const MirrorSchema = z.object({
  provider: ProviderIdSchema,
  url: DownloadUrlSchema,
  official: z.boolean(),
});

export const PlatformSelectorSchema = z.object({
  os: OsPlatformSchema,
  arch: ArchSchema,
  backend: BackendSchema.optional(),
});

export const ArtifactFileSchema = z.object({
  role: z.enum([
    'weights',
    'coreml-encoder',
    'mmproj',
    'library',
    'binary',
    'archive',
    // Multi-part sherpa-onnx topologies — see FILE_ROLES in artifacts.ts for why.
    'encoder',
    'decoder',
    'decoder-cached',
    'joiner',
    'preprocess',
    'tokens',
    'cmvn',
  ]),
  name: z
    .string()
    .min(1)
    // Path traversal guard. ComfyUI-Manager needed exactly this check after the fact.
    .refine((n) => !n.includes('/') && !n.includes('\\') && !n.includes('..'), {
      message: 'file name must be a bare basename with no path separators',
    }),
  sizeBytes: ByteSizeSchema,
  sha256: Sha256Schema,
  sha1: Sha1Schema.optional(),
  // Normally >= 1. Zero is permitted ONLY for pending-ci backend packs, where the
  // artifact is built and hashed but not yet published — enforced by BackendManifestSchema.
  mirrors: z.array(MirrorSchema),
  optional: z.boolean().optional(),
  platforms: z.array(PlatformSelectorSchema).optional(),
  unpack: z.enum(['zip', 'tar.gz', 'tar.xz']).nullish(),
});

export const LicenseInfoSchema = z.object({
  id: z.string().min(1),
  gated: z.boolean(),
  url: z.string().url(),
  requiresAcceptance: z.boolean().optional(),
});

export const ResourceRequirementsSchema = z.object({
  ramRequiredMB: z.number().int().positive(),
  vramRequiredMB: z.number().int().nonnegative(),
  diskRequiredMB: z.number().int().positive(),
  cpuFeatures: z.array(z.string()),
  // null = requirement is context-independent (Whisper). Never 0.
  computedAtContext: z.number().int().positive().nullable(),
});

export const GgufMetadataSchema = z.object({
  architecture: z.string(),
  blockCount: z.number().int().positive(),
  embeddingLength: z.number().int().positive(),
  headCount: z.number().int().positive(),
  headCountKv: z.number().int().positive(),
  keyLength: z.number().int().positive(),
  valueLength: z.number().int().positive(),
  contextLength: z.number().int().positive(),
  kvBytesPerToken: z.number().int().positive(),
});

export const ReferenceBenchmarkSchema = z.object({
  rtf: z.number().positive(),
  backend: BackendSchema,
  deviceName: z.string().min(1),
  measuredAt: z.string(),
  // Provenance is mandatory: a speed number without the machine, audio and language it
  // came from is exactly the kind of unsourced figure ADR-004 decision 3 bans.
  sampleName: z.string().min(1),
  sampleDurationSec: z.number().positive(),
  sampleLanguage: z.string().min(1),
  meanConfidence: z.number().min(0).max(1).optional(),
});

/**
 * Speed provenance. The three branches are deliberately NOT interchangeable shapes:
 *
 *   - `measured`   MUST carry the full benchmark record.
 *   - `estimated`  MUST name the entry it came from, the method, and an uncertainty > 1.
 *   - `unmeasured` is `.strict()` with no rtf key, so a number cannot be parked on it.
 *
 * `discriminatedUnion` (not a plain union) so a bad `kind` reports "unknown discriminator"
 * instead of a pile of unrelated branch errors that hide which field is actually wrong.
 */
export const SpeedEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('measured'),
      rtf: z.number().positive(),
      benchmark: ReferenceBenchmarkSchema,
    })
    .strict()
    // The two rtf values describe the same stopwatch reading; letting them differ would
    // recreate the two-sources-of-truth problem this field was added to remove.
    .refine((e) => e.rtf === e.benchmark.rtf, {
      message: 'speedEvidence.rtf must equal speedEvidence.benchmark.rtf',
    }),
  z
    .object({
      kind: z.literal('estimated'),
      rtf: z.number().positive(),
      basedOn: z.string().min(1),
      // Free text on purpose: an estimate has to be challengeable in words, and an enum
      // of blessed methods would just make the next unjustifiable estimate pick one.
      method: z.string().min(10, 'state how the estimate was derived, in words'),
      // Strictly > 1: an estimate with no uncertainty is claiming to be a measurement.
      uncertaintyFactor: z.number().gt(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unmeasured'),
      reason: z.enum(['not_run', 'artifact_differs', 'engine_unavailable', 'out_of_scope']),
    })
    .strict(),
]);

export const BenchmarkResultSchema = z.object({
  rtf: z.number().positive(),
  measuredAt: z.string(),
  backend: BackendSchema,
  deviceName: z.string(),
  sampleDurationSec: z.number().positive(),
});

/* -------------------------------- models ---------------------------------- */

export const QuantizationSchema = z.enum([
  'f32', 'f16', 'bf16',
  'q8_0', 'q6_k', 'q5_k_m', 'q5_1', 'q5_0', 'q4_k_m', 'q4_k_s', 'q4_0',
  'q3_k_m', 'q2_k', 'iq4_xs', 'iq3_m', 'iq2_m',
]);

export const ModelEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    groupId: z.string().min(1),
    role: z.enum(['asr', 'llm', 'vad', 'punctuation', 'diarization', 'embedding', 'tts']),
    family: z.string().min(1),
    arch: z.string().min(1),
    format: z.enum(['ggml', 'gguf', 'onnx', 'nemo', 'coreml']),
    quantization: QuantizationSchema,
    quantTier: z.enum(['small', 'balanced', 'large', 'full']),
    // 第二根筛选轴。必填：可空的话 UI 就得为"没有档位"再写一条分支，
    // 而那条分支永远只会因为清单漏填而触发。
    speedClass: z.enum(['fast', 'balance', 'quality']),
    displayName: z.string().min(1),
    displayNameZh: z.string().min(1),
    descriptionZh: z.string(),
    descriptionEn: z.string(),
    languages: z.array(z.string()).min(1),
    tags: z.array(z.string()),
    // Which engines can load this file. Required: a model nobody can load is not a model.
    engines: z
      .array(z.enum(['whisper.cpp', 'llama.cpp', 'sherpa-onnx', 'ffmpeg', 'yt-dlp', 'sqlite-ext']))
      .min(1, 'at least one engine must be able to load this model'),
    // ADR-011 decision 1 — languages where we MEASURED the output to be unacceptable.
    notRecommendedFor: z.array(z.string()).optional(),
    files: z.array(ArtifactFileSchema).min(1),
    totalSizeBytes: ByteSizeSchema,
    requirements: ResourceRequirementsSchema,
    gguf: GgufMetadataSchema.optional(),
    // ADR-013 decision 1 — trade-offs must be stated, not discovered.
    capabilityCaveats: z.array(z.string()).optional(),
    license: LicenseInfoSchema,
    source: z.object({
      provider: ProviderIdSchema,
      repo: z.string().min(1),
      revision: z.string().min(1),
    }),
    benchmark: BenchmarkResultSchema.nullable(),
    // Required, not optional: "we never measured it" must be stated, not inferred from a
    // missing key. `.strict()` above additionally makes the retired `referenceBenchmark`
    // key a hard validation error, so a stale manifest cannot half-migrate in silence.
    speedEvidence: SpeedEvidenceSchema,
    catalogVersion: z.string().min(1),
  })
  // Reject the fabricated-metric fields memo.ac ships, so they cannot creep back in.
  .strict()
  .refine(
    (m) => m.totalSizeBytes === sumRequiredFileBytes(m.files),
    { message: 'totalSizeBytes must equal the sum of non-optional file sizes' },
  )
  .refine((m) => m.gguf == null || m.format === 'gguf', {
    message: 'gguf metadata is only valid on format="gguf" entries',
  })
  .refine(
    (m) =>
      m.gguf == null ||
      m.gguf.kvBytesPerToken ===
        m.gguf.blockCount * m.gguf.headCountKv * (m.gguf.keyLength + m.gguf.valueLength) * 2,
    { message: 'kvBytesPerToken is inconsistent with the GGUF header fields' },
  );

function sumRequiredFileBytes(files: { sizeBytes: number; optional?: boolean }[]): number {
  return files.filter((f) => !f.optional).reduce((a, f) => a + f.sizeBytes, 0);
}

export const ModelManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogVersion: z.string().min(1),
    generatedAt: z.string(),
    models: z.array(ModelEntrySchema),
  })
  .strict()
  .refine((m) => new Set(m.models.map((x) => x.id)).size === m.models.length, {
    message: 'duplicate model id',
  })
  .superRefine((m, ctx) => {
    // One sha256 must never map to two different sizes — that means someone typed a
    // number by hand. This is the check that would have caught conflating
    // ggml-tiny.bin (77,691,713) with ggml-tiny.en.bin (77,704,715).
    const bySha = new Map<string, number>();
    for (const model of m.models) {
      for (const f of model.files) {
        const prev = bySha.get(f.sha256);
        if (prev != null && prev !== f.sizeBytes) {
          ctx.addIssue({
            code: 'custom',
            message: `sha256 ${f.sha256.slice(0, 12)}… declared with two different sizes (${prev} vs ${f.sizeBytes})`,
          });
        }
        bySha.set(f.sha256, f.sizeBytes);
      }
    }
  });

/* ------------------------------- backends --------------------------------- */

export const BackendPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    engine: z.enum(['whisper.cpp', 'llama.cpp', 'sherpa-onnx', 'ffmpeg', 'yt-dlp', 'sqlite-ext']),
    engineVersion: z.string().min(1),
    ggmlAbi: z.string().nullable(),
    backend: BackendSchema,
    tier: z.enum(['builtin', 'downloadable']),
    os: OsPlatformSchema,
    arch: ArchSchema,
    displayName: z.string().min(1),
    displayNameZh: z.string().min(1),
    files: z.array(ArtifactFileSchema).min(1),
    totalSizeBytes: ByteSizeSchema,
    cudaArchitectures: z.array(z.string()).optional(),
    requiresDriver: z
      .object({
        nvidiaDriver: z.string().optional(),
        vulkanApi: z.string().optional(),
        rocmVersion: z.string().optional(),
        macosVersion: z.string().optional(),
      })
      .nullable(),
    license: LicenseInfoSchema,
    providesFiles: z.array(z.string()).min(1),
    // Optional: only sqlite-ext packs are linked into a shared directory. See
    // BackendPack.linkInto for why backend packs must NOT declare one.
    linkInto: z.string().min(1).optional(),
    priority: z.number().int(),
    availability: z.enum(['published', 'pending-ci']).default('published'),
    benchmark: z.null(),
    catalogVersion: z.string().min(1),
  })
  .strict();

export const BackendManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogVersion: z.string().min(1),
    generatedAt: z.string(),
    packs: z.array(BackendPackSchema),
  })
  .strict()
  .superRefine((m, ctx) => {
    // A published pack must be reachable; a pending-ci pack must NOT pretend to be.
    for (const p of m.packs) {
      const hasUrl = p.files.some((f) => f.mirrors.length > 0);
      if (p.availability === 'published' && !hasUrl) {
        ctx.addIssue({ code: 'custom', message: `pack ${p.id} is 'published' but has no mirror URL` });
      }
    }
  })
  .refine((m) => new Set(m.packs.map((p) => p.id)).size === m.packs.length, {
    message: 'duplicate pack id',
  });

/* ------------------------------- hardware --------------------------------- */

export const HardwareInfoSchema = z.object({
  schemaVersion: z.literal(1),
  detectedAt: z.string(),
  os: z.object({
    platform: OsPlatformSchema,
    arch: ArchSchema,
    version: z.string(),
  }),
  cpu: z.object({
    brand: z.string(),
    physicalCores: z.number().int().positive(),
    logicalCores: z.number().int().positive(),
    features: z.array(z.string()),
  }),
  ram: z.object({
    totalMB: z.number().int().positive(),
    availableMB: z.number().int().nonnegative().nullable(),
  }),
  unifiedMemory: z.boolean(),
  gpus: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      vendor: z.enum(['nvidia', 'amd', 'intel', 'apple', 'other']),
      name: z.string(),
      vramTotalMB: z.number().int().nonnegative().nullable(),
      vramFreeMB: z.number().int().nonnegative().nullable(),
      driverVersion: z.string().nullable(),
      capabilities: z.record(z.string(), z.string()),
      backends: z.array(BackendSchema),
    }),
  ),
  backends: z.array(
    z.object({
      id: BackendSchema,
      available: z.boolean(),
      installed: z.boolean(),
      probed: z.boolean(),
      version: z.string().nullable(),
      deviceIndex: z.number().int().nullable(),
      isa: z.string().nullish(),
      unavailableReason: z.string().nullish(),
    }),
  ),
  selectedBackend: BackendSchema,
  selectedGpuIndex: z.number().int().nullable(),
  disks: z.array(
    z.object({
      mount: z.string(),
      pathFor: z.enum(['models_root', 'runtimes_root', 'other']),
      path: z.string(),
      freeMB: z.number().int().nonnegative(),
      totalMB: z.number().int().positive(),
    }),
  ),
});

/* -------------------------------- helpers --------------------------------- */

export interface ValidationResult<T> {
  ok: boolean;
  data: T | null;
  errors: string[];
}

/** Structurally typed so it survives zod major-version renames of the result type. */
type SafeParseLike<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };

function toResult<T>(parsed: SafeParseLike<T>): ValidationResult<T> {
  if (parsed.success) return { ok: true, data: parsed.data, errors: [] };
  return {
    ok: false,
    data: null,
    errors: parsed.error.issues.map(
      (i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`,
    ),
  };
}

export const InstalledFileSchema = z.object({
  role: z.string(),
  name: z.string().min(1),
  sha256: Sha256Schema,
  sizeBytes: ByteSizeSchema,
  root: z.enum(['models', 'runtimes', 'data']),
  relPath: z
    .string()
    .min(1)
    // A relative path that escapes its root is the same traversal bug as in archives.
    .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]+/).includes('..'), {
      message: 'relPath must stay inside its root (no absolute paths, no "..")',
    }),
  /** @deprecated legacy absolute path */
  path: z.string().optional(),
});

export function validateModelManifest(input: unknown) {
  return toResult(ModelManifestSchema.safeParse(input));
}

export function validateBackendManifest(input: unknown) {
  return toResult(BackendManifestSchema.safeParse(input));
}

export function validateHardwareInfo(input: unknown) {
  return toResult(HardwareInfoSchema.safeParse(input));
}


/* ------------------------- F1/F2/F5 notes domain -------------------------- */
/* Shapes adopted verbatim from oss-scout's shipped daemon (ADR-012). */

export const UlidSchema = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'must be a 26-character ULID');

export const ImportNoteRequestSchema = z
  .object({
    input: z.string().min(1, 'input is required (absolute local path or URL)'),
    title: z.string().optional(),
    // Explicitly nullable, never absent-by-accident: an empty language makes whisper.cpp
    // silently translate non-English audio to English.
    language: z.string().nullish(),
  })
  .strict();

export const TranscriptSegmentSchema = z.object({
  seq: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
  confidence: z.number().nullable(),
  chunkIdx: z.number().int().nullable(),
  flags: z.number().int().nonnegative(),
  edited: z.boolean(),
});

export const SearchHitSchema = z.object({
  noteUid: UlidSchema,
  noteTitle: z.string(),
  transcriptUid: UlidSchema.nullable(),
  seq: z.number().int().nullable(),
  startMs: z.number().int().nullable(),
  endMs: z.number().int().nullable(),
  snippet: z.string(),
  score: z.number(),
  source: z.enum(['segment', 'note']),
});

export const SearchResponseSchema = z.object({
  query: z.string(),
  hits: z.array(SearchHitSchema),
  modes: z.object({
    keyword: z.boolean(),
    semantic: z.boolean(),
    tokenizer: z.enum(['simple', 'trigram']),
  }),
});

export function validateImportNoteRequest(input: unknown) {
  return toResult(ImportNoteRequestSchema.safeParse(input));
}
export function validateSearchResponse(input: unknown) {
  return toResult(SearchResponseSchema.safeParse(input));
}
