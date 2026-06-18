// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, configure } from '@testing-library/react'
import {
  OrchestrationSyncModal,
  type SyncStatusData,
  type SyncRowResult
} from './OrchestrationSyncModal'

// The repo tags hooks with `data-test` (not testing-library's default `data-testid`).
configure({ testIdAttribute: 'data-test' })

afterEach(cleanup)

const STATUS: SyncStatusData = {
  endpoint: { host: '127.0.0.1', port: 52141, maskedToken: '••••••' },
  rows: [
    {
      id: 'claude',
      label: 'Claude Code',
      configLabel: '.mcp.json + settings.local',
      detected: true
    },
    { id: 'codex', label: 'Codex CLI', configLabel: '~/.codex/config.toml', detected: true },
    { id: 'gemini', label: 'Gemini CLI', configLabel: '~/.gemini/settings.json', detected: true },
    { id: 'opencode', label: 'OpenCode', configLabel: 'opencode.json', detected: false }
  ]
}

describe('OrchestrationSyncModal', () => {
  it('renders the masked endpoint + per-CLI detect badges + the project baseline row', () => {
    render(<OrchestrationSyncModal status={STATUS} onSync={vi.fn()} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: /sync agent orchestration/i })
    const endpoint = within(dialog).getByTestId('orch-sync-endpoint')
    expect(endpoint.textContent).toContain('127.0.0.1:52141/mcp')
    expect(endpoint.textContent).toContain('••••••')
    expect(endpoint.textContent).toMatch(/rotates on restart/i)
    // Detected vs not-installed honesty.
    expect(within(dialog).getByTestId('orch-sync-row-gemini').textContent).toContain('detected')
    expect(within(dialog).getByTestId('orch-sync-row-opencode').textContent).toContain(
      'not installed'
    )
    // Always-on project baseline row.
    expect(within(dialog).getByTestId('orch-sync-row-project').textContent).toContain('always')
  })

  it('shows a loading state until detection arrives', () => {
    render(<OrchestrationSyncModal status={null} onSync={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('orch-sync-endpoint').textContent).toMatch(/detecting endpoint/i)
  })

  it('not-installed CLIs default off + their checkbox is disabled', () => {
    render(<OrchestrationSyncModal status={STATUS} onSync={vi.fn()} onClose={vi.fn()} />)
    const opencode = screen.getByTestId('orch-sync-check-opencode') as HTMLButtonElement
    expect(opencode.disabled).toBe(true)
    expect(opencode.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('orch-sync-check-claude').getAttribute('aria-checked')).toBe('true')
  })

  it('Sync now runs the detected CLIs and renders per-row results', async () => {
    const results: SyncRowResult[] = [
      { id: 'claude', status: 'synced', detail: 'Wrote .mcp.json', path: '.mcp.json' },
      { id: 'codex', status: 'error', detail: 'boom' },
      { id: 'gemini', status: 'synced', detail: 'Wrote ~/.gemini/settings.json' }
    ]
    const onSync = vi.fn().mockResolvedValue(results)
    render(<OrchestrationSyncModal status={STATUS} onSync={onSync} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('orch-sync-now'))
    expect(onSync).toHaveBeenCalledWith(['claude', 'codex', 'gemini'])

    await screen.findByTestId('orch-sync-result-claude')
    expect(screen.getByTestId('orch-sync-result-claude').textContent).toContain('synced')
    expect(screen.getByTestId('orch-sync-result-codex').textContent).toContain('failed')
  })

  it('toggling a detected CLI off removes it from the sync set', () => {
    const onSync = vi.fn().mockResolvedValue([])
    render(<OrchestrationSyncModal status={STATUS} onSync={onSync} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('orch-sync-check-codex')) // uncheck codex
    fireEvent.click(screen.getByTestId('orch-sync-now'))
    expect(onSync).toHaveBeenCalledWith(['claude', 'gemini'])
  })

  it('Later closes', () => {
    const onClose = vi.fn()
    render(<OrchestrationSyncModal status={STATUS} onSync={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('orch-sync-later'))
    expect(onClose).toHaveBeenCalled()
  })
})
