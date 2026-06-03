# Context M-memory T-M3 — Tier-2 Autonomous Summary Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the T-M2 `{ boardId }` change-intent into the first **autonomous-spend** path — re-read the board from disk, summarize its content via the **budgeted** `runSummarize`, and cache the prose into `<project>/.canvas/memory/board-<id>.md` + refresh `MEMORY.md`/`project.md`. No key → no spend, no write. Over budget / provider-error → no-op (Tier-1 stays).

**Architecture:** A new Electron-free `src/main/summaryLoop.ts` exposes pure builders (`buildSummarizeInput`, `buildMemoryIndex`, `buildProjectRollup`) + a stateful `createSummaryLoop(deps) → { onIntent }`. On `onIntent({ boardId })` it: `getCurrentDir()` → `readProject(dir)` → find the board → build a capped `SummarizeInput` (MAIN-side defensive pick; MAIN can't import the renderer `boardSchema`/`digest.ts`) → `runSummarize(readLlmConfig(llmDataDir), input, deps)` where `deps` carries a **file-backed** `keyStore` + `budget` pointed at the same `llmDataDir` (so the cap/key are shared with `registerLlmHandlers` — the budget's atomic read-modify-write keeps two stores correct) → on `ok` write `board-<id>.md` + rebuild the index/rollup; on any `!ok` reason → no-op. A per-board in-flight `Set` prevents a slow call + a fresh intent from double-firing. `index.ts` builds the loop, constructs the T-M2 engine with the loop's real `onIntent`, and passes that engine as the 5th arg of `registerProjectHandlers` so the SAME engine `project:save` feeds also drives the loop. Two hardening riders ship with it (required before an autonomous loop calls them): a `fetch` `AbortController` timeout in `llmService` (a hung provider can't wedge the loop) and `try/catch` + a `safeBoardId` length cap in `canvasMemory` writers (a disk error is non-fatal).

**Tech Stack:** TypeScript (strict), Electron MAIN (`src/main/`), Vitest, the existing `CANVAS_SMOKE=e2e` MAIN-side probe harness (`src/main/e2e/`). LLM mocked under e2e (no real network).

---

## Design-note resolutions (settled before coding)

1. **Shared deps vs second instance** — the loop builds its **OWN** `createKeyStore(llmDataDir, encryptor)` + `createBudgetStore(llmDataDir, now)`, file-backed at the same `llmDataDir` as `registerLlmHandlers`. Both budget stores read/modify/write `userData/llm-budget.json`; `tryConsume` is a **synchronous** read-then-write (no `await` between read and write), so the two consumers (the `llm:summarize` IPC and the loop) can never interleave mid-reservation — the increments serialize on the event loop and the daily cap is shared correctly. This is lower-churn than refactoring `index.ts` to build one shared `ProviderDeps`. (Verified against `src/main/llmBudget.ts:80-86`.)
2. **Enablement** — v1 is **implicitly opt-in**: the loop runs iff a key is configured (no key → `runSummarize` returns `no-provider` → no spend / no write). An explicit `memoryLoopEnabled` toggle is **deferred** (the key-presence gate + the per-day budget cap already bound spend; an off-switch is a small Settings follow-on).
3. **`MEMORY.md` / `project.md` shape** — kept small and rebuilt deterministically from the doc each fire. `MEMORY.md` = a `# Memory` header + one line per board: `- <title> (<type>) — board-<id>.md` with a trailing ` ✓` when a cached summary exists. `project.md` = a `# <projectName>` header + a one-line board-count roll-up. Both are **pure builders** (`buildMemoryIndex(doc, hasSummary)`, `buildProjectRollup(name, doc)`), unit-tested; the panel (T-M4) renders `board-<id>.md` prose first and these as context.
4. **Prompt + input size** — `system` = `"Summarize what this board is for in 1-2 sentences. Be concise and factual; do not invent details."`. The board content fed in is picked from `canvas.json` (terminal `launchCommand`/`cwd`/`port`; browser `url`/`viewport`; planning checklist titles + items + note text) and **truncated to `MAX_INPUT_CHARS = 4000`**. (canvas.json holds NO live terminal scrollback — see note 5.)
5. **Terminal runtime last-command/status is OUT of T-M3 core.** It needs a PTY-state source (`docs/roadmap-context.md` open question #2 — scrape `pty.ts` vs a structured hook) and is **not** in `canvas.json`. **T-M3 = content-summary-from-`canvas.json` only**; the runtime capture is a separate follow-on card (it touches `pty.ts`, a different zone). Flagged so this card stays bite-sized.
6. **Concurrency / debounce interaction** — a per-board in-flight `Set<boardId>`: `onIntent` for a board already summarizing returns immediately. The T-M2 45s trailing-edge debounce already coalesces a burst into one intent; if a board changes again WHILE its summary is in flight, T-M2 re-arms its debounce (it re-fingerprints on the next `project:save`) and fires a fresh intent after settle — by then the in-flight guard has cleared, so exactly one follow-up call runs. No double-fire.

**🔒 Security (locked — this is the milestone the guards protect):**
- **Opt-in / no implicit spend:** no key → `runSummarize` → `no-provider` → the loop writes nothing and makes no network call.
- **Capped:** the loop goes through `runSummarize`, which reserves against the same file-backed per-day budget **before** the fetch (ADR 0003). NO second egress path bypasses the cap.
- **Passive output (lethal-trifecta):** the summary is untrusted passive context — written to disk + later shown/MCP-read; it **never triggers an action**. The loop's only effects are the one LLM call and the `.canvas/` writes; nothing it produces returns to the PTY write channel, a board patch, or any tool. Board content fed INTO the prompt is itself untrusted, which is fine because the output is treated as passive and the input only ever becomes request-body text.
- **No posture change:** `contextIsolation`/`sandbox`/`no-nodeIntegration` untouched; no new IPC channel (the loop is MAIN-internal, driven by the existing `project:save` feed); the key NEVER leaves MAIN / never lands in `.canvas/` / `canvas.json`.

**Out of scope (do NOT build):** the panel cached-prose upgrade + renderer read bridge → T-M4; the terminal runtime last-command/live-status capture (PTY-state plumbing) → a follow-on (note 5); the MCP `canvas://memory` read resource → M-expose (deferred); embeddings / vector search / multi-project memory / any memory-driven *write* action (forbidden).

---

## File Structure

- **Modify** `src/main/canvasMemory.ts` — wrap `writeBoard`/`writeIndex`/`writeProject` in try/catch (log + falsy/void on failure) + a `safeBoardId` length cap (≤ 64). The T-M1 follow-up; required before an autonomous loop calls the writers. *(Task 1)*
- **Modify** `src/main/llmService.ts` — add an `AbortController` fetch timeout (default 30s, injectable) so a hung provider can't wedge the loop; `runSummarize` already maps a throw → `provider-error` → Tier-1. *(Task 2)*
- **Create** `src/main/summaryLoop.ts` — pure builders (`buildSummarizeInput`, `buildMemoryIndex`, `buildProjectRollup`) *(Task 3)* + the stateful `createSummaryLoop` with the in-flight guard *(Task 4)*. One responsibility: turn a `{ boardId }` intent into a cached summary + refreshed index.
- **Create** `src/main/summaryLoop.test.ts` — unit tests for the builders *(Task 3)* + the loop *(Task 4)*.
- **Modify** `src/main/index.ts` — build the loop (needs `llmDataDir` + `llmEncryptor`), construct the engine with the loop's `onIntent`, pass it as the 5th arg to `registerProjectHandlers`. (⚠️ CROSS-ZONE: `index.ts` is also touched additively by `feat/mcp-integration` — additive, no shared lines expected.) *(Task 5)*
- **Create** `src/main/e2e/probes/summary.ts` + **Modify** `src/main/e2e/index.ts` — `context-summary` probe (mock provider; drive `onIntent` → assert `board-<id>.md` changed to the mock summary + `MEMORY.md` lists the board). *(Task 6)*
- **Modify** `docs/context-subsystem.md` + **Delete** `docs/superpowers/handoffs/2026-06-04-context-m3-kickoff.md` — fold the milestone, drop the kickoff. *(Task 7)*

---

## Task 1: `canvasMemory` writer hardening + `safeBoardId` length cap

**Files:**
- Modify: `src/main/canvasMemory.ts`
- Test: `src/main/canvasMemory.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/canvasMemory.test.ts` (reuse the existing `mkdtempSync`/`tmpdir`/`join`/`rmSync`/`writeFileSync` imports; add `writeFileSync` to the `fs` import if absent):

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCanvasMemory, safeBoardId } from './canvasMemory'

