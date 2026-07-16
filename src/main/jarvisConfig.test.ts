import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      wakeWordEnabled: true
    }
    writeJarvisConfig(dir, cfg)
    expect(readJarvisConfig(dir)).toEqual(cfg)
  })

  it('wakeWordEnabled is STRICTLY opt-in: anything but true repairs to false (D3)', () => {
    expect(repairJarvisConfig({ wakeWordEnabled: 'yes' }).wakeWordEnabled).toBe(false)
    expect(repairJarvisConfig({ wakeWordEnabled: 1 }).wakeWordEnabled).toBe(false)
    expect(repairJarvisConfig({}).wakeWordEnabled).toBe(false)
    expect(repairJarvisConfig({ wakeWordEnabled: true }).wakeWordEnabled).toBe(true)
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
        historyMode: 'nowhere' // not in the union → default
      })
    ).toEqual(jarvisDefaults())
  })

  it("historyMode 'project' is a first-class value (D4′ J5) and survives repair", () => {
    expect(repairJarvisConfig({ historyMode: 'project' }).historyMode).toBe('project')
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

  it('reads a pre-panel config carrying the retired islandPosition field and drops it', () => {
    // Surface rev 2026-07-13: the island retired. Old on-disk configs still carry the
    // field; the repair funnel must accept them silently and never re-emit it.
    writeFileSync(
      join(dir, 'jarvis-config.json'),
      JSON.stringify({ ...jarvisDefaults(), islandPosition: { x: 40, y: 24 } }),
      'utf8'
    )
    const read = readJarvisConfig(dir)
    expect(read).toEqual(jarvisDefaults())
    expect('islandPosition' in read).toBe(false)
    // And the write funnel scrubs it from disk on the next persist.
    writeJarvisConfig(dir, read)
    expect(JSON.parse(readFileSync(join(dir, 'jarvis-config.json'), 'utf8'))).not.toHaveProperty(
      'islandPosition'
    )
  })
})
