---
id: R-05
author: oss-scout
status: ready
date: 2026-08-02
supersedes: R-03 §U-5（U-5 由本文实测关闭）
---

## TL;DR（≤ 25 行，Manager 只读这里）

- **我在 T-011 结论 9 的判断是错的，本文自我更正**：`better-sqlite3` **不需要用户机器有编译工具链**。
  v13 已从 `prebuild-install` 迁到 prebuildify —— 8 个平台的预编译 `.node` **直接打包在 npm tarball 里**
  （linux/linuxmusl/darwin/win32 × x64/arm64），**无 install 脚本**，装的时候连网都不用连。→ **TD-003 可关闭。**
- T-011 里跑 `node-gyp rebuild` 是**我自己配错了**：把 `better-sqlite3` 放进了 `onlyBuiltDependencies`，
  pnpm 见到 `binding.gyp` 就空转一次 node-gyp（实测**产出 0 个 `.node`**），白白要求 make/gcc/Python。
  **已移除**：`pnpm install` 从 **1m24.8s → 976ms**，且 `--ignore-scripts` 装完一切正常。
- **三条路实测**（免编译 / FTS5 / 能否加载 sqlite-vec+libsimple / 2000 次 FTS 查询）：
  · **better-sqlite3 13.0.2** ✅ ✅ ✅ **101ms** ← 推荐
  · **node:sqlite（Node 内置）** ✅ ✅ ✅ 113ms ← 备胎，扩展能力实测与前者等价
  · **node-sqlite3-wasm 0.8.60** ✅ ✅ ❌ 306ms ← **出局**
- **WASM 路直接出局**：编译期就 `OMIT_LOAD_EXTENSION`，**结构性**不可能加载扩展 → 中文分词与
  向量检索两件套同时塌掉。不是慢的问题，是做不到。
- **推荐：better-sqlite3 v13 为主 + node:sqlite 为已验证备胎 + 中间隔一层薄 DB 适配层。**
  理由：① 免编译问题已证伪，换掉它的原始理由消失；② `node:sqlite` 在 **Node 22 上仍是 experimental**
  （实测打 ExperimentalWarning），而 ADR-006 基线正是 22；③ D-02 本就按 better-sqlite3 写，**迁移影响 ≈ 0**。
- **顺手把 D-02 §4 的全部 DDL 在真实 SQLite 上跑了一遍**（D-02 自述"未在任何 SQLite 实例上执行过"）：
  外部内容表、三组触发器、`tokenize='simple'`、bm25、`simple_query/highlight`、拼音、WAL、外键、
  `vec0` 元数据列 KNN —— **全部通过**，D-02 的 V-6 未验证项就此关闭。
- ⚠️ **architect 需改 D-02 两处**：① `vec0` 的 rowid **绑 JS number 必失败**（两个驱动都一样，是
  sqlite-vec 的行为不是驱动 bug），必须用 BigInt / SQL 字面量 / 省略 rowid / `CAST(? AS INTEGER)`；
  ② **`pragma compile_options` 不列 `ENABLE_LOAD_EXTENSION` 也照样能加载扩展** —— 扩展能力只能实测。
- **未验证**：只在 **Linux x64 glibc** 实测，mac/Win/arm64 的 prebuild **未实测**（无机器）。上游 open
  issue **#1509**：`linux-arm64.node` 要求 **GLIBC_2.38**，老发行版会炸 —— 这是主要残留风险，也正是要留
  node:sqlite 备胎的理由。性能是单次粗测，仅用于分档。
- **对其他 agent**：`architect` 改 D-02 两处；`model-mgmt`/`gpu-runtime` 无影响；**Node 基线维持 22 不变**。

---

# 详细内容

> **方法**：全部在本机实机执行。Node 24.18.0（本机）+ Node 22.23.2（从 nodejs.org 下载 LTS "Jod"，
> 2026-07-28 发布）双版本对照。SQLite 扩展用官方 release 的预编译产物
> （`sqlite-vec v0.1.9` linux-x86_64 loadable、`libsimple v0.7.1` linux）。
> 凡是没跑过的，一律标 **未实测**。

## §0 先说结论：我在 T-011 里判断错了，这里更正

T-011 结论 9 我写的是：

> better-sqlite3 是**从源码 node-gyp 编译**通过的（本机有 Python 3.14.6 + gcc）；
> **未验证**没有编译工具链的用户机器上能否装上。

**担忧的方向是对的**（这确实是产品级风险），**但事实判断是错的**。真相分两层：

### 层一：v13 根本没有 install 脚本

