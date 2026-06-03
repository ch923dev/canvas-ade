import type { IpcMain, BrowserWindow, IpcMainEvent } from 'electron'

/** Minimal board projection the renderer pushes to MAIN (control plane; no content). */
export interface BoardMirror {
  id: string
  type: string
  title: string
  /**
   * Coarse status bucket derived by the renderer from the live runtime stores
   * (T1.1). Absent when the renderer predates T1.1 (the adapter then falls back to
   * a PTY/presence-derived bucket). Validated against {@link STATUS_BUCKETS}.
   */
  status?: string
}

/**
 * A board↔board connector the renderer mirrors to MAIN (M2). Only `orchestration` edges
 * authorize dispatch (T4.6 relay_prompt); `preview` edges are the Browser→Terminal link.
 * Directional: `sourceId → targetId`. Mirror of `Connector` in `renderer/.../boardSchema.ts`.
 */
export interface ConnectorMirror {
  id: string
  sourceId: string
  targetId: string
  kind: 'preview' | 'orchestration'
}

/** Connector kinds a renderer may publish; an unrecognized kind is dropped. */
const CONNECTOR_KINDS: ReadonlySet<string> = new Set(['preview', 'orchestration'])

/**
 * The buckets a renderer is allowed to publish (mirror of `BoardStatusBucket` in
 * `renderer/src/store/boardStatus.ts`). `status` arrives over an IPC channel, so an
 * unrecognized value is dropped — never forwarded to agents as-is.
 */
const STATUS_BUCKETS: ReadonlySet<string> = new Set([
  'idle',
  'running',
  'awaiting-review',
  'blocked',
  'failed',
  'static'
])

let mirror: BoardMirror[] = []
let connectorMirror: ConnectorMirror[] = []

/** Bound the snapshot so a forged/oversized push on mcp:boards can't grow MAIN memory. */
const MAX_BOARDS = 500
const MAX_CONNECTORS = 1000
const MAX_FIELD_LEN = 256

/**
 * Keep only well-formed {id,type,title} string entries; drop anything else.
 * Bounded: at most MAX_BOARDS entries, each field at most MAX_FIELD_LEN chars —
 * the renderer is trusted, but mcp:boards is an IPC channel, so a malformed/oversized
 * payload is capped rather than retained wholesale. `type` is intentionally left an
 * open string (forward board types are allowed); an unrecognized type maps to status
 * 'unknown' downstream rather than being dropped.
 */
export function sanitizeSnapshot(input: unknown): BoardMirror[] {
  if (!Array.isArray(input)) return []
  const out: BoardMirror[] = []
  for (const b of input) {
    if (out.length >= MAX_BOARDS) break
    if (
      b &&
      typeof b === 'object' &&
      typeof (b as BoardMirror).id === 'string' &&
      typeof (b as BoardMirror).type === 'string' &&
      typeof (b as BoardMirror).title === 'string'
    ) {
      const { id, type, title, status } = b as BoardMirror
      if (
        id.length > MAX_FIELD_LEN ||
        type.length > MAX_FIELD_LEN ||
        title.length > MAX_FIELD_LEN
      ) {
        continue
      }
      // Attach status only when it is a known bucket; an invalid/absent value is
      // dropped so the adapter falls back rather than forwarding garbage.
      out.push(
        typeof status === 'string' && STATUS_BUCKETS.has(status)
          ? { id, type, title, status }
          : { id, type, title }
      )
    }
  }
  return out
}

/**
 * Keep only well-formed {id,sourceId,targetId,kind} connector entries; drop anything else.
 * Bounded like {@link sanitizeSnapshot} — mcp:boards is an IPC channel, so a malformed/
 * oversized payload is capped. An unrecognized `kind` is dropped (never forwarded).
 */
export function sanitizeConnectors(input: unknown): ConnectorMirror[] {
  if (!Array.isArray(input)) return []
  const out: ConnectorMirror[] = []
  for (const c of input) {
    if (out.length >= MAX_CONNECTORS) break
    if (
      c &&
      typeof c === 'object' &&
      typeof (c as ConnectorMirror).id === 'string' &&
      typeof (c as ConnectorMirror).sourceId === 'string' &&
      typeof (c as ConnectorMirror).targetId === 'string' &&
      typeof (c as ConnectorMirror).kind === 'string' &&
      CONNECTOR_KINDS.has((c as ConnectorMirror).kind)
    ) {
      const { id, sourceId, targetId, kind } = c as ConnectorMirror
      if (
        id.length > MAX_FIELD_LEN ||
        sourceId.length > MAX_FIELD_LEN ||
        targetId.length > MAX_FIELD_LEN
      ) {
        continue
      }
      out.push({ id, sourceId, targetId, kind })
    }
  }
  return out
}

/** Last snapshot the renderer pushed (empty until the renderer mounts + publishes). */
export function listBoardMirror(): BoardMirror[] {
  return mirror
}

/** Last connector snapshot the renderer pushed (orchestration + preview edges). */
export function listConnectors(): ConnectorMirror[] {
  return connectorMirror
}

/** Test seam — set the mirror directly (unit tests only). */
export function __setMirrorForTest(next: BoardMirror[]): void {
  mirror = next
}

/** Test seam — set the connector mirror directly (unit tests only). */
export function __setConnectorsForTest(next: ConnectorMirror[]): void {
  connectorMirror = next
}

/**
 * Register the renderer→MAIN board-snapshot channel. Sender-guarded so only the
 * main window's main frame can publish (mirrors pty.ts's isForeignSender). The
 * snapshot is control-plane metadata only — never board content.
 *
 * Accepts either the legacy boards-only array OR the `{ boards, connectors }` payload
 * (T4.6 added connectors so MAIN can resolve relay edges). An array → connectors stay [].
 */
export function registerBoardRegistryHandler(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null
): void {
  ipcMain.on('mcp:boards', (e: IpcMainEvent, payload: unknown) => {
    const main = getWin()?.webContents.mainFrame
    if (main && e.senderFrame && e.senderFrame !== main) return // foreign frame
    if (Array.isArray(payload)) {
      mirror = sanitizeSnapshot(payload)
      connectorMirror = []
    } else if (payload && typeof payload === 'object') {
      const { boards, connectors } = payload as { boards?: unknown; connectors?: unknown }
      mirror = sanitizeSnapshot(boards)
      connectorMirror = sanitizeConnectors(connectors)
    }
  })
}
