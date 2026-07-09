/**
 * Generic-PTY agent-lifecycle detection (desktop-notifications Phase 3) — the PURE half.
 *
 * Claude gets reliable hooks (see agentLifecycle.ts); every OTHER agentic CLI (Codex / Gemini /
 * opencode) gets best-effort signals inferred from PTY bytes + process lifecycle. Both detection
 * paths normalize to the SAME `LifecycleEvent` and converge on the one MAIN delivery site.
 *
 * This module holds only the decidable logic — exit-code classification + the conservative
 * idle-at-prompt heuristic — with NO electron / node-pty import, so it unit-tests in plain node
 * (mirroring agentLifecycle.ts). `pty.ts` owns the effectful wiring (the emitter seam, the session
 * scan, the port posts) and delegates the decisions here.
 */
import type { LifecycleEvent } from './agentLifecycle'
import { stripAnsi } from './ptyOutput'

/** One normalized generic-PTY lifecycle signal handed to the MAIN delivery site. */
export interface PtyLifecycleSignal {
  boardId: string
  event: LifecycleEvent
  /** The board's spawn cwd (notification context); absent when unknown. */
  cwd?: string
}

/** Injectable sink `pty.ts` calls on a normalized signal — index.ts wires it to the notifier. */
export type PtyLifecycleEmitter = (sig: PtyLifecycleSignal) => void

/**
 * Classify a PTY process exit into a lifecycle event: a clean exit (code 0) is `done`; any
 * non-zero code is `error`. A synchronous spawn failure (no exit code) is emitted as `error`
 * directly by the caller.
 */
export function classifyExit(exitCode: number): LifecycleEvent {
  return exitCode === 0 ? 'done' : 'error'
}

/**
 * Conservative "the last screen bytes are SOLICITING input" test. Deliberately matches only
 * interrogative / choice / credential / press-to-continue prompts — NOT a bare shell prompt
 * (`$` / `#` / `>` / `%`). An interactive terminal sitting idle at its shell prompt is *not*
 * "needs input"; treating it as such would fire on every idle shell (and on an agent that exited
 * back to the shell). Matching only prompts that ASK the user something keeps the heuristic quiet
 * unless something genuinely wants an answer — agent or plain script alike.
 *
 * The tail is ANSI-stripped, reduced to its last non-blank line, and trailing whitespace trimmed
 * before matching.
 */
export function looksLikePrompt(tail: string): boolean {
  const lines = stripAnsi(tail).split(/\r?\n/)
  let last = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      last = lines[i].replace(/\s+$/, '')
      break
    }
  }
  if (!last) return false
  // Ends with a question mark → a direct question ("Overwrite? ", "Continue? ").
  if (/\?$/.test(last)) return true
  // A yes/no affordance anywhere on the line: [y/n] (y/N) {yes/no} …
  if (/[([{]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]}]/i.test(last)) return true
  // Press-to-continue / arrow-key menu affordances (inquirer-style CLIs).
  if (/\b(press\s+(?:enter|return|any\s+key)|use\s+arrow\s+keys)\b/i.test(last)) return true
  // Credential / value prompts ending in a colon ("Password:", "Verification code:").
  if (/\b(password|passphrase|username|email|otp|verification\s+code|token)\s*:$/i.test(last))
    return true
  return false
}

/**
 * Composite idle-at-prompt decision (pure). Emit an `awaiting-input` signal only when a LIVE,
 * MONITORED session that is NOT already flagged has produced no output for at least `idleMs` AND
 * its last screen bytes look like an input-soliciting prompt. Every clause is a noise guard:
 *  - `running` — a spawning / exited / spawn-failed session never solicits.
 *  - `monitored` — the per-board `monitorActivity:false` opt-out silences it.
 *  - `alreadyAwaiting` — fire once per idle period; re-armed only when new output arrives.
 *  - `staleMs >= idleMs` — the output-silence dwell (a fresh prompt the user answers fast never fires).
 *  - {@link looksLikePrompt} — the tail must actually ask for input.
 */
export function isIdleAtPrompt(o: {
  running: boolean
  monitored: boolean
  alreadyAwaiting: boolean
  staleMs: number
  idleMs: number
  tail: string
}): boolean {
  if (!o.running || !o.monitored || o.alreadyAwaiting) return false
  if (o.staleMs < o.idleMs) return false
  return looksLikePrompt(o.tail)
}
