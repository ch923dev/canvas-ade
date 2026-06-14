import type {
  BoardId,
  BoardOutput,
  BoardResult,
  BoardResultInput,
  BoardStatusChange,
  BoardSummary,
  MemoryDoc
} from '@expanse-ade/mcp'
import type { AuditInput } from './auditLog'
import { createDispatchGuard } from './dispatchGuard'
import { createMcpLifecycle } from './mcpLifecycle'
import { DispatchPayloadError, sanitizeDispatchText } from './dispatchSanitize'
import {
  deriveStatus,
  makeSessionLookup,
  MCP_IDLE_TTL_MS,
  MCP_SPAWN_CAP,
  MCP_SPAWN_GRACE_MS,
  type BoardRegistry,
  type DispatchStatus,
  type LifecycleOrchestrator,
  type OrchestratorOpts
} from './mcpRegistry'

// Re-export the registry/types surface so existing importers (mcp.ts + the test suites)
// keep importing it from './mcpOrchestrator' unchanged after the mcpRegistry split.
export { MCP_SPAWN_CAP, MCP_IDLE_TTL_MS, MCP_SPAWN_GRACE_MS } from './mcpRegistry'
export type {
  BoardRegistry,
  ConnectorMirrorEntry,
  DispatchStatus,
  LifecycleOrchestrator,
  OrchestratorOpts
} from './mcpRegistry'

/**
 * Build an Orchestrator backed by the board mirror, with PTY status overlaid on
 * terminal boards. Pure (type-only package imports → contract test loads no
 * node-pty). spawnBoard/dispatchPrompt/gitDiff stay phase-gated.
 */
