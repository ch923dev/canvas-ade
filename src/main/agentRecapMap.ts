/**
 * agentRecapMap.ts
 *
 * Install / remove the Claude Code hooks that map Claude sessions to their Canvas ADE board
 * (via the recordSession.js hook script). Since F2 (terminal-resume research) the SAME script
 * registers for THREE events — SessionStart, UserPromptSubmit, SessionEnd — because SessionStart
 * alone captures EAGERLY (before the transcript exists, RC-1) and never re-fires on a mid-session
 * rotation (RC-2); the per-prompt events both self-heal the map every turn boundary and record
 * `transcriptExists`, which readRecapMap keeps as the resume-grade `confirmed` entry.
 *
 * The hooks are merged idempotently into `<projectDir>/.claude/settings.local.json`
 * without clobbering any pre-existing hooks. Idempotency is keyed on whether
 * our scriptPath already appears in any hook's `args` array.
 */
import { existsSync, statSync, readFileSync, mkdirSync, watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

export interface InstallOpts {
  projectDir: string
  /**
   * Absolute path to a Node-capable runner that executes recordSession.js. In packaged builds
   * this MUST be a real `node` executable (see findNodeExecutable) — NOT the app exe, which
   * ignores a .js arg and would boot a second window. In dev, the Electron binary works because
   * it runs a .js entry as Node.
   */
  command: string
  /** Absolute path to hooks/recordSession.js */
  scriptPath: string
  /** Absolute path to the mapping JSONL file (app-owned, in userData) */
  mapPath: string
}

const RECAP_SCRIPT_BASENAME = 'recordSession.js'

/** True when a string is, or ends in a path segment that is, exactly recordSession.js. A
 *  BASENAME match (split on both POSIX and Windows separators), NOT a loose substring — so an
 *  unrelated user path that merely CONTAINS the name (e.g. `…/recordSession.js.bak`) is never
 *  mistaken for our hook and stripped. */
function referencesRecapScript(s: string): boolean {
  return s.split(/[\\/]/).some((seg) => seg === RECAP_SCRIPT_BASENAME)
}

/**
 * True when a hook's command/args reference our recap script (by basename, ANY path). Used to
 * strip stale recap entries before re-installing so hooks from earlier builds / torn-down
 * worktrees self-heal instead of stacking (the pile-up bug: the prior idempotency key was the
 * exact scriptPath, so every new path piled on rather than replacing).
 */
function isRecapHook(h: HookCmd): boolean {
  const parts = [h?.command, ...(Array.isArray(h?.args) ? h.args : [])]
  return parts.some((p) => typeof p === 'string' && referencesRecapScript(p))
}

/**
 * Resolve a real `node` executable from PATH (best-effort). Used as the recap hook's runner in
 * packaged builds, where process.execPath is the app exe — which can't run a .js as Node without
 * ELECTRON_RUN_AS_NODE, and Claude Code EXEC-form hooks can't set env. Returns null when no node
 * is found; the caller then SKIPS installing the hook (recap silently off) rather than writing a
 * broken one — the CLI must never be broken by a missing recap runtime.
 */
export function findNodeExecutable(): string | null {
  const isWin = process.platform === 'win32'
  const exe = isWin ? 'node.exe' : 'node'
  const sep = isWin ? ';' : ':'
  for (const dir of (process.env.PATH ?? '').split(sep)) {
    if (!dir) continue
    const candidate = join(dir, exe)
    try {
      // isFile (not existsSync): a DIRECTORY named node/node.exe on PATH would otherwise be
      // returned and produce a broken, un-spawnable hook command.
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* missing / unreadable PATH entry — try the next one */
    }
  }
  return null
}

type HookCmd = { type: string; command: string; args?: string[] }
type HookBlock = { matcher?: string; hooks: HookCmd[] }
type SettingsCfg = { hooks?: Partial<Record<string, HookBlock[]>> } & Record<string, unknown>

/**
 * The Claude Code hook events our script registers under (F2). SessionEnd's reliability on a
 * hard kill is undocumented (our PTY teardown is `taskkill /T /F`), so it is best-effort;
 * UserPromptSubmit is the workhorse — it fires with {session_id, transcript_path} on every
 * prompt, exactly when the transcript is (about to be) real.
 *
 * Stop / SubagentStop / Notification (desktop-notifications) add the agent-lifecycle signals:
 * the SAME recordSession.js line records `hookEvent`, and agentLifecycle.ts watches the map for
 * these to raise a desktop notification (task done / needs input). Adding events here means a
 * pre-notifications settings.local.json reads as not-installed (isRecapHookInstalled requires
 * EVERY event) and self-heals to the full set on the next focus/open re-ensure — by design.
 */
export const RECAP_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'SessionEnd',
  'Stop',
  'SubagentStop',
  'Notification'
] as const

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

/**
 * Returns true only when our hook (identified by scriptPath in args) is installed under EVERY
 * event in RECAP_HOOK_EVENTS — so a settings file written by a pre-F2 build (SessionStart only)
 * reads as not-installed and the next re-ensure upgrades it to the full set.
 */
export function isRecapHookInstalled(projectDir: string, scriptPath: string): boolean {
  const cfg = readSettings(projectDir)
  return RECAP_HOOK_EVENTS.every((event) => {
    const blocks = cfg.hooks?.[event]
    if (!Array.isArray(blocks)) return false
    return blocks.some((b) => b?.hooks?.some((h) => argsReferenceScript(h.args, scriptPath)))
  })
}

