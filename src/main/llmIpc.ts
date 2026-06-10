/**
 * T-B1/T-B2 IPC layer for the LLM brain, split out of llmService.ts (T-B3) so the service
 * stays the pure provider engine. Owns the frame guard, the renderer-facing status/write
 * shapes, the safeStorage key-store wiring, and (T-B3) the per-day budget-store wiring.
 * Every channel rejects foreign senders; the API key crosses IPC inbound-only and is never
 * returned; no key/secret is logged or surfaced.
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import type { ProviderName, LlmConfig } from './llmConfig'
import { readLlmConfig, writeLlmConfig, DEFAULT_MODELS, isLoopbackBaseUrl } from './llmConfig'
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

/** Status surfaced to the renderer — provider/model + key presence, never key material. */
export interface LlmStatus {
  hasProvider: boolean
  provider: ProviderName
  model: string
  /** Base URL for the `local` provider, echoed so Settings can round-trip it. Undefined otherwise. */
  baseUrl?: string
  /** True when the active provider has a stored key (presence only — never the key). */
  hasKey: boolean
  /**
   * T-F6: whether the OS can encrypt a key at all (Electron safeStorage). False on a Linux host
   * with no available keyring → a key can't be stored encrypted (Settings proactively warns).
   * False also when no encryptor was wired (mis-wire / tests). Presence only — never key material.
   */
  encryptionAvailable: boolean
}

/** Result of a write-only LLM IPC call (setKey/clearKey/setConfig). Never carries key material. */
export type LlmWriteResult = { ok: boolean; reason?: string }

/**
 * BUG-012: the known ProviderName set, derived from DEFAULT_MODELS (a typed Record<ProviderName,…>)
 * so it can't drift from the union. TypeScript's ProviderName is erased at runtime, so without this
 * a renderer could write an arbitrary `provider` key (e.g. '__proto__') into the key file.
 */
const VALID_PROVIDERS = new Set<string>(Object.keys(DEFAULT_MODELS))

/**
 * BUG-012: upper bound for an API key written over IPC. Real provider keys are well under this; a
 * larger string is a mistake/abuse and would otherwise be encrypted + synchronously written to
 * disk in MAIN (event-loop stall / DoS surface). Empty keys are rejected separately (an empty key
 * still encrypts to a non-empty ciphertext → hasKey would falsely report true).
 */
const MAX_KEY_LEN = 1024

/**
 * BUG-040: upper bound for a model string written over IPC. Real model IDs are well under this
 * (longest known: ~64 chars); an unbounded string would be synchronously written to disk in MAIN
 * (event-loop stall / DoS surface). 256 chars covers all real provider model IDs with headroom.
 */
const MAX_MODEL_LEN = 256

/**
 * BUG-036: upper bound for a baseUrl string written over IPC. A valid loopback URL is at most a
 * few hundred chars; a multi-MB path passes the hostname-only isLoopbackBaseUrl check and would
 * be synchronously written to disk + echoed on every llm:status (event-loop stall / DoS surface).
 */
const MAX_BASE_URL_LEN = 2048

/**
 * BUG-036: bounds for a maxCallsPerDay value written over IPC. Must be a finite non-negative
 * integer; an upper bound of 1e6 is orders of magnitude above any realistic daily cap and
 * guards against a huge value wrapping the persisted-counter comparison in llmBudget.
 */
const MAX_CALLS_PER_DAY_CAP = 1_000_000

/**
 * BUG-037: upper bound for the summarize text/system string length. A megabyte of content is
 * far beyond any real summarize payload; a larger string is synchronously JSON.stringify'd in
 * MAIN and sent to the provider at API cost.
 */
