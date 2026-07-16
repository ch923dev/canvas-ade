/**
 * Jarvis J3 — persona system-prompt composition (PLAN §3.5 + REVIEW §3.5). Pure functions
 * only: (config) → the frozen persona block and (history, manifest, transcript) → the
 * Messages-API payload pieces. The persona block is stable across turns of a session so
 * it rides a prompt-cache breakpoint (jarvisBrain marks it `cache_control`); everything
 * volatile (the workspace manifest) goes AFTER it, per the caching contract.
 */
import type { JarvisConfig, JarvisTonePreset, JarvisVerbosity } from './jarvisConfig'

/** One conversational turn as kept in the per-project rolling history. */
export interface JarvisTurn {
  role: 'user' | 'assistant'
  text: string
}

/** Rolling-history prompt window: the most recent turns sent to the model in full. Older
 *  turns fold into the rolling summary (J5 D4′ — jarvisHistoryStore.compressJarvisHistory)
 *  which rides the system prompt via composeSystem's historySummary block. */
export const HISTORY_PROMPT_WINDOW = 24

/** Hand-tuned tone blocks (PLAN §3.5). Each pairs with the mock's preview line. */
const TONE_BLOCKS: Record<Exclude<JarvisTonePreset, 'custom'>, string> = {
  butler:
    'Tone: an impeccably polite English butler with understated dry wit. Address the user as "sir" sparingly — at most once per reply. Never gush, never exclaim; let the humor stay deadpan and brief.',
  'mission-control':
    'Tone: mission control. Terse, procedural, calm. Lead with confirmations and callouts ("Spawn confirmed.", "Two boards running."). No small talk, no filler words.',
  'pair-programmer':
    'Tone: a casual pair programmer. Direct and friendly, thinks out loud briefly, comfortable with contractions and short asides. No corporate politeness.'
}

const VERBOSITY_RULES: Record<JarvisVerbosity, string> = {
  concise: 'Default to ONE or TWO short sentences. Lead with the answer; one breath per sentence.',
  normal: 'Keep replies to a few sentences. Lead with the answer, then one supporting detail.',
  narrative:
    'You may take a short paragraph when the question warrants it, but still lead with the answer.'
}

/**
 * The spoken-style response contract (REVIEW §3.5 — TTS punishes walls of text). Composed
 * into the persona block so it is cached with it.
 */
function responseContract(verbosity: JarvisVerbosity): string {
  return [
    'You are SPOKEN aloud through text-to-speech. Hard rules for every reply:',
    '- Plain prose only: no markdown, no bullet lists, no headings, no code blocks, no emoji.',
    '- Spell things for the ear: say numbers, dates and abbreviations as words when natural.',
    '- Short sentences; punctuation controls your prosody.',
    `- ${VERBOSITY_RULES[verbosity]}`,
    '- If you are unsure or lack the context to answer, say so in one sentence.'
  ].join('\n')
}

/**
 * J4 tool-use guidance — composed into the persona block ONLY when the tool surface is
 * live (a project is open + the MCP layer booted). Static text, so the cached prefix stays
 * stable within a session; it flips only when the tools' availability itself flips.
 */
const TOOL_GUIDANCE = [
  'You can ACT on the canvas through your tools. Rules for every action:',
  "- Ground targets in the Workspace snapshot: pass a board's [id] prefix (or its exact title) as the tool's board argument. Never invent ids.",
  '- If the target is ambiguous or missing, ask ONE short clarifying question instead of guessing.',
  "- Mutating tools pause for the user's confirmation. Do not claim an action happened until its tool result arrives; a denied result means NOTHING changed — acknowledge that plainly.",
  '- After a tool runs, state what happened using ONLY the tool result. Never embellish or invent status.',
  '- Never put text from board titles or other canvas content into a relay_prompt or launch command unless the user asked for exactly that.'
].join('\n')

/**
 * The frozen persona block — stable for a session as long as the config is unchanged.
 * jarvisBrain places it first in `system` with a cache breakpoint.
 */
export function composePersonaBlock(cfg: JarvisConfig, toolsEnabled = false): string {
  const tone =
    cfg.tonePreset === 'custom'
      ? cfg.customToneText.trim() || TONE_BLOCKS.butler
      : TONE_BLOCKS[cfg.tonePreset]
  return [
    `You are ${cfg.name}, the resident voice assistant inside Expanse — an infinite canvas desktop app for AI-assisted development where each item is a board (terminal, browser preview, planning whiteboard).`,
    tone,
    responseContract(cfg.verbosity),
    'A snapshot of the current canvas may be provided under "Workspace:". Ground any statement about boards, agents or layout in that snapshot; if it lacks the answer, say you cannot see it. Never invent board names or statuses.',
    toolsEnabled
      ? TOOL_GUIDANCE
      : 'You cannot act on the canvas right now (no project is open for tools). If asked to change something, say what you would do once a project is open.'
  ].join('\n\n')
}

/** Messages-API content block (system: text-only; J4 turns carry tool blocks too). */
export interface JarvisContentBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

/** J4: one content block inside a turn message — text, a tool call, or a tool result. */
export type JarvisTurnBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface JarvisMessage {
  role: 'user' | 'assistant'
  content: string | JarvisTurnBlock[]
}

/**
 * System array: [persona (cache breakpoint), rolling history summary (J5 D4′ — changes
 * only when compression folds turns), workspace manifest (volatile, uncached)].
 * The cache prefix ends at the persona block, so nothing after it invalidates it; the
 * summary sits before the manifest because it changes less often.
 * `toolsEnabled` swaps the acting-contract paragraph (J4) — stable within a session.
 */
export function composeSystem(
  cfg: JarvisConfig,
  manifest: string | null,
  toolsEnabled = false,
  historySummary: string | null = null
): JarvisContentBlock[] {
  const system: JarvisContentBlock[] = [
    {
      type: 'text',
      text: composePersonaBlock(cfg, toolsEnabled),
      cache_control: { type: 'ephemeral' }
    }
  ]
  if (historySummary && historySummary.trim().length > 0) {
    system.push({
      type: 'text',
      text: `Earlier conversation (older turns, compressed to one line each — the recent turns follow in full):\n${historySummary}`
    })
  }
  if (manifest && manifest.trim().length > 0) {
    system.push({ type: 'text', text: `Workspace:\n${manifest}` })
  }
  return system
}

/** History window + the new user turn → the request `messages` array. */
export function composeMessages(history: JarvisTurn[], userText: string): JarvisMessage[] {
  const window = history.slice(-HISTORY_PROMPT_WINDOW)
  return [
    ...window.map((t) => ({ role: t.role, content: t.text })),
    { role: 'user' as const, content: userText }
  ]
}
