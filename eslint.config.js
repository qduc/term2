import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import hooksPlugin from 'eslint-plugin-react-hooks';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Shared options for unused-variable detection. The `_` prefix is the agreed
 * convention for intentionally unused args, vars, and caught errors.
 */
const noUnusedVarsOptions = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
};

export default tseslint.config(
  {
    // Global ignores must be in their own object without other keys
    ignores: [
      'dist.bak',
      'dist.bak/**',
      'dist/**',
      'coverage/**',
      'generated/**',
      'docs/**/*.ts',
      'tools/log_viewer/**',
      '.junie/**',
      'eval/**',
      '*.config.ts',
      '*.config.js',
      'scripts/**',
      '.worktrees/**',
      '.claude/worktrees/**',
      'website/**',
      'packages/wire/**',
      // Standalone Next.js app with its own toolchain and tsconfig; root
      // project-aware linting does not apply to it.
      'web-client/**',
      // Build and check tooling, like scripts/ above; src is linted.
      'bench/**',
      'parity/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': hooksPlugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./tsconfig.json', './packages/core/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...hooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off', // Not needed for React 17+ / React 19
      'react/prop-types': 'off', // Not needed for TypeScript
      'react/no-unescaped-entities': 'off', // Allowed for CLI terminal literal text rendering

      // Downgrade rules to 'warn' or disable them to avoid failing linting on pre-existing code.
      // `no-unused-vars` and `no-explicit-any` are refined per file kind below.
      // Explicit `any` remains disabled by default; the late module-scoped ratchet
      // below enables it only for production modules that have been cleaned up.
      '@typescript-eslint/no-unused-vars': ['warn', noUnusedVarsOptions],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      'no-control-regex': 'off', // Allowed for CLI terminal escape sequences
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      'no-empty': 'warn',
      'require-yield': 'warn',
      'no-prototype-builtins': 'warn',
      'no-case-declarations': 'warn',

      // Strict React hooks and purity rule overrides for Ink CLI & testing harness pattern support
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/globals': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
  // Production code is held to a higher standard: unused vars are an error.
  // Test files are excluded by the test override below.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', noUnusedVarsOptions],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/session/conversation/conversation-state-projector.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tool-execution-ledger.js'],
              importNames: ['reconcileHistoryWithToolLedger'],
              message: 'Use conversation-state-projector instead of reconciling conversation history manually.',
            },
          ],
        },
      ],
    },
  },
  // Tests often need mocks, stubs, and partially implemented interfaces, so
  // unused vars stay as a warning here (overriding the production error).
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', 'tests/cli/cli.integration.scenarios.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['off', noUnusedVarsOptions],
      'no-empty': 'off',
    },
  },
  // WS11 ratchet: only cleaned production modules are currently protected.
  // Keep this list file-scoped so untouched production code and tests remain
  // permissive until their explicit-any cleanup is complete.
  {
    files: [
      'src/model/providers/ai-sdk-message-normalizer.ts',
      'src/model/providers/ai-sdk-streamed-model.ts',
      'src/model/providers/provider-service.ts',
      'src/session/session/post-execute-pause-capability.ts',
      'src/config/settings/custom-provider-normalization.ts',
      'src/config/settings/settings-env.ts',
      'src/config/settings/settings-merger.ts',
      'src/config/settings/settings-persistence.ts',
      'src/tools/agent/ask-orchestrator.ts',
      'src/tools/file/glob.ts',
      'src/tools/file/grep.ts',
      'src/tools/run-agent-workflow.ts',
      'src/tools/system/shell.ts',
      'src/tools/types.ts',
      'src/shared/utils/shell/command-safety/find-helpers.ts',
      'src/shared/utils/shell/command-safety/index.ts',
      'src/shared/utils/shell/command-safety/utils.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // `.cts` files are CommonJS by contract (worker preloads loaded by `require`),
  // so `require()` is the only import form available to them.
  {
    files: ['**/*.cts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  eslintConfigPrettier,
);
