# Context T-M4 — Cached Tier-2 Prose on Reopen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is TDD: red → green → commit.

**Goal:** On project open, the Context panel renders the cached Tier-2 prose from `<project>/.canvas/memory/board-<id>.md` when present, else falls back to the Tier-1 heuristic digest — a pure disk read, **no LLM call on open**.

**Architecture:** A new guarded MAIN handler `memory:readBoards(ids) → Record<id, rawMarkdown>` folded into `registerProjectHandlers` (reuses the foreign-sender guard + current-dir + the already-imported `canvasMemory`, so `index.ts` stays untouched and avoids the `feat/mcp-integration` cross-zone). A preload `api.memory.readBoards` bridge. The renderer fetches the prose map once per project-open key change, holds it in `Canvas.tsx` state, and passes it to `DigestPanel`, which renders the heading-stripped prose body when present, else the existing Tier-1 lines.

**Tech Stack:** Electron MAIN IPC (`ipcMain.handle`), preload `contextBridge`, React 18 + Zustand renderer, Vitest (unit `*.test.ts` / integration `*.integration.test.ts(x)`), `@testing-library/react` (jsdom).

**Branch / worktree:** `feat/context` @ `Z:\canvas-ade-context`. Tests are **integration/unit only — NO e2e** (T-M4 touches no native surface; `docs/testing/TESTING.md` › Context = "none").

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/renderer/src/lib/digest.ts` | Tier-1 digest + the new pure `stripHeading` helper | Modify (add export) |
| `src/renderer/src/lib/digest.test.ts` | unit tests for digest + `stripHeading` | Modify (add cases) |
| `src/main/projectIpc.ts` | project IPC handlers + the new `memory:readBoards` handler | Modify (1 import + 1 handler) |
| `src/main/projectIpc.integration.test.ts` | handler integration tests via `ipcTestHarness` | Modify (add `memory:readBoards` block + foreign-sender row) |
| `src/preload/index.ts` | `api.memory.readBoards` bridge (additive) | Modify (add `memory` object) |
| `src/preload/preloadApi.integration.test.ts` | preload contract rows | Modify (add `memory.readBoards` row) |
| `src/renderer/src/canvas/DigestPanel.tsx` | render prose body when present, else Tier-1 lines | Modify (new `prose` prop + branch) |
| `src/renderer/src/canvas/DigestPanel.test.tsx` | jsdom render tests | Modify (add prose-present / prose-absent cases) |
| `src/renderer/src/canvas/Canvas.tsx` | fetch the prose map once per project open, pass to panel | Modify (state + effect + prop) |
| `src/preload/index.d.ts` | — | **NO CHANGE** — `CanvasApi = typeof api` auto-derives `window.api.memory`; do not add a manual type. |
| `docs/context-subsystem.md` | append the DONE entry + gate evidence | Modify (final task) |

**Cross-zone:** `src/preload/index.ts` `api` object is additively shared with `feat/mcp-integration` (it adds an `mcp` key; this adds a `memory` key — no shared lines). Declare on `.claude/coordination/ACTIVE-WORK.md` before editing (done as Task 0).

---

## Task 0: Declare the zone on the coordination board

**Files:**
- Modify: `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (the single physical board)

- [ ] **Step 1: Update the `canvas-ade-context` row** — set its "Owns" to the T-M4 zone and bump "Updated":

```
src/main/projectIpc.ts (memory:readBoards handler) · src/preload/index.ts (api.memory — ADDITIVE, cross-zone w/ feat/mcp-integration, no shared lines) · src/renderer/src/canvas/{Canvas.tsx,DigestPanel.tsx} · src/renderer/src/lib/digest.ts (stripHeading) · NEXT: M-memory T-M4 (panel cached-prose upgrade)
```

- [ ] **Step 2: Commit the board note**

```bash
cd "Z:/canvas-ade-context"
git add ".claude/coordination/ACTIVE-WORK.md"
git commit -m "chore(coord): declare T-M4 zone (projectIpc + preload memory + panel)"
```

