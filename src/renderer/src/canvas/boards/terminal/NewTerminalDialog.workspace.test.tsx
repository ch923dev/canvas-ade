import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { NewTerminalDialog } from './NewTerminalDialog'
import { useCanvasStore } from '../../../store/canvasStore'
import type { TerminalBoard } from '../../../lib/boardSchema'

/**
 * WS-3 — the terminal dialog REFLECTS the board's workspace (signed-off wireframe 2026-11-03): a
 * read-only Workspace line, a Working dir default naming the effective root, and an early
 * missing-folder warning. It never offers a workspace control (membership is WS-5's dock checkbox /
 * WS-4's Move to workspace), never blocks Create (MAIN refuses at spawn), and a project-level board
 * sees today's dialog unchanged.
 */
const base: TerminalBoard = {
  id: 'tb-1',
  type: 'terminal',
  x: 0,
  y: 0,
  w: 420,
  h: 340,
  title: 'Terminal'
}
const api = { id: 'ws-api', name: 'API', goal: '', color: 'green', root: 'api' }

const stat = vi.fn()

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  stat.mockResolvedValue({ size: 0, mtimeMs: 0, isDir: true })
  ;(window as unknown as { api: unknown }).api = {
    listShells: vi.fn(async () => [{ path: 'pwsh', label: 'PowerShell', default: true }]),
    orchestration: { grantLead: vi.fn() },
    file: { stat }
  }
  useCanvasStore.setState({
    boards: [base] as never,
    workspaces: [api] as never,
    project: { dir: 'C:/proj', name: 'proj', status: 'open' } as never
  })
})

const q = (sel: string): HTMLElement | null => document.querySelector(`[data-test="${sel}"]`)
const cwdInput = (): HTMLInputElement => q('new-terminal-cwd') as HTMLInputElement

describe('NewTerminalDialog — workspace reflection (WS-3)', () => {
  it('a project-level board sees no Workspace line and the project-folder default', () => {
    render(<NewTerminalDialog board={base} mode="create" onClose={vi.fn()} />)
    expect(q('new-terminal-workspace')).toBeNull()
    expect(cwdInput().placeholder).toBe('(blank = project folder)')
    expect(stat).not.toHaveBeenCalled()
  })

  it('a workspace board shows its workspace read-only and defaults the cwd to its root', async () => {
    const board = { ...base, workspaceId: 'ws-api' }
    render(<NewTerminalDialog board={board} mode="create" onClose={vi.fn()} />)
    const row = q('new-terminal-workspace')!
    expect(row.textContent).toContain('API')
    expect(row.textContent).toContain('api/')
    expect(row.querySelector('select, input, button')).toBeNull() // reflection only, no control
    expect(cwdInput().placeholder).toBe('blank = api/ (workspace)')
    await waitFor(() => expect(stat).toHaveBeenCalledWith('api'))
    expect(q('new-terminal-workspace-problem')).toBeNull()
  })

  it('warns when the workspace folder is missing — Create stays enabled', async () => {
    stat.mockRejectedValue(new Error('ENOENT'))
    const board = { ...base, workspaceId: 'ws-api' }
    render(<NewTerminalDialog board={board} mode="create" onClose={vi.fn()} />)
    await waitFor(() =>
      expect(q('new-terminal-workspace-problem')?.textContent).toContain(
        'Workspace "API" folder is missing (api/). Restore it or remove the workspace.'
      )
    )
    expect((q('new-terminal-create') as HTMLButtonElement).disabled).toBe(false)
  })

  it('edit mode reflects the same workspace', () => {
    const board = { ...base, workspaceId: 'ws-api', launchCommand: 'claude' }
    render(<NewTerminalDialog board={board} mode="edit" onClose={vi.fn()} />)
    expect(q('new-terminal-workspace')?.textContent).toContain('API')
  })

  it('a workspace the store no longer knows says so instead of guessing a folder', () => {
    const board = { ...base, workspaceId: 'ws-ghost' }
    render(<NewTerminalDialog board={board} mode="create" onClose={vi.fn()} />)
    expect(q('new-terminal-workspace-problem')?.textContent).toMatch(/no longer exists/)
    expect(cwdInput().placeholder).toBe('blank = workspace folder')
  })
})
