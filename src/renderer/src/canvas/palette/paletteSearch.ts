/**
 * Command-palette search (D4-A). Pure, dependency-free scoring: case-insensitive
 * word-prefix beats substring beats subsequence, earlier matches beat later ones.
 * Multi-token queries AND together (every token must match somewhere). Kept
 * deliberately simple — the corpus is a few dozen short verb titles, not documents.
 */

/** Score one query token against `text`. Higher = better; null = no match. */
function scoreToken(token: string, text: string): number | null {
  const t = text.toLowerCase()
  const idx = t.indexOf(token)
  if (idx === 0 || (idx > 0 && t[idx - 1] === ' ')) return 100 - Math.min(idx, 50)
  if (idx > 0) return 60 - Math.min(idx, 40)
  // Subsequence: every char in order, penalised by total spread.
  let from = 0
  let first = -1
  for (const ch of token) {
    const at = t.indexOf(ch, from)
    if (at < 0) return null
    if (first < 0) first = at
    from = at + 1
  }
  return Math.max(1, 30 - (from - first - token.length) - Math.min(first, 10))
}

/**
 * Score a whole query against a command's searchable text. Empty/whitespace query
 * matches everything at score 0 (the "show all" discoverability state).
 */
export function scoreMatch(query: string, text: string): number | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return 0
  let total = 0
  for (const token of tokens) {
    const s = scoreToken(token, text)
    if (s === null) return null
    total += s
  }
  return total
}

/**
 * Filter + rank `items` by `query`, preserving the input (section) order among
 * equal scores — a stable sort keeps the grouped layout calm while typing.
 */
export function rankMatches<T>(query: string, items: T[], textOf: (item: T) => string): T[] {
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = scoreMatch(query, textOf(item))
    if (score !== null) scored.push({ item, score })
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.item)
}
