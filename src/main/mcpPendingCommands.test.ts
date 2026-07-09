/**
 * Unit tests for mcpPendingCommands.ts — the persisted cross-project command queue + the
 * snapshot-driven drainer that delivers it when the target project is foregrounded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPendingCommandStore,
  startPendingCommandDrainer,
  MAX_PENDING_PER_DIR
} from './mcpPendingCommands'
import type { McpCommand, McpCommandAck } from '../shared/mcpTypes'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pending-mcp-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const cmd = (id: string): McpCommand => ({
  type: 'visualizePlan',
  id,
  visualization: 'checklist',
  items: [{ title: 'one' }]
})

describe('createPendingCommandStore', () => {
  it('enqueue → count → take roundtrip in delivery order; take empties + persists', () => {
    const store = createPendingCommandStore(dir)
    expect(store.enqueue('C:\\proj\\a', cmd('1'))).toBe(true)
    expect(store.enqueue('C:\\proj\\a', cmd('2'))).toBe(true)
    expect(store.count('C:\\proj\\a')).toBe(2)
    const taken = store.take('C:\\proj\\a')
    expect(taken.map((c) => (c.type === 'visualizePlan' ? c.id : ''))).toEqual(['1', '2'])
    expect(store.count('C:\\proj\\a')).toBe(0)
    expect(store.take('C:\\proj\\a')).toEqual([])
  })

  it('persists across store instances (a quit before the switch-back loses nothing)', () => {
    createPendingCommandStore(dir).enqueue('C:\\proj\\a', cmd('1'))
    const reloaded = createPendingCommandStore(dir)
    expect(reloaded.count('C:\\proj\\a')).toBe(1)
    expect(reloaded.take('C:\\proj\\a')).toHaveLength(1)
  })

  it('requeue front-inserts so original delivery order is preserved after a failed pass', () => {
    const store = createPendingCommandStore(dir)
    store.enqueue('d', cmd('3'))
    store.requeue('d', [cmd('1'), cmd('2')])
    expect(store.take('d').map((c) => (c.type === 'visualizePlan' ? c.id : ''))).toEqual([
      '1',
      '2',
      '3'
    ])
  })

  it('REJECTS past the per-dir cap (never silently drops an approved board)', () => {
    const store = createPendingCommandStore(dir)
    for (let i = 0; i < MAX_PENDING_PER_DIR; i++) {
      expect(store.enqueue('d', cmd(String(i)))).toBe(true)
    }
    expect(store.enqueue('d', cmd('overflow'))).toBe(false)
    expect(store.count('d')).toBe(MAX_PENDING_PER_DIR)
  })

  it('a corrupt sidecar degrades to an empty queue (no boot throw)', () => {
    writeFileSync(join(dir, 'pending-mcp-commands.json'), '{not json', 'utf8')
    const store = createPendingCommandStore(dir)
    expect(store.count('d')).toBe(0)
    expect(store.enqueue('d', cmd('1'))).toBe(true) // rewrites clean
    expect(createPendingCommandStore(dir).count('d')).toBe(1)
  })
})

describe('startPendingCommandDrainer', () => {
  interface DrainHarness {
    fire: () => Promise<void>
    sent: McpCommand[]
    dispose: () => void
  }

  function drainHarness(opts: {
    store: ReturnType<typeof createPendingCommandStore>
    currentDir: () => string | null
    ackFor?: (command: McpCommand) => McpCommandAck
    onSend?: () => void
  }): DrainHarness {
    const sent: McpCommand[] = []
    let listener: (() => void) | null = null
    const dispose = startPendingCommandDrainer({
      store: opts.store,
      currentDir: opts.currentDir,
      send: async (command) => {
        sent.push(command)
        opts.onSend?.()
        return opts.ackFor?.(command) ?? { ok: true, type: command.type }
      },
      subscribeSnapshot: (l) => {
        listener = l
        return () => {
          listener = null
        }
      }
    })
    return {
      // The drainer's snapshot callback is sync-void; yield micro/macrotasks so the async
      // drain pass inside it settles before the test asserts.
      fire: async () => {
        listener?.()
        await new Promise((r) => setTimeout(r, 0))
      },
      sent,
      dispose
    }
  }

  it('delivers the ACTIVE project queue on a snapshot, in order', async () => {
    const store = createPendingCommandStore(dir)
    store.enqueue('C:\\proj\\a', cmd('1'))
    store.enqueue('C:\\proj\\a', cmd('2'))
    const h = drainHarness({ store, currentDir: () => 'C:\\proj\\a' })
    await h.fire()
    expect(h.sent.map((c) => (c.type === 'visualizePlan' ? c.id : ''))).toEqual(['1', '2'])
    expect(store.count('C:\\proj\\a')).toBe(0)
    h.dispose()
  })

  it('leaves a NON-active project queue untouched', async () => {
    const store = createPendingCommandStore(dir)
    store.enqueue('C:\\proj\\background', cmd('1'))
    const h = drainHarness({ store, currentDir: () => 'C:\\proj\\active' })
    await h.fire()
    expect(h.sent).toHaveLength(0)
    expect(store.count('C:\\proj\\background')).toBe(1)
    h.dispose()
  })

  it('a failed ack (renderer still loading) re-queues the remainder for the next snapshot', async () => {
    const store = createPendingCommandStore(dir)
    store.enqueue('d', cmd('1'))
    store.enqueue('d', cmd('2'))
    let failFirst = true
    const h = drainHarness({
      store,
      currentDir: () => 'd',
      ackFor: () => {
        if (failFirst) {
          failFirst = false
          return { ok: false, error: 'project-loading' }
        }
        return { ok: true, type: 'visualizePlan' }
      }
    })
    await h.fire()
    expect(store.count('d')).toBe(2) // both back on the queue
    await h.fire()
    expect(store.count('d')).toBe(0)
    expect(h.sent).toHaveLength(3) // 1 failed + 2 delivered
    h.dispose()
  })

  it('a project switch MID-drain strands the remainder on the queue (never leaks cross-project)', async () => {
    const store = createPendingCommandStore(dir)
    store.enqueue('d', cmd('1'))
    store.enqueue('d', cmd('2'))
    let active = 'd'
    const h = drainHarness({
      store,
      currentDir: () => active,
      onSend: () => {
        active = 'other' // the user switches away right after the first send
      }
    })
    await h.fire()
    expect(h.sent).toHaveLength(1)
    expect(store.count('d')).toBe(1)
    h.dispose()
  })

  it('dispose unsubscribes (a snapshot after dispose delivers nothing)', async () => {
    const store = createPendingCommandStore(dir)
    store.enqueue('d', cmd('1'))
    const h = drainHarness({ store, currentDir: () => 'd' })
    h.dispose()
    await h.fire()
    expect(h.sent).toHaveLength(0)
  })
})
