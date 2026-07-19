/**
 * Compose a launch command from the structured command-builder values (A2). Pure +
 * unit-tested. The composed string is what gets persisted as `launchCommand` (the locked
 * source of truth) — the builder is a convenience layer over it, never a replacement.
 *
 * Composition rules per option kind:
 *  - select / text → `flag value` when the value is a non-empty string (else omitted);
 *    a value containing whitespace is double-quoted so a path with spaces stays one arg.
 *  - toggle        → bare `flag` when true (else omitted).
 * Options compose in registry order; the base `bin` leads (empty for the plain shell ⇒ '').
 */
import type { AgentPreset } from './agentPresets'

export type OptionValue = string | boolean
export type OptionValues = Record<string, OptionValue>

/**
 * Quote an argument that contains whitespace so it survives as a single shell token.
 * Escape backslashes AND double-quotes (POSIX double-quote semantics) so a Windows path or an
 * embedded quote can't mis-terminate / break out of the quoted token. The persisted
 * launchCommand stays user-editable, so any shell-specific quoting (pwsh backtick, cmd ^) is the
 * raw Command field's job — this is the convenience default, not a security boundary.
 */
function quoteArg(v: string): string {
  return /\s/.test(v) ? `"${v.replace(/[\\"]/g, '\\$&')}"` : v
}

export function composeCommand(preset: AgentPreset, values: OptionValues): string {
  const parts: string[] = []
  if (preset.bin) parts.push(preset.bin)
  for (const opt of preset.options ?? []) {
    const v = values[opt.id]
    if (opt.kind === 'toggle') {
      if (v === true) parts.push(opt.flag)
    } else if (typeof v === 'string' && v.trim() !== '') {
      parts.push(opt.flag, quoteArg(v.trim()))
    }
  }
  return parts.join(' ')
}

/**
 * v20 OpenRouter routing (compile-gated feature): presets whose CLI actually honours the
 * injected OpenRouter env. claude reads the Anthropic-skin trio (ANTHROPIC_BASE_URL /
 * AUTH_TOKEN); opencode reads OPENROUTER_API_KEY natively. codex needs a config.toml
 * provider block (deferred — the cliProvisioners upsert pattern when wanted) and gemini has
 * no OpenRouter path, so neither is listed: the dialog HIDES the section for them rather
 * than offer a checkbox that would not route.
 */
export const OPENROUTER_CAPABLE_PRESETS: ReadonlySet<string> = new Set(['claude', 'opencode'])

/**
 * Overlay the OpenRouter model slug onto the builder values so the composed command's model
 * flag matches the routed provider — `claude --model <slug>` (Claude Code hands it to the
 * Anthropic-compatible endpoint verbatim) and `opencode --model openrouter/<slug>` (opencode
 * addresses providers by prefix; an already-prefixed slug is kept as-is). Pure; a blank slug
 * or a non-capable preset returns `values` unchanged (compose is untouched).
 */
export function applyOpenRouterModel(
  presetId: string,
  values: OptionValues,
  model: string | undefined
): OptionValues {
  const slug = model?.trim()
  if (!slug || !OPENROUTER_CAPABLE_PRESETS.has(presetId)) return values
  if (presetId === 'opencode') {
    return { ...values, model: slug.startsWith('openrouter/') ? slug : `openrouter/${slug}` }
  }
  return { ...values, model: slug }
}
