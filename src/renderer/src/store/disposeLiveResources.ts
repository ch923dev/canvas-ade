/**
 * Tear down all live native resources before a project switch: close every preview
 * WebContentsView and kill every Terminal PTY tree. Without this, switching projects
 * leaks renderers + orphans node-pty child trees. Idempotent / best-effort.
 */
import { useCanvasStore } from './canvasStore'

export async function disposeLiveResources(): Promise<void> {
  const boards = useCanvasStore.getState().boards
  // Close all preview views in one shot (cheaper than per-id).
  await window.api.closeAllPreviews().catch(() => false)
  // Kill each terminal's PTY tree.
  await Promise.all(
    boards
      .filter((b) => b.type === 'terminal')
      .map((b) => window.api.killTerminal(b.id).catch(() => false))
  )
}
