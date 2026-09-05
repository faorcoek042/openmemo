import { useQuery } from '@tanstack/react-query';
import type { GetHardwareResponse } from '@openmemo/shared';

import { api } from './client';
import { qk, STALE_TIME_OVERRIDES } from '../../app/query';

/**
 * 硬件探测结果 —— **提升到共享层**（T-153）。
 *
 * ## 为什么它从 `features/runtime/api.ts` 搬到了这里
 *
 * `features/models` 需要知道"这台机器是不是 Apple Silicon"（`ModelCard` 要决定
 * 该不该提供 CoreML encoder 这个可选下载），而 `eslint.config.js` 的分层护栏
 * **禁止 `features/A` import `features/B`**（D-05 §3.5）。
 * 那条禁令给的正解就是「把要复用的东西提升到共享层 + 申报」，所以这里是提升，
 * 不是复制：`features/runtime/api.ts` 现在**再导出**同一个函数，
 * 两处共用同一个 `queryKey`，react-query 会去重，不会因此多探一次硬件。
 *
 * （硬件探测要起独立子进程真正枚举设备，R-02 实测 `system_profiler` 可达数秒级 ——
 *  "多探一次"不是小事，这也是必须共用而不是各写一份的原因。）
 *
 * `staleTime` 放宽到 5 分钟（`app/query.ts` 的约定）。
 *
 * ## ★ `'runtime'` 这个 surface 实参不是装饰
 *
 * 它原本是裸的 `api('/runtime/hardware')` ⇒ 落进 `'generic'`。而 `'generic'` 按
 * `lib/api/surfaces.ts` 的定义是「**未声明 surface** 的调用落点，不计入统计」——
 * 于是 `/api/runtime/*` 这一整个面**结构上永远停在 `'unknown'`**：
 * 没有任何 `markSurface('runtime', …)`、也没有任何 `api('runtime', …)` 能改写它。
 *
 * 直接后果是引导页第二步（"看看你的硬件"）那句
 * `<MockNotice surface="runtime" />` **永远渲染不出来**：daemon 没起、或这个端点还没实现时，
 * 用户在那一步看到的是一片什么都不说的界面，而产品原本承诺在这里告诉他"这块是假的"。
 *
 * ⚠️ 现在由 `lib/api/queryAndSurface.test.ts` 钉住：界面上用 `<MockNotice surface=X>`
 * 承诺要报告的每一个面，仓里必须真的存在能写它的调用点。
 */
export function useHardwareQuery() {
  return useQuery({
    queryKey: qk.runtime.hardware,
    queryFn: () => api<GetHardwareResponse>('runtime', '/runtime/hardware'),
    staleTime: STALE_TIME_OVERRIDES.hardware,
  });
}

/**
 * 这台机器是不是 Apple Silicon（CoreML / ANE 的唯一适用平台）。
 *
 * 三态，**"还不知道"必须与"不是"分开**：探测没回来时返回 `null`，
 * 界面据此不渲染任何与 ANE 有关的东西 —— 而不是先当成"不是 Mac"渲染一遍再跳变。
 * （T-060 那次"检测中"与"检测过了但不可用"必须分开，是同一条。）
 */
export function useIsAppleSilicon(): boolean | null {
  const hw = useHardwareQuery();
  if (!hw.data) return null;
  const os = hw.data.hardware.os;
  return os.platform === 'darwin' && os.arch === 'arm64';
}
