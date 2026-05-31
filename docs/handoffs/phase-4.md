# Phase 4 — Design Pass & Polish — Session Handoff

> Written 2026-05-31, cold-start context for the next session. Phase 3 is **shipped on
> `main`**. This is the entry point for Phase 4. Read this top-to-bottom before touching code.

## TL;DR — where things stand

- **Phase 3 is merged to `main`** (`139bc69`, pushed to `origin/main`). The full stack landed:
  **A persistence · B board actions · C′ port-detect→preview** + the 2026-05-31 bug-fix batch
  (14 user bugs + 4 e2e-caught regressions + 6 further chrome/preview/full-view fixes).
- All Phase 3 feature branches are **pruned** (local + remote): `phase-3-persistence`,
  `phase-3-board-actions`, `phase-3-slice-c`, `fix/phase-3-bugs`, `fix/bug-hunt-batch`.
- **Baseline green at merge:** `pnpm test` = **303 unit** · e2e harness **19/19 `ok:true`** ·
  `pnpm lint` + `pnpm typecheck` clean.
- **Phase 4 has not started.** No branch yet. Start by branching off `main`.

## Verify the baseline first (do this before any change)

```
pnpm install            # node_modules already has RTL+jsdom (added in Phase 3); safe to re-run
pnpm lint ; pnpm typecheck ; pnpm test          # expect clean + 303 passing
pnpm build
$env:CANVAS_SMOKE='e2e'; pnpm start              # expect E2E_DONE {ok:true}, 19 parts
```
**Gotchas (learned this session):**
- Kill stray `electron` processes first — a running instance locks `userData`
  (`cache: Access is denied`) and the harness fails spuriously:
  `Get-Process electron -EA SilentlyContinue | Stop-Process -Force`.
- **Known flaky e2e parts** (NOT regressions — environment/timing, rerun clean):
  `browser` (`empty=true`), `browser-gesture`, `focus-detach` (all "browser not live" — the live
  `WebContentsView` content/`capturePage` is timing-sensitive on first load), and occasionally
  `preview-edge-stale` (`no-edge`). If only these fail, kill electron, wait ~1s, rerun. If they
  persist across 2+ clean runs, it's real.
- Surface renderer console errors with `$env:ELECTRON_ENABLE_LOGGING='1'` (e.g. `Minified React #185`).

## The process rule (NON-NEGOTIABLE — memory `e2e-before-handoff`)

Every task/fix: **set goal → implement → run the FULL e2e harness in the live app → if anything
breaks, diagnose (read renderer console; baseline-compare) → iterate to production-green.**
Unit + typecheck + lint green is NOT proof the app works. For each fix, prefer a **negative
control**: revert just the fix, confirm the new e2e assertion fails, restore. (This session every
fix was negative-control-proven — see the Phase 3 bug-fix handoff for the pattern.)

Feature-shaped work follows the project cadence (memory `phase-3-slices`):
**brainstorm → spec (`docs/superpowers/specs/`) → plan (`docs/superpowers/plans/`) → execute
(subagent workflow) → e2e-verify → commit.** Phase 4 is mostly polish, so most items are direct
fixes, but the bigger ones (motion system, empty/loading/error state pass) deserve a quick spec.

## Phase 4 goal & scope (roadmap `docs/roadmap.md` › Phase 4)

> **Apply every DESIGN.md token, board-chrome rule, state, and motion spec
> (+ `prefers-reduced-motion`). Visual parity with the design frames; all states reachable and styled.**

The authoritative contract is **`design-reference/project/DESIGN.md`** (and the `*.jsx` visual
prototype — recreate the *look*, not the code). On conflict: **design wins on UX, this
brief/architecture wins on the stack** (we are React Flow + Electron `WebContentsView`, NOT
tldraw/iframe — DESIGN.md §10 is tldraw-era and must be mentally mapped to our stack).

### Acceptance for the phase
Visual parity with the design frames; every board/app state reachable and styled; motion spec
honored incl. `prefers-reduced-motion`; packaged-build CSP hardened; Geist fonts actually loaded.

## Concrete work checklist (with file pointers + acceptance)

Group the audit; each line is a candidate slice/commit. Verify each against DESIGN.md and e2e.

### A. Token / chrome parity audit (DESIGN.md §2–§6)
- Tokens live in **`src/renderer/src/index.css`** `:root` (mirror of DESIGN.md §2–4). Audit every
  token value against the tables (surfaces, borders, text, accent/status, radius `--r-board/-inner/-ctl/-pill`,
  elevation shadows, spacing scale). Confirm the **two and only two** shadows (board resting, popover) —
  no stray drop-shadows/glow (principle §1.3 "no slop").
- Board chrome geometry (§6): title bar 34px compact, glyph + type tag + title, the right-side
  actions→maximize→⋯ cluster. **Note:** this session reworked the title-bar right cluster + the ⋯
  trigger contrast (`src/renderer/src/canvas/BoardFrame.tsx`) — re-check it still matches §6 after
  any token change. States table (§6 "States"): resting/hover/selected/focused/full-view/LOD —
  verify each treatment (rings, `--accent-wash` tint, dim-others 55%).
