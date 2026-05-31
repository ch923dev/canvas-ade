# Phase 4 — Design Pass & Polish — Plan

> Written 2026-05-31. Baseline verified green: lint + typecheck clean, 303 unit, e2e 19/19
> `ok:true`. Branch off `main` → `phase-4-design-pass`. One branch, slice-per-commit. Each slice:
> implement → **Workflow** (DESIGN.md parity audit agents + full e2e harness + negative-control any
> new assertion) → commit. Process rule (`e2e-before-handoff`): unit/typecheck green ≠ working app.

Authoritative contract: `design-reference/project/DESIGN.md`. On conflict design wins on UX, brief
wins on stack (React Flow + Electron `WebContentsView`, NOT tldraw §10).

## Verification model (every slice)

A per-slice `Workflow` fans out:
1. **Parity agents** — read the slice's DESIGN.md section(s) + the touched files, report any token/
   geometry/state/motion drift (structured findings).
2. **e2e** — run the full 19-part harness in the live app; require `E2E_DONE {ok:true}`.
3. **Negative-control** — for any NEW e2e assertion: revert just the fix, confirm the new assertion
   fails, restore. Proves the assertion has teeth.

Known e2e flakes (rerun clean, not regressions): `browser`, `browser-gesture`, `focus-detach`,
occasionally `preview-edge-stale`. Kill stray electron before each run (`userData` lock).

## Slices (ordered — quick/high-visibility first)

### Slice 1 — Motion quick-wins + motion-token reconcile (§C, §9)
- **🐛 `AppChrome.tsx:16`** `FIT = { padding: 0.2, maxZoom: 1 }` → add `duration: 200`,
  `cubic-bezier(.2,.7,.2,1)` (React Flow fitView opts: `duration` + the easing via `ease`/CSS).
  §9: `fit`/`focus` animate `200ms`. Reconcile the `1`-key fit path and `0`-key reset path. Decide
  one curve/duration story: §9 names only fit/focus@200ms — set fit+focus+reset to 200ms; `overview`
  currently 240ms → align to 200ms unless we keep it deliberately distinct (note the decision).
- **Token drift fixes** (`index.css`): progress sliver `1.25s`→`1.2s` (§9); caret blink `1.05s`→`1s`
  step (§9); `ca-caret-run` reconcile.
- **`prefers-reduced-motion` completeness** (§9): audit ALL motion — spinner→static glyph, no
  progress loop, no camera ease. Wrap camera fit `duration` behind a reduced-motion check (0 when
  reduced). Today only `index.css:183` drops the keyframe loops.
- e2e: camera-animation timing not directly assertable in the harness — note as a manual/visual
  check; assert reduced-motion path where structurally checkable (duration→0).

### Slice 2 — Token / chrome parity audit (§A; DESIGN §2–§7)
- Audit `index.css :root` against §2 (surfaces/borders/text/accent), §3 (type scale), §4 (radius/
  elevation/spacing). Confirm exactly **two** shadows (`--shadow-board`, `--shadow-pop`) — no stray
  glow/drop-shadow (§1.3 "no slop"). Grep components for hardcoded colors/shadows that bypass tokens.
- Board chrome geometry (§6): 34px compact title bar, glyph + type tag + title, right cluster
  actions→maximize→⋯. Re-check `BoardFrame.tsx` right cluster + ⋯ contrast (reworked Phase 3) still
  matches §6. States table (§6): resting/hover/selected/focused/full-view/LOD treatments (rings,
  `--accent-wash`, dim-others 55%).
- Per-type (§7): Terminal §7.1 (identity pill, run timer, progress sliver), Browser §7.2 (device
  frame, URL bar, viewport segmented control), Planning §7.3 (notes/arrows/text/pen/checklist).
- Fix any drift found. e2e green (no behavior change expected; chrome assertions `menu-chrome` guard).

### Slice 3 — Geist fonts (§D)
- Add `geist` npm pkg (devDep). Copy Geist + Geist Mono woff2 → `src/renderer/src/assets/fonts/`.
  `@font-face` (font-display: swap) in `index.css`; keep the existing fallback stacks (`--ui`/`--mono`).
- `font-src 'self'` already in CSP — no network fetch. Verify in packaged build (`pnpm pack:dir`).
- e2e green; visual check Geist renders (HTML shot `CANVAS_SHOT`).

### Slice 4 — Empty / loading / error states (§B; DESIGN §8 + §7)
- **Empty project** (§8): audit `WelcomeScreen.tsx` — app-mark watermark, `h` "Empty canvas", one
  `body --text-3` line, three ghost-outline `+ Terminal / + Browser / + Planning` buttons, dock +
  top chrome visible.
- **Browser states** (`BrowserBoard.tsx` `DeviceContent`): connecting / load-failed / snapshot
  fallback — polish copy + visuals.
- **Terminal** idle/running/failed (§7.1); **Planning** empty board.
- e2e: add assertions where structurally checkable (welcome buttons present; browser state classes).
  Negative-control new assertions.

### Slice 5 — Full-view enter/exit motion (§C; needs a short spec)
- Write `docs/superpowers/specs/2026-05-31-fullview-motion.md` first.
- `FullViewModal.tsx` opens/closes instantly today. Add scrim fade-in + frame scale/opacity from the
  board's on-canvas rect (reverse on close), `200ms cubic-bezier(.2,.7,.2,1)`.
- **Constraint:** a Browser board's native `WebContentsView` CANNOT be CSS-animated (OS layer) —
  animate HTML scrim/frame; the native view snaps to final bounds (or carries it via its snapshot).
  See `BrowserPreviewLayer.tsx` (`fullViewBoundsFor`, full-view rAF pump).
