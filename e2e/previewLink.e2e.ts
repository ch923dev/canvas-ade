import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  evalIn,
  mainCall,
  openInspectorSection,
  pollEval,
  seed,
  selectForInspector
} from './helpers'

const DETECTED_URL = 'http://localhost:3000'

/**
 * Slice C′ preview link, P5 controls: the title-bar globe (tap / long-press / right-click
 * gestures) is gone — the Inspector › Linking actions drive the SAME routeUrl handlers:
 *   • "Choose target…"  = the old long-press ('hold' gesture) → the multi-select connect picker;
 *   • "Push to preview" = the old tap → refresh the linked browser(s) directly, NO picker.
 * The picker itself still renders inside the terminal node (.ca-port-picker), so its internals
 * are driven DOM-side (occlusion-immune, the pre-P5 pattern); only the screen-space Inspector
 * actions get real Playwright clicks. Seeded ids cross into page context as STRUCTURED ARGS to
 * page.evaluate — never interpolated into eval'd code (CodeQL js/bad-code-sanitization, #82).
 */

/** The connect picker's live state inside a terminal node (id flows as a DATA arg). */
function pickerState(
  page: Page,
  termId: string
): Promise<{ open: boolean; title: boolean; count: number }> {
  return page.evaluate((id) => {
    const d = (globalThis as any).document
    const node = d.querySelector(`.react-flow__node[data-id="${id}"]`)
    const p = node && node.querySelector('.ca-port-picker')
    return {
      open: !!p,
      title: !!p && p.textContent.includes('Push to which browser'),
      count: p ? p.querySelectorAll('.ca-browser-choice input').length : 0
    }
  }, termId)
}

/** The linked-browser state (previewSourceId + url) of a browser board (id as a DATA arg). */
function linkRead(page: Page, browserId: string): Promise<{ source: string | null; url: string }> {
  return page.evaluate((id) => {
    const b = (globalThis as any).__canvasE2E.getBoards().find((x: { id: string }) => x.id === id)
    return {
      source: b && b.type === 'browser' ? (b.previewSourceId ?? null) : null,
      url: b && b.type === 'browser' ? b.url : ''
    }
  }, browserId)
}

test.describe('@preview terminal → browser preview link (live port-detect + action routing)', () => {
  test('Choose target opens the connect picker; Connect links; Push to preview refreshes (no picker)', async ({
    page,
    electronApp
  }) => {
    const termId = await seed(page, 'terminal', { launchCommand: 'echo link', w: 360 })
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(termId)})`)
    await mainCall(electronApp, 'writeTerminal', termId, 'echo http://localhost:3000/\r')
    const urlSeen = await pollEval(
      page,
      `(() => { const t = window.__canvasE2E.readTerminal(${JSON.stringify(termId)}); return typeof t === 'string' && t.includes('localhost:3000'); })()`,
      8000
    )
    expect(urlSeen, 'dev-server URL echoed into the terminal').toBe(true)

    // Reveal the Inspector for the terminal; Linking starts collapsed.
    await selectForInspector(page, termId)
    await openInspectorSection(page, 'Linking')

    // "Choose target…" = the old hold gesture → the multi-select picker over the candidates.
    await page.locator('[data-test="inspector-choose-target"]').click()
    await expect
      .poll(() => pickerState(page, termId).then((s) => s.open), { timeout: 6000 })
      .toBe(true)
    const opened = await pickerState(page, termId)
    expect(opened.title, 'picker asks which browser to push to').toBe(true)
    expect(opened.count, 'seeded browser + "+ New browser" choices').toBeGreaterThanOrEqual(2)

    // Check the first (existing-browser) choice and Connect → wires the link + pushes the url.
    await page.evaluate(async (id) => {
      const d = (globalThis as any).document
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      const node = d.querySelector(`.react-flow__node[data-id="${id}"]`)
      const p = node && node.querySelector('.ca-port-picker')
      const first = p && p.querySelector('.ca-browser-choice input')
      if (first) {
        first.click()
        await sleep(60)
        const c = p.querySelector('.ca-browser-connect')
        if (c) c.click()
      }
    }, termId)
    await expect
      .poll(() => pickerState(page, termId).then((s) => s.open), {
        timeout: 4000,
        message: 'picker closes on Connect'
      })
      .toBe(false)
    await expect
      .poll(() => linkRead(page, browserId).then((l) => l.source), {
        timeout: 4000,
        message: 'link wired'
      })
      .toBe(termId)
    expect((await linkRead(page, browserId)).url).toBe(DETECTED_URL)

    // "Push to preview" = the old tap: with a linked browser it refreshes directly — NO picker.
    // Connect selects the pushed browser (its Inspector takes the slot), so re-select the
    // terminal to get its Linking actions back.
    await selectForInspector(page, termId)
    await openInspectorSection(page, 'Linking')
    await page.locator('[data-test="inspector-push-preview"]').click()
    await page.waitForTimeout(700)
    expect(
      (await pickerState(page, termId)).open,
      'push with a linked browser never opens the picker'
    ).toBe(false)
    const after = await linkRead(page, browserId)
    expect(after.source).toBe(termId)
    expect(after.url).toBe(DETECTED_URL)
  })
})
