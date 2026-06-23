// e2e/terminalSearch.e2e.ts
//
// Phase 2 — find-in-terminal (Ctrl/Cmd+F). Drives the REAL pipeline: a synthetic Ctrl+F on the
// xterm helper-textarea routes through attachCustomKeyEventHandler → terminalKeymap's `find` action
// → useTerminalSpawn's `find` effect → the bar mounts; typing runs @xterm/addon-search via
// TerminalFindBar and the match count comes from the addon's onDidChangeResults. This is the
// integration the unit tests (pure helpers) cannot cover.
//
// Determinism: the board launches `exit`, so the PTY dies and emits no more bytes; we wait for the
// "[process exited]" marker, then resetTerminalWrite a known buffer. No live-shell race.
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

// needle ×3 (all lowercase) · "Foo"+"foo" → 2 case-insensitive / 1 case-sensitive · no "zzzzz".
const CONTENT = [
  'L0 needle alpha',
  'L1 plain',
  'L2 needle beta',
  'L3 Foo and foo',
  'L4 needle gamma'
].join('\r\n')

const readBuf = (id: string) => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
const node = (id: string) => `.react-flow__node[data-id="${id}"]`

async function seedWithBuffer(page: import('@playwright/test').Page): Promise<string> {
  const id = await seed(page, 'terminal', { launchCommand: 'exit' })
  await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
  expect(
    await pollEval(page, `(${readBuf(id)} || '').includes('process exited')`, 8000),
    'shell exited (PTY drained)'
  ).toBe(true)
  await evalIn(
    page,
    `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, ${JSON.stringify(CONTENT)})`
  )
  expect(
    await pollEval(page, `(${readBuf(id)} || '').includes('needle gamma')`, 6000),
    'known buffer present'
  ).toBe(true)
  return id
}

// Open the find bar through the real key path (not a state poke) so the keymap wiring is exercised.
async function openFind(page: import('@playwright/test').Page, id: string): Promise<void> {
  await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
  await evalIn(
    page,
    `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: 'f', ctrlKey: true })`
  )
}

test.describe('@terminal find-in-terminal (Ctrl+F)', () => {
  test('Ctrl+F opens the bar; the count tracks matches; Enter advances + wraps; Esc closes', async ({
    page
  }) => {
    const id = await seedWithBuffer(page)
    const input = page.locator(`${node(id)} [data-test="terminal-find-input"]`)
    const count = page.locator(`${node(id)} [data-test="terminal-find-count"]`)

    await openFind(page, id)
    await expect(input, 'Ctrl+F opened + focused the find input').toBeFocused()

    // Type-ahead: 3 lowercase "needle" matches → "1 / 3" (case-insensitive by default).
    await input.fill('needle')
    await expect(count).toHaveText('1 / 3')

    // Enter steps forward; a 3rd Enter wraps back to the first match.
    await input.press('Enter')
    await expect(count).toHaveText('2 / 3')
    await input.press('Enter')
    await expect(count).toHaveText('3 / 3')
    await input.press('Enter')
    await expect(count, 'wraps past the last match').toHaveText('1 / 3')

    // Esc closes the bar and returns focus to xterm (the input detaches from the DOM).
    await input.press('Escape')
    await expect(input).toHaveCount(0)
  })

  test('match-case toggle narrows results; an unmatched query shows "No results"', async ({
    page
  }) => {
    const id = await seedWithBuffer(page)
    const input = page.locator(`${node(id)} [data-test="terminal-find-input"]`)
    const count = page.locator(`${node(id)} [data-test="terminal-find-count"]`)

    await openFind(page, id)
    await expect(input).toBeFocused()

    // "foo" case-insensitive matches "Foo" + "foo" → 2.
    await input.fill('foo')
    await expect(count).toHaveText('1 / 2')

    // Match-case ON → only the lowercase "foo" → 1.
    await page.locator(`${node(id)} button[title="Match case"]`).click()
    await expect(count).toHaveText('1 / 1')

    // An unmatched query → warn-toned "No results".
    await input.fill('zzzzz')
    await expect(count).toHaveText('No results')
    await expect(count).toHaveClass(/warn/)
  })
})
