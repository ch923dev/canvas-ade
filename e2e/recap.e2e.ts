import { test, expect } from './fixtures'
import { evalIn, mainCall, seed, selectForInspector } from './helpers'

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

    // P5: the title-bar flip button is gone — flip via Inspector › Session › View recap.
    await selectForInspector(page, id)
    await page.locator('[data-test="inspector-recap"]').click()
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
        // Recap enrichment: a TodoWrite (plan progress) + a failed tool_result (errors line) —
        // both BEFORE the final assistant question so the waiting-on-you status stays pinned.
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-13T04:11:20.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'TodoWrite',
                input: {
                  todos: [
                    { content: 'review docs', status: 'completed', activeForm: 'Reviewing docs' },
                    {
                      content: 'tidy structure',
                      status: 'in_progress',
                      activeForm: 'tidying structure'
                    },
                    { content: 'delete strays', status: 'pending', activeForm: 'Deleting strays' }
                  ]
                }
              }
            ]
          }
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-13T04:11:30.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't-err',
                content: 'EBUSY: rename locked',
                is_error: true
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

    // P5: flip via the Inspector (the title-bar flip button is gone).
    await selectForInspector(page, id)
    await page.locator('[data-test="inspector-recap"]').click()
    await expect(page.locator('[data-test="recap-status"]')).toContainText('waiting on you')
    await expect(page.locator('[data-test="recap-title"]')).toContainText('Tidy the docs')
    await expect(page.locator('[data-test="recap-facts-only"]')).toContainText('No narrative yet')
    const chips = page.locator('[data-test="recap-chips"]')
    await expect(chips).toContainText('CLAUDE.md')
    await expect(chips).toContainText('List files')
    // Recap enrichment: the Plan row (from the TodoWrite) + the errors line (from the
    // is_error tool_result) render from the same zero-LLM Layer-0 pass.
    const plan = page.locator('[data-test="recap-plan"]')
    await expect(plan).toContainText('1/3')
    await expect(plan).toContainText('tidying structure')
    const errors = page.locator('[data-test="recap-errors"]')
    await expect(errors).toContainText('1 tool error')
    await expect(errors).toContainText('EBUSY: rename locked')
    await expect(page.locator('[data-test="recap-lastask"]')).toContainText('tidy the docs')
  } finally {
    // Restore the CLAUDE_CONFIG_DIR seedRecapTranscript mutated, so the throwaway fixture root
    // can't leak into a later e2e file and untrust its real-transcript paths (N1).
    await mainCall(electronApp, 'restoreClaudeConfigDir')
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})

/**
 * Recap-refresh fix (a): a refresh that cannot regenerate must SAY WHY instead of silently
 * leaving the stale banner. Seed a stale narrative (asOf far behind the live PTY activity),
 * flip - the once-per-flip auto-refresh fires against the key-less e2e LLM store - and the
 * llm-unavailable outcome renders the "needs an LLM key" note. Fully deterministic: no key,
 * no egress, no canned prose.
 */
