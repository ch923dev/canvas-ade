import { describe, it, expect } from 'vitest'
import { createGatedWriter, type DispatchGateDeps, type GatedWriteInput } from './dispatchGate'
import { createDispatchGuard } from './dispatchGuard'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * Fake deps around the real guard. `failWriteAt` makes the Nth writeToPty call return false
 * (1-based) — the failing call is NOT recorded, mirroring a vanished session.
 */
function makeDeps(over?: {
  isBracketedPaste?: (id: string) => boolean
  activityStaleMs?: (id: string) => number | undefined
  awaitReady?: DispatchGateDeps['awaitReady']
  approved?: boolean
  failWriteAt?: number
}): {
  deps: DispatchGateDeps
  writes: string[]
  audits: Array<{ status: string; detail?: string }>
} {
  const writes: string[] = []
  const audits: Array<{ status: string; detail?: string }> = []
  let calls = 0
  const deps: DispatchGateDeps = {
    guard: createDispatchGuard(),
    confirm: async () => ({ approved: over?.approved ?? true }),
    writeToPty: (_id, text) => {
      calls += 1
      if (over?.failWriteAt !== undefined && calls === over.failWriteAt) return false
      writes.push(text)
      return true
    },
    ...(over?.awaitReady ? { awaitReady: over.awaitReady } : {}),
    ...(over?.isBracketedPaste ? { isBracketedPaste: over.isBracketedPaste } : {}),
    ...(over?.activityStaleMs ? { activityStaleMs: over.activityStaleMs } : {}),
    audit: async (i) => {
      audits.push({ status: i.status, detail: i.detail })
    }
  }
  return { deps, writes, audits }
}

const input = (over?: Partial<GatedWriteInput>): GatedWriteInput => ({
  type: 'relay_prompt',
  targetId: 't1',
  text: 'hello world',
  terminator: '\r',
  confirmTitle: 'Relay',
  confirmBody: (s) => s,
  ...over
})

describe('createGatedWriter — paste framing + paced chunking (relay cut-off fix)', () => {
  it('no isBracketedPaste probe wired → RAW body, then the separate terminator (today’s shape)', async () => {
    const { deps, writes } = makeDeps()
    await createGatedWriter(deps)(input())
    expect(writes).toEqual(['hello world', '\r'])
  })

  it('probe false (plain shell) → raw body — marker bytes must never reach a non-2004 target', async () => {
    const { deps, writes } = makeDeps({ isBracketedPaste: () => false })
    await createGatedWriter(deps)(input())
    expect(writes).toEqual(['hello world', '\r'])
  })

  it('probe true → the body is framed \\x1b[200~ … \\x1b[201~; the terminator stays OUTSIDE', async () => {
    const { deps, writes } = makeDeps({ isBracketedPaste: () => true })
    await createGatedWriter(deps)(input())
    expect(writes).toEqual([`${PASTE_START}hello world${PASTE_END}`, '\r'])
  })

  it('a long body is chunked ≤1024 chars, in order, terminator LAST — reassembly is byte-exact', async () => {
    const text = 'a'.repeat(3000)
    const { deps, writes } = makeDeps({ isBracketedPaste: () => true })
    await createGatedWriter(deps)(input({ text }))
    const body = writes.slice(0, -1)
    expect(writes[writes.length - 1]).toBe('\r')
    expect(body.length).toBe(Math.ceil((text.length + 12) / 1024)) // + 12 marker chars
    expect(body.every((c) => c.length <= 1024)).toBe(true)
    expect(body.join('')).toBe(`${PASTE_START}${text}${PASTE_END}`)
  })

  it('a non-BMP char straddling a 1024-char boundary is NOT split across chunks (surrogate-safe)', async () => {
    // '😀' (U+1F600 = 😀) is placed so its surrogate pair spans index 1023/1024. A naive
    // slice would land the lone high surrogate at the end of chunk 1 → U+FFFD corruption. Raw body
    // (no framing) so the boundary is exactly WRITE_CHUNK_CHARS; sanitize:false keeps the length
    // exact.
    const text = 'a'.repeat(1023) + '😀' + 'z'.repeat(1500)
    const { deps, writes } = makeDeps()
    await createGatedWriter(deps)(input({ text, sanitize: false }))
    const body = writes.slice(0, -1)
    expect(writes[writes.length - 1]).toBe('\r')
    expect(body.join('')).toBe(text) // reassembly byte-exact
    for (const c of body) {
      const lastUnit = c.charCodeAt(c.length - 1)
      expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false) // no chunk ends on a high surrogate
      const firstUnit = c.charCodeAt(0)
      expect(firstUnit >= 0xdc00 && firstUnit <= 0xdfff).toBe(false) // nor starts on a low surrogate
    }
  })

  it('a session vanishing MID-body aborts the remaining chunks AND the submit (no orphan \\r)', async () => {
    const text = 'b'.repeat(3000)
    const { deps, writes, audits } = makeDeps({ failWriteAt: 2 })
    await expect(createGatedWriter(deps)(input({ text }))).rejects.toThrow(/PTY write failed/)
    expect(writes.length).toBe(1) // chunk 1 landed; chunk 2 failed; nothing after
    expect(writes.some((w) => w.includes('\r'))).toBe(false)
    expect(audits.map((a) => a.status)).toContain('failed')
  })

  it('the content-less interrupt still writes ONLY its terminator (no framing, no echo probe)', async () => {
    const { deps, writes, audits } = makeDeps({
      isBracketedPaste: () => true,
      activityStaleMs: () => 99_999
    })
    const r = await createGatedWriter(deps)(
      input({ type: 'interrupt', text: '', terminator: '\x03', sanitize: false })
    )
    expect(writes).toEqual(['\x03'])
    expect(r.delivery).toBe('ready') // no body ⇒ echo confirm is not consulted
    expect(audits[audits.length - 1].detail).not.toContain('echo=')
  })
})

