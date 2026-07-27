/**
 * `performProjectSwitch` — the switch orchestrator (audit R9 / finding SM-3).
 *
 * 300 LOC, five distinct return codes, six production entry points, and until this file NO
 * dedicated test — its only test contact was `SwitchTransitionOverlay.integration.test.tsx`,
 * which exercises the overlay rather than the pipeline. The audit called it out because the path
 * is not stable code (8 commits across 3 files in 60 days) and because two of its properties are
 * SILENT when broken: an aborted switch that keeps no sessions, and a mis-ordered
 * cancel-autosave → flush → sidecar sequence, which loses the outgoing project's tail edits with
 * no error anywhere.
 *
 * WHAT IS ASSERTED, and why it is assertable at all: every collaborator is mocked, and each one
 * appends to a single shared `calls` log. So the file can assert not just *that* a step ran but
 * *when* it ran relative to the others — which is the only way to test an ordering contract whose
 * whole failure mode is "right calls, wrong order".
 *
 * The switch lock is a FAITHFUL mini-implementation rather than a `vi.fn()`: `'locked'` is a
 * property of a real second acquire failing, and stubbing the lock true/false by hand would let
 * the test pass against a pipeline that never took it.
 *
 * Trap kept from PR #390: `decideKeep` early-returns on `if (explicit !== undefined) return
 * explicit`, so a test that passes an explicit keep is NOT testing the default pipeline. The
 * `decideKeep` block below drives the non-explicit branch deliberately, and one test asserts the
 * early return skips `recordAskTime` — the exact reason that branch went years without executing
 * outside a unit test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AskOnSwitchChoice } from './askOnSwitchStore'

/** Ordered log of every collaborator call — the ordering contract is asserted against this. */
const { calls, storeState, lockState } = vi.hoisted(() => ({
  calls: [] as string[],
  storeState: {
    project: { dir: null as string | null, name: null as string | null, status: 'open' },
    toObject: (): unknown => ({ schemaVersion: 22, boards: [] }),
    setProjectLoading: (): void => undefined,
    applyOpenResult: async (_r: unknown): Promise<void> => undefined
  },
  // Faithful mini-lock: module-scoped, non-reentrant — the same contract canvasStore exports.
  lockState: { held: false }
}))

vi.mock('./canvasStore', () => ({
  useCanvasStore: { getState: () => storeState },
  acquireProjectSwitchLock: (): boolean => {
    if (lockState.held) return false
    lockState.held = true
    return true
  },
  releaseProjectSwitchLock: (): void => {
    lockState.held = false
    calls.push('releaseLock')
  }
}))

vi.mock('./useAutosave', () => ({
  cancelActiveAutosave: (): void => void calls.push('cancelAutosave')
}))

const { setSaveFailure, markSaved } = vi.hoisted(() => ({
  setSaveFailure: vi.fn(),
  markSaved: vi.fn()
}))
vi.mock('./saveStatusStore', () => ({
  useSaveStatusStore: {
    getState: () => ({
      setSaveFailure: (m: string) => {
        calls.push('setSaveFailure')
        setSaveFailure(m)
      },
      markSaved: () => {
        calls.push('markSaved')
        markSaved()
      }
    })
  }
}))

const { backgroundLiveResources, closeActiveLiveResources, disposeLiveResources } = vi.hoisted(
  () => ({
    backgroundLiveResources: vi.fn<(dir: string) => Promise<boolean>>(),
    closeActiveLiveResources: vi.fn<(dir: string) => Promise<void>>(),
    disposeLiveResources: vi.fn<(dir?: string) => Promise<void>>()
  })
)
vi.mock('./disposeLiveResources', () => ({
  backgroundLiveResources: (dir: string) => {
    calls.push('background')
    return backgroundLiveResources(dir)
  },
  closeActiveLiveResources: (dir: string) => {
    calls.push('closeActive')
    return closeActiveLiveResources(dir)
  },
  disposeLiveResources: (dir?: string) => {
    calls.push('disposeAll')
    return disposeLiveResources(dir)
  }
}))

const { requestAskOnSwitch } = vi.hoisted(() => ({
  requestAskOnSwitch: vi.fn<() => Promise<AskOnSwitchChoice>>()
}))
vi.mock('./askOnSwitchStore', () => ({
  requestAskOnSwitch: () => {
    calls.push('ask')
    return requestAskOnSwitch()
  }
}))

