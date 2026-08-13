import { useTranslation } from 'react-i18next';
import { ChevronRight, Cpu, HardDrive, MemoryStick, MonitorCog } from 'lucide-react';
import type {
  AdvisoryUndeterminedReason,
  Backend,
  GetHardwareResponse,
  HardwareInfo,
} from '@openmemo/shared';
import { BackendChip } from '../../../components/common/BackendChip';
import { Emphasis } from '../../../components/common/Emphasis';
import { formatBytes } from '../../../lib/format/bytes';
import { UNAVAILABLE_REASON_KEYS } from '../reasonKeys';

/**
 * 哪些后端**有资格枚举显卡**。总 `Record` —— 新增一种后端而没人表态，**构建就红**。
 *
 * 判据不是"名字里有没有 GPU"，是「probe 加载它之后，`ggml_backend_dev_type` 有可能
 * 报出 `gpu` / `igpu`」。`cpu` 显然不算；`coreml` 也不算 —— 它不是一个可 dlopen 的
 * ggml backend（CoreML 是 PRIVATE 链进 libwhisper 的，`vendor/whisper.cpp/src/CMakeLists.txt`），
 * 所以它永远不会出现在 `probedBackendsInDir()` 的结果里，拿它当"查过显卡"的证据是假的。
 */
const BACKEND_CAN_ENUMERATE_GPU: Readonly<Record<Backend, boolean>> = {
  cuda: true,
  vulkan: true,
  rocm: true,
  metal: true,
  coreml: false,
  cpu: false,
};

/**
 * 这一轮**到底有没有去看过显卡**。
 *
 * ─── 这条判据为什么必须换掉（T-195，用户真机 win32/x64 10.0.26200）────────────────
 *
 * 用户的 AMD Ryzen 7 7840HS **w/ Radeon 780M Graphics** 上，卡片写着
 * 「未检测到可用 GPU」——**而 CPU 那栏自己就印着 `Radeon 780M Graphics`**。
 *
 * 上一版的判据是 `hw.backends.some((b) => b.installed)`：**装了任何后端包**就算"查过了"。
 * 那是错的，而且错得很具体 —— `HardwareInfo.gpus` **完全由 probe 的枚举结果构造**
 * （`buildHardwareInfo`），而 probe 只能用**它扫的那一个目录里**的 ggml 库去枚举
 * （`ggml_backend_load_all_from_path`，单值 `backendDir`）。装了 CPU 包 ⇒
 * `some(b => b.installed)` 为真 ⇒ 界面宣称"查过了，没有" ——
 * **而机器上根本没有任何能枚举显卡的库被加载过。**
 *
 * 正确的判据是 `BackendStatus.probed`（T-168 就是为这件事加的字段：
 * 「这一轮到底有没有加载过这个后端的库」），且只看**有资格枚举显卡**的那几个。
 */
export function gpuEnumerationHappened(hw: HardwareInfo): boolean {
  return hw.backends.some((b) => BACKEND_CAN_ENUMERATE_GPU[b.id] && b.probed);
}

/**
 * 「判断不了」的每一种原因该说哪句话。**总 `Record`** —— 契约里新增一种原因而没人
 * 给它写话，**构建就红**（`AdvisoryUndeterminedReason` 一变，这里少一格就编译不过）。
 *
 * 为什么非要一张表：上一版这句话是 daemon 拼好的整句中文，界面原样渲染 ——
 * 那意味着**英文界面上会出现一整句中文**。措辞留在这一侧，两份 locale 才对得起来
 * （`check-locale-ratchet.mjs` 会替我们盯住"两份 key 集合一致"）。
 */
/**
 * 这七档的措辞**已搬去 `../reasonKeys`**（#106）。
 *
 * 搬家的理由不是整洁：后端包卡片上那句「这个包为什么装不了」原来走的是
 * daemon 拼的中文散文（`applicability.ts`），而它的成因就是同一个
 * `BackendUnavailableKind`。同一个成因在同一页上有两种说法，其中一种在英文
 * 界面上还是中文。现在两处共用同一张表。
 */
const UNDETERMINED_REASON_KEYS: Readonly<Record<AdvisoryUndeterminedReason, string>> = {
  virtual_adapter: 'runtime.hw.gpuVirtualUndetermined',
};

