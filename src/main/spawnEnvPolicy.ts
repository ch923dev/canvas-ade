/**
 * Per-role spawn-env policy (orchestration P5 — the A8-F3 secrets gap). Every spawned PTY
 * inherits MAIN's ENTIRE `process.env` verbatim, so whatever credentials the user's shell
 * exported before launching the app flow into every worker's shell. This module is the
 * deny-by-default half of the fix: a curated credential deny-list applied to the inherited
 * env of workers whose role cannot write (design gate 2026-07-30: deny-list, read-only
 * roles only — Q5's low-friction default; a builder inherits the full env).
 *
 * Boundaries that keep this honest:
 *  - The filter applies ONLY to the `...process.env` inheritance in `buildSpawnEnv`.
 *    Deliberate injections (OpenRouter routing, recap seam, our baseline vars) happen
 *    AFTER it and are never scrubbed — a routed board still routes.
 *  - Agent-auth vars (`ANTHROPIC_*`, `CLAUDE_*`) are never denied: scrubbing them silently
 *    breaks the worker CLI's own authentication, which reads as "broken shell".
 *  - Disclosure is mandatory in both directions: the spawn confirm names the withheld vars
 *    before the human approves, and the worker itself sees the names in
 *    `CANVAS_ENV_SCRUBBED` so it can explain a missing credential instead of guessing.
 *  - Pure + electron-free, so the policy shape and the filter are unit-testable directly.
 */
import type { RolePack } from '../shared/rolePacks'

/** The one policy shape P5 ships. A closed object (not a bare string) so later levers
 *  (per-pack extra denies, an allow-list mode) extend it without re-typing every seam. */
export interface SpawnEnvPolicy {
  scrub: 'secrets'
}

/** The swarm executor's env-policy seam (`SwarmRunCtx.envPolicy`) — declared beside the
 *  registry it fronts so the seam and the module can't drift. */
export interface SwarmEnvPolicySeam {
  preview: (pack: RolePack) => string[]
  register: (boardId: string, pack: RolePack) => void
}

/**
 * Curated credential deny-list — EXACT names. Deploy/cloud/registry/DB/API credentials a
 * read-only worker has no business inheriting. Deliberately NOT a broad `*_TOKEN|*_KEY`
 * pattern: a pattern that quietly eats a var the user's tooling needs turns the scrub into
 * "why is my shell broken" friction (Q5's argument against the allow-list, applied to
 * overbroad denies too). Extend by name, with the disclosure carrying every addition.
 */
export const SECRET_ENV_DENY_NAMES: readonly string[] = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'VERCEL_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'DIGITALOCEAN_ACCESS_TOKEN',
  'HEROKU_API_KEY',
  'FLY_API_TOKEN',
  'RAILWAY_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'HF_TOKEN',
  'SENTRY_AUTH_TOKEN',
  'SLACK_BOT_TOKEN',
  'TWILIO_AUTH_TOKEN',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'PGPASSWORD',
  'MYSQL_PWD',
  'REDIS_URL',
  'MONGODB_URI',
  'DOCKER_PASSWORD'
] as const

/** Prefix denies — cloud-credential families whose member names vary per setup. */
export const SECRET_ENV_DENY_PREFIXES: readonly string[] = ['AZURE_'] as const

/** Never denied, whatever the lists above say — the worker CLI's own auth. */
const KEEP_PREFIXES: readonly string[] = ['ANTHROPIC_', 'CLAUDE_'] as const

/** Is this env var name on the deny-list (and not agent-auth-protected)? Pure. */
export function isDeniedEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  if (KEEP_PREFIXES.some((p) => upper.startsWith(p))) return false
  if (SECRET_ENV_DENY_NAMES.includes(upper)) return true
  return SECRET_ENV_DENY_PREFIXES.some((p) => upper.startsWith(p))
}

