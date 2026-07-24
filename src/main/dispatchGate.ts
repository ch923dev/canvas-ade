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
const SUBMIT_SETTLE_MS = process.env.NODE_ENV === 'test' ? 0 : 150

/**
 * 🔒 Paste-framing + paced chunking (relay cut-off fix, 2026-07-04): a long dispatch previously
 * went to the PTY as ONE raw `proc.write` — a multi-KB synthetic-keystroke burst that an agent
 * TUI mid-boot/redraw can PARTIALLY swallow (observed: a ~1.6KB relay landing with its head
 * missing, tail intact, while the audit said `dispatched`). Two mitigations, both scoped to the
 * gate's text write:
 *  - When the target's foreground app has bracketed paste on (DECSET 2004, tracked MAIN-side by
 *    `ptyPasteMode` and probed via `deps.isBracketedPaste`), wrap the body in `\x1b[200~ …
 *    \x1b[201~` — the TUI then ingests it as ONE atomic paste, exactly like a human paste
 *    through xterm's `term.paste()`. No probe / mode off ⇒ raw body (a plain shell must never
 *    see literal marker bytes).
 *  - Write the (framed) body in small paced chunks so the ConPTY input pipe and the TUI's
 *    stdin reader drain between bursts instead of receiving one multi-KB slug.
 * The payload is sanitized BEFORE framing (ESC stripped), so a dispatch can never forge its own
 * paste markers. Gaps are zero under test to keep unit tests instant + deterministic.
 */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const WRITE_CHUNK_CHARS = 1024
const WRITE_CHUNK_GAP_MS = process.env.NODE_ENV === 'test' ? 0 : 15

/**
 * 🔒 Echo confirmation (honest ack, part 2): after the body is written, wait (bounded) for the
 * target to produce ANY output — a live REPL echoes/repaints on paste ingestion. Echo is
 * INDEPENDENT, POST-write delivery evidence that COMPLEMENTS the pre-write readiness gate: a
 * dispatch is confirmed (`dispatched`) if EITHER the boot window was observed quiet OR the target
 * visibly reacted to the write (`delivered = ready || echoSeen`). Only when BOTH signals are
 * negative — we wrote into a REPL whose boot never settled AND that produced nothing back — does
 * the dispatch honestly degrade to `dispatched_unconfirmed`. This is why echo is composed with OR,
 * not AND: it can only UPGRADE confidence (e.g. a relay into an idle-but-ready agent that readiness
 * can't settle but that echoes the paste), never downgrade a readiness-confirmed write. Zero cap
 * under test ⇒ a single immediate probe check, so unit tests drive both outcomes deterministically.
 */
const ECHO_CONFIRM_MS = process.env.NODE_ENV === 'test' ? 0 : 2000
const ECHO_POLL_MS = 50

const wait = (ms: number): Promise<void> =>
  ms <= 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms)
        t.unref?.()
      })
const settleBeforeSubmit = (): Promise<void> => wait(SUBMIT_SETTLE_MS)

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
  /**
   * 🔒 Batch confirm seam (relay_prompts): supply the confirm DECISION from an outer per-row
   * batch modal instead of raising this dispatch's own single-item confirm. The confirm STEP is
   * still unskippable — the gate always awaits a decision here — but its SOURCE becomes the batch
   * modal (still MAIN-owned, still fail-closed: anything but `approved: true` denies). Everything
   * else is unchanged (evict-on-deny, the TOCTOU re-check, per-item nonce + audit), so a batched
   * dispatch stays exactly one sanitized command line with its own independent gate run — the
   * batch only lets ONE human gesture answer MANY dispatches. When absent, `deps.confirm` (the
   * per-item modal) runs as before. The gate does NOT read `confirmTitle`/`confirmBody` in this
   * mode (the batch modal already rendered the row) — pass placeholders.
   */
  confirmOverride?: () => Promise<{ approved: boolean }>
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
  /**
   * Whether the target's foreground app currently has bracketed paste (DECSET 2004) on — MAIN
   * injects pty.ts's `isBracketedPasteEnabled`. Drives the paste-framing above. Optional so an
   * older registry/test keeps today's raw-write behaviour.
   */
  isBracketedPaste?(id: string): boolean
  /**
   * Ms since the target last produced PTY output (pty.ts's `getTerminalActivityStaleMs`, the
   * same probe the readiness waiter polls). Drives the post-write echo confirmation. Optional so
   * an older registry/test skips the echo check (delivery stays readiness-only).
   */
  activityStaleMs?(id: string): number | undefined
  audit(input: Omit<AuditInput, 'status'> & { status: DispatchStatus }): Promise<void>
}

