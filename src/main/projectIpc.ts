/**
 * Project IPC: folder picker + canvas.json open/create/save + recent-projects.
 * MAIN owns the "current dir"; the renderer drives saves (Approach A). All handlers
 * reject foreign senders (BUG-033 defense-in-depth), matching pty/preview.
 */
import path from 'node:path'
import { dialog } from 'electron'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import writeFileAtomic from 'write-file-atomic'
import {
  readProject,
  readBak,
  writeProject,
  createProject,
  migrateProjectLayout,
  getCurrentDir,
  setCurrentDir,
  projectName,
  writeAsset,
  readAsset,
  collectAssetIds,
  gcAssets,
  type ProjectResult
} from './projectStore'
import { scaffoldProjectMemory, createCanvasMemory, safeBoardId } from './canvasMemory'
import {
  listRecents,
  touchRecent,
  removeRecent,
  clearRecents,
  type RecentProject
} from './recentProjects'
import { createMemoryEngine, type MemoryEngine, type SummarizeIntent } from './memoryEngine'

/**
 * True when a renderer-supplied project dir must be REJECTED before any fs touch
 * (M-6): a non-empty absolute path with no `..` traversal segment is required.
 * Real OS-dialog results are already absolute + normalized, so legit flows pass.
 * Pure + exported for unit tests.
 */
export function isUnsafeProjectDir(dir: string): boolean {
  if (typeof dir !== 'string' || dir.length === 0) return true
  // Accept an absolute path in EITHER flavor: `path.isAbsolute` is host-specific
  // (POSIX rejects `C:\...`, Win32 accepts `/...`), so the bare check made the M-6
  // unit test pass on Windows but fail on the Linux CI runner. The `..`-traversal
  // guard below is separator-agnostic, so honoring both forms loses no safety.
  if (!path.win32.isAbsolute(dir) && !path.posix.isAbsolute(dir)) return true
  // `path.normalize` collapses `..`, so a traversal that fully resolves
  // (e.g. `C:\Users\x\..\..\evil` → `C:\evil`) would slip past a check on the
  // normalized form. Reject any `..` segment in the ORIGINAL input instead —
  // legit OS-dialog paths never contain one.
  return path.normalize(dir).split(/[/\\]/).includes('..') || dir.split(/[/\\]/).includes('..')
}

/**
 * Separator-agnostic, case-insensitive segment list for a (traversal-free) absolute path.
 * Host-neutral on purpose: the unit suite drives BOTH `C:\...` and `/...` shapes on a single
 * OS (see the M-6 note above), so we must not lean on the host's `path.sep` / drive casing.
 * Callers MUST gate on `isUnsafeProjectDir` first — this assumes no `..` segment.
 */
function pathSegments(p: string): string[] {
  return path
    .normalize(p)
    .replace(/[/\\]+$/, '') // strip trailing separator(s) so `<root>/` === `<root>`
    .split(/[/\\]/)
    .map((s) => s.toLowerCase()) // Windows paths are case-insensitive; harmless on POSIX
    .filter((s) => s.length > 0)
}

/**
 * BUG-006 (defense-in-depth): TRUE when `dir` is equal-to-or-under `root` (segment-wise).
 * Completes the create/open guard's stated goal — `isUnsafeProjectDir` only proves the path
 * is a clean absolute string, not that it points at a USER-APPROVED location. A compromised
 * renderer could otherwise mkdir+write a fresh canvas.json at any absolute path. Approved
 * roots are derived in-session from the OS folder-dialog result and the recents list.
 */
export function isUnderApprovedRoot(dir: string, root: string): boolean {
  if (typeof dir !== 'string' || typeof root !== 'string' || root.length === 0) return false
  const r = pathSegments(root)
  const d = pathSegments(dir)
  if (r.length === 0 || d.length < r.length) return false
  return r.every((seg, i) => seg === d[i])
}

/**
 * Default T-M2 intent sink: log only. T-M3 replaces this with the Tier-2 summarize loop
 * (intent → runSummarize → canvasMemory.writeBoard). The intent is passive — it is an id,
 * never an action.
 */
