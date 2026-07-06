import { test, expect } from './fixtures'
import { evalIn, mainCall } from './helpers'

/**
 * @chrome Project settings — the per-project settings tab (Sessions · Appearance · Agents).
 *
 * Covers the renderer→MAIN boundary the unit tests can't reach:
 *  - with NO project open (the e2e reset leaves project.dir null) the project-scoped panes render the
 *    shared empty state and NO keep-in-background toggle;
 *  - with a real project open the Keep-in-background toggle renders and flipping it drives the
 *    persisted keep-forever policy end-to-end (setKeepPolicy → keepForeverDirs reflects the new dir).
 *
 * Settings is opened via the decoupled `expanse:open-settings` event (lands on the owning tab) rather
 * than the chrome gear, so the spec never races the post-open chrome.
 */
test('@chrome project settings: empty state with no project; keep-in-background renders + persists with one open', async ({
  page,
  electronApp
}, testInfo) => {
  const openProjectTab = (): Promise<unknown> =>
    evalIn(
      page,
      `window.dispatchEvent(new CustomEvent('expanse:open-settings', { detail: { section: 'project-sessions' } }))`
    )
  const panel = page.locator('[data-test="settings-panel"]')
  const keepToggle = page.locator('[data-test="settings-keep-background-toggle"]')

  // 1) No project open → the gated panes (Sessions · Agents) show the empty state, no toggle.
  await openProjectTab()
  await expect(panel).toBeVisible()
  await expect(page.locator('[data-test="settings-tab-project"]')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.locator('[data-test="settings-no-project"]').first()).toBeVisible()
  await expect(keepToggle).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // 2) Open a real temp project.
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'projset-', 'projset')
  const opened = await evalIn<{ status: string }>(
    page,
    `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`
  )
  expect(opened.status, 'temp project opens clean').toBe('open')
  // A fresh project fires the one-time (per-project) recap-consent prompt — a modal that stacks over
  // Settings and would intercept the toggle click. Dismiss it before opening Settings.
  await page
    .getByRole('button', { name: /^no thanks$/i })
    .click({ timeout: 8000 })
    .catch(() => undefined)

  // 3) Project tab → the toggle renders; flipping it drives the keep-forever policy through MAIN.
  const before = await evalIn<string[]>(page, `window.api.project.keepForeverDirs()`)
  await openProjectTab()
  await expect(keepToggle).toBeVisible()
  await expect(page.locator('[data-test="settings-project-orchestration-toggle"]')).toBeVisible()
  await expect(keepToggle).toHaveAttribute('aria-checked', 'false')
  await panel.screenshot({ path: testInfo.outputPath('project-settings.png') })

  await keepToggle.click()
  await expect(keepToggle).toHaveAttribute('aria-checked', 'true')
  // The persisted forever set grew by exactly this project (the real IPC round-trip landed).
  // Count-based + separator-agnostic: MAIN may normalise the stored dir string.
  await expect
    .poll(() =>
      evalIn<string[]>(page, `window.api.project.keepForeverDirs()`).then((d) => d.length)
    )
    .toBe(before.length + 1)

  // Appearance is a compact row by default; Customize expands the inline controls (BackdropControls)
  // in place — a scene tile then renders in the pane and the settings body never overflows
  // horizontally (the popover-in-modal bug this replaced).
  await expect(page.locator('.bd-inline')).toHaveCount(0) // collapsed by default
  await page.click('[data-test="settings-appearance-customize"]')
  const tile = page.locator('.bd-inline .bd-tile').first()
  await tile.scrollIntoViewIfNeeded()
  await expect(tile).toBeVisible()
  const overflow = await page
    .locator('[data-test="settings-tabpanel"]')
    .evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow, 'settings body has no horizontal overflow').toBeLessThanOrEqual(1)
  await panel.screenshot({ path: testInfo.outputPath('project-appearance.png') })

  // Also capture the sliders + grid segment (compact controls, not full-pane lines).
  await page.locator('[data-test="backdrop-grid-off"]').scrollIntoViewIfNeeded()
  await panel.screenshot({ path: testInfo.outputPath('project-appearance-controls.png') })

  // Cleanup: forget exactly the dir(s) this spec added so nothing leaks into userData / later specs.
  const after = await evalIn<string[]>(page, `window.api.project.keepForeverDirs()`)
  for (const d of after.filter((x) => !before.includes(x))) {
    await evalIn(page, `window.api.project.forgetKeepPolicy(${JSON.stringify(d)})`)
  }
})
