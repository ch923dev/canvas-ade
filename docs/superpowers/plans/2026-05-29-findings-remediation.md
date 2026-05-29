# Findings Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps found in the post–Phase-2 review — finish the under-delivered 2.x scope, fix two real bugs, add the missing whiteboard delete/undo affordances, stand up an integration/E2E test layer, and amend the roadmap so future-phase findings aren't lost.

**Architecture:** The repo's testing pattern is **pure-function unit tests in a node Vitest env** (`vitest.config.ts` → `environment: 'node'`, `globals: false`, explicit `import { describe, it, expect } from 'vitest'`). This plan keeps that pattern: every behavioural change gets its logic extracted into a pure, tested module, and the React/Electron wiring consumes it. Component/runtime behaviour that can't be unit-tested in node (xterm I/O, native `WebContentsView` alignment) is covered by a new Playwright `_electron` harness (Phase 5) and the live-verification pass (Phase 0).

**Tech Stack:** Electron 33 · React 18 · TypeScript (strict) · `@xyflow/react` v12 · Zustand 5 · `@xterm/xterm` + `node-pty` · Vitest 2 · (new) `@playwright/test` + `@testing-library/react` + `jsdom`.

**Gate after every task:** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build` must stay green; the headless smoke (`$env:CANVAS_SMOKE='exit'; pnpm start` → `SELFTEST_DONE …"pty":true…"preview":true` + `RENDERER_SMOKE …`) must still pass. Each task ends in a commit.

---

## Finding → task map (why each task exists)

| Finding (review) | Verdict | Task |
|---|---|---|
| Terminal `restart()` leaks `onData`/`onResize` handlers | net-new bug | T1.1 |
| Duplicate `pl-arrowhead` marker id across Planning boards | net-new bug | T1.2 |
| `DiagOverlay liveViews={0}` hardcoded (handoff salvage: "rewire liveViews") | under-delivered 2.0-C | T2.1 |
| `awaiting-input` state wired but never emitted | under-delivered 2.1 | T3.1, T3.2 |
| No UI to set `launchCommand` / pick shell / cwd | under-delivered 2.1 | T3.3 |
| Arrows/strokes can't be selected or deleted; notes/text delete hidden | enhancement (not in DESIGN) | T4.3 |
| No undo/redo | enhancement (not in DESIGN) | T4.1, T4.2 |
| `BrowserPreviewLayer` live-set logic untested (riskiest code) | test gap | T5.1 |
| `onNodesChange` store-translation untested | test gap | T5.2 |
| No runtime/E2E harness (Playwright `_electron` deferred plan) | test gap | T5.3 |
| Camera pan/zoom not in `CanvasDoc`; Phase 4 polish items | future-phase scope | T6.1 |

**Explicitly dropped (over-flagged in review, confirmed intentional):** schema `z` field (speced into 2.0-B for Phase-3 stacking) · `tool`/`setTool` (drives dock active-highlight per 2.0-D; click-to-place was never speced).

---

## File Structure

**New files**
- `src/renderer/src/store/history.ts` — pure undo/redo array helpers (T4.1).
- `src/renderer/src/store/history.test.ts` — its tests (T4.1).
- `src/renderer/src/store/previewStore.test.ts` — `patch`/`clear`/`selectLiveCount`/`selectRuntime` (T2.1, T5.1).
- `src/renderer/src/lib/previewPlan.ts` — pure "which boards stay live" decision extracted from `BrowserPreviewLayer` (T5.1).
- `src/renderer/src/lib/previewPlan.test.ts` — its tests (T5.1).
- `src/renderer/src/lib/nodeChanges.ts` — pure React-Flow-change → store-intent mapper (T5.2).
- `src/renderer/src/lib/nodeChanges.test.ts` — its tests (T5.2).
- `src/renderer/src/canvas/boards/TerminalConfig.tsx` — shell/launchCommand/cwd popover (T3.3).
- `playwright.config.ts` — Electron E2E config (T5.3).
- `e2e/app.smoke.spec.ts` — launch-and-add-board runtime smoke (T5.3).

**Modified files**
- `src/renderer/src/canvas/boards/terminalState.ts` (+ `.test.ts`) — `deriveDisplayState` heuristic (T3.1).
- `src/renderer/src/canvas/boards/TerminalBoard.tsx` — restart-leak fix (T1.1), activity wiring (T3.2), config button (T3.3).
- `src/renderer/src/canvas/boards/planning/svgPaths.ts` (+ `.test.ts`) — `arrowheadMarkerId` (T1.2).
- `src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx` — per-board marker id (T1.2), clickable/selectable paths (T4.3).
- `src/renderer/src/canvas/boards/PlanningBoard.tsx` — element selection + delete, undo checkpoints (T4.2, T4.3).
- `src/renderer/src/canvas/boards/planning/{NoteCard,FreeText,ChecklistCard}.tsx` — hover ✕ delete (T4.3).
- `src/renderer/src/store/canvasStore.ts` (+ `.test.ts`) — undo/redo + `beginChange` (T4.1).
- `src/renderer/src/canvas/Canvas.tsx` — `liveViews` wire (T2.1), undo keys + drag/resize checkpoints (T4.2), intent mapper (T5.2).
- `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx` — consume `previewPlan` (T5.1).
- `src/renderer/src/canvas/Icon.tsx` — add `settings` glyph (T3.3).
- `package.json` — Playwright + testing-library + jsdom devDeps; `test:e2e` script (T5.3).
- `docs/roadmap.md` — Phase 3/4 scope amendments (T6.1).
- `CLAUDE.md` — status + decisions (each task touching behaviour).

---

## Sequencing & dependencies

```
Phase 0  Live verification (gate; no code)
   │
Phase 1  Bug fixes        T1.1 ─┐  T1.2 ─┐      (independent; do both)
   │                            │        │
Phase 2  T2.1 liveViews ◄───────┘        │      (independent)
   │                                     │
Phase 3  T3.1 ► T3.2 ► T3.3  (sequential within phase)
   │
Phase 4  T4.1 ► T4.2 ; T4.3  (T4.2 needs T4.1; T4.3 independent of 4.1/4.2)
   │
Phase 5  T5.1 ; T5.2 ; T5.3  (independent; T5.3 needs a prior `pnpm build`)
   │
Phase 6  T6.1 docs (anytime; do last so it reflects what shipped)
```

Phases 1–2 are the safest, highest-value work — do them first. Phase 3 is the headline product gap. Phase 4 is opt-in polish. Phase 5 hardens. Phase 6 is documentation.

---

# Phase 0 — Live verification (GATE, no code)

**Why:** Phases 1/3/4 change board behaviour that has never been eyeballed running (static `capturePage` can't include the native `WebContentsView` layer). Record real breakage before coding so fixes target reality.

### Task 0.1: Live-exercise every board, record findings

**Files:** none (produces notes appended to `docs/handoffs/phase-2.md` under a new `## Live-verify (YYYY-MM-DD)` heading).

- [ ] **Step 1: Launch dev**

Run: `pnpm dev`
Expected: window opens to the empty state (watermark + 3 ghost buttons).

- [ ] **Step 2: Terminal board** — dock `+ Terminal`. Verify: shell spawns (prompt appears); type `echo hi` ⏎ (echoes); drag a corner to resize (xterm reflows, no clipped rows); click ⟳ restart (fresh prompt); after restart type again (**exactly one** character per keystroke — pre-confirms the T1.1 leak); ⤓ interrupt during a `ping`/long cmd (Ctrl-C lands); close board (no orphan process: Task Manager → no stray shell).

