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
 * other C0 control chars (0x00–0x1F) + DEL (0x7F) — ESC and friends are a terminal-escape
 * injection surface and carry no legitimate command meaning here. The trailing CR that
 * actually submits the line is added by the caller, NEVER by this function.
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
  // Strip C0 controls (0x00–0x1F) + DEL (0x7F). CR/LF are already rejected above.
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) continue
    out += ch
  }
  return out
}
