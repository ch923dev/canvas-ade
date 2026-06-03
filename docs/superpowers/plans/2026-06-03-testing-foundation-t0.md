# Testing Foundation (T0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Canvas ADE test suite an explicit identity — a single decision rule for which tier a test belongs to, a self-owned structure (naming convention + Vitest split runner), and a one-time classification/retrofit of every existing test file (including the shipped T1 tests) to that convention.

**Architecture:** Add `docs/testing/TESTING.md` (the "constitution" — 3-tier taxonomy + decision rule + security-checklist map). Convert the single Vitest config into a `vitest.workspace.ts` with two projects (`unit`, `integration`) that both `extend` the shared `vitest.config.ts` (no duplicated settings). Classify every test file by tier via filename: `*.test.ts(x)` = unit, `*.integration.test.ts(x)` = integration. Split the three mixed MAIN test files and rename the six jsdom component test files so each file sits in exactly one tier.

**Tech Stack:** Vitest 2.1.9 (workspace projects), `@vitejs/plugin-react`, jsdom 29, TypeScript strict. No new dependencies. `.ts`→node, `.tsx`→jsdom (preserved via `environmentMatchGlobs`).

**Branch:** `testing-strategy` (single branch / PR #37 for the whole initiative — no new branch). Spec/roadmap: `docs/superpowers/specs/2026-06-03-testing-strategy-design.md` (§T0). Research: `docs/research/2026-06-03-testing-strategy.md`.

**Baseline before this work:** HEAD `4a1a9de`, 633 tests green across 44 files, typecheck + lint clean (one pre-existing PlanningBoard `no-console` warning). The **total test count must stay 633** through every task — this is a classification/move refactor, not a behavior change. Tests only move between files/projects; none are added or deleted.

---

## File Structure

- **Create** `docs/testing/TESTING.md` — the testing identity/decision-rule doc. One responsibility: tell a contributor which tier to write and where it lives.
- **Create** `vitest.workspace.ts` — declares the `unit` + `integration` projects.
- **Modify** `vitest.config.ts` — keep as the shared base both projects extend (plugins, alias, env rules); drop its own `include`/`exclude` (the projects own those).
- **Modify** `package.json` — add `test:unit` / `test:integration` scripts.
- **Rename (git mv)** 6 jsdom component test files `*.test.tsx` → `*.integration.test.tsx`.
- **Split** `src/main/pty.test.ts` → keep unit suites; new `src/main/pty.integration.test.ts` (handler suite).
- **Split** `src/main/preview.test.ts` → keep unit suites; new `src/main/preview.integration.test.ts` (handler suite).
- **Split** `src/main/projectIpc.test.ts` → new unit `projectIpc.test.ts` (pure fns only) + `src/main/projectIpc.integration.test.ts` (mocks + handler suites).

`persistence.integration.test.ts` already matches the convention — leave it. `windowSecurity.test.ts` is unit — leave it. The ~35 other pure-function `*.test.ts` files are already unit — leave them.

---

## Task 1: Testing identity doc (`TESTING.md`)

**Files:**
- Create: `docs/testing/TESTING.md`

This task is documentation; there is no test. It establishes the convention the later tasks implement.

- [ ] **Step 1: Create `docs/testing/TESTING.md` with this exact content:**

```markdown
# Testing — Canvas ADE

How we test. This is the source of truth for **which tier a test belongs to** and **where it lives**.
Backed by `docs/research/2026-06-03-testing-strategy.md` and the roadmap in
`docs/superpowers/specs/2026-06-03-testing-strategy-design.md`.

## Model — the Testing Trophy

We follow Kent C. Dodds' Testing Trophy: **mostly integration**, a solid unit base, a **thin** e2e
top, on a static base (TypeScript strict + ESLint). Not the unit-heavy pyramid. Ratios are
directional (~integration-heavy), never a quota.

## The three tiers (+ static)

| Tier | What it is | Runs in | Naming |
|---|---|---|---|
| **Static** | `tsc --noEmit` + ESLint | CI `check` | — |
| **Unit** | One pure function / module in isolation; collaborators mocked. No DOM render, no app, no real IPC. | Vitest `unit` project | `*.test.ts` / `*.test.tsx` |
| **Integration** | Multiple real units together: a rendered component tree (jsdom), a registered IPC handler, or logic that mocks `electron`. No real app boot. | Vitest `integration` project | `*.integration.test.ts` / `*.integration.test.tsx` |
| **E2E** | The real, booted app. The ONLY tier allowed to touch the native layer. | The e2e harness (today `CANVAS_SMOKE`; Playwright `_electron` after roadmap T4) | separate harness |

## The decision rule — which tier do I write?

Ask, in order:

1. **Can I prove it by calling a function with inputs and asserting outputs, with collaborators
   mocked?** → **unit** (`*.test.ts`). Most logic lives here: pure helpers, store reducers, layout
   math, parsers, schema (de)serialize.
2. **Does it render a component tree (jsdom), wire several real units together, register an IPC
   handler, or need `electron` mocked?** → **integration** (`*.integration.test.ts(x)`). Component
   render tests count as integration (they exercise a real tree).
3. **Does it only reproduce in the real, booted app** — native `WebContentsView`, a node-pty
   spawn→echo roundtrip, OS process-tree kill, auto-update, or genuine cross-platform/OS behavior?
   → **e2e**. Keep this tier thin (see below).

If a behavior is provable at a lower tier, write it there — duplicating it as e2e is redundant
(slower, flakier) and is not allowed.

## What each tier MAY touch

- **Unit:** pure code + mocked collaborators. No `electron`, no DOM render, no fs (use temp/mocks).
- **Integration:** real units + jsdom render + `electron`/IPC mocked (`electron-mock-ipc` or a fake
  `ipcMain` that captures handlers). **Never boots the app.**
- **E2E:** the real instance. **MAIN-process helpers only** — Playwright's renderer-side IPC helpers
  require `contextIsolation:false` + `nodeIntegration:true`, which **violates our locked sandbox**.
  Never weaken the security model to make a test pass.

## E2E keep-set (thin top)

E2E is reserved for surfaces that ONLY reproduce in the real app:
**core happy-path boot · node-pty/terminal · native `WebContentsView` (browser preview, full view) ·
auto-update · OS process-tree kill / cross-platform.** Everything else pushes down to
integration/unit. (Roadmap T3 migrates the redundant probes down; T4 moves the keep-set onto
Playwright; T5 re-enables it as a gate.)

## Security boundaries → tier map

Electron's security checklist is asserted at the **unit/integration** tier, not via broad e2e:

| Checklist item | Where asserted |
|---|---|
| #3 context isolation / #4 sandbox | unit — `src/main/windowSecurity.test.ts` (`buildMainWindowWebPreferences`) |
| #13 navigation limits / #14 new-window | unit — `windowSecurity.test.ts` (`navDecision` / `windowOpenDecision`) |
| #17 validate IPC sender / #20 no Electron APIs to untrusted content (Browser↛PTY) | integration — `pty.integration.test.ts`, `preview.integration.test.ts`, `projectIpc.integration.test.ts` |

## Running

- `pnpm test` — both projects (the CI `check` gate).
- `pnpm test:unit` — fast unit project only (use while iterating).
- `pnpm test:integration` — integration project only.
- `pnpm typecheck` · `pnpm lint` — the static tier.

## Adding a test

1. Apply the decision rule → pick the tier.
2. Name the file for its tier (`*.test.ts` vs `*.integration.test.ts`) and colocate it with the code.
3. `.ts` runs in node, `.tsx` in jsdom (handled by `environmentMatchGlobs`) — pick the extension to
   match what the test needs.
```

- [ ] **Step 2: Commit**

```bash
git add docs/testing/TESTING.md
git commit -m "docs(testing): add TESTING.md — tier taxonomy + decision rule (T0)"
```

---

## Task 2: Vitest split runner (`unit` + `integration` projects)

**Files:**
- Modify: `vitest.config.ts`
- Create: `vitest.workspace.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Replace `vitest.config.ts` with the shared base** (drop `include`/`exclude`; the projects own those):

```ts
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Shared Vitest base. Both workspace projects (unit, integration) extend this via
// vitest.workspace.ts, so plugins / alias / environment rules live in ONE place.
// `.test.tsx` files run in jsdom (DOM rendering); `.test.ts` stay in node.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [['**/*.tsx', 'jsdom']],
    globals: false
  }
})
```

- [ ] **Step 2: Create `vitest.workspace.ts`:**

```ts
import { defineWorkspace, configDefaults } from 'vitest/config'

