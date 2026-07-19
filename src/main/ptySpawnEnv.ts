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
/**
 * Nested-session env scrub: when the app itself was launched FROM a Claude Code session (a dev
 * running `pnpm dev` inside a claude terminal — including Expanse's own boards), process.env
 * carries that parent session's identity. A claude spawned in a board must NOT inherit it: with
 * these set it behaves as a child of the OUTER session (observed: no transcript of its own →
 * recap resolves a stale sibling, Resume impossible). Boards are top-level sessions by
 * definition — strip the identity vars; keep deliberate baseline vars (DISABLE_ALTERNATE_SCREEN
 * is OURS below).
 */
const NESTED_CLAUDE_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT'
] as const

/** Per-spawn OpenRouter routing intent (mirrors `TerminalBoard.openRouter` / `SpawnOpts`). */
export interface OpenRouterSpawnIntent {
  enabled: boolean
  /** OpenRouter model slug (e.g. 'anthropic/claude-sonnet-4.5'). Also composed into the
   *  launch line's model flag by the dialog; here it backs ANTHROPIC_MODEL so routing
   *  holds even if the user hand-strips the flag from the composed command. */
  model?: string
}

/**
 * Maintainer-private OpenRouter routing (compile-gated __TERMINAL_OPENROUTER__): index.ts
 * wires this ONLY when the build flag is on, so every ungated build resolves no key and the
 * env branch below is inert — a board field alone can never route. The provider returns the
 * DECRYPTED OpenRouter key (llmKeyStore, safeStorage-encrypted, userData) — resolved
 * MAIN-side at spawn time, never persisted in the board doc, never echoed into the PTY
 * line. Like every seam in this file, a provider error must NEVER break a spawn.
 */
export type OpenRouterKeyProvider = () => string | undefined
let openRouterKeyProvider: OpenRouterKeyProvider | undefined

/** index.ts wires the key lookup here (gated); pty.ts stays decoupled. */
export function setOpenRouterKeyProvider(fn: OpenRouterKeyProvider | undefined): void {
  openRouterKeyProvider = fn
}

/**
 * OpenRouter env for one spawn: OPENROUTER_API_KEY (opencode + anything OpenAI-compatible)
 * plus the Anthropic-skin trio Claude Code reads — ANTHROPIC_BASE_URL → OpenRouter's
 * Anthropic-compatible endpoint, AUTH_TOKEN → the key, and ANTHROPIC_API_KEY explicitly
 * BLANK (the endpoint contract; also stops a routed board from silently billing an
 * inherited direct-API key). Injected only when the board opted in AND a key resolves;
 * enabled-but-no-key spawns UNROUTED (the dialog's key-status row is the pre-spawn warning).
 */
function openRouterEnv(intent: OpenRouterSpawnIntent | undefined): Record<string, string> {
  if (!intent?.enabled) return {}
  let key: string | undefined
  try {
    key = openRouterKeyProvider?.()
  } catch {
    key = undefined // key resolution must never break a spawn
  }
  if (!key) return {}
  return {
    OPENROUTER_API_KEY: key,
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: '',
    ...(intent.model ? { ANTHROPIC_MODEL: intent.model } : {})
  }
}

export function buildSpawnEnv(
  provider: RecapEnvProvider | undefined,
  opts: { id: string; launchCommand?: string; cwd?: string; openRouter?: OpenRouterSpawnIntent }
): Record<string, string> {
  let recapEnv: Record<string, string> | undefined
  try {
    recapEnv = provider?.(opts)
  } catch {
    recapEnv = undefined // policy must never break a spawn
  }
  const env = {
    ...process.env,
    FORCE_HYPERLINK: '1',
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
    // OpenRouter routing before the recap seam: recap stays the LAST word (its documented
    // override contract), and the two key-sets are disjoint anyway.
    ...openRouterEnv(opts.openRouter),
    ...(recapEnv ?? {})
  } as Record<string, string>
  for (const k of NESTED_CLAUDE_ENV) delete env[k]
  return env
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
