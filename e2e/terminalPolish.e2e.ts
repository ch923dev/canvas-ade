import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'

/**
 * D2-B terminal polish (design-audit wave D2):
 *  - first-run launchCommand hint: shows on a bare-shell terminal, opens config,
 *    × dismisses app-wide forever (sticky localStorage — leading-reset + restored
 *    below, the e2e harness reuses a persistent userData dir);
 *  - config-popover unsaved-changes guard: Escape with edits arms the confirm row
 *    instead of silently discarding (REAL keyboard input — the guard's outside/Esc
 *    listeners are mount-stable window listeners, the D1-B/C mid-dispatch class
 *    jsdom cannot see);
 *  - restart menu on the shared Menu shell: Escape / outside-pointerdown / trigger
 *    re-click all auto-close (the audit's "no auto-close");
 *  - A6 recap-flip focus transfer: focus follows the visible face both ways.
 *
 * The seed()-derived board id flows into page.evaluate as a STRUCTURED ARG, never
 * interpolated into an eval'd code string (CodeQL js/bad-code-sanitization — the
 * preview-align.e2e.ts pattern from #82). Locator strings are fine: they are
 * selectors, not code. Browser globals inside the evaluated functions go through
 * `globalThis as any` (tsconfig.node has no DOM lib; no-explicit-any is off for e2e/).
 */

const HINT_KEY = 'ca.terminal.hintDismissed'
const node = (id: string): string => `.react-flow__node[data-id="${id}"]`

const boardLaunchCommand = (page: Page, id: string): Promise<string | undefined> =>
  page.evaluate(
    (a) => (globalThis as any).__canvasE2E.getBoards().find((b: any) => b.id === a)?.launchCommand,
    id
  )
const patchBoard = (page: Page, id: string, patch: Record<string, unknown>): Promise<void> =>
  page.evaluate((a) => (globalThis as any).__canvasE2E.patchBoard(a.id, a.patch), { id, patch })
const terminalEchoed = (page: Page, id: string, marker: string): Promise<boolean> =>
  page.evaluate(
    (a) => {
      const t = (globalThis as any).__canvasE2E.readTerminal(a.id)
      return typeof t === 'string' && t.includes(a.marker)
    },
    { id, marker }
  )
const focusInRecap = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((a) => {
    const d = (globalThis as any).document
    const w = d.querySelector(`[data-test="recap-wrap-${a}"]`)
    return !!w && (d.activeElement === w || w.contains(d.activeElement))
  }, id)
const focusInXterm = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((a) => {
    const d = (globalThis as any).document
    const n = d.querySelector(`.react-flow__node[data-id="${a}"]`)
    const el = d.activeElement
    return !!n && !!el && n.contains(el) && el.classList.contains('xterm-helper-textarea')
  }, id)
// True once the flip fold has SETTLED (flat-at-rest: the stage wrapper carries no
// inline transform outside a fold — useTerminalFlip's stageStyle contract).
const flipSettled = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((a) => {
    const d = (globalThis as any).document
    const stage = d.querySelector(`[data-test="recap-wrap-${a}"]`)?.parentElement
    return !!stage && !stage.style.transform
  }, id)

