#!/usr/bin/env node
/**
 * 变异检查 —— **"这些地方改坏了必须红"** 的可执行版本。
 *
 * ## 它回答的问题，和覆盖率不是同一个
 *
 * 覆盖率回答「这一行跑过没有」，变异回答「跑过的这一行，**有没有人在乎它算出什么**」。
 * T-137 找到过一个两者给出相反答案的活样本：`argGuard` 的扩展名白名单
 * 改成 `throw` → 6 条红（说明它确实被执行），改成 `return true`（什么都放行）
 * → **132/132 全绿**。行覆盖很好看，而没有任何一条测试依赖它**拒绝**过什么。
 *
 * T-137 手工做了 45 次这样的实验，**22 次存活（49%）**。那是一次性的人工过程：
 * 结论写进了报告，方法没有留下来。这个脚本把其中被修好的那批固化成可重复的。
 *
 * ## 明确不做什么（别把它当 Stryker）
 *
 * - **不自动生成变异**。变异是人挑的：每一条都附「坏了用户会怎样」。
 *   自动生成会产出成千上万条等价变异，然后没人看。
 * - **不进门禁**。它要几分钟、要先 build，而且它测的是**护栏本身**，不是产品。
 *   门禁跑 `pnpm -r test`；这个在**改动被守护的那些文件时**手动跑。
 *   （诚实地说：本仓库没有 CI、没有 git hook、`pnpm check` 也没人跑 ——
 *   多加一条没人跑的门禁没有意义，所以这里不装作它是门禁。）
 *
 * ★ format-debt（本轮）更正上面那个括号：**「本仓库没有 CI」今天已经不成立了。**
 *   `.github/workflows/ci.yml` 在跑，push/PR 自动触发，`pnpm check` 的六个成员
 *   今天也全部有自动调用方了。**结论不变**（这条仍然不进门禁），但**理由只剩下**
 *   前面那句真正成立的：它要几分钟、要先 build，且它测的是**护栏本身**不是产品。
 *   留着那个已经作废的理由很危险 —— 下一个人会照着它推出「反正没 CI」这种今天错的结论。
 *   另：当初挡着它进 CI 的隔离问题（变异体跑在 /tmp 副本 + 假 HOME）**已经解决**，
 *   所以现在不接是**成本取舍**，不再是**做不到**。
 *
 * ## 两条设计决定，都是被真实的坑逼出来的
 *
 * 1. **锚点是源文本，不是行号。** T-137 自评「每 3 个 `file:line` 引用约有 1 个
 *    已经指不到所述代码」。行号锚的清单会在几天内烂掉，然后开始报**假红** ——
 *    而假红会训练人忽略告警，和假绿一样贵。
 *    所以每条变异锚在一段**唯一**的源文本上；找不到或找到多处 → **当场报错并说清楚**，
 *    而不是猜一个位置改下去。
 *
 * 2. **在 `/tmp` 的隔离副本上改，绝不动仓库里的产物。**
 *    我做这一轮时是直接 `sed` 改 `apps/daemon/dist/` 的 —— 那期间任何人跑
 *    `pnpm -r test` 都会看到几条无法解释的红，然后去查一个根本不存在的 bug。
 *    本仓库随时有多个 agent 在跑测试，这不是假设。
 *    副本 + `node_modules` 软链（跨包依赖仍指向真仓库）足够跑起来，实测可行。
 *
 * ## 还有一条防自己人的：**先跑对照组**
 *
 * 变异测试自己最容易出的假绿是「产物本来就是坏的」——
 * 那样每一条变异都"被检测到"了，存活率漂亮得不像话，而它什么都没证明。
 * 所以每个目标包**先跑一遍未变异的测试并要求全绿**，不绿就整包作废并说明。
 *
 * ## 用法
 *
 * ```bash
 * pnpm build:safe                             # 变异跑的是编译产物，必须先 build
 * node scripts/mutation-check.mjs             # 全部（几分钟，不在门禁里）
 * node scripts/mutation-check.mjs --only E1   # 只跑某几条（前缀匹配）
 * node scripts/mutation-check.mjs --list      # 只列清单，不跑
 * node scripts/mutation-check.mjs --anchors-only   # 秒级：只查锚点还在不在（★ 在门禁里）
 * ```
 * 退出码：有任何一条**存活**（改坏了测试还是绿的）、或任何锚点失效 → 1。
 *
 * ── ★ 要重构被守护的文件（例如 `manager.ts` 那 8 种结局）之前，先读这一段 ──────────
 *
 * 这些规格的锚点钉在**编译产物**（`dist/**` / `.test-out/**`）的源文本上，
 * 所以「改契约前按源文件名 grep 谁在钉它」这条纪律**对它们无效** ——
 * 你 grep `manager.ts` 一条都找不到，得 grep `manager.js`。
 *
 * 用这个代替 grep：
 *
 * ```bash
 * pnpm build:safe && node scripts/mutation-check.mjs --anchors-only > /tmp/anchors-before.txt
 * # …重构…
 * pnpm build:safe && node scripts/mutation-check.mjs --anchors-only > /tmp/anchors-after.txt
 * diff /tmp/anchors-before.txt /tmp/anchors-after.txt   # 差集 = 这次重构踩到的规格清单
 * ```
 *
 * 踩到的那几条：**重新指锚点，不要删**。删掉等于顺手把那条不变量的守卫删了。
 * 重构落地后再跑一次**完整**那一档，确认它们不只是"锚点还在"，而是"还抓得住"。
 *
 * `[实测]` `E1-state-dropped` 就是这么死的：T-151 ⑥ 把
 * `state: a.state` 改成 `state: assetStateOf(a.state)`，锚点从此失配，
 * 而**完整那一档没人跑**，所以它安静地什么都没测了好几周。
 *
 * ── ★★ `Mutation-spec anchors` 那一格红了？照这一节做，别先去猜产品坏没坏 ──────────
 *
 * ### 1. 这个代价是**刻意付的**，不是缺陷
 *
 * 锚点钉在编译产物的源文本上 ⇒ **任何一次正常重构都可能让它红**。这是设计的一部分，
 * 不是设计的漏洞：锚点存在的理由是保证**"变异真的改到了东西"**。
 * `[实测]` 本仓有过一次变异**存活**，事后查明是那次编辑**什么都没改到** ——
 * 一条"改坏了却还是绿"的记录，真正的含义是"根本没改坏"。
 * 没有唯一锚点，这种空转会被记成"这条规格没牙齿"，然后有人去修一个没坏的东西。
 * **所以：宁可为重构付一次重指锚点的成本，也不要一份可能在空转的变异报告。**
 *
 * ### 2. 锚点红 ≠ 产品坏。第一步是问：**被守的那个行为还在不在**
 *
 * | 情况 | 处置 |
 * |---|---|
 * | 行为还在，只是文本挪了 | **重新指锚点**（`find`/`replace` 跟着新形状走，`why` 不动） |
 * | 行为换了形态 / 搬到别处了 | 先在注释里**说清新的等价保护在哪**，再改写规格 |
 * | 行为真的不可能再发生了 | 才允许删规格，而且要**论证**为什么它不可能再发生 |
 *
 * ⚠️ **不许因为"红了、赶时间"就删规格。** 删掉的不是一条测试，是那条不变量的唯一守卫。
 *
 * `[实测 2026-08-10]` `E3-write-no-mock-shortcut` 就是第一种：
 * `7a6e626` 把 `if (!isWrite && missingEndpoints.has(key))` 拆成了
 * `const missRec = isWrite ? undefined : …` 两步 —— **`isWrite` 那半个守卫一直都在**，
 * 变的只有锚文本。重指锚点即可，规格一个字没改。
 *
 * ### 3. 谁重构了被守护的文件，谁就该同时更新这里
 *
 * ⚠️ 这个文件是 **CI 治理文件**，改它可能超出你这一轮的授权范围。
 * `[实测 2026-08-10]` 有一路查到了失配、想顺手删那一行，**被权限系统按"超出授权"拦下**；
 * 它没有绕过去，而是回报并请 Manager 指派 —— **那个处置是对的，照做**。
 *
 * 所以流程写死成一句：**能改就顺手改；不能改就报 Manager 指派**，
 * 别把红留在那儿等下一个人从头查一遍（那一个来回，今天走过一次）。
 *
 * ★ **Manager 裁决（2026-08-11）：重指锚点属于常规授权，不必再走那个来回。**
 *
 * 依据是量出来的：`[实测]` 63 个 (commit, spec) 对里断了 6 对，来自 **2 次根因重构**，
 * **2/2 全是合法重构**（被守护的性质原样保留甚至加强，只是锚点文本挪了），
 * **真阳性 0**。也就是说：**锚点红几乎总是"代码挪了"，不是"护栏没了"** ——
 * 为一件几乎必然良性的修复上一道人工闸门，成本全落在摩擦上。
 *
 * 所以：**改 `find:` 让它重新指到同一段逻辑 = 常规操作，自己做。**
 * 但**下面第 4 条那两档必须都跑** —— 重指最容易挑到一段"看起来对、
 * 但没有测试依赖它"的文本，那样锚点绿了而规格已经空转。
 * **放宽的是谁能动手，不是要不要验。**
 *
 * ### 4. 🔴 `--anchors-only` 绿**不等于**规格还有牙齿 —— 重指之后必须跑两档
 *
 * ```bash
 * node scripts/mutation-check.mjs --anchors-only          # ① 秒级：锚点指得到东西吗
 * node scripts/mutation-check.mjs --only <那条规格的 id>   # ② 几分钟：改坏了真的会红吗
 * ```
 *
 * **只跑 ① 就收工，正是这条守卫要防的那种病，长在它自己身上**：
 * 锚点命中只证明"那段文本存在"，**不证明**"把它改坏了测试会红"。
 * 重指的时候很容易挑到一段**看起来对、但没有测试依赖它**的文本 ——
 * 那样锚点是绿的，而规格已经空转。
 *
 * ⇒ **硬要求：重指锚点的那次提交，必须附上 ② 的输出**（`✔ 红 / N 条被测出、0 条存活`）。
 * `[实测 2026-08-10]` `E3-write-no-mock-shortcut` 重指后跑 ②：`1 条被测出，0 条存活` ——
 * 它是**真的**长回了牙齿，不只是锚点指得到东西。
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 目标包：把哪个产物目录复制到 /tmp 去跑。
 * `node_modules` 用软链回真仓库 —— 跨包依赖（`@openmemo/*`）本来就是软链，
 * 所以副本里的 `runtime`/`db`/`pipeline` 指的仍是真仓库那份（T-137 §7b 记过这条边界）。
 */
