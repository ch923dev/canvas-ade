# M-digest T-D1 — Tier-1 Digest Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** A pure function `buildDigest(canvasDoc)` that turns a persisted `canvas.json` document into a
structured per-board context digest — the Tier-1 (no-LLM, no-key) data behind the reopen panel.

**Architecture:** One new pure module `src/renderer/src/lib/digest.ts`, no React / Zustand / network /
key. Reads only persisted fields from the existing `boardSchema` types. A top-level `buildDigest` maps
each board through a per-type helper (`digestTerminal` / `digestBrowser` / `digestPlanning`) and prepends
a count header. Cross-board info (which browser previews which terminal) is derived from the whole doc.

**Tech Stack:** TypeScript (strict), Vitest. Pure ESM module under the renderer's `lib/` (consumed by
the digest panel in T-D2; never imports a side-effecting module).

**Scope:** This plan is **only T-D1** (the pure module + its unit tests). The slide-in panel (T-D2),
the LLM brain (M-brain), and the `.canvas/` loop (M-memory) are separate plans. Stop for review after
T-D1.

**Reference — the persisted shapes this reads** (`src/renderer/src/lib/boardSchema.ts`, do not modify):
- `CanvasDoc = { schemaVersion, viewport, boards: Board[] }`
- `TerminalBoard`: `id,type,title` + optional `shell,launchCommand,cwd,port`
- `BrowserBoard`: `id,type,title,url,viewport` + optional `previewSourceId` (the terminal id that feeds it)
- `PlanningBoard`: `id,type,title,elements: PlanningElement[]`
- `ChecklistElement`: `kind:'checklist', title, items: {id,label,done}[]`
- `NoteElement`: `kind:'note', text, …`

**Digest rules (the contract these tasks build):**
- **header:** `"<N> board(s) — <t> terminal, <b> browser, <p> planning"`.
- **terminal:** line `Runs \`<launchCommand>\`` or `No launch command set`; `cwd: <cwd>` if set;
  `Dev server port <port>` if set; `Feeds preview "<browserTitle>"` if some browser's `previewSourceId`
  is this board. `status = launchCommand ? 'ready' : 'idle'`.
- **browser:** lines `URL <url>`, `Viewport <viewport>`; `Preview of "<terminalTitle>"` if
  `previewSourceId` set (fall back to the raw id if the source is missing). `status = previewSourceId ?
  'linked' : 'static'`.
- **planning:** one line per checklist `"<title>: <done>/<total> done"`; `"<n> note(s)"` if any notes;
  `Empty board` if no lines produced. `status` = aggregate `"<doneSum>/<totalSum> done"` across
  checklists, else `'notes'`.

---

### Task 1: Module scaffold — types + header + empty canvas

**Files:**
- Create: `src/renderer/src/lib/digest.ts`
- Test: `src/renderer/src/lib/digest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/digest.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildDigest } from './digest'
import type {
  CanvasDoc,
  TerminalBoard,
  BrowserBoard,
  PlanningBoard,
  PlanningElement
} from './boardSchema'

// ── test builders (minimal valid boards) ─────────────────────────────────────
function terminal(p: Partial<TerminalBoard> & { id: string }): TerminalBoard {
  return { type: 'terminal', x: 0, y: 0, w: 420, h: 340, title: 'Terminal', ...p }
}
function browser(p: Partial<BrowserBoard> & { id: string }): BrowserBoard {
  return {
    type: 'browser',
    x: 0,
    y: 0,
    w: 700,
    h: 500,
    title: 'Browser',
    url: 'http://localhost:5173',
    viewport: 'desktop',
    ...p
  }
}
function planning(
  p: Partial<PlanningBoard> & { id: string; elements?: PlanningElement[] }
): PlanningBoard {
  return { type: 'planning', x: 0, y: 0, w: 516, h: 366, title: 'Planning', elements: [], ...p }
}
function doc(boards: CanvasDoc['boards']): CanvasDoc {
  return { schemaVersion: 2, viewport: null, boards }
}

describe('buildDigest — header', () => {
  it('summarizes an empty canvas', () => {
    const d = buildDigest(doc([]))
    expect(d.header).toBe('0 boards — 0 terminal, 0 browser, 0 planning')
    expect(d.boards).toEqual([])
  })

  it('counts boards by type and carries one digest per board', () => {
    const d = buildDigest(
      doc([terminal({ id: 't1' }), browser({ id: 'b1' }), planning({ id: 'p1' })])
    )
    expect(d.header).toBe('3 boards — 1 terminal, 1 browser, 1 planning')
    expect(d.boards.map((x) => x.boardId)).toEqual(['t1', 'b1', 'p1'])
    expect(d.boards.map((x) => x.type)).toEqual(['terminal', 'browser', 'planning'])
    expect(d.boards.every((x) => typeof x.title === 'string')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/renderer/src/lib/digest.test.ts`
