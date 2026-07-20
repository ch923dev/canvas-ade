// Corpus loading + the bias-list construction rule.
//
// Manifest shape (corpus/manifest.json):
//   {
//     "sampleRate": 16000,
//     "utterances": [
//       { "id": "u001", "file": "u001.wav", "reference": "run pnpm typecheck",
//         "keyterms": ["pnpm", "typecheck"] }
//     ]
//   }
//
// THE ONE RULE THAT KEEPS THIS HONEST — read before changing buildBiasList.
// Per-utterance `keyterms` exist to SCORE recall. They must never be fed to the engine as
// that utterance's bias list: in production you cannot know which identifiers a user is
// about to say, so injecting exactly those terms would measure a capability we will never
// have and every provider would look artificially good.
//
// So the biased condition uses ONE list for the whole run — the capped union of the
// corpus's terms — which is the realistic analogue of "a context-ranked list of symbols
// from the open project". The cap is deliberate and low: the OpenAI cookbook measured a
// 30+ term glossary making accuracy WORSE than a short one, and superwhisper's docs warn
// independently that overloading the vocabulary list confuses the model
// (STT-ACCURACY.md §3.1). Raising it past ~30 is a thing to MEASURE, not to assume.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

export const DEFAULT_BIAS_CAP = 30

/** Load + validate a manifest, resolving each utterance's wav path. */
export function loadCorpus(manifestPath) {
  const path = resolve(manifestPath)
  if (!existsSync(path)) {
    throw new Error(`corpus manifest not found: ${path}\nRecord one first: pnpm stt:record`)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`corpus manifest is not valid JSON (${path}): ${err.message}`)
  }
  const dir = dirname(path)
  const utterances = Array.isArray(parsed.utterances) ? parsed.utterances : []
  if (utterances.length === 0) {
    throw new Error(`corpus manifest has no utterances: ${path}`)
  }
  const seen = new Set()
  const loaded = utterances.map((u, i) => {
    if (!u?.id) throw new Error(`corpus entry ${i} has no id`)
    if (seen.has(u.id)) throw new Error(`corpus has duplicate id: ${u.id}`)
    seen.add(u.id)
    if (typeof u.reference !== 'string' || !u.reference.trim()) {
      throw new Error(`corpus entry ${u.id} has no reference transcript`)
    }
    const file = join(dir, u.file ?? `${u.id}.wav`)
    if (!existsSync(file)) throw new Error(`corpus entry ${u.id}: missing audio ${file}`)
    return {
      id: u.id,
      file,
      reference: u.reference.trim(),
      keyterms: Array.isArray(u.keyterms)
        ? u.keyterms.filter((t) => typeof t === 'string' && t.trim())
        : [],
      notes: u.notes ?? null
    }
  })
  return { dir, sampleRate: parsed.sampleRate ?? 16000, utterances: loaded }
}

/**
 * Build the single run-wide bias list: dedupe the corpus's terms, order by frequency
 * (most-mentioned first — the closest stand-in for a relevance ranking), break ties
 * alphabetically for determinism, then cap.
 *
 * Returns `{terms, dropped}` so the report can state plainly how many terms were cut —
 * a silently truncated list would read as "we biased on everything" when we did not.
 */
export function buildBiasList(utterances, cap = DEFAULT_BIAS_CAP) {
  const counts = new Map()
  for (const u of utterances) {
    for (const term of u.keyterms ?? []) {
      const t = term.trim()
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  const ordered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term]) => term)
  return { terms: ordered.slice(0, cap), dropped: Math.max(0, ordered.length - cap) }
}
