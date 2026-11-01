import { describe, expect, it } from 'vitest'
import {
  TIDY_ACK_MAX_UNITS,
  TIDY_ACK_WHY_MAX,
  TIDY_SCOPE_MAX_IDS,
  parseTidyArgs,
  sanitizeTidyAck,
  tidyResizes,
  type TidyArgs,
  type TidyArgsInput
} from './tidyContract'

const ok = (raw: TidyArgsInput): TidyArgs => {
  const r = parseTidyArgs(raw)
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`)
  return r.args
}
const err = (raw: TidyArgsInput): string => {
  const r = parseTidyArgs(raw)
  if (r.ok) throw new Error(`expected an error for ${JSON.stringify(raw)}`)
  return r.error
}

describe('parseTidyArgs (C5 — one rule set for MAIN and the renderer)', () => {
  it('D8 (a): an omitted mode is an IMPLICIT roles; an explicit roles is not implicit', () => {
    expect(ok({})).toEqual({ mode: 'roles', implicit: true })
    expect(ok({ mode: 'roles' })).toEqual({ mode: 'roles', implicit: false })
  })

  it('implicit:true round-trips only with roles (MAIN → renderer re-read)', () => {
    expect(ok({ mode: 'roles', implicit: true })).toEqual({ mode: 'roles', implicit: true })
    expect(err({ mode: 'fit', implicit: true })).toMatch(/implicit applies to mode roles only/)
    expect(err({ mode: 'roles', implicit: 'yes' })).toMatch(/implicit must be a boolean/)
  })

  it('template is required with tile and rejected otherwise', () => {
    expect(ok({ mode: 'tile', template: 'cols-3' })).toMatchObject({ template: 'cols-3' })
    expect(err({ mode: 'tile' })).toMatch(/template is required/)
    expect(err({ mode: 'fit', template: 'cols-3' })).toMatch(/only valid with mode 'tile'/)
    expect(err({ mode: 'tile', template: 'cols-9' })).toMatch(/unknown template/)
  })

  it('scopes: all / visible / { groupId } / { boardIds } (deduped, bounded)', () => {
    expect(ok({ scope: 'all' }).scope).toBe('all')
    expect(ok({ scope: 'visible' }).scope).toBe('visible')
    expect(ok({ scope: { groupId: 'g1' } }).scope).toEqual({ groupId: 'g1' })
    expect(ok({ scope: { boardIds: ['a', 'b', 'a'] } }).scope).toEqual({ boardIds: ['a', 'b'] })
    expect(err({ scope: 'everything' })).toMatch(/scope must be/)
    expect(err({ scope: { groupId: '' } })).toMatch(/groupId/)
    expect(err({ scope: { groupId: 'g', boardIds: [] } })).toMatch(/exactly one/)
    const many = Array.from({ length: TIDY_SCOPE_MAX_IDS + 1 }, (_, i) => `b${i}`)
    expect(err({ scope: { boardIds: many } })).toMatch(/up to 500/)
    expect(err({ scope: { boardIds: ['x'.repeat(201)] } })).toMatch(/board ids/)
  })

  it('overflow pages / shrink are fit / roles only; report is allowed everywhere', () => {
    expect(ok({ mode: 'fit', overflow: 'pages' }).overflow).toBe('pages')
    expect(ok({ overflow: 'shrink' }).overflow).toBe('shrink')
    expect(ok({ mode: 'grid', overflow: 'report' }).overflow).toBe('report')
    expect(err({ mode: 'smart', overflow: 'pages' })).toMatch(/fit \/ roles only/)
    expect(err({ mode: 'fit', overflow: 'scroll' })).toMatch(/unknown overflow/)
  })

  it('primary / resize are roles-only (explicit or implicit) and type-checked', () => {
    expect(ok({ primary: 'web-1', resize: false })).toMatchObject({
      mode: 'roles',
      implicit: true,
      primary: 'web-1',
      resize: false
    })
    expect(err({ mode: 'fit', primary: 'web-1' })).toMatch(/primary is roles-only/)
    expect(err({ mode: 'smart', resize: true })).toMatch(/resize is roles-only/)
    expect(err({ primary: 7 })).toMatch(/primary must be a board id/)
    expect(err({ resize: 'no' })).toMatch(/resize must be a boolean/)
    expect(err({ fit: 1 })).toMatch(/fit must be a boolean/)
  })

  it('an off-enum mode names the vocabulary', () => {
    expect(err({ mode: 'spiral' })).toMatch(/unknown mode "?spiral"? \(one of: fit, roles/)
  })
})

describe('tidyResizes (the W5 confirm must be honest about sizes)', () => {
  it('roles (unless resize:false), tile and shrink may resize; fit and the packers never do', () => {
    expect(tidyResizes(ok({}))).toBe(true)
    expect(tidyResizes(ok({ resize: false }))).toBe(false)
    expect(tidyResizes(ok({ mode: 'tile', template: 'grid' }))).toBe(true)
    expect(tidyResizes(ok({ mode: 'fit', overflow: 'shrink' }))).toBe(true)
    expect(tidyResizes(ok({ mode: 'fit' }))).toBe(false)
    expect(tidyResizes(ok({ mode: 'smart' }))).toBe(false)
  })
})

describe('sanitizeTidyAck (C6 — only clean facts reach the agent)', () => {
  it('moved defaults to 0 and floors; fitZoom rounds to 3 dp; pages only when > 1', () => {
    expect(sanitizeTidyAck({})).toEqual({ moved: 0 })
    expect(sanitizeTidyAck({ moved: 3.7, fitZoom: 0.12345, readable: false, pages: 3 })).toEqual({
      moved: 3,
      fitZoom: 0.123,
      readable: false,
      pages: 3
    })
    expect(sanitizeTidyAck({ moved: Infinity, fitZoom: 0, pages: 1 })).toEqual({ moved: 0 })
  })

  it('units are bounded in count, ids and string length; malformed rows drop', () => {
    const units = Array.from({ length: TIDY_ACK_MAX_UNITS + 5 }, (_, i) => ({
      scene: 'lead',
      heroIds: [`h${i}`, '', 'x'.repeat(201), ...Array.from({ length: 10 }, (_, j) => `k${j}`)],
      why: 'w'.repeat(TIDY_ACK_WHY_MAX + 50)
    }))
    const out = sanitizeTidyAck({ units: [null, { scene: 1, why: 'x' }, ...units] }).units!
    expect(out).toHaveLength(TIDY_ACK_MAX_UNITS - 2)
    expect(out[0].heroIds).toHaveLength(8)
    expect(out[0].heroIds[0]).toBe('h0')
    expect([...out[0].why]).toHaveLength(TIDY_ACK_WHY_MAX)
    expect(out[0].why.endsWith('…')).toBe(true)
    expect(sanitizeTidyAck({ units: ['junk'] })).toEqual({ moved: 0 })
  })
})
