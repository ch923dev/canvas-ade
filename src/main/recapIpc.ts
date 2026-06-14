/**
 * S1 (recap redesign): the `recap:get` read path for the terminal recap face.
 *
 * Layer-0 FACTS are computed LIVE per call from the transcript tail + PTY runtime -
 * local-only (no LLM, no egress), so NO consent gate applies; the isTrustedTranscriptPath
 * guard still confines reads to .jsonl files under Claude's config root (the path is
 * persisted in canvas.json, so a hand-crafted project file must not aim MAIN's fs at an
 * arbitrary file). The Layer-1 NARRATIVE is a pure sidecar read (written, pre-sanitized,
 * by the summary loop's recap branch); narrowNarrative re-validates + re-bounds it anyway
 * because the sidecar lives in the user-editable project folder. Read-only: never an
 * action surface. Refresh stays on the existing `memory:refresh` channel.
 */
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { isForeignSender } from './ipcGuard'
import { computeRecapFacts, type RecapFacts } from './recapFacts'
import { isTrustedTranscriptPath, readTranscriptTail } from './agentTranscript'
import { safeBoardId, createCanvasMemory } from './canvasMemory'
import type { TerminalRuntime, RecapNarrative, RecapBeat } from './summaryLoop'

/** What the renderer's RecapView renders: live facts + the cached narrative, if any. */
export interface RecapBundle {
  facts: RecapFacts
  narrative?: RecapNarrative
}

/** Bounds re-applied when reading the sidecar back (a hand-edited file could be huge). */
const NARRATIVE_TEXT_MAX = 2000
const NARRATIVE_BEATS_MAX = 8

export interface RecapIpcDeps {
  getWin: () => BrowserWindow | null
  getCurrentDir: () => string | null
  /** boardId -> its transcript path (the board doc's field ?? the learned map entry). */
  getTranscriptPath: (boardId: string) => string | undefined
  /** MAIN-internal runtime accessor (same one the summary loop reads). */
  getTerminalRuntime: (boardId: string) => TerminalRuntime | undefined
  now?: () => number
}

/**
 * Pure: narrow an unknown sidecar JSON to a RecapNarrative, or undefined. The loop wrote
 * it sanitized, but the file sits in the project folder where a user (or another tool)
 * can edit it - so shape-check every field and re-cap text lengths before it reaches the
 * renderer. Never throws.
 */
export function narrowNarrative(v: unknown): RecapNarrative | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as { now?: unknown; next?: unknown; beats?: unknown; asOf?: unknown }
  if (typeof o.now !== 'string' || typeof o.asOf !== 'number' || !Number.isFinite(o.asOf))
    return undefined
  const beats: RecapBeat[] = Array.isArray(o.beats)
    ? o.beats.slice(0, NARRATIVE_BEATS_MAX).flatMap((b) => {
        const x = b as { ts?: unknown; text?: unknown; role?: unknown }
        return typeof x.text === 'string' && typeof x.ts === 'number' && Number.isFinite(x.ts)
          ? [
              {
                ts: x.ts,
                text: x.text.slice(0, NARRATIVE_TEXT_MAX),
                role: x.role === 'user' ? ('user' as const) : ('agent' as const)
              }
            ]
          : []
      })
    : []
  return {
    now: o.now.slice(0, NARRATIVE_TEXT_MAX),
    ...(typeof o.next === 'string' ? { next: o.next.slice(0, NARRATIVE_TEXT_MAX) } : {}),
    beats,
    asOf: o.asOf
  }
}

export function registerRecapIpc(ipcMain: IpcMain, deps: RecapIpcDeps): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, deps.getWin)
  const now = deps.now ?? Date.now

  // Sync handler by design: the tail read is a bounded 64KB pread (readTranscriptTail)
  // and the sidecar a small JSON - same weight class as memory:readBoards.
  ipcMain.handle('recap:get', (e, boardId: unknown): RecapBundle | null => {
    if (guard(e)) return null
    // BUG-032 discipline: enforce safeBoardId at IPC ingress before any work.
    if (typeof boardId !== 'string' || !safeBoardId(boardId)) return null
    const dir = deps.getCurrentDir()
    if (!dir) return null

    let runtime: TerminalRuntime | undefined
    try {
      runtime = deps.getTerminalRuntime(boardId)
    } catch {
      runtime = undefined
    }

    let tail = ''
    try {
      const path = deps.getTranscriptPath(boardId)
      if (path && isTrustedTranscriptPath(path) && existsSync(path)) {
        tail = readTranscriptTail(path)
      }
    } catch {
      tail = '' // unreadable/vanished transcript -> facts degrade to runtime-only
    }
    const facts = computeRecapFacts(tail, runtime, now())

    let narrative: RecapNarrative | undefined
    try {
      narrative = narrowNarrative(createCanvasMemory(dir).readBoardRecap(boardId))
    } catch {
      narrative = undefined
    }
    return { facts, ...(narrative ? { narrative } : {}) }
  })
}
