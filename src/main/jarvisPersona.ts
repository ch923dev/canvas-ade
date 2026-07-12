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

/** Rolling-history prompt window: the most recent turns sent to the model. Older turns
 *  simply fall off in v1; J5 adds the rolling-summary compression (D4′). */
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
 * The frozen persona block — stable for a session as long as the config is unchanged.
 * jarvisBrain places it first in `system` with a cache breakpoint.
 */
export function composePersonaBlock(cfg: JarvisConfig): string {
  const tone =
    cfg.tonePreset === 'custom'
      ? cfg.customToneText.trim() || TONE_BLOCKS.butler
      : TONE_BLOCKS[cfg.tonePreset]
  return [
    `You are ${cfg.name}, the resident voice assistant inside Expanse — an infinite canvas desktop app for AI-assisted development where each item is a board (terminal, browser preview, planning whiteboard).`,
    tone,
    responseContract(cfg.verbosity),
    'A snapshot of the current canvas may be provided under "Workspace:". Ground any statement about boards, agents or layout in that snapshot; if it lacks the answer, say you cannot see it. Never invent board names or statuses.',
    'You cannot yet act on the canvas (no tools in this version). If asked to change something, say what you would do and that acting lands in an upcoming update.'
  ].join('\n\n')
}

/** Messages-API content block (text-only in J3). */
export interface JarvisContentBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

export interface JarvisMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * System array: [persona (cache breakpoint), workspace manifest (volatile, uncached)].
 * The cache prefix ends at the persona block, so a changing manifest never invalidates it.
 */
export function composeSystem(cfg: JarvisConfig, manifest: string | null): JarvisContentBlock[] {
  const system: JarvisContentBlock[] = [
    { type: 'text', text: composePersonaBlock(cfg), cache_control: { type: 'ephemeral' } }
  ]
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
