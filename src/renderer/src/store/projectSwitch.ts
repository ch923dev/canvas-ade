/**
 * The project-switch pipeline (Background Project Sessions, Phase 2) — extracted from
 * ProjectSwitcher so the SAME flush → handover → load sequence is drivable by the component
 * (which wraps it in its spinner UI) and by the e2e harness (`switchProjectFromDisk`), instead
 * of living inside a component closure.
 *
 * Pipeline (order is load-bearing): acquire the cross-surface switch lock → cancel the pending
 * autosave → final flush-save pinned to the outgoing dir (abort on failure — SAVE-1 silent-loss
 * class) → hand over live resources (BACKGROUND keeps PTYs running + previews frozen; DISPOSE is
 * the legacy kill-all) → `setProjectLoading()` unmount → load + apply the new project.
 * Backgrounding must happen BEFORE the unmount: park is what turns each board unmount's
 * `pty:kill` / `preview:osrClose` into a no-op.
 */
import { useCanvasStore, acquireProjectSwitchLock, releaseProjectSwitchLock } from './canvasStore'
import { cancelActiveAutosave } from './useAutosave'
import { useSaveStatusStore } from './saveStatusStore'
import { backgroundLiveResources, disposeLiveResources } from './disposeLiveResources'

// The EXPANSE_BG_SESSIONS dev flag (Phase 2 ships dark), fetched once per renderer lifetime.
// Lazy-resolved so a partial window.api mock (integration tests stub only what they use) or a
// torn-down bridge resolves to `false` (the legacy dispose path) instead of throwing.
let bgFlag: Promise<boolean> | null = null
export function isBgSessionsEnabled(): Promise<boolean> {
  bgFlag ??= Promise.resolve()
    .then(() => window.api.project.bgSessionsEnabled())
    .then((v) => v === true)
    .catch(() => false)
  return bgFlag
}

export type SwitchOutcome = 'switched' | 'locked' | 'save-failed'

export async function performProjectSwitch(
  load: () => Promise<unknown>,
  opts?: {
    /** Keep the outgoing project running in the background. Default = the dev flag. */
    keepBackground?: boolean
  }
): Promise<SwitchOutcome> {
  // BUG-009: one switch pipeline at a time, ACROSS surfaces (shared with WelcomeScreen's
  // open/create) — without the shared lock a second click interleaves two open pipelines and
  // the renderer can settle on project B while MAIN's currentDir points at C, after which
  // autosave writes B's canvas into C's canvas.json.
  if (!acquireProjectSwitchLock()) return 'locked'
  try {
    const outgoingDir = useCanvasStore.getState().project.dir
    // PERSIST-B: kill any pending debounced autosave armed editing the outgoing project.
    // The explicit flush below is the authoritative final write; a leftover timer would
    // otherwise fire after load flips status back to 'open' (currentDir now the NEW dir)
    // and write the new project's state redundantly.
    cancelActiveAutosave()
    // 1. Flush the current project to disk before handing it over. project:save returns
    //    false on a write failure; the debounced autosaver is gated off once we flip to
    //    'loading', so a swallowed false here loses the outgoing project's tail edits with
    //    no signal (PERSIST-A / the SAVE-1 silent-loss class). Surface it and abort the
    //    switch so the outgoing project stays open and editable for a retry.
    const saved = await window.api.project.save(
      useCanvasStore.getState().toObject(),
      outgoingDir ?? undefined
    )
    if (saved === false) {
      // eslint-disable-next-line no-console
      console.error('project switch: final flush failed; aborting switch to avoid data loss')
      // D0-8: the abort must be VISIBLE — raise the save-failure chip, not console-only.
      useSaveStatusStore
        .getState()
        .setSaveFailure('Project could not be saved — switch cancelled to avoid losing edits')
      return 'save-failed'
    }
    // D0-8 symmetry: the flush SUCCEEDED — mark saved (which clears any standing failure)
    // now, or the global store carries the old project's stale message into the new one
    // (it would flash on the next project until its first autosave).
    useSaveStatusStore.getState().markSaved()
    // 2. Hand over live resources, then suppress autosave + unmount.
    const keep = opts?.keepBackground ?? ((await isBgSessionsEnabled()) && outgoingDir !== null)
    if (keep && outgoingDir !== null) {
      // BEFORE the unmount (see module doc) — MAIN parks PTYs + freezes previews while the
      // boards are still mounted, so their unmount cleanups no-op instead of killing.
      await backgroundLiveResources(outgoingDir)
      useCanvasStore.getState().setProjectLoading()
    } else {
      useCanvasStore.getState().setProjectLoading()
      await disposeLiveResources(outgoingDir ?? undefined)
    }
    // 3. Load the new project. applyOpenResult is async (it may retry canvas.json.bak on a
    //    deep-validation failure) — await so the switch completes (or settles error) here.
    //    BUG-006: load() can REJECT — createNew's project:create → MAIN createProject can
    //    throw on a disk error (mkdirSync / writeFileAtomic; project:open's readProject
    //    absorbs its errors, but create does not). Callers fire-and-forget the switch, so an
    //    unhandled rejection here would leave status stuck at 'loading' with all native
    //    resources already handed over: unrecoverable. Route any throw through the existing
    //    error path so the app settles to 'error' (carrying the message) and stays recoverable.
    const applyOpenResult = useCanvasStore.getState().applyOpenResult
    try {
      await applyOpenResult((await load()) as Parameters<typeof applyOpenResult>[0])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed to load project'
      await applyOpenResult({ ok: false, error: msg })
    }
    return 'switched'
  } finally {
    releaseProjectSwitchLock()
  }
}
