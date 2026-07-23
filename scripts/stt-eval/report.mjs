// Markdown report rendering for the STT eval harness.
//
// Pure functions over the results object so the table shape is unit-tested (report.test.ts)
// rather than eyeballed once and trusted forever.
//
// The table deliberately leads with KEYTERM EXACT, not WER. For dictating code, an engine
// that scores well on WER while mangling every identifier is useless, and the whole reason
// this harness exists is that no public benchmark measures that.

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`)
const num = (v) => (v === null || v === undefined ? '—' : String(v))
const money = (v) => (v === null || v === undefined ? '—' : `$${v.toFixed(5)}`)

/** Sort key: best keyterm-exact first, then lowest WER. Skipped engines sink to the bottom. */
export function rankRows(rows) {
  return [...rows].sort((a, b) => {
    if (a.skipped !== b.skipped) return a.skipped ? 1 : -1
    const ka = a.agg?.keytermExactRate ?? -1
    const kb = b.agg?.keytermExactRate ?? -1
    if (kb !== ka) return kb - ka
    const wa = a.agg?.wer ?? Infinity
    const wb = b.agg?.wer ?? Infinity
    return wa - wb
  })
}

function renderTable(rows) {
  const header = [
    '| Engine | Bias | WER | Keyterm exact | Keyterm loose | Recoverable gap | Median ms | $/min | Errors |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|'
  ]
  // Engine cell = vendor + the model ACTUALLY run. The model can be overridden per run
  // (STT_EVAL_*_MODEL), so a static label would silently mislabel it — always show model().
  const engineCell = (r) => (r.model ? `${r.label} \`${r.model}\`` : r.label)
  const body = rankRows(rows).map((r) => {
    if (r.skipped) {
      return `| ${engineCell(r)} | — | _skipped_ | — | — | — | — | ${money(r.pricePerMinUsd)} | ${r.skipReason} |`
    }
    const gap =
      r.agg.keytermExactRate === null || r.agg.keytermLooseRate === null
        ? '—'
        : pct(r.agg.keytermLooseRate - r.agg.keytermExactRate)
    return `| ${engineCell(r)} | ${r.bias} | ${pct(r.agg.wer)} | ${pct(r.agg.keytermExactRate)} | ${pct(r.agg.keytermLooseRate)} | ${gap} | ${num(r.medianMs)} | ${money(r.pricePerMinUsd)} | ${r.errors} |`
  })
  return [...header, ...body].join('\n')
}

/**
 * Per-term breakdown across engines — the input to the deterministic replacement layer.
 * A term every engine gets loose-but-not-exact is a formatting rule we can just write.
 */
function renderTermTable(rows, biasTerms) {
  const scored = rows.filter((r) => !r.skipped)
  if (scored.length === 0) return '_No engine produced results._'
  const terms = new Map()
  for (const r of scored) {
    for (const u of r.utterances) {
      for (const t of u.score.keyterms.results) {
        const row = terms.get(t.term) ?? { term: t.term, exact: 0, loose: 0, total: 0 }
        row.exact += t.exact ? 1 : 0
        row.loose += t.loose ? 1 : 0
        row.total += 1
        terms.set(t.term, row)
      }
    }
  }
  const lines = ['| Term | In bias list | Exact | Loose | Verdict |', '|---|:--:|---:|---:|---|']
  const ordered = [...terms.values()].sort(
    (a, b) => a.exact / a.total - b.exact / b.total || a.term.localeCompare(b.term)
  )
  for (const t of ordered) {
    const exactRate = t.exact / t.total
    const looseRate = t.loose / t.total
    const verdict =
      exactRate >= 0.9
        ? 'fine'
        : looseRate >= 0.9
          ? '**formatting — fixable with a replacement rule**'
          : looseRate >= 0.5
            ? 'partly misheard'
            : '**genuinely misheard — needs biasing or a better model**'
    lines.push(
      `| \`${t.term}\` | ${biasTerms.includes(t.term) ? '✓' : ''} | ${pct(exactRate)} | ${pct(looseRate)} | ${verdict} |`
    )
  }
  return lines.join('\n')
}

/** Full markdown report. `meta` carries corpus/bias context so a stale file is self-describing. */
export function renderReport({ meta, rows }) {
  const out = []
  out.push('# STT eval results')
  out.push('')
  out.push(`- **Run:** ${meta.startedAt}`)
  out.push(
    `- **Corpus:** ${meta.utteranceCount} utterances, ${meta.audioSeconds.toFixed(1)}s audio total`
  )
  out.push(
    `- **Bias list:** ${meta.biasTerms.length} terms (cap ${meta.biasCap})${meta.biasDropped ? ` — **${meta.biasDropped} dropped by the cap**` : ''}`
  )
  out.push(`- **Conditions:** each engine run ${meta.conditions.join(' and ')}`)
  out.push('')
  out.push("> Bias list is ONE run-wide list, never the utterance's own keyterms — see corpus.mjs.")
  out.push(
    '> "Recoverable gap" = loose minus exact: the share a deterministic replacement layer could fix.'
  )
  out.push(
    "> $/min is the engine's DEFAULT-model rate; a `STT_EVAL_*_MODEL` override may cost differently."
  )
  if (meta.postFormat) {
    out.push(
      `> **§3.2 formatting layer APPLIED** before scoring (${meta.formatSymbolCount}-symbol dict); ` +
        'scores are post-restoration.'
    )
  }
  out.push('')
  out.push('## Ranked results')
  out.push('')
  out.push(renderTable(rows))
  out.push('')
  out.push('## Per-term breakdown')
  out.push('')
  out.push(renderTermTable(rows, meta.biasTerms))
  out.push('')
  out.push('## Bias list used')
  out.push('')
  out.push(meta.biasTerms.length ? meta.biasTerms.map((t) => `\`${t}\``).join(' · ') : '_(empty)_')
  out.push('')
  return out.join('\n')
}
