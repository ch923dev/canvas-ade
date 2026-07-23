// Deepgram Nova-3 PRE-RECORDED (batch) adapter.
//
// This engine is the harness's CONTROL, not a candidate. Deepgram is the one vendor that
// publishes both figures for the same model — streaming 6.84% WER vs pre-recorded 5.26%
// — which is the number that motivated the whole push-to-talk switch. Running its batch
// endpoint here lets us check that claimed ~23% relative gain reproduces on OUR audio
// before we bet the architecture on it.
//
// It is also the only surveyed vendor that documents raw headerless PCM
// (`encoding=linear16`); we still post a WAV so every engine is fed byte-identical input.

import { fetchWithTimeout, readJson, EngineError } from './http.mjs'

const BASE = 'https://api.deepgram.com/v1/listen'

export const deepgram = {
  id: 'deepgram',
  label: 'Deepgram Nova-3 (pre-recorded)',
  biasing: 'keyterm',
  biasingNote: '`keyterm` repeated in the query string; ~500 token budget, docs advise 20-50',
  pricePerMinUsd: 0.0077,
  keyEnv: 'DEEPGRAM_API_KEY',
  notes: 'control engine — vendor publishes batch 5.26% vs streaming 6.84% WER for this model',

  configured() {
    return process.env.DEEPGRAM_API_KEY
      ? { ok: true }
      : { ok: false, reason: 'DEEPGRAM_API_KEY not set' }
  },

  model() {
    return process.env.STT_EVAL_DEEPGRAM_MODEL || 'nova-3'
  },

  async transcribe({ wav, keyterms = [], timeoutMs }) {
    const key = process.env.DEEPGRAM_API_KEY
    if (!key) throw new EngineError('DEEPGRAM_API_KEY not set')

    const params = new URLSearchParams({
      model: this.model(),
      // smart_format gives punctuation/casing, which keyterm-EXACT recall depends on —
      // without it every identifier comes back lowercased and scores as loose-only.
      smart_format: 'true',
      language: 'en'
    })
    // keyterm is repeated, one parameter per term (NOT comma-joined).
    for (const term of keyterms) params.append('keyterm', term)

    const res = await fetchWithTimeout(
      `${BASE}?${params}`,
      {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
        body: wav
      },
      timeoutMs
    )
    const json = await readJson(res, 'deepgram transcription')
    const text = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript
    if (typeof text !== 'string') {
      throw new EngineError('deepgram: no transcript in response', { body: JSON.stringify(json) })
    }
    return { text: text.trim(), raw: json }
  }
}