// Two tiers, one shared base (vitest.config.ts). The tier of a test = its filename:
//   unit          → *.test.{ts,tsx}   (excluding *.integration.*)
//   integration   → *.integration.test.{ts,tsx}
// `pnpm test` runs both; `pnpm test:unit` / `pnpm test:integration` run one.
export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['src/**/*.test.{ts,tsx}'],
      exclude: [...configDefaults.exclude, 'src/**/*.integration.test.{ts,tsx}']
    }
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['src/**/*.integration.test.{ts,tsx}'],
      exclude: [...configDefaults.exclude]
    }
  }
])
```

- [ ] **Step 3: Add scripts to `package.json`.** Find the existing `"test": "vitest run"` line and add the two project scripts immediately after it:

```json
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
```

(Leave every other script untouched. `vitest run` with a workspace file present runs all projects.)

- [ ] **Step 4: Verify both projects run and the total is unchanged**

Run: `pnpm test`
Expected: PASS, **633 tests**, and the output now shows two projects (`|unit|` and `|integration|` tags on the test lines). At this point only `persistence.integration.test.ts` is in the `integration` project; everything else is in `unit`.

Run: `pnpm test:unit`
Expected: PASS, the unit subset (does NOT include `persistence.integration.test.ts`).

Run: `pnpm test:integration`
Expected: PASS, only `persistence.integration.test.ts`'s tests.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts vitest.workspace.ts package.json
git commit -m "test(infra): split Vitest into unit + integration projects (T0)"
```

