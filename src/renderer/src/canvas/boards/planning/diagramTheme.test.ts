// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { diagramTypeLabel, buildDiagramThemeVars } from './diagramTheme'

describe('diagramTypeLabel', () => {
  it('reads the dialect from the first source token', () => {
    expect(diagramTypeLabel('graph TD\n A-->B')).toBe('flowchart')
    expect(diagramTypeLabel('flowchart LR\n A-->B')).toBe('flowchart')
    expect(diagramTypeLabel('sequenceDiagram\n A->>B: hi')).toBe('sequence')
    expect(diagramTypeLabel('erDiagram\n A ||--o{ B : x')).toBe('ER')
    expect(diagramTypeLabel('   classDiagram')).toBe('class')
    expect(diagramTypeLabel('mystery code')).toBe('diagram')
  })
})

describe('buildDiagramThemeVars — single-accent, neutral-elsewhere contract', () => {
  const vars = buildDiagramThemeVars()
  const accent = '#4f8cff'

  it('uses the accent ONLY on active/selected keys (no rainbow on base surfaces)', () => {
    // The accent is the one saturated colour, reserved for active/selected emphasis.
    expect(vars.activeTaskBkgColor).toBe(accent)
    expect(vars.activeTaskBorderColor).toBe(accent)
    // Base node/edge/text surfaces must NOT be the accent.
    for (const key of ['background', 'mainBkg', 'primaryColor', 'lineColor', 'textColor']) {
      expect(vars[key]).not.toBe(accent)
    }
  })

  it('themes to Geist + neutral dark surfaces', () => {
    expect(vars.fontFamily).toMatch(/Geist/)
    expect(vars.background).toBe('#141416')
    expect(vars.primaryColor).toBe('#1a1a1d')
  })
})
