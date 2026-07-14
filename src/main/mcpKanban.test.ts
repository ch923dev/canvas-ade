import { describe, it, expect } from 'vitest'
import {
  buildAddCardOp,
  buildKanbanAxisConfig,
  buildMoveCardOp,
  buildRemoveCardOp,
  buildUpdateCardOp,
  KanbanContentError,
  renderKanbanAxisConfirmBody,
  renderKanbanConfirmBody,
  sanitizeCardFileRefs,
  sanitizeCardLabel,
  sanitizeCardTags,
  sanitizeCardText,
  sanitizeId,
  MAX_CARD_DESCRIPTION,
  MAX_CARD_TITLE
} from './mcpKanban'

describe('mcpKanban.sanitizeCardLabel', () => {
  it('collapses whitespace to single spaces and strips C0/C1/DEL controls', () => {
    expect(sanitizeCardLabel('a\tb\x07\x1b  c\nd', MAX_CARD_TITLE, 'title')).toBe('a b c d')
  })
  it('throws on a non-string, an empty-after-sanitize value, and an over-cap value', () => {
    expect(() => sanitizeCardLabel(5, 10, 'title')).toThrow(KanbanContentError)
    expect(() => sanitizeCardLabel('   ', 10, 'title')).toThrow(/empty/)
    expect(() => sanitizeCardLabel('x'.repeat(11), 10, 'title')).toThrow(/limit/)
  })
})

describe('mcpKanban.sanitizeId', () => {
  it('trims and returns a clean id', () => {
    expect(sanitizeId('  card-1 ', 200, 'cardId')).toBe('card-1')
  })
  it('rejects empty, over-cap, and control-bearing ids', () => {
    expect(() => sanitizeId('', 200, 'cardId')).toThrow(/empty/)
    expect(() => sanitizeId('x'.repeat(201), 200, 'cardId')).toThrow(/limit/)
    expect(() => sanitizeId('bad\x00id', 200, 'cardId')).toThrow(/control/)
  })
})

describe('mcpKanban op builders', () => {
  it('buildAddCardOp uses the minted id + sanitizes each field; drops absent chips', () => {
    const op = buildAddCardOp('mint-1', {
      columnId: 'backlog',
      title: '  Wire  auth  ',
      tag: 'feature'
    })
    expect(op).toEqual({
      op: 'add',
      card: { id: 'mint-1', columnId: 'backlog', title: 'Wire auth', tag: 'feature' }
    })
  })
  it('buildAddCardOp throws on a missing/empty required field', () => {
    expect(() => buildAddCardOp('m', { columnId: 'backlog', title: '' })).toThrow(
      KanbanContentError
    )
    expect(() => buildAddCardOp('m', { title: 'x' })).toThrow(/columnId/)
  })
  it('buildMoveCardOp + buildRemoveCardOp sanitize ids', () => {
    expect(buildMoveCardOp('c1', 'review')).toEqual({
      op: 'move',
      cardId: 'c1',
      toColumnId: 'review'
    })
    expect(buildRemoveCardOp(' c2 ')).toEqual({ op: 'remove', cardId: 'c2' })
  })
  it('buildUpdateCardOp keeps only supplied fields and requires at least one', () => {
    expect(buildUpdateCardOp('c1', { tag: 'shipped', ref: 'PR #9' })).toEqual({
      op: 'update',
      cardId: 'c1',
      patch: { tag: 'shipped', ref: 'PR #9' }
    })
    expect(() => buildUpdateCardOp('c1', {})).toThrow(/no fields/)
  })

  it('buildAddCardOp sanitizes the v19 detail fields (description / tags / fileRefs)', () => {
    const op = buildAddCardOp('mint-1', {
      columnId: 'backlog',
      title: 'Wire auth',
      description: 'Line one.\nLine two.\x07',
      tags: [' feature ', 'security', 'feature'], // dup dropped, trimmed
      fileRefs: [
        { path: ' src/auth/mw.ts ', line: 12, endLine: 20 },
        { path: 'src/auth/token.ts', line: 3, endLine: 2 } // endLine <= line ⇒ collapses to line
      ]
    })
    expect(op).toEqual({
      op: 'add',
      card: {
        id: 'mint-1',
        columnId: 'backlog',
        title: 'Wire auth',
        description: 'Line one.\nLine two.', // newline KEPT, control stripped, trimmed
        tags: ['feature', 'security'],
        fileRefs: [
          { path: 'src/auth/mw.ts', line: 12, endLine: 20 },
          { path: 'src/auth/token.ts', line: 3 }
        ]
      }
    })
  })

  it('buildUpdateCardOp carries the v19 detail fields', () => {
    expect(buildUpdateCardOp('c1', { description: 'done', tags: ['shipped'] })).toEqual({
      op: 'update',
      cardId: 'c1',
      patch: { description: 'done', tags: ['shipped'] }
    })
  })
})

describe('mcpKanban.sanitizeCardText (multi-line description)', () => {
  it('keeps newlines + tabs, normalizes CRLF, strips C0/C1/DEL, trims, caps', () => {
    expect(sanitizeCardText('a\r\nb\tc\x07\x9b', MAX_CARD_DESCRIPTION, 'description')).toBe(
      'a\nb\tc'
    )
    expect(() => sanitizeCardText('   ', 100, 'description')).toThrow(/empty/)
    expect(() => sanitizeCardText('x'.repeat(5), 4, 'description')).toThrow(/limit/)
    expect(() => sanitizeCardText(5, 4, 'description')).toThrow(/must be a string/)
  })
})

