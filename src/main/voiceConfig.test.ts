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
import { DEFAULT_TTS_MODEL_ID } from './voiceTtsModels'

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
  promptHistory: [],
  ttsModelId: DEFAULT_TTS_MODEL_ID,
  ttsDuplex: 'full',
  sttModel: 'gpt-4o-transcribe',
  ttsEngine: 'kokoro',
  ttsCloudModel: 'gpt-4o-mini-tts',
  ttsVoice: 'alloy'
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
      promptHistory: ['deploy the site', 'run the tests'],
      ttsModelId: 'piper-en_US-lessac-medium',
      ttsDuplex: 'half',
      sttModel: 'gpt-4o-mini-transcribe',
      ttsEngine: 'cloud',
      ttsCloudModel: 'tts-1-hd',
      ttsVoice: 'nova'
    }
    writeVoiceConfig(dir, cfg)
    expect(readVoiceConfig(dir)).toEqual(cfg)
  })

  it('J2: preserves an unknown ttsModelId and repairs a junk ttsDuplex to full', () => {
    expect(repairVoiceConfig({ ttsModelId: 'tts-from-the-future' }).ttsModelId).toBe(
      'tts-from-the-future'
    )
    expect(repairVoiceConfig({ ttsModelId: 7 }).ttsModelId).toBe(DEFAULT_TTS_MODEL_ID)
    expect(repairVoiceConfig({ ttsDuplex: 'half' }).ttsDuplex).toBe('half')
    expect(repairVoiceConfig({ ttsDuplex: 'quantum' }).ttsDuplex).toBe('full')
    expect(repairVoiceConfig({}).ttsDuplex).toBe('full')
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

  it('Phase 3: repairs the cloud-TTS fields (ttsEngine/ttsCloudModel/ttsVoice)', () => {
    // ttsEngine is a strict 'kokoro' | 'cloud' — anything else repairs to the local default.
    expect(repairVoiceConfig({ ttsEngine: 'cloud' }).ttsEngine).toBe('cloud')
    expect(repairVoiceConfig({ ttsEngine: 'sherpa-onnx' }).ttsEngine).toBe('kokoro')
    expect(repairVoiceConfig({ ttsEngine: 42 }).ttsEngine).toBe('kokoro')
    expect(repairVoiceConfig({}).ttsEngine).toBe('kokoro')
    // model + voice are free-text: a non-empty string is preserved, junk falls back to the default.
    expect(repairVoiceConfig({ ttsCloudModel: 'tts-1' }).ttsCloudModel).toBe('tts-1')
    expect(repairVoiceConfig({ ttsCloudModel: 7 }).ttsCloudModel).toBe('gpt-4o-mini-tts')
    expect(repairVoiceConfig({ ttsVoice: 'shimmer' }).ttsVoice).toBe('shimmer')
    expect(repairVoiceConfig({ ttsVoice: '' }).ttsVoice).toBe('alloy')
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