```
$ node -e "console.log(require('better-sqlite3/package.json').scripts)"
{ build-release, build-debug, test, benchmark, download, clean }   ← 没有 install
$ node -e "console.log(require('better-sqlite3/package.json').dependencies)"
{ "node-addon-api": "^8.0.0" }                                     ← 没有 prebuild-install
```

`prebuilds/` 目录**随 npm 包一起下发**，8 个文件 17 MB：

```
darwin-arm64.node  darwin-x64.node
linux-arm64.node   linux-x64.node
linuxmusl-arm64.node  linuxmusl-x64.node
win32-arm64.node   win32-x64.node
```

构建方式是 **N-API**（`binding.gyp` 里 `NAPI_VERSION=10`）→ **ABI 稳定**，
不再需要为每个 Node 大版本单独出包。对照：v12.12.0 时代走 `prebuild-install`，
GitHub release 挂 **145 个** 资产（`...-node-v127-linux-x64.tar.gz` 这种，按 Node ABI 分）；
v13.0.0/.1/.2 的 release **资产数为 0**——这不是发布事故，是**刻意的架构切换**
（对应 issue #1465「migrate away from deprecated prebuild-install」、#1491、#655）。

### 层二：node-gyp 是我自己招来的

我在 `pnpm-workspace.yaml` 把 `better-sqlite3` 写进了 `onlyBuiltDependencies`。
pnpm 看到包里有 `binding.gyp` 且被允许跑脚本，就执行了一次 `node-gyp rebuild`。
回看 T-011 的安装日志，它其实**什么都没编译**：

```
TOUCH Release/obj.target/better_sqlite3.stamp
TOUCH Release/obj.target/test_extension.stamp
gyp info ok
```

实测确认 `build/` 里 **`.node` 文件数 = 0**，运行时 `dlopen` 到的是：

```
dlopen -> .../better-sqlite3/prebuilds/linux-x64.node
```

**即：那次编译是纯空转，却让安装从 1 秒变成 85 秒，还平白要求用户机器有 make/gcc/Python。**

### 修复与验证

从 `onlyBuiltDependencies` 移除后：

```
$ rm -rf node_modules && pnpm install
...
╭ Warning ──────────────────────────────────╮
│   Ignored build scripts: better-sqlite3.  │
╰───────────────────────────────────────────╯
Done in 976ms using pnpm v10.15.0          ← 原本 1m24.8s
```

随后功能全部正常（`build/` 下 0 个 `.node`，走的是 prebuild）：

```
require: OK | sqlite 3.53.4
sqlite-vec: v0.1.9
中文分词检索: [{"body":"思维导图与转写稿的时间轴联动"}]
版本: 13.0.2 | 本地编译产物 .node 数: 0
```

另在**全新空目录**用 `npm install better-sqlite3@13.0.2 --ignore-scripts` 复现
（模拟"用户机器完全没有编译工具链"）：`require` + `loadExtension(sqlite-vec)` +
`loadExtension(libsimple)` **全部成功**，`build/` 下 0 个 `.node`。

> ✅ **TD-003 可以关闭。** "用户不碰命令行"这条产品线不会因为 SQLite 断掉。

---

## §1 三方案实测对比表

| 维度                           | **better-sqlite3 13.0.2**                                                                      | **node:sqlite（Node 内置）**                                                                                                                                                                                | **node-sqlite3-wasm 0.8.60** |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 许可证                         | MIT                                                                                            | Node 自带（MIT）                                                                                                                                                                                            | MIT                          |
| 最近发布                       | 2026-07-29                                                                                     | 随 Node                                                                                                                                                                                                     | 2026-07-28                   |
| **需要编译工具链**             | ❌ 不需要（8 平台 prebuild 内置于 tarball）                                                    | ❌ 不需要（零依赖）                                                                                                                                                                                         | ❌ 不需要（纯 WASM）         |
| 安装时是否联网取二进制         | 否（随 tarball）                                                                               | 无需安装                                                                                                                                                                                                    | 否                           |
| SQLite 版本                    | **3.53.4**                                                                                     | 3.53.4 (N24) / **3.51.3 (N22)**                                                                                                                                                                             | 3.53.4                       |
| **FTS5**                       | ✅ `ENABLE_FTS5`                                                                               | ✅ `ENABLE_FTS5`                                                                                                                                                                                            | ✅ `ENABLE_FTS5`             |
| **loadExtension API**          | ✅ `db.loadExtension(path[,entry])`                                                            | ✅ 需 `{allowExtension:true}` + `enableLoadExtension(true)`                                                                                                                                                 | ❌ **不存在该方法**          |
| `OMIT_LOAD_EXTENSION`          | 否                                                                                             | 否                                                                                                                                                                                                          | ✅ **编译期就关掉了**        |
| **加载 sqlite-vec**            | ✅ v0.1.9                                                                                      | ✅ v0.1.9                                                                                                                                                                                                   | ❌ 结构性不可能              |
| **加载 libsimple（中文分词）** | ✅                                                                                             | ✅                                                                                                                                                                                                          | ❌ 结构性不可能              |
| API 成熟度                     | 高：`transaction()` `pragma()` `explain` `backup` `table()` `function` `aggregate` `serialize` | 中高：`function` `aggregate` `createSession`/`applyChangeset` `serialize`/`deserialize` `setAuthorizer` `enableDefensive` + 模块级 `backup`；**无** `transaction()`/`pragma()`/`explain`/`table()` 便捷封装 | 低                           |
| 稳定性标记                     | 正式版                                                                                         | **Node 22：experimental（实测打 ExperimentalWarning）**；Node 24：无警告                                                                                                                                    | 正式版                       |
| 平台覆盖                       | linux(glibc/musl)/darwin/win32 × x64/arm64；**无 win32-ia32**                                  | 跟随 Node，全平台                                                                                                                                                                                           | 全平台                       |
| 打包影响                       | 需随产品分发对应 `.node`                                                                       | **无任何原生产物**                                                                                                                                                                                          | 需带 `.wasm`                 |

