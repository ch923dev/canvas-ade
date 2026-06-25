// e2e/terminalLinks.e2e.ts
//
// Phase 4 — terminal correctness pack (clickable web-links + Unicode 11).
//
// Two integration edges the unit tests (terminalLinks.test / previewTarget.test / shellIpc.test)
// can't cover, split by what each tool can reliably exercise:
//  1. DETECTION — the WebLinksAddon really linkifies a URL in the live buffer: asserted with a REAL
//     hover (xterm's hover → `_currentLink` fires under synthetic mouse input; the addon's `hover`
//     callback is mirrored to `window.__linkHover`).
//  2. ROUTING — a detected link is routed correctly: driven through the `activateTerminalLink` seam,
//     which calls the EXACT function the addon hands a clicked URI to (modifier gate → Browser-board
//     create/route via the real store, or shell:openExternal via the real IPC). The seam is used
//     because xterm's internal mousedown→mouseup→activate chain does NOT fire under synthetic clicks
//     (a long-standing terminal-mouse-synthesis limitation); the real click gesture is verified in
//     the manual dev check.
//
// Determinism: the board launches `exit` so the PTY drains (no live-shell race; mirrors
// terminalSearch.e2e). MAIN `shell.openExternal` is patched to a recorder so the external path is
// asserted end-to-end (renderer → shell:openExternal IPC → openExternalSafe) WITHOUT launching a
// real OS browser.
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'
import type { Page, ElectronApplication } from '@playwright/test'

