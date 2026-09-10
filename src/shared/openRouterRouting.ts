/**
 * OpenRouter routing table (v20 lane, maintainer-private — compile-gated `__TERMINAL_OPENROUTER__`).
 *
 * ONE declaration shared by MAIN and the renderer (the `src/shared/rolePacks.ts` precedent), so the
 * two halves of the feature can never disagree:
 *  - the renderer asks *"does this preset get the dialog section?"* — {@link OPENROUTER_CAPABLE_PRESETS};
 *  - MAIN asks *"what env does THIS launch line need?"* — {@link resolveOpenRouterRoute} → `route.env`.
 * A preset therefore cannot be offered a checkbox that would not route, nor route through env its
 * CLI does not read.
 *
 * **Per-CLI env is SCOPED to what that CLI actually reads.** A claude route emits the Anthropic-skin
 * trio only; an opencode route emits `OPENROUTER_API_KEY` only. The original lane injected the UNION
 * for every routed spawn, so a routed claude board also carried `OPENROUTER_API_KEY` and a routed
 * opencode board also carried `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` — meaning any OTHER agentic
 * CLI the board's agent shelled out to picked up the maintainer's key and silently billed it. A route
 * now reaches exactly the process it was chosen for.
 *
 * The key itself never appears here: `env()` takes the already-decrypted key as an argument, resolved
 * MAIN-side at spawn time (`ptySpawnEnv.ts` › `OpenRouterKeyProvider`) from the safeStorage
 * `llmKeyStore`. This module is pure data + pure functions — no I/O, no secrets at rest.
 */

/** OpenRouter's Anthropic-compatible endpoint. Claude Code appends `/v1/messages`. */
export const OPENROUTER_ANTHROPIC_BASE_URL = 'https://openrouter.ai/api'

/** OpenRouter's OpenAI-compatible endpoint, for CLIs addressed that way. */
export const OPENROUTER_OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'

/** Slug clamp — the rule the MCP spawn paths already enforce (`mcpLifecycle.sanitizeOpenRouter`). */
export const OPENROUTER_MODEL_MAX = 200

/**
 * One clean token, ≤{@link OPENROUTER_MODEL_MAX} chars. Control chars are dropped and whitespace
 * collapses (a pasted multi-line slug becomes one line) — the dialog path previously did a bare
 * `.trim()` while the MCP paths clamped, leaving the PRIMARY path the least-validated one. A slug
 * reaches BOTH an env value and (via `applyOpenRouterModel`) the composed launch line, where a raw
 * newline would split the PTY write into two commands.
 */
export function sanitizeOpenRouterModel(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, OPENROUTER_MODEL_MAX)
  )
}

/** One CLI's OpenRouter route: how to recognise its launch line, and the env it needs. */
export interface OpenRouterRoute {
  /** The `AgentPreset.id` this route belongs to (also the persisted `TerminalBoard.agentKind`). */
  readonly id: string
  /** The bin its launch line starts with, bare + lowercase (see {@link launchBin}). */
  readonly bin: string
  /** Env for one spawn, given the decrypted key and the sanitized slug (absent ⇒ CLI default). */
  env(key: string, model?: string): Record<string, string>
}

/**
 * claude — Claude Code reads the Anthropic trio. `ANTHROPIC_API_KEY` is explicitly BLANK: the
 * OpenRouter endpoint contract, and it overrides an inherited direct key so a routed board can
 * never silently bill the direct Anthropic API. `ANTHROPIC_MODEL` backs the slug so routing holds
 * even if the user hand-strips `--model` off the composed line.
 */
const claudeRoute: OpenRouterRoute = {
  id: 'claude',
  bin: 'claude',
  env: (key, model) => ({
    ANTHROPIC_BASE_URL: OPENROUTER_ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: '',
    ...(model ? { ANTHROPIC_MODEL: model } : {})
  })
}

/** opencode — reads `OPENROUTER_API_KEY` natively; the model rides the `--model openrouter/<slug>`
 *  flag the dialog composes (`applyOpenRouterModel`), so there is no model env to set. */
const opencodeRoute: OpenRouterRoute = {
  id: 'opencode',
  bin: 'opencode',
  env: (key) => ({ OPENROUTER_API_KEY: key })
}

/**
 * The routes, in dialog order. gemini has no OpenRouter path and shell is not an agent, so neither
 * is listed — the dialog HIDES its section for them rather than offer a checkbox that would not
 * route, and MAIN injects nothing for them even if a board field says otherwise.
 */
export const OPENROUTER_ROUTES: readonly OpenRouterRoute[] = [claudeRoute, opencodeRoute]

/** Presets that can honour a route — the set the dialog gates its section on. */
export const OPENROUTER_CAPABLE_PRESETS: ReadonlySet<string> = new Set(
  OPENROUTER_ROUTES.map((r) => r.id)
)

/**
 * The bare, lowercase bin a launch line starts with — `claude --model x` → `claude`,
 * `"C:\tools\Claude.cmd" -c` → `claude`. Undefined for an empty/absent line (a bare interactive
 * shell). Deliberately strict: a wrapper (`npx claude`, `pwsh -c claude`, `FOO=1 claude`) resolves
 * to the WRAPPER and therefore to no route — fail-closed is the right answer for a key.
 */
export function launchBin(launchCommand: string | undefined): string | undefined {
  const line = launchCommand?.trim()
  if (!line) return undefined
  // A QUOTED first token may legitimately contain spaces — `"C:\Program Files\nodejs\claude.cmd"`
  // is the ordinary Windows install path — so read to the matching quote before falling back to a
  // whitespace split. A bare whitespace split cut that path at "Program" and resolved no route,
  // silently refusing to route for anyone whose CLI lives in a spaced directory.
  const m = /^"([^"]*)"|^'([^']*)'|^(\S+)/.exec(line)
  const first = m?.[1] ?? m?.[2] ?? m?.[3]
  if (!first) return undefined
  // Unterminated quote falls through the \S+ branch — strip any stragglers.
  const unquoted = first.replace(/^["']+/, '').replace(/["']+$/, '')
  const base = unquoted.split(/[\\/]/).pop() ?? ''
  const bare = base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
  return bare || undefined
}

/**
 * The route for a launch line, or undefined when nothing being launched can honour one.
 *
 * MAIN resolves the route from the LAUNCH LINE rather than from the board's `openRouter` field or
 * its `agentKind`, because neither is trustworthy at the trust boundary: the dialog hides its
 * checkbox for an incapable preset but does not clear the field (so a board switched claude → shell
 * keeps `enabled: true`), and MCP/swarm-spawned terminals carry no `agentKind` at all. The launch
 * line is the thing that actually runs, so it is both the fail-closed signal (no line ⇒ a bare shell
 * ⇒ never the key) and the honest one.
 */
export function resolveOpenRouterRoute(
  launchCommand: string | undefined
): OpenRouterRoute | undefined {
  const bin = launchBin(launchCommand)
  return bin ? OPENROUTER_ROUTES.find((r) => r.bin === bin) : undefined
}
