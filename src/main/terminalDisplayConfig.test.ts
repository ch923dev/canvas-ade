/**
 * terminalDisplayConfig (T1d) — the app-wide "Flicker-free terminals" userData store: read/write
 * roundtrip, defaults-on-absent/corrupt, sanitize of a bogus wire shape, and the bound spawn-time
 * getter (isFlickerFree reads fresh so a toggle applies without an app restart). Pure I/O — no
 * Electron (the IPC register fn is not exercised here; it only wraps these functions in a guard).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  DEFAULT_TERMINAL_DISPLAY,
  bindTerminalDisplayConfig,
  isFlickerFree,
  readTerminalDisplayConfig,
  sanitizeTerminalDisplayConfig,
  writeTerminalDisplayConfig
} from './terminalDisplayConfig'

let dir: string
const fileFor = (d: string): string => join(d, 'terminal-display-config.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-termdisplay-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  bindTerminalDisplayConfig('') // reset the bound getter for the next test
})

describe('read / write / sanitize', () => {
  it('defaults to flickerFree:true when no file exists', () => {
    expect(readTerminalDisplayConfig(dir)).toEqual(DEFAULT_TERMINAL_DISPLAY)
    expect(DEFAULT_TERMINAL_DISPLAY.flickerFree).toBe(true)
  })

  it('roundtrips a written config (incl. an explicit OFF over the ON default)', () => {
    writeTerminalDisplayConfig(dir, { flickerFree: false })
    expect(readTerminalDisplayConfig(dir).flickerFree).toBe(false)
    writeTerminalDisplayConfig(dir, { flickerFree: true })
    expect(readTerminalDisplayConfig(dir).flickerFree).toBe(true)
  })

  it('repairs a corrupt file back to the default (ON)', () => {
    writeFileSync(fileFor(dir), '{ not json')
    expect(readTerminalDisplayConfig(dir).flickerFree).toBe(true)
  })

  it('sanitizes a non-boolean flickerFree back to the default (ON)', () => {
    expect(sanitizeTerminalDisplayConfig({ flickerFree: 'yes' }).flickerFree).toBe(true)
    expect(sanitizeTerminalDisplayConfig(null).flickerFree).toBe(true)
    expect(sanitizeTerminalDisplayConfig({ flickerFree: false }).flickerFree).toBe(false)
  })
})

describe('isFlickerFree (bound spawn-time getter)', () => {
  it('returns the default (ON) when unbound', () => {
    bindTerminalDisplayConfig('')
    expect(isFlickerFree()).toBe(true)
  })

  it('reads fresh from disk after bind (a toggle applies without a rebind)', () => {
    bindTerminalDisplayConfig(dir)
    expect(isFlickerFree()).toBe(true) // no file yet → default (ON)
    writeTerminalDisplayConfig(dir, { flickerFree: false })
    expect(isFlickerFree()).toBe(false) // fresh read picks up the write, no rebind
    writeTerminalDisplayConfig(dir, { flickerFree: true })
    expect(isFlickerFree()).toBe(true)
  })
})
