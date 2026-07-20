// STT eval scorer (Phase 1.5 — docs/research/2026-07-21-cloud-voice-providers/STT-ACCURACY.md).
//
// Pure functions over strings: no I/O, no engine knowledge, unit-tested directly
// (wer.test.ts), exactly like scripts/e2e-scope.mjs.
//
// WHY TWO METRICS. For a dev tool, "did it get `useVoiceCapture` byte-exact" matters
// more than overall word accuracy — a transcript that is 95% right but mangles every
// identifier is useless for dictating code. So every run reports:
//
//   1. WER            — standard Levenshtein over aggressively normalised tokens.
//                       Formatting differences are deliberately normalised AWAY here
//                       so WER measures recognition, not punctuation style.
//   2. Keyterm recall — did the technical terms survive? Scored at two levels:
//        exact : the term appears verbatim (case-sensitive) in the raw hypothesis.
//        loose : it appears once case and separators (space - _ . /) are removed,
//                i.e. the engine heard the right phonemes but formatted it wrong
//                ("use voice capture" for `useVoiceCapture`).
//
// The exact→loose GAP is the actionable number: it is precisely the error class a
// deterministic replacement layer can recover (STT-ACCURACY.md §3.2). A provider with
// low exact but high loose recall is one post-processing pass away from being good;
// one with low loose recall genuinely did not hear the word.

/** Number words → digits, so "sixteen kilohertz" and "16 kilohertz" converge for WER. */
const NUMBER_WORDS = new Map([
  ['zero', '0'],
  ['one', '1'],
  ['two', '2'],
  ['three', '3'],
  ['four', '4'],
  ['five', '5'],
  ['six', '6'],
  ['seven', '7'],
  ['eight', '8'],
  ['nine', '9'],
  ['ten', '10'],
  ['eleven', '11'],
  ['twelve', '12'],
  ['thirteen', '13'],
  ['fourteen', '14'],
  ['fifteen', '15'],
  ['sixteen', '16'],
  ['seventeen', '17'],
  ['eighteen', '18'],
  ['nineteen', '19'],
  ['twenty', '20'],
  ['thirty', '30'],
  ['forty', '40'],
  ['fifty', '50'],
  ['sixty', '60'],
  ['seventy', '70'],
  ['eighty', '80'],
  ['ninety', '90'],
  ['hundred', '100']
])

/**
 * Disfluencies an engine may or may not emit depending on its formatting settings.
 * Dropping them from BOTH sides keeps WER a measure of recognition rather than of
 * whether the vendor happens to filter filler words.
 */
const FILLERS = new Set(['uh', 'um', 'erm', 'hmm', 'mhm', 'uhh', 'umm'])

/**
 * Tokenise for WER. Separators that carry CODE meaning (`-` `_` `.` `/`) are split on
 * rather than stripped, so `--no-verify` and "no verify" tokenise identically — the
 * formatting difference is scored by keyterm-exact recall instead, where it belongs.
 * Apostrophes are kept inside words ("don't" stays one token).
 */
export function normalizeTokens(text) {
  if (typeof text !== 'string') return []
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'") // smart quotes → ascii before we strip punctuation
    .replace(/[-_./\\]+/g, ' ')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/(^|\s)'+|'+(\s|$)/g, '$1$2') // leading/trailing apostrophes are punctuation
    .split(/\s+/)
    .filter((t) => t.length > 0 && !FILLERS.has(t))
    .map((t) => NUMBER_WORDS.get(t) ?? t)
}

/**
 * Identifier-shaped fold used by LOOSE keyterm matching: case and every separator
 * collapse away, so `useVoiceCapture`, "use voice capture" and "use-voice-capture"
 * all become `usevoicecapture`.
 */
export function foldIdentifier(text) {
  if (typeof text !== 'string') return ''
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Levenshtein alignment over token arrays, returning the edit breakdown (not just the
 * distance) so a report can say WHERE an engine loses — deletions usually mean dropped
 * audio, substitutions usually mean a misheard identifier.
 *
 * Full DP matrix: utterances here are ~10-30 tokens, so the O(n*m) memory is irrelevant
 * and the backtrace stays readable.
 */
export function alignTokens(refTokens, hypTokens) {
  const n = refTokens.length
  const m = hypTokens.length
  // d[i][j] = edit distance between ref[0..i) and hyp[0..j)
  const d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = d[i - 1][j - 1] + (refTokens[i - 1] === hypTokens[j - 1] ? 0 : 1)
      const del = d[i - 1][j] + 1 // a ref token with no hyp counterpart
      const ins = d[i][j - 1] + 1 // a hyp token with no ref counterpart
      d[i][j] = Math.min(sub, del, ins)
    }
  }
  // Backtrace. Ties prefer substitution → deletion → insertion; any consistent order
  // yields the same total distance, and this one keeps the counts stable across runs.
  let i = n
  let j = m
  let hits = 0
  let sub = 0
  let del = 0
  let ins = 0
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const same = refTokens[i - 1] === hypTokens[j - 1]
      if (d[i][j] === d[i - 1][j - 1] + (same ? 0 : 1)) {
        if (same) hits++
        else sub++
        i--
        j--
        continue
      }
    }
    if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      del++
      i--
      continue
    }
    ins++
    j--
  }
  return { hits, substitutions: sub, deletions: del, insertions: ins, distance: sub + del + ins }
}

