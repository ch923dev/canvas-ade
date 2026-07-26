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
import { SWARM_TRIAGE_ACTIONS } from '../shared/swarmLedgerTypes'
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
   * S2 failure model: the board-status stream + the sync salvage read + PTY silence, injected so
   * `swarmWatch` stays unit-testable and this module keeps its "no MAIN singletons" shape. ABSENT
   * ⇒ no watcher at all: runs still record and restore, they just don't detect a death or a stall
   * (the honest degradation for a test/smoke boot that has no board registry).
   */
  watch?: Pick<SwarmWatchDeps, 'subscribeStatus' | 'readResult' | 'activityStaleMs'>
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
  const confirm =
    deps.confirm ?? (async (): Promise<{ approved: boolean }> => ({ approved: false }))
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

  /**
   * Push this run's durable projection to the renderer. Called after every tool round (so a
   * dispatch/settle is visible immediately) and after a rehydrate. A run with no ledger pushes
   * nothing — the renderer keeps rendering S1's ephemeral mirror, which is the honest degradation.
   */
  const pushLedger = (runId: string, opts?: { restored?: boolean }): void => {
    const snapshot = sessionFor(runId).ledger.snapshot(opts)
    if (snapshot) push('swarm:runEvent', { runId, ev: { kind: 'ledger', snapshot } })
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
        changed: (runId) => pushLedger(runId)
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
      emit: (ev: SwarmRunEvent) =>
        push('swarm:runEvent', { runId, ev } satisfies SwarmRunEventPush),
      confirm,
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
    const snapshot = sessionFor(runId).ledger.snapshot({ restored: true })
    if (!snapshot) return { restored: false }
    push('swarm:runEvent', { runId, ev: { kind: 'ledger', snapshot } })
    return { restored: true }
  })

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

  /** S2: the swarm board was deleted — the durable run goes with it (no orphan sidecars). */
  ipcMain.handle('swarm:destroyRun', (e, payload: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    const runId = runIdOf(payload)
    if (!runId) return { ok: false }
    sessions.get(runId)?.ledger.destroy()
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
    dispose: () => watch?.stop()
  }
}
