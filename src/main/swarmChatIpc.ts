/**
 * Swarm chat IPC (orchestration S1) — the Stage-1 APP-RESIDENT orchestrator brain: one
 * conversational LLM loop PER SWARM BOARD (multi-instance — a Map of independent sessions,
 * unlike Jarvis's single voice session), each driving the existing gated dispatch surface
 * through swarmTools. Rides the SHARED Context·LLM configuration exactly like Jarvis
 * (jarvisIpc precedent): provider+model from llmConfig, the key from that provider's
 * llmKeyStore slot, every streamed hop reserved against the shared llmBudget daily cap.
 *
 * A turn is the jarvisIpc J4 loop shape: stream → assembled tool calls → execute through
 * swarmTools (human confirm gates inside) → append tool_result blocks → stream again, bounded
 * by MAX_TOOL_HOPS. Turn lifecycle events push on `swarm:turn:event`; run mirror events
 * (worker spawned / plan drawn / activity / settled) push on `swarm:runEvent` — the renderer's
 * swarmStore consumes both (useSwarmEvents). Per-run history is MAIN memory, session-only
 * (the durable run ledger is S2).
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import { createKeyStore, type Encryptor, type KeyStore } from './llmKeyStore'
import { keyForProvider, shouldEnforceBudget } from './llmService'
import { readLlmConfig, type LlmConfig } from './llmConfig'
import { createBudgetStore, DEFAULT_MAX_CALLS_PER_DAY, type BudgetStore } from './llmBudget'
import {
  composeMessages,
  type JarvisContentBlock,
  type JarvisMessage,
  type JarvisTurn,
  type JarvisTurnBlock
} from './jarvisPersona'
import {
  buildJarvisRequest,
  defaultJarvisDeps,
  isJarvisMockEnabled,
  streamJarvisReply,
  type JarvisStreamDeps,
  type JarvisToolUse
} from './jarvisBrain'
import { composeSwarmSystem } from './swarmPrompt'
import {
  buildSwarmToolDefs,
  executeSwarmTool,
  SWARM_AUTO_ALLOW,
  type SwarmCanvasFacet,
  type SwarmRunCtx,
  type SwarmRunEvent
} from './swarmTools'
import { createSwarmLedgerStore, type SwarmLedgerStore } from './swarmLedger'
import { observeWorkerAttention } from './commandFeed'
import { attentionForBlockedTag } from './workerAttention'
import {
  SWARM_TRIAGE_ACTIONS,
  SWARM_WORKTREE_DISPOSITIONS,
  type SwarmWorktreeDisposition,
  type SwarmWorktreeStatus
} from '../shared/swarmLedgerTypes'
import { createSwarmWorktreeStore, type SwarmWorktreeStore } from './swarmWorktree'
import { createSwarmLedgerSession, type SwarmLedgerSession } from './swarmLedgerSession'
import {
  createSwarmWatch,
  withRunNotices,
  type SwarmWatch,
  type SwarmWatchDeps
} from './swarmWatch'

const MAX_TURN_TEXT_LEN = 8000
const MAX_HISTORY_TURNS = 200
/** Orchestration is a work queue (spawn → dispatch → await × N), not a voice command — the
 *  hop budget is wider than Jarvis's 4. */
const MAX_TOOL_HOPS = 12

export type SwarmTurnEvent =
  | { runId: string; id: number; kind: 'delta'; text: string }
  | { runId: string; id: number; kind: 'done'; text: string; cancelled: boolean }
  | { runId: string; id: number; kind: 'error'; reason: string }
  | {
      runId: string
      id: number
      kind: 'act'
      name: string
      summary: string
      phase: 'confirm' | 'running' | 'ok' | 'denied' | 'error'
    }

export interface SwarmRunEventPush {
  runId: string
  ev: SwarmRunEvent
}

interface SwarmSession {
  history: JarvisTurn[]
  abort: AbortController | null
  paused: boolean
  writeInFlight: Set<string>
  workerRoles: Map<string, string>
  /** S2: the run's Planning board (draw_plan writes it, tick_plan_item reads it). */
  planBoard: { current: string | null }
  /**
   * S3: worker board id → the worktree allocated for it at spawn. Rebuilt from the ledger on
   * restore, so a reloaded run still knows which of its workers are isolated (and therefore what
   * its write-concurrency ceiling is) rather than silently collapsing to the un-isolated cap.
   */
  workerWorktrees: Map<string, { worktree: string; branch: string }>
  /** S2: this run's durable ledger view. Present even with no project — its methods no-op then. */
  ledger: SwarmLedgerSession
}

