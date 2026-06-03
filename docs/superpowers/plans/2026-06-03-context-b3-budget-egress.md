# M-brain T-B3 — Budget Guard + Egress ADR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the LLM brain's spend with a per-calendar-day **call** budget (typed `budget-exceeded` → Tier-1 fallback, never throws), document the one new outbound egress in an ADR, and split the IPC layer out of `llmService.ts` into `llmIpc.ts`.

**Architecture:** A new Electron-free `llmBudget.ts` persists a per-day call counter to `userData/llm-budget.json` (atomic, injected clock — mirrors `llmKeyStore`/`llmConfig`). `runSummarize` reserves one call against the cap **before** the single outbound `fetch`; a refused reservation becomes `{ok:false, reason:'budget-exceeded'}`. Enforcement is **always on for real egress** (cap = config or a 200/day default) and **off under the mock seam unless an explicit cap is configured** — so CI stays uncapped while the e2e probe opts in by lowering the cap. The IPC handlers (`registerLlmHandlers` + `isForeignSender` + status/write types) move to `llmIpc.ts`, leaving `llmService.ts` as the pure provider engine.

**Tech Stack:** TypeScript (strict), Electron 33 (MAIN), Vitest, `write-file-atomic`. No new dependencies.

---

## Settled design decisions (the 7 kickoff notes)

1. **Module boundary** → separate `src/main/llmBudget.ts` (explicit `userDataDir`, injected `Clock`; Electron-free).
2. **Cap dimension** → **call cap only** for v1 (deterministic, always available; no Provider-shape change). Default **200 calls/day** (`DEFAULT_MAX_CALLS_PER_DAY`). Token caps deferred.
3. **Reset window** → **per local calendar-day** (`YYYY-MM-DD` from an injected clock); a stale/missing/corrupt counter resets to 0.
4. **Where the guard fires + mock rule** → inside `runSummarize`, before `provider.summarize`. `shouldEnforceBudget(config, env)` = `isMockEnabled(env) ? config.maxCallsPerDay !== undefined : true`. Real egress always enforced; mock enforced only when a cap is explicitly set (the e2e probe opts in via `setConfig`).
5. **Contract** → `SummarizeResult` and the preload `LlmSummarizeResult` gain `{ok:false, reason:'budget-exceeded'}`; every caller treats it like `no-provider` (degrade to Tier-1). No new secret crosses IPC.
6. **Config surface** → cap is an optional `maxCallsPerDay?` in `llm-config.json` (no Settings field — YAGNI; `setConfig` carries it for the e2e probe). The **mutable** counter lives in a separate `userData/llm-budget.json`.
7. **IPC split** → **yes, in this task.** Move the IPC layer + `isForeignSender` + `LlmStatus`/`LlmWriteResult`/`NOOP_KEY_STORE` to `src/main/llmIpc.ts`; `llmService.ts` becomes the pure engine. Tests move to `llmIpc.test.ts`.

**Security invariants (unchanged, must hold):** the egress stays opt-in (no key/no mock → no call — already true via `getProvider`); the cap can't be bypassed by a foreign sender (handlers stay `isForeignSender`-guarded); no key/secret material crosses IPC or lands in `llm-budget.json`; `contextIsolation`/`sandbox`/`no-nodeIntegration` untouched.

---

## File Structure

- **Create** `src/main/llmBudget.ts` — per-day call-budget store (`createBudgetStore`, `dayKey`, `DEFAULT_MAX_CALLS_PER_DAY`, `BudgetStore`/`Clock`/`BudgetState` types). Pure file I/O + injected clock.
- **Create** `src/main/llmBudget.test.ts` — unit tests for consume/cap/day-reset/corrupt/file-location.
- **Modify** `src/main/llmConfig.ts` — add optional `maxCallsPerDay?` to `LlmConfig`; validate it in `readLlmConfig`.
- **Modify** `src/main/llmConfig.test.ts` — round-trip + reject-invalid cap.
- **Modify** `src/main/llmService.ts` — `SummarizeResult` += `budget-exceeded`; `ProviderDeps` += `budget?`; `shouldEnforceBudget`; budget reservation in `runSummarize`. **Remove** the IPC region (moves to `llmIpc.ts`) and the now-unused `electron` import.
- **Modify** `src/main/llmService.test.ts` — keep the pure-engine tests; **remove** the IPC/`isForeignSender` tests (they move); add `runSummarize` budget tests.
- **Create** `src/main/llmIpc.ts` — `isForeignSender`, `LlmStatus`, `LlmWriteResult`, `NOOP_KEY_STORE`, `registerLlmHandlers` (now builds + injects the budget store; `setConfig` carries `maxCallsPerDay`).
- **Create** `src/main/llmIpc.test.ts` — the moved IPC/guard tests + a capped-mock `budget-exceeded` round-trip.
- **Modify** `src/main/index.ts` — import `registerLlmHandlers` from `./llmIpc` (keep `runSummarize`/`defaultDeps` from `./llmService`).
- **Modify** `src/preload/index.ts` — mirror `budget-exceeded` on `LlmSummarizeResult`; add `maxCallsPerDay?` to the `setConfig` bridge arg.
- **Create** `src/main/e2e/probes/budget.ts` — `context-budget` probe (set cap=1 → drive past it → assert `budget-exceeded` + app usable + counter in `CANVAS_E2E_LLM_DIR`).
- **Modify** `src/main/e2e/index.ts` — register `contextBudget` in the playlist after `contextBrain`.
- **Create** `docs/decisions/0003-llm-egress.md` — the egress ADR.

