/**
 * Autosave: debounce store mutations and write the canvas to disk via IPC. MAIN is the
 * atomic writer (Approach A). Only saves while a project is open; flushes immediately on
 * window blur + beforeunload so at most ~1s of edits is ever at risk.
 */
import { useEffect } from 'react'
import { useCanvasStore, type CanvasState } from './canvasStore'
import { useSaveStatusStore } from './saveStatusStore'
import { flushAllTerminalSnapshots } from './terminalSnapshotRegistry'
import { saveErrorMessage } from '../lib/saveError'

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

/**
 * The PERSISTED state slices whose change must arm autosave. This list MUST stay in
 * lock-step with what `toObject()` serializes into canvas.json — boards, connectors,
 * viewport, groups (v6) and background (v9). A field that round-trips to disk but is
 * MISSING here is silently lost on a settings-only edit: a backdrop pick / dim drag
 * (v9) or a group create/rename (v6) with no board or camera change before the next
 * flush never armed `dirty`, so the blur/quit flush no-op'd and the change vanished on
 * reopen. Selection / tool / hover / in-flight-draft churn is intentionally NOT here
 * (that ephemeral state must never reach canvas.json). The drift-guard unit test pins
 * this set to toObject's output so the next persisted field cannot re-open the gap.
 */
// M1: the persisted set is split by WRITE COST. A DOC edit (boards/connectors/groups) rewrites the
// whole canvas.json (+ its .bak rotation); a SESSION edit (camera viewport / backdrop) writes only
// the tiny `.canvas/session.json` sidecar. The doc save still writes viewport/background INLINE
// (toObject includes them), so the inline copy stays a forward-compatible fallback for old readers.
export const DOC_KEYS = ['boards', 'connectors', 'groups'] as const
export const SESSION_KEYS = ['viewport', 'background'] as const
/** The full persisted set — the drift-guard test pins THIS (its union) to toObject's output, so a
 *  new persisted field must land in one subset or the other, never neither. */
export const SAVED_KEYS = [...DOC_KEYS, ...SESSION_KEYS] as const

/** True when a slice in `keys` changed by reference (immutable store updates ⇒ a changed slice
 *  always carries a NEW ref — a cheap identity check, no deep compare). */
function someChanged(
  keys: readonly (typeof SAVED_KEYS)[number][],
  prev: Pick<CanvasState, (typeof SAVED_KEYS)[number]>,
  next: Pick<CanvasState, (typeof SAVED_KEYS)[number]>
): boolean {
  return keys.some((k) => prev[k] !== next[k])
}

/** A board-tree edit → the full canvas.json save. */
export function hasDocChange(
  prev: Pick<CanvasState, (typeof SAVED_KEYS)[number]>,
  next: Pick<CanvasState, (typeof SAVED_KEYS)[number]>
): boolean {
  return someChanged(DOC_KEYS, prev, next)
}

/** A camera/backdrop-only edit → the cheap session-sidecar save. */
export function hasSessionChange(
  prev: Pick<CanvasState, (typeof SAVED_KEYS)[number]>,
  next: Pick<CanvasState, (typeof SAVED_KEYS)[number]>
): boolean {
  return someChanged(SESSION_KEYS, prev, next)
}

/** True when ANY persisted slice changed (kept for external callers). */
export function hasSavableChange(
  prev: Pick<CanvasState, (typeof SAVED_KEYS)[number]>,
  next: Pick<CanvasState, (typeof SAVED_KEYS)[number]>
): boolean {
  return someChanged(SAVED_KEYS, prev, next)
}