Expected: FAIL — `Failed to resolve import "./digest"` / `buildDigest is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/src/lib/digest.ts`:

```ts
/**
 * Tier-1 context digest (pure). Turns a persisted canvas document into a structured
 * per-board summary using ONLY fields already on disk in canvas.json — no LLM, no key,
 * no network, no runtime state. The reopen digest panel (T-D2) renders this when no
 * cached Tier-2 prose exists; the Tier-2 loop (M-memory) layers semantic summaries on top.
 */
import type {
  Board,
  BoardType,
  BrowserBoard,
  CanvasDoc,
  ChecklistElement,
  PlanningBoard,
  TerminalBoard
} from './boardSchema'

/** One board's heuristic digest. `lines` are human-readable; `status` is a coarse label. */
export interface BoardDigest {
  boardId: string
  type: BoardType
  title: string
  status: string
  lines: string[]
}

/** The whole-canvas Tier-1 digest: a header line + one entry per board (doc order). */
export interface CanvasDigest {
  header: string
  boards: BoardDigest[]
}

function buildHeader(boards: Board[]): string {
  const n = boards.length
  const by = (t: BoardType): number => boards.filter((b) => b.type === t).length
  return `${n} board${n === 1 ? '' : 's'} — ${by('terminal')} terminal, ${by('browser')} browser, ${by('planning')} planning`
}

/** Common skeleton; per-type helpers fill `status` + `lines`. */
function base(b: Board): BoardDigest {
  return { boardId: b.id, type: b.type, title: b.title, status: '', lines: [] }
}

function digestTerminal(b: TerminalBoard, _doc: CanvasDoc): BoardDigest {
  return base(b)
}
function digestBrowser(b: BrowserBoard, _doc: CanvasDoc): BoardDigest {
  return base(b)
}
function digestPlanning(b: PlanningBoard): BoardDigest {
  return base(b)
}

function digestBoard(b: Board, d: CanvasDoc): BoardDigest {
  switch (b.type) {
    case 'terminal':
      return digestTerminal(b, d)
    case 'browser':
      return digestBrowser(b, d)
    case 'planning':
      return digestPlanning(b)
  }
}

export function buildDigest(d: CanvasDoc): CanvasDigest {
  return { header: buildHeader(d.boards), boards: d.boards.map((b) => digestBoard(b, d)) }
}

// `ChecklistElement` is imported here so later tasks (planning) need no import churn.
export type { ChecklistElement }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/renderer/src/lib/digest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/digest.ts src/renderer/src/lib/digest.test.ts
git commit -m "feat(context): Tier-1 digest scaffold — types + header"
```

---

### Task 2: Terminal digest

**Files:**
- Modify: `src/renderer/src/lib/digest.ts` (replace `digestTerminal`)
- Test: `src/renderer/src/lib/digest.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/src/lib/digest.test.ts`:

```ts
describe('buildDigest — terminal', () => {
  it('reports launchCommand, cwd and port', () => {
    const d = buildDigest(
      doc([terminal({ id: 't1', launchCommand: 'claude', cwd: 'Z:/app', port: 5173 })])
    )
    const t = d.boards[0]
    expect(t.status).toBe('ready')
    expect(t.lines).toEqual(['Runs `claude`', 'cwd: Z:/app', 'Dev server port 5173'])
  })

  it('flags a terminal with no launch command as idle', () => {
    const d = buildDigest(doc([terminal({ id: 't1' })]))
    expect(d.boards[0].status).toBe('idle')
    expect(d.boards[0].lines).toEqual(['No launch command set'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/renderer/src/lib/digest.test.ts`