---

### Task 1: IPC split — extract `llmIpc.ts` from `llmService.ts` (no behaviour change)

Mechanical refactor first, so later budget changes land in the right module. The full test suite must stay green.

**Files:**
- Create: `src/main/llmIpc.ts`
- Create: `src/main/llmIpc.test.ts`
- Modify: `src/main/llmService.ts` (remove IPC region + `electron` import)
- Modify: `src/main/llmService.test.ts` (remove the moved tests)
- Modify: `src/main/index.ts:16` (import `registerLlmHandlers` from `./llmIpc`)

- [ ] **Step 1: Create `src/main/llmIpc.ts` with the moved IPC layer**

```ts
/**
 * T-B1/T-B2 IPC layer for the LLM brain, split out of llmService.ts (T-B3) so the service
 * stays the pure provider engine. Owns the frame guard, the renderer-facing status/write
 * shapes, the safeStorage key-store wiring, and (T-B3) the per-day budget-store wiring.
 * Every channel rejects foreign senders; the API key crosses IPC inbound-only and is never
 * returned; no key/secret is logged or surfaced.
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import type { ProviderName, LlmConfig } from './llmConfig'
import { readLlmConfig, writeLlmConfig, DEFAULT_MODELS } from './llmConfig'
import { createKeyStore, type Encryptor, type KeyStore } from './llmKeyStore'
import { createBudgetStore } from './llmBudget'
import {
  getProvider,
  runSummarize,
  defaultDeps,
  type ProviderDeps,
  type SummarizeInput,
  type SummarizeResult
} from './llmService'

/**
 * True when an IPC sender is NOT the main window's main frame (foreign → deny). Matches
 * the pty/preview/project convention (a per-module copy is intentional; consolidating the
 * copies is a separate refactor, out of scope here).
 */
export function isForeignSender(
  e: Pick<IpcMainInvokeEvent, 'senderFrame'>,
  getMainFrame: () => BrowserWindow['webContents']['mainFrame'] | null | undefined
): boolean {
  const main = getMainFrame()
  if (!e.senderFrame) return false // synthetic/internal call — allow
  if (!main) return true // real sender but window unresolved — DENY
  return e.senderFrame !== main
}

/** Status surfaced to the renderer — provider/model + key presence, never key material. */
export interface LlmStatus {
  hasProvider: boolean
  provider: ProviderName
  model: string
  /** Base URL for the `local` provider, echoed so Settings can round-trip it. Undefined otherwise. */
  baseUrl?: string
  /** True when the active provider has a stored key (presence only — never the key). */
  hasKey: boolean
}

/** Result of a write-only LLM IPC call (setKey/clearKey/setConfig). Never carries key material. */
export type LlmWriteResult = { ok: boolean; reason?: string }

const NOOP_KEY_STORE: KeyStore = {
  getKey: () => undefined,
  setKey: () => {
    // No encryptor was wired into registerLlmHandlers — keys cannot be persisted. This is a
    // mis-wire (index.ts must pass the safeStorage Encryptor), not a real no-keyring host.
    console.warn('[llmIpc] setKey called with no encryptor — key not persisted (mis-wire)')
    return false
  },
  clearKey: () => {},
  hasKey: () => false
}

export function registerLlmHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string,
  injectedDeps?: ProviderDeps,
  encryptor?: Encryptor
): void {
  const keyStore: KeyStore = encryptor ? createKeyStore(userDataDir, encryptor) : NOOP_KEY_STORE
  // Resolution uses the SAME store the IPC writes to (store-first) and the SAME budget the
  // engine reserves against, so a key/cap set over IPC is immediately live for summarize.
  const deps: ProviderDeps = {
    ...(injectedDeps ?? defaultDeps()),
    keyStore,
    budget: injectedDeps?.budget ?? createBudgetStore(userDataDir, () => new Date())
  }
  const guard = (e: IpcMainInvokeEvent): boolean =>
    isForeignSender(e, () => getWin()?.webContents.mainFrame)

  ipcMain.handle('llm:summarize', async (e, input: SummarizeInput): Promise<SummarizeResult> => {
    if (guard(e)) return { ok: false, reason: 'provider-error', message: 'forbidden sender' }
    const config = readLlmConfig(userDataDir)
    return runSummarize(config, input, deps)
  })

  ipcMain.handle('llm:status', (e): LlmStatus => {
    if (guard(e))
      return {
        hasProvider: false,
        provider: 'openrouter',
        model: DEFAULT_MODELS.openrouter,
        hasKey: false
      }
    const config = readLlmConfig(userDataDir)
    return {
      hasProvider: getProvider(config, deps) !== null,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      hasKey: keyStore.hasKey(config.provider)
    }
  })

  ipcMain.handle('llm:setKey', (e, a: { provider: ProviderName; key: string }): LlmWriteResult => {
    if (guard(e)) return { ok: false, reason: 'forbidden' }
    return keyStore.setKey(a.provider, a.key)
      ? { ok: true }
      : { ok: false, reason: 'encryption-unavailable' }
  })

  ipcMain.handle('llm:clearKey', (e, a: { provider: ProviderName }): LlmWriteResult => {
    if (guard(e)) return { ok: false, reason: 'forbidden' }
    keyStore.clearKey(a.provider)
    return { ok: true }
  })

  ipcMain.handle(
    'llm:setConfig',
    (
      e,
      a: { provider: ProviderName; model: string; baseUrl?: string; maxCallsPerDay?: number }
    ): LlmWriteResult => {
      if (guard(e)) return { ok: false, reason: 'forbidden' }
      const cfg: LlmConfig = {
        provider: a.provider,
        model: a.model,
        baseUrl: a.baseUrl,
        maxCallsPerDay: a.maxCallsPerDay
      }
      writeLlmConfig(userDataDir, cfg)
      return { ok: true }
    }
  )
}
```

