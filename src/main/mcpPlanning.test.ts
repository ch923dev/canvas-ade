import { describe, it, expect } from 'vitest'
import {
  buildPlanningOps,
  PlanningContentError,
  renderPlanningConfirmBody,
  sanitizePlanningText,
  MAX_PLANNING_ELEMENTS,
  MAX_PLANNING_ITEMS,
  MAX_PLANNING_TEXT
} from './mcpPlanning'

describe('sanitizePlanningText', () => {
  it('keeps newlines + tabs (a note is multi-line) but strips other control chars', () => {
    const out = sanitizePlanningText('a\nb\tc\x07\x1b[31m', MAX_PLANNING_TEXT, 'f')
    expect(out).toBe('a\nb\tc[31m') // BEL + ESC stripped; the literal "[31m" tail remains
  })

  it('normalizes CRLF / lone CR to LF', () => {
    expect(sanitizePlanningText('a\r\nb\rc', MAX_PLANNING_TEXT, 'f')).toBe('a\nb\nc')
  })

  it('trims and rejects empty-after-sanitization', () => {
    expect(sanitizePlanningText('  hi  ', MAX_PLANNING_TEXT, 'f')).toBe('hi')
    expect(() => sanitizePlanningText('   \x00 ', MAX_PLANNING_TEXT, 'f')).toThrow(
      PlanningContentError
    )
  })

  it('rejects a non-string and an over-length field', () => {
    expect(() => sanitizePlanningText(42, MAX_PLANNING_TEXT, 'f')).toThrow(PlanningContentError)
    expect(() =>
      sanitizePlanningText('x'.repeat(MAX_PLANNING_TEXT + 1), MAX_PLANNING_TEXT, 'f')
    ).toThrow(PlanningContentError)
  })
})

describe('buildPlanningOps', () => {
  it('validates + normalizes each kind (tint default, done default false)', () => {
    const ops = buildPlanningOps([
      { kind: 'note', text: 'hi' }, // no tint → default
      {
        kind: 'checklist',
        title: 'Plan',
        items: [{ label: 'a' }, { label: 'b', done: true }] // a.done defaults false
      },
      { kind: 'text', text: 'see ADR' },
      { kind: 'arrow', dx: 10, dy: -20 }
    ])
    expect(ops[0]).toEqual({ kind: 'note', text: 'hi', tint: 'yellow' })
    expect(ops[1]).toMatchObject({
      kind: 'checklist',
      title: 'Plan',
      items: [
        { label: 'a', done: false },
        { label: 'b', done: true }
      ]
    })
    expect(ops[2]).toEqual({ kind: 'text', text: 'see ADR' })
    expect(ops[3]).toEqual({ kind: 'arrow', dx: 10, dy: -20 })
  })

  it('builds a diagram op (Mermaid source sanitized + kept multi-line, engine stamped)', () => {
    const ops = buildPlanningOps([{ kind: 'diagram', source: 'graph TD\n  A-->B' }])
    expect(ops[0]).toEqual({ kind: 'diagram', engine: 'mermaid', source: 'graph TD\n  A-->B' })
  })

  it('rejects a diagram with a non-string / empty source', () => {
    expect(() => buildPlanningOps([{ kind: 'diagram', source: 42 }])).toThrow(PlanningContentError)
    expect(() => buildPlanningOps([{ kind: 'diagram', source: '   ' }])).toThrow(
      PlanningContentError
    )
  })

  it('rejects an unknown / unsupported kind (stroke is a draw primitive, not agent content)', () => {
    expect(() => buildPlanningOps([{ kind: 'stroke', points: [0, 0] }])).toThrow(
      PlanningContentError
    )
    expect(() => buildPlanningOps([{ kind: 'doodle', squiggle: true }])).toThrow(
      PlanningContentError
    )
  })

  it('rejects an invalid tint and a non-array / empty batch', () => {
    expect(() => buildPlanningOps([{ kind: 'note', text: 'x', tint: 'rainbow' }])).toThrow(
      PlanningContentError
    )
    expect(() => buildPlanningOps([])).toThrow(PlanningContentError)
    expect(() => buildPlanningOps('nope')).toThrow(PlanningContentError)
  })

  it('CAP: rejects more than the per-call element limit', () => {
    const many = Array.from({ length: MAX_PLANNING_ELEMENTS + 1 }, () => ({
      kind: 'note',
      text: 'n'
    }))
    expect(() => buildPlanningOps(many)).toThrow(/too many elements/)
  })

  it('CAP: rejects more than the per-checklist item limit', () => {
    const items = Array.from({ length: MAX_PLANNING_ITEMS + 1 }, (_, i) => ({ label: `i${i}` }))
    expect(() => buildPlanningOps([{ kind: 'checklist', title: 'T', items }])).toThrow(
      PlanningContentError
    )
  })

  it('CAP: rejects a batch over the total byte budget', () => {
    // A handful of near-max notes blows the 16 KB total well within the 50-element count cap.
    const big = Array.from({ length: 6 }, () => ({
      kind: 'note',
      text: 'x'.repeat(MAX_PLANNING_TEXT)
    }))
    expect(() => buildPlanningOps(big)).toThrow(/too large/)
    // Sanity: the same count of SMALL notes is fine (it's bytes, not count, that tripped).
    expect(
      buildPlanningOps(Array.from({ length: 6 }, () => ({ kind: 'note', text: 'ok' })))
    ).toHaveLength(6)
  })

  it('the byte cap is measured on CLEANED ops (control-char padding cannot dodge it)', () => {
    // Padding with stripped control chars does not count toward the budget.
    const padded = [{ kind: 'note', text: 'hi' + '\x07'.repeat(50_000) }]
    const ops = buildPlanningOps(padded)
    expect(ops[0]).toEqual({ kind: 'note', text: 'hi', tint: 'yellow' })
  })

  describe('section tag (2a column control)', () => {
    it('carries an optional section on every kind', () => {
      const ops = buildPlanningOps([
        { kind: 'note', text: 'n', section: 'Overview' },
        { kind: 'checklist', title: 'T', items: [{ label: 'a' }], section: 'Setup' },
        { kind: 'text', text: 't', section: 'Notes' },
        { kind: 'arrow', dx: 1, dy: 1, section: 'Flow' },
        { kind: 'diagram', source: 'graph TD\n A-->B', section: 'Arch' }
      ])
      expect(ops.map((o) => o.section)).toEqual(['Overview', 'Setup', 'Notes', 'Flow', 'Arch'])
    })

    it('omits section entirely when absent (no key on the op)', () => {
      const [op] = buildPlanningOps([{ kind: 'note', text: 'n' }])
      expect('section' in op).toBe(false)
    })

    it('collapses a multi-line / padded section to a single line (no confirm-body forgery)', () => {
      const [op] = buildPlanningOps([{ kind: 'note', text: 'n', section: '  Set\nup\t\x07 ' }])
      expect(op.section).toBe('Set up') // newline+tab → space, control stripped, trimmed
    })

    it('drops a section that is empty after sanitization (falls back to no section)', () => {
      const [op] = buildPlanningOps([{ kind: 'note', text: 'n', section: '  \x00 \n ' }])
      expect('section' in op).toBe(false)
    })

    it('🔒 strips [ and ] so a section cannot blur the [label] confirm boundary', () => {
      const [op] = buildPlanningOps([{ kind: 'note', text: 'n', section: 'Build] Note: injected' }])
      expect(op.section).toBe('Build Note: injected') // brackets gone → no boundary spoof
      const body = renderPlanningConfirmBody('P', [op])
      // Exactly one '[' / ']' pair survives — the genuine wrapper the host adds, not the agent's.
      expect((body.match(/\[/g) ?? []).length).toBe(1)
      expect((body.match(/\]/g) ?? []).length).toBe(1)
      expect(body).toContain('• [Build Note: injected] Note: n')
    })

    it('rejects an over-long section (cap) and a non-string section', () => {
      expect(() =>
        buildPlanningOps([{ kind: 'note', text: 'n', section: 'S'.repeat(61) }])
      ).toThrow(PlanningContentError)
      expect(() => buildPlanningOps([{ kind: 'note', text: 'n', section: 42 }])).toThrow(
        PlanningContentError
      )
    })
  })
})

