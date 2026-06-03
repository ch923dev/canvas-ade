# M-memory T-M1 — `.canvas/` engine (paths + atomic writers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the persistent `<project>/.canvas/` storage engine — paths, atomic markdown writers/readers, a default-private `.gitignore` with an opt-in-to-commit toggle, and project create/open wiring — as the foundation the Tier-2 summarize loop (T-M2/T-M3) and panel-prose upgrade (T-M4) build on.

**Architecture:** One new Electron-free module `src/main/canvasMemory.ts` exposing a `createCanvasMemory(projectDir)` factory (mirrors `createKeyStore(userDataDir, …)` / `createBudgetStore(userDataDir, …)`, but rooted at the **PROJECT folder**, not `userData` — this is project data). It owns `.canvas/memory/{MEMORY.md, project.md, board-<id>.md}` + a reserved `.canvas/audit/` dir, all via `write-file-atomic` + `mkdirSync` guards. Project create/open wiring calls `ensureScaffold()`. **No LLM, no change-detector, no loop, no renderer read-bridge in this task** (those are T-M2 / T-M3 / T-M4).

**Tech Stack:** TypeScript (strict), `write-file-atomic`, Node `fs`/`path`, Vitest (unit), the in-process `CANVAS_SMOKE=e2e` board harness (probe).

---

## Design notes — SETTLED (carried from the T-M1 kickoff, do not re-litigate)

1. **Module boundary / testability.** `canvasMemory.ts` is **Electron-free**, takes an explicit `projectDir` arg (like `llmConfig`/`llmKeyStore`/`llmBudget` take `userDataDir`). Factory surface:
   `createCanvasMemory(projectDir) → { paths, ensureScaffold(), writeBoard(id,md), writeIndex(md), writeProject(md), readBoard(id), readIndex(), readProject(), setCommitOptIn(commit), isCommitted() }`.
