import type {
  BoardId,
  BoardOutput,
  BoardResult,
  BoardResultInput,
  BoardStatusChange,
  BoardSummary,
  MemoryDoc,
  PlanningElementsSpec
} from '@expanse-ade/mcp'
import type { AuditInput } from './auditLog'
import { createDispatchGuard } from './dispatchGuard'
import { createMcpLifecycle } from './mcpLifecycle'
import { DispatchPayloadError, sanitizeDispatchText } from './dispatchSanitize'
import { buildPlanningOps, PlanningContentError, renderPlanningConfirmBody } from './mcpPlanning'
import { createKanbanMethods } from './mcpKanbanGate'
import { createVisualizeMethod } from './mcpVisualizeGate'
import { buildAppModel, type AppModel } from './appModel'
import { buildLayoutDigest, type LayoutDigest } from './layoutModel'
import { createBoardCardsMethod } from './mcpBoardCards'
import { createTidyMethod } from './mcpTidy'
import { canRelay } from './orchestration/seam'
import {
  deriveStatus,
  makeSessionLookup,
  MCP_IDLE_ACTIVITY_MS,
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
 * file-tree S5: the board summary widened with the optional file-context fields the orchestrator
 * forwards onto `canvas://boards` — a file board's `path` and a planning board's `fileRefs`. The
 * package's `BoardSummary` is the floor; these extra fields survive the resource's `JSON.stringify`
 * (the package serializes `listBoards()` verbatim), reaching an MCP-connected agent as read-only
 * context. A `BoardSummaryWithFiles[]` is assignable to the package's required `BoardSummary[]`.
 */
type BoardSummaryWithFiles = BoardSummary & {
  path?: string
  fileRefs?: Array<{ path: string; label: string }>
  /** P1 canvas awareness: world-space board geometry (top-left x/y + size w/h), forwarded verbatim
   *  onto `canvas://boards` (same JSON.stringify ride-through as path/fileRefs). Absent pre-P1. */
  x?: number
  y?: number
  w?: number
  h?: number
}

/**
 * 🔒 BUG-009: belt-and-suspenders caps for a worker's self-reported write_result fields. The
 * external @expanse-ade/mcp tool schema SHOULD .max() these (a SEPARATE-REPO follow-up), but
 * write_result is an untrusted sink (a worker reports its own result), so MAIN clamps here too —
 * mirroring the sibling sinks (boardRegistry MAX_FIELD_LEN=256, auditLog MAX_LONG=100_000). An
 * unbounded summary/refs would otherwise grow the in-memory results store + the
 * canvas://board/{id}/result payload without limit.
 */
const WRITE_RESULT_MAX_SUMMARY = 100_000
const WRITE_RESULT_MAX_REFS = 256
const WRITE_RESULT_MAX_REF_LEN = 256

/**
 * 🔒 BUG-017: `configureBoard`'s `launchCommand` is the same exec-vector free-text field
 * `spawnGroup` sanitizes (mcpLifecycle.ts), and that sibling path clamps it to 400 chars
 * AFTER sanitizing — but this path only sanitized, with no length bound. An unbounded
 * launchCommand would be shown verbatim in the human-confirm modal body (unusable dialog)
 * and, once approved, persisted verbatim to canvas.json (unbounded on-disk growth). Mirror
 * spawnGroup's cap so the two write paths for the same field enforce the same invariant.
 */
const CONFIGURE_LAUNCH_MAX_LEN = 400

/**
 * 🔒 BUG-009-style belt-and-suspenders cap on the read-only gitDiff output (PR-2). This is a
 * DOWNSTREAM-PAYLOAD bound — it caps what the chip / view-diff / agent actually RECEIVES, mirroring
 * WRITE_RESULT_MAX_SUMMARY. The caller gets a bounded, possibly-truncated diff. It is NOT a MAIN
 * memory guard: by the time this runs the full diff string has already been materialized. The
 * source-side READ bound (so MAIN never holds more than ~the cap of a large/hostile working tree)
 * lives in `gitDiff.ts`, where the read happens.
 */
const GITDIFF_MAX_BYTES = 100_000

/**
 * 🔒 Submit settle (Command-board dispatch fix, 2026-06-18): an interactive agent TUI (e.g. Claude
 * Code) treats a carriage-return that arrives in the SAME stdin burst as a multi-character, paste-like
 * prompt as a LITERAL newline inside the message — so a prompt written as one `text + \r` chunk lands
 * in the input box UNSENT (the reported bug). The gate therefore writes the prompt TEXT and the SUBMIT
 * (`\r`) as TWO separate PTY writes with this brief gap between them, so the `\r` is delivered as a
 * discrete Enter keystroke and the prompt is actually submitted. Zero under test (NODE_ENV==='test')
 * so unit tests stay instant + deterministic; the two-write split itself is unconditional (and is
 * independent of the `opts.sleep` backstop seam, so a never-resolving test sleep can't stall a write).
 */
const SUBMIT_SETTLE_MS = process.env.NODE_ENV === 'test' ? 0 : 100
const settleBeforeSubmit = (): Promise<void> =>
  SUBMIT_SETTLE_MS <= 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const t = setTimeout(resolve, SUBMIT_SETTLE_MS)
        t.unref?.()
      })