---

## Task 3: Rename the 6 jsdom component test files → integration

These are pure renames (no content change). Relative imports stay valid (same directory). After this, they move from the `unit` project to the `integration` project.

**Files (rename each `*.test.tsx` → `*.integration.test.tsx`):**
- `src/renderer/src/canvas/BoardMenu.test.tsx`
- `src/renderer/src/canvas/boards/planning/ChecklistCard.test.tsx`
- `src/renderer/src/canvas/boards/planning/ElementContextMenu.test.tsx`
- `src/renderer/src/canvas/boards/planning/FreeText.test.tsx`
- `src/renderer/src/canvas/boards/planning/ImageCard.test.tsx`
- `src/renderer/src/canvas/boards/planning/NoteCard.test.tsx`

- [ ] **Step 1: Rename with git mv**

```bash
git mv src/renderer/src/canvas/BoardMenu.test.tsx src/renderer/src/canvas/BoardMenu.integration.test.tsx
git mv src/renderer/src/canvas/boards/planning/ChecklistCard.test.tsx src/renderer/src/canvas/boards/planning/ChecklistCard.integration.test.tsx
git mv src/renderer/src/canvas/boards/planning/ElementContextMenu.test.tsx src/renderer/src/canvas/boards/planning/ElementContextMenu.integration.test.tsx
git mv src/renderer/src/canvas/boards/planning/FreeText.test.tsx src/renderer/src/canvas/boards/planning/FreeText.integration.test.tsx
git mv src/renderer/src/canvas/boards/planning/ImageCard.test.tsx src/renderer/src/canvas/boards/planning/ImageCard.integration.test.tsx
git mv src/renderer/src/canvas/boards/planning/NoteCard.test.tsx src/renderer/src/canvas/boards/planning/NoteCard.integration.test.tsx
```

- [ ] **Step 2: Verify counts unchanged and tier moved**

Run: `pnpm test`
Expected: PASS, **633 tests** (unchanged total).

Run: `pnpm test:integration`
Expected: PASS, now includes the 6 renamed component suites + `persistence.integration.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(infra): classify jsdom component tests as integration (T0)"
```

---

## Task 4: Split `pty.test.ts` (unit) / `pty.integration.test.ts`

Move the IPC-handler rejection suite out of the unit file into a new integration file. The pure-function suites (safeCwd, appendRing, isStaleExit, canonicalizeShellPath, resolveShell, isForeignSender, parkCore, adoptCore, reapParkedCore, cleanupCore, disposeAllPtysCore) stay in `pty.test.ts`.

**Files:**
- Create: `src/main/pty.integration.test.ts`
- Modify: `src/main/pty.test.ts`

- [ ] **Step 1: Create `src/main/pty.integration.test.ts`** with this header, then move the entire `describe('registerPtyHandlers — foreign-sender rejection (#17/#20 Browser↛PTY)', ...)` block (verbatim) from `pty.test.ts` into it:

```ts
import { describe, it, expect } from 'vitest'
import { registerPtyHandlers } from './pty'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

// (paste the registerPtyHandlers foreign-sender rejection describe block here, unchanged)
```

The moved block (for reference — it is the suite currently at the end of `pty.test.ts`):

