/**
 * Jarvis J3 — the clause-boundary chunker (REVIEW §3.1: chunk at the FIRST clause
 * boundary, not the first period — best-in-class local pipelines stream 3–10-word clause
 * fragments into TTS). Incremental + pure: LLM text deltas in, speakable clauses out.
 * Each emitted clause goes to ONE `speakText()` call (the host FIFO serializes them;
 * `voice:tts:speak` caps an utterance at 2000 chars — MAX_CLAUSE stays far under it).
 */

/** The first emit may fire at a soft clause boundary (comma/semicolon) once this many
 *  chars are buffered — early first-audio while the sentence is still streaming. */
const MIN_FIRST_CLAUSE = 24
/** After the first emit, wait for full sentence boundaries (keeps prosody natural). */
const MAX_CLAUSE = 280
/** Hard bound guard: `voice:tts:speak` rejects > 2000 chars outright. */
export const SPEAK_TEXT_CAP = 2000

/** Sentence enders followed by whitespace/end. `3.14`/`v0.16` never match (no space). */
const SENTENCE_END = /[.!?…]+["')\]]?(?=\s)/g
/** Soft clause boundaries for the early first emit. */
const CLAUSE_END = /[,;:]["')\]]?(?=\s)/g

function lastMatchEnd(re: RegExp, text: string): number {
  re.lastIndex = 0
  let end = -1
  for (let m = re.exec(text); m; m = re.exec(text)) end = m.index + m[0].length
  return end
}

/** Normalize a clause for speech: collapse whitespace/newlines (prose contract — the
 *  persona prompt forbids markdown, this just makes stray formatting harmless). */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export interface ClauseChunker {
  /** Feed one streamed delta; returns zero or more complete clauses to speak. */
  push(delta: string): string[]
  /** Stream ended — returns the remaining buffered text (or null when empty). */
  flush(): string | null
  /** Barge-in: drop everything buffered. */
  reset(): void
}

export function createClauseChunker(): ClauseChunker {
  let buf = ''
  let emittedAny = false

  const take = (end: number): string => {
    const clause = buf.slice(0, end)
    buf = buf.slice(end)
    emittedAny = true
    return normalize(clause)
  }

  return {
    push(delta: string): string[] {
      buf += delta
      const out: string[] = []
      // Emit every completed sentence in the buffer.
      for (;;) {
        const end = lastMatchEnd(SENTENCE_END, buf)
        if (end < 0) break
        const clause = take(end)
        if (clause) out.push(clause)
      }
      // Early first-audio: no sentence yet, but a soft boundary and enough text.
      if (!emittedAny && buf.length >= MIN_FIRST_CLAUSE) {
        const end = lastMatchEnd(CLAUSE_END, buf)
        if (end >= MIN_FIRST_CLAUSE) {
          const clause = take(end)
          if (clause) out.push(clause)
        }
      }
      // Runaway sentence: force-split at the last space so no utterance nears the cap.
      while (buf.length > MAX_CLAUSE) {
        const cut = buf.lastIndexOf(' ', MAX_CLAUSE)
        const end = cut > MIN_FIRST_CLAUSE ? cut : MAX_CLAUSE
        const clause = take(end)
        if (clause) out.push(clause)
      }
      return out.filter((c) => c.length <= SPEAK_TEXT_CAP)
    },
    flush(): string | null {
      const rest = normalize(buf)
      buf = ''
      emittedAny = false
      return rest.length > 0 ? rest.slice(0, SPEAK_TEXT_CAP) : null
    },
    reset(): void {
      buf = ''
      emittedAny = false
    }
  }
}
