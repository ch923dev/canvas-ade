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
  /** Present only on a COMPACT-folder display node (see compactTree): the merged chain of
   *  single-child folders, top→deepest, rendered as one "a / b / c" row. */
  segments?: { id: string; name: string }[]
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

/**
 * VS Code-style "compact folders": collapse a chain of single-child folders into ONE display node
 * labelled "a / b / c". Pure transform over the (lazily loaded) source tree — apply just before
 * rendering. The compound node KEEPS the TOP folder's id (so react-arborist's open state stays
 * stable at the moment a chain first loads) but exposes the DEEPEST folder's children; `segments`
 * carry the chain for the label. Only LOADED single-folder links merge, so a chain extends as its
 * folders load (FileTree cascade-loads sole sub-folders so the merge happens without a flash).
 */
export function compactTree(nodes: FileNode[]): FileNode[] {
  return nodes.map(compactNode)
}

function compactNode(n: FileNode): FileNode {
  if (!n.isDir) return n
  const segments = [{ id: n.id, name: n.name }]
  let cur = n
  while (cur.loaded && cur.children && cur.children.length === 1 && cur.children[0].isDir) {
    cur = cur.children[0]
    segments.push({ id: cur.id, name: cur.name })
  }
  const children = cur.children ? cur.children.map(compactNode) : cur.children
  if (segments.length > 1) {
    return { id: n.id, name: cur.name, isDir: true, loaded: cur.loaded, children, segments }
  }
  return { ...n, children }
}
