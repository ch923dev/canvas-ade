import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * D3-A note tint picker — the real-app slivers jsdom can't prove: a real-OS
 * right-click travelling through the well's hit-test into the Menu-shell portal,
 * and the hover swatch pill which only reveals via genuine CSS :hover (synthetic
 * dispatch never triggers it — memory e2e-sendinputevent-vs-dispatchevent).
 * The transform/undo contract is pinned in elements.test.ts +
 * PlanningBoard.interaction.test.tsx.
 *
 * Board/note ids flow as DATA through structured-arg page.evaluate, never
 * interpolated into eval'd code strings (CodeQL js/bad-code-sanitization — the
 * #82/#114 pattern).
 */
const tintOf = (page: Page, planId: string, noteId: string): Promise<string | undefined> =>
  page.evaluate(
    ([bid, nid]) => {
      const boards = (globalThis as any).__canvasE2E.getBoards() as {
        id: string
        type: string
        elements?: { id: string; tint?: string }[]
      }[]
      const b = boards.find((x) => x.id === bid)
      return b?.type === 'planning' ? b.elements?.find((e) => e.id === nid)?.tint : undefined
    },
    [planId, noteId] as const
  )

async function seedNote(page: Page): Promise<string> {
  const planId = await seed(page, 'planning')
  await page.evaluate((bid) => {
    ;(globalThis as any).__canvasE2E.patchBoard(bid, {
      elements: [
        {
          id: 'tn-1',
          kind: 'note',
          x: 40,
          y: 40,
          w: 156,
          h: 96,
          tint: 'yellow',
          text: 'A',
          rotation: 0
        }
      ]
    })
  }, planId)
  await evalIn(page, 'window.__canvasE2E.fitView()')
  await page.waitForTimeout(300)
  return planId
}

test.describe('@planning note tint picker (real OS input)', () => {
  test('right-click note → Tint swatch recolors it; ONE undo restores', async ({ page }) => {
    const planId = await seedNote(page)
    expect(await tintOf(page, planId, 'tn-1')).toBe('yellow')

    await page.locator(`[data-id="${planId}"] .pl-note`).click({ button: 'right' })
    const swatch = page.getByTestId('w3-menu-tint-green')
    await expect(swatch, 'Tint row swatch in the context menu').toBeVisible()
    await swatch.click()

    await expect.poll(() => tintOf(page, planId, 'tn-1')).toBe('green')
    await evalIn(page, 'window.__canvasE2E.undo()')
    await expect
      .poll(() => tintOf(page, planId, 'tn-1'), { message: 'one undo restores the tint' })
      .toBe('yellow')
  })

  test('hover reveals the swatch pill; a dot click recolors; ONE undo restores', async ({
    page
  }) => {
    const planId = await seedNote(page)
    const pill = page.locator(`[data-id="${planId}"] .pl-tint-pill`)

    // Hidden (opacity 0 + pointer-events none) until a REAL hover lands on the card.
    expect(
      await pill.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).opacity)
    ).toBe('0')
    await page.locator(`[data-id="${planId}"] .pl-note`).hover()
    await expect
      .poll(
        () => pill.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).opacity),
        {
          message: 'pill fades in on hover'
        }
      )
      .toBe('1')

    await page.getByTestId('pl-tint-blue').click()
    await expect.poll(() => tintOf(page, planId, 'tn-1')).toBe('blue')
    await evalIn(page, 'window.__canvasE2E.undo()')
    await expect
      .poll(() => tintOf(page, planId, 'tn-1'), { message: 'one undo restores the tint' })
      .toBe('yellow')
  })

  // S5 token promotion: the note tint hex moved out of tints.ts into named --note-*
  // CSS tokens (index.css), referenced via var(). jsdom can't resolve custom
  // properties, so this real-Chromium check is the only proof the indirection still
  // paints the exact same colour ("renders identically — no visual diff").
  test('note tints render to their exact --note-* token colours (S5 promotion)', async ({
    page
  }) => {
    const planId = await seedNote(page)
    const bgColorOf = (): Promise<string> =>
      page
        .locator(`[data-id="${planId}"] .pl-note`)
        .evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).backgroundColor)
    // hex → rgb: index.css --note-* tokens; plain falls back to --surface-raised (#1a1a1d).
    const EXPECT: Record<string, string> = {
      yellow: 'rgb(42, 40, 24)', // #2a2818
      blue: 'rgb(22, 32, 43)', // #16202b
      green: 'rgb(22, 36, 29)', // #16241d
      plain: 'rgb(26, 26, 29)' // --surface-raised
    }
    for (const [tint, rgb] of Object.entries(EXPECT)) {
      await page.evaluate(
        ([bid, t]) => {
          ;(globalThis as any).__canvasE2E.patchBoard(bid, {
            elements: [
              {
                id: 'tn-1',
                kind: 'note',
                x: 40,
                y: 40,
                w: 156,
                h: 96,
                tint: t,
                text: 'A',
                rotation: 0
              }
            ]
          })
        },
        [planId, tint] as const
      )
      await expect.poll(bgColorOf, { message: `${tint} note resolves to ${rgb}` }).toBe(rgb)
    }
  })
})
