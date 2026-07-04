/**
 * Per-CLI writers for EXTERNAL MCP servers (feature: add external MCP servers, Phase 3).
 *
 * The `canvas-ade` provisioners (`./claude` … `./opencode`) write Expanse's OWN single loopback
 * server, consent-gated, with a freshly-minted token each spawn. External servers are different:
 * a user-registered SET of named servers, http OR stdio, gated only by enabled+targets (NOT
 * orchestration consent — they are the user's own servers, REPORT §D1). So this is a PARALLEL writer
 * that reuses the shared merge-not-clobber helpers but never touches the `canvas-ade` key.
 *
 * Discipline is identical to the canvas-ade path: merge (only our named keys), atomic 0o600 writes,
 * and NEVER log a header/env value. Secrets arrive already decrypted in a {@link ResolvedServer}
 * (the store decrypts in MAIN immediately before the write); they live only for the duration of the
 * write. MAIN-only (node fs via the shared helpers).
 */
import { join } from 'node:path'
import type { CliId, NamedSecret, ResolvedServer } from '../mcpServers/types'
import {
  type McpServersConfig,
  claudeHome,
  codexHome,
  codexTableBlock,
  dirExists,
  existingServersMap,
  geminiHome,
  isRecord,
  opencodeHome,
  readJsonConfig,
  readTextConfig,
  removeCodexTableNamed,
  removeFileQuiet,
  tomlBasicString,
  tomlInlineTable,
  tomlStringArray,
  upsertCodexTableBlock,
  writeJsonConfig,
  writeTextConfig
} from './shared'

/** Where a CLI's config lives — a project-scoped file (board cwd) or a home-scoped file. */
export type WriterScope = 'project' | 'home'

/** One CLI's external-server writer. `dir` is the project/board dir; home writers ignore it. */
export interface ExternalCliWriter {
  readonly id: CliId
  readonly scope: WriterScope
  /** Upsert every server in `servers` (merge-not-clobber). */
  writeServers(dir: string, servers: readonly ResolvedServer[]): void
  /** Remove the named servers' entries (idempotent — absent names are a no-op). */
  removeServers(dir: string, names: readonly string[]): void
}

// ── secret → plain map helpers (used by the JSON CLIs) ──────────────────────────────────────────

/** `[{name,value}]` → `{name: value}`, or undefined when the list is empty/absent (omit the key). */
function toObject(list: NamedSecret[] | undefined): Record<string, string> | undefined {
  if (!list || list.length === 0) return undefined
  return Object.fromEntries(list.map((s) => [s.name, s.value]))
}

/** `[{name,value}]` → `[[name,value]]` for TOML inline tables (empty ⇒ []). */
function toPairs(list: NamedSecret[] | undefined): [string, string][] {
  return (list ?? []).map((s) => [s.name, s.value])
}

// ── Claude · `<project>/.mcp.json` + `.claude/settings.local.json` (project-scoped) ──────────────

interface SettingsLocal {
  enabledMcpjsonServers?: string[]
  [k: string]: unknown
}

function claudeEntry(s: ResolvedServer): Record<string, unknown> {
  if (s.transport === 'http') {
    const headers = toObject(s.headers)
    return { type: 'http', url: s.url, ...(headers ? { headers } : {}) }
  }
  const env = toObject(s.env)
  return {
    type: 'stdio',
    command: s.command,
    ...(s.args && s.args.length ? { args: s.args } : {}),
    ...(env ? { env } : {})
  }
}