```ts
// Checklist #17 + #20 (Browser↛PTY): the PTY control channel is shared by ALL
// webContents, including per-board preview WebContentsViews that load untrusted
// localhost pages. A foreign sender (anything that isn't the main window's main
// frame) must be REJECTED — a previewed page must never be able to spawn or kill
// a shell. This proves the guard is wired into the handlers, not just that the
// pure isForeignSender works.
describe('registerPtyHandlers — foreign-sender rejection (#17/#20 Browser↛PTY)', () => {
  const mainFrame = { id: 'main-frame' }
  const foreign = { senderFrame: { id: 'preview-board-frame' } } as unknown as IpcMainInvokeEvent

  function setup(): Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown> {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    const ipcMain = {
      handle: (c: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
        handlers.set(c, fn)
    } as unknown as IpcMain
    const getWin = (): BrowserWindow => ({ webContents: { mainFrame } }) as unknown as BrowserWindow
    registerPtyHandlers(ipcMain, getWin)
    return handlers
  }

  it('pty:spawn throws for a foreign sender (no shell is spawned)', () => {
    const handlers = setup()
    expect(() => handlers.get('pty:spawn')!(foreign, { id: 'b1' })).toThrow(/forbidden sender/)
  })

  it('pty:kill returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('pty:kill')!(foreign, 'b1')).toBe(false)
  })

  it('pty:shells returns [] for a foreign sender (no shell enumeration leaked)', () => {
    const handlers = setup()
    expect(handlers.get('pty:shells')!(foreign)).toEqual([])
  })

  it('terminal:detectPorts returns [] for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('terminal:detectPorts')!(foreign, 'b1')).toEqual([])
  })

  it('pty:disposeAll returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('pty:disposeAll')!(foreign)).toBe(false)
  })

  it('pty:park returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('pty:park')!(foreign, 'b1')).toBe(false)
  })

  it('pty:adopt returns { adopted: false } for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('pty:adopt')!(foreign, 'b1')).toEqual({ adopted: false })
  })
})
```

> NOTE: the moved block references `BrowserWindow` in `setup()`. Add `BrowserWindow` to the new file's electron type import: `import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'`. (If the live block in `pty.test.ts` differs slightly from the above — e.g. the cast was already `BrowserWindow` — move whatever is actually there; do not rewrite assertions.)

- [ ] **Step 2: Edit `src/main/pty.test.ts`** — delete the moved `describe('registerPtyHandlers — foreign-sender rejection ...')` block, and remove the now-unused imports it required:
  - Remove `registerPtyHandlers` from the `from './pty'` import list.
  - Remove the line `import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'` (the remaining unit suites do not use these — verify with a search; the `isForeignSender` unit tests use `as never` casts, not these types).

- [ ] **Step 3: Verify**

Run: `pnpm exec vitest run src/main/pty.test.ts src/main/pty.integration.test.ts`
Expected: PASS; the combined test count equals what `pty.test.ts` had before the split (no tests lost).

Run: `pnpm test`
Expected: PASS, **633 tests** total.

Run: `pnpm typecheck` → clean. Run: `pnpm lint` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/pty.test.ts src/main/pty.integration.test.ts
git commit -m "test(main): split pty handler rejection suite into pty.integration.test.ts (T0)"
```

---

## Task 5: Split `preview.test.ts` (unit) / `preview.integration.test.ts`

Move the `registerPreviewHandlers` rejection suite out. The pure-function suites (isErrorResponseCode, isHttpErrorCode, isAllowedPreviewUrl, isAllowedExternal, registerPreviewNavGuards, registerLoadLatch, isForeignSender) stay in `preview.test.ts`.

**Files:**
- Create: `src/main/preview.integration.test.ts`
- Modify: `src/main/preview.test.ts`

- [ ] **Step 1: Create `src/main/preview.integration.test.ts`** and move the entire `describe('registerPreviewHandlers — foreign-sender rejection (#17)', ...)` block (verbatim, including the `it.each` groups added in coverage) from `preview.test.ts`. Header:

```ts
import { describe, it, expect } from 'vitest'
import { registerPreviewHandlers } from './preview'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'

// (paste the registerPreviewHandlers foreign-sender rejection describe block here, unchanged)
```

> Move the block exactly as it exists in `preview.test.ts` (it includes `preview:open` throw, `preview:navigate`/`preview:goBack`/`preview:goForward`/`preview:reload` → false, the `true`-returning `it.each` for setBoundsBatch/detach/detachAll/attach/close/closeAll, and `preview:capture` → null). Do not rewrite assertions.

- [ ] **Step 2: Edit `src/main/preview.test.ts`** — delete the moved block and fix imports:
  - Remove `registerPreviewHandlers` from the `from './preview'` import list.
  - In `import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'`, remove `IpcMain` (only the moved suite used it). KEEP `BrowserWindow` and `IpcMainInvokeEvent` — the remaining `isForeignSender` unit suite uses both (`winWithMain(): BrowserWindow` and `IpcMainInvokeEvent['senderFrame']`).

