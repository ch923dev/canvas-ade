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
    return Promise.resolve(opts.save())
      .then((ok) => {
        if (ok === false) opts.onError?.(new Error('autosave: project:save returned false'))
      })
      .catch((e) => opts.onError?.(e))
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

/** React hook: arms autosave against the canvas store + window lifecycle. */
export function useAutosave(): void {
  useEffect(() => {
    const saver = createAutosaver({
      save: async () => window.api.project.save(useCanvasStore.getState().toObject()),
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

    // Save when boards or camera change (skip pure selection/tool churn).
    let prevBoards = useCanvasStore.getState().boards
    let prevViewport = useCanvasStore.getState().viewport
    const unsub = useCanvasStore.subscribe((s) => {
      if (s.boards !== prevBoards || s.viewport !== prevViewport) {
        prevBoards = s.boards
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

    return () => {
      void saver.flush()
      saver.cancel()
      unsub()
      offFlush()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])
}
