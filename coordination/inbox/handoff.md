# inbox / handoff

> 本 agent 只写两个文件：`/root/memo/HANDOFF.md` 与本文件。不碰任何代码或他人文档。

## [2026-08-03] HANDOFF.md v1 DONE

交付: `/root/memo/HANDOFF.md`（七节齐全）

节标题:
- ① 30 秒读懂：这是什么、现在能干什么
- ② 怎么跑起来（从零到能用）
- ③ 架构一页纸
- ④ 当前工作分工与在途任务
- ⑤ 踩过的坑与由此立下的规矩（A 假绿灯家族 / B 假红灯 / C 键名对不上 / D 后端好了前端关着 /
  D-bis 注释与代码不一致 / E 跨端降级 / F 验功能不验组件 / G .gitignore 前导斜杠 / H 禁止 pkill -f / I 其它）
- ⑥ 已知未解决 / 未验证（分"做了没验 / 当前就是坏的 / 已裁决不做 / 等用户等硬件 / 安全现状"）
- ⑦ 给接手者的第一步建议

方法: 读完 16 份 ADR + PROTOCOL + CHARTER + FEATURE-COVERAGE + PENDING + D-07/08/09 TL;DR
+ 七份 inbox（重点读最近 2–3 条）+ 90 条 git log；对 `:10000` demo **只读**打了 9 个接口；
派 2 个 sonnet subagent 分别核实「构建/启动/环境变量/selfcheck」与「路由面/前端接线/历史 bug 类是否复发」。

### 我核实后发现与既有报告 / 文档不符的地方（共 8 条）

1. **`GET /api/health` 的 `host` 说 `127.0.0.1`，socket 实际绑 `0.0.0.0:10000`**（`ss -ltnp` 为证）。
   读这个字段的人会得出"只绑回环"的错误结论 —— 而这正是 T-111 里被反复强调的安全前提。
2. **安装记录里躺着已不存在的绝对路径**：`/root/data-memo/models/manifests/asr/asr_whisper-base-q5_1.json`
   的 `files[0].path` = `/tmp/cold4/...`，`/tmp/cold4` 已不存在，`GET /api/models/installed` 原样返回；
   同目录的 backend 记录还留着 `installPath: "whispercpp/v1.9.1/cpu"` —— T-097 声称已删除的字段。
   **根因：T-053/T-097 两次修复都是 forward-only，没有做记录迁移。** 这条不在任何 inbox 里。
3. **`GET /api/selfcheck` 是 `scripts/selfcheck.mjs` 的真子集**，缺硬件探测、缺数据目录自洽性(4b)、
   缺本地 LLM 探测。→ 网页自检绿了不代表 CLI 绿，验收必须用 CLI。
4. **`scripts/check-tracked-sources.mjs` 没有任何自动调用方**（全仓 grep 除自身 0 命中，不在 package.json
   脚本 / 唯一的 workflow / 任何 git hook 里）。防 `.gitignore` 回归的护栏本身没人跑。
5. **三处注释与代码不一致**：`vite.config.ts:55`「daemon 托管 SPA 尚未实现」（已实现且正在生效）、
   `DataLocationSection.tsx:83-91`「这个端点还不存在」（GET/POST 都完整实现）、
   `packages/shared/openapi.yaml` 4 处仍写 `installPath`（代码已改 `linkInto`）。
6. **`POST /api/backends/selftest` 定义了两次** —— `backends.ts` 的 501 桩被 `hardware.ts` 的真实现
   永久遮蔽（路由先注册先赢）。不可达死代码。
7. **`FEATURE-COVERAGE.md` 两个方向都偏，已逐条复核**：它标 🔴 的拖拽上传/标签星标文件夹写入/
   笔记导出/TipTap/onboarding/任务中心持久化 **全部已接通**；"daemon 只有 6 个端点"实际约 83 条；
   但它标 🟢 的 **F3 前端至今是 mock**（`RecorderPage.tsx:130-163` 用 `setInterval` 播硬编码字幕，
   `stop()` 硬编码"已更新 47 / 已保留 3"）。**这是章程五个必备功能里唯一 UI 层是假的。**
