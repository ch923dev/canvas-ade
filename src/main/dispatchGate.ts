import { DispatchPayloadError, sanitizeDispatchText } from './dispatchSanitize'
import type { DispatchGuard } from './dispatchGuard'
import type { AuditInput } from './auditLog'
import type { DispatchStatus } from './mcpRegistry'

/**
 * 🔒 The single, unskippable PTY write gate shared by ALL four dispatch tools
 * (handoff_prompt / assign_prompt / relay_prompt / interrupt) — extracted verbatim from
 * `mcpOrchestrator.ts` (2026-07-03, the max-lines doctrine split — the same move as
 * `mcpKanbanGate`; `buildOrchestrator` injects its guard/registry/audit sink here and spreads
 * nothing: every caller still goes through the ONE returned function). Centralising the gate IS
 * the hardening: no caller can assemble a partial pipeline.
 */

/**
 * 🔒 Submit settle (Command-board dispatch fix, 2026-06-18): an interactive agent TUI (e.g. Claude
 * Code) treats a carriage-return that arrives in the SAME stdin burst as a multi-character,
 * paste-like prompt as a LITERAL newline inside the message — so a prompt written as one
 * `text + \r` chunk lands in the input box UNSENT (the reported bug). The gate therefore writes
 * the prompt TEXT and the SUBMIT (`\r`) as TWO separate PTY writes with this brief gap between
 * them, so the `\r` is delivered as a discrete Enter keystroke and the prompt is actually
 * submitted. Zero under test (NODE_ENV==='test') so unit tests stay instant + deterministic.
 */
const SUBMIT_SETTLE_MS = process.env.NODE_ENV === 'test' ? 0 : 100
const settleBeforeSubmit = (): Promise<void> =>
  SUBMIT_SETTLE_MS <= 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const t = setTimeout(resolve, SUBMIT_SETTLE_MS)
        t.unref?.()
      })

export interface GatedWriteInput {
  /** Audit `type` + thrown-error prefix (e.g. 'handoff_prompt', 'interrupt'). */
  type: string
  /** The RESOLVED opaque target board id (audit targetId + writeToPty target). */
  targetId: string
  /** The raw payload to authorize ('' for the content-less interrupt). */
  text: string
  /** Appended to safeText for the PTY write: '\r' submits a line, '\x03' is a raw Ctrl-C. */
  terminator: '\r' | '\x03'
  /** false skips sanitization (interrupt has no command text to sanitize). Default true. */
  sanitize?: boolean
  confirmTitle: string
  /** Confirm body built AFTER sanitization so it can embed the exact safeText shown+run. */
  confirmBody: (safeText: string) => string
  /** Trailing context appended to detail lines (relay's `${sourceId}->${targetId}`). */
  detailSuffix?: string
  /**
   * 🔒 Optional re-check run AFTER the human approves but BEFORE the nonce is consumed /
   * the PTY is written (relay's BUG-021 TOCTOU: the authorizing cable can be deleted while
   * the modal is open). Return null to proceed, or { detail, error } to evict + reject.
   */
  preWriteRecheck?: (seq: number) => { detail: string; error: string } | null
  /**
   * Readiness gate (2026-07-03): default ON — the write waits (bounded) for the target's BOOT
   * window to quiet so the prompt lands in a ready REPL, not mid-boot. `false` opts out
   * (interrupt: a Ctrl-C into a booting/hung process is legitimate and must not wait). The
   * observation STARTS right after the nonce is issued (in parallel with the human confirm, so
   * the modal's wall-clock usually covers it → the common case adds 0ms) and is AWAITED after
   * approval; the TOCTOU re-check stays immediately before consume/write, so a cable deleted
   * during the readiness wait is still caught. A backstopped/aborted wait DEGRADES the audit to
   * `dispatched_unconfirmed` — the write still happens (failing would regress slow-boot flows
   * the human already approved); honesty moves to the audit + the returned `delivery`.
   */
  awaitReadiness?: boolean
}

export interface GatedWriteResult {
  safeText: string
  nonce: string
  seq: number
  delivery: 'ready' | 'unconfirmed'
}

