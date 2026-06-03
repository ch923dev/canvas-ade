# M-digest T-D2 — Slide-in Digest Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** An auto slide-in side panel that, on project open, shows one card per board (the Tier-1
digest from T-D1) — the user-visible "instant context on reopen" win, with no LLM / no key.

**Architecture:** A presentational `DigestPanel` component (pure props → JSX, unit-tested) rendered by
`CanvasInner` in `Canvas.tsx`. The container holds `digestOpen` state, auto-opens it when
`project.status` becomes `'open'`, and feeds the panel `buildDigest(toObject())` from the store. The
panel is dismissible (✕) and re-openable (a small "Context" tab when closed). An e2e probe drives it
through the existing `window.__canvasE2E` hook and asserts the rendered cards match the boards.

**Tech Stack:** React 18 + TypeScript (strict), Zustand (`useCanvasStore`), Vitest +
`@testing-library/react`, the `CANVAS_SMOKE=e2e` Electron harness.

**Branch:** `feat/context-d2-panel` (off `feat/context`). **Worktree:** `Z:\canvas-ade-context`.

**Reference — integration points (from a code scan; do not re-derive):**
- Project-open signal: `src/renderer/src/store/canvasStore.ts` `applyOpenResult()` sets
  `project.status = 'open'`. `CanvasInner` already selects it: `Canvas.tsx:110`
  `const projectStatus = useCanvasStore((s) => s.project.status)`.
- Doc for the digest: the store exposes `toObject(): CanvasDoc` (`{schemaVersion, viewport, boards}`)
  and `boards: Board[]`.
- Mount: `CanvasInner` render tree in `Canvas.tsx` (the block that renders `<AppChrome … />`).
- e2e host hooks: `Canvas.tsx` calls `installE2EHooks(rf, { setFullView, openFullViewAnimated,
  closeFullViewAnimated, setFocus })`; the hook API lives in `src/renderer/src/smoke/e2eHooks.ts`
  (`window.__canvasE2E`, incl. `seedBoard(type, patch?)`, `getBoards()`).
- e2e probes: `src/main/e2e/probes/*.ts` export an `E2EProbe` (`{ name, run(ctx) }` → `{ name, ok,
  detail }`); registered in the PLAYLIST array in `src/main/e2e/index.ts`. `ctx.evalIn`, `ctx.poll`.
- Tokens: `src/renderer/src/index.css` (`--surface`, `--surface-raised`, `--border`, `--border-subtle`,
  `--text`, `--text-2`, `--text-3`, `--accent`, `--ok`, `--r-board`, `--r-inner`, `--shadow-board`,
  `--space-*`, `--fs-*`, `--ui`, `--mono`).

**Scope:** T-D2 only (the panel + wiring + e2e). The LLM brain (M-brain) and `.canvas/` memory
(M-memory) are later. The panel renders **Tier-1** prose only; the T-M4 upgrade to cached Tier-2 prose
is out of scope here.

---

### Task 1: `DigestPanel` presentational component + unit tests

**Files:**
- Create: `src/renderer/src/canvas/DigestPanel.tsx`
- Test: `src/renderer/src/canvas/DigestPanel.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/canvas/DigestPanel.test.tsx`:

