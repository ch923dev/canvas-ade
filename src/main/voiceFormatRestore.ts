/**
 * Voice cloud STT — deterministic code-formatting restoration. TS port of
 * scripts/stt-eval/formatRestore.mjs (+ `foldIdentifier` from wer.mjs), STT-ACCURACY.md
 * §3.2 (PR #368). The measured 85.5% keyterm-exact depends on this layer; the algorithm
 * (fold + greedy longest-match) is byte-for-byte the harness's, so its 17 ported tests hold.
 *
 * THE PROBLEM. gpt-4o-transcribe HEARS an identifier correctly but writes it in prose form:
 * `contextIsolation` → "context isolation", `add_card` → "add card". On the measured run the
 * model is ~87% loose but only ~69% exact; every point of that exact→loose gap is a KNOWN
 * symbol spoken correctly and mis-spelled. This closes it with a dictionary lookup — the
 * repo's OWN symbol table (voiceSymbols.ts), applied uniformly to every utterance, UNCAPPED
 * (unlike the ≤30-term biasing prompt): the long tail that can't fit the prompt is recovered
 * here. No model, no network, no per-utterance knowledge. Runs MAIN-side inside the cloud
 * engine, on the final text, before it posts the transcript back to the renderer.
 */

/**
 * Identifier-shaped fold: case + every separator collapse away, so `useVoiceCapture`,
 * "use voice capture" and "use-voice-capture" all become `usevoicecapture` (wer.mjs).
 */
export function foldIdentifier(text: string): string {
  if (typeof text !== 'string') return ''
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Number of spoken words a symbol expands to: camelCase humps and separators (- _ . /)
 * each start a new word. `modified_beam_search` → 3, `useVoiceCapture` → 3, `add_card` → 2.
 * Drives the max window width so multi-word symbols are matched whole.
 */
export function spokenSegments(symbol: string): number {
  return symbol
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase hump
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMFollowed → ACRONYM Followed
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean).length
}

export interface SymbolMap {
  byFold: Map<string, string>
  maxSpan: number
  dropped: string[]
}

/**
 * Index canonical symbols by their folded form. A fold that maps to two different canonicals
 * is AMBIGUOUS and removed — the layer must never silently pick one spelling over another the
 * user might have meant (e.g. add_card vs addCard).
 */
export function buildSymbolMap(symbols: readonly string[]): SymbolMap {
  const byFold = new Map<string, string>()
  const ambiguous = new Set<string>()
  let maxSpan = 1
  for (const s of symbols) {
    if (typeof s !== 'string' || !s.trim()) continue
    const f = foldIdentifier(s)
    if (!f) continue
    if (byFold.has(f)) {
      if (byFold.get(f) !== s) ambiguous.add(f)
      continue
    }
    byFold.set(f, s)
    maxSpan = Math.max(maxSpan, spokenSegments(s))
  }
  for (const f of ambiguous) byFold.delete(f)
  return { byFold, maxSpan: Math.min(maxSpan, 8), dropped: [...ambiguous] }
}

interface Token {
  text: string
  word: boolean
}

/** Split into an alternating stream of word tokens and the gaps (spaces/punctuation) between. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const re = /([A-Za-z0-9']+)|([^A-Za-z0-9']+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    tokens.push({ text: m[0], word: m[1] !== undefined })
  }
  return tokens
}

/**
 * True iff every gap BETWEEN the `len` word tokens starting at word `w` is pure whitespace.
 * Guards the multi-word matcher against merging words split by punctuation (see call site).
 */
function interWordGapsAreWhitespace(
  tokens: Token[],
  wordIdx: number[],
  w: number,
  len: number
): boolean {
  for (let k = 0; k < len - 1; k++) {
    for (let t = wordIdx[w + k] + 1; t < wordIdx[w + k + 1]; t++) {
      if (!/^\s*$/.test(tokens[t].text)) return false
    }
  }
  return true
}

/**
 * Rewrite prose-form identifiers in `text` to their canonical spelling using `symbols` (a
 * string list or a prebuilt map from buildSymbolMap). Greedy longest-match over word windows;
 * the gaps between matched words are consumed, everything else is preserved verbatim.
 */
export function restoreFormatting(text: string, symbols: readonly string[] | SymbolMap): string {
  if (typeof text !== 'string' || !text) return text
  const map =
    'byFold' in (symbols as SymbolMap)
      ? (symbols as SymbolMap)
      : buildSymbolMap(symbols as string[])
  if (map.byFold.size === 0) return text

  const tokens = tokenize(text)
  const wordIdx = tokens.map((t, i) => (t.word ? i : -1)).filter((i) => i >= 0)
  const out: string[] = []
  let cursor = 0 // index into `tokens` up to which we've emitted

  for (let w = 0; w < wordIdx.length; ) {
    let matched: { len: number; canonical: string } | null = null
    const maxLen = Math.min(map.maxSpan, wordIdx.length - w)
    for (let len = maxLen; len >= 1; len--) {
      // A multi-word match may only span words separated by PURE WHITESPACE. Without this,
      // "add. card" (two sentences) would fold to "addcard", match `add_card`, delete the
      // full stop and splice unrelated sentences into a fabricated identifier — a false
      // merge that gets likelier as the dictionary grows.
      if (len > 1 && !interWordGapsAreWhitespace(tokens, wordIdx, w, len)) continue
      const fold = foldIdentifier(
        Array.from({ length: len }, (_, k) => tokens[wordIdx[w + k]].text).join('')
      )
      const canonical = map.byFold.get(fold)
      if (canonical) {
        matched = { len, canonical }
        break
      }
    }
    const startTok = wordIdx[w]
    // Emit any gap tokens sitting between the last cursor and this word, untouched.
    for (let i = cursor; i < startTok; i++) out.push(tokens[i].text)
    if (matched) {
      out.push(matched.canonical)
      const endTok = wordIdx[w + matched.len - 1]
      cursor = endTok + 1
      w += matched.len
    } else {
      out.push(tokens[startTok].text)
      cursor = startTok + 1
      w += 1
    }
  }
  // Trailing gap after the last word.
  for (let i = cursor; i < tokens.length; i++) out.push(tokens[i].text)
  return out.join('')
}
