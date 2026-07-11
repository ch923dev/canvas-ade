// src/main/ptySpawnEnv.ts
/**
 * Injectable policy seam for injecting extra env vars at spawn time (e.g. CANVAS_RECAP_BOARD).
 * Returns a record to merge LAST into the spawn env, or undefined for no extra env.
 * Policy errors must NEVER break a spawn — buildSpawnEnv calls the provider inside a try/catch.
 * index.ts wires the policy (consent + claude detection) into pty.ts; pty.ts stays decoupled.
 */
export type RecapEnvProvider = (opts: {
  id: string
  launchCommand?: string
  cwd?: string
}) => Record<string, string> | undefined

/**
 * The PTY spawn environment (terminal-copy fix,
 * docs/reviews/2026-07-11-terminal-copy-paste-research):
 *
 * - `FORCE_HYPERLINK=1` — on win32 the `supports-hyperlinks` detection used across the
 *   Claude Code / Ink ecosystem returns false outside Windows Terminal (no WT_SESSION under
 *   ConPTY), so agents print plain-text URLs. xterm's OSC 8 support is core and always on;
 *   forcing emission makes agent links clickable instead of drag-select-only.
 * - `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` — Claude Code ≥2.1.150 defaults to a
 *   fullscreen/alt-screen TUI that keeps xterm mouse-tracking on while running, which
 *   disables + wipes text selection in the embedding terminal (xterm
 *   `SelectionService.disable()` on every DECSET mouse-mode toggle). This is the one
 *   documented switch that restores selection AND keeps scrollback (the DISABLE_MOUSE
 *   variants break in-app scrolling).
 *
 * Both are inert for non-Claude agents. `recapEnv` (the injectable policy seam) is spread
 * LAST so a policy can still override either baseline var.
 */
export function buildSpawnEnv(
  provider: RecapEnvProvider | undefined,
  opts: { id: string; launchCommand?: string; cwd?: string }
): Record<string, string> {
  let recapEnv: Record<string, string> | undefined
  try {
    recapEnv = provider?.(opts)
  } catch {
    recapEnv = undefined // policy must never break a spawn
  }
  return {
    ...process.env,
    FORCE_HYPERLINK: '1',
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
    ...(recapEnv ?? {})
  } as Record<string, string>
}

/**
 * Cross-cwd recap capture: ensure the recap hook exists in the SPAWN CWD's
 * `.claude/settings.local.json` before the launch line is written. Claude Code reads hooks from
 * the directory it launches in, but the hook was only ever installed into the OPEN project dir
 * (project open + window focus) — so a board whose cwd override points at another repo (MCP
 * `spawn_board` cwd, the Inspector's Edit… cwd) launched a claude that never fired
 * recordSession.js: no map entry, "Capture didn't record this session", Resume impossible.
 * The injected provider owns the policy (consent + runner + which dirs to skip); the write is
 * synchronous + idempotent so the file is on disk before the agent reads it. Like the env seam
 * above, a provider error must NEVER break a spawn — syncRecapHook guards the call.
 */
export type RecapHookSyncProvider = (opts: { id: string; cwd: string }) => void
let recapHookSyncProvider: RecapHookSyncProvider | undefined

/** index.ts wires the policy (consent + runner + skip-list) here; pty.ts stays decoupled. */
export function setRecapHookSyncProvider(fn: RecapHookSyncProvider | undefined): void {
  recapHookSyncProvider = fn
}

/** pty.ts calls this just before the launch line; the guard keeps spawns unbreakable. */
export function syncRecapHook(opts: { id: string; cwd: string }): void {
  try {
    recapHookSyncProvider?.(opts)
  } catch {
    /* hook install is best-effort — never block a spawn */
  }
}
