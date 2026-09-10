// src/main/ptySpawnEnv.ts
import { filterSpawnEnvBase, type SpawnEnvPolicy } from './spawnEnvPolicy'
import { resolveOpenRouterRoute, sanitizeOpenRouterModel } from '../shared/openRouterRouting'

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
 *   variants break in-app scrolling). **T1d — this is now conditional on `opts.flickerFree`
 *   (the app-wide "Flicker-free terminals" setting, default ON):** ON omits it so the CLI keeps
 *   its default alt-screen → zero resize-scrollback litter (anthropics/claude-code#51828); Shift+drag
 *   still copies in alt-screen so #332's copy fix is NOT re-broken (only modifier-less drag-select is
 *   lost). OFF forces it off as above. Decided AFTER the process.env spread (so an inherited value
 *   from a parent Claude session can't leak past an ON) but BEFORE the recap seam (so recap keeps its
 *   last-word override of this key).
 *
 * Both are inert for non-Claude agents. `recapEnv` (the injectable policy seam) is spread
 * LAST so a policy can still override either baseline var (the alt-screen decision is applied
 * after the spreads, so `flickerFree` — an explicit user setting — wins over any inherited value).
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
 * OpenRouter env for one spawn, SCOPED to the CLI actually being launched
 * (`shared/openRouterRouting` owns the per-route env — claude gets the Anthropic-skin trio,
 * opencode gets `OPENROUTER_API_KEY`).
 *
 * 🔒 The LAUNCH LINE decides the route, not the board's intent field. `openRouter.enabled` is
 * only an intent: the dialog hides its checkbox for an incapable preset but does NOT clear the
 * field, so a board switched claude → shell keeps `enabled: true` — and under the old
 * preset-blind injection that put the decrypted key into a plain interactive shell's env, where
 * `env` prints it and every child inherits it. MCP/swarm-spawned terminals also carry no
 * `agentKind`, so the board field could not be the gate either way. Resolving from what actually
 * runs is fail-closed (no launch line ⇒ a bare shell ⇒ never the key) and honest (a board
 * claiming claude while launching pwsh does not route).
 *
 * Injected only when the board opted in AND a route resolves AND a key resolves; every other
 * state spawns UNROUTED (the dialog's key-status row is the pre-spawn warning for the no-key case).
 */
function openRouterEnv(
  intent: OpenRouterSpawnIntent | undefined,
  launchCommand: string | undefined
): Record<string, string> {
  if (!intent?.enabled) return {}
  const route = resolveOpenRouterRoute(launchCommand)
  if (!route) return {}
  let key: string | undefined
  try {
    key = openRouterKeyProvider?.()
  } catch {
    key = undefined // key resolution must never break a spawn
  }
  if (!key) return {}
  // Re-clamp the slug MAIN-side: it arrives over IPC from the renderer, and MAIN is the trust
  // boundary (the same discipline as every other seam in this file).
  const model = intent.model ? sanitizeOpenRouterModel(intent.model) : ''
  return route.env(key, model || undefined)
}

/**
 * P5 secrets hygiene (A8-F3): per-board env policy, applied to the INHERITED `process.env`
 * base only — deliberate injections below (our baseline vars, OpenRouter routing, the recap
 * seam) are never filtered. index.ts wires `spawnEnvPolicy.getSpawnEnvPolicy` here; pty.ts
 * stays decoupled, and — like every seam in this file — a provider error never breaks a spawn.
 */
export type SpawnEnvPolicyProvider = (boardId: string) => SpawnEnvPolicy | undefined
let spawnEnvPolicyProvider: SpawnEnvPolicyProvider | undefined

export function setSpawnEnvPolicyProvider(fn: SpawnEnvPolicyProvider | undefined): void {
  spawnEnvPolicyProvider = fn
}

export function buildSpawnEnv(
  provider: RecapEnvProvider | undefined,
  opts: {
    id: string
    launchCommand?: string
    cwd?: string
    openRouter?: OpenRouterSpawnIntent
    /** T1d "Flicker-free terminals" (app-wide setting, read fresh per spawn in pty.ts). When true,
     *  do NOT force alt-screen off → the CLI keeps its default alt-screen (zero resize litter). */
    flickerFree?: boolean
  }
): Record<string, string> {
  let recapEnv: Record<string, string> | undefined
  try {
    recapEnv = provider?.(opts)
  } catch {
    recapEnv = undefined // policy must never break a spawn
  }
  // P5: resolve + apply this board's env policy to the inherited base BEFORE any deliberate
  // injection, so a role-scrubbed worker still gets routing/recap/baseline vars intact.
  let policy: SpawnEnvPolicy | undefined
  try {
    policy = spawnEnvPolicyProvider?.(opts.id)
  } catch {
    policy = undefined // policy must never break a spawn
  }
  const { env: inherited, scrubbed } = filterSpawnEnvBase(process.env, policy)
  const env = {
    ...inherited,
    FORCE_HYPERLINK: '1',
    // OpenRouter routing before the recap seam; the two key-sets are disjoint anyway.
    ...openRouterEnv(opts.openRouter, opts.launchCommand)
  } as Record<string, string>
  // Disclosure to the worker itself: a silently-scrubbed env reads as "broken shell" — the
  // names live in the env so the agent can SAY a credential was withheld instead of guessing.
  if (scrubbed.length > 0) env.CANVAS_ENV_SCRUBBED = scrubbed.join(',')
  // Alt-screen decision (T1d) — set AFTER the process.env spread (so an inherited
  // CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN from a parent Claude session can't leak past an ON) but
  // BEFORE the recap seam (so recap stays the LAST word and can still override this key — its
  // documented contract, exercised by pty.recapenv.test.ts). ON omits the var → the CLI keeps its
  // default alt-screen (zero resize litter, #51828); OFF forces it off (selection-during-stream, #332).
  if (opts.flickerFree) delete env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
  else env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'
  // Recap seam LAST word (its documented override contract): can still override the alt-screen key.
  Object.assign(env, recapEnv ?? {})
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
