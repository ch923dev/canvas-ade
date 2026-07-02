/**
 * Voice V2 — engine integration: the 16 kHz WAV fixture through a REAL sherpa-onnx
 * OnlineRecognizer via the host's frame processor (plan V2 exit: "WAV fixture →
 * transcript events").
 *
 * Model-gated: runs only when CANVAS_VOICE_MODELS_ROOT points at a voice-models root
 * containing the default Kroko install (`<root>/kroko-en-2025-08-06/…`) — download it in
 * the app (or via voiceModels.downloadModel) first. CI has no model → suite skips.
 *
 * Fixture: test_wavs/0.wav from the Apache-2.0 zipformer-en-2023-06-26 repo (LibriSpeech;
 * expected transcript per its trans.txt: "after early nightfall the yellow lamps would
 * light up here and there the squalid quarter of the brothels").
 */
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { buildRecognizerConfig, createFrameProcessor, type RecognizerLike } from './voiceEngineHost'
import { DEFAULT_VOICE_MODEL_ID, getModelSpec, type VoiceModelPaths } from './voiceModels'

const MODELS_ROOT = process.env.CANVAS_VOICE_MODELS_ROOT
const FRAME_SAMPLES = 1920 // 120 ms @ 16 kHz — the V1 capture frame

/** Minimal RIFF reader for the canonical 16-bit mono PCM fixture (finds the data chunk). */
function readWavPcm16(path: string): Int16Array {
  const buf = readFileSync(path)
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF')
  expect(buf.toString('ascii', 8, 12)).toBe('WAVE')
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      expect(buf.readUInt16LE(off + 8)).toBe(1) // PCM
      expect(buf.readUInt16LE(off + 10)).toBe(1) // mono
      expect(buf.readUInt32LE(off + 12)).toBe(16000)
      expect(buf.readUInt16LE(off + 22)).toBe(16) // bits/sample
    } else if (id === 'data') {
      return new Int16Array(buf.buffer, buf.byteOffset + off + 8, size / 2)
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

describe.runIf(!!MODELS_ROOT)('sherpa-onnx engine ↔ frame processor (model-gated)', () => {
  it(
    'streams the fixture into partials and an endpoint final matching the transcript',
    { timeout: 120_000 },
    () => {
      const spec = getModelSpec(DEFAULT_VOICE_MODEL_ID)!
      const dir = join(MODELS_ROOT!, spec.id)
      const byRole = (role: string): string =>
        join(dir, spec.files.find((f) => f.role === role)!.name)
      const model: VoiceModelPaths = {
        encoder: byRole('encoder'),
        decoder: byRole('decoder'),
        joiner: byRole('joiner'),
        tokens: byRole('tokens')
      }
      const req = createRequire(import.meta.url)
      const sherpa = req('sherpa-onnx-node') as {
        OnlineRecognizer: new (cfg: unknown) => RecognizerLike
      }
      const recognizer = new sherpa.OnlineRecognizer(buildRecognizerConfig(model))

      const events: Array<{ t: string; text: string }> = []
      const proc = createFrameProcessor(recognizer, (m) => events.push(m))

      const here = dirname(fileURLToPath(import.meta.url))
      const samples = readWavPcm16(join(here, '__fixtures__', 'voice-librispeech-16k.wav'))
      for (let i = 0; i + FRAME_SAMPLES <= samples.length; i += FRAME_SAMPLES) {
        const frame = samples.slice(i, i + FRAME_SAMPLES)
        proc.push(frame.buffer as ArrayBuffer)
      }
      // ~3.6 s of silence so endpoint rule1 (2.4 s trailing silence) fires a final.
      const silence = new Int16Array(FRAME_SAMPLES)
      for (let i = 0; i < 30; i++) proc.push(silence.buffer.slice(0) as ArrayBuffer)

      const partials = events.filter((e) => e.t === 'partial')
      const finals = events.filter((e) => e.t === 'final')
      expect(partials.length).toBeGreaterThan(1) // streaming, not one-shot
      expect(finals.length).toBeGreaterThanOrEqual(1)
      const text = finals
        .map((f) => f.text)
        .join(' ')
        .toLowerCase()
      expect(text).toContain('after early nightfall')
      expect(text).toContain('yellow lamps')
    }
  )
})