> Note: `setConfig` now carries `maxCallsPerDay` (Task 3 adds it to `LlmConfig`). Until Task 3 lands this is `undefined`-typed via the literal — keep it; typecheck passes once `LlmConfig` has the field. To keep Task 1 a clean refactor, the `maxCallsPerDay` line here is the only forward-reference; it compiles because the arg is optional and `LlmConfig` gains the field in Task 3 (do Task 1→3 in order).

- [ ] **Step 2: Remove the IPC region from `src/main/llmService.ts`**

Delete from `llmService.ts`: the `electron` import line (`import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'`), the entire `// Electron IPC layer (T-B1)` region — `isForeignSender`, `LlmStatus`, `LlmWriteResult`, `NOOP_KEY_STORE`, `registerLlmHandlers`. **Keep** `defaultDeps` (engine transport) and everything above the IPC region. After this, `llmService.ts` imports only `LlmConfig`/`ProviderName` types + `readLlmConfig`/`writeLlmConfig`/`DEFAULT_MODELS` (note: `writeLlmConfig`/`DEFAULT_MODELS` were only used by the IPC region — **remove them from the import** if now unused; keep `readLlmConfig` only if still used, else drop). Also `createKeyStore` was only used by `registerLlmHandlers` — drop it from the `llmKeyStore` import, keeping `type Encryptor`? `Encryptor` was only IPC-side too → keep only `type KeyStore`.

Final `llmService.ts` import block:
```ts
import type { LlmConfig, ProviderName } from './llmConfig'
import type { KeyStore } from './llmKeyStore'
```
(`readLlmConfig`, `writeLlmConfig`, `DEFAULT_MODELS`, `createKeyStore`, `Encryptor`, and the `electron` import are no longer referenced by the engine — remove them. `tsc --noUnusedLocals` will flag any miss.)

- [ ] **Step 3: Move the IPC tests into `src/main/llmIpc.test.ts`**

Cut these `it(...)` blocks from `src/main/llmService.test.ts` and paste them into a new `src/main/llmIpc.test.ts`, updating the import to `from './llmIpc'`: `allows a synthetic call (no senderFrame)`, `denies a real sender when the window is unresolved`, `allows the main frame and denies a different frame`, `summarize round-trips through the handler (mock env, no network)`, `status reports a provider + model and never leaks key material`, `summarize rejects a foreign sender (guard chain through the handler)`, `status returns the degraded shape for a foreign sender`.

`llmIpc.test.ts` header:
```ts
import { describe, it, expect, vi } from 'vitest'
import { isForeignSender, registerLlmHandlers, type LlmStatus } from './llmIpc'
import type { ProviderDeps, SummarizeResult } from './llmService'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
// (paste the moved blocks; keep whatever fake ipcMain / deps helpers they relied on —
//  move those helpers too. If a helper is shared with engine tests, duplicate the small
//  fake here rather than cross-importing a test file.)
```

- [ ] **Step 4: Update `src/main/index.ts` import**

Change line 16 from:
```ts
import { registerLlmHandlers, runSummarize, defaultDeps } from './llmService'
```
to:
```ts
import { runSummarize, defaultDeps } from './llmService'
import { registerLlmHandlers } from './llmIpc'
```

- [ ] **Step 5: Run the gate to confirm the refactor is behaviour-preserving**

Run: `pnpm typecheck && pnpm test`
Expected: PASS — same test count as before minus the moved tests in `llmService.test.ts`, plus the same count back in `llmIpc.test.ts` (net 0). No `noUnusedLocals` errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/llmIpc.ts src/main/llmIpc.test.ts src/main/llmService.ts src/main/llmService.test.ts src/main/index.ts
git commit -m "refactor(context): split LLM IPC layer into llmIpc.ts (T-B3 prep)"
```

---

### Task 2: Budget store module (`llmBudget.ts`)

**Files:**
- Create: `src/main/llmBudget.ts`
- Test: `src/main/llmBudget.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/llmBudget.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBudgetStore, dayKey, DEFAULT_MAX_CALLS_PER_DAY } from './llmBudget'