Note: the coordination file may live outside the worktree's git index (it's a shared board). If `git add` reports it's not under this worktree, skip the commit — the edit itself is the declaration.

---

## Task 1: `stripHeading` pure helper (unit)

The cached file format is `` `# <title>\n\n<prose>\n` ``. The card already shows the title, so the panel must render only the body. Extract the strip as a pure, testable helper in the renderer digest lib (the panel imports it).

**Files:**
- Modify: `src/renderer/src/lib/digest.ts`
- Test: `src/renderer/src/lib/digest.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `src/renderer/src/lib/digest.test.ts` (keep existing imports; add `stripHeading` to the import from `./digest`):

```typescript
import { buildDigest, stripHeading } from './digest'

describe('stripHeading', () => {
  it('strips a leading "# title" line and the blank line after it', () => {
    expect(stripHeading('# Dev server\n\nRuns the Vite dev server on port 5173.\n')).toBe(
      'Runs the Vite dev server on port 5173.'
    )
  })

  it('keeps multi-paragraph prose intact below the heading', () => {
    expect(stripHeading('# Plan\n\nFirst line.\n\nSecond line.\n')).toBe(
      'First line.\n\nSecond line.'
    )
  })

  it('returns trimmed input unchanged when there is no heading', () => {
    expect(stripHeading('Just prose, no heading.\n')).toBe('Just prose, no heading.')
  })

  it('returns empty string when the file is only a heading', () => {
    expect(stripHeading('# Title only\n')).toBe('')
  })

  it('does not treat a non-heading hash (no trailing space) as a heading', () => {
    expect(stripHeading('#notaheading\nbody')).toBe('#notaheading\nbody')
  })
})
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
cd "Z:/canvas-ade-context"
pnpm test:unit -- src/renderer/src/lib/digest.test.ts
```

Expected: FAIL — `stripHeading is not a function` (not exported yet).

- [ ] **Step 3: Implement `stripHeading`** — append to `src/renderer/src/lib/digest.ts` (after `buildDigest`):

```typescript
/**
 * T-M4: strip a leading Markdown `# heading` line (+ the blank lines after it) from cached
 * Tier-2 prose so the panel renders only the body — the card already shows the title. Pure:
 * a non-heading body (no leading `# `) is returned trimmed, unchanged.
 */
export function stripHeading(md: string): string {
  const lines = md.split('\n')
  if (lines[0]?.startsWith('# ')) {
    lines.shift()
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  }
  return lines.join('\n').trim()
}
```

- [ ] **Step 4: Run the tests — verify they pass**

```bash
pnpm test:unit -- src/renderer/src/lib/digest.test.ts
```

Expected: PASS (all 5 `stripHeading` cases + the existing digest cases).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/digest.ts src/renderer/src/lib/digest.test.ts
git commit -m "feat(context): stripHeading helper for cached Tier-2 prose (T-M4)"
```

---

## Task 2: MAIN `memory:readBoards` handler (integration)

Fold a guarded batch read into `registerProjectHandlers`. For each requested id, return the raw `board-<id>.md` markdown if present; omit absent ones. Foreign sender → `{}`; no current dir → `{}`. Returns RAW markdown — the renderer/panel strips the heading (keeps MAIN dumb).

