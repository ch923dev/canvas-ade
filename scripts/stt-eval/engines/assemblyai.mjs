// AssemblyAI batch (async) transcription adapter.
//
// The accuracy tier candidate: 3.1% AA-WER on the independent leaderboard and by far the
// largest biasing headroom of any surveyed vendor (`keyterms_prompt`, up to 1,000 phrases
// of <=6 words). If the eval shows a ~30-term cap is leaving accuracy on the table, this
// is the engine with room to grow into a full repo symbol list.
//
// Three legs, unlike every other adapter: upload -> create -> poll. Billing is per audio
// duration here (not wall-clock socket time as with their streaming product), so polling
// costs nothing but latency.

import { fetchWithTimeout, readJson, EngineError } from './http.mjs'

const BASE = 'https://api.assemblyai.com/v2'
const POLL_INTERVAL_MS = 700
const MAX_POLLS = 90 // ~60s ceiling; eval clips are 3-15s so this is generous

/**
 * `keyterms_prompt` rejects phrases longer than 6 words; a single over-long entry fails
 * the whole request, so filter rather than let one bad corpus row kill an engine's column.
 */
function sanitizeKeyterms(keyterms) {
  return keyterms.filter((t) => t.trim().split(/\s+/).length <= 6)
}

export const assemblyai = {
  id: 'assemblyai',
  label: 'AssemblyAI Universal (batch)',
  biasing: 'keyterms_prompt',
  biasingNote: '`keyterms_prompt`, up to 1000 phrases of <=6 words',
  pricePerMinUsd: 0.0035,
  keyEnv: 'ASSEMBLYAI_API_KEY',
  notes: 'largest biasing headroom surveyed; model id via STT_EVAL_ASSEMBLYAI_MODEL',

  configured() {
    return process.env.ASSEMBLYAI_API_KEY
      ? { ok: true }
      : { ok: false, reason: 'ASSEMBLYAI_API_KEY not set' }
  },

  model() {
    // Vendor model ids have churned (universal / universal-3-pro / universal-3-5-pro).
    // Overridable so a rename does not require a code change.
    return process.env.STT_EVAL_ASSEMBLYAI_MODEL || 'universal'
  },

  async transcribe({ wav, keyterms = [], timeoutMs }) {
    const key = process.env.ASSEMBLYAI_API_KEY
    if (!key) throw new EngineError('ASSEMBLYAI_API_KEY not set')
    const auth = { authorization: key }

    // 1. upload the raw bytes
    const upRes = await fetchWithTimeout(
      `${BASE}/upload`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/octet-stream' },
        body: wav
      },
      timeoutMs
    )
    const { upload_url: uploadUrl } = await readJson(upRes, 'assemblyai upload')
    if (!uploadUrl) throw new EngineError('assemblyai: upload returned no upload_url')

    // 2. create the transcript job
    const terms = sanitizeKeyterms(keyterms)
    const createRes = await fetchWithTimeout(
      `${BASE}/transcript`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_url: uploadUrl,
          speech_model: this.model(),
          language_code: 'en',
          punctuate: true,
          format_text: true,
          ...(terms.length ? { keyterms_prompt: terms } : {})
        })
      },
      timeoutMs
    )
    const created = await readJson(createRes, 'assemblyai create')
    if (!created.id) throw new EngineError('assemblyai: create returned no id')

    // 3. poll to completion
    for (let i = 0; i < MAX_POLLS; i++) {
      const pollRes = await fetchWithTimeout(
        `${BASE}/transcript/${created.id}`,
        { headers: auth },
        timeoutMs
      )
      const job = await readJson(pollRes, 'assemblyai poll')
      if (job.status === 'completed') {
        return { text: (job.text ?? '').trim(), raw: job }
      }
      if (job.status === 'error') {
        throw new EngineError(`assemblyai: ${job.error ?? 'job failed'}`, {
          body: JSON.stringify(job)
        })
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
    throw new EngineError(`assemblyai: job ${created.id} did not complete in time`)
  }
}
