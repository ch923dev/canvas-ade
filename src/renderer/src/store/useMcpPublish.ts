import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'

/** Warn once if the preload bridge is missing in Electron (vs silently in tests). */
let warnedMissingBridge = false

/**
 * Publish a minimal board snapshot (id/type/title) to MAIN's MCP board registry
 * whenever the canvas changes. Debounced; control-plane metadata only (no board
 * content). A no-op if the bridge is absent (e.g. a non-Electron test runtime) —
 * but if `window.api` exists yet `mcp.publishBoards` does not, the preload bridge
 * has regressed: warn once so a dropped bridge surfaces instead of silently leaving
 * the MAIN mirror (and canvas://boards) permanently empty.
 */
export function useMcpPublish(): void {
  const boards = useCanvasStore((s) => s.boards)
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
      publish(boards.map((b) => ({ id: b.id, type: b.type, title: b.title })))
    }, 150)
    return () => clearTimeout(t)
  }, [boards])
}
