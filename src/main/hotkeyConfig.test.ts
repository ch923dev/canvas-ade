import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHotkeyConfig, writeHotkeyConfig, DEFAULT_HOTKEYS } from './hotkeyConfig'

describe('hotkeyConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hotkeycfg-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns DEFAULT_HOTKEYS when no file exists', () => {
    expect(readHotkeyConfig(dir)).toEqual(DEFAULT_HOTKEYS)
  })

  it('round-trips a written config', () => {
    const cfg = { enabled: false, next: 'Control+Alt+K', prev: 'Control+Alt+J' }
    writeHotkeyConfig(dir, cfg)
    expect(readHotkeyConfig(dir)).toEqual(cfg)
  })

  it('repairs blank/missing fields back to their defaults', () => {
    writeFileSync(join(dir, 'hotkey-config.json'), JSON.stringify({ next: '' }), 'utf8')
    const cfg = readHotkeyConfig(dir)
    expect(cfg.next).toBe(DEFAULT_HOTKEYS.next)
    expect(cfg.prev).toBe(DEFAULT_HOTKEYS.prev)
    expect(cfg.enabled).toBe(DEFAULT_HOTKEYS.enabled)
  })

  it('keeps a valid enabled=false through the repair path', () => {
    writeFileSync(
      join(dir, 'hotkey-config.json'),
      JSON.stringify({ enabled: false, next: 'Control+1', prev: 'Control+2' }),
      'utf8'
    )
    expect(readHotkeyConfig(dir).enabled).toBe(false)
  })

  it('coerces a non-boolean enabled back to the default', () => {
    writeFileSync(
      join(dir, 'hotkey-config.json'),
      JSON.stringify({ enabled: 'yes', next: 'Control+1', prev: 'Control+2' }),
      'utf8'
    )
    expect(readHotkeyConfig(dir).enabled).toBe(DEFAULT_HOTKEYS.enabled)
  })

  it('falls back to defaults on corrupt/truncated JSON', () => {
    writeFileSync(join(dir, 'hotkey-config.json'), '{ "enabled": tr', 'utf8')
    expect(readHotkeyConfig(dir)).toEqual(DEFAULT_HOTKEYS)
  })

  it('writes hotkey-config.json into the given userData dir', () => {
    writeHotkeyConfig(dir, DEFAULT_HOTKEYS)
    expect(existsSync(join(dir, 'hotkey-config.json'))).toBe(true)
    const raw = JSON.parse(readFileSync(join(dir, 'hotkey-config.json'), 'utf8'))
    expect(raw.next).toBe(DEFAULT_HOTKEYS.next)
  })
})
