# Browser Preview Camera-Sync Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Restore the Browser board's native `WebContentsView` camera tracking — it currently freezes on
pan/zoom while its HTML device frame moves — by removing a `useOnViewportChange` single-slot collision.

**Architecture:** React Flow's `useOnViewportChange` writes ONE store slot per callback (last-writer-wins,
not additive). Two call sites register it: `usePreviewManager` (native camera sync: `onStart`/`onChange`/
`onEnd`) and `Canvas` (autosave: `onChange` only). `Canvas` is the parent, so React commits its effect
LAST and clobbers all three preview slots (`onStart`/`onEnd` → `undefined`) — so on a camera move the
preview's detach + rAF reposition pump never fire. Fix: move `Canvas`'s autosave OFF `useOnViewportChange`
onto an **additive** React Flow store `transform` subscription (`useStoreApi().subscribe`), leaving
`usePreviewManager` the sole `useOnViewportChange` owner. Confirmed by a decisive live test (root-cause doc
§"INDEPENDENT RE-VERIFICATION").

**Tech Stack:** Electron 42 · React 18 · `@xyflow/react` 12.10.2 · Zustand · Playwright `_electron` e2e.

**Prereq reading:** `docs/research/2026-06-06-browser-preview-camera-sync-rootcause.md` (root cause +
verification). This plan implements its "Proposed fix · Option 1".

---

## Why Option 1 (and not 2 or 3)

- **Option 1 (chosen):** Canvas autosave → RF store `transform` subscription. Surgical (one hook), additive
  (no slot contention), keeps the exact autosave-on-pan cadence. `usePreviewManager` keeps owning
  `useOnViewportChange` — matches CLAUDE.md §"Browser preview" ("synced … via `useOnViewportChange`").
- **Option 2** (single fan-out owner in Canvas calling both autosave + preview begin/pump/end via refs):
  more plumbing, couples Canvas to the preview engine. Rejected as heavier.
