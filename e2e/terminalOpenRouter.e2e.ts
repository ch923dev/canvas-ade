import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { evalIn } from './helpers'

/**
 * @terminal Maintainer-private OpenRouter routing (v20, compile-gated __TERMINAL_OPENROUTER__).
 *
 * The gate is a BUILD constant, so an ungated e2e build DCEs the dialog section out entirely.
 * This spec therefore self-skips when the section is absent (`new-terminal-openrouter` count 0),
 * exactly like the @voicedrill manual-only spec — it runs only against a build made with
 * TERMINAL_OPENROUTER=1 (the maintainer's build; the CI merge-gate matrix is ungated and skips it).
 *
 * When gated it asserts the real product behavior against the running app: the section appears
 * only for capable presets (claude/opencode), toggling it reveals the model field and recomposes
 * the launch command with the routed model flag, the missing-key status row round-trips the real
 * llm:hasKey IPC (fresh e2e key store is empty), and Create persists the additive board field.
 */
type BoardInfo = { launchCommand?: string; openRouter?: { enabled: boolean; model?: string } }
const boardById = (page: Page, id: string): Promise<BoardInfo> =>
  page.evaluate((a) => (globalThis as any).__canvasE2E.getBoards().find((b: any) => b.id === a), id)

// Open the place-first dialog and report whether the gated OpenRouter section is compiled in.
async function openDialogAndProbeGate(page: Page): Promise<string> {
  const id = await evalIn<string>(page, 'window.__canvasE2E.seedConfigPendingTerminal()')
  await expect(page.locator('[data-test="new-terminal-dialog"]')).toBeVisible()
  return id
}

