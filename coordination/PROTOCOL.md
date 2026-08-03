# Agent 协作协议 v1

所有 agent **必须**遵守。Meta Manager 是唯一的调度者与合并者。

## 0. 角色
- **Meta Manager**（主会话）：分派任务、读摘要、做决策、写 ADR、合并成果。不写业务代码。
- **Lead Agent**（opus5）：领域负责人，可再派 sub-subagent（琐碎活用 sonnet5）。
- **Worker Agent**（sonnet5）：执行明确定义的机械任务。

## 1. 通讯机制 = 共享文件系统（单一事实来源）

```
/root/memo/
├── docs/
│   ├── 00-CHARTER.md          # 项目章程（Manager 所有，只读）
│   ├── research/              # 研究报告  R-*.md
│   ├── design/                # 设计文档  D-*.md
│   └── adr/                   # 架构决策记录 ADR-NNN-*.md（仅 Manager 写）
├── coordination/
│   ├── PROTOCOL.md            # 本文件
│   ├── BOARD.md               # 任务看板（仅 Manager 写）
│   ├── ROSTER.md              # Agent 花名册（仅 Manager 写）
│   ├── inbox/<agent>.md       # Agent → Manager 的回执（Agent 写，追加）
│   └── tasks/T-NNN.md         # 任务卡（Manager 写规格，Agent 写进展）
```

### 规则
1. **写自己的文件，读别人的文件。** 除 `inbox/<自己>.md`、自己被分配的 `tasks/T-NNN.md`
   和自己交付的 `docs/**` 文件外，不得修改任何文件。避免写冲突。
2. **跨 agent 依赖靠文件，不靠猜。** 需要别人的产出时，读对方的 `docs/` 交付物。
   若尚不存在，在自己的 inbox 里写 `BLOCKED: 等待 <文件路径>`，然后先做不依赖它的部分。
3. **绝不修改他人的交付物。** 有异议 → 在自己 inbox 里写 `DISPUTE:` 条目，Manager 裁决。

## 2. 交付物格式（强制）

每份 `docs/**` 文档**必须**以这个块开头，Manager 只读这一块：

```markdown
---
id: R-01
author: <agent-name>
status: draft | ready | superseded
date: YYYY-MM-DD
---

## TL;DR（≤ 25 行，Manager 只读这里）
- 结论 1
- 结论 2
- 关键取舍：...
- 未验证/存疑：...   <-- 必填，没有就写"无"
- 对其他 agent 的影响：...

## 详细内容
（正文随意长）
```

## 3. 回执格式（`coordination/inbox/<agent>.md`，追加不覆盖）

```markdown
## [YYYY-MM-DD HH:MM] <TASK-ID> <STATUS>
STATUS ∈ DONE | PROGRESS | BLOCKED | DISPUTE | QUESTION
交付: <文件路径列表>
要点: <≤5 行>
下一步建议: <≤3 行>
需要 Manager 决策: <有则列出，无则写"无">
```

## 4. 诚实规则（不可协商）
- 没验证过的写 **"未验证"**。没跑通的写 **"未跑通"** 并附错误输出。
- 不允许编造 API、版本号、benchmark 数字。不确定就去查，查不到就标 `UNKNOWN`。
- 网络受限导致无法验证的，明确写 `无法联网验证`。

## 5. 派生 subagent 的规则
- Lead 可派 sub-subagent，但**自己名下同时运行的不得超过 2 个**（全局上限 4 由 Manager 控制）。
- 机械性工作（改文件名、批量重写、跑格式化、写样板代码）→ 用 sonnet5。
- 需要判断/设计/取舍的 → opus5。
- 派出去的 agent 完成后不要 kill，记录其 name/id 到自己的 inbox 以便复用。

## 6. 上下文节约
- 不要把大文件全文贴进回复。写到磁盘，回复里只给路径 + TL;DR。
- 读别人的文档时优先只读 TL;DR 块。

## 7. 共享产物：`apps/web/dist` 不许被验证构建覆盖

`:10000` 的演示实例（用户唯一能从 NAT 外访问的入口）**直接托管 `apps/web/dist`**。
任何 agent 跑一次 `vite build`，都会**换掉用户正在看的前端** —— 进程没重启、
版本号没变、页面却已经是别人的半成品了。没有任何东西会报错。

所以：

