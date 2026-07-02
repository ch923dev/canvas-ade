import { describe, it, expect } from 'vitest'
import {
  buildPlanItems,
  renderVisualizeConfirmBody,
  resolveVisualization,
  VisualizeContentError
} from './mcpVisualize'

describe('mcpVisualize — buildPlanItems (validate + sanitize + cap)', () => {
  it('sanitizes short fields to single-line + keeps a multi-line note', () => {
    const plan = buildPlanItems(
      [
        {
          title: 'a\tb\x07  c',
          status: 'In\nProgress',
          tag: 'feat\x1bure',
          note: 'line1\n\n\n\nline2'
        }
      ],
      'My  Board\x07'
    )
    expect(plan.items[0].title).toBe('a b c') // tab collapsed, BEL stripped
    expect(plan.items[0].status).toBe('In Progress') // newline collapsed to a space (single-line)
    expect(plan.items[0].tag).toBe('feature') // ESC stripped
    expect(plan.items[0].note).toBe('line1\n\nline2') // note keeps newlines, 3+ blanks collapsed
    expect(plan.title).toBe('My Board')
  })

  it('omits absent optional fields', () => {
    const plan = buildPlanItems([{ title: 'only a title' }], undefined)
    expect(plan.items[0]).toEqual({ title: 'only a title' })
    expect(plan.title).toBeUndefined()
  })

  it('rejects a non-array, an empty plan, and a too-large plan', () => {
    expect(() => buildPlanItems('nope', undefined)).toThrow(VisualizeContentError)
    expect(() => buildPlanItems([], undefined)).toThrow(/no items/)
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ title: `t${i}` }))
    expect(() => buildPlanItems(tooMany, undefined)).toThrow(/too many items/)
  })

  it('rejects an item with an empty/non-string title (before any gate)', () => {
    expect(() => buildPlanItems([{ title: '   ' }], undefined)).toThrow(/title is empty/)
    expect(() => buildPlanItems([{ title: 42 }], undefined)).toThrow(/must be a string/)
    expect(() => buildPlanItems([{}], undefined)).toThrow(/must be a string/)
  })

  it('rejects a plan whose aggregate content exceeds MAX_PLAN_BYTES even though every item is individually within the per-field caps', () => {
    // 100 items (the count cap) × a near-max-length note/title/status/tag/assignee each — every
    // field passes its own per-field cap, but the SUM is well over the 16 KiB aggregate cap.
    const items = Array.from({ length: 100 }, () => ({
      title: 't'.repeat(200),
      status: 's'.repeat(60),
      tag: 'g'.repeat(40),
      assignee: 'a'.repeat(40),
      note: 'n'.repeat(2000)
    }))
    expect(() => buildPlanItems(items, undefined)).toThrow(/content too large/)
  })
})

describe('mcpVisualize — resolveVisualization', () => {
  it('passes a valid shape through', () => {
    expect(resolveVisualization('kanban')).toBe('kanban')
    expect(resolveVisualization('checklist')).toBe('checklist')
  })
  it('falls back to grid for absent/invalid', () => {
    expect(resolveVisualization(undefined)).toBe('grid')
    expect(resolveVisualization('bogus')).toBe('grid')
    expect(resolveVisualization(7)).toBe('grid')
  })
})

describe('mcpVisualize — renderVisualizeConfirmBody', () => {
  it('shows the full plan grouped by status + the suggestion (never a bare count)', () => {
    const plan = buildPlanItems(
      [
        { title: 'Audit tokens', status: 'backlog', tag: 'research' },
        { title: 'Wire PKCE', status: 'in progress', assignee: 'claude', note: 'use WorkOS' }
      ],
      'Auth plan'
    )
    const body = renderVisualizeConfirmBody(plan, 'kanban')
    expect(body).toContain('2-item plan')
    expect(body).toContain('Suggested layout: Kanban')
    expect(body).toContain('Board title: Auth plan')
    expect(body).toContain('[backlog]')
    expect(body).toContain('[in progress]')
    expect(body).toContain('Audit tokens')
    expect(body).toContain('research')
    expect(body).toContain('@claude')
    expect(body).toContain('use WorkOS') // the note body is shown in full
  })

  it('labels items without a status', () => {
    const plan = buildPlanItems([{ title: 'loose item' }], undefined)
    expect(renderVisualizeConfirmBody(plan, 'grid')).toContain('[no status]')
  })
})
