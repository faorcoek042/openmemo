/**
 * 「措辞总表」那一族模块的**公共词汇**。
 *
 * ## 这一族是什么
 *
 * 契约里一个机器可读的判别式联合（`UpstreamFailure` / `Inapplicability` /
 * `EngineUnavailableReason` / `RecorderErrorReason` / `ProxyProbeDetail` /
 * `RemovalFailureKind` / `SemanticUnavailableReason` …）→ 用户读得懂的那句话。
 * 每个模块都长成同一个样子：一张 `Record<全部 kind, 词条 key>` 的**总表**，
 * 加一个按 kind 分发插值的函数。
 *
 * **这一族的成员名单不写在这里** —— 谁 import 了本文件的 {@link Translate}，
 * 谁就在名单上。写一份手抄名单只会有一天和实际不一样（本仓已经为"被抄写的清单"
 * 栽过好几次），而 `grep` 出来的那份永远是对的。
 *
 * ## 为什么值得把这三样抽出来
 *
 * 抽之前：`type Translate = …` **逐字重复了 6 遍**（连同同一句注释），
 * `function assertNeverX(x: never) { void x; return ''; }` 有 7 份拷贝散在 4 个文件里，
 * `Object.prototype.hasOwnProperty.call(表, kind)` 3 份。
 * 重复本身不贵，贵的是它们**看起来一样、其实不一样**：7 份 `assertNever` 里有一份
 * 返回 `null` 而不是 `''`，而那个差异是有意义的（见下），却埋在一个名字很像的
 * 私有函数体里，读的人只会以为又是同一份拷贝。
 *
 * ## ★★ 两条腿：编译期的总表，运行期的 `normalize*`。**缺一条就是一个洞。**
 *
 * · **总表**（`Record<全部 kind, string>`）守的是**我们自己**：契约里加一档而没人
 *   给它写话，`tsc` 当场红。这是这一族每个文件抬头都写着的那条。
 * · **`normalize*`** 守的是**网线**：类型只是我们对响应的期望，不是边界。
 *   到得了这里的东西包括旧 daemon 发的散文字符串、以及**新 daemon 发的、这份前端
 *   还不认识的 kind**（daemon 与 SPA 同包发布，但陈旧标签页真实存在 ——
 *   `lib/api/client.ts` 的自愈重连走的就是那条路）。
 *
 * `features/recorder/recorderErrorText.ts` 是把这两条腿都写全了的样板，
 * 它自己的注释说得最准：「上面那张总表守编译期，`normalizeRecorderError` 守运行期，
 * **两道一起才够**」。
 *
 * ## ⚠️ 兜底值**故意各不相同**，抽公共部分时**不要把它抹平**
 *
 * 这正是 {@link unreachable} 把兜底值做成**参数**、而不是内建成 `''` 的原因：
 * 那个值必须留在调用点上，让人一眼看见这个模块选了哪一种，以及为什么。
 *
 * | 兜底 | 谁这么做 | 判据 |
 * |---|---|---|
 * | 退到一个**真实的契约成员** | `uninstallFailureText` → `'unknown'` | 那一格的话（「没删掉、它在这儿、原因我们没弄清」）对一个真不认识的 kind **恰好是准确的** |
 * | `null`（那一段不渲染） | `proxyReasonText` / `engineReasonText` / `search/modes` | 猜一格会**言之凿凿地说出一个我们并不知道的成因**；`null` 说的是「服务端没说」，这句任何时候都成立 |
 * | 空串 | `reasonText` / `reasonKeys` | 外层那句话仍然成立，只是少了括号里的细节 |
 *
 * 判据是同一句，`search/modes.ts` 把它写得最好：
 * **「哪个默认值会让界面说一句不成立的话」** —— 不是"缺省该宽还是该严"。
 *
 * ## 🔴 已知的洞：**空串那一档今天没有第二条腿**
 *
 * `features/components/reasonText.ts` 与 `features/runtime/reasonKeys.ts` 是这一族里
 * 仅有的两个**没有 `normalize*`** 的模块。它们的 `assertNever` 只在编译期成立，
 * 而两个文件的抬头都明令禁止"新档位静默渲染成一段空白"—— 也就是说，
 * 它们各自禁止的那件事，正是它们自己在版本错配时会做的事。
 *
 * ⚠️ `reasonKeys.ts` 那一处还要更钝一点：`backend_unavailable` 那条腿是
 * `UNAVAILABLE_REASON_KEYS[r.unavailableKind]`，`kind` 本身认得、只有
 * `unavailableKind` 不认得时**根本进不了 `default`**，取出来的是 `undefined`，
 * 于是 `t(undefined)`。本仓没开 `noUncheckedIndexedAccess`，所以 `tsc` 看不见它。
 *
 * **本轮刻意没修**：补第二条腿要逐档论证兜底值（`null` 还是退到某个真实成员）、
 * 多半还要加词条，那是一次独立改动，不是重构的顺手活。记在这里，不是修好了。
 */

/**
 * `t()` 的最小形状。
 *
 * 这一族的模块**刻意不引 React / i18next** —— 它们要能被直接喂输入写用例
 * （`node --test` 那条 CJS 通道，见 `apps/web/tsconfig.test.json`）。
 * 所以调用点把 `t` 当参数传进来，而不是在模块里 `useTranslation()`。
 */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * 编译期穷尽性检查；**运行期不 throw**，退到调用点给的那个值。
 *
 * `x: never` 是全部机关：少写一条 `case` 时它接不住，`tsc` 当场红 —— 那是我们要的。
 * 而真跑到这一行（版本错配）时 throw 会让整页崩掉，那比少一句解释坏得多。
 *
 * ⚠️ **兜底值是参数，不是内建的 `''`**：见文件抬头那张表，这一族三种兜底纪律
 * 各有各的判据。写成 `unreachable(x, '')` / `unreachable(x, null)` 的好处是
 * 选了哪一种就摆在调用点上，而不是藏在一个名字很像的私有函数里。
 */
export function unreachable<T>(x: never, fallback: T): T {
  void x;
  return fallback;
}

/**
 * 网线上那个 `kind` 是不是**总表认得**的那几格之一。
 *
 * ## 为什么判据是总表，而不是另抄一份常量名单
 *
 * 抄一份就会有一天两边不一样。让运行期这一道直接读**编译期那张总表**，
 * 于是「加一格 ⇒ 编译逼着补词条 ⇒ 那一格自动被运行期收下」，两件事不会各走各的
 * （`search/modes.ts` 的 `SEMANTIC_UNAVAILABLE_KEYS` 注释写的就是这条）。
 *
 * ## 为什么是 `hasOwnProperty.call` 而不是 `in`
 *
 * `'toString' in KEYS` **是真的** —— `in` 会走原型链。网线上一个
 * `{"kind":"toString"}` 就能骗过 `in`，然后 `KEYS['toString']` 取出一个函数
 * 喂给 `t()`。`Object.prototype.hasOwnProperty.call(...)` 而不是 `表.hasOwnProperty(...)`：
 * 后者在 `Object.create(null)` 造的表上不存在。
 */
export function isKnownKind<K extends string>(
  table: Readonly<Record<K, unknown>>,
  kind: unknown,
): kind is K {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(table, kind);
}
