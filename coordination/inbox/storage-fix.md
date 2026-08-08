# inbox: storage-fix

## [2026-08-03 20:15] T-128 DONE

### TL;DR（≤25 行）

1. **`model-mgmt` 的根因判断完全正确，我独立复现了，无异议。** Node v24.18.0 实测：
   `fs.cp` 默认把相对链接改写成**指向源目录的绝对路径**，两级链两跳都被改写；随后删源 → 全断。
2. **修复 1**：`move.ts` 的 `fs.cp` 加 `verbatimSymlinks: true`。**未碰 `unpack.ts`**（它写相对链接是对的）。
3. **修复 2（更重要）**：`verifyTreesMatch` 现在把符号链接**纳入校验，比 `readlink` 的结果本身**，
   并区分「类型不一致」（链接被 deref 成真文件）。`measureTree` 新增 `links` 单独计数、按
   `lstat().size` 计入 bytes、**不跟随**（跟随会重复计数，指向父目录会死循环）。
4. **修复 3（我加的，超出你列的两条，理由见 §3）**：`findStaleLinks()` —— 搬完后查新目录里
   还有没有链接指着**即将被删的旧位置**。`verbatimSymlinks` **修不了**"数据里本来就有绝对路径
   自指链接"这一类；而 **rename 快路径根本不调用 `verifyTreesMatch`**，原先零符号链接检查。
5. **反向验证做了 4 组，全部贴了真实输出（§4）。** 最关键一组是**同时撤掉两半**（= 事故当天的
   代码）：`moveDataDir` 返回 **`ok: true`（绿灯）**、源目录已删，而 `readlink` 拿到
   `/tmp/om-move-soc-2gxeJU/src/.../libwhisper.so.1` —— **一个已经不存在的路径**。假绿灯当场复现。
6. **测试 13 → 32 条，原 13 条一条没删、一条没改。** 新增 19 条，其中 7 条用**两级链**
   （`a.so → a.so.1 → a.so.1.9.1`），断言是「顺着链**真的读到目标内容**」而不是「链接存在」。
7. **门禁真实 exit code**：`tsc -b: 0` · `eslint . : 0`（**全仓库**，不只我的文件） ·
   `pnpm -r test: 0`（db 47 / web 18 / web-components 122 / daemon **95** = 282 passed, 0 failed）。
8. **未验证/存疑**：① 只在 Linux/ext4 验过，**Windows/macOS 未验**（Windows 符号链接需要权限，
   行为可能不同）；② **没跑任何转写**（按用户新指令），`.so` 全是假占位文件；
   ③ `findStaleLinks` **不覆盖**"相对链接跨出数据目录"（如 `../../x`）—— 见 §6 已知边界。
9. **对其他 agent 的影响**：`MoveResult` 加了 3 个字段（`links` / `staleLinks` / `warningZh`），
   **全是新增，无破坏性改动**；`measureTree` 返回值加 `links`。`apps/daemon/src/http/rest/storage.ts`
   我**一个字没改**（编译通过，无需改）—— 但它现在**没有把 `warningZh` 透给用户**，见 §7-1。
10. 纪律：只改 `apps/daemon/src/storage/` 下 2 个文件（`git status` 可核）；未碰 web；
    未构建 `apps/web/dist`（mtime 前后都是 `19:56:22`，不是我写的）；未碰 `/root/data-memo`；未碰 `:10000`。

---

### 1. 交付

```
apps/daemon/src/storage/move.ts        （改）
apps/daemon/src/storage/move.test.ts   （改，13 → 32 条）
coordination/inbox/storage-fix.md      （本文件）
```

`git add` 清单（**没有用 `git add -A`**）：

```
git add apps/daemon/src/storage/move.ts \
        apps/daemon/src/storage/move.test.ts \
        coordination/inbox/storage-fix.md
```

`git status --short` 在我动手前后都只有这两个源文件是 `M`，没有夹带任何别人的改动。

### 2. 根因复核：我独立跑了一遍，结论与 `model-mgmt` 一致

我没有直接采信，先自己造了两级链复现（`/tmp/storage-fix/repro/repro.mjs`，Node **v24.18.0**）：

