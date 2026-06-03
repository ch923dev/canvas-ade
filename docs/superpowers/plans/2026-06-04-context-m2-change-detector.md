# Context M-memory T-M2 — Meaningful-Change Detector + Debounce — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the DETECTOR half of the Tier-2 memory loop — a MAIN-side module that watches the `project:save` doc stream and, after a per-board debounce, emits a `{ boardId }` "summarize" intent **only** when a board's *meaningful content* (not geometry/selection) changed.

**Architecture:** A new, Electron-free, fully-deterministic `src/main/memoryEngine.ts` exposing `createMemoryEngine({ onIntent, debounceMs?, schedule? }) → { observe(doc), reset() }`. It diffs a per-board **content fingerprint** (`boardFingerprint`) against the last-seen value; a change (or a brand-new board) (re)starts that board's trailing-edge debounce; on fire it calls `onIntent`. It is wired into `projectIpc.ts`: the `project:save` handler feeds the saved doc in (best-effort, after a successful write — it can **never** fail a save), and `project:open` / `project:current` call `reset()` on a project switch. **T-M2 only EMITS** — no LLM call, no `.canvas/` write, no `llmService`/`canvasMemory` import (that is T-M3).

**Tech Stack:** TypeScript (strict), Electron MAIN (`src/main/`), Vitest, the existing `CANVAS_SMOKE=e2e` MAIN-side probe harness (`src/main/e2e/`).

---

## Design-note resolutions (settled before coding)

