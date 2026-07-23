#!/usr/bin/env node
// STT eval runner — the Phase-1.5 decision tool.
//
//   pnpm stt:eval                        # every configured engine, biased + unbiased
//   pnpm stt:eval -- --engines groq,local
//   pnpm stt:eval -- --bias-cap 50 --only biased
//
// Fans the corpus at each engine under each condition, scores with wer.mjs, and writes
// results/<timestamp>.{json,md}. Engines without a credential are SKIPPED and reported as
// skipped — never silently omitted.
//
// WHY BOTH CONDITIONS. The biased-vs-unbiased delta IS the experiment: research says
// keyterm biasing is the single biggest accuracy lever available to us, but it is also
// the one with a documented backfire mode (long glossaries measurably hurt). Running both
// turns that into a number for our own audio instead of a claim from a vendor blog.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCorpus, buildBiasList, DEFAULT_BIAS_CAP } from './corpus.mjs'
import { scoreUtterance, aggregate } from './wer.mjs'
import { wavDurationSeconds } from './wav.mjs'
import { selectEngines } from './engines/index.mjs'
import { withRetry, timed } from './engines/http.mjs'
import { renderReport, rankRows } from './report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_MANIFEST = join(HERE, 'corpus', 'manifest.json')
const RESULTS_DIR = join(HERE, 'results')

function parseArgs(argv) {
  const args = {
    engines: 'all',
    manifest: DEFAULT_MANIFEST,
    biasCap: DEFAULT_BIAS_CAP,
    only: 'both',
    timeoutMs: 60_000,
    delayMs: 0
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--engines') args.engines = next()
    else if (a === '--manifest') args.manifest = next()
    else if (a === '--bias-cap') args.biasCap = Number(next())
    else if (a === '--only')
      args.only = next() // biased | unbiased | both
    else if (a === '--timeout') args.timeoutMs = Number(next())
    else if (a === '--delay') args.delayMs = Number(next())
    else if (a === '--help' || a === '-h') args.help = true
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!['biased', 'unbiased', 'both'].includes(args.only)) {
    throw new Error(`--only must be biased|unbiased|both, got ${args.only}`)
  }
  if (!Number.isFinite(args.biasCap) || args.biasCap < 0)
    throw new Error('--bias-cap must be a non-negative number')
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0)
    throw new Error('--delay must be a non-negative number of ms')
  return args
}

const HELP = `stt-eval — measure WER + keyterm recall on our own audio

  --engines <ids|all>   comma-separated engine ids (default: all)
  --manifest <path>     corpus manifest (default: scripts/stt-eval/corpus/manifest.json)
  --bias-cap <n>        max terms in the run-wide bias list (default: ${DEFAULT_BIAS_CAP})
  --only <cond>         biased | unbiased | both (default: both)
  --timeout <ms>        per-request timeout (default: 60000)
  --delay <ms>          sleep between requests to stay under a rate limit (default: 0).
                        Excluded from the latency column. Free-tier Groq (~20 RPM) needs
                        ~3500; without it half the requests 429 and score as total misses.

Credentials are read from the environment; an engine without one is skipped:
  GROQ_API_KEY · OPENAI_API_KEY · OPENROUTER_API_KEY · ASSEMBLYAI_API_KEY · DEEPGRAM_API_KEY
  STT_EVAL_LOCAL_MODEL=<sherpa offline transducer model dir>
`

