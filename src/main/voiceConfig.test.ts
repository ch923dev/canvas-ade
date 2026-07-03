import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readVoiceConfig, repairVoiceConfig, writeVoiceConfig } from './voiceConfig'

describe('voiceConfig (V3 minimal slice)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'voicecfg-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns defaults when no file exists', () => {
    expect(readVoiceConfig(dir)).toEqual({ showPill: true, pillPosition: undefined })
  })

  it('round-trips showPill + pillPosition', () => {
    writeVoiceConfig(dir, { showPill: false, pillPosition: { x: 120, y: 640 } })
    expect(readVoiceConfig(dir)).toEqual({ showPill: false, pillPosition: { x: 120, y: 640 } })
  })

  it('repairs a malformed pillPosition to undefined (read-repair)', () => {
    writeFileSync(
      join(dir, 'voice-config.json'),
      JSON.stringify({ showPill: 'yes', pillPosition: { x: 'NaN', y: null } }),
      'utf8'
    )
    expect(readVoiceConfig(dir)).toEqual({ showPill: true, pillPosition: undefined })
  })

  it('survives unparseable JSON on disk', () => {
    writeFileSync(join(dir, 'voice-config.json'), '{not json', 'utf8')
    expect(readVoiceConfig(dir)).toEqual({ showPill: true, pillPosition: undefined })
  })

  it('repairVoiceConfig sanitizes non-finite coordinates (the set() merge-patch funnel)', () => {
    expect(repairVoiceConfig({ showPill: true, pillPosition: { x: Infinity, y: 4 } })).toEqual({
      showPill: true,
      pillPosition: undefined
    })
    expect(repairVoiceConfig(null)).toEqual({ showPill: true, pillPosition: undefined })
    expect(repairVoiceConfig({ pillPosition: { x: 1, y: 2 } })).toEqual({
      showPill: true,
      pillPosition: { x: 1, y: 2 }
    })
  })
})
