import { describe, expect, it } from 'vitest'
import { nameOf, type WhyContext } from './roleWhy'

const ctxWith = (title: string): WhyContext => ({
  boards: new Map([['b8b4c254-0000', { id: 'b8b4c254-0000', type: 'browser' } as never]]),
  roles: new Map([['b8b4c254-0000', { role: 'preview' } as never]]),
  titles: { 'b8b4c254-0000': title }
})

describe('roleWhy — a title is safe to echo into the agent-facing ack (I2 P3)', () => {
  it('a plain title is quoted with its role noun; no title falls back to the short id', () => {
    expect(nameOf(ctxWith('App'), 'b8b4c254-0000')).toBe("browser 'App'")
    expect(nameOf(ctxWith(''), 'b8b4c254-0000')).toBe('browser #b8b4c254')
  })

  it('strips bidi overrides, zero-width and control characters (the shared group-name rule)', () => {
    const hostile = 'A\u202Epp\u200B\u2066x\u0007\u061C'
    expect(nameOf(ctxWith(hostile), 'b8b4c254-0000')).toBe("browser 'Appx'")
  })

  it('quotes are made typographic so a title cannot close the quoting', () => {
    expect(nameOf(ctxWith("it's"), 'b8b4c254-0000')).toBe("browser 'it’s'")
  })

  it('clamps by CODE POINT — an emoji at the cut is never split into a lone surrogate', () => {
    const title = `${'a'.repeat(38)}😀😀😀`
    const name = nameOf(ctxWith(title), 'b8b4c254-0000')
    const inner = name.slice("browser '".length, -1)
    expect([...inner]).toHaveLength(40)
    expect(inner).toBe(`${'a'.repeat(38)}😀…`)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(inner)).toBe(false)
  })
})
