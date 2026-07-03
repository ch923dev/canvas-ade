import { describe, it, expect } from 'vitest'
import { registerPtyHandlers } from './pty'
import { createIpcCapture, foreignEvent, mainWin } from './ipcTestHarness'

// Checklist #17 + #20 (Browser↛PTY): the PTY control channel is shared by ALL
// webContents, including per-board preview WebContentsViews that load untrusted
// localhost pages. A foreign sender (anything that isn't the main window's main
// frame) must be REJECTED — a previewed page must never be able to spawn or kill
// a shell. This proves the guard is wired into the handlers, not just that the
// pure isForeignSender works.
describe('registerPtyHandlers — foreign-sender rejection (#17/#20 Browser↛PTY)', () => {
  function setup(): ReturnType<typeof createIpcCapture> {
    const cap = createIpcCapture()
    registerPtyHandlers(cap.ipcMain, mainWin)
    return cap
  }

  it('pty:spawn throws for a foreign sender (no shell is spawned)', () => {
    const cap = setup()
    expect(() => cap.invokeAs(foreignEvent, 'pty:spawn', { id: 'b1' })).toThrow(/forbidden sender/)
  })

  it('pty:kill returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'pty:kill', 'b1')).toBe(false)
  })

  it('pty:shells returns [] for a foreign sender (no shell enumeration leaked)', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'pty:shells')).toEqual([])
  })

  it('terminal:detectPorts returns [] for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'terminal:detectPorts', 'b1')).toEqual([])
  })

  it('pty:disposeAll returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'pty:disposeAll')).toBe(false)
  })

  it('pty:park returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'pty:park', 'b1')).toBe(false)
  })

  it('pty:adopt returns { adopted: false } for a foreign sender', async () => {
    // Phase 5: the handler is async now (it may read the sidecar preface before adopting),
    // so the rejection resolves through a promise — same value, awaited.
    const cap = setup()
    await expect(cap.invokeAs(foreignEvent, 'pty:adopt', 'b1')).resolves.toEqual({
      adopted: false
    })
  })
})
