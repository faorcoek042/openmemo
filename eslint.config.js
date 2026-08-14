// ESLint flat config（ESLint 10）。刻意保持精简 —— 只装护栏，不做风格独裁。
// 风格交给 Prettier；eslint-config-prettier 负责关掉所有会打架的规则。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    // 第三方源码与产物一律不 lint
    ignores: [
      'vendor/**',
      '**/dist/**',
      '**/dist-types/**',
      '**/build/**',
      // CMake / 原生编译产物（gpu-runtime 的 .build/ 里有名为 *.ts 的 CMake 依赖文件，
      // 它们不是 TypeScript，会让 parser 直接炸）
      '.build/**',
      '**/.build/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // 测试编译产物（apps/web 的两条测试道各自的输出）。
      // 不能放 dist/（主构建 emptyOutDir 会清空）也不能放 node_modules/（node --test 跳过该目录）。
      '**/.test-out/**',
      // shadcn/ui 复制源码（ADR-002 决策 2 豁免），保持与上游一致
      'apps/web/src/components/ui/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  // ───────────────────────────────────────────────────────────────────────────
  // 前端分层护栏（D-05 §3.5，ADR-007 采纳为全项目沿用条款）。
  // 由 `architect` 在 T-021 落地；改动前请在 inbox 申报（SHARED-CHANGE:）。
  //
  // 为什么需要机器强制而不是写在文档里靠自觉：
  // 横向依赖（features/A 直接 import features/B）是"三个人并行开发 → 一周后合不进去"
  // 的最常见死法。禁止它之后，复用只能走"提升到 components/common + 申报"，
  // 于是写冲突在结构上就不成立了。
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ['apps/web/src/features/*/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 精确匹配"跳到兄弟 feature"的相对路径：`../<名字>/…`。
              // 负向先行 (?!\.) 把 `../../lib/…`、`../../components/…` 排除在外 ——
              // 它们是允许的向下依赖，只有同级的 `../别的feature/` 才是横向依赖。
              regex: '^\\.\\./(?!\\.)[^/]+/',
              message:
                'features/A 不得 import features/B（D-05 §3.5）。需要复用请把组件"提升"到 ' +
                'components/common/，并在 coordination/inbox/<你>.md 写 SHARED-CHANGE: 申报。',
            },
          ],
        },
      ],
    },
  },
  {
    // 共享层不得反向依赖业务层，否则 components/ui 无法独立预览、lib 无法单测。
    files: ['apps/web/src/{lib,components}/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/features/**'],
              message:
                'lib/ 与 components/ 不得依赖 features/（D-05 §3.5）。依赖方向只能是 features → lib/components。',
            },
          ],
        },
      ],
    },
  },
  {
    // 例外：bindings.ts 与 routes.tsx 的**职责就是聚合 feature 的分片导出**（D-05 §3.4）。
    // 这正是把冲突热点变成"只在新增 feature 时才动一行"的手法，必须放行。
    files: ['apps/web/src/lib/events/bindings.ts', 'apps/web/src/routes.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // ───────────────────────────────────────────────────────────────────────────
  // D-01 §8.4 L1「子进程只从一个出口出去」—— T-153 补上的机器执行者。
  //
  // ⚠️ 这条规则**此前不存在**，而 `D-01:1061`、`docs/SECURITY.md:109`、`D-06:330`
  // 三份文档都声称它是「CI 强制的架构点」。三份互相交叉引用，读起来像被三处证实，
  // 实际上一处都没有。补规则的同时那三处文档已改成如实（见 D-01 §8.4）。
  //
  // ── 三条必须一起读的边界 ──────────────────────────────────────────────────
  //
  // ① **必须带白名单，否则是一盏假红灯。** `packages/runtime` 那三处**架构上修不了**：
  //    `pipeline` 依赖 `runtime`，反过来不行，所以它们用不了 `runner.ts`。
  //    假红灯会训练人忽略告警（HANDOFF ⑤B），和假绿灯一样要当 bug 修。
  //
  // ② **它拦不住动态 import。** `packages/downloader/scripts/verify-offline.mjs:640`
  //    是 `await import('node:child_process')` —— 静态规则对它无能为力。
  //    这一点被 `childProcessAllowlist.test.ts` 显式钉住（一条断言专门证明"这里拦不住"），
  //    免得下一个人因为"有规则了"再把文档写回"已强制"。
  //
  // ③ **范围只到产品源码**（`apps/*/src/**` 与 `packages/*/src/**`）。
  //    `scripts/**` 与 `verify-*.mjs` 是构建/验证工具，不随产品分发，
  //    它们 spawn 的是我们自己钉死的命令，不接触用户输入 —— 把它们一起禁掉
  //    只会逼出 12 条 eslint-disable 注释，而那等于没有规则。
  //    同理排除 `*.test.ts` / `__tests__/**`：测试要起子进程来**证明**这条规则生效
  //    （`packages/pipeline/src/subprocess/__tests__/childProcessAllowlist.test.ts`
  //    真的 spawn 一次 eslint），把它们一起禁掉就是让守卫无法存在。
  //    这也与三份文档里「产品代码 7 处（排除 scripts/tests）」那个口径对齐。
  //
  // ⚠️ **`apps/web/**` 刻意不在范围内**，原因是机制而不是偏好：flat config 里
  //    同名规则是**整体覆盖**不是合并，把 web 一起圈进来会让这一块把上面两条
  //    前端分层护栏（features/A ↮ features/B、lib/components ↮ features）悄悄吃掉。
  //    web 是浏览器包，`node:child_process` 在那里会被 vite 当场打断，不需要这条。
  //    ★ 守卫测试里有一条专门断言那两条前端护栏**仍然会报错**。
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ['apps/daemon/src/**/*.{ts,tsx,mts,cts}', 'packages/*/src/**/*.{ts,tsx,mts,cts}'],
    ignores: ['**/*.test.{ts,tsx,mts,cts}', '**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:child_process',
              message:
                '子进程只能从 packages/pipeline/src/subprocess/runner.ts 出去（D-01 §8.4 L1）。' +
                '那里集中了 shell:false、argv 不变量、env 白名单重建、超时与进程组回收。' +
                '确有架构原因绕不开的，请加进 eslint.config.js 的白名单并写清性质 —— ' +
                '不要就地 eslint-disable（那会让例外从此不可清点）。',
            },
            {
              name: 'child_process',
              message:
                '同上；另外请用 `node:` 前缀写法（裸 `child_process` 可被同名 npm 包顶掉）。',
            },
          ],
        },
      ],
    },
  },
  {
    /*
     * L1 白名单 —— **7 处，逐条定性**（`[实测]` AST 剥注释后全仓扫描，2026-08-06）。
     *
     * | 文件 | 性质 |
     * |---|---|
     * | `pipeline/src/subprocess/runner.ts` | ✅ 权威出口本身 |
     * | `pipeline/src/asr/whisperServer.ts` | ⚠️ 违反本包自己的不变量（长驻服务 vs run-to-completion）；已 import runner 的 `buildChildEnv` 并传 `shell:false`。**债还在** |
     * | `apps/daemon/src/main.ts`           | detached 自重启，runner 没有对应能力 —— 合理例外 |
     * | `apps/daemon/src/bootstrap/tls.ts`  | 启动时 `execFileSync('openssl')`，同步/异步差异让复用别扭 |
     * | `runtime/src/probe/runProbe.ts`     | ⚠️ **架构上修不了**：pipeline → runtime 单向依赖 |
     * | `runtime/src/detect/system.ts`      | 同上 |
     * | `runtime/src/selfTest.ts`           | 同上 |
     *
     * 这张表就是这条规则的全部例外。**改它必须同时改 D-01 §8.4 的同一张表** ——
     * 守卫测试会断言"能通过 lint 的文件集合"恰好是这 7 个，多一个少一个都红。
     */
    files: [
      'packages/pipeline/src/subprocess/runner.ts',
      'packages/pipeline/src/asr/whisperServer.ts',
      'apps/daemon/src/main.ts',
      'apps/daemon/src/bootstrap/tls.ts',
      'packages/runtime/src/probe/runProbe.ts',
      'packages/runtime/src/detect/system.ts',
      'packages/runtime/src/selfTest.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // 根 scripts/ 与各包自己的 scripts/（如 apps/daemon/scripts/）都是 Node 环境
    files: ['**/scripts/**/*.{js,mjs,cjs}', '**/*.config.{js,mjs,ts}'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  // ───────────────────────────────────────────────────────────────────────────
  // #111 ①：`host: <某个 URL>.host` —— 让这个形状写不出来
  //
  // 这条规则存在的理由不是"有人粗心"，而是**这个错误的反馈信号在生产输入上
  // 恒为零**：`URL.host` 含端口，而 `http.request({host})` 是一个真实、文档化的
  // 选项，所以 `host: u.host` 类型对、lint 干净、代码评审看不出、
  // 并且对**每一个默认端口的 URL 都正常工作**。它只在带端口的地址上炸，
  // 而仓库里真实的清单地址一个带端口的都没有。
  //
  // 于是它被独立写出来了**两次**：
  //   · `scripts/ci/probe-mirror.mjs::probeUrl`  —— #108 被桩上游抓到（run 31695269578，12 条里红 7 条）
  //   · `scripts/ci/check-release-refs.mjs::probe` —— #111，潜伏至今，从没红过
  // 两次都是"从旁边那份抄过来"。靠纪律避免注定失败：**在人会看的每一个位置上，
  // 错的那版和对的那版长得一模一样。**
  //
  // 正确写法（`probe-mirror.mjs` 里那份，有 `selftest-probe-mirror.mjs` 守着）：
  //     hostname: u.hostname,
  //     port: u.port || (u.protocol === 'https:' ? 443 : 80),
  //
  // ⚠️ 选择器刻意只认**两侧都是 `host`** 的那一种：`host: <expr>.host`。
  //    `[实测]` 全仓扫描（2026-08-14）下当前零命中 —— `host: u.hostname`、
  //    `host: HOST`、`host: '127.0.0.1'`、`host: deps.host()` 都不匹配，
  //    `parsed.host.toLowerCase() !== host`（auth.ts 的同源校验，那里**就该**带端口）
  //    是 BinaryExpression 也不匹配。也就是说它今天不误伤任何一处，
  //    而下一次有人写出这个形状时当场红。
  //
  // ⚠️ 用 `no-restricted-syntax`（本仓此前未使用过的规则名）而不是往上面那两块里加 ——
  //    flat config 同名规则是**整体覆盖**不是合并，复用 `no-restricted-imports`
  //    会把前端分层护栏和 child_process 闸门悄悄吃掉（第 133 行那段说的就是这件事）。
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Property[key.name='host'][value.type='MemberExpression'][value.property.name='host']",
          message:
            '`URL.host` **含端口**，而 `http/https.request({ host })` 不接受 "主机:端口" —— ' +
            '带端口的地址会变成"去解析一个叫 `127.0.0.1:41273` 的主机名"，一个请求都发不出去。' +
            '改成 `hostname: u.hostname` + `port: u.port || (u.protocol === "https:" ? 443 : 80)`，' +
            '并且请求函数要按 `u.protocol` 在 node:http / node:https 之间选。' +
            '更好的做法是别再写第三份：`scripts/ci/probe-mirror.mjs` 的 `probeUrl()` / `probeFollow()` ' +
            '已经是对的，而且有 `selftest-probe-mirror.mjs`（绑 :0 的桩上游）守着。' +
            '（这个形状已经被独立写出来过两次：#108、#111）',
        },
      ],
    },
  },
  prettier,
);
