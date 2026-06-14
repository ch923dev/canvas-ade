import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { evalIn } from './helpers'

/**
 * New Terminal dialog — place-first flow. A user-placed terminal holds its spawn
 * (configPendingId) until the dialog resolves. We seed a held terminal via the e2e
 * hook (real store path), then drive the portaled dialog with real OS clicks (it is a
 * fixed-position modal at scale 1, so plain Playwright clicks hit-test correctly).
 */

// Look up a board by id via a STRUCTURED ARG to page.evaluate — never interpolate the id into an
// eval'd code string (CodeQL js/bad-code-sanitization; the terminalPolish.e2e.ts / #82 convention).
type BoardInfo = { launchCommand?: string; agentKind?: string }
const boardById = (page: Page, id: string): Promise<BoardInfo> =>
  page.evaluate((a) => (globalThis as any).__canvasE2E.getBoards().find((b: any) => b.id === a), id)

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
    const board = await boardById(page, id)
    expect(board.launchCommand).toBe('codex')
    expect(board.agentKind).toBe('codex')
  })

  test('Cancel releases the spawn as a plain shell (no command / agentKind)', async ({ page }) => {
    const id = await evalIn<string>(page, 'window.__canvasE2E.seedConfigPendingTerminal()')
    await expect(page.locator('[data-test="new-terminal-dialog"]')).toBeVisible()

    await page.locator('[data-test="new-terminal-cancel"]').click()

    await expect(page.locator('[data-test="new-terminal-dialog"]')).toHaveCount(0)
    expect(await evalIn(page, 'window.__canvasE2E.getConfigPendingId()')).toBeNull()
    const board = await boardById(page, id)
    expect(board.launchCommand ?? null).toBeNull()
    expect(board.agentKind ?? null).toBeNull()
  })

  test('category tabs group the options; the builder composes flags + search spans all tabs', async ({
    page
  }) => {
    const id = await evalIn<string>(page, 'window.__canvasE2E.seedConfigPendingTerminal()')
    await expect(page.locator('[data-test="command-builder"]')).toBeVisible()

    // Claude's options are split across category tabs. The Setup tab is active by default, so
    // Model is visible but Continue (Session tab) is not — until we switch tabs. Search starts
    // collapsed behind its toggle (one band, not a permanent search bar).
    await expect(page.locator('[data-test="group-setup"]')).toBeVisible()
    await expect(page.locator('[data-test="group-session"]')).toBeVisible()
    await expect(page.locator('[data-test="opt-model"]')).toBeVisible()
    await expect(page.locator('[data-test="opt-continue"]')).toHaveCount(0)
    await expect(page.locator('[data-test="command-builder-search"]')).toHaveCount(0)
    await expect(page.locator('[data-test="command-builder-search-toggle"]')).toBeVisible()

    // Set a model on Setup, then switch to the Session tab to reach Continue. The composed
    // command recomposes in registry order regardless of which tab set each value.
    await page.locator('[data-test="opt-model"]').selectOption('opus')
    await page.locator('[data-test="group-session"]').click()
    await page.locator('[data-test="opt-continue"]').click()
    await expect(page.locator('[data-test="new-terminal-command"]')).toHaveValue(
      'claude --model opus -c'
    )

    // Open search → the tab strip is replaced and the query spans all tabs: 'perm' surfaces the
    // permission option from the Permissions tab while the Setup tab's model row drops out.
    await page.locator('[data-test="command-builder-search-toggle"]').click()
    await page.locator('[data-test="command-builder-search"]').fill('perm')
    await expect(page.locator('[data-test="group-setup"]')).toHaveCount(0)
    await expect(page.locator('[data-test="opt-permission-mode"]')).toBeVisible()
    await expect(page.locator('[data-test="opt-model"]')).toHaveCount(0)

    await page.locator('[data-test="new-terminal-create"]').click()
    await expect(page.locator('[data-test="new-terminal-dialog"]')).toHaveCount(0)
    const board = await boardById(page, id)
    expect(board.launchCommand).toBe('claude --model opus -c')
    expect(board.agentKind).toBe('claude')
  })

  test('edit mode: the ⚙ button opens the same dialog pre-filled; Apply patches the live board', async ({
    page
  }) => {
    // A LIVE (already-spawned) terminal, not a held one — the edit path.
    const patch = JSON.stringify({
      agentKind: 'claude',
      launchCommand: 'claude',
      title: 'My agent'
    })
    const id = await evalIn<string>(page, `window.__canvasE2E.seedBoard('terminal', ${patch})`)
    // Select + fit so the board chrome is visible and on-screen, then open config via ⚙.
    await evalIn(page, `window.__canvasE2E.setSelection([${JSON.stringify(id)}])`)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await page.locator(`[data-test="config-${id}"]`).click()

    const dialog = page.locator('[data-test="new-terminal-dialog"]')
    await expect(dialog).toBeVisible()
    // Edit mode pre-fills the command from the board and the primary action is Apply & restart.
    await expect(page.locator('[data-test="new-terminal-command"]')).toHaveValue('claude')
    await expect(page.locator('[data-test="new-terminal-create"]')).toHaveText('Apply & restart')

    // Edit the command and apply → the live board is patched (which respawns the session).
    await page.locator('[data-test="new-terminal-command"]').fill('claude --model opus')
    await page.locator('[data-test="new-terminal-create"]').click()
    await expect(dialog).toHaveCount(0)
    const board = await boardById(page, id)
    expect(board.launchCommand).toBe('claude --model opus')
    expect(board.agentKind).toBe('claude')
  })

  test('edit mode: Cancel discards the edit; the live board is not patched', async ({ page }) => {
    const patch = JSON.stringify({
      agentKind: 'claude',
      launchCommand: 'claude',
      title: 'My agent'
    })
    const id = await evalIn<string>(page, `window.__canvasE2E.seedBoard('terminal', ${patch})`)
    await evalIn(page, `window.__canvasE2E.setSelection([${JSON.stringify(id)}])`)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await page.locator(`[data-test="config-${id}"]`).click()

    const dialog = page.locator('[data-test="new-terminal-dialog"]')
    await expect(dialog).toBeVisible()
    // Dirty the command, then Cancel: the Modal closes and persists nothing. This is the new
    // contract that replaced the old TerminalConfig unsaved-changes guard (explicit Cancel/Apply).
    await page.locator('[data-test="new-terminal-command"]').fill('codex --full-auto')
    await page.locator('[data-test="new-terminal-cancel"]').click()
    await expect(dialog).toHaveCount(0)
    const board = await boardById(page, id)
    expect(board.launchCommand).toBe('claude')
    expect(board.agentKind).toBe('claude')
  })
})
