// OpenAI-shaped batch transcription adapters: Groq, OpenAI, OpenRouter.
//
// All three expose `POST <base>/audio/transcriptions` with the same multipart contract
// (file + model + prompt), so they share one implementation and differ only by config.
//
// BIASING NOTE. Their only biasing lever is the free-text `prompt`, which Whisper-lineage
// models attend to for at most the LAST 224 TOKENS. That aligns with the harness's own
// keyterm cap — the OpenAI cookbook measured a 30+ term glossary making accuracy WORSE
// than a short list, so run.mjs caps the list rather than letting it grow to the API
// limit (STT-ACCURACY.md §3.1).
//
// OPENROUTER IS UNVERIFIED. Its docs describe base64-JSON and multipart uploads but do
// NOT document a biasing parameter at all. We send `prompt` on the OpenAI-compatible
// assumption; if it is ignored, the biased and unbiased columns will come out identical
// — which is exactly the open question this harness was built to answer, so the result
// is reported rather than asserted.

import { fetchWithTimeout, readJson, wavFormData, EngineError } from './http.mjs'

/**
 * Whisper-lineage models read the prompt as a *continuation of prior speech*, not as an
 * instruction — a bare comma-joined list is the shape the OpenAI cookbook recommends.
 */
function promptFor(keyterms) {
  if (!keyterms?.length) return undefined
  return `Technical vocabulary: ${keyterms.join(', ')}.`
}

function makeOpenAiShapeEngine({
  id,
  label,
  base,
  baseEnv,
  keyEnv,
  model,
  modelEnv,
  pricePerMinUsd,
  notes
}) {
  // Base URL is overridable per engine: it lets a corporate proxy or a self-hosted
  // OpenAI-compatible endpoint slot in, and it is how the harness's own end-to-end check
  // points an engine at a local fake vendor without touching this file.
  const baseUrl = () => process.env[baseEnv] || base
  return {
    id,
    label,
    biasing: 'prompt',
    biasingNote: '`prompt`, last 224 tokens only',
    pricePerMinUsd,
    keyEnv,
    notes,
    configured() {
      return process.env[keyEnv] ? { ok: true } : { ok: false, reason: `${keyEnv} not set` }
    },
    model() {
      return process.env[modelEnv] || model
    },
    async transcribe({ wav, keyterms = [], timeoutMs }) {
      const key = process.env[keyEnv]
      if (!key) throw new EngineError(`${keyEnv} not set`)
      const fd = wavFormData(wav, 'utterance.wav', {
        model: this.model(),
        response_format: 'json',
        // Greedy decode: the harness compares engines, and sampling would add run-to-run
        // variance that has nothing to do with the model's accuracy.
        temperature: '0',
        language: 'en',
        prompt: promptFor(keyterms)
      })
      const res = await fetchWithTimeout(
        `${baseUrl()}/audio/transcriptions`,
        { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd },
        timeoutMs
      )
      const json = await readJson(res, `${id} transcription`)
      if (typeof json.text !== 'string') {
        throw new EngineError(`${id}: no text in response`, { body: JSON.stringify(json) })
      }
      return { text: json.text.trim(), raw: json }
    }
  }
}

export const groq = makeOpenAiShapeEngine({
  id: 'groq',
  label: 'Groq whisper-large-v3-turbo',
  base: 'https://api.groq.com/openai/v1',
  baseEnv: 'STT_EVAL_GROQ_BASE',
  keyEnv: 'GROQ_API_KEY',
  model: 'whisper-large-v3-turbo',
  modelEnv: 'STT_EVAL_GROQ_MODEL',
  pricePerMinUsd: 0.000667,
  notes: '10s minimum billable duration; fastest measured provider in research'
})

export const openai = makeOpenAiShapeEngine({
  id: 'openai',
  label: 'OpenAI gpt-4o-transcribe',
  base: 'https://api.openai.com/v1',
  baseEnv: 'STT_EVAL_OPENAI_BASE',
  keyEnv: 'OPENAI_API_KEY',
  model: 'gpt-4o-transcribe',
  modelEnv: 'STT_EVAL_OPENAI_MODEL',
  pricePerMinUsd: 0.006,
  notes: 'word timestamps are whisper-1 only'
})

export const openrouter = makeOpenAiShapeEngine({
  id: 'openrouter',
  label: 'OpenRouter (batch transcription)',
  base: 'https://openrouter.ai/api/v1',
  baseEnv: 'STT_EVAL_OPENROUTER_BASE',
  keyEnv: 'OPENROUTER_API_KEY',
  model: 'openai/whisper-large-v3',
  modelEnv: 'STT_EVAL_OPENROUTER_MODEL',
  pricePerMinUsd: null, // token-priced, no published audio-seconds conversion
  notes:
    'UNVERIFIED: no documented biasing param — identical biased/unbiased scores mean it is ignored'
})