/**
 * Build an Orchestrator backed by the board mirror, with PTY status overlaid on
 * terminal boards. Pure (type-only package imports → contract test loads no
 * node-pty). spawnBoard/dispatchPrompt stay phase-gated; gitDiff is live (PR-2, via registry).
 * `addPlanningElements` (S2) implements the package's content-write method (`@expanse-ade/mcp` ≥ 0.11.0).
 */
export function buildOrchestrator(
  registry: BoardRegistry,
  opts: OrchestratorOpts = {}
): LifecycleOrchestrator {
  const now = opts.now ?? Date.now
  // The spawn cap may be a fixed number OR a getter (the live Settings-backed config). Normalize to
  // a getter so the lifecycle's cap check + describeApp's reported rule always read the CURRENT
  // value — a user raising/lowering the cap takes effect without rebuilding the orchestrator.
  // Capture into a const first so the typeof-narrowing survives into the constant-getter closure.
  const capOpt = opts.cap
  const getCap: () => number =
    typeof capOpt === 'function' ? capOpt : (): number => capOpt ?? MCP_SPAWN_CAP
  const idleTtlMs = opts.idleTtlMs ?? MCP_IDLE_TTL_MS
  const spawnGraceMs = opts.spawnGraceMs ?? MCP_SPAWN_GRACE_MS
  // BUG-007: output-silence dormancy threshold for the idle-reaper (see MCP_IDLE_ACTIVITY_MS).
  const idleActivityMs = opts.idleActivityMs ?? MCP_IDLE_ACTIVITY_MS
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

  // BUG-002: a live terminal's derived status is permanently 'running' (there is no
  // per-task running->idle transition on a long-lived agent shell), so the status-stream
  // settle in awaitHandoffSettled never fires and every handoff rode the backstop to
  // 'timed_out'. A worker reporting its OWN result via write_result IS the real task-done
  // marker — so we settle the handoff when a result lands for the target board too. These
  // per-board listeners are fired by writeResult after registry.recordResult lands.
  const resultSettleListeners = new Map<string, Set<() => void>>()
  const onResultSettled = (boardId: string, fn: () => void): (() => void) => {
    let set = resultSettleListeners.get(boardId)
    if (!set) {
      set = new Set()
      resultSettleListeners.set(boardId, set)
    }
    set.add(fn)
    return () => {
      const s = resultSettleListeners.get(boardId)
      if (!s) return
      s.delete(fn)
      if (s.size === 0) resultSettleListeners.delete(boardId)
    }
  }
  const fireResultSettled = (boardId: string): void => {
    const set = resultSettleListeners.get(boardId)
    if (!set) return
    // Copy before firing: a listener's finish() unsubscribes (mutating the set) mid-iteration.
    for (const fn of [...set]) {
      try {
        fn()
      } catch {
        // 🔒 Isolate a throwing listener so one bad settle can't break the fan-out.
      }
    }
  }

  /**
   * Await the dispatched board leaving `running`, event-driven off the status stream (M5 — replaces
   * the old busy-poll). Resolves 'idle' when it settles, 'closed' when it leaves the canvas, or
   * 'timed_out' at the backstop deadline. Re-resolves the LIVE derived status on each wake so a stale
   * pre-write 'running' snapshot can't stall it (BUG-008 discipline).
   *
   * BUG-002: ALSO settles 'idle' when a worker records its own result (write_result) for this board,
   * since a live agent shell never flips its derived status off 'running' — the recorded result is
   * the real task-done signal, so the handoff resolves instead of always riding the backstop.
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
      let unsubResult = (): void => {}
      let cancelBackstop = (): void => {}
      const finish = (exit: 'idle' | 'closed' | 'timed_out'): void => {
        if (settled) return
        settled = true
        unsub()
        unsubResult()
        cancelBackstop()
        resolve(exit)
      }
      unsub = registry.subscribeStatus((change) => {
        if (change.id !== boardId) return
        const c = check()
        if (c) finish(c)
      })
      // BUG-002: a worker writing its OWN result (write_result) is the task-done marker even
      // while its shell stays derived-'running' (a live agent shell never flips off 'running').
      // A result LANDING for this board during the wait settles the handoff as 'idle' — UNLESS
      // the board has meanwhile left the canvas, in which case `check()` reports 'closed'.
      // Fired by writeResult AFTER registry.recordResult lands (a fresh task-done signal, not a
      // pre-existing fixture result — so it can't settle a handoff that never saw a new write).
      unsubResult = onResultSettled(boardId, () => finish(check() ?? 'idle'))
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

  // 🔒 P3 Kanban card writes (add/move/update/remove) — the resolve→kanban-check→confirm→patchKanban
  // →audit gate + the four methods live in ./mcpKanbanGate (keeps this file under the max-lines gate);
  // spread into the returned object below. No PTY / nonce — a card is passive content (ADR 0003).
  const kanbanMethods = createKanbanMethods({
    listBoards: () => registry.listBoards(),
    confirm: (req) => registry.confirm(req),
    sendCommand: (cmd) => registry.sendCommand(cmd),
    audit: writeAudit
  })

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

    // (write) Write the prompt TEXT and the submit TERMINATOR as TWO separate PTY writes, with a
    // brief settle between them. An interactive agent TUI (Claude Code) treats a `\r` arriving in the
    // SAME stdin burst as the (multi-char, paste-like) prompt as a LITERAL newline — the prompt lands
    // in the input box UNSENT — and only submits on a `\r` delivered as its OWN discrete keystroke.
    // A content-less write (interrupt: text '') has nothing to settle → terminator only. A false
    // return means no live terminal session held the id — audit failed + throw on the TEXT write
    // FIRST, so a vanished session never receives a lone orphan submit.
    if (safeText.length > 0) {
      if (!registry.writeToPty(targetId, safeText)) {
        await audit('failed', { detail: `pty write failed; ${seqDetail}` })
        throw new Error(`${type}: PTY write failed (no live terminal session)`)
      }
      await settleBeforeSubmit()
    }
    if (!registry.writeToPty(targetId, terminator)) {
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
    try {
      await audit('dispatched', { detail: seqDetail })
    } catch (err) {
      console.error(
        `[mcp-audit] ${type}: dispatched audit append failed AFTER the PTY write committed; ` +
          'forensic gap (command already ran, not re-thrown to avoid a re-run)',
        err
      )
    }
    return { safeText, nonce, seq }
  }

  // The read-only board projection (T1.1). Lifted out of the returned object so the
  // extracted lifecycle cluster (reapIdle) can read the SAME derived per-board statuses
  // through the injected `listBoards` dep, while mcp.ts still calls it via the spread.
  const listBoardSummaries = async (): Promise<BoardSummaryWithFiles[]> => {
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
      ...(b.monitorActivity !== undefined ? { monitorActivity: b.monitorActivity } : {}),
      // file-tree S5: forward the file-context fields only when present (a file board's path /
      // a planning board's fileRefs), so other boards' summaries stay byte-identical. These ride
      // out verbatim on the `canvas://boards` resource (JSON.stringify of this projection), giving
      // an agent the path of an open File board + the files pinned to a plan — never file content.
      ...(b.path !== undefined ? { path: b.path } : {}),
      ...(b.fileRefs !== undefined ? { fileRefs: b.fileRefs } : {}),
      // P1 canvas awareness: forward world-space geometry when present (mirror-validated finite),
      // so an agent can reason spatially over `canvas://boards`. Absent ⇒ omitted (pre-P1 renderer).
      ...(b.x !== undefined ? { x: b.x } : {}),
      ...(b.y !== undefined ? { y: b.y } : {}),
      ...(b.w !== undefined ? { w: b.w } : {}),
      ...(b.h !== undefined ? { h: b.h } : {})
    }))
  }

  // The board-lifecycle cluster (spawnBoard / closeBoard / reapIdle + the cap budget,
  // reconcile, and the re-entrancy latch) extracted to a DI factory (mirrors the
  // store-slice split #101). reapIdle reads derived statuses through `listBoardSummaries`.
  const lifecycle = createMcpLifecycle({
    registry,
    now,
    cap: getCap,
    idleTtlMs,
    spawnGraceMs,
    idleActivityMs,
    listBoards: listBoardSummaries
  })

  // PR-5/P1b: the Named-Group mirror projected to the shape BOTH self-models consume (describeApp's
  // `canvas.groups` + describeLayout's digest input). Defined once so the projection isn't duplicated.
  const listGroupsProjection = (): Array<{ id: string; name: string; boardIds: string[] }> =>
    (registry.listGroups?.() ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      boardIds: [...g.boardIds]
    }))

  return {
    listBoards: listBoardSummaries,
    ...lifecycle,
    async boardStatus(boardId: BoardId): Promise<string> {
      const board = registry.listBoards().find((b) => b.id === boardId)
      if (!board) throw new Error(`board not found: ${boardId}`)
      return deriveStatus(board, sessionLookup())
    },
    // 🔒 P3b canvas://board/{id}/cards — the READ half of the card loop (one kanban board's lanes+cards,
    // grouped from the live mirror). Built in ./mcpBoardCards + spread here to keep this file under the
    // max-lines gate. Read-only (no PTY / nonce / confirm) — card TEXT the human already sees on-canvas.
    ...createBoardCardsMethod(registry.listBoards),
    // 🔒 P2 tidy_canvas — reposition the whole canvas via the renderer's deterministic packer. Built
    // in ./mcpTidy + spread here to keep this file under the max-lines gate. UN-GATED + content-less
    // (reposition-only, one host-undo reversible — the spawn_group precedent): no cap/mint/confirm/audit.
    ...createTidyMethod({ sendCommand: (cmd) => registry.sendCommand(cmd) }),
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
          safeLaunch = sanitizeDispatchText(config.launchCommand).slice(0, CONFIGURE_LAUNCH_MAX_LEN)
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
          // F6: a human was shown this exact command and chose to block it → the audit verb
          // is `denied` (human said no), NOT `rejected` (which is reserved for automated
          // pre-gate failures: sanitizer reject, board-not-found, type mismatch). On this
          // exec-vector-adjacent path the distinction is forensic, not cosmetic — it tells an
          // auditor whether the system blocked the write before a human saw it or a human
          // explicitly refused it. Mirrors every other human-deny path in this file.
          await writeAudit({
            type: 'configure_board',
            targetId: boardId,
            prompt: safeLaunch,
            nonce: '',
            status: 'denied',
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
      if (!ack.ok) {
        // F7: a shell/cwd change is a durable per-board config write that persists to
        // canvas.json. "No exec vector" exempts it from the human gate, NOT from the audit
        // trace — the locked invariant is that EVERY cross-board write leaves an audit entry,
        // dangerous or not. Record the failed apply BEFORE the throw so the trail is symmetric
        // with the launchCommand path.
        await writeAudit({
          type: 'configure_board',
          targetId: boardId,
          prompt: '',
          nonce: '',
          status: 'failed',
          detail: `configure_board apply failed: ${ack.error}`
        })
        throw new Error(`configure_board failed: ${ack.error}`)
      }
      // F7: record the persisted shell/cwd write. prompt is '' (no exec content — matches the
      // content-less add_planning_elements pattern); detail names which keys were patched
      // (forensically useful) WITHOUT logging the cwd value, which could be a sensitive path.
      await writeAudit({
        type: 'configure_board',
        targetId: boardId,
        prompt: '',
        nonce: '',
        status: 'configured',
        detail: `shell/cwd configured: ${Object.keys(config).join(', ')}`
      })
    },
    async addPlanningElements(boardId: BoardId, spec: PlanningElementsSpec): Promise<void> {
      // 🔒 S2: the FIRST MCP path writing attacker-influenceable CONTENT onto the durable
      // canvas (ADR 0003 §M-expose). Resolve + planning-check HERE; MAIN then
      // validates/sanitizes/caps every element, shows the FULL rendered content in a
      // mandatory write-time human confirm, and only on approval appends it via the command
      // channel. There is NO PTY write and NO nonce — nothing executes; the content is
      // untrusted PASSIVE context that renders but never auto-arms an action (a "Run"-wired
      // item is P4, out of this slice). Every branch audits, mirroring the dispatch paths.
      const auditPlanning = (
        status: DispatchStatus,
        opts2: { prompt?: string; detail?: string } = {}
      ): Promise<void> =>
        writeAudit({
          type: 'add_planning_elements',
          targetId: boardId,
          prompt: opts2.prompt ?? '',
          nonce: '',
          status,
          ...(opts2.detail !== undefined ? { detail: opts2.detail } : {})
        })

      // (1) Resolve by OPAQUE id (never a label). Not found → audit + throw.
      const board = registry.listBoards().find((b) => b.id === boardId)
      if (!board) {
        await auditPlanning('rejected', { detail: 'board not found' })
        throw new Error(`add_planning_elements: board not found: ${boardId}`)
      }

      // (2) Planning-only. Content must NEVER land on a terminal/browser board (a terminal's
      // content reaches a PTY; a planning board is an inert whiteboard).
      if (board.type !== 'planning') {
        await auditPlanning('rejected', { detail: `non-planning target (${board.type})` })
        throw new Error(`add_planning_elements: target is not a planning board (${board.type})`)
      }

      // (3) Validate + sanitize + cap. A malformed / oversized batch is rejected BEFORE the
      // human gate — never minted into ops, never shown to the human to rubber-stamp.
      let ops
      try {
        // MAIN re-validates the agent content from scratch (untrusted) regardless of the
        // tool-layer schema — buildPlanningOps takes `unknown` and rejects anything off-shape.
        ops = buildPlanningOps(spec.elements)
      } catch (err) {
        // Audit EVERY rejection — ADR 0003's contract is that every terminal branch of an agent
        // write is logged. A PlanningContentError is the agent's invalid content; anything else is
        // an unexpected internal failure (e.g. a throw while capping the batch) — neither may leave
        // a silent gap in the audit trail.
        const detail =
          err instanceof PlanningContentError
            ? `invalid content: ${err.message}`
            : `error building ops: ${err instanceof Error ? err.message : String(err)}`
        await auditPlanning('rejected', { detail })
        throw err
      }

      // (4) Mandatory human confirm — MAIN owns the decision, fail-closed. The body carries
      // the FULL rendered content (not a bare count) so injected text can't be rubber-
      // stamped; one batch confirm per write.
      const body = renderPlanningConfirmBody(board.title, ops)
      const { approved } = await registry.confirm({
        title: `Write ${ops.length} item(s) to "${board.title}"`,
        body
      })
      if (!approved) {
        await auditPlanning('denied', { prompt: body, detail: `${ops.length} elements` })
        throw new Error('add_planning_elements: write denied by the human gate')
      }

      // (5) Apply via the command channel. The renderer appends to the planning board's
      // `elements` (PATCHABLE_KEYS.planning) as a discrete undoable edit + re-validates each
      // materialized element (defense in depth). A false ack → audit failed + throw.
      const ack = await registry.sendCommand({ type: 'patchPlanning', id: boardId, ops })
      if (!ack.ok) {
        await auditPlanning('failed', { prompt: body, detail: `apply failed: ${ack.error}` })
        throw new Error(`add_planning_elements failed: ${ack.error}`)
      }

      // (6) Record the landed write — the FULL content in `prompt` for the forensic trail.
      await auditPlanning('applied', { prompt: body, detail: `${ops.length} elements` })
    },
    // 🔒 P3 Kanban card writes (add/move/update/remove) — built in ./mcpKanbanGate (see kanbanMethods).
    ...kanbanMethods,
    // 🔒 P5 plan-visualize (visualize_plan) — the upgraded content-write gate (chooser + create),
    // built in ./mcpVisualizeGate (keeps this file under the max-lines gate). NO PTY / nonce (a board
    // is passive content, ADR 0003). Inlined into the spread to stay under the gate.
    ...createVisualizeMethod({
      confirm: (req) => registry.confirm(req),
      sendCommand: (cmd) => registry.sendCommand(cmd),
      audit: writeAudit
    }),
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
      //
      // BUG-008: this audit lands AFTER the PTY write has committed + the board has run, so
      // an append failure here must not reject the realised handoff (a thrown error would
      // make a caller retry a command that already executed). Swallow + log a forensic-gap
      // warning, then still return the realised result.
      try {
        await writeAudit({
          type: 'handoff_prompt',
          targetId: boardId,
          prompt: safeText,
          nonce,
          status: exit === 'idle' ? 'completed' : exit,
          outputs: JSON.stringify(result),
          detail: `seq=${seq}`
        })
      } catch (err) {
        console.error(
          '[mcp-audit] handoff_prompt: outcome audit append failed AFTER the PTY write ' +
            'committed; forensic gap (handoff already ran, not re-thrown to avoid a re-run)',
          err
        )
      }
      return result
    },
    /**
     * Await a dispatched worker's task to SETTLE without a write (C2e) — the verdict half of a
     * dispatch whose prompt was delivered as a LAUNCH ARG (`claude "<prompt>"`), so there is no
     * handoff write to gate. READ-ONLY: no nonce, no confirm, no PTY write. A live agent shell never
     * flips its derived status off 'running', so we settle on OUTPUT SILENCE — the PTY has been quiet
     * for `SETTLE_QUIET_MS` AFTER first showing activity (reusing the idle-reaper's
     * `boardActivityStaleMs`). A worker recording its OWN result (write_result) settles immediately
     * (fast-path); a board leaving the canvas settles; a one-shot backstop bounds the wait. Returns
     * the board's result (the same shape `handoffPrompt` returns).
     */
    async awaitSettled(boardId: BoardId): Promise<BoardResult> {
      const SETTLE_QUIET_MS = 6000 // PTY silence that reads as "the worker finished its task"
      const SETTLE_POLL_MS = 1000
      const board = registry.listBoards().find((b) => b.id === boardId)
      if (!board) throw new Error(`await_settled: board not found: ${boardId}`)
      if (board.type !== 'terminal') {
        throw new Error(`await_settled: target is not a terminal (${board.type})`)
      }
      await new Promise<void>((resolve) => {
        let done = false
        let sawActivity = false
        let poll: ReturnType<typeof setInterval> | null = null
        let unsubResult = (): void => {}
        let cancelBackstop = (): void => {}
        const finish = (): void => {
          if (done) return
          done = true
          if (poll) clearInterval(poll)
          unsubResult()
          cancelBackstop()
          resolve()
        }
        // write_result fast-path: a worker recording its own result is the real task-done marker.
        unsubResult = onResultSettled(boardId, finish)
        // Output-silence poll: settle once the worker — having shown activity — has been quiet for
        // SETTLE_QUIET_MS, or the board left the canvas. `sawActivity` guards against settling on the
        // INITIAL quiet before the agent has produced any output (still booting).
        poll = setInterval(() => {
          if (!registry.listBoards().some((b) => b.id === boardId)) return finish()
          const stale = registry.boardActivityStaleMs?.(boardId)
          if (typeof stale !== 'number') return
          if (stale < SETTLE_QUIET_MS) sawActivity = true
          else if (sawActivity) finish()
        }, SETTLE_POLL_MS)
        // One-shot backstop — bound the wait if the worker never goes quiet / never reports.
        cancelBackstop = startBackstop(handoffTimeoutMs, finish)
      })
      return registry.readResult(boardId)
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
      // 🔒 BUG-009: clamp the untrusted self-reported fields (the external schema cap is a
      // separate-repo follow-up). Summary is sliced to a max; refs is bounded in BOTH array
      // length AND per-element length so a worker can't grow the results store unbounded.
      if (result.summary !== undefined)
        recorded.summary = result.summary.slice(0, WRITE_RESULT_MAX_SUMMARY)
      if (result.refs !== undefined)
        recorded.refs = result.refs
          .slice(0, WRITE_RESULT_MAX_REFS)
          .map((ref) => ref.slice(0, WRITE_RESULT_MAX_REF_LEN))
      registry.recordResult(boardId, recorded)
      // BUG-002: a worker reporting its own result IS the task-done marker — wake any in-flight
      // handoff await-idle parked on this board (a live agent shell never flips off 'running',
      // so without this the dispatching agent's handoff would always ride the backstop).
      fireResultSettled(boardId)
    },
    async relayPrompt(sourceId: BoardId, targetId: BoardId, text: string): Promise<void> {
      // 🔒 agent-to-agent relay (T4.6, the M4 gate): a dispatch A→B is authorized by an
      // ORCHESTRATION connector A→B (the spatial cable is the route). Resolve the cable +
      // prove both ends are terminals HERE, then the shared write gate runs the dispatch
      // pipeline; relay's BUG-021 TOCTOU re-check is supplied as the gate's preWriteRecheck.

      // (1) The cable IS the authorization: require a directed orchestration edge A→B.
      // Resolved BEFORE the gate so an unauthorized relay has no side effect. `canRelay` (the
      // shared seam predicate) is the SINGLE source of truth — the same fn the connector-aware
      // seam exports, so the gate here and any caller-side check agree by construction.
      if (!canRelay(sourceId, targetId, registry.listConnectors())) {
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
        // relay fire once that cable is gone. Same `canRelay` predicate as the initial check.
        preWriteRecheck: (seq) => {
          return canRelay(sourceId, targetId, registry.listConnectors())
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
    async gitDiff(boardId: BoardId): Promise<string> {
      // The orchestrator owns the policy (board resolution + terminal-check); the git work is a
      // MAIN-injected capability (registry.gitDiff → gitDiff.ts → simple-git, MAIN-only, read-only).
      const board = registry.listBoards().find((b) => b.id === boardId)
      if (!board) throw new Error(`gitDiff: board not found: ${boardId}`)
      if (board.type !== 'terminal') {
        throw new Error(`gitDiff: not a terminal board: ${boardId}`)
      }
      if (!registry.gitDiff) throw new Error('gitDiff not available')
      const raw = await registry.gitDiff(boardId)
      // 🔒 clamp the untrusted diff to a true BYTE bound (BUG-009 pattern). This is a
      // DOWNSTREAM-PAYLOAD cap — it bounds what the chip / view-diff / agent receives, NOT MAIN's
      // resident memory (the full string is already materialized here; the source-side read bound
      // lives in gitDiff.ts). Measure UTF-8 bytes — NOT UTF-16 code units (`.length`) — so a
      // multibyte-heavy diff can't slip past the stated cap, and cut on a char boundary (back off
      // any split trailing multibyte sequence) so the result is STRICTLY <= GITDIFF_MAX_BYTES with
      // no U+FFFD expansion.
      const buf = Buffer.from(raw, 'utf8')
      if (buf.length <= GITDIFF_MAX_BYTES) return raw
      let end = GITDIFF_MAX_BYTES
      while (end > 0 && (buf[end] & 0xc0) === 0x80) end-- // 0b10xxxxxx = a continuation byte
      return buf.subarray(0, end).toString('utf8')
    },
    async describeApp(): Promise<AppModel> {
      // 🔒 PR-3/PR-5: assemble the read-only app self-model (hybrid agency layer). Read-only — no
      // write path, no token. boards/connectors/groups are projected from the live renderer mirror;
      // rules come from this orchestrator's own cap/TTL budget. (PR-5 made `groups` live; a registry
      // that doesn't wire listGroups reads [].)
      const summaries = await listBoardSummaries()
      return buildAppModel({
        // Drop the file-context fields (path/fileRefs) the app-model doesn't carry + default status;
        // everything else — agentKind/monitorActivity + P1 geometry (x/y/w/h) — rides through via
        // `...rest`, so an orchestrator reasoning over `canvas://app-model` sees the same spatial data
        // as `canvas://boards`. (`_`-prefixed drops are ignored by noUnusedLocals; keeps this <700.)
        boards: summaries.map(({ path: _path, fileRefs: _fileRefs, status, ...rest }) => ({
          ...rest,
          status: status ?? 'static'
        })),
        connectors: registry.listConnectors().map((c) => ({
          id: c.id,
          sourceId: c.sourceId,
          targetId: c.targetId,
          kind: c.kind
        })),
        groups: listGroupsProjection(),
        rules: {
          spawnCap: getCap(),
          everyWriteGated: true,
          idleTtlMs,
          idleActivityMs
        }
      })
    },
    async describeLayout(): Promise<LayoutDigest> {
      // P1b: assemble the read-only SPATIAL digest served as `canvas://layout`. Read-only — projects
      // the live board geometry (P1 canvas awareness) + the Named-Group mirror through
      // buildLayoutDigest, which derives bbox / overlaps / row·column·grid·scattered arrangement.
      // Same injected-mirror discipline as describeApp; a registry that doesn't wire listGroups reads
      // [] (an ungrouped digest). Boards without geometry are dropped by the digest, not here.
      const summaries = await listBoardSummaries()
      return buildLayoutDigest(
        summaries.map((b) => ({ id: b.id, type: b.type, x: b.x, y: b.y, w: b.w, h: b.h })),
        listGroupsProjection()
      )
    }
  }
}
