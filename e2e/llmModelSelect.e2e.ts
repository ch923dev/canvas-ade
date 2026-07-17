import { test, expect } from './fixtures'
import { mainCall } from './helpers'

/**
 * Settings › Context·LLM model combobox — the full renderer↔MAIN round-trip with ZERO egress:
 * `setLlmMock` flips CANVAS_LLM_MOCK at runtime so `llm:models:list` serves the deterministic
 * mock catalog (llmModelsCatalog.mockModels — the provider default + mock/model-a/b). Proves:
 * open Settings → Agents & AI → the Model field opens a list on click → rows render id + ctx +
 * tools chips → picking a row fills the input and closes the list → free text still types over
 * a picked value (the combobox never blocks custom ids).
 */

test('@chrome settings: model combobox lists the catalog, picks a model, keeps free text', async ({
  page,
  electronApp
}) => {
  await mainCall(electronApp, 'setLlmMock', true)
  try {
    await page.click('[title="Settings"]')
    await expect(page.locator('[data-test="settings-panel"]')).toBeVisible()
    await page.click('[data-test="settings-tab-agents"]')
    await expect(page.locator('[data-test="settings-section-llm"]')).toBeVisible()

    // Click the Model field → the dropdown opens and the mock catalog renders (lazy fetch).
    const model = page.locator('[aria-label="Model"]')
    await model.click()
    const list = page.locator('[data-test="model-combobox-list"]')
    await expect(list).toBeVisible()
    const row = page.locator('[data-test="model-option-mock/model-a"]')
    await expect(row).toBeVisible()
    await expect(row).toContainText('128K ctx')
    await expect(row).toContainText('⚒ tools')

    // Pick it: the input takes the id, the list closes.
    await row.click()
    await expect(model).toHaveValue('mock/model-a')
    await expect(list).toHaveCount(0)

    // Free text is never blocked: typing a custom id over the pick sticks.
    await model.fill('my-org/custom-model')
    await expect(model).toHaveValue('my-org/custom-model')
    // Esc closes the (typing-reopened) LIST only — one Esc, one layer: the Settings panel
    // must survive it (the combobox consumes the key before the Modal's window handler).
    await page.keyboard.press('Escape')
    await expect(model).toHaveValue('my-org/custom-model')
    await expect(list).toHaveCount(0)
    await expect(page.locator('[data-test="settings-panel"]')).toBeVisible()

    // Close Settings so no scrim leaks into a sibling spec (the menuShell finding).
    await page.click('[data-test="settings-close"]')
    await expect(page.locator('[data-test="settings-panel"]')).toHaveCount(0)
  } finally {
    await mainCall(electronApp, 'setLlmMock', false)
  }
})