```
[default   fs.cp (source still present)]
   libwhisper.so -> /tmp/storage-fix/repro/src/libwhisper.so.1
   libwhisper.so.1 -> /tmp/storage-fix/repro/src/libwhisper.so.1.9.1
[verbatim  fs.cp (source still present)]
   libwhisper.so -> libwhisper.so.1
   libwhisper.so.1 -> libwhisper.so.1.9.1
AFTER rm(source): dst_default/libwhisper.so  -> /tmp/.../src/libwhisper.so.1 => BROKEN (ENOENT)
AFTER rm(source): dst_verbatim/libwhisper.so -> libwhisper.so.1              => READABLE ("REALCONTENT")
```

**两级链的两跳都被改写**（`model-mgmt` 的报告只展示了一跳，实际更糟）。
`.so → .so.1 → .so.1.9.1` 这个形状不是我编的，是 whisper.cpp 官方 tarball 的原样
（`model-mgmt` T-045 用 `tar -tzvf` 记录过），也正是用户断掉的那 8 条。

**结论：根因判断成立，`verbatimSymlinks: true` 是正确修法，我无 DISPUTE。**

### 3. 为什么我多加了 `findStaleLinks`（第三条，你没点名）

你要求的是两条：加 `verbatimSymlinks`、让 `verifyTreesMatch` 纳入符号链接。做完这两条之后
我发现**还有一条路是完全裸的**，而且它是**默认路径**：

| 场景                                                          | `verbatimSymlinks` 管用吗   | `verifyTreesMatch` 管用吗           |
| ------------------------------------------------------------- | --------------------------- | ----------------------------------- |
| `fs.cp` 改写相对链接（本次事故）                              | ✅ 修掉                     | ✅ 能变红                           |
| 数据里**本来就有**绝对路径自指链接（`/旧位置/a → /旧位置/b`） | ❌ **原样保留正是它的职责** | ❌ **两棵树逐字相同，必然报"一致"** |
| **同盘 rename 快路径**（`forceCopy=false`，即默认）           | —                           | ❌ **根本不调用它**                 |

后两行合起来是：**同盘移动 + 已有绝对链接 = 又是一次静默弄坏 + 绿灯**，和这次事故一模一样，
只是触发条件换了一个。所以我加了 `findStaleLinks(newDir, oldDir)`：查的是**后果**
（"搬完还有没有东西指着一个即将消失的地方"），而不是形式。两条策略都会走这一步。

**它是警告不是失败**（`ok: true` + `staleLinks[]` + `warningZh`）：数据确实全部搬到位了，
为几条链接把整次迁移回滚只会让用户更糟；但**必须说出来**，因为这正是"绿灯背后功能已经坏了"那一格。

### 4. 反向验证：4 组，全部真实输出

方法：备份 → 拆掉修复的某一部分 → `tsc -b` → 跑测试 → **确认真的红** → 从备份还原 → 确认变绿。
备份在 `/tmp/storage-fix/backup/`。基线：**32 passed / 0 failed**。

#### E1 —— 只拿掉 `verbatimSymlinks: true`

```
ℹ tests 32   ℹ pass 31   ℹ fail 1
✖ ★ copy（跨盘慢路径）：搬完源目录删掉后，两级 .so 链仍然可加载
  AssertionError: false !== true            ← moveDataDir 返回 ok:false
```

护栏拦住了：新的 `verifyTreesMatch` 抓到链接目标不一致 → **回滚，源一个字节没删**。
这是"修复没了但护栏在"的正确行为。

#### E2 —— **同时**拿掉 `verbatimSymlinks` 和 `verifyTreesMatch` 的符号链接支持（= 事故当天的代码）

这一组才是重点：**`ok: true` 那句断言通过了**（绿灯），失败发生在后面读链接的时候。

```
ℹ tests 32   ℹ pass 29   ℹ fail 3

✖ ★ 符号链接被改写成绝对路径 → 必须报「链接目标不一致」（这正是 fs.cp 默认干的事）
  AssertionError: 符号链接被改写却报"一致" —— 假绿灯又回来了
  true !== false

✖ ★ copy（跨盘慢路径）：搬完源目录删掉后，两级 .so 链仍然可加载
  AssertionError: libwhisper.so 的链接目标被改写了
  + actual   - expected
  + '/tmp/om-move-soc-2gxeJU/src/models/by-name/backend/whisper-bin-ubuntu-x64/libwhisper.so.1'
  - 'libwhisper.so.1'

✖ ★ 复制路径若把链接改写了，校验必须**拦下来并回滚**，源一个字节不动
  AssertionError: 校验放行了一棵链接已被改写的树 —— 源就会被删掉
  true !== false
```