vi.mock('./projectThumbCapture', () => ({
  captureProjectThumb: async (): Promise<void> => void calls.push('thumb')
}))

const { armSwitchTransition } = vi.hoisted(() => ({ armSwitchTransition: vi.fn() }))
vi.mock('./switchTransitionStore', () => ({
  armSwitchTransition: (a: unknown) => {
    calls.push('arm')
    armSwitchTransition(a)
  },
  settleSwitchTransitionIn: (): void => void calls.push('settleIn'),
  clearSwitchTransition: (): void => void calls.push('clearOverlay')
}))

const { recordAskTime, reportMainOpen, endSwitch, markPaintableAndEnd } = vi.hoisted(() => ({
  recordAskTime: vi.fn(),
  reportMainOpen: vi.fn(),
  endSwitch: vi.fn(),
  markPaintableAndEnd: vi.fn()
}))
vi.mock('./switchMetrics', () => ({
  beginSwitch: (): void => void calls.push('beginSwitch'),
  markSwitch: (m: string): void => void calls.push(`mark:${m}`),
  recordAskTime: (ms: number) => {
    calls.push('recordAskTime')
    recordAskTime(ms)
  },
  reportMainOpen: (ms: number) => reportMainOpen(ms),
  endSwitch: (o: string) => {
    calls.push(`endSwitch:${o}`)
    endSwitch(o)
  },
  markPaintableAndEnd: (o: string) => {
    calls.push(`paintable:${o}`)
    markPaintableAndEnd(o)
  }
}))

import { performProjectSwitch } from './projectSwitch'

const OUT = 'C:/proj/outgoing'

const api = {
  save: vi.fn<() => Promise<{ ok: boolean; code?: string }>>(),
  saveSession: vi.fn<() => Promise<boolean>>(),
  thumb: vi.fn<() => Promise<string | null>>(),
  askOnSwitchInfo: vi.fn<
    () => Promise<{
      dir: string
      policy: 'ask' | 'keep'
      terminals: number
      previews: number
    } | null>
  >(),
  setKeepPolicy: vi.fn<(forever: boolean) => Promise<boolean>>(),
  forgetKeepPolicy: vi.fn<(dir: string) => Promise<boolean>>()
}

/** The pipeline's `load` thunk — logs, so load-vs-handover ordering is assertable. */
function loader(result: unknown = { ok: true }): () => Promise<unknown> {
  return async () => {
    calls.push('load')
    return result
  }
}

/** Position of a logged call, or -1. Ordering asserts read as `a < b`. */
const at = (name: string): number => calls.indexOf(name)

beforeEach(() => {
  calls.length = 0
  lockState.held = false
  storeState.project = { dir: OUT, name: 'outgoing', status: 'open' }
  storeState.setProjectLoading = (): void => void calls.push('setProjectLoading')
  storeState.applyOpenResult = async (): Promise<void> => void calls.push('applyOpenResult')

  // The two writes log as well as resolve — the ordering block below asserts on their position
  // relative to `cancelAutosave`, which is only observable if every step shares one log.
  api.save.mockReset().mockImplementation(async () => {
    calls.push('save')
    return { ok: true }
  })
  api.saveSession.mockReset().mockImplementation(async () => {
    calls.push('saveSession')
    return true
  })
  api.thumb.mockReset().mockResolvedValue('data:image/png;base64,AAA')
  api.askOnSwitchInfo.mockReset().mockResolvedValue(null)
  api.setKeepPolicy.mockReset().mockResolvedValue(true)
  api.forgetKeepPolicy.mockReset().mockResolvedValue(true)
  requestAskOnSwitch.mockReset().mockResolvedValue({ action: 'keep', forever: false })
  backgroundLiveResources.mockReset().mockResolvedValue(true)
  closeActiveLiveResources.mockReset().mockResolvedValue(undefined)
  disposeLiveResources.mockReset().mockResolvedValue(undefined)
  setSaveFailure.mockReset()
  markSaved.mockReset()
  recordAskTime.mockReset()
  reportMainOpen.mockReset()
  endSwitch.mockReset()
  markPaintableAndEnd.mockReset()
  armSwitchTransition.mockReset()
  ;(globalThis as unknown as { window: unknown }).window = { api: { project: api } }
})

