/**
 * The project-switch pipeline (Background Project Sessions, Phase 2; dialog-mediated since
 * Phase 4) — extracted from ProjectSwitcher so the SAME flush → handover → load sequence is
 * drivable by the component (which wraps it in its spinner UI) and by the e2e harness
 * (`switchProjectFromDisk`), instead of living inside a component closure.
 *
 * Pipeline (order is load-bearing): acquire the cross-surface switch lock → DECIDE the
 * handover (per-project keep policy; 'ask' → the ask-on-switch dialog; Cancel aborts with no
 * side effects) → cancel the pending autosave → final flush-save pinned to the outgoing dir
 * (abort on failure — SAVE-1 silent-loss class) → hand over live resources (BACKGROUND keeps
 * PTYs running + previews frozen; STOP is the scoped active-close — NEVER the dispose-all,
 * which would reap other residents' background sessions) → `setProjectLoading()` unmount →
 * load + apply the new project. Backgrounding must happen BEFORE the unmount: park is what
 * turns each board unmount's `pty:kill` / `preview:osrClose` into a no-op.
 */
import { useCanvasStore, acquireProjectSwitchLock, releaseProjectSwitchLock } from './canvasStore'
import { cancelActiveAutosave } from './useAutosave'
import { useSaveStatusStore } from './saveStatusStore'
import {
  backgroundLiveResources,
  closeActiveLiveResources,
  disposeLiveResources
} from './disposeLiveResources'
import { requestAskOnSwitch } from './askOnSwitchStore'
import { captureProjectThumb } from './projectThumbCapture'
import {
  armSwitchTransition,
  settleSwitchTransitionIn,
  clearSwitchTransition
} from './switchTransitionStore'

export type SwitchOutcome = 'switched' | 'locked' | 'save-failed' | 'cancelled'

/** Phase 4c: budget for pulling the outgoing thumb as the overlay's OUT snapshot — same
 *  contract as the capture itself (cosmetic; the switch never waits on it). */
const SNAPSHOT_FETCH_BUDGET_MS = 400

/**
 * The switch-away snapshot for the transition overlay: the dock thumbnail
 * `captureProjectThumb` just cached for the outgoing dir. Time-boxed like the capture; any
 * miss (no cached thumb, slow IPC, partial test mock) resolves null and the overlay skips
 * the scale-out for the fade/HOLD path — still no picker, never a blocked switch.
 */
async function fetchOutgoingSnapshot(dir: string): Promise<string | null> {
  const fetched = Promise.resolve()
    .then(() => window.api.project.thumbs())
    .then((t) => t[dir] ?? null)
    .catch(() => null)
  const budget = new Promise<string | null>((resolve) => {
    setTimeout(() => resolve(null), SNAPSHOT_FETCH_BUDGET_MS)
  })
  return Promise.race([fetched, budget])
}

/**
 * Decide whether the outgoing project keeps running (Phase 4). Explicit `keepBackground`
 * (the e2e harness) wins. Otherwise: nothing running → plain stop (nothing to keep);
 * remembered 'keep' policy → silent keep; 'ask' → the dialog (Keep also records the policy —
 * with the forever flag when ticked — so the NEXT switch away is silent). A torn-down bridge /
 * partial test mock resolves to the safe legacy stop.
 */
async function decideKeep(
  outgoingDir: string,
  explicit: boolean | undefined,
  incomingName: string | null
): Promise<boolean | 'cancelled'> {
  if (explicit !== undefined) return explicit
  const info = await Promise.resolve()
    .then(() => window.api.project.askOnSwitchInfo())
    .catch(() => null)
  if (!info || info.dir !== outgoingDir) return false
  if (info.terminals + info.previews === 0) return false
  if (info.policy === 'keep') return true
  const choice = await requestAskOnSwitch({
    outgoingName: useCanvasStore.getState().project.name ?? 'this project',
    incomingName,
    terminals: info.terminals,
    previews: info.previews
  })
  if (choice.action === 'cancel') return 'cancelled'
  if (choice.action === 'stop') return false
  await Promise.resolve()
    .then(() => window.api.project.setKeepPolicy(choice.forever))
    .catch(() => false)
  return true
}

