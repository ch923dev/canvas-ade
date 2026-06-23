// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  buildSnapshotHtml,
  highlightSnapshotAsync,
  needsAsyncHighlight,
  resolveLanguage,
  snapshotImmediateHtml,
  SYNC_HIGHLIGHT_MAX_CHARS
} from './fileBoardSyntax'

// SLICE-008: the snapshot highlight now runs off the open-time critical path for large files —
// Lezer's incremental parser driven in time-sliced batches instead of one blocking `parser.parse`.
// The non-negotiable invariant: the async result is BYTE-IDENTICAL to the synchronous oracle
// (`buildSnapshotHtml`) for every file ≤ the highlight cap. These tests pin that, plus the
// threshold/placeholder/staleness contract the FileBoard host relies on.
describe('SLICE-008 — async snapshot highlight (fileBoardSyntax)', () => {
  const { parser } = resolveLanguage('ts')
  // A real TS unit, repeated to cross the async threshold (and likely span several parse slices).
  const UNIT = `export function add(a: number, b: number): number {
  // a representative line of real TypeScript with strings, numbers, and a regex
  const tag = 'sum=' + String(a + b)
  return /[0-9]+/.test(tag) ? a + b : 0xff
}
`
  const big = (chars: number): string => UNIT.repeat(Math.ceil(chars / UNIT.length))

  it('resolves a real TS parser (precondition)', () => {
    expect(parser).not.toBeNull()
  })

  it('async output is byte-identical to the synchronous oracle for a SMALL file', async () => {
    const code = big(5_000)
    expect(needsAsyncHighlight(code, parser)).toBe(false) // small ⇒ stays synchronous
    const html = await highlightSnapshotAsync(code, parser, () => false)
    expect(html).toBe(buildSnapshotHtml(code, parser))
    expect(html).toContain('<span style="color:') // actually highlighted
  })

  it('async output is byte-identical to the synchronous oracle for a LARGE (sliced) file', async () => {
    const code = big(SYNC_HIGHLIGHT_MAX_CHARS * 4) // ~120 KB ⇒ multiple time slices
    expect(needsAsyncHighlight(code, parser)).toBe(true)
    const html = await highlightSnapshotAsync(code, parser, () => false)
    expect(html).toBe(buildSnapshotHtml(code, parser))
    expect(html).toContain('<span style="color:')
  })

  it('the immediate placeholder for a large file is escaped plaintext (no spans)', () => {
    const code = big(SYNC_HIGHLIGHT_MAX_CHARS * 4)
    const immediate = snapshotImmediateHtml(code, parser)
    expect(immediate).not.toContain('<span')
    expect(immediate).toBe(buildSnapshotHtml(code, null)) // == the escaped plain-text fallback
  })

  it('the immediate snapshot for a small file is the full synchronous highlight', () => {
    const code = big(5_000)
    expect(snapshotImmediateHtml(code, parser)).toBe(buildSnapshotHtml(code, parser))
  })

  it('a request marked stale before it finishes resolves to null (caller drops it)', async () => {
    const code = big(SYNC_HIGHLIGHT_MAX_CHARS * 4)
    expect(await highlightSnapshotAsync(code, parser, () => true)).toBeNull()
  })

  it('no parser / over-cap ⇒ plaintext (async matches sync), never flagged for async', async () => {
    const code = big(5_000)
    expect(needsAsyncHighlight(code, null)).toBe(false)
    expect(await highlightSnapshotAsync(code, null, () => false)).toBe(
      buildSnapshotHtml(code, null)
    )

    const over = big(250_000) // > HIGHLIGHT_MAX_CHARS (200 KB)
    expect(needsAsyncHighlight(over, parser)).toBe(false)
    expect(await highlightSnapshotAsync(over, parser, () => false)).toBe(
      buildSnapshotHtml(over, parser)
    )
  })
})
