import { describe, it, expect } from 'vitest'
import {
  buildAddCardOp,
  buildMoveCardOp,
  buildRemoveCardOp,
  buildUpdateCardOp,
  KanbanContentError,
  renderKanbanConfirmBody,
  sanitizeCardLabel,
  sanitizeId,
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
})
