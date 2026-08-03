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

| 场景 | `verbatimSymlinks` 管用吗 | `verifyTreesMatch` 管用吗 |
|---|---|---|
| `fs.cp` 改写相对链接（本次事故） | ✅ 修掉 | ✅ 能变红 |
| 数据里**本来就有**绝对路径自指链接（`/旧位置/a → /旧位置/b`） | ❌ **原样保留正是它的职责** | ❌ **两棵树逐字相同，必然报"一致"** |
| **同盘 rename 快路径**（`forceCopy=false`，即默认） | — | ❌ **根本不调用它** |

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

| 分组 | 条数 | 钉住的性质 |
|---|---|---|
| `verifyTreesMatch` 符号链接 | 4 | 目标被改写 → 报「链接目标不一致」（两级链 **6 条**逐条对上）；verbatim → 通过；被 deref 成真文件 → 报「类型不一致」；少一条链接 → 报「缺失」 |
| `measureTree` | 2 | 链接单独计数且不并进 `files`；**不跟随目录链接**（含一条指向父目录的，跟随即死循环） |
| `findStaleLinks` | 3 | 绝对链接指向旧目录 → 抓到；同目录相对链接 → **不误报**；指向 `/usr/lib` → 不误报 |
| T-128 端到端 | 5 | rename / copy **两条策略各一条**：搬完删源后 `readlink` 两跳都还是相对的，且**顺着链真读到目标内容**；校验必须拦下被改写的树；已有绝对自指链接 → `staleLinks` 报出来（rename 路径单独再钉一次） |
| 合计 | **19** | |

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