8. **`docs/SECURITY.md` 的威胁模型与当前部署不一致** —— 它写「daemon 只绑 127.0.0.1，绝不 0.0.0.0」，
   而 demo 正是 `0.0.0.0` + 免鉴权 + dataDir 里有真实 API Key 的 `secrets.json`。
   （ADR-002 的 `mind-elixir-core` 之类的事实订正已在 ADR 里留痕，此处不重复。）

9. **`git add -A` 第二次污染提交历史**：`d12ab1e` 的 message 是「memo.ac 内置清单取证 (T-113)」，
   却同时带进了 `apps/daemon/src/http/{auth.ts,server.ts}` 的**免鉴权改动**（38+24 行）——
   一个安全边界变更藏在一个 docs 提交里。第一次是 `f27c317`（只写 T-043，带进整批 T-040 代码，
   后来靠空提交补记归属）。本项目把 commit message 当最重要的事实来源，`add -A` 直接污染它。

### 顺带记录的两项环境事实
- 机器上挂着**两个遗留 vite dev server**（127.0.0.1:5173 与 :5188，跑了 19–24 小时）。
- `PENDING-USER-DECISIONS.md` 的 A-1（GitHub 仓库=唯一硬阻塞）已被 ADR-015 撤销，**该文件那一段已过期**。

下一步建议:
1. 请把 F3 前端 mock 排进任务（`architect`）—— 它是章程功能，且后端早就是真的。
2. `check-tracked-sources.mjs` 接进 CI 或 pre-commit（`oss-scout`）。
3. 安装记录迁移（`model-mgmt`）：旧记录的绝对路径与 `installPath` 残留。

需要 Manager 决策: 无（本 agent 不改代码，以上均为报告）。

诚实声明:
- demo（`:10000`）**全程只读**，只发过 GET，未重启、未写、未读任何密钥文件内容。
- 未使用 `pkill -f`，未起任何进程。
- HANDOFF.md 里每条能力都带证据等级；凡是我没独立核实的一律标 `[报告]`，未验的标 `[未验证]`。
- 派生 subagent（均已完成，未 kill）：`a42d44f46cb4de218`（构建/启动/env/selfcheck 核实）、
  `a87634e67cd873b89`（路由面/前端接线/历史 bug 类复发核实）。

---

## [2026-08-03 20:35] T-131 DONE —— 裁决回写 D-05 + HANDOFF.md 追上现实

### TL;DR

1. **裁决已回写。** `D-05 §7.1/§7.2` 更新为当前取值，新增 **§7.1b 变更说明**（谁改的 / 何时 / 为什么 / 依据哪次实测），
   **不是静默覆盖**。TL;DR 也加了一行，Manager 只读 TL;DR 时也能看见这次回写。
2. **`tokens.css` 的悬空指针已清。** 那条「以 D-09 §8 为准」回写后就成了指向已合并文档的指针，
   已改写成：**规范 = D-05 §7.1/§7.2；D-09 §8 保留为变更过程档案；状态色四层展开仍以 D-09 §7 为准**。
   **只动注释，一个 CSS 值都没碰。** `[实测]` `pnpm --filter @openmemo/web test:unit` → **18/18 通过**
   （该测试从 `tokens.css` 现场解析，改注释若碰坏解析会当场变红）。
3. **四个 `--status-*` 锚点与 `--data-1..4` 一个都没动**，已逐值核对。
4. **HANDOFF.md 按代码重写**，对齐到 `6b1cac0` + 三路未提交的在途工作。
   **上一版有 6 条已经过期，我逐条核实后删改**（见下 §2）——其中最要紧的一条是「F3 前端是 mock」，
   那是上一版标的"最大功能缺口"，**T-117 已经接通了**。
5. **你给的清单里有 1 处与代码不符、2 处需要补充**（见 §3），另有 **4 条你没提到的事**（见 §4），
   包括一次**新的、更隐蔽的提交串档**（commit message 与内容完全对不上）。

---

### 1. 交付（精确清单，**请勿 `git add -A`**）

```
docs/design/D-05-frontend.md          # §7.1/§7.2 回写 + §7.1b 变更说明 + §7.3/§7.5 两处失效标注 + TL;DR 一行
apps/web/src/styles/tokens.css        # **仅文件头注释**（第 64-67 行那段指路标注 → 改写）
HANDOFF.md                            # 重写
coordination/inbox/handoff.md         # 本文件
```