test('@terminal stale recap + no LLM key: refresh surfaces the why-note', async ({
  page,
  electronApp
}) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'recap-note-', 'recap-n')
  try {
    // Decide consent BEFORE the renderer binds the project: AppChrome prompts (a scrim that
    // would swallow every later click) off getConsent on each projectDir change, so the
    // decision must already be persisted when the open effect fires. MAIN's current dir is
    // already the temp project (createTempProject), so the store keys correctly. Consent
    // state doesn't matter to THIS spec (the key-less LLM gate fires before any write).
    await evalIn<{ ok: boolean }>(page, `window.api.recap.setConsent('enabled')`)
    // ...and the SEPARATE orchestration consent (its 'enable' prompt fires once recap
    // consent is decided - another scrim that would swallow the Inspector clicks).
    await evalIn<{ ok: boolean }>(page, `window.api.orchestration.setConsent('declined')`)
    // Bind the RENDERER to the temp project and flush the seeded board into canvas.json —
    // summaryLoop.run() re-reads the doc from disk, so an unsaved board would report
    // skipped{board-missing} (a legit-null note) instead of exercising the LLM gate.
    const opened = await evalIn<{ status: string }>(
      page,
      `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`
    )
    expect(opened.status, 'fresh temp project opens clean').toBe('open')
    const id = await seed(page, 'terminal', { launchCommand: 'claude', agentTranscriptPath: 'x' })
    const saved = await evalIn<boolean>(
      page,
      `window.api.project.save(JSON.parse(window.__canvasE2E.serializeDoc()), ${JSON.stringify(tmp)})`
    )
    expect(saved, 'seeded board flushed to canvas.json').toBe(true)
    const stale = mkNarrative()
    stale.asOf = Date.now() - 10 * 60_000 // trails the live PTY activity by ~10m -> stale
    const wrote = await mainCall<boolean>(electronApp, 'writeRecapJson', id, stale)
    expect(wrote).toBe(true)

    await selectForInspector(page, id)
    await page.locator('[data-test="inspector-recap"]').click()
    // the stale banner shows (narrative suppressed), the auto-refresh runs, and the outcome
    // note explains what gated the regeneration. Two gates can legitimately fire first here:
    // the key-less LLM store ("needs an LLM key") or the untrusted 'x' transcript ("no session
    // transcript") when a sibling spec's runtime LLM mock is live on the shared worker app —
    // the spec pins the CONTRACT (a visible why-note), not one gate's wording.
    await expect(page.locator('[data-test="recap-stale"]')).toBeVisible()
    await expect(page.locator('[data-test="recap-refresh-note"]')).toContainText(
      /LLM key|transcript/,
      { timeout: 10_000 }
    )
  } finally {
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})

/**
 * Recap-refresh fix (b): the full regen chain - learned transcript + consent + (mock) LLM ->
 * manual refresh writes the narrative sidecar and the OPEN face re-reads it without a reflip.
 * CANVAS_LLM_MOCK is toggled at runtime through the e2e seam (the loop reads the live
 * process.env) and restored in the finally so later specs keep the key-less default.
 */
test('@terminal manual refresh regenerates the narrative in place (mock LLM)', async ({
  page,
  electronApp
}) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'recap-regen-', 'recap-g')
  try {
    await mainCall(electronApp, 'setLlmMock', true)
    const jsonl =
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-13T04:10:00.000Z',
          message: { role: 'user', content: 'review the auth module' }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-13T04:11:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Found 3 issues.' }] }
        })
      ].join('\n') + '\n'
    const transcript = await mainCall<string>(electronApp, 'seedRecapTranscript', jsonl)
    // Consent BEFORE the renderer binds the project (AppChrome prompts off getConsent on the
    // projectDir change — a pre-persisted decision keeps the scrim away) AND before the
    // transcript->LLM path runs (BUG-002 gate).
    await evalIn<{ ok: boolean }>(page, `window.api.recap.setConsent('enabled')`)
    // ...and the SEPARATE orchestration consent (its 'enable' prompt fires once recap
    // consent is decided - another scrim that would swallow the Inspector clicks).
    await evalIn<{ ok: boolean }>(page, `window.api.orchestration.setConsent('declined')`)
    // Bind the renderer + flush the board to disk (see the why-note spec) so run() finds it.
    const opened = await evalIn<{ status: string }>(
      page,
      `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`
    )
    expect(opened.status, 'fresh temp project opens clean').toBe('open')
    const id = await seed(page, 'terminal', { launchCommand: 'claude' })
    const saved = await evalIn<boolean>(
      page,
      `window.api.project.save(JSON.parse(window.__canvasE2E.serializeDoc()), ${JSON.stringify(tmp)})`
    )
    expect(saved, 'seeded board flushed to canvas.json').toBe(true)
    await mainCall(electronApp, 'recordRecapSession', id, transcript)

    // wait for the learned map entry to land (same poll as the facts spec)
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

    await selectForInspector(page, id)
    await page.locator('[data-test="inspector-recap"]').click()
    await expect(page.locator('[data-test="recap-facts-only"]')).toContainText('No narrative yet')

    // ONE manual refresh: the mock provider echoes the milestone input, the loop persists it
    // as the NOW line, and the face re-reads in place - no reflip, banner gone.
    await page.locator('button[title="Refresh recap"]').click()
    await expect(page.locator('[data-test="recap-now"]')).toContainText('[mock]', {
      timeout: 15_000
    })
    await expect(page.locator('[data-test="recap-facts-only"]')).toHaveCount(0)
  } finally {
    await mainCall(electronApp, 'setLlmMock', false)
    await mainCall(electronApp, 'restoreClaudeConfigDir')
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})
