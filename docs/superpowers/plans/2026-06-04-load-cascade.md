# Wave 0 — Load Cascade (data-loss) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the only permanent-data-loss path on `main` — the load/persistence seam where a corrupt or version-skewed `canvas.json` throws uncaught (blank app, no recovery) while the destructive `gcAssets` sweep has already `unlinkSync`'d image blobs.

**Architecture:** Wrap the existing seam in guards rather than rebuild it. The `migrate()`/`fromObject` throws already carry distinct messages ("newer than supported" vs malformed), and `readProject` already does a `.bak` fallback for parse/envelope failures — the gaps are: those deep-validation throws are *uncaught*, `.bak` is not retried for *deep* (envelope-valid) corruption, `gcAssets` is destructive, and there is no React error boundary. Fix each.

**Tech Stack:** Electron 33, React 18, Zustand, `write-file-atomic`, Vitest, `@testing-library/react`.

**Branch / worktree:** `fix/load-cascade` off `main` (this worktree: `Z:\canvas-ade-load-cascade`). `main` = integration-only.

**⚠️ Verification constraint (read before running gate commands):** this worktree junctions `node_modules` from the primary checkout, which **lacks the private `@ch923dev/canvas-ade-mcp` + `@modelcontextprotocol/sdk` deps**. Whole-project `pnpm typecheck` / `pnpm build` / the pre-commit `pnpm test:e2e:matrix` therefore CANNOT run here (Rollup/tsc can't resolve the absent dep from `mcpSmoke.ts`) — this is an env limit, not a regression. **Wave 0's touched files do NOT import MCP**, so **targeted vitest is the correct per-task verification** and runs green. Per-task commits use `git commit --no-verify`. **Before the PR merges to `main`: run the FULL gate + e2e matrix on a provisioned checkout** (CI with `NODE_AUTH_TOKEN`, or local `pnpm mcp:link` after `pnpm mcp:build`). This is non-negotiable for this plan: the error-boundary fix is the exact "black-screen regression" class the e2e matrix exists to catch.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/renderer/src/canvas/ErrorBoundary.tsx` | Reusable React error boundary (class) + fallback render | **Create** |
| `src/renderer/src/canvas/ErrorBoundary.test.tsx` | Boundary unit tests | **Create** |
| `src/renderer/src/main.tsx` | Wrap app root in top-level boundary | Modify (currently 7 lines) |
| `src/renderer/src/canvas/BoardNode.tsx` | Wrap per-board content slot in a boundary | Modify |
| `src/renderer/src/store/canvasStore.ts` | Guard both `fromObject` calls; `.bak` retry | Modify (`loadObject`, `applyOpenResult`) |
| `src/main/projectStore.ts` | `gcAssets` → quarantine-move; add `readBak(dir)` | Modify |
| `src/main/projectIpc.ts` | New `project:reopenFromBak` handler | Modify |
| `src/preload/index.ts` + `index.d.ts` | Expose `project.reopenFromBak` | Modify |

---

## Task 1: Reusable React ErrorBoundary (`no-error-boundary`)

Independent, highest blast-radius — do first. Catches any render/effect throw → recovery UI instead of a black screen.

**Files:**
- Create: `src/renderer/src/canvas/ErrorBoundary.tsx`
- Test: `src/renderer/src/canvas/ErrorBoundary.test.tsx`

- [ ] **Step 1 — Write the failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

const Boom = (): React.ReactElement => {
  throw new Error('kaboom')
}

describe('ErrorBoundary', () => {
  it('renders the fallback instead of propagating a child throw', () => {
    render(
      <ErrorBoundary fallback={<div>recovery-ui</div>}>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('recovery-ui')).toBeInTheDocument()
  })

  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary fallback={<div>recovery-ui</div>}>
        <div>ok</div>
      </ErrorBoundary>
    )
    expect(screen.getByText('ok')).toBeInTheDocument()
  })

  it('calls a function fallback with a reset callback and the error', () => {
    render(
      <ErrorBoundary fallback={(_reset, err) => <div>caught: {err.message}</div>}>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('caught: kaboom')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2 — Run, expect FAIL**

Run: `pnpm exec vitest run src/renderer/src/canvas/ErrorBoundary.test.tsx`
Expected: FAIL — "ErrorBoundary is not exported" / module not found.

- [ ] **Step 3 — Implement** (class component — React error boundaries must be class)

```tsx
import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
  fallback: ReactNode | ((reset: () => void, error: Error) => ReactNode)
  onError?: (error: Error, info: ErrorInfo) => void
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] isolated a render throw:', error, info.componentStack)
    this.props.onError?.(error, info)
  }

  private reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    if (this.state.error) {
      const { fallback } = this.props
      return typeof fallback === 'function' ? fallback(this.reset, this.state.error) : fallback
    }
    return this.props.children
  }
}
```

- [ ] **Step 4 — Run, expect PASS**

Run: `pnpm exec vitest run src/renderer/src/canvas/ErrorBoundary.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5 — Commit**