`actual` 里那个 `/tmp/om-move-soc-2gxeJU/src/...` **在断言执行时已经被删掉了** ——
这就是用户 `/root/data-memo` 里那 8 条链接的完整形状，一比一复现。

#### E3 —— 只把 `measureTree` 改回"跳过符号链接"

```
ℹ tests 32   ℹ pass 28   ℹ fail 4
✖ ★ 链接单独计数，且不并进 files              AssertionError: 3 个 .so × 两级链 = 6 条  0 !== 6
✖ ★ 不跟随指向目录的链接（…）                 AssertionError: 0 !== 2
✖ ★ rename（同盘快路径）：…两级 .so 链仍然可加载  AssertionError: 0 !== 6
✖ ★ copy（跨盘慢路径）：…两级 .so 链仍然可加载    AssertionError: 0 !== 6
```

#### E4 —— 只停掉 `findStaleLinks`（`succeeded()` 里改成常量空数组）

```
ℹ tests 32   ℹ pass 29   ℹ fail 3
✖ ★ 数据里本来就有**绝对路径**链接指向自己 → 搬完必须报出来（verbatim 修不了这种）
  AssertionError: 指向旧位置的链接必须被报出来，不能静默绿灯    0 !== 1
✖ ★ rename 快路径也要查 stale 链接（它根本不调用 verifyTreesMatch）
  AssertionError: 0 !== 1
```

（这一组跑的时候 E1 的改动还没还原，所以 copy 那条也一并红了 3 条。）

#### 还原后

```
ℹ tests 32   ℹ suites 7   ℹ pass 32   ℹ fail 0
```

**四组每一组都真的变红了，我没有"认为它会红"。**

### 5. 测试清单（19 条新增，原 13 条原封不动）

