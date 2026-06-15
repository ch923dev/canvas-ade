import { describe, it, expect } from 'vitest'
import {
  cleanDiagramError,
  safeDiagramId,
  renderDiagram,
  DIAGRAM_MAX_SOURCE
} from './diagramWorker'

// Pure helpers only — the actual render path needs an Electron BrowserWindow (covered by the
// @planning diagram e2e + the dev check). `renderDiagram` is tested only on its input-validation
// guards, which short-circuit BEFORE touching a window (so they run fine under vitest/node).

describe('cleanDiagramError', () => {
  it('strips the Error: prefix and collapses whitespace', () => {
    expect(cleanDiagramError('Error:   Parse error on line 2:\n  foo')).toBe(
      'Parse error on line 2: foo'
    )
  })
  it('bounds the length so a hostile source cannot flood the toast', () => {
    const out = cleanDiagramError('x'.repeat(5000))
    expect(out.length).toBeLessThanOrEqual(301)
    expect(out.endsWith('…')).toBe(true)
  })
  it('falls back to a generic message for an empty input', () => {
    expect(cleanDiagramError('')).toBe('diagram render failed')
  })
})

describe('safeDiagramId', () => {
  it('strips non-id characters', () => {
    expect(safeDiagramId('a b/c<>"d')).toBe('abcd')
  })
  it('prefixes a leading non-letter so the SVG id is valid', () => {
    expect(safeDiagramId('123')).toBe('d123')
    expect(safeDiagramId('')).toBe('d0')
    expect(safeDiagramId('-x')).toBe('d-x')
  })
})

describe('renderDiagram input guards', () => {
  it('rejects a non-string / empty / oversized source without opening a window', async () => {
    expect(await renderDiagram({ source: 123 as never, id: 'a' })).toEqual({
      ok: false,
      error: 'source must be a string'
    })
    expect(await renderDiagram({ source: '', id: 'a' })).toEqual({
      ok: false,
      error: 'empty diagram source'
    })
    const big = await renderDiagram({ source: 'x'.repeat(DIAGRAM_MAX_SOURCE + 1), id: 'a' })
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.error).toMatch(/exceeds/)
  })
})