```bash
git add src/renderer/src/canvas/ErrorBoundary.tsx src/renderer/src/canvas/ErrorBoundary.test.tsx
git commit --no-verify -m "feat(renderer): reusable ErrorBoundary (no-error-boundary)"
```

---

## Task 2: Top-level boundary around the app root

**Files:**
- Modify: `src/renderer/src/main.tsx`

- [ ] **Step 1 — Implement** (main.tsx is the bootstrap; verified via build + the e2e black-screen probe, not a unit test)

```tsx
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './canvas/ErrorBoundary'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary
    fallback={(reset) => (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text)',
          background: 'var(--bg)'
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <h2>Something went wrong</h2>
          <p style={{ color: 'var(--text-dim)' }}>
            The canvas hit an unexpected error. Your last save is on disk.
          </p>
          <button
            onClick={() => {
              reset()
              location.reload()
            }}
          >
            Reload
          </button>
        </div>
      </div>
    )}
  >
    <App />
  </ErrorBoundary>
)
```

- [ ] **Step 2 — Verify**

Confirm the import path resolves and the file transpiles: `pnpm exec vitest run src/renderer/src/canvas/ErrorBoundary.test.tsx` still passes (sanity). Full build verification is deferred to CI (see verification constraint). Manual smoke when the dep is provisioned: temporarily `throw` in the `App` body → recovery card appears (not a black screen); revert the temp throw.

- [ ] **Step 3 — Commit**

```bash
git add src/renderer/src/main.tsx
git commit --no-verify -m "feat(renderer): wrap app root in a top-level ErrorBoundary"
```

---

## Task 3: Per-board boundary in `BoardNode`

One bad board renders a compact failure card; the rest of the canvas survives. Wrap the per-type CONTENT slot, not the chrome — so the user can still move/delete a failed board.

**Files:**
- Modify: `src/renderer/src/canvas/BoardNode.tsx`
- Test: extend the existing `BoardNode` test (or add `BoardNode.errorboundary.test.tsx`)

- [ ] **Step 1 — Read `BoardNode.tsx` first** to find the content slot (where the per-type board body — terminal/browser/planning — is rendered inside the shared chrome/frame). The boundary wraps ONLY that slot.

- [ ] **Step 2 — Write the failing test**

```tsx
// Render a BoardNode whose content throws; assert the per-board fallback shows
// and the surrounding frame/titlebar still renders (board remains movable/deletable).
// Use the existing BoardNode test harness/mocks. Pseudocode for the assertions:
//   render(<BoardNodeWithThrowingContent />)
//   expect(screen.getByText(/this board failed to render/i)).toBeInTheDocument()
//   expect(screen.getByTestId('board-frame')).toBeInTheDocument()   // chrome survived
```