`git status` 里同时还有 `apps/daemon/src/storage/move.{ts,test.ts}`（`storage-fix`）、
`apps/web/src/features/models/ModelsPage.tsx` 等（`models-page-fix`）、`coordination/inbox/storage-fix.md`
—— **那些不是我的**。

`tokens.css` 动手前查过 `git status`：**未被任何人占用**（mtime 19:32，工作区无修改），故未走申报等待。

### 2. 上一版 HANDOFF 里**已经过期**的 6 条（我逐条核实后改了）

| 上一版写的 | 实际 | 证据 |
|---|---|---|
| 「F3 录音页前端是 mock，是最大的功能缺口」 | **已接通** | `[读码]` `features/recorder/asrStream.ts`（新文件）：AudioWorklet → PCM16 → `/ws/recorder`；`RecorderPage.tsx:190` 注释写明"此前这里是 `setInterval` 轮播" |
| 「`GET /api/selfcheck` 是 CLI 的真子集，缺三项」 | **已补齐** | `[实测]` HTTP 端点现在 19 项，`hw.probe` / `datadir.assetsPresent` / `llm.tier2` 三项都在 |
| 「安装记录里躺着 `/tmp/cold4` 悬空路径 + `installPath` 残留」 | **已迁移干净** | `[实测]` `GET /api/models/installed` 中 `/tmp/` 0 命中、`installPath` 0 命中（`storage/migrateRecords.ts`） |
| 「`openapi.yaml` 还留着 4 处 `installPath`」 | **0 处** | `[实测]` `grep -c` = 0 |
| 「`docs/SECURITY.md` 与当前部署不一致」 | **已如实** | `[读码]` 原句已改成划掉，并列出真实部署与恢复命令 |
| 「`check-tracked-sources.mjs` 没有任何调用方」 | **有入口，没人跑** | `[实测]` 已在根 `package.json` 的 `check:sources` / `check` 里；但仓库唯一 workflow 是手动的 `build-backends.yml`，`.git/hooks` 无非 sample 钩子 |
| 「`HealthBanner.tsx` 是死文件待清」 | **已删** | `[实测]` `git log --diff-filter=D` → 删于 `70210a0` |
| 「demo LLM 配置自相矛盾（`defaultModelId` vs `providers[0].model`）」 | **不再是矛盾** | T-126b 定了权威关系：前者权威、后者是"上次选的型号"的记忆，**两者本就允许不同** |

### 3. 你那份清单里，**与代码不符 / 需要补充**的地方

**① 「`speedEvidence` 实测覆盖 2/35 → 9/35」—— 数字对，但"2"的来源要说准。**
`[实测]` 逐条数过三份清单：改动前 `speedEvidence` 字段**根本不存在**（0 条），
那个 **2** 是旧字段 `referenceBenchmark` 的条数（都在 `models-whisper.json`）。
现在 35 条全部必填：`measured 9 / estimated 0 / unmeasured 26`（`not_run 20` / `out_of_scope 5` / `artifact_differs 1`）。
**所以准确说法是「有出处的速度 2/35 → 9/35」，不是"speedEvidence 从 2 涨到 9"。**

**② 「`daemon` 一处都不读 `providers[i].model`」—— 核实成立，但要连着说另一半。**
`[读码]` daemon 确实一个字都不读它（只读 `llm.providers[i].{id,kind}`）。
**但它读 `llm.providers[i].kind`**，而且这是 T-115 报的 D1 缺陷的修法：
原来 daemon 按 **id 字面量**分派协议（`=== 'anthropic'`），而新目录里 Anthropic 那家的 id 是 **`claude`**
—— 不改就会静默落进 OpenAI 兼容分支。**"providers 不权威"只对 `model` 成立，对 `kind` 恰恰相反。**
我把这三行写成了 HANDOFF ③ 的一张权威表，因为这正是最容易搞反的地方。