const PACKAGES = {
  'apps/daemon': { artifactRoot: 'dist' },
  'apps/web': { artifactRoot: '.test-out' },
};

/**
 * ## 变异清单
 *
 * 每一条都必须写 `why`：**这个地方坏了，用户会怎样**。
 * 写不出 `why` 的变异不该在这里 —— 那说明我们不知道自己在守什么。
 *
 * `find` 必须在产物里**唯一**。`replace` 是"把被测行为整句删掉/中和"，
 * 不是"改个符号看看"：判据是"这条不变量没了"，不是"编译不过"。
 */
const MUTATIONS = [
  // ── E1：`GET /api/notes/:uid`。T-137 实测：整个端点从来没有被任何 daemon 测试执行过。
  {
    id: 'E1-endpoint-dead',
    pkg: 'apps/daemon',
    artifact: 'dist/http/rest/notes.js',
    tests: ['dist/http/noteDetailContract.test.js'],
    /*
     * ⚠️ 锚点在 #95 那次改动里烂过一次 —— **规格没变**（还是"把整个端点变成不执行"），
     * 变的只是那一段的**第一条语句**：GET 分支开头插进了一次 `resolveRetranscribeSource`
     * （`canRetranscribe` 从"判 input_url 非空"改成"真去解析一次"）。
     *
     * 重新指的时候**刻意避开注释和 `const assets = …`**，改钉**分支里第一条可执行语句**：
     *   · 原锚点把 `if (method === 'GET') {` 和它下面那行绑在一起，于是"在开头插一行"
     *     这种再正常不过的改动都会让它失效 —— 这已经是它第二次被同类改动打断；
     *   · 钉第一条语句则只要求"这个分支还有第一条语句"，插入注释、插入新语句都不影响，
     *     而变异的语义（在分支最前面 throw）仍然**逐字不变**。
     * 产物里唯一（`grep -c` = 1）。
     */
    find: '                    const retranscribe = await resolveRetranscribeSource(',
    replace:
      "                    throw new Error('mutation-check: 端点没被执行');\n                    const retranscribe = await resolveRetranscribeSource(",
    why: '端点整个不执行 —— T-139 的两个 P0（播放器拿不到音源、正文写得进读不回）就藏在这里，结构上不可能被发现',
  },
  {
    id: 'E1-state-dropped',
    pkg: 'apps/daemon',
    artifact: 'dist/http/rest/notes.js',
    tests: ['dist/http/noteDetailContract.test.js'],
    /*
     * ⚠️ 锚点在 T-151 ⑥ 那次重构里烂掉过：`state: a.state` → `state: assetStateOf(a.state)`。
     * **规格没变**（还是"把 state 整个从载荷里拿掉"），变的只是锚文本。
     * 它烂掉之后这条一直是哑弹 —— 完整那一档会报 ANCHOR 并 exit 1，
     * 但**没有人在跑完整那一档**。所以现在有了 `--anchors-only`（秒级）。
     */
    find: '                        state: assetStateOf(a.state),\n',
    replace: '',
    why: '前端筛 `a.state === "ready"` → 恒 false → `<audio>` 根本不进 DOM：波形在、播放键在，点了什么都不发生，零报错（T-139 A1）',
  },
  {
    id: 'E1-bodyJson-dropped',
    pkg: 'apps/daemon',
    artifact: 'dist/http/rest/notes.js',
    tests: ['dist/http/noteDetailContract.test.js'],
    find: '                        bodyJson: parseJsonOrNull(note.body_json),\n',
    replace: '',
    why: '正文写得进读不回：用户写完自动保存成功，刷新一下正文就"没了"（T-139 A1b，⑤C 第七例）',
  },
  {
    id: 'E1-starred-detail-lies',
    pkg: 'apps/daemon',
    artifact: 'dist/http/rest/notes.js',
    tests: ['dist/http/noteDetailContract.test.js'],
    // `starred` 在**列表**端点上一直是钉住的，**详情**端点上此前是裸的
    find: '                        starred: note.starred === 1,',
    replace: '                        starred: false,',
    why: '详情页的星标状态恒为"未收藏"：用户点了星标、列表里亮着，进详情页又是灭的，改一次亮一次、刷新又灭',
  },
  {
    id: 'E1-folderUid-dangling',
    pkg: 'apps/daemon',
    artifact: 'dist/http/rest/notes.js',
    tests: ['dist/http/noteDetailContract.test.js'],
    find: '                        folderUid: repos.folderUidOf(note.folder_id),',
    replace: "                        folderUid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',",
    why: '笔记指向一个不存在的文件夹：侧栏定位不到当前笔记，而这条链上没有任何一层会报错',
  },
  {
    id: 'E1-tags-dropped',
    pkg: 'apps/daemon',
    artifact: 'dist/http/rest/notes.js',
    tests: ['dist/http/noteDetailContract.test.js'],
    find: '                        tags: repos.tagsOfNote(note.id).map((t) => ({',
    replace: '                        _tagsRemoved: [].map((t) => ({',
    why: '前端 `tags.map()` 撞 `undefined.map` —— 整页崩（端点里那条注释说的正是这个）',
  },

  // ── E2：Host/Origin 闸门。T-137 实测：整段删掉，196/196 全绿；全仓无测试 import 过 guard.ts。
  {
    id: 'E2-host-domain-rule',
    pkg: 'apps/daemon',
    artifact: 'dist/http/guard.js',
    tests: ['dist/http/guard.test.js'],
    find: '    if (!ALLOWED_HOSTS.has(hostname) && !isIpLiteral(hostname)) {',
    replace: '    if (false) {',
    why: 'DNS rebinding 防线整段消失：任意网页把自己的域名重绑到本机，就能读走用户全部笔记与密钥。guard.ts 自称这是"唯一可靠的拦截点"',
  },
  {
    id: 'E2-origin-sameorigin',
    pkg: 'apps/daemon',
    artifact: 'dist/http/guard.js',
    tests: ['dist/http/guard.test.js'],
    find: '    if (originHostname !== normalizedReqHost) {',
    replace: '    if (false) {',
    why: '跨源 Origin 被放行 = CSRF 直接开门；WebSocket 不受 SameSite 完全保护，这是它唯一的拦截点',
  },
  {
    id: 'E2-ipv6-sameorigin',
    pkg: 'apps/daemon',
    artifact: 'dist/http/guard.js',
    tests: ['dist/http/guard.test.js'],
    // 把 T-142 修掉的那个 bug 原样种回去：以为 URL.hostname 会剥方括号，于是再包一层
    find: '    const originHostname = unbracket(parsed.hostname);',
    replace:
      "    const originHostname = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;",
    why: '同源的 IPv6 请求被恒拒：用 http://[::1]:port 打开界面，页面发出的每一个请求都 403，整页全死',
  },
  {
    id: 'E2-ipv6-not-too-loose',
    pkg: 'apps/daemon',
    artifact: 'dist/http/guard.js',
    tests: ['dist/http/guard.test.js'],
    /*
     * 反方向：修 IPv6 最容易做过头的地方是**归一化函数本身** ——
     * 剥得太狠，把本来不同的主机名折叠成同一个，判据就被悄悄放松了。
     * 这里让 `unbracket` 把一切都折叠成空串（"什么都同源"）。
     * ⚠️ 第一版我把这条的锚点写成了和 `E2-origin-sameorigin` 同一行 ——
     * 那是同一个变异写了两遍，只会把数字做大，不增加任何覆盖。
     */
    find: "    const unbracket = (h) => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h).toLowerCase();",
    replace: "    const unbracket = (_h) => '';",
    why: '归一化把不同主机折叠成同源：任意站点带着"合法" Origin 打进来，CSRF 开门 —— 而 IPv6 那几条用例照样绿，看起来像是修对了',
  },
  {
    id: 'POINTER-override-ignored',
    pkg: 'apps/daemon',
    artifact: 'dist/config/paths.js',
    tests: ['dist/storage/restart-datadir.test.js'],
    find: "    return process.env['OPENMEMO_POINTER_FILE'] ?? join(defaultDataDir(), 'datadir.json');",
    replace: "    return join(defaultDataDir(), 'datadir.json');",
    why: '测试重新开始写机器级的全局指针：跑测试跑到一半被 kill，用户的 demo 重启后挂到空壳上，界面上 key/模型/转写"全部消失"（已经真实发生过一次）',
  },
  {
    id: 'E2-secfetch',
    pkg: 'apps/daemon',
    artifact: 'dist/http/guard.js',
    tests: ['dist/http/guard.test.js'],
    find: "    if (site === 'same-origin' || site === 'same-site' || site === 'none')\n        return { ok: true };",
    replace: '    return { ok: true };',
    why: '浏览器强制附加、页面伪造不了的那一层失效 —— 三道闸门去掉一道，且没有任何迹象',
  },

  // ── E3：前端"写操作永不静默回落 mock"。T-137 实测：整族守卫删光，176/176 全绿，
  //     因为测试包里 `mockFetcher` 恒为 null —— 那条断言一直在断言一件不可能发生的事。
  {
    id: 'E3-write-no-mock-notimpl',
    pkg: 'apps/web',
    artifact: '.test-out/unit/lib/api/client.js',
    tests: ['.test-out/unit/lib/api/client.test.js'],
    find: "            if (!isWrite && mockFetcher) {\n                (0, surfaces_1.markSurface)(surface, 'mock');",
    replace:
      "            if (mockFetcher) {\n                (0, surfaces_1.markSurface)(surface, 'mock');",
    why: '路由不存在时写操作静默"成功"：用户以为改动保存了，实际什么都没发生。项目自己的定性是"比报错糟糕得多"',
  },
  {
    id: 'E3-write-no-mock-offline',
    pkg: 'apps/web',
    artifact: '.test-out/unit/lib/api/client.js',
    tests: ['.test-out/unit/lib/api/client.test.js'],
    find: '            if (!isWrite && mockFetcher)\n                return mockFetcher(path, opts);',
    replace: '            if (mockFetcher)\n                return mockFetcher(path, opts);',
    why: 'daemon 没起时写操作回落内存实现 —— 界面显示保存成功，重启后全部消失',
  },
  {
    id: 'E3-write-no-mock-shortcut',
    pkg: 'apps/web',
    artifact: '.test-out/unit/lib/api/client.js',
    tests: ['.test-out/unit/lib/api/client.test.js'],
    /*
     * ⚠️ 锚点在 `7a6e626`（T-200 S-4「一次 404 不再永久钉死」）里被挪走了：
     * `if (!isWrite && missingEndpoints.has(key))` → 拆成 `missRec` 两步。
     * **规格没变**（写请求不许抄近路回 mock），变的只是锚文本 ——
     * 变异照旧是"把 `isWrite` 那半个守卫拿掉"。
     */
    find: '    const missRec = isWrite ? undefined : missingEndpoints.get(key);',
    replace: '    const missRec = missingEndpoints.get(key);',
    why: '已知缺失的端点上，写请求抄近路回 mock —— daemon 后来补上了路由，用户仍然永远保存失败',
  },
  {
    id: 'E3-csrf-header',
    pkg: 'apps/web',
    artifact: '.test-out/unit/lib/api/client.js',
    tests: ['.test-out/unit/lib/api/client.test.js'],
    find: '        if (csrf)\n            h.set(CSRF_HEADER, csrf);\n        if (idempotencyKey)',
    replace:
      '        if (false)\n            h.set(CSRF_HEADER, csrf);\n        if (idempotencyKey)',
    why: '读全通、写全 403：界面一切正常，所有保存静默失败，库里 0 行（这是发生过的事故）',
  },
  {
    id: 'E3-credentials',
    pkg: 'apps/web',
    artifact: '.test-out/unit/lib/api/client.js',
    tests: ['.test-out/unit/lib/api/client.test.js'],
    find: "        credentials: 'same-origin',",
    replace: "        credentials: 'omit',",
    why: 'cookie 不上线 —— 鉴权整个失效，表现同上：读像是正常的，写全挂',
  },
  {
    id: 'E3-handshake-gate',
    pkg: 'apps/web',
    artifact: '.test-out/unit/lib/api/client.js',
    tests: ['.test-out/unit/lib/api/client.test.js'],
    find: '    await gate();',
    replace: '    /* gate removed */;',
    why: '首屏每个 query 都比握手快 ⇒ 一片 401 ⇒ 满屏"未认证，请重新打开应用"',
  },
];

