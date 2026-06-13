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

/** Quote an argument that contains whitespace so it survives as a single shell token. */
function quoteArg(v: string): string {
  return /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v
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