2. **Formats.** Writers are **dumb** — they persist whatever markdown string the caller composes (T-M3 composes real content). T-M1 only proves the **paths + round-trip**. `ensureScaffold()` creates the dir tree + the `.gitignore`; it does **not** seed stub content. Readers return `undefined` on a missing/unreadable file (**never throw**).
3. **`.gitignore` + commit-toggle.** A `.gitignore` lives **inside** `.canvas/`. Default **private** = `*\n` (ignores all `.canvas/` contents from git → `.canvas/` is invisible to `git status`). **Opt-in commit** = `audit/\n` (commits the `.gitignore` + `memory/` prose, ignores only the volatile `audit/` log). State **is** the file contents — no separate state file (YAGNI). `ensureScaffold()` writes the default **only if the `.gitignore` is absent** (never clobbers a user's choice). The UI toggle is a later task; T-M1 ships the `setCommitOptIn`/`isCommitted` API.
4. **Project-open/create wiring.** `createProject()` (in `projectStore.ts`) calls `ensureScaffold()` on create (Electron-free → unit-testable directly). For OPENING an existing project missing `.canvas/`, the `projectIpc.ts` `project:open` + `project:current` handlers call `ensureScaffold()` after a successful read (open-if-absent). **No change to the `canvas.json` save/load contract;** `.canvas/` content never routes into `canvas.json` or a board patch key.
5. **e2e project dir.** Mirror the W4/W5 whiteboard probes: `mkdtempSync(join(tmpdir(),'canvas-m1-'))` → `createProject(tmp,'m1',{})` → `setCurrentDir(tmp)`; assert `.canvas/` round-trips **under `tmp`**, never `userData`.
6. **Read-bridge scope.** **Deferred to T-M4** (which needs it). T-M1 = MAIN engine + wiring + e2e only. No `memory:read*` IPC now.

**🔒 Security (locked):** `.canvas/` is **project data** (atomic, default `.gitignore`d, opt-in commit). The **API key is NEVER here** (key stays in `userData/llm-keys.json`, safeStorage). Generated memory is **untrusted passive context** — written + read/displayed, **never triggers an action**. `contextIsolation`/`sandbox`/`no-nodeIntegration` untouched. Board ids are sanitized into the `board-<id>.md` filename (path-traversal defense, mirrors the `assets/` `ASSET_RE` discipline).

**Board-id charset assumption:** board ids are nanoid-style (`A-Za-z0-9_-`). `safeBoardId` validates exactly that; an id with any other char is rejected (writer returns `false`, reader returns `undefined`) — a board summary is never written outside `.canvas/memory/`.

---

## File Structure

- **Create** `src/main/canvasMemory.ts` — the engine (paths, atomic writers, readers, `.gitignore`/commit toggle, `ensureScaffold`). Electron-free.
- **Create** `src/main/canvasMemory.test.ts` — unit tests (Vitest, temp-dir per test).
- **Modify** `src/main/projectStore.ts` — `createProject()` scaffolds `.canvas/` on create.
- **Modify** `src/main/projectIpc.ts` — `project:open` + `project:current` scaffold `.canvas/` after a successful open (open-if-absent).
- **Create** `src/main/e2e/probes/memory.ts` — the `context-memory` probe.
- **Modify** `src/main/e2e/index.ts` — append `memory` to the `PLAYLIST`.

---

## Task 1: `canvasMemory` paths + `ensureScaffold` (dirs + default `.gitignore`)

**Files:**
- Create: `src/main/canvasMemory.ts`
- Test: `src/main/canvasMemory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/canvasMemory.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvasMemory } from './canvasMemory'

describe('canvasMemory', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canvasmem-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('paths', () => {
    it('resolves the .canvas tree under the project dir', () => {
      const m = createCanvasMemory(dir)
      expect(m.paths.root).toBe(join(dir, '.canvas'))
      expect(m.paths.memoryDir).toBe(join(dir, '.canvas', 'memory'))
      expect(m.paths.auditDir).toBe(join(dir, '.canvas', 'audit'))
      expect(m.paths.gitignore).toBe(join(dir, '.canvas', '.gitignore'))
      expect(m.paths.index).toBe(join(dir, '.canvas', 'memory', 'MEMORY.md'))
      expect(m.paths.project).toBe(join(dir, '.canvas', 'memory', 'project.md'))
      expect(m.paths.board('abc')).toBe(join(dir, '.canvas', 'memory', 'board-abc.md'))
    })
  })

  describe('ensureScaffold', () => {
    it('creates memory/ + audit/ dirs and a default-private .gitignore', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      expect(statSync(m.paths.memoryDir).isDirectory()).toBe(true)
      expect(statSync(m.paths.auditDir).isDirectory()).toBe(true)
      expect(existsSync(m.paths.gitignore)).toBe(true)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe('*\n')
    })

    it('is idempotent and does NOT clobber an existing .gitignore', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      // simulate a user opt-in by rewriting the ignore, then re-scaffold
      m.setCommitOptIn(true)
      const committed = readFileSync(m.paths.gitignore, 'utf8')
      m.ensureScaffold() // must not reset to '*\n'
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe(committed)
    })

    it('does NOT seed stub MEMORY.md / project.md content', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      expect(existsSync(m.paths.index)).toBe(false)
      expect(existsSync(m.paths.project)).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/canvasMemory.test.ts`
Expected: FAIL — `createCanvasMemory` not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/canvasMemory.ts`:

```ts
/**
 * T-M1: the persistent `<project>/.canvas/` memory engine. Resolves the memory paths and
 * provides atomic markdown writers/readers + a default-private `.gitignore` with an
 * opt-in-to-commit toggle. PROJECT data (rooted at the project folder, NOT userData) —
 * the opposite of llmConfig/llmKeyStore/llmBudget. Electron-free (explicit `projectDir`)
 * so it unit-tests without Electron. The Tier-2 loop (T-M3) writes through these; the
 * panel (T-M4) reads through them. Generated memory is UNTRUSTED PASSIVE context — it is
 * written + read/displayed and NEVER triggers an action. The API key is NEVER here.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

const CANVAS_DIR = '.canvas'
const MEMORY_DIR = 'memory'
const AUDIT_DIR = 'audit'
const GITIGNORE = '.gitignore'

/** Default-private: ignore the whole `.canvas/` from git. */
const IGNORE_PRIVATE = '*\n'
/** Opt-in commit: keep the prose, ignore only the volatile audit log. */
const IGNORE_COMMITTED = 'audit/\n'

/** Board ids are nanoid-style; reject anything else to keep writes inside memory/. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/
export function safeBoardId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && SAFE_ID.test(id)
}

export interface CanvasMemoryPaths {
  root: string
  memoryDir: string
  auditDir: string
  gitignore: string
  index: string
  project: string
  board(id: string): string
}

export interface CanvasMemory {
  paths: CanvasMemoryPaths
  ensureScaffold(): void
  writeBoard(id: string, md: string): boolean
  writeIndex(md: string): void
  writeProject(md: string): void
  readBoard(id: string): string | undefined
  readIndex(): string | undefined
  readProject(): string | undefined
  setCommitOptIn(commit: boolean): void
  isCommitted(): boolean
}

function readMd(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

export function createCanvasMemory(projectDir: string): CanvasMemory {
  const root = join(projectDir, CANVAS_DIR)
  const memoryDir = join(root, MEMORY_DIR)
  const auditDir = join(root, AUDIT_DIR)
  const gitignore = join(root, GITIGNORE)
  const paths: CanvasMemoryPaths = {
    root,
    memoryDir,
    auditDir,
    gitignore,
    index: join(memoryDir, 'MEMORY.md'),
    project: join(memoryDir, 'project.md'),
    board: (id) => join(memoryDir, `board-${id}.md`)
  }

  return {
    paths,
    ensureScaffold() {
      mkdirSync(memoryDir, { recursive: true })
      mkdirSync(auditDir, { recursive: true })
      // Write the default-private ignore only if absent — never clobber a user opt-in.
      if (!existsSync(gitignore)) {
        writeFileAtomic.sync(gitignore, IGNORE_PRIVATE, 'utf8')
      }
    },
    writeBoard(id, md) {
      if (!safeBoardId(id)) return false
      mkdirSync(memoryDir, { recursive: true })
      writeFileAtomic.sync(paths.board(id), md, 'utf8')
      return true
    },
    writeIndex(md) {
      mkdirSync(memoryDir, { recursive: true })
      writeFileAtomic.sync(paths.index, md, 'utf8')
    },
    writeProject(md) {
      mkdirSync(memoryDir, { recursive: true })
      writeFileAtomic.sync(paths.project, md, 'utf8')
    },
    readBoard(id) {
      if (!safeBoardId(id)) return undefined
      return readMd(paths.board(id))
    },
    readIndex() {
      return readMd(paths.index)
    },
    readProject() {
      return readMd(paths.project)
    },
    setCommitOptIn(commit) {
      mkdirSync(root, { recursive: true })
      writeFileAtomic.sync(gitignore, commit ? IGNORE_COMMITTED : IGNORE_PRIVATE, 'utf8')
    },
    isCommitted() {
      const raw = readMd(gitignore)
      if (raw === undefined) return false
      return raw.trim() !== '*'
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/canvasMemory.test.ts`
Expected: PASS (paths + ensureScaffold groups green).

- [ ] **Step 5: Commit**

```bash
git add src/main/canvasMemory.ts src/main/canvasMemory.test.ts
git commit -F - <<'EOF'
feat(context): M-memory T-M1 — .canvas/ paths + ensureScaffold

createCanvasMemory(projectDir) factory: resolves the .canvas/memory tree
+ reserved audit/ dir, scaffolds dirs + a default-private .gitignore (*),
idempotent + non-clobbering. Electron-free (explicit projectDir).
EOF
```

---

## Task 2: board-summary write/read round-trip + id safety

**Files:**
- Modify: `src/main/canvasMemory.test.ts`

(Implementation already present from Task 1 — this task locks the behavior with tests; if a test fails, fix `canvasMemory.ts`.)

- [ ] **Step 1: Write the failing test**

Append inside the `describe('canvasMemory', …)` block in `src/main/canvasMemory.test.ts`:

```ts
  describe('board summaries', () => {
    it('round-trips a board markdown file under memory/', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      const ok = m.writeBoard('term1', '# Terminal\n\nRuns pnpm dev\n')
      expect(ok).toBe(true)
      expect(existsSync(m.paths.board('term1'))).toBe(true)
      expect(m.readBoard('term1')).toBe('# Terminal\n\nRuns pnpm dev\n')
    })

    it('returns undefined for a missing board file (never throws)', () => {
      const m = createCanvasMemory(dir)
      expect(m.readBoard('nope')).toBeUndefined()
    })

    it('creates memory/ on writeBoard even without ensureScaffold', () => {
      const m = createCanvasMemory(dir)
      expect(m.writeBoard('b1', 'hi')).toBe(true)
      expect(m.readBoard('b1')).toBe('hi')
    })

    it('rejects an unsafe board id (path-traversal defense)', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      expect(m.writeBoard('../evil', 'x')).toBe(false)
      expect(m.writeBoard('a/b', 'x')).toBe(false)
      expect(m.writeBoard('', 'x')).toBe(false)
      expect(m.readBoard('../evil')).toBeUndefined()
      // nothing escaped the memory dir
      expect(existsSync(join(dir, 'evil'))).toBe(false)
      expect(existsSync(join(dir, '.canvas', 'evil'))).toBe(false)
    })
  })
```

- [ ] **Step 2: Run test to verify it passes (impl already exists)**

Run: `pnpm vitest run src/main/canvasMemory.test.ts`
Expected: PASS — `writeBoard`/`readBoard`/`safeBoardId` from Task 1 satisfy these. If any fail, fix `canvasMemory.ts` until green.

- [ ] **Step 3: Commit**

```bash
git add src/main/canvasMemory.test.ts
git commit -m "test(context): lock T-M1 board summary round-trip + id-safety"
```

---

## Task 3: index + project writers/readers round-trip

**Files:**
- Modify: `src/main/canvasMemory.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe('canvasMemory', …)` block:

```ts
  describe('index + project', () => {
    it('round-trips MEMORY.md', () => {
      const m = createCanvasMemory(dir)
      m.writeIndex('# Context memory\n\n- [Terminal](board-term1.md)\n')
      expect(m.readIndex()).toBe('# Context memory\n\n- [Terminal](board-term1.md)\n')
    })

    it('round-trips project.md', () => {
      const m = createCanvasMemory(dir)
      m.writeProject('# Project\n\nA canvas.\n')
      expect(m.readProject()).toBe('# Project\n\nA canvas.\n')
    })

    it('returns undefined for missing index/project (never throws)', () => {
      const m = createCanvasMemory(dir)
      expect(m.readIndex()).toBeUndefined()
      expect(m.readProject()).toBeUndefined()
    })

    it('writes only under the project dir, never elsewhere', () => {
      const m = createCanvasMemory(dir)
      m.writeIndex('x')
      m.writeProject('y')
      m.writeBoard('b', 'z')
      // every file is inside <dir>/.canvas/memory
      expect(m.paths.index.startsWith(join(dir, '.canvas'))).toBe(true)
      expect(m.paths.project.startsWith(join(dir, '.canvas'))).toBe(true)
      expect(m.paths.board('b').startsWith(join(dir, '.canvas'))).toBe(true)
    })
  })
```

- [ ] **Step 2: Run test to verify it passes (impl already exists)**

Run: `pnpm vitest run src/main/canvasMemory.test.ts`
Expected: PASS. If any fail, fix `canvasMemory.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/main/canvasMemory.test.ts
git commit -m "test(context): lock T-M1 MEMORY.md / project.md round-trip"
```

---

## Task 4: `.gitignore` commit-toggle (`setCommitOptIn` / `isCommitted`)

**Files:**
- Modify: `src/main/canvasMemory.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe('canvasMemory', …)` block:

```ts
  describe('commit toggle', () => {
    it('defaults to private (uncommitted) after scaffold', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      expect(m.isCommitted()).toBe(false)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe('*\n')
    })

    it('opt-in commit rewrites the ignore to ignore only audit/', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      m.setCommitOptIn(true)
      expect(m.isCommitted()).toBe(true)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe('audit/\n')
    })

    it('opt-out restores private', () => {
      const m = createCanvasMemory(dir)
      m.setCommitOptIn(true)
      m.setCommitOptIn(false)
      expect(m.isCommitted()).toBe(false)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe('*\n')
    })

    it('isCommitted is false when no .gitignore exists', () => {
      const m = createCanvasMemory(dir)
      expect(m.isCommitted()).toBe(false)
    })
  })
```

- [ ] **Step 2: Run test to verify it passes (impl already exists)**

Run: `pnpm vitest run src/main/canvasMemory.test.ts`
Expected: PASS. If any fail, fix `canvasMemory.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/main/canvasMemory.test.ts
git commit -m "test(context): lock T-M1 .gitignore commit toggle"
```

---

## Task 5: wire `ensureScaffold()` into project create + open

**Files:**
- Modify: `src/main/projectStore.ts` (`createProject` scaffolds on create)
- Modify: `src/main/projectStore.test.ts` (assert create scaffolds)
- Modify: `src/main/projectIpc.ts` (`project:open` + `project:current` scaffold open-if-absent)

- [ ] **Step 1: Write the failing test**

Add to `src/main/projectStore.test.ts` (match the file's existing import + temp-dir style; the assertions):

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// ...within the existing describe for createProject (or a new one):

it('createProject scaffolds the .canvas memory tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'projmem-'))
  try {
    await createProject(dir, 'p', {})
    expect(existsSync(join(dir, '.canvas', 'memory'))).toBe(true)
    expect(existsSync(join(dir, '.canvas', 'audit'))).toBe(true)
    expect(readFileSync(join(dir, '.canvas', '.gitignore'), 'utf8')).toBe('*\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

> If `projectStore.test.ts` does not already import `mkdtempSync`/`rmSync`/`tmpdir`, add them to its existing `node:fs` / `node:os` imports (do not duplicate import lines).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/projectStore.test.ts`
Expected: FAIL — `.canvas/` not created (createProject does not scaffold yet).

- [ ] **Step 3: Write minimal implementation**

In `src/main/projectStore.ts`, add the import near the top (with the other local imports):

```ts
import { createCanvasMemory } from './canvasMemory'
```

In `createProject`, scaffold after the doc is ensured (both the reuse-existing and fresh-write paths). Replace the body's tail so BOTH return paths scaffold:

```ts
export async function createProject(
  dir: string,
  _name: string,
  _opts: { gitInit?: boolean }
): Promise<ProjectResult> {
  // `gitInit` is accepted for forward-compat with Slice C (worktrees) but is inert here.
  mkdirSync(dir, { recursive: true })
  const existing = readProject(dir)
  if (existing.ok) {
    createCanvasMemory(dir).ensureScaffold() // open-if-absent on a reused project
    return existing
  }
  // PERSIST-C: route the fresh write through writeProject so a canvas.json is only ever
  // created via the one envelope-guarded + atomic path (the same guard project:save uses)
  // — a future change to the fresh-doc shape can't silently bypass it. There is no prior
  // file here (reuse-if-exists returned above), so the .bak rotation is a no-op.
  const fresh = { schemaVersion: 2, viewport: null, boards: [] }
  await writeProject(dir, fresh)
  createCanvasMemory(dir).ensureScaffold() // T-M1: project data lives in <project>/.canvas/
  return { ok: true, dir, name: projectName(dir), doc: fresh }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/projectStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the open paths in `projectIpc.ts`**

In `src/main/projectIpc.ts`, add the import (with the `./projectStore` import group):

```ts
import { createCanvasMemory } from './canvasMemory'
```

In the `project:open` handler, after `remember(r)` and the asset GC, scaffold on a successful read (open-if-absent — an existing project predating T-M1 gets its `.canvas/` on first open):

```ts
  ipcMain.handle('project:open', (e, dir: string): ProjectResult => {
    if (guard(e)) return { ok: false, error: 'forbidden' }
    if (isUnsafeProjectDir(dir)) return { ok: false, error: 'invalid path' }
    const r = readProject(dir)
    remember(r)
    if (r.ok) {
      gcAssets(r.dir, collectAssetIds(r.doc))
      createCanvasMemory(r.dir).ensureScaffold() // T-M1: ensure .canvas/ on open
    }
    return r
  })
```

In the `project:current` handler, scaffold in the same `if (r.ok)` block (after `gcAssets`):

```ts
    if (r.ok) {
      setCurrentDir(r.dir)
      touchRecent(userDataDir, r.dir, projectName(r.dir), now())
      gcAssets(r.dir, collectAssetIds(r.doc))
      createCanvasMemory(r.dir).ensureScaffold() // T-M1: ensure .canvas/ on reopen
    }
```

- [ ] **Step 6: Run typecheck + the affected suites**

Run: `pnpm vitest run src/main/projectStore.test.ts && pnpm typecheck`
Expected: PASS (typecheck clean; `project:open`/`project:current` wiring is covered end-to-end by the Task 6 e2e probe).

- [ ] **Step 7: Commit**

```bash
git add src/main/projectStore.ts src/main/projectStore.test.ts src/main/projectIpc.ts
git commit -F - <<'EOF'
feat(context): M-memory T-M1 — scaffold .canvas/ on project create + open

createProject ensures the memory tree on create (and on reuse of an
existing project); project:open / project:current ensure it open-if-absent
so projects predating T-M1 get .canvas/ on first open. No canvas.json
contract change.
EOF
```

---

## Task 6: `context-memory` e2e probe

**Files:**
- Create: `src/main/e2e/probes/memory.ts`
- Modify: `src/main/e2e/index.ts` (append to `PLAYLIST`)

- [ ] **Step 1: Write the probe**

Create `src/main/e2e/probes/memory.ts`:

```ts
import { mkdtempSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createProject, setCurrentDir } from '../../projectStore'
import { createCanvasMemory } from '../../canvasMemory'
import type { E2EProbe } from '../types'

/**
 * M-memory T-M1: the `.canvas/` engine. Creates a throwaway project (mirrors the W4/W5
 * asset probes — project-rooted, so it needs a project dir, NOT a userData temp), then
 * asserts: (1) createProject scaffolded `.canvas/memory` + `.canvas/audit` + a
 * default-private `.gitignore` (`*`); (2) a board summary round-trips on disk under the
 * PROJECT dir; (3) the memory lives under the project dir, never userData. No LLM (T-M1
 * is the storage layer; the Tier-2 loop is T-M3).
 */
export const contextMemory: E2EProbe = {
  name: 'context-memory',
  async run() {
    const tmp = mkdtempSync(join(tmpdir(), 'canvas-m1-'))
    setCurrentDir(tmp)
    await createProject(tmp, 'm1', {})

    const mem = createCanvasMemory(tmp)
    const scaffolded =
      existsSync(mem.paths.memoryDir) &&
      existsSync(mem.paths.auditDir) &&
      existsSync(mem.paths.gitignore)
    const ignoreOk = scaffolded && readFileSync(mem.paths.gitignore, 'utf8') === '*\n'

    const wrote = mem.writeBoard('e2e-board', '# Board\n\nstub summary\n')
    const roundTrip = mem.readBoard('e2e-board') === '# Board\n\nstub summary\n'
    const onDisk = existsSync(join(tmp, '.canvas', 'memory', 'board-e2e-board.md'))
    // The board file is under the PROJECT dir, not anywhere near a userData path.
    const underProject = mem.paths.board('e2e-board').startsWith(join(tmp, '.canvas'))

    const ok = scaffolded && ignoreOk && wrote && roundTrip && onDisk && underProject
    return {
      name: 'context-memory',
      ok,
      detail: ok
        ? `scaffolded + board-e2e-board.md round-trips under ${join(tmp, '.canvas')}`
        : JSON.stringify({ scaffolded, ignoreOk, wrote, roundTrip, onDisk, underProject })
    }
  }
}
```

- [ ] **Step 2: Register the probe (append to the PLAYLIST)**

In `src/main/e2e/index.ts`, add the import alongside the other context probes:

```ts
import { contextMemory } from './probes/memory'
```

Append `contextMemory` as the **last** entry of the `PLAYLIST` array (it sets `currentDir` to a throwaway project, so it must not run before probes that depend on the seeded project; the prior `seed` probe at index ~95 already asserted the board count returned to 4 via the renderer store, which is independent of `currentDir`):

```ts
  settings, // M-brain T-B2: key store hasKey round-trip + no-plaintext-leak invariant
  contextMemory // M-memory T-M1: .canvas/ scaffold + board summary round-trip (project-rooted; runs last)
]
```

> Add a trailing comma after `settings` when inserting `contextMemory`.

- [ ] **Step 3: Build + run the e2e harness**

Run:
```
pnpm build
$env:CANVAS_SMOKE='e2e'; pnpm start
```
Expected: a line `E2E_CONTEXT-MEMORY {"name":"context-memory","ok":true,...}` and `E2E_DONE ... ok:true`.
> The `browser`/`browser-gesture`/`focus-detach` trio may show `ok:false` from the known `capturePage` env flake (memory `e2e-browser-trio-flake`) — rerun once for a clean `E2E_DONE`; not a regression.

- [ ] **Step 4: Commit**

```bash
git add src/main/e2e/probes/memory.ts src/main/e2e/index.ts
git commit -m "test(context): e2e context-memory probe — .canvas/ scaffold + round-trip"
```

---

## Task 7: full gate + fold the summary into the build log

**Files:**
- Modify: `docs/context-subsystem.md` (add an "M-memory T-M1" subsection + a gate-evidence row)

- [ ] **Step 1: Run the full gate**

Run:
```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```
Expected: all green. If `format:check` fails, run `pnpm format` then re-stage (prettier drift was a hard gate in T-B2/T-B3). Note the unit count (was **682** at T-B3 `cec15ba`; T-M1 adds the `canvasMemory` + `projectStore` scaffold tests).

- [ ] **Step 2: Run the e2e harness**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_CONTEXT-MEMORY ... ok:true`; `E2E_DONE ok:true` (rerun once if the browser trio flakes).

