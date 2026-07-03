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
import { evalIn, mainCall, pollEval, seed } from './helpers'

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

  // Regression for the PR #232 review finding: a FULL xterm re-spawn (reconfigure
  // shell/cwd/launchCommand) disposes the old SearchAddon; a left-open bar would keep its
  // onDidChangeResults bound to the disposed addon → frozen counter. The fix closes the bar on the
  // spawn cleanup, so it re-subscribes to the fresh addon on reopen.
  test('a full xterm re-spawn (reconfigure) closes an open find bar (no stale subscription)', async ({
    page
  }) => {
    const id = await seedWithBuffer(page)
    const input = page.locator(`${node(id)} [data-test="terminal-find-input"]`)
    const count = page.locator(`${node(id)} [data-test="terminal-find-count"]`)

    await openFind(page, id)
    await input.fill('needle')
    await expect(count).toHaveText('1 / 3')

    // Change launchCommand → the spawn effect re-runs (full xterm + SearchAddon replacement).
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(id)}, { launchCommand: 'exit 0' })`
    )
    await expect(input, 'find bar closes on a full re-spawn').toHaveCount(0)
  })
})

// ── Find-count fix: the two gated/streaming states the static-buffer specs above never cover ──

const live = (id: string): string => `window.__canvasE2E.terminalLive(${JSON.stringify(id)})`
const heldBytes = (id: string): string =>
  `window.__canvasE2E.terminalHeldBytes(${JSON.stringify(id)})`

/** Seed a LIVE shell terminal (unlike seedWithBuffer's dead `exit` PTY) framed in view. */
async function seedLive(page: import('@playwright/test').Page): Promise<string> {
  const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
  await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 10_000)
  await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
  expect(await pollEval(page, `${live(id)} === true`, 4_000), 'terminal live in view').toBe(true)
  await page.waitForTimeout(500) // let the spawn banner finish streaming
  return id
}

test.describe('@terminal find-in-terminal — live/gated buffers (find-count fix)', () => {
  test('the count converges on STREAMING output with no further user input', async ({
    page,
    electronApp
  }) => {
    const id = await seedLive(page)
    const input = page.locator(`${node(id)} [data-test="terminal-find-input"]`)
    const count = page.locator(`${node(id)} [data-test="terminal-find-count"]`)

    await openFind(page, id)
    await expect(input).toBeFocused()
    // Not in the buffer yet — the bar reports an HONEST negative...
    await input.fill('FINDME_STREAM')
    await expect(count).toHaveText('No results')

    // ...then the agent prints it. The addon's write-driven recount must update the open bar
    // without the user touching the query (the pre-fix behavior this spec pins, plus proof the
    // lastFound gating never masks a genuine late match).
    await mainCall(electronApp, 'writeTerminal', id, `echo FINDME_STREAM\r`)
    await expect(count).toHaveText(/\d+ \/ \d+/, { timeout: 8_000 })
  })

  test('REVEAL-LATCH regression: a search right after reveal converges with ZERO further PTY writes', async ({
    page,
    electronApp
  }) => {
    const id = await seedLive(page)
    const input = page.locator(`${node(id)} [data-test="terminal-find-input"]`)
    const count = page.locator(`${node(id)} [data-test="terminal-find-count"]`)

    // Gate the board below LOD; produce the needle while hidden (bytes HELD, not rendered).
    await evalIn(page, `window.__canvasE2E.setZoom(0.3)`)
    expect(await pollEval(page, `${live(id)} === false`, 4_000), 'gated below LOD').toBe(true)
    await mainCall(electronApp, 'writeTerminal', id, `echo FINDME_LATCH\r`)
    expect(
      await pollEval(page, `${heldBytes(id)} > 0`, 8_000),
      'needle bytes are held while gated (the stale-buffer precondition)'
    ).toBe(true)

    // Reveal and IMMEDIATELY search — inside the liveness-settle/rAF window the searched buffer
    // can still lack the needle. Pre-fix, that initial 0 LATCHED until the next PTY output
    // (this spec writes none). The fix converges it: flush-at-open + the one-shot settle
    // re-search recount with no further output.
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await openFind(page, id)
    await input.fill('FINDME_LATCH')
    await expect(count, 'count is exact with no further PTY writes').toHaveText(/\d+ \/ \d+/, {
      timeout: 5_000
    })
    await expect(count).not.toHaveClass(/warn/)
  })
})
