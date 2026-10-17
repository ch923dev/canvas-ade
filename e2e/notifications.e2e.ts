import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, evalIn, mainCall, pollEval, seed } from './helpers'

/**
 * Desktop-notifications (SPEC Phase 5) — the end-to-end delivery path that only reproduces in the
 * booted app: a normalized lifecycle signal driven INTO MAIN's real `deliver` (via the P5 e2e seam
 * `notifyDeliver`, which routes to `createLifecycleDeliver` — the SAME gate + `notify:lifecycle`
 * IPC push production uses), then the renderer surfaces the in-app toast + the on-canvas attention
 * ring, and the gate (master / monitorActivity / onlyWhenUnfocused) is honoured.
 *
 * Deterministic: the OS-notification layer is a recording SPY (asserted via `notifyOsCalls`, never a
 * real `Notification`), window focus is forced via the injected seam, and there is no 60s idle wait.
 * The gate matrix + attentionStore set/clear + copy are proven at the unit tier (notificationsConfig
 * / attentionStore / agentLifecycle / ptyLifecycle `.test.ts`); this sliver proves the REAL wiring.
 */

// Typed VALUE readers (real-arg bridge calls) — the id crosses by structured clone and every
// comparison against an expected kind/bucket runs in Node, never inside an eval'd code string
// (CodeQL js/bad-code-sanitization).
const attention = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'attentionKind', a: [id] })
const ring = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'attentionRingKind', a: [id] })
const bucketOf = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'boardBucket', a: [id] })

/** Seed a terminal that stays UNSELECTED. `seedBoard` selects the newest board, and selection
 *  means "seen": on ANY later canvas-store change, useNotifications clears a selected board's
 *  attention mark. Whenever such a change lands after the delivery (a slower PTY spawn on a
 *  loaded machine is enough), it wipes the ring the test is polling for: 2/3 isolated failures
 *  on an unchanged main build, 2026-10-17. Park the selection on a planning sink, the same
 *  pattern notificationBell.e2e.ts uses. */
async function seedUnselected(page: Page): Promise<string> {
  const id = await seed(page, 'terminal')
  await seed(page, 'planning')
  return id
}

/** Poll a predicate over one of the readers above — the comparison runs HERE in Node (the
 *  terminalScrollback.e2e.ts `pollScale` shape). Same boolean contract as `pollEval`. */
async function pollKind(
  read: () => Promise<string | null>,
  pred: (v: string | null) => boolean,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect.poll(async () => pred(await read()), { timeout: timeoutMs }).toBe(true)
    return true
  } catch {
    return false
  }
}

