// Lint configuration (flat config). ESLint is a devDependency only: nothing that ships inside the app depends on it.
import js from '@eslint/js';
import globals from 'globals';
import codexmods from './scripts/lint/rules.mjs';

export default [
  {
    ignores: ['design/**', '.tmp/**', 'node_modules/**', 'contracts/upstream/**', 'adapters/**/*.json'],
  },
  js.configs.recommended,
  {
    rules: {
      // Best-effort cleanup is idiomatic here: `catch (e) {}` and `catch (e) { return fallback; }` ignore the error on purpose.
      // `const { dropped, ...rest } = obj` is the idiom for omitting properties.
      // Other unused bindings are real findings; a leading underscore marks one that is kept for its position.
      'no-unused-vars': ['error', { caughtErrors: 'none', ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Path and id validators reject control characters (NUL, C0) on purpose.
      'no-control-regex': 'off',
    },
  },
  {
    // Default: ES modules on Node 24.
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // CommonJS: the loader, framework-main and the diagnostic prelude run as CJS inside the app.
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.commonjs },
    },
  },
  {
    // QA-only diagnostic prelude: the builder substitutes these placeholders before it is prepended to the loader.
    files: ['scripts/qa/diag/prelude.cjs'],
    languageOptions: {
      globals: { __DIAG_FULL__: 'readonly', __DIAG_CONTROL__: 'readonly', __TAP_SOURCE__: 'readonly' },
    },
  },
  {
    // Page main world: the renderer runtime and mod renderer entries use browser APIs.
    files: ['framework/renderer/**/*.mjs', 'mods/*/renderer.mjs', 'sdk/templates/*/renderer.mjs'],
    ignores: ['**/*.test.mjs', 'framework/renderer/test/**'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // The preload runs in Electron's preload realm: browser globals plus Node's `require`/`process`.
    files: ['framework/preload/**/*.cjs'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.commonjs },
    },
  },
  {
    // Shared surfaces render the concept (docs/design/graph-integrity.md G2.4): which provider an instance comes from never decides what
    // they offer. Code that addresses the app's own objects names the object in its disable comment; a comparison left for GI2b says so.
    files: ['framework/renderer/present/**/*.mjs', 'framework/host/graph/providers/windows/**/*.mjs', 'framework/shared/**/*.mjs'],
    ignores: ['**/*.test.mjs', '**/test/**'],
    plugins: { codexmods },
    rules: { 'codexmods/no-provider-identity': 'error' },
  },
  {
    // Tests run under node:test; renderer tests also exercise browser-shaped code through shims.
    files: ['**/*.test.mjs', '**/test/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
