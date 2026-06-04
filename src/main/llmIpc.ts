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
  /**
   * T-F6: whether the OS can encrypt a key at all (Electron safeStorage). False on a Linux host
   * with no available keyring → a key can't be stored encrypted (Settings proactively warns).
   * False also when no encryptor was wired (mis-wire / tests). Presence only — never key material.
   */
  encryptionAvailable: boolean
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
      // Preserve an already-configured cap when the caller omits it (the Settings modal does):
      // otherwise every Save silently wipes maxCallsPerDay back to the 200 default (F-B).
      const existing = readLlmConfig(userDataDir)
      const cfg: LlmConfig = {
        provider: a.provider,
        model: a.model,
        baseUrl: a.baseUrl,
        maxCallsPerDay: a.maxCallsPerDay ?? existing.maxCallsPerDay
      }
      writeLlmConfig(userDataDir, cfg)
      return { ok: true }
    }
  )
}
