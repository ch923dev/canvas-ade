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
}

export interface Autosaver {
  schedule: () => void
  flush: () => void
  cancel: () => void
}

/** Pure debounce+gate engine (no React) — unit-tested directly. */
export function createAutosaver(opts: AutosaverOpts): Autosaver {
  const delay = opts.delayMs ?? 1000
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false

  const run = (): void => {
    timer = null
    if (!dirty || opts.getStatus() !== 'open') return
    dirty = false
    void opts.save()
  }
  return {
    schedule: () => {
      dirty = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, delay)
    },
    flush: () => {
      if (timer) clearTimeout(timer)
      run()
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
        'welcome'
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

    const onBlur = (): void => saver.flush()
    const onUnload = (): void => saver.flush()
    window.addEventListener('blur', onBlur)
    window.addEventListener('beforeunload', onUnload)

    return () => {
      saver.flush()
      saver.cancel()
      unsub()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])
}