- [ ] **Step 3: Browser board** — start any localhost dev server first (e.g. `python -m http.server 5173`). Dock `+ Browser`, set URL bar to `http://localhost:5173` ⏎. Verify: native view paints **pixel-aligned inside** the HTML device frame at zoom 1.0 / 0.6 / 1.8; switch Mobile/Tablet/Desktop (true reflow at the breakpoint, not just a scale); pan/zoom (snapshot carries motion, no trailing native layer, swaps to LOD card < 40%); point URL at a dead port (shows **load-failed**, not "connected").

- [ ] **Step 4: Planning board** — dock `+ Planning`. Verify: note tool → click places a note **under the cursor** at zoom 1.0 AND at 1.8 (pen-mapping sanity); type in it; checklist tool → add/toggle items (progress bar moves); arrow + pen tools draw under the cursor at varying zoom; drag a note (follows cursor); resize the board.

- [ ] **Step 5: Record**

Append a dated `## Live-verify` section to `docs/handoffs/phase-2.md`: for each of T-board / B-board / P-board, one line `✅ works` or `❌ <what broke>`. This is the ground truth Phases 1/3/4 build on.

- [ ] **Step 6: Commit**

```bash
git add docs/handoffs/phase-2.md
git commit -m "docs: live-verify pass of Phase 2 boards (pre-remediation baseline)"
```

---

# Phase 1 — Bug fixes

## Task 1.1: Fix Terminal `restart()` listener accumulation

**Bug:** `TerminalBoard.spawn()` registers `term.onData`/`term.onResize` **inside** the persistent `onWinMsg` handler, capturing each port in a closure. `restart()` triggers a new `pty:port` message → `onWinMsg` fires again → another `onData`/`onResize` pair is added (xterm returns disposables that are never held). After N restarts, each keystroke fans out to N handlers. **Fix:** register the I/O wiring **once**, routing to `portRef.current` (the live port); `onWinMsg` only swaps the ref + message pump.

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx` (the `spawn` callback + its cleanup)

- [ ] **Step 1: Move `onData`/`onResize` out of `onWinMsg`, route via `portRef`**

In `spawn()`, replace the `onWinMsg` definition and its registration. **Before:**

```tsx
    const onWinMsg = (e: MessageEvent): void => {
      const data = e.data as { __ptyPort?: boolean; id?: string }
      if (!data || !data.__ptyPort || data.id !== board.id) return
      const port = e.ports[0]
      portRef.current = port
      port.onmessage = (ev): void => {
        const m = ev.data as PortMessage
        if (m.t === 'data' && m.d) term.write(m.d)
        else if (m.t === 'state' && m.state) setState(m.state)
        else if (m.t === 'exit') {
          setState('exited')
          term.write(`\r\n\x1b[90m[process exited: ${m.code ?? 0}]\x1b[0m\r\n`)
        }
      }
      port.start()
      term.onData((d) => port.postMessage({ t: 'input', d }))
      term.onResize(({ cols, rows }) => port.postMessage({ t: 'resize', cols, rows }))
    }
    window.addEventListener('message', onWinMsg)
```

**After:**

```tsx
    // Register terminal I/O ONCE; route to whatever port is live now. restart()
    // swaps portRef without re-binding these, so handlers never accumulate.
    const dataDisp = term.onData((d) => portRef.current?.postMessage({ t: 'input', d }))
    const resizeDisp = term.onResize(({ cols, rows }) =>
      portRef.current?.postMessage({ t: 'resize', cols, rows })
    )

    const onWinMsg = (e: MessageEvent): void => {
      const data = e.data as { __ptyPort?: boolean; id?: string }
      if (!data || !data.__ptyPort || data.id !== board.id) return
      const port = e.ports[0]
      portRef.current = port
      port.onmessage = (ev): void => {
        const m = ev.data as PortMessage
        if (m.t === 'data' && m.d) {
          lastDataRef.current = performance.now() // (T3.2 wires this; harmless now)
          term.write(m.d)
        } else if (m.t === 'state' && m.state) setState(m.state)
        else if (m.t === 'exit') {
          setState('exited')
          term.write(`\r\n\x1b[90m[process exited: ${m.code ?? 0}]\x1b[0m\r\n`)
        }
      }
      port.start()
    }
    window.addEventListener('message', onWinMsg)
```

> Note: `lastDataRef` is added in T3.2. If implementing T1.1 alone first, omit that one line; T3.2 re-adds it.

- [ ] **Step 2: Dispose the handlers in cleanup**

In the cleanup function returned by `spawn()`, add the two disposes (place right after `ro.disconnect()`):

```tsx
      ro.disconnect()
      dataDisp.dispose()
      resizeDisp.dispose()
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS (no unused-var error; both disposables are used in cleanup).

- [ ] **Step 4: Manual verify (no node-unit possible — needs a real PTY)**