describe('llmBudget', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llmbudget-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // A fixed clock the test can advance.
  function clockAt(iso: string): () => Date {
    return () => new Date(iso)
  }

  it('has a sane default cap', () => {
    expect(DEFAULT_MAX_CALLS_PER_DAY).toBeGreaterThan(0)
  })

  it('dayKey is the local YYYY-MM-DD', () => {
    expect(dayKey(new Date(2026, 5, 3, 14, 0, 0))).toBe('2026-06-03')
  })

  it('consumes calls up to the cap, then blocks', () => {
    const b = createBudgetStore(dir, clockAt('2026-06-03T10:00:00'))
    expect(b.tryConsume(2)).toBe(true)
    expect(b.tryConsume(2)).toBe(true)
    expect(b.tryConsume(2)).toBe(false) // cap hit
    expect(b.peek().calls).toBe(2) // a blocked call does NOT increment
  })

  it('a cap of 0 blocks immediately', () => {
    const b = createBudgetStore(dir, clockAt('2026-06-03T10:00:00'))
    expect(b.tryConsume(0)).toBe(false)
    expect(b.peek().calls).toBe(0)
  })

  it('persists the counter across store instances on the same day', () => {
    const c = clockAt('2026-06-03T10:00:00')
    createBudgetStore(dir, c).tryConsume(5)
    const b2 = createBudgetStore(dir, c)
    expect(b2.peek().calls).toBe(1)
    expect(b2.tryConsume(5)).toBe(true)
    expect(b2.peek().calls).toBe(2)
  })

  it('resets on a new calendar day', () => {
    createBudgetStore(dir, clockAt('2026-06-03T23:59:00')).tryConsume(1) // day full at cap 1
    const next = createBudgetStore(dir, clockAt('2026-06-04T00:01:00'))
    expect(next.peek().calls).toBe(0) // new day → reset
    expect(next.tryConsume(1)).toBe(true)
  })

  it('treats a missing or corrupt counter file as zero', () => {
    const b = createBudgetStore(dir, clockAt('2026-06-03T10:00:00'))
    expect(b.peek().calls).toBe(0) // missing
    rmSync(join(dir, 'llm-budget.json'), { force: true })
    // write garbage
    require('node:fs').writeFileSync(join(dir, 'llm-budget.json'), '{not json', 'utf8')
    expect(b.peek().calls).toBe(0) // corrupt → zero
  })

  it('writes llm-budget.json into the given dir only', () => {
    createBudgetStore(dir, clockAt('2026-06-03T10:00:00')).tryConsume(5)
    expect(existsSync(join(dir, 'llm-budget.json'))).toBe(true)
    const raw = readFileSync(join(dir, 'llm-budget.json'), 'utf8')
    expect(raw).not.toMatch(/api[_-]?key/i) // never key material
    expect(JSON.parse(raw)).toMatchObject({ day: '2026-06-03', calls: 1 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/main/llmBudget.test.ts`
Expected: FAIL — `Cannot find module './llmBudget'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/main/llmBudget.ts
/**
 * T-B3: per-day CALL-budget store for the LLM brain. Counts summarize calls against a
 * configurable per-calendar-day cap and persists the running count to
 * userData/llm-budget.json (atomic write — same userData discipline as llmConfig/llmKeyStore;
 * NEVER a project folder / .canvas/ / canvas.json). Electron-free: the clock is injected so
 * the day boundary is deterministic in tests. The engine (runSummarize) reserves one call via
 * tryConsume(cap) BEFORE the single outbound fetch; a false result becomes a typed
 * {ok:false,reason:'budget-exceeded'} and the app falls back to Tier-1. Token-dimension caps
 * are intentionally deferred (a call cap is deterministic + always available; token usage
 * would need per-provider response plumbing).
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

/** Default per-day call cap — cheap/fast summaries are short + frequent; 200/day is generous. */
export const DEFAULT_MAX_CALLS_PER_DAY = 200

/** Injected clock so the day boundary is deterministic in tests. */
export type Clock = () => Date

export interface BudgetState {
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  /** Calls consumed during `day`. */
  calls: number
}

export interface BudgetStore {
  /**
   * Reserve one call against `cap` for today, resetting on a new day. Returns true (and
   * persists the increment) when allowed; false (writing nothing) when the cap is reached.
   */
  tryConsume(cap: number): boolean
  /** Today's usage (read-only; reflects a day reset without persisting). */
  peek(): BudgetState
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'llm-budget.json')
}

/** Local YYYY-MM-DD for a Date (no UTC shift — the cap is a local-day cap). */
export function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function read(userDataDir: string): BudgetState | null {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return null
  try {
    const p = JSON.parse(readFileSync(f, 'utf8')) as Partial<BudgetState>
    if (typeof p.day === 'string' && typeof p.calls === 'number' && p.calls >= 0) {
      return { day: p.day, calls: p.calls }
    }
    return null
  } catch {
    return null
  }
}

function write(userDataDir: string, state: BudgetState): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(state, null, 2), 'utf8')
}

export function createBudgetStore(userDataDir: string, clock: Clock): BudgetStore {
  /** Today's state, resetting a stale (prior-day) or missing/corrupt counter to zero. */
  function current(): BudgetState {
    const today = dayKey(clock())
    const stored = read(userDataDir)
    if (!stored || stored.day !== today) return { day: today, calls: 0 }
    return stored
  }
  return {
    peek: current,
    tryConsume(cap) {
      const state = current()
      if (state.calls >= cap) return false
      write(userDataDir, { day: state.day, calls: state.calls + 1 })
      return true
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/main/llmBudget.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/llmBudget.ts src/main/llmBudget.test.ts
git commit -m "feat(context): per-day call-budget store (T-B3)"
```

---

### Task 3: Add `maxCallsPerDay` to `LlmConfig`

**Files:**
- Modify: `src/main/llmConfig.ts`
- Test: `src/main/llmConfig.test.ts`

- [ ] **Step 1: Write the failing tests (append to `llmConfig.test.ts`)**

```ts
  it('round-trips an optional maxCallsPerDay cap', () => {
    writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: 5 })
    expect(readLlmConfig(dir).maxCallsPerDay).toBe(5)
  })

  it('omits maxCallsPerDay when not set', () => {
    writeLlmConfig(dir, { provider: 'openrouter', model: 'm' })
    expect(readLlmConfig(dir).maxCallsPerDay).toBeUndefined()
  })

  it('rejects a negative or non-numeric cap (→ undefined)', () => {
    writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: -3 })
    expect(readLlmConfig(dir).maxCallsPerDay).toBeUndefined()
    writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: NaN })
    expect(readLlmConfig(dir).maxCallsPerDay).toBeUndefined()
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/main/llmConfig.test.ts`
Expected: FAIL — `maxCallsPerDay` is not on `LlmConfig` / not parsed.

- [ ] **Step 3: Implement**

In `src/main/llmConfig.ts`, add the field to the interface:
```ts
export interface LlmConfig {
  provider: ProviderName
  model: string
  /** Base URL for the `local` provider only (e.g. http://127.0.0.1:1234/v1). */
  baseUrl?: string
  /** Per-day LLM call cap (T-B3). Undefined → DEFAULT_MAX_CALLS_PER_DAY for real egress. */
  maxCallsPerDay?: number
}
```

In `readLlmConfig`, after computing `baseUrl`, parse the cap and include it:
```ts
    const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl : undefined
    const maxCallsPerDay =
      typeof p.maxCallsPerDay === 'number' &&
      Number.isFinite(p.maxCallsPerDay) &&
      p.maxCallsPerDay >= 0
        ? Math.floor(p.maxCallsPerDay)
        : undefined
    return { provider, model, baseUrl, maxCallsPerDay }
```

(`writeLlmConfig` already `JSON.stringify`s the whole `cfg`, so `maxCallsPerDay` persists with no change. `defaults()` returns no `maxCallsPerDay` → `undefined`, correct.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/main/llmConfig.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/llmConfig.ts src/main/llmConfig.test.ts
git commit -m "feat(context): optional maxCallsPerDay in llm-config (T-B3)"
```

---

### Task 4: Wire the budget into `runSummarize` + extend `SummarizeResult`

**Files:**
- Modify: `src/main/llmService.ts`
- Test: `src/main/llmService.test.ts`

- [ ] **Step 1: Write the failing tests (append to the `runSummarize` describe block in `llmService.test.ts`)**

```ts
  // Minimal fakes: a fetch that records calls, a budget whose tryConsume is scripted.
  const okFetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'real' } }] }),
    text: async () => ''
  }))

  function budgetReturning(allowed: boolean): { store: import('./llmBudget').BudgetStore; calls: () => number } {
    let n = 0
    return {
      store: {
        tryConsume: () => {
          n++
          return allowed
        },
        peek: () => ({ day: '2026-06-03', calls: n })
      },
      calls: () => n
    }
  }

  const realEnv = {} as Record<string, string | undefined> // not mock; key present below
  const cfg = { provider: 'openrouter' as const, model: 'm' }

  it('real egress consults the budget and returns ok when allowed', async () => {
    const fetch = vi.fn(okFetch)
    const b = budgetReturning(true)
    const r = await runSummarize(cfg, { text: 'hi' }, {
      fetch,
      env: { OPENROUTER_API_KEY: 'k' },
      budget: b.store
    })
    expect(r).toEqual({ ok: true, text: 'real' })
    expect(b.calls()).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('returns budget-exceeded WITHOUT calling fetch when the cap is hit', async () => {
    const fetch = vi.fn(okFetch)
    const b = budgetReturning(false)
    const r = await runSummarize(cfg, { text: 'hi' }, {
      fetch,
      env: { OPENROUTER_API_KEY: 'k' },
      budget: b.store
    })
    expect(r).toEqual({ ok: false, reason: 'budget-exceeded' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does NOT consult the budget under the mock seam with no explicit cap', async () => {
    const b = budgetReturning(false) // would block if consulted
    const r = await runSummarize(cfg, { text: 'hi' }, {
      fetch: vi.fn(),
      env: { CANVAS_SMOKE: 'e2e' }, // mock on
      budget: b.store
    })
    expect(r).toEqual({ ok: true, text: '[mock] hi' })
    expect(b.calls()).toBe(0) // budget untouched
  })

  it('DOES enforce under the mock seam when an explicit cap is configured', async () => {
    const b = budgetReturning(false)
    const r = await runSummarize({ ...cfg, maxCallsPerDay: 1 }, { text: 'hi' }, {
      fetch: vi.fn(),
      env: { CANVAS_SMOKE: 'e2e' },
      budget: b.store
    })
    expect(r).toEqual({ ok: false, reason: 'budget-exceeded' })
  })

  it('skips enforcement entirely when no budget is injected (back-compat)', async () => {
    const r = await runSummarize(cfg, { text: 'hi' }, {
      fetch: vi.fn(okFetch),
      env: { OPENROUTER_API_KEY: 'k' }
    })
    expect(r).toEqual({ ok: true, text: 'real' })
  })
```

> If `vi` isn't already imported in `llmService.test.ts`, add it: `import { describe, it, expect, vi } from 'vitest'`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: FAIL — `budget-exceeded` not produced; `ProviderDeps` has no `budget`.

- [ ] **Step 3: Implement in `src/main/llmService.ts`**

Add the budget import at the top (engine side only needs the type + default):
```ts
import { DEFAULT_MAX_CALLS_PER_DAY, type BudgetStore } from './llmBudget'
```

Extend `ProviderDeps`:
```ts
export interface ProviderDeps {
  fetch: FetchLike
  env: Record<string, string | undefined>
  /** Store-first key source (T-B2). getKey-only so unit tests inject a tiny fake. */
  keyStore?: Pick<KeyStore, 'getKey'>
  /** T-B3 per-day call budget. When present + enforced, summarize reserves a call first. */
  budget?: BudgetStore
}
```

Extend `SummarizeResult`:
```ts
export type SummarizeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-provider' }
  | { ok: false; reason: 'budget-exceeded' }
  | { ok: false; reason: 'provider-error'; message: string }
```

Add the enforcement predicate (exported for direct unit cover + reuse):
```ts
/**
 * Whether the per-day budget is enforced for this call. Real egress: always (cap = config or
 * the default). Under the mock seam (CI/e2e): only when an explicit cap is configured — so CI
 * stays uncapped unless a probe opts in by setting maxCallsPerDay.
 */
export function shouldEnforceBudget(
  config: LlmConfig,
  env: Record<string, string | undefined>
): boolean {
  return isMockEnabled(env) ? config.maxCallsPerDay !== undefined : true
}
```

Update `runSummarize` (reserve before calling the provider):
```ts
export async function runSummarize(
  config: LlmConfig,
  input: SummarizeInput,
  deps: ProviderDeps
): Promise<SummarizeResult> {
  const provider = getProvider(config, deps)
  if (!provider) return { ok: false, reason: 'no-provider' }
  if (deps.budget && shouldEnforceBudget(config, deps.env)) {
    const cap = config.maxCallsPerDay ?? DEFAULT_MAX_CALLS_PER_DAY
    if (!deps.budget.tryConsume(cap)) return { ok: false, reason: 'budget-exceeded' }
  }
  try {
    return { ok: true, text: await provider.summarize(input) }
  } catch (err) {
    return {
      ok: false,
      reason: 'provider-error',
      message: err instanceof Error ? err.message : String(err)
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: PASS (existing engine tests + 5 new budget tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/llmService.ts src/main/llmService.test.ts
git commit -m "feat(context): budget-exceeded result + budget reservation in runSummarize (T-B3)"
```

---

### Task 5: IPC budget round-trip test (handler wires a real store)

`registerLlmHandlers` already attaches `createBudgetStore(...)` (Task 1). Prove a capped mock call surfaces `budget-exceeded` end-to-end through the handler.

**Files:**
- Test: `src/main/llmIpc.test.ts`

- [ ] **Step 1: Write the failing test (append to `llmIpc.test.ts`)**

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeLlmConfig } from './llmConfig'