| 分组                        | 条数   | 钉住的性质                                                                                                                                                                                      |
| --------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyTreesMatch` 符号链接 | 4      | 目标被改写 → 报「链接目标不一致」（两级链 **6 条**逐条对上）；verbatim → 通过；被 deref 成真文件 → 报「类型不一致」；少一条链接 → 报「缺失」                                                    |
| `measureTree`               | 2      | 链接单独计数且不并进 `files`；**不跟随目录链接**（含一条指向父目录的，跟随即死循环）                                                                                                            |
| `findStaleLinks`            | 3      | 绝对链接指向旧目录 → 抓到；同目录相对链接 → **不误报**；指向 `/usr/lib` → 不误报                                                                                                                |
| T-128 端到端                | 5      | rename / copy **两条策略各一条**：搬完删源后 `readlink` 两跳都还是相对的，且**顺着链真读到目标内容**；校验必须拦下被改写的树；已有绝对自指链接 → `staleLinks` 报出来（rename 路径单独再钉一次） |
| 合计                        | **19** |                                                                                                                                                                                                 |

**断言写法上的一条纪律**：`.so` 那几条的最终断言是
`readFile(dst/.../libwhisper.so)` 的**内容以 `libwhisper-REAL-BYTES` 开头**，
不是 `access()` 也不是 `lstat()` —— 悬空链接 `lstat` 照样成功，
「组件存在」在这个 bug 上恰恰就是那盏假绿灯。

### 6. 已知边界（诚实标注，**未覆盖**）

1. **只在 Linux / ext4 验过。Windows 与 macOS 未验。** Windows 建符号链接需要额外权限，
   `fs.cp` 的 verbatim 行为我**没有机器可测**，不声称。
2. **`findStaleLinks` 不覆盖"相对链接跨出数据目录"**（如 `models/x → ../../外面/y`）。
   verbatim 会原样保留它，搬到新位置后它指向的是**另一个地方**。
   没做的理由：`unpack.ts` 在安装时就拒绝逃逸链接（`model-mgmt` T-045，42/42 测试），
   正常数据里不该有；而把"所有指向数据目录外的链接"都报出来会对
   `/usr/lib/...` 这类完全正常的链接**误报**。**这条是明知而未做，不是漏了。**
3. **没有跑任何转写**（用户新指令）。测试树里的 `.so` 是假占位文件，
   验的是"链接可解析并读到预期内容"，**不是** "whisper 真的能加载"。
   真实链路的证据在你手里（你手工修好用户数据后 `whisper-cli --help` 已能 `load_backend`）。
4. **没有在真实的 `/root/data-memo` 上跑过任何东西**（你说了不要碰），全部用 `mkdtemp` 临时目录，
   测试 `after()` 里逐个清理。

### 7. 需要 Manager 决策

1. **`warningZh` 目前没有出口。** `apps/daemon/src/http/rest/storage.ts:287-292` 的移动响应
   只回 `bytes/files` 和「已移动 N 个文件到新位置」。`staleLinks`/`warningZh` **算出来了但没透到网页**。
   我按你划的边界（"只碰 `apps/daemon/src/storage/`"）**没有改那个文件**，编译也不需要改。
   要不要接出去请你定 —— 不接的话，"链接断了"这件事仍然只有读日志的人看得到。
   接法很小：响应体加 `staleLinks`/`warningZh` 两个字段，前端有 warning 就渲染成黄条。
2. **用户已经断掉的那份数据**：你手工修好了，但那 8 条链接在**数据库/安装记录里没有任何痕迹**。
   下次装/升级后端时会不会又写回绝对链接，取决于 `unpack.ts`（写相对，是对的）。
   建议把「后端安装后自检一次 `.so` 链是否可解析」加进 selfcheck —— 那不是我的文件，我没做。
3. `move.ts` 第 56 行有一处 **prettier 不合规（超行宽）**，是**我动手前就存在**的
   （`planMove` 的 `return { ...base, ok: false, reason: 'source and target are the same', … }`）。
   我没顺手改，避免在这次 diff 里混入无关噪声。仓库里 `apps/daemon/src/http/rest/storage.ts`
   等文件同样不合规，说明 `format:check` 目前不是门禁。要统一的话建议单独起一个任务。

### 8. 自查（诚实规则）

- **我一开始差点犯一个真错**：把 `return await succeeded('rename')` 写在了 `try` 里面。
  收尾函数一旦抛错就会被那个 `catch` 接住，然后**从"源目录已经不在了"的状态掉进复制路径**。
  自己复读时发现的，已改成用 `renamed` 标志把 return 提到 `try` 外；慢路径同理
  （那边更凶：catch 里的回滚会 `rm(to)`，而此刻 `from` 已经删了 = 删掉唯一一份数据）。
  代码里两处都写了注释说明为什么不能挪回去。**这个坑不是测试抓出来的，是读出来的，我如实记一笔。**
- **E4 那组我跑的时候 E1 的改动还没还原**，所以它红了 3 条而不是 2 条。
  已在 §4-E4 标注，没有把多出来的那条算成 `findStaleLinks` 的功劳。
- `verifyTreesMatch` 我加了 `kind: 'other'`（fifo/socket 等）分支。**这条没有测试覆盖** ——
  造 fifo 需要 `mkfifo`，而数据目录里出现它属于极端情况。它的作用只是"不静默丢弃"，
  比原来的隐式跳过好，但我不声称它被验过。
- **`measureTree` 的 `bytes` 现在把链接自身的 `lstat().size` 算进去了**（几十字节量级）。
  这会让空间预检的估算**极其轻微地变保守**，方向是安全的。但它意味着
  `GET /api/settings/data-dir` 报的字节数会比从前多几百字节 —— **如果有人对着这个数字做过基线，会对不上。**
- 我**没有**去改 `unpack.ts`（你说了别动，我复核过它写的确实是相对链接，改动毫无必要）。
- 全程没有 `pkill`，没有起任何服务，没有占用端口。`pnpm -r test` 里 daemon 的测试自己会起
  `:174xx`/`:173xx` 上的临时实例并自行 `stop()`，与 `:10000` 无关。

---

## [2026-08-03 21:05] T-128 续办 DONE（两个决策点 + 你点名的第 3 条）

### TL;DR（≤25 行）

1. **`warningZh` 已接出去，而且前端真的显示。** daemon 响应加 `links`/`staleLinks`/`warningZh`；
   `DataLocationSection` 渲染成黄条 + **逐条列出是哪几个链接**。对**真 daemon 发真 HTTP**
   验过，响应与界面两端都贴了实际输出（§2）。
2. **selfcheck 加了 `backend.libLinks`**，判据是 `open()` + 读**首 4 字节**（不是 `access`/`lstat`）。
   **同源已实跑校验**：`CLI 与 /api/selfcheck 同源 25 项逐 id 一致`，断链后**两个出口同时变红**（§3）。
3. **你点名的第 3 条，答案是：能测，而且这不是孤例 —— 我在同一文件里找到了第二处，已修。**
   `MoveOptions.onStep` 本身就是现成的**故障注入点**，用它可以精确构造"收尾阶段抛错"这个
   此前无法到达的状态。补了 3 条测试，反向验证时**真的红了**（§4）。
4. **第二处同形状缺陷（新发现，后果同样是删光数据）**：`fs.rm(from)` 原本也在那个
   会 `fs.rm(to)` 回滚的 `try` 里 —— **删源删到一半失败 → 回滚删掉刚校验通过的唯一一份**，
   源缺一半、目标清空，**两份都毁**。已把删源移到 try 外，失败降级成警告（§4.2）。
5. **顺带抓到一个测试基建缺陷**：组件测试宿主 `host.tsx` 的 `type()` **驱动不了受控文本输入框**
   （`fireEvent.change` 与 `input` 都进不到 React 的 onChange，state 恒为空）。
   我**没有改**这个共享文件，但它会让这类测试**静默地空转** —— 我自己就写出过一条这样的
   假绿测试，是靠加"前提断言"才发现的。建议单独派人修，详见 §5，**这条请转达**。
6. **门禁**：`tsc(runtime+daemon)=0` · `tsc(web test 配置)=0` · `eslint . = 0`（全仓库）·
   我的三个套件 **daemon storage 36/36 · runtime selfcheck 20/20 · web components 140(138 pass, 0 fail)**。
7. ⚠️ **`tsc -b` 与 `pnpm -r test` 在仓库层面是红的，但不是我造成的**，我不把它说成绿：
   - `apps/web/src/features/models/ModelsPage.tsx(276)` TS2322 —— `models-page-fix` 在改（+113/−66），我没碰过；
   - `apps/daemon/.../upload.test.js` 1 条失败 —— `job-events` 正在改 `upload.ts`/`jobs/{events,queue,scheduler}.ts`，
     即该断言（`note.created + job.created`）的正主。实测 `grep` 确认：upload 链路**零处**引用我改的文件。
8. **未验证/存疑**：`findStaleLinks` 何时会误报见 §6；Windows/macOS 仍未验；未跑转写。
9. 纪律：未碰 `apps/web/dist`（mtime 前后都是 `19:56:22`）；未碰 `/root/data-memo`；`:10000` 全程只读
   （自建实例用 17820/17830，用完按 pid 精确停）。⚠️ 我踩了一次 `pkill -f`，见 §7 自查。

---

### 1. 交付与 `git add` 清单（**没有用 `git add -A`**）

```
git add apps/daemon/src/storage/move.ts \
        apps/daemon/src/storage/move.test.ts \
        apps/daemon/src/http/rest/storage.ts \
        packages/runtime/src/selfcheck.ts \
        packages/runtime/src/selfcheck.test.ts \
        apps/web/src/features/settings/DataLocationSection.tsx \
        apps/web/src/test/components.test.tsx \
        coordination/inbox/storage-fix.md
