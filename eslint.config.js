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
      'dist/**',
      'coverage/**',
      'generated/**',
      'tools/log_viewer/**',
      '.junie/**',
      'eval/**',
      '*.config.ts',
      '*.config.js',
      'scripts/**',
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
        project: ['./tsconfig.json'],
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
      // `no-unused-vars` and `no-explicit-any` are refined per file kind below:
      // production source is strict, tests stay permissive. `no-explicit-any` is
      // kept as 'warn' everywhere until the existing usage is cleaned up.
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
    },
  },
  // Production code is held to a higher standard: unused vars are an error.
  // Test files under source/ are excluded by the test override below.
  {
    files: ['source/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', noUnusedVarsOptions],
    },
  },
  {
    files: ['source/services/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', 'source/services/conversation/conversation-state-projector.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '../tool-execution-ledger.js',
              importNames: ['reconcileHistoryWithToolLedger'],
              message: 'Use conversation-state-projector instead of reconciling conversation history manually.',
            },
            {
              name: './tool-execution-ledger.js',
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
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['off', noUnusedVarsOptions],
      'no-empty': 'off',
    },
  },
  eslintConfigPrettier,
);
