/**
 * OpenCode provisioner → `<project>/opencode.json` (project-scoped, highest precedence).
 *
 * OpenCode keys MCP servers under a top-level `mcp` map; a remote server is `{ type:'remote', url,
 * enabled:true, headers }`. We set an inline `Authorization` bearer header. Merged (preserving the
 * user's other servers + keys) and stamped with the `$schema` OpenCode expects; written 0o600.
 * Detection = the OpenCode config dir (`~/.config/opencode`), since `opencode.json` is per-project.
 *
 * Ref (verified 2026-06-19): https://opencode.ai/docs/mcp-servers/
 */
import { join } from 'node:path'
import type { TerminalToken } from '../orchestration/seam'
import {
  type AppCliProvisioner,
  SERVER_NAME,
  bearer,
  dirExists,
  existingServersMap,
  isRecord,
  mcpUrl,
  opencodeHome,
  readJsonConfig,
  removeFileQuiet,
  writeJsonConfig
} from './shared'

const OPENCODE_SCHEMA = 'https://opencode.ai/config.json'

interface OpencodeConfig {
  $schema?: string
  mcp?: Record<string, unknown>
  [k: string]: unknown
}

function configPath(projectDir: string): string {
  return join(projectDir, 'opencode.json')
}

/** OpenCode's `mcp` entry for a remote (HTTP) server with bearer auth. */
function opencodeEntry(port: number, token: string): Record<string, unknown> {
  return {
    type: 'remote',
    url: mcpUrl(port),
    enabled: true,
    headers: { Authorization: bearer(token) }
  }
}

function writeSync(projectDir: string, tok: TerminalToken): string {
  const file = configPath(projectDir)
  const cfg = readJsonConfig<OpencodeConfig>(file) ?? {}
  if (!cfg.$schema) cfg.$schema = OPENCODE_SCHEMA
  cfg.mcp = {
    ...existingServersMap(cfg, 'mcp'),
    [SERVER_NAME]: opencodeEntry(tok.port, tok.token)
  }
  writeJsonConfig(file, cfg)
  return 'opencode.json'
}

function removeSync(projectDir: string): void {
  const file = configPath(projectDir)
  const cfg = readJsonConfig<OpencodeConfig>(file)
  if (!isRecord(cfg?.mcp) || !(SERVER_NAME in cfg.mcp)) return
  delete cfg.mcp[SERVER_NAME]
  const onlyOurs =
    Object.keys(cfg.mcp).length === 0 &&
    Object.keys(cfg).every((k) => k === 'mcp' || k === '$schema')
  if (onlyOurs) removeFileQuiet(file)
  else writeJsonConfig(file, cfg)
}

export const opencodeProvisioner: AppCliProvisioner = {
  id: 'opencode',
  label: 'OpenCode',
  configLabel: () => 'opencode.json',
  detect: () => dirExists(opencodeHome()),
  writeSync,
  removeSync,
  sync: async (projectDir, tok) => void writeSync(projectDir, tok),
  unsync: async (projectDir) => void removeSync(projectDir)
}
