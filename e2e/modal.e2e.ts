import { test, expect } from './fixtures'
import { evalIn } from './helpers'

/**
 * Design-audit D1-B: the shared Modal primitive (scrim/portal/Esc/focus) behind
 * ConfirmModal / RecapConsentModal / SettingsPanel.
 *
 * Covers, end to end against the real renderer:
 *  - the Settings panel opens on the shared primitive with the `--scrim` token resolved
 *    (no hardcoded rgba), initial focus lands INSIDE the dialog (A7), a REAL OS Esc closes
 *    it from the home grid, and focus restores to the opener (A7). The real-input Esc matters: a
 *    deps-churned window listener is removed mid-dispatch by the canvas keybindings' synchronous
 *    store commit and silently never fires — jsdom can't see that (Modal.tsx Esc-effect comment).
 *  - occlusion regression (PR #93 lesson — the leaked recap-consent scrim broke real-OS
 *    input across later specs): after open→close, NO scrim/dialog node survives at the
 *    canvas center, and with no project open the recap-consent scrim never mounts.
 */

test('@chrome settings panel: token scrim, initial focus, Esc close, focus restore', async ({
  page
}) => {
  await page.click('[title="Settings"]')
  const panel = page.locator('[data-test="settings-panel"]')
  await expect(panel).toBeVisible()

  // The scrim consumes the --scrim token (D0-3 approved value: rgba(0,0,0,0.5)) — the
  // computed style proves the var() resolved instead of a hardcoded literal drifting.
  const scrimBg = await evalIn<string>(
    page,
    `getComputedStyle(document.querySelector('[data-test="settings-scrim"]')).backgroundColor`
  )
  expect(scrimBg).toBe('rgba(0, 0, 0, 0.5)')

  // A7 initial focus: focus moved inside the dialog. The panel opens on the category grid (not a
  // section), so the first focusable is the close button — the assertion only cares that focus is
  // inside the card, not which control.
  const focusInDialog = await evalIn<boolean>(
    page,
    `!!document.activeElement?.closest('[data-test="settings-panel"]')`
  )
  expect(focusInDialog, 'initial focus lands inside the dialog').toBe(true)

  // Real OS Esc closes from the home grid (bubble-phase window listener on the shared Modal; when
  // drilled into a section the panel's own capture-phase Esc would go back one level first).
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // A7 focus restore: back on the opener button.
  const restored = await evalIn<string | null>(
    page,
    `document.activeElement?.getAttribute('title') ?? null`
  )
  expect(restored, 'focus restored to the Settings opener').toBe('Settings')
})

test('@chrome @voice settings voice section: catalog over real IPC + showPill applies LIVE', async ({
  page
}, testInfo) => {
  // The pill is on by default (fresh voice-config) — the live-apply baseline.
  await expect(page.locator('[data-test="voice-pill"]')).toBeVisible()

  await page.click('[title="Settings"]')
  // Voice is now a drill-in tile — open it before asserting its controls.
  await page.click('[data-test="settings-tile-voice"]')
  await expect(page.locator('[data-test="voice-showpill-row"]')).toBeVisible()
  // Model catalog rendered over the REAL voice:models:list IPC (no models on disk in the
  // e2e userData → both cards show Download CTAs; the default badge still renders).
  await expect(page.locator('[data-test="voice-model-kroko-en-2025-08-06"]')).toBeVisible()
  await expect(page.locator('[data-test="voice-model-zipformer-en-2023-06-26-int8"]')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('voice-settings-section.png') })

  // V4 live-apply: toggling OFF removes the pill from the DOM while Settings stays open
  // (voice:config:changed push → no remount needed), and toggling back ON restores it —
  // which also restores the shared e2e userData for later specs (sticky-prefs class).
  await page.click('[data-test="voice-showpill-toggle"]')
  await expect(page.locator('[data-test="voice-pill"]')).toHaveCount(0)
  await page.click('[data-test="voice-showpill-toggle"]')
  await expect(page.locator('[data-test="voice-pill"]')).toBeVisible()

  // Drilled into the Voice section → close outright via the close button (a single Esc would only
  // go back to the grid).
  await page.click('[data-test="settings-close"]')
  await expect(page.locator('[data-test="settings-panel"]')).toHaveCount(0)
})

test('@chrome settings tiles: drill into a section and back returns to the grid', async ({
  page
}) => {
  await page.click('[title="Settings"]')
  const panel = page.locator('[data-test="settings-panel"]')
  await expect(panel).toBeVisible()

  // Home grid: the tiles are present and no section body has rendered yet.
  await expect(page.locator('[data-test="settings-tile-billing"]')).toBeVisible()
  await expect(page.locator('[data-test="billing-manage"]')).toHaveCount(0)

  // Drill into Billing → its detail body renders (the Manage-subscription stub is present but
  // disabled until the billing lane ships).
  await page.click('[data-test="settings-tile-billing"]')
  await expect(page.locator('[data-test="billing-manage"]')).toBeDisabled()

  // Back → the section body unmounts and we are on the grid again; one Esc from here closes.
  await page.click('[data-test="settings-back"]')
  await expect(page.locator('[data-test="billing-manage"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})

test('@chrome no modal scrim occludes the canvas after close / without a project (PR #93 regression)', async ({
  page
}) => {
  // Open + close the Settings panel, then prove the scrim fully unmounted.
  await page.click('[title="Settings"]')
  await expect(page.locator('[data-test="settings-panel"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-test="settings-scrim"]')).toHaveCount(0)

  // No project is open in the default e2e state → the recap-consent scrim must not mount
  // (the projectDir render gate). A leaked fixed-position scrim here is exactly what made
  // real-OS input hit the wrong element in terminalIO/textToolbar (#93).
  await expect(page.locator('[data-test="recap-consent-scrim"]')).toHaveCount(0)

  // And the canvas center is actually hittable: the topmost element under the pane center
  // belongs to the canvas/chrome, not to any dialog or scrim.
  const centerIsClear = await evalIn<boolean>(
    page,
    `(() => {
       const w = document.documentElement.clientWidth
       const h = document.documentElement.clientHeight
       const el = document.elementFromPoint(w / 2, h / 2)
       return !!el && !el.closest('[role="dialog"]') && !el.closest('[data-test$="-scrim"]')
     })()`
  )
  expect(centerIsClear, 'canvas center not occluded by a modal scrim').toBe(true)
})
