/**
 * 模型域对外出口（T-022 独占）。
 *
 * 注意：按 D-05 §3.5 的依赖方向规则，**其它 feature 不应该 import 本文件** ——
 * 需要复用的东西提升到 `components/common/`（`AsrModelPicker` 就是走完这条路的那个）。
 * 这里导出的是路由与 SSE 分片，供顶层聚合文件使用。
 *
 * ⚠️ **订正**：这句话原先把 `FitBadge` 和 `ModelPicker` 并列，写成两个都"已经提升到
 * `components/common/`"。`FitBadge` 那半句是假的：它虽然摆在 `components/common/` 里，
 * 消费方却自始至终只有本 feature（`ModelDetailPage` / `ModelCard` / `QuantSelector`），
 * 而 `ModelPicker` 这个名字全仓根本不存在（真名是 `AsrModelPicker`）。
 * 现在 `FitBadge` 已搬回 `./components/FitBadge`。
 *
 * 提升的判据是 D-05 §3.3 规则 4：**被第二个 feature 需要时**才提升，不要预先猜。
 * 反过来这条注释就是它的代价 —— 单消费方的东西留在共享层里，读的人会以为
 * 共享层比实际大，于是照着一个不存在的复用关系做决定。
 */
export { modelsRoutes } from './Models.routes';
export { modelsSse } from './sse';