describe('renderPlanningConfirmBody', () => {
  it('shows the FULL content (every note body + every checklist item), not a bare count', () => {
    const ops = buildPlanningOps([
      { kind: 'note', text: 'audit mw' },
      {
        kind: 'checklist',
        title: 'Auth refactor',
        items: [{ label: 'done item', done: true }, { label: 'todo item' }]
      }
    ])
    const body = renderPlanningConfirmBody('My Plan', ops)
    expect(body).toContain('My Plan')
    expect(body).toContain('audit mw')
    expect(body).toContain('Auth refactor')
    expect(body).toContain('☑ done item')
    expect(body).toContain('☐ todo item')
  })

  it('shows a diagram op as the FULL Mermaid source (so the human sees what will render)', () => {
    const ops = buildPlanningOps([{ kind: 'diagram', source: 'graph TD\n  A[Plan]-->B[Build]' }])
    const body = renderPlanningConfirmBody('P', ops)
    expect(body).toContain('Diagram')
    expect(body).toContain('graph TD')
    expect(body).toContain('A[Plan]-->B[Build]')
  })

  it('🔒 multi-line content cannot spoof a top-level "• " bullet (indents continuation lines)', () => {
    // A crafted note tries to forge a fake top-level checklist bullet via an embedded newline.
    const ops = buildPlanningOps([
      { kind: 'note', text: 'real text\n• Checklist "Critical":\n☑ sneaky item' }
    ])
    const body = renderPlanningConfirmBody('P', ops)
    // The forged line must NOT appear flush-left (which would mimic a genuine bullet); it is
    // indented under the note instead. No line other than the genuine one starts with "• Note".
    const bulletLines = body.split('\n').filter((l) => l.startsWith('• '))
    expect(bulletLines).toEqual(['• Note: real text'])
    expect(body).not.toMatch(/^• Checklist/m) // the injected fake bullet is indented, not flush
    expect(body).toContain('  • Checklist') // it survives, but visibly nested
  })

  it('🔒 collapses 3+ blank-line floods so padded whitespace cannot push content off-screen', () => {
    const ops = buildPlanningOps([
      { kind: 'note', text: `a${'\n'.repeat(40)}b` },
      { kind: 'note', text: 'visible tail' }
    ])
    const body = renderPlanningConfirmBody('P', ops)
    expect(body).not.toMatch(/\n{3,}/) // no run of 3+ newlines survives
    expect(body).toContain('visible tail') // the later element is still rendered
  })

  it('surfaces an element section as a [label] prefix so the human sees the column structure', () => {
    const ops = buildPlanningOps([
      { kind: 'note', text: 'goal', section: 'Overview' },
      { kind: 'checklist', title: 'Setup', items: [{ label: 'env' }], section: 'Setup' }
    ])
    const body = renderPlanningConfirmBody('P', ops)
    expect(body).toContain('• [Overview] Note: goal')
    expect(body).toContain('• [Setup] Checklist "Setup"')
  })
})
