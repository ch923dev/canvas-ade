/**
 * Opening a project when there is NO OUTGOING PROJECT — the sibling of `performProjectSwitch`.
 *
 * The two are not variants of one another, and conflating them is how this got divergent in the
 * first place. A SWITCH has an outgoing project to protect: it must ask about live resources, flush
 * a save, write the session sidecar, capture a thumbnail, and hand over PTY/preview resources
 * before it may touch the incoming one. An OPEN has none of that — nothing is running, nothing is
 * unsaved, nobody has to be asked. What it still shares with a switch is the part every caller was
 * re-implementing by hand, each slightly differently:
 *
 *   • the cross-surface switch LOCK (#BUG-009). Two open pipelines that interleave leave MAIN's
 *     currentDir pointing at one project and the renderer holding the other, and the next autosave
 *     cross-writes one project's canvas into the other's file.
 *   • `loading` up front, so the picker stops being interactive while the IPC is in flight.
 *   • routing a REJECTED ipc into `applyOpenResult({ok:false})` (#BUG-030) rather than leaving the
 *     app stuck on the loading line.
 *
 * Audit R4: before this, three production doors did that by hand — WelcomeScreen's `openDir`,
 * WelcomeScreen's `onCreate`, and the boot auto-reopen in App.tsx. The first two agreed; **boot
 * took no lock at all**, so a user clicking a recent while `project.current()` was still resolving
 * ran two concurrent opens into exactly the cross-write above. That divergence is the bug this
 * primitive exists to delete, not merely to tidy.
 *
 * NOT routed through here: `e2eHooks.openProjectFromDisk`. That is a harness door and deliberately
 * stays a bare open — specs call it with a project already open, which is a SWITCH, and quietly
 * promoting those calls would change what the suite exercises. See `docs/testing/TESTING.md`.
 */
import {
  useCanvasStore,
  acquireProjectSwitchLock,
  releaseProjectSwitchLock,
  type OpenResult
} from './canvasStore'

/**
 * Why an open ended.
 *  • `opened`  — the canvas is up on the new project.
 *  • `none`    — there was nothing to open (boot found no last project); back to the picker.
 *  • `locked`  — another open/switch was already in flight; project state was left untouched.
 *  • `failed`  — MAIN said no, or the IPC rejected; status is 'error' carrying the message.
 */
export type OpenOutcome = 'opened' | 'none' | 'locked' | 'failed'

/**
 * Run `load` as THE open of a project, with no outgoing project to hand over.
 *
 * `load` is invoked only once the lock is held, so a caller that must show a modal first (the
 * folder dialog in `onCreate`) does that BEFORE calling — a cancelled dialog then never strands
 * the lock. Resolving to `null` means "nothing to open" and is not an error.
 *
 * @param failLabel message to fall back to when a rejection carries no `Error.message`.
 */
export async function openProject(
  load: () => Promise<OpenResult | null>,
  failLabel = 'failed to open project'
): Promise<OpenOutcome> {
  if (!acquireProjectSwitchLock()) return 'locked'
  const { applyOpenResult, setProjectLoading } = useCanvasStore.getState()
  setProjectLoading()
  try {
    const r = await load()
    if (r === null) {
      // Back to the empty picker, clearing any stale error — undoing the `loading` armed above,
      // which would otherwise leave the app on a loading line with no project and no picker.
      // Set directly rather than via a store action: canvasStore.ts sits on its max-lines cap, and
      // this is the one caller (same direct-setState pattern as e2eHooks' project reset).
      useCanvasStore.setState((s) => ({
        project: { ...s.project, status: 'welcome', error: undefined }
      }))
      return 'none'
    }
    await applyOpenResult(r)
    // applyOpenResult owns the verdict (it can still fail deep-validation and fall back to .bak),
    // so the outcome is read off the state it settled rather than assumed from `r.ok`.
    return useCanvasStore.getState().project.status === 'open' ? 'opened' : 'failed'
  } catch (err) {
    // #BUG-030: a rejected IPC (disk-full in touchRecent/userData) must settle to 'error' so the
    // user can retry — without this the app stays on the loading line with no way forward.
    await applyOpenResult({
      ok: false,
      error: err instanceof Error ? err.message : failLabel
    })
    return 'failed'
  } finally {
    releaseProjectSwitchLock()
  }
}
