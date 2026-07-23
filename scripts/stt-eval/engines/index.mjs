// Engine registry for the STT eval harness.
//
// Every adapter satisfies the same shape, so run.mjs never branches on vendor:
//   id, label, biasing, biasingNote, pricePerMinUsd, keyEnv, notes
//   configured() -> {ok, reason?}     — why an engine is skipped, printed in the report
//   model()      -> string            — recorded per run so results are reproducible
//   transcribe({wav, keyterms, timeoutMs}) -> {text, raw}
//
// An engine with no credential is SKIPPED and reported as such, never silently dropped —
// a missing column in the results table must be explainable.

import { groq, openai, openrouter } from './openaiShape.mjs'
import { deepgram } from './deepgram.mjs'
import { assemblyai } from './assemblyai.mjs'
import { local } from './local.mjs'

/** Registry order = default report order: local first (free), then cheapest cloud upward. */
export const ENGINES = [local, groq, openrouter, assemblyai, openai, deepgram]

export const ENGINES_BY_ID = new Map(ENGINES.map((e) => [e.id, e]))

/** Resolve a comma-separated `--engines` selection, erroring on unknown ids. */
export function selectEngines(spec) {
  if (!spec || spec === 'all') return ENGINES
  const ids = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const unknown = ids.filter((id) => !ENGINES_BY_ID.has(id))
  if (unknown.length) {
    throw new Error(
      `unknown engine id(s): ${unknown.join(', ')} — known: ${[...ENGINES_BY_ID.keys()].join(', ')}`
    )
  }
  return ids.map((id) => ENGINES_BY_ID.get(id))
}

export { EngineError } from './http.mjs'
