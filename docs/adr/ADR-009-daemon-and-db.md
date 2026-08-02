---
id: ADR-009
title: daemon 与 DB 层裁决（T-016）
status: accepted
date: 2026-08-02
decider: Meta Manager
input: coordination/inbox/oss-scout.md
---

## 实测验收（五项全绿，均为实跑非声称）

| 项 | 结果 |
|----|------|
| daemon 启动 + 健康检查 | `db=better-sqlite3 sqlite=3.53.4 schema=v1 tokenizer=simple vec=on` |
| **第二个实例被挡住** | `单实例锁生效`，退出码 3 —— 端口绑定即锁（ADR-006 决策 2）已实证 |
| 测试 | **76 pass / 0 fail**，driver+migrate 用例**对两个驱动各跑一遍** |
| **扩展 `.so` 改名降级** | 启动✅ tokenizer 从 `simple` 退到 `trigram`，**搜索层仍可用**；恢复后自动复原 |
| 构建 / lint / 许可证 | `packages/db` + `apps/daemon` EXIT=0；license-report 346 项（A:5 B:338 C:3） |

**D-02 §4 全部落地**：26 表 + 57 索引 + 3 个 FTS5 表 + 11 触发器，`foreign_key_check` 干净。

## 决策 1：`fastify` → `node:http` —— **批准**

理由（`oss-scout` 提出）：SSE / Range / WS upgrade **需要 socket 级控制**，框架反而挡路。
附带收益：少一层依赖，与 ADR-005 的逐依赖登记方向一致。
新增 `ws`（MIT）—— 批准。

## 决策 2：`better-sqlite3` 移到 `packages/db` 作直接依赖并保留回退 —— **批准**

依赖归属跟随使用者，正确。

## 决策 3：`apps/web/tsconfig.json` 的越界申报 —— **追认**

该文件按 BOARD 本就归 `oss-scout`（根配置/tsconfig 类）。修的是 `include` 不匹配 `.json`
导致前端 i18n 报 TS6307 —— **解掉了前端的一个阻塞**，属正确行为，无需追责。

## 决策 4：D-02 的两处文档缺口 —— 转 `architect` 修

1. **§4.1 的 `mindmap_nodes_fts` 三个触发器原文写的是「（略）」，不是可执行 SQL。**
   `oss-scout` 已按 `notes_fts` 模式重建并冒烟验证，**需 `architect` 确认语义是否一致**。
   ⚠️ 教训：设计文档里的「（略）」会被下游当成"照抄即可"，实际是空洞。**DDL 不许省略。**
2. §1.1 的循环外键说明漏了两处（功能无碍，纯文档缺口）。

---

# 附：测试逼出的四个问题（方法论记录）

`oss-scout` 报告测试抓出**自己代码的 2 个 bug** 和**自己测试设定的 2 个错误**：

**代码 bug**
1. `instanceId` 忘了接线 → health 永远返回空串。
2. health 少回 `host` → 提示显示 `http://undefined:17650`。

**测试设定错误**（更值得记录 —— 错的测试会给出假结论）
3. **`fetch` 会忽略 `Host` 头**（forbidden header）→ 用 `fetch` 根本测不了 DNS rebinding 防护，
   必须改用 `http.request`。
4. **端口漂移场景必须用非 OpenMemo 服务占位** —— 否则按 D-01 §2.3 正确走的是 conflict 分支，
   测的根本不是漂移。

→ 与 ADR-008 的「假绿灯」同类。**全项目结论：测试通过时要问一句"它通过的理由对不对"。**

# 附：适配层抹平的一个隐蔽差异
`node:sqlite` 返回 **null 原型对象**，`better-sqlite3` 返回普通对象
→ 会让 `deepStrictEqual` / `hasOwnProperty` **静默出错**。适配层已统一。
这条印证了 ADR-005 决策 6 要求"薄适配层 + 备胎也要测"的必要性 —— 不真跑备胎就发现不了。

# 附：未实现 / 未验证（如实记录）
- `/media` Range、SSE 业务事件、WS 音频、`job_steps` 读写 **均未实现**（留给 T-020/T-021 对接）。
- **只在 Linux x64 验证**，mac / Windows 全未测 → 进 A 类待环境。
- `pnpm -r build` **仍未全绿**：`apps/web/src/features/*/sse.ts` 有 6 个 TS2345
  （前端自定义事件类型与 `shared` 冲突）→ **这正是 ADR-007 决策 1 认定的 SSE 事件缺失阻塞的具体表现**，
  `model-mgmt` 正在补，补完即消。