### 性能实测

工作负载：单事务插入 20,000 行 → FTS5 `rebuild` → 2,000 次 `MATCH` 查询（命中共 4,000,000 行）。
本机 Linux x64，Node 24.18.0。

| 驱动                  | setup | 插入 20,000 行 | 2,000 次 FTS 查询 |
| --------------------- | ----- | -------------- | ----------------- |
| **better-sqlite3**    | 4 ms  | **43 ms**      | **101 ms**        |
| **node:sqlite**       | 1 ms  | **43 ms**      | 113 ms            |
| **node-sqlite3-wasm** | 17 ms | 55 ms          | **306 ms**（≈3×） |

> 写入几乎无差别；查询上 WASM 约慢 3 倍。better-sqlite3 与 node:sqlite 实质等价（差 ~10%）。
> ⚠️ 这是**单次运行**的粗测，不是严谨 benchmark（无预热、无多轮取中位数）。用于分档足够，不要引用为精确数字。

### 为什么 WASM 直接出局

```
node-sqlite3-wasm
  LOAD_EXTENSION: OMIT_LOAD_EXTENSION
  有 loadExtension API 吗: undefined
  加载 sqlite-vec FAILED: db.loadExtension is not a function
```

它在**编译期**就定义了 `SQLITE_OMIT_LOAD_EXTENSION`。这不是"慢"或"少个 API"，
而是**中文分词（libsimple）与向量检索（sqlite-vec）在这条路上根本不存在**。
D-02 §4 的检索三件套会塌掉两件。→ **不予考虑**。
（`sql.js` 同类问题，且更旧；`@sqlite.org/sqlite-wasm` 是官方 WASM，同样无法 dlopen 原生扩展。）

---

## §2 Node 22 vs Node 24：`node:sqlite` 的关键差异（实测）

我下载了真实的 **Node 22.23.2**（LTS "Jod"，2026-07-28）做对照，因为 ADR-006 决策 7 把基线定在 22。

|                                                     | Node 22.23.2                                                                                    | Node 24.18.0  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------- |
| `node:sqlite` 可用性                                | **不需要 `--experimental-sqlite` flag**                                                         | 同            |
| 稳定性                                              | ⚠️ **打 `ExperimentalWarning: SQLite is an experimental feature and might change at any time`** | ✅ **无警告** |
| SQLite 版本                                         | 3.51.3                                                                                          | 3.53.4        |
| `pragma compile_options` 含 `ENABLE_LOAD_EXTENSION` | ❌ **不含**                                                                                     | ✅ 含         |
| **实际 `loadExtension`**                            | ✅ **照样成功**（sqlite-vec + libsimple 全通）                                                  | ✅ 成功       |

> 🔑 **重要陷阱**：Node 22 的 `compile_options` 里查不到 `ENABLE_LOAD_EXTENSION`，
> **但扩展照样加载成功**。better-sqlite3 也一样（它的 `compile_options` 同样不列这一项，
> 扩展却能加载）。**`SQLITE_ENABLE_LOAD_EXTENSION` 不是"开启"开关**——
> 扩展加载默认就是编译进去的，除非定义了 `SQLITE_OMIT_LOAD_EXTENSION` 才关掉。
> → **判断扩展能力只能实测，不能读 compile_options。**（D-02 §21 的 V-6 提法需按此订正。）

