# M-brain T-B2 — safeStorage Key Store + Settings Key-Entry UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace T-B1's env-var API-key read with an Electron `safeStorage`-encrypted key store under `userData`, add `llm:setKey`/`llm:clearKey`/`llm:setConfig` IPC + a `hasKey` flag on `llm:status`, and ship a minimal Settings modal (provider · model · masked key) — the key flowing renderer→MAIN write-only, never back, never to the project folder.

**Architecture:** A new electron-free `src/main/llmKeyStore.ts` owns encrypt/persist/read/clear behind an injectable `Encryptor` (real wiring = Electron `safeStorage`, passed from `index.ts`; tests inject a fake). `keyForProvider` becomes store-first / env-fallback and stays injectable via `ProviderDeps.keyStore`. The IPC handlers + preload bridge gain the key-write channels; the renderer gets a portaled Settings modal opened from a gear in the camera cluster. Everything downstream of the key source (`getProvider`, `runSummarize`, mock seam, no-provider contract) is untouched.

**Tech Stack:** Electron 33 `safeStorage`, TypeScript strict, Vitest + Testing Library, `write-file-atomic`, React 18 + portal (existing chrome pattern), the `CANVAS_SMOKE=e2e` in-process board harness.

---

## Design decisions settled (the 6 kickoff notes)

1. **Module boundary.** The encrypted key lives in a **new** `src/main/llmKeyStore.ts`. `llmConfig.ts` stays key-free (its `not.toMatch(/api[_-]?key/i)` test holds). Key file = `userData/llm-keys.json`, separate from `userData/llm-config.json`.
2. **Resolution precedence.** **safeStorage store FIRST, env var as a dev fallback.** `keyForProvider(provider, env, store?)` returns `store?.getKey(provider) ?? env[KEY_ENV[provider]]`. Keeps T-B1 dev/test env flows working; stays injectable (no Electron needed in unit tests).
3. **safeStorage unavailable (Linux, no keyring).** **Refuse-to-persist** — `setKey` returns `{ ok: false, reason: 'encryption-unavailable' }` and writes **nothing**. We never write a plaintext key to disk. On such hosts the env-var fallback (note 2) remains the path. Documented in the handoff.
4. **IPC surface + key direction.** New `llm:setKey {provider,key} → {ok,reason?}`, `llm:clearKey {provider} → {ok}`, `llm:setConfig {provider,model,baseUrl?} → {ok}`; `llm:status` gains `hasKey:boolean`. Key flows renderer→MAIN only; **never returned**; status carries presence only. All new handlers reject foreign senders via the existing `isForeignSender`.
5. **Injectable encryptor.** `Encryptor { isEncryptionAvailable(); encryptString(plain): Buffer; decryptString(enc): Buffer→string }` mirrors `safeStorage`'s method names. `createKeyStore(userDataDir, encryptor)` mirrors how `llmConfig` takes an explicit `userDataDir`. `llmKeyStore.ts` imports **no** Electron runtime — the real `safeStorage` adapter is built in `index.ts` (already imports `electron`) and passed in. So `llmKeyStore.test.ts` runs without Electron.
6. **Settings modal scope.** Minimal, portaled, design-token styled: provider `<select>` (4), model text input (prefilled from `DEFAULT_MODELS` on provider change, editable), `baseUrl` input shown only for `local`, masked key `<input type=password>`, **Save** (writes config via `llm:setConfig` + the key via `llm:setKey` when the field is non-empty) and **Clear key** (`llm:clearKey`). No multi-key / profiles (YAGNI).

**e2e isolation:** under `CANVAS_SMOKE=e2e`, `index.ts` registers the LLM handlers against a **temp** userData dir (`mkdtempSync`) and exports its path as `process.env.CANVAS_E2E_LLM_DIR`, so the probe scans the real on-disk artifact without polluting the dev's real `userData`. The mock provider seam (T-B1) is unchanged → `summarize` still resolves `[mock] …` with no key/network.

## File structure

| File | Responsibility |
|---|---|
| `src/main/llmKeyStore.ts` (new) | `Encryptor`/`KeyStore` interfaces + `createKeyStore` (encrypt/persist/read/clear, atomic write). Electron-free. |
| `src/main/llmKeyStore.test.ts` (new) | Unit tests with a fake reversible encryptor + `mkdtempSync` dir. |
| `src/main/llmService.ts` (modify) | `keyForProvider` store-first/env-fallback; `ProviderDeps.keyStore`; `getProvider` passes the store; `registerLlmHandlers` builds the store from an injected `Encryptor`, adds the 3 channels + `hasKey`. |
| `src/main/llmService.test.ts` (modify) | Precedence tests; handler tests for setKey/clearKey/setConfig/status.hasKey + foreign-sender denial. |
| `src/main/index.ts` (modify) | Build the `safeStorage` `Encryptor` adapter; compute the (temp-under-e2e) llm data dir; pass both to `registerLlmHandlers`; export `CANVAS_E2E_LLM_DIR`. |
| `src/preload/index.ts` (modify) | Extend `llm` bridge (`setKey`/`clearKey`/`setConfig`); `LlmStatus` mirror gains `hasKey`; new result types. |
| `src/renderer/src/canvas/SettingsModal.tsx` (new) | Portaled modal: provider/model/baseUrl/key + Save/Clear. |
| `src/renderer/src/canvas/SettingsModal.test.tsx` (new) | RTL: prefill from status, Save calls setConfig+setKey, Clear calls clearKey, key input masked. |
| `src/renderer/src/canvas/AppChrome.tsx` (modify) | Gear `ToolBtn` in the camera cluster that opens the modal. |
| `src/main/e2e/probes/settings.ts` (new) | `context-keystore` probe: setKey→hasKey, encrypted-on-disk, no plaintext leak, config key-free, clearKey→hasKey:false. |
| `src/main/e2e/index.ts` (modify) | Import + append `settings` to `PLAYLIST`. |