Expected: FAIL — `status` is `''` and `lines` is `[]` (stub).

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/src/lib/digest.ts`, replace the `digestTerminal` stub with:

```ts
function digestTerminal(b: TerminalBoard, d: CanvasDoc): BoardDigest {
  const lines: string[] = []
  if (b.launchCommand) lines.push(`Runs \`${b.launchCommand}\``)
  else lines.push('No launch command set')
  if (b.cwd) lines.push(`cwd: ${b.cwd}`)
  if (b.port !== undefined) lines.push(`Dev server port ${b.port}`)
  const consumer = d.boards.find(
    (o): o is BrowserBoard => o.type === 'browser' && o.previewSourceId === b.id
  )
  if (consumer) lines.push(`Feeds preview "${consumer.title}"`)
  return {
    boardId: b.id,
    type: 'terminal',
    title: b.title,
    status: b.launchCommand ? 'ready' : 'idle',
    lines
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/renderer/src/lib/digest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/digest.ts src/renderer/src/lib/digest.test.ts
git commit -m "feat(context): Tier-1 terminal digest"
```

---

### Task 3: Browser digest + reverse preview link

**Files:**
- Modify: `src/renderer/src/lib/digest.ts` (replace `digestBrowser`)
- Test: `src/renderer/src/lib/digest.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/src/lib/digest.test.ts`:

```ts
describe('buildDigest — browser', () => {
  it('reports url and viewport for an unlinked browser', () => {
    const d = buildDigest(
      doc([browser({ id: 'b1', url: 'http://localhost:3000', viewport: 'mobile' })])
    )
    const b = d.boards[0]
    expect(b.status).toBe('static')
    expect(b.lines).toEqual(['URL http://localhost:3000', 'Viewport mobile'])
  })

  it('names the source terminal when previewSourceId is set', () => {
    const d = buildDigest(
      doc([
        terminal({ id: 't1', title: 'Dev server', launchCommand: 'pnpm dev', port: 5173 }),
        browser({ id: 'b1', previewSourceId: 't1' })
      ])
    )
    const b = d.boards[1]
    expect(b.status).toBe('linked')
    expect(b.lines).toContain('Preview of "Dev server"')
    // and the terminal side reports the reverse link
    expect(d.boards[0].lines).toContain('Feeds preview "Browser"')
  })

  it('falls back to the raw id when the source terminal is gone', () => {
    const d = buildDigest(doc([browser({ id: 'b1', previewSourceId: 'missing' })]))
    expect(d.boards[0].lines).toContain('Preview of "missing"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/renderer/src/lib/digest.test.ts`
Expected: FAIL — browser `status`/`lines` are stubbed empty.

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/src/lib/digest.ts`, replace the `digestBrowser` stub with:

```ts
function digestBrowser(b: BrowserBoard, d: CanvasDoc): BoardDigest {
  const lines: string[] = [`URL ${b.url}`, `Viewport ${b.viewport}`]
  if (b.previewSourceId) {
    const src = d.boards.find((o) => o.id === b.previewSourceId)
    lines.push(`Preview of "${src?.title ?? b.previewSourceId}"`)
  }
  return {
    boardId: b.id,
    type: 'browser',
    title: b.title,
    status: b.previewSourceId ? 'linked' : 'static',
    lines
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/renderer/src/lib/digest.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/digest.ts src/renderer/src/lib/digest.test.ts
git commit -m "feat(context): Tier-1 browser digest + reverse preview link"
```

---

### Task 4: Planning digest (checklists + notes)

**Files:**
- Modify: `src/renderer/src/lib/digest.ts` (replace `digestPlanning`)
- Test: `src/renderer/src/lib/digest.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/src/lib/digest.test.ts`:

```ts
import type { ChecklistElement, NoteElement } from './boardSchema'

function checklist(title: string, done: number, total: number): ChecklistElement {
  const items = Array.from({ length: total }, (_, i) => ({
    id: `i${i}`,
    label: `item ${i}`,
    done: i < done
  }))
  return { kind: 'checklist', id: `c-${title}`, x: 0, y: 0, w: 240, h: 0, title, items }
}
function note(id: string): NoteElement {
  return { kind: 'note', id, x: 0, y: 0, w: 160, h: 120, tint: 'yellow', text: 'hi' }
}

describe('buildDigest — planning', () => {
  it('reports checklist progress and note count', () => {
    const d = buildDigest(
      doc([
        planning({
          id: 'p1',
          elements: [checklist('Auth', 1, 3), checklist('UI', 2, 2), note('n1'), note('n2')]
        })
      ])
    )
    const p = d.boards[0]
    expect(p.lines).toEqual(['Auth: 1/3 done', 'UI: 2/2 done', '2 notes'])
    expect(p.status).toBe('3/5 done')
  })

  it('uses singular "note" for one note and notes status with no checklist', () => {
    const d = buildDigest(doc([planning({ id: 'p1', elements: [note('n1')] })]))
    expect(d.boards[0].lines).toEqual(['1 note'])
    expect(d.boards[0].status).toBe('notes')
  })

  it('labels a truly empty planning board', () => {
    const d = buildDigest(doc([planning({ id: 'p1', elements: [] })]))
    expect(d.boards[0].lines).toEqual(['Empty board'])
    expect(d.boards[0].status).toBe('notes')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/renderer/src/lib/digest.test.ts`
Expected: FAIL — planning `status`/`lines` are stubbed empty.

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/src/lib/digest.ts`, replace the `digestPlanning` stub with:

```ts
function digestPlanning(b: PlanningBoard): BoardDigest {
  const checklists = b.elements.filter((e): e is ChecklistElement => e.kind === 'checklist')
  const noteCount = b.elements.filter((e) => e.kind === 'note').length
  const lines: string[] = []
  for (const c of checklists) {
    const done = c.items.filter((i) => i.done).length
    lines.push(`${c.title}: ${done}/${c.items.length} done`)
  }
  if (noteCount > 0) lines.push(`${noteCount} note${noteCount === 1 ? '' : 's'}`)
  if (lines.length === 0) lines.push('Empty board')
  const totalItems = checklists.reduce((s, c) => s + c.items.length, 0)
  const totalDone = checklists.reduce((s, c) => s + c.items.filter((i) => i.done).length, 0)
  const status = checklists.length > 0 ? `${totalDone}/${totalItems} done` : 'notes'
  return { boardId: b.id, type: 'planning', title: b.title, status, lines }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/renderer/src/lib/digest.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/digest.ts src/renderer/src/lib/digest.test.ts
git commit -m "feat(context): Tier-1 planning digest (checklists + notes)"
```

---

### Task 5: Full gate + handoff

**Files:**
- Create: `docs/superpowers/handoffs/2026-06-03-context-d1-digest.md`

- [ ] **Step 1: Run the full gate**

Run (from the worktree root `Z:\canvas-ade-context`):
`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all green; the new `digest.test.ts` (10 tests) is included in the unit count.

> If `format:check` flags `digest.ts` / `digest.test.ts`, run `pnpm exec prettier --write
> src/renderer/src/lib/digest.ts src/renderer/src/lib/digest.test.ts` and re-run the gate. (Do NOT run
> a repo-wide `pnpm format` — only your two files.)

- [ ] **Step 2: Write the handoff doc**

Create `docs/superpowers/handoffs/2026-06-03-context-d1-digest.md` covering: what landed (the
`buildDigest` pure module + `CanvasDigest`/`BoardDigest` types), files (`digest.ts`, `digest.test.ts`),
test evidence (10 unit tests, gate green), the digest-rule contract (copy the rules block from this
plan's header), follow-ups (none for T-D1; T-D2 consumes `CanvasDigest`), and the next-task pointer
(**T-D2 — slide-in digest panel**, see `docs/roadmap-context.md` › M-digest).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/handoffs/2026-06-03-context-d1-digest.md
git commit -m "docs(context): T-D1 handoff — Tier-1 digest module"
```

- [ ] **Step 4: Note on the coordination board**

Update the `canvas-ade-context` row's Notes on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md`:
"T-D1 done — `digest.ts` Tier-1 module + 10 tests, gate green. Next: T-D2 panel."

---

## Self-Review

**Spec coverage (T-D1 slice of the design §5.1):**
- pure `buildDigest(canvasDoc) → DigestModel` ✓ (Task 1)
- terminal launchCommand/cwd/port + linked-preview ✓ (Tasks 2, 3 reverse link)
- browser url/viewport/previewSourceId ✓ (Task 3)
- planning checklist title+done/total + note count ✓ (Task 4)
- disk-only (no runtime last-command/status) ✓ — explicitly out of scope per design §5.1; captured by
  the Tier-2 loop later, not here.

**Placeholder scan:** none — every step has concrete code + exact commands.

**Type consistency:** `BoardDigest` / `CanvasDigest` field names (`boardId,type,title,status,lines` /
`header,boards`) are identical across all tasks. Helper names (`digestTerminal`/`digestBrowser`/
`digestPlanning`/`buildHeader`/`base`/`digestBoard`) are stable from Task 1 and only have bodies
replaced. Test builders (`terminal`/`browser`/`planning`/`doc`/`checklist`/`note`) are consistent.

**Note:** the `ChecklistElement` re-export in Task 1 keeps the type imported from the start so Task 4
adds no import churn to `digest.ts`; the `import type { ChecklistElement, NoteElement }` in the Task 4
test block is additive to the test file only.
```