`node:sqlite` 的安全默认值是对的：不传 `{allowExtension:true}` 时调 `loadExtension`
会被拒（`ERR_INVALID_STATE`）——比 better-sqlite3 默认放行更稳妥。

---

## §3 用 D-02 的真实 DDL 做验证（此前从未在 SQLite 上跑过）

D-02 §21 自述：「本文所有 DDL **未在任何 SQLite 实例上执行过**」。
我把 §4.1 的 `notes_fts` 外部内容表 + 三组触发器原样跑了一遍：

```
journal_mode -> wal
foreign_keys -> 1
外部内容表 + tokenize=simple: OK
三组触发器: OK
中文检索「思维导图」: [{"uid":"01J...A","title":"会议纪要","r":-0.0000043812}]
中文检索「架构」   : [{"uid":"01J...B","title":"Podcast 笔记","r":-0.0000021098}]
simple_highlight  : [{"h":"讨论了[思维导图]的[导]出格式与转写稿时间轴联动"}]
UPDATE 后再搜「思维导图」(应为空): []
UPDATE 后搜「向量检索」        : [{"uid":"01J...A",...}]
DELETE 后搜「向量检索」(应为空): []
```

**结论：D-02 §4.1 的 DDL 与触发器设计正确，insert/update/delete 三路同步都工作。**

### 拼音检索（libsimple）逐项实测

| 查询                                 | 结果                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| `simple_query('思维导图')`           | ✅ 命中                                                              |
| `simple_query('swdt')`               | ✅ 命中（思维导图 首字母）                                           |
| `simple_query('sw')`                 | ✅ 命中                                                              |
| `simple_query('zhuanxie')`           | ✅ 命中（转写 全拼）                                                 |
| `simple_query('zx')`                 | ✅ 命中                                                              |
| `simple_query('时间轴')` / `('sjz')` | ✅ 命中                                                              |
| `simple_query('sxdt')`               | ❌ 未命中 —— **这是正确行为**，思维导图的首字母是 `swdt` 不是 `sxdt` |

> D-02 §20 ③ 说 libsimple「原生支持拼音检索」—— **实测确认属实**，全拼与首字母都支持。

### 中文分词的必要性（顺带证明）

不加 libsimple、用 SQLite 默认 tokenizer：

```
FTS5 create+insert: OK
  match hello -> [{"body":"hello world"}]
  match 思维   -> []          ← 中文完全搜不到
```

→ **libsimple 不是优化项，是中文可用性的前提。** R-03 §2 D9 的判断成立。

### `vec0` 元数据列 + KNN

```
KNN 查询: [{"rowid":1,"distance":0},{"rowid":2,"distance":13.190905570983887}]
vec0 元数据列 + KNN: ✅
```

---

## §4 ⚠️ 给 architect 的订正：`vec0` rowid 绑定陷阱

跑 D-02 §4.3 时撞到的**真问题**：

```
Error: Only integers are allows for primary key values on vec_chunks
  code: 'ERR_SQLITE_ERROR', errcode: 1, errstr: 'SQL logic error'
```

我在两个驱动上逐一试了 5 种写法，**结果完全一致**：

| 写法                                | better-sqlite3 | node:sqlite |
| ----------------------------------- | -------------- | ----------- |
| `.run(1, 2, emb)` —— 传 JS `number` | ❌ 失败        | ❌ 失败     |
| `.run(1n, 2n, emb)` —— 传 `BigInt`  | ✅             | ✅          |
| SQL 字面量 `values (3, 2, '[...]')` | ✅             | ✅          |
| 省略 rowid 让它自增                 | ✅             | ✅          |
| `CAST(? AS INTEGER)`                | ✅             | ✅          |

**这不是驱动 bug，是 `sqlite-vec` v0.1.9 的行为**：两个驱动都把 JS `number` 绑成 SQLite 的
浮点类型，而 `vec0` 的主键严格要求 INTEGER。

> 📌 **对 D-02 的影响**：D-02 §12 的「双 ID 约定」说得对（内部整数 PK 是 FTS5 `content_rowid`
> 与 sqlite-vec 的硬要求），但 **§4.3 的插入代码样例必须补上绑定方式**，否则实现时必踩。
> 建议 D-02 统一约定：**所有写 `vec0` 的地方一律绑 `BigInt`**，
> 并在 DB 适配层里做转换，不要指望调用方记得。
> （`node:sqlite` 的 `Statement.setReadBigInts()` 可以让读出来的也是 BigInt，两头对齐。）

---

## §5 推荐与理由

