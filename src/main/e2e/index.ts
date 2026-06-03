/**
 * In-process board harness (CANVAS_SMOKE=e2e). MAIN seeds one of each board type
 * through the renderer hook (window.__canvasE2E) and asserts each works at runtime,
 * INCLUDING the Browser native WebContentsView layer that mainWindow.capturePage()
 * cannot see (asserted via the preview manager's own per-view capturePage).
 *
 * Formerly one 950-line function; now a fixed PLAYLIST of probe modules threaded with a
 * shared E2ECtx. The ORDER is load-bearing — probes share seeded ids and restore each
 * other's mutations (e.g. menu-chrome shrinks the terminal, preview-connect-gesture
 * widens it back; the final `seed` asserts the count returned to 4). Do NOT reorder.
 *
 * Emits one marker line per part + a final E2E_DONE, and returns a summary whose
 * exitCode the caller assigns to process.exitCode. Verified by running the command;
 * not a vitest target (needs the live Electron runtime).
 *
 * Markers go to stdout via bare console.log — safe here because index.ts installs a
 * process.stdout 'error' handler (EPIPE swallow) before this runs whenever SMOKE is set.
 */
import type { BrowserWindow } from 'electron'
import { summarizeE2E, type E2EPart } from '../e2eReport'
import { makeContext } from './context'
import type { E2EProbe } from './types'
import {
  terminal,
  configNowheel,
  terminalLod,
  terminalRespawn,
  terminalAdopt
} from './probes/terminal'
import { browser, browserGesture, focusDetach, browserDeadUrl } from './probes/browserPreview'
import {
  terminalFullview,
  fullviewPreview,
  fullviewSelfPreserve,
  fullviewEmulator,
  fullviewClose
} from './probes/fullview'
import { planning } from './probes/planning'
import { boardMenu, menuChrome, menuPreviewDetach } from './probes/menu'
import { previewEdgeStale, duplicateKeepsLink, previewConnectGesture } from './probes/previewLink'
import { connectorRoundtrip, connectorDrawDelete, connectorEdgeRender } from './probes/connectors'
import { tidy, tile } from './probes/layout'
import {
  whiteboardErase,
  whiteboardSelection,
  whiteboardFullviewAdd,
  whiteboardAltDup,
  whiteboardLock,
  whiteboardGroup,
  whiteboardAlign,
  whiteboardGroupAlign,
  whiteboardPasteImage,
  whiteboardExport // W5: SVG/PNG export pipeline
} from './probes/whiteboard'
import { boardStatusPill } from './probes/status'
import { lifecycleSpawnClose } from './probes/lifecycle'
import {
  dispatchAudit,
  dispatchConfirm,
  dispatchHandoff,
  dispatchAssign,
  dispatchWriteResult,
  dispatchInterrupt
} from './probes/dispatch'
import { seed } from './probes/seed'

// EXACT current execution order — interleaves themes by design (a probe's theme file is
// just where it lives; this list is what actually runs, and order is the contract).
const PLAYLIST: E2EProbe[] = [
  terminal,
  terminalFullview,
  browser,
  browserGesture,
  focusDetach,
  configNowheel,
  planning,
  fullviewPreview, // emits fullview-preview + fullview-preserve
  fullviewSelfPreserve,
  fullviewEmulator,
  fullviewClose,
  terminalLod,
  terminalRespawn,
  terminalAdopt,
  browserDeadUrl,
  previewEdgeStale,
  duplicateKeepsLink,
  boardMenu,
  menuChrome,
  boardStatusPill, // T1.6: on-canvas pill dot matches the agent-facing bucket
  menuPreviewDetach,
  previewConnectGesture,
  connectorRoundtrip, // M2 T2.1: connector add/round-trip/remove through the store
  connectorDrawDelete, // M2 T2.2: draw via resolveConnectTarget + ✕/board-delete cleanup + undo
  connectorEdgeRender, // M2 T2.3 (gate): distinct stroke vs preview + reroute + preview no-regression
  tidy,
  tile,
  whiteboardErase, // W1: emits whiteboard-erase + whiteboard-shortcut
  whiteboardSelection, // W2: emits whiteboard-group-delete/multidrag/shift-add/snap
  whiteboardAltDup, // W3: real-input alt-drag duplicate
  whiteboardLock, // W3: locked resists drag/erase/X
  whiteboardGroup, // W3: group move + group delete via the menu
  whiteboardAlign, // W3: align-left via the menu
  whiteboardGroupAlign, // W3: align works on a GROUP (right-click expands the group)
  whiteboardFullviewAdd, // Option A: real-input add-note in Planning camera-full-view
  whiteboardPasteImage, // W4: real-paste image persists + reloads + dedups + GCs
  whiteboardExport, // W5: SVG/PNG export pipeline (svg/png/image-embed/missing-asset)
  lifecycleSpawnClose, // M3 T3.1+T3.2: addBoard → canvas+mirror+shell; drain+removeBoard → gone+reaped; baseline 4
  dispatchAudit, // M4 T4.1: MAIN append → audit:read IPC readback + viewer renders the row
  dispatchConfirm, // M4 T4.2: confirm gate blocks until answered; approve/deny round-trip
  dispatchHandoff, // M4 T4.3: confirm→nonce→write into target PTY→audit; replay+label rejected
  dispatchAssign, // M4 T4.4: assign_prompt fire-and-forget — confirm→write→resolves (no await-idle); dispatched audit, no completed
  dispatchWriteResult, // M4 T4.4: write_result — worker records its own board result → canvas://board/{id}/result
  dispatchInterrupt, // M4 T4.5: interrupt — confirm→\x03→resolves→interrupt/dispatched audit; replay rejected
  seed
]

export async function runE2ESmoke(win: BrowserWindow, localUrl: string): Promise<number> {
  const ctx = makeContext(win, localUrl)

  // The hook installs after React mounts — wait for it before driving anything.
  const hookReady = await ctx.poll(() => ctx.evalIn<boolean>('!!window.__canvasE2E'), 8000)
  if (!hookReady) {
    const s = summarizeE2E([
      { name: 'hook', ok: false, detail: 'window.__canvasE2E never appeared' }
    ])
    console.log(s.line)
    return s.exitCode
  }

  const parts: E2EPart[] = []
  for (const probe of PLAYLIST) {
    const r = await probe.run(ctx)
    if (Array.isArray(r)) parts.push(...r)
    else parts.push(r)
  }

  const summary = summarizeE2E(parts)
  for (const p of parts) console.log(`E2E_${p.name.toUpperCase()} ${JSON.stringify(p)}`)
  console.log(summary.line)
  return summary.exitCode
}
