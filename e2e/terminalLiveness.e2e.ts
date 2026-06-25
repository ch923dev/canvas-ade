// e2e/terminalLiveness.e2e.ts — Lane A terminal render-liveness gating (terminal-crisp umbrella,
// docs/research/2026-06-25-terminal-dom-renderer › Lane A). xterm's DOM renderer draws ALL incoming
// PTY data regardless of whether the board is on-screen (xterm #880). Lane A pauses the RENDER (not
// the PTY) for terminals that are off-screen or below LOD: incoming bytes are HELD by the write
// coalescer (the session keeps running and producing) and flushed losslessly when the board returns
// to view.
//
// These specs drive the REAL PTY (writeTerminal → node-pty → MessagePort → coalescer → xterm) and
// assert the gate end-to-end:
//   1. a below-LOD terminal holds writes (sentinel NOT in the framebuffer) while its held buffer
//      GROWS (PTY alive), then catches up losslessly on reveal;
//   2. the same for an OFF-SCREEN terminal at full zoom (isolates the off-screen gate from LOD).
// `echo <sentinel>` is used (works under pwsh / cmd / bash) so the spec passes on both e2e legs.
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const J = JSON.stringify
const read = (id: string): string => `(window.__canvasE2E.readTerminal(${J(id)}) ?? '')`
const live = (id: string): string => `window.__canvasE2E.terminalLive(${J(id)})`
const held = (id: string): string => `window.__canvasE2E.terminalHeldBytes(${J(id)})`

/** Seed a terminal with a live shell, frame it (on-screen ∧ ≥ LOD ⇒ live), let the banner settle. */
async function seedLiveTerminal(page: Parameters<typeof evalIn>[0]): Promise<string> {
  const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
  await pollEval(page, `window.__canvasE2E.terminalMounted(${J(id)})`, 10_000)
  await evalIn(page, `window.__canvasE2E.fitView(${J(id)})`)
  expect(await pollEval(page, `${live(id)} === true`, 4_000), 'terminal starts live in view').toBe(
    true
  )
  // Let the spawn banner finish streaming so the bytes we later observe held are purely the
  // sentinel produced WHILE hidden (the banner flushed while the terminal was visible).
  await page.waitForTimeout(500)
  return id
}

/** Drive the real PTY to emit a sentinel, assert it is HELD (not rendered) while gated, then
 *  REVEAL and assert it appears (lossless catch-up) and the held buffer drains. `reveal` flips the
 *  gate back to live (zoom up / pan back). */
async function assertHoldThenCatchUp(
  page: Parameters<typeof evalIn>[0],
  electronApp: Parameters<typeof mainCall>[0],
  id: string,
  sentinel: string,
  reveal: () => Promise<void>
): Promise<void> {
  // The PTY keeps producing while the board is gated.
  await mainCall(electronApp, 'writeTerminal', id, `echo ${sentinel}\r`)
  // Its output is HELD (the coalescer's buffer grows — proves the session is alive, not paused) ...
  expect(
    await pollEval(page, `${held(id)} > 0`, 8_000),
    'PTY output is held while the board is gated (session alive)'
  ).toBe(true)
  // ... but NOT rendered: the framebuffer is frozen, so the sentinel is absent from it.
  const gatedText = await evalIn<string>(page, read(id))
  expect(gatedText.includes(sentinel), 'sentinel is NOT rendered while gated').toBe(false)

  // Reveal → the gate flips live → the held buffer flushes losslessly.
  await reveal()
  expect(await pollEval(page, `${live(id)} === true`, 4_000), 'terminal is live again').toBe(true)
  expect(
    await pollEval(page, `${read(id)}.includes(${J(sentinel)})`, 8_000),
    'held output appears after reveal (lossless catch-up)'
  ).toBe(true)
  // The held buffer drained on flush.
  expect(
    await pollEval(page, `${held(id)} === 0`, 4_000),
    'held buffer drains after the flush'
  ).toBe(true)
}

test.describe('@terminal terminal render-liveness gating (xterm #880, Lane A)', () => {
  test('a BELOW-LOD terminal holds PTY writes (session alive), then catches up on reveal', async ({
    page,
    electronApp
  }) => {
    const id = await seedLiveTerminal(page)
    // Hide by zooming below LOD (0.3 < LOD_ZOOM 0.4) — the gate flips false for every terminal.
    await evalIn(page, `window.__canvasE2E.setZoom(0.3)`)
    expect(await pollEval(page, `${live(id)} === false`, 4_000), 'gated below LOD').toBe(true)
    await assertHoldThenCatchUp(page, electronApp, id, 'CANVAS_LIVENESS_LOD_OK', async () => {
      await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    })
  })

  test('an OFF-SCREEN terminal (full zoom) holds writes, then catches up when panned back', async ({
    page,
    electronApp
  }) => {
    const id = await seedLiveTerminal(page)
    // Pan the board fully off the right edge with the zoom UNCHANGED — isolates the off-screen gate
    // from the below-LOD one above (the terminal stays above LOD the whole time).
    await evalIn(page, `window.__canvasE2E.panBy(6000, 0)`)
    expect(
      await pollEval(page, `${live(id)} === false`, 4_000),
      'gated off-screen at full zoom'
    ).toBe(true)
    await assertHoldThenCatchUp(page, electronApp, id, 'CANVAS_LIVENESS_OFFSCREEN_OK', async () => {
      await evalIn(page, `window.__canvasE2E.panBy(-6000, 0)`)
    })
  })

  test('a visible terminal renders PTY output normally (the gate is transparent when live)', async ({
    page,
    electronApp
  }) => {
    // Regression guard: with the coalescer in the hot path, a LIVE terminal must still render real
    // PTY output (now batched per frame, not per chunk) — i.e. Lane A is invisible when on-screen.
    const id = await seedLiveTerminal(page)
    await mainCall(electronApp, 'writeTerminal', id, `echo CANVAS_LIVENESS_VISIBLE_OK\r`)
    expect(
      await pollEval(page, `${read(id)}.includes('CANVAS_LIVENESS_VISIBLE_OK')`, 8_000),
      'live terminal renders PTY output through the coalescer'
    ).toBe(true)
    expect(await evalIn<number>(page, held(id)), 'nothing left held on a live terminal').toBe(0)
  })
})