/**
 * 硬件探测结果卡（章程要求 2.1 的第一步："网页检测硬件"）。
 *
 * ★ 显存显示 **可用/总量** 两个数字，不是只显示总量。
 * LM Studio 的 Settings > Hardware 只显示总量，结果在多应用抢显存时把模型误判成
 * "Full GPU Offload Possible"，加载直接 OOM（其 issue #67）。我们两个都给。
 * `vramFreeMB` 为 null 时明确写"未知"，不拿总量冒充可用量。
 */

export function HardwareCard({
  hw,
  locale,
  runtime,
}: {
  hw: HardwareInfo;
  locale: string;
  /** daemon 的诊断字段。**可选**：`models.ts` 那条兜底路由不带它（见契约注释）。 */
  runtime?: GetHardwareResponse['runtime'];
}) {
  const { t } = useTranslation();
  const gpu = hw.selectedGpuIndex != null ? hw.gpus[hw.selectedGpuIndex] : null;
  const modelsDisk = hw.disks.find((d) => d.pathFor === 'models_root') ?? hw.disks[0];
  const probedForGpu = gpuEnumerationHappened(hw);
  /**
   * 操作系统层面**独立于"装没装包"**的证据（`Get-CimInstance Win32_VideoController` /
   * sysfs DRM / nvidia-smi 认为本机可能支持哪些后端）。
   * `undefined` = 老 daemon 不发这个字段；`[]` = **没有独立证据**，
   * **不是**"本机没有显卡"（powershell 失败、sysfs 读不到都会是空）。
   */
  const advisory = runtime?.advisoryBackends;
  /**
   * 系统层面**逐块看见的**显示适配器。名字直接来自
   * `Get-CimInstance Win32_VideoController` / sysfs / nvidia-smi。
   *
   * ⚠️ **绝不混进 `hw.gpus`。** 那个字段是"探针枚举到、可以拿来算显存与后端可用性"的设备；
   * 这个只是"操作系统说这台机器上插着什么"。混进去会污染 fit 计算与后端选择
   * （`detect/gpu.ts` 抬头两个实测反例：库在但无 GPU；lavapipe 报一个 CPU 设备）。
   * **它只用来说话。**
   *
   * ★ #86：**「我们看见一块卡」与「我们看见一个虚拟机适配器」不是同一句话。**
   * 这里原来是 `advisoryGpus.map(g => g.name)` —— 一视同仁。于是虚拟机里那块
   * `Microsoft Hyper-V Video` 被当成"你的卡"说了两遍假话：
   *   · 探测前：「**这块卡我们看见了**，只是还没装上能用它的后端包（可能支持 vulkan）」
   *   · 探测后：「所以**卡在我们这一侧，不是你没有显卡**」——
   *     更糟，它无条件断言用户有显卡，还把他支回我们这边继续找问题。
   * 现在按 `verdict` 分开：`undetermined` 的那些**不算"看见的卡"**，
   * 它们带着自己的理由单独说一句「判断不了」。
   *
   * ⚠️ `verdict` 缺失时**退回旧行为**（当成 candidate）：老 daemon 发的
   * `candidateBackends` 语义就是它。这是向后兼容，不是一次新的判断。
   */
  const advisoryGpus = runtime?.advisoryGpus ?? [];
  const seenAdapters = advisoryGpus
    .filter((g) => g.verdict?.kind !== 'undetermined')
    .map((g) => g.name)
    .filter(Boolean);
  /**
   * 「我们判断不了」那一档要说的话 —— **在这一侧组装，不是 daemon 递一句中文过来**。
   *
   * 上一版是 daemon 直接给整句中文、这里原样渲染。那句话**没法翻译**：
   * 英文界面上会冒出一整句中文 —— 而"往 `en.json` 里塞中文"正是本版在治的形状
   * （v0.7.1 已知边界里那颗写死中文的「检查更新」按钮）。
   * 现在 daemon 只说**原因**（`AdvisoryUndeterminedReason`）和**装什么才问得出答案**
   * （`probeWith`），措辞在下面那张总 `Record` 里 —— 新增一种原因而没人给它写话，
   * **构建当场就红**，不会静默退化成一句空白。
   *
   * ⚠️ 它不是"技术细节"，是这一档**唯一的正文**：省掉或折叠它，
   * 用户就只剩一句"还没查过"，而「这台机器上到底能不能用 GPU 加速」
   * 这个问题**我们回答了没有**，他仍然不知道。
   */
  const undeterminedNotes = advisoryGpus.flatMap((g) =>
    g.verdict?.kind === 'undetermined'
      ? [
          {
            key: g.name,
            text: t(UNDETERMINED_REASON_KEYS[g.verdict.reason], {
              adapter: g.name,
              backends: g.verdict.probeWith.join(' / '),
            }),
          },
        ]
      : [],
  );

  return (
    <section
      className="rounded-lg border border-line bg-surface-1 p-4"
      data-testid="runtime-hardware-card"
    >
      <h2 className="text-sm font-medium text-ink">{t('runtime.hw.title')}</h2>

      <dl className="mt-3 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
        <Row icon={<MonitorCog className="size-4" />} label={t('runtime.hw.gpu')}>
          {gpu ? (
            <>
              <span className="text-ink">{gpu.name}</span>
              <span className="text-ink-secondary">
                {t('runtime.hw.vram', {
                  total:
                    gpu.vramTotalMB != null
                      ? formatBytes(gpu.vramTotalMB * 1e6, locale)
                      : t('runtime.hw.unknown'),
                  free:
                    gpu.vramFreeMB != null
                      ? formatBytes(gpu.vramFreeMB * 1e6, locale)
                      : t('runtime.hw.unknown'),
                })}
              </span>
            </>
          ) : hw.unifiedMemory ? (
            <span className="text-ink">{t('runtime.hw.unifiedMemory')}</span>
          ) : /*
              ★★ 三态，不是两态（T-195）。

              📝 **此前这里写的是** `hw.backends.some((b) => b.installed) ? noGpu : …` ——
              「装了任何后端包」就算"查过了"。用户真机（win32/x64，Ryzen 7 7840HS
              **w/ Radeon 780M Graphics**）上，装的是 CPU 包，于是这条为真、
              界面宣称「未检测到可用 GPU」——**而机器上根本没有任何能枚举显卡的库被加载过**。
              CPU 那栏自己就印着 `Radeon 780M Graphics`，隔壁却说没有显卡。

              判据换成 `BackendStatus.probed`（T-168 正是为"这轮有没有加载过它"加的字段），
              且只看**有资格枚举显卡**的那几个后端。三档：

                ① 没有任何 GPU 后端被加载 → **我们没查过**（附上系统层面的独立证据，如果有）
                ② 查过了、且系统也说没有   → 真的没有可用 GPU
                ③ 查过了、但系统说有       → 有卡，我们这套没能用上它（第二态，值得单说）
            */
          !probedForGpu ? (
            <span className="text-ink-secondary" data-testid="hw-gpu-unprobed">
              {t('runtime.hw.gpuNotProbed')}
              {/*
                  ★ **我们看见的那块卡，要说出它的名字。**
                  用户那台的 CPU 那栏自己就印着 `Radeon 780M Graphics`，
                  隔壁却说"没有显卡" —— 而同一次 advisory 探测其实**是有那块卡的**。
                  说出名字，"这是我们这边还没装上东西"与"你没有显卡"才分得开。
                */}
              {seenAdapters.length > 0 ? (
                <span className="block text-ink" data-testid="hw-gpu-advisory-seen">
                  {t('runtime.hw.gpuAdvisorySeen', {
                    adapters: seenAdapters.join('、'),
                    backends: (advisory ?? []).join(' / '),
                  })}
                </span>
              ) : null}
              {/*
                  ★ #86 第三态：**「我们判断不了」要说出口，而且要说清下一步。**
                  这几句由 daemon 逐块给（每块虚拟适配器一句，含"装哪个包能问出答案"）。
                  它**不与上面那句合并**：上面说的是"我们看见了一块卡"，
                  这里说的是"我们看见的是虚拟机的适配器，它背后有没有卡我们不知道" ——
                  合并回一句就等于回到那个两态。
                */}
              {undeterminedNotes.map((n) => (
                <span className="block text-ink" data-testid="hw-gpu-undetermined" key={n.key}>
                  {n.text}
                </span>
              ))}
            </span>
          ) : seenAdapters.length > 0 ? (
            <span className="text-warning" data-testid="hw-gpu-probed-but-unusable">
              {t('runtime.hw.gpuProbedUnusable', { adapters: seenAdapters.join('、') })}
            </span>
          ) : (
            /*
             * ★ #86：探针**跑过了**（`probedForGpu`）而且一个设备都没枚举到 ——
             * 这时候 probe 就是权威，答案是"这台机器上没有能用的 GPU"，句号。
             *
             * 虚拟适配器在这一档**刻意不再出现**：装上包探一次正是我们让用户做的事，
             * 他做完了，问题就有答案了。继续说"判断不了"是把一个已经回答的问题
             * 重新说成悬案；而说成 `gpuProbedUnusable`（「不是你没有显卡」）
             * 则是拿一个虚拟适配器去断言用户有显卡 —— 那正是这次要修掉的那句。
             */
            <span className="text-ink-secondary" data-testid="hw-gpu-none">
              {t('runtime.hw.noGpu')}
            </span>
          )}
        </Row>

        <Row icon={<MemoryStick className="size-4" />} label={t('runtime.hw.ram')}>
          <span className="text-ink">{formatBytes(hw.ram.totalMB * 1e6, locale)}</span>
          {hw.ram.availableMB != null ? (
            <span className="text-ink-secondary">
              {t('runtime.hw.ramAvailable', {
                free: formatBytes(hw.ram.availableMB * 1e6, locale),
              })}
            </span>
          ) : null}
        </Row>

        <Row icon={<Cpu className="size-4" />} label={t('runtime.hw.cpu')}>
          <span className="text-ink">{hw.cpu.brand}</span>
          <span className="text-ink-secondary">
            {t('runtime.hw.cores', {
              physical: hw.cpu.physicalCores,
              logical: hw.cpu.logicalCores,
            })}
          </span>
          {/*
            AVX2 缺失是**硬约束**：预编译的 CPU 后端普遍要求它。
            但它是 **x86 专属**的维度 —— 在 arm64（Apple Silicon）上根本不存在这个概念。

            ⚠️ 原来这里只判 `!features.includes('avx2')`，于是 M 系列 Mac 上必然为真，
            用户看到的是「Apple M4 · 10 核 / 10 线程 · **不支持 AVX2**」并且是红色告警色。
            用户 2026-08-08 因此以为自己的 M4 缺了什么 —— 而 M4 不支持 AVX2
            既不是缺陷也不是降级，**是一个不适用的维度**。

            判据：**「不适用」和「不支持」必须区分得开。**
            前者不该出现，后者才该报警。所以这一行只在 x64 上渲染。
          */}
          {/*
            ★★ 三态，不是两态。上一次修复只分出了「不适用」与「不支持」，
            而**空集合仍然被渲染成"已知的不支持"** —— 那正是 Windows 上的现状：
            `detectCpuWin32()` 无条件返回 `features: []`，它**从来没查过任何指令集标志**。
            于是每一台 Windows 机器都被红字告知「不支持 AVX2」，包括支持 AVX2/AVX-512 的
            Ryzen 7 7840HS。**用户读到的是"我的 CPU 不行"，而真相是"我们从来没看过"。**

            · arm64            → 一个字都不说（AVX2 是 x86 概念，**不适用**）
            · x64 且查到了特性 → 有 avx2 就不说；没有才红字「不支持」（**确实查过**）
            · x64 但特性集为空 → 灰字「无法确认」（**未知**）——不报警、也不假称支持
          */}
          {hw.os.arch !== 'x64' ? null : hw.cpu.features.length === 0 ? (
            <span className="text-ink-secondary">{t('runtime.hw.avx2Unknown')}</span>
          ) : !hw.cpu.features.includes('avx2') ? (
            <span className="text-critical">{t('runtime.hw.noAvx2')}</span>
          ) : null}
        </Row>

        <Row icon={<HardDrive className="size-4" />} label={t('runtime.hw.modelsDir')}>
          {modelsDisk ? (
            <>
              <span className="block truncate font-mono text-[11px] text-ink">
                {modelsDisk.path}
              </span>
              <span className="text-ink-secondary">
                {t('runtime.hw.diskFree', {
                  free: formatBytes(modelsDisk.freeMB * 1e6, locale),
                  total: formatBytes(modelsDisk.totalMB * 1e6, locale),
                })}
              </span>
            </>
          ) : (
            <span className="text-ink-secondary">{t('runtime.hw.unknown')}</span>
          )}
        </Row>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
        <span className="text-xs text-ink-secondary">{t('runtime.hw.backendsLabel')}</span>
        {hw.backends.map((b) => (
          <BackendChip
            key={b.id}
            backend={b.id}
            state={
              /*
               * ★ 这里此前**不读 `probed`** —— `installed:true, probed:false` 的后端
               *   与真正加载成功的显示同一个「已安装」，T-168 建立的区分
               *   在最后一跳上死掉了（那句"这一轮没有去加载它"只在折叠的 details 里）。
               *   现在装在盘上但这轮没被加载的单独成一档。
               *
               * ★ T-196：`platform_unsupported` 排在**最前面**，比 `installed` 还靠前 ——
               *   Metal/CoreML 在 Windows 上 `installed` 恒为 false，落到最后就是「不可用」，
               *   与「还没装」显示成同一个东西。**判据是字段不是文案**：读
               *   `unavailableKind`，绝不去匹配 `unavailableReason` 那句英文。
               */
              hw.selectedBackend === b.id
                ? 'active'
                : b.unavailableKind === 'platform_unsupported'
                  ? 'other-platform'
                  : b.bundled && !b.installed
                    ? // 出厂自带那份在兜底：能用，但**没有装任何包**（T-197）
                      'bundled'
                    : b.installed
                      ? b.probed
                        ? 'installed'
                        : 'installed-unprobed'
                      : b.available
                        ? 'available'
                        : 'not-installed'
            }
          />
        ))}
      </div>

      {/*
        探测不可用时给出真实原因，而不是笼统的"不可用"。

        ⚠️ 但**默认折叠**。这里原来是直接摊开的一个 `<ul>`，实测在本机渲染成 6 行：
        `cuda：probe did not complete: probe executable not found: /tmp/…/bin/runtime/probe`
        —— 英文、带绝对路径、六行几乎一模一样。它出现在整页最上方那张卡里，
        成了用户进 `/runtime` 第一眼看到的东西。

        D-05 §5.3 第 3 条写得很直白：**禁止把 `error.detail` 原样甩给用户，
        技术细节折叠在 `[查看详情]` 里**。这就是那一条的落地 ——
        信息一个字没少（点开就有，可复制去提 issue），但不再占据首屏。
        芯片行上已经用 `不可用` 说明了结论，细节是给排查的人看的，不是给所有人看的。
      */}
      {hw.backends.some((b) => !b.available && b.unavailableReason) ? (
        <details className="group mt-2">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-ink-muted hover:text-ink-secondary">
            <ChevronRight
              className="size-3 transition-transform group-open:rotate-90"
              aria-hidden
            />
            {t('runtime.hw.whyUnavailable', {
              n: hw.backends.filter((b) => !b.available && b.unavailableReason).length,
            })}
          </summary>
          <ul className="mt-1.5 space-y-0.5 border-l-2 border-line pl-2.5">
            {hw.backends
              .filter((b) => !b.available && b.unavailableReason)
              .map((b) => (
                <li key={b.id} className="text-[11px] break-all text-ink-muted">
                  {/*
                    ★★ #105 ③：**七档全都说人话，不只 `platform_unsupported` 那一档。**

                    这里原来是个二分：认得 `platform_unsupported` 就给中文 + 英文尾巴，
                    其余**一律**把 `unavailableReason` 原样甩出去 ——
                    于是中文界面上出现 `cuda：backend package not installed` 三条。

                    「装不了」和「还没装」**永远不合并成一句好听的话** ——
                    它们对用户是两条不同的指令，后者让他去装，前者照做就是去找一个
                    不可能存在的包。现在七档各说各的（见 `UNAVAILABLE_REASON_KEYS`）。

                    `unavailableKind` 缺失（老 daemon）时**照旧只显示英文原文** ——
                    我们不知道它是哪一档，替它挑一句中文就是编。
                  */}
                  {b.unavailableKind != null ? (
                    <>
                      <span data-testid={`hw-unavailable-${b.id}`}>
                        {b.id}：
                        <Emphasis text={t(UNAVAILABLE_REASON_KEYS[b.unavailableKind])} />
                      </span>
                      {/* 英文原文降级成技术尾巴（D-05 §5.3）：排障拿得到，但不占正文 */}
                      <span className="mt-0.5 block font-mono opacity-70">
                        {b.unavailableReason}
                      </span>
                    </>
                  ) : (
                    <span className="font-mono">
                      {b.id}：{b.unavailableReason}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </details>
      ) : null}

      <p className="mt-2 text-[11px] text-ink-muted">
        {t('runtime.hw.detectedAt', {
          at: new Date(hw.detectedAt).toLocaleString(locale),
          platform: hw.os.platform,
          arch: hw.os.arch,
          version: hw.os.version,
        })}
      </p>
    </section>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-ink-muted">
        <span aria-hidden>{icon}</span>
        {label}
      </dt>
      <dd className="mt-0.5 min-w-0">{children}</dd>
    </div>
  );
}
