/**
 * LLM key-store + Jarvis brain IPC wiring, extracted from index.ts for the max-lines
 * ratchet (the #340 ↔ J3 umbrella merge put index.ts over the 702 pin; voiceBoot /
 * deepLinkBoot precedent). Pure wiring, no behavior. The two registrations live
 * together because they share the same key slot: Jarvis reads the llmKeyStore
 * `anthropic` entry (llmDataDir + the shared safeStorage encryptor) that the LLM
 * handlers persist. The per-turn workspace manifest reads the AppModel in-process via
 * the lazy MCP boot — ensureMcp is a whenReady-scope closure in index.ts, so it is
 * injected rather than imported (first Jarvis turn pays the one-time ensureMcp, like
 * first orchestration).
 *
 * J4 (hands): the same lazy boot now also supplies the tool executor's canvas facet —
 * the widened RunningMcp slice (cards/plan/viewport/spawn/dispatch) — plus the
 * Jarvis-side confirm (requestConfirm: the spawn_board pre-gate; the orchestrator's own
 * gates ride the registry binding). jarvisIpc wraps execution in the ALS origin marker,
 * so every confirm raised inside a tool call renders on the panel.
 */
import type { BrowserWindow, IpcMain } from 'electron'
import type { RunningMcp } from './mcp'
import { registerJarvisHandlers, type JarvisIpcDeps } from './jarvisIpc'
import { registerLlmHandlers } from './llmIpc'
import { registerSwarmHandlers, type SwarmHandlers } from './swarmChatIpc'
import { requestConfirm } from './mcpConfirm'
import { subscribeBoardStatus } from './boardRegistry'
import { isResultSynthesized, readBoardResult } from './boardResults'
import { getTerminalActivityStaleMs } from './pty'

interface LlmJarvisBootDeps {
  llmDataDir: string
  llmEncryptor: JarvisIpcDeps['encryptor']
  /** MAIN's getCurrentDir — history keying (null = no project). */
  getCurrentDir: JarvisIpcDeps['getProjectKey']
  /** The memoized lazy MCP boot from index.ts (M11). */
  ensureMcp: () => Promise<RunningMcp | null | undefined>
  /** `resultSynth.onSettle` — S2 forces a synthesis before salvaging a dead worker (see below). */
  synthesizeNow: (boardId: string) => void
}

/**
 * Wire the LLM/Jarvis/swarm IPC surfaces. Returns the swarm handle so index.ts can run the S2
 * failure-case-B drain from its quit chain (the ONE thing registration can't own itself).
 */
export function wireLlmJarvis(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: LlmJarvisBootDeps
): SwarmHandlers {
  registerLlmHandlers(ipcMain, getWin, deps.llmDataDir, undefined, deps.llmEncryptor)
  // Jarvis J3: the voice-brain session. Key = the llmKeyStore `anthropic` slot (same
  // encryptor as the LLM handlers above).
  registerJarvisHandlers(ipcMain, getWin, {
    getUserData: () => deps.llmDataDir,
    encryptor: deps.llmEncryptor,
    getProjectKey: deps.getCurrentDir,
    getAppModel: async () => {
      try {
        return (await deps.ensureMcp())?.describeApp() ?? null
      } catch {
        return null
      }
    },
    // J4: the tool executor's canvas facet — RunningMcp IS the facet (structural subset);
    // null (no project / MCP bind failure) runs the turn toolless.
    getFacet: async () => {
      try {
        return (await deps.ensureMcp()) ?? null
      } catch {
        return null
      }
    },
    // J4: the Jarvis-side pre-gate (spawn_board). Same fail-closed requestConfirm as every
    // MCP gate; the ALS origin marker (set around the executor in jarvisIpc) routes it to
    // the panel act card.
    confirm: (req) => requestConfirm(ipcMain, getWin, req)
  })
  // Orchestration S1: the swarm boards' app-resident orchestrator brain — per-board chat
  // sessions on the SAME shared Context·LLM config/key/budget plumbing (Q9 default). RunningMcp
  // is the tool facet (structural superset of SwarmCanvasFacet); the same fail-closed
  // requestConfirm gates spawn_worker (dispatch confirms inside the orchestrator gate).
  return registerSwarmHandlers(ipcMain, getWin, {
    getUserData: () => deps.llmDataDir,
    encryptor: deps.llmEncryptor,
    getFacet: async () => {
      try {
        return (await deps.ensureMcp()) ?? null
      } catch {
        return null
      }
    },
    confirm: (req) => requestConfirm(ipcMain, getWin, req),
    // Orchestration S2: the run ledger is a PROJECT sidecar (`<project>/.canvas/memory/`, design
    // D1) — the same `getCurrentDir` Jarvis keys its history by. No project ⇒ no ledger ⇒ the run
    // is ephemeral exactly as in S1.
    getProjectDir: deps.getCurrentDir,
    // Orchestration S2 failure model. All three signals are MAIN singletons, bound HERE (the boot
    // wiring) rather than imported inside swarmChatIpc, so the watcher stays injectable:
    //   - subscribeBoardStatus → a worker board going 'gone'/'failed' IS the death signal;
    //   - readBoardResult      → the SYNC salvage read (usable inside the quit chain, unlike the
    //                            async MCP facet, which may already be closed by then);
    //   - activityStaleMs      → real PTY silence, folded into the ledger by the stall sweep.
    watch: {
      subscribeStatus: (listener) => subscribeBoardStatus(listener),
      readResult: (boardId) => ({
        ...readBoardResult(boardId),
        synthesized: isResultSynthesized(boardId)
      }),
      activityStaleMs: (boardId) => getTerminalActivityStaleMs(boardId),
      // - synthesizeNow    → death IS a settle. `readBoardResult` alone would almost always be
      //                      empty here: synthesis is otherwise driven only by the recap watcher's
      //                      25s transcript debounce, while a PTY exit reaches the watcher in a
      //                      few hundred ms — and the sweep never revisits an already-`blocked`
      //                      task, so a late synthesis would never be salvaged at all.
      synthesizeNow: (boardId) => deps.synthesizeNow(boardId)
    }
  })
}