it('enforces a configured cap through the summarize handler (mock seam, no network)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'llmipc-budget-'))
  try {
    // Explicit cap of 1 → mock-seam enforcement opts in (shouldEnforceBudget).
    writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: 1 })

    const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
    const fakeIpc = {
      handle: (ch: string, fn: (e: unknown, a: unknown) => unknown) => handlers.set(ch, fn)
    } as unknown as IpcMain
    const win = { webContents: { mainFrame: {} } } as unknown as Parameters<
      typeof registerLlmHandlers
    >[1] extends () => infer _ ? never : never // (use the same fake-win helper the moved tests use)

    // Reuse the moved tests' fake window + synthetic event (no senderFrame → allowed).
    registerLlmHandlers(fakeIpc, () => ({ webContents: { mainFrame: {} } }) as never, dir, {
      fetch: (async () => {
        throw new Error('network must not be hit under mock')
      }) as never,
      env: { CANVAS_SMOKE: 'e2e' }
    })

    const summarize = handlers.get('llm:summarize')!
    const r1 = (await summarize({ senderFrame: undefined }, { text: 'a' })) as SummarizeResult
    const r2 = (await summarize({ senderFrame: undefined }, { text: 'b' })) as SummarizeResult
    expect(r1).toEqual({ ok: true, text: '[mock] a' })
    expect(r2).toEqual({ ok: false, reason: 'budget-exceeded' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

> Simplify to match the fake `ipcMain`/window helpers the moved IPC tests already define in this file — reuse them rather than the inline `as never` casts above. The assertion that matters: first call `[mock] a`, second `budget-exceeded`, and the injected `fetch` is never invoked.

- [ ] **Step 2: Run to verify failure (then pass once aligned with helpers)**

Run: `pnpm vitest run src/main/llmIpc.test.ts`
Expected: initially FAIL if helper wiring differs; adjust to the file's fakes → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/llmIpc.test.ts
git commit -m "test(context): handler-level budget-exceeded round-trip (T-B3)"
```

---

### Task 6: Mirror `budget-exceeded` in preload + carry `maxCallsPerDay` on `setConfig`

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Update the preload mirror types**

Extend `LlmSummarizeResult`:
```ts
export type LlmSummarizeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-provider' }
  | { ok: false; reason: 'budget-exceeded' }
  | { ok: false; reason: 'provider-error'; message: string }
```

Add `maxCallsPerDay?` to the `setConfig` bridge arg (find the existing `setConfig` in the `llm` bridge):
```ts
    setConfig: (cfg: {
      provider: 'openrouter' | 'openai' | 'anthropic' | 'local'
      model: string
      baseUrl?: string
      maxCallsPerDay?: number
    }): Promise<LlmWriteResult> => ipcRenderer.invoke('llm:setConfig', cfg),
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS — renderer callers that `switch` on `result.reason` now see `budget-exceeded`; any exhaustive switch that breaks is a caller to fix (treat `budget-exceeded` like `no-provider`). Search: `rg "reason ===|\.reason" src/renderer` — if a caller exhaustively handles reasons, add the `budget-exceeded` branch (degrade to Tier-1, same as `no-provider`).

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(context): mirror budget-exceeded + setConfig cap in preload (T-B3)"
```

---

### Task 7: e2e budget probe

**Files:**
- Create: `src/main/e2e/probes/budget.ts`
- Modify: `src/main/e2e/index.ts`

- [ ] **Step 1: Write the probe**

```ts
// src/main/e2e/probes/budget.ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { E2EProbe } from '../types'

/**
 * M-brain T-B3: the per-day call budget. Under CANVAS_SMOKE=e2e the provider is mocked
 * (no network). Default config sets NO cap → mock-seam enforcement is OFF, so this probe
 * opts in by lowering maxCallsPerDay to 1 via the real setConfig bridge, then drives
 * summarize past it. The SECOND call is deterministically over cap 1 (the counter is shared
 * across the run, so after one call it is >= 1). Asserts: budget-exceeded surfaces, the app
 * stays usable (status resolves + Tier-1 digest cards still render), and the spend counter
 * lives in CANVAS_E2E_LLM_DIR (a throwaway temp dir), never a project folder. Restores an
 * uncapped config at the end so nothing downstream is throttled.
 */
export const contextBudget: E2EProbe = {
  name: 'context-budget',
  async run(ctx) {
    const cfg = "{ provider:'openrouter', model:'google/gemini-2.0-flash-001'"
    await ctx.evalIn(`window.api.llm.setConfig(${cfg}, maxCallsPerDay: 1 }).then((r)=>JSON.stringify(r))`)

    await ctx.evalIn("window.api.llm.summarize({ text:'budget-1' }).then((r)=>JSON.stringify(r))")
    const second = await ctx.evalIn<string>(
      "window.api.llm.summarize({ text:'budget-2' }).then((r)=>JSON.stringify(r))"
    )
    const status = await ctx.evalIn<string>('window.api.llm.status().then((s)=>JSON.stringify(s))')
    const cards = await ctx.evalIn<number>(
      "document.querySelectorAll('[data-test=digest-card]').length"
    )
    // Restore an uncapped config (no maxCallsPerDay).
    await ctx.evalIn(`window.api.llm.setConfig(${cfg} }).then((r)=>JSON.stringify(r))`)

    // MAIN-side: the counter is in the e2e temp userData dir, not a project folder.
    const dir = process.env.CANVAS_E2E_LLM_DIR
    const counterInTempDir = !!dir && existsSync(join(dir, 'llm-budget.json'))

    let exceeded = false
    let usable = false
    try {
      exceeded = (JSON.parse(second) as { reason?: string }).reason === 'budget-exceeded'
      const s = JSON.parse(status) as { provider?: string }
      usable = !!s.provider && cards >= 1
    } catch {
      /* keep false */
    }

    return {
      name: 'context-budget',
      ok: exceeded && usable && counterInTempDir,
      detail: `second=${second} cards=${cards} counterInTempDir=${counterInTempDir}`
    }
  }
}
```

> The `${cfg}` string-splice keeps the literal valid: it expands to `setConfig({ provider:'openrouter', model:'google/gemini-2.0-flash-001', maxCallsPerDay: 1 })` and (restore) `setConfig({ provider:'openrouter', model:'google/gemini-2.0-flash-001' })`. If clearer, write the two `setConfig` calls out in full instead of splicing.

- [ ] **Step 2: Register it in the playlist AFTER `contextBrain`**

In `src/main/e2e/index.ts`, extend the import and the `PLAYLIST` tail:
```ts
import { context, contextBrain } from './probes/context'
import { contextBudget } from './probes/budget'
// ...
  seed, // asserts the canvas returned to 4 boards
  context, // M-digest T-D2: reopen digest panel
  contextBrain, // M-brain T-B1: llm:summarize mock round-trip (no cap set → unenforced)
  contextBudget // M-brain T-B3: opt-in cap → budget-exceeded; runs AFTER contextBrain
```

> Order matters: `contextBrain` must run before `contextBudget` lowers the cap, or its single summarize would hit the cap. `contextBudget` restores an uncapped config when done.

- [ ] **Step 3: Build + run the board e2e**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_CONTEXT-BUDGET {"ok":true,...}` and `E2E_DONE ok:true`. (The browser/browser-gesture/focus-detach trio may flake once on a contended host — rerun for a clean pass; memory `e2e-browser-trio-flake`.)

- [ ] **Step 4: Commit**

```bash
git add src/main/e2e/probes/budget.ts src/main/e2e/index.ts
git commit -m "test(context): e2e budget probe — opt-in cap → budget-exceeded, app usable (T-B3)"
```

---

### Task 8: Egress ADR

**Files:**
- Create: `docs/decisions/0003-llm-egress.md`

- [ ] **Step 1: Write the ADR**

```markdown
# 3. LLM egress — the one new outbound call beyond loopback

Date: 2026-06-03
Status: Accepted

## Context

The Context subsystem's Tier-2 brain (`llmService.ts`, M-brain) summarizes board content by
calling a user-chosen LLM provider (OpenRouter default; OpenAI / Anthropic / a local endpoint).
This is the **one new outbound network egress** beyond loopback (the local dev server + the
preview `WebContentsView`s). Until now the app made no third-party network calls. Board content
(terminal scrollback, browser page text) flows **into** the request body, and an API key + the
user's spend are involved — so the egress needs an explicit, documented contract.

## Decision

1. **Opt-in, never implicit.** No call is made without a configured provider key. `getProvider`
   returns `null` when no key is present (and the mock seam short-circuits in CI/e2e), so
   `runSummarize` yields `{ok:false, reason:'no-provider'}` and the app runs at Tier-1. Egress
   exists only after the user enters a key in Settings (T-B2, `safeStorage` in `userData`).
2. **Isolated behind one interface.** The only `fetch` lives inside the real `Provider.summarize`
   in `llmService.ts`. No other module performs outbound I/O for the brain.
3. **Spend is capped.** A per-calendar-day **call** budget (`llmBudget.ts`, T-B3) reserves a call
   before each request; over the cap → `{ok:false, reason:'budget-exceeded'}` → Tier-1. Default
   200 calls/day, user-overridable via `maxCallsPerDay` in `llm-config.json`. The counter lives in
   `userData/llm-budget.json` (never a project folder).
4. **Passive output only (lethal-trifecta).** Generated summaries are **untrusted, passive
   context** — written to disk + displayed (+ later MCP-read), and they **never trigger an
   action**. Board content reaching the model never returns to the PTY write channel or any tool.
5. **Security posture unchanged.** `contextIsolation: true`, `sandbox: true`,
   `nodeIntegration: false` are untouched. Browser-board content (a native `WebContentsView` with
   no preload and a separate session) cannot reach the `llm:*` channels. The API key crosses IPC
   **inbound only** and is never returned to the renderer.

## Consequences

- The app makes a third-party HTTPS call **only** when the user has configured a key and stayed
  under budget. A privacy-sensitive user simply sets no key and keeps full Tier-1 functionality.
- Spend is bounded by a daily cap the user controls; a runaway loop degrades to Tier-1 rather
  than overspending.
- Out of scope here: the MCP server's Host-header attack surface (a separate egress/ingress
  concern, covered by the MCP ADR — memory `mcp-spec-state-2026-06`); token-dimension budgets
  (deferred — the call cap is the v1 guard); per-provider request hardening.
```

- [ ] **Step 2: Commit**

```bash
git add docs/decisions/0003-llm-egress.md
git commit -m "docs(context): ADR 0003 — LLM egress (opt-in, capped, passive) (T-B3)"
```

---

### Task 9: Full gate + handoff (controller)

**Files:**
- Create: `docs/superpowers/handoffs/2026-06-03-context-b3-budget-egress.md`

- [ ] **Step 1: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`
Expected: typecheck 0, lint 0 errors, format clean (run `pnpm format` first if it drifts — format:check is a hard gate, memory note from T-B2), all unit tests green (≈ +21 new: 8 budget, 3 config, 5 runSummarize-budget, 1 IPC budget round-trip, plus the moved IPC tests net-zero), build OK.

- [ ] **Step 2: Run the board e2e (rerun once if the browser trio flakes)**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_CONTEXT-BUDGET {"ok":true,...}`, `E2E_DONE ok:true`.

- [ ] **Step 3: Write the handoff doc**

Cover: what shipped (budget store + enforcement rule + ADR + IPC split), the files, the new IPC `setConfig` cap field, the enforcement table (real always / mock only with explicit cap), the gate evidence, the e2e probe, and the next pointer (M-memory T-M1 — `.canvas/` engine). Note any follow-ups (e.g. the 4th `isForeignSender` copy still un-consolidated; token-dimension cap deferred).

- [ ] **Step 4: Commit + squash-merge**

```bash
git add docs/superpowers/handoffs/2026-06-03-context-b3-budget-egress.md
git commit -m "docs(context): T-B3 handoff — budget guard + egress ADR"
git checkout feat/context && git merge --squash feat/context-b3-budget-egress && git commit
```
Then update `.claude/coordination/ACTIVE-WORK.md` (context row → T-B3 done) and the `context-subsystem` memory.

---

## Self-Review

- **Spec coverage:** per-day budget cap (Tasks 2–5) ✓; typed `budget-exceeded` never-throws → Tier-1 (Task 4) ✓; configurable cap + counter in `userData`, injectable (Tasks 2–3) ✓; egress ADR (Task 8) ✓; mock seam stays uncapped unless opted in (Task 4 `shouldEnforceBudget` + Task 7 probe) ✓; IPC split (Task 1) ✓; preload mirror (Task 6) ✓; e2e asserts the cap fires AND app stays usable AND counter location (Task 7) ✓.
- **Placeholder scan:** all code steps carry full code; the two soft spots (the `llmIpc.test.ts` fake-window/ipcMain helpers in Tasks 1/5, and the probe's `setConfig` string form in Task 7) are flagged with explicit "reuse the existing helper / write both calls out" guidance rather than left as TODO.
- **Type consistency:** `BudgetStore.tryConsume(cap)` / `peek()`, `createBudgetStore(userDataDir, clock)`, `DEFAULT_MAX_CALLS_PER_DAY`, `shouldEnforceBudget(config, env)`, `SummarizeResult` + `LlmSummarizeResult` `budget-exceeded` variant, and `setConfig`'s `maxCallsPerDay?` are named identically across main + preload + tests.
```