export async function performProjectSwitch(
  load: () => Promise<unknown>,
  opts?: {
    /** Keep the outgoing project running in the background. Default = the Phase-4 policy flow
     *  (remembered keep → silent; otherwise the ask-on-switch dialog when anything is live). */
    keepBackground?: boolean
    /** Incoming project's display name for the dialog title (best-effort). */
    incomingName?: string
  }
): Promise<SwitchOutcome> {
  // BUG-009: one switch pipeline at a time, ACROSS surfaces (shared with WelcomeScreen's
  // open/create) — without the shared lock a second click interleaves two open pipelines and
  // the renderer can settle on project B while MAIN's currentDir points at C, after which
  // autosave writes B's canvas into C's canvas.json.
  if (!acquireProjectSwitchLock()) return 'locked'
  try {
    const outgoingDir = useCanvasStore.getState().project.dir
    // Phase 4: decide the handover BEFORE any side effect (lock → dialog → save, per the
    // approved design) — a Cancel must leave the outgoing project exactly as it was.
    const keepDecision =
      outgoingDir !== null
        ? await decideKeep(outgoingDir, opts?.keepBackground, opts?.incomingName ?? null)
        : false
    if (keepDecision === 'cancelled') return 'cancelled'
    const keep = keepDecision === true
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
    // Phase 4b (project dock): snapshot the outgoing canvas for its dock card. MUST run
    // BEFORE the setProjectLoading() unmount below (after it the canvas DOM is gone) and
    // covers BOTH the keep and stop paths. Best-effort: capturePage is env-flaky, so a
    // failed capture is a normal outcome (the dock shows its dot-grid placeholder).
    if (outgoingDir !== null) await captureProjectThumb()
    // Phase 4c: arm the switch-transition overlay BEFORE the setProjectLoading() unmount —
    // the overlay is what stands in for the outgoing canvas the moment it disappears.
    // Cancel/locked/save-failed all returned above, so those paths arm NOTHING; the
    // welcome-screen open (no outgoing project) keeps its D0-7 fallback. The overlay
    // settles below off the real landing; a throw in between is the watchdog's job.
    if (outgoingDir !== null) {
      armSwitchTransition({
        snapshotUrl: await fetchOutgoingSnapshot(outgoingDir),
        incomingName: opts?.incomingName ?? null,
        outgoingName: useCanvasStore.getState().project.name
      })
    }
    // 2. Hand over live resources, then suppress autosave + unmount.
    if (keep && outgoingDir !== null) {
      // BEFORE the unmount (see module doc) — MAIN parks PTYs + freezes previews while the
      // boards are still mounted, so their unmount cleanups no-op instead of killing.
      await backgroundLiveResources(outgoingDir)
      useCanvasStore.getState().setProjectLoading()
    } else if (outgoingDir !== null) {
      // STOP: the SCOPED close — kills only what the outgoing project owns. The legacy
      // dispose-all here would also reap every other resident's background sessions.
      useCanvasStore.getState().setProjectLoading()
      await closeActiveLiveResources(outgoingDir)
    } else {
      // No project open (welcome-screen open) — nothing project-scoped to close; the legacy
      // sweep clears any stray pre-project resources (e2e boot state).
      useCanvasStore.getState().setProjectLoading()
      await disposeLiveResources(undefined)
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
    // Phase 4c: settle the overlay off the REAL landing — 'open' plays the IN rise over
    // the freshly mounted canvas; anything else (load error, .bak retry that also failed)
    // drops the overlay IMMEDIATELY so the error screen is reachable. Both are no-ops
    // when nothing was armed (welcome-screen open).
    if (useCanvasStore.getState().project.status === 'open') settleSwitchTransitionIn()
    else clearSwitchTransition()
    return 'switched'
  } finally {
    releaseProjectSwitchLock()
  }
}