// ─────────────────────────── 以下是执行器 ───────────────────────────

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const listOnly = argv.includes('--list');

const selected = MUTATIONS.filter((m) => !only || m.id.startsWith(only));
if (selected.length === 0) {
  console.error(
    `没有匹配 --only ${only} 的变异。可用：\n  ${MUTATIONS.map((m) => m.id).join('\n  ')}`,
  );
  process.exit(1);
}

if (listOnly) {
  for (const m of selected) console.log(`${m.id}\n    ${m.why}\n    ← ${m.pkg}/${m.artifact}`);
  process.exit(0);
}

/**
 * `--anchors-only`：**只问「每条锚点还指得到东西吗」，不跑任何测试。**
 *
 * ## 为什么单独有这一档
 *
 * 完整的变异跑要先 build、要为每个包起沙箱、要把测试跑 N 遍 —— 几分钟起步，
 * 所以它（有意地）不进门禁。代价是：**锚点烂掉这件事没有任何人在看。**
 * 而锚点烂掉的后果不是"这条变异不准"，是"这条规格从此什么都没测"——
 * 本仓刚刚在别处付过这笔账（软链守卫在 Windows 上解析出一个幻影根，
 * 于是 `lstat` 全落空、包含性判断恒真：**守卫没有变红，它变成了恒真**）。
 *
 * 这一档只做字符串比对，**秒级**，因此可以随时跑、也可以进门禁。
 *
 * ## 它**不**回答什么
 *
 * 它只回答「锚点还在」，不回答「这条变异还抓得住」。
 * 后者仍然要跑完整的那一档 —— 别拿这一档的绿去替代它。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/mutation-check.mjs --anchors-only          # 秒级；改完被守护的文件先跑这个
 * ```
 *
 * ⚠️ 锚点钉的是**编译产物**（`dist/**` / `.test-out/**`），所以先 `pnpm build:safe`；
 * 也因此「按源文件名 grep 谁在钉我」这条纪律对它们无效 —— 你 grep `manager.ts`
 * 找不到，得 grep `manager.js`。这一档正是那条纪律的替代品：**改完直接问它。**
 */
