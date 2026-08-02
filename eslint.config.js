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
  {
    // 根 scripts/ 与各包自己的 scripts/（如 apps/daemon/scripts/）都是 Node 环境
    files: ['**/scripts/**/*.{js,mjs,cjs}', '**/*.config.{js,mjs,ts}'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  prettier,
);
