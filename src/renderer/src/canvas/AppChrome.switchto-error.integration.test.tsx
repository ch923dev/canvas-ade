// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ProjectSwitcher } from './AppChrome'
import { useCanvasStore } from '../store/canvasStore'

// BUG-006: switchTo's `await load()` had no try/catch. For createNew, load() =
// window.api.project.create → MAIN createProject can THROW (disk-full / permission via
// mkdirSync / writeFileAtomic). The rejection escaped switchTo (callers use `void switchTo`)
// → status stuck at 'loading' with all live native resources already torn down: unrecoverable.
// The fix wraps the load() await so a rejection settles to status:'error' (recoverable).

// `globals: false` in vitest.config → RTL auto-cleanup isn't registered; clean up by hand.
beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    project: {
      recents: vi.fn().mockResolvedValue([]),
      // current flush succeeds, so the switch proceeds to dispose + load
      save: vi.fn().mockResolvedValue(true),
      // the failing leg under test: a disk error in MAIN createProject rejects the IPC
      create: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
      // disposeLiveResources may touch these — keep them harmless no-ops
      open: vi.fn()
    },
    dialog: { openFolder: vi.fn().mockResolvedValue('Z:/some/new/project') },
    // disposeLiveResources tears these down before the load — resolve harmlessly
    closeAllPreviews: vi.fn().mockResolvedValue(true),
    closeAllOsr: vi.fn().mockResolvedValue(true),
    disposeAllTerminals: vi.fn().mockResolvedValue(true)
  }
})
afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('ProjectSwitcher switchTo error recovery (BUG-006)', () => {
  it('settles to status:error (not stuck loading) when project.create rejects', async () => {
    render(<ProjectSwitcher />)
    // open the dropdown, then trigger "Create project…"
    fireEvent.click(screen.getByTitle('Switch project'))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    fireEvent.click(screen.getByText('Create project…'))

    // The create IPC rejects mid-switch. The switch must NOT leave the app stuck at 'loading';
    // it must settle to 'error' carrying the rejection message so the user can recover.
    await waitFor(() => {
      expect(useCanvasStore.getState().project.status).toBe('error')
    })
    expect(useCanvasStore.getState().project.status).not.toBe('loading')
    expect(useCanvasStore.getState().project.error).toContain('permission denied')
  })
})