```tsx
import { it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DigestPanel } from './DigestPanel'
import { buildDigest } from '../lib/digest'
import type { CanvasDoc } from '../lib/boardSchema'

const DOC: CanvasDoc = {
  schemaVersion: 2,
  viewport: null,
  boards: [
    { id: 't1', type: 'terminal', x: 0, y: 0, w: 420, h: 340, title: 'Dev server', launchCommand: 'pnpm dev', port: 5173 },
    { id: 'b1', type: 'browser', x: 0, y: 0, w: 700, h: 500, title: 'Preview', url: 'http://localhost:5173', viewport: 'desktop', previewSourceId: 't1' },
    {
      id: 'p1', type: 'planning', x: 0, y: 0, w: 516, h: 366, title: 'Plan',
      elements: [
        { kind: 'checklist', id: 'c1', x: 0, y: 0, w: 240, h: 0, title: 'Auth', items: [
          { id: 'i1', label: 'a', done: true },
          { id: 'i2', label: 'b', done: false }
        ] }
      ]
    }
  ]
}
const EMPTY: CanvasDoc = { schemaVersion: 2, viewport: null, boards: [] }

it('renders one card per board with title, status and lines', () => {
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open onOpen={() => {}} onClose={() => {}} />
  )
  expect(container.querySelectorAll('[data-test=digest-card]')).toHaveLength(3)
  expect(screen.getByText('3 boards — 1 terminal, 1 browser, 1 planning')).toBeTruthy()
  expect(screen.getByText('Dev server')).toBeTruthy()
  expect(screen.getByText('Runs `pnpm dev`')).toBeTruthy()
  expect(screen.getByText('Auth: 1/2 done')).toBeTruthy()
})

it('marks the panel open and renders no reopen tab when open', () => {
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open onOpen={() => {}} onClose={() => {}} />
  )
  expect(container.querySelector('[data-test=digest-panel]')!.getAttribute('data-open')).toBe('true')
  expect(container.querySelector('[data-test=digest-reopen]')).toBeNull()
})

it('hides the panel and shows a reopen tab when closed', () => {
  const onOpen = vi.fn()
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open={false} onOpen={onOpen} onClose={() => {}} />
  )
  expect(container.querySelector('[data-test=digest-panel]')!.getAttribute('data-open')).toBe('false')
  const reopen = container.querySelector('[data-test=digest-reopen]') as HTMLButtonElement
  expect(reopen).toBeTruthy()
  reopen.click()
  expect(onOpen).toHaveBeenCalledTimes(1)
})

it('calls onClose when the dismiss button is clicked', () => {
  const onClose = vi.fn()
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open onOpen={() => {}} onClose={onClose} />
  )
  ;(container.querySelector('[data-test=digest-close]') as HTMLButtonElement).click()
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('handles an empty canvas', () => {
  const { container } = render(
    <DigestPanel digest={buildDigest(EMPTY)} open onOpen={() => {}} onClose={() => {}} />
  )
  expect(container.querySelectorAll('[data-test=digest-card]')).toHaveLength(0)
  expect(screen.getByText('0 boards — 0 terminal, 0 browser, 0 planning')).toBeTruthy()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/renderer/src/canvas/DigestPanel.test.tsx`
Expected: FAIL — `Failed to resolve import "./DigestPanel"`.

- [ ] **Step 3: Write the component**

Create `src/renderer/src/canvas/DigestPanel.tsx`:

```tsx
/**
 * Tier-1 reopen digest panel (presentational). Renders the CanvasDigest from
 * `buildDigest` (T-D1) as an auto slide-in side panel of per-board cards. Pure: all
 * state (open/closed) is owned by the container in Canvas.tsx. No LLM / no key — this
 * is the no-cost reopen context. The T-M4 milestone later swaps in cached Tier-2 prose.
 */
import type { JSX } from 'react'
import type { CanvasDigest } from '../lib/digest'

const TYPE_TAG: Record<string, string> = {
  terminal: 'TERM',
  browser: 'WEB',
  planning: 'PLAN'
}

export interface DigestPanelProps {
  digest: CanvasDigest
  open: boolean
  onOpen: () => void
  onClose: () => void
}

export function DigestPanel({ digest, open, onOpen, onClose }: DigestPanelProps): JSX.Element {
  return (
    <>
      {!open && (
        <button
          type="button"
          className="digest-reopen"
          data-test="digest-reopen"
          onClick={onOpen}
          title="Show project context"
        >
          Context
        </button>
      )}
      <aside className="digest-panel" data-test="digest-panel" data-open={open} aria-hidden={!open}>
        <header className="digest-head">
          <span className="digest-head-title">Project context</span>
          <button
            type="button"
            className="digest-close"
            data-test="digest-close"
            onClick={onClose}
            aria-label="Dismiss context panel"
          >
            ✕
          </button>
        </header>
        <p className="digest-sub">{digest.header}</p>
        <div className="digest-list">
          {digest.boards.map((b) => (
            <article key={b.boardId} className="digest-card" data-test="digest-card">
              <div className="digest-card-top">
                <span className="digest-tag">{TYPE_TAG[b.type] ?? b.type.toUpperCase()}</span>
                <span className="digest-card-title">{b.title}</span>
                <span className="digest-status" data-status={b.status}>
                  {b.status}
                </span>
              </div>
              <ul className="digest-lines">
                {b.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </aside>
    </>
  )
}
```