test.describe('@terminal @core desktop notifications (lifecycle → toast + on-canvas + gate)', () => {
  test.beforeEach(async ({ electronApp }) => {
    await mainCall(electronApp, 'notifyReset')
  })

  test('a lifecycle event surfaces the in-app toast + the on-canvas attention indicator (per kind)', async ({
    page,
    electronApp
  }) => {
    // needs-input → --warn ring + awaiting-review pill; error → --err ring + failed pill; done →
    // --ok ring (no bucket change per DESIGN — a badge, not a pill). One board per kind (a board
    // holds one attention kind); the toast is matched by its per-event verb so accumulation is safe.
    const cases = [
      {
        event: 'needs-input' as const,
        verb: 'needs your input',
        toastKind: 'info',
        bucket: 'awaiting-review',
        pill: 'var(--warn)'
      },
      { event: 'done' as const, verb: 'finished', toastKind: 'ok', bucket: null, pill: null },
      {
        event: 'error' as const,
        verb: 'hit an error',
        toastKind: 'error',
        bucket: 'failed',
        pill: 'var(--err)'
      }
    ]

    for (const c of cases) {
      const id = await seedUnselected(page)
      await mainCall(electronApp, 'notifyDeliver', id, c.event)

      // (1) In-app toast surfaced through the REAL deliver → notify:lifecycle IPC → useNotifications.
      // Read the toast array to Node and match here — never interpolate the verb/kind INTO an
      // in-page eval string (keeps the value off the code-construction path; CodeQL js/bad-code-sanitization).
      await expect
        .poll(
          async () =>
            (
              await evalIn<Array<{ message: string; kind: string }>>(
                page,
                'window.__canvasE2E.notifyToasts()'
              )
            ).some((t) => t.message.includes(c.verb) && t.kind === c.toastKind),
          { timeout: 5000, message: `toast for ${c.event}` }
        )
        .toBe(true)

      // (2) The on-canvas attention overlay rendered on THIS board with the right kind (→ colour).
      const ringOk = await pollKind(
        () => ring(page, id),
        (v) => v === c.event,
        5000
      )
      expect(ringOk, `on-canvas ring for ${c.event}`).toBe(true)
      expect(await attention(page, id)).toBe(c.event)

      // (3) The status pill maps to the DESIGN colour for the bucket-changing events (warn / err).
      if (c.pill) {
        expect(await bucketOf(page, id), `bucket for ${c.event}`).toBe(c.bucket)
        const dot = await callE2E<string>(page, { m: 'bucketPillDot', a: [c.bucket] })
        expect(dot, `pill dot for ${c.event}`).toBe(c.pill)
      }
    }

    // The OS layer fired once per event by default (onlyWhenUnfocused off) — proves the spy is live,
    // so the "OS skipped" assertion in the gate test below is a meaningful contrast.
    const osCalls = await mainCall<Array<{ title: string; body: string }>>(
      electronApp,
      'notifyOsCalls'
    )
    expect(osCalls.length, 'OS notification raised per event by default').toBe(3)
  })

  test('monitorActivity:false stays fully silent — no toast, no on-canvas attention, no OS layer', async ({
    page,
    electronApp
  }) => {
    const id = await seedUnselected(page)
    // The board opted out (schema v10 monitorActivity:false) → the gate silences every surface.
    await mainCall(electronApp, 'notifySetBoard', id, { monitorActivity: false })
    await mainCall(electronApp, 'notifyDeliver', id, 'needs-input')

    // A window for a (would-be) IPC to land, then assert nothing surfaced anywhere.
    await page.waitForTimeout(300)
    expect(await evalIn(page, 'window.__canvasE2E.notifyToasts()')).toEqual([])
    expect(await attention(page, id)).toBeNull()
    expect(await ring(page, id)).toBeNull()
    expect(await mainCall(electronApp, 'notifyOsCalls')).toEqual([])
  })

  test('gate: master OFF is silent; onlyWhenUnfocused while focused shows toast + pill but skips the OS layer', async ({
    page,
    electronApp
  }) => {
    // (a) Master switch OFF → the whole feature is silent (no toast, no attention, no OS layer).
    const idOff = await seedUnselected(page)
    await mainCall(electronApp, 'notifyConfigure', { enabled: false })
    await mainCall(electronApp, 'notifyDeliver', idOff, 'error')
    await page.waitForTimeout(300)
    expect(await evalIn(page, 'window.__canvasE2E.notifyToasts()')).toEqual([])
    expect(await attention(page, idOff)).toBeNull()
    expect(await mainCall(electronApp, 'notifyOsCalls')).toEqual([])

    // (b) Master ON + onlyWhenUnfocused + window FOCUSED → the in-app toast + on-canvas pill DO
    //     deliver (on-canvas is what disambiguates which board while you're looking at the app), but
    //     the OS-notification layer is suppressed. Focus is forced via the injected seam so the
    //     branch is deterministic regardless of the real OS focus state (flaky under xvfb).
    await mainCall(electronApp, 'notifyReset')
    await mainCall(electronApp, 'notifyConfigure', { enabled: true, onlyWhenUnfocused: true })
    await mainCall(electronApp, 'notifySetFocused', true)
    const idOn = await seedUnselected(page)
    await mainCall(electronApp, 'notifyDeliver', idOn, 'needs-input')

    expect(
      await pollKind(
        () => attention(page, idOn),
        (v) => v === 'needs-input',
        5000
      ),
      'attention delivered while focused'
    ).toBe(true)
    expect(
      await pollEval(
        page,
        `window.__canvasE2E.notifyToasts().some((t) => t.message.includes('needs your input'))`,
        5000
      ),
      'toast delivered while focused'
    ).toBe(true)
    expect(await bucketOf(page, idOn), 'warn pill delivered while focused').toBe('awaiting-review')
    // ...but the OS layer was SKIPPED — asserted via the injected notify spy, never a real Notification.
    expect(await mainCall(electronApp, 'notifyOsCalls'), 'OS layer skipped while focused').toEqual(
      []
    )
  })

  test('deliver dedupe: an identical re-fire collapses to one delivery, then re-admits after the window (audit P2-2)', async ({
    page,
    electronApp
  }) => {
    // The production regression: a Claude permission prompt fires needs-input from the hook path
    // AND from the generic idle monitor — two OS notifications ~10s apart for one prompt. The
    // deliver-level dedupe collapses the second; the OS-spy count is the strong signal (the toast
    // is keyed per (board, mark), so its count alone can't distinguish dedupe from replace).
    const id = await seedUnselected(page)
    await mainCall(electronApp, 'notifyDeliver', id, 'needs-input')
    await mainCall(electronApp, 'notifyDeliver', id, 'needs-input')
    expect(
      (await mainCall<Array<{ title: string }>>(electronApp, 'notifyOsCalls')).length,
      'second identical signal collapsed inside the production window'
    ).toBe(1)
    // The single delivery still surfaced normally.
    expect(
      await pollKind(
        () => attention(page, id),
        (v) => v === 'needs-input',
        5000
      ),
      'the one admitted delivery reached the canvas'
    ).toBe(true)

    // Shrink the window (rebuilds the probe deliver with a clean map) and prove re-admission is
    // TIME-driven: inside 100ms the repeat suppresses, past it the same signal fires again.
    await mainCall(electronApp, 'notifySetDedupeMs', 100)
    await mainCall(electronApp, 'notifyDeliver', id, 'needs-input')
    await mainCall(electronApp, 'notifyDeliver', id, 'needs-input')
    expect(
      (await mainCall<Array<{ title: string }>>(electronApp, 'notifyOsCalls')).length,
      'repeat inside the shrunk window still collapses'
    ).toBe(2)
    await page.waitForTimeout(250)
    await mainCall(electronApp, 'notifyDeliver', id, 'needs-input')
    expect(
      (await mainCall<Array<{ title: string }>>(electronApp, 'notifyOsCalls')).length,
      'the same signal re-admits after the window expires'
    ).toBe(3)
  })
})
