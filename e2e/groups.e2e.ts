import { test, expect } from './fixtures'
import { evalIn, pollEval } from './helpers'

test.describe('named board groups — Ctrl+G create flow', () => {
  test('Ctrl+G on a 2-board selection mints a group + renders its box tab', async ({ page }) => {
    // 1. Clean canvas (fixtures.page resets before each test) — start from zero.
    expect(await evalIn<number>(page, `window.__canvasE2E.getBoards().length`)).toBe(0)
    expect(await evalIn<number>(page, `window.__canvasE2E.getGroups().length`)).toBe(0)

    // 2. Seed two boards (returns ids).
    const ids = await evalIn<[string, string]>(
      page,
      `(() => {
        const a = window.__canvasE2E.seedBoard('terminal')
        const b = window.__canvasE2E.seedBoard('planning')
        return [a, b]
      })()`
    )
    expect(ids).toHaveLength(2)

    // 3. Select both (the group-create path reads selectedIds).
    await evalIn(page, `window.__canvasE2E.setSelection(${JSON.stringify(ids)})`)
    expect(await evalIn<number>(page, `window.__canvasE2E.getGroups().length`)).toBe(0)

    // 4. The FAB appears once >=2 boards are selected.
    expect(await pollEval(page, `!!document.querySelector('.group-fab')`, 2000)).toBe(true)

    // 5. Fire the REAL keybinding (window keydown listener; no window-edge focus needed).
    await page.keyboard.press('Control+g')

    // 6. Exactly one group, containing both seeded ids.
    expect(await pollEval(page, `window.__canvasE2E.getGroups().length === 1`, 3000)).toBe(true)
    const g = await evalIn<{ name: string; boardIds: string[] }>(
      page,
      `(() => { const x = window.__canvasE2E.getGroups()[0]; return { name: x.name, boardIds: x.boardIds }; })()`
    )
    expect(g.boardIds).toEqual(expect.arrayContaining(ids))
    expect(g.name).toBe('Group 1') // first auto-name

    // 7. The S2 GroupBoxLayer rendered exactly one box tab for the new group.
    await expect(page.locator('.group-box-tab')).toHaveCount(1)
  })

  test('typing a name + Enter commits the rename; the box tab shows it', async ({ page }) => {
    // Seed two, select, Ctrl+G → the name popover opens auto-focused over the selection.
    const ids = await evalIn<[string, string]>(
      page,
      `(() => [window.__canvasE2E.seedBoard('terminal'), window.__canvasE2E.seedBoard('planning')])()`
    )
    await evalIn(page, `window.__canvasE2E.setSelection(${JSON.stringify(ids)})`)
    await page.keyboard.press('Control+g')

    const input = page.locator('.group-name-input')
    await expect(input).toBeVisible()
    await input.fill('Auth')
    await expect(input).toHaveValue('Auth')
    await input.press('Enter')

    // Popover closes; the group's name is the typed value (renameGroup committed).
    await expect(input).toHaveCount(0)
    expect(await pollEval(page, `window.__canvasE2E.getGroups()[0]?.name === 'Auth'`, 2000)).toBe(
      true
    )
    await expect(page.locator('.group-box-tab')).toHaveText('Auth')
  })

  test('Esc in the popover cancels the rename and keeps the auto-name', async ({ page }) => {
    const ids = await evalIn<[string, string]>(
      page,
      `(() => [window.__canvasE2E.seedBoard('terminal'), window.__canvasE2E.seedBoard('planning')])()`
    )
    await evalIn(page, `window.__canvasE2E.setSelection(${JSON.stringify(ids)})`)
    await page.keyboard.press('Control+g')

    const input = page.locator('.group-name-input')
    await expect(input).toBeVisible()
    // Type a throwaway name, then Esc — the doneRef guard must stop the unmount blur from
    // committing it, so the group keeps the auto-name minted at create time.
    await input.fill('Throwaway')
    await page.keyboard.press('Escape')

    await expect(input).toHaveCount(0)
    expect(await pollEval(page, `window.__canvasE2E.getGroups().length === 1`, 2000)).toBe(true)
    expect(await evalIn<string>(page, `window.__canvasE2E.getGroups()[0].name`)).toBe('Group 1')
  })

  test('focus fits one group directly (no picker) and opens the picker for many', async ({
    page
  }) => {
    // Seed 4 boards, mint ONE group → bare `f` fits it directly, no picker.
    const ids = await evalIn<string[]>(
      page,
      `(() => {
        const t = window.__canvasE2E
        const a = t.seedBoard('planning'), b = t.seedBoard('planning')
        const c = t.seedBoard('planning'), d = t.seedBoard('planning')
        t.addGroup('Auth', [a, b])
        return [a, b, c, d]
      })()`
    )
    expect(ids).toHaveLength(4)
    expect(await evalIn<number>(page, `window.__canvasE2E.getGroups().length`)).toBe(1)

    await page.keyboard.press('f')
    // One group → fit directly, the picker must NOT appear.
    await expect(page.locator('.group-pick-pop')).toHaveCount(0)

    // Mint a SECOND group → bare `f` now opens the which-group picker.
    await evalIn(
      page,
      `window.__canvasE2E.addGroup('API', [${JSON.stringify(ids[2])}, ${JSON.stringify(ids[3])}])`
    )
    expect(await pollEval(page, `window.__canvasE2E.getGroups().length === 2`, 2000)).toBe(true)

    await page.keyboard.press('f')
    await expect(page.locator('.group-pick-pop')).toHaveCount(1)
    // The picker lists one row per group.
    await expect(page.locator('.group-pick-row')).toHaveCount(2)

    // Picking a row closes the picker (and fits that group).
    await page.locator('.group-pick-row').first().click()
    await expect(page.locator('.group-pick-pop')).toHaveCount(0)
  })
})
