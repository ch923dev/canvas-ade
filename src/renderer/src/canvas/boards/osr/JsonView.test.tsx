// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { JsonView } from './JsonView'
import { useToastStore } from '../../../store/toastStore'

afterEach(cleanup)

describe('JsonView — security', () => {
  it('escapes page-controlled HTML in values (no raw injection, no <script> node)', () => {
    const evil = '{"x":"<script>alert(1)</script><img src=x onerror=1>"}'
    const { container } = render(<JsonView body={evil} mime="application/json" base64={false} />)
    // The literal text is shown…
    expect(container.textContent).toContain('<script>alert(1)</script>')
    // …but never as live nodes (React text-escaped — no dangerouslySetInnerHTML anywhere).
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('JsonView — tree', () => {
  it('folds and unfolds a container on click', () => {
    const { container } = render(
      <JsonView body='{"arr":[1,2,3,4]}' mime="application/json" base64={false} />
    )
    // depth-1 array is open by default → elements visible
    expect(container.textContent).toContain('1')
    const openRow = container.querySelector('.bb-net-json-open') as HTMLElement
    expect(openRow).toBeTruthy()
    fireEvent.click(openRow) // collapse
    expect(container.querySelector('.bb-net-json-rows')?.textContent).not.toContain('3')
    fireEvent.click(openRow) // expand again
    expect(container.querySelector('.bb-net-json-rows')?.textContent).toContain('3')
  })

  it('shows a big integer verbatim with a 64-bit chip', () => {
    const { container } = render(
      <JsonView body='{"id":12345678901234567890}' mime="application/json" base64={false} />
    )
    expect(container.textContent).toContain('12345678901234567890')
    expect(container.textContent).toContain('64-bit')
  })

  it('switches to Raw mode showing re-indented source', () => {
    render(<JsonView body='{"a":1,"b":2}' mime="application/json" base64={false} />)
    fireEvent.click(screen.getByText('Raw'))
    const pre = document.querySelector('.bb-net-bodytext') as HTMLElement
    expect(pre).toBeTruthy()
    expect(pre.textContent).toContain('"a": 1')
  })

  it('copies a value to the clipboard and shows a toast on click', () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    useToastStore.setState({ toasts: [] })
    const { container } = render(
      <JsonView body='{"name":"hello world"}' mime="application/json" base64={false} />
    )
    fireEvent.click(container.querySelector('.bb-net-json-val') as HTMLElement)
    // JSON string copies its content without the surrounding quotes.
    expect(writeText).toHaveBeenCalledWith('hello world')
    expect(useToastStore.getState().toasts.some((t) => /copied/i.test(t.message))).toBe(true)
  })

  it('renders binary bodies as a labeled passthrough (no tree)', () => {
    const { container } = render(
      <JsonView body="iVBORw0KGgo=" mime="image/png" base64={true} truncated={false} />
    )
    expect(container.textContent).toContain('[binary · base64]')
    expect(container.querySelector('.bb-net-json-rows')).toBeNull()
  })
})

describe('JsonView — JD-2 enrichments', () => {
  const openSearch = (): HTMLInputElement => {
    fireEvent.click(screen.getByRole('button', { name: 'Find in body' }))
    return screen.getByRole('searchbox') as HTMLInputElement
  }

  it('opens a URL value externally (never copies, never in-app nav)', () => {
    const openExternalPreview = vi.fn(() => Promise.resolve(true))
    ;(window as unknown as { api: unknown }).api = { openExternalPreview }
    const { container } = render(
      <JsonView body='{"u":"https://x.test/a"}' mime="application/json" base64={false} />
    )
    const link = container.querySelector('.bb-net-json-link') as HTMLElement
    expect(link).toBeTruthy()
    fireEvent.click(link)
    expect(openExternalPreview).toHaveBeenCalledWith('https://x.test/a')
  })

  it('search highlights matches and jumps to one inside a collapsed subtree (auto-expand)', () => {
    const { container } = render(
      <JsonView body='{"a":{"b":{"c":"findme"}}}' mime="application/json" base64={false} />
    )
    const rows = (): string => container.querySelector('.bb-net-json-rows')?.textContent ?? ''
    // "c" is at depth 3 inside the depth-2 (default-collapsed) container → hidden initially.
    expect(rows()).not.toContain('findme')

    const input = openSearch()
    fireEvent.change(input, { target: { value: 'findme' } })
    // Typing highlights only; Enter steps onto the match → un-collapses its ancestors → now visible.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(rows()).toContain('findme')
    const match = container.querySelector('.bb-net-json-match') as HTMLElement
    expect(match).toBeTruthy()
    expect(match.textContent).toBe('findme')
    // No injected markup — the highlight is React text spans, never innerHTML.
    expect(container.querySelector('script')).toBeNull()
  })

  it('match highlight over a script-bearing value adds no live nodes', () => {
    const { container } = render(
      <JsonView body='{"x":"<script>hi</script>"}' mime="application/json" base64={false} />
    )
    const input = openSearch()
    fireEvent.change(input, { target: { value: 'script' } })
    expect(container.querySelector('.bb-net-json-match')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
  })

  it('exposes a tree role + keeps aria-activedescendant on a mounted row', () => {
    const { container } = render(
      <JsonView body='{"a":1,"b":2,"c":3}' mime="application/json" base64={false} />
    )
    const tree = container.querySelector('[role="tree"]') as HTMLElement
    expect(tree).toBeTruthy()
    expect(container.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(0)

    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    const active = tree.getAttribute('aria-activedescendant')
    expect(active).toBeTruthy()
    // the referenced row must exist in the (virtualized) DOM
    expect(container.querySelector(`#${active}`)).toBeTruthy()
  })

  it('copy/expand keys are a safe no-op when no row is active (guards vis[-1])', () => {
    const writeText = vi.fn((_text: string) => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const { container } = render(
      <JsonView body='{"a":{"x":1}}' mime="application/json" base64={false} />
    )
    const tree = container.querySelector('[role="tree"]') as HTMLElement
    // No selection (activeId null → ai === -1). A copy/expand key must bail before reading the
    // current row, not throw on vis[-1] (the [warning] the reviewer flagged on the stale-active path).
    expect(() => fireEvent.keyDown(tree, { key: 'c' })).not.toThrow()
    expect(() => fireEvent.keyDown(tree, { key: 'p' })).not.toThrow()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('pressing "p" on a close-brace row copies nothing (no bogus "$" path)', () => {
    const writeText = vi.fn((_text: string) => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const { container } = render(<JsonView body='{"a":1}' mime="application/json" base64={false} />)
    const tree = container.querySelector('[role="tree"]') as HTMLElement
    // visible = [ '{' open, a:1 scalar, '}' close ] → ArrowDown ×3 lands the active row on the close.
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    fireEvent.keyDown(tree, { key: 'p' })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('embedded mode does not intercept Ctrl+F (parent panel shortcut preserved)', () => {
    const { container } = render(
      <JsonView body='{"a":1}' mime="application/json" base64={false} embedded />
    )
    // No find affordance in embedded mode…
    expect(container.querySelector('.bb-net-json-findbtn')).toBeNull()
    // …and onRootKeyDown bails before preventDefault/stopPropagation, leaving Ctrl+F for the parent.
    const root = container.querySelector('.bb-net-json') as HTMLElement
    const notCancelled = fireEvent.keyDown(root, { key: 'f', ctrlKey: true })
    expect(notCancelled).toBe(true)
  })

  it('copies a property path via the row affordance', () => {
    const writeText = vi.fn((_text: string) => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    useToastStore.setState({ toasts: [] })
    const { container } = render(
      <JsonView body='{"profile":{"email":"a@b.c"}}' mime="application/json" base64={false} />
    )
    const pathBtn = container.querySelector(
      '.bb-net-json-pathbtn[aria-label="Copy property path"]'
    ) as HTMLElement
    expect(pathBtn).toBeTruthy()
    fireEvent.click(pathBtn)
    expect(writeText).toHaveBeenCalled()
    expect(writeText.mock.calls[0][0].startsWith('$')).toBe(true)
    expect(useToastStore.getState().toasts.some((t) => /path copied/i.test(t.message))).toBe(true)
  })
})