test.describe('@terminal OpenRouter routing (compile-gated, self-skips ungated)', () => {
  test('section shows for claude, hides for shell; toggle reveals model + recomposes command', async ({
    page
  }) => {
    const id = await openDialogAndProbeGate(page)
    const section = page.locator('[data-test="new-terminal-openrouter"]')
    // Ungated build → section stripped → this whole spec is not applicable.
    test.skip((await section.count()) === 0, 'ungated build (__TERMINAL_OPENROUTER__ off)')

    // Default preset is claude (capable) → section present, model field hidden until enabled.
    await expect(section).toBeVisible()
    await expect(page.locator('[data-test="openrouter-model"]')).toHaveCount(0)

    // Shell is not OpenRouter-capable → the section is absent for it.
    await page.locator('[data-test="preset-shell"]').click()
    await expect(section).toHaveCount(0)

    // Back to claude → enable routing → the model field reveals and the missing-key row shows
    // (a fresh e2e key store has no openrouter key; this also proves the llm:hasKey IPC round-trips).
    await page.locator('[data-test="preset-claude"]').click()
    await section.click()
    await expect(page.locator('[data-test="openrouter-model"]')).toBeVisible()
    await expect(page.locator('[data-test="openrouter-key-missing"]')).toBeVisible()

    // Typing a slug recomposes the launch command to route the model flag through OpenRouter.
    await page.locator('[data-test="openrouter-model"]').fill('anthropic/claude-sonnet-4.5')
    await expect(page.locator('[data-test="new-terminal-command"]')).toHaveValue(
      'claude --model anthropic/claude-sonnet-4.5'
    )

    // Create → the additive field persists on the board (the key is NOT on the board — env-only).
    await page.locator('[data-test="new-terminal-create"]').click()
    await expect(page.locator('[data-test="new-terminal-dialog"]')).toHaveCount(0)
    const board = await boardById(page, id)
    expect(board.openRouter).toEqual({ enabled: true, model: 'anthropic/claude-sonnet-4.5' })
    expect(board.launchCommand).toBe('claude --model anthropic/claude-sonnet-4.5')
  })

  test('opencode composes the provider-prefixed model slug', async ({ page }) => {
    const id = await openDialogAndProbeGate(page)
    const section = page.locator('[data-test="new-terminal-openrouter"]')
    test.skip((await section.count()) === 0, 'ungated build (__TERMINAL_OPENROUTER__ off)')

    await page.locator('[data-test="preset-opencode"]').click()
    await section.click()
    await page.locator('[data-test="openrouter-model"]').fill('moonshotai/kimi-k2')
    await expect(page.locator('[data-test="new-terminal-command"]')).toHaveValue(
      'opencode --model openrouter/moonshotai/kimi-k2'
    )

    await page.locator('[data-test="new-terminal-create"]').click()
    const board = await boardById(page, id)
    expect(board.openRouter).toEqual({ enabled: true, model: 'moonshotai/kimi-k2' })
  })

  test('codex composes the four probe-verified provider overrides plus -m', async ({ page }) => {
    const id = await openDialogAndProbeGate(page)
    const section = page.locator('[data-test="new-terminal-openrouter"]')
    test.skip((await section.count()) === 0, 'ungated build (__TERMINAL_OPENROUTER__ off)')

    await page.locator('[data-test="preset-codex"]').click()
    await expect(section).toBeVisible()
    await section.click()
    await page.locator('[data-test="openrouter-model"]').fill('openai/gpt-5-codex')

    // The argv is probe-verified against codex-cli 0.153.4: `name` is required, and NO wire_api
    // (chat/chat_completions break config loading there; responses is the default).
    const expected =
      'codex -c model_provider=openrouter -c model_providers.openrouter.name=OpenRouter ' +
      '-c model_providers.openrouter.base_url=https://openrouter.ai/api/v1 ' +
      '-c model_providers.openrouter.env_key=OPENROUTER_API_KEY -m openai/gpt-5-codex'
    await expect(page.locator('[data-test="new-terminal-command"]')).toHaveValue(expected)

    await page.locator('[data-test="new-terminal-create"]').click()
    const board = await boardById(page, id)
    expect(board.openRouter).toEqual({ enabled: true, model: 'openai/gpt-5-codex' })
    expect(board.launchCommand).toBe(expected)
    // The key is NEVER on the launch line — the overrides only NAME the env var to read.
    expect(board.launchCommand).not.toMatch(/sk-|OPENROUTER_API_KEY=./)
  })

  // 🔒 The routed-shell defect: the section UNMOUNTS for an incapable preset, so routing used to
  // stay ON with no UI left to clear it and Create persisted `enabled: true` on a plain shell —
  // where MAIN then put the decrypted key into an interactive shell's env. Switching away must
  // take the intent with it. (MAIN refuses to route a non-agent launch line either way now; this
  // asserts the persisted doc matches what the user can actually see.)
  test('switching to an incapable preset clears the routing intent', async ({ page }) => {
    const id = await openDialogAndProbeGate(page)
    const section = page.locator('[data-test="new-terminal-openrouter"]')
    test.skip((await section.count()) === 0, 'ungated build (__TERMINAL_OPENROUTER__ off)')

    await section.click()
    await page.locator('[data-test="openrouter-model"]').fill('anthropic/claude-sonnet-4.5')
    await expect(page.locator('[data-test="openrouter-model"]')).toBeVisible()

    // Shell cannot honour a route → the section goes away.
    await page.locator('[data-test="preset-shell"]').click()
    await expect(section).toHaveCount(0)

    // Back on claude the checkbox must read OFF again (the intent went with the preset), not
    // silently-still-on with a hidden model slug.
    await page.locator('[data-test="preset-claude"]').click()
    await expect(section).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('[data-test="openrouter-model"]')).toHaveCount(0)

    // Create from the shell preset persists NO routing field at all.
    await page.locator('[data-test="preset-shell"]').click()
    await page.locator('[data-test="new-terminal-create"]').click()
    await expect(page.locator('[data-test="new-terminal-dialog"]')).toHaveCount(0)
    const board = await boardById(page, id)
    expect(board.openRouter).toBeUndefined()
  })
})
