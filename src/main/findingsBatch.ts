/**
 * End-of-run findings aggregation (orchestration P4) — the DURABLE half.
 *
 * The feed (`commandFeed.ts`) makes a run watchable while it happens; this makes its conclusions
 * keepable after it ends. Both exist because of the same constraint, pulling in opposite directions:
 *
 *   🔒 Every `add_card` is HUMAN-CONFIRMED, and it adds exactly ONE card. So N findings published
 *      the obvious way is N modals — the confirm storm that would make the feature unusable at the
 *      scale it exists for. This module composes all N into ONE batch: one `confirmBatch` modal
 *      with N rows (the shipped `relay_prompts` gate, reused verbatim) resolving to ONE
 *      `patchKanban` carrying N add-ops (the applier already accepts an op ARRAY). One gesture.
 *
 * 🔒 MAIN COMPOSES, THE AGENT DOES NOT SUPPLY. Everything here is derived from results MAIN already
 * holds in `boardResults` — an orchestrator asking to publish names only the destination board and
 * lane. "The reply proposes, MAIN disposes": an agent cannot author a card whose content it did not
 * earn through a worker's own `write_result`.
 *
 * WHAT A "FINDING" IS, HONESTLY. `BoardResult.refs` crosses the wire as `string[]`. The
 * `code-reviewer` role pack ASKS its workers for richer refs (path · line · severity · note · fix),
 * and host-side `reportSchema` validation is a documented future extension (`03-mechanism` item 4)
 * — so what actually arrives is somewhere between `src/main/pty.ts:774` and a whole sentence. The
 * parser below is deliberately tolerant of that whole range and NEVER discards a ref it cannot
 * parse: an unparseable ref becomes a finding whose note is the raw string, which the batch then
 * discloses. Silently dropping the refs we do not understand would quietly lose real findings.
 */
import { flattenLine } from '../shared/commandFeedTypes'

/** One worker's report, as MAIN holds it. */
export interface WorkerReport {
  boardId: string
  /** Role pack id, when the ledger knows it — becomes a card tag. */
  role?: string
  status?: string
  summary?: string
  refs?: string[]
  /** Derived by `boardResultSynth` rather than self-reported. Carried onto the card as provenance. */
  synthesized?: boolean
}

/** The severity vocabulary the `code-reviewer` pack asks for, plus the honest `unknown`. */
export const FINDING_SEVERITIES = ['crit', 'high', 'med', 'low', 'unknown'] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

/** One composed finding — the shape a kanban card is built from. */
export interface Finding {
  /** Project-relative path, when a ref carried one. */
  path?: string
  line?: number
  severity: FindingSeverity
  /** The sentence. Falls back to the raw ref, then to the worker's summary. */
  note: string
  /** Every worker board that reported it. More than one ⇒ independently corroborated (merged). */
  boardIds: string[]
  /** Role packs of the reporting workers (deduped) — card tags. */
  roles: string[]
  /** True when EVERY reporting worker's result was synthesized rather than self-reported. */
  synthesized: boolean
}

/** The composed batch, ready for the confirm modal. */
export interface FindingsBatch {
  findings: Finding[]
  /**
   * The modal's disclosure line — merged count, silent workers, and any cap. Composed HERE so the
   * string has one source (the S1 eyeball rule) and so a caller cannot publish the batch without it.
   */
  disclose: string
  /** Findings the cap dropped. Never silent: the count is in `disclose`. */
  dropped: number
  /** Workers whose report carried nothing at all. Counted in `disclose` — absence, stated. */
  silentWorkers: number
}

/**
 * Hard cap on published findings. Large enough that a real review fan-out fits whole, small enough
 * that one confirm modal stays reviewable — approving 300 rows in one gesture would make the gate
 * theatre rather than consent.
 */
export const MAX_FINDINGS = 60

const MAX_NOTE = 400
const MAX_PATH = 256

/** Severity words a worker might write, mapped onto the closed vocabulary. */
const SEVERITY_WORDS: Record<string, FindingSeverity> = {
  crit: 'crit',
  critical: 'crit',
  blocker: 'crit',
  high: 'high',
  major: 'high',
  med: 'med',
  medium: 'med',
  moderate: 'med',
  minor: 'low',
  low: 'low',
  nit: 'low',
  info: 'low'
}

/** Runtime narrow onto the closed severity vocabulary. */
export function isFindingSeverity(v: unknown): v is FindingSeverity {
  return typeof v === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(v)
}

/**
 * Lane for a severity.
 *
 * 🔒 `unknown` lands in `backlog`, NOT `review`. A finding whose severity we could not read is not
 * evidence that it is urgent — routing it to `review` would let unparseable text quietly outrank
 * a worker's explicit `low`. Backlog keeps it, and the batch disclosure says severities are claims.
 */
