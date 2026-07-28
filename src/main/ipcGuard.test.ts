import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { isForeignSender, withProjectDir } from './ipcGuard'

// The single IPC trust-boundary guard (was copy-pasted in preview/projectIpc/pty/llmIpc).
// Adopts preview's robust shape: a window can resolve while its webContents is already
// destroyed during shutdown (a late in-flight invoke racing teardown), and touching
// `.webContents.mainFrame` then throws — so an unresolved OR destroyed window must DENY
// WITHOUT touching the frame.
describe('isForeignSender', () => {
  const mainFrame = { name: 'main' } as unknown as IpcMainInvokeEvent['senderFrame']
  const foreignFrame = { name: 'foreign' } as unknown as IpcMainInvokeEvent['senderFrame']
  const liveWin = (): BrowserWindow =>
    ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame }
    }) as unknown as BrowserWindow

  it('allows a synthetic/internal call (no senderFrame)', () => {
    expect(isForeignSender({ senderFrame: null }, () => liveWin())).toBe(false)
  })

  it('blocks a real foreign frame', () => {
    expect(isForeignSender({ senderFrame: foreignFrame }, () => liveWin())).toBe(true)
  })

  it('allows the live main frame', () => {
    expect(isForeignSender({ senderFrame: mainFrame }, () => liveWin())).toBe(false)
  })

  it('denies a real sender when the window is unresolved (getWin → null)', () => {
    expect(isForeignSender({ senderFrame: mainFrame }, () => null)).toBe(true)
  })

  it('denies WITHOUT touching .mainFrame when the window itself is destroyed', () => {
    const destroyed = {
      isDestroyed: () => true,
      webContents: {
        isDestroyed: () => false,
        get mainFrame(): never {
          throw new Error('Object has been destroyed')
        }
      }
    } as unknown as BrowserWindow
    expect(isForeignSender({ senderFrame: mainFrame }, () => destroyed)).toBe(true)
  })

  it('denies WITHOUT touching .mainFrame when only the webContents is destroyed', () => {
    const wcDestroyed = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => true,
        get mainFrame(): never {
          throw new Error('Object has been destroyed')
        }
      }
    } as unknown as BrowserWindow
    expect(isForeignSender({ senderFrame: mainFrame }, () => wcDestroyed)).toBe(true)
  })
})

/**
 * R14 / SM-1: the dir invariant, enforced once. Before this wrapper the same three-part check
 * (frame → current dir → expectedDir pin) was hand-rolled into FOUR write handlers, and every new
 * project-scoped write handler had to remember to re-derive it. These cases are the contract the
 * wrapper owes each of those call sites — a handler that runs is guaranteed a non-null dir that
 * matches the caller's pin.
 */
