/**
 * Unit tests for the switch-latency instrumentation (audit R1).
 *
 * The point of this file is that the NUMBERS are trustworthy. An instrumentation bug is worse than
 * no instrumentation: roadmap Phases 2 and 3 are judged before/after against these segments, so a
 * quietly wrong `arm` would send optimization work at the wrong subsystem. The cases that matter
 * most are the ones where a segment is ABSENT — a missing measurement must never read as a fast one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  beginSwitch,
  markSwitch,
  recordAskTime,
  reportMainOpen,
  endSwitch,
  resetSwitchMetrics,
  isSwitchMeasuring,
  bucketOf,
  useSwitchMetricsStore,
  BUCKET_OK_MS,
  BUCKET_WARN_MS
} from './switchMetrics'

/** Drive `performance.now()` through a scripted sequence so segment arithmetic is exact rather
 *  than timing-dependent. Every call consumes one value; the last value repeats if overrun. */
function scriptClock(values: number[]): void {
  let i = 0
  vi.spyOn(performance, 'now').mockImplementation(() => values[Math.min(i++, values.length - 1)])
}

beforeEach(() => {
  resetSwitchMetrics()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetSwitchMetrics()
})

describe('bucketOf', () => {
  it('buckets against the NN/g response-time limits', () => {
    expect(bucketOf(0)).toBe('ok')
    expect(bucketOf(BUCKET_OK_MS - 1)).toBe('ok')
    expect(bucketOf(BUCKET_OK_MS)).toBe('warn')
    expect(bucketOf(BUCKET_WARN_MS - 1)).toBe('warn')
    expect(bucketOf(BUCKET_WARN_MS)).toBe('err')
  })

  it('does not bucket a missing segment', () => {
    // A segment that never happened is not "fast" — it is unknown, and must not render green.
    expect(bucketOf(null)).toBeNull()
  })
})

describe('segment math', () => {
  it('derives arm / load / paint / total from the marks', () => {
    // start=0, armed=120, loaded=400, paintable=460
    scriptClock([0, 120, 400, 460])
    beginSwitch()
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    const m = endSwitch('switched')

    expect(m).not.toBeNull()
    expect(m?.arm).toBe(120)
    expect(m?.load).toBe(280)
    expect(m?.paint).toBe(60)
    expect(m?.total).toBe(460)
    expect(m?.outcome).toBe('switched')
  })

  it('keeps total consistent with the sum of its segments', () => {
    scriptClock([0, 120, 400, 460])
    beginSwitch()
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    const m = endSwitch('switched')
    // The overlay shows these four numbers together; if they did not add up the readout would be
    // actively misleading about where the time went.
    expect((m?.arm ?? 0) + (m?.load ?? 0) + (m?.paint ?? 0)).toBe(m?.total)
  })

  it('commits the record to the store', () => {
    scriptClock([0, 50, 100, 150])
    beginSwitch()
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    endSwitch('switched')
    expect(useSwitchMetricsStore.getState().last?.total).toBe(150)
  })
})

describe('ask-time exclusion', () => {
  it('subtracts dialog think-time from arm and total', () => {
    // start=0, armed=5120, loaded=5400, paintable=5460, with 5000ms of it spent in the dialog.
    scriptClock([0, 5120, 5400, 5460])
    beginSwitch()
    recordAskTime(5000)
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    const m = endSwitch('switched')

    // Without the exclusion this reads as a 5.5-second switch, which is a statement about how long
    // the user deliberated, not about the app.
    expect(m?.arm).toBe(120)
    expect(m?.total).toBe(460)
    expect(m?.ask).toBe(5000)
  })

  it('leaves load and paint untouched — the dialog closes before either begins', () => {
    scriptClock([0, 5120, 5400, 5460])
    beginSwitch()
    recordAskTime(5000)
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    const m = endSwitch('switched')
    expect(m?.load).toBe(280)
    expect(m?.paint).toBe(60)
  })

  it('reports null ask when no dialog appeared', () => {
    scriptClock([0, 100, 200, 300])
    beginSwitch()
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    expect(endSwitch('switched')?.ask).toBeNull()
  })

  it('is additive across multiple dialogs', () => {
    scriptClock([0, 1000, 1100, 1200])
    beginSwitch()
    recordAskTime(300)
    recordAskTime(200)
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    expect(endSwitch('switched')?.ask).toBe(500)
  })

  it('ignores nonsense durations rather than corrupting the record', () => {
    scriptClock([0, 100, 200, 300])
    beginSwitch()
    recordAskTime(Number.NaN)
    recordAskTime(-50)
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    expect(endSwitch('switched')?.ask).toBeNull()
  })

  it('never lets exclusion drive a segment negative', () => {
    // Pathological: more ask time recorded than wall time elapsed. Clamp rather than emit a
    // negative duration, which would render as nonsense and break bucketing.
    scriptClock([0, 100, 200, 300])
    beginSwitch()
    recordAskTime(99999)
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    const m = endSwitch('switched')
    expect(m?.arm).toBe(0)
    expect(m?.total).toBe(0)
  })
})

