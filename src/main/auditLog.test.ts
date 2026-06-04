import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// BUG-024 (1): inject a one-shot appendFile failure to prove a failed WRITE does not burn
// its seq. The mock wraps the REAL fs/promises so every other test keeps real disk behavior;
// only `failNextAppend` (armed per-test) makes the next appendFile reject (e.g. ENOSPC).
const fsControl = vi.hoisted(() => ({ failNextAppend: false }))
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...real,
    appendFile: (...args: Parameters<typeof real.appendFile>) => {
      if (fsControl.failNextAppend) {
        fsControl.failNextAppend = false
        return Promise.reject(
          Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        )
      }
      return real.appendFile(...args)
    }
  }
})

import { createAuditLog, shapeAuditEntry, type AuditInput } from './auditLog'

let dir: string
const FILE = 'mcp-audit.jsonl'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-audit-'))
})
afterEach(() => {
  fsControl.failNextAppend = false
  rmSync(dir, { recursive: true, force: true })
})

const input = (over: Partial<AuditInput> = {}): AuditInput => ({
  type: 'handoff_prompt',
  targetId: 'board-1',
  prompt: 'echo hi',
  nonce: 'nonce-abc',
  ...over
})

describe('shapeAuditEntry (pure)', () => {
  it('stamps the given seq + ts and carries the core fields', () => {
    const e = shapeAuditEntry(input(), 7, 1234)
    expect(e).toMatchObject({
      seq: 7,
      ts: 1234,
      type: 'handoff_prompt',
      targetId: 'board-1',
      prompt: 'echo hi',
      nonce: 'nonce-abc',
      status: 'dispatched' // default when not supplied
    })
  })

  it('honours an explicit status and includes optional fields only when present', () => {
    const withOpt = shapeAuditEntry(input({ status: 'completed', outputs: 'done' }), 1, 0)
    expect(withOpt.status).toBe('completed')
    expect(withOpt.outputs).toBe('done')
    // optional fields absent → the key is omitted, not set to undefined
    const bare = shapeAuditEntry(input(), 1, 0)
    expect('outputs' in bare).toBe(false)
    expect('detail' in bare).toBe(false)
  })

  it("🔒 bounds field lengths (a forged oversized prompt can't grow the log unboundedly)", () => {
    const e = shapeAuditEntry(input({ prompt: 'p'.repeat(200_000), nonce: 'n'.repeat(2000) }), 1, 0)
    expect(e.prompt.length).toBe(100_000)
    expect(e.nonce.length).toBe(256)
  })
})

describe('createAuditLog (append-only JSONL)', () => {
  it('append then read round-trips the entry', async () => {
    const log = createAuditLog({ dir, now: () => 555 })
    const written = await log.append(input())
    expect(written.seq).toBe(1)
    expect(written.ts).toBe(555)
    const back = await log.read()
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ seq: 1, ts: 555, prompt: 'echo hi' })
  })

  it('assigns a monotonic sequence, persisted across fresh instances over the same dir', async () => {
    const a = createAuditLog({ dir, now: () => 1 })
    expect((await a.append(input())).seq).toBe(1)
    expect((await a.append(input())).seq).toBe(2)
    // a NEW instance must continue the sequence (read max-seq from disk), not reset to 1
    const b = createAuditLog({ dir, now: () => 1 })
    expect((await b.append(input())).seq).toBe(3)
  })

  it('appends one JSON line per entry (true append, not rewrite)', async () => {
    const log = createAuditLog({ dir, now: () => 1 })
    await log.append(input({ prompt: 'first' }))
    await log.append(input({ prompt: 'second' }))
    const raw = readFileSync(join(dir, FILE), 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).prompt).toBe('first')
    expect(JSON.parse(lines[1]).prompt).toBe('second')
  })

  it('serializes concurrent appends — distinct, gap-free, monotonic seqs, both written', async () => {
    const log = createAuditLog({ dir, now: () => 1 })
    // Fire two appends WITHOUT awaiting between them — they both race the same pending
    // initSeq(); the reservation must be serialized so they get distinct seqs.
    const [a, b] = await Promise.all([
      log.append(input({ prompt: 'first' })),
      log.append(input({ prompt: 'second' }))
    ])
    const seqs = [a.seq, b.seq].sort((x, y) => x - y)
    expect(seqs).toEqual([1, 2]) // distinct, gap-free, monotonic
    // Both entries are persisted (no interleaved/lost write).
    const back = await log.read()
    expect(back).toHaveLength(2)
    expect(back.map((e) => e.seq).sort((x, y) => x - y)).toEqual([1, 2])
    const raw = readFileSync(join(dir, FILE), 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(2)
  })

  it('a failed write does NOT burn the seq — the next append reuses it, no gap (BUG-024 #1)', async () => {
    const log = createAuditLog({ dir, now: () => 1 })
    expect((await log.append(input({ prompt: 'first' }))).seq).toBe(1)

    // The next appendFile fails (ENOSPC). The reserved seq (2) must NOT advance.
    fsControl.failNextAppend = true
    await expect(log.append(input({ prompt: 'lost' }))).rejects.toThrow(/ENOSPC/)

    // The retry must REUSE seq 2 (not skip to 3) — an audit trail must be gap-free.
    expect((await log.append(input({ prompt: 'retry' }))).seq).toBe(2)

    const back = await log.read()
    expect(back.map((e) => e.seq).sort((x, y) => x - y)).toEqual([1, 2])
    expect(back.map((e) => e.prompt).sort()).toEqual(['first', 'retry']) // 'lost' never persisted
  })

  it('concurrent appends land in the file in SEQ order (BUG-024 #2: serialized writes)', async () => {
    const log = createAuditLog({ dir, now: () => 1 })
    // Fire many appends concurrently. The full write (not just the seq arithmetic) is
    // serialized through the tail promise, so the physical JSONL line order must equal the
    // seq order — the pre-fix code only chained the seq number, letting writes interleave.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => log.append(input({ prompt: `p${i}` })))
    )
    const raw = readFileSync(join(dir, FILE), 'utf8')
    const seqsInFileOrder = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { seq: number }).seq)
    expect(seqsInFileOrder).toEqual([1, 2, 3, 4, 5, 6, 7, 8]) // physical order === seq order
  })

  it('read tolerates a corrupt / blank line and returns the well-formed entries', async () => {
    const log = createAuditLog({ dir, now: () => 1 })
    await log.append(input({ prompt: 'good' }))
    appendFileSync(join(dir, FILE), 'not json\n\n', 'utf8')
    const back = await log.read()
    expect(back).toHaveLength(1)
    expect(back[0].prompt).toBe('good')
  })

  it('read returns newest-first and caps to the limit', async () => {
    const log = createAuditLog({ dir, now: () => 1 })
    for (let i = 0; i < 5; i++) await log.append(input({ prompt: `p${i}` }))
    const back = await log.read({ limit: 2 })
    expect(back.map((e) => e.prompt)).toEqual(['p4', 'p3'])
  })

  it('read on an absent log file is empty (no throw)', async () => {
    const log = createAuditLog({ dir })
    expect(await log.read()).toEqual([])
  })
})
