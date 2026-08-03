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