// ────────────────────────────────────────────────────────────────────────────────────────────
// The five return codes. Each is the ONLY exit from its branch, so each also asserts what the
// branch must NOT have done — an abort that still handed over resources is the dangerous shape.
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('performProjectSwitch — the five return codes', () => {
  it("'switched': flushes, arms the overlay, hands over, loads, and settles on the painted frame", async () => {
    const outcome = await performProjectSwitch(loader(), { keepBackground: false })

    expect(outcome).toBe('switched')
    expect(api.save).toHaveBeenCalledTimes(1)
    expect(calls).toContain('arm')
    expect(calls).toContain('load')
    expect(calls).toContain('applyOpenResult')
    // The overlay settles off the REAL landing (status 'open'), and the record closes on the
    // first painted frame rather than when the promise resolves.
    expect(calls).toContain('settleIn')
    expect(markPaintableAndEnd).toHaveBeenCalledWith('switched')
    expect(endSwitch).not.toHaveBeenCalled()
  })

  it("'locked': the lock is already held → returns immediately, does NOTHING, and is not measured", async () => {
    // Held directly rather than by racing a real switch: the assertions below are about what the
    // rejected call did NOT do, and a concurrently-progressing first switch would write into the
    // same log and make "nothing happened" unassertable.
    lockState.held = true

    expect(await performProjectSwitch(loader())).toBe('locked')

    // "A 'locked' return is deliberately NOT measured" — the lock rejected the call before any
    // work happened, so recording one would pollute the record with zero-length runs and clobber
    // the real switch already in flight. Not one collaborator ran, not even beginSwitch.
    expect(calls).toEqual([])
    expect(endSwitch).not.toHaveBeenCalled()
    expect(api.save).not.toHaveBeenCalled()
    // The rejected call must not release the lock it never took (that would strand the real one).
    expect(lockState.held).toBe(true)
  })

  it('a REAL second switch during one in flight settles locked, and the first still completes', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const first = performProjectSwitch(async () => {
      calls.push('load')
      await gate
      return { ok: true }
    })
    // Let the first switch reach the load thunk (it holds the lock across every await).
    await vi.waitFor(() => expect(calls).toContain('load'))

    expect(await performProjectSwitch(loader())).toBe('locked')

    release()
    expect(await first).toBe('switched')
    // One switch's worth of work, not two.
    expect(api.save).toHaveBeenCalledTimes(1)
  })

  it("'save-failed': aborts BEFORE any handover, raises the visible chip, and never loads", async () => {
    api.save.mockResolvedValue({ ok: false, code: 'ENOSPC' })

    const outcome = await performProjectSwitch(loader(), { keepBackground: true })

    expect(outcome).toBe('save-failed')
    // The whole point of the abort: the outgoing project stays open + editable for a retry.
    expect(calls).not.toContain('load')
    expect(calls).not.toContain('background')
    expect(calls).not.toContain('setProjectLoading')
    expect(calls).not.toContain('arm')
    // D0-8: the abort must be VISIBLE, not console-only.
    expect(setSaveFailure).toHaveBeenCalledTimes(1)
    expect(markSaved).not.toHaveBeenCalled()
    expect(endSwitch).toHaveBeenCalledWith('save-failed')
  })

  it("'background-failed': a failed keep-handover aborts, clears the overlay, and does NOT unmount", async () => {
    backgroundLiveResources.mockResolvedValue(false)

    const outcome = await performProjectSwitch(loader(), { keepBackground: true })

    expect(outcome).toBe('background-failed')
    // The sessions were never parked, so proceeding to the unmount would have killed the very
    // terminals the user chose to keep — silently. Nothing past the handover may run.
    expect(calls).not.toContain('setProjectLoading')
    expect(calls).not.toContain('load')
    expect(calls).toContain('clearOverlay')
    expect(setSaveFailure).toHaveBeenCalledTimes(1)
    expect(endSwitch).toHaveBeenCalledWith('background-failed')
  })

  it("'cancelled': the ask-dialog Cancel leaves the outgoing project EXACTLY as it was", async () => {
    api.askOnSwitchInfo.mockResolvedValue({ dir: OUT, policy: 'ask', terminals: 2, previews: 1 })
    requestAskOnSwitch.mockResolvedValue({ action: 'cancel' })

    const outcome = await performProjectSwitch(loader())

    expect(outcome).toBe('cancelled')
    // "A Cancel must leave the outgoing project exactly as it was" — the decision is taken
    // BEFORE any side effect, so not one of these may have happened.
    expect(calls).not.toContain('cancelAutosave')
    expect(api.save).not.toHaveBeenCalled()
    expect(calls).not.toContain('thumb')
    expect(calls).not.toContain('arm')
    expect(calls).not.toContain('background')
    expect(calls).not.toContain('closeActive')
    expect(calls).not.toContain('load')
    expect(endSwitch).toHaveBeenCalledWith('cancelled')
  })

  it('releases the lock on EVERY outcome, so the next switch is never wedged', async () => {
    api.save.mockResolvedValue({ ok: false })
    expect(await performProjectSwitch(loader())).toBe('save-failed')
    expect(lockState.held).toBe(false)

    // A throw from deep in the pipeline must release it too (the `finally`).
    api.save.mockRejectedValue(new Error('ipc down'))
    await expect(performProjectSwitch(loader())).rejects.toThrow('ipc down')
    expect(lockState.held).toBe(false)

    api.save.mockResolvedValue({ ok: true })
    expect(await performProjectSwitch(loader())).toBe('switched')
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────
// decideKeep. The explicit-keep early return is why the ask branch never ran outside a unit
// test before PR #390 — so these drive the DEFAULT (non-explicit) pipeline on purpose.
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('decideKeep — the handover decision', () => {
  it('an EXPLICIT keep short-circuits: no info IPC, no dialog, no ask time recorded', async () => {
    await performProjectSwitch(loader(), { keepBackground: true })

    // `if (explicit !== undefined) return explicit` — every automated switch before #390 took
    // this branch, which is exactly why the code below it went unexercised.
    expect(api.askOnSwitchInfo).not.toHaveBeenCalled()
    expect(requestAskOnSwitch).not.toHaveBeenCalled()
    expect(recordAskTime).not.toHaveBeenCalled()
    expect(calls).toContain('background')
  })

  it('an EXPLICIT stop short-circuits to the scoped close', async () => {
    await performProjectSwitch(loader(), { keepBackground: false })
    expect(api.askOnSwitchInfo).not.toHaveBeenCalled()
    expect(calls).toContain('closeActive')
    expect(calls).not.toContain('background')
  })

  it('no info (torn bridge / partial mock) degrades to the safe legacy stop', async () => {
    api.askOnSwitchInfo.mockRejectedValue(new Error('no bridge'))
    await performProjectSwitch(loader())
    expect(requestAskOnSwitch).not.toHaveBeenCalled()
    expect(calls).toContain('closeActive')
  })

  it('info for a DIFFERENT dir is ignored (stale reply) — stop, no dialog', async () => {
    api.askOnSwitchInfo.mockResolvedValue({
      dir: 'C:/proj/somewhere-else',
      policy: 'keep',
      terminals: 3,
      previews: 1
    })
    await performProjectSwitch(loader())
    expect(requestAskOnSwitch).not.toHaveBeenCalled()
    expect(calls).toContain('closeActive')
  })

  it('nothing live → plain stop, and the user is never asked about nothing', async () => {
    api.askOnSwitchInfo.mockResolvedValue({ dir: OUT, policy: 'ask', terminals: 0, previews: 0 })
    await performProjectSwitch(loader())
    expect(requestAskOnSwitch).not.toHaveBeenCalled()
    expect(calls).toContain('closeActive')
  })

  it("a remembered 'keep' policy keeps SILENTLY — no dialog on the next switch away", async () => {
    api.askOnSwitchInfo.mockResolvedValue({ dir: OUT, policy: 'keep', terminals: 1, previews: 0 })
    await performProjectSwitch(loader())
    expect(requestAskOnSwitch).not.toHaveBeenCalled()
    expect(recordAskTime).not.toHaveBeenCalled()
    expect(calls).toContain('background')
  })

  it('ask → Keep: records the policy (with the forever flag) and times the dialog', async () => {
    api.askOnSwitchInfo.mockResolvedValue({ dir: OUT, policy: 'ask', terminals: 1, previews: 2 })
    requestAskOnSwitch.mockResolvedValue({ action: 'keep', forever: true })

    await performProjectSwitch(loader())

    expect(api.setKeepPolicy).toHaveBeenCalledWith(true)
    expect(api.forgetKeepPolicy).not.toHaveBeenCalled()
    expect(calls).toContain('background')
    // R1: the dialog is human think-time and is timed so `switchMetrics` can subtract it.
    expect(recordAskTime).toHaveBeenCalledTimes(1)
    expect(recordAskTime.mock.calls[0][0]).toBeGreaterThanOrEqual(0)
  })

  it("ask → Stop: forgets the persisted policy (the user's explicit gesture) and closes", async () => {
    api.askOnSwitchInfo.mockResolvedValue({ dir: OUT, policy: 'ask', terminals: 1, previews: 0 })
    requestAskOnSwitch.mockResolvedValue({ action: 'stop' })

    await performProjectSwitch(loader())

    // The policy reset belongs to the USER's Stop pick, not to closeActive's mechanics — the
    // zero-resource auto-stop must never delete a persisted "always keep" behind their back.
    expect(api.forgetKeepPolicy).toHaveBeenCalledWith(OUT)
    expect(api.setKeepPolicy).not.toHaveBeenCalled()
    expect(calls).toContain('closeActive')
    expect(recordAskTime).toHaveBeenCalledTimes(1)
  })

  it('the dialog is timed even when the user then CANCELS (the switch that never happened)', async () => {
    api.askOnSwitchInfo.mockResolvedValue({ dir: OUT, policy: 'ask', terminals: 1, previews: 0 })
    requestAskOnSwitch.mockResolvedValue({ action: 'cancel' })
    await performProjectSwitch(loader())
    expect(recordAskTime).toHaveBeenCalledTimes(1)
  })

  it('a failed setKeepPolicy never derails the keep the user just chose', async () => {
    api.askOnSwitchInfo.mockResolvedValue({ dir: OUT, policy: 'ask', terminals: 1, previews: 0 })
    requestAskOnSwitch.mockResolvedValue({ action: 'keep', forever: false })
    api.setKeepPolicy.mockRejectedValue(new Error('ipc down'))

    expect(await performProjectSwitch(loader())).toBe('switched')
    expect(calls).toContain('background')
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────
// Ordering. The audit named this specifically: an ordering bug here is silent data loss.
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('pipeline ordering (an inversion here is SILENT data loss)', () => {
  it('cancel-autosave → flush-save → session sidecar, in that order', async () => {
    await performProjectSwitch(loader(), { keepBackground: false })

    // PERSIST-B: the debounce is killed FIRST. A leftover timer firing after load flips
    // currentDir to the new project writes the outgoing state into the wrong canvas.json.
    expect(at('cancelAutosave')).toBeGreaterThanOrEqual(0)
    expect(at('cancelAutosave')).toBeLessThan(at('save'))
    // M1: session.json WINS on the next load, so the sidecar must be re-written after the doc
    // flush — otherwise a camera pan made right before the switch is silently reverted.
    expect(at('save')).toBeLessThan(at('saveSession'))
    expect(at('saveSession')).toBeLessThan(at('markSaved'))
  })

  it('decides the handover BEFORE cancelling autosave or saving anything', async () => {
    api.askOnSwitchInfo.mockResolvedValue({ dir: OUT, policy: 'ask', terminals: 1, previews: 0 })
    requestAskOnSwitch.mockResolvedValue({ action: 'keep', forever: false })

    await performProjectSwitch(loader())

    expect(at('ask')).toBeLessThan(at('cancelAutosave'))
    expect(at('ask')).toBeLessThan(at('save'))
  })

  it('captures the thumbnail and arms the overlay BEFORE the unmount', async () => {
    await performProjectSwitch(loader(), { keepBackground: false })

    // The capture needs the canvas DOM (gone after setProjectLoading), and the overlay is what
    // stands in for the outgoing canvas the moment it disappears.
    expect(at('thumb')).toBeLessThan(at('setProjectLoading'))
    expect(at('arm')).toBeLessThan(at('setProjectLoading'))
    expect(at('save')).toBeLessThan(at('thumb'))
  })

  it('KEEP path: parks the resources BEFORE the unmount (park is what makes the unmount a no-op)', async () => {
    await performProjectSwitch(loader(), { keepBackground: true })

    expect(at('background')).toBeLessThan(at('setProjectLoading'))
    expect(at('setProjectLoading')).toBeLessThan(at('load'))
    expect(calls).not.toContain('closeActive')
    expect(calls).not.toContain('disposeAll')
  })

  it('STOP path: unmounts FIRST, then runs the SCOPED close (never the dispose-all)', async () => {
    await performProjectSwitch(loader(), { keepBackground: false })

    expect(at('setProjectLoading')).toBeLessThan(at('closeActive'))
    expect(closeActiveLiveResources).toHaveBeenCalledWith(OUT)
    // The legacy dispose-all here would reap every OTHER resident's background sessions.
    expect(calls).not.toContain('disposeAll')
  })

  it('the handover always precedes the load', async () => {
    await performProjectSwitch(loader(), { keepBackground: true })
    expect(at('background')).toBeLessThan(at('load'))
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────
// The remaining branches: welcome-screen open, load failure, advisory sidecar, main's timing.
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('performProjectSwitch — edge branches', () => {
  it('no outgoing project (welcome-screen open): no thumb, no overlay, legacy sweep only', async () => {
    storeState.project = { dir: null, name: null, status: 'welcome' }

    expect(await performProjectSwitch(loader())).toBe('switched')

    expect(api.askOnSwitchInfo).not.toHaveBeenCalled()
    expect(calls).not.toContain('thumb')
    // Nothing to stand in for → nothing armed; App.tsx's D0-7 fallback carries this path.
    expect(calls).not.toContain('arm')
    expect(calls).toContain('disposeAll')
    expect(disposeLiveResources).toHaveBeenCalledWith(undefined)
  })

  it('a sidecar failure is ADVISORY — the switch still completes', async () => {
    api.saveSession.mockResolvedValue(false)
    expect(await performProjectSwitch(loader(), { keepBackground: false })).toBe('switched')
    expect(calls).toContain('load')
    expect(markSaved).toHaveBeenCalledTimes(1)
  })

  it('a REJECTING load settles the error screen and drops the overlay immediately', async () => {
    storeState.applyOpenResult = async (r: unknown): Promise<void> => {
      calls.push('applyOpenResult')
      // The error path leaves status non-'open' — the real store's behaviour on ok:false.
      if ((r as { ok: boolean }).ok === false) storeState.project.status = 'error'
    }
    const failing = async (): Promise<unknown> => {
      calls.push('load')
      throw new Error('disk gone')
    }

    // BUG-006: an unhandled rejection here would strand status at 'loading' with every native
    // resource already handed over — unrecoverable. It must settle, not throw.
    expect(await performProjectSwitch(failing, { keepBackground: false })).toBe('switched')
    expect(calls).toContain('clearOverlay')
    expect(calls).not.toContain('settleIn')
    // No painted canvas will follow, so the record closes now rather than leaking into the
    // next switch's window.
    expect(endSwitch).toHaveBeenCalledWith('switched')
    expect(markPaintableAndEnd).not.toHaveBeenCalled()
  })

  it("folds MAIN's reported open duration into the record when the loader carries one", async () => {
    await performProjectSwitch(loader({ ok: true, openMs: 12.5 }), { keepBackground: false })
    expect(reportMainOpen).toHaveBeenCalledWith(12.5)
  })

  it('a loader with no openMs (create / .bak reopen) contributes nothing', async () => {
    await performProjectSwitch(loader({ ok: true }), { keepBackground: false })
    expect(reportMainOpen).not.toHaveBeenCalled()
  })

  it('pins the flush to the OUTGOING dir, not whatever is current when it lands (BUG-009)', async () => {
    await performProjectSwitch(loader(), { keepBackground: false })
    expect(api.save).toHaveBeenCalledWith(expect.anything(), OUT)
    expect(api.saveSession).toHaveBeenCalledWith(expect.anything(), OUT)
  })

  it('a missing thumb (fetch rejects) still arms the overlay — the snapshot is cosmetic', async () => {
    api.thumb.mockRejectedValue(new Error('no thumb'))
    expect(await performProjectSwitch(loader(), { keepBackground: false })).toBe('switched')
    expect(armSwitchTransition).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotUrl: null, outgoingName: 'outgoing' })
    )
  })

  it('passes the incoming name through to the overlay', async () => {
    await performProjectSwitch(loader(), { keepBackground: false, incomingName: 'incoming' })
    expect(armSwitchTransition).toHaveBeenCalledWith(
      expect.objectContaining({ incomingName: 'incoming' })
    )
  })
})
