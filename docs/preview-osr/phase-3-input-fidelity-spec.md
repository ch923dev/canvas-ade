# OS-3 Phase 3 — OSR preview input fidelity (IME · clipboard · AltGr · wheel)

> Slice spec for `feat/osr-input-fidelity`. Third phase of OS-3 (OSR Browser-preview
> productionization). Per the doc-lifecycle this file is **deleted on the FINAL OS-3 PR** (the
> build-history line is the residue, #150 backdrop precedent). Authoritative gap register: the
> spike spec `docs/reviews/2026-06-14-electron-to-flutter-assessment/preview-offscreen-spike-spec.md`
> › §8c — the four P1 rows this phase closes: **IME/composition**, **clipboard Ctrl+C/X/V**,
> **AltGr**, and **forwarded-wheel precision**. Builds on Phase 1 (#155 — supersample/reflow) and
> Phase 2 (#159 — paint-gating/MAX_LIVE/dirty-rect).

## Decisions locked

- **Rollout (unchanged):** OSR stays **flag-gated** (`VITE_PREVIEW_OSR`); the default-flip + native-path
  deletion is Phase 5. This phase only changes behaviour behind the flag.
- **Phase 3 = the four input rows** of §8c (IME, clipboard, AltGr, wheel). Native `<select>`/dialogs/
  downloads/audio-mute are explicitly **Phase 4** (design-artifact-gated, touch chrome) — out of scope.
- **No UI/UX artifact:** Phase 3 adds **no visible chrome**. The composition proxy is an invisible,
  click-through `<textarea>` (opacity 0, `pointer-events:none`). Nothing the user sees changes, so the
  "design artifact before code" gate (CLAUDE.md) does not apply. The verification surface is a manual
  dev check with a real IME + AltGr layout (acceptance below), not a screenshot.

## Problem (grounded in the code)

`useOffscreenInput.ts` forwards input from the focusable `<canvas>` to MAIN's `preview:osrInput` →
`webContents.sendInputEvent`. It works for ASCII + mouse + wheel but has a **structural** ceiling for
real text input:

- **IME / composition is impossible.** A bare focused `<canvas>`/`<div>` has no *editing host*, so the
  browser fires no `compositionstart/update/end` on it. CJK/emoji/dead-key input never reaches the page
  (the §8c "IME broken" row). There is no way to fix this without an **editable** focus target.
- **AltGr is corrupted.** Windows synthesizes **Ctrl+Alt** for AltGr, so `€` (AltGr+E) arrives with
  `ctrlKey===true`. The current `onKeyDown` only emits a `char` when `!e.ctrlKey && !e.metaKey`, so the
  character is dropped and the page sees a stray Ctrl+Alt chord instead (the §8c "AltGr broken" row).
- **Clipboard is flaky.** Ctrl/Cmd+C/X/V are forwarded as **synthetic key chords** via `sendInputEvent`.
  The previewed page's `navigator.clipboard` is intentionally denied (deny-all permissions), so a
  synthetic Ctrl+V cannot read the OS clipboard — paste silently fails / is inconsistent (the §8c
  "clipboard partial" row).
- **Wheel is jumpy.** `onWheel` approximates line/page deltas crudely (`deltaMode===1 ? 16 : …`) and sets
  no precise-scroll hint, so trackpad scrolling is coarse and mouse-wheel notches over/under-shoot (the
  §8c "wheel partial" row).

## Design

The fix that resolves IME, AltGr, and dead-keys **at once** is the industry-standard remote-rendering
pattern (xterm, noVNC, Guacamole, Chrome Remote Desktop all use it): a **hidden, editable composition
proxy** that owns the keyboard, while the canvas keeps the pointer/wheel/cursor. Text then flows through
the proxy's real `input`/composition events and is committed into the page via CDP — the same attached
`wc.debugger` Phase 0 already uses for focus emulation (ADR 0002 pre-authorizes CDP attach; MAIN-side
only, renderer sandbox untouched).

### Surfaces

```
.bb-frame
 ├─ <canvas class="bb-live">          ← pointer / wheel / cursor-mirror   (unchanged role)
 └─ <textarea class="bb-ime-proxy">   ← keyboard / IME / clipboard target  (NEW; invisible)
```

The proxy is `position:absolute; inset:0; opacity:0; pointer-events:none; resize:none; border:0;
`white-space:pre;` `autocomplete/autocorrect/autocapitalize=off; spellcheck=false; tabIndex=-1;
aria-hidden`. `pointer-events:none` makes every click fall through to the canvas (so hit-testing +
cursor mirroring are unchanged); we `proxy.focus({preventScroll:true})` **programmatically** on canvas
`pointerdown` (focus works regardless of opacity/pointer-events). Sizing it to the board (not 1×1) puts
the OS IME candidate window roughly over the board. The canvas **loses** `tabIndex={0}` — the proxy is
now the sole focus/keyboard target, so DOM focus stays singular (only the active board is emulated-focused).

### 3A — Text via `Input.insertText` (fixes AltGr + dead-keys; the IME commit path)

All **text** is routed through the proxy's native `input` event and committed with CDP `Input.insertText`,
**not** synthetic `char` chords. This is the §8c AltGr lever's robust option ("route all text via
`Input.insertText`") and it dissolves the AltGr/dead-key problem: the browser composes `AltGr+E→€` or
`´+e→é` for us; we read the final grapheme(s) off the proxy and insert them. Modifier-state guessing is
gone.

- proxy `input` (not composing) → `osrIme(id, 'commit', proxy.value)`; clear `proxy.value`.
- The page receives `beforeinput`/`input` (what controlled `<input>`/React forms listen to). It does
  **not** receive a synthetic `keydown` for letter keys — a documented tradeoff (a page that reads raw
  `keydown` for *text* keys, e.g. a canvas game's WASD, won't see them in OSR text mode; command keys
  below still send real key events). Acceptable for a localhost UI preview; revisitable in P2.

### 3B — IME / composition via `Input.imeSetComposition` + `insertText`

- `compositionstart` → set a `composing` flag.
- `compositionupdate` → `osrIme(id, 'compose', e.data)` → MAIN `Input.imeSetComposition({text, selectionStart:len, selectionEnd:len})` so the composing text shows **inline underlined** in the page input (best-effort feel).
- `compositionend` → `osrIme(id, 'commit', e.data)` → MAIN `Input.insertText({text})` (commits, clears the composition); clear `composing` + `proxy.value`; swallow the trailing `input`.
- The `input` handler **ignores** events while `composing` (the composition path drives them) and ignores the one immediately-following commit `input`.

Guarantee vs best-effort: **commit** (insertText) is the guarantee — you can always type CJK. **compose**
(imeSetComposition, inline preview) is best-effort; if it misbehaves on a platform the commit still lands.
Both are `try/catch` in MAIN.

### 3C — Clipboard via the trusted WebContents edit methods

Ctrl/Cmd + C/X/V/A are intercepted on the proxy `keydown`, routed to MAIN, and applied with the
**WebContents** edit methods — never a synthetic chord:

- `copy` → `wc.copy()`  ·  `cut` → `wc.cut()`  ·  `paste` → `wc.paste()`  ·  `selectAll` → `wc.selectAll()`

`wc.copy()`/`cut()` push the page selection to the **OS** clipboard; `wc.paste()` pastes the OS clipboard
into the page's focused field — the trusted MAIN-side bridge over the page's denied `navigator.clipboard`.
The chord is `preventDefault`+`stopPropagation`+swallowed (NOT also forwarded), so there is no double-paste.
Tradeoff: a page with a *custom* Ctrl+C handler (e.g. Monaco) gets the WebContents copy instead of its
handler — standard embedded-browser behaviour; documented.

### Key routing (pure `osrKeyInput.ts`, unit-tested)

`classifyKeydown(e)` → one of:

| Class | When | Action |
|---|---|---|
| `ime` | `e.isComposing \|\| e.keyCode === 229` | ignore (composition events drive it) |
| `clipboard:{copy,cut,paste,selectAll}` | (ctrl/meta) & **not AltGr** & key ∈ c/x/v/a | `osrEditCommand`; preventDefault; swallow |
| `command` | named non-text key (Enter/Tab/Esc/arrows/Backspace/Delete/Home/End/Page*/F1–F12) **or** any (ctrl/meta)-modified non-clipboard key | `sendOsrInput` keyDown/keyUp; preventDefault (stop proxy edit + RF) |
| `text` | printable, no command-modifier (incl. **AltGr** = `getModifierState('AltGraph')` or Win Ctrl+Alt) | do nothing in keydown — let the proxy `input` fire → insertText |

AltGr detection (`getModifierState('AltGraph') || (ctrlKey && altKey && !metaKey)`) reclassifies a would-be
`command` chord as `text` so the proxy receives the composed char.

### 3D — Wheel precision (pure `osrWheel.ts`, unit-tested)

`mapOsrWheel(e, pageH)` → `{ deltaX, deltaY, hasPreciseScrollingDeltas, canScroll }`:

- `deltaMode===0` (pixel — trackpads / precise mice) → deltas pass through 1:1, `hasPreciseScrollingDeltas:true`.
- `deltaMode===1` (line) → `× LINE_HEIGHT_PX` (≈40, Chromium's mouse-wheel line default — replaces the
  too-small 16), precise:false.
- `deltaMode===2` (page) → `× pageH`.
- Sign negated (DOM down-positive → Electron mouseWheel up-positive), as today. `canScroll:true`.

## Files

| File | Change |
|---|---|
| `src/renderer/src/lib/osrKeyInput.ts` (new, pure) | `classifyKeydown`, AltGr detection, `keyCodeOf` (moved from the hook); unit-tested |
| `src/renderer/src/lib/osrWheel.ts` (new, pure) | `mapOsrWheel` (precise/line/page deltas); unit-tested |
| `src/renderer/.../useOffscreenInput.ts` | proxy textarea = keyboard/IME/clipboard target; canvas = pointer/wheel/cursor; composition + input + clipboard listeners; wheel via `mapOsrWheel`; `classifyKeydown` routing |
| `src/renderer/.../BrowserBoard.tsx` | render the hidden `.bb-ime-proxy` textarea sibling; drop canvas `tabIndex`; pass a `proxyRef` to `useOffscreenInput` |
| `src/renderer/src/index.css` | `.bb-ime-proxy` (invisible, click-through, no focus ring) |
| `src/main/previewOsr.ts` | `applyOsrEdit(wc, action)` + `preview:osrEdit`; `applyOsrIme(e, kind, text)` (CDP imeSetComposition/insertText + `sendInputEvent` char fallback) + `preview:osrIme`; both frame-guarded |
| `src/preload/index.ts` (+ `index.d.ts` via `CanvasApi`) | `osrEditCommand(id, action)` + `osrIme(id, kind, text)` |

## Tests

- **`osrKeyInput.test.ts` (pure):** Enter/Tab/arrows → `command`; printable letter → `text`; Ctrl+C/X/V/A
  → `clipboard:*`; Ctrl+S → `command` (not clipboard); IME sentinel (`keyCode 229` / `isComposing`) →
  `ime`; **AltGr+E (ctrl+alt or AltGraph) → `text`, NOT command/clipboard** (the regression that proves
  the € fix); `keyCodeOf` maps named keys + passes single chars.
- **`osrWheel.test.ts` (pure):** pixel mode → 1:1 + `hasPreciseScrollingDeltas`; line mode → ×40; page
  mode → ×pageH; sign negated; zero deltas → zero.
- **`previewOsr` (main):** `preview:osrEdit('copy')` calls `wc.copy()` (etc. for cut/paste/selectAll);
  unknown action is a no-op; frame-guard rejects a foreign sender. `applyOsrIme('compose')` sends
  `Input.imeSetComposition`, `('commit')` sends `Input.insertText`; a throwing/absent debugger falls back
  to `sendInputEvent` char(s) for commit and no-ops for compose.
- **e2e (`@preview`, flag ON):** typing ASCII into a focused page input lands the text (insertText path);
  Ctrl+A then Ctrl+C then click-elsewhere then Ctrl+V round-trips a selection. (Real-IME + AltGr are
  manual — no headless IME; see acceptance.) Tag per `docs/testing/TESTING.md` › E2E tags.

## Acceptance (Phase 3) — manual dev check, flag ON, title-stamped

`$env:VITE_PREVIEW_OSR='1'; $env:CANVAS_DEV_TITLE='PR#NNN OSR input fidelity'; pnpm dev` against a small
local page with a text `<input>`/`<textarea>`:

- **ASCII** types into the page input (insertText path replaces the old char path with no regression).
- **AltGr** — on an EU layout (or AltGr remap), `AltGr+E` types `€` into the input (the headline fix).
  Dead key (`´` then `e` → `é`) composes correctly.
- **IME** — switch the OS to a CJK IME (e.g. Microsoft Pinyin); composing shows candidates; commit drops
  the chosen characters into the page input. Inline composition preview is best-effort; commit is required.
- **Clipboard** — select page text, `Ctrl+C`; paste into the OS (Notepad) → got it. Copy from the OS,
  `Ctrl+V` into the page input → pasted. `Ctrl+X`/`Ctrl+A` work.
- **Wheel** — trackpad scroll is smooth/precise; mouse-wheel notches scroll a sensible amount (not the
  old tiny 16px).
- **No regression** — command keys (Enter submits, Tab moves, Esc, arrows scroll the page) still work;
  the canvas still hit-tests clicks and mirrors the cursor; confirm the window title reads this PR's stamp.

Full gate green; **FULL e2e matrix at the pre-merge gate** (touches `src/main` → Linux leg required).

## Risks / handoffs

- **insertText loses raw `keydown` for text keys** — documented tradeoff (games/custom editors reading
  letter `keydown`). Command keys keep real key events. P2 could dual-send keydown+insertText if needed.
- **imeSetComposition doubling on commit** — if a platform double-inserts, clear the composition before
  `insertText` (`imeSetComposition('',0,0)` first). Left out initially to avoid spurious empty-composition
  events; flagged for the live IME check.
- **Proxy focus vs the canvas** — focus must move to the proxy on `pointerdown`; the per-interaction CDP
  focus emulation (`preview:osrFocus`) now keys off the **proxy's** focus/blur. Verify a click still
  shows the page caret (focus emulation on) and clicking another board fires blur (menus close).
- **CDP unavailable fallback** — if `wc.debugger` isn't attached (detach/unsupported), `applyOsrIme`
  commit falls back to per-codepoint `sendInputEvent` char so text never silently drops; compose no-ops.
- **No headless IME/AltGr** — the pure classifier + wheel mapper are unit-tested; the CDP/textarea wiring
  is thin and verified by the manual check. Same headless-limit posture as Phase 2's dirty-rect.

## Out of scope (later OS-3 phases)

Native `<select>`/date/color pickers · `alert/confirm/prompt` dialogs · `<input type=file>` · downloads ·
`<video>/<audio>` mute (all **Phase 4**, design-artifact-gated) · the default-flip + native-path deletion
+ P2 polish (worker/`OffscreenCanvas`/WebGL frame path, 60fps focused cap, dual keydown+insertText) — **Phase 5**.
