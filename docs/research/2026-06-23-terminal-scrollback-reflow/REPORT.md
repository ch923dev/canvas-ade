# Terminal scrollback corruption on full-view toggle — investigation + plan

*Canvas ADE · xterm.js 5.5.0 + addon-webgl 0.18.0 + addon-fit 0.10.0 · Electron 42 · 2026-06-23*
*Status: research + remediation plan (no code changed). One product decision gates Phase A — see §9.*

---

## 1. Executive summary

The reported symptom — scrolling up shows **truncated/missing** scrollback, and the **first lines
visible before scrolling get duplicated**, worst on **full-view enter↔exit** — is caused by a single
trigger: a full-view toggle issues a **genuine column-changing `term.resize()`**, which drives
xterm.js's **lossy buffer reflow** (`Buffer.resize → _reflowLarger/_reflowSmaller`).

This is the *one* place in the app where columns change. The "FREEZE re-raster" deliberately keeps
`cols×rows` constant across **zoom** (so zoom never reflows). But full view sets `counterScale = 1`
**and** portals the board into a ~90vw×90vh modal, so the well's real `clientWidth/Height` change,
the ResizeObserver's freeze-gate correctly fires, `fitWhole()` re-proposes a different column count,
and `term.resize(cols≠current)` runs — **twice per round-trip** (enter widens, exit narrows).

- **Truncation/missing** = genuine buffer loss: reflow re-wraps lines and trims at the 5000-line cap,
  and xterm does **not** preserve a scrolled-up viewport offset across a resize.
- **Duplication** = stale paint during/after the reflow (the portal pauses the renderer; the no-clip
  font loop fires up to 4 extra `fontSize` writes after the resize), until a full repaint lands.