const claudeWriter: ExternalCliWriter = {
  id: 'claude',
  scope: 'project',
  writeServers(dir, servers) {
    if (servers.length === 0) return
    const mcpFile = join(dir, '.mcp.json')
    const mcp = readJsonConfig<McpServersConfig>(mcpFile) ?? {}
    const map = { ...existingServersMap(mcp, 'mcpServers') }
    for (const s of servers) map[s.name] = claudeEntry(s)
    mcp.mcpServers = map
    writeJsonConfig(mcpFile, mcp)

    // Trust-prompt bypass: ensure every written name is in enabledMcpjsonServers (deduped).
    const setFile = join(dir, '.claude', 'settings.local.json')
    const settings = readJsonConfig<SettingsLocal>(setFile) ?? {}
    const enabled = new Set(settings.enabledMcpjsonServers ?? [])
    for (const s of servers) enabled.add(s.name)
    settings.enabledMcpjsonServers = [...enabled]
    writeJsonConfig(setFile, settings)
  },
  removeServers(dir, names) {
    const drop = new Set(names)
    const mcpFile = join(dir, '.mcp.json')
    const mcp = readJsonConfig<McpServersConfig>(mcpFile)
    if (isRecord(mcp?.mcpServers)) {
      let changed = false
      for (const n of names)
        if (n in mcp.mcpServers) {
          delete mcp.mcpServers[n]
          changed = true
        }
      if (changed) {
        if (Object.keys(mcp.mcpServers).length === 0 && Object.keys(mcp).length === 1) {
          removeFileQuiet(mcpFile)
        } else {
          writeJsonConfig(mcpFile, mcp)
        }
      }
    }
    const setFile = join(dir, '.claude', 'settings.local.json')
    const settings = readJsonConfig<SettingsLocal>(setFile)
    if (settings?.enabledMcpjsonServers?.some((n) => drop.has(n))) {
      settings.enabledMcpjsonServers = settings.enabledMcpjsonServers.filter((n) => !drop.has(n))
      if (settings.enabledMcpjsonServers.length === 0) delete settings.enabledMcpjsonServers
      writeJsonConfig(setFile, settings)
    }
  }
}

// ── Gemini · `~/.gemini/settings.json` (home-scoped; transport by KEY) ───────────────────────────

function geminiEntry(s: ResolvedServer): Record<string, unknown> {
  if (s.transport === 'http') {
    const headers = toObject(s.headers)
    return { httpUrl: s.url, ...(headers ? { headers } : {}) }
  }
  const env = toObject(s.env)
  return {
    command: s.command,
    ...(s.args && s.args.length ? { args: s.args } : {}),
    ...(env ? { env } : {})
  }
}

const geminiWriter: ExternalCliWriter = {
  id: 'gemini',
  scope: 'home',
  writeServers(_dir, servers) {
    if (servers.length === 0) return
    const file = join(geminiHome(), 'settings.json')
    const cfg = readJsonConfig<McpServersConfig>(file) ?? {}
    const map = { ...existingServersMap(cfg, 'mcpServers') }
    for (const s of servers) map[s.name] = geminiEntry(s)
    cfg.mcpServers = map
    writeJsonConfig(file, cfg)
  },
  removeServers(_dir, names) {
    const file = join(geminiHome(), 'settings.json')
    const cfg = readJsonConfig<McpServersConfig>(file)
    if (!isRecord(cfg?.mcpServers)) return
    let changed = false
    for (const n of names)
      if (n in cfg.mcpServers) {
        delete cfg.mcpServers[n]
        changed = true
      }
    if (changed) writeJsonConfig(file, cfg)
  }
}

// ── Codex · `~/.codex/config.toml` (home-scoped; surgical per-name TOML upsert) ──────────────────

function codexBodyLines(s: ResolvedServer): string[] {
  if (s.transport === 'http') {
    const lines = [`url = ${tomlBasicString(s.url ?? '')}`]
    if (s.headers && s.headers.length)
      lines.push(`http_headers = ${tomlInlineTable(toPairs(s.headers))}`)
    return lines
  }
  const lines = [`command = ${tomlBasicString(s.command ?? '')}`]
  if (s.args && s.args.length) lines.push(`args = ${tomlStringArray(s.args)}`)
  if (s.env && s.env.length) lines.push(`env = ${tomlInlineTable(toPairs(s.env))}`)
  return lines
}

