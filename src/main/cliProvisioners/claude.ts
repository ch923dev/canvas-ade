/**
 * Claude Code provisioner. Two project-scoped files (PLAN §3 · REPORT §2.2):
 *   - `<project>/.mcp.json` — the loopback streamable-HTTP server entry + bearer (the canonical
 *     project MCP config; also what the spawn-time hook lays so a real `claude` finds it).
 *   - `<project>/.claude/settings.local.json` — `enabledMcpjsonServers: ["canvas-ade"]` bypasses
 *     Claude Code's per-project server trust prompt (the proven zero-prompt path).
 *
 * Both are MERGED (we only ever touch our own keys) and written 0o600. Detection = `~/.claude`.
 */
import { join } from 'node:path'
import type { TerminalToken } from '../orchestration/seam'
import {
  type AppCliProvisioner,
  type McpServersConfig,
  SERVER_NAME,
  claudeHome,
  dirExists,
  existingServersMap,
  isRecord,
  mcpEntry,
  readJsonConfig,
  removeFileQuiet,
  writeJsonConfig
} from './shared'

interface SettingsLocal {
  enabledMcpjsonServers?: string[]
  [k: string]: unknown
}

function mcpJsonPath(projectDir: string): string {
  return join(projectDir, '.mcp.json')
}
function settingsLocalPath(projectDir: string): string {
  return join(projectDir, '.claude', 'settings.local.json')
}

function writeSync(projectDir: string, tok: TerminalToken): string {
  // 1) .mcp.json — set ONLY our server entry, preserve any others the user has. Capture the
  //    pre-write state so a failure below can be rolled back cleanly (see BUG-020).
  const mcpFile = mcpJsonPath(projectDir)
  const originalMcp = readJsonConfig<McpServersConfig>(mcpFile)
  const mcp: McpServersConfig = originalMcp ? { ...originalMcp } : {}
  mcp.mcpServers = {
    ...existingServersMap(mcp, 'mcpServers'),
    [SERVER_NAME]: mcpEntry(tok.port, tok.token)
  }
  writeJsonConfig(mcpFile, mcp)

  // 2) .claude/settings.local.json — ensure our server id is in enabledMcpjsonServers (deduped),
  //    preserving any existing entries (e.g. the recap SessionStart hook lives here too).
  //
  //    BUG-020: if THIS write throws, .mcp.json (already on disk, holding a live bearer token) would
  //    otherwise be left behind untracked — the caller reports the whole sync as an error and never
  //    records the target dir for revoke, so nothing ever cleans it up. Roll .mcp.json back to
  //    exactly its pre-write state (or delete it if it didn't exist before) before re-throwing, so a
  //    partial failure never orphans a token-bearing file.
  try {
    const setFile = settingsLocalPath(projectDir)
    const settings = readJsonConfig<SettingsLocal>(setFile) ?? {}
    const enabled = new Set(settings.enabledMcpjsonServers ?? [])
    enabled.add(SERVER_NAME)
    settings.enabledMcpjsonServers = [...enabled]
    writeJsonConfig(setFile, settings)
  } catch (err) {
    if (originalMcp) writeJsonConfig(mcpFile, originalMcp)
    else removeFileQuiet(mcpFile)
    throw err
  }

  return '.mcp.json + .claude/settings.local.json'
}

function removeSync(projectDir: string): void {
  const mcpFile = mcpJsonPath(projectDir)
  const mcp = readJsonConfig<McpServersConfig>(mcpFile)
  if (isRecord(mcp?.mcpServers) && SERVER_NAME in mcp.mcpServers) {
    delete mcp.mcpServers[SERVER_NAME]
    if (Object.keys(mcp.mcpServers).length === 0 && Object.keys(mcp).length === 1) {
      // The file held only our entry → remove it rather than leave an empty stub.
      removeFileQuiet(mcpFile)
    } else {
      writeJsonConfig(mcpFile, mcp)
    }
  }

  const setFile = settingsLocalPath(projectDir)
  const settings = readJsonConfig<SettingsLocal>(setFile)
  if (settings?.enabledMcpjsonServers?.includes(SERVER_NAME)) {
    settings.enabledMcpjsonServers = settings.enabledMcpjsonServers.filter((s) => s !== SERVER_NAME)
    if (settings.enabledMcpjsonServers.length === 0) delete settings.enabledMcpjsonServers
    writeJsonConfig(setFile, settings)
  }
}

export const claudeProvisioner: AppCliProvisioner = {
  id: 'claude',
  label: 'Claude Code',
  configLabel: () => '.mcp.json + settings.local',
  detect: () => dirExists(claudeHome()),
  writeSync,
  removeSync,
  sync: async (projectDir, tok) => void writeSync(projectDir, tok),
  unsync: async (projectDir) => void removeSync(projectDir)
}
