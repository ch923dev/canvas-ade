/**
 * Codex CLI provisioner → `~/.codex/config.toml` (global, home-scoped).
 *
 * PLAN §7 flagged Codex as "verify transport" (historically stdio-first). VERIFIED 2026-06-19
 * (https://developers.openai.com/codex/mcp): recent Codex (≥0.121.0) supports a STABLE streamable-
 * HTTP transport — `[mcp_servers.<name>]` with `url` + `http_headers` (STATIC header pairs), so we
 * can ship an INLINE bearer (`http_headers = { Authorization = "Bearer …" }`), no env-var indirection
 * and no experimental flag. Older Codex without streamable-HTTP simply ignores the server.
 *
 * config.toml holds the user's entire Codex setup, so we never parse/rewrite the whole file — we
 * surgically upsert ONLY our `[mcp_servers.canvas-ade]` table (replace-or-append), leaving every
 * other table, comment, and byte intact (see {@link ./shared} `upsertCodexTable`). Written 0o600.
 */
import { join } from 'node:path'
import type { TerminalToken } from '../orchestration/seam'
import {
  type AppCliProvisioner,
  codexHome,
  dirExists,
  readTextConfig,
  removeCodexTable,
  removeFileQuiet,
  tildeify,
  upsertCodexTable,
  writeTextConfig
} from './shared'

function configPath(): string {
  return join(codexHome(), 'config.toml')
}

function writeSync(_projectDir: string, tok: TerminalToken): string {
  const file = configPath()
  const next = upsertCodexTable(readTextConfig(file), tok.port, tok.token)
  writeTextConfig(file, next)
  return tildeify(file)
}

function removeSync(_projectDir: string): void {
  const file = configPath()
  const existing = readTextConfig(file)
  if (existing === undefined) return
  const next = removeCodexTable(existing)
  if (next.trim() === '') removeFileQuiet(file)
  else if (next !== existing) writeTextConfig(file, next)
}

export const codexProvisioner: AppCliProvisioner = {
  id: 'codex',
  label: 'Codex CLI',
  configLabel: () => tildeify(configPath()),
  detect: () => dirExists(codexHome()),
  writeSync,
  removeSync,
  sync: async (projectDir, tok) => void writeSync(projectDir, tok),
  unsync: async (projectDir) => void removeSync(projectDir)
}