export function buildOrchestrator(
  registry: BoardRegistry,
  opts: OrchestratorOpts = {}
): LifecycleOrchestrator {
  const now = opts.now ?? Date.now
  const cap = opts.cap ?? MCP_SPAWN_CAP
  const idleTtlMs = opts.idleTtlMs ?? MCP_IDLE_TTL_MS
  const spawnGraceMs = opts.spawnGraceMs ?? MCP_SPAWN_GRACE_MS
  // 🔒 One single-use-nonce authority per orchestrator (T4.3 dispatch).
  const guard = opts.guard ?? createDispatchGuard()
  const handoffTimeoutMs = opts.handoffTimeoutMs ?? MCP_IDLE_TTL_MS
  // The handoff await-idle backstop deadline, made CANCELLABLE: a fast-settling dispatch clears
  // the real timer in finish() instead of leaving a 5-min timer + closure alive until it no-ops
  // (the prior `void sleep(...).then()` never cancelled). The injected `opts.sleep` seam (tests)
  // still drives the delay when present — its promise can't be cancelled, but finish() is
  // idempotent so a late fire is a harmless no-op and the test leaks no real timer.
  const startBackstop = (ms: number, onExpire: () => void): (() => void) => {
    if (opts.sleep) {
      void opts.sleep(ms).then(onExpire)
      return () => {}
    }
    const t = setTimeout(onExpire, ms)
    t.unref?.()
    return () => clearTimeout(t)
  }
  // A fresh LAZY session-status resolver per logical status read: materialises
  // registry.listSessions() at most once, and only when a terminal-without-mirror-status
  // is actually derived (deriveStatus's terminal-fallback branch — the common read never
  // touches the PTY map). Built fresh each call so it always reflects the LIVE sessions
  // (BUG-008: the handoff await-idle re-resolves the live status on every wake — never a
  // captured snapshot).
  const sessionLookup = (): ((id: string) => string | undefined) =>
    makeSessionLookup(() => registry.listSessions())

  /**
   * Await the dispatched board leaving `running`, event-driven off the status stream (M5 — replaces
   * the old busy-poll). Resolves 'idle' when it settles, 'closed' when it leaves the canvas, or
   * 'timed_out' at the backstop deadline. Re-resolves the LIVE derived status on each wake so a stale
   * pre-write 'running' snapshot can't stall it (BUG-008 discipline).
   */
  const awaitHandoffSettled = (boardId: string): Promise<'idle' | 'closed' | 'timed_out'> => {
    const check = (): 'idle' | 'closed' | null => {
      const live = registry.listBoards().find((b) => b.id === boardId)
      if (!live) return 'closed'
      return deriveStatus(live, sessionLookup()) !== 'running' ? 'idle' : null
    }
    const immediate = check()
    if (immediate) return Promise.resolve(immediate)
    return new Promise<'idle' | 'closed' | 'timed_out'>((resolve) => {
      let settled = false
      let unsub = (): void => {}
      let cancelBackstop = (): void => {}
      const finish = (exit: 'idle' | 'closed' | 'timed_out'): void => {
        if (settled) return
        settled = true
        unsub()
        cancelBackstop()
        resolve(exit)
      }
      unsub = registry.subscribeStatus((change) => {
        if (change.id !== boardId) return
        const c = check()
        if (c) finish(c)
      })
      // One-shot backstop (NOT a poll): a single deadline timer, cancelled on settle.
      cancelBackstop = startBackstop(handoffTimeoutMs, () => finish('timed_out'))
    })
  }

  // 🔒 One typed audit sink for every dispatch/lifecycle write path (T4.1). Routing all
  // audit writes through it pins the `status` field to the closed DispatchStatus vocabulary
  // — an off-vocabulary or typo'd status is a compile error, not a silently-mislabelled
  // forensic line — and removes the repeated literal at each call site.
  const writeAudit = (
    input: Omit<AuditInput, 'status'> & { status: DispatchStatus }
  ): Promise<void> => registry.audit(input)

  /**
   * 🔒 The single, unskippable write gate shared by ALL four PTY-dispatch tools
   * (handoff_prompt / assign_prompt / relay_prompt / interrupt). Centralising the gate IS
   * the hardening: no caller can assemble a partial pipeline. After the caller has resolved
   * the target + proven it is a terminal, this runs the canonical, ORDERED sequence ONCE —
   *   sanitize → issue nonce → human confirm (+evict-on-deny) → pre-write re-check
   *   → consume nonce (+audit-on-replay) → writeToPty (+audit-on-fail) → audit `dispatched`
   * — and audits EVERY branch (BUG-019: post-sanitization entries record safeText, never raw
   * text; BUG-020: a denied/rejected nonce is evicted). The ordering must stay whole and in
   * this order — do not reorder or skip a step. Returns the realised { safeText, nonce, seq }
   * so a caller (handoffPrompt) can run its own await-idle follow-up and record the matching
   * `completed`/`closed`/`timed_out` entry.
   */
  const runGatedWrite = async (d: {
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
  }): Promise<{ safeText: string; nonce: string; seq: number }> => {
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
      writeAudit({ type, targetId, prompt: safeText ?? d.text, nonce, status, ...extra })

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

    // (confirm) Mandatory human confirm — MAIN owns the decision, fail-closed. The body
    // carries the RESOLVED target + the EXACT (sanitized) payload the human is authorizing.
    const { approved } = await registry.confirm({
      title: d.confirmTitle,
      body: d.confirmBody(safeText)
    })
    if (!approved) {
      // 🔒 Evict the issued-but-unredeemed nonce so a denied dispatch does not leak it into
      // the guard's outstanding set forever (BUG-020). consume() deletes it.
      guard.consume(nonce)
      await audit('denied', { detail: seqDetail })
      throw new Error(`${type}: dispatch denied by the human gate`)
    }

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

    // (write) Write into the PTY (safeText + the terminator). A false means no live terminal
    // session held the id — audit failed + throw.
    if (!registry.writeToPty(targetId, safeText + terminator)) {
      await audit('failed', { detail: `pty write failed; ${seqDetail}` })
      throw new Error(`${type}: PTY write failed (no live terminal session)`)
    }

    // (audit dispatched) 🔒 Record the write the MOMENT it lands — BEFORE any (bounded)
    // await-idle follow-up the caller may run — so a crash mid-wait still leaves a durable
    // trail that the command executed in the target shell (the audit log's BEFORE/AFTER
    // contract).
    await audit('dispatched', { detail: seqDetail })
    return { safeText, nonce, seq }
  }

  // The read-only board projection (T1.1). Lifted out of the returned object so the
  // extracted lifecycle cluster (reapIdle) can read the SAME derived per-board statuses
  // through the injected `listBoards` dep, while mcp.ts still calls it via the spread.
  const listBoardSummaries = async (): Promise<BoardSummary[]> => {
    const sessionStatusFor = sessionLookup()
    return registry.listBoards().map((b) => ({
      id: b.id,
      type: b.type,
      title: b.title,
      status: deriveStatus(b, sessionStatusFor),
      // Phase B: forward the v10 agent-identity fields only when present, so a non-terminal
      // (or pre-v10) board's summary is unchanged. agentKind lets an orchestrator route by
      // capability; monitorActivity gates the canvas://attention queue (selectAttention).
      ...(b.agentKind !== undefined ? { agentKind: b.agentKind } : {}),
      ...(b.monitorActivity !== undefined ? { monitorActivity: b.monitorActivity } : {})
    }))
  }

  // The board-lifecycle cluster (spawnBoard / closeBoard / reapIdle + the cap budget,
  // reconcile, and the re-entrancy latch) extracted to a DI factory (mirrors the
  // store-slice split #101). reapIdle reads derived statuses through `listBoardSummaries`.
  const lifecycle = createMcpLifecycle({
    registry,
    now,
    cap,
    idleTtlMs,
    spawnGraceMs,
    listBoards: listBoardSummaries
  })

  return {
    listBoards: listBoardSummaries,
    ...lifecycle,
    async boardStatus(boardId: BoardId): Promise<string> {
      const board = registry.listBoards().find((b) => b.id === boardId)
      if (!board) throw new Error(`board not found: ${boardId}`)
      return deriveStatus(board, sessionLookup())
    },
    async boardOutput(boardId: BoardId, opts?: { cursor?: number }): Promise<BoardOutput> {
      // Read-only scrollback page (T1.4). An absent board reads as empty (the
      // accessor returns an empty page), not an error — output is observational.
      return registry.readOutput(boardId, opts)
    },
    async boardResult(boardId: BoardId): Promise<BoardResult> {
      // Read-only structured last result (T1.5). No result recorded → empty shell.
      return registry.readResult(boardId)
    },
    subscribeStatus(listener: (change: BoardStatusChange) => void): () => void {
      // M5 app-adopt: forward MAIN's per-board status stream (PR1's subscribeBoardStatus)
      // as the package's BoardStatusChange, attaching the board's recorded result when it
      // settles to idle so a barrier can return it. readResult is sync; the result is
      // omitted unless one was actually recorded (present), and only on idle.
      // Phase B: carry `monitorActivity` through unchanged so the attention notifier can gate
      // its push (a `monitorActivity:false` board raises no canvas://attention update).
      return registry.subscribeStatus((change) => {
        const { monitorActivity } = change
        if (change.status === 'idle') {
          const result = registry.readResult(change.id)
          if (result.present) {
            listener({ id: change.id, status: change.status, monitorActivity, result })
            return
          }
        }
        listener({ id: change.id, status: change.status, monitorActivity })
      })
    },
    async projectMemory(): Promise<MemoryDoc> {
      // 🔒 read-only passive context (T1.7). Absent memory engine → empty shell.
      return registry.readMemory()
    },
    async boardSummary(boardId: BoardId): Promise<MemoryDoc> {
      // 🔒 read-only passive context (T1.7). Path-guarded id; absent → empty shell.
      return registry.readSummary(boardId)
    },
    async configureBoard(
      boardId: BoardId,
      config: { shell?: string; launchCommand?: string; cwd?: string }
    ): Promise<void> {
      // 🔒 `launchCommand` is the exec vector (BUG-002): it is free-text written verbatim
      // as the FIRST PTY line on the board's next spawn, so a configure that sets it can
      // pre-stage an arbitrary shell command with deferred execution. It has no live PTY to
      // write into and no single-use nonce (nothing runs now), so it does NOT route through
      // runGatedWrite (the live-PTY dispatch gate); instead it runs the same sanitize →
      // human confirm → audit discipline — BEFORE the value is ever persisted. Shell/cwd-only
      // patches carry no exec vector, so they pass through unchanged (no confirm) to keep the
      // existing contract.
      if (config.launchCommand !== undefined && config.launchCommand !== '') {
        // (a) One launchCommand = one command line. Reject an embedded CR/LF (it would run
        // N commands on spawn) + strip control chars — BEFORE the human gate so a
        // multi-command payload is never shown to the human to rubber-stamp.
        let safeLaunch: string
        try {
          safeLaunch = sanitizeDispatchText(config.launchCommand)
        } catch (err) {
          if (err instanceof DispatchPayloadError) {
            await writeAudit({
              type: 'configure_board',
              targetId: boardId,
              prompt: config.launchCommand,
              nonce: '',
              status: 'rejected',
              detail: `unsafe launchCommand: ${err.message}`
            })
          }
          throw err
        }

        // (b) Mandatory human confirm — MAIN owns the decision, fail-closed. The body
        // carries the target board TITLE (resolved from the live mirror, with UUID fallback)
        // + the EXACT (sanitized) command the human is authorizing.  Mirroring handoffPrompt:
        // the human gate is more effective when the user can identify the board by name.
        const boardEntry = registry.listBoards().find((b) => b.id === boardId)
        const boardLabel = boardEntry?.title ?? boardId
        const { approved } = await registry.confirm({
          title: `Configure launch command for "${boardLabel}"`,
          body: `Set this command to run on terminal "${boardLabel}" the next time it spawns?\n\n${safeLaunch}`
        })
        if (!approved) {
          await writeAudit({
            type: 'configure_board',
            targetId: boardId,
            prompt: safeLaunch,
            nonce: '',
            status: 'rejected',
            detail: 'launchCommand configure denied by the human gate'
          })
          throw new Error('configure_board: launchCommand denied by the human gate')
        }

        // (c) Apply the durable per-type config via the command channel (sanitized value).
        const ack = await registry.sendCommand({
          type: 'configureBoard',
          id: boardId,
          patch: { ...config, launchCommand: safeLaunch }
        })
        if (!ack.ok) {
          // APP-N1: the human approved but the apply failed — record `failed` BEFORE the
          // throw so the audit trail is symmetric with the dispatch paths (every other write
          // path audits a failure). Without this the exact path BUG-002 hardened had a
          // forensic gap: an approved-then-failed configure left no trace.
          await writeAudit({
            type: 'configure_board',
            targetId: boardId,
            prompt: safeLaunch,
            nonce: '',
            status: 'failed',
            detail: `configure_board apply failed: ${ack.error}`
          })
          throw new Error(`configure_board failed: ${ack.error}`)
        }

        // Record the approved configure (target board id + the new launchCommand) AFTER it
        // lands so the audit trail reflects a write that actually persisted.
        await writeAudit({
          type: 'configure_board',
          targetId: boardId,
          prompt: safeLaunch,
          nonce: '',
          status: 'configured',
          detail: 'launchCommand set via configure_board'
        })
        return
      }

      // No launchCommand → no exec vector. Apply the durable per-type config via the command
      // channel. The renderer's updateBoard filters to PATCHABLE_KEYS, so an off-type/
      // ephemeral key is dropped.
      const ack = await registry.sendCommand({ type: 'configureBoard', id: boardId, patch: config })
      if (!ack.ok) throw new Error(`configure_board failed: ${ack.error}`)
    },
    async handoffPrompt(boardId: BoardId, text: string): Promise<BoardResult> {
      // 🔒 The dangerous path: a write into another agent's shell. Resolve the OPAQUE id +
      // prove it is a terminal HERE; the shared write gate then runs the unskippable
      // sanitize→nonce→confirm→consume→write→audit pipeline (every non-write branch still
      // audits). See CLAUDE.md › Process model & security.

      // (1) Resolve the target by its OPAQUE server id (never a label — a title is not an
      // id, so label-targeting can't match here). Not found → audit + throw, no nonce.
      const board = registry.listBoards().find((b) => b.id === boardId)
      if (!board) {
        await writeAudit({
          type: 'handoff_prompt',
          targetId: boardId,
          prompt: text,
          nonce: '',
          status: 'rejected',
          detail: 'board not found'
        })
        throw new Error(`handoff_prompt: board not found: ${boardId}`)
      }

      // (2) Terminal-only. Browser/Planning content must NEVER reach a PTY — reject BEFORE
      // any nonce/confirm/write side effect.
      if (board.type !== 'terminal') {
        await writeAudit({
          type: 'handoff_prompt',
          targetId: boardId,
          prompt: text,
          nonce: '',
          status: 'rejected',
          detail: `non-terminal target (${board.type})`
        })
        throw new Error(`handoff_prompt: target is not a terminal (${board.type})`)
      }

      // (3) The shared, unskippable write gate: sanitize → nonce → confirm → consume →
      // PTY write → audit `dispatched`. Returns the realised safeText/nonce/seq.
      const { safeText, nonce, seq } = await runGatedWrite({
        type: 'handoff_prompt',
        targetId: boardId,
        text,
        terminator: '\r',
        confirmTitle: `Hand off to "${board.title}"`,
        confirmBody: (s) => `Run this prompt in terminal "${board.title}" (${boardId})?\n\n${s}`
      })

      // (4) Await idle — event-driven off the status stream (M5). No busy-poll: park on the
      // first status change for this board (re-resolving the live derived status on wake),
      // bounded by a one-shot backstop deadline.
      const exit = await awaitHandoffSettled(boardId)
      const result = registry.readResult(boardId)

      // (5) Record the dispatch outcome (target + full prompt + nonce + seq + outputs). The
      // status distinguishes a true completion (`completed`) from a board that closed
      // mid-dispatch (`closed`) or never left `running` before the deadline (`timed_out`),
      // so the MCP client/audit trail can tell them apart instead of always seeing
      // `completed` over a false-empty result (BUG-008).
      await writeAudit({
        type: 'handoff_prompt',
        targetId: boardId,
        prompt: safeText,
        nonce,
        status: exit === 'idle' ? 'completed' : exit,
        outputs: JSON.stringify(result),
        detail: `seq=${seq}`
      })
      return result
    },
    async dispatchPrompt(boardId: BoardId, text: string): Promise<void> {
      // 🔒 assign_prompt (T4.4): the FIRE-AND-FORGET sibling of handoffPrompt — the SAME
      // shared write gate MINUS the blocking await-idle/result. Resolve the OPAQUE id +
      // prove it is a terminal HERE, then the gate. See CLAUDE.md › Process model & security.

      // (1) Resolve by OPAQUE id (never a label). Not found → audit + throw, no nonce.
      const board = registry.listBoards().find((b) => b.id === boardId)
      if (!board) {
        await writeAudit({
          type: 'assign_prompt',
          targetId: boardId,
          prompt: text,
          nonce: '',
          status: 'rejected',
          detail: 'board not found'
        })
        throw new Error(`assign_prompt: board not found: ${boardId}`)
      }

      // (2) Terminal-only. Browser/Planning content must NEVER reach a PTY.
      if (board.type !== 'terminal') {
        await writeAudit({
          type: 'assign_prompt',
          targetId: boardId,
          prompt: text,
          nonce: '',
          status: 'rejected',
          detail: `non-terminal target (${board.type})`
        })
        throw new Error(`assign_prompt: target is not a terminal (${board.type})`)
      }

      // (3) The shared, unskippable write gate. Fire-and-forget: no await-idle, no
      // `completed` follow-up — the caller does not block on the target finishing.
      await runGatedWrite({
        type: 'assign_prompt',
        targetId: boardId,
        text,
        terminator: '\r',
        confirmTitle: `Assign to "${board.title}"`,
        confirmBody: (s) => `Run this prompt in terminal "${board.title}" (${boardId})?\n\n${s}`
      })
    },
    async writeResult(boardId: BoardId, result: BoardResultInput): Promise<void> {
      // 🔒 write_result (T4.4, worker-tier write): record the worker's OWN board result.
      // `boardId` is the caller's token-bound board (the tool passes ctx.boardId), so a
      // worker can only write its own. No PTY write, no confirm — it's a self-report. The
      // host stamps `present: true` + `at`; only supplied fields are carried.
      const recorded: BoardResult = { present: true, at: new Date(now()).toISOString() }
      if (result.status !== undefined) recorded.status = result.status
      if (result.summary !== undefined) recorded.summary = result.summary
      if (result.refs !== undefined) recorded.refs = result.refs
      registry.recordResult(boardId, recorded)
    },
    async relayPrompt(sourceId: BoardId, targetId: BoardId, text: string): Promise<void> {
      // 🔒 agent-to-agent relay (T4.6, the M4 gate): a dispatch A→B is authorized by an
      // ORCHESTRATION connector A→B (the spatial cable is the route). Resolve the cable +
      // prove both ends are terminals HERE, then the shared write gate runs the dispatch
      // pipeline; relay's BUG-021 TOCTOU re-check is supplied as the gate's preWriteRecheck.

      // (1) The cable IS the authorization: require a directed orchestration edge A→B.
      // Resolved BEFORE the gate so an unauthorized relay has no side effect.
      const cable = registry
        .listConnectors()
        .find(
          (c) => c.kind === 'orchestration' && c.sourceId === sourceId && c.targetId === targetId
        )
      if (!cable) {
        await writeAudit({
          type: 'relay_prompt',
          targetId,
          prompt: text,
          nonce: '',
          status: 'rejected',
          detail: `no orchestration connector ${sourceId}->${targetId}`
        })
        throw new Error(`relay_prompt: no orchestration connector ${sourceId} -> ${targetId}`)
      }

      // (2) Both ends must be terminals (never Browser→PTY). Resolve by opaque id.
      const boards = registry.listBoards()
      const source = boards.find((b) => b.id === sourceId)
      const target = boards.find((b) => b.id === targetId)
      if (!source || source.type !== 'terminal' || !target || target.type !== 'terminal') {
        await writeAudit({
          type: 'relay_prompt',
          targetId,
          prompt: text,
          nonce: '',
          status: 'rejected',
          detail: `relay requires terminal→terminal (source=${source?.type ?? 'missing'} target=${target?.type ?? 'missing'})`
        })
        throw new Error('relay_prompt: relay requires a terminal source and a terminal target')
      }

      // (3) The shared, unskippable write gate, writing into the TARGET's PTY. The cable
      // re-check (BUG-021) runs inside the gate, after the confirm, before the write.
      await runGatedWrite({
        type: 'relay_prompt',
        targetId,
        text,
        terminator: '\r',
        detailSuffix: `${sourceId}->${targetId}`,
        confirmTitle: `Relay "${source.title}" → "${target.title}"`,
        confirmBody: (s) =>
          `Relay this prompt from terminal "${source.title}" to terminal "${target.title}" (${targetId})?\n\n${s}`,
        // 🔒 TOCTOU re-check (BUG-021): the cable IS the authorization, but the confirm await
        // is unbounded and listConnectors() reads a mutable mirror the renderer can overwrite
        // mid-wait (the user can delete the cable on the canvas while the modal is open).
        // Re-verify the SAME directed orchestration edge still exists BEFORE consuming the
        // nonce / writing — a human who approved "authorized by cable X" must not have the
        // relay fire once that cable is gone.
        preWriteRecheck: (seq) => {
          const cableStillLive = registry
            .listConnectors()
            .some(
              (c) =>
                c.kind === 'orchestration' && c.sourceId === sourceId && c.targetId === targetId
            )
          return cableStillLive
            ? null
            : {
                detail: `authorization cable removed during confirm; ${sourceId}->${targetId}; seq=${seq}`,
                error: `relay_prompt: authorization connector ${sourceId} -> ${targetId} removed during confirm`
              }
        }
      })
    },
    async interrupt(boardId: BoardId): Promise<void> {
      // 🔒 interrupt (T4.5): the content-less sibling — the SAME shared write gate, but it
      // writes a raw Ctrl-C (\x03, NO carriage return) and carries no prompt (sanitization
      // is skipped — there is no command text). Resolve + terminal-check HERE, then the gate.

      // (1) Resolve by OPAQUE id (never a label). Not found → audit + throw, no nonce.
      const board = registry.listBoards().find((b) => b.id === boardId)
      if (!board) {
        await writeAudit({
          type: 'interrupt',
          targetId: boardId,
          prompt: '',
          nonce: '',
          status: 'rejected',
          detail: 'board not found'
        })
        throw new Error(`interrupt: board not found: ${boardId}`)
      }

      // (2) Terminal-only. Browser/Planning never reach a PTY.
      if (board.type !== 'terminal') {
        await writeAudit({
          type: 'interrupt',
          targetId: boardId,
          prompt: '',
          nonce: '',
          status: 'rejected',
          detail: `non-terminal target (${board.type})`
        })
        throw new Error(`interrupt: target is not a terminal (${board.type})`)
      }

      // (3) The shared, unskippable write gate — writes a raw Ctrl-C (terminator '\x03',
      // no sanitization, no carriage return) and audits `dispatched`. Content-less,
      // fire-and-forget.
      await runGatedWrite({
        type: 'interrupt',
        targetId: boardId,
        text: '',
        terminator: '\x03',
        sanitize: false,
        confirmTitle: `Interrupt "${board.title}"`,
        confirmBody: () => `Send Ctrl-C (interrupt) to terminal "${board.title}" (${boardId})?`
      })
    },
    async gitDiff(_boardId: BoardId): Promise<string> {
      throw new Error('gitDiff not available until Phase 6')
    }
  }
}