- [ ] **Step 3: Fold the T-M1 summary into `docs/context-subsystem.md`**

Per the consolidated-docs discipline (do **NOT** write a standalone handoff). Under a new `## M-memory — \`.canvas/\` engine + Tier-2 loop` heading (or extend "What's next"), add a `### T-M1 — \`.canvas/\` engine` subsection documenting: the `createCanvasMemory(projectDir)` surface, the `.canvas/memory/{MEMORY.md,project.md,board-<id>.md}` + `audit/` layout, the default-private/`audit/`-commit `.gitignore` toggle, `safeBoardId`, the create/open scaffold wiring, and the `context-memory` probe. Update the **Status** line (top of the file) to `M-memory T-M1 ✅; next T-M2`. Add a gate-evidence table row: `| T-M1 | <commit> | <unit count> | context-memory ok |`.

- [ ] **Step 4: Delete the consumed kickoff**

```bash
git rm docs/superpowers/handoffs/2026-06-03-context-m1-kickoff.md
```
(The kickoff's lifecycle note: "when T-M1 ships, fold its summary into `docs/context-subsystem.md` and delete this kickoff.")

- [ ] **Step 5: Commit the docs**

```bash
git add docs/context-subsystem.md
git commit -m "docs(context): fold M-memory T-M1 into the build log; drop kickoff"
```

---

## Post-plan: squash-merge to `feat/context`

After the gate + e2e are green and docs folded:

```bash
git checkout feat/context
git merge --squash feat/context-m1-canvas-engine
git commit -F - <<'EOF'
feat(context): M-memory T-M1 — .canvas/ engine (paths + atomic writers)

createCanvasMemory(projectDir): .canvas/memory/{MEMORY.md,project.md,
board-<id>.md} + reserved audit/, atomic markdown writers/readers,
default-private .gitignore with opt-in-to-commit toggle, safeBoardId
path-traversal guard. Scaffolded on project create + open (open-if-absent).
e2e context-memory probe. No LLM/loop/read-bridge (T-M2/T-M3/T-M4).
EOF
```
Then update `.claude/coordination/ACTIVE-WORK.md` (clear the `canvas-ade-context` row) and the `context-subsystem` memory (T-M1 done; next T-M2).

---

## Self-Review (run after writing — completed)

**Spec coverage** (T-M1 card in `docs/roadmap-context.md`): paths `.canvas/memory/{MEMORY.md,project.md,board-<id>.md}` + `audit/` → Task 1. Atomic writers (`write-file-atomic` + `mkdirSync`) rooted at project → Tasks 1–3. Default-`.gitignore` + opt-in commit → Tasks 1 & 4. Read helpers returning empty/undefined on missing, never throw → Tasks 2–3. Create/open wiring → Task 5. e2e round-trip + gitignore-present + under-project-dir → Task 6. Handoff folded into build log → Task 7. ✅ all covered.

**Placeholder scan:** no TBD/"add error handling"/bare "write tests" — every code step has full code. ✅

**Type consistency:** `createCanvasMemory` surface (`paths`, `ensureScaffold`, `writeBoard`/`readBoard`, `writeIndex`/`readIndex`, `writeProject`/`readProject`, `setCommitOptIn`, `isCommitted`, `safeBoardId`) identical across Tasks 1–6. `writeBoard` returns `boolean` consistently. `.gitignore` content constants (`'*\n'` / `'audit/\n'`) consistent across impl + every test. ✅
