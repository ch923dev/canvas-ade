/**
 * agentRecapMap.ts
 *
 * Install / remove the SessionStart hook that maps Claude Code sessions to
 * their Canvas ADE board (via the recordSession.js hook script).
 *
 * The hook is merged idempotently into `<projectDir>/.claude/settings.local.json`
 * without clobbering any pre-existing hooks. Idempotency is keyed on whether
 * our scriptPath already appears in any hook's `args` array.
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

export interface InstallOpts {
  projectDir: string
  /** Absolute path to the Node binary (process.execPath) */
  nodePath: string
  /** Absolute path to hooks/recordSession.js */
  scriptPath: string
  /** Absolute path to the mapping JSONL file (app-owned, in userData) */
  mapPath: string
}

type HookCmd = { type: string; command: string; args?: string[] }
type HookBlock = { matcher?: string; hooks: HookCmd[] }
type SettingsCfg = { hooks?: { SessionStart?: HookBlock[] } } & Record<string, unknown>

function settingsPath(projectDir: string): string {
  return join(projectDir, '.claude', 'settings.local.json')
}

function readSettings(projectDir: string): SettingsCfg {
  const p = settingsPath(projectDir)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SettingsCfg
  } catch {
    return {}
  }
}

function writeSettings(projectDir: string, cfg: SettingsCfg): void {
  mkdirSync(join(projectDir, '.claude'), { recursive: true })
  writeFileAtomic.sync(settingsPath(projectDir), JSON.stringify(cfg, null, 2), 'utf8')
}

/** Returns true if our hook (identified by scriptPath in args) is already installed. */
export function isRecapHookInstalled(projectDir: string, scriptPath: string): boolean {
  const cfg = readSettings(projectDir)
  const blocks = cfg.hooks?.SessionStart ?? []
  return blocks.some((b) => b.hooks?.some((h) => h.args?.includes(scriptPath)))
}

/**
 * Merges the recap SessionStart hook into settings.local.json.
 * No-op if already installed (idempotent, keyed on scriptPath in args).
 * Pre-existing hooks are preserved.
 */
export function installRecapHook(opts: InstallOpts): void {
  if (isRecapHookInstalled(opts.projectDir, opts.scriptPath)) return
  const cfg = readSettings(opts.projectDir)
  cfg.hooks ??= {}
  cfg.hooks.SessionStart ??= []
  cfg.hooks.SessionStart.push({
    matcher: '',
    hooks: [{ type: 'command', command: opts.nodePath, args: [opts.scriptPath, opts.mapPath] }]
  })
  writeSettings(opts.projectDir, cfg)
}

/**
 * Removes only our hook entry (identified by scriptPath in args).
 * Pre-existing unrelated hooks are preserved.
 * Empty SessionStart blocks are pruned after removal.
 */
export function removeRecapHook(projectDir: string, scriptPath: string): void {
  if (!existsSync(settingsPath(projectDir))) return
  const cfg = readSettings(projectDir)
  const blocks = cfg.hooks?.SessionStart
  if (!blocks) return
  cfg.hooks!.SessionStart = blocks
    .map((b) => ({ ...b, hooks: b.hooks.filter((h) => !h.args?.includes(scriptPath)) }))
    .filter((b) => b.hooks.length > 0)
  writeSettings(projectDir, cfg)
}
