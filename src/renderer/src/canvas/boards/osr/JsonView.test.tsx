// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { JsonView } from './JsonView'

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

  it('renders binary bodies as a labeled passthrough (no tree)', () => {
    const { container } = render(
      <JsonView body="iVBORw0KGgo=" mime="image/png" base64={true} truncated={false} />
    )
    expect(container.textContent).toContain('[binary · base64]')
    expect(container.querySelector('.bb-net-json-rows')).toBeNull()
  })
})
