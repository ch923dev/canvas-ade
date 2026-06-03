import { describe, it, expect } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { isForeignSender, isUnsafeProjectDir } from './projectIpc'

describe('isForeignSender (BUG-M6)', () => {
  const sameFrame = { id: 'main' }

  it('allows a synthetic/internal call (no senderFrame)', () => {
    const e = { senderFrame: undefined } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => sameFrame as never)).toBe(false)
  })

  it('blocks a foreign frame', () => {
    const e = { senderFrame: { id: 'other' } } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => sameFrame as never)).toBe(true)
  })

  it('allows the same main frame', () => {
    const e = { senderFrame: sameFrame } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => sameFrame as never)).toBe(false)
  })

  it('blocks a real sender when the window is unresolved (getMainFrame → null)', () => {
    const e = { senderFrame: { id: 'real' } } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => null)).toBe(true)
  })
})

describe('isUnsafeProjectDir (M-6)', () => {
  it('accepts a normal absolute path (Windows + POSIX)', () => {
    expect(isUnsafeProjectDir('C:\\Users\\x\\proj')).toBe(false)
    expect(isUnsafeProjectDir('/home/x/proj')).toBe(false)
  })

  it('rejects a relative path', () => {
    expect(isUnsafeProjectDir('proj')).toBe(true)
    expect(isUnsafeProjectDir('./proj')).toBe(true)
  })

  it('rejects an absolute path that still contains traversal', () => {
    expect(isUnsafeProjectDir('C:\\Users\\x\\..\\..\\evil')).toBe(true)
    expect(isUnsafeProjectDir('/home/x/../../etc')).toBe(true)
  })

  it('rejects empty / non-string input', () => {
    expect(isUnsafeProjectDir('')).toBe(true)
    expect(isUnsafeProjectDir(undefined as unknown as string)).toBe(true)
    expect(isUnsafeProjectDir(null as unknown as string)).toBe(true)
    expect(isUnsafeProjectDir(42 as unknown as string)).toBe(true)
  })
})