export interface SwarmIpcDeps {
  getUserData?: () => string
  encryptor?: Encryptor
  budget?: BudgetStore
  /** The lazily-ensured RunningMcp (structural superset of SwarmCanvasFacet); null = no canvas. */
  getFacet?: () => Promise<SwarmCanvasFacet | null>
  /** The shared fail-closed confirm; the P5 `choices` chooser rides through untouched. */
  confirm?: SwarmRunCtx['confirm']
  stream?: JarvisStreamDeps
  /**
   * S2: the ACTIVE project dir — the run ledger lives at `<project>/.canvas/memory/` (design D1),
   * so with no project every ledger call no-ops and the run behaves exactly like S1 (ephemeral).
   */
  getProjectDir?: () => string | null
  /** S2: ledger-store seam (tests inject an in-memory one). Default: the real project sidecar. */
  ledgerStore?: SwarmLedgerStore
  /**
   * S3: the git worktree allocator (seam — tests inject a stub). Default: the real `simple-git`
   * store rooted at the active project. `simple-git` never leaves MAIN, and every destructive
   * path in it is guarded by `owns()` against the CURRENT project's worktree dir.
   */
  worktrees?: SwarmWorktreeStore
  /**
   * S2 failure model: the board-status stream + the sync salvage read + PTY silence, injected so
   * `swarmWatch` stays unit-testable and this module keeps its "no MAIN singletons" shape. ABSENT
   * ⇒ no watcher at all: runs still record and restore, they just don't detect a death or a stall
   * (the honest degradation for a test/smoke boot that has no board registry).
   */
  watch?: Pick<
    SwarmWatchDeps,
    'subscribeStatus' | 'readResult' | 'activityStaleMs' | 'synthesizeNow'
  >
  /**
   * P5 secrets hygiene: the per-role env policy seam (preview for the spawn confirm's
   * disclosure + register-by-board-id for `buildSpawnEnv`). Injected — the registry is a MAIN
   * singleton (`spawnEnvPolicy.ts`) and this module keeps its no-MAIN-singletons shape. Absent
   * ⇒ workers inherit the full env exactly as before P5.
   */
  envPolicy?: SwarmRunCtx['envPolicy']
  /**
   * P5 session consent: the swarm-side slice of `sessionConsent.ts` (worker registration at
   * spawn, revoke, the active-grant snapshot for the chip row, and change notifications for
   * the push). Injected for the same no-MAIN-singletons reason as `envPolicy`. Absent ⇒ no
   * worker is ever consent-eligible and the chip row never renders — per-write everywhere.
   */
  sessionConsent?: {
    registerWorker(runId: string, boardId: string, roleId: string, launchCommand: string): void
    revoke(runId: string, roleId: string): boolean
    active(runId: string): Array<{ roleId: string; roleName: string }>
    onChange(listener: (runId: string) => void): () => void
  }
}

/** What the boot wiring keeps a handle on after registration (the quit-path drain). */
export interface SwarmHandlers {
  /**
   * 🔒 Failure case B — call from the quit chain. Synchronous: salvages every un-settled worker's
   * result into its ledger and marks each live run `interrupted`. Never kills a worker board (D5).
   *
   * NON-THROWING BY CONTRACT: the caller is `shutdown()`, where an exception would abort the PTY
   * drain behind it and orphan an agent process tree. A ledger we cannot write is a lost ledger,
   * never a lost teardown.
   */
  drainRuns(): void
  /** Stop the watcher (teardown / test cleanup). */
  dispose(): void
}

