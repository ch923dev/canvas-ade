import { test, expect } from './fixtures'
import { evalIn, mainCall } from './helpers'

/**
 * PR-4 (Command-board prerequisite): the result synthesizer materializes a board's structured
 * `BoardResult` from its recap transcript when the worker agent has SETTLED, and never clobbers a
 * worker's explicit `write_result`.
 *
 * This proves the REAL MAIN wiring end-to-end: a learned transcript (registered through the same
 * production session-map path the recordSession.js hook uses) → the synthesizer's getFacts closure
 * (resolveLiveTranscriptPath → trusted-path guard → readTranscriptTail → computeRecapFacts) → a
 * synthesized result readable back. The `synthesizeResultNow` seam drives the SAME
 * `resultSynth.onSettle` the recap-mtime watcher fires, only without its 25s debounce.
 *
 * No canvas board is seeded on purpose: a board with a LIVE PTY pushes its activity clock to ~now
 * (status `running` → no verdict yet), and seeding/observing a board would trip the boardResults
 * prune. A synthetic, recapMap-only id with PAST transcript timestamps reads `idle` (absent
 * runtime = alive-unknown), the settled state the synthesizer records — and nothing prunes it.
 */

interface BoardResultShape {
  present: boolean
  status?: string
  summary?: string
  refs?: string[]
  at?: string
}

/** A SETTLED (past-timestamp, no trailing question) transcript → computeRecapFacts reads `idle`. */
function idleTranscript(): string {
  return (
    [
      JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'build the widget' }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:01:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'Z:/repo/widget.ts' } }]
        }
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Build the widget' }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:02:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done building the widget.' }]
        }
      })
    ].join('\n') + '\n'
  )
}

test('@core synthesizes a BoardResult from a settled recap transcript', async ({ electronApp }) => {
  // recap:get needs a current project dir; the synthesizer reads only the learned map + transcript.
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'synth-e2e-', 'synth-e2e')
  const id = 'pr4-synth-board'
  try {
    const transcript = await mainCall<string>(electronApp, 'seedRecapTranscript', idleTranscript())
    await mainCall(electronApp, 'recordRecapSession', id, transcript)

    // watchRecapMap absorbs the session-map append on a debounce; drive onSettle until the learned
    // path has flowed into recapMap and the synthesized result lands.
    await expect
      .poll(
        async () => {
          await mainCall(electronApp, 'synthesizeResultNow', id)
          const r = await mainCall<BoardResultShape>(electronApp, 'boardResultFor', id)
          return r?.present === true
        },
        { timeout: 10_000 }
      )
      .toBe(true)

    const result = await mainCall<BoardResultShape>(electronApp, 'boardResultFor', id)
    expect(result.status).toBe('success')
    expect(result.summary).toContain('Build the widget')
    expect(result.summary).toContain('1 file')
    expect(result.refs).toEqual(['Z:/repo/widget.ts'])
    expect(typeof result.at).toBe('string')
  } finally {
    await mainCall(electronApp, 'restoreClaudeConfigDir')
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})

test('@core never clobbers an explicit write_result', async ({ page, electronApp }) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'synth-keep-', 'synth-keep')
  const id = 'pr4-explicit-board'
  try {
    // A worker self-report recorded WITHOUT the synthesized tag owns the id.
    await mainCall(electronApp, 'mcpRecordResult', id, {
      present: true,
      status: 'success',
      summary: 'worker self-report'
    })
    const transcript = await mainCall<string>(electronApp, 'seedRecapTranscript', idleTranscript())
    await mainCall(electronApp, 'recordRecapSession', id, transcript)

    // Wait for the learned path to flow in (recap:get sees the fixture turns), then drive onSettle.
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
    await mainCall(electronApp, 'synthesizeResultNow', id)

    // The explicit summary survives — synthesis did not overwrite it.
    const result = await mainCall<BoardResultShape>(electronApp, 'boardResultFor', id)
    expect(result.summary).toBe('worker self-report')
  } finally {
    await mainCall(electronApp, 'restoreClaudeConfigDir')
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})