if (argv.includes('--anchors-only')) {
  const bad = [];
  for (const m of selected) {
    const file = join(REPO, m.pkg, m.artifact);
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      bad.push(
        `${m.id}: 产物不存在 ${m.pkg}/${m.artifact} —— 先 pnpm build:safe` +
          `（web 还要 pnpm --filter @openmemo/web test:unit 编一次）`,
      );
      continue;
    }
    const hits = src.split(m.find).length - 1;
    if (hits === 1) {
      console.log(`  ✔ ${m.id}`);
    } else {
      console.log(`  ✘ ${m.id}  锚点出现 ${hits} 次（要求 1 次）`);
      bad.push(
        `${m.id}: 锚点在 ${m.pkg}/${m.artifact} 里出现 ${hits} 次（要求恰好 1 次）——\n` +
          `    这条规格现在**什么都没测**。请重新指锚点，别把它删掉。锚文本：\n` +
          `    ${JSON.stringify(m.find.slice(0, 90))}`,
      );
    }
  }
  if (bad.length > 0) {
    console.error(
      `\n✘ mutation-check --anchors-only：${bad.length}/${selected.length} 条锚点失效\n  ${bad.join('\n  ')}`,
    );
    console.error(
      '\n  ── 这条门禁在说什么 ─────────────────────────────────────────────────\n' +
        '  它只回答一个问题：**这些规格还指得到东西吗。**\n' +
        '  上面每一条 ✘ 都意味着那条规格现在**一次都没在测**（不是"测得不准"，是"没测"）。\n' +
        '  你多半是刚重构了被守护的那几个文件 —— 锚点钉的是**编译产物**里的源文本，\n' +
        '  所以「按源文件名 grep 谁在钉我」找不到它们（grep `manager.ts` 找不到，得 grep `manager.js`）。\n' +
        '\n' +
        '  修法：打开 scripts/mutation-check.mjs，把那几条的 `find` 重新指到改后的那段文本。\n' +
        '        **不要删规格** —— 删掉等于把那条不变量的守卫一起删了。\n' +
        '  改完先 `pnpm build:safe`，再跑 `node scripts/mutation-check.mjs --anchors-only`。\n' +
        '\n' +
        '  ⚠️ 这一档绿**不等于**规格还有牙齿。它证明的是"锚点还在"，\n' +
        '     "改坏了会不会红"要跑完整那一档：`node scripts/mutation-check.mjs`（几分钟，不在门禁里）。',
    );
    process.exit(1);
  }
  console.log(
    `\n✔ ${selected.length} 条锚点全部命中（各恰好 1 次）。\n` +
      '  ⚠️ 这只证明「锚点还指得到东西」，**不**证明「改坏了还会红」——\n' +
      '     后者要跑完整那一档：`node scripts/mutation-check.mjs`（几分钟，有意不在门禁里）。',
  );
  process.exit(0);
}