/** Median, not mean: one cold-start or one retry would otherwise dominate the latency column. */
function median(values) {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runCondition(engine, utterances, biasTerms, { timeoutMs, label, delayMs = 0 }) {
  const rows = []
  const latencies = []
  let errors = 0
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i]
    // Throttle BEFORE the request (not the first). Sits outside timed(), so the latency
    // column stays a clean per-request measurement even when we're pacing for a rate limit.
    if (delayMs > 0 && i > 0) await sleep(delayMs)
    const wav = readFileSync(u.file)
    try {
      const { value, ms } = await timed(() =>
        withRetry(() => engine.transcribe({ wav, keyterms: biasTerms, timeoutMs }))
      )
      latencies.push(ms)
      rows.push({
        id: u.id,
        reference: u.reference,
        hypothesis: value.text,
        ms,
        score: scoreUtterance({
          reference: u.reference,
          hypothesis: value.text,
          keyterms: u.keyterms
        })
      })
      process.stdout.write('.')
    } catch (err) {
      errors++
      // An engine error is scored as a total miss rather than dropped: an engine that
      // fails on 3 of 30 clips must not out-rank one that answered all 30.
      rows.push({
        id: u.id,
        reference: u.reference,
        hypothesis: '',
        ms: null,
        error: err?.message ?? String(err),
        score: scoreUtterance({ reference: u.reference, hypothesis: '', keyterms: u.keyterms })
      })
      process.stdout.write('x')
    }
  }
  process.stdout.write(` ${engine.id}/${label}\n`)
  return {
    engineId: engine.id,
    label: `${engine.label}`,
    bias: label,
    model: engine.model(),
    pricePerMinUsd: engine.pricePerMinUsd,
    biasingNote: engine.biasingNote ?? null,
    notes: engine.notes ?? null,
    skipped: false,
    errors,
    medianMs: median(latencies),
    utterances: rows,
    agg: aggregate(rows.map((r) => r.score))
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }

  const corpus = loadCorpus(args.manifest)
  const { terms: biasTerms, dropped: biasDropped } = buildBiasList(corpus.utterances, args.biasCap)
  const audioSeconds = corpus.utterances.reduce(
    (sum, u) => sum + wavDurationSeconds(readFileSync(u.file)),
    0
  )
  const engines = selectEngines(args.engines)
  const conditions = args.only === 'both' ? ['unbiased', 'biased'] : [args.only]

  console.log(
    `corpus: ${corpus.utterances.length} utterances (${audioSeconds.toFixed(1)}s) · ` +
      `bias list: ${biasTerms.length}${biasDropped ? ` (+${biasDropped} dropped by cap)` : ''} · ` +
      `engines: ${engines.map((e) => e.id).join(', ')}\n`
  )

  const rows = []
  for (const engine of engines) {
    const status = engine.configured()
    if (!status.ok) {
      console.log(`- ${engine.id}: SKIPPED (${status.reason})`)
      rows.push({
        engineId: engine.id,
        label: engine.label,
        skipped: true,
        skipReason: status.reason,
        pricePerMinUsd: engine.pricePerMinUsd,
        errors: 0,
        utterances: []
      })
      continue
    }
    for (const cond of conditions) {
      rows.push(
        await runCondition(engine, corpus.utterances, cond === 'biased' ? biasTerms : [], {
          timeoutMs: args.timeoutMs,
          label: cond,
          delayMs: args.delayMs
        })
      )
    }
  }

  const meta = {
    startedAt: new Date().toISOString(),
    manifest: args.manifest,
    utteranceCount: corpus.utterances.length,
    audioSeconds,
    biasTerms,
    biasCap: args.biasCap,
    biasDropped,
    conditions
  }

  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = meta.startedAt.replace(/[:.]/g, '-')
  const jsonPath = join(RESULTS_DIR, `${stamp}.json`)
  const mdPath = join(RESULTS_DIR, `${stamp}.md`)
  writeFileSync(jsonPath, JSON.stringify({ meta, rows }, null, 2), 'utf8')
  writeFileSync(mdPath, renderReport({ meta, rows }), 'utf8')

  console.log('')
  for (const r of rankRows(rows)) {
    if (r.skipped) continue
    const k = r.agg.keytermExactRate
    console.log(
      `  ${r.engineId.padEnd(12)} ${r.bias.padEnd(9)} ` +
        `WER ${((r.agg.wer ?? 0) * 100).toFixed(1)}%  ` +
        `keyterm-exact ${k === null ? '—' : (k * 100).toFixed(1) + '%'}  ` +
        `${r.medianMs ?? '—'}ms`
    )
  }
  console.log(`\nwrote ${mdPath}`)
}

main().catch((err) => {
  console.error(`\nstt-eval failed: ${err.message}`)
  process.exitCode = 1
})
