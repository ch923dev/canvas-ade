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
  type SwarmRunEvent
} from './swarmTools'

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
}

export interface SwarmIpcDeps {
  getUserData?: () => string
  encryptor?: Encryptor
  budget?: BudgetStore
  /** The lazily-ensured RunningMcp (structural superset of SwarmCanvasFacet); null = no canvas. */
  getFacet?: () => Promise<SwarmCanvasFacet | null>
  confirm?: (req: { title: string; body: string }) => Promise<{ approved: boolean }>
  stream?: JarvisStreamDeps
}

export function registerSwarmHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: SwarmIpcDeps = {}
): void {
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

  const sessions = new Map<string, SwarmSession>()
  const sessionFor = (runId: string): SwarmSession => {
    let s = sessions.get(runId)
    if (!s) {
      s = {
        history: [],
        abort: null,
        paused: false,
        writeInFlight: new Set(),
        workerRoles: new Map()
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
        const messages: JarvisMessage[] = composeMessages(session.history, text)
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
          session.history.push({ role: 'user', text })
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
      emit: (ev: SwarmRunEvent) =>
        push('swarm:runEvent', { runId, ev } satisfies SwarmRunEventPush),
      confirm
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
}
