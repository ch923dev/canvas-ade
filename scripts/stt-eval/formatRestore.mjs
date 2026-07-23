// Deterministic code-formatting restoration (STT-ACCURACY.md §3.2).
//
// THE PROBLEM IT SOLVES. A good STT model HEARS an identifier's phonemes correctly but
// writes them in prose form: `contextIsolation` → "context isolation", `add_card` →
// "add card", `MessagePort` → "message port". The eval calls this the exact→loose gap:
// on gpt-4o-transcribe the model is ~87% loose but only ~69% exact, and every point of
// that gap is a KNOWN symbol spoken correctly and mis-spelled. This layer closes it with
// a dictionary lookup — no model, no network, no per-utterance knowledge.
//
// WHY IT IS NOT CHEATING. The dictionary is the repo's OWN symbol table (in production:
// CodeGraph / file-tree symbols; in the eval: the corpus's full keyterm set). It is ONE
// fixed set applied uniformly to every utterance — never the utterance's own answer. And
// crucially it is UNCAPPED, unlike the ≤30-term biasing prompt (§3.1): the long tail of
// symbols that cannot fit the prompt without hurting accuracy is recovered here instead.
// That division of labour — short prompt for the model, full dictionary for the rewrite —
// is the whole point of the two-layer design.
//
// HOW. Fold every symbol to its bare-alnum-lowercase form (`useVoiceCapture` →
// "usevoicecapture") and index canonical-by-fold. Then slide a window over the hypothesis
// words, longest-first, and where a run of words folds to a known symbol, replace the run
// with the canonical spelling. Whole words only (never a substring), so "ts" rewrites a
// standalone "ts" but never the "ts" inside "tsconfig". Ambiguous folds (two symbols that
// fold identically, e.g. add_card vs addCard) are DROPPED — we never guess which was meant.

import { foldIdentifier } from './wer.mjs'

/**
 * Number of spoken words a symbol expands to: camelCase humps and separators (- _ . /)
 * each start a new word. `modified_beam_search` → 3, `useVoiceCapture` → 3, `add_card` → 2.
 * Drives the max window width so multi-word symbols are matched whole.
 */
export function spokenSegments(symbol) {
  return symbol
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase hump
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMFollowed → ACRONYM Followed
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean).length
}

/**
 * Index canonical symbols by their folded form. Returns { byFold, maxSpan, dropped }.
 * A fold that maps to two different canonicals is AMBIGUOUS and removed — the layer must
 * never silently pick one spelling over another the user might have meant.
 */
export function buildSymbolMap(symbols) {
  const byFold = new Map()
  const ambiguous = new Set()
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

/** Split into an alternating stream of word tokens and the gaps (spaces/punctuation) between. */
function tokenize(text) {
  const tokens = []
  const re = /([A-Za-z0-9']+)|([^A-Za-z0-9']+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    tokens.push({ text: m[0], word: m[1] !== undefined })
  }
  return tokens
}

/**
 * True iff every gap BETWEEN the `len` word tokens starting at word `w` is pure whitespace.
 * Guards the multi-word matcher against merging words split by punctuation (see call site).
 */
function interWordGapsAreWhitespace(tokens, wordIdx, w, len) {
  for (let k = 0; k < len - 1; k++) {
    for (let t = wordIdx[w + k] + 1; t < wordIdx[w + k + 1]; t++) {
      if (!/^\s*$/.test(tokens[t].text)) return false
    }
  }
  return true
}

/**
 * Rewrite prose-form identifiers in `text` to their canonical spelling using `symbols`
 * (or a prebuilt map from buildSymbolMap). Greedy longest-match over word windows; the
 * gaps between matched words are consumed, everything else is preserved verbatim.
 */
export function restoreFormatting(text, symbols) {
  if (typeof text !== 'string' || !text) return text
  const map = symbols && symbols.byFold ? symbols : buildSymbolMap(symbols || [])
  if (map.byFold.size === 0) return text

  const tokens = tokenize(text)
  const wordIdx = tokens.map((t, i) => (t.word ? i : -1)).filter((i) => i >= 0)
  const out = []
  let cursor = 0 // index into `tokens` up to which we've emitted

  for (let w = 0; w < wordIdx.length; ) {
    let matched = null
    const maxLen = Math.min(map.maxSpan, wordIdx.length - w)
    for (let len = maxLen; len >= 1; len--) {
      // A multi-word match may only span words separated by PURE WHITESPACE. Without this,
      // "add. card" (two sentences) would fold to "addcard", match `add_card`, delete the
      // full stop and splice unrelated sentences into a fabricated identifier — a false
      // merge that gets likelier as the dictionary grows. A separator carrying any
      // non-space char (`.`/`,`/`(` …) means the words weren't spoken as one token.
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
