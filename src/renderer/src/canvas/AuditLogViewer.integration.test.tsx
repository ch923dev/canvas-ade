import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import AuditLogViewer from './AuditLogViewer'

// `globals: false` → register RTL cleanup manually; also drop the window.api stub so
// tests don't leak the bridge into one another.
afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

interface FakeEntry {
  seq: number
  ts: number
  type: string
  targetId: string
  prompt: string
  nonce: string
  status: string
}

const entry = (over: Partial<FakeEntry> = {}): FakeEntry => ({
  seq: 1,
  ts: 0,
  type: 'handoff_prompt',
  targetId: 'board-x',
  prompt: 'echo hi',
  nonce: 'n1',
  status: 'completed',
  ...over
})

/** Stub the read-only `window.api.mcp.readAudit` bridge with a spy. */
function stubReadAudit(entries: FakeEntry[]): ReturnType<typeof vi.fn> {
  const read = vi.fn(async () => entries)
  ;(window as unknown as { api: unknown }).api = { mcp: { readAudit: read } }
  return read
}

// Mirrors the deleted `dispatch-audit` e2e probe's renderer half: an audit entry read
// back through the bridge must render in the viewer (the `[data-audit-seq]` row). The
// MAIN persist + `audit:read` IPC half is covered by auditLog/auditIpc (unit/integration).
describe('AuditLogViewer (integration)', () => {
  it('opens via the launcher, reads the trail, and renders a row per entry', async () => {
    const read = stubReadAudit([
      entry({ seq: 7, prompt: 'CANVAS_E2E_AUDIT_PROBE', status: 'dispatched' })
    ])
    const { container } = render(<AuditLogViewer />)

    // Closed: only the corner launcher shows, no list yet.
    expect(container.querySelector('[data-audit-seq]')).toBeNull()
    fireEvent.click(screen.getByText('Audit'))

    await waitFor(() => expect(read).toHaveBeenCalledWith({ limit: 200 }))
    await waitFor(() => expect(container.querySelector('[data-audit-seq="7"]')).not.toBeNull())
    // The dispatched prompt + status render in the row.
    expect(screen.getByText('CANVAS_E2E_AUDIT_PROBE')).toBeTruthy()
    expect(screen.getByText('dispatched')).toBeTruthy()
    expect(screen.getByText('→ board-x')).toBeTruthy()
  })

  it('MCP-01: the open panel is a labeled complementary landmark, not a dialog', async () => {
    stubReadAudit([])
    render(<AuditLogViewer />)
    fireEvent.click(screen.getByText('Audit'))
    const panel = await screen.findByRole('complementary', { name: /mcp dispatch audit log/i })
    expect(panel).toBeTruthy()
    // It's a persistent side panel, not a modal overlay — must NOT expose a dialog role.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the empty state and no rows when the trail is empty', async () => {
    stubReadAudit([])
    const { container } = render(<AuditLogViewer />)
    fireEvent.click(screen.getByText('Audit'))
    await waitFor(() => expect(screen.getByText('No dispatch events recorded.')).toBeTruthy())
    expect(container.querySelector('[data-audit-seq]')).toBeNull()
  })

  it('Refresh re-reads the trail', async () => {
    const read = stubReadAudit([entry()])
    render(<AuditLogViewer />)
    fireEvent.click(screen.getByText('Audit'))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTitle('Refresh'))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  })

  it('renders one row per entry, newest-first order preserved from the bridge', async () => {
    stubReadAudit([
      entry({ seq: 9, status: 'completed' }),
      entry({ seq: 8, status: 'denied' }),
      entry({ seq: 7, status: 'rejected' })
    ])
    const { container } = render(<AuditLogViewer />)
    fireEvent.click(screen.getByText('Audit'))
    await waitFor(() => expect(container.querySelectorAll('[data-audit-seq]')).toHaveLength(3))
    const seqs = Array.from(container.querySelectorAll('[data-audit-seq]')).map((el) =>
      el.getAttribute('data-audit-seq')
    )
    expect(seqs).toEqual(['9', '8', '7'])
  })
})