/**
 * 假 HOME —— **变异体是敌对代码，必须假设它会写机器级状态**。
 *
 * 这条是被真事逼出来的，记在这里：我给"指针位置可被覆盖"这条不变量加了一条变异
 * （把 `pointerFile()` 改回硬编码全局位置），跑完发现
 * **变异检查自己把用户的 `~/.local/share/openmemo/datadir.json` 写坏了** ——
 * 因为那条变异干的正是"让代码去写全局指针"，而测试随后就写了一个诱饵进去。
 *
 * 也就是说：**一个用来防止事故的工具，自己复现了那场事故。**
 * （已当场还原，并与开工备份逐字比对过。）
 *
 * 教训不是"这条变异不该加"，是**框错了威胁模型**：
 * 变异体按定义就是"被拿掉了某条安全性质的代码"，
 * 拿它当良民、只隔离产物目录是不够的 —— 还得隔离**它可能写到的机器级位置**。
 * 所以每个变异体都跑在一个假 HOME 里：`homedir()` / `XDG_DATA_HOME` 全部落进沙箱。
 *
 * 副作用是好的：那条变异**照样红**（测试断言"指针路径不许在 $HOME 底下"，
 * 假 HOME 也是 $HOME），但它再也够不到真实的那一份。
 */
function fakeHome(sandbox) {
  const h = join(sandbox, '.fake-home');
  mkdirSync(join(h, '.local', 'share'), { recursive: true });
  return h;
}

