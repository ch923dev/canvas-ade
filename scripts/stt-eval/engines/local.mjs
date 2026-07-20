// Local sherpa-onnx OFFLINE (non-streaming) recognizer adapter.
//
// The point of including it: push-to-talk unlocks better LOCAL models for the same reason
// it unlocks better cloud ones — an offline model sees the whole utterance instead of a
// look-ahead window. The app currently ships a STREAMING zipformer; this adapter measures
// what its OFFLINE counterpart is worth on our own audio, for free and fully private.
//
// HOTWORDS ARE INTENTIONALLY BEST-EFFORT, NOT ASSERTED.
// sherpa-onnx supports hotword biasing only on TRANSDUCER models decoded with
// `modified_beam_search` — Whisper/Moonshine/SenseVoice have no local biasing path at
// all. Offline-transducer hotword support landed upstream in Feb 2026 (PR #3077), and
// this repo pins sherpa-onnx-node 1.13.3, whose OfflineRecognizerConfig typedef documents
// only `featConfig`/`modelConfig`. So we pass `decodingMethod`/`hotwordsFile` anyway (the
// native addon reads config by field name; unknown fields are inert) and let the RESULT
// say whether it took: if the biased and unbiased columns come out identical, the pinned
// binding ignored them. That is a finding, not a bug — report it, do not assume it.
//
// Configure with a directory of sherpa offline transducer files:
//   STT_EVAL_LOCAL_MODEL=/path/to/model   (encoder*.onnx, decoder*.onnx, joiner*.onnx, tokens.txt)

import { existsSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeWav } from '../wav.mjs'
import { EngineError } from './http.mjs'

/** Pick the int8 variant when both are present — <1% WER cost for ~75% less memory. */
function findModelFile(dir, prefix) {
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.onnx'))
  if (files.length === 0) return null
  const int8 = files.find((f) => f.includes('int8'))
  return join(dir, int8 ?? files[0])
}

/** sherpa wants Float32 in [-1,1]; the corpus is s16le. */
function pcm16ToFloat32(pcm) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const out = new Float32Array(pcm.byteLength / 2)
  for (let i = 0; i < out.length; i++) {
    const s = view.getInt16(i * 2, true)
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff
  }
  return out
}

// One recognizer per hotword-set, cached: constructing an OfflineRecognizer loads ONNX
// graphs and is far slower than a decode, so building it per utterance would make the
// reported latency meaningless.
const cache = new Map()

async function recognizerFor(modelDir, keyterms) {
  const hotwordsKey = keyterms.length ? keyterms.join('') : ''
  const cached = cache.get(hotwordsKey)
  if (cached) return cached

  const { OfflineRecognizer } = await import('sherpa-onnx-node')
  const encoder = findModelFile(modelDir, 'encoder')
  const decoder = findModelFile(modelDir, 'decoder')
  const joiner = findModelFile(modelDir, 'joiner')
  const tokens = join(modelDir, 'tokens.txt')
  if (!encoder || !decoder || !joiner) {
    throw new EngineError(
      `local: ${modelDir} is not an offline transducer model (need encoder/decoder/joiner .onnx)`
    )
  }
  if (!existsSync(tokens)) throw new EngineError(`local: missing tokens.txt in ${modelDir}`)

  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder, decoder, joiner },
      tokens,
      numThreads: Number(process.env.STT_EVAL_LOCAL_THREADS || 4),
      provider: 'cpu',
      debug: false
    },
    // Hotwords require modified_beam_search — greedy silently ignores them.
    decodingMethod: keyterms.length ? 'modified_beam_search' : 'greedy_search',
    maxActivePaths: 4
  }
  if (keyterms.length) {
    // One hotword per line; sherpa's file format allows an optional `:score` suffix.
    const dir = mkdtempSync(join(tmpdir(), 'stt-eval-hotwords-'))
    const file = join(dir, 'hotwords.txt')
    const score = process.env.STT_EVAL_LOCAL_HOTWORD_SCORE || '2.0'
    writeFileSync(file, keyterms.map((t) => `${t} :${score}`).join('\n') + '\n', 'utf8')
    config.hotwordsFile = file
    config.hotwordsScore = Number(score)
  }
  const rec = await OfflineRecognizer.createAsync(config)
  cache.set(hotwordsKey, rec)
  return rec
}

export const local = {
  id: 'local',
  label: 'Local sherpa-onnx (offline transducer)',
  biasing: 'hotwords',
  biasingNote:
    'sherpa hotwords — transducer + modified_beam_search only; BEST-EFFORT on the pinned 1.13.3 binding',
  pricePerMinUsd: 0,
  keyEnv: null,
  notes: 'set STT_EVAL_LOCAL_MODEL to an offline transducer model dir',

  configured() {
    const dir = process.env.STT_EVAL_LOCAL_MODEL
    if (!dir) return { ok: false, reason: 'STT_EVAL_LOCAL_MODEL not set' }
    if (!existsSync(dir))
      return { ok: false, reason: `STT_EVAL_LOCAL_MODEL path does not exist: ${dir}` }
    return { ok: true }
  },

  model() {
    return process.env.STT_EVAL_LOCAL_MODEL ?? '(unset)'
  },

  async transcribe({ wav, keyterms = [] }) {
    const dir = process.env.STT_EVAL_LOCAL_MODEL
    if (!dir) throw new EngineError('STT_EVAL_LOCAL_MODEL not set')
    const { pcm, sampleRate } = decodeWav(wav)
    if (sampleRate !== 16000) {
      // No resampler here on purpose: the corpus is recorded at 16 kHz, and silently
      // resampling would hide a corpus bug behind a plausible-looking score.
      throw new EngineError(`local: expected 16 kHz audio, got ${sampleRate}`)
    }
    const rec = await recognizerFor(dir, keyterms)
    const stream = rec.createStream()
    stream.acceptWaveform({ sampleRate, samples: pcm16ToFloat32(pcm) })
    const result = await rec.decodeAsync(stream)
    return { text: (result?.text ?? '').trim(), raw: result }
  }
}
