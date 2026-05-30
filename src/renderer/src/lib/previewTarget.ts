/**
 * Pure push-target resolution for the preview link (Slice C′): decide which Browser
 * board a terminal's "push to preview" should target. Order: follow an existing
 * link → currently-selected browser → the sole browser → spawn a fresh one.
 */
import type { Board } from './boardSchema'

export type PreviewTarget = { kind: 'existing'; id: string } | { kind: 'spawn' }

export function resolvePreviewTarget(
  boards: Board[],
  selectedId: string | null,
  fromId: string
): PreviewTarget {
  const linked = boards.find((b) => b.type === 'browser' && b.previewSourceId === fromId)
  if (linked) return { kind: 'existing', id: linked.id }

  const selected = boards.find((b) => b.id === selectedId && b.type === 'browser')
  if (selected) return { kind: 'existing', id: selected.id }

  const browsers = boards.filter((b) => b.type === 'browser')
  if (browsers.length === 1) return { kind: 'existing', id: browsers[0].id }

  return { kind: 'spawn' }
}
