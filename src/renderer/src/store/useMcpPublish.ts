import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'

/**
 * Publish a minimal board snapshot (id/type/title) to MAIN's MCP board registry
 * whenever the canvas changes. Debounced; control-plane metadata only (no board
 * content). A no-op if the bridge is absent (e.g. a non-Electron test runtime).
 */
export function useMcpPublish(): void {
  const boards = useCanvasStore((s) => s.boards)
  useEffect(() => {
    const publish = window.api?.mcp?.publishBoards
    if (!publish) return
    const t = setTimeout(() => {
      publish(boards.map((b) => ({ id: b.id, type: b.type, title: b.title })))
    }, 150)
    return () => clearTimeout(t)
  }, [boards])
}