> If TypeScript errors on `import type { JSX } from 'react'`, use `import { type JSX } from 'react'` or
> drop the explicit return type and let it infer — match whatever the neighbouring components do
> (check `FullViewModal.tsx`'s signature).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/renderer/src/canvas/DigestPanel.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/DigestPanel.tsx src/renderer/src/canvas/DigestPanel.test.tsx
git commit -m "feat(context): DigestPanel presentational component (T-D2)"
```

---

### Task 2: Panel styles + container wiring

**Files:**
- Modify: `src/renderer/src/index.css` (append a `.digest-*` block)
- Modify: `src/renderer/src/canvas/Canvas.tsx` (state + auto-open + render + e2e host hook)

- [ ] **Step 1: Append the panel styles**

Append to `src/renderer/src/index.css` (uses existing tokens; honours reduced-motion):

```css
/* ── Digest panel (Tier-1 reopen context) ───────────────────────────────────── */
.digest-panel {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: 300px;
  z-index: 70;
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  padding: var(--space-12);
  background: var(--surface);
  border-right: 1px solid var(--border);
  color: var(--text);
  font-family: var(--ui);
  font-size: var(--fs-body);
  overflow-y: auto;
  transform: translateX(0);
  transition: transform 200ms ease;
}
.digest-panel[data-open='false'] {
  transform: translateX(-100%);
}
.digest-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.digest-head-title {
  font-size: var(--fs-label);
  font-weight: var(--fw-label);
  color: var(--text);
}
.digest-close {
  background: transparent;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: var(--space-4);
}
.digest-close:hover {
  color: var(--text);
}
.digest-sub {
  margin: 0;
  color: var(--text-2);
  font-size: var(--fs-label);
}
.digest-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
.digest-card {
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-inner);
  padding: var(--space-12);
}
.digest-card-top {
  display: flex;
  align-items: baseline;
  gap: var(--space-8);
}
.digest-tag {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.digest-card-title {
  flex: 1;
  font-weight: var(--fw-label);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.digest-status {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-2);
}
.digest-status[data-status='ready'] {
  color: var(--ok);
}
.digest-status[data-status='linked'] {
  color: var(--accent);
}
.digest-lines {
  margin: var(--space-8) 0 0;
  padding-left: var(--space-16);
  color: var(--text-2);
  font-size: var(--fs-label);
}
.digest-lines li {
  margin-bottom: var(--space-4);
}
.digest-reopen {
  position: fixed;
  top: 50%;
  left: 0;
  transform: translateY(-50%);
  z-index: 70;
  writing-mode: vertical-rl;
  padding: var(--space-12) var(--space-4);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-left: none;
  border-radius: 0 var(--r-inner) var(--r-inner) 0;
  color: var(--text-2);
  font-family: var(--ui);
  font-size: var(--fs-label);
  cursor: pointer;
}
.digest-reopen:hover {
  color: var(--text);
}
@media (prefers-reduced-motion: reduce) {
  .digest-panel {
    transition: none;
  }
}
```

- [ ] **Step 2: Wire the container in `Canvas.tsx`**

Make these edits inside `CanvasInner`:

1. Add the import near the other `./` component imports (e.g. beside `AppChrome` / `FullViewModal`):
```tsx
import { DigestPanel } from './DigestPanel'
import { buildDigest } from '../lib/digest'
```
Ensure `useMemo` and `useState` are in the existing `react` import (add if missing).

2. Add store selectors near the existing `projectStatus` selector (`Canvas.tsx:110`). `projectStatus`
   is already selected — add:
```tsx
const boards = useCanvasStore((s) => s.boards)
const toObject = useCanvasStore((s) => s.toObject)
```
> If `boards` is already selected in `CanvasInner`, reuse it — do not add a duplicate selector.

3. Add panel state + auto-open effect + memoized digest (place with the other `useState`/`useEffect`
   hooks in `CanvasInner`):
```tsx
const [digestOpen, setDigestOpen] = useState(false)
useEffect(() => {
  if (projectStatus === 'open') setDigestOpen(true)
}, [projectStatus])
const digest = useMemo(() => buildDigest(toObject()), [toObject, boards])
```

4. Render the panel as a sibling of `<AppChrome … />` (just after it):
```tsx
<DigestPanel
  digest={digest}
  open={digestOpen}
  onOpen={() => setDigestOpen(true)}
  onClose={() => setDigestOpen(false)}
/>
```

5. Expose the open/close to the e2e harness. Find the `installE2EHooks(rf, { … })` call and add
   `setDigestOpen` to the host object:
```tsx
installE2EHooks(rf, {
  setFullView: setFullViewId,
  openFullViewAnimated: openFullView,
  closeFullViewAnimated: closeFullView,
  setFocus: setFocusedId,
  setDigestOpen
})
```
> Match the EXACT property names already in that object (the ones above are from the scan — verify
> against the real call and only ADD `setDigestOpen`). If `installE2EHooks` is in a `useEffect` whose
> deps list those handlers, add `setDigestOpen` to the deps too (it is a stable `useState` setter, so
> this is just lint-correctness).

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean. (No unit test here — the wiring is exercised by the e2e probe in Task 3 + manual.)
If `format:check` would flag your touched files, run
`pnpm exec prettier --write src/renderer/src/index.css src/renderer/src/canvas/Canvas.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/index.css src/renderer/src/canvas/Canvas.tsx
git commit -m "feat(context): wire digest panel into the canvas — auto-open on project open"
```

---

### Task 3: e2e hook + probe

**Files:**
- Modify: `src/renderer/src/smoke/e2eHooks.ts` (add `setDigestOpen` to host type; add `openDigest`/`closeDigest` to the API)
- Create: `src/main/e2e/probes/context.ts`
- Modify: `src/main/e2e/index.ts` (register the probe in the PLAYLIST)

- [ ] **Step 1: Extend the e2e hooks**

In `src/renderer/src/smoke/e2eHooks.ts`:

1. Add `setDigestOpen` to the `E2EHostHooks` interface (the type of the `host` arg of
   `installE2EHooks`):
```ts
setDigestOpen(open: boolean): void
```

2. Add two methods to the `CanvasE2E` interface AND its implementation `api` object:
```ts
// interface
openDigest(): void
closeDigest(): void
```
```ts
// in the api object
openDigest() {
  host.setDigestOpen(true)
},
closeDigest() {
  host.setDigestOpen(false)
},
```
> Match the file's existing method style (the scan shows plain method shorthand on the `api` object).

- [ ] **Step 2: Create the probe**

Create `src/main/e2e/probes/context.ts`:

```ts
import type { E2EProbe } from '../types'

/**
 * T-D2: the Tier-1 reopen digest panel. Seeds one board of each type, opens the panel
 * via the e2e hook, and asserts the rendered cards match the boards AND a card reflects
 * real board data (the terminal's launchCommand line). No LLM involved (Tier-1).
 */
export const context: E2EProbe = {
  name: 'context-digest',
  async run(ctx) {
    await ctx.evalIn<string>(
      "window.__canvasE2E.seedBoard('terminal', { launchCommand: 'pnpm dev' })"
    )
    await ctx.evalIn<string>("window.__canvasE2E.seedBoard('browser')")
    await ctx.evalIn<string>("window.__canvasE2E.seedBoard('planning')")
    await ctx.evalIn('window.__canvasE2E.openDigest()')

    const open = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          "!!document.querySelector('[data-test=digest-panel][data-open=true]')"
        ),
      4000
    )
    const cards = await ctx.evalIn<number>(
      "document.querySelectorAll('[data-test=digest-card]').length"
    )
    const boards = await ctx.evalIn<number>('window.__canvasE2E.getBoards().length')
    const hasCmd = await ctx.evalIn<boolean>(
      "Array.from(document.querySelectorAll('[data-test=digest-card]')).some((c) => c.textContent.includes('Runs `pnpm dev`'))"
    )

    return {
      name: 'context-digest',
      ok: open && cards === boards && cards >= 3 && hasCmd,
      detail: `open=${open} cards=${cards} boards=${boards} cmd=${hasCmd}`
    }
  }
}
```
> Verify the exact import path + the `E2EProbe` result shape against an existing probe
> (`src/main/e2e/probes/planning.ts`) and adjust if the type lives elsewhere (e.g. `../context` vs
> `../types`). Verify `seedBoard` accepts a second patch arg (the scan shows `seedBoard(type, patch)`).

- [ ] **Step 3: Register the probe**

In `src/main/e2e/index.ts`, import `context` and add it to the PLAYLIST array (place it after
`planning` so boards already exist in a known order — but it seeds its own, so order is not critical):
```ts
import { context } from './probes/context'
// …in the playlist array:
  context,
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm typecheck`  → clean.
```bash
git add src/renderer/src/smoke/e2eHooks.ts src/main/e2e/probes/context.ts src/main/e2e/index.ts
git commit -m "test(context): e2e probe + hooks for the digest panel"
```

---

### Task 4: Full gate + e2e run + handoff

**Files:**
- Create: `docs/superpowers/handoffs/2026-06-03-context-d2-panel.md`

- [ ] **Step 1: Full gate**

Run from `Z:\canvas-ade-context`:
`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all green; `DigestPanel.test.tsx` (5 tests) included.