/** 在隔离副本里跑一组测试文件，返回退出码。 */
function runTests(sandbox, tests) {
  const home = fakeHome(sandbox);
  const r = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: sandbox,
    encoding: 'utf8',
    timeout: 300_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home, // Windows 上 os.homedir() 看这个
      XDG_DATA_HOME: join(home, '.local', 'share'),
    },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const sandboxes = new Map();
const created = [];
function sandboxFor(pkg) {
  if (sandboxes.has(pkg)) return sandboxes.get(pkg);
  const cfg = PACKAGES[pkg];
  if (!cfg) throw new Error(`未知的目标包：${pkg}`);
  const dir = mkdtempSync(join(tmpdir(), 'openmemo-mutation-'));
  created.push(dir);
  cpSync(join(REPO, pkg, cfg.artifactRoot), join(dir, cfg.artifactRoot), { recursive: true });
  symlinkSync(join(REPO, pkg, 'node_modules'), join(dir, 'node_modules'));
  cpSync(join(REPO, pkg, 'package.json'), join(dir, 'package.json'));
  sandboxes.set(pkg, dir);
  return dir;
}

const problems = [];
const results = [];
/**
 * 对照组结果，**按组缓存的是结论，不是"查过了"**。
 *
 * ★ 这里原本是 `const controlled = new Set()`，只记「这组查过没有」。
 * 于是对照组红掉时：**只有该组第一条**被记 `VOID`，`controlled.add()` 之后，
 * **同组其余各条直接跳过对照检查**，拿着一个本来就红的包去跑变异 ——
 * 而 `detected = code !== 0` 在一个本来就红的包上**恒真**，于是它们全被报成 `✔ 红`。
 *
 * 整轮仍然 exit 1（第一条已经进了 `problems`），所以不是静默通过；
 * **但逐条报告里会出现一片证明不了任何事的绿勾**，而逐条报告正是给人排查用的东西。
 * 这与本仓刚查出的那条同形：**判据没有变红，它变成了恒真。**
 *
 * 现在缓存 `true/false`：对照组没成立的组，**每一条都报 VOID，一个绿勾都不许有**。
 */