**Critical:** this is a **known, currently-unfixed xterm bug** (#5319 / #3513; the attempted fix
#5321 was *reverted* by #5358 after it bricked buffers, and the regression persists in **6.0.0**).
So **upgrading xterm will not fix it.** The robust fix is to stop changing columns on full view —
i.e. extend the existing FREEZE discipline to the full-view portal transition.

---

## 2. How the terminal is built (the relevant seams)

- **One xterm ⇄ one node-pty (MAIN) ⇄ one board.** Data plane over a MessagePort; control plane over
  IPC. `scrollback: 5000`, WebGL renderer (budget 8 contexts), `allowProposedApi: true`.
  (`useTerminalSpawn.ts:378-388`)
- **FREEZE re-raster:** at settled camera zoom `z`, the well is laid out at `boardContent × cs` and
  counter-scaled by `1/cs`; render font = `pinned × cs`. So `cols/rows` are **frozen across zoom**;
  the ResizeObserver is gated on the z-invariant `screenWrap` size and skips zoom-only fires.
  (`useTerminalSpawn.ts:225-226, 570-598`; `useTerminalReraster.ts`)
- **Full view:** `requestFullView` mounts `FullViewModal` (rect = 5vh/5vw inset → ~90vw×90vh,
  `FullViewModal.tsx:46-54`); `BoardNode` **`createPortal`-relocates** the live subtree into the modal
  host (relocation, *not* remount — PTY/xterm survive, `BoardNode.tsx:238-260`); `BoardFullViewContext`
  flips true → `counterScale` forced to `1` (`useTerminalSpawn.ts:209,225-226`).
- **`fitWhole()`** runs `FitAddon.fit()` then arithmetic whole-cell row-shed and calls `term.resize`
  at most once (`useTerminalSpawn.ts:280-307`).

---

## 3. Root cause (confirmed against the vendored xterm source)

### 3.1 The trigger chain (full view, both directions)

```
ENTER: maximize → FullViewModal mounts → BoardNode createPortal relocates the live well into the
  ~90vw modal → counterScale forced 1 → well clientWidth/Height change → spawn-effect ResizeObserver
  fires; wrap key changes → FREEZE gate does NOT skip → fitWhole() → term.resize(cols↑, rows)
  → CoreTerminal.resize → Buffer.resize → _reflow              (cols up  → _reflowLarger)
EXIT:  symmetric, back to the small in-canvas size              (cols down → _reflowSmaller)
```

Reflow is gated **only** on a column delta: `_reflow` early-returns when `_cols === newCols`
(`Buffer.ts:300-303`). A rows-only resize is safe; a **column** change is not.

### 3.2 Why reflow is even active (no `windowsMode`/`windowsPty` escape hatch)

The `Terminal` is constructed with no `windowsPty`/`windowsMode` option, so
`_isReflowEnabled = _hasScrollback && !windowsMode` → **true** at `scrollback:5000`
(`Buffer.ts:292-298`). The full JS reflow pass runs on every column change, on every platform.

### 3.3 TRUNCATION (lines genuinely removed from the buffer)

1. **Cap trim on narrowing.** On exit, cols shrink → `_reflowSmaller` re-splits long lines and
   **inserts** wrapped rows (`Buffer.ts:345-515`, `BufferReflow.ts:176-223`). Near the 5000 cap the
   surplus is trimmed from the **top** (`trimStart`/`onTrimEmitter`), discarding oldest scrollback.
2. **maxLength trim on height change.** Full view also changes rows; when `newMaxLength < maxLength`,
   `lines.trimStart(amountToTrim)` drops top lines and `ydisp = max(ydisp - amountToTrim, 0)`
   (`Buffer.ts:219-229`).
3. **Scrolled-up offset not preserved.** Reflow only keeps the **bottom** edge anchored: it adjusts
   `ydisp` *only when `ydisp === ybase`* (`Buffer.ts:336-339, 452-454`). When the user is scrolled up
   (`ydisp < ybase` — exactly "reading logs"), `ybase` shifts but `ydisp` does not, so the visible top
   row drifts relative to content. **xterm never saves/restores a scrolled-up offset across a resize.**

The loss in (1)/(2) is inherent xterm behavior — the text is genuinely gone from the buffer; no
repaint recovers it.

### 3.4 DUPLICATION (the first visible lines reappear)

The buffer does **not** additively duplicate: `_reflowLarger`/`_reflowSmaller` copy cells in place via
`copyCellsFrom` with no source re-emit (`BufferReflow.ts:62`; `Buffer.ts:401-429`). Duplication is a
**stale-paint** artifact:

- The WebGL model is a flat array indexed by viewport `y`; `_updateModel` **skips** a cell when its
  cached `code/bg/fg/ext` equal the new value (`WebglRenderer.ts:485-490`). After reflow, screen `y`
  maps to a different buffer row, but glyphs that happen to match are left painted.
- A full repaint *is* scheduled, but it is rAF-debounced and **deferred while the renderer is paused**
  — the old DOM node going invisible during the portal sets the terminal's IntersectionObserver to
  paused and routes resize into a deferred task (`RenderService.ts:120-133, 246-256`).
- **Canvas ADE compounds it on exit:** `useTerminalReraster`'s no-clip rAF loop fires up to four
  `term.options.fontSize *= 0.97` writes **one frame after** the synchronous resize
  (`useTerminalReraster.ts:90-110`). Each write forces another `clear()+handleResize()+refresh` and a
  cell re-measure — racing a reflow that is still settling (ConPTY reprint data may still be arriving).

### 3.5 Why **exit** is worst, and the Windows angle

- After the exit resize, `useZoomSettle`'s 250 ms debounce can land in the snap band → `snapZoom` →
  `setViewport` → a **second** settle → a second `counterScale` change → another reraster/resize.
  (`useZoomSettle.ts:29,44-67`)
- On **Windows** the PTY is ConPTY (node-pty). xterm has no `windowsPty` hint, so xterm's JS reflow
  and ConPTY's own screen reprint **both** re-lay-out the screen on a resize and disagree — the exact
  mechanism behind the known-unfixed #5319/#3513 (and Microsoft's `vscode#241978`). This makes the
  duplication/garble materially worse on this user's platform.

---

## 4. Ranked hypotheses (5-way adversarial verification)

| ID | Hypothesis | Verdict | Explains trunc / dup / full-view-trigger |
|----|------------|---------|------------------------------------------|
| **H1** | Column-changing reflow on toggle is the trigger | **Root trigger (confirmed)** | partly / partly / **yes** |
| **H5** | Scrolled-up `ydisp/ybase` desync after reflow | **Contributing** | partly / partly / partly |
| **H4** | Multiple resizes + font writes per toggle (not a true race, but extra reflows + stale-frame window) | **Contributing** | partly / partly / yes |
| **H2** | xterm/ConPTY *double* re-layout on Windows (no `windowsPty` hint) | **Contributing (Windows)** | partly / partly / yes |
| **H3** | WebGL renderer alone paints stale rows (buffer fine) | **Refuted as sole cause** | no / no / no |

Consensus: **one root trigger (the column-changing resize), several contributing facets.** Duplication
is render-side staleness *induced by* the reflow + portal-pause + font-loop, not an independent GPU bug.

---

## 5. Key external evidence (web research)

- **#5319 / #3513** — reflow desync with ConPTY (cursor lands wrong; reflow deletes/duplicates buffer
  content). Fix **#5321 reverted by #5358** (2025-06-18) after it bricked buffers → **still open in
  practice, incl. in 6.0.0.** Mirrors `microsoft/vscode#241978`.
