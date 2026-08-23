import { useTranslation } from 'react-i18next';
import type { FailedFileReport, RefusedFileReport } from '@openmemo/shared';

import { Banner } from './Banner';
import { removalFailureText } from './uninstallFailureText';

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
 *
 * ## ★★ #113：第二条横幅（「我们没删动」），**同一套表达，不是第二种**
 *
 * 契约上多了一档 `filesFailedToRemove`：我们**试了**、`fs.rm` **抛了**。
 * 它和上面那档（我们**不肯**删）对用户的下一步动作不同，所以是两条横幅、
 * 两句话；但**说法的形状必须一模一样**，因为要兑现的承诺是同一个：
 *
 *   ① 先说「记录已经清掉了」（否则用户会再点一次，拿到 404）；
 *   ② 逐条说清是哪几个、**在哪儿**；
 *   ③ tone 仍然是 `info`。
 *
 * ⚠️ 第三条不是偷懒。诱惑很实在：这一档"更严重"（磁盘真的没回来、而且本来
 * 该回来），值得一个 `warning`。**但那量的是另一件事** —— 卸载本身**成功了**，
 * 记录真的走了。把它渲染成故障级，用户的下一步动作又会变回"再点一次"，
 * 而那正是 #107 花一整轮定下来的反面。severity 的差别由**那句话本身**
 * （"重启一次多半就好"）承担，不由色条承担。
 */
export interface UninstallResidueBannerProps {
  /**
   * 服务端拒绝删除的条目。
   *
   * `undefined` 覆盖两种情况，而它们对用户是同一个意思 ——「没什么要说的」：
   * 还没卸载过，或者上一次卸载回的是 204（全删干净了）。
   * ⚠️ 空数组也不显示：一次纯粹的 rm 失败会给出 `filesNotRemoved: []`
   * （#113 之后 200 有两个来源），那时该说话的是下面那条横幅，不是这条 ——
   * 显示成"有 0 个文件没删掉"是一句凭空造出来的话。
   */
  readonly files: readonly RefusedFileReport[] | undefined;
  /**
   * 服务端**试着删了、没删动**的条目（#113）。
   *
   * 与 `files` 各自独立：两格可以同时非空（一条记录里既有越界的、又有占用中的），
   * 那时两条横幅都出现 —— 因为用户要做的是**两件不同的事**。
   */
  readonly failed?: readonly FailedFileReport[] | undefined;
}

export function UninstallResidueBanner({ files, failed }: UninstallResidueBannerProps) {
  const { t } = useTranslation();
  const refused = files ?? [];
  const notDeleted = failed ?? [];
  if (refused.length === 0 && notDeleted.length === 0) return null;

  return (
    <>
      {refused.length > 0 ? (
        <Banner
          tone="info"
          testId="uninstall-files-kept"
          title={t('uninstall.recordRemovedFilesKept', {
            n: refused.length,
            names: refused.map((f) => f.name).join(', '),
          })}
          detail={
            <>
              <span className="block">{t('uninstall.filesKeptHint')}</span>
              {refused.map((f, i) => (
                /*
                 * ★ 逐条把**解析层的英文原话**照登出来 —— 那串字里带着绝对路径，
                 * 也就是"那几个文件到底在哪"这个问题在整条链上唯一的答案。
                 * 契约（`RefusedFileReport.reason`）刻意没有把它收成枚举，
                 * 所以这里也不许把它改写成我们自己的话。
                 *
                 * ## ★★ 那句「以下是存储层原文，我们没有翻译它：」删掉了
                 *
                 * 它的职责是**标出这一段不是我们写的**，而这一行**已经是等宽字体**了 ——
                 * 形式在承担同一个职责，那句话是纯冗余。而且它说的是
                 * 「**我们**没有翻译它」：一句关于我们工作流程的陈述，用户不关心。
                 * 留一个短标签在这儿仍然多余：等宽 + 独占一行已经说清了。
                 */
                <span key={`${String(i)}-${f.name}`} className="mt-0.5 block break-all font-mono">
                  {f.reason}
                </span>
              ))}
            </>
          }
        />
      ) : null}
      {notDeleted.length > 0 ? (
        <Banner
          tone="info"
          testId="uninstall-files-failed"
          title={t('uninstall.recordRemovedFilesFailed', {
            n: notDeleted.length,
            names: notDeleted.map((f) => f.name).join(', '),
          })}
          detail={
            <>
              <span className="block">{t('uninstall.filesFailedHint')}</span>
              {notDeleted.map((f, i) => (
                <span key={`${String(i)}-${f.name}`} className="mt-1 block">
                  {/*
                   * ★ 「没删掉 + 在哪儿 + 能做什么」三件事在这一句里说完：
                   * 三句词条都吃 `{{name}}` 与 `{{path}}`，措辞按 kind 分档
                   * （`REMOVAL_FAILURE_KEYS` 是**全量 Record** —— 契约多一格
                   * 而没人写话，构建当场红）。
                   */}
                  <span className="block break-all">{removalFailureText(t, f)}</span>
                  {/*
                   * ★ 系统原话单独一行、等宽。
                   * `kind === 'unknown'` 时这是我们唯一说得出的东西，所以它不是
                   * 可选的装饰；另外两格留着它是给排障用的。
                   * 「以下是系统原话，我们没有翻译它：」同上删掉 —— 等宽已经把
                   * 「这一段不是产品在说话」说完了。
                   */}
                  <span className="mt-0.5 block break-all font-mono">{f.detail}</span>
                </span>
              ))}
            </>
          }
        />
      ) : null}
    </>
  );
}
