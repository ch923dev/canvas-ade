import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'

/**
 * Recap redesign S1: the flip-to-recap proofs against the two-zone face.
 *
 * The rebuilt RecapView renders a `recap:get` bundle - live LOCAL facts + the structured
 * narrative sidecar (`board-<id>.recap.json`) - instead of parsing the board markdown. The
 * narrative tests seed the sidecar MAIN-side via the CANVAS_E2E-gated
 * `__canvasE2EMain.writeRecapJson` (the md-era `writeRecapMd` path still feeds the
 * DigestPanel, but the face no longer reads it). The facts test seeds a fixture transcript
 * under a throwaway CLAUDE_CONFIG_DIR (`seedRecapTranscript`) and proves the zero-LLM
 * Layer-0 path: status word, chips, and last-ask render with NO key and NO canned prose.
 *
 * Isolation: explicit createTempProject + finally-teardown, same pattern as recovery.e2e.ts.
 */

/** Beat timestamp built from LOCAL time components so the asserted HH:MM label is TZ-safe. */
const BEAT_TS = new Date(2026, 5, 13, 14, 32).getTime()

// A canned CURRENT narrative. `asOf` is stamped fresh per call: the rebuilt RecapView hides a
// narrative whose asOf trails the live session activity (the staleness guard), and the seeded
// board's PTY pushes facts.lastActivity to ~now — so a fixed past asOf would be suppressed.
// Beats keep the fixed BEAT_TS so the asserted HH:MM label stays timezone-stable.
const mkNarrative = (): {
  now: string
  next: string
  beats: { ts: number; text: string; role: 'agent' }[]
  asOf: number
} => ({
  now: 'Reviewing auth; resume -> refresh-token',
  next: 'Approve the refresh-token rotation plan',
  beats: [{ ts: BEAT_TS, text: 'review auth', role: 'agent' }],
  asOf: Date.now()
})

test('@terminal flip shows the two-zone recap for a terminal board', async ({
  page,
  electronApp
}) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'recap-e2e-', 'recap-e2e')
  try {
    const id = await seed(page, 'terminal', { launchCommand: 'claude', agentTranscriptPath: 'x' })
    const wrote = await mainCall<boolean>(electronApp, 'writeRecapJson', id, mkNarrative())
    expect(wrote, 'canned narrative sidecar persisted to the temp project .canvas/memory/').toBe(
      true
    )

    await page.locator(`[data-test="flip-${id}"]`).click()
    await expect(page.locator('[data-test="recap-now"]')).toContainText('Reviewing auth')
    await expect(page.locator('[data-test="recap-next"]')).toContainText('refresh-token rotation')
    await expect(page.locator('[data-test="recap-beat"]')).toContainText('14:32')
    await expect(page.locator('[data-test="recap-beat"]')).toContainText('review auth')
    // The status header renders from LOCAL facts (the exact word depends on whether the
    // seeded board's PTY spawned in this env - the facts test below pins it instead).
    await expect(page.locator('[data-test="recap-status"]')).toBeVisible()
  } finally {
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})

/**
 * Double-click flip: double-clicking the terminal flips it to the recap (overriding React
 * Flow's node-double-click focus), and double-clicking the recap flips it back. Proves the
 * onDoubleClick trigger + the fold animation settle (the recap overlay actually mounts and
 * later unmounts). We offset the first double-click off-center so it lands on the terminal
 * surface, not the centered idle "Start" button (double-clicks on buttons are guarded out).
 */
test('@terminal double-click flips a terminal to its recap and back', async ({
  page,
  electronApp
}) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'recap-dbl-', 'recap-dbl')
  try {
    const id = await seed(page, 'terminal', { launchCommand: 'claude', agentTranscriptPath: 'x' })
    const wrote = await mainCall<boolean>(electronApp, 'writeRecapJson', id, mkNarrative())
    expect(wrote, 'canned narrative sidecar persisted to the temp project .canvas/memory/').toBe(
      true
    )

    const node = page.locator(`.react-flow__node[data-id="${id}"]`)
    const recap = page.locator('[data-test="recap-view"]')

    // Double-click the terminal surface (off-center, away from the title-bar + Start button)
    // -> flips to the recap. expect() auto-waits through the ~300ms fold.
    await node.dblclick({ position: { x: 40, y: 80 } })
    await expect(page.locator('[data-test="recap-now"]')).toContainText('Reviewing auth')

    // Double-click the recap face -> flips back; the recap overlay unmounts.
    await recap.dblclick()
    await expect(recap).toHaveCount(0)
  } finally {
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})

/**
 * Layer-0 proof: with NO LLM key and NO canned narrative, the flip face still renders the
 * session facts computed locally from a fixture transcript - the waiting-on-you status word
 * (the fixture ends on an assistant question), the session title (ai-title record), the
 * CHANGED/COMMANDS chips (tool_use records), and the last-ask footer. Runs LAST in this
 * file: seedRecapTranscript repoints process.env.CLAUDE_CONFIG_DIR for the app instance
 * (harmless to the other tests - their 'x' transcript paths are untrusted either way).
 */
test('@terminal facts render from the transcript with no LLM key', async ({
  page,
  electronApp
}) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'recap-facts-', 'recap-f')
  try {
    const jsonl =
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-13T04:10:00.000Z',
          message: { role: 'user', content: 'tidy the docs' }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-13T04:11:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'Edit', input: { file_path: 'Z:/repo/CLAUDE.md' } },
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'ls', description: 'List files' }
              }
            ]
          }
        }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Tidy the docs' }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-13T04:12:00.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Should I delete the stray screenshots?' }]
          }
        })
      ].join('\n') + '\n'
    const transcript = await mainCall<string>(electronApp, 'seedRecapTranscript', jsonl)
    const id = await seed(page, 'terminal', { launchCommand: 'claude' })
    // Register the board->transcript mapping through the PRODUCTION learned path (the
    // session-map append the real recordSession.js hook performs); in e2e the renderer has
    // no open project, so the board-doc field never reaches the on-disk canvas.json.
    await mainCall(electronApp, 'recordRecapSession', id, transcript)

    // watchRecapMap absorbs the append on a debounce; poll the same recap:get the face
    // uses until the learned path lands and the facts see the fixture turns.
    await expect
      .poll(
        () =>
          evalIn<number>(
            page,
            `window.api.recap.get(${JSON.stringify(id)}).then((b) => (b ? b.facts.turns.user + b.facts.turns.agent : 0))`
          ),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0)

    await page.locator(`[data-test="flip-${id}"]`).click()
    await expect(page.locator('[data-test="recap-status"]')).toContainText('waiting on you')
    await expect(page.locator('[data-test="recap-title"]')).toContainText('Tidy the docs')
    await expect(page.locator('[data-test="recap-facts-only"]')).toContainText('No narrative yet')
    const chips = page.locator('[data-test="recap-chips"]')
    await expect(chips).toContainText('CLAUDE.md')
    await expect(chips).toContainText('List files')
    await expect(page.locator('[data-test="recap-lastask"]')).toContainText('tidy the docs')
  } finally {
    // Restore the CLAUDE_CONFIG_DIR seedRecapTranscript mutated, so the throwaway fixture root
    // can't leak into a later e2e file and untrust its real-transcript paths (N1).
    await mainCall(electronApp, 'restoreClaudeConfigDir')
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})
