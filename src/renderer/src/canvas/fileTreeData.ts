/**
 * File-tree epic (S2) — pure tree-data model + helpers for the lazily-loaded FileTree.
 *
 * Split out of FileTree.tsx so the component module exports only the component (react-refresh)
 * and so this logic is unit-testable in isolation. No React, no IPC — just immutable transforms
 * over the nested node model react-arborist renders.
 */

/** The DnD MIME the tree emits and the S4 Planning drop handler will read (S1 contract). */
export const FILEREF_MIME = 'application/x-canvas-ade-fileref'

/** Mirrors the preload `FileEntry` (S1) — what `file.listDir` returns per directory entry. */
export interface FileEntry {
  name: string
  isDir: boolean
}

/**
 * One tree node. `id` is the root-relative, forward-slashed path (the openFileBoard / fileref
 * contract). `children === undefined` on a dir = not-yet-loaded (the childrenAccessor still
 * reports it as openable); `loaded` flips true once its listing has been fetched.
 */
export interface FileNode {
  id: string
  name: string
  isDir: boolean
  children?: FileNode[]
  loaded?: boolean
}

/** Dirs before files, then case-insensitive name — a stable, conventional order. */
function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/** Build child nodes for `parentId` ('' = root) from a raw listing. */
export function toNodes(parentId: string, entries: FileEntry[]): FileNode[] {
  return [...entries].sort(compareEntries).map((e) => ({
    id: parentId ? `${parentId}/${e.name}` : e.name,
    name: e.name,
    isDir: e.isDir
  }))
}

/**
 * Merge a fresh listing onto the previous children, carrying over an already-loaded subdir's
 * own children so a live refresh of a parent never collapses an expanded subtree.
 */
export function mergeChildren(prev: FileNode[] | undefined, fresh: FileNode[]): FileNode[] {
  const byId = new Map((prev ?? []).map((n) => [n.id, n]))
  return fresh.map((f) => {
    const old = byId.get(f.id)
    return f.isDir && old?.loaded ? { ...f, children: old.children, loaded: true } : f
  })
}

/** Immutably replace the node at `id` via `fn`, recursing only down the matching branch. */
function updateNode(nodes: FileNode[], id: string, fn: (n: FileNode) => FileNode): FileNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n)
    if (n.children && id.startsWith(`${n.id}/`)) {
      return { ...n, children: updateNode(n.children, id, fn) }
    }
    return n
  })
}

/** Apply a directory listing (root or nested), preserving expanded subtrees. */
export function applyListing(prev: FileNode[], parentId: string, entries: FileEntry[]): FileNode[] {
  const fresh = toNodes(parentId, entries)
  if (parentId === '') return mergeChildren(prev, fresh)
  return updateNode(prev, parentId, (n) => ({
    ...n,
    children: mergeChildren(n.children, fresh),
    loaded: true
  }))
}

/** Find a node by id (depth-first), pruning to the matching branch. */
export function findNode(nodes: FileNode[], id: string): FileNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children && id.startsWith(`${n.id}/`)) {
      const hit = findNode(n.children, id)
      if (hit) return hit
    }
  }
  return null
}

/** The relative parent dir of a relative path ('' for a root-level entry). */
export function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}
