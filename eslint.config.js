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
  {
    files: ['scripts/**/*.{js,mjs}', '*.config.{js,mjs,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  prettier,
);
