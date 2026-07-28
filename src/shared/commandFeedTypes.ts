/**
 * The external-worker observability feed (orchestration P4) — the cross-process contract for
 * carrying a worker's live status + structured self-report onto the Command board.
 *
 * WHY THIS EXISTS. `write_result` is the only no-confirm, own-board-bound worker→orchestrator
 * channel, and until P4 it dead-ended in a MAIN in-memory Map (`boardResults.ts`) read only by the
 * `canvas://board/{id}/result` resource, `awaitSettled`, and the synthesizer. A worker dispatched
 * THROUGH the Command board surfaced in its recap (that dispatch parks `awaitSettled` on it); a
 * worker an EXTERNAL orchestrator spawned surfaced nowhere. This module is the shape that closes it.
 *
 * 🔒 THE LOAD-BEARING CONSTRAINT. High-frequency N-worker status must NEVER be a durable content
 * write: every `add_card`/`add_planning_element` is human-confirmed, so streaming status as durable
 * content fires N confirm prompts at exactly the scale the feature exists for. Everything in this
 * file therefore rides the EPHEMERAL Command-board feed (`commandStore`, never serialized) and
 * costs ZERO human confirms. Durable aggregation is a separate, batched, end-of-run path
 * (`findingsBatch.ts`) that pays exactly ONE confirm for all N findings.
 *
 * Lives in `src/shared/` so MAIN and the renderer cannot drift — a field added on one side is a
 * compile error on the other (the `swarmLedgerTypes` precedent). Value exports are fine here (this
 * module is dependency-free and DOM/Node-free); only `mcpTypes.ts` is declaration-only.
 */

/**
 * The CLOSED lifecycle vocabulary a fed worker can be pushed into.
 *
 * Deliberately NOT identical to `commandStore.TaskStatus`: `blocked` is orthogonal to the kanban
 * columns (a blocked worker is still executing — it just cannot proceed), so the renderer lands it
 * as `executing` + a `blockedTag` chip rather than inventing a sixth column that would make the
 * column counts lie. `queued` is absent by construction: a fed worker already exists, so it can
 * never be waiting for a local dispatch slot.
 */
export const COMMAND_FEED_STATES = [
  'routing',
  'executing',
  'blocked',
  'reporting',
  'done',
  'failed'
] as const
export type CommandFeedState = (typeof COMMAND_FEED_STATES)[number]

/**
 * How many fed (external) tasks the Command board keeps. Beyond this the OLDEST settled fed task is
 * evicted and the board states the drop in its visible string — a silently-capped feed is worse
 * than no feed, because the human reads absence as "nothing happened".
 */
export const MAX_FED_TASKS = 50

/** Field clamps for anything a worker can put on the wire (it is untrusted text). */
export const MAX_FEED_SUMMARY = 4000
export const MAX_FEED_REF = 256
export const MAX_FEED_REFS = 64
export const MAX_FEED_LINE = 200

/**
 * One MAIN → renderer feed push about ONE worker board. Every field beyond `boardId` is optional:
 * a push may carry only a status change, only a result, or both. Absent means "unchanged", never
 * "cleared" — so a status-only push cannot wipe a previously reported result.
 *
 * 🔒 NO TITLE RIDES HERE. The renderer already resolves board titles against the live canvas; MAIN
 * carrying one would make it a second title authority (the rule S2 set with `SwarmTriageRow` and S3
 * kept with `boardId2`). The applier looks the title up itself.
 */
export interface CommandFeedPush {
  /** The worker terminal board's id — the join key, and the only required field. */
  boardId: string
  /** New lifecycle state. Absent ⇒ leave whatever the task already has. */
  state?: CommandFeedState
  /**
   * Why the worker cannot proceed (a `SwarmBlockedTag`, or the worker's own raw status when it
   * self-reported blocked). Only meaningful with `state:'blocked'`; the renderer ignores it
   * otherwise so a stale tag can never outlive the block.
   */
  blockedTag?: string
  /** The worker's structured self-report, when this push carries one. */
  result?: { status?: string; summary?: string; refs?: string[] }
  /**
   * The card's one visible disclosure line, composed MAIN-side so these strings have ONE source
   * (the S1 eyeball bug: a reason not carried in the visible string is a reason that does not
   * exist). Carries the off-vocabulary fallback note, the blocked reason, or the idle interval.
   */
  disclose?: string
  /** The role pack the worker was spawned under, when the ledger knows it. Rendered as a meta chip. */
  role?: string
}

/**
 * The result of classifying a worker's RAW `write_result` status string.
 * `disclose` is set only when the classification is not self-evident from the card — i.e. exactly
 * when the raw value fell off the vocabulary.
 */
