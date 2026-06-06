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
import { describe, it, expect, vi } from 'vitest'
import { makeFlushChannel, makeFlushFinish } from './flushChannel'
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
