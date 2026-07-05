import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_PROMPT_HISTORY,
  readVoiceConfig,
  repairVoiceConfig,
  writeVoiceConfig,
  type VoiceConfig
} from './voiceConfig'
import { DEFAULT_VOICE_MODEL_ID } from './voiceModels'

const DEFAULTS: VoiceConfig = {
  engine: 'sherpa-onnx',
  modelId: DEFAULT_VOICE_MODEL_ID,
  language: 'auto',
  micDeviceId: undefined,
  hotkey: undefined,
  autoSendOnFinal: false,
  cloudProvider: undefined,
  showPill: true,
  pillPosition: undefined,
  promptHistory: []
}

describe('voiceConfig (V4 full SPEC §5 shape)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'voicecfg-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns defaults when no file exists', () => {
    expect(readVoiceConfig(dir)).toEqual(DEFAULTS)
  })

  it('opens a V3-era config (showPill/pillPosition only) clean, filling the V4 defaults', () => {
    writeFileSync(
      join(dir, 'voice-config.json'),
      JSON.stringify({ showPill: false, pillPosition: { x: 120, y: 640 } }),
      'utf8'
    )
    expect(readVoiceConfig(dir)).toEqual({
      ...DEFAULTS,
      showPill: false,
      pillPosition: { x: 120, y: 640 }
    })
  })

  it('round-trips the full V4 shape', () => {
    const cfg: VoiceConfig = {
      engine: 'cloud',
      modelId: 'zipformer-en-2023-06-26-int8',
      language: 'en',
      micDeviceId: 'abc123',
      hotkey: 'Ctrl+Alt+V',
      autoSendOnFinal: false,
      cloudProvider: 'someday',
      showPill: false,
      pillPosition: { x: 12, y: 34 },
      promptHistory: ['deploy the site', 'run the tests']
    }
    writeVoiceConfig(dir, cfg)
    expect(readVoiceConfig(dir)).toEqual(cfg)
  })

  it('preserves an unknown modelId (catalog fallback happens at use time, not here)', () => {
    writeFileSync(
      join(dir, 'voice-config.json'),
      JSON.stringify({ modelId: 'model-from-the-future' }),
      'utf8'
    )
    expect(readVoiceConfig(dir).modelId).toBe('model-from-the-future')
  })

  it('repairs every malformed field to its default (read-repair)', () => {
    writeFileSync(
      join(dir, 'voice-config.json'),
      JSON.stringify({
        engine: 'telepathy',
        modelId: 7,
        language: '',
        micDeviceId: 42,
        hotkey: '',
        cloudProvider: false,
        showPill: 'yes',
        pillPosition: { x: 'NaN', y: null }
      }),
      'utf8'
    )
    expect(readVoiceConfig(dir)).toEqual(DEFAULTS)
  })

  it('forces autoSendOnFinal false even when the file says true (SPEC §2 hard-false)', () => {
    writeFileSync(join(dir, 'voice-config.json'), JSON.stringify({ autoSendOnFinal: true }), 'utf8')
    expect(readVoiceConfig(dir).autoSendOnFinal).toBe(false)
    expect(repairVoiceConfig({ autoSendOnFinal: true }).autoSendOnFinal).toBe(false)
  })

  it('survives unparseable JSON on disk', () => {
    writeFileSync(join(dir, 'voice-config.json'), '{not json', 'utf8')
    expect(readVoiceConfig(dir)).toEqual(DEFAULTS)
  })

  it('repairVoiceConfig sanitizes non-finite coordinates (the set() merge-patch funnel)', () => {
    expect(repairVoiceConfig({ showPill: true, pillPosition: { x: Infinity, y: 4 } })).toEqual(
      DEFAULTS
    )
    expect(repairVoiceConfig(null)).toEqual(DEFAULTS)
    expect(repairVoiceConfig({ pillPosition: { x: 1, y: 2 } })).toEqual({
      ...DEFAULTS,
      pillPosition: { x: 1, y: 2 }
    })
  })

  it("accepts 'cloud' as a persisted engine value (greyed in UI, never honored)", () => {
    expect(repairVoiceConfig({ engine: 'cloud' }).engine).toBe('cloud')
    expect(repairVoiceConfig({ engine: 'sherpa-onnx' }).engine).toBe('sherpa-onnx')
  })
})

describe('voiceConfig — prompt-history ring', () => {
  it('defaults to an empty history and repairs a non-array to []', () => {
    expect(repairVoiceConfig({}).promptHistory).toEqual([])
    expect(repairVoiceConfig({ promptHistory: 'nope' }).promptHistory).toEqual([])
    expect(repairVoiceConfig({ promptHistory: null }).promptHistory).toEqual([])
  })

  it('keeps newest-first order and trims each entry', () => {
    expect(
      repairVoiceConfig({ promptHistory: ['  build the app  ', 'run tests'] }).promptHistory
    ).toEqual(['build the app', 'run tests'])
  })

  it('drops empty and non-string entries', () => {
    expect(
      repairVoiceConfig({ promptHistory: ['keep', '', '   ', 7, null, { x: 1 }, 'also'] })
        .promptHistory
    ).toEqual(['keep', 'also'])
  })

  it('hard-caps to MAX_PROMPT_HISTORY, keeping the newest (front of the list)', () => {
    const big = Array.from({ length: MAX_PROMPT_HISTORY + 50 }, (_, i) => `p${i}`)
    const out = repairVoiceConfig({ promptHistory: big }).promptHistory
    expect(out).toHaveLength(MAX_PROMPT_HISTORY)
    expect(out[0]).toBe('p0')
    expect(out[MAX_PROMPT_HISTORY - 1]).toBe(`p${MAX_PROMPT_HISTORY - 1}`)
  })
})