describe('mcpKanban.sanitizeCardTags', () => {
  it('trims, dedups (first wins), rejects a non-array / empty result / over-cap', () => {
    expect(sanitizeCardTags([' a ', 'b', 'a'])).toEqual(['a', 'b'])
    expect(() => sanitizeCardTags('nope')).toThrow(/must be an array/)
    expect(() => sanitizeCardTags(['   '])).toThrow(/empty/)
    expect(() => sanitizeCardTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow(/limit/)
  })
})

describe('mcpKanban.sanitizeCardFileRefs', () => {
  it('normalizes path/line/endLine and drops a non-range endLine', () => {
    expect(
      sanitizeCardFileRefs([
        { path: ' a.ts ', line: 5, endLine: 9 },
        { path: 'b.ts' },
        { path: 'c.ts', line: 4, endLine: 4 } // endLine === line ⇒ dropped
      ])
    ).toEqual([{ path: 'a.ts', line: 5, endLine: 9 }, { path: 'b.ts' }, { path: 'c.ts', line: 4 }])
  })
  it('rejects a non-array, a non-integer line, and an empty result', () => {
    expect(() => sanitizeCardFileRefs('nope')).toThrow(/must be an array/)
    expect(() => sanitizeCardFileRefs([{ path: 'a.ts', line: 0 }])).toThrow(/positive integer/)
    expect(() => sanitizeCardFileRefs([{ path: 'a.ts', line: 1.5 }])).toThrow(/positive integer/)
    expect(() => sanitizeCardFileRefs([{ path: '  ' }])).toThrow(/empty/)
  })
  it('rejects an over-cap path LOUDLY (must not survive the write to silently drop on the mirror read)', () => {
    // MAX_CARD_FILE_REF_PATH === 256 matches the boardRegistry mirror-ingest cap; a longer path is a
    // clear write error here, never an ack:true that vanishes from canvas://board/{id}/cards on read-back.
    expect(() => sanitizeCardFileRefs([{ path: 'x'.repeat(257) }])).toThrow(/limit/)
    expect(sanitizeCardFileRefs([{ path: 'x'.repeat(256) }])).toEqual([{ path: 'x'.repeat(256) }])
  })
})

describe('mcpKanban.buildKanbanAxisConfig', () => {
  it('accepts the two-value enum + a single-line label; requires ≥1 field', () => {
    expect(buildKanbanAxisConfig({ columnAxis: 'category', axisLabel: '  Subsystem ' })).toEqual({
      columnAxis: 'category',
      axisLabel: 'Subsystem'
    })
    expect(buildKanbanAxisConfig({ columnAxis: 'flow' })).toEqual({ columnAxis: 'flow' })
  })
  it('rejects an off-enum axis, an empty/over-cap label, and an empty config', () => {
    expect(() => buildKanbanAxisConfig({ columnAxis: 'sideways' })).toThrow(/flow.*category/)
    expect(() => buildKanbanAxisConfig({ axisLabel: '   ' })).toThrow(/empty/)
    expect(() => buildKanbanAxisConfig({ axisLabel: 'x'.repeat(61) })).toThrow(/limit/)
    expect(() => buildKanbanAxisConfig({})).toThrow(/no fields/)
  })
})

describe('mcpKanban.renderKanbanConfirmBody', () => {
  it('shows the exact op for each kind', () => {
    expect(
      renderKanbanConfirmBody('Plan', {
        op: 'add',
        card: { id: 'c1', columnId: 'backlog', title: 'T', tag: 'feature', assignee: 'claude' }
      })
    ).toMatch(/Add card to column "backlog": T.*feature.*@claude/s)
    expect(
      renderKanbanConfirmBody('Plan', { op: 'move', cardId: 'c1', toColumnId: 'review' })
    ).toMatch(/Move card c1 → column "review"/)
    expect(
      renderKanbanConfirmBody('Plan', { op: 'update', cardId: 'c1', patch: { tag: 'x' } })
    ).toMatch(/Update card c1 — tag: x/)
    expect(renderKanbanConfirmBody('Plan', { op: 'remove', cardId: 'c1' })).toMatch(
      /Remove card c1/
    )
  })

  it('shows the v19 detail fields on indented sub-lines (add)', () => {
    const body = renderKanbanConfirmBody('Plan', {
      op: 'add',
      card: {
        id: 'c1',
        columnId: 'backlog',
        title: 'T',
        tags: ['feature', 'security'],
        fileRefs: [{ path: 'a.ts', line: 1, endLine: 9 }, { path: 'b.ts' }],
        description: 'line one\nline two'
      }
    })
    expect(body).toContain('    tags: feature, security')
    expect(body).toContain('    files: a.ts:1-9, b.ts')
    expect(body).toContain('    description: line one')
    // 🔒 a multi-line description's continuation line is INDENTED, never a forged top-level "• " bullet.
    expect(body).toContain('\n      line two')
    expect(body).not.toMatch(/^• line two/m)
  })

  it('renders an update carrying ONLY detail fields (no inline chips)', () => {
    const body = renderKanbanConfirmBody('Plan', {
      op: 'update',
      cardId: 'c9',
      patch: { tags: ['shipped'] }
    })
    expect(body).toContain('• Update card c9')
    expect(body).toContain('    tags: shipped')
  })
})

describe('mcpKanban.renderKanbanAxisConfirmBody', () => {
  it('shows the axis + label the human is authorizing', () => {
    expect(
      renderKanbanAxisConfirmBody('Sprint', { columnAxis: 'category', axisLabel: 'Subsystem' })
    ).toMatch(/column axis of kanban board "Sprint".*axis: category.*label: Subsystem/s)
  })
})
