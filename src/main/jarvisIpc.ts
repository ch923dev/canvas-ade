/**
 * Jarvis J3 — IPC layer for the brain session. Owns the frame guard, the per-project
 * rolling history (MAIN memory, D4′ v1), the single in-flight turn (AbortController —
 * barge-in cancels it), and the config get/set/changed-push (voiceIpc pattern). The
 * API key rides the EXISTING llmKeyStore `anthropic` slot (written via llm:setKey);
 * this module only ever reads it, key material never crosses IPC outbound.
 *
 * J4 (hands): a turn is now a LOOP — stream → assembled tool calls → execute each through
 * jarvisTools (validation + the human confirm gates) → append tool_result blocks → stream
 * again, until the model stops calling tools (or MAX_TOOL_HOPS). Tool lifecycle events ride
 * the same `jarvis:turn:event` push as `act` records so the panel renders turn-act rows;
 * execution is wrapped in `runAsJarvisToolCall` so the confirm gates render on the panel
 * (mcpConfirm origin routing) instead of the center modal.
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import { createKeyStore, type Encryptor, type KeyStore } from './llmKeyStore'
import { keyForProvider } from './llmService'
import {
  readJarvisConfig,
  repairJarvisConfig,
  writeJarvisConfig,
  type JarvisConfig
} from './jarvisConfig'
import {
  composeMessages,
  composeSystem,
  type JarvisMessage,
  type JarvisTurn,
  type JarvisTurnBlock
} from './jarvisPersona'
import { buildWorkspaceManifest } from './jarvisManifest'
import {
  buildJarvisRequest,
  defaultJarvisDeps,
  isJarvisMockEnabled,
  streamJarvisReply,
  type JarvisStreamDeps,
  type JarvisToolUse
} from './jarvisBrain'
import {
  buildJarvisToolDefs,
  executeJarvisTool,
  isJarvisToolGated,
  type JarvisCanvasFacet
} from './jarvisTools'
import { runAsJarvisToolCall } from './jarvisToolContext'
import type { AppModel } from './appModel'

/** Transcript text bound (a spoken utterance; far under the summarize caps). */
const MAX_TURN_TEXT_LEN = 4000
/** Per-project rolling history hard cap (prompt window is narrower — jarvisPersona). */
const MAX_HISTORY_TURNS = 200
/** Tool rounds per turn — a voice command is one or two actions, never a work queue. */
const MAX_TOOL_HOPS = 4

/** One turn-act lifecycle phase (the panel's act row states — mock rev 2 exhibit F). */
export type JarvisActPhase = 'confirm' | 'running' | 'ok' | 'denied' | 'error'

/** Renderer push: one streaming turn's lifecycle events. J4 adds the `act` records. */
export type JarvisTurnEvent =
  | { id: number; kind: 'delta'; text: string }
  | { id: number; kind: 'done'; text: string; cancelled: boolean }
  | { id: number; kind: 'error'; reason: string }
  | {
      id: number
      kind: 'act'
      actId: number
      name: string
      summary: string
      phase: JarvisActPhase
      gated: boolean
    }

/** Status surfaced to the renderer — presence/availability only, never key material. */
export interface JarvisStatus {
  hasKey: boolean
  encryptionAvailable: boolean
  mockEnabled: boolean
  config: JarvisConfig
}

export interface JarvisIpcDeps {
  getUserData?: () => string
  /** The llm-keys encryptor (safeStorage in real wiring). Absent → env-var key only. */
  encryptor?: Encryptor
  /** In-process AppModel read (RunningMcp.describeApp via lazy ensureMcp); null = no canvas. */
  getAppModel?: () => Promise<AppModel | null>
  /**
   * J4: the curated canvas facet the tool executor drives (the widened RunningMcp slice via
   * the same lazy ensureMcp). null = no canvas → the turn runs TOOLLESS (persona says so).
   */
  getFacet?: () => Promise<JarvisCanvasFacet | null>
  /** J4: the Jarvis-side confirm (spawn_board pre-gate) — requestConfirm in real wiring. */
  confirm?: (req: { title: string; body: string }) => Promise<{ approved: boolean }>
  /** History keying — the open project dir (MAIN's getCurrentDir). null = no project. */
  getProjectKey?: () => string | null
  stream?: JarvisStreamDeps
}

