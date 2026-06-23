import { describe, it, expect } from 'vitest'
import {
  looksJson,
  detectBodyKind,
  buildModel,
  initialCollapsed,
  visibleRows,
  reindent,
  stripBom,
  type JsonRow
} from './osrJson'

const scalars = (rows: JsonRow[]): JsonRow[] => rows.filter((r) => r.kind === 'scalar')

describe('looksJson / detectBodyKind', () => {
  it('detects JSON by mime or by a leading brace/bracket (BOM-tolerant)', () => {
    expect(looksJson('{"a":1}')).toBe(true)
    expect(looksJson('[1,2]')).toBe(true)
    expect(looksJson('42', 'application/json')).toBe(true)
    expect(looksJson('not json')).toBe(false)
    expect(looksJson('﻿{"a":1}')).toBe(true) // BOM-prefixed
  })

  it('classifies form payloads with no mime by sniffing key=value&…', () => {
    expect(detectBodyKind('a=1&b=2')).toBe('form')
    expect(detectBodyKind('user=bob', 'application/x-www-form-urlencoded')).toBe('form')
    expect(detectBodyKind('{"a":1}')).toBe('json')
    expect(detectBodyKind('hello world')).toBe('text')
    expect(detectBodyKind('iVBORw0KGgo', 'image/png', true)).toBe('binary')
  })
})

describe('buildModel — fidelity', () => {
  it('preserves duplicate keys (no dedupe) and flags the later one', () => {
    const { rows, meta } = buildModel('{"a":1,"a":2}', 'application/json')
    const members = scalars(rows).filter((r) => r.key === 'a')
    expect(members).toHaveLength(2)
    expect(members[0].valueText).toBe('1')
    expect(members[1].valueText).toBe('2')
    expect(members[1].duplicateKey).toBe(true)
    expect(meta.duplicateKeys).toBe(1)
  })

  it('preserves key order through a reindent round-trip', () => {
    const src = '{"z":1,"a":2,"m":3}'
    const out = reindent(src, 'application/json')
    expect(out.indexOf('"z"')).toBeLessThan(out.indexOf('"a"'))
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"m"'))
  })

  it('shows a big integer from the source, not a round-tripped float', () => {
    const { rows, meta } = buildModel('{"id":12345678901234567890}', 'application/json')
    const id = scalars(rows).find((r) => r.key === 'id')!
    expect(id.valueType).toBe('bigint')
    expect(id.valueText).toBe('12345678901234567890') // not 1.2345678901234568e19
    expect(meta.bigInts).toBe(1)
  })

  it('tolerates a truncated body — partial tree + a truncated marker, no throw', () => {
    const { rows, meta } = buildModel('{"a":1,"b":{"c":2', 'application/json')
    expect(meta.truncated).toBe(true)
    expect(meta.parseError).toBe(false)
    expect(rows.some((r) => r.truncatedHere)).toBe(true)
    expect(scalars(rows).find((r) => r.key === 'a')?.valueText).toBe('1')
    expect(scalars(rows).find((r) => r.key === 'c')?.valueText).toBe('2')
  })

  it('strips a BOM before scanning', () => {
    const { rows, meta } = buildModel('﻿{"ok":true}', 'application/json')
    expect(meta.parseError).toBe(false)
    expect(scalars(rows).find((r) => r.key === 'ok')?.valueType).toBe('bool')
    expect(stripBom('﻿x')).toBe('x')
  })

  it('renders form payloads as decoded kv rows', () => {
    const { rows, kind } = buildModel('name=jo+bob&city=N%C3%BCrnberg', undefined)
    expect(kind).toBe('form')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ key: 'name', valueText: 'jo bob' })
    expect(rows[1]).toMatchObject({ key: 'city', valueText: 'Nürnberg' })
  })

  it('the four non-tree states: empty, parse-junk, plain text, binary', () => {
    expect(buildModel('', undefined).rows[0]).toMatchObject({ valueType: 'raw', valueText: '' })

    const junk = buildModel('{"a": @bad}', 'application/json')
    expect(junk.meta.parseError).toBe(true) // gathered rows + flag, no throw
    expect(junk.kind).toBe('json')

    const text = buildModel('just a log line', undefined)
    expect(text.kind).toBe('text')
    expect(text.rows[0].valueType).toBe('raw')

    const bin = buildModel('iVBORw0KGgo=', 'image/png', true)
    expect(bin.kind).toBe('binary')
    expect(bin.rows[0].valueType).toBe('raw')
  })
})

describe('fold math', () => {
  const model = buildModel('{"a":1,"b":{"c":2,"d":[3,4]},"e":5}', 'application/json')

  it('collapses containers at depth ≥ 2 by default (top two levels open)', () => {
    const collapsed = initialCollapsed(model.rows)
    const vis = visibleRows(model.rows, collapsed)
    // depth-2 array [3,4] is collapsed → its elements 3 and 4 are hidden
    expect(vis.some((r) => r.valueText === '3')).toBe(false)
    expect(vis.some((r) => r.valueText === '4')).toBe(false)
    // its parent object {c,d} (depth 1) stays open → c is visible
    expect(vis.some((r) => r.key === 'c')).toBe(true)
  })

  it('hides a collapsed container through its matching close row', () => {
    const obj = model.rows.find((r) => r.key === 'b' && r.kind === 'open')!
    const vis = visibleRows(model.rows, new Set([obj.id]))
    // collapsing b hides c, d, and the inner array but keeps sibling e
    expect(vis.some((r) => r.key === 'c')).toBe(false)
    expect(vis.some((r) => r.key === 'd')).toBe(false)
    expect(vis.some((r) => r.key === 'e')).toBe(true)
    // the open row itself is still present (renders the summary)
    expect(vis.some((r) => r.id === obj.id)).toBe(true)
  })

  it('records childCount + a closeId on every container', () => {
    const root = model.rows[0]
    expect(root.kind).toBe('open')
    expect(root.childCount).toBe(3) // a, b, e
    expect(root.closeId).toBeDefined()
  })
})

describe('reindent', () => {
  it('is lossless for big ints and duplicate keys', () => {
    const src = '{"id":99999999999999999999,"x":1,"x":2}'
    const out = reindent(src, 'application/json')
    expect(out).toContain('99999999999999999999')
    expect(out.match(/"x"/g)).toHaveLength(2)
  })

  it('returns binary/non-JSON bodies verbatim', () => {
    expect(reindent('iVBORw0', 'image/png', true)).toBe('iVBORw0')
    expect(reindent('plain text', undefined)).toBe('plain text')
  })

  it('keeps empty containers on one line', () => {
    expect(reindent('{"a":{},"b":[]}', 'application/json')).toContain('{}')
    expect(reindent('{"a":{},"b":[]}', 'application/json')).toContain('[]')
  })
})