Run: `pnpm dev` → add a Terminal → `restart` twice → type `abc`.
Expected: exactly `abc` appears (not `aaabbbccc`). A Playwright regression for this is added in T5.3.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "fix(terminal): register xterm onData/onResize once to stop handler buildup across restart"
```

---

## Task 1.2: Per-board arrowhead marker id

**Bug:** every `WhiteboardSvg` hard-codes `<marker id="pl-arrowhead">`. With ≥2 Planning boards the DOM has duplicate ids; `url(#pl-arrowhead)` resolves to the first, so a second board's arrowheads reference another board's marker. **Fix:** derive a per-board marker id.

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/svgPaths.ts` (add helper)
- Test: `src/renderer/src/canvas/boards/planning/svgPaths.test.ts` (add a case)
- Modify: `src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx` (consume helper + new prop)
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx` (pass `board.id`)

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/src/canvas/boards/planning/svgPaths.test.ts`:

```ts
import { arrowheadMarkerId } from './svgPaths'

describe('arrowheadMarkerId', () => {
  it('namespaces the marker id by board id', () => {
    expect(arrowheadMarkerId('abc')).toBe('pl-arrowhead-abc')
  })
  it('differs per board so duplicate DOM ids cannot collide', () => {
    expect(arrowheadMarkerId('a')).not.toBe(arrowheadMarkerId('b'))
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test svgPaths`
Expected: FAIL — `arrowheadMarkerId is not a function`.

- [ ] **Step 3: Implement the helper**

Append to `src/renderer/src/canvas/boards/planning/svgPaths.ts`:

```ts
/** Per-board SVG <marker> id so multiple Planning boards never share a DOM id. */
export function arrowheadMarkerId(boardId: string): string {
  return `pl-arrowhead-${boardId}`
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm test svgPaths`
Expected: PASS.

- [ ] **Step 5: Thread the id through `WhiteboardSvg`**

In `WhiteboardSvg.tsx`: add `boardId: string` to `WhiteboardSvgProps`, compute the id, and use it in the `<marker>` and both `markerEnd`s. Replace the import line and the `defs`/arrow markup:

```tsx
import { arrowPath, strokeToPath, arrowheadMarkerId } from './svgPaths'
```

Add `boardId` to the destructured props and compute:

```tsx
  const markerId = arrowheadMarkerId(boardId)
```

Replace `<marker id="pl-arrowhead" …>` with `<marker id={markerId} …>` and both occurrences of `markerEnd="url(#pl-arrowhead)"` with `markerEnd={`url(#${markerId})`}`.

- [ ] **Step 6: Pass `board.id` from `PlanningBoard`**

In `PlanningBoard.tsx`, the `<WhiteboardSvg …>` render, add the prop:

```tsx
        <WhiteboardSvg
          boardId={board.id}
          arrows={arrows}
          strokes={strokes}
          draftArrow={draftArrow}
          draftStroke={draftStroke}
        />
```

- [ ] **Step 7: Gate + commit**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: PASS.

```bash
git add src/renderer/src/canvas/boards/planning/svgPaths.ts src/renderer/src/canvas/boards/planning/svgPaths.test.ts src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -m "fix(planning): namespace arrowhead marker id per board to avoid duplicate DOM ids"
```

---

# Phase 2 — Complete 2.0-C (DiagOverlay live-view metric)

## Task 2.1: Wire `liveViews` from the preview store

**Gap:** the Phase-2 handoff salvage map says *"keep DiagOverlay (rewire `liveViews` to the real manager)"* — never done. `Canvas.tsx` passes `liveViews={0}`; `previewStore.selectLiveCount` was written for exactly this and is unused.

**Files:**
- Create: `src/renderer/src/store/previewStore.test.ts`
- Modify: `src/renderer/src/canvas/Canvas.tsx`

- [ ] **Step 1: Write the failing test (also satisfies part of T5.1)**

Create `src/renderer/src/store/previewStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { usePreviewStore, selectLiveCount, selectRuntime, DEFAULT_RUNTIME } from './previewStore'

beforeEach(() => usePreviewStore.setState({ byId: {} }))

describe('previewStore', () => {
  it('selectRuntime falls back to the idle default for an unknown id', () => {
    expect(selectRuntime('nope')(usePreviewStore.getState())).toEqual(DEFAULT_RUNTIME)
  })

  it('patch creates then shallow-merges an entry', () => {
    usePreviewStore.getState().patch('a', { status: 'connecting' })
    usePreviewStore.getState().patch('a', { live: true })
    const r = selectRuntime('a')(usePreviewStore.getState())
    expect(r.status).toBe('connecting')
    expect(r.live).toBe(true)
  })

  it('selectLiveCount counts only entries with live === true', () => {
    const { patch } = usePreviewStore.getState()
    patch('a', { live: true })
    patch('b', { live: false })
    patch('c', { live: true })
    expect(selectLiveCount(usePreviewStore.getState())).toBe(2)
  })

  it('clear removes an entry', () => {
    usePreviewStore.getState().patch('a', { live: true })
    usePreviewStore.getState().clear('a')
    expect(selectLiveCount(usePreviewStore.getState())).toBe(0)
  })
})
```

- [ ] **Step 2: Run it, verify it passes** (the store already implements this)

Run: `pnpm test previewStore`
Expected: PASS (4 tests). This locks the contract `Canvas` will consume.

- [ ] **Step 3: Wire the metric in `Canvas.tsx`**

Add imports near the other store imports:

```tsx
import { usePreviewStore, selectLiveCount } from '../store/previewStore'
```

Inside `CanvasInner`, add a subscription (near the other `useCanvasStore` selectors):

```tsx
  const liveViews = usePreviewStore(selectLiveCount)
```

Replace the diag render line `{diag && <DiagOverlay liveViews={0} />}` with:

```tsx
      {diag && <DiagOverlay liveViews={liveViews} />}
```

- [ ] **Step 4: Gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 5: Manual verify**

`pnpm dev` → toggle diag (Ctrl/⌘+Shift+D) → add 2 Browser boards on live URLs zoomed in.
Expected: `views` row reads `2` (was always `0`); drops as you zoom < 40% / exceed the 4-live cap.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/store/previewStore.test.ts src/renderer/src/canvas/Canvas.tsx
git commit -m "feat(diag): wire live-view count from previewStore (completes 2.0-C salvage)"
```

---

# Phase 3 — Complete 2.1 (Terminal: awaiting-input + config UI)

## Task 3.1: `deriveDisplayState` idle heuristic (pure)

**Gap:** 2.1 listed `awaiting-input` as a basic state; the state channel exists but nothing ever emits it (a PTY gives no portable "waiting for input" signal). Approximate it: a `running` terminal that has produced **no output for `AWAIT_IDLE_MS`** is displayed as `awaiting-input` (`--warn`); fresh output flips it back to `running`.

**Files:**
- Modify: `src/renderer/src/canvas/boards/terminalState.ts`
- Test: `src/renderer/src/canvas/boards/terminalState.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `terminalState.test.ts`:

```ts
import { deriveDisplayState, AWAIT_IDLE_MS } from './terminalState'

describe('deriveDisplayState', () => {
  it('keeps non-running states untouched', () => {
    expect(deriveDisplayState('exited', 0, 999_999)).toBe('exited')
    expect(deriveDisplayState('spawning', 0, 999_999)).toBe('spawning')
  })
  it('stays running while output is recent', () => {
    expect(deriveDisplayState('running', 1000, 1000 + AWAIT_IDLE_MS - 1)).toBe('running')
  })
  it('flips running → awaiting-input after the idle threshold', () => {
    expect(deriveDisplayState('running', 1000, 1000 + AWAIT_IDLE_MS)).toBe('awaiting-input')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test terminalState`
Expected: FAIL — `deriveDisplayState is not a function`.

- [ ] **Step 3: Implement**

Append to `terminalState.ts`:

```ts
/** Idle ms after which a running terminal is *displayed* as awaiting input. */
export const AWAIT_IDLE_MS = 2500

/**
 * A PTY exposes no portable "waiting for input" signal, so approximate it: a
 * `running` terminal idle (no output) for ≥ AWAIT_IDLE_MS is shown as
 * `awaiting-input`. Any non-running lifecycle state passes through unchanged.
 */
export function deriveDisplayState(
  state: TerminalState,
  lastDataAt: number,
  now: number
): TerminalState {
  if (state === 'running' && now - lastDataAt >= AWAIT_IDLE_MS) return 'awaiting-input'
  return state
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm test terminalState`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/terminalState.ts src/renderer/src/canvas/boards/terminalState.test.ts
git commit -m "feat(terminal): add deriveDisplayState idle→awaiting-input heuristic"
```

---

## Task 3.2: Wire activity tracking into the Terminal pill

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

- [ ] **Step 1: Add the imports + last-data ref**

Extend the existing `terminalState` import to include the new symbols:

```tsx
import {
  agentIdentity,
  brailleFrame,
  formatTimer,
  isRunning,
  statusFor,
  deriveDisplayState,
  type TerminalState
} from './terminalState'
```

Add a ref alongside the other refs in the component body:

```tsx
  const lastDataRef = useRef(0)
```

(If T1.1 already added `lastDataRef.current = performance.now()` in the port `onmessage`, leave it. Otherwise add that line to the `m.t === 'data'` branch now.)

- [ ] **Step 2: Add a slow tick while running and derive the display state**

Add a tick state + interval near the other `useEffect`s (after the spinner effect):

```tsx
  // Slow tick so the pill can flip to awaiting-input after an output lull.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setTick((t) => t + 1), 500)
    return () => window.clearInterval(id)
  }, [running])
```

Replace the existing `status` line:

```tsx
  const status = statusFor(state, identity, running ? formatTimer(elapsed) : undefined)
```

with:

```tsx
  const display = deriveDisplayState(state, lastDataRef.current, performance.now())
  const status = statusFor(display, identity, running ? formatTimer(elapsed) : undefined)
```

> `running`, the progress sliver, the spinner and the prompt stay keyed on the **lifecycle** `state` (a lull is not a process exit) — only the **pill** reflects `display`.

- [ ] **Step 3: Gate + manual verify**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: PASS.

`pnpm dev` → Terminal → wait ~3s at an idle prompt: pill dot turns `--warn` "awaiting input"; type a key → back to `--ok` running.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "feat(terminal): show awaiting-input after an output lull"
```

---

## Task 3.3: Terminal config popover (shell · launchCommand · cwd)

**Gap (🔴):** the bridge supports per-board `shell` / `launchCommand` / `cwd` (`pty.ts`, `pty:shells`) but no UI sets them — every Terminal is the default shell with no agent. Add a small popover: shell `<select>` (from `listShells()`), a `launchCommand` text field, and a `cwd` field. Applying patches the board; the existing `spawn` effect depends on `[board.id, board.shell, board.cwd, board.launchCommand]`, so a patch auto-respawns with the new config.

**Files:**
- Modify: `src/renderer/src/canvas/Icon.tsx` (add a `settings` glyph)
- Create: `src/renderer/src/canvas/boards/TerminalConfig.tsx`
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx` (config button + popover state)

- [ ] **Step 1: Add a `settings` icon**

In `Icon.tsx`, add `'settings'` to the `IconName` union (after `'trash'`) and add to `PATHS` (a single-path sliders glyph):

```ts
  | 'trash'
  | 'settings'
```

```ts
  trash: 'M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13',
  settings: 'M4 8h7M15 8h5M4 16h5M13 16h7M13 6v4M9 14v4'
```

- [ ] **Step 2: Create the popover component**

Create `src/renderer/src/canvas/boards/TerminalConfig.tsx`:

```tsx
/**
 * Terminal config popover (completes Phase 2.1's per-board shell selection).
 * Edits the board's durable `shell` / `launchCommand` / `cwd`; applying patches
 * the board in canvasStore, which re-runs TerminalBoard's spawn effect (its deps
 * include these fields) and respawns the session with the new config.
 *
 * `launchCommand` is free-text → ANY agentic CLI (e.g. `claude`, `codex`). It is
 * written as the first PTY line in pty.ts so the agent inherits PATH/profile/auth.
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { TerminalBoard as TerminalBoardData } from '../../lib/boardSchema'
import type { ShellInfo } from '../../../../preload'
import { useCanvasStore } from '../../store/canvasStore'

export function TerminalConfig({
  board,
  onClose
}: {
  board: TerminalBoardData
  onClose: () => void
}): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const [shells, setShells] = useState<ShellInfo[]>([])
  const [shell, setShell] = useState(board.shell ?? '')
  const [launchCommand, setLaunchCommand] = useState(board.launchCommand ?? '')
  const [cwd, setCwd] = useState(board.cwd ?? '')

  useEffect(() => {
    let live = true
    void window.api.listShells().then((list) => {
      if (!live) return
      setShells(list)
      if (!board.shell && list[0]) setShell(list[0].path)
    })
    return () => {
      live = false
    }
  }, [board.shell])

  const apply = (): void => {
    updateBoard(board.id, {
      shell: shell || undefined,
      launchCommand: launchCommand.trim() || undefined,
      cwd: cwd.trim() || undefined
    })
    onClose()
  }

  return (
    <div
      style={pop}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      <label style={lbl}>
        Shell
        <select style={fld} value={shell} onChange={(e) => setShell(e.target.value)}>
          {shells.map((s) => (
            <option key={s.path} value={s.path}>
              {s.label}
              {s.default ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label style={lbl}>
        Launch command
        <input
          style={fld}
          placeholder="e.g. claude  (blank = shell only)"
          spellCheck={false}
          value={launchCommand}
          onChange={(e) => setLaunchCommand(e.target.value)}
        />
      </label>
      <label style={lbl}>
        Working dir
        <input
          style={fld}
          placeholder="(blank = home)"
          spellCheck={false}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
        />
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 2 }}>
        <button style={btnGhost} onClick={onClose}>
          Cancel
        </button>
        <button style={btnPrimary} onClick={apply}>
          Apply &amp; restart
        </button>
      </div>
    </div>
  )
}

const pop: React.CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  zIndex: 5,
  width: 240,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 'var(--r-board)',
  background: 'var(--surface-raised)',
  border: '1px solid var(--border)',
  boxShadow: 'var(--shadow-pop)'
}
const lbl: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontFamily: 'var(--ui)',
  fontSize: 11,
  color: 'var(--text-3)'
}
const fld: React.CSSProperties = {
  height: 26,
  padding: '0 8px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 12,
  outline: 'none'
}
const btnGhost: React.CSSProperties = {
  height: 26,
  padding: '0 10px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-2)',
  fontSize: 12,
  cursor: 'pointer'
}
const btnPrimary: React.CSSProperties = {
  ...btnGhost,
  border: '1px solid var(--accent)',
  background: 'var(--accent-wash)',
  color: 'var(--accent)'
}
```

> The `ShellInfo` import path mirrors how the renderer already references preload types; if the project exposes preload types via a different alias, match the existing `window.api` typing (see `src/preload/index.d.ts`). Verify in Step 4.

- [ ] **Step 3: Add a config button + popover to `TerminalBoard`**

In `TerminalBoard.tsx`: import the popover and add open state.

```tsx
import { TerminalConfig } from './TerminalConfig'
```

Add state near the other `useState`s:

```tsx
  const [configOpen, setConfigOpen] = useState(false)
```

Add a config `IconBtn` to the `actions` block (left of play/pause):

```tsx
  const actions = (
    <>
      <IconBtn name="settings" title="Configure" onClick={() => setConfigOpen((v) => !v)} />
      <IconBtn name={live ? 'pause' : 'play'} title={live ? 'Pause' : 'Run'} onClick={toggleRun} />
      <IconBtn name="restart" title="Restart" onClick={restart} />
      <IconBtn name="stop" title="Interrupt (Ctrl-C)" danger onClick={interrupt} />
    </>
  )
```

Render the popover inside the `BoardFrame` content (first child of the `shell` div, so it overlays the screen):

```tsx
      <div style={shell}>
        {configOpen && <TerminalConfig board={board} onClose={() => setConfigOpen(false)} />}
        {/* …existing screenWrap / workingLine / prompt… */}
```

- [ ] **Step 4: Gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: PASS. (If the `ShellInfo` import errors, switch it to the type already surfaced by `window.api.listShells()`'s return — see `src/preload/index.d.ts` — and re-run.)

- [ ] **Step 5: Manual verify**

`pnpm dev` → Terminal → ⚙ → set Launch command `node -v` (or `claude` if installed), Apply.
Expected: terminal restarts, the command runs as the first line; identity pill shows the derived agent name (`node` / `claude`). Reopen ⚙ → pick a different shell → Apply → respawns in that shell.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/Icon.tsx src/renderer/src/canvas/boards/TerminalConfig.tsx src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "feat(terminal): per-board config popover for shell + launchCommand + cwd (completes 2.1)"
```

---

# Phase 4 — Enhancements (whiteboard delete + undo/redo)

## Task 4.1: Undo/redo history (pure module + store wiring)

**Design:** app-level history of the `boards` array. `beginChange()` snapshots the current boards onto a `past` stack (capped) at the **start of a discrete edit** (board add/remove, drag-start, resize-start, planning gesture-start, text-edit focus); the continuous mutators (`updateBoard`/`resizeBoard`) don't snapshot, so one gesture = one undo step.

**Files:**
- Create: `src/renderer/src/store/history.ts`
- Create: `src/renderer/src/store/history.test.ts`
- Modify: `src/renderer/src/store/canvasStore.ts`
- Modify: `src/renderer/src/store/canvasStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/store/history.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { recordPast, applyUndo, applyRedo } from './history'

describe('history helpers', () => {
  it('recordPast appends and caps at the limit', () => {
    expect(recordPast([1, 2], 3)).toEqual([1, 2, 3])
    expect(recordPast([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
  })
  it('applyUndo returns null when there is nothing to undo', () => {
    expect(applyUndo([], 'present', [])).toBeNull()
  })
  it('applyUndo moves present→future and pops past→present', () => {
    expect(applyUndo(['a', 'b'], 'c', [])).toEqual({ past: ['a'], present: 'b', future: ['c'] })
  })
  it('applyRedo returns null when there is nothing to redo', () => {
    expect(applyRedo([], 'present', [])).toBeNull()
  })
  it('applyRedo moves present→past and shifts future→present', () => {
    expect(applyRedo(['a'], 'b', ['c', 'd'])).toEqual({ past: ['a', 'b'], present: 'c', future: ['d'] })
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test history`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `history.ts`**

```ts
/**
 * Pure undo/redo helpers over plain arrays (no React/Zustand). The canvas store
 * holds `past: T[]`, `boards: T` (the present), `future: T[]`; these advance them.
 * Kept pure so the stack semantics are unit-tested in isolation.
 */
export const HISTORY_LIMIT = 50

/** Append `present` to `past`, keeping at most `limit` entries (oldest dropped). */
export function recordPast<T>(past: T[], present: T, limit = HISTORY_LIMIT): T[] {
  return [...past, present].slice(-limit)
}

/** Step back: pop past→present, push old present→future. null if past is empty. */
export function applyUndo<T>(
  past: T[],
  present: T,
  future: T[],
  limit = HISTORY_LIMIT
): { past: T[]; present: T; future: T[] } | null {
  if (past.length === 0) return null
  return {
    present: past[past.length - 1],
    past: past.slice(0, -1),
    future: [present, ...future].slice(0, limit)
  }
}

/** Step forward: shift future→present, push old present→past. null if future empty. */
export function applyRedo<T>(
  past: T[],
  present: T,
  future: T[],
  limit = HISTORY_LIMIT
): { past: T[]; present: T; future: T[] } | null {
  if (future.length === 0) return null
  return {
    present: future[0],
    future: future.slice(1),
    past: recordPast(past, present, limit)
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm test history`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire history into `canvasStore`**

In `canvasStore.ts`: add the import, the new state fields + actions, and snapshot in `addBoard`/`removeBoard`.

Import:

```ts
import { recordPast, applyUndo, applyRedo } from './history'
```

Add to the `CanvasState` interface:

```ts
  past: Board[][]
  future: Board[][]
  /** Snapshot the current boards for undo (call at the start of a discrete edit). */
  beginChange: () => void
  undo: () => void
  redo: () => void
```

Add to the initial state (after `tool: 'select',`):

```ts
  past: [],
  future: [],
```

Make `addBoard` and `removeBoard` snapshot first:

```ts
  addBoard: (type, at) => {
    const id = newId()
    const board = createBoard(type, { id, x: at.x, y: at.y })
    set((s) => ({
      past: recordPast(s.past, s.boards),
      future: [],
      boards: [...s.boards, board],
      selectedId: id
    }))
    return id
  },

  removeBoard: (id) =>
    set((s) => ({
      past: recordPast(s.past, s.boards),
      future: [],
      boards: s.boards.filter((b) => b.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId
    })),
```

Add the three new actions (next to `setTool`):

```ts
  beginChange: () => set((s) => ({ past: recordPast(s.past, s.boards), future: [] })),
  undo: () =>
    set((s) => {
      const r = applyUndo(s.past, s.boards, s.future)
      return r ? { boards: r.present, past: r.past, future: r.future, selectedId: null } : s
    }),
  redo: () =>
    set((s) => {
      const r = applyRedo(s.past, s.boards, s.future)
      return r ? { boards: r.present, past: r.past, future: r.future, selectedId: null } : s
    }),
```

- [ ] **Step 6: Add store tests**

Append to `canvasStore.test.ts` (match its existing reset pattern — reset `boards`, `selectedId`, **and** `past`/`future` in its `beforeEach`):

```ts
  it('undo reverts an add; redo re-applies it', () => {
    const s = useCanvasStore.getState()
    s.beginChange === undefined // no-op guard for readability
    useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    expect(useCanvasStore.getState().boards).toHaveLength(1)
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().boards).toHaveLength(0)
    useCanvasStore.getState().redo()
    expect(useCanvasStore.getState().boards).toHaveLength(1)
  })

  it('beginChange snapshots so a subsequent move can be undone', () => {
    const id = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    useCanvasStore.getState().beginChange()
    useCanvasStore.getState().updateBoard(id, { x: 200 })
    expect(useCanvasStore.getState().boards[0].x).toBe(200)
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().boards[0].x).toBe(0)
  })
```

> Update the file's `beforeEach`/reset to also clear `past: [], future: []` so tests don't bleed history.

- [ ] **Step 7: Gate + commit**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: PASS.

```bash
git add src/renderer/src/store/history.ts src/renderer/src/store/history.test.ts src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit -m "feat(store): app-level undo/redo history with beginChange checkpoints"
```

---

## Task 4.2: Wire undo checkpoints + keys

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx` (keys + drag/resize checkpoints)
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx` (gesture/edit checkpoints)

- [ ] **Step 1: Checkpoint on drag/resize start + add Undo/Redo keys in `Canvas.tsx`**

Add store selectors in `CanvasInner`:

```tsx
  const beginChange = useCanvasStore((s) => s.beginChange)
  const undo = useCanvasStore((s) => s.undo)
  const redo = useCanvasStore((s) => s.redo)
```

Add handlers and pass them to `<ReactFlow>`:

```tsx
  const onNodeDragStart = useCallback(() => beginChange(), [beginChange])
```

In the `<ReactFlow …>` props add:

```tsx
        onNodeDragStart={onNodeDragStart}
```

> Resize start: `NodeResizer` (in `BoardNode.tsx`) accepts `onResizeStart`. Add `onResizeStart={() => useCanvasStore.getState().beginChange()}` to the `<NodeResizer …>` element so a resize is one undo step.

In the `onKey` handler (the `useEffect` keydown), add undo/redo — guarding against typing into inputs so native text-undo still works:

```tsx
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (e.key === 'Escape') {
        clearSelection()
      } else if (e.key.toLowerCase() === 'd' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        setDiag((v) => !v)
      } else if (e.key === '1') {
        void rf.fitView(FIT_OPTIONS)
      } else if (e.key === '0') {
        void rf.zoomTo(1)
      }
    }
```

Update the effect dep array to include `undo, redo`.

- [ ] **Step 2: Checkpoint planning gestures/edits in `PlanningBoard.tsx`**

Add a selector:

```tsx
  const beginChange = useCanvasStore((s) => s.beginChange)
```

Call `beginChange()` at the start of each discrete edit (one snapshot per gesture):
- In `onWellPointerDown`, as the **first line** (covers note/check create, arrow/pen draw, and element move-start handled below).
- In `startElementDrag`, as the **first line** (before computing the offset).
- In `onWellDoubleClick`, before the `commit([...])`.
- In each element edit callback that should be undoable — wrap text-edit focus: pass `onFocus={() => beginChange()}` to the note/text/checklist `<textarea>`/`<input>` (see T4.3 components) so a contiguous typing burst is one undo step. (Add it where the components are rendered, via a new `onEditStart` prop, OR call `beginChange()` once on the first `onChange` of a focus — simplest is `onFocus`.)

> Keep it coarse: the goal is "Ctrl+Z reverses the last visible action," not keystroke-level undo.

- [ ] **Step 3: Gate + manual verify**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: PASS.

`pnpm dev`: add a board → Ctrl+Z removes it → Ctrl+Shift+Z re-adds. Drag a board → Ctrl+Z returns it. On a Planning board: draw a stroke → Ctrl+Z removes the stroke. Typing in a note + Ctrl+Z reverts the whole burst (and does NOT hijack while the caret is in the textarea — native text undo still works there).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx src/renderer/src/canvas/BoardNode.tsx src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -m "feat(canvas): undo/redo keys + drag/resize/planning checkpoints"
```

---

## Task 4.3: Whiteboard element selection + delete

**Gap:** committed arrows/strokes can't be selected or removed (`WhiteboardSvg` is `pointerEvents:none`); notes/text only delete via empty-text+Backspace (hidden). Add: clickable vector paths with a selection highlight, `Delete`/`Backspace` removal of the selected vector element (without deleting the board), and a hover ✕ on notes/text/checklist.

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx`
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx`
- Modify: `src/renderer/src/canvas/boards/planning/{NoteCard,FreeText,ChecklistCard}.tsx`

- [ ] **Step 1: Make vector paths selectable in `WhiteboardSvg`**

Add props `selectedId?: string | null` and `onSelect?: (id: string) => void`. For each committed arrow/stroke `<path>`, set `pointerEvents` so only the drawn pixels catch the click, raise stroke hit area, highlight when selected, and select on pointer-down:

For arrows, replace the committed-arrow `<path>` with:

```tsx
      {arrows.map((a) => (
        <path
          key={a.id}
          d={arrowPath(a)}
          stroke={a.id === selectedId ? 'var(--accent)' : 'var(--border-strong)'}
          strokeWidth={a.id === selectedId ? 2.5 : 1.5}
          fill="none"
          markerEnd={`url(#${markerId})`}
          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
          onPointerDown={(e) => {
            e.stopPropagation()
            onSelect?.(a.id)
          }}
        />
      ))}
```

For committed strokes, replace with:

```tsx
      {strokePaths.map((d, i) =>
        d ? (
          <path
            key={strokes[i].id}
            d={d}
            fill={strokes[i].id === selectedId ? 'var(--accent)' : 'var(--text-2)'}
            style={{ pointerEvents: 'auto', cursor: 'pointer' }}
            onPointerDown={(e) => {
              e.stopPropagation()
              onSelect?.(strokes[i].id)
            }}
          />
        ) : null
      )}
```

(The root `<svg>` keeps `pointerEvents:none`; only these paths opt back in, so empty space still routes to the well's draw/select handlers.)

- [ ] **Step 2: Selection state + delete-key in `PlanningBoard`**

Add state:

```tsx
  const [selectedElId, setSelectedElId] = useState<string | null>(null)
```

Pass to `WhiteboardSvg`:

```tsx
        <WhiteboardSvg
          boardId={board.id}
          arrows={arrows}
          strokes={strokes}
          draftArrow={draftArrow}
          draftStroke={draftStroke}
          selectedId={selectedElId}
          onSelect={setSelectedElId}
        />
```

Clear selection when the empty well is pressed — at the top of `onWellPointerDown`, after the `e.target !== e.currentTarget` guard:

```tsx
      setSelectedElId(null)
```

Add a `Delete`/`Backspace` handler on the well so a selected vector element is removed **without** bubbling to the canvas board-delete. Add `onKeyDown` + `tabIndex` to the well `<div>`:

```tsx
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElId) {
            e.stopPropagation()
            e.preventDefault()
            beginChange()
            commit(removeElement(elements, selectedElId))
            setSelectedElId(null)
          }
        }}
```

> Selecting a path focuses the well (pointer-down inside it). If focus isn't reliable, call `wellRef.current?.focus()` inside `onSelect`. Verify in Step 5.

- [ ] **Step 3: Hover ✕ on notes/text/checklist**

In `NoteCard.tsx`, `FreeText.tsx`, `ChecklistCard.tsx`: when `interactive`, render a small delete button that calls the existing `onDelete(id)`. Example for `NoteCard` (place as first child of the card `<div>`):

```tsx
      {interactive && (
        <button
          className="pl-del"
          title="Delete"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(note.id)
          }}
          style={{
            position: 'absolute',
            top: -8,
            right: -8,
            width: 18,
            height: 18,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 'var(--r-pill)',
            border: '1px solid var(--border)',
            background: 'var(--surface-raised)',
            color: 'var(--text-3)',
            cursor: 'pointer',
            opacity: 0,
            transition: 'opacity .1s'
          }}
        >
          <Icon name="x" size={11} />
        </button>
      )}
```

Add `import { Icon } from '../../Icon'` to each, and a CSS rule so it appears on hover. Append to `src/renderer/src/index.css`:

```css
.pl-note:hover .pl-del,
.pl-text:hover .pl-del,
.pl-check:hover .pl-del {
  opacity: 1;
}
```

`ChecklistCard` already calls a delete path? It doesn't receive `onDelete` today — add an `onDelete` prop to `ChecklistCardProps`, thread it from `PlanningBoard` (`onDelete={deleteEl}`), and render the same ✕ button (anchored to the card; `position:absolute` top/right). `FreeText` already takes `onDelete` — render the ✕ on its wrapper (`.pl-text`, which needs `position:relative` — add it to that div's style).

- [ ] **Step 4: Gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 5: Manual verify**

`pnpm dev` → Planning: draw an arrow + a pen stroke → click each (turns `--accent`) → press Delete (removed; board NOT deleted) → Ctrl+Z restores. Hover a note/text/checklist → ✕ appears top-right → click removes it.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/boards/planning src/renderer/src/canvas/boards/PlanningBoard.tsx src/renderer/src/index.css
git commit -m "feat(planning): select + delete arrows/strokes and hover-delete notes/text/checklist"
```

---

# Phase 5 — Integration tests + Playwright scaffold

## Task 5.1: Extract + test the preview live-set decision

**Why:** `BrowserPreviewLayer`'s `liveEligible` + `MAX_LIVE` slicing is the riskiest logic and is untested. It's pure given geometry (it uses `worldRectToScreen`, itself pure). Extract a tested decision module.

**Files:**
- Create: `src/renderer/src/lib/previewPlan.ts`
- Create: `src/renderer/src/lib/previewPlan.test.ts`
- Modify: `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/previewPlan.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isLiveEligible, pickLive, type LiveCandidate } from './previewPlan'

const at = (id: string, y: number): LiveCandidate => ({ id, screenY: y, w: 100, h: 100 })

describe('isLiveEligible', () => {
  it('rejects when below the LOD zoom', () => {
    expect(isLiveEligible({ zoom: 0.3, lod: 0.4, screenY: 0, paneTop: 0, w: 100, h: 100 })).toBe(false)
  })
  it('rejects a degenerate stage', () => {
    expect(isLiveEligible({ zoom: 1, lod: 0.4, screenY: 0, paneTop: 0, w: 1, h: 1 })).toBe(false)
  })
  it('rejects when the stage sits above the pane top', () => {
    expect(isLiveEligible({ zoom: 1, lod: 0.4, screenY: -5, paneTop: 0, w: 100, h: 100 })).toBe(false)
  })
  it('accepts an in-band, on-pane, sized stage', () => {
    expect(isLiveEligible({ zoom: 1, lod: 0.4, screenY: 10, paneTop: 0, w: 100, h: 100 })).toBe(true)
  })
})

describe('pickLive', () => {
  it('keeps at most `cap` candidates (first-come)', () => {
    expect(pickLive([at('a', 1), at('b', 2), at('c', 3)], 2)).toEqual(['a', 'b'])
  })
  it('returns all when under the cap', () => {
    expect(pickLive([at('a', 1)], 4)).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test previewPlan`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `previewPlan.ts`**

```ts
/**
 * Pure decision logic for which Browser boards may host a live native view,
 * extracted from BrowserPreviewLayer so the eligibility + cap rules are tested.
 * Geometry is pre-resolved to screen space by the caller (worldRectToScreen).
 */
export interface EligibilityInput {
  zoom: number
  lod: number
  /** Stage top in screen px (pane-local + offset). */
  screenY: number
  /** Pane top in screen px (a native view can't be clipped above the pane). */
  paneTop: number
  /** Stage size in screen px. */
  w: number
  h: number
}

export function isLiveEligible(i: EligibilityInput): boolean {
  if (i.zoom < i.lod) return false
  if (i.w <= 1 || i.h <= 1) return false
  return i.screenY >= i.paneTop
}

export interface LiveCandidate {
  id: string
  screenY: number
  w: number
  h: number
}

/** Cap the live set (first-come wins, matching the existing slice(0, MAX_LIVE)). */
export function pickLive(candidates: LiveCandidate[], cap: number): string[] {
  return candidates.slice(0, cap).map((c) => c.id)
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm test previewPlan`
Expected: PASS (6 tests).

- [ ] **Step 5: Refactor `BrowserPreviewLayer.liveEligible` to call `isLiveEligible`**

Replace the body of the `liveEligible` callback so the decision goes through the tested fn (geometry resolution stays in the layer):

```tsx
  const liveEligible = useCallback(
    (g: BoardGeom): boolean => {
      const vp = getViewport()
      const stage = deviceStageRect(g.w, g.h, g.viewport)
      const s = worldRectToScreen(toWorldRect(stage, g.x, g.y), vp, paneOffset.current)
      return isLiveEligible({
        zoom: vp.zoom,
        lod: LOD_ZOOM,
        screenY: s.y,
        paneTop: paneOffset.current.y,
        w: stage.width,
        h: stage.height
      })
    },
    [getViewport]
  )
```

Add the import:

```tsx
import { isLiveEligible } from '../../lib/previewPlan'
```

> Behaviour is identical to today; this just routes the rule through tested code. The `endMotion` `slice(0, MAX_LIVE)` can optionally be swapped for `pickLive` later — leave as-is to keep the diff small.

- [ ] **Step 6: Gate + commit**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: PASS.

```bash
git add src/renderer/src/lib/previewPlan.ts src/renderer/src/lib/previewPlan.test.ts src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx
git commit -m "test(preview): extract + unit-test live-eligibility decision from BrowserPreviewLayer"
```

---

## Task 5.2: Extract + test the React-Flow change → store-intent mapper

**Why:** `Canvas.onNodesChange` translates RF changes into store mutations; the translation is logic worth pinning. Extract it pure.

**Files:**
- Create: `src/renderer/src/lib/nodeChanges.ts`
- Create: `src/renderer/src/lib/nodeChanges.test.ts`
- Modify: `src/renderer/src/canvas/Canvas.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/nodeChanges.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { nodeChangesToIntents } from './nodeChanges'

describe('nodeChangesToIntents', () => {
  it('maps a position change to a move intent', () => {
    expect(
      nodeChangesToIntents([{ type: 'position', id: 'a', position: { x: 5, y: 6 } } as never])
    ).toEqual([{ kind: 'move', id: 'a', x: 5, y: 6 }])
  })
  it('maps a resizing dimensions change to a resize intent (ignores non-resizing)', () => {
    expect(
      nodeChangesToIntents([
        { type: 'dimensions', id: 'a', dimensions: { width: 300, height: 200 }, resizing: true } as never,
        { type: 'dimensions', id: 'b', dimensions: { width: 1, height: 1 }, resizing: false } as never
      ])
    ).toEqual([{ kind: 'resize', id: 'a', w: 300, h: 200 }])
  })
  it('maps select/deselect and remove', () => {
    expect(
      nodeChangesToIntents([
        { type: 'select', id: 'a', selected: true } as never,
        { type: 'remove', id: 'b' } as never
      ])
    ).toEqual([
      { kind: 'select', id: 'a' },
      { kind: 'remove', id: 'b' }
    ])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test nodeChanges`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `nodeChanges.ts`**

```ts
/**
 * Pure mapping of React Flow NodeChange[] → store intents, so Canvas.onNodesChange
 * is a thin apply loop and the translation rules are unit-tested. Mirrors the prior
 * inline logic: position→move, (resizing) dimensions→resize, select→select/deselect,
 * remove→remove. `select:false` yields a deselect intent the caller can fold.
 */
import type { NodeChange } from '@xyflow/react'

export type Intent =
  | { kind: 'move'; id: string; x: number; y: number }
  | { kind: 'resize'; id: string; w: number; h: number }
  | { kind: 'select'; id: string }
  | { kind: 'deselect'; id: string }
  | { kind: 'remove'; id: string }

export function nodeChangesToIntents(changes: NodeChange[]): Intent[] {
  const out: Intent[] = []
  for (const c of changes) {
    if (c.type === 'position' && c.position) {
      out.push({ kind: 'move', id: c.id, x: c.position.x, y: c.position.y })
    } else if (c.type === 'dimensions' && c.dimensions && c.resizing) {
      out.push({ kind: 'resize', id: c.id, w: c.dimensions.width, h: c.dimensions.height })
    } else if (c.type === 'select') {
      out.push(c.selected ? { kind: 'select', id: c.id } : { kind: 'deselect', id: c.id })
    } else if (c.type === 'remove') {
      out.push({ kind: 'remove', id: c.id })
    }
  }
  return out
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm test nodeChanges`
Expected: PASS.

- [ ] **Step 5: Use it in `Canvas.onNodesChange`**

Replace the body of `onNodesChange` to apply intents:

```tsx
  const onNodesChange = useCallback(
    (changes: NodeChange<BoardFlowNode>[]) => {
      let nextSel: string | null | undefined
      for (const intent of nodeChangesToIntents(changes)) {
        if (intent.kind === 'move') updateBoard(intent.id, { x: intent.x, y: intent.y })
        else if (intent.kind === 'resize') resizeBoard(intent.id, intent.w, intent.h)
        else if (intent.kind === 'select') nextSel = intent.id
        else if (intent.kind === 'deselect') {
          if (nextSel === undefined) nextSel = null
        } else if (intent.kind === 'remove') {
          removeBoard(intent.id)
          setFocusedId((f) => (f === intent.id ? null : f))
        }
      }
      if (nextSel !== undefined) selectBoard(nextSel)
    },
    [updateBoard, resizeBoard, removeBoard, selectBoard]
  )
```

Add the import:

```tsx
import { nodeChangesToIntents } from '../lib/nodeChanges'
```

- [ ] **Step 6: Gate + commit**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: PASS. Manual: drag/resize/select/delete still behave identically.

```bash
git add src/renderer/src/lib/nodeChanges.ts src/renderer/src/lib/nodeChanges.test.ts src/renderer/src/canvas/Canvas.tsx
git commit -m "test(canvas): extract + unit-test node-change → store-intent mapping"
```

---

## Task 5.3: Playwright `_electron` runtime smoke

**Why:** xterm I/O, native-view alignment, and the restart-leak regression can't be unit-tested in node. Stand up the deferred Playwright `_electron` harness (memory: "self-smoke-test plan") with one launch-and-add-board smoke. CI wiring is optional/local.

**Files:**
- Modify: `package.json` (devDeps + `test:e2e`)
- Create: `playwright.config.ts`
- Create: `e2e/app.smoke.spec.ts`

- [ ] **Step 1: Add deps + script**

Run:

```bash
pnpm add -D @playwright/test
```

In `package.json` `scripts`, add:

```json
    "test:e2e": "playwright test",
```

- [ ] **Step 2: Create `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test'

// Electron E2E: launches the BUILT app (out/main/index.js). Run `pnpm build` first.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list'
})
```

- [ ] **Step 3: Create `e2e/app.smoke.spec.ts`**

```ts
import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'

// Launches the built Electron app and drives the real renderer. Requires a prior
// `pnpm build` (main bundle at out/main/index.js).
test('app launches, shows empty state, and adds a Terminal board', async () => {
  const app = await electron.launch({ args: [join(__dirname, '..', 'out', 'main', 'index.js')] })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // Empty state present at 0 boards (DESIGN §8 "Empty canvas").
  await expect(win.getByText('Empty canvas')).toBeVisible({ timeout: 10_000 })

  // Dock "+ Terminal" adds a board → board count updates, titlebar appears.
  await win.getByRole('button', { name: /Terminal/ }).first().click()
  await expect(win.locator('.board-titlebar')).toHaveCount(1, { timeout: 10_000 })

  await app.close()
})
```

- [ ] **Step 4: Run it**

Run: `pnpm build && pnpm test:e2e`
Expected: 1 passed. (If the empty-state text or dock label differs, align the selectors to the actual DOM — `EmptyState.tsx` / `AppChrome.tsx` — and re-run.)

- [ ] **Step 5: Add a Terminal restart-leak regression (guards T1.1)**

Append to `e2e/app.smoke.spec.ts`:

```ts
test('terminal echoes one char per keystroke after two restarts (T1.1 guard)', async () => {
  const app = await electron.launch({ args: [join(__dirname, '..', 'out', 'main', 'index.js')] })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.getByRole('button', { name: /Terminal/ }).first().click()

  const restart = win.getByTitle('Restart')
  await restart.click()
  await restart.click()

  // Focus the terminal screen and type a marker.
  await win.locator('.xterm-screen').click()
  await win.keyboard.type('abc')

  // The xterm buffer should contain exactly one 'abc' run from our typing, not
  // tripled echoes. Assert the rendered text has no 'aaabbbccc'.
  const text = await win.locator('.xterm').innerText()
  expect(text).not.toContain('aaabbbccc')
  await app.close()
})
```

- [ ] **Step 6: Run + commit**

Run: `pnpm build && pnpm test:e2e`
Expected: 2 passed.

```bash
git add package.json pnpm-lock.yaml playwright.config.ts e2e/app.smoke.spec.ts
git commit -m "test(e2e): Playwright _electron runtime smoke + terminal restart-leak guard"
```

> Note: do NOT add `e2e/` to the Vitest `include`; they use different runners. Add `e2e/` and `playwright-report/`, `test-results/` to `.gitignore` if Playwright writes artifacts.

---

# Phase 6 — Amend the roadmap (future-phase findings)

## Task 6.1: Make Phase 3 camera-in-schema explicit + record Phase 4 polish items

**Why:** these findings are correctly owned by future phases but are only *implicit* today. Make them explicit so they're not forgotten when Phase 3/4 are planned.

**Files:**
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Add the camera-in-schema task to Phase 3**

Under Phase 3 → "Project create / open", add a bullet:

```markdown
- **Camera in the document:** add `viewport { x, y, zoom }` to `CanvasDoc` (bump `schemaVersion`
  + migration) so pan/zoom survives restart (the §3 acceptance criterion). Today `CanvasDoc`
  holds `boards` only — without this, reopen-fidelity for the camera is impossible.
```

- [ ] **Step 2: Add Phase 4 polish items**

Under Phase 4, add bullets:

```markdown
- **Terminal mid-run line-kinds** (DESIGN §7.1: tool-call `›`, file-edit `+/−`, working action text).
  NOTE the tension with the agent-agnostic stack — arbitrary CLI output isn't parseable; decide
  per-agent adapters vs raw passthrough before building.
- **Checklist scales with the board** (DESIGN §7.3) — today the card is a fixed 240px width.
- **Resize-handle + token drift** vs DESIGN §6 (handles 8×8 not 10×10; re-audit tokens).
- **Minimap** (DESIGN §8 "optional bottom-right").
```

- [ ] **Step 3: Note the dropped/clarified review items**

Add a short line under Phase 4 (or a "Review follow-ups" note):

```markdown
- Review follow-ups resolved: arrow/stroke delete + undo/redo shipped post-Phase-2
  (see `docs/superpowers/plans/2026-05-29-findings-remediation.md`); schema `z` and the dock
  `tool` state confirmed intentional (no change).
```

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): make Phase 3 camera-in-schema explicit; record Phase 4 polish items"
```

---

## Final: update CLAUDE.md status

- [ ] **Step 1:** Append a dated entry to `CLAUDE.md` → Status summarizing what shipped (bug fixes, awaiting-input, terminal config UI, undo/redo, whiteboard delete, preview/nodeChanges test extraction, Playwright harness) and the new test count.
- [ ] **Step 2:** Commit: `git commit -am "docs: CLAUDE.md status — post-review remediation complete"`

---

## Self-review (run before execution)

- **Spec coverage:** every review finding maps to a task (table at top) or is explicitly dropped with reason. ✓
- **Type consistency:** `arrowheadMarkerId(boardId)` (T1.2), `deriveDisplayState(state,lastDataAt,now)` + `AWAIT_IDLE_MS` (T3.1), `recordPast/applyUndo/applyRedo` (T4.1), `isLiveEligible/pickLive/LiveCandidate/EligibilityInput` (T5.1), `nodeChangesToIntents/Intent` (T5.2) — names used identically where consumed. ✓
- **No placeholders:** every code step shows the real code; every run step shows the command + expected result. ✓
- **Open risk to watch during execution:** (a) the `ShellInfo` import path in `TerminalConfig.tsx` (T3.3 Step 4 verifies); (b) well-focus for the planning Delete key (T4.3 Step 2 note); (c) Playwright selectors vs actual DOM (T5.3 Step 4 note). Each has an in-task fallback.
