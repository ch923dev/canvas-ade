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

/** The env var CLIs read the OpenRouter key from. Named in codex's `env_key` override, so it must
 *  match the key `codexRoute.env` actually injects. */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY'

/** Display name codex requires on a `[model_providers.*]` table (`name` is not optional). */
const CODEX_PROVIDER_NAME = 'OpenRouter'

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

/** One CLI's OpenRouter route: how to recognise its launch line, the env it needs, and any
 *  launch-line arguments that env alone cannot express. */
export interface OpenRouterRoute {
  /** The `AgentPreset.id` this route belongs to (also the persisted `TerminalBoard.agentKind`). */
  readonly id: string
  /** The bin its launch line starts with, bare + lowercase (see {@link launchBin}). */
  readonly bin: string
  /** Env for one spawn, given the decrypted key and the sanitized slug (absent ⇒ CLI default). */
  env(key: string, model?: string): Record<string, string>
  /**
   * Extra argv the composed launch line needs, inserted straight after the bin (see
   * `composeCommand`). Only for a CLI that cannot be pointed at OpenRouter by env alone — codex
   * needs config overrides. NEVER carries the key: these tokens are persisted in the board doc and
   * echo in the PTY, so a route may only name the env var the CLI should read.
   */
  args?(model?: string): readonly string[]
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
 * codex — reads `OPENROUTER_API_KEY`, but only once its config names OpenRouter as the active
 * provider. Rather than mutate the user's `~/.codex/config.toml` (which would risk clobbering a
 * hand-tuned `model`/`wire_api` and leave routing switched on for every codex run on the machine,
 * inside Expanse or not), the provider is declared per-spawn with `-c` overrides. Their blast
 * radius is exactly this one process.
 *
 * PROBE-VERIFIED against codex-cli 0.153.4 on an isolated `CODEX_HOME` (`codex doctor` reports
 * `config loaded` · provider `openrouter` · wire API `responses`; the full line plus `-m` parses):
 *  - `name` is REQUIRED — omit it and config loading FAILS outright.
 *  - `wire_api` is deliberately NOT set. `chat` and `chat_completions` are both REJECTED on this
 *    version (they break config loading); `responses` is the only accepted value AND the default,
 *    so omitting the key is both the working and the least-brittle choice.
 *  - the model rides `-m <slug>` (CODEX_OPTIONS' free-text model flag), so there is no model env.
 */
const codexRoute: OpenRouterRoute = {
  id: 'codex',
  bin: 'codex',
  env: (key) => ({ OPENROUTER_API_KEY: key }),
  args: () => [
    '-c',
    'model_provider=openrouter',
    '-c',
    `model_providers.openrouter.name=${CODEX_PROVIDER_NAME}`,
    '-c',
    `model_providers.openrouter.base_url=${OPENROUTER_OPENAI_BASE_URL}`,
    '-c',
    `model_providers.openrouter.env_key=${OPENROUTER_KEY_ENV}`
  ]
}

/**
 * The routes, in dialog order. gemini has no OpenRouter path and shell is not an agent, so neither
 * is listed — the dialog HIDES its section for them rather than offer a checkbox that would not
 * route, and MAIN injects nothing for them even if a board field says otherwise.
 */
export const OPENROUTER_ROUTES: readonly OpenRouterRoute[] = [
  claudeRoute,
  codexRoute,
  opencodeRoute
]

/**
 * Look a route up by PRESET id — the renderer's question ("what does the dialog compose for the
 * preset the user picked?"). MAIN asks the other question, by launch-line bin
 * ({@link resolveOpenRouterRoute}), because a board field is not evidence of what will run.
 */
export function routeByPresetId(presetId: string | undefined): OpenRouterRoute | undefined {
  return presetId ? OPENROUTER_ROUTES.find((r) => r.id === presetId) : undefined
}

/**
 * The routing argv the composed launch line needs for a preset, or `[]` when that CLI is steered by
 * env alone (claude, opencode). Pure — the dialogs feed the result to `composeCommand`.
 */
export function openRouterArgs(presetId: string | undefined, model?: string): readonly string[] {
  return routeByPresetId(presetId)?.args?.(model) ?? []
}

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
