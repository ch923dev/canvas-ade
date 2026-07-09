import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

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

const attention = (id: string): string => `window.__canvasE2E.attentionKind(${JSON.stringify(id)})`
const ring = (id: string): string => `window.__canvasE2E.attentionRingKind(${JSON.stringify(id)})`
const bucketOf = (id: string): string => `window.__canvasE2E.boardBucket(${JSON.stringify(id)})`

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
      const id = await seed(page, 'terminal')
      await mainCall(electronApp, 'notifyDeliver', id, c.event)

      // (1) In-app toast surfaced through the REAL deliver → notify:lifecycle IPC → useNotifications.
      const toastOk = await pollEval(
        page,
        `window.__canvasE2E.notifyToasts().some((t) => t.message.includes(${JSON.stringify(
          c.verb
        )}) && t.kind === ${JSON.stringify(c.toastKind)})`,
        5000
      )
      expect(toastOk, `toast for ${c.event}`).toBe(true)

      // (2) The on-canvas attention overlay rendered on THIS board with the right kind (→ colour).
      const ringOk = await pollEval(page, `${ring(id)} === ${JSON.stringify(c.event)}`, 5000)
      expect(ringOk, `on-canvas ring for ${c.event}`).toBe(true)
      expect(await evalIn(page, attention(id))).toBe(c.event)

      // (3) The status pill maps to the DESIGN colour for the bucket-changing events (warn / err).
      if (c.pill) {
        expect(await evalIn(page, bucketOf(id)), `bucket for ${c.event}`).toBe(c.bucket)
        const dot = await evalIn<string>(
          page,
          `window.__canvasE2E.bucketPillDot(${JSON.stringify(c.bucket)})`
        )
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
    const id = await seed(page, 'terminal')
    // The board opted out (schema v10 monitorActivity:false) → the gate silences every surface.
    await mainCall(electronApp, 'notifySetBoard', id, { monitorActivity: false })
    await mainCall(electronApp, 'notifyDeliver', id, 'needs-input')

    // A window for a (would-be) IPC to land, then assert nothing surfaced anywhere.
    await page.waitForTimeout(300)
    expect(await evalIn(page, 'window.__canvasE2E.notifyToasts()')).toEqual([])
    expect(await evalIn(page, attention(id))).toBeNull()
    expect(await evalIn(page, ring(id))).toBeNull()
    expect(await mainCall(electronApp, 'notifyOsCalls')).toEqual([])
  })

  test('gate: master OFF is silent; onlyWhenUnfocused while focused shows toast + pill but skips the OS layer', async ({
    page,
    electronApp
  }) => {
    // (a) Master switch OFF → the whole feature is silent (no toast, no attention, no OS layer).
    const idOff = await seed(page, 'terminal')
    await mainCall(electronApp, 'notifyConfigure', { enabled: false })
    await mainCall(electronApp, 'notifyDeliver', idOff, 'error')
    await page.waitForTimeout(300)
    expect(await evalIn(page, 'window.__canvasE2E.notifyToasts()')).toEqual([])
    expect(await evalIn(page, attention(idOff))).toBeNull()
    expect(await mainCall(electronApp, 'notifyOsCalls')).toEqual([])

    // (b) Master ON + onlyWhenUnfocused + window FOCUSED → the in-app toast + on-canvas pill DO
    //     deliver (on-canvas is what disambiguates which board while you're looking at the app), but
    //     the OS-notification layer is suppressed. Focus is forced via the injected seam so the
    //     branch is deterministic regardless of the real OS focus state (flaky under xvfb).
    await mainCall(electronApp, 'notifyReset')
    await mainCall(electronApp, 'notifyConfigure', { enabled: true, onlyWhenUnfocused: true })
    await mainCall(electronApp, 'notifySetFocused', true)
    const idOn = await seed(page, 'terminal')
    await mainCall(electronApp, 'notifyDeliver', idOn, 'needs-input')

    expect(
      await pollEval(page, `${attention(idOn)} === 'needs-input'`, 5000),
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
    expect(await evalIn(page, bucketOf(idOn)), 'warn pill delivered while focused').toBe(
      'awaiting-review'
    )
    // ...but the OS layer was SKIPPED — asserted via the injected notify spy, never a real Notification.
    expect(await mainCall(electronApp, 'notifyOsCalls'), 'OS layer skipped while focused').toEqual(
      []
    )
  })
})