describe('withProjectDir', () => {
  const mainFrame = { name: 'main' } as unknown as IpcMainInvokeEvent['senderFrame']
  const foreignFrame = { name: 'foreign' } as unknown as IpcMainInvokeEvent['senderFrame']
  const liveWin = (): BrowserWindow =>
    ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame }
    }) as unknown as BrowserWindow
  const ev = (frame: IpcMainInvokeEvent['senderFrame'] | null): IpcMainInvokeEvent =>
    ({ senderFrame: frame }) as IpcMainInvokeEvent

  /** A project:save-shaped wrapper: pin at arg 1, `{ ok:false }` rejection. */
  const build = (
    dir: string | null
  ): {
    call: (
      e: IpcMainInvokeEvent,
      doc: unknown,
      expectedDir?: unknown
    ) => { ok: boolean; dir?: string } | Promise<{ ok: boolean; dir?: string }>
    ran: { dir: string; doc: unknown }[]
  } => {
    const ran: { dir: string; doc: unknown }[] = []
    const call = withProjectDir<
      [doc: unknown, expectedDir?: unknown],
      { ok: boolean; dir?: string }
    >(
      { getWin: () => liveWin(), getDir: () => dir },
      {
        channel: 'test:save',
        pickExpectedDir: (_doc, expectedDir) => expectedDir,
        reject: () => ({ ok: false })
      },
      (resolved, _e, doc) => {
        ran.push({ dir: resolved, doc })
        return { ok: true, dir: resolved }
      }
    )
    return { call, ran }
  }

  it('runs the handler with the resolved dir when the pin matches', () => {
    const { call, ran } = build('C:\\proj\\a')
    expect(call(ev(mainFrame), { d: 1 }, 'C:\\proj\\a')).toEqual({ ok: true, dir: 'C:\\proj\\a' })
    expect(ran).toEqual([{ dir: 'C:\\proj\\a', doc: { d: 1 } }])
  })

  it('runs the handler for an UNPINNED legacy caller (expectedDir omitted)', () => {
    const { call, ran } = build('C:\\proj\\a')
    expect(call(ev(mainFrame), { d: 1 })).toEqual({ ok: true, dir: 'C:\\proj\\a' })
    expect(ran).toHaveLength(1)
  })

  // BUG-009 itself: the doc belongs to a project that is no longer current.
  it('rejects a pin that does not match the current dir, and never runs the handler', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { call, ran } = build('C:\\proj\\a')
    expect(call(ev(mainFrame), { d: 1 }, 'C:\\proj\\b')).toEqual({ ok: false })
    expect(ran).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('rejects a foreign sender before touching the dir', () => {
    const { call, ran } = build('C:\\proj\\a')
    expect(call(ev(foreignFrame), { d: 1 }, 'C:\\proj\\a')).toEqual({ ok: false })
    expect(ran).toHaveLength(0)
  })

  it('rejects when no project is open', () => {
    const { call, ran } = build(null)
    expect(call(ev(mainFrame), { d: 1 })).toEqual({ ok: false })
    expect(ran).toHaveLength(0)
  })

  // Fail closed: the old projectIpc form was `typeof expectedDir === 'string' && …`, so a
  // non-string pin was silently treated as absent and the write went through.
  it('rejects a non-string pin instead of ignoring it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { call, ran } = build('C:\\proj\\a')
    expect(call(ev(mainFrame), { d: 1 }, 42)).toEqual({ ok: false })
    expect(call(ev(mainFrame), { d: 1 }, null)).toEqual({ ok: false })
    expect(ran).toHaveLength(0)
    warn.mockRestore()
  })

  // The pin sits at a different argument position on every channel — terminal:writeSnapshot
  // carries it at arg 3, behind (boardId, text, sync).
  it('reads the pin from whichever argument position the channel puts it in', () => {
    const ran: string[] = []
    const call = withProjectDir<
      [boardId: string, text: string, sync?: boolean, expectedDir?: string],
      boolean
    >(
      { getWin: () => liveWin(), getDir: () => 'C:\\proj\\a' },
      {
        channel: 'test:writeSnapshot',
        pickExpectedDir: (_boardId, _text, _sync, expectedDir) => expectedDir,
        reject: () => false
      },
      (_dir, _e, boardId) => {
        ran.push(boardId)
        return true
      }
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(call(ev(mainFrame), 'b1', 'text', true, 'C:\\proj\\a')).toBe(true)
    expect(call(ev(mainFrame), 'b2', 'text', true, 'C:\\proj\\b')).toBe(false)
    expect(ran).toEqual(['b1'])
    warn.mockRestore()
  })

  it('passes a rejected async handler through unchanged (rejection value is per-channel)', async () => {
    const call = withProjectDir<[expectedDir?: string], boolean>(
      { getWin: () => liveWin(), getDir: () => 'C:\\proj\\a' },
      { channel: 'test:async', pickExpectedDir: (expectedDir) => expectedDir, reject: () => false },
      async () => true
    )
    await expect(call(ev(mainFrame), 'C:\\proj\\a')).resolves.toBe(true)
  })
})