**③ 「数据目录移动会静默弄坏符号链接（`storage-fix` 正在修，未落地）」—— 状态要更新。**
`[实测]` `storage-fix` 的回执已写 **T-128 DONE**，`move.{ts,test.ts}` 已 staged，测试 13→32 条，
四组反向验证都贴了真实的 `✖ fail` 输出。**代码未合并**，所以我在 HANDOFF 里标的是
「🔵 回执写 DONE，Manager 尚未合并；合并前该功能仍然会静默弄坏后端」。
另：**用户 `:10000` 上那 8 条断链已经被人手工修好了** `[实测]` —— 我 `ls -l` 复核，
8 条全部是相对链接且 `-e` 可解析（mtime 19:51）。根因仍未合并，但现场已恢复。

### 4. 你没提到、但我核出来的 4 条（都进了 HANDOFF）

1. 🔴 **`git add -A` 的第 3、第 4 次污染，形式比前两次隐蔽得多 —— commit message 与内容完全对不上。**
   `[实测]` `git show --stat` 逐个核：
   - `75474bc`「D-10 规格 (T-115)」实际装着 **T-118 全部代码 + T-117 全部代码**（含新文件 `asrStream.ts`）；
   - `93310ea`「T-118」只剩 2 个文件；
   - `18f205f`「F3 接真 WebSocket (T-117)」**只有一个 inbox 文件，零行代码**；
   - `9d57689`「T-121」顺带装走了 T-114 的 `statusTone.ts` 等一批配色代码。
   成因是 14:55 那次 `add -A` 把磁盘上别人已写完未提交的文件一并扫走。
   **后果：想知道 F3 是怎么接通的，`git log --oneline` 会把你指到一个只有 inbox 文件的提交。**
2. 🔴 **T-127 的版本戳在"全部接通"时看不见。** `[读码]` `daemon v… · commit · 起 HH:MM` 这行渲染在
   `MockNotice.tsx` 的 `ConnectivitySummary` 内部，而该组件开头是 `if (mocked === 0) return null;`。
   **一切正常时，那个用来回答"重启生效了没有"的东西自己消失了** —— 而"一切正常"恰恰是最需要它的时候。
   这是「Tab 条嵌在 `tab==='asr'` 分支里」的同族：**嵌套条件让 A 继承了 B 的消失条件。**
   我在 HANDOFF ⑤D 里把这一族补成了第三种形态（前两种是"过时的开关"）。
3. 🔴 **demo 上 `yt-dlp` 找不到** → **F1 粘链接导入在这台机器上现在用不了**。`[实测]` 自检 5 条 warn 之一，本轮新出现。
   另 4 条：`hw.probe` 未装（GPU 侧全空）、`model.vad` 未装（切分降级）、`llm.tier2` 未探测到（正常）、
   `datadir.assetsPresent` 3 条历史资产已不存在。
4. 🟡 **T-128 算出的 `warningZh` / `staleLinks` 没有出口** —— `rest/storage.ts` 的搬迁响应不带它们，
   "链接断了"仍然只有读日志的人看得到。`storage-fix` 按边界没改那个文件，等你派活。

### 5. 回写的理由我写进了文档，不只写结论

D-05 §7.1b 里那段是这么写的（原话）：

> 原 §7.2 的表层三档在明档实测**两两只有 1.03:1**。也就是说，本节承诺的"三级抬升"**在亮色主题里从未真正存在过** ——
> 它不是一条被违反的规范，而是**一条描述了不存在事实的规范**。
> `hover:bg-surface-2`（1.02:1）与侧栏选中态这两处"看不见的交互态"，是照着这条规范一字不差写出来的，
> **代码没错，规范错了。**
> 它能活这么久，是因为当时全部对比度断言管的都是"前景 vs 背景"，而这里坏掉的是"背景 vs 背景" ——
> 没有任何一条断言在看这件事。

并立了一条规矩：**"一条从未被任何断言覆盖过的规范，很可能从落笔那天起就是错的。"**
同时把 `SURFACE_MIN = 1.06` 这件事写清楚：**自定阈值可以，冒充 WCAG 不行**（`ui-polish` 自己就是这么标的）。

### 6. 诚实声明

