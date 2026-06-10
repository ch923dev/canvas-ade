/**
 * Autosave: debounce store mutations and write the canvas to disk via IPC. MAIN is the
 * atomic writer (Approach A). Only saves while a project is open; flushes immediately on
 * window blur + beforeunload so at most ~1s of edits is ever at risk.
 */
import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'

type ProjectStatus = 'welcome' | 'loading' | 'open' | 'error'

interface AutosaverOpts {
  save: () => Promise<boolean>
  getStatus: () => ProjectStatus
  delayMs?: number
  /** SAVE-1: called when a save rejects OR resolves false, so a failing disk is visible. */
  onError?: (e: unknown) => void
}

export interface Autosaver {
  schedule: () => void
  /** Flush any pending save NOW; resolves once the underlying save settles. */
  flush: () => Promise<void>
  cancel: () => void
}

/** Pure debounce+gate engine (no React) — unit-tested directly. */
export function createAutosaver(opts: AutosaverOpts): Autosaver {
  const delay = opts.delayMs ?? 1000
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false

  const run = (): Promise<void> => {
    timer = null
    if (!dirty || opts.getStatus() !== 'open') return Promise.resolve()
    dirty = false
    // SAVE-1: surface a failed save (rejection OR a `false` result from main's
    // project:save) instead of floating it silently — otherwise a failing disk loses
    // every edit with zero signal to the user.
    // BUG-008: a failure must also RE-ARM dirty, or the unsaved edits become
    // unrecoverable — every later flush (blur, beforeunload, MAIN's project:flush quit
    // handshake) would hit the `!dirty` gate and write nothing even after the disk
    // recovers. Re-arming alone cannot hot-loop: retries only run via the debounced
    // schedule() or an explicit flush().
    return Promise.resolve(opts.save())
      .then((ok) => {
        if (ok === false) {
          dirty = true
          opts.onError?.(new Error('autosave: project:save returned false'))
        }
      })
      .catch((e) => {
        dirty = true
        opts.onError?.(e)
      })
  }
  return {
    schedule: () => {
      dirty = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void run(), delay)
    },
    flush: () => {
      if (timer) clearTimeout(timer)
      return run()
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
      dirty = false
    }
  }
}

// PERSIST-B: the live autosaver instance, published so out-of-tree code (a project
// switch, which can't reach into the hook's closure) can cancel a pending debounced
// save before tearing down the canvas. A leftover timer armed editing project A would
// otherwise fire AFTER the switch flips status back to 'open' with `currentDir` now B,
// writing B's state to B's dir — data-correct but a redundant post-load write.
let activeAutosaver: Autosaver | null = null
/** Register (or clear, with null) the hook's live autosaver instance. */
export function setActiveAutosaver(a: Autosaver | null): void {
  activeAutosaver = a
}
/** Cancel any pending debounced autosave. Safe no-op when none is registered. */
export function cancelActiveAutosave(): void {
  activeAutosaver?.cancel()
}

/** React hook: arms autosave against the canvas store + window lifecycle. */
export function useAutosave(): void {
  useEffect(() => {
    const saver = createAutosaver({
      // BUG-009: pass the project dir this doc belongs to, so MAIN can reject the write
      // if a project switch raced the save (currentDir would point at the new project).
      save: async () => {
        const s = useCanvasStore.getState()
        return window.api.project.save(s.toObject(), s.project.dir ?? undefined)
      },
      // The `project` slice is added in a later task; read it defensively so the hook
      // compiles + no-ops (status 'welcome' → gate closed) until that slice exists.
      getStatus: () =>
        (useCanvasStore.getState() as { project?: { status?: ProjectStatus } }).project?.status ??
        'welcome',
      // SAVE-1: a swallowed autosave failure means silent data loss. Log it so a
      // failing disk is at least visible in diagnostics (a non-blocking toast can hang
      // off this hook later without re-plumbing the autosaver).
      // eslint-disable-next-line no-console
      onError: (e) => console.error('autosave failed', e)
    })

    // Save when boards, connectors, or camera change (skip pure selection/tool churn).
    // connectors (M2) ride their own ref — a connector add/remove leaves `boards`
    // untouched, so it must be watched explicitly or a new cable wouldn't autosave.
    let prevBoards = useCanvasStore.getState().boards
    let prevConnectors = useCanvasStore.getState().connectors
    let prevViewport = useCanvasStore.getState().viewport
    const unsub = useCanvasStore.subscribe((s) => {
      if (
        s.boards !== prevBoards ||
        s.connectors !== prevConnectors ||
        s.viewport !== prevViewport
      ) {
        prevBoards = s.boards
        prevConnectors = s.connectors
        prevViewport = s.viewport
        saver.schedule()
      }
    })

    const onBlur = (): void => void saver.flush()
    const onUnload = (): void => void saver.flush()
    window.addEventListener('blur', onBlur)
    window.addEventListener('beforeunload', onUnload)

    // BUG-M2: main hard-exits with app.exit(0) on quit, which bypasses `beforeunload`,
    // so the flush above would never run and the last ~1s of edits is lost. Main posts
    // `project:flush` right before exit and awaits our reply — flush (awaiting the save)
    // so the on-disk canvas.json is current before the process dies.
    const offFlush = window.api.project.onFlush(() => saver.flush())

    // PERSIST-B: publish this instance so a project switch can cancel its pending timer.
    setActiveAutosaver(saver)

    return () => {
      void saver.flush()
      saver.cancel()
      setActiveAutosaver(null)
      unsub()
      offFlush()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])
}