/**
 * Build the gate. After the caller has resolved the target + proven it is a terminal, the
 * returned function runs the canonical, ORDERED sequence ONCE —
 *   sanitize → issue nonce (+start readiness) → human confirm (+evict-on-deny, abort readiness)
 *   → await readiness → pre-write re-check → consume nonce (+audit-on-replay)
 *   → paste-framed chunked body write (+audit-on-fail) → echo confirm → terminator write
 *   → audit `dispatched`/`dispatched_unconfirmed`
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
    // A `confirmOverride` (relay_prompts batch) supplies the decision from the outer per-row
    // modal instead — the step is still awaited + fail-closed, only its SOURCE differs.
    const { approved } = d.confirmOverride
      ? await d.confirmOverride()
      : await deps.confirm({
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
    // (readiness verdict) Resolve the pre-write delivery signal NOW: it BOTH composes into the
    // final `delivered` (OR echo, below) AND gates the echo poll — an already-`ready` write skips
    // the (up to ECHO_CONFIRM_MS) echo wait entirely, since echo can only UPGRADE `delivered`,
    // never downgrade a readiness-confirmed write. No readiness probe wired ⇒ null ⇒ ready (older
    // registries keep today's `dispatched`).
    const ready =
      !readiness ||
      readiness.outcome === 'ready' ||
      readiness.outcome === 'ready_latched' ||
      readiness.outcome === 'ready_assumed'

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

    // (write) Write the prompt TEXT and the submit TERMINATOR as SEPARATE PTY writes, with a
    // brief settle between them. An interactive agent TUI (Claude Code) treats a `\r` arriving in the
    // SAME stdin burst as the (multi-char, paste-like) prompt as a LITERAL newline — the prompt lands
    // in the input box UNSENT — and only submits on a `\r` delivered as its OWN discrete keystroke.
    // The BODY is paste-framed when the target has DECSET 2004 on and is written in paced chunks
    // (see the framing/chunking rationale above) — the terminator must stay OUTSIDE the paste
    // frame (inside it, `\r` is literal paste content, not a keystroke). A content-less write
    // (interrupt: text '') has nothing to frame/settle → terminator only. A false return means no
    // live terminal session held the id — audit failed + throw on the BODY writes FIRST, so a
    // vanished session never receives a lone orphan submit (a session vanishing MID-body aborts
    // the remaining chunks + the submit the same way).
    // echoSeen defaults FALSE (no positive post-write evidence): with the OR composition below,
    // an absent echo probe or an empty body leaves delivery to the readiness signal alone.
    let echoSeen = false
    if (safeText.length > 0) {
      const body = deps.isBracketedPaste?.(targetId)
        ? `${PASTE_START}${safeText}${PASTE_END}`
        : safeText
      // Chunk by code UNITS, but never split a surrogate pair across two writes: a lone high
      // surrogate at a chunk boundary is UTF-8-encoded to U+FFFD independently in each write,
      // corrupting a non-BMP char (emoji / CJK-ext / math symbol) and defeating byte-exact
      // delivery. When the boundary lands on a high surrogate, pull it back one unit so the pair
      // rides together into the next chunk.
      for (let i = 0; i < body.length; ) {
        let end = Math.min(i + WRITE_CHUNK_CHARS, body.length)
        const lastUnit = body.charCodeAt(end - 1)
        if (end < body.length && lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1
        if (i > 0) await wait(WRITE_CHUNK_GAP_MS)
        if (!deps.writeToPty(targetId, body.slice(i, end))) {
          await audit('failed', { detail: `pty write failed; ${seqDetail}` })
          throw new Error(`${type}: PTY write failed (no live terminal session)`)
        }
        i = end
      }
      // (echo confirm + submit pacing) Bounded wait for the target to visibly react to the body
      // BEFORE the submit. Output-arrived-since-write test: staleMs is now−lastActivityAt, so
      // stale ≤ elapsed ⇔ the last output happened at/after the write began. Degrade-and-submit
      // at the cap (the human already approved) — the ack honesty, not the submit, carries an
      // unseen echo.
      //
      // The poll runs on EVERY bodied write, including an already-`ready` one (changed for
      // PR #381's dev-check repro): a long paste-framed prompt keeps an agent TUI ingesting /
      // repainting past a blind fixed settle, and a `\r` landing inside that burst is treated as
      // a LITERAL newline — the prompt sat UNSENT in the input box while the readiness-confirmed
      // write reported `ready`. Pacing the submit on the target's first post-write output makes
      // the Enter land after ingestion. Ack semantics are UNCHANGED: `delivered = ready ||
      // echoSeen` (echo still only UPGRADES), and `echo=` is still recorded only when readiness
      // did not already carry delivery (see the audit note below).
      if (deps.activityStaleMs) {
        const writeStart = Date.now()
        for (;;) {
          const stale = deps.activityStaleMs(targetId)
          if (stale !== undefined && stale <= Date.now() - writeStart) {
            echoSeen = true
            break
          }
          if (Date.now() - writeStart >= ECHO_CONFIRM_MS) break
          await wait(ECHO_POLL_MS)
        }
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
    // Echo confirm (2026-07-04): the target visibly reacting to the write is independent positive
    // evidence, composed with OR — `dispatched` iff the boot settled (`ready`, resolved above) OR
    // the target echoed; only BOTH-negative degrades to `dispatched_unconfirmed`. `echo=` is
    // recorded ONLY when the ack actually depended on the check (i.e. `!ready`) — on a `ready`
    // write the poll still runs but purely to PACE the submit (see the write step), and stamping
    // its result into a readiness-carried ack would churn audit shape for no forensic gain.
    const delivered = ready || echoSeen
    const echoDetail =
      !ready && deps.activityStaleMs && safeText.length > 0
        ? `; echo=${echoSeen ? 'seen' : 'none'}`
        : ''
    try {
      await audit(delivered ? 'dispatched' : 'dispatched_unconfirmed', {
        detail: `${seqDetail}${readinessDetail}${echoDetail}`
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
