import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'
import { useTerminalRuntimeStore } from './terminalRuntimeStore'
import { usePreviewStore } from './previewStore'
import { buildBoardSnapshot } from './boardStatus'

/** Warn once if the preload bridge is missing in Electron (vs silently in tests). */
let warnedMissingBridge = false

/**
 * Publish a board snapshot (id/type/title + derived status bucket, T1.1) to MAIN's
 * MCP board registry whenever the canvas OR a board's live runtime changes. The
 * status bucket is derived in the renderer (the only place that holds the live
 * `terminalRuntimeStore` + `previewStore` state) so the agent-facing
 * `canvas://boards` view and the on-canvas pill share one source of truth.
 *
 * Debounced; control-plane metadata only (no board content — `previewStore` snapshots
 * etc. never leave the renderer). A no-op if the bridge is absent (e.g. a non-Electron
 * test runtime) — but if `window.api` exists yet `mcp.publishBoards` does not, the
 * preload bridge has regressed: warn once so a dropped bridge surfaces instead of
 * silently leaving the MAIN mirror (and `canvas://boards`) permanently empty.
 */
export function useMcpPublish(): void {
  const boards = useCanvasStore((s) => s.boards)
  // Orchestration connectors authorize agent-to-agent relay (T4.6); mirror them to MAIN
  // alongside boards so the dispatch adapter can resolve a relay edge. Subscribing
  // re-publishes when a cable is drawn/removed.
  const connectors = useCanvasStore((s) => s.connectors)
  // Subscribe to the runtime slices so a liveness change (terminal start/exit, a
  // browser load/fail) re-publishes even when the durable `boards` array is unchanged.
  const running = useTerminalRuntimeStore((s) => s.running)
  const previewById = usePreviewStore((s) => s.byId)
  useEffect(() => {
    const publish = window.api?.mcp?.publishBoards
    if (!publish) {
      if (window.api && !warnedMissingBridge) {
        warnedMissingBridge = true
        // eslint-disable-next-line no-console -- intentional one-time regression warning
        console.error(
          'useMcpPublish: window.api.mcp.publishBoards missing — MCP board list will be empty'
        )
      }
      return
    }
    const t = setTimeout(() => {
      publish({
        boards: buildBoardSnapshot(boards, { running, preview: previewById }),
        connectors
      })
    }, 150)
    return () => clearTimeout(t)
  }, [boards, connectors, running, previewById])
}