- [ ] **Step 3: Verify**

Run: `pnpm exec vitest run src/main/preview.test.ts src/main/preview.integration.test.ts`
Expected: PASS; combined count equals pre-split `preview.test.ts`.

Run: `pnpm test` → PASS, **633** total. `pnpm typecheck` → clean. `pnpm lint` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/preview.test.ts src/main/preview.integration.test.ts
git commit -m "test(main): split preview handler rejection suite into preview.integration.test.ts (T0)"
```

---

## Task 6: Split `projectIpc.test.ts` — pure unit vs mocked integration

`projectIpc.test.ts` mixes two pure-function suites (unit) with mock-backed handler suites (integration). The integration suites carry all the mock infrastructure, so they keep the bulk of the file (renamed/recreated as the integration file); the two pure suites move to a clean unit file with no mocks.

**Files:**
- Create: `src/main/projectIpc.integration.test.ts` (mocks + all `registerProjectHandlers`/`export:save`/foreign-sender suites)
- Modify (reduce to pure-only): `src/main/projectIpc.test.ts`

- [ ] **Step 1: Create `src/main/projectIpc.integration.test.ts`** containing everything the current `projectIpc.test.ts` has EXCEPT the two pure describes (`describe('isForeignSender (BUG-M6)', ...)` and `describe('isUnsafeProjectDir (M-6)', ...)`). Concretely, it keeps: the `vi.hoisted` mocks block, the three `vi.mock(...)` calls, the `makeIpcMain` helper, the `beforeEach`, and the describes `registerProjectHandlers (T4)`, `export:save`, and `registerProjectHandlers — foreign-sender rejection (#17)`. Its import line:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
```

and the value import becomes (drop the two pure fns, keep `registerProjectHandlers`):

```ts
import { registerProjectHandlers } from './projectIpc'
```

(Everything else — mocks, helper, the three handler describes — is moved verbatim.)

- [ ] **Step 2: Replace `src/main/projectIpc.test.ts`** with a pure-only unit file: keep ONLY the two pure describes, import only the pure fns, no mocks. Full new content:

```ts
import { describe, it, expect } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { isForeignSender, isUnsafeProjectDir } from './projectIpc'

describe('isForeignSender (BUG-M6)', () => {
  const sameFrame = { id: 'main' }

  it('allows a synthetic/internal call (no senderFrame)', () => {
    const e = { senderFrame: undefined } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => sameFrame as never)).toBe(false)
  })

  it('blocks a foreign frame', () => {
    const e = { senderFrame: { id: 'other' } } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => sameFrame as never)).toBe(true)
  })

  it('allows the same main frame', () => {
    const e = { senderFrame: sameFrame } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => sameFrame as never)).toBe(false)
  })

  it('blocks a real sender when the window is unresolved (getMainFrame → null)', () => {
    const e = { senderFrame: { id: 'real' } } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => null)).toBe(true)
  })
})

describe('isUnsafeProjectDir (M-6)', () => {
  it('accepts a normal absolute path (Windows + POSIX)', () => {
    expect(isUnsafeProjectDir('C:\\Users\\x\\proj')).toBe(false)
    expect(isUnsafeProjectDir('/home/x/proj')).toBe(false)
  })

  it('rejects a relative path', () => {
    expect(isUnsafeProjectDir('proj')).toBe(true)
    expect(isUnsafeProjectDir('./proj')).toBe(true)
  })

  it('rejects an absolute path that still contains traversal', () => {
    expect(isUnsafeProjectDir('C:\\Users\\x\\..\\..\\evil')).toBe(true)
    expect(isUnsafeProjectDir('/home/x/../../etc')).toBe(true)
  })

  it('rejects empty / non-string input', () => {
    expect(isUnsafeProjectDir('')).toBe(true)
    expect(isUnsafeProjectDir(undefined as unknown as string)).toBe(true)
    expect(isUnsafeProjectDir(null as unknown as string)).toBe(true)
    expect(isUnsafeProjectDir(42 as unknown as string)).toBe(true)
  })
})
```

> This pure-only content is reproduced verbatim from the existing `isForeignSender (BUG-M6)` and `isUnsafeProjectDir (M-6)` describes in `projectIpc.test.ts` — do not change the assertions. If the live file differs, prefer the live assertions.

- [ ] **Step 3: Verify no test was lost or duplicated**

Run: `pnpm exec vitest run src/main/projectIpc.test.ts src/main/projectIpc.integration.test.ts`
Expected: PASS; combined count equals the pre-split `projectIpc.test.ts` count (the 4 isForeignSender + 4 isUnsafeProjectDir unit tests now live in `projectIpc.test.ts`; the handler/export/rejection suites in the integration file). No test appears in both files.

Run: `pnpm test` → PASS, **633** total. `pnpm typecheck` → clean. `pnpm lint` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/projectIpc.test.ts src/main/projectIpc.integration.test.ts
git commit -m "test(main): split projectIpc into pure-unit + mocked-integration files (T0)"
```

