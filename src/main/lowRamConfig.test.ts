import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectLowRam, isLowRam, bindLowRamConfig, LOW_RAM_THRESHOLD_BYTES } from './lowRamConfig'

describe('detectLowRam (the 8 GiB auto-enable gate)', () => {
  it('is ON at or below 8 GiB total RAM, OFF above (bytes, not freemem)', () => {
    expect(LOW_RAM_THRESHOLD_BYTES).toBe(8 * 1024 ** 3)
    expect(detectLowRam(4 * 1024 ** 3)).toBe(true) // 4 GB
    expect(detectLowRam(8 * 1024 ** 3)).toBe(true) // exactly 8 GiB → on
    expect(detectLowRam(8 * 1024 ** 3 + 1)).toBe(false) // just above → off
    expect(detectLowRam(16 * 1024 ** 3)).toBe(false) // 16 GB
  })
})

describe('isLowRam override (userData low-ram.json wins over auto-detect)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lowram-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    bindLowRamConfig(dir) // reset the module cache for the next test (dir now gone → auto-detect)
  })

  it("an 'on' override forces low-RAM regardless of machine RAM", () => {
    writeFileSync(join(dir, 'low-ram.json'), JSON.stringify({ mode: 'on' }))
    bindLowRamConfig(dir) // rebind → resets the cache
    expect(isLowRam()).toBe(true)
  })

  it("an 'off' override forces full-RAM", () => {
    writeFileSync(join(dir, 'low-ram.json'), JSON.stringify({ mode: 'off' }))
    bindLowRamConfig(dir)
    expect(isLowRam()).toBe(false)
  })

  it('a corrupt override falls back to auto-detect (never throws)', () => {
    writeFileSync(join(dir, 'low-ram.json'), '{ not json')
    bindLowRamConfig(dir)
    const v = isLowRam()
    expect(typeof v).toBe('boolean') // auto-detect result
    expect(isLowRam()).toBe(v) // cached → stable per run
  })

  it('an unknown mode value is ignored (→ auto-detect)', () => {
    writeFileSync(join(dir, 'low-ram.json'), JSON.stringify({ mode: 'maybe' }))
    bindLowRamConfig(dir)
    expect(typeof isLowRam()).toBe('boolean')
  })
})