export function laneForSeverity(severity: FindingSeverity): string {
  return severity === 'crit' || severity === 'high' || severity === 'med' ? 'review' : 'backlog'
}

const clamp = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s

/** Collapse whitespace + strip control bytes. Shared with the feed so worker text is sanitized
 *  identically wherever it is rendered. */
const flatten = flattenLine

/** A `path:line` / `path:line-endLine` head, when the token looks like one. */
function parseLocator(token: string): { path: string; line?: number } | null {
  // A path needs a separator or an extension to be a path rather than a stray word — otherwise
  // "high" and "TODO" would both become file paths and every finding would claim a location.
  const m = /^([\w./\\@+-]*[/\\][\w./\\@+-]+|[\w.@+-]+\.[A-Za-z0-9]+)(?::(\d+))?(?:-\d+)?$/.exec(
    token
  )
  if (!m) return null
  const line = m[2] !== undefined ? Number.parseInt(m[2], 10) : undefined
  return {
    path: clamp(m[1], MAX_PATH),
    ...(line !== undefined && Number.isFinite(line) && line > 0 ? { line } : {})
  }
}

/**
 * Parse ONE ref string into a finding's location + severity + note.
 *
 * Accepts, in order: a JSON object (a worker that took the role pack's object schema literally and
 * stringified it), then a leading `path:line` locator with an optional severity token, then the
 * whole string as a bare note. It never returns null — see the module header: a ref we cannot read
 * is still a finding, and losing it silently is the failure mode this whole lane exists to prevent.
 */
export function parseRef(raw: string): {
  path?: string
  line?: number
  severity: FindingSeverity
  note: string
  parsed: boolean
} {
  const text = flatten(raw)
  if (text.length === 0) return { severity: 'unknown', note: '', parsed: false }

  // 1 · JSON object form: {"path":"a.ts","line":7,"severity":"high","note":"…"}
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>
      const path =
        typeof o.path === 'string' && o.path.length > 0 ? clamp(o.path, MAX_PATH) : undefined
      const line =
        typeof o.line === 'number' && Number.isFinite(o.line) && o.line > 0
          ? Math.floor(o.line)
          : undefined
      const sevRaw = typeof o.severity === 'string' ? o.severity.toLowerCase() : ''
      const severity = SEVERITY_WORDS[sevRaw] ?? 'unknown'
      const note = typeof o.note === 'string' && o.note.length > 0 ? flatten(o.note) : text
      if (path !== undefined || o.note !== undefined) {
        return {
          ...(path !== undefined ? { path } : {}),
          ...(line !== undefined ? { line } : {}),
          severity,
          note: clamp(note, MAX_NOTE),
          parsed: true
        }
      }
    } catch {
      /* not JSON after all — fall through to the token forms */
    }
  }

  // 2 · token forms: `[high] path:line — note` / `path:line high — note` / `path:line`
  const tokens = text.split(' ')
  let idx = 0
  let severity: FindingSeverity = 'unknown'
  let locator: { path: string; line?: number } | null = null
  // Scan at most the first two tokens for a locator and a severity, in either order — beyond that
  // we are reading prose, and guessing a path out of a sentence invents locations.
  for (let scanned = 0; scanned < 2 && idx < tokens.length; scanned++) {
    const bare = tokens[idx].replace(/^[[(]|[\])]$/g, '').replace(/[,:;—-]+$/, '')
    const sev = SEVERITY_WORDS[bare.toLowerCase()]
    if (sev !== undefined && severity === 'unknown') {
      severity = sev
      idx++
      continue
    }
    const loc = parseLocator(bare)
    if (loc && locator === null) {
      locator = loc
      idx++
      continue
    }
    break
  }
  const rest = tokens
    .slice(idx)
    .join(' ')
    .replace(/^[—–:-]+\s*/, '')
    .trim()
  // A pure locator with no prose is a real, common shape (`src/main/pty.ts:774`) — the note falls
  // back to the locator itself so the card is never blank.
  const note = rest.length > 0 ? rest : text
  return {
    ...(locator?.path !== undefined ? { path: locator.path } : {}),
    ...(locator?.line !== undefined ? { line: locator.line } : {}),
    severity,
    note: clamp(note, MAX_NOTE),
    parsed: locator !== null
  }
}

/** Dedupe key: same file, same line, same claim. Case/space-insensitive on the note. */
function keyOf(f: { path?: string; line?: number; note: string }): string {
  return `${f.path ?? ''}|${f.line ?? ''}|${f.note
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()}`
}