/** Pure debounce+gate engine (no React) — unit-tested directly. */
export function createAutosaver(opts: AutosaverOpts): Autosaver {
  const delay = opts.delayMs ?? 1000
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  // PERSIST-02: single-flight latch. The pending `project:save` promise (with its
  // trailing-coalesce chain) while a save is in flight; null when idle. A concurrent
  // run() (the debounce timer re-firing, or a blur/quit flush) JOINS this promise instead
  // of starting a second `project:save` — two writers racing the same canvas.json was the
  // narrow overlapping-save window the audit flagged.
  let inFlight: Promise<void> | null = null

  // Perform one save. On success, if an edit landed DURING the save (a schedule() re-armed
  // `dirty`), do one more pass so a draining flush()/quit reaches a clean disk — the
  // trailing-coalesce. A FAILURE only re-arms `dirty` and STOPS (no recurse), so a
  // persistently failing disk can't hot-loop; the re-armed edit is retried by the next
  // debounced schedule() or explicit flush() once the disk recovers (the BUG-008 contract).
  const cycle = (): Promise<void> => {
    if (!dirty || opts.getStatus() !== 'open') return Promise.resolve()
    dirty = false
    // SAVE-1: surface a failed save (rejection OR a `false` result from main's
    // project:save) instead of floating it silently — otherwise a failing disk loses
    // every edit with zero signal to the user.
    return Promise.resolve(opts.save())
      .then((ok) => {
        if (ok === false) {
          // BUG-008: re-arm so a later flush retries; do NOT recurse (no hot-loop).
          dirty = true
          opts.onError?.(new Error('autosave: project:save returned false'))
          return undefined
        }
        // Trailing-coalesce: drain an edit that arrived while this save was in flight.
        return dirty && opts.getStatus() === 'open' ? cycle() : undefined
      })
      .catch((e) => {
        dirty = true
        opts.onError?.(e)
      })
  }

  const run = (): Promise<void> => {
    timer = null
    // PERSIST-02: join the in-flight save rather than overlapping a second writer. The
    // pending `dirty` edits ride that save's trailing-coalesce (or the next debounce).
    if (inFlight) return inFlight
    if (!dirty || opts.getStatus() !== 'open') return Promise.resolve()
    inFlight = cycle().finally(() => {
      inFlight = null
    })
    return inFlight
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
    // Shared save gate (both savers): only save while a dir-bearing project is 'open'. The `project`
    // slice is read defensively (compiles/no-ops as 'welcome' if absent); a dir-less "open" (the e2e
    // boot — production always opens with a dir) has nowhere to save, so 'welcome' keeps the gate
    // closed instead of attempting a write MAIN fails (which once raised a phantom sticky toast).
    const getStatus = (): ProjectStatus => {
      const p = (
        useCanvasStore.getState() as { project?: { status?: ProjectStatus; dir?: string | null } }
      ).project
      if (p?.dir == null) return 'welcome'
      return p.status ?? 'welcome'
    }
    // The AUTHORITATIVE full-doc saver: rewrites the whole canvas.json (incl inline viewport/
    // background — the forward-compat copy). BUG-009: pass the project dir so MAIN rejects a write
    // that raced a switch. PERSIST-03: drive the save lifecycle. SAVE-1: a failure routes through
    // onError → the sticky save-failure toast so a failing disk is never silent.
    // C3: carry the write errno from a failed save to onError WITHOUT changing the engine's
    // boolean `save` contract. Reset at the start of each attempt so a later throw (which has no
    // code) can't reuse a stale one.
    let lastFailCode: string | undefined
    const saver = createAutosaver({
      save: async () => {
        const s = useCanvasStore.getState()
        const status = useSaveStatusStore.getState()
        status.markSaving()
        lastFailCode = undefined
        const res = await window.api.project.save(s.toObject(), s.project.dir ?? undefined)
        if (res.ok) {
          status.markSaved()
          return true
        }
        // C3: stash the errno; the engine calls onError below (for a `false` result) which maps it.
        lastFailCode = res.code
        return false
      },
      getStatus,
      onError: (e) => {
        // eslint-disable-next-line no-console
        console.error('autosave failed', e)
        // C3: map the write errno (stashed in `save` above) to accurate copy — only a real
        // ENOSPC says "disk full"; a lock/permission/read-only failure no longer masquerades
        // as one. A throw (no code) → neutral generic. The console line keeps the raw detail.
        useSaveStatusStore
          .getState()
          .setSaveFailure(saveErrorMessage(lastFailCode, 'Auto-save failed'))
      }
    })
    // M1: the SESSION-sidecar saver — a camera pan / backdrop change writes ONLY .canvas/session.json
    // (a few hundred bytes) instead of the whole board tree + its .bak rotation. Advisory: a failed
    // sidecar write is non-fatal (the inline canvas.json copy is the fallback), so it does NOT raise
    // the sticky save-failure toast the doc saver does — a console line only.
    const sessionSaver = createAutosaver({
      save: () => {
        const s = useCanvasStore.getState()
        return window.api.project.saveSession(
          { viewport: s.viewport, background: s.background },
          s.project.dir ?? undefined
        )
      },
      getStatus,
      onError: (e) => {
        // eslint-disable-next-line no-console
        console.error('session autosave failed (advisory — inline canvas.json is the fallback)', e)
      }
    })

    // Arm autosave when any PERSISTED slice changes (skip pure selection/tool/hover
    // churn). Each slice rides its own ref — connectors (M2), groups (v6) and the
    // backdrop (v9) all leave `boards` untouched, so every persisted field must be
    // watched via SAVED_KEYS (kept in lock-step with toObject) or a settings-only edit
    // silently fails to schedule a save. zustand hands the previous state as the 2nd
    // listener arg, so there is no manual prev-tracking to drift out of sync.
    const unsub = useCanvasStore.subscribe((s, prev) => {
      // M1: route each change to the cheaper write — a board-tree edit rewrites canvas.json; a
      // camera/backdrop-only edit writes just the sidecar. Both can fire if a single update touched
      // both (e.g. a board move that also nudged the camera).
      if (hasDocChange(prev, s)) saver.schedule()
      if (hasSessionChange(prev, s)) sessionSaver.schedule()
    })

    const onBlur = (): void => {
      void saver.flush()
      void sessionSaver.flush()
    }
    // S3: on window close AND the main-driven before-quit flush, persist every terminal's scrollback
    // alongside the canvas. Folded into THESE awaited handlers (not a second `project:flush`
    // subscriber) on purpose: main resolves the quit on the FIRST reply, so a separate subscriber's
    // snapshot write could be cut off by `app.exit(0)`. Blur is deliberately canvas-only —
    // serializing every terminal's full buffer on each focus loss is too heavy, and close/quit/switch
    // (disposeLiveResources) already cover the durable moments.
    //
    // BUG-040: both moments below pass `sync: true` — `flushRenderer`'s before-quit round-trip
    // no-ops once the window is already destroyed, so a window-close-driven quit relies on THIS
    // beforeunload write actually landing before MAIN moves on; only a synchronous (blocking) MAIN
    // write gives that guarantee. Every other caller (disposeLiveResources on project switch) keeps
    // the default async writer so a large scrollback buffer never stalls MAIN during normal use.
    const onUnload = (): void => {
      void saver.flush()
      void sessionSaver.flush() // M1: the camera/backdrop sidecar flushes on the same durable moments
      // R2 dir-pin: quit-time flushes carry the project they belong to (background sessions
      // make a cross-project late-write race real; MAIN rejects a mismatched dir).
      void flushAllTerminalSnapshots({
        sync: true,
        expectedDir: useCanvasStore.getState().project.dir ?? undefined
      })
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('beforeunload', onUnload)

    // BUG-M2: main hard-exits with app.exit(0) on quit, which bypasses `beforeunload`,
    // so the flush above would never run and the last ~1s of edits is lost. Main posts
    // `project:flush` right before exit and awaits our reply — flush (awaiting the save +
    // the terminal snapshots) so the on-disk canvas.json + sidecars are current before the
    // process dies.
    const offFlush = window.api.project.onFlush(() =>
      Promise.all([
        saver.flush(),
        sessionSaver.flush(), // M1: the sidecar is current before app.exit(0), like canvas.json
        flushAllTerminalSnapshots({
          sync: true,
          expectedDir: useCanvasStore.getState().project.dir ?? undefined
        })
      ]).then(() => undefined)
    )

    // PERSIST-B: publish a combined disposer so a project switch cancels BOTH pending debounced
    // timers (a leftover session timer would otherwise fire after the switch and write the new
    // project's camera into the wrong dir — MAIN's dir-pin rejects it, but cancel avoids the churn).
    setActiveAutosaver({
      schedule: () => saver.schedule(),
      flush: () => Promise.all([saver.flush(), sessionSaver.flush()]).then(() => undefined),
      cancel: () => {
        saver.cancel()
        sessionSaver.cancel()
      }
    })

    return () => {
      void saver.flush()
      void sessionSaver.flush()
      saver.cancel()
      sessionSaver.cancel()
      setActiveAutosaver(null)
      unsub()
      offFlush()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])
}
