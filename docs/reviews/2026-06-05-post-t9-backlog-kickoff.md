# Kickoff — `main` backlog after #53 + T9 (2026-06-05, later)

**For:** the next session(s) on the Canvas ADE / Expanse `main` backlog.
**Read first:** `.claude/coordination/ACTIVE-WORK.md` (live board — has the full #53 + T9 banners) +
the source reports `docs/reviews/2026-06-04-CONSOLIDATED-backlog.md`,
`docs/reviews/2026-06-04-main-branch-full-audit.md`. Supersedes
`docs/reviews/2026-06-05-remaining-backlog-kickoff.md` (Task 0 / #53 + Task 1 / T9 are now DONE).

---

## Where things stand — `main` @ `1b1dee7`

Shipped to `main` since the last kickoff:
- **PR #53 (`8d65f41`)** — Waves 0 (data-loss recovery) + 2 pt1 (SCA + runtime hardening) + 4
  (reliability) + repo-wide `pnpm format` + a real **corrupt-doc-recovery e2e** (`e2e/recovery.e2e.ts`)
  + `createNavGuard` unit coverage.
- **PR #59 / T9 (`1b1dee7`)** — **Electron 33 → 42** (off EOL) + toolchain (**vite 5→7 · electron-vite
  2→5 · plugin-react 4→5 · vitest 2→4**, clears the critical vitest UI-server CVE) + **tar ≥7.5.8**
  (pnpm override) + **SCA gate flipped HARD** (`pnpm audit --audit-level=high` blocks in `pr.yml`).
- Already on `main` before that: Phases 0–4 + layout presets, MCP M0–M4 (#43), Context subsystem (#39)
  + context-followup (#44).

**Tree health:** full gate + e2e matrix (Win-native + Linux-Docker, 23/23 each) green on the post-T9
tree; `pnpm audit --audit-level=high` = exit 0 (1 moderate PostCSS, below the gate).

## Environment / CI facts (NOT blockers anymore — but know them)

- **GitHub Actions billing is UNBLOCKED** and CI is **token-wired** (`3f0bc7b` added `NODE_AUTH_TOKEN` +
  `packages: read` to `pr.yml`/`staging.yml` so CI resolves the private `@ch923dev/canvas-ade-mcp` dep).
  PRs CI-verify + merge normally now. The CI `check` job runs on **ubuntu-latest**.
- **Provisioned local gate recipe** (when you need the FULL `typecheck`/`build`/`test:e2e:matrix`, which a
  junctioned worktree can't run): in the worktree, drop the junction (`rm node_modules` — it's a symlink),
  then `NODE_AUTH_TOKEN=$(gh auth token) pnpm install` (the gh keyring token has `read:packages`). node-pty
  auto-rebuilds; `pnpm test:e2e:matrix` needs Docker (present). Tear down with
  `git worktree remove --force` (the de-junctioned `node_modules` is a real dir, removed with the worktree).
- **⚠️ Windows build prereq (since Electron 42):** node-pty source-compiles on the Electron-42 ABI (no
  prebuilt) and its `binding.gyp` sets `SpectreMitigation:'Spectre'` → the **MSVC x64/x86 Spectre-mitigated
  libs** VS component must be installed (it is, on this dev box). CI `check`=ubuntu is unaffected; the
  Windows leg of the 6-target packaging matrix (Phase 5) + any other Windows build env will need it.
  Documented in CLAUDE.md (Stack + env).

---

## Remaining backlog (priority order)

### Task A — Wave-4 remainder (quick; Low/Info) — START HERE
The 5 items deferred from Wave 4 because they overlapped #53's files (now landed). All Low/Info,
file-disjoint-ish, TDD + vitest-verified. **Re-confirm `file:line` on the post-T9 tree** (line numbers
predate #53 + T9). From `docs/reviews/2026-06-04-CONSOLIDATED-backlog.md`:

| Finding | Sev | File | Fix |
|---|---|---|---|
| `bak-rotation-non-atomic-copy` | Low | `src/main/projectStore.ts` (writeProject .bak copy) | `copyFileSync`→.bak is non-atomic (torn .bak on a mid-copy crash). Atomic write/rename. Keep consistent with Wave-0's `readBak`/quarantine. |
| `project-current-readproject-swallow` | Low | `src/main/projectIpc.ts` (`project:current`) | A `readProject` failure on auto-reopen is swallowed → silent. Surface/log it. |
| `project-current-skips-unsafe-dir-guard` | Info | `src/main/projectIpc.ts` (`project:current`) | Add the `isUnsafeProjectDir` guard `project:open` has, for consistency. |
| `project-switcher-no-outside-close` | Low | `src/renderer/src/canvas/AppChrome.tsx` (ProjectSwitcher) | Add the outside-pointerdown/Escape/resize close effect (like BoardMenu/TidyMenu), gated on `open`. |
| `before-quit-flush-no-catch` | Info | `src/main/index.ts` (before-quit) | Add `.catch` so a flush rejection still runs `shutdown()`/`app.exit`. |

### Task B — Wave 5 (maintainability / perf / CSP / test debt)
Heavily overlaps core files (Canvas.tsx, PlanningBoard.tsx, index.ts, preview.ts, pty.ts, projectIpc.ts).
God-file splits **need e2e** (now runnable via the provisioned recipe). Sub-areas (consolidated backlog):
- **CSP / secure-defaults**: tighten prod CSP in `src/renderer/index.html` (drop `'unsafe-inline'` where
  possible; add `object-src 'none'; base-uri 'self'; frame-ancestors 'none'`). Pin
  `webSecurity`/`allowRunningInsecureContent`/`experimentalFeatures` in `windowSecurity.ts` with tests.
  Lowest-collision if index.html-only.
- **`foreign-sender-guard-triplicated`**: hoist ONE shared `isForeignSender`/`ipcGuard.ts` (copy-pasted in
  `projectIpc.ts`/`preview.ts`/`pty.ts` + 3 near-identical test suites). High value (security guard).
- **Test gaps**: extract + unit-test quit/flush/crash orchestration (`index.ts`), preview wiring,
  `pty:spawn` options, preload MessagePort re-post, `enumerateShells`.
- **God-file splits** (e2e-verify): `BrowserPreviewLayer.tsx` (→ `PreviewManager`), `PlanningBoard.tsx`
  (→ `usePlanningPointer`), `Canvas.tsx` (→ `useFullView`/`useTidyTile`/`useCanvasKeybindings`).
- **Perf**: narrow the `BrowserPreviewLayer` store subscription to the `boards` slice; memoize
  `onnodeschange`/`nodes`/`fitToBoards` allocations in `Canvas.tsx`.
- **Accept/document-as-is** (Info, annotate near code): `pty-launchcommand-trusted-autoexec`,
  `tolerated-phantom-undo-step`, `module-lastrecorded-shared-singleton`, `fresh-doc-stale-schemaversion`,
  `navigate-blocked-scheme-no-bounds-resync`, `skiplibcheck-everywhere`, `measured-ref-not-pruned`,
  `iconbtn-dead-longpress-timer`, `node-pty-pinned-beta`.

### Task C — branch / coordination hygiene
- **~16 stale `fix/*` locals** (Hunt-B, squash-merged via #45/#47/#48 + the 3 #53-superseded waves):
  `fix/BUG-001…`, `fix/BUG-002…`, `fix/bughunt-{highs,lows,mediums}`, `fix/l-{infra,llmipc,mcp,summary}`,
  `fix/m-{ctx,llm,mcp}-cluster`, `fix/mediums-to-main`, `fix/load-cascade`, `fix/runtime-supply-chain`,
  `fix/wave4-reliability`. **Verify each is content-in-`main` before deleting** (squash-merge breaks
  ancestry → `git branch --merged` won't show them; diff the branch's net change vs main).
- `chore/adopt-mcp-0.8.2-relay-binding` — check if still needed (MCP pkg adoption).
- Trim done rows on `.claude/coordination/ACTIVE-WORK.md`.

### Task D — Dependabot npm-registry creds (follow-up from T9)
`dependabot.yml` (Wave-2) → the **npm** ecosystem Dependabot runs FAIL on `main` (no creds for the private
`@ch923dev/canvas-ade-mcp` GH-Packages registry). Add a `registries:` block + a `DEPENDABOT_*` PAT secret
(read:packages) referenced from the npm `updates` entry, OR scope dependabot to non-private deps. The
github-actions ecosystem works (PRs #54–58 are its open bumps — review/merge separately). NOT a code
regression. Memory `dependabot-private-registry-fail`.

### Task E — Phase 5 (packaging / signing) — de-risked by T9
CI matrix is unsigned until Phase 5. `pack:dir` works on electron-builder 26 / Electron 42 (node-pty
asarUnpacked verified). Remaining: code-signing + notarize + the electron-updater feed; auto-update e2e
coverage (deferred — needs packaging/electron-updater). The Windows leg needs the Spectre VC component.

### Longer-term (unchanged)
- **`canvas-ade-mcp` M5** (Barriers + event-driven attention) — branch off current `main`; memory
  `canvas-ade-mcp`. Then post-MCP **Feature Workspaces / worktrees** (FW-1).
- **Rebrand #17 (`chore/rebrand-expanse`) — MERGES LAST** (memory `rebrand-expanse`; ~2 cross-zone
  one-liners, will need a rebase onto post-T9 main).
- Research-only PRs: #29 (Maestri), #27 (demo-video), #25 (SaaS).

## Working rules (don't re-decide)
- App fixes on a `fix/*` **worktree off `main`** via `.claude/tools/new-worktree.ps1`. `main` =
  integration-only. Merge sequentially; re-run the gate after EACH merge (CI is a real green gate now).
- Subagent-driven (TDD + per-task spec+quality review) is the cadence. **Real coverage, not replica
  tests** (a Wave-4 review caught false-green replicas). Workflow subagents: sonnet for mechanical, opus
  for integration/security/judgment; never haiku.
- The full `typecheck`/`build`/`test:e2e:matrix` needs the provisioned token'd env (recipe above);
  junctioned worktrees run vitest + lint + web/preload typecheck only (commit `--no-verify`).
- Durable cross-feature contract changes (CLAUDE.md, ADRs) land WITH their feature's PR (or directly on
  main if standalone).
