/**
 * Jarvis J1 — TTS spike (D2 verification).
 *
 * Measures, per engine/thread-count, on this machine:
 *   - init ms (OfflineTts.createAsync)
 *   - first-audio ms (generateAsync first onProgress chunk — the latency that matters
 *     for perceived responsiveness; REVIEW-2026-07-10 §3.1)
 *   - total synth ms + RTF (synth time / audio duration; <1 = faster than realtime)
 *   - writes a WAV per case for a quality listen
 *
 * Usage:  node scripts/tts-spike.mjs <modelsDir> <outDir>
 *   <modelsDir> must contain kokoro-en-v0_19/ and/or vits-piper-en_US-lessac-medium/
 *   (sherpa-onnx tts-models release archives, extracted).
 *
 * Spike-only utility — NOT part of the app build. The J1 engine work ports the winning
 * config into voiceEngineHost; the pack:dir asar proof runs through the host, not this.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const [modelsDir, outDir = './tts-spike-out'] = process.argv.slice(2)
if (!modelsDir) {
  console.error('usage: node scripts/tts-spike.mjs <modelsDir> [outDir]')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

// Short clause = the barge-in/ack shape ("first clause boundary" chunking, REVIEW §3.1);
// long sentence = a typical grounded read-back.
const CLAUSE = 'On it — spawning the auth terminal now.'
const SENTENCE =
  'Done. The auth terminal is running in the top right group, and the browser board is pointed at localhost three thousand.'

const KOKORO_DIR = join(modelsDir, 'kokoro-en-v0_19')
const PIPER_DIR = join(modelsDir, 'vits-piper-en_US-lessac-medium')

/** @returns {{label:string, sid:number, config:object}[]} */
function cases() {
  const out = []
  if (existsSync(join(KOKORO_DIR, 'model.onnx'))) {
    for (const numThreads of [1, 2, 4]) {
      out.push({
        label: `kokoro-fp32-t${numThreads}`,
        sid: 4, // af_sky — the PLAN §3.5 persona default voice
        config: {
          model: {
            kokoro: {
              model: join(KOKORO_DIR, 'model.onnx'),
              voices: join(KOKORO_DIR, 'voices.bin'),
              tokens: join(KOKORO_DIR, 'tokens.txt'),
              dataDir: join(KOKORO_DIR, 'espeak-ng-data')
            },
            numThreads,
            provider: 'cpu',
            debug: 0
          },
          maxNumSentences: 1
        }
      })
    }
  }
  if (existsSync(join(PIPER_DIR, 'en_US-lessac-medium.onnx'))) {
    for (const numThreads of [1, 2]) {
      out.push({
        label: `piper-lessac-medium-t${numThreads}`,
        sid: 0,
        config: {
          model: {
            vits: {
              model: join(PIPER_DIR, 'en_US-lessac-medium.onnx'),
              tokens: join(PIPER_DIR, 'tokens.txt'),
              dataDir: join(PIPER_DIR, 'espeak-ng-data')
            },
            numThreads,
            provider: 'cpu',
            debug: 0
          },
          maxNumSentences: 1
        }
      })
    }
  }
  return out
}

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

async function measure(tts, sid, text) {
  let firstAudioMs = -1
  let chunks = 0
  const t0 = performance.now()
  const audio = await tts.generateAsync({
    text,
    sid,
    speed: 1.0,
    onProgress: () => {
      chunks++
      if (firstAudioMs < 0) firstAudioMs = performance.now() - t0
      return 1 // continue (0/false = cancel — the J2 barge-in flush hook)
    }
  })
  const totalMs = performance.now() - t0
  const durS = audio.samples.length / audio.sampleRate
  return { firstAudioMs, totalMs, chunks, durS, rtf: totalMs / 1000 / durS, audio }
}

const results = []
for (const c of cases()) {
  const tInit0 = performance.now()
  const tts = await sherpa.OfflineTts.createAsync(c.config)
  const initMs = performance.now() - tInit0

  // Warm-up (first generate pays one-time graph warmup; measure steady state separately)
  const cold = await measure(tts, c.sid, CLAUSE)
  const warmClause = await measure(tts, c.sid, CLAUSE)
  const warmSentence = await measure(tts, c.sid, SENTENCE)

  writeFileSync(
    join(outDir, `${c.label}-clause.wav`),
    toWav(warmClause.audio.samples, warmClause.audio.sampleRate)
  )
  writeFileSync(
    join(outDir, `${c.label}-sentence.wav`),
    toWav(warmSentence.audio.samples, warmSentence.audio.sampleRate)
  )

  const row = {
    label: c.label,
    sampleRate: tts.sampleRate,
    numSpeakers: tts.numSpeakers,
    initMs: Math.round(initMs),
    coldClause: fmt(cold),
    warmClause: fmt(warmClause),
    warmSentence: fmt(warmSentence)
  }
  results.push(row)
  console.log(JSON.stringify(row))
}

function fmt(m) {
  return {
    firstAudioMs: Math.round(m.firstAudioMs),
    totalMs: Math.round(m.totalMs),
    chunks: m.chunks,
    audioS: +m.durS.toFixed(2),
    rtf: +m.rtf.toFixed(3)
  }
}

writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2))
console.log(`\nWAVs + results.json → ${outDir}`)