- [ ] **Step 2: Build + e2e harness** (the standing requirement — unit-green ≠ working)

Run (PowerShell, from `Z:\canvas-ade-context`):
```
pnpm build
$env:CANVAS_SMOKE='e2e'; pnpm start
```
Expected: `E2E_DONE ok:true` (exit 0); the new `context-digest` part reports
`ok` with `open=true cards=3 boards=3 cmd=true`. The known browser-trio env flake may appear —
re-run for a clean pass (memory `e2e-browser-trio-flake`); it is not a regression.

- [ ] **Step 3: Manual test**

1. `pnpm dev`, open a real project that has a terminal (with a launchCommand) + a browser + a planning
   board with a checklist.
2. On open → the panel slides in from the left with one card per board; the terminal card shows
   `` Runs `…` `` + port; the browser card shows its URL + `Preview of "…"`; the planning card shows
   `done/total`.
3. Click ✕ → panel slides out, a vertical "Context" tab remains at the left edge.
4. Click the "Context" tab → panel slides back in.
5. Switch to another project → the panel re-opens with that project's boards.

- [ ] **Step 4: Write the handoff**

Create `docs/superpowers/handoffs/2026-06-03-context-d2-panel.md`: what landed (DigestPanel + wiring +
e2e), files, test evidence (5 unit + `context-digest` e2e + gate), the prop contract
(`DigestPanelProps`), the `data-test` hooks (`digest-panel`/`digest-card`/`digest-close`/`digest-reopen`),
follow-ups (the auto-open-on-real-project-open path is covered by manual + the e2e opens via hook;
T-M4 will swap Tier-1 lines for cached Tier-2 prose), and the next-task pointer (**M-brain T-B1** —
provider-agnostic LLM adapter; or open the **M-digest milestone PR** `feat/context` → `main`).

