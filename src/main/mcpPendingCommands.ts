/**
 * Pending cross-project MCP commands (2026-07-09) — the queue half of visualize_plan routing.
 *
 * A background project's agent can propose a board (human-confirmed as usual), but the renderer
 * only ever holds the ACTIVE project's canvas — so a confirmed command targeting a NON-active
 * project is queued here and delivered through the SAME `sendMcpCommand` → renderer-applier path
 * when that project is next foregrounded (all renderer-side validation/undo/tidy applies then).
 *
 * Persisted under userData (NEVER a project folder — the queue must survive a quit before the
 * switch-back; mirrors orchestrationConfig.ts's file discipline). Delivery is snapshot-driven:
 * the drainer wakes on each renderer board-snapshot publish (`boardRegistry.subscribeBoardSnapshot`)
 * — a publish is proof the renderer store settled — and the applier additionally rejects commands
 * while `project.status === 'loading'`, so a drained command can never land in a store that an
 * in-flight `applyOpenResult` is about to replace (the failure re-queues; the next snapshot retries).
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import type { McpCommand, McpCommandAck } from '../shared/mcpTypes'

/** Per-project queue cap — a runaway agent can't grow the file unbounded (reject, don't rotate:
 *  dropping the OLDEST would silently lose an already-human-approved board). */
export const MAX_PENDING_PER_DIR = 32
/** Whole-store cap across all projects (belt over the per-dir cap). */
export const MAX_PENDING_TOTAL = 256

export interface PendingCommandStore {
  /** Queue a confirmed command for a non-active project. False = cap-rejected (nothing stored). */
  enqueue(dir: string, command: McpCommand): boolean
  /** Queued commands for `dir` (delivery order). Read-only peek. */
  count(dir: string): number
  /** Remove + return `dir`'s queue (delivery order) and persist the removal. */
  take(dir: string): McpCommand[]
  /** Re-queue commands that failed to deliver, at the FRONT (preserves original order). */
  requeue(dir: string, commands: McpCommand[]): void
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'pending-mcp-commands.json')
}

/**
 * Create the store backed by `<userDataDir>/pending-mcp-commands.json`. Lazy-loaded on first
 * access; a missing/corrupt file degrades to an empty queue (the plan is re-proposable — never
 * throw on boot for a poisoned sidecar). Every mutation persists atomically.
 */
export function createPendingCommandStore(userDataDir: string): PendingCommandStore {
  let byDir: Map<string, McpCommand[]> | null = null

  const load = (): Map<string, McpCommand[]> => {
    if (byDir) return byDir
    byDir = new Map()
    const file = fileFor(userDataDir)
    if (!existsSync(file)) return byDir
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const [dir, cmds] of Object.entries(raw)) {
        if (typeof dir !== 'string' || dir.length === 0 || !Array.isArray(cmds)) continue
        const list = cmds
          .filter((c): c is McpCommand => c !== null && typeof c === 'object')
          .slice(0, MAX_PENDING_PER_DIR)
        if (list.length > 0) byDir.set(dir, list)
      }
    } catch {
      // Corrupt sidecar → empty queue (the enqueue below rewrites it clean).
    }
    return byDir
  }

  const persist = (): void => {
    const m = load()
    try {
      mkdirSync(userDataDir, { recursive: true })
      writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(Object.fromEntries(m)), 'utf8')
    } catch (err) {
      // Best-effort durability: the in-memory queue still delivers this run; only a quit
      // before the switch-back loses it. Loud, not silent — this is an approved write.
      console.error('[mcp-pending] persist failed', err)
    }
  }

  const total = (m: Map<string, McpCommand[]>): number => {
    let n = 0
    for (const list of m.values()) n += list.length
    return n
  }

  return {
    enqueue(dir, command) {
      const m = load()
      const list = m.get(dir) ?? []
      if (list.length >= MAX_PENDING_PER_DIR || total(m) >= MAX_PENDING_TOTAL) return false
      list.push(command)
      m.set(dir, list)
      persist()
      return true
    },
    count(dir) {
      return load().get(dir)?.length ?? 0
    },
    take(dir) {
      const m = load()
      const list = m.get(dir) ?? []
      if (list.length === 0) return []
      m.delete(dir)
      persist()
      return list
    },
    requeue(dir, commands) {
      if (commands.length === 0) return
      const m = load()
      m.set(dir, [...commands, ...(m.get(dir) ?? [])])
      persist()
    }
  }
}

/**
 * Wire the delivery loop: on each renderer board-snapshot publish, deliver the ACTIVE project's
 * queued commands through `send` (the frame-guarded `sendMcpCommand`). Single-flight; a failed
 * ack (renderer still loading, ack timeout, window gone) re-queues that command AND stops the
 * pass — the next snapshot retries. A mid-drain project switch also stops the pass (the command
 * must only ever land on ITS project's canvas; `currentDir` is re-read before every send).
 * Returns the snapshot unsubscribe.
 */
export function startPendingCommandDrainer(deps: {
  store: PendingCommandStore
  currentDir: () => string | null
  send: (command: McpCommand) => Promise<McpCommandAck>
  subscribeSnapshot: (listener: () => void) => () => void
}): () => void {
  let draining = false
  let disposed = false
  // One-shot backstop after a failed pass: the canvas may go quiet right after the open (an empty
  // project publishes exactly once), so a pass that failed on the still-loading store would
  // otherwise wait for a snapshot that never comes.
  const retryLater = (): void => {
    const t = setTimeout(() => {
      if (!disposed) void drain()
    }, 2000)
    t.unref?.()
  }
  const drain = async (): Promise<void> => {
    if (draining) return
    const dir = deps.currentDir()
    if (dir === null || deps.store.count(dir) === 0) return
    draining = true
    try {
      const pending = deps.store.take(dir)
      for (let i = 0; i < pending.length; i++) {
        // Re-check the active project before EVERY send — a switch mid-drain must strand the
        // remainder back on the queue, never leak it onto the incoming project's canvas.
        if (deps.currentDir() !== dir) {
          deps.store.requeue(dir, pending.slice(i))
          return
        }
        const ack = await deps.send(pending[i])
        if (!ack.ok) {
          deps.store.requeue(dir, pending.slice(i))
          retryLater()
          return
        }
      }
    } finally {
      draining = false
    }
  }
  const unsubscribe = deps.subscribeSnapshot(() => {
    void drain()
  })
  return () => {
    disposed = true
    unsubscribe()
  }
}