test.describe('@terminal terminal polish (D2-B)', () => {
  test('first-run hint: bare shell shows the pill; click opens config; × dismisses app-wide', async ({
    page
  }) => {
    // Leading reset: the persistent userData dir can carry a dismissal from a prior run.
    await evalIn(page, `localStorage.removeItem(${JSON.stringify(HINT_KEY)})`)
    try {
      const id = await seed(page, 'terminal') // NO launchCommand → bare shell
      const hint = page.locator(`${node(id)} [data-test="terminal-hint"]`)
      await expect(hint).toBeVisible()

      // The pill text is the action: it opens the ⚙ config popover.
      await hint.getByRole('button', { name: /Set a launch command/ }).click()
      await expect(page.locator(`${node(id)} .nowheel select`)).toBeVisible()
      await page.locator(`${node(id)} button`, { hasText: 'Cancel' }).click()

      // × dismisses, persists the sticky key, and survives as gone.
      await hint.locator('[data-test="terminal-hint-dismiss"]').click()
      await expect(hint).toHaveCount(0)
      const sticky = await evalIn<string | null>(
        page,
        `localStorage.getItem(${JSON.stringify(HINT_KEY)})`
      )
      expect(sticky).toBe('1')

      // A terminal WITH a launch command never shows the pill (independent of dismissal).
      await evalIn(page, `localStorage.removeItem(${JSON.stringify(HINT_KEY)})`)
      const id2 = await seed(page, 'terminal', { launchCommand: 'echo HINTLESS' })
      // Anchor on the board chrome first: a bare toHaveCount(0) would pass trivially
      // before the seeded board even renders (asserting absence of everything).
      await expect(page.locator(node(id2))).toBeVisible()
      await expect(page.locator(`${node(id2)} [data-test="terminal-hint"]`)).toHaveCount(0)
    } finally {
      // Never ratchet later specs/runs: leave the key absent (the pre-dismissal state).
      await evalIn(page, `localStorage.removeItem(${JSON.stringify(HINT_KEY)})`)
    }
  })

  test('config guard: Escape with unsaved edits confirms instead of discarding', async ({
    page
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo GUARD' })
    await page.locator(`${node(id)} button[title="Configure terminal"]`).click()
    const launch = page.locator(`${node(id)} input[placeholder^="e.g. claude"]`)
    await expect(launch).toBeVisible()

    // Dirty edit + REAL Escape: the popover stays, the confirm row arms.
    await launch.fill('codex')
    await page.keyboard.press('Escape')
    await expect(page.locator(`${node(id)}`).getByRole('alert')).toContainText('Unsaved changes')
    await expect(launch).toBeVisible()

    // Discard closes without persisting the edit.
    await page.locator(`${node(id)} button`, { hasText: 'Discard' }).click()
    await expect(launch).toHaveCount(0)
    const persisted = await boardLaunchCommand(page, id)
    expect(persisted, 'discard must not persist the edit').toBe('echo GUARD')

    // Clean reopen: Escape closes straight through (no confirm row).
    await page.locator(`${node(id)} button[title="Configure terminal"]`).click()
    await expect(launch).toBeVisible()
    await launch.click()
    await page.keyboard.press('Escape')
    await expect(launch).toHaveCount(0)
  })

  test('restart menu auto-closes: Escape, outside pointerdown, trigger re-click', async ({
    page
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo RESTART' })
    await patchBoard(page, id, { agentSessionId: 'sess-e2e-1' })
    const trigger = page.locator(`${node(id)} button[title^="Restart"]`)
    const menu = page.getByRole('menu', { name: 'Restart terminal' })

    await trigger.click()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem')).toHaveText(['Resume session', 'New session'])
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    await trigger.click()
    await expect(menu).toBeVisible()
    await page.mouse.click(40, 300) // outside pointerdown (canvas pane)
    await expect(menu).toHaveCount(0)

    await trigger.click()
    await expect(menu).toBeVisible()
    await trigger.click() // BUG-045 class: the trigger's own click toggles closed
    await expect(menu).toHaveCount(0)
  })

  test('A6: flipping transfers focus to the recap and back to xterm', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo FLIPFOCUS' })
    // Let the spawn settle so xterm exists before we assert focus round-trips.
    await expect.poll(() => terminalEchoed(page, id, 'FLIPFOCUS'), { timeout: 10_000 }).toBe(true)

    await page.locator(`[data-test="flip-${id}"]`).click()
    await expect
      .poll(() => focusInRecap(page, id), {
        timeout: 4000,
        message: 'focus moved to the recap face after flip'
      })
      .toBe(true)

    // The fold must SETTLE before flipping back: toggle() swallows clicks while a
    // fold is in flight (intended re-entrancy guard), and the focus poll above can
    // pass right after the 150ms face swap — under load the settle timer starves,
    // so an immediate second click lands mid-fold and is silently ignored (the
    // recap face then stays up forever; caught by a full-suite run's failure.png).
    await expect
      .poll(() => flipSettled(page, id), { timeout: 4000, message: 'flip fold settled' })
      .toBe(true)

    await page.locator(`[data-test="flip-${id}"]`).click()
    await expect
      .poll(() => focusInXterm(page, id), {
        timeout: 4000,
        message: 'focus restored to xterm after flip-back'
      })
      .toBe(true)
  })
})
