import { test, expect } from './fixtures'
import { evalIn } from './helpers'

/**
 * New Terminal dialog — place-first flow. A user-placed terminal holds its spawn
 * (configPendingId) until the dialog resolves. We seed a held terminal via the e2e
 * hook (real store path), then drive the portaled dialog with real OS clicks (it is a
 * fixed-position modal at scale 1, so plain Playwright clicks hit-test correctly).
 */
test.describe('New Terminal dialog (place-first flow)', () => {
  test('pick a preset → Create → board carries the preset command + agentKind', async ({
    page
  }) => {
    const id = await evalIn<string>(page, 'window.__canvasE2E.seedConfigPendingTerminal()')

    const dialog = page.locator('[data-test="new-terminal-dialog"]')
    await expect(dialog).toBeVisible()
    // Default preset is Claude → the command field is pre-filled.
    await expect(page.locator('[data-test="new-terminal-command"]')).toHaveValue('claude')

    // Switching the preset re-fills the command.
    await page.locator('[data-test="preset-codex"]').click()
    await expect(page.locator('[data-test="new-terminal-command"]')).toHaveValue('codex')

    await page.locator('[data-test="new-terminal-create"]').click()

    // Dialog closes, the held flag is released, and the patch landed on the board.
    await expect(dialog).toHaveCount(0)
    expect(await evalIn(page, 'window.__canvasE2E.getConfigPendingId()')).toBeNull()
    const board = await evalIn<{ launchCommand?: string; agentKind?: string }>(
      page,
      `window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(id)})`
    )
    expect(board.launchCommand).toBe('codex')
    expect(board.agentKind).toBe('codex')
  })

  test('Cancel releases the spawn as a plain shell (no command / agentKind)', async ({ page }) => {
    const id = await evalIn<string>(page, 'window.__canvasE2E.seedConfigPendingTerminal()')
    await expect(page.locator('[data-test="new-terminal-dialog"]')).toBeVisible()

    await page.locator('[data-test="new-terminal-cancel"]').click()

    await expect(page.locator('[data-test="new-terminal-dialog"]')).toHaveCount(0)
    expect(await evalIn(page, 'window.__canvasE2E.getConfigPendingId()')).toBeNull()
    const board = await evalIn<{ launchCommand?: string; agentKind?: string }>(
      page,
      `window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(id)})`
    )
    expect(board.launchCommand ?? null).toBeNull()
    expect(board.agentKind ?? null).toBeNull()
  })

  test('command builder composes flags into the command + search filters the options', async ({
    page
  }) => {
    const id = await evalIn<string>(page, 'window.__canvasE2E.seedConfigPendingTerminal()')
    await expect(page.locator('[data-test="command-builder"]')).toBeVisible()

    // Pick a model + a toggle → the command field recomposes (registry order).
    await page.locator('[data-test="opt-model"]').selectOption('opus')
    await page.locator('[data-test="opt-continue"]').click()
    await expect(page.locator('[data-test="new-terminal-command"]')).toHaveValue(
      'claude --model opus -c'
    )

    // Search narrows the option list (the model row drops out; permission stays).
    await page.locator('[data-test="command-builder-search"]').fill('perm')
    await expect(page.locator('[data-test="opt-permission-mode"]')).toBeVisible()
    await expect(page.locator('[data-test="opt-model"]')).toHaveCount(0)

    await page.locator('[data-test="new-terminal-create"]').click()
    await expect(page.locator('[data-test="new-terminal-dialog"]')).toHaveCount(0)
    const board = await evalIn<{ launchCommand?: string; agentKind?: string }>(
      page,
      `window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(id)})`
    )
    expect(board.launchCommand).toBe('claude --model opus -c')
    expect(board.agentKind).toBe('claude')
  })
})