```

`apps/web/src/features/settings/` 与 `models-page-fix` 的 `features/models/` **不重叠**；
**没有动 `locales/*.json`**（他正在改），做法见 §2。

### 2. `warningZh` 接出去 —— 端到端真实输出

**daemon 侧**（`http/rest/storage.ts`）：响应加 `links` / `staleLinks` / `warningZh`。

**真 daemon 实测**（自建 `:17830`，dataDir `/tmp/storage-fix/movesrc`，
里面放一条**绝对路径自指链接**，即用户数据里真实存在的形态）：

```json
POST /api/settings/data-dir  {"path":"/tmp/storage-fix/movedst","moveExisting":true}
{
 "ok": true, "moved": true, "strategy": "rename",
 "bytes": 506978, "files": 7, "links": 1,
 "staleLinks": [{ "rel": "models/libx.so",
                  "target": "/tmp/storage-fix/movesrc/models/libx.so.1",
                  "resolved": "/tmp/storage-fix/movesrc/models/libx.so.1" }],
 "warningZh": "数据已全部移动到新位置，但有 1 个符号链接仍指向旧位置（例如 models/libx.so → …），
               旧位置删除后它们会失效。这类链接多来自已安装的后端（如 whisper.cpp 的 .so），
               可能需要重新安装该后端。",
 "messageZh": "已移动 7 个文件与 1 个符号链接到新位置，正在重启以生效。"
}
```

**并且客观核对了它说的是真话**（不是只信自己的断言）：

```
$ cat /tmp/storage-fix/movedst/models/libx.so
cat: …: No such file or directory        ← 链接确实断了
```

注意这条走的是 **`rename` 快路径** —— 它此前**完全没有任何符号链接检查**。

**前端侧**（`DataLocationSection.tsx`）：黄条 + 图标 + **逐条列出链接**（>5 条折叠成计数）。
刻意放在「需要重启」那句绿字**下面而不是替代它**：数据确实搬成功了，
后端可能已不能用，**两件都是事实，只说一件都是误导**。

文案直接用 daemon 的 `warningZh`，**不新增 i18n 词条** —— 同组件里 `entries[].purposeZh`
已经是这么渲染的（"要明文告知用户的后果，以 daemon 为权威"），顺带完全避开
`locales/*.json` 的撞车。

### 3. selfcheck：`backend.libLinks`（同源已实跑校验）

判据**必须是"顺着链真的读到内容"**，所以用 `open()` + 读**首 4 字节**：

- `lstat()` 不跟随链接，**对彻底悬空的链接照样成功** → 用它等于把这条检查写成永远绿；
- `access()` 虽然跟随、悬空会失败，但只回答"能不能"，**不产生可核对的证据**；
- 读 4 字节代价是常数，不受 `.so` 体积影响，且顺带能抓出"指向空文件/被截断"。

`required: true` **写成无条件**：它是纯逻辑（"链断了 = 转写不能用"），环境差异全由 status 承担。
条件化的 `required` 会被 `diffSelfCheckReports` 判成"判据被改分叉了"，而 CLI 与 daemon 的
storeRoot 本来就可能不同。**已用测试钉死**（三种环境下 required 恒为 true 且 id 集合一致）。

**同源实跑**（自建 daemon `:17820`，链接完好时）：

```
✔ 后端 .so 符号链接可解析     2 条链接全部可读到目标内容
── 同源校验
✔ CLI 与 /api/selfcheck 同源  25 项逐 id 一致（本地 5 失败 / 端点 5 失败）
```

**把链接改成事故形态后（指向已消失的旧数据目录），两个出口同时变红**：

```
CLI:
✘ 后端 .so 符号链接可解析 — 2/2 条链接读不到目标：
    whisper-bin-ubuntu-x64/libwhisper.so→libwhisper.so.1(ENOENT)
    whisper-bin-ubuntu-x64/libwhisper.so.1→/tmp/om-gone/…/libwhisper.so.1.9.1(ENOENT)
  → 这些链接指向的是旧数据目录（多半是移动数据目录后留下的）。在「运行时」页重新安装该后端包即可修复；数据与笔记不受影响。
✔ CLI 与 /api/selfcheck 同源  25 项逐 id 一致（本地 6 失败 / 端点 6 失败）

端点 GET /api/selfcheck:
{"id":"backend.libLinks","status":"fail","required":true,
 "detail":"2/2 条链接读不到目标：…(ENOENT)…","remediation":"这些链接指向的是旧数据目录…"}
report.ok = false
```

顺带一个客观佐证，说明为什么判据不能是"组件存在"：

```
$ test -L libwhisper.so.1 && echo "链接在"      → 链接在
$ test -r libwhisper.so.1 || echo "真去读就没了" → 真去读就没了
```

### 4. 你点名的第 3 条：**能被测试覆盖，而且是一类不是孤例**

#### 4.1 能测 —— `onStep` 就是现成的故障注入点

我当初是**复读代码**发现的，但"复读发现"不等于"只能靠复读"。
`MoveOptions.onStep` 本来就是回调，让它在指定步骤抛错，就能精确构造
"收尾阶段失败"这个此前无法到达的状态。补了 3 条测试，钉的是一条不变量：

> **过了「校验通过」这条线之后，无论再发生什么，`to` 里的数据都必须还在。**

**反向验证（把收尾挪回 `try` 里 = 我最初写错的样子）——真的红了：**

```
E9  慢路径两处都挪回 try：      36 tests / 34 pass / 2 fail
  ✖ ★ copy 校验通过后收尾抛错 → 新位置的数据必须完好（回滚会毁掉唯一一份）
     Error: ENOENT: no such file or directory, access '/tmp/om-move-fi-c-NTC3k1/dst/openmemo.db'
  ✖ ★ 删源失败只能降级成警告，绝不能反过来删掉新位置
     Error: ENOENT: no such file or directory, access '/tmp/om-move-fi-rm-RrmV9b/dst/openmemo.db'

E9b 快路径**完全**还原成我最初写错的样子（连 renamed 标志也去掉）：
                                36 tests / 35 pass / 1 fail
  ✖ ★ rename 成功后收尾抛错 → 新位置的数据必须完好（不能掉进复制路径）
     Error: ENOENT: no such file or directory, access '/tmp/om-move-fi-r-zAnATc/dst/openmemo.db'
```

⚠️ **一处必须说明的自我更正**：E9 第一版我保留了 `renamed` 标志，快路径那条**没有变红** ——
因为那不是对原缺陷的忠实复现（`if (renamed) return` 兜住了它）。
我没把这当成"测试不灵"，而是重做了 E9b 把标志一并去掉，这才是我原来写的形状，**当场就红了**。
**贴出来的是两次都做过的事实，不是只贴红的那次。**

#### 4.2 不是孤例 —— 同一形状的第二处，后果一样是删光数据（已修）

按你要的三个特征（`try` 内 return / catch 里做破坏性操作 / 成功路径与回滚路径共享状态）
把 `move.ts` 逐段过了一遍：

| #   | 位置                                                | 形状                               | 结论                                                            |
| --- | --------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| 1   | 快路径 `return await succeeded('rename')` 在 try 内 | try 内 return + catch 落到复制路径 | **我自己写出来的，已修**（`renamed` 标志把 return 提到 try 外） |
| 2   | **慢路径 `fs.rm(from)` 在会回滚的 try 内**          | catch 做 `fs.rm(to)` 破坏性操作    | **新发现，已修** —— 见下                                        |
| 3   | 慢路径 `return await succeeded('copy')`             | 已在 try 外                        | 安全（改动时就放在外面）                                        |
| 4   | 快路径 catch 里的 `fs.mkdir(to)`                    | catch 内操作                       | 非破坏性，安全                                                  |
| 5   | 快路径 rename 前的 `fs.rm(to)`                      | 破坏性                             | 安全：前面已拒过"目标非空"，且有测试钉住                        |
| 6   | `succeeded()` 读闭包里的 `size`                     | 成功/回滚共享状态                  | 只读，安全                                                      |

**第 2 处的后果**：删源删到一半失败（权限 / 文件被占用 / EBUSY）→ catch 触发 `fs.rm(to)`
→ **把刚刚校验通过的唯一一份完整数据删掉**，而源已经缺了一半。**那不是回滚，是两份都毁。**

修法与语义：**过了校验这条线，"移动"就算成功**。源目录删不干净是**残留**，
是一条要如实告诉用户的警告（并进 `warningZh`），不是一个该拿数据去赌的错误。

**我的判断**：这是一**类**，不是孤例。共同点是「**破坏性回滚的作用域画得太大**」——
把"还能安全撤销"的阶段和"已经不可逆"的阶段放进了同一个 `try`。
现在文件里用一条注释把那条线显式画出来了（"校验通过之后就是不归点：从这里往下，`to` 再也不许被删"）。

### 5. ⚠️ 请转达：组件测试宿主驱动不了受控文本输入框（**会让测试静默空转**）

`apps/web/src/test/host.tsx` 的 `type()` 用 `fireEvent.change(el, {target:{value}})`。
对**受控**文本输入框（`value={state}` + `onChange`），**React 的 onChange 收不到**，state 恒为空。
实测证据（临时加探针打出来的，探针已撤）：

```
DEBUG after type:  应用|disabled=true   val=/new/place      ← DOM 值变了
DEBUG state newPath = []                                    ← 而 React state 还是空
```

三种写法都试过，**都不行**：`fireEvent.change` / `fireEvent.input` / 原型链原生 setter + 派发。
`<select>` 是好的（React 对 select 走 `change`），所以现有那条 LLM 下拉测试是真的在测。
现有 `SearchBox` 那条能过，是因为它的 input **不受控**，断言只回读 DOM 值。

**为什么这件事值得单独派人**：它不会报错，只会让测试**看起来通过**。
我自己就写出过一条这样的假绿测试 —— "没有失效链接时不显示警告块"最初是 PASS 的，
而实际上 mutation 根本没发出去，它只是在断言"什么都没发生"。
我加了一句前提断言（"移动请求本身要成功"）才把它揪出来。**这正是本项目反复出现的形状。**

**我的应对（没有改共享文件）**：把警告块抽成 `StaleLinksWarning` 组件直接渲染做断言，
另加一条源码级断言证明 `DataLocationSection` 真的把 `changeDir.data.warningZh` 接进了它；
整条点击链路改用**真 daemon 真 HTTP** 覆盖（§2）。
**两边合起来才算验过；单独任何一边我都不会说它通了。**

反向验证（把渲染从 `DataLocationSection` 里摘掉）：

```
✖ ★ DataLocationSection 确实把 daemon 的 warningZh 接进了这个组件
  AssertionError: mutation 的返回没有被读取
```

### 6. `findStaleLinks` 何时会误报（你要求写清楚）

它把**解析后落在旧数据目录内**的链接判为 stale。会**误报**的情况只有一种：

> 用户**故意**在数据目录里放了指向旧位置的链接，而他**不打算删除旧目录**。

此时链接其实还能用，我们却报了警告。判断：**先误报着**，因为
① 它只是一条警告，不阻断、不回滚、不改任何文件；
② 反过来漏报的代价是转写整个不能用而无人知晓（就是这次事故）。
**不会**误报的情况已用测试钉住：同目录相对链接、指向 `/usr/lib` 的系统库链接，都不报。

**明知而未覆盖**：相对链接跨出数据目录（如 `../../外面/y`）。verbatim 会原样保留它，
搬家后它指向的是**另一个地方**。没做的理由是 `unpack.ts` 安装时就拒绝逃逸链接，
且"所有指向数据目录外的链接都报"会对 `/usr/lib` 这类完全正常的链接大量误报。

### 7. 门禁与自查

```
tsc(packages/runtime + apps/daemon)      = 0
tsc(apps/web/tsconfig.test.json)         = 0     ← 含我改的组件与组件测试
eslint .（全仓库）                        = 0
eslint（我的 7 个文件）                    = 0
apps/daemon storage/move.test            36 / 36 pass
packages/runtime selfcheck.test          20 / 20 pass
apps/web components                     140 tests / 138 pass / 0 fail
packages/db 47 pass · apps/web unit 18 pass
scripts/selfcheck.mjs --daemon           同源 25 项逐 id 一致（完好与断链两种状态各跑一次）
```

**红的两条，是别人的，我不冒领也不掩盖**：

- `apps/web/src/features/models/ModelsPage.tsx(276,15)` TS2322 → `models-page-fix`（该文件 +113/−66，我没碰过）
- `apps/daemon/dist/http/upload.test.js` 1 条失败 → `job-events`（正在改 `upload.ts`/`jobs/{events,queue,scheduler}.ts`，
  正是 `note.created + job.created` 那条断言的正主）。已 `grep` 确认 upload 链路**零处**引用我改的文件。
- 另外中途见过一次 `?tab=llm 切换条` 的红，restore 后复跑即消失 —— 是并发编辑造成的瞬时态，**不是产品缺陷，我没把它算进去**。

**自查（诚实规则）**

- ⚠️ **我用了一次 `pkill -f "port 17820"`，它匹配到了我自己的 shell 并把它杀掉了**（exit 144）。
  这个仓库早有教训（`model-mgmt`「不再用 `pkill -f` 批量杀进程」），**我还是踩了**。
  之后全部改成 `ps -eo pid,args` 精确定位 + `kill <pid>`。
  **`:10000`（pid 2992138）与 `job-events` 的 `:17931` 全程存活，事后逐条确认过。**
  没有造成他人损失，但这是我这轮最不该犯的操作错误。
- **我写出过一条假绿测试**（§5），靠补前提断言才发现。已把这条经验写进测试注释。
- **E9 第一版复现不忠实**，我没有拿它当结论，重做了 E9b（§4.1）。
- `checkBackendSymlinks` 的 `kind:'other'`（fifo/socket）分支**没有测试覆盖**，不声称验过。
- **仍未做**：Windows/macOS 未验（本仓库无 CI，全平台都是这个状态）；未跑任何转写（按用户指令），
  测试里的 `.so` 是带真 ELF 魔数的占位文件，验的是"链可解析并读到预期内容"，
  **不是** "whisper 真能加载"。