/**
 * The deny-list names PRESENT in `env` right now, sorted — the disclosure both surfaces
 * (spawn confirm + `CANVAS_ENV_SCRUBBED`) render exactly this list, so what the human
 * approves and what the worker can explain are the same string. Pure.
 */
export function secretEnvNamesPresent(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && isDeniedEnvName(k))
    .sort()
}

/**
 * Apply a policy to the INHERITED env base. Returns the filtered copy plus the names it
 * removed (for `CANVAS_ENV_SCRUBBED`). No policy ⇒ untouched copy, empty names. Pure.
 */
export function filterSpawnEnvBase(
  env: Record<string, string | undefined>,
  policy: SpawnEnvPolicy | undefined
): { env: Record<string, string | undefined>; scrubbed: string[] } {
  if (policy?.scrub !== 'secrets') return { env: { ...env }, scrubbed: [] }
  const scrubbed = secretEnvNamesPresent(env)
  const out = { ...env }
  for (const name of scrubbed) delete out[name]
  return { env: out, scrubbed }
}

/**
 * The pack → policy rule the design gate fixed (2026-07-30): read posture (`plan`) is
 * scrubbed; every write-capable posture inherits the full env. Off-vocabulary or missing
 * permissionMode ⇒ NO scrub — the same fail-open-to-today's-behaviour a non-role board
 * gets (this lever hardens read-only roles; it must never break an ordinary spawn).
 */
export function envPolicyForPack(
  pack: Pick<RolePack, 'permissionMode'>
): SpawnEnvPolicy | undefined {
  return pack.permissionMode === 'plan' ? { scrub: 'secrets' } : undefined
}

/**
 * The spawn confirm's disclosure sentence for a scrub — one source of truth for the string the
 * human approves. Bounded (first 8 names + a count) so a var-heavy machine still gets a
 * readable modal; the worker sees the full set in CANVAS_ENV_SCRUBBED either way. Empty names
 * ⇒ '' (no policy / nothing present to withhold ⇒ nothing to disclose).
 */
export function describeEnvScrub(names: string[]): string {
  if (names.length === 0) return ''
  const shown = names.slice(0, 8).join(', ')
  const more = names.length > 8 ? `, +${names.length - 8} more` : ''
  return ` Env: ${names.length} credential var${names.length === 1 ? '' : 's'} will be withheld from this worker (${shown}${more}); agent-auth vars are kept.`
}

// ── the MAIN-side registry: board id → policy, fed at spawn_worker, read at pty:spawn ──

/** Registrations are tiny; the cap is a leak guard, not a working limit. FIFO eviction. */
const MAX_POLICIES = 256

const policies = new Map<string, SpawnEnvPolicy>()

/**
 * Record the policy for a board ABOUT to spawn. Called by the swarm spawn path right after
 * the host mints the board id — the renderer's `pty:spawn` for that board arrives at least
 * one command-ack + mount + fit later, so the registry is populated well before the env is
 * built. A board that respawns/restarts under the same id keeps its policy (the registry is
 * NOT consume-once — a restarted reviewer must not silently inherit the full env).
 */
export function registerSpawnEnvPolicy(boardId: string, policy: SpawnEnvPolicy): void {
  if (!boardId) return
  if (!policies.has(boardId) && policies.size >= MAX_POLICIES) {
    const oldest = policies.keys().next().value
    if (oldest !== undefined) policies.delete(oldest)
  }
  policies.set(boardId, policy)
}

/** The policy for a spawning board, or undefined (ordinary boards: no filtering). */
export function getSpawnEnvPolicy(boardId: string): SpawnEnvPolicy | undefined {
  return policies.get(boardId)
}

/** Drop one registration (board removed) — optional hygiene; the cap bounds the rest. */
export function clearSpawnEnvPolicy(boardId: string): void {
  policies.delete(boardId)
}

/** Test seam. */
export function resetSpawnEnvPolicies(): void {
  policies.clear()
}