export function registerSwarmHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: SwarmIpcDeps = {}
): SwarmHandlers {
  const getUserData = deps.getUserData ?? ((): string => '')
  const keyStore: KeyStore | undefined = deps.encryptor
    ? createKeyStore(getUserData(), deps.encryptor)
    : undefined
  const streamDeps = deps.stream ?? defaultJarvisDeps()
  const getFacet = deps.getFacet ?? (async (): Promise<SwarmCanvasFacet | null> => null)
  // Typed as the full contract (not the narrowed `{approved}` the fallback returns) so callers
  // can read `choice` — the S3 disposition rides the shared P5 chooser.
  const confirm: SwarmRunCtx['confirm'] = deps.confirm ?? (async () => ({ approved: false }))
  const budget = deps.budget ?? createBudgetStore(getUserData(), () => new Date())
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  const ledgerStore =
    deps.ledgerStore ??
    createSwarmLedgerStore({ getProjectDir: deps.getProjectDir ?? ((): string | null => null) })

  const sessions = new Map<string, SwarmSession>()
  const sessionFor = (runId: string): SwarmSession => {
    let s = sessions.get(runId)
    if (!s) {
      s = {
        history: [],
        abort: null,
        paused: false,
        writeInFlight: new Set(),
        workerRoles: new Map(),
        planBoard: { current: null },
        workerWorktrees: new Map(),
        ledger: createSwarmLedgerSession(runId, { store: ledgerStore })
      }
      sessions.set(runId, s)
    }
    return s
  }

  let turnSeq = 0

  const push = (channel: 'swarm:turn:event' | 'swarm:runEvent', payload: unknown): void => {
    try {
      const win = getWin()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send(channel, payload)
    } catch {
      /* window died mid-send — the run mirror re-syncs on the next event */
    }
  }

  const worktrees =
    deps.worktrees ??
    createSwarmWorktreeStore({ getProjectDir: deps.getProjectDir ?? ((): string | null => null) })

  /**
   * S3 — live git facts per worktree PATH, app-wide (paths are absolute and unique across runs).
   *
   * A CACHE rather than a read inside the projection, because `pushLedger` is synchronous and is
   * called from the tool round, the watcher, and the IPC handlers alike; making it async would
   * push a promise into all three. The cache is refreshed off to the side and, when a value
   * actually changed, re-pushes — so the board self-heals within one tick instead of rendering a
   * stale "kept, 7 uncommitted" forever.
   */
  const worktreeStatus = new Map<string, SwarmWorktreeStatus>()

  /**
   * Push this run's durable projection to the renderer. Called after every tool round (so a
   * dispatch/settle is visible immediately) and after a rehydrate. A run with no ledger pushes
   * nothing — the renderer keeps rendering S1's ephemeral mirror, which is the honest degradation.
   */
  const pushLedger = (runId: string, opts?: { restored?: boolean }): void => {
    const session = sessionFor(runId)
    const known: Record<string, SwarmWorktreeStatus> = {}
    for (const path of session.ledger.worktreePaths()) {
      const st = worktreeStatus.get(path)
      // A path we have not statted yet is left OUT, not defaulted: "unknown" must never render
      // as "clean", because clean is what authorises a removal and hides a dirty-tree row.
      if (st) known[path] = st
    }
    const snapshot = session.ledger.snapshot({ ...opts, worktrees: known })
    if (snapshot) push('swarm:runEvent', { runId, ev: { kind: 'ledger', snapshot } })
  }

  /** Re-stat this run's worktrees; re-push only when something actually moved. Never throws. */
  const refreshWorktrees = async (runId: string): Promise<void> => {
    const paths = sessionFor(runId).ledger.worktreePaths()
    if (paths.length === 0) return
    let changed = false
    for (const path of paths) {
      try {
        const next = await worktrees.status(path)
        const prev = worktreeStatus.get(path)
        if (
          !prev ||
          prev.exists !== next.exists ||
          prev.dirty !== next.dirty ||
          prev.changed !== next.changed
        ) {
          worktreeStatus.set(path, next)
          changed = true
        }
      } catch {
        /* a status read must never break the run it is describing */
      }
    }
    if (changed) pushLedger(runId)
  }

  /** Fire-and-forget refresh — callers are sync paths that must not await git. */
  const kickRefresh = (runId: string): void => {
    void refreshWorktrees(runId).catch(() => {})
  }

  /**
   * 🔒 S3 teardown, the locked policy. A worker board that left the canvas gets its worktree
   * removed ONLY when the tree is clean; a dirty tree is kept on disk exactly where it is and
   * surfaces as a `dirty_worktree` triage row. `removeIfClean` re-checks both conditions itself
   * and refuses any path outside the CURRENT project's worktree dir — which is also what makes a
   * project switch (where every board goes `gone` at once) a no-op instead of a mass teardown.
   * The BRANCH always survives, so a removed worktree still appears in the merge sequence.
   */
  const releaseWorktreeFor = async (boardId: string): Promise<void> => {
    for (const [runId, session] of sessions) {
      const held = session.workerWorktrees.get(boardId)
      if (!held) continue
      session.workerWorktrees.delete(boardId)
      try {
        await worktrees.removeIfClean(held.worktree)
      } catch {
        /* keep-on-failure is the safe direction: the tree stays, the row surfaces it */
      }
      await refreshWorktrees(runId).catch(() => {})
    }
  }

  /**
   * S2 failure model. The watcher lives here because it needs the ledger store AND the push — but
   * it is deliberately dependency-injected (status stream / salvage read / PTY silence), so this
   * module still imports no MAIN singleton and the unit tests drive it with plain functions.
   */
  const watch: SwarmWatch | null = deps.watch
    ? createSwarmWatch({
        store: ledgerStore,
        ...deps.watch,
        narrate: (runId, n) => push('swarm:runEvent', { runId, ev: { kind: 'narrate', ...n } }),
        changed: (runId) => pushLedger(runId),
        releaseWorktree: (boardId) => {
          void releaseWorktreeFor(boardId).catch(() => {})
        },
        // P4: the watcher's blocked verdict reaches the CANVAS — the board's attention ring and its
        // Command-board card — not just the triage queue inside the swarm board. `attentionForBlockedTag`
        // owns the tag→mark map (closed vocabulary, unknown ⇒ `blocked`, the surface-it direction).
        observeBlocked: (boardId, tag, detail, role) => {
          observeWorkerAttention(boardId, attentionForBlockedTag(tag), {
            detail,
            blockedTag: tag,
            ...(role ? { role } : {})
          })
        }
      })
    : null
  watch?.start()

  const sharedConfig = (): LlmConfig => readLlmConfig(getUserData())
  const providerKey = (cfg: LlmConfig): string | undefined =>
    keyForProvider(cfg.provider, streamDeps.env, keyStore)
  const brainReady = (cfg: LlmConfig): boolean =>
    isJarvisMockEnabled(streamDeps.env) ||
    (cfg.provider === 'local' ? cfg.baseUrl !== undefined : providerKey(cfg) !== undefined)

  ipcMain.handle(
    'swarm:turn:start',
    (e, payload: unknown): { ok: boolean; id?: number; reason?: string } => {
      if (guard(e)) return { ok: false, reason: 'forbidden' }
      const p = payload as { runId?: unknown; text?: unknown } | null
      const runId = typeof p?.runId === 'string' ? p.runId : ''
      const text = typeof p?.text === 'string' ? p.text.trim() : ''
      if (!runId || !text || text.length > MAX_TURN_TEXT_LEN) {
        return { ok: false, reason: 'invalid-text' }
      }
      const shared = sharedConfig()
      if (!brainReady(shared)) return { ok: false, reason: 'no-key' }
      const session = sessionFor(runId)
      // One turn per RUN (independent runs stream concurrently). A busy run refuses rather
      // than aborting — mid-run steering lands as the NEXT turn, it never kills tool work.
      if (session.abort !== null) return { ok: false, reason: 'busy' }
      // S2: the run becomes durable on its FIRST turn (not at board mount) — an untouched swarm
      // board should not litter `.canvas/memory/` with an empty ledger. The opening prompt is the
      // run's title; `ensure` only sets it on create, so later turns never rename the run.
      session.ledger.ensure(text)
      // S2: fold in whatever happened BETWEEN turns (a worker died, a worker stalled). Without
      // this the brain would happily `await_worker` a board the watcher already buried. It rides
      // the user turn as a prefix — a second assistant turn would break provider alternation.
      const prompt = withRunNotices(text, watch?.takeNotices(runId) ?? [])

      const abort = new AbortController()
      session.abort = abort
      const id = ++turnSeq

      void (async (): Promise<void> => {
        const facet = await getFacet()
        if (abort.signal.aborted) {
          if (session.abort === abort) session.abort = null
          push('swarm:turn:event', { runId, id, kind: 'done', text: '', cancelled: true })
          return
        }
        const toolsAttached = facet !== null
        // The system prompt as a cache-controlled block array (the composeSystem shape).
        const systemBlocks = (paused: boolean): JarvisContentBlock[] => [
          { type: 'text', text: composeSwarmSystem(paused), cache_control: { type: 'ephemeral' } }
        ]
        let system = systemBlocks(session.paused)
        const tools = toolsAttached ? buildSwarmToolDefs() : undefined
        const messages: JarvisMessage[] = composeMessages(session.history, prompt)
        const key = providerKey(shared) ?? ''
        const requestCfg: LlmConfig = isJarvisMockEnabled(streamDeps.env)
          ? { ...shared, provider: 'anthropic' }
          : shared
        const spokenParts: string[] = []
        let cancelled = false
        let hops = 0
        for (;;) {
          // Paused state can flip between hops — recompose so the model is told.
          system = systemBlocks(session.paused)
          if (shouldEnforceBudget(shared, streamDeps.env)) {
            const cap = shared.maxCallsPerDay ?? DEFAULT_MAX_CALLS_PER_DAY
            if (!budget.tryConsume(cap)) {
              if (session.abort === abort) session.abort = null
              push('swarm:turn:event', { runId, id, kind: 'error', reason: 'budget-exceeded' })
              return
            }
          }
          const req = buildJarvisRequest(requestCfg, key, system, messages, tools)
          const result = await streamJarvisReply(req, streamDeps, abort.signal, (delta) =>
            push('swarm:turn:event', { runId, id, kind: 'delta', text: delta })
          )
          if (!result.ok) {
            if (session.abort === abort) session.abort = null
            push('swarm:turn:event', {
              runId,
              id,
              kind: 'error',
              // An orchestrator without tools is useless — no toolless degrade (unlike Jarvis):
              // surface the provider error honestly and let the human fix the model choice.
              reason: result.reason === 'no-key' ? 'no-key' : result.message
            })
            return
          }
          if (result.text.trim().length > 0) spokenParts.push(result.text)
          cancelled = result.cancelled
          const wantsTools =
            !cancelled && result.stopReason === 'tool_use' && result.toolUses.length > 0
          if (!wantsTools || facet === null || ++hops > MAX_TOOL_HOPS) break
          const assistantBlocks: JarvisTurnBlock[] = [
            ...(result.text.trim().length > 0
              ? [{ type: 'text', text: result.text } as JarvisTurnBlock]
              : []),
            ...result.toolUses.map(
              (tu): JarvisTurnBlock => ({
                type: 'tool_use',
                id: tu.id,
                name: tu.name,
                input: tu.input
              })
            )
          ]
          messages.push({ role: 'assistant', content: assistantBlocks })
          const resultBlocks = await runToolRound(
            runId,
            id,
            result.toolUses,
            facet,
            session,
            abort.signal
          )
          messages.push({ role: 'user', content: resultBlocks })
          if (abort.signal.aborted) {
            cancelled = true
            break
          }
        }
        if (session.abort === abort) session.abort = null
        const spoken = spokenParts.join(' ')
        if (spoken.trim().length > 0) {
          session.history.push({ role: 'user', text: prompt })
          session.history.push({
            role: 'assistant',
            text: cancelled ? `${spoken} — (interrupted)` : spoken
          })
          if (session.history.length > MAX_HISTORY_TURNS) {
            session.history.splice(0, session.history.length - MAX_HISTORY_TURNS)
          }
        }
        push('swarm:turn:event', { runId, id, kind: 'done', text: spoken, cancelled })
      })().catch(() => {
        if (session.abort === abort) session.abort = null
        push('swarm:turn:event', { runId, id, kind: 'error', reason: 'turn-failed' })
      })

      return { ok: true, id }
    }
  )

  /** One tool round: execute sequentially, pushing act lifecycle + run-mirror events. */
  const runToolRound = async (
    runId: string,
    turnId: number,
    toolUses: JarvisToolUse[],
    facet: SwarmCanvasFacet,
    session: SwarmSession,
    signal: AbortSignal
  ): Promise<JarvisTurnBlock[]> => {
    const results: JarvisTurnBlock[] = []
    const ctx = {
      paused: () => session.paused,
      writeInFlight: session.writeInFlight,
      workerRoles: session.workerRoles,
      planBoard: session.planBoard,
      workerWorktrees: session.workerWorktrees,
      // S3: allocate BEFORE the board spawns (the `safeCwd` constraint). The executor refuses the
      // spawn on anything but success — there is no shared-tree fallback.
      allocateWorktree: (workerName: string) => worktrees.allocate(runId, workerName),
      releaseWorktree: async (worktree: string): Promise<void> => {
        await worktrees.removeIfClean(worktree)
      },
      emit: (ev: SwarmRunEvent) =>
        push('swarm:runEvent', { runId, ev } satisfies SwarmRunEventPush),
      confirm,
      // P5: the env-policy seam rides through to spawn_worker (disclosure + registration).
      ...(deps.envPolicy ? { envPolicy: deps.envPolicy } : {}),
      // P5: consent registration binds the RUN id here (the executor never learns it).
      ...(deps.sessionConsent
        ? {
            consent: {
              registerWorker: (boardId: string, roleId: string, launchCommand: string) =>
                deps.sessionConsent!.registerWorker(runId, boardId, roleId, launchCommand)
            }
          }
        : {}),
      // S2: durable recording. The facet doubles as the planning reader (RunningMcp exposes
      // boardPlanning), so a task can join the checklist item it fulfils.
      ledger: session.ledger.hooks(() => facet)
    }
    for (const tu of toolUses) {
      const gated = !SWARM_AUTO_ALLOW.has(tu.name)
      push('swarm:turn:event', {
        runId,
        id: turnId,
        kind: 'act',
        name: tu.name,
        summary: tu.name,
        phase: gated ? 'confirm' : 'running'
      })
      if (signal.aborted) {
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'cancelled — the user interrupted',
          is_error: true
        })
        push('swarm:turn:event', {
          runId,
          id: turnId,
          kind: 'act',
          name: tu.name,
          summary: tu.name,
          phase: 'error'
        })
        continue
      }
      const outcome = await executeSwarmTool(tu.name, tu.input, facet, ctx)
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {})
      })
      push('swarm:turn:event', {
        runId,
        id: turnId,
        kind: 'act',
        name: tu.name,
        summary: outcome.summary,
        phase: outcome.denied ? 'denied' : outcome.isError || signal.aborted ? 'error' : 'ok'
      })
      // The ledger may have moved (a dispatch became an assignment, a settle became a result) —
      // reproject after EVERY tool, so the board is never a round behind the durable truth.
      pushLedger(runId)
      // S3: a spawn just created a worktree, and a settle just changed what is in one. Stat them
      // off to the side; the re-push lands as soon as git answers.
      kickRefresh(runId)
    }
    return results
  }

  ipcMain.handle('swarm:turn:cancel', (e, payload: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    const runId =
      typeof (payload as { runId?: unknown })?.runId === 'string'
        ? (payload as { runId: string }).runId
        : ''
    sessions.get(runId)?.abort?.abort()
    return { ok: true }
  })

  ipcMain.handle('swarm:setPaused', (e, payload: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    const p = payload as { runId?: unknown; paused?: unknown } | null
    const runId = typeof p?.runId === 'string' ? p.runId : ''
    if (!runId || typeof p?.paused !== 'boolean') return { ok: false }
    sessionFor(runId).paused = p.paused
    return { ok: true }
  })

  const runIdOf = (payload: unknown): string => {
    const v = (payload as { runId?: unknown } | null)?.runId
    return typeof v === 'string' ? v : ''
  }

  /**
   * S2 restore — the one moment the ledger is visible. A swarm board asks on mount; if a durable
   * run exists for this board in THIS project, its projection comes back and the header shows the
   * `restored` chip. `{ restored: false }` = a fresh board, no ledger, or no project: the board
   * renders S1's empty state and nothing is invented.
   */
  ipcMain.handle('swarm:restore', (e, payload: unknown): { restored: boolean } => {
    if (guard(e)) return { restored: false }
    const runId = runIdOf(payload)
    if (!runId) return { restored: false }
    // Read WITHOUT creating: mounting a board must never mint a ledger for a run that never ran.
    const session = sessionFor(runId)
    // 🔒 base P5 — re-attach v2 BEFORE projecting, so the snapshot below already reflects the
    // reconciled truth (state flipped live, finished-while-away results settled, dead workers
    // lost). Idempotent: only an `interrupted` run re-attaches (the flip is the latch), so a
    // plain reload of a live/done run — and a second mount — fall straight through. The
    // narrations it pushes land before the ledger snapshot, matching the chat's read order.
    watch?.reattach(runId)
    const snapshot = session.ledger.snapshot({ restored: true })
    if (!snapshot) return { restored: false }
    // 🔒 S3: rebuild the worker→worktree map from the durable assignments. Without this a
    // reloaded run believes none of its workers are isolated, and the write-concurrency ceiling
    // silently collapses to 1 — a cap that is wrong in the SAFE direction is still a cap whose
    // disclosure string lies about why.
    for (const w of snapshot.workers) {
      if (!w.worktree || !w.taskId) continue
      // The projection carries the branch; the path comes from the same assignment.
      const held = session.ledger.worktreeFor(w.taskId)
      if (held)
        session.workerWorktrees.set(w.boardId, { worktree: held.worktree, branch: held.branch })
    }
    // 🔒 base P5: rebuild the worker→ROLE map too — the dispatch write-cap and the consent gate
    // both key off it, and before this a reloaded run believed every worker was role-less (the
    // write ceiling read wrong AND no worker could ever be consent-eligible again... which for
    // consent is actually the intended fail-closed default — eligibility needs the spawn-time
    // launch evidence a restart does not have, so roles are rebuilt but consent registration is
    // deliberately NOT). In-memory values from THIS session win over the ledger's.
    for (const w of snapshot.workers) {
      if (w.role && !session.workerRoles.has(w.boardId)) {
        session.workerRoles.set(w.boardId, w.role)
      }
    }
    push('swarm:runEvent', { runId, ev: { kind: 'ledger', snapshot } })
    // base P5: re-hydrate the consent chip row (empty after a restart by construction).
    pushConsents(runId)
    // The trees moved while we were not running (or were deleted by hand) — stat and re-push.
    kickRefresh(runId)
    return { restored: true }
  })

  /**
   * 🔒 S3 worktree disposition — the locked keep-on-dirty rule's prompt, reached from the
   * `dirty_worktree` triage row. The renderer proposes a task id and nothing else; MAIN re-derives
   * the worktree from the ledger, reads the CURRENT file count off disk (a count stale by an hour
   * is a disclosure that lies), raises the shared P5 chooser, re-validates the returned choice
   * against the closed vocabulary, and only then runs a scoped git write.
   *
   * `keep` is the default, the cancel path, and the fallback for every degenerate case — nothing
   * here destroys a tree without an explicitly named human choice, and `discard` pays a second
   * confirm on top.
   */
  ipcMain.handle(
    'swarm:worktreeDispose',
    async (e, payload: unknown): Promise<{ ok: boolean; detail: string }> => {
      if (guard(e)) return { ok: false, detail: 'forbidden' }
      const p = payload as { runId?: unknown; taskId?: unknown } | null
      const runId = runIdOf(payload)
      const taskId = typeof p?.taskId === 'string' ? p.taskId : ''
      if (!runId || !taskId) return { ok: false, detail: 'invalid request' }
      const session = sessionFor(runId)
      const held = session.ledger.worktreeFor(taskId)
      if (!held) return { ok: false, detail: 'that task holds no worktree' }
      // 🔒 The destructive-path gate, re-derived MAIN-side. A row anchored on a FINISHED task can
      // point at a worktree its worker has since taken a new task in — and `discard` there would
      // `git clean -fd` work that is being written right now. Refuse, and say which worker owns it.
      if (held.busy) {
        return {
          ok: false,
          detail: `${held.label} is working in that worktree right now — nothing was touched. Await or reassign its task first.`
        }
      }
      const st = await worktrees.status(held.worktree)
      if (!st.exists) return { ok: false, detail: 'the worktree is no longer on disk' }
      if (!st.dirty) {
        const r = await worktrees.removeIfClean(held.worktree)
        await refreshWorktrees(runId).catch(() => {})
        return r.removed
          ? { ok: true, detail: 'the worktree was already clean — removed, branch kept' }
          : { ok: false, detail: r.reason ?? 'could not remove the worktree' }
      }
      const n = st.changed
      const files = `${n} file${n === 1 ? '' : 's'}`
      const decision = await confirm({
        title: `${held.label} left uncommitted changes`,
        body:
          `Its worktree is still on disk at ${held.worktree} (branch ${held.branch}) and nothing has been discarded. ` +
          `Choose what happens to ${files} — Keep is what already happened, and what happens if you cancel. ` +
          `Commit puts them on the worker's own branch; Stash pushes them (including untracked) to the repo stash; ` +
          `Discard throws them away permanently — commits already on the branch survive either way, and the branch is never deleted.`,
        choices: {
          label: 'Disposition',
          default: 'keep',
          options: [
            { id: 'keep', label: `Keep on disk (${files} untouched)` },
            { id: 'commit', label: `Commit ${files} onto ${held.branch}, then remove` },
            { id: 'stash', label: `Stash ${files}, then remove` },
            { id: 'discard', label: `Discard ${files} permanently, then remove` }
          ]
        }
      })
      if (!decision.approved) return { ok: true, detail: 'kept on disk — nothing ran' }
      // 🔒 Closed vocabulary: anything off-set falls back to `keep`, never to a destructive branch.
      const choice: SwarmWorktreeDisposition =
        SWARM_WORKTREE_DISPOSITIONS.find((c) => c === decision.choice) ?? 'keep'
      if (choice === 'discard') {
        // The second confirm the design promises. Destructive and unrecoverable, so it is asked
        // plainly and separately rather than folded into the chooser's Apply.
        const sure = await confirm({
          title: 'Discard uncommitted work?',
          body: `This permanently throws away ${files} in ${held.worktree}. It cannot be undone. Commits already on ${held.branch} survive, and the branch is kept.`,
          confirmLabel: 'Discard',
          denyLabel: 'Keep it'
        })
        if (!sure.approved) return { ok: true, detail: 'kept on disk — discard cancelled' }
      }
      // 🔒 Re-check liveness INSIDE the write (the BUG-021 TOCTOU discipline). The gate above ran
      // before the modal; a human can sit on that modal for minutes, and the orchestrator is free
      // to hand this worker a new task in the meantime — at which point `discard` would destroy
      // work that started after the question was asked. Cheap to re-derive, and the only honest
      // answer is to keep the tree and say why.
      //
      // `keep` is exempt: it is an unconditional no-op (`swarmWorktree.dispose` returns before it
      // touches anything), so refusing it would report "nothing was touched" as a FAILURE for the
      // one choice whose whole contract is that nothing happens. Gate the write, not the no-op.
      if (choice !== 'keep' && session.ledger.worktreeFor(taskId)?.busy === true) {
        return {
          ok: false,
          detail: `${held.label} started working in that worktree while the prompt was open — nothing was touched.`
        }
      }
      const outcome = await worktrees.dispose(held.worktree, choice, held.label)
      await refreshWorktrees(runId).catch(() => {})
      if (outcome.ok && choice !== 'keep') {
        // Run-level narration: no `boardId`, because the worker board may be long gone and the
        // renderer would otherwise bold a title it cannot resolve.
        push('swarm:runEvent', {
          runId,
          ev: { kind: 'narrate', text: `worktree ${held.label} — ${outcome.detail}.` }
        })
      }
      return outcome
    }
  )

  /** S2: the human has read the run up to now — bounds which results count as unreviewed. */
  ipcMain.handle('swarm:markSeen', (e, payload: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    const runId = runIdOf(payload)
    if (!runId) return { ok: false }
    sessionFor(runId).ledger.markSeen()
    pushLedger(runId)
    return { ok: true }
  })

  /**
   * 🔒 S2 triage action — the renderer PROPOSES a row id + an action name; MAIN re-derives
   * everything else from the ledger and refuses anything off-contract. Nothing here writes to a
   * PTY: a `reassign` comes back as a PROMPT the renderer sends as the next orchestrator turn, so
   * the actual re-dispatch still pays the normal per-write confirm gate and gets narrated in chat.
   */
  ipcMain.handle('swarm:triageAction', (e, payload: unknown): { ok: boolean; prompt?: string } => {
    if (guard(e)) return { ok: false }
    const p = payload as { runId?: unknown; taskId?: unknown; action?: unknown } | null
    const runId = runIdOf(payload)
    const taskId = typeof p?.taskId === 'string' ? p.taskId : ''
    // Closed vocabulary — a forged/unknown action name can never widen into an unhandled path.
    const action = SWARM_TRIAGE_ACTIONS.find((a) => a === p?.action)
    if (!runId || !taskId || !action) return { ok: false }
    const outcome = sessionFor(runId).ledger.applyAction(taskId, action)
    if (outcome.ok) pushLedger(runId)
    return outcome
  })

  /**
   * 🔒 P5 session consent — the chip row's push + the Revoke path. `pushConsents` sends the
   * FULL active-grant snapshot for one run (idempotent, so a re-push after any change or a
   * board mount re-hydrate is always correct); the module-level onChange subscription keeps the
   * chip live for grants made inside the dispatch gate (which this module never sees directly).
   * Revocation takes effect on the NEXT act — the gate re-derives consent per dispatch.
   */
  const pushConsents = (runId: string): void => {
    if (!deps.sessionConsent) return
    push('swarm:runEvent', {
      runId,
      ev: { kind: 'consent', consents: deps.sessionConsent.active(runId) }
    })
  }
  const unsubscribeConsent = deps.sessionConsent?.onChange((runId) => pushConsents(runId))

  ipcMain.handle('swarm:consentRevoke', (e, payload: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    const p = payload as { runId?: unknown; roleId?: unknown } | null
    const runId = runIdOf(payload)
    const roleId = typeof p?.roleId === 'string' ? p.roleId : ''
    if (!runId || !roleId || !deps.sessionConsent) return { ok: false }
    const ok = deps.sessionConsent.revoke(runId, roleId)
    // The onChange subscription re-pushes the snapshot; a no-op revoke pushes nothing.
    return { ok }
  })

  /** S2: the swarm board was deleted — the durable run goes with it (no orphan sidecars). */
  ipcMain.handle('swarm:destroyRun', (e, payload: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    const runId = runIdOf(payload)
    if (!runId) return { ok: false }
    // `sessionFor`, NOT `sessions.get`: a board deleted without ever having been TOUCHED this
    // session (reopened project, never sent a turn) has no in-memory session — and reading through
    // `get` there would silently leave its sidecar behind as an orphan the retention sweep keeps
    // alive for 19 more runs. Building the session is free; it only wraps the store.
    sessionFor(runId).ledger.destroy()
    sessions.delete(runId)
    return { ok: true }
  })

  return {
    drainRuns: () => {
      try {
        watch?.drain()
      } catch (err) {
        console.warn('[swarm] run drain failed on quit (non-fatal — teardown continues)', err)
      }
    },
    dispose: () => {
      watch?.stop()
      unsubscribeConsent?.()
    }
  }
}
