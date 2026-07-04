import { ipcRenderer } from 'electron'

/**
 * The preload `mcpServers` namespace — register/manage the user's OWN external MCP servers (feature:
 * add external MCP servers) — factored out of preload/index.ts to stay under the max-lines ratchet
 * (the recapApi.ts / terminalApi.ts precedent). Every invoke handler is `isForeignSender`
 * frame-guarded in MAIN.
 *
 * Shapes MIRROR src/main/mcpServers/types.ts across the process boundary (tsconfig.preload ⊥
 * tsconfig.node → no shared import; keep them in lockstep). 🔒 secret VALUES never cross: the
 * renderer sees masked names + presence; on save it sends the values the user typed ('' = keep the
 * stored secret).
 */
export type McpCliId = 'claude' | 'codex' | 'gemini' | 'opencode'
export type McpTransport = 'http' | 'stdio'

export interface McpMaskedSecret {
  name: string
  hasValue: boolean
}
export interface McpTestResult {
  ok: boolean
  at: number
  detail?: string
  toolCount?: number
}
export interface MaskedMcpServer {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  url?: string
  command?: string
  args?: string[]
  headers?: McpMaskedSecret[]
  env?: McpMaskedSecret[]
  targets: McpCliId[]
  lastTest?: McpTestResult
}
/** A submitted secret. `value: ''` = keep the stored one; `origName` = the row's original name, so a
 *  blank-value KEEP survives a rename (matching by current name alone would drop the token). */
export interface McpSaveSecret {
  name: string
  value: string
  origName?: string
}
export interface McpServerSaveInput {
  id?: string
  name: string
  enabled: boolean
  transport: McpTransport
  url?: string
  headers?: McpSaveSecret[]
  command?: string
  args?: string[]
  env?: McpSaveSecret[]
  targets: McpCliId[]
}
export type McpSaveResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'validation' | 'encryption-unavailable'; detail?: string }

export const mcpServersApi = {
  list: (): Promise<MaskedMcpServer[]> => ipcRenderer.invoke('mcp-servers:list'),
  save: (input: McpServerSaveInput): Promise<McpSaveResult> =>
    ipcRenderer.invoke('mcp-servers:save', input),
  remove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('mcp-servers:remove', id),
  setEnabled: (id: string, on: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('mcp-servers:setEnabled', id, on),
  test: (id: string): Promise<McpTestResult> => ipcRenderer.invoke('mcp-servers:test', id),
  detectClis: (): Promise<Record<McpCliId, boolean>> => ipcRenderer.invoke('mcp-servers:detectClis')
}