Write it against the real `BoardNode` test setup (match the file's existing import/mocks). Drive a throw from the content component for the board type under test.

- [ ] **Step 3 — Run, expect FAIL**

Run: `pnpm exec vitest run <the BoardNode test file>`
Expected: FAIL — the throw propagates (no per-board fallback yet).

- [ ] **Step 4 — Implement**

Import `ErrorBoundary` and wrap the content slot:

```tsx
<ErrorBoundary
  fallback={
    <div className="board-error" style={{ padding: 16, color: 'var(--text-dim)' }}>
      This board failed to render
    </div>
  }
>
  {/* existing per-type content slot */}
</ErrorBoundary>
```

Keep the board frame/titlebar OUTSIDE the boundary.

- [ ] **Step 5 — Run, expect PASS**

Run: `pnpm exec vitest run <the BoardNode test file>`
Expected: PASS.

- [ ] **Step 6 — Commit**

```bash
git add src/renderer/src/canvas/BoardNode.tsx <the BoardNode test file>
git commit --no-verify -m "feat(renderer): per-board ErrorBoundary isolates a bad board"
```

---

## Task 4: Guard both `fromObject` throws → `project.status='error'`

Findings: `fromobject-throw-unguarded-open`, `corrupt-canvas-json-crashes-load`, `downgrade-newer-schema-crash`. The `status:'error'` path + WelcomeScreen error display already exist (`canvasStore.ts:644-647`, `WelcomeScreen.tsx`). The throws just need catching.

**Files:**
- Modify: `src/renderer/src/store/canvasStore.ts` — `applyOpenResult` (currently `:644-663`, `fromObject(r.doc)` at `:649`) and `loadObject` (`:626-642`, `fromObject(doc)` at `:627`)
- Test: extend `src/renderer/src/store/canvasStore.test.ts`

- [ ] **Step 1 — Write the failing test**

```ts
it('applyOpenResult routes a deep-corrupt doc to status:error, boards untouched', async () => {
  const before = useCanvasStore.getState().boards
  await useCanvasStore.getState().applyOpenResult({
    ok: true,
    dir: 'd',
    name: 'n',
    doc: { schemaVersion: 5, boards: [{ id: 1 /* invalid: non-string id, no type */ }] }
  })
  const s = useCanvasStore.getState()
  expect(s.project.status).toBe('error')
  expect(s.boards).toEqual(before) // no partial mutation
})

it('applyOpenResult flags a too-new schema distinctly', async () => {
  await useCanvasStore.getState().applyOpenResult({
    ok: true,
    dir: 'd',
    name: 'n',
    doc: { schemaVersion: 999, boards: [] }
  })
  const s = useCanvasStore.getState()
  expect(s.project.status).toBe('error')
  expect(s.project.error).toMatch(/newer than supported/)
})
```

Note: a deep-invalid board must be one `fromObject` actually rejects — read `boardSchema.ts` `fromObject` (`:520`) to pick a value it throws on (e.g. missing `type`, non-string `id`). Stub `window.api.project.reopenFromBak` to return `{ ok: false }` in this test so the catch falls through to `status:'error'` (the `.bak` retry lands in Task 5).

- [ ] **Step 2 — Run, expect FAIL**

Run: `pnpm exec vitest run src/renderer/src/store/canvasStore.test.ts`
Expected: FAIL — today `applyOpenResult` throws synchronously rather than setting `status:'error'`.

- [ ] **Step 3 — Implement** — wrap the `fromObject` call in `applyOpenResult`:

```ts
let d: ReturnType<typeof fromObject>
try {
  d = fromObject(r.doc)
} catch (err) {
  const msg = err instanceof Error ? err.message : 'failed to load project'
  set((s) => ({ project: { ...s.project, status: 'error', error: msg } }))
  return
}
```

Apply the same guard in `loadObject` (set `status:'error'` on throw; leave `boards`/`connectors`/`viewport` unchanged; do NOT null `lastRecorded` until after a successful `fromObject`).

- [ ] **Step 4 — Run, expect PASS**

Run: `pnpm exec vitest run src/renderer/src/store/canvasStore.test.ts`
Expected: PASS. Genuine-repro check: temporarily make `fromObject` always succeed-with-garbage → the deep-corrupt assertion fails, proving the test bites.

- [ ] **Step 5 — Commit**

```bash
git add src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit --no-verify -m "fix(store): guard fromObject load throws → status:error (corrupt + too-new)"
```

---

## Task 5: `.bak` retry on deep-validation failure (`deep-validation-throw-no-bak-fallback`)

`readProject` only falls back to `.bak` on parse/envelope failure (`projectStore.ts:55`). An envelope-valid-but-deep-corrupt primary never triggers it. Add an explicit `.bak`-only re-read the renderer calls when `fromObject` throws.

**Files:**
- Modify: `src/main/projectStore.ts` — add `readBak(dir)`
- Modify: `src/main/projectIpc.ts` — add `project:reopenFromBak` handler
- Modify: `src/preload/index.ts` (+ `src/preload/index.d.ts`) — expose `project.reopenFromBak`
- Modify: `src/renderer/src/store/canvasStore.ts` — retry inside the Task-4 catch
- Test: `src/main/projectStore.test.ts`, `src/main/projectIpc.integration.test.ts`, `src/renderer/src/store/canvasStore.test.ts`

- [ ] **Step 1 — Write the failing MAIN unit test** in `projectStore.test.ts`

```ts
it('readBak returns the .bak doc, ignoring a deep-corrupt primary', () => {
  const dir = mkTmp() // reuse the file's existing temp-dir helper
  writeFileSync(
    join(dir, 'canvas.json'),
    JSON.stringify({ schemaVersion: 5, boards: [{ junk: true }] })
  )
  writeFileSync(
    join(dir, 'canvas.json.bak'),
    JSON.stringify({ schemaVersion: 5, viewport: null, boards: [] })
  )
  const r = readBak(dir)
  expect(r.ok).toBe(true)
  if (r.ok) expect((r.doc as { boards: unknown[] }).boards).toEqual([])
})

it('readBak returns ok:false when no .bak exists', () => {
  expect(readBak(mkTmp()).ok).toBe(false)
})
```

- [ ] **Step 2 — Run, expect FAIL** (`readBak` not exported)

Run: `pnpm exec vitest run src/main/projectStore.test.ts`

- [ ] **Step 3 — Implement `readBak` in `projectStore.ts`**

```ts
/** Read ONLY canvas.json.bak (skip the primary) — for renderer-reported deep-validation recovery. */
export function readBak(dir: string): ProjectResult {
  const backup = tryParse(join(dir, CANVAS_BAK))
  if (backup !== undefined) return { ok: true, dir, name: projectName(dir), doc: backup }
  return { ok: false, error: `No readable canvas.json.bak in ${dir}` }
}
```

- [ ] **Step 4 — Add the IPC handler in `projectIpc.ts`** (frame-guarded like its siblings; import `readBak`, `isUnsafeProjectDir` already in scope)

```ts
ipcMain.handle('project:reopenFromBak', (e, dir: string): ProjectResult => {
  if (guard(e)) return { ok: false, error: 'forbidden' }
  if (isUnsafeProjectDir(dir)) return { ok: false, error: 'invalid path' }
  return readBak(dir) // pure read; do NOT gcAssets here
})
```

- [ ] **Step 5 — Expose in preload** (`src/preload/index.ts`, in the `project` group) and type it (`src/preload/index.d.ts`)

```ts
// preload index.ts (mirror the existing project.* invoke pattern):
reopenFromBak: (dir: string): Promise<ProjectResult> =>
  ipcRenderer.invoke('project:reopenFromBak', dir),
```

```ts
// preload index.d.ts: add to the project interface
reopenFromBak: (dir: string) => Promise<ProjectResult>
```

- [ ] **Step 6 — Wire the renderer retry** — in the Task-4 `applyOpenResult` catch, attempt `.bak` before giving up (makes `applyOpenResult` async — confirm callers `await`/`void` it; `App.tsx:35` already calls it inside a `.then`):

```ts
} catch (err) {
  const bak = await window.api.project.reopenFromBak(r.dir)
  if (bak.ok) {
    try {
      const d2 = fromObject(bak.doc)
      lastRecorded = null
      markRestoredIdle(d2.boards)
      set({
        boards: d2.boards,
        connectors: d2.connectors,
        viewport: d2.viewport,
        selectedId: null,
        past: [],
        future: [],
        project: { dir: r.dir, name: r.name, status: 'open' }
      })
      return
    } catch {
      /* .bak is also bad → fall through to error */
    }
  }
  const msg = err instanceof Error ? err.message : 'failed to load project'
  set((s) => ({ project: { ...s.project, status: 'error', error: msg } }))
  return
}
```

- [ ] **Step 7 — Integration test** (renderer store, mocking `window.api.project.reopenFromBak`)

```ts
it('recovers via .bak when the primary doc is deep-corrupt', async () => {
  vi.spyOn(window.api.project, 'reopenFromBak').mockResolvedValue({
    ok: true,
    dir: 'd',
    name: 'n',
    doc: { schemaVersion: 5, viewport: null, boards: [] }
  })
  await useCanvasStore.getState().applyOpenResult({
    ok: true, dir: 'd', name: 'n',
    doc: { schemaVersion: 5, boards: [{ junk: true }] }
  })
  expect(useCanvasStore.getState().project.status).toBe('open')
})

it('ends in status:error when both primary and .bak are bad', async () => {
  vi.spyOn(window.api.project, 'reopenFromBak').mockResolvedValue({ ok: false, error: 'x' })
  await useCanvasStore.getState().applyOpenResult({
    ok: true, dir: 'd', name: 'n',
    doc: { schemaVersion: 5, boards: [{ junk: true }] }
  })
  expect(useCanvasStore.getState().project.status).toBe('error')
})
```

Also add a MAIN integration test in `projectIpc.integration.test.ts` asserting the `project:reopenFromBak` handler returns the `.bak` doc and rejects a foreign sender (mirror an existing handler test).

- [ ] **Step 8 — Run all, expect PASS**

Run: `pnpm exec vitest run src/main/projectStore.test.ts src/main/projectIpc.integration.test.ts src/renderer/src/store/canvasStore.test.ts`
Expected: PASS.

- [ ] **Step 9 — Commit**

```bash
git add src/main/projectStore.ts src/main/projectIpc.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/store/canvasStore.ts src/main/projectStore.test.ts src/main/projectIpc.integration.test.ts src/renderer/src/store/canvasStore.test.ts
git commit --no-verify -m "fix(persist): retry canvas.json.bak on renderer deep-validation failure"
```

---

## Task 6: `gcAssets` → reversible quarantine-move, not `unlinkSync` — the highest-consequence fix

Findings: `gcassets-before-validation-data-loss`, `downgrade-newer-schema-crash-plus-asset-gc`. Removes the "permanent" property entirely — even if every downstream step throws on a mis-read doc, swept blobs are recoverable from `assets/.trash/`. Simpler than the renderer-ack defer and orthogonal to it.

**Files:**
- Modify: `src/main/projectStore.ts` — `gcAssets` (`:171-189`)
- Test: `src/main/projectStore.test.ts`

- [ ] **Step 1 — Write the failing test**

```ts
it('gcAssets moves an orphan to assets/.trash, keeps referenced, never hard-deletes', async () => {
  const dir = mkTmp()
  const keep = await writeAsset(dir, new Uint8Array([1]), 'png')
  const orphan = await writeAsset(dir, new Uint8Array([2]), 'png')
  gcAssets(dir, new Set([keep.assetId]))
  expect(existsSync(join(dir, keep.assetId))).toBe(true) // referenced kept
  expect(existsSync(join(dir, orphan.assetId))).toBe(false) // removed from live
  const orphanFile = orphan.assetId.split('/')[1]
  expect(existsSync(join(dir, 'assets', '.trash', orphanFile))).toBe(true) // recoverable
})

it('gcAssets does not re-sweep or delete its own .trash dir', () => {
  const dir = mkTmp()
  mkdirSync(join(dir, 'assets', '.trash'), { recursive: true })
  expect(() => gcAssets(dir, new Set())).not.toThrow()
  expect(existsSync(join(dir, 'assets', '.trash'))).toBe(true)
})
```

- [ ] **Step 2 — Run, expect FAIL**

Run: `pnpm exec vitest run src/main/projectStore.test.ts`

- [ ] **Step 3 — Implement** — in `gcAssets`, skip the `.trash` entry and move instead of unlink (`copyFileSync` is already imported; add `mkdirSync` to the `fs` import if not present)

```ts
const TRASH = '.trash'
for (const f of files) {
  if (f === TRASH) continue // never sweep the quarantine itself
  if (!referenced.has(`${ASSETS}/${f}`)) {
    try {
      const trashDir = join(assetsDir, TRASH)
      mkdirSync(trashDir, { recursive: true })
      copyFileSync(join(assetsDir, f), join(trashDir, f))
      unlinkSync(join(assetsDir, f)) // move = copy-then-unlink; quarantine copy retained
    } catch {
      /* a locked / already-moved file must not abort the sweep */
    }
  }
}
```

- [ ] **Step 4 — Run, expect PASS** (and re-run the existing gcAssets test in the file — update its assertion if it expected hard deletion)

Run: `pnpm exec vitest run src/main/projectStore.test.ts`

- [ ] **Step 5 — Commit**

```bash
git add src/main/projectStore.ts src/main/projectStore.test.ts
git commit --no-verify -m "fix(persist): gcAssets quarantine-moves orphans to assets/.trash (no permanent loss)"
```

---

## Task 7: Wave 0 verification + integration

- [ ] **Step 1 — Targeted full-suite vitest** (everything Wave 0 touched + their neighbours)

Run: `pnpm exec vitest run src/main/projectStore.test.ts src/main/projectIpc.integration.test.ts src/renderer/src/store/canvasStore.test.ts src/renderer/src/canvas/ErrorBoundary.test.tsx <BoardNode test>`
Expected: all PASS.

- [ ] **Step 2 — Provisioned full gate (REQUIRED before merge)** — on a checkout with the MCP dep (`pnpm mcp:build && pnpm mcp:link`, or CI with `NODE_AUTH_TOKEN`):

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm exec vitest run
pnpm test:e2e:matrix
```

- [ ] **Step 3 — Add/extend an e2e probe** that seeds a deep-corrupt `canvas.json` and asserts the recovery card / WelcomeScreen error appears (not a black screen) — this is the load-bearing proof for the error-boundary + guard work. Run under the provisioned checkout.

- [ ] **Step 4 — Finish the branch** via `superpowers:finishing-a-development-branch`: open PR `fix/load-cascade` → `main`; after merge, re-run the full gate + e2e (CLAUDE.md sequential-merge rule). Update the coordination board row to `done` and tear down via `.claude/tools/remove-worktree.ps1`.

---

## Self-review

- **Spec coverage:** `gcassets-before-validation-data-loss` → T6; `corrupt-canvas-json-crashes-load` + `fromobject-throw-unguarded-open` → T4; `deep-validation-throw-no-bak-fallback` → T5; `no-error-boundary` → T1+T2+T3; `downgrade-newer-schema-crash[-plus-asset-gc]` → T4 (too-new test) + T6 (gc reversible).
- **Type consistency:** `ErrorBoundary`, `readBak`, `reopenFromBak`, `gcAssets`, `ProjectResult` used identically across tasks. `applyOpenResult` becomes async (flagged in T5; `App.tsx:35` caller already in a `.then`).
- **Ordering rationale:** boundaries (T1–T3) first = immediate black-screen protection independent of the rest; T6 (gc quarantine) is the single most important fix and fully independent.
