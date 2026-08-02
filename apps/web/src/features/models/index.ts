/**
 * 模型域对外出口（T-022 独占）。
 *
 * 注意：按 D-05 §3.5 的依赖方向规则，**其它 feature 不应该 import 本文件** ——
 * 需要复用的东西（ModelPicker / FitBadge）已经提升到 `components/common/`。
 * 这里导出的是路由与 SSE 分片，供顶层聚合文件使用。
 */
export { modelsRoutes } from './Models.routes';
export { modelsSse } from './sse';
