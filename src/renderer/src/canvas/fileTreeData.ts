/**
 * File-tree epic (S2) — pure tree-data model + helpers for the lazily-loaded FileTree.
 *
 * Split out of FileTree.tsx so the component module exports only the component (react-refresh)
 * and so this logic is unit-testable in isolation. No React, no IPC — just immutable transforms
 * over the nested node model react-arborist renders.
 */

/** The DnD MIME the tree emits and the S4 Planning drop handler will read (S1 contract). */
export const FILEREF_MIME = 'application/x-canvas-ade-fileref'

// ── File glyphs (shared by the tree row AND the S4 file-reference chip) ─────────
// File glyphs all share the folded-corner silhouette + a type mark inside, so they read as a
// family. Kept NEUTRAL (no per-type colour) to honour the one-accent design contract (DESIGN.md);
// the differentiation is by shape, like a minimal icon theme. Pure (path string in/out), so they
// live in this React-free module — one source of truth the tree and the chip both draw from.
const FILE_PATH = 'M7 4h7l4 4v12H7zM14 4v4h4'
const CODE_PATH = 'M7 4h7l4 4v12H7zM14 4v4h4M10 12l-1.6 2 1.6 2M14 12l1.6 2-1.6 2' // </>
const DOC_PATH = 'M7 4h7l4 4v12H7zM14 4v4h4M9.5 13h5M9.5 16h3.5' // text lines
const IMG_PATH = 'M7 4h7l4 4v12H7zM14 4v4h4M9 17l2-2.4 1.5 1.5L15.5 13l1.5 2' // mountain

const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])
const DOC_EXT = new Set(['md', 'mdx', 'markdown', 'txt'])
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'])

/** The folded-file glyph (SVG path data) for a filename, picked by extension. */
export function fileGlyphPath(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (CODE_EXT.has(ext)) return CODE_PATH
  if (DOC_EXT.has(ext)) return DOC_PATH
  if (IMG_EXT.has(ext)) return IMG_PATH
  return FILE_PATH
}

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
