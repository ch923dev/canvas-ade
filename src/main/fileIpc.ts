/**
 * File-tree epic (S1) — frame-guarded, root-confined filesystem IPC.
 *
 * The renderer is sandboxed and never touches Node/fs; every read/write/list/stat goes
 * through MAIN here. EACH handler (a) rejects a foreign sender via `isForeignSender` (the
 * single IPC trust-boundary guard), then (b) resolves the renderer's RELATIVE path against
 * the realpath'd project root with `realResolveWithinRoot` (lexical + symlink containment,
 * KICKOFF §4). The renderer never picks the fs op or passes flags; an absolute path is
 * rejected by the path helper. Writes go through `write-file-atomic` (the repo-wide save
 * primitive). `listDir` does NOT follow symlinked subdirs (it reports the dirent's own kind
 * and SKIPS links; Node recursive readdir would follow them — we are non-recursive +
 * report-only).
 *
 * NOTE the channels published here form the S1 contract every later slice builds on:
 *   file:readText · file:writeText · file:listDir · file:stat
 * plus the renderer-only `file:treeEvent` push channel (the chokidar watcher that EMITS it
 * lands in S2 — the channel/types are defined in the preload now so the contract is stable).
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { relative as pathRelative, sep } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { simpleGit } from 'simple-git'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import { getCurrentDir } from './projectStore'
import { realResolveWithinRoot } from './pathSafe'

/**
 * MAIN-side read ceiling (DoS backstop). The renderer already size-gates for UX far below this
 * (LARGE_TEXT_BYTES 2 MiB / MAX_IMAGE_BYTES 32 MiB in fileBoardSyntax), but a buggy or misbehaving
 * renderer must not be able to make MAIN slurp an arbitrarily large file into memory. 64 MiB sits
 * safely above the largest renderer gate; a read over it is rejected before the file is touched.
 */
const MAX_READ_BYTES = 64 * 1024 * 1024

/** One directory entry surfaced to the tree (no symlink following — report-only kind). */
export interface FileEntry {
  name: string
  isDir: boolean
}

/** Result of `file:gitPermalink` — a GitHub blob URL pinned to HEAD, or a reason it couldn't. */
export type GitPermalinkResult = { ok: true; url: string } | { ok: false; reason: string }

/** Parse an `origin` remote URL into `{owner, repo}` for GitHub forms (https / ssh / git@). */
function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i)
  return m ? { owner: m[1], repo: m[2] } : null
}

/** A file/dir stat projection (the minimum the tree/board need). */
export interface FileStat {
  size: number
  mtimeMs: number
  isDir: boolean
}

/**
 * Resolve a renderer-supplied RELATIVE path to a real, in-root absolute path. Throws when
 * no project is open or the path escapes the root. The root is realpath'd ONCE per call so
 * the symlink layer compares real paths to a real root.
 */
async function resolveRel(relPath: unknown): Promise<string> {
  const dir = getCurrentDir()
  if (!dir) throw new Error('file: no project open')
  if (typeof relPath !== 'string') throw new Error('file: path is not a string')
  const root = await realpath(dir)
  return realResolveWithinRoot(root, relPath)
}

/**
 * Resolve a read target AND enforce the MAIN-side size ceiling before any bytes are loaded.
 * Throws when the file is larger than `MAX_READ_BYTES` so an oversized read can never OOM MAIN
 * regardless of what the renderer requests (the renderer's own UX gate is advisory only).
 */
async function resolveReadable(relPath: unknown): Promise<string> {
  const abs = await resolveRel(relPath)
  const s = await stat(abs)
  if (s.size > MAX_READ_BYTES) {
    throw new Error(`file: too large to read (${s.size} bytes > ${MAX_READ_BYTES})`)
  }
  return abs
}

