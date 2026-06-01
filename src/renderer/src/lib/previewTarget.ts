/**
 * Pure push-target classification for the preview link (Slice C′ + multi-browser
 * connect). Given the source terminal, split the Browser boards into:
 *  - linked: already wired to THIS terminal (a plain click just refreshes these), and
 *  - candidates: browsers the user can connect — unconnected (B) or connected to
 *    ANOTHER terminal (C, choosing it severs that link).
 *
 * The renderer routes by gesture: a tap refreshes the linked browser(s); a long-press
 * (or a tap with nothing linked) opens a multi-select picker over the candidates.
 */
import type { Board, BrowserBoard } from './boardSchema'

/** A target that can be applied directly (existing browser id, or a fresh spawn). */
export type ResolvedPushTarget = { kind: 'existing'; id: string } | { kind: 'spawn' }

/** One Browser board the user can choose to connect to the source terminal. */
export type PreviewCandidate = {
  id: string
  title: string
  url: string
  /** Set when this browser is currently linked to ANOTHER terminal — connecting it
   *  here severs that link. Undefined for unconnected browsers. */
  connectedTo?: { id: string; title: string }
}

export type PushClassification = {
  /** Browser ids already linked to the source terminal (a plain click refreshes these). */
  linkedIds: string[]
  /** Browsers the user can connect: unconnected (B) + connected-elsewhere (C). */
  candidates: PreviewCandidate[]
}

export function classifyPushTargets(boards: Board[], fromId: string): PushClassification {
  const terminalTitles = new Map(
    boards.filter((b) => b.type === 'terminal').map((t) => [t.id, t.title] as const)
  )
  const browsers = boards.filter((b): b is BrowserBoard => b.type === 'browser')

  const linkedIds: string[] = []
  const candidates: PreviewCandidate[] = []
  for (const b of browsers) {
    if (b.previewSourceId === fromId) {
      linkedIds.push(b.id) // A — already connected to this terminal
      continue
    }
    // C only when the link points at a real OTHER terminal; a dangling source id
    // (stale, normally stripped on load) is treated as unconnected (B).
    const src = b.previewSourceId
    const otherTitle = src && src !== fromId ? terminalTitles.get(src) : undefined
    const connectedTo = src && otherTitle !== undefined ? { id: src, title: otherTitle } : undefined
    candidates.push({ id: b.id, title: b.title, url: b.url, connectedTo })
  }
  return { linkedIds, candidates }
}