describe('missing marks degrade to null, not zero', () => {
  it('reports null total and paint for a switch that never painted', () => {
    scriptClock([0, 120, 400])
    beginSwitch()
    markSwitch('armed')
    markSwitch('loaded')
    const m = endSwitch('save-failed')
    // The switch aborted. It has an `arm` and a `load`, but claiming total=0 would report the
    // slowest possible outcome as the fastest.
    expect(m?.arm).toBe(120)
    expect(m?.load).toBe(280)
    expect(m?.paint).toBeNull()
    expect(m?.total).toBeNull()
    expect(m?.outcome).toBe('save-failed')
  })

  it('records an aborted switch rather than discarding it', () => {
    scriptClock([0, 4000])
    beginSwitch()
    const m = endSwitch('cancelled')
    // A cancel that burned four seconds getting to the dialog is exactly what this should catch.
    expect(m?.outcome).toBe('cancelled')
    expect(useSwitchMetricsStore.getState().last?.outcome).toBe('cancelled')
  })

  it('spans load from start on the welcome-screen path, where nothing is armed', () => {
    // No outgoing project → no transition overlay → no `armed` mark. The load still genuinely
    // began at the top of the pipeline, so dropping the number would leave that path unmeasured.
    scriptClock([0, 300, 360])
    beginSwitch()
    markSwitch('loaded')
    markSwitch('paintable')
    const m = endSwitch('switched')
    expect(m?.arm).toBeNull()
    expect(m?.load).toBe(300)
    expect(m?.paint).toBe(60)
    expect(m?.total).toBe(360)
  })
})

describe('run-window lifecycle', () => {
  it('ignores marks laid outside a run', () => {
    // A stray mark must not resurrect a closed window and attribute time to the wrong switch.
    expect(isSwitchMeasuring()).toBe(false)
    markSwitch('armed')
    expect(isSwitchMeasuring()).toBe(false)
    expect(endSwitch('switched')).toBeNull()
  })

  it('closes the window on endSwitch', () => {
    scriptClock([0, 10])
    beginSwitch()
    expect(isSwitchMeasuring()).toBe(true)
    endSwitch('switched')
    expect(isSwitchMeasuring()).toBe(false)
  })

  it('discards an unfinished run when a new switch begins', () => {
    scriptClock([0, 50, 100, 150, 200])
    beginSwitch()
    markSwitch('armed')
    beginSwitch() // second switch starts before the first ever ended
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    const m = endSwitch('switched')
    // Measured from the SECOND start (100), not the first (0) — the user is waiting on the newer one.
    expect(m?.total).toBe(100)
  })

  it('folds in MAIN’s reported open duration', () => {
    scriptClock([0, 100, 400, 460])
    beginSwitch()
    markSwitch('armed')
    reportMainOpen(275)
    markSwitch('loaded')
    markSwitch('paintable')
    expect(endSwitch('switched')?.mainOpen).toBe(275)
  })

  it('reports null mainOpen when MAIN sent nothing', () => {
    scriptClock([0, 100, 400, 460])
    beginSwitch()
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    expect(endSwitch('switched')?.mainOpen).toBeNull()
  })

  it('reset drops both the in-flight run and the committed record', () => {
    scriptClock([0, 100, 200, 300])
    beginSwitch()
    markSwitch('armed')
    markSwitch('loaded')
    markSwitch('paintable')
    endSwitch('switched')
    expect(useSwitchMetricsStore.getState().last).not.toBeNull()

    beginSwitch()
    resetSwitchMetrics()
    expect(isSwitchMeasuring()).toBe(false)
    expect(useSwitchMetricsStore.getState().last).toBeNull()
  })
})

/** `markPaintableAndEnd` resolves TWO frames after it is called, and `performProjectSwitch` releases
 *  the switch lock before then — so a second switch can legitimately start inside that window. These
 *  pin that the late callback belongs to the run that queued it and cannot touch a newer one. */
describe('markPaintableAndEnd — superseded by a newer switch', () => {
  /** Manual rAF pump: queued callbacks run only when `flushFrames` says so. */
  function manualRaf(): { flushFrames: (n: number) => void; cancelled: number[] } {
    let seq = 0
    const queue = new Map<number, FrameRequestCallback>()
    const cancelled: number[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      const id = ++seq
      queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
      if (queue.delete(id)) cancelled.push(id)
    })
    const flushFrames = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const due = [...queue.entries()]
        queue.clear()
        for (const [, cb] of due) cb(0)
      }
    }
    return { flushFrames, cancelled }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does NOT stamp paintable on, or close, a run started after it was queued', async () => {
    const { flushFrames } = manualRaf()
    const { markPaintableAndEnd } = await import('./switchMetrics')

    scriptClock([0, 100, 200, 1000, 1100, 1200, 1300])
    beginSwitch()
    markSwitch('armed')
    markSwitch('loaded')
    markPaintableAndEnd('switched') // queued — two frames pending

    // A second switch begins before those frames land (the lock is already released).
    beginSwitch()
    expect(isSwitchMeasuring()).toBe(true)

    flushFrames(2)

    // The stale callback must not have closed the NEW run.
    expect(isSwitchMeasuring()).toBe(true)
    // ...and must not have committed a record for it.
    expect(useSwitchMetricsStore.getState().last).toBeNull()
  })

  it('a new switch cancels the pending frame rather than leaving it to fire', async () => {
    const { cancelled } = manualRaf()
    const { markPaintableAndEnd } = await import('./switchMetrics')

    scriptClock([0, 100, 200, 300])
    beginSwitch()
    markSwitch('armed')
    markSwitch('loaded')
    markPaintableAndEnd('switched')

    beginSwitch()
    expect(cancelled.length).toBe(1)
  })

  it('still commits normally when nothing supersedes it', async () => {
    const { flushFrames } = manualRaf()
    const { markPaintableAndEnd } = await import('./switchMetrics')

    scriptClock([0, 100, 200, 300])
    beginSwitch()
    markSwitch('armed')
    markSwitch('loaded')
    markPaintableAndEnd('switched')
    flushFrames(2)

    expect(isSwitchMeasuring()).toBe(false)
    const last = useSwitchMetricsStore.getState().last
    expect(last?.outcome).toBe('switched')
    expect(last?.total).toBe(300)
  })
})
