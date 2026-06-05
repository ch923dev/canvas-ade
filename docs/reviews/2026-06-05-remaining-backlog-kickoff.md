# Kickoff — Remaining `main` Backlog (post-Wave-0/2/4)

**Date:** 2026-06-05 · **For:** the next session(s) picking up the Canvas ADE / Expanse `main` backlog.
**Read first:** `.claude/coordination/ACTIVE-WORK.md` (live board, SessionStart-injected) + the source reports
`docs/reviews/2026-06-04-CONSOLIDATED-backlog.md`, `docs/reviews/2026-06-04-main-branch-full-audit.md`,
`docs/reviews/2026-06-04-mcp-context-bughunt/`.

---

## Where things stand (2026-06-05)

- **Hunt B (Waves 1 + 3)** — LLM-egress SSRF, MCP `configureBoard` confirm, all 28 MCP/Context cards — **already on `main`** (#45/#47/#48/#49).
- **PR #53 `fix/waves-0-2-4`** — **OPEN, the one to merge.** Consolidates Wave 0 (data-loss load-cascade), Wave 2 pt1 (SCA + runtime security hardening, minus the Electron bump), and the Wave 4 independent subset (silent-failure/reliability). Merged conflict-free off `main 8a41a5d`. **Gate-green locally**: 1192 unit+int · lint · web+preload typecheck · format:check on changed files · node-typecheck only the pre-existing MCP `TS2307`. PRs #50/#51/#52 were closed as superseded (their branches `fix/load-cascade`, `fix/runtime-supply-chain`, `fix/wave4-reliability` are kept).

### ⛔ The blocker that gates EVERYTHING
**GitHub Actions is billing-blocked** — every PR `check` job fails in ~2s (*"recent account payments have failed or your spending limit needs to be increased"*). So **no PR (incl. #53) can CI-verify or merge** until the user either:
1. fixes Actions billing, OR
2. runs the gate in a **token'd local checkout** (where `pnpm install` resolves the private `@expanse-ade/mcp` GitHub-Packages dep via `NODE_AUTH_TOKEN`), then `pnpm typecheck && pnpm build && pnpm test:e2e:matrix`.

Until then: local junctioned worktrees can run **vitest + lint + web/preload typecheck** (real), but **NOT** full `typecheck` (node leg), `build`, or the e2e matrix (the junctioned `node_modules` lacks the private MCP dep → `mcpSmoke.ts` won't resolve). Commit with `--no-verify` (the pre-commit e2e matrix can't build). This is an env limit, not a regression. See memory `ci-green-2026-06-02` (updated with the billing note) + `mcp-publish-gating`.

---

## Task 0 — Merge PR #53 (do first, once unblocked)
**Needs the billing/token unblock above.** Steps:
1. In a provisioned checkout (token'd): rebase/confirm `fix/waves-0-2-4` on current `main`, run the **full gate + e2e matrix** green.
2. Add an **e2e probe** for the two surfaces this batch couldn't unit-cover: (a) corrupt-`canvas.json` recovery shows the recovery card / WelcomeScreen error (not a black screen); (b) the packaged `file://` nav pin still allows the app's own `location.reload()` (Wave 0 recovery button) while blocking other `file:` URLs. Also worth: Wave-4 #22/#23 (camera-fullview chaining, snap-suppress blur) which were deferred to e2e.
3. Merge #53 → `main`. Per CLAUDE.md sequential-merge: re-run the full gate + e2e after the merge.
4. Then tear down the 4 wave worktrees (`canvas-ade-load-cascade`, `-runtime-supply-chain`, `-wave4-reliability`, `-waves-integration`) via `.claude/tools/remove-worktree.ps1` and delete their branches.
5. ⚠️ A repo-wide `pnpm format` is owed: `src/main/llmIpc.ts` + `src/main/mcpOrchestrator.test.ts` carry pre-existing prettier drift on `main` that fails `format:check` (NOT from these waves). Fold it into Task 0 or a tiny standalone PR so CI `format:check` goes green.

---

## Task 1 — T9: Electron 33 → 42 (EOL) — the de-facto release blocker
**Plan already written:** `docs/superpowers/plans/2026-06-04-electron-bump-t9.md` (committed on the #53 branch; if #53 not yet merged, read it from there). **PREPARED, NOT EXECUTED** — needs a provisioned env (token'd install + node-pty native ABI rebuild + build + e2e). Target **Electron 42** (40/41/42 supported as of June 2026; 39- EOL). Includes **vitest 2→4** (critical CVE) + **tar ≥7.5** (×7 high). The gating risk is the **node-pty ABI** rebuild vs Electron 42 (the repo pins `node-pty 1.2.0-beta.13` winpty-free because the path `Z:\Canvas ADE` has a space; [node-pty #728](https://github.com/microsoft/node-pty/issues/728)). Branch `fix/electron-bump` off `main` AFTER #53 lands so the SCA `pnpm audit` step (now non-blocking with a `TODO(T9)`) can be flipped to a **hard gate** once the tree is clean. Pairs with Phase 5 packaging/signing.

---

## Task 2 — Wave 4 remainder (the items that overlapped #50/#51, deferred)
Do AFTER #53 merges (these touch files #53 changed). All Low/Info, file-disjoint-ish, TDD, verify via vitest. Re-confirm `file:line` on the post-merge tree (the audit's line numbers predate the waves).

| Finding | Sev | File (audit line) | Fix |
|---|---|---|---|
| `bak-rotation-non-atomic-copy` | Low | `src/main/projectStore.ts` (writeProject .bak copy) | `copyFileSync` of the prior good `canvas.json`→`.bak` is non-atomic (a crash mid-copy can leave a torn `.bak`). Use an atomic write/rename for the rotation. Note Wave 0 already added `readBak`/quarantine here — keep consistent. |
| `project-current-readproject-swallow` | Low | `src/main/projectIpc.ts` (`project:current`) | A `readProject` failure on auto-reopen is swallowed → silent. Surface it (return the error / log) so a failed reopen isn't invisible. |
| `project-current-skips-unsafe-dir-guard` | Info | `src/main/projectIpc.ts` (`project:current`) | `project:current` doesn't run `isUnsafeProjectDir` like `project:open` does. Add the guard for consistency. |
| `project-switcher-no-outside-close` | Low | `src/renderer/src/canvas/AppChrome.tsx` (ProjectSwitcher) | Dropdown has no outside-pointerdown/Escape/resize close effect (unlike BoardMenu/TidyMenu). Add the same close effect gated on `open`. |
| `before-quit-flush-no-catch` | Info | `src/main/index.ts` (before-quit) | The flush/quit chain has no `.catch` — a flush rejection could skip teardown. Add a catch so `shutdown()`/`app.exit` still run. (Related: `index-quit-shutdown-untested` in Task 3.) |

---

## Task 3 — Wave 5 (maintainability / perf / CSP / test debt) — no rush, post-#53
**Heavily overlaps the core files the waves touched** (Canvas.tsx, PlanningBoard.tsx, index.ts, preview.ts, pty.ts, projectIpc.ts) — **do AFTER #53 + Task 2 land** or you'll fight merge conflicts. Sub-areas (from the consolidated backlog):

- **CSP / secure-defaults** (`prod-csp-style-unsafe-inline`, `implicit-secure-defaults-not-pinned`): tighten the prod CSP in `src/renderer/index.html` (`content="…"` line 16) — drop `'unsafe-inline'` where possible; add `object-src 'none'; base-uri 'self'; frame-ancestors 'none'`. Pin `webSecurity`/`allowRunningInsecureContent`/`experimentalFeatures` explicitly in `buildMainWindowWebPreferences` (`src/main/windowSecurity.ts`) with tests. **Lowest-collision Wave-5 item if CSP is index.html-only.**
- **`foreign-sender-guard-triplicated`**: hoist ONE shared `isForeignSender`/`ipcGuard.ts` (currently copy-pasted in `projectIpc.ts`/`preview.ts`/`pty.ts` with 3 near-identical test suites). High value (a security guard), but spans all 3 wave files → do after #53.
- **Test gaps** (silent regressions): extract + unit-test the quit/flush/crash orchestration (`index-quit-shutdown-untested`, `src/main/index.ts:164-242`); preview wiring; `pty:spawn` options; preload MessagePort re-post; `enumerateShells`.
- **God-file splits** (risky without e2e — do once billing/e2e is back): `BrowserPreviewLayer.tsx` (982 LOC → extract a `PreviewManager` class), `PlanningBoard.tsx` (1188 → `usePlanningPointer`), `Canvas.tsx` (857 → `useFullView`/`useTidyTile`/`useCanvasKeybindings`). These rewrite the exact preview/whiteboard sync paths — **must** be e2e-verified.
- **Perf**: `previewlayer-reconcile-on-every-viewport-frame` (narrow the `BrowserPreviewLayer` store subscription to the `boards` slice — see `BrowserPreviewLayer.tsx:878` `useCanvasStore.subscribe`); `onnodeschange-perframe-snap-allocation` + `nodes-memo-data-object-churn` + `fittoboards-repeated-minmax-spread` (all `Canvas.tsx`, precompute/memoize). `BrowserPreviewLayer` perf is the only Wave-5 item NOT colliding with #53's files.
- **Accept/document-as-is** (Info, annotate the invariant near the code, no behaviour change): `pty-launchcommand-trusted-autoexec`, `tolerated-phantom-undo-step`, `module-lastrecorded-shared-singleton`, `fresh-doc-stale-schemaversion`, `navigate-blocked-scheme-no-bounds-resync`, `skiplibcheck-everywhere`, `measured-ref-not-pruned`, `iconbtn-dead-longpress-timer`, `node-pty-pinned-beta`.

---

## Task 4 — Branch / coordination hygiene (quick, anytime)
- After #53 merges: delete the 4 wave branches (local + remote) + tear down their worktrees.
- Prune the ~13 stale `fix/*` locals from Hunt B (squash-merged via #45/#47/#48 — `fix/BUG-001…`, `fix/m-*`, `fix/l-*`, `fix/bughunt-*`, `fix/mediums-to-main`). Verify each is content-in-`main` before deleting (squash-merge breaks ancestry, so `git branch --merged` won't show them — diff against main).
- Trim the closed/done rows on `.claude/coordination/ACTIVE-WORK.md`.

## Working rules (don't re-decide)
- App fixes on a `fix/*` **worktree off `main`** via `.claude/tools/new-worktree.ps1` (junctions node_modules). `main` = integration-only.
- Subagent-driven (TDD + per-task spec+quality review) is the established cadence — see how Waves 0/2/4 were built.
- Verify real coverage, not replicas (a Wave-4 review caught false-green replica tests — extract used helpers like `isValidResize`/`cameraShortcut.ts`/`terminalPreview.ts`).
- Workflow subagents: sonnet for mechanical, opus for integration/security/judgment; never haiku.
