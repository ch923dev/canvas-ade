import { isInvisibleCodePoint } from '../shared/invisibleChars'

/**
 * 🔒 Dispatch payload sanitizer (M4 hardening, HIGH).
 *
 * A dispatch (`handoff_prompt` / `assign_prompt` / `relay_prompt`) writes the prompt into
 * a target board's PTY and the caller appends a SINGLE carriage return so the shell runs
 * ONE line. The human-confirm modal shows that one line and authorizes it. If the prompt
 * text itself carried an embedded CR/LF, the PTY would see multiple Enters → MULTIPLE
 * shell commands would run from a single approval (one confirm → N commands). That breaks
 * the M4 invariant "what the human approves is exactly what runs", and is the lethal-trifecta
 * lever (a worker's tainted output relayed + rubber-stamped).
 *
 * So: a dispatch is EXACTLY ONE command line. Reject any embedded CR/LF (the dispatch
 * fails — the agent must resend a single command, never silently flattened). Strip the
 * other C0 control chars (0x00-0x1F) + DEL (0x7F) + C1 controls (0x80-0x9F) — ESC and
 * friends are a terminal-escape injection surface and carry no legitimate command meaning
 * here; the C1 range is the 8-bit encoding of exactly those escapes (CSI/OSC/DCS/NEL).
 * The trailing CR that actually submits the line is added by the caller, NEVER by this
 * function.
 */
export class DispatchPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DispatchPayloadError'
  }
}

/**
 * Returns the prompt text reduced to a single safe command line, or throws
 * {@link DispatchPayloadError} if it contains an embedded CR/LF.
 */
export function sanitizeDispatchText(text: string): string {
  if (/[\r\n]/.test(text)) {
    throw new DispatchPayloadError(
      'dispatch payload contains an embedded newline (CR/LF); a dispatch must be a single command line'
    )
  }
  // Strip C0 controls (0x00-0x1F) + DEL (0x7F) + C1 controls (0x80-0x9F).
  // C1 are the 8-bit encodings of CSI/OSC/DCS/NEL etc. — same injection surface as C0.
  // CR/LF are already rejected above.
  // BUG-001: also strip every INVISIBLE code point (`shared/invisibleChars.ts`): the Unicode bidi
  // override/isolate + zero-width characters (Trojan Source class — the confirm dialog renders
  // through Chromium's Unicode Bidi Algorithm, so it can visually reorder the text differently from
  // the logical/PTY-executed byte sequence) AND the code points that render as nothing — variation
  // selectors, tag characters (ASCII smuggling: U+E0041 is an invisible "A" the PTY still receives),
  // soft hyphen, invisible operators, … Either kind defeats "what the human approves is exactly
  // what runs". Visible text is never touched.
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
    if (isInvisibleCodePoint(ch)) continue
    out += ch
  }
  return out
}
