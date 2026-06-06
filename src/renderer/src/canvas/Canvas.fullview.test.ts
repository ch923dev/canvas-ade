/**
 * #BUG-004 — maximizing a Terminal/Browser board while a Planning board is already in
 * camera-full-view must NOT leave both full-view modes live (double-mode → two Esc).
 *
 * `requestFullView` (Canvas.tsx) is an inline closure over component refs/callbacks that
 * cannot mount in the jsdom/vitest env (React Flow + Zustand + electron preload). Its
 * decision logic is extracted into the pure, exported `planFullViewAction`, which the
 * source closure now drives in order — so a regression in the decision breaks this test
 * even though the component never mounts (mirrors the Wave-4 `shouldFireCameraShortcut`
 * pattern in Canvas.wave4.test.tsx).
 *
 * globals: false — import all vitest helpers explicitly (see vitest.config.ts).
 */
import { describe, it, expect } from 'vitest'
import { planFullViewAction } from './Canvas'

describe('#BUG-004 — planFullViewAction never leaves portal + camera full view both live', () => {
  it('Terminal maximize while a Planning board is in camera-FV exits camera-FV BEFORE opening the portal', () => {
    // cameraFullViewId set (a Planning board is camera-full-viewed); no portal modal yet.
    const steps = planFullViewAction('terminal', 'term-1', null, 'plan-1')
    // The exit must come first, then the portal open — never an open with camera-FV still set.
    expect(steps).toEqual(['exitCameraFullView', 'openFullView'])
  })

  it('Browser maximize while a Planning board is in camera-FV also exits camera-FV first', () => {
    const steps = planFullViewAction('browser', 'br-1', null, 'plan-1')
    expect(steps).toEqual(['exitCameraFullView', 'openFullView'])
  })

  // ---- guards: the fix must not regress the other branches ----

  it('Terminal maximize with NO camera-FV just opens the portal', () => {
    expect(planFullViewAction('terminal', 'term-1', null, null)).toEqual(['openFullView'])
  })

  it('re-toggling the SAME portal board closes it (no spurious exit)', () => {
    expect(planFullViewAction('browser', 'br-1', 'br-1', null)).toEqual(['closeFullView'])
  })

  it('Planning maximize enters camera-FV (enter already hard-closes any portal internally)', () => {
    expect(planFullViewAction('planning', 'plan-1', null, null)).toEqual(['enterCameraFullView'])
  })

  it('re-toggling the SAME camera-FV Planning board exits camera-FV', () => {
    expect(planFullViewAction('planning', 'plan-1', null, 'plan-1')).toEqual(['exitCameraFullView'])
  })

  it('switching camera-FV from Planning A to Planning B enters B (enter restores the saved viewport guard)', () => {
    expect(planFullViewAction('planning', 'plan-2', null, 'plan-1')).toEqual([
      'enterCameraFullView'
    ])
  })
})
