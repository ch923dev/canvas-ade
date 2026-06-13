/**
 * Agentic-CLI presets for the New Terminal dialog (Quick Start). Pure data + tiny
 * resolvers, no React — unit-testable in isolation.
 *
 * A preset is identity + a base launch command. The locked decision (CLAUDE.md ›
 * "Agentic CLI: open / agent-agnostic, user-configurable launchCommand") is preserved:
 * a preset only PRE-FILLS the free-text `launchCommand`; the raw string stays the source
 * of truth and the escape hatch. `agentKind` (the preset id) is persisted as board
 * identity and exposed to MCP via `canvas://boards`.
 *
 * `options` is the schema the A2 command builder renders (selects/toggles/text → CLI
 * flags). It is curated, NOT exhaustive — CLI flags drift across versions — and designed
 * to be user-extensible later. The Claude options are grounded in the real, current
 * `claude` flags (verified 2026-06-13); other agents carry a minimal starter set until
 * each is grounded the same way. Shell has no options (raw command only).
 */
import type { IconName } from '../../Icon'

/** One configurable option in the command builder; composes to a CLI fragment. */
export type AgentOption =
  | {
      id: string
      kind: 'select'
      label: string
      flag: string
      choices: { value: string; label: string }[]
    }
  | { id: string; kind: 'toggle'; label: string; flag: string; danger?: boolean }
  | { id: string; kind: 'text'; label: string; flag: string; placeholder?: string }

export interface AgentPreset {
  /** Stable key — also the persisted `TerminalBoard.agentKind`. */
  id: string
  /** Display label in the Quick Start row. */
  label: string
  /** Base launch command written as the first PTY line. Empty for the plain shell. */
  bin: string
  /** Monochrome brand glyph (Icon.tsx). */
  glyph: IconName
  /** Command-builder schema (A2). Absent ⇒ raw command only (e.g. shell). */
  options?: AgentOption[]
  /** Reserved for Phase C (orchestrator command board). Unused in A1/A2. */
  defaultRole?: 'orchestrator' | 'worker'
}

/** Claude option schema — grounded in the real `claude` CLI (verified 2026-06-13). */
const CLAUDE_OPTIONS: AgentOption[] = [
  {
    id: 'model',
    kind: 'select',
    label: 'Model',
    flag: '--model',
    choices: [
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
      { value: 'haiku', label: 'Haiku' },
      { value: 'fable', label: 'Fable' }
    ]
  },
  {
    id: 'effort',
    kind: 'select',
    label: 'Effort',
    flag: '--effort',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'X-High' },
      { value: 'max', label: 'Max' }
    ]
  },
  {
    id: 'permission-mode',
    kind: 'select',
    label: 'Permission mode',
    flag: '--permission-mode',
    choices: [
      { value: 'default', label: 'Default' },
      { value: 'acceptEdits', label: 'Accept edits' },
      { value: 'plan', label: 'Plan' },
      { value: 'auto', label: 'Auto' },
      { value: 'dontAsk', label: "Don't ask" },
      { value: 'bypassPermissions', label: 'Bypass permissions' }
    ]
  },
  { id: 'continue', kind: 'toggle', label: 'Continue last session', flag: '-c' },
  {
    id: 'resume',
    kind: 'text',
    label: 'Resume a session',
    flag: '--resume',
    placeholder: 'session id / name'
  },
  {
    id: 'skip-permissions',
    kind: 'toggle',
    label: 'Skip permission prompts',
    flag: '--dangerously-skip-permissions',
    danger: true
  },
  { id: 'bg', kind: 'toggle', label: 'Background session', flag: '--bg' },
  { id: 'add-dir', kind: 'text', label: 'Add directory', flag: '--add-dir', placeholder: 'path' },
  {
    id: 'mcp-config',
    kind: 'text',
    label: 'MCP config',
    flag: '--mcp-config',
    placeholder: 'json path / inline'
  }
]

// Starter schemas for the other agents, grounded in their docs/--help as of 2026-06-13
// (model ids drift, so Codex/OpenCode use a free-text model field rather than a wrong enum).
// Conservative on purpose — the composed command stays editable, so a missing flag is a quick
// manual add, while a WRONG enum value would silently launch a broken command.
const GEMINI_OPTIONS: AgentOption[] = [
  {
    id: 'model',
    kind: 'select',
    label: 'Model',
    flag: '-m',
    choices: [
      { value: 'gemini-2.5-pro', label: '2.5 Pro' },
      { value: 'gemini-2.5-flash', label: '2.5 Flash' }
    ]
  },
  { id: 'yolo', kind: 'toggle', label: 'Auto-approve (YOLO)', flag: '--yolo', danger: true },
  { id: 'sandbox', kind: 'toggle', label: 'Sandbox', flag: '--sandbox' }
]
const CODEX_OPTIONS: AgentOption[] = [
  { id: 'model', kind: 'text', label: 'Model', flag: '-m', placeholder: 'e.g. gpt-5-codex' },
  { id: 'full-auto', kind: 'toggle', label: 'Full auto', flag: '--full-auto', danger: true },
  { id: 'search', kind: 'toggle', label: 'Web search', flag: '--search' }
]
const OPENCODE_OPTIONS: AgentOption[] = [
  { id: 'model', kind: 'text', label: 'Model', flag: '--model', placeholder: 'provider/model' },
  { id: 'continue', kind: 'toggle', label: 'Continue last session', flag: '-c' }
]

export const AGENT_PRESETS: readonly AgentPreset[] = [
  {
    id: 'claude',
    label: 'Claude',
    bin: 'claude',
    glyph: 'agent-claude',
    options: CLAUDE_OPTIONS,
    defaultRole: 'worker'
  },
  { id: 'codex', label: 'Codex', bin: 'codex', glyph: 'agent-codex', options: CODEX_OPTIONS },
  { id: 'gemini', label: 'Gemini', bin: 'gemini', glyph: 'agent-gemini', options: GEMINI_OPTIONS },
  {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    glyph: 'agent-opencode',
    options: OPENCODE_OPTIONS
  },
  { id: 'shell', label: 'Shell', bin: '', glyph: 'agent-shell' }
]

/** Look up a preset by id (the persisted agentKind). */
export function presetById(id: string | undefined): AgentPreset | undefined {
  return id ? AGENT_PRESETS.find((p) => p.id === id) : undefined
}
