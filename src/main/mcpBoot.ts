/**
 * M11 — lazy-start wiring for the in-app MCP loopback server, extracted from index.ts (which sits at
 * the max-lines ratchet — see docs/contributing/file-size-doctrine.md; the same reason voiceBoot.ts /
 * deepLinkBoot.ts exist).
 *
 * The in-app `@expanse-ade/mcp` loopback server used to boot unconditionally in `whenReady`, holding
 * Express 5 + the MCP SDK + zod/ajv in MAIN's heap for the whole run even when Agent Orchestration is
 * never used (the common case). `createMcpBoot` assembles the board registry (previously an inline
 * literal in index.ts — every field is a plain module import, so it moves here wholesale) and returns
 * a memoized `ensureMcp()` so the ESM import + loopback bind are paid only on the FIRST orchestration
 * use. index.ts triggers it on orchestration-ENABLE, on opening an already-consented project, and —
 * for the capture-by-value e2e seam — eagerly before installE2EMain.
 *
 * Only three things genuinely live in index.ts's setup scope and so are injected: the window getter,
 * the userData dir (for the live spawn-cap read), and `publish` (writes the resolved server into
 * index.ts's `mcp` variable so the existing `() => mcp` getters observe it).
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { startMcpServer, type RunningMcp } from './mcp'
import { singleFlight } from './promiseSingleton'
import type { BoardRegistry } from './mcpRegistry'
import {
  listPtySessions,
  readPtyOutput,
  drainPty,
  writeToPty,
  getTerminalActivityStaleMs,
  isBracketedPasteEnabled,
  getTerminalBootInfo,
  getTerminalCwd
} from './pty'
import { boardGitDiff } from './gitDiff'
import { createReadinessWaiter } from './terminalReadiness'
import { readBoardResult, recordBoardResult } from './boardResults'
import { readProjectMemory, readBoardSummary } from './boardMemory'
import { readOrchestrationConfig } from './orchestrationConfig'
import { listBoardMirror, listConnectors, listGroups, subscribeBoardStatus } from './boardRegistry'
import { sendMcpCommand } from './mcpCommand'
import { getAuditLog } from './auditIpc'
import { requestConfirm, requestConfirmBatch } from './mcpConfirm'

export interface McpBootDeps {
  /** index.ts's trusted BrowserWindow getter (frame-guard target for the confirm/command IPC). */
  getWin: () => BrowserWindow | null
  /** userData dir — the live spawn-cap config is read fresh per spawn check from here. */
  userData: string
  /** Publish the resolved server into index.ts's `mcp` variable (read by the () => mcp getters). */
  publish: (m: RunningMcp | null) => void
}

/**
 * Assemble the MCP board registry + opts and return the memoized `ensureMcp()`. The registry body is
 * verbatim what index.ts passed to `startMcpServer` before M11 — no behavioural change, only its home.
 */
export function createMcpBoot(deps: McpBootDeps): () => Promise<RunningMcp | null> {
  const { getWin, userData, publish } = deps
  const registry: BoardRegistry = {
    listBoards: listBoardMirror,
    // The orchestration connector graph (T4.6 relay_prompt) — mirrored from the renderer.
    listConnectors,
    // PR-5: the Named Group mirror (feature zones) — feeds the app-model's live canvas.groups.
    listGroups,
    listSessions: listPtySessions,
    // BUG-007: ms-since-last-PTY-output per board — the output-silence dormancy signal awaitSettled
    // (C2e) polls, since a live agent shell's status never flips off 'running'.
    boardActivityStaleMs: getTerminalActivityStaleMs,
    // Relay cut-off fix (2026-07-04): DECSET-2004 probe — the dispatch gate paste-frames its body
    // write only when the target's foreground app currently accepts bracketed paste.
    isBracketedPaste: isBracketedPasteEnabled,
    // Readiness gate (2026-07-03): boot-quiet waiter so a dispatched prompt lands in a READY REPL, not
    // mid-boot (floor → activity → quiet, degrade-honestly backstop). One waiter instance per server
    // so its per-process latch spans dispatches.
    awaitReady: createReadinessWaiter({
      bootInfo: getTerminalBootInfo,
      activityStaleMs: getTerminalActivityStaleMs,
      now: Date.now
    }).awaitTerminalReady,
    subscribeStatus: subscribeBoardStatus,
    readOutput: readPtyOutput,
    readResult: readBoardResult,
    readMemory: readProjectMemory,
    readSummary: readBoardSummary,
    // The MCP write path (T3.1+): frame-guarded control-plane command → renderer.
    sendCommand: (command) => sendMcpCommand(ipcMain, getWin, command),
    // Graceful PTY drain before an MCP close_board removes the board (T3.2).
    drainPty: (id) => drainPty(id),
    // 🔒 MCP dispatch (T4.3 handoff_prompt): write into a terminal's PTY ONLY after a single-use
    // nonce + a mandatory human confirm + an audit entry have authorized it.
    writeToPty: (id, text) => writeToPty(id, text),
    // 🔒 PR-2: read-only working-tree diff for a board (simple-git in MAIN, via gitDiff.ts).
    gitDiff: (id) => boardGitDiff(id, getTerminalCwd),
    // The human-confirm gate (T4.2) — fail-closed; blocks until the user answers.
    confirm: (req) => requestConfirm(ipcMain, getWin, req),
    // The per-row BATCH human-confirm gate (relay_prompts) — fail-closed; ONE modal, N rows.
    confirmBatch: (req) => requestConfirmBatch(ipcMain, getWin, req),
    // Append to the append-only dispatch audit trail (T4.1). Read lazily so the closure resolves the
    // log at dispatch time.
    audit: (e) =>
      getAuditLog()
        ?.append(e)
        .then(() => {})
        .catch((err: unknown) => {
          // A failed audit write is a forensic gap — surface it in the log even if a future
          // non-awaiting caller forgets to handle the rejection, then RE-THROW so today's awaiting
          // callers (the mcpOrchestrator dispatch paths) still see it and can react.
          console.error('[mcp-audit] append failed', err)
          throw err
        }) ?? Promise.resolve(),
    // 🔒 MCP worker-tier write (T4.4 write_result): record a board's own structured result →
    // canvas://board/{id}/result. Bound to the caller's token board by the tool.
    recordResult: (id, result) => recordBoardResult(id, result)
  }
  const opts = {
    // The runaway-swarm spawn cap is user-configurable (orchestration-config.json in userData). Read
    // FRESH per spawn check so a Settings change to the cap applies live — no MAIN restart, no
    // orchestrator rebuild. Unset/absent config ⇒ MCP_SPAWN_CAP (4).
    cap: () => readOrchestrationConfig(userData).spawnCap
  }
  // Memoized so concurrent triggers (ENABLE onChange · open-of-consented-project · e2e warm) share
  // ONE boot; publish writes the resolved server into index.ts's `mcp` for the () => mcp getters.
  return singleFlight(() => startMcpServer(registry, opts), publish)
}