describe('createGatedWriter — post-write echo confirmation (honest ack, OR-composed)', () => {
  it('UPGRADE: readiness unconfirmed BUT echo seen → dispatched + delivery ready + echo=seen', async () => {
    // The idle-but-ready case: the boot window never settled to observe, but the target echoed
    // the paste → delivery IS confirmed (this is the e2e-flake fix — echo upgrades, not downgrades).
    const { deps, audits } = makeDeps({
      awaitReady: async () => ({ outcome: 'unconfirmed', waitedMs: 15000 }),
      activityStaleMs: () => 0
    })
    const r = await createGatedWriter(deps)(input())
    expect(r.delivery).toBe('ready')
    const last = audits[audits.length - 1]
    expect(last.status).toBe('dispatched')
    expect(last.detail).toContain('readiness=unconfirmed')
    expect(last.detail).toContain('echo=seen')
  })

  it('BOTH negative: readiness unconfirmed AND no echo → dispatched_unconfirmed + echo=none (terminator still sent)', async () => {
    const { deps, writes, audits } = makeDeps({
      awaitReady: async () => ({ outcome: 'unconfirmed', waitedMs: 15000 }),
      activityStaleMs: () => 99_999
    })
    const r = await createGatedWriter(deps)(input())
    expect(r.delivery).toBe('unconfirmed')
    const last = audits[audits.length - 1]
    expect(last.status).toBe('dispatched_unconfirmed')
    expect(last.detail).toContain('echo=none')
    expect(writes[writes.length - 1]).toBe('\r') // degrade-and-submit, never a swallowed Enter
  })

  it('readiness ready → echo poll SKIPPED (no avoidable wait); still dispatched, no echo= recorded', async () => {
    // Perf gate: an already-`ready` write needs no echo confirmation (echo can only UPGRADE), so
    // the poll is skipped entirely — activityStaleMs is never consulted and `echo=` is not
    // recorded (claiming echo=none here would mean "didn't check", not "checked, saw none").
    const probe = { calls: 0 }
    const { deps, audits } = makeDeps({
      awaitReady: async () => ({ outcome: 'ready', waitedMs: 5 }),
      activityStaleMs: () => {
        probe.calls += 1
        return 99_999
      }
    })
    const r = await createGatedWriter(deps)(input())
    expect(r.delivery).toBe('ready')
    expect(probe.calls).toBe(0) // echo poll never ran — readiness already carried delivery
    const last = audits[audits.length - 1]
    expect(last.status).toBe('dispatched')
    expect(last.detail).toContain('readiness=ready')
    expect(last.detail).not.toContain('echo=')
  })

  it('no activityStaleMs probe wired → no echo check, delivery stays readiness-only (back-compat)', async () => {
    const { deps, audits } = makeDeps({
      awaitReady: async () => ({ outcome: 'unconfirmed', waitedMs: 5 })
    })
    const r = await createGatedWriter(deps)(input())
    expect(r.delivery).toBe('unconfirmed') // no echo probe ⇒ readiness alone decides
    expect(audits[audits.length - 1].detail).not.toContain('echo=')
  })

  it('denied confirm: nothing is written, no echo probe runs, the nonce is evicted (unchanged)', async () => {
    const probe = { called: false }
    const { deps, writes, audits } = makeDeps({
      approved: false,
      activityStaleMs: () => {
        probe.called = true
        return 0
      }
    })
    await expect(createGatedWriter(deps)(input())).rejects.toThrow(/denied/)
    expect(writes).toEqual([])
    expect(probe.called).toBe(false)
    expect(audits.map((a) => a.status)).toEqual(['denied'])
  })
})

describe('createGatedWriter — confirmOverride (relay_prompts batch seam)', () => {
  function spyDeps(): {
    deps: DispatchGateDeps
    writes: string[]
    audits: string[]
    state: { confirmCalls: number }
  } {
    const state = { confirmCalls: 0 }
    const writes: string[] = []
    const audits: string[] = []
    const deps: DispatchGateDeps = {
      guard: createDispatchGuard(),
      confirm: async () => {
        state.confirmCalls += 1
        return { approved: true }
      },
      writeToPty: (_id, text) => {
        writes.push(text)
        return true
      },
      audit: async (i) => {
        audits.push(i.status)
      }
    }
    return { deps, writes, audits, state }
  }

  it('an approving override writes WITHOUT calling the per-item confirm modal', async () => {
    const { deps, writes, audits, state } = spyDeps()
    const r = await createGatedWriter(deps)(
      input({ confirmOverride: async () => ({ approved: true }) })
    )
    // The batch modal already decided this row → the gate does NOT raise a per-item confirm.
    expect(state.confirmCalls).toBe(0)
    expect(writes).toEqual(['hello world', '\r'])
    expect(audits[audits.length - 1]).toBe('dispatched')
    expect(r.delivery).toBe('ready')
  })

  it('a denying override fails closed: no write, nonce evicted, audit denied, still no per-item confirm', async () => {
    const { deps, writes, audits, state } = spyDeps()
    await expect(
      createGatedWriter(deps)(input({ confirmOverride: async () => ({ approved: false }) }))
    ).rejects.toThrow(/denied/)
    expect(state.confirmCalls).toBe(0)
    expect(writes).toEqual([])
    expect(audits).toEqual(['denied'])
  })

  it('with no override the per-item confirm modal still runs (unchanged single-dispatch path)', async () => {
    const { deps, state } = spyDeps()
    await createGatedWriter(deps)(input())
    expect(state.confirmCalls).toBe(1)
  })
})
