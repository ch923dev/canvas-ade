import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_CUSTOM_TONE_LEN,
  MAX_PERSONA_NAME_LEN,
  jarvisDefaults,
  readJarvisConfig,
  repairJarvisConfig,
  writeJarvisConfig,
  type JarvisConfig
} from './jarvisConfig'

describe('jarvisConfig (J3 persona config read-repair)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jarviscfg-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns defaults when no file exists', () => {
    expect(readJarvisConfig(dir)).toEqual(jarvisDefaults())
  })

  it('returns defaults for a corrupt file', () => {
    writeFileSync(join(dir, 'jarvis-config.json'), '{not json', 'utf8')
    expect(readJarvisConfig(dir)).toEqual(jarvisDefaults())
  })

  it('round-trips a full config', () => {
    const cfg: JarvisConfig = {
      enabled: false,
      name: 'Friday',
      tonePreset: 'mission-control',
      customToneText: '',
      speakingRate: 1.2,
      verbosity: 'narrative',
      voiceSid: 3,
      announcePolicy: 'all',
      model: 'claude-haiku-4-5',
      historyMode: 'off',
      islandPosition: { x: 40, y: 24 }
    }
    writeJarvisConfig(dir, cfg)
    expect(readJarvisConfig(dir)).toEqual(cfg)
  })

  it('repairs every malformed field to its default', () => {
    expect(
      repairJarvisConfig({
        enabled: 'yes',
        name: '   ',
        tonePreset: 'sassy',
        customToneText: 42,
        speakingRate: 'fast',
        verbosity: 'shouty',
        voiceSid: -2,
        announcePolicy: 'loud',
        model: '',
        historyMode: 'project', // J5 value — repairs to 'session' until the union widens
        islandPosition: { x: 'a', y: 0 }
      })
    ).toEqual(jarvisDefaults())
  })

  it('clamps speakingRate into [0.5, 2] and trims/caps the name', () => {
    const r = repairJarvisConfig({ speakingRate: 9, name: `  ${'x'.repeat(80)}  ` })
    expect(r.speakingRate).toBe(2)
    expect(r.name).toHaveLength(MAX_PERSONA_NAME_LEN)
    expect(repairJarvisConfig({ speakingRate: 0.1 }).speakingRate).toBe(0.5)
  })

  it('caps customToneText and preserves an unknown model id (scene-id discipline)', () => {
    const r = repairJarvisConfig({
      customToneText: 'y'.repeat(MAX_CUSTOM_TONE_LEN + 50),
      model: 'claude-something-future'
    })
    expect(r.customToneText).toHaveLength(MAX_CUSTOM_TONE_LEN)
    expect(r.model).toBe('claude-something-future')
  })

  it('write funnels through repair — junk on the way in never lands on disk', () => {
    writeJarvisConfig(dir, { ...jarvisDefaults(), speakingRate: 99 })
    expect(readJarvisConfig(dir).speakingRate).toBe(2)
  })

  it('drops a non-finite island position', () => {
    expect(
      repairJarvisConfig({ islandPosition: { x: Infinity, y: 2 } }).islandPosition
    ).toBeUndefined()
  })
})