export function registerFileIpc(ipcMain: IpcMain, getWin: () => BrowserWindow | null): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('file:readText', async (e, relPath: string): Promise<string> => {
    if (guard(e)) throw new Error('file: foreign sender denied')
    const abs = await resolveReadable(relPath)
    return readFile(abs, 'utf8')
  })

  // S3 (cross-zone, additive): raw bytes for the File-board image preview. `readText`
  // is UTF-8 only — it corrupts binary — so a raster image (png/jpg/gif/webp) needs a
  // bytes channel to reach the renderer as a Blob. SAME trust boundary as every other
  // handler: foreign-sender guard → `realResolveWithinRoot` containment → one `fs` read
  // (the renderer never picks the op or passes flags). The renderer size-gates via
  // `file:stat` before calling, so this stays a small read. Buffer ⊆ Uint8Array; Electron
  // structured-clones it across the bridge (the same shape `asset:read` already returns).
  ipcMain.handle('file:readBytes', async (e, relPath: string): Promise<Uint8Array> => {
    if (guard(e)) throw new Error('file: foreign sender denied')
    const abs = await resolveReadable(relPath)
    return readFile(abs)
  })

  // S3 (additive): the resolved ABSOLUTE on-disk path — for the board's "Copy absolute path"
  // action. `resolveRel` already realpath-resolves + containment-checks; we just return it
  // (the renderer never learns the project root except for a file it already references).
  ipcMain.handle('file:realPath', async (e, relPath: string): Promise<string> => {
    if (guard(e)) throw new Error('file: foreign sender denied')
    return resolveRel(relPath)
  })

  // S3 (additive): a GitHub permalink (blob URL @ HEAD) for the board's "Copy GitHub link"
  // action. `simple-git` runs ONLY in MAIN (CLAUDE.md) behind this sender-guarded handler; the
  // path is containment-checked first. Returns a structured reason (never throws to the
  // renderer) when the project isn't a GitHub-remote repo / has no commits. The blob path is
  // relative to the GIT root (which may sit above the project root), so a project that is a
  // sub-directory of a larger repo still links correctly.
  ipcMain.handle('file:gitPermalink', async (e, relPath: string): Promise<GitPermalinkResult> => {
    if (guard(e)) throw new Error('file: foreign sender denied')
    const abs = await resolveRel(relPath)
    const dir = getCurrentDir()
    if (!dir) return { ok: false, reason: 'No project open' }
    try {
      const git = simpleGit(dir)
      if (!(await git.checkIsRepo())) return { ok: false, reason: 'Not a git repository' }
      let remoteUrl = ''
      try {
        remoteUrl = (await git.remote(['get-url', 'origin']))?.toString().trim() ?? ''
      } catch {
        return { ok: false, reason: 'No "origin" remote' }
      }
      const gh = remoteUrl ? parseGithubRemote(remoteUrl) : null
      if (!gh) return { ok: false, reason: 'origin is not a GitHub remote' }
      const sha = (await git.revparse(['HEAD'])).trim()
      const root = await realpath((await git.revparse(['--show-toplevel'])).trim())
      const relInRepo = pathRelative(root, abs).split(sep).join('/')
      return { ok: true, url: `https://github.com/${gh.owner}/${gh.repo}/blob/${sha}/${relInRepo}` }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'git error' }
    }
  })

  ipcMain.handle(
    'file:writeText',
    async (e, args: { path: string; text: string }): Promise<boolean> => {
      if (guard(e)) throw new Error('file: foreign sender denied')
      const abs = await resolveRel(args?.path)
      const text = typeof args?.text === 'string' ? args.text : ''
      await writeFileAtomic(abs, text, 'utf8')
      return true
    }
  )

  ipcMain.handle('file:listDir', async (e, relPath: string): Promise<FileEntry[]> => {
    if (guard(e)) throw new Error('file: foreign sender denied')
    const abs = await resolveRel(relPath)
    const ents = await readdir(abs, { withFileTypes: true })
    const out: FileEntry[] = []
    for (const ent of ents) {
      // Do NOT follow symlinks: a symlinked entry's TARGET could be outside the root, so we
      // skip it entirely (the tree never surfaces a link, and the symlink layer would reject
      // a later read/list through it anyway). `isSymbolicLink()` reflects the dirent itself.
      if (ent.isSymbolicLink()) continue
      out.push({ name: ent.name, isDir: ent.isDirectory() })
    }
    return out
  })

  ipcMain.handle('file:stat', async (e, relPath: string): Promise<FileStat> => {
    if (guard(e)) throw new Error('file: foreign sender denied')
    const abs = await resolveRel(relPath)
    const s = await stat(abs)
    return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() }
  })
}