/**
 * Merges the recap SessionStart hook into settings.local.json as a Claude Code EXEC-form entry
 * (`{ type, command, args }` — direct spawn, no shell). EXEC form is the Windows-safe shape: the
 * runner path and the two argument paths are passed as separate argv elements, so a spaced path
 * can't be mangled by cmd.exe's quote-escaping — the failure mode of the old
 * `cmd.exe /c set "ELECTRON_RUN_AS_NODE=1"&& "<exe>" …` shell wrapper, which produced
 * `'"…\Expanse.exe"' is not recognized as an internal or external command` and blocked the agent
 * CLI from starting.
 *
 * Self-healing + idempotent: ANY prior recap hook (any recordSession.js path) is stripped before
 * exactly one current entry is added, so entries from earlier builds/worktrees can't stack up.
 * Pre-existing UNRELATED hooks are preserved. Writes nothing when the result is byte-identical.
 */
export function installRecapHook(opts: InstallOpts): void {
  if (!opts.command) return
  const cfg = readSettings(opts.projectDir)
  cfg.hooks ??= {}
  const hookCmd: HookCmd = {
    type: 'command',
    command: opts.command,
    args: [opts.scriptPath, opts.mapPath]
  }
  let changed = false
  for (const event of RECAP_HOOK_EVENTS) {
    const before = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event]! : []
    const stripped = before
      .filter((b) => b && typeof b === 'object')
      .map((b) => ({
        ...b,
        hooks: Array.isArray(b.hooks) ? b.hooks.filter((h: HookCmd) => !isRecapHook(h)) : []
      }))
      .filter((b) => b.hooks.length > 0)
    const next: HookBlock[] = [...stripped, { matcher: '', hooks: [hookCmd] }]
    // No-op write avoidance: a re-ensure on every project open shouldn't churn the file mtime.
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      cfg.hooks[event] = next
      changed = true
    }
  }
  if (changed) writeSettings(opts.projectDir, cfg)
}

/**
 * Removes only our hook entries (identified by scriptPath in args), across every event we
 * register under. Pre-existing unrelated hooks are preserved. Empty containers are pruned.
 */
export function removeRecapHook(projectDir: string, scriptPath: string): void {
  if (!existsSync(settingsPath(projectDir))) return
  const cfg = readSettings(projectDir)
  if (!cfg.hooks) return
  let changed = false
  for (const event of RECAP_HOOK_EVENTS) {
    const blocks = cfg.hooks[event]
    if (!blocks) continue
    // BUG-032: guard against malformed settings.local.json (hand-edited or third-party-written)
    // where an event block is not an array or has a non-array `hooks` field. Mirror the
    // defensiveness of isRecapHookInstalled (b.hooks?.some). Without this, a TypeError escapes
    // the ipcMain.handle callback, leaving consent persisted as 'declined' while the hook stays
    // installed (no retry path on the decline side).
    if (!Array.isArray(blocks)) continue
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
      cfg.hooks[event] = kept
    } else {
      delete cfg.hooks[event]
    }
    changed = true
  }
  if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks
  if (changed) writeSettings(projectDir, cfg)
}

/** A resume-grade capture: the latest hook line that SAW the transcript on disk (F2). */
export interface ConfirmedCapture {
  sessionId: string
  transcriptPath: string
  ts?: number
}

export interface RecapMapEntry {
  sessionId: string
  transcriptPath: string
  /**
   * When the hook recorded this entry (epoch ms; recordSession.js has always written it).
   * Optional: entries from pre-`ts` builds parse without it. Used by
   * resolveLiveTranscriptPath's eager-capture grace (recap-refresh fix A4).
   */
  ts?: number
  /**
   * F2: the latest line for this board whose `transcriptExists` was true at fire time — proof
   * the session became a real conversation. The TOP-LEVEL fields stay the latest line of ANY
   * kind (the eager SessionStart entry keeps the recap display fresh + the A4 grace working);
   * resume paths prefer this. Absent for pre-F2 lines and never-prompted sessions.
   */
  confirmed?: ConfirmedCapture
}

/**
 * Parse the mapping JSONL -> boardId -> latest {sessionId, transcriptPath, ts} + the latest
 * CONFIRMED (transcriptExists:true) capture. Best-effort.
 */
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
      const r = JSON.parse(s) as {
        boardId?: string
        sessionId?: string
        transcriptPath?: string
        ts?: unknown
        transcriptExists?: unknown
        confirmed?: unknown
      }
      if (r.boardId && r.transcriptPath) {
        const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? { ts: r.ts } : {}
        // An EMBEDDED confirmed object round-trips the consent-decline prune, which rewrites
        // surviving boards' lines as JSON.stringify({boardId, ...entry}) — without this, any
        // decline in one project would silently drop every OTHER project's confirmed capture.
        let embedded: ConfirmedCapture | undefined
        if (r.confirmed && typeof r.confirmed === 'object') {
          const c = r.confirmed as { sessionId?: unknown; transcriptPath?: unknown; ts?: unknown }
          if (typeof c.transcriptPath === 'string' && c.transcriptPath) {
            embedded = {
              sessionId: typeof c.sessionId === 'string' ? c.sessionId : '',
              transcriptPath: c.transcriptPath,
              ...(typeof c.ts === 'number' && Number.isFinite(c.ts) ? { ts: c.ts } : {})
            }
          }
        }
        // A confirmed LINE is its own capture; otherwise carry the embedded / prior one forward.
        const confirmed =
          r.transcriptExists === true
            ? { sessionId: r.sessionId ?? '', transcriptPath: r.transcriptPath, ...ts }
            : (embedded ?? out.get(r.boardId)?.confirmed)
        out.set(r.boardId, {
          sessionId: r.sessionId ?? '',
          transcriptPath: r.transcriptPath,
          ...ts,
          ...(confirmed ? { confirmed } : {})
        })
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
