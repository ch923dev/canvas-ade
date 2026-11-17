/**
 * Claude Code provisioner. Two project-scoped files (PLAN §3 · REPORT §2.2):
 *   - `<project>/.mcp.json` — the loopback streamable-HTTP server entry + bearer (the canonical
 *     project MCP config; also what the spawn-time hook lays so a real `claude` finds it).
 *   - `<project>/.claude/settings.local.json` — `enabledMcpjsonServers: ["canvas-ade"]` bypasses
 *     Claude Code's per-project server trust prompt (the proven zero-prompt path).
 *
 * Both are MERGED (we only ever touch our own keys) and written 0o600. Detection = `~/.claude`.
 *
 * WS-8 (O-5): for a terminal inside a Project Workspace the settings file also carries the workspace
 * deny rules + `sandbox.enabled` (`claudeRules.ts`), merged the same way and recorded in a ledger so
 * revoke removes exactly what Expanse added. Removal leaves no `{}` stub behind (G12): a settings file
 * emptied by the unsync is deleted, and so is the `.claude/` folder if that leaves it empty.
 */
import { join } from 'node:path'
import type { TerminalToken } from '../orchestration/seam'
import { mergeRules, ownedRulesFor, setOwnedRules, stripRules } from './claudeRules'
import {
  type AppCliProvisioner,
  type McpServersConfig,
  type ProvisionWriteOpts,
  SERVER_NAME,
  assertTargetDir,
  claudeHome,
  dirExists,
  existingServersMap,
  isRecord,
  mcpEntry,
  readJsonConfig,
  removeDirIfEmpty,
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

function writeSync(projectDir: string, tok: TerminalToken, opts?: ProvisionWriteOpts): string {
  // A board cwd that no longer exists (a removed worktree) is never re-created to hold our config.
  assertTargetDir(projectDir)
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
    let settings = readJsonConfig<SettingsLocal>(setFile) ?? {}
    const enabled = new Set(settings.enabledMcpjsonServers ?? [])
    enabled.add(SERVER_NAME)
    settings.enabledMcpjsonServers = [...enabled]
    let owned = ownedRulesFor(projectDir)
    if (opts?.claudeRules) {
      const r = mergeRules(settings, opts.claudeRules, owned)
      settings = r.settings as SettingsLocal
      owned = r.owned
    }
    writeJsonConfig(setFile, settings)
    // Recorded only once the file holding them is on disk, so the ledger never claims a rule that
    // a failed write never placed.
    if (opts?.claudeRules) setOwnedRules(projectDir, owned)
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
  const read = readJsonConfig<SettingsLocal>(setFile)
  const owned = ownedRulesFor(projectDir)
  if (!read) {
    setOwnedRules(projectDir, undefined) // the file (and so every rule we added) is already gone
    return
  }
  let settings = read
  let changed = false
  if (settings.enabledMcpjsonServers?.includes(SERVER_NAME)) {
    settings.enabledMcpjsonServers = settings.enabledMcpjsonServers.filter((s) => s !== SERVER_NAME)
    if (settings.enabledMcpjsonServers.length === 0) delete settings.enabledMcpjsonServers
    changed = true
  }
  const stripped = stripRules(settings, owned)
  if (stripped.changed) {
    settings = stripped.settings as SettingsLocal
    changed = true
  }
  if (changed) writeOrDropSettings(projectDir, settings)
  setOwnedRules(projectDir, undefined)
}

/**
 * G12: write the settings back, or — when our removal left it empty — delete it, and the `.claude/`
 * folder with it if nothing else lives there. An emptied `{}` stub is still an untracked file, and
 * it kept a worktree whose agent wrote nothing reading as dirty.
 */
function writeOrDropSettings(projectDir: string, settings: Record<string, unknown>): void {
  const setFile = settingsLocalPath(projectDir)
  if (Object.keys(settings).length > 0) {
    writeJsonConfig(setFile, settings)
    return
  }
  removeFileQuiet(setFile)
  removeDirIfEmpty(join(projectDir, '.claude'))
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
