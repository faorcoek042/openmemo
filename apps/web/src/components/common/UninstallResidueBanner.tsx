import { useTranslation } from 'react-i18next';
import type { RefusedFileReport } from '@openmemo/shared';

import { Banner } from './Banner';

/**
 * 「卸载已经生效，但有几个文件我们没删」—— 两个卸载入口共用的那一句话（#109）。
 *
 * ## 为什么它非说不可
 *
 * `795f091` 让 `DELETE /api/models/:id` 与 `DELETE /api/backends/:id` 在**有拒绝时**
 * 回 `200 + filesNotRemoved`（干净的那条路仍然是 204）。**但那只到服务端边界**：
 * 响应体 + 一条 `console.warn`，而两个 web 调用方都是 `api<void>(…)` —— body 被整个
 * 丢掉。用户点了卸载，卡片消失，盘上留着几百 MB，界面**一个字都没说过**。
 *
 * ## 🔴 顺序是判据的一部分：**先说「记录已经清掉了」**
 *
 * 这条是 #107 那一轮留下的教训，不是文案偏好：用户点卸载、看到「有 N 个文件没能删」，
 * 最自然的解读是「卸载失败了，我再点一次」—— 而记录其实已经走了，**再点会拿到 404**。
 * 所以 `uninstall.recordRemovedFilesKept` 这一句（标题、最先读到的那一句）必须
 * 先兑现"你的卸载生效了"，再说残留。副标题 `uninstall.filesKeptHint` 把这件事
 * 说到底："这里不需要再做什么"。
 *
 * ## 🔴 tone 是 `info`，不是 `critical`
 *
 * 卸载**成功了**，只是有残留。渲染成红色/故障图标（或者更糟：编一个 `ApiError`
 * 去复用 `ErrorBlock`）是在量另一件事 —— 那会把一次成功的操作说成失败，
 * 用户的下一步动作又会变回"再点一次"。
 *
 * ## 为什么它住在 `components/common/` 而不是两个 feature 目录里各一份
 *
 * 两个卸载入口（`/models` 与 `/runtime`）说的是**同一件事、同一个契约**。
 * 各写一份的结局本仓已经数过好几次：两处对同一个状态说两句不一样的话，
 * 而且只改一处的修复看起来是完整的。**判据（哪些字段、说什么、什么 tone）
 * 只有一份；两个页面各自负责把自己的 `filesNotRemoved` 递进来。**
 */
export interface UninstallResidueBannerProps {
  /**
   * 服务端拒绝删除的条目。
   *
   * `undefined` 覆盖两种情况，而它们对用户是同一个意思 ——「没什么要说的」：
   * 还没卸载过，或者上一次卸载回的是 204（全删干净了）。
   * ⚠️ 空数组也不显示：**能走到那个 200 响应体它就一定非空**，空数组只可能是
   * 调用方自己造出来的，不该在界面上变成一句"有 0 个文件没删掉"。
   */
  readonly files: readonly RefusedFileReport[] | undefined;
}

export function UninstallResidueBanner({ files }: UninstallResidueBannerProps) {
  const { t } = useTranslation();
  if (!files || files.length === 0) return null;

  return (
    <Banner
      tone="info"
      testId="uninstall-files-kept"
      title={t('uninstall.recordRemovedFilesKept', {
        n: files.length,
        names: files.map((f) => f.name).join(', '),
      })}
      detail={
        <>
          <span className="block">{t('uninstall.filesKeptHint')}</span>
          {files.map((f, i) => (
            /*
             * ★ 逐条把**解析层的英文原话**照登出来 —— 那串字里带着绝对路径，
             * 也就是"那几个文件到底在哪"这个问题在整条链上唯一的答案。
             * 契约（`RefusedFileReport.reason`）刻意没有把它收成枚举，
             * 所以这里也不许把它改写成我们自己的话：`uninstall.verbatimReason`
             * 那句词条的职责就是**标出这一段不是我们写的**。
             */
            <span key={`${String(i)}-${f.name}`} className="mt-0.5 block break-all font-mono">
              {t('uninstall.verbatimReason', { reason: f.reason })}
            </span>
          ))}
        </>
      }
    />
  );
}
