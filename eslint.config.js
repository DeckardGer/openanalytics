import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const TYPED_SOURCES = ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts', 'tests/**/*.ts']

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      // Claude Code drops temporary agent worktrees here; they are full repo
      // checkouts, and linting them doubles every finding.
      '.claude/**',
      'packages/contracts/src/generated/**',
      // Minified tracker bundle: build output, measured by scripts/build-tracker.mjs.
      'apps/tracker/bundle/**',
      'docs/snapshot/**',
      // apps/web is a Next.js app with its own eslint-config-next setup
      // (apps/web/eslint.config.mjs), linted via `pnpm --filter web lint`.
      // The backend ruleset (no-console, restricted `process`) does not apply
      // to browser/Next code.
      'apps/web/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Rules that need no type information, so they also cover config and scripts.
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // `any` erases exactly the contract guarantees this codebase depends on.
      '@typescript-eslint/no-explicit-any': 'error',

      // Structured logging only: docs snapshot 02 §26.
      'no-console': 'error',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message:
            'Read configuration through loadServiceEnv() so the secret boundary is enforced.',
        },
      ],
    },
  },

  {
    // Type-aware linting. Restricted to workspace sources because the rules need
    // a TypeScript program, which config and script files are not part of.
    files: TYPED_SOURCES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A floating promise in the ingest path silently drops work; the queue and
      // manifest guarantees assume every async step is awaited.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },

  {
    // Bootstrap, CLI and config files legitimately read the raw environment and
    // write to stdio before a logger exists.
    files: [
      'apps/*/src/bootstrap.ts',
      // The CLI is a command-line program: it reads its own environment, writes
      // to stdio, and shells out to the platform's ACL tool. It has no logger
      // and no service env to read through, which is what this exemption is for.
      'apps/cli/src/**/*.ts',
      'apps/*/src/main.ts',
      'packages/*/src/cli.ts',
      'packages/domain/src/policy.ts',
      'packages/domain/src/analytics-query.ts',
      'packages/domain/src/session.ts',
      'packages/domain/src/public-dashboard.ts',
      'packages/domain/src/widget-range.ts',
      'packages/domain/src/read-key.ts',
      'packages/domain/src/read-cost.ts',
      'packages/domain/src/assistant.ts',
      'packages/domain/src/env.ts',
      // The cloud surface's own config loaders, exempt for the reason every entry
      // above is: a loader is where `process.env` is *read once* and validated, and
      // the boundary this rule protects is enforced by `loadServiceEnv` calling
      // into these schemas at boot.
      'packages/domain/src/cloud/env.ts',
      'packages/domain/src/cloud/notify-forms.ts',
      'packages/observability/src/logger.ts',
      // One-shot operator tooling, .mjs and .ts alike: a proof script reads
      // its own env knobs and prints to the operator, not to a logger.
      'scripts/**/*.mjs',
      'scripts/**/*.ts',
      'eslint.config.js',
      'vitest.config.ts',
    ],
    rules: {
      'no-restricted-globals': 'off',
      'no-console': 'off',
    },
  },

  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
)
