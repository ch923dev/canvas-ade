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
import { existsSync, readFileSync, mkdirSync, watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

export interface InstallOpts {
  projectDir: string
  /** Absolute path to the Node binary (process.execPath) */
  nodePath: string
  /** Absolute path to hooks/recordSession.js */
  scriptPath: string
  /** Absolute path to the mapping JSONL file (app-owned, in userData) */
  mapPath: string
  /**
   * BUG-003: env vars the hook command must run under. Set
   * { ELECTRON_RUN_AS_NODE: '1' } in packaged builds so the app exe acts as
   * node when the Claude SessionStart hook invokes it. Claude Code's hook
   * schema has NO `env` field, so these are baked into a SHELL-form command
   * (cmd /c `set K=V&& ...` on Windows, `K=V ...` via /bin/sh on POSIX).
   */
  env?: Record<string, string>
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

/** True when an args element IS the scriptPath (direct form) or embeds it (shell form). */
function argsReferenceScript(args: string[] | undefined, scriptPath: string): boolean {
  return !!args?.some((a) => typeof a === 'string' && a.includes(scriptPath))
}

/** Returns true if our hook (identified by scriptPath in args) is already installed. */
export function isRecapHookInstalled(projectDir: string, scriptPath: string): boolean {
  const cfg = readSettings(projectDir)
  const blocks = cfg.hooks?.SessionStart ?? []
  return blocks.some((b) => b.hooks?.some((h) => argsReferenceScript(h.args, scriptPath)))
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
  let hookCmd: HookCmd = {
    type: 'command',
    command: opts.nodePath,
    args: [opts.scriptPath, opts.mapPath]
  }
  // BUG-003: bake ELECTRON_RUN_AS_NODE=1 into the hook so the app exe acts as node in
  // packaged builds (where process.execPath is the Electron app binary, not a plain
  // node). Claude Code's documented hook schema has no `env` field, so the env
  // assignment is baked into a shell-form command instead.
  if (opts.env && Object.keys(opts.env).length > 0) {
    const pairs = Object.entries(opts.env)
    const q = (p: string): string => `"${p}"`
    const invocation = `${q(opts.nodePath)} ${q(opts.scriptPath)} ${q(opts.mapPath)}`
    hookCmd =
      process.platform === 'win32'
        ? {
            type: 'command',
            command: 'cmd.exe',
            // /d: skip AutoRun; /s: preserve the quoted command string verbatim.
            args: [
              '/d',
              '/s',
              '/c',
              // `set "K=V"` (quotes around the WHOLE assignment — cmd strips them and the
              // value keeps metacharacters/spaces literal). NOT `set K="V"`, which would
              // store the quotes INTO the value.
              `${pairs.map(([k, v]) => `set "${k}=${v}"&& `).join('')}${invocation}`
            ]
          }
        : {
            type: 'command',
            command: '/bin/sh',
            // Single-quote the value (POSIX-safe for all metacharacters; embedded ' via
            // the standard '\'' splice) so a future env entry with spaces/$/&c. can't
            // shell-split or inject a command.
            args: [
              '-c',
              `${pairs.map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}' `).join('')}${invocation}`
            ]
          }
  }
  cfg.hooks.SessionStart.push({ matcher: '', hooks: [hookCmd] })
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
  // BUG-032: guard against malformed settings.local.json (hand-edited or third-party-written)
  // where a SessionStart block is not an array or has a non-array `hooks` field. Mirror the
  // defensiveness of isRecapHookInstalled (b.hooks?.some). Without this, a TypeError escapes
  // the ipcMain.handle callback, leaving consent persisted as 'declined' while the hook stays
  // installed (no retry path on the decline side).
  if (!Array.isArray(blocks)) return
  const kept = blocks
    .filter((b) => b && typeof b === 'object')
    .map((b) => ({
      ...b,
      hooks: Array.isArray(b.hooks)
        ? b.hooks.filter((h: HookCmd) => !argsReferenceScript(h.args, scriptPath))
        : []
    }))
    .filter((b) => b.hooks.length > 0)
  // Prune empty containers so removing our last hook leaves a clean file, not a dangling
  // `{ hooks: { SessionStart: [] } }`.
  if (kept.length > 0) {
    cfg.hooks!.SessionStart = kept
  } else {
    delete cfg.hooks!.SessionStart
    if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks
  }
  writeSettings(projectDir, cfg)
}

export interface RecapMapEntry {
  sessionId: string
  transcriptPath: string
}

/** Parse the mapping JSONL -> boardId -> latest {sessionId, transcriptPath}. Best-effort. */
export function readRecapMap(mapPath: string): Map<string, RecapMapEntry> {
  const out = new Map<string, RecapMapEntry>()
  if (!existsSync(mapPath)) return out
  let text = ''
  try {
    text = readFileSync(mapPath, 'utf8')
  } catch {
    return out
  }
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s) as { boardId?: string; sessionId?: string; transcriptPath?: string }
      if (r.boardId && r.transcriptPath) {
        out.set(r.boardId, { sessionId: r.sessionId ?? '', transcriptPath: r.transcriptPath })
      }
    } catch {
      /* skip */
    }
  }
  return out
}

/** Watch the mapping file; call onChange (debounced) with the freshly-parsed map. Returns a disposer. */
export function watchRecapMap(
  mapPath: string,
  onChange: (m: Map<string, RecapMapEntry>) => void,
  debounceMs = 200
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => onChange(readRecapMap(mapPath)), debounceMs)
  }
  let w: ReturnType<typeof watch> | null = null
  try {
    const dir = dirname(mapPath)
    const fname = basename(mapPath)
    mkdirSync(dir, { recursive: true })
    // Watch the DIRECTORY (it exists after mkdirSync), not the file. The map file is created
    // lazily by recordSession.js's first appendFileSync, and fs.watch on a not-yet-created
    // file throws ENOENT — so watching the file directly silently misses the very first
    // session after recaps are enabled (no event until an app restart). A directory watch
    // catches the create; we filter by filename to stay scoped. `filename` can be null on
    // some platforms → fall back to firing.
    w = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename === null || filename === fname) fire()
    })
  } catch {
    /* directory unwatchable (rare) — the prime fire below still runs once */
  }
  fire() // prime
  return () => {
    if (timer) clearTimeout(timer)
    try {
      w?.close()
    } catch {
      /* already closed */
    }
  }
}