- **验证构建一律 `--outDir` 到 `/tmp/<你的名字>/`**，例如
  `vite build --outDir /tmp/llm-picker/dist`。
- `apps/web/dist` **只由 Manager 在重启前统一构建**。
- 不确定某条命令会不会写进去，就先 `--outDir` 到 `/tmp`。

同理适用于 `:10000` 本身：**只读，不重启、不 kill、不占用该端口**。要起服务用别的端口。

（此规则源于 `llm-picker` 的主动申报 —— 它构建完才意识到，并如实报了出来。
规则针对的是"没人知道这条线存在"，不是针对它。）

## 8. 断言 DOM 节点不许直接比对象 —— 会 OOM，而且假装成"测试挂了"

`assert.equal(domNode, null)` **失败时**，node:test 要为两边算 diff，`util.inspect` 会顺着
`parentNode` / React fiber **展开整棵树**。实测进程涨到 **10.5 GB**，表现是：

- 不是"断言变红"，而是**整个测试文件炸掉**（57 秒后 `'test failed'`，同文件里其它 suite 一个没跑）
- **同进程里别人的用例统计一起被带偏**

**比"护栏没变红"更难查** —— 因为它看起来像环境问题、像超时、像别的 agent 把仓库弄坏了，
而不像"我这条断言写错了"。

所以：**断言 DOM 存在性一律先转成布尔或字符串再比**。

```js
assert.equal(el === null, true)          // ✅
assert.equal(!!container.querySelector(sel), false)  // ✅
assert.equal(el, null)                   // ✘ 失败时 OOM
```

同理适用于任何**可能持有父引用的对象**（DOM 节点、fiber、带 `parent` 指针的树节点、
含循环引用的图）。判据不是"它是不是 DOM"，是"**它失败时会被 inspect 展开多大**"。

（源于 `models-page-fix` 的反向验证 —— 它第一次没拿到红灯，追下去才发现是 OOM，
并如实报了出来而不是重跑一次糊弄过去。）

### §7 补充：用 `pnpm build:safe`，不要靠记性

§7 禁止验证构建覆盖 `apps/web/dist`，但**两名 agent 先后踩了同一个坑**，成因是同一个：
HANDOFF 教的启动步骤就是 `pnpm -r build`，而禁令针对的是它的**子步骤**（`vite build`）——
两句话隔了几十行，**读到禁令的人不会意识到自己刚敲的那条命令就违反了它**。

所以禁令改成脚本：

```bash
pnpm build:safe     # ✅ 构建除 web 之外的全部包，不会碰 apps/web/dist
pnpm -r build       # ⚠️ 含 vite build，只有 Manager 在重启前跑
```

**判据不是"要记得别跑那条命令"，是"跑错了也不会造成后果"。**
一条需要人时刻记住的规则，等价于一条迟早会被违反的规则 —— 这次是两次。

（源于 `ytdlp-install` 的自我申报：它违反后没有掩盖，而是分析出"两句话隔了 60 行"
这个真正的成因并建议加脚本。）

## 9. 数据目录指针是**全局单例**，测试搬迁绝不能碰它

指针文件在 `~/.local/share/openmemo/datadir.json`，**按设计就在数据目录之外**
（鸡生蛋：数据搬走后得先知道搬到哪了，指针跟着走就再也找不到了）。

代价是：**它是全机器共享的一份**。任何 agent 跑一次会写指针的搬迁流程，
就把**用户的 demo 一起搬走了** —— 而且不会立刻显形，要等下一次重启。

已经发生过一次：某轮测试把它改成了 `/tmp/<agent>/movedst`，
Manager 几小时后重启 demo，daemon 挂到一个空壳上 ——
**用户的 DeepSeek key、模型、转写记录全部"消失"**，自检从 `ok:20 fail:0` 掉到 `ok:7 fail:5`。
数据一个字节没丢，但从界面上完全看不出这一点。

所以：

- **测搬迁只调纯函数**，不走会写指针的那条路径；
- 非走不可就**先备份指针、跑完还原、并核对内容**（不是"我还原了吗"，是 `cat` 出来对一遍）；
- Manager 重启前**先确认 `dataDir` 是不是用户那个**。

**判据：一个进程级测试写了机器级状态，就已经越界了 —— 哪怕它自己的临时目录用得很干净。**
