// @ts-check
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  // Global ignores (object with only `ignores` = replaces .eslintignore).
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      // Generated Playwright e2e artifacts (gitignored): the HTML report bundles
      // minified vendor JS and `test-results/` holds traces/screenshots. eslint 10
      // dropped `.eslintignore`, so they must be listed here or `pnpm lint` reports
      // thousands of errors in generated files after any e2e run (local-only — a clean
      // CI checkout has neither dir).
      'playwright-report/**',
      'test-results/**',
      'design-reference/**',
      // Harness-managed agent worktrees (each carries its own out/ build bundle).
      '.claude/**',
      // Session worktrees checked out inside the repo dir (parallel-session
      // convention) — each is its own lint root; linting them from main trips
      // tsconfigRootDir ambiguity and double-lints in-flight branches.
      '.worktrees/**',
      // Agent tooling — workflow scripts run with injected globals (phase/agent/…),
      // not lintable as standalone modules; not project source.
      '.agents/**',
      // Vendored third-party source kept verbatim (ADR 0001 — perfect-freehand).
      'src/vendor/**',
      // Shipped hook scripts: plain CommonJS .js files run standalone under node
      // (no build step, no bundler). ESLint's no-undef / no-require-imports do not
      // apply to these — they use globals (require, process) that are valid at runtime.
      'src/main/hooks/**',
      // Tooling configs are authored loosely and don't benefit from TS linting.
      '**/*.config.{js,cjs,mjs,ts,mts}',
      'eslint.config.mjs'
    ]
  },

  // Base JS + non-type-checked TypeScript recommended (fast; no projectService).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Defaults for every linted TS/TSX file.
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    rules: {
      // Mirror tsconfig noUnusedLocals/Params, but allow intentional _-prefixed
      // throwaways (used across main: `(_e, _lvl, message)`, `(_req, res)`).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none'
        }
      ]
    }
  },

  // Main + preload run in Node/Electron-main: Node globals, console allowed.
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      'no-console': 'off'
    }
  },

  // Renderer: browser globals, React Hooks + Fast Refresh, console discouraged.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    languageOptions: {
      globals: { ...globals.browser }
    },
    rules: {
      // react-hooks v7 flat preset (rules-of-hooks + exhaustive-deps).
      ...reactHooks.configs.flat['recommended-latest'].rules,
      // react-refresh, Vite preset — warn so default-exported components
      // (App.tsx, smoke/*) don't error the build; still flags real breakers.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // App.tsx uses `// eslint-disable-next-line no-console` for its one log;
      // keep that disable meaningful by flagging stray console in the renderer.
      'no-console': 'warn',
      // SECURITY INVARIANT (sandboxed renderer): the renderer runs with
      // contextIsolation/sandbox and must NEVER import Node built-ins, native, or
      // main-only modules — those live in src/main and reach the renderer only via
      // the preload contextBridge. `patterns` covers both bare (`fs`) and
      // `node:`-prefixed (`node:fs`) specifiers in one shot; `paths` bans the
      // specific main-only packages (incl. `electron`, which the renderer must
      // never import directly — use the preload bridge). NOT applied to
      // src/main/** or src/preload/** (those legitimately use Node).
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'fs',
                'fs/*',
                'path',
                'os',
                'child_process',
                'crypto',
                'net',
                'http',
                'https',
                'stream',
                'worker_threads',
                'node:*'
              ],
              message:
                'Renderer is sandboxed — use the preload contextBridge, not Node/native modules (security invariant).'
            }
          ],
          paths: [
            {
              name: 'electron',
              message:
                'Renderer must not import electron directly — use the preload contextBridge (security invariant).'
            },
            {
              name: 'node-pty',
              message:
                'node-pty is MAIN-only — the renderer reaches the PTY via the preload bridge (security invariant).'
            },
            {
              name: 'simple-git',
              message:
                'simple-git is MAIN-only — the renderer must not run git (security invariant).'
            },
            {
              name: 'write-file-atomic',
              message:
                'write-file-atomic is MAIN-only filesystem access — not allowed in the sandboxed renderer (security invariant).'
            }
          ]
        }
      ]
    }
  },

  // Playwright e2e harness (root-level `e2e/`). Mixed renderer/main world: it
  // evaluates source strings in the page (`eval`), bridges MAIN registry calls
  // (`any`), and uses Playwright's empty-pattern fixture signature `({}, use)`.
  {
    files: ['e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      'no-eval': 'off',
      'no-empty-pattern': 'off',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },

  // e2e fixture scripts (`.mjs`) run standalone under Node (e.g. as a launchCommand
  // child) — plain ESM modules with Node globals (process/setInterval/fs).
  {
    files: ['e2e/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node }
    }
  },

  // Build/test tooling in `scripts/` runs standalone under Node — the pre-push
  // hook invokes `e2e-scope.mjs` directly. Plain ESM modules with Node globals.
  {
    files: ['scripts/**/*.{mjs,ts}'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node }
    }
  },

  // File-size ratchet — caps new source at 700 CODE lines (blanks + comments skipped, so dense
  // documentation is never penalised) and freezes today's code-heavy files at pinned counts. Pins
  // are edited DOWNWARD only: lower a file's pin in the same PR that shrinks it; delete the entry
  // once it drops under 700. Tests are exempt (large test files are healthy). The three pins below
  // are the only source files whose CODE-line count currently exceeds 700 (measured 2026-06-09);
  // every other file — incl. the comment-dense pty.ts/mcpOrchestrator.ts/usePreviewManager.ts/
  // canvasStore.ts — is already under the global cap, which guards it against future growth.
  // See docs/contributing/file-size-doctrine.md.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/*.integration.test.{ts,tsx}'],
    rules: { 'max-lines': ['error', { max: 700, skipBlankLines: true, skipComments: true }] }
  },
  {
    files: ['src/renderer/src/canvas/boards/TerminalBoard.tsx'],
    rules: { 'max-lines': ['error', { max: 631, skipBlankLines: true, skipComments: true }] }
  },
  {
    files: ['src/renderer/src/canvas/Canvas.tsx'],
    rules: { 'max-lines': ['error', { max: 779, skipBlankLines: true, skipComments: true }] }
  },
  {
    files: ['src/renderer/src/canvas/boards/PlanningBoard.tsx'],
    rules: { 'max-lines': ['error', { max: 666, skipBlankLines: true, skipComments: true }] }
  },

  // Disable all formatting rules that would conflict with Prettier. MUST be last.
  eslintConfigPrettier
)