- Reduced-motion: instant (no scale/fade). e2e: `terminal-fullview`/`fullview-preview`/
  `fullview-emulator` must stay green (live subtree/PTY/native view survive). Add an open/close
  assertion if checkable.

### Slice 6 — CSP nonce hardening (§E; packaged build)
- `index.html` ships dev CSP with `'unsafe-inline'`. Packaged build: nonce-based policy, drop
  `unsafe-inline` for script+style. Vite emits inline scripts/styles → wire a nonce (electron-vite
  CSP plugin / hash-allowlist). Dev keeps looser CSP (Vite refresh + xterm inline styles need it).
- **Never weaken** `contextIsolation`/`sandbox`/`nodeIntegration`.
- Verify packaged renderer (`pnpm pack:dir` → `release/win-unpacked`) loads with no CSP console
  violations + no `unsafe-inline`. e2e green.

### Slice 7 — Renderer code-split (§F)
- Renderer = one 1.28MB chunk. Lazy-load heavy deps behind board type: `@xterm/*` (Terminal),
  `@xyflow/react` is core (keep). `React.lazy` / dynamic `import()` so a no-terminal project doesn't
  pay xterm up front. Manual chunks in `electron.vite.config.ts` if cleaner.
- Acceptance: smaller initial chunk; no functional regression (full e2e green — terminal parts
  exercise the lazy path).

## Ordering rationale
Quick/high-visibility + low-risk first (1 motion, 2 tokens, 3 fonts, 4 states), then care-needed
(5 full-view motion around native view), then packaging-adjacent (6 CSP, 7 code-split) verified
against `pnpm pack:dir`. End each slice runnable + committed; full e2e green before handoff.

## DESIGN.md → code map
See `docs/handoffs/phase-4.md` table (tokens→index.css, §6 chrome→BoardFrame/BoardNode, §7 per-type
boards, §8 chrome→AppChrome/WelcomeScreen, §9 motion→AppChrome+index.css+FullViewModal).

---

## Progress (2026-05-31) — 6/7 slices shipped on `phase-4-design-pass`

| Commit | Slice | Notes |
|---|---|---|
| `5e2dbed` | 1 Motion (§9) | `lib/motion.ts` cubic-bezier + `cameraAnim` (200ms, reduced-motion→0); select-ring 120ms + handle fade 100ms. |
| `83beb17` | 2 Token/chrome (§A) | §4 two-shadow consolidation; §6 selected = ring-only; §7.3 grid 12px. Deliberate divergences kept (type tag dropped, terminal globe/gear shipped). |
| `e541a54` | 3 Geist fonts (§D) | variable woff2 bundled, `@font-face`, CSP-safe; `RENDERER_FONTS` probe. |
| `76e76fe` | 4 States (§B) | welcome-screen tokenised; terminal braille spinner wired (80ms, reduced-motion static). EmptyState/Browser states already compliant. |
| `ceb53cb` | 6 CSP (§E) | `canvas-ade-csp-meta` Vite plugin: prod `script-src 'self'` (no unsafe-inline); style-src keeps unsafe-inline (React inline attrs can't be nonce'd). |
| `5874f2d` | 7 Code-split (§F) | React.lazy boards + dynamic smoke xterm; entry chunk 1,286→672 kB. |

Verification per slice: parity workflow (1,2) / build-proof (3,6,7) + full e2e + unit/typecheck/lint.

**e2e env-flake (IMPORTANT for the next session):** the live-`WebContentsView` trio
`browser` / `browser-gesture` / `focus-detach` flaps `empty=true` / `not live` on this machine —
PROVEN environmental (a negative-control run on stashed main-equivalent code fails the identical
trio). It is NOT a regression from any slice. Every other part (terminal×5, planning, menu×3,
fullview-preview/emulator, preview-edge, duplicate, deadurl, seed) passed across all slices. Treat
16/16-non-trio + the negative control as the bar when the trio is flaking; rerun on a fresh
electron process for a clean 19/19 (Slices 2 & 3 caught it green).

### ▶ Remaining — Slice 5: Full-view enter/exit motion (§C) + §6.1 top band
Deferred to a fresh session (most delicate work; native-view constraint). Entry points:
1. **Write the spec** `docs/superpowers/specs/2026-05-31-fullview-motion.md` first.
2. `FullViewModal.tsx` opens/closes instantly — add scrim fade-in + frame scale/opacity from the
   board's on-canvas rect (reverse on close), `200ms cubic-bezier(.2,.7,.2,1)` (reuse `EASE_STANDARD`
   / `cameraAnim` timing from `lib/motion.ts`). Reduced-motion → instant.
3. **Native-view constraint:** a Browser board's `WebContentsView` CANNOT be CSS-animated (OS layer).
   Animate the HTML scrim/frame; the native view snaps to final bounds (or rides its snapshot). See
   `BrowserPreviewLayer.tsx` (`fullViewBoundsFor`, full-view rAF pump).
4. **Fold in the §6.1 top band** the Slice 2 audit found missing: a `FULL VIEW` label + `✕ Esc`
   exit band at the top of the full-view frame (`FullViewModal.tsx`). Changing the frame layout will
   shift `fullViewBoundsFor` geometry → re-verify `fullview-emulator` / `fullview-preview` e2e (both
   currently green) after.
5. e2e: keep `terminal-fullview` (same-pid survival), `fullview-preview`, `fullview-emulator` green.
