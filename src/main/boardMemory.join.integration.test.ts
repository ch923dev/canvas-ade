/**
 * M-expose (T1.7) END-TO-END JOIN: the Tier-2 write side (summaryLoop → canvasMemory) and the
 * MCP read side (boardMemory, injected into startMcpServer as readMemory/readSummary) target the
 * SAME `<project>/.canvas/memory/` files and AGREE on path + id charset + format.
 *
 * The two halves are each unit-covered, but separately: summaryLoop.test.ts reads its output back
 * through the WRITE module's own reader (createCanvasMemory().readBoard), never through boardMemory
 * — the actual `canvas://memory` / `canvas://board/{id}/summary` accessor that MAIN hands the MCP
 * server. This test closes that gap: drive the REAL summaryLoop (mock provider, no network), then
 * read the result back through boardMemory exactly as the MCP resource handlers do. If the writer
 * and the MCP reader ever drift (path layout, the safeBoardId vs SAFE_ID charset, the heading
 * framing), this fails — the unit halves would not.
 *
 * 🔒 Still passive: boardMemory is read-only; this asserts the read, never an action.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSummaryLoop } from './summaryLoop'
import { __setMemoryDirForTest, readBoardSummary, readProjectMemory } from './boardMemory'
import type { Encryptor } from './llmKeyStore'

/** Trivial round-trip Encryptor — unused on the mock path (no key needed), required by the loop dep. */
const fakeEncryptor: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => Buffer.from(b).toString('utf8')
}

const docWith = (boards: unknown[]): unknown => ({ schemaVersion: 4, viewport: null, boards })
const planNote = (id: string, text: string): unknown => ({
  id,
  type: 'planning',
  title: 'Plan',
  elements: [{ id: 'n1', kind: 'note', text }]
})

const tmps: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmps.push(d)
  return d
}

afterEach(() => {
  __setMemoryDirForTest(null) // never leak the dir override into another test
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true })
})

/** Run the real Tier-2 loop (mock provider) so it writes board-<id>.md + MEMORY.md under `proj`. */
async function summarizeInto(proj: string, boardId: string, doc: unknown): Promise<void> {
  const loop = createSummaryLoop({
    llmDataDir: tmp('m-expose-llm-'),
    encryptor: fakeEncryptor,
    getCurrentDir: () => proj,
    readProject: () => ({ ok: true, dir: proj, name: 'proj', doc }),
    now: () => new Date(),
    env: { CANVAS_LLM_MOCK: '1' } // getProvider → mock ([mock] <text>): no network, no key
  })
  await loop.onIntent({ boardId })
}

describe('M-expose join: summaryLoop write → boardMemory (MCP) read', () => {
  it('the MCP reader serves the per-board summary the loop just wrote', async () => {
    const proj = tmp('m-expose-proj-')

    // Pre-condition: with the write not yet done, the MCP reader gracefully empties — proving the
    // assertion below reflects the WRITE producing the file, not a pre-seeded fixture.
    __setMemoryDirForTest(proj)
    expect(readBoardSummary('p1')).toEqual({ present: false, text: '' })

    await summarizeInto(proj, 'p1', docWith([planNote('p1', 'hello world')]))

    // The MCP read path (canvas://board/p1/summary) now serves the loop's output, raw markdown
    // (heading framing + the mock-prefixed body) — proving path + id charset + format all agree.
    const summary = readBoardSummary('p1')
    expect(summary.present).toBe(true)
    expect(summary.text).toContain('[mock]') // mock provider prefix → the LLM body reached disk
    expect(summary.text).toContain('hello world') // board content reached the prompt → the summary
    expect(summary.text).toMatch(/^# /) // canvasMemory's `# <title>` framing is served verbatim
  })

  it('the MCP project index (canvas://memory) lists the summarized board', async () => {
    const proj = tmp('m-expose-proj-')
    await summarizeInto(proj, 'p1', docWith([planNote('p1', 'hello world')]))
    __setMemoryDirForTest(proj)

    const index = readProjectMemory()
    expect(index.present).toBe(true)
    expect(index.text).toContain('# Memory')
    expect(index.text).toContain('board-p1.md') // the index enumerates the board the loop wrote
  })

  it('🔒 a nanoid-shaped id written by the loop round-trips through the MCP reader charset', async () => {
    // canvasMemory.safeBoardId (writer) and boardMemory.SAFE_ID (MCP reader) must accept the SAME
    // ids or a legitimately-written summary would be unreadable over MCP. Use a realistic nanoid
    // (the `_-` chars are in both alphabets) to lock the parity at the join, not just per module.
    const proj = tmp('m-expose-proj-')
    const id = 'V1StGXR8_Z5jdHi6B-myT'
    await summarizeInto(proj, id, docWith([planNote(id, 'parser at 80%')]))
    __setMemoryDirForTest(proj)

    expect(existsSync(join(proj, '.canvas', 'memory', `board-${id}.md`))).toBe(true)
    const summary = readBoardSummary(id)
    expect(summary.present).toBe(true)
    expect(summary.text).toContain('parser at 80%')
  })
})
