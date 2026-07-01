// @vitest-environment jsdom
/**
 * ElementInspectorSection (P4) — the always-visible Element controls. These pin the presentation
 * contract: which controls a given model surfaces (decision 3 gating), that typography is no-op-gated
 * (re-selecting the active token never emits — no phantom undo), and that every action fires the SAME
 * callback the context menu carries (the entries are shared verbatim). Rendering + wiring only; the
 * gating logic itself is unit-tested in elementModel.test.ts.
 *
 * globals: false — import vitest/testing-library helpers explicitly.
 */
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MenuEntry } from '../ElementContextMenu'
import { ElementInspectorSection } from './ElementInspectorSection'
import type { ElementInspectorModel, TypographyControls } from './usePlanningElementInspector'

afterEach(cleanup)

/** A full entry set (all ids the section looks up), each onSelect a spy. Override by id. */
function makeEntries(over: Partial<Record<string, Partial<MenuEntry>>> = {}): MenuEntry[] {
  const merge = <E extends MenuEntry>(base: E): E => ({ ...base, ...(over[base.id] as object) })
  return [
    merge({ kind: 'action', id: 'lock', label: 'Lock', onSelect: vi.fn() }),
    merge({ kind: 'action', id: 'group', label: 'Group', disabled: true, onSelect: vi.fn() }),
    merge({ kind: 'action', id: 'ungroup', label: 'Ungroup', disabled: true, onSelect: vi.fn() }),
    merge({ kind: 'action', id: 'duplicate', label: 'Duplicate', onSelect: vi.fn() }),
    merge({ kind: 'action', id: 'send-to-board', label: 'Send to board…', onSelect: vi.fn() }),
    merge({
      kind: 'swatchRow',
      id: 'tint',
      label: 'Tint',
      swatches: [
        { id: 'yellow', title: 'Yellow tint', fill: '#0', edge: '#0', onSelect: vi.fn() },
        {
          id: 'blue',
          title: 'Blue tint',
          fill: '#0',
          edge: '#0',
          current: true,
          onSelect: vi.fn()
        },
        { id: 'plain', title: 'Plain tint', fill: '#0', edge: '#0', onSelect: vi.fn() }
      ]
    }),
    merge({
      kind: 'iconRow',
      id: 'align',
      label: 'Align',
      buttons: [
        { id: 'left', title: 'Align left', icon: 'align-left', onSelect: vi.fn() },
        { id: 'right', title: 'Align right', icon: 'align-right', onSelect: vi.fn() }
      ]
    }),
    merge({
      kind: 'iconRow',
      id: 'distribute',
      label: 'Distribute',
      disabled: true,
      buttons: [
        { id: 'h', title: 'Distribute horizontally', icon: 'distribute-h', onSelect: vi.fn() }
      ]
    }),
    merge({ kind: 'action', id: 'delete', label: 'Delete', danger: true, onSelect: vi.fn() })
  ]
}

const typography = (over: Partial<TypographyControls['current']> = {}): TypographyControls => ({
  current: {
    fontFamily: 'sans',
    fontSize: 'M',
    align: 'left',
    color: 'default',
    bold: false,
    ...over
  },
  apply: vi.fn()
})

function model(over: Partial<ElementInspectorModel> = {}): ElementInspectorModel {
  return {
    count: 1,
    kindLabel: 'text',
    mixed: false,
    typography: null,
    showTint: false,
    showArrange: false,
    entries: makeEntries(),
    ...over
  }
}

describe('ElementInspectorSection', () => {
  it('a homogeneous text selection shows typography + no tint', () => {
    render(<ElementInspectorSection model={model({ typography: typography() })} />)
    expect(screen.getByRole('radiogroup', { name: 'Font family' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Font size' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Bold' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Text color' })).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Note tint' })).toBeNull()
  })

  it('typography apply is no-op-gated — active token does not emit, a new one does', () => {
    const typo = typography({ fontSize: 'M' })
    render(<ElementInspectorSection model={model({ typography: typo })} />)
    const sizes = screen.getByRole('radiogroup', { name: 'Font size' })
    // Re-selecting the ACTIVE size (M) must NOT emit (no phantom undo).
    fireEvent.click(within(sizes).getByRole('radio', { name: 'M' }))
    expect(typo.apply).not.toHaveBeenCalled()
    // A different size emits exactly that patch.
    fireEvent.click(within(sizes).getByRole('radio', { name: 'L' }))
    expect(typo.apply).toHaveBeenCalledWith({ fontSize: 'L' })
  })

  it('bold toggles to the opposite of the current value', () => {
    const typo = typography({ bold: false })
    render(<ElementInspectorSection model={model({ typography: typo })} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Bold' }))
    expect(typo.apply).toHaveBeenCalledWith({ bold: true })
  })

  it('a homogeneous note selection shows the tint row (not typography)', () => {
    const entries = makeEntries()
    render(
      <ElementInspectorSection model={model({ kindLabel: 'note', showTint: true, entries })} />
    )
    const tint = screen.getByRole('radiogroup', { name: 'Note tint' })
    expect(tint).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Font family' })).toBeNull()
    // The swatch fires the SAME entry callback the context menu carries.
    const tintEntry = entries.find((e) => e.id === 'tint')
    const onYellow = tintEntry?.kind === 'swatchRow' ? tintEntry.swatches[0].onSelect : undefined
    fireEvent.click(within(tint).getByRole('radio', { name: 'Yellow tint' }))
    expect(onYellow).toHaveBeenCalledTimes(1)
  })

  it('align/distribute appear only when showArrange is set', () => {
    const { rerender } = render(<ElementInspectorSection model={model({ showArrange: false })} />)
    expect(screen.queryByRole('group', { name: 'Align' })).toBeNull()
    rerender(<ElementInspectorSection model={model({ count: 2, showArrange: true })} />)
    expect(screen.getByRole('group', { name: 'Align' })).toBeTruthy()
  })

  it('shared actions are always present and fire their entry callbacks', () => {
    const entries = makeEntries()
    render(<ElementInspectorSection model={model({ entries })} />)
    const del = entries.find((e) => e.id === 'delete')
    const onDelete = del?.kind === 'action' ? del.onSelect : undefined
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    // Lock + duplicate + send are rendered.
    expect(screen.getByRole('button', { name: 'Lock' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send…' })).toBeTruthy()
  })

  it('the selection-count chip reflects count + mixed styling', () => {
    render(<ElementInspectorSection model={model({ count: 3, kindLabel: 'mixed', mixed: true })} />)
    const chip = screen.getByText('3')
    expect(chip).toBeTruthy()
    expect(chip.getAttribute('data-mixed')).toBe('true')
  })
})