export function registerJarvisHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: JarvisIpcDeps = {}
): void {
  const getUserData = deps.getUserData ?? ((): string => '')
  const keyStore: KeyStore | undefined = deps.encryptor
    ? createKeyStore(getUserData(), deps.encryptor)
    : undefined
  const streamDeps = deps.stream ?? defaultJarvisDeps()
  const getProjectKey = deps.getProjectKey ?? ((): string | null => null)
  const getAppModel = deps.getAppModel ?? (async (): Promise<AppModel | null> => null)
  const getFacet = deps.getFacet ?? (async (): Promise<JarvisCanvasFacet | null> => null)
  const confirm =
    deps.confirm ?? (async (): Promise<{ approved: boolean }> => ({ approved: false }))
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  // D4′ v1: per-project rolling history, MAIN memory only (J5 adds .canvas/memory/jarvis/).
  const histories = new Map<string, JarvisTurn[]>()
  const historyFor = (): JarvisTurn[] => {
    const key = getProjectKey() ?? '(no-project)'
    let h = histories.get(key)
    if (!h) {
      h = []
      histories.set(key, h)
    }
    return h
  }

  // One turn in flight at a time; a new start (the user spoke again) aborts the previous.
  let turnSeq = 0
  let activeAbort: AbortController | null = null

  const push = (ev: JarvisTurnEvent): void => {
    // BRAIN-2: close-the-window-mid-stream lands here with a destroyed-but-not-yet-nulled
    // window — the webContents getter itself throws then (index.ts 'closed' handler), so
    // the isDestroyed() guard needs the try as well (the recap-map lesson).
    try {
      const win = getWin()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send('jarvis:turn:event', ev)
    } catch {
      /* window died mid-send — the turn's events die with their window */
    }
  }

  const anthropicKey = (): string | undefined =>
    keyForProvider('anthropic', streamDeps.env, keyStore)

  ipcMain.handle('jarvis:status', (e): JarvisStatus => {
    if (guard(e)) {
      return {
        hasKey: false,
        encryptionAvailable: false,
        mockEnabled: false,
        config: repairJarvisConfig(null)
      }
    }
    return {
      hasKey: anthropicKey() !== undefined,
      encryptionAvailable: deps.encryptor?.isEncryptionAvailable() ?? false,
      mockEnabled: isJarvisMockEnabled(streamDeps.env),
      config: readJarvisConfig(getUserData())
    }
  })

  ipcMain.handle('jarvis:config:get', (e): JarvisConfig => {
    if (guard(e)) return repairJarvisConfig(null)
    return readJarvisConfig(getUserData())
  })

  ipcMain.handle('jarvis:config:set', (e, patch: unknown): { ok: boolean } => {
    if (guard(e) || typeof patch !== 'object' || patch === null) return { ok: false }
    const userData = getUserData()
    const next = repairJarvisConfig({ ...readJarvisConfig(userData), ...patch })
    writeJarvisConfig(userData, next)
    getWin()?.webContents.send('jarvis:config:changed', next)
    return { ok: true }
  })

  /** J4: run one tool round — execute each call sequentially, pushing act lifecycle
   *  events, and return the tool_result blocks for the next hop. */
  const runToolRound = async (
    turnId: number,
    toolUses: JarvisToolUse[],
    facet: JarvisCanvasFacet,
    signal: AbortSignal,
    nextActId: () => number
  ): Promise<JarvisTurnBlock[]> => {
    const results: JarvisTurnBlock[] = []
    for (const tu of toolUses) {
      const actId = nextActId()
      const gated = isJarvisToolGated(tu.name)
      // The act row appears as 'confirm' (gated — the confirm gate is about to block on
      // the human) or 'running' (auto-allow tier). Summaries here predate validation, so
      // build them from the tool NAME only; the outcome summary carries validated detail.
      push({
        id: turnId,
        kind: 'act',
        actId,
        name: tu.name,
        summary: tu.name,
        phase: gated ? 'confirm' : 'running',
        gated
      })
      if (signal.aborted) {
        // Superseded mid-round: report the remaining calls as cancelled to the model (it
        // never sees this — the turn is dead — but the block array must stay 1:1).
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'cancelled — the user interrupted',
          is_error: true
        })
        push({
          id: turnId,
          kind: 'act',
          actId,
          name: tu.name,
          summary: tu.name,
          phase: 'error',
          gated
        })
        continue
      }
      // 🔒 The origin marker routes every confirm this call raises (the orchestrator gates
      // AND the spawn pre-gate) to the panel's act card instead of the center modal.
      const outcome = await runAsJarvisToolCall(() =>
        executeJarvisTool(tu.name, tu.input, { facet, confirm })
      )
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {})
      })
      push({
        id: turnId,
        kind: 'act',
        actId,
        name: tu.name,
        summary: outcome.summary,
        phase: outcome.denied ? 'denied' : outcome.isError ? 'error' : 'ok',
        gated
      })
    }
    return results
  }

  ipcMain.handle(
    'jarvis:turn:start',
    (e, payload: unknown): { ok: boolean; id?: number; reason?: string } => {
      if (guard(e)) return { ok: false, reason: 'forbidden' }
      const p = payload as { text?: unknown } | null
      const text = typeof p?.text === 'string' ? p.text.trim() : ''
      if (!text || text.length > MAX_TURN_TEXT_LEN) return { ok: false, reason: 'invalid-text' }
      const cfg = readJarvisConfig(getUserData())
      const key = anthropicKey()
      if (!key && !isJarvisMockEnabled(streamDeps.env)) return { ok: false, reason: 'no-key' }

      activeAbort?.abort() // the user spoke again — the previous turn yields
      const abort = new AbortController()
      activeAbort = abort
      const id = ++turnSeq
      const history = historyFor()

      void (async (): Promise<void> => {
        let manifest: string | null = null
        let facet: JarvisCanvasFacet | null = null
        try {
          facet = await getFacet()
          manifest = buildWorkspaceManifest(facet ? await facet.describeApp() : await getAppModel())
        } catch {
          manifest = null // a manifest failure never blocks the conversation
        }
        // BRAIN-1: the facet/manifest await above is the long pre-stream hop (first turn =
        // full lazy ensureMcp, seconds). A barge-in landing there finds no abort listener
        // attached yet — settle the turn as cancelled instead of issuing the request.
        if (abort.signal.aborted) {
          if (activeAbort === abort) activeAbort = null
          push({ id, kind: 'done', text: '', cancelled: true })
          return
        }
        const toolsEnabled = facet !== null
        const system = composeSystem(cfg, manifest, toolsEnabled)
        const tools = toolsEnabled ? buildJarvisToolDefs() : undefined
        const messages: JarvisMessage[] = composeMessages(
          cfg.historyMode === 'off' ? [] : history,
          text
        )
        // J4 turn loop: stream → tools → tool_results → stream again (bounded).
        let actSeq = 0
        const nextActId = (): number => ++actSeq
        const spokenParts: string[] = []
        let cancelled = false
        let hops = 0
        for (;;) {
          const req = buildJarvisRequest(cfg.model, key ?? '', system, messages, tools)
          const result = await streamJarvisReply(req, streamDeps, abort.signal, (delta) =>
            push({ id, kind: 'delta', text: delta })
          )
          if (!result.ok) {
            if (activeAbort === abort) activeAbort = null
            push({
              id,
              kind: 'error',
              reason: result.reason === 'no-key' ? 'no-key' : result.message
            })
            return
          }
          if (result.text.trim().length > 0) spokenParts.push(result.text)
          cancelled = result.cancelled
          const wantsTools =
            !cancelled && result.stopReason === 'tool_use' && result.toolUses.length > 0
          if (!wantsTools || facet === null || ++hops > MAX_TOOL_HOPS) break
          // Assistant hop (its text + the tool_use blocks), then the results as user blocks.
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
            id,
            result.toolUses,
            facet,
            abort.signal,
            nextActId
          )
          messages.push({ role: 'user', content: resultBlocks })
          if (abort.signal.aborted) {
            cancelled = true
            break
          }
        }
        if (activeAbort === abort) activeAbort = null
        const spoken = spokenParts.join(' ')
        if (cfg.historyMode !== 'off' && spoken.trim().length > 0) {
          history.push({ role: 'user', text })
          history.push({
            role: 'assistant',
            text: cancelled ? `${spoken} — (interrupted)` : spoken
          })
          if (history.length > MAX_HISTORY_TURNS)
            history.splice(0, history.length - MAX_HISTORY_TURNS)
        }
        push({ id, kind: 'done', text: spoken, cancelled })
      })().catch(() => {
        // BRAIN-2: the turn body is void'd — without this catch any unexpected throw
        // (push used to throw on a destroyed window) became an unhandledRejection →
        // crashShutdown. Settle the turn as errored; push itself never throws now.
        if (activeAbort === abort) activeAbort = null
        push({ id, kind: 'error', reason: 'turn-failed' })
      })

      return { ok: true, id }
    }
  )

  ipcMain.handle('jarvis:turn:cancel', (e): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    activeAbort?.abort()
    return { ok: true }
  })

  ipcMain.handle('jarvis:history:get', (e): JarvisTurn[] => {
    if (guard(e)) return []
    // A bounded copy — the renderer view renders it; mutations stay MAIN-side.
    return historyFor().slice(-MAX_HISTORY_TURNS)
  })

  ipcMain.handle('jarvis:history:clear', (e): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    historyFor().length = 0
    return { ok: true }
  })
}