const codexWriter: ExternalCliWriter = {
  id: 'codex',
  scope: 'home',
  writeServers(_dir, servers) {
    if (servers.length === 0) return
    const file = join(codexHome(), 'config.toml')
    let content = readTextConfig(file)
    for (const s of servers) {
      content = upsertCodexTableBlock(content, s.name, codexTableBlock(s.name, codexBodyLines(s)))
    }
    writeTextConfig(file, content ?? '')
  },
  removeServers(_dir, names) {
    const file = join(codexHome(), 'config.toml')
    const existing = readTextConfig(file)
    if (existing === undefined) return
    let next = existing
    for (const n of names) next = removeCodexTableNamed(next, n)
    if (next === existing) return
    if (next.trim() === '') removeFileQuiet(file)
    else writeTextConfig(file, next)
  }
}

// ── OpenCode · `<project>/opencode.json` (project-scoped) ────────────────────────────────────────

const OPENCODE_SCHEMA = 'https://opencode.ai/config.json'
interface OpencodeConfig {
  $schema?: string
  mcp?: Record<string, unknown>
  [k: string]: unknown
}

function opencodeEntry(s: ResolvedServer): Record<string, unknown> {
  if (s.transport === 'http') {
    const headers = toObject(s.headers)
    return { type: 'remote', url: s.url, enabled: true, ...(headers ? { headers } : {}) }
  }
  const environment = toObject(s.env)
  return {
    type: 'local',
    command: [s.command ?? '', ...(s.args ?? [])],
    enabled: true,
    ...(environment ? { environment } : {})
  }
}

const opencodeWriter: ExternalCliWriter = {
  id: 'opencode',
  scope: 'project',
  writeServers(dir, servers) {
    if (servers.length === 0) return
    const file = join(dir, 'opencode.json')
    const cfg = readJsonConfig<OpencodeConfig>(file) ?? {}
    if (!cfg.$schema) cfg.$schema = OPENCODE_SCHEMA
    const map = { ...existingServersMap(cfg, 'mcp') }
    for (const s of servers) map[s.name] = opencodeEntry(s)
    cfg.mcp = map
    writeJsonConfig(file, cfg)
  },
  removeServers(dir, names) {
    const file = join(dir, 'opencode.json')
    const cfg = readJsonConfig<OpencodeConfig>(file)
    if (!isRecord(cfg?.mcp)) return
    let changed = false
    for (const n of names)
      if (n in cfg.mcp) {
        delete cfg.mcp[n]
        changed = true
      }
    if (!changed) return
    const onlyMeta =
      Object.keys(cfg.mcp).length === 0 &&
      Object.keys(cfg).every((k) => k === 'mcp' || k === '$schema')
    if (onlyMeta) removeFileQuiet(file)
    else writeJsonConfig(file, cfg)
  }
}

export const EXTERNAL_WRITERS: Record<CliId, ExternalCliWriter> = {
  claude: claudeWriter,
  codex: codexWriter,
  gemini: geminiWriter,
  opencode: opencodeWriter
}

/** Directory a project-scoped writer targets given the project/board dir; home writers ignore it. */
export function writerTargetDir(id: CliId, projectOrBoardDir: string): string {
  switch (id) {
    case 'gemini':
      return geminiHome()
    case 'codex':
      return codexHome()
    default:
      return projectOrBoardDir // claude / opencode are project-scoped
  }
}

/** Detection map (config dir present per CLI) — reused by the IPC `detectClis` handler. */
export async function detectExternalClis(): Promise<Record<CliId, boolean>> {
  const dirs: Record<CliId, string> = {
    claude: claudeHome(),
    codex: codexHome(),
    gemini: geminiHome(),
    opencode: opencodeHome()
  }
  const entries = await Promise.all(
    (Object.keys(dirs) as CliId[]).map(async (id) => [id, await dirExists(dirs[id])] as const)
  )
  return Object.fromEntries(entries) as Record<CliId, boolean>
}
