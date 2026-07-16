import { describe, it, expect } from 'vitest'
import { SPEAK_TEXT_CAP, createClauseChunker } from './clauseChunker'

describe('clauseChunker (J3 — clause-boundary streaming into TTS)', () => {
  it('emits nothing until a boundary arrives', () => {
    const c = createClauseChunker()
    expect(c.push('The tests')).toEqual([])
    expect(c.push(' pass')).toEqual([])
  })

  it('emits a sentence once its end + following space arrive', () => {
    const c = createClauseChunker()
    expect(c.push('The tests pass.')).toEqual([]) // no trailing space yet — could be "pass.io"
    expect(c.push(' Indeed')).toEqual(['The tests pass.'])
  })

  it('early first emit at a soft clause boundary once enough text buffered', () => {
    const c = createClauseChunker()
    const out = c.push('Focused the auth terminal, sir, the rest ')
    expect(out).toEqual(['Focused the auth terminal, sir,'])
  })

  it('after the first emit it waits for full sentences (no comma chatter)', () => {
    const c = createClauseChunker()
    c.push('Focused the auth terminal, sir, and then ')
    expect(c.push('some more words, with commas, everywhere ')).toEqual([])
    expect(c.push('until a period. And')).toEqual([
      'and then some more words, with commas, everywhere until a period.'
    ])
  })

  it('decimals and versions never split a sentence', () => {
    const c = createClauseChunker()
    expect(c.push('Pi is 3.14159 and the build is v0.16.0 today. Next')).toEqual([
      'Pi is 3.14159 and the build is v0.16.0 today.'
    ])
  })

  it('multiple sentences in one delta all emit, in order', () => {
    const c = createClauseChunker()
    expect(c.push('One done. Two done. Three is still going')).toEqual(['One done. Two done.'])
  })

  it('collapses newlines/whitespace in emitted clauses', () => {
    const c = createClauseChunker()
    expect(c.push('First\nline   done. More')).toEqual(['First line done.'])
  })

  it('flush returns the remainder and empties the buffer', () => {
    const c = createClauseChunker()
    c.push('Sentence one. And a trailing fragment')
    expect(c.flush()).toBe('And a trailing fragment')
    expect(c.flush()).toBeNull()
  })

  it('reset drops buffered text (barge-in)', () => {
    const c = createClauseChunker()
    c.push('Half a sentence that will never')
    c.reset()
    expect(c.flush()).toBeNull()
  })

  it('a runaway boundary-less stream force-splits well under the speak cap', () => {
    const c = createClauseChunker()
    const out = c.push('word '.repeat(200)) // 1000 chars, no sentence end
    expect(out.length).toBeGreaterThan(0)
    for (const clause of out) expect(clause.length).toBeLessThanOrEqual(SPEAK_TEXT_CAP)
  })
})