const readBuf = (id: string) => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`

/** Browser boards as plain {id,url} (serializable) — the link router's create/route target. */
function browserBoards(page: Page): Promise<{ id: string; url: string }[]> {
  return evalIn(
    page,
    `window.__canvasE2E.getBoards().filter((b) => b.type === 'browser').map((b) => ({ id: b.id, url: b.url }))`
  )
}

/** Seed a terminal and wait for its PTY to drain (so a later buffer write isn't overwritten). */
async function seedDrained(page: Page): Promise<string> {
  const id = await seed(page, 'terminal', { launchCommand: 'exit' })
  await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
  expect(
    await pollEval(page, `(${readBuf(id)} || '').includes('process exited')`, 8000),
    'shell exited (PTY drained)'
  ).toBe(true)
  return id
}

/** Write a known buffer and bring the board on-screen so terminalCellPoint maps to live px. */
async function writeBuffer(
  page: Page,
  id: string,
  content: string,
  sentinel: string
): Promise<void> {
  await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
  await evalIn(
    page,
    `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, ${JSON.stringify(content)})`
  )
  expect(
    await pollEval(page, `(${readBuf(id)} || '').includes(${JSON.stringify(sentinel)})`, 6000),
    'known buffer present'
  ).toBe(true)
}

/** Drive the real web-link activator (the function the addon calls) with a URI + modifier flags. */
function activateLink(
  page: Page,
  id: string,
  uri: string,
  mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
): Promise<unknown> {
  return evalIn(
    page,
    `window.__canvasE2E.activateTerminalLink(${JSON.stringify(id)}, ${JSON.stringify(uri)}, ${JSON.stringify(mods)})`
  )
}

test.describe('@terminal terminal links + unicode11', () => {
  // Patch MAIN shell.openExternal to a recorder: the external path is asserted without ever
  // launching a real OS browser.
  test.beforeEach(async ({ electronApp }) => {
    await electronApp.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opens?: string[] }
      g.__opens = []
      shell.openExternal = async (u: string): Promise<void> => {
        g.__opens!.push(u)
      }
    })
  })

  const opens = (app: ElectronApplication): Promise<string[]> =>
    app.evaluate(() => (globalThis as unknown as { __opens?: string[] }).__opens ?? [])

  test('Unicode 11 is active and a wide-glyph line renders intact', async ({ page }) => {
    const id = await seedDrained(page)
    expect(
      await evalIn(page, `window.__canvasE2E.terminalUnicodeVersion(${JSON.stringify(id)})`)
    ).toBe('11')
    await writeBuffer(page, id, 'CJK 日本語 + emoji 😀🎉 tail', 'tail')
    const buf = await evalIn<string>(page, readBuf(id))
    expect(buf).toContain('日本語')
    expect(buf).toContain('😀')
  })

  test('the WebLinksAddon detects + linkifies a URL in the buffer (real hover)', async ({
    page
  }) => {
    const id = await seedDrained(page)
    await writeBuffer(page, id, 'http://localhost:5199/alpha', 'localhost:5199')
    const p = await evalIn<{ x: number; y: number }>(
      page,
      `window.__canvasE2E.terminalCellPoint(${JSON.stringify(id)}, 8, 0, 0.5, 0.5)`
    )
    // A real hover over the URL cell: xterm resolves the link provider → the addon's hover fires.
    await page.mouse.move(Math.round(p.x) - 6, Math.round(p.y))
    await page.waitForTimeout(40)
    await page.mouse.move(Math.round(p.x), Math.round(p.y))
    expect(
      await pollEval(page, `window.__linkHover === 'http://localhost:5199/alpha'`, 4000),
      'the addon linkified + hovered the URL'
    ).toBe(true)
  })

  test('a localhost link routes to a Browser board; a same-origin link reuses it', async ({
    page
  }) => {
    const id = await seedDrained(page)
    expect((await browserBoards(page)).length, 'no browser board yet').toBe(0)

    await activateLink(page, id, 'http://localhost:5199/alpha', { ctrlKey: true })
    expect(
      await pollEval(
        page,
        `window.__canvasE2E.getBoards().some((b) => b.type === 'browser' && b.url.includes('localhost:5199'))`,
        6000
      ),
      'a Browser board opened on the link'
    ).toBe(true)
    const first = await browserBoards(page)
    expect(first.length, 'exactly one browser board').toBe(1)
    expect(first[0].url).toContain('/alpha')

    // A second link of the SAME origin routes the existing board — no duplicate.
    await activateLink(page, id, 'http://localhost:5199/beta', { ctrlKey: true })
    expect(
      await pollEval(
        page,
        `(window.__canvasE2E.getBoards().find((b) => b.type === 'browser')?.url || '').includes('/beta')`,
        6000
      ),
      'the existing board navigated to the same-origin link'
    ).toBe(true)
    const after = await browserBoards(page)
    expect(after.length, 'still exactly one browser board (reused, not duplicated)').toBe(1)
    expect(after[0].id, 'same board id').toBe(first[0].id)
  })

  test('a remote link opens the OS browser (shell:openExternal), NOT a Browser board', async ({
    page,
    electronApp
  }) => {
    const id = await seedDrained(page)
    await activateLink(page, id, 'https://example.com/docs', { ctrlKey: true })
    await expect
      .poll(() => opens(electronApp), { timeout: 6000 })
      .toContain('https://example.com/docs')
    expect((await browserBoards(page)).length, 'no Browser board for a remote link').toBe(0)
  })

  test('Shift+Ctrl flips a localhost link to the OS browser (no Browser board)', async ({
    page,
    electronApp
  }) => {
    const id = await seedDrained(page)
    await activateLink(page, id, 'http://localhost:5288/flip', { ctrlKey: true, shiftKey: true })
    await expect
      .poll(() => opens(electronApp), { timeout: 6000 })
      .toContain('http://localhost:5288/flip')
    expect((await browserBoards(page)).length, 'Shift flipped local → external, no board').toBe(0)
  })

  test('a plain activation (no modifier) routes nowhere — selection is preserved', async ({
    page,
    electronApp
  }) => {
    const id = await seedDrained(page)
    await activateLink(page, id, 'http://localhost:5199/x', {})
    await activateLink(page, id, 'https://example.com/y', {})
    await page.waitForTimeout(300)
    expect((await browserBoards(page)).length, 'no board from an unmodified activation').toBe(0)
    expect(await opens(electronApp), 'no external open from an unmodified activation').toEqual([])
  })
})