/** The facet of the board registry + orchestrator plumbing the gate needs (injected). */
export interface DispatchGateDeps {
  guard: DispatchGuard
  confirm(req: { title: string; body: string }): Promise<{ approved: boolean }>
  writeToPty(id: string, text: string): boolean
  awaitReady?(
    id: string,
    opts?: { signal?: AbortSignal }
  ): Promise<{ outcome: string; waitedMs: number }>
  audit(input: Omit<AuditInput, 'status'> & { status: DispatchStatus }): Promise<void>
}

/**
 * Build the gate. After the caller has resolved the target + proven it is a terminal, the
 * returned function runs the canonical, ORDERED sequence ONCE —
 *   sanitize → issue nonce (+start readiness) → human confirm (+evict-on-deny, abort readiness)
 *   → await readiness → pre-write re-check → consume nonce (+audit-on-replay)
 *   → writeToPty (+audit-on-fail) → audit `dispatched`/`dispatched_unconfirmed`
 * — and audits EVERY branch (BUG-019: post-sanitization entries record safeText, never raw
 * text; BUG-020: a denied/rejected nonce is evicted). The ordering must stay whole and in
 * this order — do not reorder or skip a step. Returns the realised { safeText, nonce, seq,
 * delivery } so a caller (handoffPrompt) can run its own await-idle follow-up and record the
 * matching `completed`/`closed`/`timed_out` entry.
 */