export interface FeedClassification {
  state: CommandFeedState
  disclose?: string
  /** Present when the state is `blocked` — the reason tag the chip renders. */
  blockedTag?: string
}

/** Raw statuses a worker may use to say "finished successfully". */
const DONE_WORDS = new Set(['done', 'ok', 'okay', 'success', 'succeeded', 'complete', 'completed'])
/** Raw statuses a worker may use to say "finished badly". */
const FAILED_WORDS = new Set([
  'failed',
  'failure',
  'fail',
  'error',
  'errored',
  'cancelled',
  'canceled'
])
/** Raw statuses a worker may use to say "I cannot proceed". */
const BLOCKED_WORDS = new Set([
  'blocked',
  'needs-input',
  'needs_input',
  'needsinput',
  'waiting',
  'stuck',
  'partial'
])

/**
 * Classify a worker's raw `write_result.status` into the closed feed vocabulary.
 *
 * 🔒 THE SAFE FALLBACK IS `reporting`, AND IT IS DELIBERATE. An unrecognized status means the
 * worker DID report but we cannot say what it reported. `done` would launder an unknown into a
 * success; `failed` would claim a failure nobody reported. `reporting` is non-terminal, so the card
 * stays in the recap's NOW zone and the human keeps watching — and it always carries the raw value
 * in `disclose`, so the surface says exactly what it could not read. It cannot hang forever: the
 * PTY exit path and P2's stall watch still settle the board independently.
 *
 * An ABSENT status is not off-vocabulary — a worker legitimately writes `{summary}` alone — so it
 * classifies as `reporting` with no disclosure noise.
 */
export function classifyFeedStatus(raw: string | undefined | null): FeedClassification {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { state: 'reporting' }
  const norm = raw.trim().toLowerCase()
  if (DONE_WORDS.has(norm)) return { state: 'done' }
  if (FAILED_WORDS.has(norm)) return { state: 'failed' }
  if (BLOCKED_WORDS.has(norm)) return { state: 'blocked', blockedTag: norm }
  return {
    state: 'reporting',
    disclose: `unrecognized status ${JSON.stringify(clampLine(raw))} — treated as unsettled`
  }
}

/** Runtime narrow onto the closed state vocabulary (the applier re-validates the wire — defense in depth). */
export function isCommandFeedState(v: unknown): v is CommandFeedState {
  return typeof v === 'string' && (COMMAND_FEED_STATES as readonly string[]).includes(v)
}

/**
 * Collapse untrusted worker text to ONE clean line: control bytes out, whitespace collapsed.
 * Length-agnostic — {@link clampLine} adds the clamp. Shared so every surface that renders worker
 * text (feed card, findings note, confirm row) sanitizes it identically.
 */
export function flattenLine(v: string): string {
  return clampLine(v, Number.MAX_SAFE_INTEGER)
}

/** Collapse to a single line and clamp — worker text is untrusted and may be multi-line/huge. */
export function clampLine(v: string, max: number = MAX_FEED_LINE): string {
  // Strip C0/C1 control bytes (ANSI escapes, stray CR) BEFORE whitespace-collapsing, so a worker
  // cannot smuggle terminal control sequences into a card label. Matching control characters IS
  // the point here, so the rule that forbids them in a regex is disabled deliberately.
  const flat = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Sanitize + clamp a worker's raw result for the wire. Returns `undefined` when nothing survives,
 * so a garbage report becomes a status-only push instead of an empty result zone.
 */
export function sanitizeFeedResult(
  raw: { status?: unknown; summary?: unknown; refs?: unknown } | undefined | null
): CommandFeedPush['result'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: NonNullable<CommandFeedPush['result']> = {}
  if (typeof raw.status === 'string' && raw.status.trim().length > 0) {
    out.status = clampLine(raw.status, 80)
  }
  if (typeof raw.summary === 'string' && raw.summary.trim().length > 0) {
    const s = raw.summary.trim()
    out.summary = s.length > MAX_FEED_SUMMARY ? `${s.slice(0, MAX_FEED_SUMMARY - 1)}…` : s
  }
  if (Array.isArray(raw.refs)) {
    const refs: string[] = []
    for (const r of raw.refs) {
      if (refs.length >= MAX_FEED_REFS) break
      if (typeof r !== 'string' || r.trim().length === 0) continue
      refs.push(clampLine(r, MAX_FEED_REF))
    }
    if (refs.length > 0) out.refs = refs
  }
  return out.status === undefined && out.summary === undefined && out.refs === undefined
    ? undefined
    : out
}