**Files:**
- Modify: `src/main/projectIpc.ts`
- Test: `src/main/projectIpc.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests** — add a new `describe` block to `src/main/projectIpc.integration.test.ts`. First extend the existing `vi.mock('./canvasMemory', …)` — the file currently mocks it only for `scaffoldProjectMemory`. Locate the current mock; if it is `vi.mock('./canvasMemory', () => ({ scaffoldProjectMemory: vi.fn() }))`, REPLACE it with the hoisted form below (so tests can drive `createCanvasMemory`). If `./canvasMemory` is NOT yet mocked in this file, add this near the other `vi.mock` calls:

```typescript
// (top of file, alongside the other vi.hoisted stubs)
const { canvasMemory } = vi.hoisted(() => ({
  canvasMemory: {
    scaffoldProjectMemory: vi.fn(),
    createCanvasMemory: vi.fn()
  }
}))
vi.mock('./canvasMemory', () => canvasMemory)
```

Then add the test block (after the memory-engine describe):

```typescript
describe('memory:readBoards (T-M4 cached-prose read bridge)', () => {
  const getWin = (): null => null // no window — guard uses the synthetic senderFrame path

  function withReader(readBoard: (id: string) => string | undefined): ReturnType<typeof createIpcCapture> {
    canvasMemory.createCanvasMemory.mockReturnValue({ readBoard })
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')
    return cap
  }

  it('returns raw markdown for ids that have a cached file, omitting absent ones', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const cap = withReader((id) => (id === 't1' ? '# Dev\n\nprose t1\n' : undefined))

    const result = await cap.invoke('memory:readBoards', ['t1', 'b1'])
    expect(result).toEqual({ t1: '# Dev\n\nprose t1\n' })
  })

  it('returns {} when there is no current dir (never reads disk)', async () => {
    store.getCurrentDir.mockReturnValue(null)
    const cap = withReader(() => '# x\n\ny\n')

    expect(await cap.invoke('memory:readBoards', ['t1'])).toEqual({})
    expect(canvasMemory.createCanvasMemory).not.toHaveBeenCalled()
  })

  it('returns {} for a non-array ids payload', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const cap = withReader(() => '# x\n\ny\n')

    expect(await cap.invoke('memory:readBoards', 'not-an-array')).toEqual({})
  })

  it('rejects a foreign sender and reads nothing (#17)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    canvasMemory.createCanvasMemory.mockReturnValue({ readBoard: () => '# x\n\ny\n' })
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, mainWin, '/userData')

    expect(await cap.invokeAs(foreignEvent, 'memory:readBoards', ['t1'])).toEqual({})
    expect(canvasMemory.createCanvasMemory).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
cd "Z:/canvas-ade-context"
pnpm test:integration -- src/main/projectIpc.integration.test.ts
```

Expected: FAIL — `memory:readBoards` handler not registered (the harness throws "no handler for channel" / returns undefined).

- [ ] **Step 3: Implement the handler** — in `src/main/projectIpc.ts`:

3a. Extend the `canvasMemory` import (currently `import { scaffoldProjectMemory } from './canvasMemory'`):

```typescript
import { scaffoldProjectMemory, createCanvasMemory } from './canvasMemory'
```

3b. Register the handler inside `registerProjectHandlers`, next to the other `ipcMain.handle` calls (e.g. after `asset:read`):

```typescript
  // T-M4: batch-read cached Tier-2 prose for the current project's boards. Pure disk read —
  // NO LLM call. Returns the RAW board-<id>.md markdown per present id (the renderer strips
  // the heading); absent ids are omitted. Generated memory is UNTRUSTED PASSIVE context —
  // this handler only READS + returns it, it never triggers an action. Foreign sender → {};
  // no current dir → {}. readBoard already guards safeBoardId + never throws (canvasMemory.ts).
  ipcMain.handle('memory:readBoards', (e, ids: string[]): Record<string, string> => {
    if (guard(e)) return {}
    const dir = getCurrentDir()
    if (!dir || !Array.isArray(ids)) return {}
    const mem = createCanvasMemory(dir)
    const out: Record<string, string> = {}
    for (const id of ids) {
      const md = mem.readBoard(id)
      if (md !== undefined) out[id] = md
    }
    return out
  })
```

- [ ] **Step 4: Run the tests — verify they pass**

```bash
pnpm test:integration -- src/main/projectIpc.integration.test.ts
```

Expected: PASS (the 4 new cases + all existing project handler cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/projectIpc.ts src/main/projectIpc.integration.test.ts
git commit -m "feat(context): memory:readBoards guarded read bridge (T-M4)"
```

---

## Task 3: Preload `api.memory.readBoards` bridge (contract test)

**Files:**
- Modify: `src/preload/index.ts`
- Test: `src/preload/preloadApi.integration.test.ts`

