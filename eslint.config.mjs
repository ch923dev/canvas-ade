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
      // electron-builder alternate output dirs + pruned electronDist copies: a RUNNING
      // installed Expanse instance watching the repo permanently locks fresh .asar files
      // (Electron asar-fs handle cache), so packaged-validation runs pack into fresh
      // `release-*` dirs from a `spike-*`/pruned dist copy that can't always be deleted
      // afterward (still locked). Same class of local-only build output as release/.
      'release-*/**',
      'spike-*/**',
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
      // Per-project Canvas-ADE runtime data (ADR 0009): canvas.json/assets + scratch in
      // .canvas/tmp/ (one-off .mjs shot scripts etc.). Gitignored runtime state, hidden from
      // the File Tree and already prettier-ignored — not project source.
      '.canvas/**',
      // Session worktrees checked out inside the repo dir (parallel-session
      // convention) — each is its own lint root; linting them from main trips
      // tsconfigRootDir ambiguity and double-lints in-flight branches.
      '.worktrees/**',
      // Agent tooling — workflow scripts run with injected globals (phase/agent/…),
      // not lintable as standalone modules; not project source.
      '.agents/**',
      // Supabase backend (Phase 1 accounts) — Deno Edge Functions + SQL migrations are a separate
      // runtime (Deno globals, https:// URL imports), not part of the Electron app's TS project.
      // Keep the app's eslint/tsconfig out of it; the function is deployed by the Supabase CLI.
      'supabase/**',
      // Vendored third-party source kept verbatim (ADR 0001 — perfect-freehand).
      'src/vendor/**',
      // Diagram render-worker assets (S4): the vendored Mermaid bundle + the static worker
      // HTML/bridge are loaded by Electron at runtime, NOT part of the app source graph (the
      // bridge runs as a plain browser <script> with window/mermaid globals, not a module).
      'resources/diagram-worker/**',
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

  // Token-drift guard (STYLE-02, PA-R — the final Post-Audit-Polish slice) — surfaces raw style
  // literals in renderer COMPONENTS that bypass the design tokens, so a token change actually
  // propagates instead of leaving hard-coded copies behind. WARN-ONLY by design: PA-R owns only this
  // file, so it cannot clean the literals it finds (each lives in another slice's zone). Warn surfaces
  // them without failing the gate (`eslint .` exits 0 on warnings); the ratchet to `error` happens
  // file-by-file as a file's literals migrate to var(--token). See docs/reviews/2026-06-19-feature-audit.md.
  //
  // SCOPE — high-signal token drift, the case where propagation actually breaks:
  //  • raw COLOR literals (hex + rgb/rgba). Change --accent and a hard-coded `#4f8cff` goes stale —
  //    this is the drift that bites, so it is flagged everywhere in renderer .tsx.
  //  • raw px/%/em-STRING fontSize/borderRadius (e.g. `fontSize: '14px'`) — an explicit CSS unit when
  //    a --fs-*/--r-* token exists.
  // Deliberately NOT flagged — bare NUMERIC fontSize/borderRadius (e.g. `fontSize: 11`). The audit's
  // raw count is ~210, it is a pervasive ACCEPTED pattern (used in fresh design-reviewed code), the
  // fs/radius tokens change rarely (low propagation risk), and ~half the hits are in `boards/command/**`
  // — the Command Board, which the 2026-06-19 audit EXPLICITLY EXCLUDED from scope. Flagging all of
  // them would bury the lint's signal for near-zero benefit; the numeric ratchet is a documented
  // follow-up (flip on a `[value>=0]` selector once the fs/radius literals are migrated).
  //
  // .tsx only (the component layer): xterm's numeric `fontSize` is a genuine library API in a `.ts`
  // hook (an expression, not a literal — doubly excluded), and `.ts` theme modules (CodeMirror,
  // Mermaid, planning text tokens) legitimately use concrete values for worker / 3rd-party contexts
  // that cannot read CSS vars. Matching on `Literal` (never expressions) keeps false positives near zero.
  {
    files: ['src/renderer/**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          // Raw px/%/em string fontSize / borderRadius (e.g. `fontSize: '14px'`). `var(--fs-meta)`
          // is a string Literal that does NOT start with a digit, so it passes.
          selector: 'Property[key.name=/^(fontSize|borderRadius)$/] > Literal[value=/^[0-9.]/]',
          message:
            'Token drift (STYLE-02): use a CSS var for fontSize/borderRadius (--fs-* / --r-*), not a raw px/%/em string, so design-token changes propagate.'
        },
        {
          // Raw hex color literals (#rgb / #rgba / #rrggbb / #rrggbbaa) — use the color tokens.
          selector: 'Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
          message:
            'Token drift (STYLE-02): use a color token (var(--accent) / --text-* / --surface / …), not a raw hex literal.'
        },
        {
          // Raw rgb()/rgba() color literals — use the color tokens (e.g. var(--accent-wash)).
          selector: 'Literal[value=/^rgba?\\(/]',
          message: 'Token drift (STYLE-02): use a color token, not a raw rgb()/rgba() literal.'
        }
      ]
    }
  },

  // File-size ratchet — caps new source at 700 CODE lines (blanks + comments skipped, so dense
  // documentation is never penalised) and freezes today's code-heavy files at pinned counts. Pins
  // are edited DOWNWARD only: lower a file's pin in the same PR that shrinks it; delete the entry
  // once it drops under 700. Tests are exempt (large test files are healthy). The three pins below
  // are the only source files whose CODE-line count currently exceeds 700 (measured 2026-06-09);
  // every other file — incl. the comment-dense pty.ts/mcpOrchestrator.ts/canvasStore.ts — is
  // already under the global cap, which guards it against future growth.
  // See docs/contributing/file-size-doctrine.md.
  {
    files: ['src/**/*.{ts,tsx}'],
    // `smoke/e2eHooks.ts` is the Playwright `_electron` test harness (installed only under isE2E) —
    // test infrastructure, exempt like `*.test.ts` per the "tests are exempt" rule above (its name
    // just doesn't match the test glob). Additive probe surfaces (e.g. setOsrAlive) grow it healthily.
    ignores: ['**/*.test.{ts,tsx}', '**/*.integration.test.{ts,tsx}', '**/smoke/e2eHooks.ts'],
    rules: { 'max-lines': ['error', { max: 700, skipBlankLines: true, skipComments: true }] }
  },
  {
    files: ['src/main/pty.ts'],
    // M9 review fix (perf-polish): the teardown-side micro-batch drain (drainBatch + the
    // flushData threading across SessionLike/ParkedLike) must live at the session-lifecycle
    // choke points (cleanupCore/parkCore/adoptCore) beside the maps and identity guards they
    // protect — extracting them would split one lifecycle invariant across files. Pinned at
    // the post-fix count; ratchet DOWNWARD when pty.ts is next split.
    // 706→696 (terminal-copy fix): the spawn-env build + recap-provider try/catch extracted to
    // ptySpawnEnv.ts (buildSpawnEnv) — ratcheted down per the rule above.
    // 696→700 (cross-cwd recap capture): the one-line syncRecapHook(...) call must fire at the
    // spawn choke point, and the one-line maybeEnsureClaudeHook(...) probe must sit in the
    // onData handler beside the pasteMode observer it mirrors (+ its import). The seams
    // themselves live in ptySpawnEnv.ts / claudeBootDetect.ts. Ratchet DOWNWARD on next split.
    // 700→702 (T1d flicker-free): the one-line flickerFree: isFlickerFree() read must fire at the
    // buildSpawnEnv choke point (+ its import). The store lives in terminalDisplayConfig.ts.
    rules: { 'max-lines': ['error', { max: 702, skipBlankLines: true, skipComments: true }] }
  },
  {
    files: ['src/main/index.ts'],
    // 700→702 (PR-2 background sessions): the whole feature lives in its own modules
    // (backgroundSessionsBoot / closeGuard / trayResidency), but its four wiring lines are
    // choke points that can only live here — attachCloseGuard(mainWindow) inside createWindow
    // (must re-arm on every window (re)creation incl. tray reopen), the one-call
    // wireBackgroundSessionsUx boot (replaces the old wireLifecycleNotifications line), the
    // isTrayResident() guard merged into the existing window-all-closed quit condition, and
    // the two import lines. Ratchet DOWNWARD when index.ts is next split.
    // 702→704 (T1d flicker-free): the one-line registerTerminalDisplayHandlers(...) wiring must
    // sit beside the other terminal handlers (+ its import). Store lives in terminalDisplayConfig.ts.
    // 704→707 (Phase 2 voice cloud STT): the safeStorage encryptor moved above registerVoiceHandlers
    // and its now-3-line deps arg ({ encryptor, getProjectDir }) is the cloud-selection key gate.
    rules: { 'max-lines': ['error', { max: 707, skipBlankLines: true, skipComments: true }] }
  },
  {
    files: ['src/renderer/src/canvas/boards/TerminalBoard.tsx'],
    // PA-9/TERM-07 ratcheted 631→627 (extracted the context-menu builder, run-timer and
    // interrupt-feedback into boards/terminal/*). Pins move DOWNWARD only.
    rules: { 'max-lines': ['error', { max: 627, skipBlankLines: true, skipComments: true }] }
  },
  {
    files: ['src/renderer/src/canvas/Canvas.tsx'],
    // 764→765 (M8, perf-polish): the digestOpen gate + last-digest fallback state must live in
    // CanvasInner next to the digestOpen/digestProjectKey render-adjust block it extends.
    // 765→766 (terminal-copy fix): `selectionKeyCode={null}` is a <ReactFlow> prop — it can
    // only live on the element in CanvasInner.
    // 766→767 (kanban axis-picker, review fix): addCentered must pass `configPending` for a kanban
    // so the palette/empty-state create paths reach the New Kanban dialog — one hoisted `at` local.
    // Ratchet DOWNWARD when Canvas.tsx is next split.
    rules: { 'max-lines': ['error', { max: 767, skipBlankLines: true, skipComments: true }] }
  },
  {
    files: ['src/renderer/src/canvas/boards/PlanningBoard.tsx'],
    rules: { 'max-lines': ['error', { max: 666, skipBlankLines: true, skipComments: true }] }
  },
  {
    files: ['src/renderer/src/store/canvasStore.ts'],
    // #BUG-006 + #BUG-007 both land here and both bind to the module-PRIVATE pendingCheckpoint
    // machinery. BUG-006: the four untracked layout writers (growBoard*/reposition/setDiagramCache)
    // must rewrite an armed gesture checkpoint or a later undo silently reverts them. BUG-007:
    // pendingCheckpoint is scoped per-gesture (a `pendingCheckpoints` stack via rewritePendingBoards)
    // so an interloping beginChange() can't swallow another gesture's checkpoint. Neither can be
    // extracted to a sibling without exposing that private state. Pinned at the post-fix count;
    // ratchet DOWNWARD when the store is next split. See docs/contributing/file-size-doctrine.md.
    // 720→725 (M1): the session-sidecar merge threads through applyLoadedDoc + applyOpenResult (the
    // doc-apply choke points that must live here, beside the load-epoch/pendingCheckpoint machinery).
    // 725→727 (v19 kanban card-detail): two CanvasState members — the ephemeral `pendingFileFocus`
    // field + the `openFileRef` signature — must live in the store's own state type (a slice implements
    // openFileRef but cannot declare it); both are single lines, so the cap moves by exactly two.
    rules: { 'max-lines': ['error', { max: 727, skipBlankLines: true, skipComments: true }] }
  },

  // Disable all formatting rules that would conflict with Prettier. MUST be last.
  eslintConfigPrettier
)
