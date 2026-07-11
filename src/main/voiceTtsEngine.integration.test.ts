/**
 * Jarvis J1 — TTS engine integration: a REAL sherpa-onnx OfflineTts built from the host's
 * `buildTtsConfig` synthesizes a sentence to non-silent PCM, round-tripped through a WAV
 * (plan J1 exit: "synth-to-WAV integration test").
 *
 * Model-gated like the STT suite: runs only when CANVAS_VOICE_MODELS_ROOT points at a
 * voice-models root containing the CATALOG-layout TTS components (`tts-espeak/`,
 * `tts-kokoro/`, `tts-piper/` — install via voiceTtsModels.downloadTtsModel). Each engine
 * gates its own test, so a Piper-only install still exercises Piper. CI has no models →
 * suite skips.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildTtsConfig,
  createTtsRunner,
  type OfflineTtsLike,
  type TtsOutMsg
} from './voiceEngineHost'
import type { TtsModelPaths } from './voiceTtsModels'

const MODELS_ROOT = process.env.CANVAS_VOICE_MODELS_ROOT

const ESPEAK_DATA = MODELS_ROOT ? join(MODELS_ROOT, 'tts-espeak', 'espeak-ng-data') : ''
const KOKORO_DIR = MODELS_ROOT ? join(MODELS_ROOT, 'tts-kokoro') : ''
const PIPER_DIR = MODELS_ROOT ? join(MODELS_ROOT, 'tts-piper') : ''

const espeakReady = !!MODELS_ROOT && existsSync(join(ESPEAK_DATA, 'phontab'))
const kokoroReady = espeakReady && existsSync(join(KOKORO_DIR, 'model.onnx'))
const piperReady = espeakReady && existsSync(join(PIPER_DIR, 'en_US-lessac-medium.onnx'))

const TEXT = 'Done. The auth terminal is running in the top right group.'

interface EngineCase {
  label: string
  ready: boolean
  paths: TtsModelPaths
  sid: number
  sampleRate: number
}

const CASES: EngineCase[] = [
  {
    label: 'kokoro',
    ready: kokoroReady,
    sid: 4,
    sampleRate: 24000,
    paths: {
      engine: 'kokoro',
      model: join(KOKORO_DIR, 'model.onnx'),
      voices: join(KOKORO_DIR, 'voices.bin'),
      tokens: join(KOKORO_DIR, 'tokens.txt'),
      dataDir: ESPEAK_DATA
    }
  },
  {
    label: 'piper',
    ready: piperReady,
    sid: 0,
    sampleRate: 22050,
    paths: {
      engine: 'vits',
      model: join(PIPER_DIR, 'en_US-lessac-medium.onnx'),
      tokens: join(PIPER_DIR, 'tokens.txt'),
      dataDir: ESPEAK_DATA
    }
  }
]

/** Minimal 16-bit mono PCM WAV writer (the shape the J2 playback path will emit). */
function toWav(samples: Float32Array, sampleRate: number): Buffer {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const dataBytes = pcm.length * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  Buffer.from(pcm.buffer).copy(buf, 44)
  return buf
}