- **#325 / #3178** — long-standing "resize loses scrollback text" (narrow then widen ⇒ data not
  restored). The original truncation class.
- **hermes-hq/hermes-ide #113** — near-identical symptoms in another Electron terminal: history
  navigation leaves **fragments of previous output** ("duplicated first lines"); root cause = **PTY/xterm
  column mismatch**; also flags the `cols < 10` NaN-guard footgun (`NaN < 10` is false) → use
  `Number.isFinite()`.
- **Version reality (verified 2026-06-23):** `@xterm/xterm` latest **6.0.0**, addon-webgl **0.19.0**,
  addon-fit **0.11.0**, addon-serialize **0.14.0** (not installed). 6.0.0 ships adjacent stale-render
  fixes (#5253 re-`open()`, #5305 webgl-throw listeners, #5328 refresh-after-ED, #5423
  clear-selection-on-resize) **but not** a working core-reflow fix, and carries breaking changes
  (#5107 overviewRuler, #5462 removed `windowsMode`/`fastScrollModifier`, #5096 rewritten viewport).
- **WebGL maintainer note (#4065):** the WebGL renderer's own `handleResize()` clears its model + full
  redraws, so a stale-row symptom after a *pure* resize is usually the **buffer** upstream, not the GPU.
  `term.refresh()` is harmless defense-in-depth; it won't fix a corrupted buffer.

---

## 6. Remediation plan

> **DECIDED (2026-06-23):** **Pure A1** — full view keeps the in-canvas columns and scales the grid
> up to fill the modal; it never issues a column-changing `term.resize` on toggle. (A2 "reflow wider"
> was considered and declined.) A-Win (Windows ConPTY hint) and A-Polish (clean repaint) ship with it.

### Phase A — stop the corruption (Pure A1)

#### A1 — Don't change columns on full view (extend FREEZE to the portal) ⭐ chosen
- **What:** treat full view as a **large settled "zoom"** rather than a re-fit. Instead of forcing
  `counterScale = 1` and letting `fitWhole` re-propose cols from the modal width, **freeze the
  in-canvas `term.cols/term.rows`** and set `counterScale` to the **modal-fill factor** so the existing
  FREEZE seam scales the grid up: render font = `pinned × cs`, well laid out at `boardContent × cs`,
  `transform: scale(1/cs)` → the same grid fills the modal, crisp at device pixels. No `term.resize`
  with a different column count ever fires on the toggle. (If a taller modal warrants more rows, a
  **rows-only** `term.resize(term.cols, newRows)` is safe — `_reflow` early-returns when cols match.)
- **Files:** `useTerminalSpawn.ts:209,225-226` (replace `isFullView → counterScale=1` with a
  full-view fill factor); `:280-307` (`fitWhole` — pin the column component; don't re-propose cols in
  full view); `:576-598` (RO gate — treat the full-view transition like a zoom, skip the col re-fit);
  `useTerminalReraster.ts:124-139` (wrapper style already supports `cs≠1`); `FullViewModal.tsx:46-54`
  (modal rect → fill factor).
- **Why it works:** no column delta ⇒ `_reflow` early-returns (`Buffer.ts:300-303`) ⇒ no cap-trim, no
  re-wrap, no `ydisp` recompute, no stale-paint-during-reflow ⇒ **scrollback identity preserved** across
  the round-trip. Both truncation *and* duplication disappear at the toggle.
- **Two integration points to handle carefully (implementation risk):**
  1. **Selection shim `getZoom`** (`useTerminalSpawn.ts:238-242`): full view currently returns net
     scale `1`; under A1 the grid renders at the fill factor, so `getZoom` must return the real net
     scale (fill-factor-aware) or click-to-select coordinates will drift in full view.
  2. **No-clip rAF font loop** (`useTerminalReraster.ts:90-110`): it still runs at `cs≠1`; with cols
     frozen it only does its clip correction (no reflow to race), but pair with A-Polish below so the 4
     `fontSize` writes can't leave a stale glyph frame.
- **Trade-off (accepted):** full view shows the **same column count** as the board, scaled up (bigger
  glyphs / letterboxed), **not** a wider re-flowed grid. **Needs a design-artifact mock + sign-off**
  (per design-before-code) before implementation; verify TUIs (vim/htop) read acceptably letterboxed.
- **Risk:** Medium (the two integration points above).

#### A-Polish — clean repaint after the full-view settle (cheap insurance) — ships with A1
After the full-view counter-scale settles (and after the no-clip loop's last `fontSize` write), call
`webglAddon.clearTextureAtlas()` + `term.refresh(0, term.rows-1)`. Defeats any residual stale glyph
from the 4 font writes. *Low risk;* one extra full repaint per toggle. (`useTerminalReraster.ts`)

#### A-Win — Windows ConPTY hint — ships with A1
Pass `windowsPty: { backend: 'conpty', buildNumber }` to the `Terminal` constructor on Windows so
xterm and ConPTY stop double-laying-out on any resize (addresses H2; also protects the still-reflowing
canvas-drag-resize path). Note this makes `_isReflowEnabled` ConPTY-version-gated — validate behavior.
(`useTerminalSpawn.ts:378-388`)

> **Note — A1 fixes the *toggle*, not *all* resizes.** Dragging a board much wider/narrower on the
> canvas still changes cols and reflows (just less often, and rarely while scrolled up). The true
> backstop against *all* resize loss is the **serialize/restore** capability in Phase 2 (snapshot →
> resize → write back). A-Win reduces the Windows severity of that residual path in the meantime.

#### A1 — as shipped (2026-06-23, after adversarial review)
The implementation (`useTerminalSpawn.ts` + `useTerminalReraster.ts`) matches A1 above, with three
refinements surfaced by a 3-agent diff review:
1. **Freeze at the ResizeObserver, not just `fitWhole`.** The RO ignores the full-view portal's resize
   for an established grid **and does not advance `lastWrapKey`**, so the symmetric *exit* fire (well
   back to the pre-full-view size) compares equal and is skipped too. This was the key fix: an exit
   re-fit raced the font transition back to pinned, changed rows, and `term.resize` → the PTY got a
   **SIGWINCH** → the shell **redrew its prompt over the bottom rows** (real line loss). Skipping both
   fires keeps the grid at its exact in-canvas `cols×rows` with **zero PTY mutation** across the toggle.
2. **Established-grid guard (`establishedRef`).** The freeze applies only to a grid already fitted
   in-canvas. A *fresh* mount while maximized (reconfigure-in-full-view respawn) still takes its initial
   fit — it has no scrollback to corrupt, and skipping its fit would spawn a wrong-width PTY.
3. **A-Polish kept** as a single `term.refresh(0, rows-1)` on the toggle (in `useTerminalReraster`),
   cheap insurance for the duplication facet. The `clearTextureAtlas` half was dropped (not on the
   public `Terminal` API; the font change already refreshes the atlas).
- **A-Win — shipped as Phase 1b** (separate PR): xterm `windowsPty: { backend:'conpty', buildNumber }`
  hint, plumbed via `main/platformIpc.ts` (sync `os.release()` build → preload `osWinBuild` → renderer
  `conptyHint`). **Gated to Win 11 builds ≥ 21376** so it never disables reflow on Win 10 (the
  `_isReflowEnabled` footgun). Aligns xterm's resize/scrollback handling with ConPTY's reprint (cuts
  the drag-resize row duplication); does NOT eliminate the cols-reflow itself — that remains Phase 5
  (serialize/restore). Full terminal+fullview e2e (27) green on Win 11; no regression.
- **Regression e2e** (`e2e/terminalScrollback.e2e.ts`, `@terminal`): asserts cols frozen *during* full
  view + every line marker (`L000..L119`) survives a round-trip at zoom 1 **and** a non-1 zoom. Uses an
  `exit`-launched (dead) PTY so the live shell can't race the buffer. Green ×3, serial, retries:0.

### Phase B — hardening

| # | Change | Files | Why | Risk |
|---|--------|-------|-----|------|
| B1 | **Don't rely on an xterm bump for this bug** (6.0.0 lacks the reflow fix). Optionally bump for the adjacent stale-render fixes, budgeting the 6.0 breaking changes. | `package.json` | adjacent fixes only | Med (ABI + breaking changes) |
| B2 | **Configurable + persisted scrollback** (raise default 5000 → 10k–50k; `scrollback?` additive schema field per ADR 0007 + NewTerminalDialog + sticky default like `terminalFont.ts`). | `boardSchema.ts`, `useTerminalSpawn.ts:387`, `NewTerminalDialog.tsx` | fewer cap-trims; user control | Low |
| B3 | **Align the MAIN replay ring to the buffer** — today renderer buffer = 5000 lines but adopt replays a 256 KB byte ring (`RING_CAP_BYTES`), so delete→undo is lossy. | `pty.ts`, `ptyOutput.ts` | faithful restore | Med (memory) |
| B4 | **Regression e2e** (the A1 probe below) in the `@terminal` suite — asserts buffer-content identity + `cols` unchanged + `ydisp` restored across enter→exit and enter→exit→enter. | `e2e/terminal*.e2e.ts` | locks the fix | Low |

---

## 7. Maximize terminal capabilities — roadmap

> **DECIDED build sequence (2026-06-23) — all four selected, sequenced by value × readiness:**
> 1. **Phase 1 — Corruption fix (Pure A1 + A-Polish + regression e2e)** — ✅ implemented (PR #227). **Phase 1b — A-Win** (Windows ConPTY hint, build ≥ 21376) ✅ implemented (separate PR). Gates trust in all of below.
> 2. **Phase 2 — Find-in-terminal (search)** — top user value for log debugging; independent. *(design artifact: find bar)*
> 3. **Phase 3 — Configurable + persisted scrollback** — low effort; sets the depth before serialize. *(design artifact: setting field)*
> 4. **Phase 4 — Correctness pack (web-links + unicode11)** — low effort, independent; unicode also trims wrap miscounts.
> 5. **Phase 5 — Serialize/restore + save-to-file** — heaviest; **after** the fix (else you serialize a corrupted buffer); the all-resize backstop + log export. *(optional add-on: jump-to-bottom badge)*
>
> Each phase = its own `fix/*` or `feat/*` worktree + PR (per CLAUDE.md), full gate + e2e matrix per merge.

Have today: scrollback (fixed 5000), copy/paste-with-image, context menu, font-resize + sticky,
recap/flip, Shift+Enter=LF, scale-correct selection shim, restart/resume, port-detect→preview,
session park/adopt across LOD/undo. **Missing**, prioritized for the stated goal (reading/debugging logs):

| Capability | Value | Effort | Dep on fix | Design artifact? | Notes |
|---|---|---|---|---|---|
| **Search / find-in-terminal** (`@xterm/addon-search`) | **High** | Low–Med | independent | **Yes** (find bar) | The single biggest win for "reading logs / debugging"; decorations work under WebGL; route Ctrl+F via `terminalKeymap.ts`. |
| **Configurable + persisted scrollback** (B2) | High | Low | complements fix | **Yes** (setting UI) | 5000 is low for log-heavy agent runs. |
| **Serialize ⇄ restore live buffer** (`@xterm/addon-serialize`) | High | Med | **after** fix | No | Faithful delete→undo (replaces lossy ring), persist scrollback across restart, enables export. Do **after** the fix or you serialize a corrupted buffer. |
| **Save / export buffer to file** | Med–High | Low | after serialize | No | "Save terminal log" → MAIN `write-file-atomic` into `.canvas/tmp` or a chosen path. |
| **Clickable links** (`@xterm/addon-web-links`) | Med–High | Low | independent | No | URLs/paths in agent output → `shell.openExternal` (security model already routes external nav). |
| **Unicode 11 width** (`@xterm/addon-unicode11`) | Med | Low | independent | No | Correct emoji/CJK cell width; reduces wrap miscount that *feeds* reflow drift. `allowProposedApi` already on. |
| **Jump-to-bottom affordance** | Med | Low | independent | **Yes** (badge) | Common while scrolled up during streaming output. |
| **Scroll polish** (`scrollOnUserInput`, `smoothScroll`, `scrollSensitivity`) | Low | Low | independent | No | Reading comfort. |
| **Accessibility** (`screenReaderMode`, opt-in) | Low | Low | independent | No | ARIA-live tree; off by default for perf. |
| **Ligatures** (`@xterm/addon-ligatures`) | Low | Med | independent | No | **Not supported under WebGL** → would force a renderer downgrade. Recommend **decline/defer**. |
| **Split panes / multi-session per board** | Low | High | — | Yes | Conflicts with the 1 xterm : 1 PTY : 1 board model (park/adopt/LOD/selection/flip). The canvas *is* the multi-terminal surface. **Defer.** |

Per the **design-before-code** rule, the flagged rows (search find-bar, scrollback setting,
jump-to-bottom badge, and the A1 full-view trade) need a token-matched HTML/wireframe mock for sign-off
before implementation.

---

## 8. Verification

**Regression e2e (Playwright `_electron`, `@terminal` tag)** — the decisive probe:
1. Seed a terminal; `resetTerminalWrite` 200 numbered lines (`LINE-0001…`).
2. Scroll up to the middle (`term.scrollLines(-50)`); record `term.cols`, `ydisp`
   (`term.buffer.active.viewportY`), the visible top-line text, and the full array of buffer line
   strings (via `e2eTerminals` / `electronApp.evaluate`).
3. `setFullView(id)` → wait → `setFullView(null)` (and also an enter→exit→enter cycle).
4. **Assert:** (a) buffer line strings identical in content + order + count; (b) `term.cols` unchanged
   (A1); (c) `ydisp` restored ±0; (d) the recorded top-line text is still the visible top line.

Reuse the existing harness handles (`window.__canvasE2E.terminalGeometry / resetTerminalWrite /
setFullView / readTerminal / focusTerminal`, see `e2e/terminalClip.e2e.ts`, `e2e/fullview.e2e.ts`).

**Mandatory manual dev check** (CLAUDE.md): reproduce in `pnpm dev` with
`$env:CANVAS_DEV_TITLE='PR#NNN terminal-scrollback-fix'` — long log, scroll up, enter→exit full view,
visually confirm no truncation/duplication. Green typecheck/unit is **not** sufficient for this class.

---

## 9. Open questions / decisions

1. **~~Gating decision — A1 vs A2~~ → DECIDED: Pure A1** (keep in-canvas columns, scale up; never
   reflow on toggle). A2 declined. Still owed before code: the **A1 design-artifact mock** (full view
   = same columns, bigger glyphs / letterbox) for sign-off per design-before-code.
2. **Windows ConPTY contribution (H2/A-Win):** instrument `proc.resize` vs `term.write` replays on a
   real Windows board to confirm the reprint disagreement, and reproduce on Linux/macOS (real PTY, no
   reprint) to isolate. Decide whether to add the `windowsPty` hint.
3. **Second-resize incidence:** how often does exit actually fire the `useZoomSettle` second resize
   (snap-band dependent)? Drives whether A2a is needed or A1 alone suffices.
4. **Scrollback default + ring alignment (B2/B3):** target depth and memory budget.

---

*Primary file refs: `useTerminalSpawn.ts` (scrollback @387, `fitWhole` @280-307, RO FREEZE gate
@576-598, `counterScale` @209,225-226), `useTerminalReraster.ts` (font seam @63-79, no-clip rAF loop
@90-110), `useZoomSettle.ts` (@29,44-67), `BoardNode.tsx` (@238-260), `FullViewModal.tsx` (@46-54),
`pty.ts`/`ptyOutput.ts` (ring). xterm internals: `Buffer.ts:150,219-229,244-254,292-298,300-515`,
`BufferReflow.ts:24-106,176-223`, `WebglRenderer.ts:168-199,485-490,301-305`, `RenderService.ts`.*
