/**
 * External MCP servers — IPC (feature: add external MCP servers, Phase 2).
 *
 * Six frame-guarded handlers backing `window.api.mcpServers`. The renderer only ever receives MASKED
 * rows (secret VALUES omitted) and never sends ciphertext — it submits the values the user typed
 * ('' means "keep the stored secret"). Any registry mutation fires {@link onRegistryChanged} so the
 * on-disk CLI configs reconcile immediately (a disabled/removed server's decrypted secret leaves
 * disk at once).
 *
 * 🔒 MAIN-only. Untrusted input is coerced/validated at this boundary before it reaches the store;
 * secret values are never logged and never returned to the renderer.
 */
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { isForeignSender } from '../ipcGuard'
import { detectExternalClis } from '../cliProvisioners/external'
import { onRegistryChanged } from './externalSync'
import type { probeExternalServer } from './mcpClientProbe'
import type { McpServersStore } from './mcpServersStore'
import type {
  CliId,
  ExternalMcpTestResult,
  MaskedServer,
  SaveResult,
  SaveSecret,
  SaveServerInput
} from './types'

const CLI_SET: readonly CliId[] = ['claude', 'codex', 'gemini', 'opencode']

/** Coerce untrusted `[{name,value,origName?}]` — drop anything not a `{string,string}` pair. */
function asSecrets(v: unknown): SaveSecret[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: SaveSecret[] = []
  for (const e of v) {
    if (e && typeof e === 'object') {
      const r = e as Record<string, unknown>
      if (typeof r.name === 'string' && typeof r.value === 'string') {
        out.push({
          name: r.name,
          value: r.value,
          ...(typeof r.origName === 'string' ? { origName: r.origName } : {})
        })
      }
    }
  }
  return out
}

/** Coerce the untrusted save payload to a well-typed input, or null when unusable. */
function coerceSave(raw: unknown): SaveServerInput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string') return null
  if (r.transport !== 'http' && r.transport !== 'stdio') return null
  return {
    id: typeof r.id === 'string' ? r.id : undefined,
    name: r.name,
    enabled: r.enabled !== false, // default enabled
    transport: r.transport,
    url: typeof r.url === 'string' ? r.url : undefined,
    headers: asSecrets(r.headers),
    command: typeof r.command === 'string' ? r.command : undefined,
    args: Array.isArray(r.args)
      ? r.args.filter((a): a is string => typeof a === 'string')
      : undefined,
    env: asSecrets(r.env),
    targets: Array.isArray(r.targets)
      ? r.targets.filter((t): t is CliId => CLI_SET.includes(t as CliId))
      : []
  }
}

export interface McpServersIpcDeps {
  store: McpServersStore
  probe: typeof probeExternalServer
  /** Wall clock for the recorded `lastTest.at` (injected so it stays testable). */
  now?: () => number
}

/**
 * Register the external-MCP-servers IPC. `getWin` is the foreign-sender guard's trusted window.
 * Mutating handlers fire `onRegistryChanged(store)` (fire-and-forget) so on-disk configs reconcile.
 */
export function registerMcpServersHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: McpServersIpcDeps
): void {
  const { store, probe } = deps
  const now = deps.now ?? Date.now
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)
  const reconcile = (): void => {
    try {
      onRegistryChanged(store)
    } catch {
      /* best-effort — a config-write failure must never fail the IPC (the registry is already saved) */
    }
  }

  ipcMain.handle('mcp-servers:list', (e): MaskedServer[] => {
    if (guard(e)) return []
    return store.listMasked()
  })

  ipcMain.handle('mcp-servers:save', (e, raw: unknown): SaveResult => {
    if (guard(e)) return { ok: false, reason: 'validation' }
    const input = coerceSave(raw)
    if (!input) return { ok: false, reason: 'validation' }
    const result = store.upsert(input)
    if (result.ok) reconcile()
    return result
  })

  ipcMain.handle('mcp-servers:remove', (e, id: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    if (typeof id !== 'string') return { ok: false }
    store.remove(id)
    reconcile()
    return { ok: true }
  })

  ipcMain.handle('mcp-servers:setEnabled', (e, id: unknown, on: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    if (typeof id !== 'string' || typeof on !== 'boolean') return { ok: false }
    store.setEnabled(id, on)
    reconcile()
    return { ok: true }
  })

  ipcMain.handle('mcp-servers:test', async (e, id: unknown): Promise<ExternalMcpTestResult> => {
    if (guard(e)) return { ok: false, at: now(), detail: 'forbidden' }
    if (typeof id !== 'string') return { ok: false, at: now(), detail: 'unknown server' }
    const resolved = store.getResolved(id)
    if (!resolved) return { ok: false, at: now(), detail: 'unknown server' }
    const r = await probe(resolved)
    const result: ExternalMcpTestResult = {
      ok: r.ok,
      at: now(),
      detail: r.detail,
      toolCount: r.toolCount
    }
    store.recordTest(id, result)
    return result
  })

  ipcMain.handle('mcp-servers:detectClis', async (e): Promise<Record<CliId, boolean>> => {
    if (guard(e)) {
      return { claude: false, codex: false, gemini: false, opencode: false }
    }
    return detectExternalClis()
  })
}