/**
 * Word Error Rate. `rate` is (S+D+I)/N against the REFERENCE length, the standard
 * definition — note it is unbounded above (a hallucinating engine that emits 3x the
 * words can exceed 1.0, which is correct and worth seeing rather than clamping away).
 * An empty reference yields rate 0 for an empty hypothesis, else 1 per inserted token.
 */
export function wordErrorRate(reference, hypothesis) {
  const refTokens = normalizeTokens(reference)
  const hypTokens = normalizeTokens(hypothesis)
  const a = alignTokens(refTokens, hypTokens)
  const rate =
    refTokens.length === 0 ? (hypTokens.length === 0 ? 0 : 1) : a.distance / refTokens.length
  return { ...a, refWords: refTokens.length, hypWords: hypTokens.length, rate }
}

/**
 * Keyterm recall. Each term is scored independently against the RAW hypothesis:
 *   exact — verbatim, case-sensitive (what we actually want to paste into an editor)
 *   loose — identifier-folded (heard correctly, formatted wrong → recoverable)
 * `exact` implies `loose`; the per-term rows let a report list which terms an engine
 * reliably mangles, which is the input to the deterministic replacement layer.
 */
export function keytermRecall(hypothesis, keyterms) {
  const terms = Array.isArray(keyterms)
    ? keyterms.filter((t) => typeof t === 'string' && t.trim())
    : []
  const raw = typeof hypothesis === 'string' ? hypothesis : ''
  const folded = foldIdentifier(raw)
  const results = terms.map((term) => {
    const exact = raw.includes(term)
    const foldedTerm = foldIdentifier(term)
    // A term that folds to nothing (pure punctuation) can never be scored — treat as
    // missed rather than silently matching the empty string against everything.
    const loose = foldedTerm.length > 0 && folded.includes(foldedTerm)
    return { term, exact, loose }
  })
  const exactHits = results.filter((r) => r.exact).length
  const looseHits = results.filter((r) => r.loose).length
  return {
    total: terms.length,
    exactHits,
    looseHits,
    exactRate: terms.length === 0 ? null : exactHits / terms.length,
    looseRate: terms.length === 0 ? null : looseHits / terms.length,
    results
  }
}

/** Score one utterance end to end. */
export function scoreUtterance({ reference, hypothesis, keyterms = [] }) {
  return {
    wer: wordErrorRate(reference, hypothesis),
    keyterms: keytermRecall(hypothesis, keyterms)
  }
}

/**
 * Corpus-level roll-up. WER is aggregated the ONLY correct way — total edits over total
 * reference words — never as a mean of per-utterance rates, which would over-weight
 * short utterances (a 3-word clip with one error would count as much as a 30-word clip
 * with one error).
 */
export function aggregate(scores) {
  const totals = { substitutions: 0, deletions: 0, insertions: 0, refWords: 0 }
  let exactHits = 0
  let looseHits = 0
  let keytermTotal = 0
  for (const s of scores) {
    totals.substitutions += s.wer.substitutions
    totals.deletions += s.wer.deletions
    totals.insertions += s.wer.insertions
    totals.refWords += s.wer.refWords
    exactHits += s.keyterms.exactHits
    looseHits += s.keyterms.looseHits
    keytermTotal += s.keyterms.total
  }
  const distance = totals.substitutions + totals.deletions + totals.insertions
  return {
    utterances: scores.length,
    ...totals,
    distance,
    wer: totals.refWords === 0 ? null : distance / totals.refWords,
    keytermTotal,
    keytermExactHits: exactHits,
    keytermLooseHits: looseHits,
    keytermExactRate: keytermTotal === 0 ? null : exactHits / keytermTotal,
    keytermLooseRate: keytermTotal === 0 ? null : looseHits / keytermTotal
  }
}