const MAX_SUMMARIZE_TEXT_LEN = 100_000

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
  // BUG-013: HONOR an injected budget — only build a fresh store when none was injected, so a
  // caller/test that injects a budget (for isolation) is not silently ignored. Computed once into
  // a named local rather than relying on the spread-then-override order being correct.
  const budget = injectedDeps?.budget ?? createBudgetStore(userDataDir, () => new Date())
  // Resolution uses the SAME store the IPC writes to (store-first) and the SAME budget the
  // engine reserves against, so a key/cap set over IPC is immediately live for summarize.
  // NOTE: `injectedDeps.keyStore` is INTENTIONALLY ignored — the keyStore is always built from
  // `encryptor` so the llm:setKey/clearKey/status write channels and the summarize resolution
  // share one store (a per-injection store would let the IPC writes and reads drift apart).
  const deps: ProviderDeps = {
    ...(injectedDeps ?? defaultDeps()),
    keyStore,
    budget
  }
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('llm:summarize', async (e, input: SummarizeInput): Promise<SummarizeResult> => {
    if (guard(e)) return { ok: false, reason: 'provider-error', message: 'forbidden sender' }
    // BUG-011: the IPC arg is `unknown` at runtime — a caller sending `{}` / `{ system: 'x' }`
    // (no `text`) would push `content: undefined` into the provider body (JSON.stringify drops it
    // → malformed request the provider rejects with a 400, AND a budget slot is consumed first).
    // Reject cleanly here, before any provider/budget work, so no future renderer caller can leak
    // a null-content request or waste the daily cap.
    if (typeof input?.text !== 'string' || input.text.length === 0)
      return { ok: false, reason: 'provider-error', message: 'invalid input: text is required' }
    // BUG-037: system must be undefined or a non-empty string — a truthy non-string (object, number)
    // builds a malformed provider body the provider rejects with 400 AFTER a budget slot is
    // irrevocably consumed. Also cap both fields: a giant string is JSON.stringify'd synchronously
    // in MAIN and egressed at API cost.
    if (
      input.system !== undefined &&
      (typeof input.system !== 'string' || input.system.length === 0)
    )
      return {
        ok: false,
        reason: 'provider-error',
        message: 'invalid input: system must be a non-empty string'
      }
    if (input.text.length > MAX_SUMMARIZE_TEXT_LEN)
      return { ok: false, reason: 'provider-error', message: 'invalid input: text too long' }
    if (typeof input.system === 'string' && input.system.length > MAX_SUMMARIZE_TEXT_LEN)
      return { ok: false, reason: 'provider-error', message: 'invalid input: system too long' }
    const config = readLlmConfig(userDataDir)
    return runSummarize(config, input, deps)
  })

  // T-F6: a key can only be stored when the OS keyring is available. No encryptor wired → false.
  const encryptionAvailable = (): boolean => (encryptor ? encryptor.isEncryptionAvailable() : false)

  ipcMain.handle('llm:status', (e): LlmStatus => {
    if (guard(e))
      return {
        hasProvider: false,
        provider: 'openrouter',
        model: DEFAULT_MODELS.openrouter,
        hasKey: false,
        encryptionAvailable: false
      }
    const config = readLlmConfig(userDataDir)
    return {
      hasProvider: getProvider(config, deps) !== null,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      hasKey: keyStore.hasKey(config.provider),
      encryptionAvailable: encryptionAvailable()
    }
  })

  ipcMain.handle('llm:setKey', (e, a: { provider: ProviderName; key: string }): LlmWriteResult => {
    if (guard(e)) return { ok: false, reason: 'forbidden' }
    // BUG-012: validate the IPC args before the key store / encryptor. `provider`/`key` are
    // `unknown` at runtime — an unknown provider would pollute the key file (e.g. '__proto__'),
    // an empty key would falsely report hasKey:true, and an unbounded key would be encrypted +
    // written synchronously (event-loop stall). Reject all three cleanly here.
    if (!VALID_PROVIDERS.has(a?.provider as string))
      return { ok: false, reason: 'invalid-provider' }
    if (typeof a.key !== 'string' || a.key.length === 0 || a.key.length > MAX_KEY_LEN)
      return { ok: false, reason: 'invalid-key' }
    return keyStore.setKey(a.provider, a.key)
      ? { ok: true }
      : { ok: false, reason: 'encryption-unavailable' }
  })

  ipcMain.handle('llm:clearKey', (e, a: { provider: ProviderName }): LlmWriteResult => {
    if (guard(e)) return { ok: false, reason: 'forbidden' }
    // BUG-027 + BUG-039: validate `a` and `a.provider` before touching the keyStore.
    // Without this guard, a null/missing arg throws TypeError (BUG-027), and an unknown provider
    // such as '__proto__' would reach keyStore.clearKey() causing spurious I/O (BUG-039).
    // Mirrors the VALID_PROVIDERS guard already present on llm:setKey (BUG-012).
    if (!VALID_PROVIDERS.has(a?.provider as string))
      return { ok: false, reason: 'invalid-provider' }
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
      // BUG-028: guard against null/missing arg before any property access. Without this, a null
      // arg throws TypeError at the a.baseUrl access below instead of returning a typed error.
      if (!a || typeof a !== 'object') return { ok: false, reason: 'invalid-args' }
      // BUG-040: validate provider against the known set BEFORE persisting. Without this, an
      // unknown provider such as '__proto__' would be written to the config file. readLlmConfig
      // repairs it on read, but the dirty write still occurs. Mirrors the BUG-012 guard on setKey.
      if (!VALID_PROVIDERS.has(a.provider as string))
        return { ok: false, reason: 'invalid-provider' }
      // BUG-040: cap model string length — an unbounded model string would reach writeFileAtomic.sync
      // synchronously in MAIN (event-loop stall / DoS surface), mirroring MAX_KEY_LEN on setKey.
      if (typeof a.model !== 'string' || a.model.length === 0 || a.model.length > MAX_MODEL_LEN)
        return { ok: false, reason: 'invalid-model' }
      // BUG-036: cap baseUrl length before the loopback check — a multi-MB path passes the
      // hostname-only isLoopbackBaseUrl check and would be synchronously written to disk in MAIN.
      if (
        a.baseUrl !== undefined &&
        typeof a.baseUrl === 'string' &&
        a.baseUrl.length > MAX_BASE_URL_LEN
      )
        return { ok: false, reason: 'invalid-baseUrl' }
      // BUG-001 (SSRF): reject a non-loopback baseUrl BEFORE it is persisted, so a renderer
      // caller can't point LLM egress at file://, IMDS (169.254.169.254), or internal hosts.
      // An empty/omitted baseUrl is fine (non-local providers ignore it).
      if (a.baseUrl !== undefined && !isLoopbackBaseUrl(a.baseUrl))
        return { ok: false, reason: 'invalid-baseUrl' }
      // BUG-036: validate maxCallsPerDay when present — a non-integer/negative/huge value would be
      // persisted verbatim; readLlmConfig then repairs it to undefined, silently destroying a
      // previously-configured cap and reverting to the 200 default. A non-number truthy value
      // (string, object) also reaches writeFileAtomic.sync synchronously in MAIN (DoS surface).
      if (a.maxCallsPerDay !== undefined) {
        if (
          typeof a.maxCallsPerDay !== 'number' ||
          !Number.isInteger(a.maxCallsPerDay) ||
          a.maxCallsPerDay < 0 ||
          a.maxCallsPerDay > MAX_CALLS_PER_DAY_CAP
        )
          return { ok: false, reason: 'invalid-maxCallsPerDay' }
      }
      // Preserve an already-configured cap when the caller omits it (the Settings modal does):
      // otherwise every Save silently wipes maxCallsPerDay back to the 200 default (F-B).
      // BUG-040: same preserve-when-omitted rule for baseUrl — the Settings modal sends
      // `baseUrl: undefined` for non-local providers, so writing `a.baseUrl` unconditionally
      // wiped the stored local baseUrl on every non-local Save (local → openrouter → local
      // left the local provider permanently unconfigured). baseUrl is local-only (llmConfig),
      // so preserving it across non-local saves is loss-free.
      const existing = readLlmConfig(userDataDir)
      const cfg: LlmConfig = {
        provider: a.provider,
        model: a.model,
        baseUrl: a.baseUrl ?? existing.baseUrl,
        maxCallsPerDay: a.maxCallsPerDay ?? existing.maxCallsPerDay
      }
      writeLlmConfig(userDataDir, cfg)
      return { ok: true }
    }
  )
}