// J2: the speak-queue runner over a REAL engine — the chunk stream actually streams
// (multi-sentence text → ≥2 chunks before done) and a mid-synthesis cancel() stops
// the remaining sentences (the onProgress-return-0 barge-in hook, D6).
describe.runIf(CASES.some((c) => c.ready))(
  'createTtsRunner ↔ real OfflineTts (model-gated)',
  () => {
    // Fallback keeps COLLECTION safe where no model is installed (CI): runIf(false)
    // still executes this describe body to collect titles — only the run is skipped.
    const c = CASES.find((x) => x.ready) ?? CASES[0]
    const MULTI = 'First sentence here. Second sentence follows. Third sentence closes it out.'

    it(
      `${c.label}: streams per-sentence chunks; cancel mid-stream drops the tail`,
      { timeout: 120_000 },
      async () => {
        const req = createRequire(import.meta.url)
        const sherpa = req('sherpa-onnx-node') as {
          OfflineTts: { createAsync(config: unknown): Promise<OfflineTtsLike> }
        }
        const tts = await sherpa.OfflineTts.createAsync(buildTtsConfig(c.paths))

        // Full run: every sentence chunk arrives, then a clean done.
        const full: TtsOutMsg[] = []
        const runner = createTtsRunner(tts, (m) => full.push(m))
        runner.speak({ id: 1, text: MULTI, sid: c.sid, speed: 1.0 })
        await new Promise<void>((resolve) => {
          const iv = setInterval(() => {
            if (full.some((m) => m.t === 'tts:done')) {
              clearInterval(iv)
              resolve()
            }
          }, 50)
        })
        const fullChunks = full.filter(
          (m): m is Extract<TtsOutMsg, { t: 'tts:chunk' }> => m.t === 'tts:chunk'
        )
        expect(fullChunks.length).toBeGreaterThanOrEqual(2)
        expect(full.at(-1)).toEqual({ t: 'tts:done', id: 1, cancelled: false })
        // Chunks carry REAL PCM — guards the sherpa onProgress signature (the callback
        // takes ONE {samples, progress} object; a positional mistake still fires but
        // every chunk goes out 0-byte — the exact bug the J2 dev check caught live).
        for (const chunk of fullChunks) {
          const raw = Buffer.from(chunk.pcm16, 'base64')
          const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2)
          expect(pcm.length).toBeGreaterThan(1000)
          let peak = 0
          for (const s of pcm) peak = Math.max(peak, Math.abs(s) / 32768)
          expect(peak).toBeGreaterThan(0.05)
        }

        // Cancelled run: cancel on the FIRST chunk → fewer chunks than the full run and
        // a cancelled done (sherpa stops synthesizing the remaining sentences).
        const cut: TtsOutMsg[] = []
        const runner2 = createTtsRunner(tts, (m) => {
          cut.push(m)
          if (m.t === 'tts:chunk' && cut.filter((x) => x.t === 'tts:chunk').length === 1) {
            runner2.cancel()
          }
        })
        runner2.speak({ id: 2, text: MULTI, sid: c.sid, speed: 1.0 })
        await new Promise<void>((resolve) => {
          const iv = setInterval(() => {
            if (cut.some((m) => m.t === 'tts:done')) {
              clearInterval(iv)
              resolve()
            }
          }, 50)
        })
        const cutChunks = cut.filter((m) => m.t === 'tts:chunk')
        expect(cutChunks.length).toBeLessThan(fullChunks.length)
        expect(cut.at(-1)).toEqual({ t: 'tts:done', id: 2, cancelled: true })
      }
    )
  }
)

describe.runIf(CASES.some((c) => c.ready))(
  'sherpa-onnx OfflineTts ↔ buildTtsConfig (model-gated)',
  () => {
    for (const c of CASES) {
      it.runIf(c.ready)(
        `${c.label}: synthesizes non-silent audio, streams chunks, round-trips a WAV`,
        { timeout: 120_000 },
        async () => {
          const req = createRequire(import.meta.url)
          const sherpa = req('sherpa-onnx-node') as {
            OfflineTts: { createAsync(config: unknown): Promise<OfflineTtsLike> }
          }
          const tts = await sherpa.OfflineTts.createAsync(buildTtsConfig(c.paths))
          expect(tts.sampleRate).toBe(c.sampleRate)

          let chunks = 0
          const audio = await tts.generateAsync({
            text: TEXT,
            sid: c.sid,
            speed: 1.0,
            onProgress: () => {
              chunks++
              return 1 // continue (0/false = cancel — the J2 barge-in hook)
            }
          })
          // maxNumSentences:1 → sentence-chunked synthesis actually streamed.
          expect(chunks).toBeGreaterThanOrEqual(1)
          expect(audio.sampleRate).toBe(c.sampleRate)
          // A ~4 s sentence: demand at least 1 s of audio and a real (non-silent) signal.
          expect(audio.samples.length).toBeGreaterThan(c.sampleRate)
          let peak = 0
          for (const s of audio.samples) peak = Math.max(peak, Math.abs(s))
          expect(peak).toBeGreaterThan(0.05)

          // Synth-to-WAV: write, re-read, verify the RIFF header + payload size survive.
          const out = join(mkdtempSync(join(tmpdir(), 'voice-tts-itest-')), `${c.label}.wav`)
          writeFileSync(out, toWav(audio.samples, audio.sampleRate))
          const wav = readFileSync(out)
          expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
          expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
          expect(wav.readUInt32LE(24)).toBe(c.sampleRate)
          expect(wav.readUInt32LE(40)).toBe(audio.samples.length * 2)
        }
      )
    }
  }
)