const controlOk = new Map();

for (const m of selected) {
  let sandbox;
  try {
    sandbox = sandboxFor(m.pkg);
  } catch (e) {
    problems.push(`${m.id}: ${String(e.message)}`);
    continue;
  }
  const target = join(sandbox, m.artifact);
  let pristine;
  try {
    pristine = readFileSync(target, 'utf8');
  } catch {
    problems.push(
      `${m.id}: 产物不存在 ${m.pkg}/${m.artifact} —— 先 pnpm build:safe（web 还要 pnpm --filter @openmemo/web test:unit 编一次）`,
    );
    continue;
  }

  // 对照组：变异之前，这组测试必须**本来就是绿的**。
  // 不做这一步的话，一个本来就红的产物会让每条变异都"被检测到"，
  // 存活率漂亮得不像话，而它什么都没证明。
  const controlKey = `${m.pkg}::${m.tests.join(',')}`;
  if (!controlOk.has(controlKey)) {
    const c = runTests(sandbox, m.tests);
    controlOk.set(controlKey, c.code === 0);
    if (c.code !== 0) {
      problems.push(
        `${m.id} 所在的组: **对照组就不是绿的**（未变异时 exit=${c.code}）—— 本组全部作废。\n` +
          `    先把 ${m.tests.join(' ')} 跑绿，再谈变异。\n` +
          c.out
            .split('\n')
            .filter((l) => l.includes('✖') || l.includes('Error'))
            .slice(0, 5)
            .map((l) => `    ${l}`)
            .join('\n'),
      );
    }
  }
  if (controlOk.get(controlKey) === false) {
    /*
     * ★ 同组的**每一条**都要落到这里，不只是第一条。
     * 在一个本来就红的包上跑变异，`detected` 恒真 —— 报出来的 `✔ 红` 证明不了任何事。
     */
    results.push({ id: m.id, status: 'VOID' });
    continue;
  }

  // 锚点必须唯一：找不到或找到多处，一律当错误停下来，绝不猜一个位置改下去。
  const hits = pristine.split(m.find).length - 1;
  if (hits !== 1) {
    problems.push(
      `${m.id}: 锚点在 ${m.pkg}/${m.artifact} 里出现 ${hits} 次（要求恰好 1 次）——\n` +
        `    代码动过了，请**重新指锚点**，别把这条删掉。锚文本：\n` +
        `    ${JSON.stringify(m.find.slice(0, 90))}`,
    );
    results.push({ id: m.id, status: 'ANCHOR' });
    continue;
  }

  writeFileSync(target, pristine.replace(m.find, m.replace));
  const r = runTests(sandbox, m.tests);
  writeFileSync(target, pristine);

  const detected = r.code !== 0;
  results.push({ id: m.id, status: detected ? 'RED' : 'SURVIVED', why: m.why });
  if (!detected) {
    problems.push(`${m.id}: **存活** —— 把这条行为整句改坏，测试依然全绿。\n    后果：${m.why}`);
  }
}

for (const d of created) rmSync(d, { recursive: true, force: true });

const red = results.filter((r) => r.status === 'RED').length;
const survived = results.filter((r) => r.status === 'SURVIVED').length;

console.log('');
for (const r of results) {
  const mark = { RED: '✔ 红', SURVIVED: '✘ 存活', ANCHOR: '⚠ 锚点失效', VOID: '⚠ 对照组不绿' }[
    r.status
  ];
  console.log(`  ${mark}  ${r.id}`);
}
console.log(`\n共 ${results.length} 条：${red} 条被测出，${survived} 条存活。`);

if (problems.length > 0) {
  console.error(`\n✘ mutation-check:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('✔ mutation-check: 每一条被守护的行为，改坏了都会红。');