export function createGatedWriter(
  deps: DispatchGateDeps
): (d: GatedWriteInput) => Promise<GatedWriteResult> {
  const { guard } = deps
  return async (d: GatedWriteInput): Promise<GatedWriteResult> => {
    const { type, targetId, terminator } = d
    let safeText: string | undefined
    let nonce = ''
    let seq = 0
    // Bound audit: type/targetId fixed; prompt is safeText once sanitized (BUG-019), else the
    // raw text (a pre-sanitization rejection, before safeText exists); nonce is '' until issued.
    const audit = (
      status: DispatchStatus,
      extra?: { detail?: string; outputs?: string }
    ): Promise<void> =>
      deps.audit({ type, targetId, prompt: safeText ?? d.text, nonce, status, ...extra })

    // (sanitize) 🔒 One dispatch = one command line. Reject an embedded CR/LF (it would run N
    // commands from a single approval) + strip control chars — BEFORE nonce/confirm so a
    // multi-command payload is never minted a nonce nor shown to the human to rubber-stamp.
    if (d.sanitize === false) {
      safeText = d.text
    } else {
      try {
        safeText = sanitizeDispatchText(d.text)
      } catch (err) {
        if (err instanceof DispatchPayloadError) {
          await audit('rejected', {
            detail: `unsafe payload: ${err.message}${d.detailSuffix ? `; ${d.detailSuffix}` : ''}`
          })
        }
        throw err
      }
    }

    // (issue) Mint the single-use nonce + monotonic sequence for this dispatch.
    const issued = guard.issue()
    nonce = issued.nonce
    seq = issued.seq
    const seqDetail = d.detailSuffix ? `${d.detailSuffix}; seq=${seq}` : `seq=${seq}`

    // (start readiness — non-blocking) Kick off the boot-readiness observation NOW so it runs in
    // parallel with the human confirm below. Read-only; never rejects (`terminalReadiness`
    // resolves 'unconfirmed' on backstop/abort). Absent probe (older test registries) or an
    // explicit opt-out (interrupt) ⇒ null ⇒ today's write-immediately behaviour.
    const readinessAbort = new AbortController()
    const readinessP =
      d.awaitReadiness !== false && deps.awaitReady
        ? deps.awaitReady(targetId, { signal: readinessAbort.signal })
        : null

    // (confirm) Mandatory human confirm — MAIN owns the decision, fail-closed. The body
    // carries the RESOLVED target + the EXACT (sanitized) payload the human is authorizing.
    const { approved } = await deps.confirm({
      title: d.confirmTitle,
      body: d.confirmBody(safeText)
    })
    if (!approved) {
      // 🔒 Evict the issued-but-unredeemed nonce so a denied dispatch does not leak it into
      // the guard's outstanding set forever (BUG-020). consume() deletes it. Abort the readiness
      // observation too — no timer may outlive a denied dispatch.
      readinessAbort.abort()
      guard.consume(nonce)
      await audit('denied', { detail: seqDetail })
      throw new Error(`${type}: dispatch denied by the human gate`)
    }

    // (await readiness) Bounded by its own backstop; usually already resolved (see above). Runs
    // BEFORE the TOCTOU re-check so the cable check stays immediately adjacent to consume/write —
    // an authorization deleted DURING this wait is still caught.
    const readiness = readinessP ? await readinessP : null
    const readinessDetail = readiness
      ? `; readiness=${readiness.outcome} waited=${readiness.waitedMs}ms`
      : ''

    // (pre-write re-check) 🔒 relay's BUG-021 TOCTOU slots HERE — after confirm, before the
    // nonce is consumed / the PTY is written. A vanished authorization → evict + reject.
    if (d.preWriteRecheck) {
      const failure = d.preWriteRecheck(seq)
      if (failure) {
        guard.consume(nonce)
        await audit('rejected', { detail: failure.detail })
        throw new Error(failure.error)
      }
    }

    // (consume) Redeem the nonce (defensive — a replayed/forged nonce can never reach a
    // write). Belt-and-braces against a re-entrant/duplicated dispatch.
    if (!guard.consume(nonce)) {
      await audit('rejected', { detail: `replayed/forged nonce; ${seqDetail}` })
      throw new Error(`${type}: nonce already consumed (replay rejected)`)
    }

    // (write) Write the prompt TEXT and the submit TERMINATOR as TWO separate PTY writes, with a
    // brief settle between them. An interactive agent TUI (Claude Code) treats a `\r` arriving in the
    // SAME stdin burst as the (multi-char, paste-like) prompt as a LITERAL newline — the prompt lands
    // in the input box UNSENT — and only submits on a `\r` delivered as its OWN discrete keystroke.
    // A content-less write (interrupt: text '') has nothing to settle → terminator only. A false
    // return means no live terminal session held the id — audit failed + throw on the TEXT write
    // FIRST, so a vanished session never receives a lone orphan submit.
    if (safeText.length > 0) {
      if (!deps.writeToPty(targetId, safeText)) {
        await audit('failed', { detail: `pty write failed; ${seqDetail}` })
        throw new Error(`${type}: PTY write failed (no live terminal session)`)
      }
      await settleBeforeSubmit()
    }
    if (!deps.writeToPty(targetId, terminator)) {
      await audit('failed', { detail: `pty write failed; ${seqDetail}` })
      throw new Error(`${type}: PTY write failed (no live terminal session)`)
    }

    // (audit dispatched) 🔒 Record the write the MOMENT it lands — BEFORE any (bounded)
    // await-idle follow-up the caller may run — so a crash mid-wait still leaves a durable
    // trail that the command executed in the target shell (the audit log's BEFORE/AFTER
    // contract).
    //
    // BUG-008: the write has ALREADY committed to the PTY at this point, so a POST-write
    // audit append failure must NOT convert the realised dispatch into a thrown error — that
    // would reject a successful dispatch and a retry would re-run the command in the target
    // shell. The pre-write audit branches (rejected/denied/failed) DO re-throw (no side
    // effect occurred there); here we swallow the rejection and log a forensic-gap warning
    // instead, then resolve with the realised result.
    //
    // Honest ack (2026-07-03): `dispatched` now MEANS "written into a readiness-confirmed
    // REPL". A wait that backstopped/aborted (outcome 'unconfirmed'/'no_session') degrades to
    // `dispatched_unconfirmed` — same write, honest label. No readiness probe wired ⇒ null ⇒
    // today's `dispatched` (older registries keep their exact behaviour).
    const delivered =
      !readiness ||
      readiness.outcome === 'ready' ||
      readiness.outcome === 'ready_latched' ||
      readiness.outcome === 'ready_assumed'
    try {
      await audit(delivered ? 'dispatched' : 'dispatched_unconfirmed', {
        detail: `${seqDetail}${readinessDetail}`
      })
    } catch (err) {
      console.error(
        `[mcp-audit] ${type}: dispatched audit append failed AFTER the PTY write committed; ` +
          'forensic gap (command already ran, not re-thrown to avoid a re-run)',
        err
      )
    }
    return { safeText, nonce, seq, delivery: delivered ? 'ready' : 'unconfirmed' }
  }
}