---

## Task 1: `llmKeyStore.ts` — encrypted key store (Electron-free, injectable encryptor)

**Files:**
- Create: `src/main/llmKeyStore.ts`
- Test: `src/main/llmKeyStore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/llmKeyStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createKeyStore, type Encryptor } from './llmKeyStore'

// Reversible non-crypto fake: tags the plaintext so a test can prove the on-disk bytes
// are NOT the raw key, while staying decryptable. `available` toggles the Linux-no-keyring path.
function fakeEncryptor(available = true): Encryptor {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from('ENC:' + plain, 'utf8'),
    decryptString: (enc) => enc.toString('utf8').replace(/^ENC:/, '')
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keystore-test-'))
})

describe('createKeyStore', () => {
  it('round-trips a key through encrypt → persist → decrypt', () => {
    const store = createKeyStore(dir, fakeEncryptor())
    expect(store.setKey('openrouter', 'sk-secret')).toBe(true)
    expect(store.hasKey('openrouter')).toBe(true)
    expect(store.getKey('openrouter')).toBe('sk-secret')
  })

  it('never writes the raw key to disk (the file holds ciphertext, not plaintext)', () => {
    const store = createKeyStore(dir, fakeEncryptor())
    store.setKey('openai', 'PLAINTEXT-KEY')
    const raw = readFileSync(join(dir, 'llm-keys.json'), 'utf8')
    expect(raw).not.toContain('PLAINTEXT-KEY')
  })

  it('keeps keys separate per provider', () => {
    const store = createKeyStore(dir, fakeEncryptor())
    store.setKey('openrouter', 'a')
    store.setKey('anthropic', 'b')
    expect(store.getKey('openrouter')).toBe('a')
    expect(store.getKey('anthropic')).toBe('b')
    expect(store.hasKey('openai')).toBe(false)
    expect(store.getKey('openai')).toBeUndefined()
  })

  it('clearKey removes only that provider', () => {
    const store = createKeyStore(dir, fakeEncryptor())
    store.setKey('openrouter', 'a')
    store.setKey('anthropic', 'b')
    store.clearKey('openrouter')
    expect(store.hasKey('openrouter')).toBe(false)
    expect(store.getKey('anthropic')).toBe('b')
  })

  it('refuses to persist when encryption is unavailable (no plaintext fallback)', () => {
    const store = createKeyStore(dir, fakeEncryptor(false))
    expect(store.setKey('openrouter', 'x')).toBe(false)
    expect(existsSync(join(dir, 'llm-keys.json'))).toBe(false)
    expect(store.hasKey('openrouter')).toBe(false)
  })

  it('returns undefined for a corrupt store file rather than throwing', () => {
    const store = createKeyStore(dir, fakeEncryptor())
    store.setKey('openrouter', 'a')
    // Corrupt: overwrite with junk base64 that decrypts to nothing useful.
    const fs = require('fs') as typeof import('fs')
    fs.writeFileSync(join(dir, 'llm-keys.json'), '{ not json', 'utf8')
    expect(store.getKey('openrouter')).toBeUndefined()
    expect(store.hasKey('openrouter')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/z/canvas-ade-context" && pnpm vitest run src/main/llmKeyStore.test.ts`
Expected: FAIL — `createKeyStore` / `Encryptor` not exported (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/llmKeyStore.ts
/**
 * T-B2: the encrypted API-key store for the LLM brain. Keys are encrypted via an injected
 * Encryptor (the real wiring passes Electron's safeStorage from index.ts) and persisted to
 * `userData/llm-keys.json` — NEVER the project folder / .canvas/ / canvas.json. Electron-free
 * by design (the Encryptor is injected) so this unit-tests without Electron, mirroring how
 * llmConfig takes an explicit userDataDir. The key is write-only into MAIN: nothing here ever
 * returns key material across IPC (callers expose only presence via hasKey).
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import type { ProviderName } from './llmConfig'

/** Mirrors Electron safeStorage's surface so the real one drops in unchanged. */
export interface Encryptor {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface KeyStore {
  /** Decrypted key for a provider, or undefined if none stored / unreadable. */
  getKey(provider: ProviderName): string | undefined
  /** Encrypt + persist. Returns false (and writes nothing) if encryption is unavailable. */
  setKey(provider: ProviderName, key: string): boolean
  clearKey(provider: ProviderName): void
  /** Presence only — true when a non-empty entry exists for the provider. */
  hasKey(provider: ProviderName): boolean
}

type KeyFile = Partial<Record<ProviderName, string>> // provider → base64(ciphertext)

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'llm-keys.json')
}

function readFile(userDataDir: string): KeyFile {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return {}
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as KeyFile) : {}
  } catch {
    return {}
  }
}

function writeFile(userDataDir: string, data: KeyFile): void {
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(data, null, 2), 'utf8')
}