### 推荐：`better-sqlite3` v13.0.2 为主，`node:sqlite` 为已验证备胎，中间隔一层薄适配层

**为什么不换成 `node:sqlite`**（尽管它零依赖、很诱人）：

1. **换掉 better-sqlite3 的原始理由已经证伪。** 这次 spike 的起因是"要编译工具链"，
   实测证明不需要。理由没了，就不该为了换而换。
2. **Node 22 上它仍是 experimental**（实测有警告，官方明说 "might change at any time"）。
   而 ADR-006 决策 7 把基线定在 **22**。要用 stable 的 `node:sqlite` 就得把基线抬到 24，
   这会反过来推翻 ADR-006，牵动 `gpu-runtime` 的 CI matrix。**代价大于收益。**
3. **D-02 已经按 better-sqlite3 写了**（§51 的连接级 `foreign_keys`、§878 的
   `db.loadExtension(...)` 样例）。保持不变 = 迁移影响 0。
4. 便捷 API（`transaction()`、`pragma()`）在 `node:sqlite` 上要自己补。

**为什么仍要留 `node:sqlite` 备胎**：

- 上游 **open issue #1509**：`prebuilds/linux-arm64.node` 要求 **GLIBC_2.38**，
  老 Linux 发行版会 `GLIBC_2.38 not found`。这是 better-sqlite3 路线的**主要残留风险**。
- `node:sqlite` 的扩展能力经本文实测与 better-sqlite3 **完全等价**（FTS5 + sqlite-vec + libsimple 全通），
  真出问题时切换是可行的。
- 因此建议 **`packages/daemon` 里加一层薄 DB 适配层**（`open / prepare / exec / loadExtension / transaction`
  五个方法足够），让两者可替换。这也符合 ADR-001 强制配套第 2 条"所有组件都必须模块化调用"。

### 配套配置（已落地）

- `pnpm-workspace.yaml`：**`better-sqlite3` 移出 `onlyBuiltDependencies`**，并写明原因。
  这不只是提速，更是**去掉对用户机器编译工具链的隐性依赖**。
- Node 基线：`engines: ">=22"`（root + 7 个包全部同步），`.nvmrc` = `22`。**维持 ADR-006 不变。**

### 迁移影响评估（回答 Manager 的问题）

| 对象                      | 影响                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- |
| **D-02 的 DDL**           | **无需改动** —— 已实测全部通过                                                |
| D-02 §4.3 代码样例        | ⚠️ **需改**：`vec0` 插入必须绑 BigInt / CAST（见 §4）                         |
| D-02 §21 的 V-6 未验证项  | ✅ **可关闭**，但结论要写成"实测通过"而非"compile_options 显示"（见 §2 陷阱） |
| `model-mgmt` (T-013)      | 无影响（不碰 DB 驱动）                                                        |
| `gpu-runtime` (T-012)     | 无影响；CI matrix 保持 Node 22                                                |
| ADR-006 决策 7（基线 22） | **不需要改**                                                                  |

---

## §6 未验证 / 风险清单（诚实）

| #   | 项目                                                                                                                              | 状态                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| U-1 | **只在 Linux x64 (glibc) 实测。** macOS(arm64/x64)、Windows(x64/arm64)、Linux arm64/musl 的 prebuild **全部未实测**（无对应机器） | 未实测                                          |
| U-2 | 上游 open issue **#1509**：`linux-arm64.node` 需要 **GLIBC_2.38**，老发行版会失败                                                 | 已知风险，未复现                                |
| U-3 | better-sqlite3 v13 **无 win32-ia32**（32 位 Windows）prebuild —— v12 时代有                                                       | 已核实，影响面判断为可接受（未与 Manager 确认） |
| U-4 | 性能数字是**单次粗测**（无预热、无多轮中位数），仅用于分档                                                                        | 粗测                                            |
| U-5 | `node:sqlite` 在 Node 22 上标 experimental，**未评估**其 API 在 22.x 生命周期内变更的概率                                         | UNKNOWN                                         |
| U-6 | libsimple / sqlite-vec 的 **mac/Windows 预编译产物未下载验证**（本文只验了 linux 版）                                             | 未实测                                          |
| U-7 | 未测**并发**：daemon 多连接 + WAL 下的读写竞争、`busy_timeout` 行为                                                               | 未测                                            |
| U-8 | 未测**大规模向量**（本文只插了 2 条向量），sqlite-vec 在 10 万级 chunk 上的表现 UNKNOWN                                           | 未测                                            |
| U-9 | `sqlite-vec` 仍是 **0.1.x**，磁盘格式可能变（R-03 已警告，D-02 已设计成可重建，风险已缓解）                                       | 已缓解                                          |