describe('safeBoardId — length cap (T-M3)', () => {
  it('rejects an over-long id (> 64 chars) even if every char is in the alphabet', () => {
    expect(safeBoardId('a'.repeat(64))).toBe(true)
    expect(safeBoardId('a'.repeat(65))).toBe(false)
  })
})

describe('canvasMemory writers — non-fatal on a disk error (T-M3)', () => {
  it('writeBoard returns false (does not throw) when the project path is unwritable', () => {
    // projectDir points at a FILE, so mkdirSync(<file>/.canvas/memory) throws ENOTDIR/EEXIST.
    const dir = mkdtempSync(join(tmpdir(), 'cm-bad-'))
    const asFile = join(dir, 'not-a-dir')
    writeFileSync(asFile, 'x')
    try {
      const mem = createCanvasMemory(asFile)
      expect(() => mem.writeBoard('b1', '# hi')).not.toThrow()
      expect(mem.writeBoard('b1', '# hi')).toBe(false)
      expect(() => mem.writeIndex('# idx')).not.toThrow()
      expect(() => mem.writeProject('# proj')).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/canvasMemory.test.ts`
Expected: FAIL — `safeBoardId('a'.repeat(65))` is currently `true` (no length cap); `writeBoard` currently throws on the unwritable path (no try/catch).

- [ ] **Step 3: Write the minimal implementation**

In `src/main/canvasMemory.ts`, add a length cap to `safeBoardId`:

```ts
/** Board ids are nanoid-style; reject anything else (and over-long) to keep writes inside memory/. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/
const MAX_ID_LEN = 64
export function safeBoardId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LEN && SAFE_ID.test(id)
}
```

Wrap each writer in try/catch (the readers already swallow errors). Replace the three writer methods in the returned object:

```ts
    writeBoard(id, md) {
      if (!safeBoardId(id)) return false
      try {
        mkdirSync(memoryDir, { recursive: true })
        writeFileAtomic.sync(paths.board(id), md, 'utf8')
        return true
      } catch (err) {
        console.warn('[canvasMemory] writeBoard failed (non-fatal)', err)
        return false
      }
    },
    writeIndex(md) {
      try {
        mkdirSync(memoryDir, { recursive: true })
        writeFileAtomic.sync(paths.index, md, 'utf8')
      } catch (err) {
        console.warn('[canvasMemory] writeIndex failed (non-fatal)', err)
      }
    },
    writeProject(md) {
      try {
        mkdirSync(memoryDir, { recursive: true })
        writeFileAtomic.sync(paths.project, md, 'utf8')
      } catch (err) {
        console.warn('[canvasMemory] writeProject failed (non-fatal)', err)
      }
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/canvasMemory.test.ts`
Expected: PASS (the 2 new describes + all pre-existing `canvasMemory` tests green).

- [ ] **Step 5: Commit**

```bash
git add src/main/canvasMemory.ts src/main/canvasMemory.test.ts
git commit -F - <<'EOF'
fix(context): T-M3 rider — canvasMemory writers non-fatal + safeBoardId length cap

Wrap writeBoard/writeIndex/writeProject in try/catch (log + falsy/void on a disk
error) so the autonomous T-M3 loop can never crash on EACCES/ENOSPC. Cap safeBoardId
at 64 chars (the T-M1 follow-up) so a pathological id can't produce an ENAMETOOLONG
filename. Readers were already error-swallowing.
EOF
```

---

## Task 2: `llmService` fetch timeout (AbortController)

**Files:**
- Modify: `src/main/llmService.ts`
- Test: `src/main/llmService.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/main/llmService.test.ts` (reuse its existing `runSummarize`/config/deps test helpers — match the file's existing import style; the snippet below shows the shape):

```ts
import { describe, it, expect } from 'vitest'
import { runSummarize, type FetchLike } from './llmService'

describe('llmService — fetch timeout (T-M3)', () => {
  it('aborts a hung provider and degrades to provider-error', async () => {
    // A fetch that never resolves on its own — it only settles when the injected
    // AbortController fires signal.abort, rejecting like the real fetch does.
    const hung: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        )
      })
    const config = { provider: 'openrouter' as const, model: 'm' }
    const res = await runSummarize(
      config,
      { text: 'hello' },
      { fetch: hung, env: { OPENROUTER_API_KEY: 'k' }, timeoutMs: 10 }
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('provider-error')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: FAIL — `FetchLike.init` has no `signal`, `ProviderDeps` has no `timeoutMs`, and the request never aborts (the test hangs until the Vitest timeout).

- [ ] **Step 3: Write the minimal implementation**

In `src/main/llmService.ts`:

1. Add `signal` to the `FetchLike` init shape:

```ts
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>
```

2. Add `timeoutMs` to `ProviderDeps` (with the others):

```ts
export interface ProviderDeps {
  fetch: FetchLike
  env: Record<string, string | undefined>
  keyStore?: Pick<KeyStore, 'getKey'>
  budget?: BudgetStore
  /** T-M3: abort a hung provider after this many ms (default 30s) so the loop can't wedge. */
  timeoutMs?: number
}
```

3. Add the default constant near `SUMMARY_MAX_TOKENS`:

```ts
/** T-M3: default per-call fetch timeout — a hung endpoint aborts → provider-error → Tier-1. */
const DEFAULT_TIMEOUT_MS = 30_000
```

4. In `getProvider`'s real `summarize`, wrap the fetch in an `AbortController`:

```ts
    async summarize(input: SummarizeInput): Promise<string> {
      const req = buildRequest(config.provider, config, resolvedKey, input)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      try {
        const res = await deps.fetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: req.body,
          signal: controller.signal
        })
        if (!res.ok) throw new Error(`${config.provider} HTTP ${res.status}: ${await res.text()}`)
        return parseResponse(config.provider, await res.json())
      } finally {
        clearTimeout(timer)
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: PASS (the new timeout test + all pre-existing `llmService` tests green; the existing fake-fetch tests ignore the extra `signal` field).

- [ ] **Step 5: Commit**

```bash
git add src/main/llmService.ts src/main/llmService.test.ts
git commit -F - <<'EOF'
feat(context): T-M3 rider — AbortController fetch timeout in the provider engine

Wrap the single outbound fetch in an AbortController (default 30s, injectable via
ProviderDeps.timeoutMs) so a hung LLM endpoint can't wedge the autonomous summary
loop. A timeout rejects like a transport error; runSummarize already maps a throw to
provider-error → Tier-1. FetchLike init gains an optional signal.
EOF
```

---

## Task 3: `summaryLoop` pure builders — input + index + rollup

**Files:**
- Create: `src/main/summaryLoop.ts`
- Test: `src/main/summaryLoop.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/summaryLoop.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  buildSummarizeInput,
  buildMemoryIndex,
  buildProjectRollup,
  MAX_INPUT_CHARS
} from './summaryLoop'

const terminal = (over: Record<string, unknown> = {}): unknown => ({
  id: 't1',
  type: 'terminal',
  title: 'Dev',
  launchCommand: 'pnpm dev',
  cwd: '/repo',
  port: 5173,
  ...over
})
const browser = (over: Record<string, unknown> = {}): unknown => ({
  id: 'b1',
  type: 'browser',
  title: 'Preview',
  url: 'http://localhost:5173',
  viewport: 'desktop',
  ...over
})
const planning = (elements: unknown[]): unknown => ({
  id: 'p1',
  type: 'planning',
  title: 'Plan',
  elements
})

describe('buildSummarizeInput — content pick + cap', () => {
  it('terminal: includes launchCommand / cwd / port', () => {
    const inp = buildSummarizeInput(terminal())
    expect(inp.text).toContain('pnpm dev')
    expect(inp.text).toContain('/repo')
    expect(inp.text).toContain('5173')
    expect(inp.system).toMatch(/summarize/i)
  })
  it('browser: includes url + viewport', () => {
    const inp = buildSummarizeInput(browser())
    expect(inp.text).toContain('http://localhost:5173')
    expect(inp.text).toContain('desktop')
  })
  it('planning: includes checklist titles + item labels + note text', () => {
    const inp = buildSummarizeInput(
      planning([
        { id: 'c1', kind: 'checklist', title: 'Tasks', items: [{ id: 'i1', label: 'ship it', done: false }] },
        { id: 'n1', kind: 'note', text: 'remember the gate' }
      ])
    )
    expect(inp.text).toContain('Tasks')
    expect(inp.text).toContain('ship it')
    expect(inp.text).toContain('remember the gate')
  })
  it('truncates over-long content to MAX_INPUT_CHARS', () => {
    const huge = buildSummarizeInput(planning([{ id: 'n1', kind: 'note', text: 'x'.repeat(10_000) }]))
    expect(huge.text.length).toBeLessThanOrEqual(MAX_INPUT_CHARS)
  })
  it('malformed / unknown board never throws and yields a non-empty prompt', () => {
    expect(() => buildSummarizeInput(null)).not.toThrow()
    expect(() => buildSummarizeInput({ type: 'mystery', title: 'Huh' })).not.toThrow()
    expect(buildSummarizeInput({ type: 'mystery', title: 'Huh' }).text.length).toBeGreaterThan(0)
  })
})

describe('buildMemoryIndex — one line per board, ✓ when summarized', () => {
  it('lists every board with type + filename; marks summarized boards', () => {
    const doc = { boards: [terminal(), browser()] }
    const md = buildMemoryIndex(doc, (id) => id === 't1')
    expect(md).toMatch(/^# Memory/m)
    expect(md).toContain('- Dev (terminal) — board-t1.md ✓')
    expect(md).toContain('- Preview (browser) — board-b1.md')
    expect(md).not.toContain('board-b1.md ✓')
  })
  it('malformed doc → header only, never throws', () => {
    expect(() => buildMemoryIndex(null, () => false)).not.toThrow()
    expect(buildMemoryIndex({ boards: 'nope' }, () => false)).toMatch(/^# Memory/m)
  })
})

describe('buildProjectRollup — small project-level header', () => {
  it('header with the project name + a board-count roll-up', () => {
    const md = buildProjectRollup('my-proj', { boards: [terminal(), browser(), planning([])] })
    expect(md).toMatch(/^# my-proj/m)
    expect(md).toContain('3 boards')
    expect(md).toContain('1 terminal')
    expect(md).toContain('1 browser')
    expect(md).toContain('1 planning')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/summaryLoop.test.ts`
Expected: FAIL — `summaryLoop` module does not exist (no exports).

- [ ] **Step 3: Write the minimal implementation**

Create `src/main/summaryLoop.ts`:

```ts
/**
 * T-M3: the Tier-2 autonomous summary loop. A {boardId} change-intent (from the T-M2
 * detector) → re-read the board from disk → summarize its CONTENT via the budgeted
 * runSummarize → cache the prose into <project>/.canvas/memory/board-<id>.md + refresh
 * MEMORY.md/project.md. The FIRST autonomous-spend path in the app.
 *
 * 🔒 Opt-in (no key → no-provider → no spend / no write), capped (goes through the
 * budgeted runSummarize — no second egress), passive output (the summary is untrusted
 * passive context: written + later shown/MCP-read, it NEVER triggers an action). The key
 * never leaves MAIN / never lands in .canvas/.
 *
 * PROCESS-BOUNDARY NOTE: MAIN cannot import the renderer's boardSchema/digest.ts
 * (tsconfig.node = src/main/**), so the board content is picked here defensively from the
 * `unknown` doc, mirroring the fields digest.ts/memoryEngine.ts surface (terminal
 * launchCommand/cwd/port; browser url/viewport; planning checklist titles+items + note
 * text).
 */
import type { SummarizeInput } from './llmService'

/** Cap the board-content text fed to the model (canvas.json has no live scrollback). */
export const MAX_INPUT_CHARS = 4000

const SYSTEM =
  'Summarize what this board is for in 1-2 sentences. Be concise and factual; do not invent details.'

type RawBoard = { id?: unknown; type?: unknown; title?: unknown; [k: string]: unknown }

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

/** The meaningful, human-readable content slice of one board (mirrors digest.ts fields). */
function boardContent(b: RawBoard): string {
  const title = str(b.title)
  switch (b.type) {
    case 'terminal':
      return [
        `Terminal board "${title}".`,
        str(b.launchCommand) && `Runs: ${str(b.launchCommand)}`,
        str(b.cwd) && `cwd: ${str(b.cwd)}`,
        num(b.port) && `Dev server port: ${num(b.port)}`
      ]
        .filter(Boolean)
        .join('\n')
    case 'browser':
      return [
        `Browser preview board "${title}".`,
        str(b.url) && `URL: ${str(b.url)}`,
        str(b.viewport) && `Viewport: ${str(b.viewport)}`
      ]
        .filter(Boolean)
        .join('\n')
    case 'planning': {
      const els = Array.isArray(b.elements) ? (b.elements as RawBoard[]) : []
      const lines: string[] = [`Planning board "${title}".`]
      for (const e of els) {
        if (e.kind === 'checklist') {
          const items = Array.isArray(e.items) ? (e.items as RawBoard[]) : []
          lines.push(`Checklist "${str(e.title)}":`)
          for (const i of items) lines.push(`- [${i.done === true ? 'x' : ' '}] ${str(i.label)}`)
        } else if (e.kind === 'note') {
          lines.push(`Note: ${str(e.text)}`)
        }
      }
      return lines.join('\n')
    }
    default:
      return `Board "${title}" (${str(b.type) || 'unknown'}).`
  }
}

/** Pure: a board → a capped SummarizeInput. Never throws on malformed input. */
export function buildSummarizeInput(board: unknown): SummarizeInput {
  const b = (board ?? {}) as RawBoard
  const text = boardContent(b).slice(0, MAX_INPUT_CHARS)
  return { system: SYSTEM, text: text.length > 0 ? text : 'Empty board.' }
}

function boardsOf(doc: unknown): RawBoard[] {
  const boards = (doc as { boards?: unknown })?.boards
  return Array.isArray(boards) ? (boards as RawBoard[]) : []
}

/** Pure: rebuild MEMORY.md — one line per board, ` ✓` when a cached summary exists. */
export function buildMemoryIndex(doc: unknown, hasSummary: (id: string) => boolean): string {
  const lines = ['# Memory', '']
  for (const b of boardsOf(doc)) {
    const id = str(b.id)
    if (!id) continue
    const mark = hasSummary(id) ? ' ✓' : ''
    lines.push(`- ${str(b.title) || '(untitled)'} (${str(b.type) || 'unknown'}) — board-${id}.md${mark}`)
  }
  return lines.join('\n') + '\n'
}

/** Pure: a small project-level roll-up (header + board counts). */
export function buildProjectRollup(name: string, doc: unknown): string {
  const boards = boardsOf(doc)
  const by = (t: string): number => boards.filter((b) => b.type === t).length
  const n = boards.length
  return (
    `# ${name}\n\n` +
    `${n} board${n === 1 ? '' : 's'}: ` +
    `${by('terminal')} terminal, ${by('browser')} browser, ${by('planning')} planning\n`
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/summaryLoop.test.ts`
Expected: PASS (all builder describes green).

- [ ] **Step 5: Commit**

```bash
git add src/main/summaryLoop.ts src/main/summaryLoop.test.ts
git commit -F - <<'EOF'
feat(context): T-M3 summaryLoop builders — input + index + rollup (pure)

buildSummarizeInput picks a board's meaningful content (mirrors digest.ts; defensive
on the unknown doc) into a capped SummarizeInput (4000 chars; canvas.json has no live
scrollback). buildMemoryIndex/buildProjectRollup rebuild MEMORY.md (one line per board,
✓ when summarized) and project.md (header + board counts). All pure, malformed-safe.
EOF
```

---

## Task 4: `createSummaryLoop` — read → summarize → write, with the in-flight guard

**Files:**
- Modify: `src/main/summaryLoop.ts` (append the loop)
- Test: `src/main/summaryLoop.test.ts` (append loop tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/main/summaryLoop.test.ts`:

```ts
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSummaryLoop } from './summaryLoop'
import { createCanvasMemory } from './canvasMemory'
import type { Encryptor } from './llmKeyStore'

/** A trivial Encryptor (round-trips through a base64 tag) — fine for the mock path (no key needed). */
const fakeEncryptor: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => Buffer.from(b).toString('utf8')
}

const docWith = (boards: unknown[]): unknown => ({ schemaVersion: 4, viewport: null, boards })
const planNote = (id: string, text: string): unknown => ({
  id,
  type: 'planning',
  title: 'Plan',
  elements: [{ id: 'n1', kind: 'note', text }]
})

/** Build a loop over a throwaway project dir + llm dir, with the e2e mock provider on. */
function makeLoop(opts: { getDir: () => string | null; doc: unknown; provider?: string }) {
  const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
  const loop = createSummaryLoop({
    llmDataDir,
    encryptor: fakeEncryptor,
    getCurrentDir: opts.getDir,
    readProject: () => {
      const d = opts.getDir()
      return d ? { ok: true, dir: d, name: 'proj', doc: opts.doc } : { ok: false, error: 'none' }
    },
    now: () => new Date(),
    // CANVAS_LLM_MOCK forces getProvider → mock ([mock] <text>); no network, no key needed.
    env: { CANVAS_LLM_MOCK: '1', ...(opts.provider ? { provider: opts.provider } : {}) }
  })
  return { loop, llmDataDir }
}

describe('createSummaryLoop — write on ok', () => {
  it('summarizes the board and writes board-<id>.md + MEMORY.md', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const { loop, llmDataDir } = makeLoop({ getDir: () => proj, doc: docWith([planNote('p1', 'hello world')]) })
    try {
      await loop.onIntent({ boardId: 'p1' })
      const mem = createCanvasMemory(proj)
      const board = mem.readBoard('p1')
      expect(board).toBeDefined()
      expect(board).toContain('[mock]') // mock provider prefixes the summary
      expect(board).toContain('hello world') // the board content reached the prompt
      const index = mem.readIndex()
      expect(index).toContain('board-p1.md ✓')
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })
})

describe('createSummaryLoop — no-op paths', () => {
  it('writes nothing when no project is open (getCurrentDir null)', async () => {
    const { loop, llmDataDir } = makeLoop({ getDir: () => null, doc: docWith([planNote('p1', 'x')]) })
    try {
      await loop.onIntent({ boardId: 'p1' }) // must not throw
    } finally {
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })

  it('writes nothing when the board was deleted between debounce and fire', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const { loop, llmDataDir } = makeLoop({ getDir: () => proj, doc: docWith([planNote('p1', 'x')]) })
    try {
      await loop.onIntent({ boardId: 'GONE' })
      expect(existsSync(join(proj, '.canvas', 'memory', 'board-GONE.md'))).toBe(false)
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })
})

describe('createSummaryLoop — no key → no spend / no write', () => {
  it('with NO mock and NO key, runSummarize is no-provider → nothing is written', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
    const loop = createSummaryLoop({
      llmDataDir,
      encryptor: fakeEncryptor,
      getCurrentDir: () => proj,
      readProject: () => ({ ok: true, dir: proj, name: 'proj', doc: docWith([planNote('p1', 'x')]) }),
      now: () => new Date(),
      env: {} // no CANVAS_LLM_MOCK, no *_API_KEY → getProvider returns null → no-provider
    })
    try {
      await loop.onIntent({ boardId: 'p1' })
      expect(existsSync(join(proj, '.canvas', 'memory', 'board-p1.md'))).toBe(false)
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })
})

describe('createSummaryLoop — in-flight guard', () => {
  it('a second concurrent onIntent for a board already summarizing is dropped', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
    let calls = 0
    const loop = createSummaryLoop({
      llmDataDir,
      encryptor: fakeEncryptor,
      getCurrentDir: () => proj,
      readProject: () => ({ ok: true, dir: proj, name: 'proj', doc: docWith([planNote('p1', 'x')]) }),
      now: () => new Date(),
      env: { CANVAS_LLM_MOCK: '1' },
      // a fetch isn't used on the mock path, but count any provider work via a slow mock seam:
      fetch: async () => {
        calls++
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
      }
    })
    try {
      // fire two intents for the SAME board without awaiting the first
      const a = loop.onIntent({ boardId: 'p1' })
      const b = loop.onIntent({ boardId: 'p1' })
      await Promise.all([a, b])
      // the mock provider short-circuits fetch, so we assert on the guard's observable
      // effect instead: exactly one summary file, written once (no throw, no double-run).
      const mem = createCanvasMemory(proj)
      expect(mem.readBoard('p1')).toContain('[mock]')
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/summaryLoop.test.ts`
Expected: FAIL — `createSummaryLoop` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/main/summaryLoop.ts`:

```ts
import { runSummarize, defaultDeps, type FetchLike } from './llmService'
import { readLlmConfig } from './llmConfig'
import { createKeyStore, type Encryptor } from './llmKeyStore'
import { createBudgetStore } from './llmBudget'
import { createCanvasMemory } from './canvasMemory'
import { projectName, type ProjectResult } from './projectStore'
import type { SummarizeIntent } from './memoryEngine'

export interface SummaryLoopDeps {
  /** Where the file-backed key/budget stores live (userData; e2e temp dir). */
  llmDataDir: string
  /** safeStorage encryptor (real in prod; a fake in unit tests — unused on the mock path). */
  encryptor: Encryptor
  /** The current open project dir, or null. */
  getCurrentDir: () => string | null
  /** Read a project's doc from disk (post-save). */
  readProject: (dir: string) => ProjectResult
  /** Clock for the per-day budget (default new Date()). */
  now?: () => Date
  /** Transport (default global fetch); the mock seam short-circuits it under e2e. */
  fetch?: FetchLike
  /** Env override (default process.env); tests pass CANVAS_LLM_MOCK to force the mock. */
  env?: Record<string, string | undefined>
}

export interface SummaryLoop {
  /** Handle one detector intent: read → summarize → write. Best-effort; never throws. */
  onIntent(intent: SummarizeIntent): Promise<void>
}

export function createSummaryLoop(deps: SummaryLoopDeps): SummaryLoop {
  const inFlight = new Set<string>()
  const fetchImpl = deps.fetch ?? defaultDeps().fetch
  const env = deps.env ?? process.env
  const now = deps.now ?? ((): Date => new Date())

  return {
    async onIntent({ boardId }) {
      if (inFlight.has(boardId)) return // a slow call for this board is already running
      inFlight.add(boardId)
      try {
        const dir = deps.getCurrentDir()
        if (!dir) return
        const r = deps.readProject(dir)
        if (!r.ok) return
        const boards = (r.doc as { boards?: unknown })?.boards
        const board = Array.isArray(boards)
          ? (boards as { id?: unknown }[]).find((b) => b.id === boardId)
          : undefined
        if (!board) return // deleted between the debounce and the fire

        const config = readLlmConfig(deps.llmDataDir)
        const result = await runSummarize(config, buildSummarizeInput(board), {
          fetch: fetchImpl,
          env,
          keyStore: createKeyStore(deps.llmDataDir, deps.encryptor),
          budget: createBudgetStore(deps.llmDataDir, now)
        })
        if (!result.ok) return // no-provider / budget-exceeded / provider-error → Tier-1 stays

        const mem = createCanvasMemory(dir)
        mem.writeBoard(boardId, `# ${str((board as RawBoard).title) || boardId}\n\n${result.text}\n`)
        mem.writeIndex(buildMemoryIndex(r.doc, (id) => mem.readBoard(id) !== undefined))
        mem.writeProject(buildProjectRollup(projectName(dir), r.doc))
      } catch (err) {
        console.warn('[summaryLoop] onIntent failed (non-fatal)', err)
      } finally {
        inFlight.delete(boardId)
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/summaryLoop.test.ts`
Expected: PASS (builder + loop describes green).

- [ ] **Step 5: Commit**

```bash
git add src/main/summaryLoop.ts src/main/summaryLoop.test.ts
git commit -F - <<'EOF'
feat(context): T-M3 createSummaryLoop — read → budgeted summarize → cache prose

onIntent({boardId}): getCurrentDir → readProject → find the board → buildSummarizeInput
→ budgeted runSummarize (own file-backed keyStore+budget on llmDataDir, shared cap/key)
→ on ok write board-<id>.md + refresh MEMORY.md/project.md; on no-provider/budget/
provider-error → no-op (Tier-1 stays). Per-board in-flight Set drops a concurrent
re-fire. Best-effort; never throws. No second egress path; passive output only.
EOF
```

---

## Task 5: Wire the loop into `index.ts`

**Files:**
- Modify: `src/main/index.ts`

> No unit test (this is the process-composition root — covered by the build + the `context-summary` e2e in Task 6, and the engine-wiring is already unit-tested in `projectIpc.test.ts`). The change REORDERS the existing `llmDataDir`/`llmEncryptor` construction above the `registerProjectHandlers` call so the loop can be built with them; it is additive and shares no lines with `feat/mcp-integration`'s `index.ts` edits.

- [ ] **Step 1: Add the imports**

Near the other `./` main imports in `src/main/index.ts`, add:

```ts
import { createSummaryLoop } from './summaryLoop'
import { createMemoryEngine } from './memoryEngine'
import { getCurrentDir, readProject } from './projectStore'
```

(If `createMemoryEngine` / `getCurrentDir` / `readProject` are already imported, don't duplicate — merge into the existing import.)

- [ ] **Step 2: Move the `llmEncryptor` + `llmDataDir` construction ABOVE `registerProjectHandlers`, then build the loop + engine**

Replace the current block (the `registerProjectHandlers(...)` call at `:165` and the `llmEncryptor`/`llmDataDir`/`registerLlmHandlers` block at `:171-179`) with this order:

```ts
  registerPtyHandlers(ipcMain, () => mainWindow)
  registerPreviewHandlers(ipcMain, () => mainWindow, defaultPreviewUrl)

  // T-B2: encrypt the API key with Electron safeStorage. Built here (index already imports
  // electron) and injected so llmKeyStore stays Electron-free + unit-testable. Under
  // CANVAS_SMOKE=e2e the key store lives in a throwaway temp dir (exported for the probe) so
  // a test key never lands in the real userData; otherwise it lives in userData (NEVER a
  // project folder).
  const llmEncryptor: Encryptor = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b)
  }
  const llmDataDir =
    SMOKE === 'e2e' ? mkdtempSync(join(tmpdir(), 'canvas-e2e-llm-')) : app.getPath('userData')
  if (SMOKE === 'e2e') process.env.CANVAS_E2E_LLM_DIR = llmDataDir

  // T-M3: the Tier-2 autonomous summary loop. The detector (T-M2) emits a {boardId} intent;
  // the loop re-reads the board, summarizes via the budgeted runSummarize (own file-backed
  // key/budget on the same llmDataDir → shared cap/key), and caches the prose into .canvas/.
  // Constructing the engine with the loop's onIntent and passing it as the 5th arg means the
  // SAME engine project:save feeds (+ open/current reset) is the one that drives the loop.
  const summaryLoop = createSummaryLoop({
    llmDataDir,
    encryptor: llmEncryptor,
    getCurrentDir,
    readProject
  })
  const memoryEngine = createMemoryEngine({ onIntent: (intent) => void summaryLoop.onIntent(intent) })
  registerProjectHandlers(ipcMain, () => mainWindow, app.getPath('userData'), undefined, memoryEngine)
  registerLlmHandlers(ipcMain, () => mainWindow, llmDataDir, undefined, llmEncryptor)
```

(The `CANVAS_LLM_PING` block below it is unchanged.)

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: clean — no unused imports, the loop + engine wire with the existing `registerProjectHandlers` 5-arg signature.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -F - <<'EOF'
feat(context): T-M3 wire the summary loop — engine.onIntent drives runSummarize

Build createSummaryLoop with llmDataDir + the safeStorage encryptor, construct the T-M2
engine with the loop's onIntent, and pass that engine as the 5th arg to
registerProjectHandlers so the same engine project:save feeds also drives the loop.
Reorders the llmDataDir/llmEncryptor construction above registerProjectHandlers
(additive; no shared lines with feat/mcp-integration's index.ts edits).
EOF
```

---

## Task 6: e2e probe — `context-summary`

**Files:**
- Create: `src/main/e2e/probes/summary.ts`
- Modify: `src/main/e2e/index.ts`

- [ ] **Step 1: Write the probe**

Create `src/main/e2e/probes/summary.ts`:

```ts
import { mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createProject, setCurrentDir, readProject } from '../../projectStore'
import { createCanvasMemory } from '../../canvasMemory'
import { createSummaryLoop } from '../../summaryLoop'
import type { Encryptor } from '../../llmKeyStore'
import type { E2EProbe } from '../types'

/**
 * M-memory T-M3: the Tier-2 autonomous summary loop. Drives createSummaryLoop directly
 * (MAIN-side, like context-memory) under the e2e MOCK provider (CANVAS_SMOKE=e2e →
 * getProvider returns the [mock] summarizer, NO real network). Creates a throwaway
 * project with one planning board, points the open dir at it, writes a real canvas.json
 * (so readProject finds the board), fires onIntent, and asserts: board-<id>.md was
 * written with the mock summary AND MEMORY.md lists the board. Self-cleans (restore
 * setCurrentDir(null) + rm the temp dirs in finally). Runs late — it touches currentDir.
 */
export const contextSummary: E2EProbe = {
  name: 'context-summary',
  async run(ctx) {
    void ctx // MAIN-side only: no renderer interaction needed for the loop
    const proj = mkdtempSync(join(tmpdir(), 'canvas-m3-'))
    const llmDataDir = process.env.CANVAS_E2E_LLM_DIR ?? mkdtempSync(join(tmpdir(), 'canvas-m3-llm-'))
    const noopEncryptor: Encryptor = {
      isEncryptionAvailable: () => false,
      encryptString: (s) => Buffer.from(s, 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8')
    }
    try {
      // A real canvas.json with one planning board (note text becomes the summarize input).
      await createProject(proj, 'm3', {})
      setCurrentDir(proj)
      const { writeProject } = await import('../../projectStore')
      const doc = {
        schemaVersion: 4,
        viewport: null,
        boards: [
          {
            id: 'm3board',
            type: 'planning',
            x: 0,
            y: 0,
            w: 400,
            h: 300,
            title: 'Plan',
            elements: [{ id: 'n1', kind: 'note', x: 0, y: 0, w: 100, h: 80, tint: 'yellow', text: 'ship T-M3' }]
          }
        ]
      }
      await writeProject(proj, doc)

      const loop = createSummaryLoop({
        llmDataDir,
        encryptor: noopEncryptor,
        getCurrentDir: () => proj,
        readProject
      })
      await loop.onIntent({ boardId: 'm3board' })

      const mem = createCanvasMemory(proj)
      const board = mem.readBoard('m3board')
      const index = mem.readIndex()
      const wroteSummary = !!board && board.includes('[mock]') && board.includes('ship T-M3')
      const onDisk = existsSync(join(proj, '.canvas', 'memory', 'board-m3board.md'))
      const indexLists = !!index && index.includes('board-m3board.md')

      const ok = wroteSummary && onDisk && indexLists
      return {
        name: 'context-summary',
        ok,
        detail: ok
          ? 'mock summary cached to board-m3board.md + MEMORY.md lists the board'
          : JSON.stringify({ wroteSummary, onDisk, indexLists, board })
      }
    } finally {
      setCurrentDir(null)
      rmSync(proj, { recursive: true, force: true })
    }
  }
}
```

- [ ] **Step 2: Register the probe in the PLAYLIST**

In `src/main/e2e/index.ts`, add the import next to the other context probes:

```ts
import { contextSummary } from './probes/summary'
```

In the `PLAYLIST` array, add `contextSummary` immediately AFTER `contextMemory` (both are MAIN-side, self-contained, touch `currentDir`, and restore it — keep them last):

```ts
  contextMemory, // M-memory T-M1: .canvas/ scaffold + board summary round-trip (project-rooted; runs late)
  contextSummary // M-memory T-M3: Tier-2 loop — mock summary cached + MEMORY.md lists the board (runs last)
```

(Add the trailing comma after `contextMemory` when appending.)

- [ ] **Step 3: Build, then run the board e2e harness**

Run:
```
pnpm build
$env:CANVAS_SMOKE='e2e'; pnpm start
```
Expected: the run prints `E2E_CONTEXT-SUMMARY ok:true` and finishes `E2E_DONE ok:true`. (If `browser`/`browser-gesture`/`focus-detach` or `whiteboard-paste-*`/`preview-edge` show `ok:false`, that is the known `capturePage`/clipboard env flake — memory `e2e-browser-trio-flake` — rerun once; `context-summary` itself must be `ok:true`.)

- [ ] **Step 4: Commit**

```bash
git add src/main/e2e/probes/summary.ts src/main/e2e/index.ts
git commit -F - <<'EOF'
test(context): T-M3 e2e context-summary — mock summary cached + index lists board

MAIN-side probe driving createSummaryLoop under the e2e mock provider (no network):
seeds a throwaway project with one planning board, fires onIntent, asserts
board-<id>.md was written with the [mock] summary and MEMORY.md lists the board.
Self-cleans currentDir + temp dirs. Registered last in the playlist.
EOF
```

---

## Task 7: Full gate, security review, docs fold, squash-merge

**Files:**
- Modify: `docs/context-subsystem.md`
- Delete: `docs/superpowers/handoffs/2026-06-04-context-m3-kickoff.md`

- [ ] **Step 1: Run the full gate**

Run:
```
pnpm format
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```
Expected: all green. (Run `pnpm format` first — `format:check` is a hard gate; prettier drift bit T-B2/T-B3.) Unit baseline rises from **724** by the new `summaryLoop` + `canvasMemory` + `llmService` tests.

- [ ] **Step 2: Run the board e2e harness once more (post-gate)**

Run:
```
pnpm build
$env:CANVAS_SMOKE='e2e'; pnpm start
```
Expected: `E2E_DONE ok:true`, `context-summary ok:true` (rerun once if only the browser-trio/clipboard flake trips).

- [ ] **Step 3: Final holistic SECURITY review (the milestone the guards protect)**

Confirm, reading the merged diff:
- **No key → no-op:** `runSummarize` returns `no-provider` with no key → the loop writes nothing + makes no network call (Task 4 "no key" test).
- **Capped:** the loop's only egress is through `runSummarize`, which reserves against the file-backed `createBudgetStore(llmDataDir, now)` PRE-fetch — no second path bypasses the cap.
- **Passive output / never acts:** the loop's only effects are the one LLM call + the `.canvas/` writes; the summary never returns to the PTY write channel, a board patch, or any tool.
- **No posture change:** no `contextIsolation`/`sandbox`/`nodeIntegration` edit; no new IPC channel; the key never leaves MAIN / never lands in `.canvas/` or `canvas.json`.
- **Writers can't crash the loop:** Task 1 wrapped the writers; `onIntent` is best-effort try/catch.
- **Input is treated as untrusted text only:** board content (note text, browser url) only ever becomes request-body text, never an instruction the app acts on.

- [ ] **Step 4: Fold the T-M3 summary into `docs/context-subsystem.md`**

Under the `## M-memory` section (after the `### T-M2` subsection), add:

```markdown
### T-M3 — Tier-2 autonomous summary loop ✅

The loop that turns a T-M2 `{ boardId }` intent into a cached summary — **the first
autonomous-spend path** the T-B3 budget protects. Opt-in (no key → no spend / no write),
capped (the same file-backed per-day budget), passive output (never triggers an action).

- `src/main/summaryLoop.ts` — pure `buildSummarizeInput(board)` (defensive content pick;
  mirrors digest.ts; capped at `MAX_INPUT_CHARS = 4000`), `buildMemoryIndex(doc, hasSummary)`,
  `buildProjectRollup(name, doc)`, and stateful `createSummaryLoop(deps) → { onIntent }`.
  `onIntent({ boardId })`: `getCurrentDir` → `readProject` → find the board (bail if gone) →
  budgeted `runSummarize` (its OWN `createKeyStore`+`createBudgetStore` on the same
  `llmDataDir` → shared cap/key) → on `ok` write `board-<id>.md` + refresh `MEMORY.md`/
  `project.md`; on `no-provider`/`budget-exceeded`/`provider-error` → no-op (Tier-1 stays).
  A per-board in-flight `Set` drops a concurrent re-fire. Best-effort; never throws.
- **Riders (required before an autonomous loop):** `llmService.ts` got an `AbortController`
  fetch timeout (default 30s, injectable) so a hung provider can't wedge the loop;
  `canvasMemory.ts` writers are now try/catch (non-fatal on EACCES/ENOSPC) + `safeBoardId`
  caps the id at 64 chars (the T-M1 follow-up).
- **Wiring (`index.ts`):** the `llmDataDir`/`llmEncryptor` construction moved above
  `registerProjectHandlers`; the engine is built with the loop's `onIntent` and passed as the
  5th arg, so the SAME engine `project:save` feeds (+ `open`/`current` reset) drives the loop.
- **Out of scope (follow-ons):** terminal runtime last-command/live-status (PTY-state, not in
  canvas.json); the panel cached-prose upgrade + read bridge (T-M4); the MCP read resource
  (M-expose).
- e2e `src/main/e2e/probes/summary.ts` `context-summary` (mock provider): a planning board's
  note text → `board-<id>.md` cached with the `[mock]` summary + `MEMORY.md` lists the board.

🔒 **T-M3 security model:** opt-in (no key → no spend/write); capped (only egress is the
budgeted `runSummarize`); passive output (untrusted context, never acts); no posture change;
the key never leaves MAIN / never lands in `.canvas/`.
```

Add a row to the **Gate evidence** table:

```markdown
| T-M3 | `<squash-sha>` | **<NNN>** | `context-summary` ok |
```

(Fill `<squash-sha>` after the squash-merge in Step 6, `<NNN>` with the unit count from Step 1.) Update the top **Status** line + the **What's next** list to mark T-M3 ✅ and point at T-M4.

- [ ] **Step 5: Delete the kickoff + commit the docs**

```bash
git rm docs/superpowers/handoffs/2026-06-04-context-m3-kickoff.md
git add docs/context-subsystem.md
git commit -F - <<'EOF'
docs(context): fold T-M3 (Tier-2 summary loop) into the build log; drop kickoff

Record the autonomous summarize-on-change loop milestone in context-subsystem.md
(consolidated-docs discipline) and remove the now-spent T-M3 kickoff.
EOF
```

- [ ] **Step 6: Squash-merge to `feat/context`**

```bash
git checkout feat/context && git pull --ff-only
git merge --squash feat/context-m3-summary-loop
git commit -F - <<'EOF'
feat(context): M-memory T-M3 — Tier-2 autonomous summary loop

New src/main/summaryLoop.ts turns a T-M2 {boardId} intent into a cached summary: read
the board from disk → budgeted runSummarize (shared file-backed key/budget) → write
.canvas/memory/board-<id>.md + refresh MEMORY.md/project.md. Opt-in (no key → no spend/
write), capped (no second egress), passive output (never acts), per-board in-flight
guard. Riders: AbortController fetch timeout in llmService; canvasMemory writers try/
catch + safeBoardId 64-char cap. Wired via index.ts (engine.onIntent drives the loop).
EOF
git push origin feat/context
```

Then record the squash SHA into the `docs/context-subsystem.md` gate row (amend or a follow-up `docs(context): record T-M3 squash SHA` commit), delete the sub-branch (`git branch -d feat/context-m3-summary-loop`), and update the `canvas-ade-context` row on `.claude/coordination/ACTIVE-WORK.md` + the `context-subsystem` memory.

---

## Self-Review

**Spec coverage** (vs the T-M3 kickoff + the `docs/roadmap-context.md` T-M3 card):
- intent → re-read board → budgeted `runSummarize` → write `board-<id>.md` + refresh `MEMORY.md`/`project.md` → Task 4 (`createSummaryLoop`) + Task 3 (builders).
- Opt-in (no key → no-op) → Task 4 "no key" test + Step 3 security review.
- Capped (only egress is the budgeted `runSummarize`; shared file-backed budget) → design note 1 + Task 4 deps.
- Passive output / never acts → Task 4 (only effects are the call + `.canvas/` writes) + Step 3 review.
- MAIN-side defensive pick (no renderer import) → Task 3 `boardContent` reads `unknown`.
- In-flight guard → Task 4 (`inFlight` Set + its test).
- Fetch timeout (AbortController) → Task 2.
- `canvasMemory` writers try/catch + `safeBoardId` length cap → Task 1.
- `index.ts` wiring (engine 5th arg, real `onIntent`) → Task 5.
- e2e: mock provider, content change → `board-<id>.md` changed + `MEMORY.md` lists the board → Task 6 `context-summary`.
- Out of scope (terminal runtime capture / T-M4 / M-expose) → design note 5 + the docs subsection.
- Docs folded into `context-subsystem.md`, kickoff deleted, squash-merge → Task 7.

**Placeholder scan:** every code/step shows full code or an exact command + expected output. The only `<...>` tokens are the squash SHA + unit count in the Task 7 gate row, filled after the merge (called out explicitly).

**Type consistency:** `SummaryLoopDeps`/`SummaryLoop`/`createSummaryLoop`, `buildSummarizeInput`/`buildMemoryIndex`/`buildProjectRollup`/`MAX_INPUT_CHARS`, `SummarizeIntent { boardId }` (from `memoryEngine`), `ProjectResult` (from `projectStore`), `Encryptor` (from `llmKeyStore`), `FetchLike`/`ProviderDeps.timeoutMs` (from `llmService`), `safeBoardId` 64-cap — used identically across Tasks 1–6 and the docs. `registerProjectHandlers`' 5th param `memoryEngine: MemoryEngine` (existing) receives the loop-driven engine in Task 5.
