// @vitest-environment jsdom
import { it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { PlanningToolbar } from './PlanningToolbar'
import type { PlanningBoard as PlanningBoardData } from '../../../lib/boardSchema'
import type { PlanTool } from './tools'

afterEach(cleanup)

const board = {
  id: 'b1',
  type: 'planning',
  title: 'Plan',
  x: 0,
  y: 0,
  w: 400,
  h: 300,
  elements: []
} as unknown as PlanningBoardData

function renderToolbar(tool: PlanTool = 'select' as PlanTool, snapEnabled = true): void {
  render(
    <PlanningToolbar
      board={board}
      tool={tool}
      snapEnabled={snapEnabled}
      onPickTool={() => {}}
      onToggleSnap={() => {}}
    />
  )
}

it('PLAN-02: every tool button exposes a human accessible name', () => {
  renderToolbar()
  for (const name of [
    'Select',
    'Sticky note',
    'Text',
    'Checklist',
    'Diagram',
    'Arrow',
    'Pen',
    'Eraser'
  ]) {
    expect(screen.getByRole('button', { name })).toBeTruthy()
  }
})

it('PLAN-03: each tool tooltip surfaces its shortcut letter', () => {
  renderToolbar()
  expect(screen.getByRole('button', { name: 'Sticky note' }).getAttribute('title')).toBe(
    'Sticky note (N)'
  )
  expect(screen.getByRole('button', { name: 'Text' }).getAttribute('title')).toBe('Text (X)')
  expect(screen.getByRole('button', { name: 'Diagram' }).getAttribute('title')).toBe('Diagram (D)')
})

it('PLAN-02: the active tool announces aria-pressed; inactive tools do not', () => {
  renderToolbar('note' as PlanTool)
  expect(screen.getByRole('button', { name: 'Sticky note' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('false')
})

it('PLAN-02: the snap toggle has a stable name + pressed state', () => {
  renderToolbar('select' as PlanTool, true)
  expect(screen.getByRole('button', { name: 'Snap to grid' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
})