function logSummarizeIntent(intent: SummarizeIntent): void {
  console.log(`[memoryEngine] summarize intent for board ${intent.boardId}`)
}

/**
 * BUG-027: upper bound on the ids[] memory:readBoards will service in one call. Each id costs a
 * synchronous existsSync on the IPC thread, so an unbounded array (a compromised renderer could
 * pass thousands) would block other handlers. The legitimate caller passes the live board ids,
 * naturally bounded to the real board count, so 256 is a generous practical ceiling.
 */
const MAX_READ_BOARD_IDS = 256

/**
 * BUG-018 #2: after baselining at project open, re-arm a summarize for any board whose cached
 * `board-<id>.md` was deleted externally (user/GC) between sessions. A content-identical re-open
 * never emits via observe() (the baseline matches), so without this the memory dir would stay
 * empty until a real content edit. Best-effort + pure-read: a malformed doc or fs error never
 * aborts the open. Reuses a single CanvasMemory instance (no per-id construction).
 */
function rehydrateMissingSummaries(dir: string, doc: unknown, engine: MemoryEngine): void {
  try {
    const boards = (doc as { boards?: unknown })?.boards
    if (!Array.isArray(boards)) return
    const mem = createCanvasMemory(dir)
    const missing: string[] = []
    for (const board of boards) {
      const id = (board as { id?: unknown })?.id
      // readBoard guards safeBoardId + returns undefined when the file is absent.
      if (typeof id === 'string' && id.length > 0 && mem.readBoard(id) === undefined) {
        missing.push(id)
      }
    }
    if (missing.length > 0) engine.rehydrate(missing)
  } catch (err) {
    console.warn('[memoryEngine] rehydrate of missing summaries failed (non-fatal)', err)
  }
}

/** Extract the string board ids from a (possibly malformed) canvas doc. Best-effort, pure. */
function boardIdsOf(doc: unknown): Set<string> {
  const ids = new Set<string>()
  const boards = (doc as { boards?: unknown })?.boards
  if (!Array.isArray(boards)) return ids
  for (const board of boards) {
    const id = (board as { id?: unknown })?.id
    if (typeof id === 'string' && id.length > 0) ids.add(id)
  }
  return ids
}