- Per-type content/actions (§7): Terminal §7.1 (agent identity pill, run timer, mid-run rendering,
  progress sliver), Browser §7.2 (device frame, URL bar, viewport segmented control — already
  largely built), Planning §7.3 (notes/arrows/text/pen/checklist).
- Acceptance: side-by-side with `design-reference/project/*.jsx` frames; no token drift.

### B. Empty / loading / error states (DESIGN.md §8 "Empty project" + §7)
- **Empty project** (§8): `src/renderer/src/canvas/WelcomeScreen.tsx` exists (Phase 3 boot) — audit
  it against the spec: app-mark watermark, `h` "Empty canvas", one `body --text-3` line, three
  ghost-outline `+ Terminal / + Browser / + Planning` buttons, dock + top chrome still visible.
- Browser states (`src/renderer/src/canvas/boards/BrowserBoard.tsx` `DeviceContent`): connecting /
  load-failed / snapshot fallback — polish copy + visuals (Phase 2 shipped basic).
- Terminal idle/running/failed states; Planning empty board.
- Acceptance: every state reachable in the live app and styled; add e2e where structurally checkable.

### C. Motion pass (DESIGN.md §9) — likely its own small spec
- Camera: pan direct (1:1); **`fit` / `focus` animate 200ms `cubic-bezier(.2,.7,.2,1)`**.
  - 🐛 **Known bug to fix here** (`src/renderer/src/canvas/AppChrome.tsx`): `const FIT = { padding: 0.2, maxZoom: 1 }`
    passes **no `duration`** → `rf.fitView(FIT)` snaps instantly, violating §9. Siblings animate
    (`OVERVIEW = { ..., duration: 240 }`). Add `duration: 200` (and reconcile 200 vs the 240 used by
    overview — pick one curve/duration story consistent with §9). The `1` key fit path too.
- Board select ring `120ms ease-out`; handle fade `100ms`; terminal spinner 80ms/frame; caret blink
  1s; run progress sliver 1.2s linear loop (`.ca-progress-bar` in index.css).
- 🎬 **Deferred Full-view enter/exit animation** (cut from Phase 3 Slice B, noted in roadmap):
  `src/renderer/src/canvas/FullViewModal.tsx` opens/closes **instantly**. Add scrim fade-in +
  frame scale/opacity from the board's on-canvas rect (reverse on close). **Constraint:** a Browser
  board's native `WebContentsView` CANNOT be CSS-animated (OS layer) — animate the HTML scrim/frame;
  the native view snaps to final bounds (or carries the transition via its snapshot). See the
  full-view machinery in `BrowserPreviewLayer.tsx` (`fullViewBoundsFor`, the full-view rAF pump).
- **`prefers-reduced-motion`** (§9): only partially handled today (`index.css:183` drops some loops).
  Audit ALL motion: drop spinner→static glyph, no progress loop, no camera ease. Wrap new motion in
  the media query.
- Acceptance: each motion matches §9 timing; reduced-motion path verified.

### D. Fonts (roadmap: "Load Geist / Geist Mono")
- `index.css` declares `--ui: 'Geist', system-ui…` and `--mono: 'Geist Mono', …` but there is **no
  `@font-face`** — Geist is NOT actually bundled, so it falls back to system-ui today. Add the font
  files (self-hosted, `font-src 'self'` already in CSP) + `@font-face`. Keep the fallback stack.
- Acceptance: Geist renders in the packaged build (no network fetch — CSP forbids).

### E. CSP hardening (roadmap; packaged build)
- `src/renderer/index.html` ships a dev CSP with `'unsafe-inline'` for script + style. Phase 4:
  **nonce-based policy, drop `unsafe-inline`** for the packaged build (dev can keep its looser CSP).
  Vite emits inline scripts/styles — wire a nonce (electron-vite/CSP plugin) or hash-allowlist.
  Never weaken `contextIsolation`/`sandbox`/`nodeIntegration` (CLAUDE.md security rules).
- Acceptance: packaged renderer loads with no `unsafe-inline`; no CSP console violations.

### F. Renderer code-split (roadmap)
- Lazy-load heavy deps where sensible: `@xterm/*`, `@xyflow/react`. Current renderer bundle is
  ~1.28 MB (one chunk — see the build output). Use dynamic `import()` / `React.lazy` behind board
  type so a project with no terminal doesn't pay xterm cost up front.
- Acceptance: smaller initial chunk; no functional regression (e2e green).

## DESIGN.md → code map (where each section lives)

