/**
 * Gemini CLI provisioner → `~/.gemini/settings.json` (global, home-scoped).
 *
 * Gemini selects the transport by KEY: `httpUrl` ⇒ Streamable HTTP (our transport), `url` ⇒ SSE,
 * `command` ⇒ stdio. We set `httpUrl` + an inline `Authorization` bearer header. Merged into the
 * existing `mcpServers` map (preserving the user's other servers + settings); written 0o600.
 *
 * Ref (verified 2026-06-19): https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
 */
import { join } from 'node:path'
import type { TerminalToken } from '../orchestration/seam'
import {
  type AppCliProvisioner,
  type McpServersConfig,
  SERVER_NAME,
  bearer,
  dirExists,
  geminiHome,
  mcpUrl,
  readJsonConfig,
  tildeify,
  writeJsonConfig
} from './shared'

function settingsPath(): string {
  return join(geminiHome(), 'settings.json')
}

/** Gemini's `mcpServers` entry for a Streamable-HTTP server with bearer auth. */
function geminiEntry(port: number, token: string): Record<string, unknown> {
  return { httpUrl: mcpUrl(port), headers: { Authorization: bearer(token) } }
}

function writeSync(_projectDir: string, tok: TerminalToken): string {
  const file = settingsPath()
  const cfg = readJsonConfig<McpServersConfig>(file) ?? {}
  cfg.mcpServers = { ...cfg.mcpServers, [SERVER_NAME]: geminiEntry(tok.port, tok.token) }
  writeJsonConfig(file, cfg)
  return tildeify(file)
}

function removeSync(_projectDir: string): void {
  const file = settingsPath()
  const cfg = readJsonConfig<McpServersConfig>(file)
  if (cfg?.mcpServers && SERVER_NAME in cfg.mcpServers) {
    delete cfg.mcpServers[SERVER_NAME]
    writeJsonConfig(file, cfg)
  }
}

export const geminiProvisioner: AppCliProvisioner = {
  id: 'gemini',
  label: 'Gemini CLI',
  configLabel: () => tildeify(settingsPath()),
  detect: () => dirExists(geminiHome()),
  writeSync,
  removeSync,
  sync: async (projectDir, tok) => void writeSync(projectDir, tok),
  unsync: async (projectDir) => void removeSync(projectDir)
}