/** Order: worst first, then located-before-unlocated, then by path — the order a human triages in. */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  crit: 0,
  high: 1,
  med: 2,
  low: 3,
  unknown: 4
}

/**
 * Compose N worker reports into ONE reviewable, deduped batch.
 *
 * Mechanical merge only — dedupe by (path, line, normalized note), exactly the rule `03-mechanism`
 * item 5 fixes. It never adjudicates: two workers whose findings CONTRADICT each other both survive
 * as separate rows, because resolving a contradiction is a judgment call and a deterministic rule
 * that fakes one produces confident-wrong merges.
 */
export function composeFindings(reports: ReadonlyArray<WorkerReport>): FindingsBatch {
  const byKey = new Map<string, Finding>()
  let silentWorkers = 0
  let unparsed = 0

  for (const r of reports) {
    const refs = Array.isArray(r.refs) ? r.refs.filter((s) => typeof s === 'string') : []
    const summary = typeof r.summary === 'string' ? flatten(r.summary) : ''
    if (refs.length === 0 && summary.length === 0) {
      silentWorkers++
      continue
    }
    // A report with a summary but no refs is still a finding — one unlocated row carrying what the
    // worker concluded. Dropping it would lose the entire output of any worker that summarizes
    // rather than enumerates.
    const parsedRefs =
      refs.length > 0
        ? refs.map((ref) => parseRef(ref))
        : [
            {
              severity: 'unknown' as FindingSeverity,
              note: clamp(summary, MAX_NOTE),
              parsed: false
            }
          ]

    for (const p of parsedRefs) {
      if (p.note.length === 0) continue
      if (!p.parsed) unparsed++
      const key = keyOf(p)
      const existing = byKey.get(key)
      if (existing) {
        // Same claim from a second worker: corroboration, not a duplicate card. Keep the WORST
        // severity — one reviewer calling it critical is not cancelled by another calling it low.
        if (!existing.boardIds.includes(r.boardId)) existing.boardIds.push(r.boardId)
        if (r.role && !existing.roles.includes(r.role)) existing.roles.push(r.role)
        if (SEVERITY_RANK[p.severity] < SEVERITY_RANK[existing.severity]) {
          existing.severity = p.severity
        }
        // Provenance only stays `synthesized` if EVERY contributor was — one real self-report is
        // enough to make the finding claimed rather than derived.
        existing.synthesized = existing.synthesized && r.synthesized === true
        continue
      }
      byKey.set(key, {
        ...(p.path !== undefined ? { path: p.path } : {}),
        ...(p.line !== undefined ? { line: p.line } : {}),
        severity: p.severity,
        note: p.note,
        boardIds: [r.boardId],
        roles: r.role ? [r.role] : [],
        synthesized: r.synthesized === true
      })
    }
  }

  const all = [...byKey.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      Number(a.path === undefined) - Number(b.path === undefined) ||
      (a.path ?? '').localeCompare(b.path ?? '') ||
      (a.line ?? 0) - (b.line ?? 0)
  )
  const findings = all.slice(0, MAX_FINDINGS)
  const dropped = all.length - findings.length
  const merged = findings.filter((f) => f.boardIds.length > 1).length

  const parts = [
    `${findings.length} finding${findings.length === 1 ? '' : 's'} from ${reports.length} worker${reports.length === 1 ? '' : 's'}`
  ]
  if (merged > 0) parts.push(`${merged} merged by (path, line, note)`)
  if (unparsed > 0)
    parts.push(`${unparsed} ref${unparsed === 1 ? '' : 's'} had no readable location`)
  if (silentWorkers > 0) {
    parts.push(
      `${silentWorkers} worker${silentWorkers === 1 ? '' : 's'} reported nothing and ${silentWorkers === 1 ? 'is' : 'are'} not represented`
    )
  }
  if (dropped > 0) parts.push(`capped at ${MAX_FINDINGS} — ${dropped} dropped`)
  parts.push("severities are the workers' own claims, not verified")

  return { findings, disclose: `${parts.join(' · ')}.`, dropped, silentWorkers }
}

/** The `path:line` reference string a card carries. Empty when the finding has no location. */
export function findingRef(f: Finding): string {
  if (f.path === undefined) return ''
  return f.line === undefined ? f.path : `${f.path}:${f.line}`
}

/** The confirm-modal row label for a finding: who found it, where, how bad, and which lane. */
export function findingLabel(f: Finding, titleOf: (boardId: string) => string): string {
  const who = f.boardIds.map(titleOf).join(' + ')
  const where = findingRef(f) || 'no file reference'
  return `${who} · ${where} · ${f.severity} → lane "${laneForSeverity(f.severity)}"`
}