| DESIGN.md | Code |
|---|---|
| §2 tokens, §3 type, §4 radius/elevation | `src/renderer/src/index.css` `:root` |
| §5 canvas (grid, camera, pan/zoom) | `src/renderer/src/canvas/Canvas.tsx`, `lib/cameraBounds.ts`, `lib/canvasView.ts` |
| §6 board chrome (title bar, states, LOD) | `src/renderer/src/canvas/BoardFrame.tsx`, `BoardNode.tsx` |
| §6.1 full view & duplicate | `FullViewModal.tsx`, `canvas/boardActions.ts`, `fullViewContext.ts`, store `duplicateBoard` |
| §7.1 Terminal | `canvas/boards/TerminalBoard.tsx`, `TerminalConfig.tsx`, `store/terminalRuntimeStore.ts`, main `pty.ts` |
| §7.2 Browser | `canvas/boards/BrowserBoard.tsx`, `BrowserPreviewLayer.tsx`, `lib/browserLayout.ts`, main `preview.ts`, `portDetect.ts` |
| §7.3 Planning | `canvas/boards/PlanningBoard.tsx`, `planning/ChecklistCard.tsx`, `lib/pen.ts` |
| §8 app chrome (switcher, camera cluster, dock, minimap) | `canvas/AppChrome.tsx`, `WelcomeScreen.tsx` |
| §8 empty project | `WelcomeScreen.tsx` |
| §9 motion | `AppChrome.tsx` (camera), `index.css` (rings/loops/`prefers-reduced-motion`), `FullViewModal.tsx` |
| preview-link edges (Slice C′) | `lib/previewEdges.ts`, `canvas/edges/PreviewEdge.tsx`, `lib/previewTarget.ts` |

## Repo orientation (key facts)

- **Stack:** Electron 33 + TS + React 18, electron-vite. Canvas = `@xyflow/react` v12 (custom nodes).
  Terminal = `@xterm/xterm` ⇄ `node-pty` (MAIN only). Browser = native `WebContentsView` (NOT iframe).
  State = Zustand; persistence = `canvas.json` per project (schema **v2**). See CLAUDE.md for the
  locked decisions and the security model (never weaken `contextIsolation`/`sandbox`/`nodeIntegration`).
- **Repo path has a space** (`Z:\Canvas ADE`) → `node-pty` MUST stay winpty-free (the pinned beta).
- **e2e harness:** `src/main/e2eSmoke.ts` (19 parts, drives the renderer via `window.__canvasE2E`).
  Host hooks in `src/renderer/src/smoke/e2eHooks.ts` (`seedBoard`, `patchBoard`, `fitView`, `setZoom`,
  `panBy`, `setFullView`, `setFocus`, `setTerminalDown`, `duplicateBoard`, `deleteBoard`, …).
  Main-side debug helpers: `debugTerminalPid` (`pty.ts`), `debugCaptureView`/`debugViewIds` (`preview.ts`).
  Unit tests = vitest; `.test.tsx` run on jsdom (RTL), `.test.ts` on node (`vitest.config.ts`
  `environmentMatchGlobs`).
- **Commands:** `pnpm dev` (HMR) · `pnpm build` · `pnpm typecheck` · `pnpm test` · `pnpm pack:dir`.
  Headless smoke: `$env:CANVAS_SMOKE='exit'; pnpm start`. HTML shot (DOM only, NOT native view):
  `$env:CANVAS_SHOT='C:\tmp\x.png'; pnpm start`.

## Still-open from earlier phases (fold in or keep deferred)

- **Stage-2 Playwright `_electron` harness** (Phase 2 follow-up, memory `self-smoke-test-plan`):
  a real Playwright driver + MAIN-side per-view `capturePage`. The `CANVAS_SMOKE=e2e` harness is the
  current stand-in. Still deferred unless Phase 4 needs pixel diffs for visual parity.
- **Full-view enter/exit animation** — folded into Phase 4 §C above (was the explicit Slice B deferral).
- **Agentic session resume** (roadmap note) — deferred, not Phase 4.
- **Feature Workspaces / git worktrees** — deferred post-MCP (memory `feature-workspaces-vision`).
- The Phase 2 "`connected`-on-dead-URL Browser bug" is now covered by the `browser-deadurl` e2e
  (refused URL → `load-failed`); consider it closed unless it resurfaces.

## Suggested ordering for the next session

1. Verify baseline (commands above) — confirm 303 + 19/19 (mind the browser-live flake).
2. Branch off `main` (e.g. `phase-4-design-pass`).
3. **Quick wins first** (low-risk, high-visibility, each negative-control + e2e where checkable):
   the `fit` 200ms animation bug (§C), token audit diffs (§A), `prefers-reduced-motion` completeness (§C).
4. **Fonts (§D)** + **empty/loading/error pass (§B)** — visible parity wins.
5. **Full-view enter/exit motion (§C)** — needs care around the native `WebContentsView` constraint;
   write a short spec.
6. **CSP nonce (§E)** + **code-split (§F)** — packaging-adjacent; verify the packaged build
   (`pnpm pack:dir`) + e2e.
7. End each slice runnable + committed; full e2e green before handoff.

## Reference

- Authoritative design: `design-reference/project/DESIGN.md` (+ `*.jsx` frames, `chats/chat1.md` intent).
- Roadmap: `docs/roadmap.md` › Phase 4 (and the inline 🎬/🐛 notes).
- Phase 3 bug-fix handoff (process + negative-control pattern, the 6 chrome/preview fixes):
  `docs/handoffs/2026-05-31-phase-3-bug-fixes-handoff.md`.
- Phase 3 slice C′ handoff: `docs/handoffs/phase-3-slice-c.md`. Status archive: `status-archive.md`.
