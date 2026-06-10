import { test, expect } from './fixtures'
import { evalIn } from './helpers'

// Shared <Menu> shell (D1-C) — real-app slivers the jsdom tier can't prove:
// real-OS key delivery into the roving focus, trigger re-click toggling, and
// focus restore back into xterm. Two of these caught real bugs during the lane:
// a mid-dispatch listener removal swallowed Escape (groups.e2e.ts:150), and the
// focus restore was a silent no-op on xterm's transiently-unfocusable textarea.
test.describe('shared menu shell (real OS input)', () => {
  test('project switcher: ArrowDown moves the roving focus; Escape closes', async ({ page }) => {
    await page.locator('.project-switcher-trigger').click()
    await expect(page.locator('.project-switcher-menu')).toHaveCount(1)
    const before = await evalIn<string>(page, `document.activeElement?.textContent || ''`)
    await page.keyboard.press('ArrowDown')
    const after = await evalIn<string>(page, `document.activeElement?.textContent || ''`)
    expect(before).not.toBe(after)
    await page.keyboard.press('Escape')
    await expect(page.locator('.project-switcher-menu')).toHaveCount(0)
  })

  test('tidy picker: re-clicking the trigger closes (no close-then-reopen flicker)', async ({
    page
  }) => {
    const trigger = page.locator('button[title="Tidy layout (T)"]')
    await trigger.click()
    await expect(page.locator('[aria-label="Tidy layout"]')).toHaveCount(1)
    await trigger.click()
    await expect(page.locator('[aria-label="Tidy layout"]')).toHaveCount(0)
  })

  test('terminal context menu: autoFocus enters the menu; close restores xterm focus', async ({
    page
  }) => {
    await evalIn(page, `window.__canvasE2E.seedBoard('terminal')`)
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const well = page.locator('.xterm-screen').first()
    await well.click()
    await well.click({ button: 'right' })
    await expect(page.locator('[aria-label="Element actions"]')).toHaveCount(1)
    expect(await evalIn<string>(page, `document.activeElement?.getAttribute('role') || ''`)).toBe(
      'menuitem'
    )
    await page.keyboard.press('Escape')
    await expect(page.locator('[aria-label="Element actions"]')).toHaveCount(0)
    // The restore is deferred a tick (mid-commit focus() on xterm's textarea is a silent
    // no-op) — poll briefly instead of asserting synchronously.
    await expect
      .poll(() => evalIn<string>(page, `(document.activeElement?.className || '').toLowerCase()`), {
        timeout: 2000
      })
      .toContain('xterm')
  })
})