- **Option 3** (drive the preview pump from a store-`transform` subscription instead of
  `useOnViewportChange` entirely): most robust — also covers instant programmatic camera sets
  (`rf.setViewport` `duration:0`) that don't fire `useOnViewportChange`. But a larger change to motion
  start/end (detach) detection. **Deferred as a follow-up hardening** (tracked at the end of this plan);
  in real use those instant sets are each followed by a store-path reconcile that repositions the native
  (root-cause doc §"Open questions" #4), so Option 1 fixes the reported bug fully.

## File structure (what changes)

| File | Change | Responsibility |
|---|---|---|
| `src/renderer/src/canvas/Canvas.tsx` | **Modify** | Replace the autosave `useOnViewportChange` (≈L671-676) with an additive RF store `transform` subscription; drop the now-unused `useOnViewportChange` import (L28). |
| `src/renderer/src/canvas/boards/usePreviewManager.ts` | **Modify** | Remove the TEMP `previewDebug` instrumentation (object L58-72 + 6 increment sites). The `useOnViewportChange` at L671 STAYS (now the sole owner). |
| `e2e/preview-align.e2e.ts` | **Rewrite** | Replace the 2 diagnostic tests with ONE hard-asserting regression test: real `sendInput` panOnScroll → native (`viewBounds`) tracks `.bb-frame` ≤2px at settled rest. Drops all `window.__previewDebug` reads. |
| `src/main/preview.ts` `debugViewBounds` · `src/main/e2eMain.ts` `viewBounds` | **Keep** | The regression test's measurement channel. Already on the branch. |

**No durable-contract change.** CLAUDE.md §"Browser preview" still holds (preview sync stays on
`useOnViewportChange`, now exclusively). No ADR needed.

---

## Task 1: Add the hard-asserting regression test (RED)

Write the regression test FIRST and watch it FAIL on the current (clobbered) code — that is the bug,
captured. It must NOT depend on `previewDebug` (removed in Task 3); it asserts only on `viewBounds`
(native, from main) vs the `.bb-frame` `getBoundingClientRect` (HTML), and only at **settled rest** (poll
until the native view is re-attached after the motion — mid-motion it is intentionally detached to a
snapshot, see root-cause doc).

**Files:**
- Rewrite: `e2e/preview-align.e2e.ts`

- [ ] **Step 1: Replace the spec with the regression test**

Overwrite `e2e/preview-align.e2e.ts` with:

```ts
/**
 * REGRESSION GUARD — the native WebContentsView must track its HTML `.bb-frame` after a REAL
 * camera pan. Guards the useOnViewportChange single-slot collision (Canvas autosave clobbering
 * usePreviewManager's camera sync) that froze the native view on pan/zoom.
 * See docs/research/2026-06-06-browser-preview-camera-sync-rootcause.md.
 *
 * MUST use real OS input (sendInput wheel = panOnScroll): programmatic panBy/setZoom use
 * duration:0 and do NOT fire useOnViewportChange. MUST assert at settled rest only — mid-motion
 * the view is intentionally detached to an HTML snapshot (detach+snapshot LOD), so the native
 * rect is stale until re-attach. Asserts on deterministic viewBounds (main getter), never
 * capturePage (memory: e2e-browser-trio-flake).
 *   pnpm build; pnpm exec playwright test e2e/preview-align.e2e.ts
 */
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

interface NativeBounds {
  attached: boolean
  bounds: { x: number; y: number; width: number; height: number }
}
interface FrameRect {
  left: number
  top: number
  width: number
  height: number
}

const runtimeStatus = (id: string, status: string): string =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`
const runtimeLive = (id: string): string =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.live === true; })()`
const frameRectExpr = (id: string): string =>
  `(() => { const el = document.querySelector('[data-bb-frame="${id}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`

const BORDER = 1
const TOLERANCE = 2 // px — native vs frame-inset at settled rest

test.describe('preview camera-sync regression', () => {
  test('native rect tracks the .bb-frame after a REAL panOnScroll', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    expect(await pollEval(page, runtimeStatus(id, 'connected'), 12_000)).toBe(true)
    await pollEval(page, runtimeLive(id), 8000)
    await page.waitForTimeout(600)

    // helper: native (main) + frame-inset (renderer) divergence, plus attached flag.
    async function divergence(): Promise<{ attached: boolean; maxAbs: number } | null> {
      const nb = await mainCall<NativeBounds | null>(electronApp, 'viewBounds', id)
      const fr = await evalIn<FrameRect | null>(page, frameRectExpr(id))
      if (!nb || !fr) return null
      const ex = {
        x: fr.left + BORDER,
        y: fr.top + BORDER,
        width: fr.width - BORDER * 2,
        height: fr.height - BORDER * 2
      }
      const maxAbs = Math.max(
        Math.abs(nb.bounds.x - ex.x),
        Math.abs(nb.bounds.y - ex.y),
        Math.abs(nb.bounds.width - ex.width),
        Math.abs(nb.bounds.height - ex.height)
      )
      return { attached: nb.attached, maxAbs }
    }

    // Sanity: at rest the native must be live and aligned with its frame.
    const rest = await divergence()
    expect(rest, 'measured a rest native rect').not.toBeNull()
    expect(rest!.attached, 'native view is live at rest').toBe(true)
    expect(rest!.maxAbs, `rest divergence ${rest!.maxAbs}px`).toBeLessThanOrEqual(TOLERANCE)

    // REAL panOnScroll (wheel over the empty left margin, clear of the device stage → the
    // canvas PANS; zoom needs Ctrl/Meta). Four steps to travel the frame well off its origin.
    for (let step = 0; step < 4; step++) {
      await mainCall(electronApp, 'sendInput', {
        type: 'mouseWheel',
        x: 60,
        y: 380,
        deltaX: 0,
        deltaY: -90
      })
      await page.waitForTimeout(120)
    }

    // Settle: the rAF pump self-stops after a few idle frames and endMotion re-attaches the
    // native view. Poll until the view is attached again AND aligned, then hard-assert.
    const settled = await expect
      .poll(
        async () => {
          const d = await divergence()
          return d && d.attached ? d.maxAbs : Number.POSITIVE_INFINITY
        },
        {
          message: 'native re-attaches and tracks the frame within 2px after the pan',
          timeout: 6000,
          intervals: [200, 200, 300, 500]
        }
      )
      .toBeLessThanOrEqual(TOLERANCE)
    void settled
  })
})
```

- [ ] **Step 2: Build, then run the test to confirm it FAILS (RED)**

Run:
```bash
cd "Z:\canvas-ade-preview-camera-sync"
pnpm build
pnpm exec playwright test e2e/preview-align.e2e.ts
```
Expected: **FAIL.** With the bug present the native rect is frozen ≈282px from the frame, so either the
rest-state assertion (`rest.maxAbs <= 2`) or the post-pan `expect.poll` times out at ∞. This proves the
test catches the bug. Note which assertion fails (likely the post-pan poll; the rest sanity may pass if the
board happened to live-attach at the fitted position, or may itself fail at ~282px — both are RED).

- [ ] **Step 3: Commit the RED test**

```bash
git add e2e/preview-align.e2e.ts
git commit -F - <<'EOF'
test(preview): hard-asserting camera-sync regression (RED)

Real sendInput panOnScroll → assert native viewBounds tracks .bb-frame
<=2px at settled rest. Fails on the useOnViewportChange clobber bug.
EOF
```

---

## Task 2: Move Canvas autosave off `useOnViewportChange` (GREEN)

Replace the colliding autosave hook with an additive RF store `transform` subscription, leaving
`usePreviewManager` the sole `useOnViewportChange` owner.

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx:28` (import) and `:671-676` (the autosave hook)

- [ ] **Step 1: Swap the import**

In `src/renderer/src/canvas/Canvas.tsx`, the React Flow import block (around L26-30) currently includes
`useOnViewportChange`. Remove `useOnViewportChange` and add `useStoreApi`. For example, change:

```ts
  ReactFlow,
  ReactFlowProvider,
  useOnViewportChange,
  useReactFlow,
```
to:
```ts
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
```
(Keep the rest of the import list intact; only swap these two names. If `useStoreApi` is already imported,
just delete `useOnViewportChange`.)

- [ ] **Step 2: Replace the autosave hook**

Replace the block at `Canvas.tsx:671-676`:

```ts
  // Capture the live camera into the (untracked) store so autosave persists it.
  // onChange fires on the rAF-coalesced camera updates React Flow emits — no new
  // pump, and writing setViewport won't pollute undo history.
  useOnViewportChange({
    onChange: (vp) => setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom })
  })
```

with:

```ts
  // Capture the live camera into the (untracked) store so autosave persists it.
  // NOT useOnViewportChange: that is a SINGLE-SLOT store field (last writer wins), and
  // usePreviewManager owns it for the native Browser-preview camera sync (onStart/onChange/
  // onEnd). A second useOnViewportChange here (Canvas is the parent → its effect commits
  // last) clobbered the preview's onStart/onEnd with undefined and froze every Browser
  // board's WebContentsView on pan/zoom. The RF store `transform` subscription is additive
  // (any number of subscribers) and fires at the same rAF-coalesced cadence; setViewport is
  // untracked (no undo) and L2-guards equal values (no autosave spam).
  // See docs/research/2026-06-06-browser-preview-camera-sync-rootcause.md.
  const storeApi = useStoreApi()
  useEffect(() => {
    let prev: readonly [number, number, number] | null = null
    return storeApi.subscribe((s) => {
      const t = s.transform
      if (prev && t[0] === prev[0] && t[1] === prev[1] && t[2] === prev[2]) return
      prev = t
      setViewport({ x: t[0], y: t[1], zoom: t[2] })
    })
  }, [storeApi, setViewport])
```

(`useEffect` is already imported in Canvas.tsx. `s.transform` is React Flow's `[x, y, zoom]` tuple.)

- [ ] **Step 3: Run the regression test to confirm it PASSES (GREEN)**

Run:
```bash
pnpm build
pnpm exec playwright test e2e/preview-align.e2e.ts
```
Expected: **PASS.** The preview manager's `onStart`/`onChange`/`onEnd` survive → on the real panOnScroll
the pump fires, the native detaches/repositions, and at settled rest the native tracks the `.bb-frame`
≤2px.

- [ ] **Step 4: Verify autosave persistence still works (manual confirm of root-cause Q3)**

Run:
```bash
pnpm exec playwright test e2e/preview-align.e2e.ts e2e/browser.e2e.ts
```
Expected: PASS. Also confirm no `setViewport`/persistence unit tests broke (Task 4 gate covers it). The
autosave writer subscribes to the same `viewport` store field the autosaver watches
(`useAutosave.ts:105`), so pan → `setViewport` (new value) → `viewport` identity change → debounced save,
exactly as before. Restore-on-open is unchanged (`Canvas.tsx:686-687` reads `viewport` from the store).

- [ ] **Step 5: Commit the fix**

```bash
git add src/renderer/src/canvas/Canvas.tsx
git commit -F - <<'EOF'
fix(preview): native view freezes on pan — drop useOnViewportChange clobber

Canvas autosave registered a 2nd useOnViewportChange; that store field is
single-slot (last writer wins) and Canvas (parent) committed last, wiping
usePreviewManager's onStart/onChange/onEnd → no detach + no reposition pump
on a camera move, so each Browser board's WebContentsView froze while its
HTML frame moved. Persist the camera via an additive RF store `transform`
subscription instead; usePreviewManager is now the sole useOnViewportChange
owner. Regression test now GREEN.
EOF
```

---

## Task 3: Remove the temporary `previewDebug` instrumentation

The diagnostic counters were scaffolding for the hunt. Remove them now (the regression test no longer reads
them). Keep the `viewBounds` main getter (`preview.ts`/`e2eMain.ts`) — that is the test's measurement
channel and stays.

**Files:**
- Modify: `src/renderer/src/canvas/boards/usePreviewManager.ts`

- [ ] **Step 1: Delete the `previewDebug` object + window publish (L58-72)**

Remove the entire block:

```ts
// TEMP DIAGNOSTIC (preview-align hunt) — counts camera-pump activity + the last viewport
// the pump computed bounds against, exposed for the alignment e2e probe. REMOVE after fix.
const previewDebug = {
  flushes: 0,
  pumps: 0,
  beginMotions: 0,
  endMotions: 0,
  lastVpX: 0,
  lastVpY: 0,
  lastVpZoom: 1,
  lastItems: 0
}
if (typeof window !== 'undefined') {
  ;(window as unknown as { __previewDebug?: typeof previewDebug }).__previewDebug = previewDebug
}
```

- [ ] **Step 2: Remove the 5 increment/assignment sites**

In `flushBatch` — replace:
```ts
  const flushBatch = useCallback((): boolean => {
    const _dbgVp = getViewport()
    previewDebug.flushes++
    previewDebug.lastVpX = _dbgVp.x
    previewDebug.lastVpY = _dbgVp.y
    previewDebug.lastVpZoom = _dbgVp.zoom
    const items: Array<{ id: string; bounds: Rect; zoomFactor: number }> = []
```
with:
```ts
  const flushBatch = useCallback((): boolean => {
    const items: Array<{ id: string; bounds: Rect; zoomFactor: number }> = []
```
and remove the `lastItems` line:
```ts
    previewDebug.lastItems = items.length
    if (!items.length) return false
```
→
```ts
    if (!items.length) return false
```
(`getViewport` is no longer used by `flushBatch` after dropping `_dbgVp`. Check whether `getViewport`
remains used elsewhere in the hook; if it is now unused, also drop it from the `useReactFlow()`
destructure at L157 and from the `flushBatch` dep array at L500. `pnpm lint` will flag it if missed.)

In `startPump` (the rAF `step`) — replace:
```ts
    const step = (): void => {
      previewDebug.pumps++
      idleRef.current = flushBatch() ? 0 : idleRef.current + 1
```
with:
```ts
    const step = (): void => {
      idleRef.current = flushBatch() ? 0 : idleRef.current + 1
```

In `beginMotion` — replace:
```ts
  const beginMotion = useCallback((): void => {
    previewDebug.beginMotions++
    startPump()
```
with:
```ts
  const beginMotion = useCallback((): void => {
    startPump()
```

In `endMotion` — replace:
```ts
  const endMotion = useCallback((): void => {
    previewDebug.endMotions++
    // Bug #2: endMotion is driven by BOTH the camera path (useOnViewportChange.onEnd)
```
with:
```ts
  const endMotion = useCallback((): void => {
    // Bug #2: endMotion is driven by BOTH the camera path (useOnViewportChange.onEnd)
```

- [ ] **Step 3: Confirm no stray references remain**

Run:
```bash
grep -rn "previewDebug\|__previewDebug" src e2e
```
Expected: **no output** (all references gone — the e2e spec was already rewritten in Task 1).

- [ ] **Step 4: Build + re-run the regression test (still GREEN)**

Run:
```bash
pnpm build
pnpm exec playwright test e2e/preview-align.e2e.ts
```
Expected: PASS (removing instrumentation changes no behavior).

- [ ] **Step 5: Commit the cleanup**

```bash
git add src/renderer/src/canvas/boards/usePreviewManager.ts
git commit -F - <<'EOF'
chore(preview): remove temporary previewDebug instrumentation

Hunt scaffolding; the camera-sync regression test asserts on viewBounds, not
the counters. viewBounds main getter stays as the test's measurement channel.
EOF
```

---

## Task 4: Full gate + e2e + finalize

**Files:** none (verification only).

- [ ] **Step 1: Run the full local gate**

Run (memory: `gate-must-run-format-check` — all four, prettier is separate from eslint):
```bash
cd "Z:\canvas-ade-preview-camera-sync"
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```
Expected: typecheck clean, lint 0 errors, format clean, all unit+integration green. If `format:check`
flags the edited files, run `pnpm format` and amend.

- [ ] **Step 2: Run the preview + browser e2e**

Run (memory: `e2e-before-handoff`):
```bash
pnpm exec playwright test e2e/preview-align.e2e.ts e2e/browser.e2e.ts
```
Expected: PASS. The `browser` trio can env-flake on `capturePage` (memory: `e2e-browser-trio-flake`) — if
`browser.e2e.ts` flakes, rerun once; `preview-align.e2e.ts` is deterministic (`viewBounds`) and must be
green first try.

- [ ] **Step 3: Confirm the tree is clean and the diff is the intended surface**

Run:
```bash
git status --short
git diff main --stat
```
Expected: only `Canvas.tsx`, `usePreviewManager.ts`, `e2e/preview-align.e2e.ts` changed beyond the
already-committed `preview.ts`/`e2eMain.ts` getter + docs. No `previewDebug` left; `viewBounds` kept.

- [ ] **Step 4: Update the coordination board + open the PR**

- Update this worktree's row in `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (status → "fix done,
  PR open"; note the one-line Canvas.tsx autosave change).
- Open the PR off `main` (this is fix work — never commit to `main`; promote via the sequential merge once
  green; rebrand #17 still merges last).

---

## Self-review

- **Spec coverage:** root-cause "Proposed fix · Option 1" → Task 2; "remove previewDebug, keep viewBounds +
  spec" → Task 3 (+ spec kept/rewritten Task 1); "convert diagnostic to hard-assert ≤2px after real
  panOnScroll, deterministic via viewBounds" → Task 1; open-question Q3 (autosave) → Task 2 Step 4; gate +
  e2e → Task 4. Covered.
- **Type consistency:** `viewBounds` returns `{ attached, bounds:{x,y,width,height} }` (used as
  `NativeBounds`); `s.transform` is `[number,number,number]`; `setViewport({x,y,zoom})` matches the store
  action signature (`canvasStore.test.ts`). Consistent.
- **No placeholders:** every code step shows the exact before/after. The only judgment call is whether
  `getViewport` becomes unused in `usePreviewManager` after Task 3 (lint will decide) — flagged inline.

## Risks

1. **`storeApi.subscribe` selector-less firing** — fires on every RF store change, not just `transform`.
   Mitigated: the listener diffs `transform` and early-returns on no-change, and `setViewport` L2-guards
   equal values regardless. Net cost ≈ one tuple compare per RF store notification. Negligible.
2. **Autosave cadence drift** — must keep triggering a save on pan. Mitigated: `setViewport(new value)`
   changes `viewport` identity → `useAutosave.ts:105` watcher fires → debounced save. Verified in Task 2
   Step 4. (If a future change makes `setViewport` skip identity change for new values, autosave-on-pan
   would silently stop — covered only by the manual reopen check; consider a unit test if that code moves.)
3. **`getViewport` dead-code in usePreviewManager** — after dropping `_dbgVp`, confirm it's still used (it
   is referenced elsewhere in the hook for live reads); if not, remove from the destructure + dep array.
4. **Programmatic instant camera (`rf.setViewport` duration:0) still doesn't pump** — out of scope for this
   fix (covered by store-path reconcile in real use; see follow-up below). Not a regression: behavior is
   unchanged from today for those paths.

## Follow-up (separate PR, not this one)

**Option 3 hardening** — drive the preview reposition pump from the RF store `transform` subscription too
(not only `useOnViewportChange`), so instant programmatic camera moves (`rf.setViewport` `duration:0`:
viewport restore on open, fit-on-load, tidy) also reposition the native without relying on a following
store-path reconcile. Larger change to motion start/end (detach) detection — design separately. Tracked in
root-cause doc §"Open questions" #4.
