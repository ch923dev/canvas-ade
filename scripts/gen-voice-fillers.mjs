/**
 * Jarvis J2 — pre-render the filler WAVs (latency masking, REVIEW-2026-07-10 §3.3):
 * short spoken acks committed as renderer assets so the FIRST audio of a turn is
 * instant while Kokoro synthesizes the real reply (~456 ms warm first-audio).
 *
 * Dev utility, NOT part of the app build (tts-spike.mjs precedent). Re-run only when
 * the persona voice or the phrase set changes; commit the regenerated WAVs.
 *
 * Usage:  CANVAS_VOICE_MODELS_ROOT=<voice-models root with tts-kokoro/tts-espeak>
 *         node scripts/gen-voice-fillers.mjs
 * Output: src/renderer/src/assets/voice/filler-<name>.wav (24 kHz mono 16-bit PCM,
 *         Kokoro sid 4 = af_sky — the PLAN §3.5 persona default voice).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const ROOT = process.env.CANVAS_VOICE_MODELS_ROOT
if (!ROOT) {
  console.error('set CANVAS_VOICE_MODELS_ROOT to a voice-models root (tts-kokoro/tts-espeak)')
  process.exit(1)
}
const KOKORO = join(ROOT, 'tts-kokoro')
const ESPEAK = join(ROOT, 'tts-espeak', 'espeak-ng-data')
if (!existsSync(join(KOKORO, 'model.onnx')) || !existsSync(join(ESPEAK, 'phontab'))) {
  console.error(`Kokoro/espeak components not installed under ${ROOT}`)
  process.exit(1)
}

const FILLERS = {
  'one-moment': 'One moment.',
  'on-it': 'On it.'
}

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
  'src',
  'assets',
  'voice'
)
mkdirSync(OUT_DIR, { recursive: true })

function toWav(samples, sampleRate) {
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

const tts = await sherpa.OfflineTts.createAsync({
  model: {
    kokoro: {
      model: join(KOKORO, 'model.onnx'),
      voices: join(KOKORO, 'voices.bin'),
      tokens: join(KOKORO, 'tokens.txt'),
      dataDir: ESPEAK
    },
    numThreads: 4,
    provider: 'cpu',
    debug: 0
  },
  maxNumSentences: 1
})

for (const [name, text] of Object.entries(FILLERS)) {
  const audio = await tts.generateAsync({ text, sid: 4, speed: 1.0 })
  const out = join(OUT_DIR, `filler-${name}.wav`)
  writeFileSync(out, toWav(audio.samples, audio.sampleRate))
  console.log(`${out}  (${(audio.samples.length / audio.sampleRate).toFixed(2)}s)`)
}