- [ ] **Step 5: Commit + coordination note**

```bash
git add docs/superpowers/handoffs/2026-06-03-context-d2-panel.md
git commit -m "docs(context): T-D2 handoff — slide-in digest panel"
```
Update the `canvas-ade-context` row Notes on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md`:
"T-D2 done — DigestPanel + e2e (context-digest). M-digest complete; ready for the milestone PR."

---

## Self-Review

**Spec coverage (design §5.4 + roadmap M-digest T-D2):**
- auto slide-in side panel on project open ✓ (Task 2 effect on `projectStatus === 'open'`)
- one card per board, title + status + lines ✓ (Task 1 component; Task 1 tests assert per-board cards)
- dismissible + re-openable ✓ (Task 1 ✕ + reopen tab; tested)
- renders Tier-1 digest, no LLM call ✓ (`buildDigest(toObject())`, no provider import)
- e2e probe asserting the panel mounts with correct cards ✓ (Task 3 `context-digest`, asserts
  cards===boards AND a card shows real board data)
- manual test with explicit steps ✓ (Task 4 Step 3)

**Placeholder scan:** none — concrete code + commands throughout. The two "verify against the real
file" notes (Canvas.tsx host-object property names; the `E2EProbe` import path) are guardrails for
known-fragile anchors, not deferred work.

**Type consistency:** `DigestPanelProps` (`digest,open,onOpen,onClose`) is identical across the
component, its tests, and the Canvas.tsx render site. `data-test` ids (`digest-panel`, `digest-card`,
`digest-close`, `digest-reopen`) match between the component, the unit tests, and the e2e probe.
`setDigestOpen` / `openDigest` / `closeDigest` names are consistent across Canvas.tsx, e2eHooks.ts, and
the probe. `buildDigest` / `CanvasDigest` / `CanvasDoc` come from T-D1 unchanged.

**Note:** Tasks 2 and 3 carry no unit tests (container wiring + e2e plumbing are integration concerns);
they are covered by the `context-digest` e2e probe + the manual test, per the standing e2e requirement.
```

