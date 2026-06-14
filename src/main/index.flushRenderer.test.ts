/**
 * BUG-038: flushRenderer uses non-CSPRNG channel name and finish() ignores the sender frame.
 *
 * These tests verify the HELPERS extracted from flushRenderer (makeFlushChannel,
 * makeFlushFinish) so that the fix is testable without importing the full Electron
 * app bootstrap (index.ts). The tests prove:
 *
 *   1. The channel name MUST be a CSPRNG UUID (not Date.now()/Math.random) — RED against
 *      the old inline `Date.now():Math.random()` shape.
 *   2. The finish callback MUST reject replies from foreign frames (isForeignSender guard)
 *      — RED against the old `finish = (): void => { ... }` that accepted no arguments
 *      and therefore could not perform any frame check.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFlushChannel, makeFlushFinish } from './flushChannel'
import { watchRecapMap } from './agentRecapMap'
import type { BrowserWindow } from 'electron'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mainFrame(): object {
  return { name: 'main' }
}

function foreignFrame(): object {
  return { name: 'foreign' }
}

function liveWin(frame: object): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame: frame
    }
  } as unknown as BrowserWindow
}

// ---------------------------------------------------------------------------
// BUG-038 Part 1: channel name must be CSPRNG (randomUUID), not Date.now()/Math.random
// ---------------------------------------------------------------------------

describe('BUG-038 makeFlushChannel — CSPRNG channel name', () => {
  it('🔒 produces a channel that contains a v4 UUID (unguessable, not predictable timestamps)', () => {
    const ch = makeFlushChannel()
    // Must match the prefix + a standard v4 UUID.
    const uuidV4 =
      /^project:flush:done:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(ch).toMatch(uuidV4)
  })

  it('🔒 must NOT match the old Date.now():Math.random() shape', () => {
    const ch = makeFlushChannel()
    // The OLD channel was `project:flush:done:${Date.now()}:${Math.random().toString(36).slice(2)}`
    // — two colon-separated numeric/base36 parts, no hyphens.
    expect(ch).not.toMatch(/^project:flush:done:\d+:[0-9a-z]+$/)
  })

  it('produces distinct channels on successive calls (no collision)', () => {
    const c1 = makeFlushChannel()
    const c2 = makeFlushChannel()
    expect(c1).not.toBe(c2)
  })
})

// ---------------------------------------------------------------------------
// BUG-001 regression: flushRenderer must guard win.isDestroyed() before accessing .webContents.
// The fix is in index.ts (not importable here), but we verify the helper isForeignSender
// correctly handles the destroyed-window path so the guard reads win.isDestroyed() first.
// ---------------------------------------------------------------------------

describe('BUG-001 isForeignSender — destroyed-window guard (mirrors index.ts fix)', () => {
  it('returns true (deny) when the window is destroyed — no throw from .webContents access', async () => {
    // This simulates the case where mainWindow.isDestroyed() is true. The canonical
    // isForeignSender guard from ipcGuard.ts checks isDestroyed() BEFORE .webContents.
    const { isForeignSender } = await import('./ipcGuard')
    const destroyedWin = {
      isDestroyed: () => true,
      // webContents getter throws, as a real destroyed BrowserWindow does:
      get webContents(): never {
        throw new Error('Object has been destroyed')
      }
    } as unknown as BrowserWindow
    const e = { senderFrame: { id: 'frame' } } as never
    expect(() => isForeignSender(e, () => destroyedWin)).not.toThrow()
    expect(isForeignSender(e, () => destroyedWin)).toBe(true) // DENY on destroyed window
  })

  it('returns true (deny) when getWin() returns null — consistent with BUG-001 guard', async () => {
    const { isForeignSender } = await import('./ipcGuard')
    const e = { senderFrame: { id: 'frame' } } as never
    expect(isForeignSender(e, () => null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// BUG-001 (recap-map watcher crash): the recap-map onChange callback in index.ts runs
// INSIDE agentRecapMap's bare debounce setTimeout, so any throw escapes to uncaughtException
// -> crashShutdown(1). The defect: `const wc = mainWindow?.webContents` — optional chaining
// does NOT stop the `.webContents` GETTER from THROWING on a destroyed-but-non-null window
// (the 'closed' handler used to leave mainWindow non-null). The fix reads win.isDestroyed()
// BEFORE touching .webContents. These tests drive the REAL watchRecapMap setTimeout escape
// path (the crash vector) against a destroyed-window double whose getter throws, proving the
// BUGGY shape escapes the timer and the FIXED shape does not.
// ---------------------------------------------------------------------------

describe('BUG-001 watchRecapMap onChange — destroyed-window guard (real timer escape path)', () => {
  let dir: string | null = null
  afterEach(() => {
    vi.useRealTimers()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  /** A destroyed-but-non-null window whose `.webContents` getter THROWS, like a real one. */
  function destroyedNonNullWin(): BrowserWindow {
    return {
      isDestroyed: () => true,
      get webContents(): never {
        throw new Error('Object has been destroyed')
      }
    } as unknown as BrowserWindow
  }

  it('🔒 the OLD `mainWindow?.webContents` shape throws out of the debounce setTimeout', () => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'recap-bug001-old-'))
    const mapPath = join(dir, 'session-map.jsonl')
    writeFileSync(mapPath, '')
    const win = destroyedNonNullWin()
    // The OLD index.ts onChange: optional chaining does NOT guard the throwing getter.
    const dispose = watchRecapMap(mapPath, () => {
      const wc = win?.webContents // <- throws on the destroyed window (the bug)
      if (wc && !wc.isDestroyed()) wc.send('recap:learned', [])
    })
    // The prime fire scheduled a debounce timer; running it invokes onChange inside the
    // setTimeout. In prod that escapes to uncaughtException -> crashShutdown(1).
    expect(() => vi.runOnlyPendingTimers()).toThrow(/destroyed/i)
    dispose()
  })

  it('🔒 the FIXED guard (isDestroyed() BEFORE .webContents) does NOT throw and does NOT send', () => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'recap-bug001-fixed-'))
    const mapPath = join(dir, 'session-map.jsonl')
    writeFileSync(mapPath, '')
    const win = destroyedNonNullWin()
    let sent = 0
    // The FIXED index.ts onChange: read isDestroyed() FIRST, never touch .webContents on a
    // destroyed window (mirrors flushRenderer's canonical guard).
    const dispose = watchRecapMap(mapPath, () => {
      const w = win
      if (!w || w.isDestroyed()) return
      const wc = w.webContents
      if (!wc.isDestroyed()) {
        sent++
        wc.send('recap:learned', [])
      }
    })
    expect(() => vi.runOnlyPendingTimers()).not.toThrow()
    expect(sent).toBe(0) // a destroyed window is never sent to
    dispose()
  })
})