---

## Task 7: Final verification + push

- [ ] **Step 1: Confirm the whole suite + both projects + classification**

Run: `pnpm test`
Expected: PASS, **633 tests** (unchanged from baseline), output shows `unit` + `integration` project tags.

Run: `pnpm test:unit`
Expected: PASS — contains only `*.test.{ts,tsx}` (no `*.integration.*`).

Run: `pnpm test:integration`
Expected: PASS — contains exactly: the 6 renamed component suites, `persistence.integration.test.ts`, `pty.integration.test.ts`, `preview.integration.test.ts`, `projectIpc.integration.test.ts`.

Run: `pnpm typecheck` → clean. Run: `pnpm lint` → 0 errors (1 pre-existing PlanningBoard `no-console` warning).

- [ ] **Step 2: Confirm no stray mixed-tier files remain**

Run: `git ls-files 'src/**/*.test.ts' 'src/**/*.test.tsx'` and sanity-check that no MAIN file still both registers IPC handlers AND lives in a `*.test.ts` (unit) file, and that the 6 component files are gone from the unit set. (The three `*.integration.test.ts` and the 6 `*.integration.test.tsx` should appear; `pty.test.ts`/`preview.test.ts`/`projectIpc.test.ts` should now be pure-unit.)

- [ ] **Step 3: Push**

```bash
git push
```

(Updates PR #37 — the whole initiative on the one branch.)

---

## Self-Review

**Spec coverage (§T0 of the design):**
- TESTING.md identity doc (taxonomy + decision rule + tier-touch rules + security map + e2e keep-set) → Task 1. ✅
- Naming convention (`*.test` unit / `*.integration.test` integration) → encoded in Task 2 globs + Tasks 3–6 file names. ✅
- Vitest projects split (unit/integration) extending a shared base, scripts → Task 2. ✅
- `.ts`→node / `.tsx`→jsdom preserved → Task 2 keeps `environmentMatchGlobs` in the shared base. ✅
- Classification + retrofit map: split mixed main files (incl. T1 retrofit) → Tasks 4/5/6; 6 jsdom component files → integration → Task 3; `persistence.integration.test.ts` left, `windowSecurity.test.ts` left unit, ~35 pure files left unit → covered by "leave them" + Task 7 audit. ✅
- Single branch / PR #37, no new branch → all tasks push to `testing-strategy`. ✅
- Total count preserved (633), no behavior change → asserted in every task's verify step + Task 7. ✅

**Placeholder scan:** the only "paste the block here" instructions (Tasks 4/5) are explicit MOVES of existing, fully-shown code (the pty block is reproduced in full; the preview block is enumerated and lives in the source) — not unspecified work. Task 6's new files are fully specified (the unit file verbatim; the integration file = "current file minus the two named pure describes"). No TBD/TODO.

**Consistency:** project names `unit`/`integration` match between `vitest.workspace.ts`, the `--project` script flags, and `TESTING.md`. The naming convention (`*.integration.test.{ts,tsx}`) is identical across the workspace globs, the renames, and the new files. `environmentMatchGlobs [['**/*.tsx','jsdom']]` lives only in the shared base (no duplication). Test-count invariant (633) is stated identically in every verify step.

**Risk note:** the load-bearing uncertainty is Vitest 2.1.9's `extends` merge for workspace projects (does the project `exclude` replace or merge with the base?). Task 2 Step 4 verifies empirically — if the `unit` project accidentally double-runs `*.integration.*` (count > 633 or a file tagged in both projects), fix by making the `unit` exclude authoritative (already spelled out with `...configDefaults.exclude`) before committing.