1. **Fingerprint representation** — a stable `JSON.stringify` of the meaningful fields picked into a **fixed key order** per board type. **Process-boundary constraint (verified):** MAIN cannot import the renderer's `boardSchema.ts` / `digest.ts` — `tsconfig.node.json` includes only `src/main/**`, and `project:save` already receives the doc typed `unknown`. So the field set is picked **locally** in `memoryEngine.ts` from the `unknown` doc, **mirroring** the fields `src/renderer/src/lib/digest.ts` enumerates. A header comment + the parity unit tests document the intended sync (the kickoff's "share a constant" is not possible across the main/renderer tsconfig split — local-pick-with-parity-comment is the resolution).
2. **Where the detector is fed** — inside the existing `project:save` handler, **after** a successful `writeProject`, wrapped in its **own** try/catch so a detector bug can never turn a good save into `false`. The **first** `observe` of a session sets baseline fingerprints and emits nothing (`primed` flag).
3. **Debounce** — `DEFAULT_DEBOUNCE_MS = 45_000`, per-board **independent trailing-edge** timer; a second meaningful change *during* the window **restarts** (extends) the timer, so a burst collapses to one intent. `debounceMs` is injectable (e2e/tests use a small value).
4. **Timer/clock injection** — inject a `Scheduler = (fn, ms) => Cancel` seam (mirrors `llmBudget.ts`'s injected clock). Production default wraps `setTimeout`/`clearTimeout`; unit tests inject a **manual fake** (`flush()`); the e2e probe injects the **real** scheduler with a **short** `debounceMs` so it does not stall the playlist.
5. **Intent shape + emit** — `interface SummarizeIntent { boardId: string }`; emitted via an injected `onIntent(intent)` callback registered at construction. **Zero** `llmService`/`canvasMemory` imports (asserted by review).
6. **Module/state shape** — `createMemoryEngine(deps) → MemoryEngine`; holds `Map<boardId, fingerprint>` + `Map<boardId, Cancel>` + a `primed` boolean. `reset()` cancels all timers, clears both maps, and un-primes (so a new project does not inherit the old one's fingerprints/timers).

**🔒 Security (locked):** the detector only **reads** the already-trusted persisted doc and **emits an id** — it never triggers an action beyond the emit (which T-M3 must keep as a summarize-only intent, never a PTY write or board mutation). No new egress. `contextIsolation`/`sandbox`/`no-nodeIntegration` untouched. The `project:save` feed is best-effort and can never fail a save. Generated/observed memory stays untrusted passive context.

**Out of scope (do NOT build):** the Tier-2 summarize loop (intent → `runSummarize` → `canvasMemory.writeBoard`) = T-M3; terminal last-command/live-status capture = T-M3; the panel cached-prose upgrade = T-M4; the MCP `canvas://memory` resource = M-expose (deferred).

---

## File Structure

- **Create** `src/main/memoryEngine.ts` — the detector: `boardFingerprint` (pure) + `createMemoryEngine` (stateful, injected timer/callback). One responsibility: decide *when* a board is worth re-summarizing and emit its id.
- **Create** `src/main/memoryEngine.test.ts` — unit tests for `boardFingerprint` (move-invariant, content-sensitive per type, malformed-safe) and `createMemoryEngine` (baseline/content/move/burst/new/removed/reset) using a manual fake scheduler.
- **Create** `src/main/e2e/probes/change.ts` — `context-change` MAIN-side probe driving the engine directly with a short real debounce.
- **Modify** `src/main/projectIpc.ts` — construct one engine (default `onIntent` = log), feed `project:save`, `reset()` on open/current.
- **Modify** `src/main/projectIpc.test.ts` — wiring tests (observe called on save; throwing observe still returns `true`; reset on open).
- **Modify** `src/main/e2e/index.ts` — import + register `contextChange` in the PLAYLIST.

`src/main/index.ts` is **NOT** modified: the engine is constructed inside `registerProjectHandlers` with a default, so the existing call site is unchanged.

---

## Task 1: `boardFingerprint` — the pure meaningful-content fingerprint

**Files:**
- Create: `src/main/memoryEngine.ts`
- Test: `src/main/memoryEngine.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/memoryEngine.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { boardFingerprint } from './memoryEngine'

const terminal = (over: Record<string, unknown> = {}): unknown => ({
  id: 't1',
  type: 'terminal',
  x: 0,
  y: 0,
  w: 420,
  h: 340,
  title: 'Terminal',
  launchCommand: 'pnpm dev',
  cwd: '/repo',
  port: 5173,
  ...over
})
const browser = (over: Record<string, unknown> = {}): unknown => ({
  id: 'b1',
  type: 'browser',
  x: 0,
  y: 0,
  w: 700,
  h: 500,
  title: 'Browser',
  url: 'http://localhost:5173',
  viewport: 'desktop',
  previewSourceId: 't1',
  ...over
})
const planning = (elements: unknown[]): unknown => ({
  id: 'p1',
  type: 'planning',
  x: 0,
  y: 0,
  w: 516,
  h: 366,
  title: 'Planning',
  elements
})
const note = (text: string, over: Record<string, unknown> = {}): unknown => ({
  id: 'n1',
  kind: 'note',
  x: 0,
  y: 0,
  w: 100,
  h: 80,
  tint: 'yellow',
  text,
  ...over
})
const checklist = (items: { label: string; done: boolean }[]): unknown => ({
  id: 'c1',
  kind: 'checklist',
  x: 0,
  y: 0,
  w: 200,
  h: 0,
  title: 'Tasks',
  items: items.map((i, idx) => ({ id: `i${idx}`, ...i }))
})

describe('boardFingerprint — move-invariant', () => {
  it('terminal: pure move/resize does not change the fingerprint', () => {
    expect(boardFingerprint(terminal())).toBe(
      boardFingerprint(terminal({ x: 999, y: 888, w: 1000, h: 900, z: 5, title: 'Renamed' }))
    )
  })
  it('browser: pure move does not change the fingerprint', () => {
    expect(boardFingerprint(browser())).toBe(boardFingerprint(browser({ x: 50, y: 60, w: 720 })))
  })
  it('planning: moving a note does not change the fingerprint', () => {
    expect(boardFingerprint(planning([note('hi')]))).toBe(
      boardFingerprint(planning([note('hi', { x: 300, y: 400, rotation: 45, tint: 'blue' })]))
    )
  })
})

describe('boardFingerprint — content-sensitive', () => {
  it('terminal: launchCommand / cwd / port changes are detected', () => {
    const base = boardFingerprint(terminal())
    expect(boardFingerprint(terminal({ launchCommand: 'pnpm build' }))).not.toBe(base)
    expect(boardFingerprint(terminal({ cwd: '/other' }))).not.toBe(base)
    expect(boardFingerprint(terminal({ port: 3000 }))).not.toBe(base)
  })
  it('browser: url / viewport / previewSourceId changes are detected', () => {
    const base = boardFingerprint(browser())
    expect(boardFingerprint(browser({ url: 'http://localhost:3000' }))).not.toBe(base)
    expect(boardFingerprint(browser({ viewport: 'mobile' }))).not.toBe(base)
    expect(boardFingerprint(browser({ previewSourceId: 't2' }))).not.toBe(base)
  })
  it('planning: note text + checklist item label/done changes are detected', () => {
    expect(boardFingerprint(planning([note('hi')]))).not.toBe(
      boardFingerprint(planning([note('hi there')]))
    )
    const c = boardFingerprint(planning([checklist([{ label: 'a', done: false }])]))
    expect(boardFingerprint(planning([checklist([{ label: 'a', done: true }])]))).not.toBe(c)
    expect(boardFingerprint(planning([checklist([{ label: 'b', done: false }])]))).not.toBe(c)
  })
})

describe('boardFingerprint — robustness', () => {
  it('malformed / null / unknown-type input never throws and is stable', () => {
    expect(() => boardFingerprint(null)).not.toThrow()
    expect(() => boardFingerprint({})).not.toThrow()
    expect(() => boardFingerprint({ type: 'planning', elements: 'nope' })).not.toThrow()
    expect(boardFingerprint({ id: 'x', type: 'mystery' })).toBe(
      boardFingerprint({ id: 'x', type: 'mystery' })
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/memoryEngine.test.ts`
Expected: FAIL — `boardFingerprint` is not exported (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/main/memoryEngine.ts`:

```ts
/**
 * T-M2: the meaningful-change DETECTOR half of the Tier-2 memory loop. Watches the
 * `project:save` doc stream and, when a board's MEANINGFUL content changes (not a pure
 * move/resize/pan/select), emits a debounced `{ boardId }` "summarize" intent. It does
 * NOT call the brain or write `.canvas/` (that is T-M3) — it only decides WHEN a board is
 * worth re-summarizing and emits an id via an injected callback. Electron-free + fully
 * deterministic: the timer is injected (mirrors llmBudget.ts's injected clock) so the
 * debounce unit-tests without real time, and e2e can use a short real debounce.
 *
 * PROCESS-BOUNDARY NOTE: MAIN cannot import the renderer's boardSchema/digest.ts
 * (tsconfig.node only includes src/main/**), so the meaningful-field set is picked here
 * defensively from the `unknown` doc. The picked fields MIRROR the fields
 * src/renderer/src/lib/digest.ts surfaces per type — keep the two in sync (terminal:
 * launchCommand/cwd/port · browser: url/viewport/previewSourceId · planning: per-checklist
 * title + items {label,done}, note text). Geometry/selection/viewport are excluded so a
 * pure move/resize/pan/select yields an identical fingerprint.
 *
 * 🔒 Security: generated/observed memory is untrusted passive context. The detector only
 * READS the already-trusted persisted doc and EMITS an id; it never triggers an action
 * beyond the emit. No new egress.
 */

/** Cancel a scheduled debounce. */
export type Cancel = () => void
/** Inject a setTimeout-like seam so the debounce is deterministic in tests. */
export type Scheduler = (fn: () => void, ms: number) => Cancel

/** The one thing the detector emits: "board X is worth re-summarizing." */
export interface SummarizeIntent {
  boardId: string
}

/** Default per-board debounce window — content settles before we spend a summarize. */
export const DEFAULT_DEBOUNCE_MS = 45_000

// ── Meaningful-field extraction (mirrors digest.ts; excludes geometry/selection) ──

type RawBoard = { id?: unknown; type?: unknown; [k: string]: unknown }

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The meaningful slice of one board, in a fixed key order, as a stable JSON string. */
export function boardFingerprint(board: unknown): string {
  const b = (board ?? {}) as RawBoard
  switch (b.type) {
    case 'terminal':
      return JSON.stringify({
        t: 'terminal',
        launchCommand: str(b.launchCommand),
        cwd: str(b.cwd),
        port: numOrNull(b.port)
      })
    case 'browser':
      return JSON.stringify({
        t: 'browser',
        url: str(b.url),
        viewport: str(b.viewport),
        previewSourceId: str(b.previewSourceId)
      })
    case 'planning': {
      const elements = Array.isArray(b.elements) ? (b.elements as RawBoard[]) : []
      const checklists = elements
        .filter((e) => e.kind === 'checklist')
        .map((e) => ({
          title: str(e.title),
          items: (Array.isArray(e.items) ? (e.items as RawBoard[]) : []).map((i) => ({
            label: str(i.label),
            done: i.done === true
          }))
        }))
      const notes = elements.filter((e) => e.kind === 'note').map((e) => str(e.text))
      return JSON.stringify({ t: 'planning', checklists, notes })
    }
    default:
      // Unknown/missing type: a stable constant per id so it never churns intents.
      return JSON.stringify({ t: String(b.type ?? 'unknown'), id: str(b.id) })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/memoryEngine.test.ts`
Expected: PASS (all `boardFingerprint` describes green).

- [ ] **Step 5: Commit**

```bash
git add src/main/memoryEngine.ts src/main/memoryEngine.test.ts
git commit -F - <<'EOF'
feat(context): T-M2 boardFingerprint — meaningful-content fingerprint (move-invariant)

Pure per-board fingerprint over only the fields digest.ts surfaces (terminal
launchCommand/cwd/port; browser url/viewport/previewSourceId; planning checklist
title+items and note text). Excludes geometry/selection so a pure move/resize is a
no-op. Read defensively from the unknown project:save doc (MAIN cannot import the
renderer boardSchema/digest.ts).
EOF
```

---

## Task 2: `createMemoryEngine` — diff + per-board debounce + emit

**Files:**
- Modify: `src/main/memoryEngine.ts` (append the engine)
- Test: `src/main/memoryEngine.test.ts` (append engine tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/main/memoryEngine.test.ts`:

```ts
import { createMemoryEngine, type Scheduler, type SummarizeIntent } from './memoryEngine'

/** A manual scheduler: jobs run only when flush() is called (simulates the debounce firing). */
function fakeScheduler() {
  const jobs: { fn: () => void; cancelled: boolean }[] = []
  const schedule: Scheduler = (fn) => {
    const job = { fn, cancelled: false }
    jobs.push(job)
    return () => {
      job.cancelled = true
    }
  }
  const flush = (): void => {
    // snapshot so jobs scheduled during flush don't run in this pass
    for (const job of [...jobs]) {
      if (!job.cancelled) {
        job.cancelled = true
        job.fn()
      }
    }
  }
  return { schedule, flush }
}

const docOf = (boards: unknown[]): unknown => ({ schemaVersion: 4, viewport: null, boards })
const term = (id: string, launchCommand: string, x = 0): unknown => ({
  id,
  type: 'terminal',
  x,
  y: 0,
  w: 420,
  h: 340,
  title: 'T',
  launchCommand
})

describe('createMemoryEngine — baseline + diff', () => {
  it('first observe sets baseline and emits nothing', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'pnpm dev')]))
    flush()
    expect(intents).toEqual([])
  })

  it('a content change after baseline emits exactly one intent for that board', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'pnpm dev')])) // baseline
    engine.observe(docOf([term('t1', 'pnpm build')])) // content changed
    flush()
    expect(intents).toEqual([{ boardId: 't1' }])
  })

  it('a pure move (x only) after baseline emits nothing', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'pnpm dev', 0)])) // baseline
    engine.observe(docOf([term('t1', 'pnpm dev', 999)])) // moved only
    flush()
    expect(intents).toEqual([])
  })

  it('a burst of content changes to one board collapses to a single intent', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'a')])) // baseline
    engine.observe(docOf([term('t1', 'ab')]))
    engine.observe(docOf([term('t1', 'abc')]))
    engine.observe(docOf([term('t1', 'abcd')]))
    flush()
    expect(intents).toEqual([{ boardId: 't1' }])
  })

  it('a brand-new board added after baseline emits an intent for it', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'a')])) // baseline
    engine.observe(docOf([term('t1', 'a'), term('t2', 'b')])) // t2 is new
    flush()
    expect(intents).toEqual([{ boardId: 't2' }])
  })

  it('a board removed before its debounce fires cancels its pending intent', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'a'), term('t2', 'b')])) // baseline
    engine.observe(docOf([term('t1', 'a'), term('t2', 'bb')])) // t2 changed → timer armed
    engine.observe(docOf([term('t1', 'a')])) // t2 removed → cancel
    flush()
    expect(intents).toEqual([])
  })
})

describe('createMemoryEngine — reset', () => {
  it('reset cancels pending timers and clears baselines', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'a')])) // baseline
    engine.observe(docOf([term('t1', 'b')])) // armed
    engine.reset()
    flush()
    expect(intents).toEqual([]) // armed timer was cancelled

    // after reset, the next observe re-baselines (no spurious emit)
    engine.observe(docOf([term('t1', 'c')]))
    flush()
    expect(intents).toEqual([])
  })

  it('observe is best-effort: a malformed doc never throws and arms nothing', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    expect(() => engine.observe(undefined)).not.toThrow()
    expect(() => engine.observe({ boards: 'nope' })).not.toThrow()
    flush()
    expect(intents).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/memoryEngine.test.ts`
Expected: FAIL — `createMemoryEngine` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/main/memoryEngine.ts`:

```ts
export interface MemoryEngineDeps {
  /** Called once per board after its debounce settles. The ONLY output of the detector. */
  onIntent: (intent: SummarizeIntent) => void
  /** Debounce window per board (ms). Default DEFAULT_DEBOUNCE_MS. e2e/tests override small. */
  debounceMs?: number
  /** Timer seam. Default wraps setTimeout/clearTimeout. Tests inject a manual fake. */
  schedule?: Scheduler
}

export interface MemoryEngine {
  /** Feed a saved doc (the `project:save` payload, typed `unknown`). Best-effort, pure-read. */
  observe(doc: unknown): void
  /** Drop all per-board state + cancel pending timers (call on project switch). */
  reset(): void
}

/** Default real timer: setTimeout/clearTimeout. */
const realScheduler: Scheduler = (fn, ms) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

export function createMemoryEngine(deps: MemoryEngineDeps): MemoryEngine {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const schedule = deps.schedule ?? realScheduler
  const fingerprints = new Map<string, string>()
  const timers = new Map<string, Cancel>()
  let primed = false

  function cancelTimer(id: string): void {
    const cancel = timers.get(id)
    if (cancel) {
      cancel()
      timers.delete(id)
    }
  }

  function armDebounce(id: string): void {
    cancelTimer(id) // trailing-edge: a fresh meaningful change restarts the window
    const cancel = schedule(() => {
      timers.delete(id)
      deps.onIntent({ boardId: id })
    }, debounceMs)
    timers.set(id, cancel)
  }

  return {
    observe(doc) {
      const boards = (doc as { boards?: unknown })?.boards
      if (!Array.isArray(boards)) return // best-effort: a malformed doc is a no-op

      const seen = new Set<string>()
      for (const board of boards) {
        const id = str((board as RawBoard)?.id)
        if (!id) continue
        seen.add(id)
        const fp = boardFingerprint(board)
        const prev = fingerprints.get(id)
        fingerprints.set(id, fp)
        if (!primed) continue // first doc of a session: baseline only, never emit
        if (prev === undefined || prev !== fp) armDebounce(id) // new or changed board
      }

      // A board removed from the doc: drop its state + cancel any pending intent.
      for (const id of [...fingerprints.keys()]) {
        if (!seen.has(id)) {
          cancelTimer(id)
          fingerprints.delete(id)
        }
      }

      primed = true
    },
    reset() {
      for (const id of [...timers.keys()]) cancelTimer(id)
      fingerprints.clear()
      primed = false
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/memoryEngine.test.ts`
Expected: PASS (all `boardFingerprint` + `createMemoryEngine` describes green).

- [ ] **Step 5: Commit**

```bash
git add src/main/memoryEngine.ts src/main/memoryEngine.test.ts
git commit -F - <<'EOF'
feat(context): T-M2 createMemoryEngine — per-board debounced change detector

observe(doc) diffs each board's content fingerprint vs last-seen; a change or a
brand-new board (re)arms a per-board trailing-edge debounce (default 45s, injected
timer); on fire it emits {boardId} via onIntent. First observe = baseline (no emit);
removed boards cancel pending timers; reset() clears state on project switch. No LLM,
no .canvas/ write, no llmService/canvasMemory import.
EOF
```

---

## Task 3: Wire the detector into `projectIpc.ts`

**Files:**
- Modify: `src/main/projectIpc.ts`
- Test: `src/main/projectIpc.test.ts`

- [ ] **Step 1: Write the failing wiring tests**

Append to `src/main/projectIpc.test.ts` (imports: add `vi` to the existing `vitest` import if missing, and the new imports below):

```ts
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerProjectHandlers } from './projectIpc'
import { createProject, setCurrentDir } from './projectStore'
import type { MemoryEngine } from './memoryEngine'

/** Capture the handlers registerProjectHandlers installs, with a sender that passes the guard. */
function harness(engine: MemoryEngine) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const ipcMain = { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
  const frame = {}
  const win = { webContents: { mainFrame: frame } }
  const userDataDir = mkdtempSync(join(tmpdir(), 'm2-ud-'))
  registerProjectHandlers(
    ipcMain as never,
    () => win as never,
    userDataDir,
    () => 0,
    engine
  )
  const e = { senderFrame: frame } as never // senderFrame === mainFrame → guard passes
  return { handlers, e, userDataDir }
}

describe('projectIpc — T-M2 memory-engine wiring', () => {
  it('feeds the saved doc into the engine after a successful save', async () => {
    const observe = vi.fn()
    const engine: MemoryEngine = { observe, reset: vi.fn() }
    const { handlers, e, userDataDir } = harness(engine)
    const proj = mkdtempSync(join(tmpdir(), 'm2-proj-'))
    try {
      await createProject(proj, 'm2', {})
      setCurrentDir(proj)
      const doc = { schemaVersion: 4, viewport: null, boards: [] }
      const ok = await handlers.get('project:save')!(e, doc)
      expect(ok).toBe(true)
      expect(observe).toHaveBeenCalledWith(doc)
    } finally {
      setCurrentDir(null)
      rmSync(proj, { recursive: true, force: true })
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('a throwing engine.observe never fails the save (best-effort feed)', async () => {
    const engine: MemoryEngine = {
      observe: () => {
        throw new Error('detector boom')
      },
      reset: vi.fn()
    }
    const { handlers, e, userDataDir } = harness(engine)
    const proj = mkdtempSync(join(tmpdir(), 'm2-proj-'))
    try {
      await createProject(proj, 'm2', {})
      setCurrentDir(proj)
      const ok = await handlers.get('project:save')!(e, { schemaVersion: 4, viewport: null, boards: [] })
      expect(ok).toBe(true) // save still succeeds despite the detector throwing
    } finally {
      setCurrentDir(null)
      rmSync(proj, { recursive: true, force: true })
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('resets the engine when a project is opened (switch)', async () => {
    const reset = vi.fn()
    const engine: MemoryEngine = { observe: vi.fn(), reset }
    const { handlers, e, userDataDir } = harness(engine)
    const proj = mkdtempSync(join(tmpdir(), 'm2-proj-'))
    try {
      await createProject(proj, 'm2', {})
      const r = handlers.get('project:open')!(e, proj) as { ok: boolean }
      expect(r.ok).toBe(true)
      expect(reset).toHaveBeenCalled()
    } finally {
      setCurrentDir(null)
      rmSync(proj, { recursive: true, force: true })
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/projectIpc.test.ts`
Expected: FAIL — `registerProjectHandlers` has no 5th `engine` parameter; `observe`/`reset` are never called.

- [ ] **Step 3: Write the minimal implementation**

In `src/main/projectIpc.ts`, add the import near the other `./` imports:

```ts
import { createMemoryEngine, type MemoryEngine, type SummarizeIntent } from './memoryEngine'
```

Add this module-level default just above `registerProjectHandlers`:

```ts
/**
 * Default T-M2 intent sink: log only. T-M3 replaces this with the Tier-2 summarize loop
 * (intent → runSummarize → canvasMemory.writeBoard). The intent is passive — it is an id,
 * never an action.
 */
function logSummarizeIntent(intent: SummarizeIntent): void {
  console.log(`[memoryEngine] summarize intent for board ${intent.boardId}`)
}
```

Change the `registerProjectHandlers` signature to accept an injectable engine (last param, defaulted so `index.ts` is untouched):

```ts
export function registerProjectHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string,
  now: () => number = () => Date.now(),
  memoryEngine: MemoryEngine = createMemoryEngine({ onIntent: logSummarizeIntent })
): void {
```

In the `project:open` handler, after the existing `scaffoldProjectMemory(r.dir)` line (inside `if (r.ok)`), add a best-effort reset:

```ts
      scaffoldProjectMemory(r.dir) // T-M1: ensure .canvas/ on open (best-effort, never aborts open)
      try {
        memoryEngine.reset() // T-M2: a project switch drops stale fingerprints/timers
      } catch (err) {
        console.warn('[memoryEngine] reset on open failed (non-fatal)', err)
      }
```

In the `project:current` handler, after its `scaffoldProjectMemory(r.dir)` line (inside `if (r.ok)`), add the same:

```ts
      scaffoldProjectMemory(r.dir) // T-M1: ensure .canvas/ on reopen (best-effort, never aborts)
      try {
        memoryEngine.reset() // T-M2: re-baseline on reopen/switch
      } catch (err) {
        console.warn('[memoryEngine] reset on current failed (non-fatal)', err)
      }
```

In the `project:save` handler, feed the doc after a successful write — in its OWN try/catch so it can never turn a good save into `false`:

```ts
    try {
      await writeProject(dir, doc)
      try {
        memoryEngine.observe(doc) // T-M2: detect meaningful change (best-effort; never fails a save)
      } catch (err) {
        console.warn('[memoryEngine] observe failed (non-fatal)', err)
      }
      return true
    } catch (err) {
      console.error('project:save failed', err)
      return false
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/projectIpc.test.ts`
Expected: PASS (the 3 new wiring tests + all pre-existing projectIpc tests green).

- [ ] **Step 5: Commit**

```bash
git add src/main/projectIpc.ts src/main/projectIpc.test.ts
git commit -F - <<'EOF'
feat(context): T-M2 wire change detector into project:save / open / current

Construct one memoryEngine (default onIntent logs; T-M3 swaps in the summarize loop).
project:save feeds the saved doc after a successful write, in its own try/catch so a
detector bug can never fail a save. project:open and project:current reset() the engine
on a project switch so a new project never inherits stale fingerprints/timers. index.ts
unchanged (engine param is defaulted).
EOF
```

---

## Task 4: e2e probe — `context-change`

**Files:**
- Create: `src/main/e2e/probes/change.ts`
- Modify: `src/main/e2e/index.ts`

- [ ] **Step 1: Write the probe**

Create `src/main/e2e/probes/change.ts`:

```ts
import { createMemoryEngine } from '../../memoryEngine'
import type { E2EProbe } from '../types'

/**
 * M-memory T-M2: the meaningful-change detector. Drives createMemoryEngine directly
 * (MAIN-side, like context-memory) with a SHORT real debounce + a counting onIntent, and
 * asserts: a CONTENT change (note text) fires exactly ONE intent after the debounce, while
 * a PURE MOVE (x only) fires ZERO. Real timer (not a fake) so it exercises the production
 * setTimeout path end-to-end. No LLM, no .canvas/ write.
 */
export const contextChange: E2EProbe = {
  name: 'context-change',
  async run(ctx) {
    void ctx // MAIN-side only: no renderer interaction needed for the detector
    const intents: string[] = []
    const debounceMs = 40
    const engine = createMemoryEngine({
      onIntent: (i) => intents.push(i.boardId),
      debounceMs
    })
    const docWith = (text: string, x: number): unknown => ({
      schemaVersion: 4,
      viewport: null,
      boards: [
        {
          id: 'b1',
          type: 'planning',
          x,
          y: 0,
          w: 400,
          h: 300,
          title: 'P',
          elements: [
            { id: 'n1', kind: 'note', x: 0, y: 0, w: 100, h: 80, tint: 'yellow', text }
          ]
        }
      ]
    })
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, debounceMs + 60))

    // 1) baseline (no emit) → a CONTENT change → exactly one intent after the debounce
    engine.observe(docWith('hello', 0))
    engine.observe(docWith('hello world', 0)) // note text changed
    await settle()
    const afterContent = intents.length // expect 1

    // 2) a PURE MOVE (x changes, text identical) → no new intent
    engine.observe(docWith('hello world', 999))
    await settle()
    const afterMove = intents.length // expect still 1

    const ok = afterContent === 1 && afterMove === 1 && intents[0] === 'b1'
    return {
      name: 'context-change',
      ok,
      detail: ok
        ? 'content change → 1 intent; pure move → 0 (debounced detector)'
        : JSON.stringify({ afterContent, afterMove, intents })
    }
  }
}
```

- [ ] **Step 2: Register the probe in the PLAYLIST**

In `src/main/e2e/index.ts`, add the import next to the other context probes:

```ts
import { contextChange } from './probes/change'
```

In the `PLAYLIST` array, add `contextChange` immediately before `contextMemory` (both are MAIN-side, self-contained, and do not depend on seeded renderer state):

```ts
  contextChange, // M-memory T-M2: meaningful-change detector (content → 1 intent; move → 0)
  contextMemory // M-memory T-M1: .canvas/ scaffold + board summary round-trip (project-rooted; runs last)
```

- [ ] **Step 3: Build, then run the board e2e harness**

Run:
```
pnpm build
$env:CANVAS_SMOKE='e2e'; pnpm start
```
Expected: the run prints `E2E_PART context-change ok:true` and finishes `E2E_DONE ok:true`. (If `browser`/`browser-gesture`/`focus-detach` show `ok:false`, that is the known `capturePage` env flake — memory `e2e-browser-trio-flake` — rerun once; `context-change` itself must be `ok:true`.)

- [ ] **Step 4: Commit**

```bash
git add src/main/e2e/probes/change.ts src/main/e2e/index.ts
git commit -F - <<'EOF'
test(context): T-M2 e2e context-change — content→1 intent, move→0

MAIN-side probe driving createMemoryEngine with a short real debounce: a note-text
change emits exactly one summarize intent; a pure move emits none. Registered before
context-memory in the playlist.
EOF
```

---

## Task 5: Full gate, docs fold, squash-merge

**Files:**
- Modify: `docs/context-subsystem.md` (add the T-M2 subsection + gate row)
- Delete: `docs/superpowers/handoffs/2026-06-04-context-m2-kickoff.md`

- [ ] **Step 1: Run the full gate**

Run:
```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```
Expected: all green. (Run `pnpm format` first if `format:check` reports drift — prettier drift bit T-B2/T-B3.) Unit baseline rises from 702 by the new `memoryEngine` + `projectIpc` tests.

- [ ] **Step 2: Run the board e2e harness once more (post-gate)**

Run:
```
pnpm build
$env:CANVAS_SMOKE='e2e'; pnpm start
```
Expected: `E2E_DONE ok:true`, `context-change ok:true` (rerun once if only the browser-trio flake trips).

- [ ] **Step 3: Fold the T-M2 summary into `docs/context-subsystem.md`**

Under the `## M-memory` section (after the `### T-M1` subsection), add:

```markdown
### T-M2 — Meaningful-change detector + debounce ✅

The DETECTOR half of the Tier-2 loop: decides *when* a board is worth re-summarizing and
emits a `{ boardId }` intent — **no LLM call, no `.canvas/` write** (that is T-M3).

- `src/main/memoryEngine.ts` — `createMemoryEngine({ onIntent, debounceMs?, schedule? }) →
  { observe(doc), reset() }` + pure `boardFingerprint(board)`. Electron-free; the timer is an
  injected `Scheduler` (default `setTimeout`; tests inject a manual fake; e2e uses a short
  real debounce). `DEFAULT_DEBOUNCE_MS = 45_000`, per-board independent **trailing-edge**
  timer (a burst collapses to one intent).
- **Fingerprint** mirrors `digest.ts`'s meaningful fields (terminal `launchCommand`/`cwd`/
  `port`; browser `url`/`viewport`/`previewSourceId`; planning per-checklist `title` + items
  `{label,done}` + note `text`) and **excludes** geometry/selection/viewport — a pure
  move/resize/pan/select is a no-op. **Process boundary:** MAIN can't import the renderer's
  `boardSchema`/`digest.ts` (`tsconfig.node` = `src/main/**`), so the field set is picked
  locally from the `unknown` doc with a parity comment + parity tests.
- **Semantics:** first `observe` of a session = baseline (no emit); a changed or brand-new
  board (re)arms its debounce; a removed board cancels its pending intent; `reset()` clears
  fingerprints + cancels timers on project switch.
- **Wiring (`projectIpc.ts`):** one engine (default `onIntent` logs — T-M3 swaps in the
  summarize loop); `project:save` feeds the doc after a successful write in its **own**
  try/catch (can never fail a save); `project:open`/`project:current` `reset()` on switch.
  `index.ts` untouched (engine param defaulted).
- 🔒 **Security:** detector only reads the trusted persisted doc and emits an id — never an
  action; no new egress. e2e `src/main/e2e/probes/change.ts` `context-change`: content
  change → 1 intent, pure move → 0.
```

Then add a row to the **Gate evidence** table:

```markdown
| T-M2 | `<squash-sha>` | **<NNN>** | `context-change` ok |
```

(Fill `<squash-sha>` after the squash-merge in Step 5, and `<NNN>` with the unit count from Step 1.)

Update the doc's top **Status** line and the **What's next** list to mark T-M2 ✅ and point at T-M3.

- [ ] **Step 4: Delete the kickoff + commit the docs**

```bash
git rm docs/superpowers/handoffs/2026-06-04-context-m2-kickoff.md
git add docs/context-subsystem.md
git commit -F - <<'EOF'
docs(context): fold T-M2 (change detector) into the build log; drop kickoff

Record the meaningful-change detector + debounce milestone in context-subsystem.md
(consolidated-docs discipline) and remove the now-spent T-M2 kickoff.
EOF
```

- [ ] **Step 5: Squash-merge to `feat/context`**

```bash
git checkout feat/context && git pull --ff-only
git merge --squash feat/context-m2-change-detector
git commit -F - <<'EOF'
feat(context): M-memory T-M2 — meaningful-change detector + debounce

New src/main/memoryEngine.ts detects meaningful per-board content changes off the
project:save doc stream (fingerprint excludes geometry/selection; mirrors digest.ts),
debounces per board (~45s, injected timer), and emits a {boardId} summarize intent via
an injected callback. Wired into projectIpc (best-effort feed that can never fail a save;
reset on project switch). DETECTOR ONLY — no LLM, no .canvas/ write (that is T-M3).
EOF
git push origin feat/context
```

Then record the squash SHA back into the `docs/context-subsystem.md` gate row (amend or a follow-up `docs(context): record T-M2 squash SHA` commit), delete the sub-branch (`git branch -d feat/context-m2-change-detector`), and update the `canvas-ade-context` row on `.claude/coordination/ACTIVE-WORK.md` + the `context-subsystem` memory.

---

## Self-Review

**Spec coverage** (vs the T-M2 card in `docs/roadmap-context.md` + the kickoff):
- Fingerprint over meaningful fields only, geometry excluded → Task 1 (move-invariant + content-sensitive tests).
- Per-board ~30–60s debounce, trailing-edge, burst-collapse → Task 2 (`armDebounce` + burst test); 45s default, injectable.
- First save = baseline, no emit → Task 2 (`primed`, "first observe emits nothing" test).
- New board emits; removed board cancels → Task 2 (those two tests).
- Electron-free, injected clock/timer, deterministic → `Scheduler` seam + fake-scheduler tests.
- Fed from `project:save` after a successful write, best-effort try/catch → Task 3 ("throwing observe still returns true" test).
- Reset on project switch → Task 3 ("reset on open" test).
- Emits `{ boardId }` via injected callback; zero `llmService`/`canvasMemory` imports → Task 2 contract + final review check.
- e2e: content change → 1 intent, pure move → 0, real intents → Task 4 `context-change`.
- No LLM / no `.canvas/` write / no new egress / passive id-only → enforced across Tasks 1–4, reviewed in Task 5.
- Docs folded into `context-subsystem.md`, kickoff deleted, squash-merge → Task 5.

**Placeholder scan:** every code/step shows full code or an exact command + expected output. No TBD/ellipsis.

**Type consistency:** `SummarizeIntent { boardId }`, `Scheduler = (fn, ms) => Cancel`, `MemoryEngine { observe(doc), reset() }`, `MemoryEngineDeps { onIntent, debounceMs?, schedule? }`, `boardFingerprint(board: unknown): string`, `DEFAULT_DEBOUNCE_MS` — used identically in Tasks 1–4 and the docs. `registerProjectHandlers`' new 5th param `memoryEngine: MemoryEngine` matches the injected spy/throwing engines in the Task 3 tests.