- **只改了上面 4 个文件。** `tokens.css` 只动文件头注释块，**没有增删或修改任何 CSS 声明**。
- **未构建 `apps/web/dist`**（PROTOCOL §7）。我跑的唯一一条测试是 `pnpm --filter @openmemo/web test:unit`，
  它输出到 `.test-out/unit/`，不写 `dist`。`apps/web/dist` 我一次都没碰。
- **`:10000` 全程只读**：只发 GET（`/api/health`、`/api/selfcheck`、`/api/settings`、`/api/notes`、
  `/api/models/installed`、`/api/runtime/hardware`、`/api/jobs`），未重启、未 kill、未占用该端口、未发任何写请求。
- **`/root/data-memo` 只做了一次 `ls -l` + `readlink`**（为核实那 8 条链是否已修好），**未写入、未执行其中任何二进制、未读 `secrets.json`**。
- **未使用 `pkill -f`，未起任何服务进程，未派生 subagent。**
- **未 commit。** PROTOCOL §0：Manager 是唯一合并者。
- 本 agent 原本"只写 HANDOFF.md 与本文件"的自我约束，本轮因你的裁决而扩大到
  `docs/design/D-05-frontend.md` 与 `apps/web/src/styles/tokens.css` 的**文件头注释**，范围以此为限。
- **仍是 `[报告]` 级、我没独立核实的**：T-125 的 9 条 RTF 实测数字、T-128 的四组反向验证输出、
  T-121 的真浏览器 partial/final、`pnpm -r test` 的 282 passed —— 我引用了它们并都标了 `[报告]`。

### 7. 需要 Manager 决策

1. **合并 T-128（`storage-fix`）** —— 合并前"更改数据位置"仍会静默弄坏转写后端。
   顺带定一下 `warningZh` 要不要接出到 `rest/storage.ts` 的响应。
2. **`/api/health` 的 `host` 字段仍写死 `'127.0.0.1'`**（`http/server.ts:121`）而实际绑 `0.0.0.0` ——
   上一版就报过，至今未修。它是安全判断的输入，建议改名或补真实 bind 地址字段。
3. **demo 的 yt-dlp 没了** —— 要不要补装（关系到 F1 能不能演示）。
4. **`role=llm` 的 5 条 GGUF + llamacpp 后端包下架**（D-10 #7）与 **「+ 添加服务商」11 个预设 → 24 家**（D-10 #24）
   两件事都还挂着，各自有明确 owner，缺的是排期。

### 8. 更正（追加，不覆盖上面）—— 我写这份回执期间工作区又动了

`[实测]` **T-128 已经在 20:09 被合并**（`ae9bdb3`，只含 `move.ts` + `move.test.ts` + `inbox/storage-fix.md`
三个文件，**没有夹带**）。所以：

- 上面 §3-③ 的「代码未合并」与 §7-1 的「请合并 T-128」**已过时**，HANDOFF.md 已改成"✅ 刚落地"。
- `job-events` 的身份也查清了：**T-130，job 事件契约** —— `JobCreatedEvent.job` 从 `DownloadJob`
  改成 `AnyJob` 判别联合，因为**转写与导图任务根本描述不成 `DownloadJob`**（没有字节计数器）。
  它同时在 `apps/daemon/src/http/rest/storage.ts` 里**把 T-128 的 `staleLinks`/`warningZh` 接出到搬迁响应**，
  注释原话值得记：「算出来却不透出去，等于把一盏假绿灯换成一盏没接线的红灯」。
  ⚠️ **但前端 `DataLocationSection.tsx` 那头还没渲染**，所以 §7-1 那半条仍然成立：**两头都接上才算闭环。**
- `models-page-fix` 的范围也比我快照时大（现在还动着 `ModelDetailPage`、`DownloadRow`、`QuantSelector`、
  `StorageBreakdown`、`FitBadge`、`JobToaster`、`LlmSettingsSection`、`NotesListPage`、`DataLocationSection`）。

**教训记在 HANDOFF 文件头了**：④ 的在途表是 20:40 的快照，工作区一直在动，
**接手的人动手前必须自己再跑一次 `git status` 与 `git log --oneline | head`**。
一份"在途任务表"天然会过期 —— 所以它的正确用法是"告诉你去问谁"，不是"告诉你现在是什么"。