export function registerProjectHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string,
  now: () => number = () => Date.now(),
  memoryEngine: MemoryEngine = createMemoryEngine({ onIntent: logSummarizeIntent }),
  // T-F4: the manual-refresh sink. index.ts wires this to summaryLoop.onIntent so a user ⟳ runs
  // the SAME budgeted/passive summarize the detector does (no new egress). Default = no-op.
  onRefresh: (boardId: string) => Promise<void> = async () => {},
  // Terminal recap (Task 10): fired with the project dir whenever a project is opened/reopened
  // (project:open + project:current). index.ts wires this to re-ensure the recap SessionStart hook
  // for an already-consented project. Default = no-op. Best-effort (never aborts the open).
  onProjectOpen: (dir: string) => void = () => {},
  // Terminal recap: fired with the set of board ids in the CURRENT canvas doc on every
  // save/open/switch. index.ts wires this to recapWatcher.retain() so a deleted terminal — or the
  // boards of a project we switched away from — has its transcript watcher torn down instead of
  // leaking until quit. Default = no-op. Best-effort (never aborts the save/open).
  onBoardsObserved: (liveBoardIds: Set<string>) => void = () => {}
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  // BUG-006: the set of locations the USER has approved this session. A create/open target must
  // be equal-to-or-under one of these — `isUnsafeProjectDir` only proves the path is a clean
  // absolute string, not that the user picked it. Seeded by the OS folder-dialog result below;
  // the recents list (already user-approved) is consulted live in the gate so prior sessions'
  // projects stay openable. The current open dir is auto-approved too (an in-session reopen).
  const approvedRoots = new Set<string>()

  // TRUE when `dir` is approved to be created/opened: equal-to-or-under a dialog-picked root,
  // the currently-open project, or any recents entry. Fails CLOSED — an unknown path is denied.
  // listRecents reads the persisted MRU (the durable record of past user approvals).
  const isApprovedTarget = async (dir: string): Promise<boolean> => {
    if (approvedRoots.has(dir)) return true
    const current = getCurrentDir()
    if (current && isUnderApprovedRoot(dir, current)) return true
    for (const root of approvedRoots) {
      if (isUnderApprovedRoot(dir, root)) return true
    }
    let recents: RecentProject[]
    try {
      const listed = await listRecents(userDataDir)
      recents = Array.isArray(listed) ? listed : []
    } catch {
      recents = []
    }
    return recents.some((r) => isUnderApprovedRoot(dir, r.path))
  }

  // BUG-027: memory:readBoards built a fresh CanvasMemory on EVERY IPC call. Memoize one per
  // project dir and reuse it across calls (re-create only when the open project changes), so a
  // burst of reads doesn't re-run the path scaffolding each time.
  let cachedMemory: { dir: string; mem: ReturnType<typeof createCanvasMemory> } | null = null
  const memoryFor = (dir: string): ReturnType<typeof createCanvasMemory> => {
    if (!cachedMemory || cachedMemory.dir !== dir) {
      cachedMemory = { dir, mem: createCanvasMemory(dir) }
    }
    return cachedMemory.mem
  }

  ipcMain.handle('dialog:openFolder', async (e): Promise<string | null> => {
    if (guard(e)) return null
    const win = getWin()
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    // BUG-006: the user just picked this path in the OS dialog — approve it (and anything the
    // renderer then creates/opens under it) so the subsequent project:create/open is allowed.
    const picked = res.filePaths[0]
    approvedRoots.add(picked)
    return picked
  })

  const remember = async (r: ProjectResult): Promise<void> => {
    if (r.ok) {
      setCurrentDir(r.dir)
      // BUG-026: touchRecent writes to the userData dir. An EPERM/ENOSPC there must NOT
      // propagate out of the IPC handler — a recents-write failure is non-fatal. The project
      // opened successfully; the renderer must see ok:true even if the MRU list can't update.
      try {
        await touchRecent(userDataDir, r.dir, r.name, now())
      } catch (err) {
        console.warn('[recentProjects] touchRecent failed (non-fatal, MRU list not updated)', err)
      }
    }
  }

  ipcMain.handle('project:open', async (e, dir: string): Promise<ProjectResult> => {
    if (guard(e)) return { ok: false, error: 'forbidden' }
    if (isUnsafeProjectDir(dir)) return { ok: false, error: 'invalid path' }
    // BUG-006: constrain the target to a user-approved location (dialog pick / recents /
    // current). Fail closed — a compromised renderer must not open an arbitrary path.
    if (!(await isApprovedTarget(dir))) return { ok: false, error: 'invalid path' }
    // Once opened from an approved location, remember the dir so an in-session re-open of the
    // same project (e.g. after a project:current cycle) stays approved without a fresh dialog.
    approvedRoots.add(dir)
    // ADR 0009: relocate a legacy-root project (canvas.json/.bak/assets/) into .canvas/ before
    // reading. Best-effort + idempotent; the readers fall back to the legacy root if it no-ops.
    migrateProjectLayout(dir)
    const r = readProject(dir)
    await remember(r)
    if (r.ok) {
      // BUG-016: collect asset ids from BOTH the primary AND the backup before sweeping.
      // If the primary is envelope-valid but deep-corrupt, the renderer triggers T5 recovery
      // (project:reopenFromBak). Without this union, assets referenced only by the backup
      // are quarantined here before the deep-validation failure is detected — leaving the
      // T5 recovery path with broken/missing images.
      // The union is best-effort: a missing/corrupt backup simply contributes an empty set.
      const primaryIds = collectAssetIds(r.doc)
      const bakResult = readBak(r.dir)
      const bakIds = bakResult.ok ? collectAssetIds(bakResult.doc) : new Set<string>()
      const allReferencedIds = new Set<string>([...primaryIds, ...bakIds])
      gcAssets(r.dir, allReferencedIds)
      scaffoldProjectMemory(r.dir) // T-M1: ensure .canvas/ on open (best-effort, never aborts open)
      // Terminal recap (Task 10): re-ensure the recap SessionStart hook for an already-consented
      // project. Best-effort — a hook-install failure must NEVER abort the open.
      try {
        onProjectOpen(r.dir)
      } catch (err) {
        console.warn('[recap] onProjectOpen failed on project:open (non-fatal)', err)
      }
      try {
        memoryEngine.reset() // T-M2: a project switch drops stale fingerprints/timers
        // Baseline from the LOADED doc so the FIRST meaningful post-open edit emits an intent.
        // Without this, the first project:save becomes the baseline (no emit) and the first
        // edit after every open/switch is silently swallowed until a second save.
        memoryEngine.observe(r.doc)
        // recap: a project switch must drop the prior project's transcript watchers.
        onBoardsObserved(boardIdsOf(r.doc))
        // BUG-018 #2: re-summarize boards whose cached summary file is missing on disk.
        rehydrateMissingSummaries(r.dir, r.doc, memoryEngine)
      } catch (err) {
        console.warn('[memoryEngine] reset/observe on open failed (non-fatal)', err)
      }
    }
    return r
  })

  // T5: renderer-reported deep-validation recovery. After `fromObject` throws on a
  // primary that MAIN passed (envelope-valid but deep-corrupt), the renderer asks for the
  // .bak so it can retry the parse against the last good snapshot. Pure read — NO gcAssets,
  // NO setCurrentDir/touchRecent (the open project is unchanged; this is a recovery probe).
  ipcMain.handle('project:reopenFromBak', (e, dir: string): ProjectResult => {
    if (guard(e)) return { ok: false, error: 'forbidden' }
    if (isUnsafeProjectDir(dir)) return { ok: false, error: 'invalid path' }
    return readBak(dir)
  })

  ipcMain.handle(
    'project:create',
    async (
      e,
      args: {
        dir: string
        name: string
        opts: { gitInit?: boolean }
      }
    ): Promise<ProjectResult> => {
      if (guard(e)) return { ok: false, error: 'forbidden' }
      if (isUnsafeProjectDir(args.dir)) return { ok: false, error: 'invalid path' }
      // BUG-006: a fresh canvas.json may only be written under a user-approved location
      // (the path just picked in the OS dialog, or a known recents/current root). Fail
      // closed so a compromised renderer can't mkdir+write at an arbitrary absolute path.
      if (!(await isApprovedTarget(args.dir))) return { ok: false, error: 'invalid path' }
      const r = await createProject(args.dir, args.name, args.opts ?? {})
      await remember(r)
      return r
    }
  )

  ipcMain.handle(
    'project:save',
    async (e, doc: unknown, expectedDir?: unknown): Promise<boolean> => {
      if (guard(e)) return false
      const dir = getCurrentDir()
      if (!dir) return false
      // BUG-009: the doc carries no dir association, so a save raced against a project
      // switch would silently write project B's canvas into project C's canvas.json
      // (currentDir is set synchronously at each open's start). Callers that know their
      // project dir (the autosaver) pass it; a mismatch means the doc belongs to a project
      // that is no longer current — reject instead of cross-writing. Optional so existing
      // call sites without the arg keep working.
      if (typeof expectedDir === 'string' && expectedDir !== dir) {
        console.warn('[project:save] rejected: doc is for', expectedDir, 'but current dir is', dir)
        return false
      }
      // SAVE-1: a write failure (disk full, permission denied, envelope-invalid doc)
      // must report failure to the renderer, not reject opaquely. The renderer's
      // autosaver surfaces a `false`/rejection via its onError hook so a failing disk
      // is visible instead of silently swallowed.
      try {
        await writeProject(dir, doc)
        try {
          memoryEngine.observe(doc) // T-M2: detect meaningful change (best-effort; never fails a save)
          onBoardsObserved(boardIdsOf(doc)) // recap: prune watchers for boards deleted this save
        } catch (err) {
          console.warn('[memoryEngine] observe failed (non-fatal)', err)
        }
        return true
      } catch (err) {
        console.error('project:save failed', err)
        return false
      }
    }
  )

  ipcMain.handle('project:recents', async (e): Promise<RecentProject[]> => {
    if (guard(e)) return []
    return listRecents(userDataDir)
  })

  // Remove one entry / wipe the recents list. LIST-ONLY mutations — the project folder
  // on disk is never touched. Both return the fresh (display-pruned) list so the renderer
  // can re-render without a second round-trip. A userData write failure is non-fatal
  // (same policy as touchRecent, BUG-026): log + return the current list.
  ipcMain.handle('project:removeRecent', async (e, dir: string): Promise<RecentProject[]> => {
    if (guard(e)) return []
    if (typeof dir === 'string') {
      try {
        await removeRecent(userDataDir, dir)
      } catch (err) {
        console.warn('[recentProjects] removeRecent failed (non-fatal)', err)
      }
    }
    return listRecents(userDataDir)
  })

  ipcMain.handle('project:clearRecents', async (e): Promise<RecentProject[]> => {
    if (guard(e)) return []
    try {
      await clearRecents(userDataDir)
    } catch (err) {
      console.warn('[recentProjects] clearRecents failed (non-fatal)', err)
    }
    return listRecents(userDataDir)
  })

  ipcMain.handle('project:current', async (e): Promise<ProjectResult | null> => {
    if (guard(e)) return null
    const recents = await listRecents(userDataDir)
    if (recents.length === 0) return null
    const dir = recents[0].path
    // project-current-skips-unsafe-dir-guard: vet the persisted recents path before any fs
    // touch, exactly like project:open — a tampered recents file must not reach readProject.
    if (isUnsafeProjectDir(dir)) {
      console.warn('[project:current] skipping reopen of an unsafe most-recent path:', dir)
      return null
    }
    migrateProjectLayout(dir) // ADR 0009: relocate a legacy-root project into .canvas/ before reading
    const r = readProject(dir)
    if (r.ok) {
      setCurrentDir(r.dir)
      // BUG-026: a write failure on the userData dir must not abort the open or corrupt the
      // renderer's view of the operation — a recents-write failure is non-fatal.
      try {
        await touchRecent(userDataDir, r.dir, projectName(r.dir), now())
      } catch (err) {
        console.warn('[recentProjects] touchRecent failed in project:current (non-fatal)', err)
      }
      // BUG-016: union primary + backup asset ids before sweeping (same fix as project:open).
      const primaryIds = collectAssetIds(r.doc)
      const bakResult = readBak(r.dir)
      const bakIds = bakResult.ok ? collectAssetIds(bakResult.doc) : new Set<string>()
      gcAssets(r.dir, new Set([...primaryIds, ...bakIds]))
      scaffoldProjectMemory(r.dir) // T-M1: ensure .canvas/ on reopen (best-effort, never aborts)
      // Terminal recap (Task 10): re-ensure the recap SessionStart hook for an already-consented
      // project on auto-reopen. Best-effort — never abort the reopen.
      try {
        onProjectOpen(r.dir)
      } catch (err) {
        console.warn('[recap] onProjectOpen failed on project:current (non-fatal)', err)
      }
      try {
        memoryEngine.reset() // T-M2: re-baseline on reopen/switch
        // Baseline from the loaded doc (see project:open) so the first post-reopen edit emits.
        memoryEngine.observe(r.doc)
        // recap: re-baseline the transcript watchers to this project's boards on auto-reopen.
        onBoardsObserved(boardIdsOf(r.doc))
        // BUG-018 #2: re-summarize boards whose cached summary file is missing on disk.
        rehydrateMissingSummaries(r.dir, r.doc, memoryEngine)
      } catch (err) {
        console.warn('[memoryEngine] reset/observe on current failed (non-fatal)', err)
      }
    } else {
      // project-current-readproject-swallow: an auto-reopen read failure was returned as a
      // bare null with no trace. Surface it so a failed reopen of the last project is visible.
      console.warn('[project:current] failed to reopen most-recent project:', dir, '—', r.error)
    }
    return r.ok ? r : null
  })

  ipcMain.handle(
    'asset:write',
    async (
      e,
      args: { bytes: Uint8Array; ext: string }
    ): Promise<{ assetId: string } | { error: string }> => {
      if (guard(e)) return { error: 'forbidden' }
      const dir = getCurrentDir()
      if (!dir) return { error: 'no project open' }
      try {
        return await writeAsset(dir, args.bytes, args.ext)
      } catch (err) {
        return { error: String((err as Error)?.message ?? err) }
      }
    }
  )

  ipcMain.handle('asset:read', (e, assetId: string): Uint8Array | null => {
    if (guard(e)) return null
    const dir = getCurrentDir()
    if (!dir) return null
    return readAsset(dir, assetId)
  })

  // T-M4: batch-read cached Tier-2 prose for the current project's boards. Pure disk read —
  // NO LLM call. Returns the RAW board-<id>.md markdown per present id (the renderer strips
  // the heading); absent ids are omitted. Generated memory is UNTRUSTED PASSIVE context —
  // this only READS + returns it, it never triggers an action. Foreign sender → {}; no
  // current dir → {}. readBoard already guards safeBoardId + never throws (canvasMemory.ts).
  ipcMain.handle('memory:readBoards', (e, ids: string[]): Record<string, string> => {
    if (guard(e)) return {}
    const dir = getCurrentDir()
    if (!dir || !Array.isArray(ids)) return {}
    // BUG-027: bound the request so a compromised renderer can't pin the IPC thread with
    // thousands of synchronous existsSync calls. Real callers pass live board ids (≪ 256).
    if (ids.length > MAX_READ_BOARD_IDS) return {}
    const mem = memoryFor(dir) // BUG-027: reuse one CanvasMemory per dir, not one per call
    const out: Record<string, string> = {}
    for (const id of ids) {
      const md = mem.readBoard(id)
      if (md !== undefined) out[id] = md
    }
    return out
  })

  // T-F4: a USER-driven "refresh this board's summary now" — bypasses the T-M2 debounce by calling
  // the SAME summarize path (onRefresh = summaryLoop.onIntent) the detector uses. Still 🔒 passive +
  // key/budget-gated INSIDE the loop (no new egress rule): with no key / over cap the loop simply
  // no-ops and the prose is unchanged. Foreign sender / non-string id / no open project → {ok:false}.
  // {ok:true} means the refresh ran (the renderer re-reads prose via memory:readBoards either way).
  ipcMain.handle('memory:refresh', async (e, boardId: unknown): Promise<{ ok: boolean }> => {
    if (guard(e)) return { ok: false }
    // BUG-032: enforce safeBoardId (MAX_ID_LEN=64, charset [A-Za-z0-9_-]) at IPC ingress.
    // The original check only rejected non-string / empty — a 1 MB or invalid-charset id
    // passed through to onRefresh, causing a transient allocation + O(n) board scan.
    if (typeof boardId !== 'string' || !safeBoardId(boardId)) return { ok: false }
    if (!getCurrentDir()) return { ok: false }
    await onRefresh(boardId)
    return { ok: true }
  })

  ipcMain.handle(
    'export:save',
    async (
      e,
      args: { bytes: Uint8Array; ext: 'png' | 'svg'; defaultName: string }
    ): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> => {
      if (guard(e)) return { ok: false, error: 'forbidden' }
      const win = getWin()
      const ext = args.ext === 'png' ? 'png' : 'svg'
      const safeName = (args.defaultName || 'whiteboard').replace(/[^\w.-]+/g, '_')
      const opts = {
        defaultPath: `${safeName}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
      }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      try {
        await writeFileAtomic(res.filePath, Buffer.from(args.bytes))
        return { ok: true, path: res.filePath }
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err) }
      }
    }
  )
}