- [ ] **Step 1: Write the failing contract test** — add a row to the `'preload api → project / asset / dialog / export channels'` `it.each` table in `src/preload/preloadApi.integration.test.ts`:

```typescript
    [
      'memory.readBoards',
      (a: CanvasApi) => a.memory.readBoards(['t1', 'b1']),
      ['memory:readBoards', ['t1', 'b1']]
    ],
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
cd "Z:/canvas-ade-context"
pnpm test:integration -- src/preload/preloadApi.integration.test.ts
```

Expected: FAIL — `a.memory is undefined` (the api has no `memory` key yet) / TypeScript error on `a.memory`.

- [ ] **Step 3: Add the `memory` bridge** — in `src/preload/index.ts`, add a `memory` object to the `api` object (place it after the `export` object, alongside `asset` / `dialog` — additive, no shared lines with `feat/mcp-integration`'s `mcp` key):

```typescript
  // ── M-memory T-M4: read cached Tier-2 prose for the panel (pure disk read; MAIN-guarded) ──
  memory: {
    readBoards: (ids: string[]): Promise<Record<string, string>> =>
      ipcRenderer.invoke('memory:readBoards', ids)
  },
```

(`CanvasApi = typeof api` at the bottom of the file auto-derives the type — no `index.d.ts` edit.)

- [ ] **Step 4: Run the test — verify it passes**

```bash
pnpm test:integration -- src/preload/preloadApi.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/preload/preloadApi.integration.test.ts
git commit -m "feat(context): preload api.memory.readBoards bridge (T-M4)"
```

---

## Task 4: `DigestPanel` renders prose when present (jsdom integration)

**Files:**
- Modify: `src/renderer/src/canvas/DigestPanel.tsx`
- Test: `src/renderer/src/canvas/DigestPanel.test.tsx`

- [ ] **Step 1: Write the failing render tests** — append to `src/renderer/src/canvas/DigestPanel.test.tsx` (reuses the existing `DOC` fixture):

```typescript
it('renders cached prose (heading stripped) for a board that has it', () => {
  const { container } = render(
    <DigestPanel
      digest={buildDigest(DOC)}
      prose={{ t1: '# Dev server\n\nRuns the Vite dev server and serves the SPA.\n' }}
      open
      onOpen={() => {}}
      onClose={() => {}}
    />
  )
  // The prose body is shown, the "# Dev server" heading line is NOT.
  expect(screen.getByText('Runs the Vite dev server and serves the SPA.')).toBeTruthy()
  expect(screen.queryByText('# Dev server')).toBeNull()
  // The terminal card with prose shows a prose block, not the Tier-1 lines.
  const cards = container.querySelectorAll('[data-test=digest-card]')
  const termCard = cards[0]
  expect(termCard.querySelector('[data-test=digest-prose]')).toBeTruthy()
  expect(termCard.querySelector('.digest-lines')).toBeNull()
})

it('falls back to Tier-1 lines for boards without cached prose', () => {
  const { container } = render(
    <DigestPanel
      digest={buildDigest(DOC)}
      prose={{ t1: '# Dev server\n\nprose for t1\n' }}
      open
      onOpen={() => {}}
      onClose={() => {}}
    />
  )
  // b1 (browser) has no prose → its Tier-1 lines render.
  const browserCard = container.querySelectorAll('[data-test=digest-card]')[1]
  expect(browserCard.querySelector('.digest-lines')).toBeTruthy()
  expect(browserCard.querySelector('[data-test=digest-prose]')).toBeNull()
})

it('renders Tier-1 lines for every card when no prose map is passed', () => {
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open onOpen={() => {}} onClose={() => {}} />
  )
  expect(container.querySelectorAll('[data-test=digest-prose]')).toHaveLength(0)
  expect(container.querySelectorAll('.digest-lines')).toHaveLength(3)
})
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
cd "Z:/canvas-ade-context"
pnpm test:integration -- src/renderer/src/canvas/DigestPanel.test.tsx
```

Expected: FAIL — `prose` is not a valid prop (TS error) and no `[data-test=digest-prose]` node renders.

- [ ] **Step 3: Add the `prose` prop + render branch** — edit `src/renderer/src/canvas/DigestPanel.tsx`:

3a. Import `stripHeading` (add to the existing `digest` import line):

```typescript
import type { CanvasDigest } from '../lib/digest'
import { stripHeading } from '../lib/digest'
```

3b. Add `prose` to the props interface:

```typescript
export interface DigestPanelProps {
  digest: CanvasDigest
  /** T-M4: cached Tier-2 prose by board id (raw board-<id>.md). Absent → Tier-1 lines. */
  prose?: Record<string, string>
  open: boolean
  onOpen: () => void
  onClose: () => void
}
```

3c. Destructure `prose` and branch the card body. Replace the card body (the `<ul className="digest-lines">…</ul>` block) so the prose body wins when present and non-empty:

```typescript
export function DigestPanel({ digest, prose, open, onOpen, onClose }: DigestPanelProps): ReactElement {
```

…and inside `digest.boards.map((b) => (…))`, replace the `<ul className="digest-lines">…</ul>` with:

```tsx
              {(() => {
                const raw = prose?.[b.boardId]
                const body = raw ? stripHeading(raw) : ''
                return body ? (
                  <p className="digest-prose" data-test="digest-prose">
                    {body}
                  </p>
                ) : (
                  <ul className="digest-lines">
                    {b.lines.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                )
              })()}
```

- [ ] **Step 4: Run the tests — verify they pass**

```bash
pnpm test:integration -- src/renderer/src/canvas/DigestPanel.test.tsx
```

Expected: PASS (3 new cases + the 5 existing DigestPanel cases — the existing "renders … lines" cases still pass because they pass no `prose`).

- [ ] **Step 5: Add the `digest-prose` style** — append to `src/renderer/src/index.css` next to the existing `.digest-lines` rule (match its token style; keep it calm/dense per DESIGN.md — no new colors):

```css
.digest-prose {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
}
```

(If `--text-secondary` is not a defined token, reuse whatever color `.digest-lines li` uses — grep `.digest-lines` in `index.css` and mirror it. Do not invent a new color.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/DigestPanel.tsx src/renderer/src/canvas/DigestPanel.test.tsx src/renderer/src/index.css
git commit -m "feat(context): DigestPanel renders cached prose, Tier-1 fallback (T-M4)"
```

---

## Task 5: `Canvas.tsx` fetches the prose map once per project open

Wire the renderer: on the project-open key change, batch-fetch the prose map and pass it to `DigestPanel`. No LLM call — pure `memory:readBoards` IPC. This is render-wiring; it is covered manually + by the DigestPanel render tests (a Canvas-level jsdom test would need the full store/ReactFlow harness — out of scope, consistent with the existing untested digest wiring).

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`

- [ ] **Step 1: Add prose state next to the digest state** — after the `digest` `useMemo` (~line 223, after the `digestProjectKey` block):

```typescript
  // T-M4: cached Tier-2 prose by board id, fetched once per project open (pure disk read,
  // NO LLM call). DigestPanel renders the prose body when present, else the Tier-1 lines.
  const [prose, setProse] = useState<Record<string, string>>({})
  useEffect(() => {
    if (openedProjectKey === null) {
      setProse({})
      return
    }
    let cancelled = false
    const ids = useCanvasStore.getState().boards.map((b) => b.id)
    void window.api.memory.readBoards(ids).then((map) => {
      if (!cancelled) setProse(map)
    })
    return () => {
      cancelled = true
    }
    // Fire once per open/switch: openedProjectKey changes on each project-open transition.
    // boards are read live (getState) so this does not re-fetch on every board edit.
  }, [openedProjectKey])
```

(`useState` and `useEffect` are already imported in `Canvas.tsx` — confirmed at the top imports. `useCanvasStore` and `window.api` are already used throughout the file.)

- [ ] **Step 2: Pass `prose` to the panel** — update the `<DigestPanel … />` mount (~line 852):

```tsx
          <DigestPanel
            digest={digest}
            prose={prose}
            open={digestOpen}
            onOpen={() => setDigestOpen(true)}
            onClose={() => setDigestOpen(false)}
          />
```

- [ ] **Step 3: Typecheck + the affected suites**

```bash
cd "Z:/canvas-ade-context"
pnpm typecheck
pnpm test:integration -- src/renderer/src/canvas/DigestPanel.test.tsx
```

Expected: typecheck clean; DigestPanel suite green.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx
git commit -m "feat(context): Canvas fetches cached prose once per open → DigestPanel (T-M4)"
```

---

## Task 6: Full gate + DONE entry + final commit

**Files:**
- Modify: `docs/context-subsystem.md`

- [ ] **Step 1: Run the full gate**

```bash
cd "Z:/canvas-ade-context"
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

Expected: all green. If `format:check` flags the new files, run `pnpm format` (prettier --write) on them, re-stage, and re-run. Record the final unit+integration test count from the `pnpm test` summary (the prior baseline was **740 unit**; T-M4 adds ~12 tests → expect ~752+).

- [ ] **Step 2: Append the DONE entry to the build log** — in `docs/context-subsystem.md`, (a) add a `T-M4` row to the "Gate evidence" table with the squash/commit SHA + the test count from Step 1, and (b) update the "What's next" / M-memory line so T-M4 reads ✅ DONE. Use the existing prior-milestone entries as the template (mirror their wording + the consolidated-docs discipline — do NOT create a separate handoff doc). Example row:

```
| T-M4 | <commit-sha> | <count> | (no native surface — unit/integration only) |
```

And a short prose entry mirroring the T-M3 entry's shape, summarizing: `memory:readBoards` guarded read-bridge folded into `registerProjectHandlers` (index.ts untouched → no feat/mcp-integration collision); preload `api.memory.readBoards`; `stripHeading` pure helper; `DigestPanel` renders heading-stripped prose when present else Tier-1; `Canvas.tsx` fetches once per open (NO LLM call); all 4 read-bridge cases incl. foreign-sender → `{}` + no-dir → `{}`. Note **M-memory COMPLETE** (T-M1·T-M2·T-M3·T-M4 all ✅).

- [ ] **Step 3: Commit the docs**

```bash
git add docs/context-subsystem.md docs/superpowers/plans/2026-06-04-context-m4-panel-prose.md
git commit -m "docs(context): record T-M4 DONE + gate evidence; M-memory complete"
```

- [ ] **Step 4: Report** — files touched + the final test count + gate result.

---

## Self-Review (run against the kickoff before executing)

1. **Spec coverage:**
   - MAIN read-bridge folded into `registerProjectHandlers`, `index.ts` untouched → Task 2 ✅
   - Foreign-sender rejection on the new handler → Task 2 Step 1 case 4 ✅
   - No current dir → `{}` → Task 2 case 2 ✅
   - Preload `api.memory.readBoards` + contract row → Task 3 ✅
   - `index.d.ts` — correctly a NO-CHANGE (auto-derived) → File Structure note ✅
   - Renderer fetches once on project-open key, passes to panel → Task 5 ✅
   - Panel renders prose (heading stripped) else Tier-1 → Task 4 ✅
   - `stripHeading` unit-tested pure helper → Task 1 ✅
   - Reuse `canvasMemory.readBoard` (no new reader) → Task 2 Step 3 ✅
   - NO e2e added → no `e2e/` task present ✅
   - DONE entry appended to `docs/context-subsystem.md` (no separate handoff) → Task 6 ✅
2. **Placeholder scan:** every code step shows complete code; no TBD/TODO. ✅
3. **Type consistency:** handler returns `Record<string, string>` (raw md); preload mirror `Promise<Record<string, string>>`; panel prop `prose?: Record<string, string>`; `stripHeading(md: string): string` consistent across Tasks 1/4. Channel string `'memory:readBoards'` identical in handler + preload + both tests. ✅