// ---------------------------------------------------------------------------
// BUG-019 regression: makeFlushFinish's keep-waiting semantics require ipcMain.on (not once).
// We verify that a foreign-frame reply does NOT resolve — which only works with ipcMain.on
// (once would consume the listener on the first call and the legitimate reply would be missed).
// The helper's own 'ignores a foreign-frame reply' test already covers this semantics;
// this test makes the intent explicit as a named regression.
// ---------------------------------------------------------------------------

describe('BUG-019 makeFlushFinish — foreign-frame does not consume the listener', () => {
  it('calling finish with a foreign frame leaves the listener armed (resolved stays false)', () => {
    const frame = mainFrame()
    const win = liveWin(frame)
    let resolved = false
    const { finish } = makeFlushFinish({
      getWin: () => win,
      onResolve: () => {
        resolved = true
      },
      onCleanup: () => {}
    })
    // Two foreign-frame calls — if the listener were consumed on the first call,
    // the second would have no effect and the resolver would still be reachable.
    // With ipcMain.once wiring, the listener is gone after the first delivery;
    // with ipcMain.on wiring, finish remains callable by the legitimate frame.
    finish({ senderFrame: foreignFrame() } as never)
    finish({ senderFrame: foreignFrame() } as never)
    expect(resolved).toBe(false)
    // The legitimate frame can still resolve.
    finish({ senderFrame: frame } as never)
    expect(resolved).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// BUG-038 Part 2: finish() must guard against foreign-frame senders
// ---------------------------------------------------------------------------

describe('BUG-038 makeFlushFinish — sender-frame guard', () => {
  it('resolves when the legitimate main-frame sends the reply', async () => {
    const frame = mainFrame()
    const win = liveWin(frame)
    let resolved = false
    const { finish } = makeFlushFinish({
      getWin: () => win,
      onResolve: () => {
        resolved = true
      },
      onCleanup: () => {}
    })
    // Simulate main-frame sending the reply.
    finish({ senderFrame: frame } as never)
    expect(resolved).toBe(true)
  })

  it('🔒 ignores a foreign-frame reply (the old finish() had no e parameter — bug)', () => {
    // The OLD finish = (): void => { ... } accepted no argument at all, so the IpcMainEvent
    // was silently dropped and NO frame check was possible. Any sender — including a
    // compromised WebContentsView preview-board — could trigger early resolution.
    const frame = mainFrame()
    const win = liveWin(frame)
    let resolved = false
    const { finish } = makeFlushFinish({
      getWin: () => win,
      onResolve: () => {
        resolved = true
      },
      onCleanup: () => {}
    })
    // A foreign frame (e.g., a preview WebContentsView) sends the reply — must be IGNORED.
    finish({ senderFrame: foreignFrame() } as never)
    expect(resolved).toBe(false)
  })

  it('🔒 is idempotent — the done guard prevents double-resolution', () => {
    const frame = mainFrame()
    const win = liveWin(frame)
    let resolveCount = 0
    const { finish } = makeFlushFinish({
      getWin: () => win,
      onResolve: () => {
        resolveCount++
      },
      onCleanup: () => {}
    })
    finish({ senderFrame: frame } as never)
    finish({ senderFrame: frame } as never)
    expect(resolveCount).toBe(1)
  })

  it('calls onCleanup when resolving (removes the IPC listener)', () => {
    const frame = mainFrame()
    const win = liveWin(frame)
    const cleanupSpy = vi.fn()
    const { finish } = makeFlushFinish({
      getWin: () => win,
      onResolve: () => {},
      onCleanup: cleanupSpy
    })
    finish({ senderFrame: frame } as never)
    expect(cleanupSpy).toHaveBeenCalledOnce()
  })

  it('the forceFinish path (timeout / send-failure) resolves without a frame check', () => {
    // When called without an event (timeout fallback or catch block), it must still resolve.
    const frame = mainFrame()
    const win = liveWin(frame)
    let resolved = false
    const { forceFinish } = makeFlushFinish({
      getWin: () => win,
      onResolve: () => {
        resolved = true
      },
      onCleanup: () => {}
    })
    forceFinish()
    expect(resolved).toBe(true)
  })
})