export function createKeyStore(userDataDir: string, encryptor: Encryptor): KeyStore {
  return {
    getKey(provider) {
      const enc = readFile(userDataDir)[provider]
      if (!enc) return undefined
      try {
        return encryptor.decryptString(Buffer.from(enc, 'base64'))
      } catch {
        return undefined
      }
    },
    setKey(provider, key) {
      if (!encryptor.isEncryptionAvailable()) return false
      const data = readFile(userDataDir)
      data[provider] = encryptor.encryptString(key).toString('base64')
      writeFile(userDataDir, data)
      return true
    },
    clearKey(provider) {
      const data = readFile(userDataDir)
      if (data[provider] === undefined) return
      delete data[provider]
      writeFile(userDataDir, data)
    },
    hasKey(provider) {
      const enc = readFile(userDataDir)[provider]
      return typeof enc === 'string' && enc.length > 0
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/z/canvas-ade-context" && pnpm vitest run src/main/llmKeyStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/llmKeyStore.ts src/main/llmKeyStore.test.ts
git commit -F - <<'EOF'
feat(context): T-B2 llmKeyStore — safeStorage-injectable encrypted key store

Encrypt/persist/read/clear API keys under userData/llm-keys.json behind an
injectable Encryptor (real = Electron safeStorage, tests = fake). Refuses to
persist when encryption is unavailable (no plaintext fallback). Electron-free.
EOF
```

---

## Task 2: `keyForProvider` store-first + `ProviderDeps.keyStore`

**Files:**
- Modify: `src/main/llmService.ts:105-127` (`ProviderDeps`, `keyForProvider`, `getProvider`)
- Test: `src/main/llmService.test.ts` (add a precedence `describe`)

- [ ] **Step 1: Write the failing test**

Add to `src/main/llmService.test.ts` (after the existing `keyForProvider`/`getProvider` blocks). Import `type KeyStore` from `./llmKeyStore` at the top of the file.

```ts
// at top with the other imports:
// import type { KeyStore } from './llmKeyStore'

// A getKey-only fake store for resolution tests.
const fakeStore = (keys: Partial<Record<string, string>>): Pick<KeyStore, 'getKey'> => ({
  getKey: (p) => keys[p]
})

describe('keyForProvider precedence (store-first, env fallback)', () => {
  it('prefers the key store over the env var', () => {
    expect(
      keyForProvider('openrouter', { OPENROUTER_API_KEY: 'from-env' }, fakeStore({ openrouter: 'from-store' }))
    ).toBe('from-store')
  })
  it('falls back to the env var when the store has no key', () => {
    expect(keyForProvider('openrouter', { OPENROUTER_API_KEY: 'from-env' }, fakeStore({}))).toBe('from-env')
  })
  it('returns undefined when neither store nor env has a key', () => {
    expect(keyForProvider('openrouter', {}, fakeStore({}))).toBeUndefined()
  })
  it('works with no store (env only) — T-B1 behaviour preserved', () => {
    expect(keyForProvider('openrouter', { OPENROUTER_API_KEY: 'k' })).toBe('k')
  })
  it('getProvider resolves a provider from the store alone (no env)', () => {
    const p = getProvider(
      { provider: 'openrouter', model: 'm' },
      { fetch: errFetch, env: {}, keyStore: fakeStore({ openrouter: 'sk' }) }
    )
    expect(p).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/z/canvas-ade-context" && pnpm vitest run src/main/llmService.test.ts`
Expected: FAIL — `keyForProvider` takes 2 args (TS error on the 3rd) / `ProviderDeps` has no `keyStore`.

- [ ] **Step 3: Write minimal implementation**

In `src/main/llmService.ts`, add the import and edit the three sites:

```ts
// add near the top imports:
import type { KeyStore } from './llmKeyStore'
```

```ts
// ProviderDeps — add the optional store seam:
export interface ProviderDeps {
  fetch: FetchLike
  env: Record<string, string | undefined>
  /** Store-first key source (T-B2). getKey-only so unit tests inject a tiny fake. */
  keyStore?: Pick<KeyStore, 'getKey'>
}
```

```ts
/** The configured API key for a provider: safeStorage store first, env var as dev fallback. */
export function keyForProvider(
  provider: ProviderName,
  env: Record<string, string | undefined>,
  store?: Pick<KeyStore, 'getKey'>
): string | undefined {
  return store?.getKey(provider) ?? env[KEY_ENV[provider]]
}
```

```ts
// inside getProvider, replace the key line:
  const key = keyForProvider(config.provider, deps.env, deps.keyStore)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/z/canvas-ade-context" && pnpm vitest run src/main/llmService.test.ts`
Expected: PASS — new precedence block green, all prior `getProvider`/`runSummarize` tests still green (env-only path unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/main/llmService.ts src/main/llmService.test.ts
git commit -F - <<'EOF'
feat(context): T-B2 keyForProvider store-first, env fallback

Add ProviderDeps.keyStore (getKey-only seam); resolve the key from the
safeStorage store first, env var as a dev fallback. Injectable — no Electron
in unit tests. Downstream getProvider/runSummarize unchanged.
EOF
```

---

## Task 3: Key IPC — `setKey` / `clearKey` / `setConfig` + `status.hasKey`

**Files:**
- Modify: `src/main/llmService.ts` (`LlmStatus`, `registerLlmHandlers`)
- Test: `src/main/llmService.test.ts` (extend the `registerLlmHandlers` describe)

- [ ] **Step 1: Write the failing test**

Add to the `registerLlmHandlers` describe in `src/main/llmService.test.ts`. Reuse the existing `setup()` fixture but extend it to capture handlers and accept an encryptor (use a temp dir + the same `fakeEncryptor` shape as Task 1; define a local copy here).

```ts
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Encryptor } from './llmKeyStore'

const fakeEncryptor = (available = true): Encryptor => ({
  isEncryptionAvailable: () => available,
  encryptString: (p) => Buffer.from('ENC:' + p, 'utf8'),
  decryptString: (e) => e.toString('utf8').replace(/^ENC:/, '')
})

function setupKeyed(encryptor: Encryptor) {
  const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
  const dir = mkdtempSync(join(tmpdir(), 'llm-ipc-'))
  registerLlmHandlers(
    { handle: (c: string, h: (e: unknown, a: unknown) => unknown) => void handlers.set(c, h) } as never,
    () => null,
    dir,
    undefined,
    encryptor
  )
  return {
    dir,
    call: (c: string, a?: unknown) => Promise.resolve(handlers.get(c)!({ senderFrame: null }, a)),
    callForeign: (c: string, a?: unknown) => Promise.resolve(handlers.get(c)!({ senderFrame: {} }, a))
  }
}

describe('registerLlmHandlers — key channels', () => {
  it('setKey persists and status reports hasKey:true (key never returned)', async () => {
    const f = setupKeyed(fakeEncryptor())
    const set = (await f.call('llm:setKey', { provider: 'openrouter', key: 'sk-xyz' })) as {
      ok: boolean
    }
    expect(set.ok).toBe(true)
    const s = (await f.call('llm:status')) as LlmStatus
    expect(s.hasKey).toBe(true)
    expect(Object.values(s)).not.toContain('sk-xyz')
  })

  it('clearKey removes the key (hasKey:false after)', async () => {
    const f = setupKeyed(fakeEncryptor())
    await f.call('llm:setKey', { provider: 'openrouter', key: 'sk-xyz' })
    const cleared = (await f.call('llm:clearKey', { provider: 'openrouter' })) as { ok: boolean }
    expect(cleared.ok).toBe(true)
    expect(((await f.call('llm:status')) as LlmStatus).hasKey).toBe(false)
  })

  it('setKey refuses cleanly when encryption is unavailable', async () => {
    const f = setupKeyed(fakeEncryptor(false))
    const set = (await f.call('llm:setKey', { provider: 'openrouter', key: 'x' })) as {
      ok: boolean
      reason?: string
    }
    expect(set).toEqual({ ok: false, reason: 'encryption-unavailable' })
    expect(((await f.call('llm:status')) as LlmStatus).hasKey).toBe(false)
  })

  it('setConfig persists provider/model and status reflects it', async () => {
    const f = setupKeyed(fakeEncryptor())
    await f.call('llm:setConfig', { provider: 'anthropic', model: 'claude-3-5-haiku-latest' })
    const s = (await f.call('llm:status')) as LlmStatus
    expect(s.provider).toBe('anthropic')
    expect(s.model).toBe('claude-3-5-haiku-latest')
  })

  it('all new channels reject a foreign sender', async () => {
    const f = setupKeyed(fakeEncryptor())
    expect(await f.callForeign('llm:setKey', { provider: 'openrouter', key: 'x' })).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(await f.callForeign('llm:clearKey', { provider: 'openrouter' })).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(await f.callForeign('llm:setConfig', { provider: 'openai', model: 'm' })).toEqual({
      ok: false,
      reason: 'forbidden'
    })
  })
})
```

Also update the **existing** `llm:status` handler test (the one asserting status shape) to include `hasKey: false` if it uses `toEqual`; if it uses `toMatchObject`, no change needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/z/canvas-ade-context" && pnpm vitest run src/main/llmService.test.ts`
Expected: FAIL — `registerLlmHandlers` ignores the 5th arg / no `llm:setKey` handler / `LlmStatus` has no `hasKey`.

- [ ] **Step 3: Write minimal implementation**

In `src/main/llmService.ts`:

```ts
// add the import:
import { createKeyStore, type Encryptor, type KeyStore } from './llmKeyStore'
```

```ts
// extend LlmStatus:
export interface LlmStatus {
  hasProvider: boolean
  provider: ProviderName
  model: string
  /** True when the active provider has a stored key (presence only — never the key). */
  hasKey: boolean
}
```

Replace `registerLlmHandlers` with the store-aware version (adds the encryptor param, builds the store, the 3 new channels, and `hasKey`). A no-op store is used when no encryptor is supplied (keeps the existing summarize/status tests, which pass no encryptor, green with `hasKey:false`).

```ts
const NOOP_KEY_STORE: KeyStore = {
  getKey: () => undefined,
  setKey: () => false,
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
  // Resolution uses the SAME store the IPC writes to (store-first), so a key set via
  // llm:setKey is immediately visible to llm:summarize.
  const deps: ProviderDeps = { ...(injectedDeps ?? defaultDeps()), keyStore }
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
      hasKey: keyStore.hasKey(config.provider)
    }
  })

  ipcMain.handle(
    'llm:setKey',
    (e, a: { provider: ProviderName; key: string }): { ok: boolean; reason?: string } => {
      if (guard(e)) return { ok: false, reason: 'forbidden' }
      return keyStore.setKey(a.provider, a.key)
        ? { ok: true }
        : { ok: false, reason: 'encryption-unavailable' }
    }
  )

  ipcMain.handle(
    'llm:clearKey',
    (e, a: { provider: ProviderName }): { ok: boolean; reason?: string } => {
      if (guard(e)) return { ok: false, reason: 'forbidden' }
      keyStore.clearKey(a.provider)
      return { ok: true }
    }
  )

  ipcMain.handle(
    'llm:setConfig',
    (e, a: { provider: ProviderName; model: string; baseUrl?: string }): { ok: boolean; reason?: string } => {
      if (guard(e)) return { ok: false, reason: 'forbidden' }
      writeLlmConfig(userDataDir, { provider: a.provider, model: a.model, baseUrl: a.baseUrl })
      return { ok: true }
    }
  )
}
```

Add `writeLlmConfig` to the existing `llmConfig` import in `llmService.ts`:

```ts
import { readLlmConfig, writeLlmConfig, DEFAULT_MODELS } from './llmConfig'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/z/canvas-ade-context" && pnpm vitest run src/main/llmService.test.ts`
Expected: PASS — new key-channel block green; existing handler tests green (`hasKey:false` on the no-encryptor path).

- [ ] **Step 5: Commit**

```bash
git add src/main/llmService.ts src/main/llmService.test.ts
git commit -F - <<'EOF'
feat(context): T-B2 key IPC — setKey/clearKey/setConfig + status.hasKey

New guarded channels write the key into MAIN only (never returned); status
gains hasKey (presence only). Resolution + IPC share one store so a set key is
immediately live for summarize. Foreign senders rejected on every channel.
EOF
```

---

## Task 4: Preload bridge — extend `window.api.llm`

**Files:**
- Modify: `src/preload/index.ts:65-72` (types) and `:182-187` (the `llm` bridge)

- [ ] **Step 1: Write the failing test**

Preload has no unit test harness; coverage is the e2e probe (Task 7) + `pnpm typecheck`. The verification step is the typecheck in Step 4. (No standalone test file — adding one for the contextBridge wiring would be testing the framework.)

- [ ] **Step 2: (n/a — typecheck is the gate; see Step 4)**

- [ ] **Step 3: Write the implementation**

Extend the mirrored types (`src/preload/index.ts` around line 65):

```ts
// ── M-brain T-B1/T-B2 — mirrors main SummarizeResult / LlmStatus (preload stays decoupled) ──
export type LlmSummarizeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-provider' }
  | { ok: false; reason: 'provider-error'; message: string }

export interface LlmStatus {
  hasProvider: boolean
  provider: 'openrouter' | 'openai' | 'anthropic' | 'local'
  model: string
  hasKey: boolean
}

export type LlmWriteResult = { ok: boolean; reason?: string }
```

Extend the bridge (around line 183):

```ts
  // ── M-brain T-B1/T-B2: provider-agnostic LLM (MAIN owns the key/egress) ──
  llm: {
    summarize: (input: { system?: string; text: string }): Promise<LlmSummarizeResult> =>
      ipcRenderer.invoke('llm:summarize', input),
    status: (): Promise<LlmStatus> => ipcRenderer.invoke('llm:status'),
    setKey: (args: { provider: LlmStatus['provider']; key: string }): Promise<LlmWriteResult> =>
      ipcRenderer.invoke('llm:setKey', args),
    clearKey: (args: { provider: LlmStatus['provider'] }): Promise<LlmWriteResult> =>
      ipcRenderer.invoke('llm:clearKey', args),
    setConfig: (args: {
      provider: LlmStatus['provider']
      model: string
      baseUrl?: string
    }): Promise<LlmWriteResult> => ipcRenderer.invoke('llm:setConfig', args)
  }
```

- [ ] **Step 4: Run typecheck to verify the bridge compiles + `CanvasApi` re-exports the new shape**

Run: `cd "/z/canvas-ade-context" && pnpm typecheck`
Expected: PASS (0 errors). The renderer (Task 6) now sees `window.api.llm.setKey/clearKey/setConfig/status().hasKey` via `CanvasApi`.

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts
git commit -F - <<'EOF'
feat(context): T-B2 preload — llm.setKey/clearKey/setConfig + status.hasKey

Extend the contextBridge llm bridge with the key-write channels and the hasKey
status field. Key is write-only into MAIN; the bridge never reads it back.
EOF
```

---

## Task 5: `index.ts` wiring — safeStorage adapter + temp e2e dir

**Files:**
- Modify: `src/main/index.ts:163` (registration) + add the adapter + dir computation near it.

- [ ] **Step 1: Write the failing test**

`index.ts` is the app entrypoint (not unit-tested). Verification is `pnpm build` (Step 4) + the e2e probe (Task 7). No new unit test.

- [ ] **Step 2: (n/a — build + e2e are the gate)**

- [ ] **Step 3: Write the implementation**

In `src/main/index.ts`, add to the `electron` import: `safeStorage`. Add the `Encryptor` import + the new imports for the temp dir:

```ts
import { app, BrowserWindow, ipcMain, shell, safeStorage } from 'electron'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import type { Encryptor } from './llmKeyStore'
```

Replace the `registerLlmHandlers(...)` line (currently `:163`) with:

```ts
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
  registerLlmHandlers(ipcMain, () => mainWindow, llmDataDir, undefined, llmEncryptor)
```

If `join` is not already imported in `index.ts`, add it: `import { join } from 'path'` (check the existing imports first — reuse if present). Keep the `CANVAS_LLM_PING` block reading `app.getPath('userData')` for config; it is unaffected by the key dir (no key needed to prove the no-provider path).

- [ ] **Step 4: Run build to verify it compiles**

Run: `cd "/z/canvas-ade-context" && pnpm build`
Expected: PASS — main bundle builds; no unused-import / type errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -F - <<'EOF'
feat(context): T-B2 wire safeStorage encryptor into the LLM key store

Inject an Electron safeStorage Encryptor into registerLlmHandlers. Key store
lives in userData (never a project folder); under CANVAS_SMOKE=e2e it uses a
temp dir exported as CANVAS_E2E_LLM_DIR so the probe can assert on disk.
EOF
```

---

## Task 6: Settings modal (renderer) + gear in app chrome

**Files:**
- Create: `src/renderer/src/canvas/SettingsModal.tsx`
- Test: `src/renderer/src/canvas/SettingsModal.test.tsx`
- Modify: `src/renderer/src/canvas/AppChrome.tsx` (gear `ToolBtn` in the camera cluster, mounts the modal)

- [ ] **Step 1: Write the failing test**

```tsx
// src/renderer/src/canvas/SettingsModal.test.tsx
import { it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'

const llm = {
  status: vi.fn(),
  setKey: vi.fn(),
  clearKey: vi.fn(),
  setConfig: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  llm.status.mockResolvedValue({
    hasProvider: false,
    provider: 'openrouter',
    model: 'google/gemini-2.0-flash-001',
    hasKey: false
  })
  llm.setKey.mockResolvedValue({ ok: true })
  llm.clearKey.mockResolvedValue({ ok: true })
  llm.setConfig.mockResolvedValue({ ok: true })
  ;(window as unknown as { api: { llm: typeof llm } }).api = { llm }
})

it('prefills provider + model from status on open', async () => {
  render(<SettingsModal onClose={() => {}} />)
  await waitFor(() => expect(llm.status).toHaveBeenCalled())
  const provider = screen.getByLabelText(/provider/i) as HTMLSelectElement
  const model = screen.getByLabelText(/model/i) as HTMLInputElement
  await waitFor(() => expect(provider.value).toBe('openrouter'))
  expect(model.value).toBe('google/gemini-2.0-flash-001')
})

it('masks the key input', async () => {
  render(<SettingsModal onClose={() => {}} />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  expect(key.type).toBe('password')
})

it('Save writes config and the key when a key is entered', async () => {
  const onClose = vi.fn()
  render(<SettingsModal onClose={onClose} />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  fireEvent.change(key, { target: { value: 'sk-secret' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() =>
    expect(llm.setConfig).toHaveBeenCalledWith({
      provider: 'openrouter',
      model: 'google/gemini-2.0-flash-001',
      baseUrl: undefined
    })
  )
  expect(llm.setKey).toHaveBeenCalledWith({ provider: 'openrouter', key: 'sk-secret' })
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})

it('Save does not call setKey when the key field is empty', async () => {
  render(<SettingsModal onClose={() => {}} />)
  await screen.findByLabelText(/api key/i)
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(llm.setConfig).toHaveBeenCalled())
  expect(llm.setKey).not.toHaveBeenCalled()
})

it('Clear key calls clearKey for the active provider', async () => {
  render(<SettingsModal onClose={() => {}} />)
  await screen.findByLabelText(/api key/i)
  fireEvent.click(screen.getByRole('button', { name: /clear key/i }))
  await waitFor(() => expect(llm.clearKey).toHaveBeenCalledWith({ provider: 'openrouter' }))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/z/canvas-ade-context" && pnpm vitest run src/renderer/src/canvas/SettingsModal.test.tsx`
Expected: FAIL — `SettingsModal` module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/renderer/src/canvas/SettingsModal.tsx
/**
 * T-B2: the LLM Settings modal. Choose a provider, override its model, optionally enter an
 * API key (masked, write-only into MAIN via llm.setKey — never read back). Portaled to <body>
 * over a scrim, design-token styled (calm/dense, one accent). Provider/model persist via
 * llm.setConfig; the key via llm.setKey; Clear key via llm.clearKey. No multi-key/profiles.
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_MODELS } from '../lib/llmModels'

const PROVIDERS: Array<{ id: keyof typeof DEFAULT_MODELS; label: string }> = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'local', label: 'Local' }
]

export function SettingsModal({ onClose }: { onClose: () => void }): ReactElement {
  const [provider, setProvider] = useState<keyof typeof DEFAULT_MODELS>('openrouter')
  const [model, setModel] = useState(DEFAULT_MODELS.openrouter)
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.llm.status().then((s) => {
      setProvider(s.provider)
      setModel(s.model)
      setHasKey(s.hasKey)
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const onProvider = (p: keyof typeof DEFAULT_MODELS): void => {
    setProvider(p)
    setModel(DEFAULT_MODELS[p]) // prefill the cheap/fast default; still editable
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.llm.setConfig({
        provider,
        model,
        baseUrl: provider === 'local' && baseUrl ? baseUrl : undefined
      })
      if (key.trim()) await window.api.llm.setKey({ provider, key: key.trim() })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.llm.clearKey({ provider })
      setHasKey(false)
      setKey('')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div style={styles.scrim} onPointerDown={onClose} data-test="settings-scrim">
      <div
        style={styles.card}
        role="dialog"
        aria-label="LLM settings"
        data-test="settings-modal"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div style={styles.head}>Context brain · LLM</div>

        <label style={styles.field}>
          <span style={styles.label}>Provider</span>
          <select
            aria-label="Provider"
            value={provider}
            onChange={(e) => onProvider(e.target.value as keyof typeof DEFAULT_MODELS)}
            style={styles.input}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>Model</span>
          <input
            aria-label="Model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={styles.input}
          />
        </label>

        {provider === 'local' && (
          <label style={styles.field}>
            <span style={styles.label}>Base URL</span>
            <input
              aria-label="Base URL"
              value={baseUrl}
              placeholder="http://127.0.0.1:1234/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
              style={styles.input}
            />
          </label>
        )}

        <label style={styles.field}>
          <span style={styles.label}>
            API key {hasKey && <span style={{ color: 'var(--accent)' }}>· set</span>}
          </span>
          <input
            aria-label="API key"
            type="password"
            value={key}
            placeholder={hasKey ? '•••••••• (leave blank to keep)' : 'Paste your key'}
            onChange={(e) => setKey(e.target.value)}
            style={styles.input}
          />
        </label>

        <div style={styles.row}>
          <button
            style={styles.ghost}
            disabled={busy || !hasKey}
            onClick={() => void clear()}
          >
            Clear key
          </button>
          <div style={{ flex: 1 }} />
          <button style={styles.ghost} disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primary} disabled={busy} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

const styles: Record<string, CSSProperties> = {
  scrim: {
    position: 'fixed',
    inset: 0,
    zIndex: 300,
    background: 'rgba(0,0,0,0.4)',
    display: 'grid',
    placeItems: 'center'
  },
  card: {
    width: 380,
    background: 'var(--surface-raised)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-ctl)',
    boxShadow: 'var(--shadow-pop)',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  },
  head: { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 11, color: 'var(--text-3)', fontWeight: 600 },
  input: {
    height: 30,
    padding: '0 9px',
    borderRadius: 6,
    border: '1px solid var(--border-subtle)',
    background: 'var(--inset)',
    color: 'var(--text)',
    fontSize: 12.5,
    fontFamily: 'var(--ui)'
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 },
  ghost: {
    height: 30,
    padding: '0 12px',
    borderRadius: 6,
    border: '1px solid var(--border-subtle)',
    background: 'transparent',
    color: 'var(--text-2)',
    fontSize: 12.5,
    cursor: 'pointer'
  },
  primary: {
    height: 30,
    padding: '0 14px',
    borderRadius: 6,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'pointer'
  }
}
```

Create the shared model-default source the modal imports (the renderer must not import from `src/main`). Mirror `DEFAULT_MODELS` in a renderer lib:

```ts
// src/renderer/src/lib/llmModels.ts
/** Renderer-side mirror of main's DEFAULT_MODELS (cheap/fast tier). Kept in sync by hand —
 *  the source of truth is src/main/llmConfig.ts; this avoids a renderer→main import. */
export const DEFAULT_MODELS = {
  openrouter: 'google/gemini-2.0-flash-001',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  local: 'local-model'
} as const
```

Add the gear to `AppChrome.tsx` — a `ToolBtn` that opens the modal. In `CameraCluster`, add a divider + gear before `<TidyMenu>`, and hoist a `showSettings` state to `AppChrome` so the modal mounts once:

```tsx
// AppChrome.tsx — import the modal + an 'gear' icon (add 'gear' to Icon if missing; reuse an
// existing glyph name otherwise — check Icon.tsx IconName union first).
import { SettingsModal } from './SettingsModal'

export function AppChrome({ onAdd, onTidy }: AppChromeProps): ReactElement {
  const [showSettings, setShowSettings] = useState(false)
  return (
    <>
      <ProjectSwitcher />
      <CameraCluster onTidy={onTidy} onSettings={() => setShowSettings(true)} />
      <Dock onAdd={onAdd} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  )
}
```

In `CameraCluster`, accept `onSettings` and render the gear after the overview button / `TidyMenu`:

```tsx
function CameraCluster({
  onTidy,
  onSettings
}: {
  onTidy: (preset: LayoutPreset) => void
  onSettings: () => void
}): ReactElement {
  // ...existing...
  // after <TidyMenu onTidy={onTidy} />:
  //   <span style={styles.divider} />
  //   <ToolBtn name="gear" title="Settings" onClick={onSettings} />
}
```

> Icon check: open `src/renderer/src/canvas/Icon.tsx`. If `'gear'` is not in `IconName`, add a simple gear path, or reuse an existing settings-like glyph (e.g. `'overview'` is taken — pick an unused neutral one). Pick the lowest-risk option; do not invent an icon name not in the union.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/z/canvas-ade-context" && pnpm vitest run src/renderer/src/canvas/SettingsModal.test.tsx`
Expected: PASS (5 tests).
Run: `cd "/z/canvas-ade-context" && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/SettingsModal.tsx src/renderer/src/canvas/SettingsModal.test.tsx src/renderer/src/lib/llmModels.ts src/renderer/src/canvas/AppChrome.tsx
git commit -F - <<'EOF'
feat(context): T-B2 Settings modal — provider/model/key entry from app chrome

Portaled, token-styled modal opened from a gear in the camera cluster. Provider
select + editable model + (local) baseUrl + masked key. Save writes config +
(if entered) the key; Clear key wipes it. Key is write-only into MAIN.
EOF
```

---

## Task 7: e2e probe — `context-keystore`

**Files:**
- Create: `src/main/e2e/probes/settings.ts`
- Modify: `src/main/e2e/index.ts` (import + append to `PLAYLIST`)

- [ ] **Step 1: Write the probe (the "failing test" here is the live e2e run)**

```ts
// src/main/e2e/probes/settings.ts
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { E2EProbe } from '../types'

/**
 * M-brain T-B2: the key store + status.hasKey round-trip, and the security invariant that
 * no key material lands in plaintext. Drives the real preload bridge (window.api.llm) to set
 * a sentinel key, then asserts MAIN-side (the probe runs in MAIN) that the on-disk store under
 * the temp e2e dir (CANVAS_E2E_LLM_DIR) holds CIPHERTEXT — the sentinel appears in NO file as
 * plaintext, and llm-config.json stays key-free. Then clears and confirms hasKey flips false.
 * On a host without encryption (safeStorage unavailable) setKey refuses cleanly; the probe
 * accepts that branch too (nothing is written, so the no-leak invariant still holds).
 */
const SENTINEL = 'E2E-KEY-DO-NOT-LEAK-9173'

export const settings: E2EProbe = {
  name: 'context-keystore',
  async run(ctx) {
    const setRaw = await ctx.evalIn<string>(
      `window.api.llm.setKey({ provider: 'openrouter', key: '${SENTINEL}' }).then((r) => JSON.stringify(r))`
    )
    const statusRaw = await ctx.evalIn<string>(
      'window.api.llm.status().then((s) => JSON.stringify(s))'
    )
    const set = JSON.parse(setRaw) as { ok: boolean; reason?: string }
    const status = JSON.parse(statusRaw) as { hasKey: boolean } & Record<string, unknown>

    // MAIN-side disk assertions against the temp e2e key dir.
    const dir = process.env.CANVAS_E2E_LLM_DIR
    let noLeak = true
    let configClean = true
    let encryptedPresent = false
    if (dir && existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (readFileSync(join(dir, f)).includes(SENTINEL)) noLeak = false
      }
      const keyFile = join(dir, 'llm-keys.json')
      encryptedPresent = existsSync(keyFile) && !readFileSync(keyFile, 'utf8').includes(SENTINEL)
      const cfg = join(dir, 'llm-config.json')
      configClean = !existsSync(cfg) || !readFileSync(cfg, 'utf8').includes(SENTINEL)
    }

    // Key is never returned to the renderer.
    const keyNotLeakedToRenderer = !Object.values(status).includes(SENTINEL)

    // Clear path.
    await ctx.evalIn<string>(
      "window.api.llm.clearKey({ provider: 'openrouter' }).then((r) => JSON.stringify(r))"
    )
    const afterRaw = await ctx.evalIn<string>(
      'window.api.llm.status().then((s) => JSON.stringify(s))'
    )
    const after = JSON.parse(afterRaw) as { hasKey: boolean }

    const encryptionAvailable = set.ok === true
    const happy =
      encryptionAvailable &&
      status.hasKey === true &&
      encryptedPresent &&
      after.hasKey === false
    // Refuse-persist host: setKey failed cleanly, nothing written, hasKey stayed false.
    const refused =
      !encryptionAvailable && set.reason === 'encryption-unavailable' && status.hasKey === false

    const ok = noLeak && configClean && keyNotLeakedToRenderer && (happy || refused)
    return {
      name: 'context-keystore',
      ok,
      detail: `set.ok=${set.ok} hasKey=${status.hasKey} enc=${encryptedPresent} noLeak=${noLeak} cfgClean=${configClean} noRendererLeak=${keyNotLeakedToRenderer} cleared=${after.hasKey === false}`
    }
  }
}
```

Register it in `src/main/e2e/index.ts` — extend the existing context import and append to `PLAYLIST` after `contextBrain`:

```ts
import { context, contextBrain } from './probes/context'
import { settings } from './probes/settings'
// ...
const PLAYLIST: E2EProbe[] = [
  // ...existing...
  context,
  contextBrain,
  settings // M-brain T-B2: key store hasKey round-trip + no-plaintext-leak invariant
]
```

- [ ] **Step 2: Run the e2e harness to verify the probe passes**

Run (PowerShell):
```powershell
cd "Z:\canvas-ade-context"; pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start
```
Expected: `E2E_CONTEXT-KEYSTORE {"ok":true,...}` in the output, `E2E_DONE ok:true`, exit 0. (The `browser`/`browser-gesture`/`focus-detach` trio may flake on a contended host — rerun; memory `e2e-browser-trio-flake`.)

- [ ] **Step 3: (covered by Step 2 — the probe IS the test)**

- [ ] **Step 4: Clean up the env var after the run**

PowerShell leaves `$env:CANVAS_SMOKE` set for the session; clear it before other commands:
```powershell
Remove-Item Env:CANVAS_SMOKE
```

- [ ] **Step 5: Commit**

```bash
git add src/main/e2e/probes/settings.ts src/main/e2e/index.ts
git commit -F - <<'EOF'
test(context): T-B2 e2e — key store hasKey round-trip + no-plaintext-leak

context-keystore probe sets a sentinel key via the real bridge, asserts MAIN-side
that the temp e2e store holds ciphertext (sentinel in no file, config key-free,
key never returned to the renderer), then clears and confirms hasKey flips false.
Accepts the refuse-persist branch on hosts without safeStorage.
EOF
```

---

## Task 8: Full gate + handoff doc

**Files:**
- Create: `docs/superpowers/handoffs/2026-06-03-context-b2-keystore.md`

- [ ] **Step 1: Run the full gate**

Run:
```powershell
cd "Z:\canvas-ade-context"; pnpm typecheck; pnpm lint; pnpm format:check; pnpm test; pnpm build
```
Expected: typecheck 0 errors · lint 0 errors · format clean · all unit tests green (T-B1's 640 + the new key-store/precedence/IPC/modal tests) · build OK.

If `format:check` flags files, run `pnpm format` (or the repo's prettier write script), re-run `format:check`, and amend the relevant commit.

- [ ] **Step 2: Run the e2e gate**

Run (PowerShell):
```powershell
cd "Z:\canvas-ade-context"; pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start; Remove-Item Env:CANVAS_SMOKE
```
Expected: `E2E_CONTEXT-KEYSTORE {"ok":true,...}`, `E2E_DONE ok:true`, exit 0 (browser-trio flake excepted — rerun once for a clean line).

- [ ] **Step 3: Write the handoff doc**

Create `docs/superpowers/handoffs/2026-06-03-context-b2-keystore.md` covering: what shipped (key store + IPC + modal), the files, the 6 settled decisions (esp. **the Linux-no-keyring refuse-persist caveat** — note the env-var fallback still works there), the IPC contract (`setKey`/`clearKey`/`setConfig` shapes + `status.hasKey`), the security model (key write-only into MAIN, never on disk in plaintext, never in a project folder, never returned to the renderer), test evidence (unit counts + the `E2E_CONTEXT-KEYSTORE` line), and the next-task pointer (T-B3 budget guard + egress ADR — and the flagged follow-up: split the IPC layer out of `llmService.ts` into `llmIpc.ts` when T-B3 lands).

- [ ] **Step 4: Commit the handoff**

```bash
git add docs/superpowers/handoffs/2026-06-03-context-b2-keystore.md
git commit -m "docs(context): T-B2 handoff — safeStorage key store + Settings UX"
```

- [ ] **Step 5: Squash-merge + update tracking (controller, after review)**

```bash
git checkout feat/context
git merge --squash feat/context-b2-keystore
git commit -F - <<'EOF'
feat(context): M-brain T-B2 — safeStorage key store + Settings key-entry UX

Encrypted API key in userData (safeStorage, refuse-persist on no-keyring), key
IPC (setKey/clearKey/setConfig + status.hasKey), Settings modal. Key write-only
into MAIN, never to the project folder, never returned to the renderer.
EOF
```
Then: update `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (mark the row done) and the `context-subsystem` memory (T-B2 done; T-B3 next).

---

## Self-review

- **Spec coverage:** key store (T1) · safeStorage wiring + refuse-persist (T1+T5) · store-first/env-fallback resolver, injectable (T2) · setKey/clearKey/setConfig + hasKey, foreign-sender guarded, key write-only (T3) · preload bridge (T4) · Settings modal from chrome, tokens, no profiles (T6) · e2e set→hasKey + no-plaintext-leak + config-key-free + temp userData + mock still resolves (T7) · gate + handoff + caveat (T8). All 6 kickoff design notes settled in the header.
- **Type consistency:** `Encryptor`/`KeyStore`/`createKeyStore` (T1) used verbatim in T2/T3/T5; `keyForProvider(provider, env, store?)` signature consistent T2↔T3; `LlmStatus.hasKey` added in T3, mirrored in preload T4, read in modal T6 + probe T7; channel names `llm:setKey`/`llm:clearKey`/`llm:setConfig` identical across T3/T4/T6/T7; `CANVAS_E2E_LLM_DIR` set in T5, read in T7; `DEFAULT_MODELS` renderer mirror (T6) matches main `llmConfig.ts`.
- **Placeholder scan:** none — every code/test step is concrete. The one judgement call (gear icon name) is flagged with an explicit fallback in T6.
