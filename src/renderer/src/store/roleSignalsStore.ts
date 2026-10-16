/**
 * Role signals (spatial-awareness C9 producers, lane L11) — the EPHEMERAL per-board observations
 * the role model (`src/shared/boardRoles.ts`) reads off the MCP mirror:
 *  - `ports`         terminal → the loopback ports its dev server printed (`server` role + the
 *                    preview→server port link). Fed by the EXISTING detect path
 *                    (`terminal:detectPorts` → `portDetect.parsePortsFromOutput`): every caller
 *                    goes through {@link detectTerminalPorts}, which records what it read.
 *  - `callsPorts`    browser  → the loopback ports its page requested (D10, MAIN's
 *                    `previewOriginPorts` observer).
 *  - `lastFocusedAt` any board → when the user last selected it (the hero tie-break).
 *
 * 🔒 Session state only (scene/session split): never persisted, never a board patch key, never on
 * the undo rail. Only port NUMBERS and timestamps live here (D9) — never a URL, host or path.
 * `useMcpPublish` reads it into each board's mirror entry; MAIN re-sanitizes every field.
 */
import { create } from 'zustand'
import { MAX_CONTEXT_PORTS } from '../../../shared/spatialTypes'
import { useCanvasStore } from './canvasStore'
import { useTerminalRuntimeStore } from './terminalRuntimeStore'

type PortMap = Readonly<Record<string, readonly number[]>>

export interface RoleSignalsState {
  /** Terminal id → detected loopback listening ports (most recent first, ≤ 8). */
  ports: PortMap
  /** Browser id → loopback ports its page requested (≤ 8, as MAIN reported them). */
  callsPorts: PortMap
  /** Board id → epoch ms of the last time the user selected it. */
  lastFocusedAt: Readonly<Record<string, number>>
  /** Replace a terminal's ports (normalized; an empty list drops the entry). */
  setPorts: (id: string, ports: unknown) => void
  /** Replace a browser's called ports (normalized; an empty list drops the entry). */
  setCallsPorts: (id: string, ports: unknown) => void
  /** Stamp `at` as the last-focus time of every id. */
  markFocused: (ids: readonly string[], at: number) => void
  /** The terminal's process stopped — its ports are no longer served. */
  clearPorts: (id: string) => void
  /** Boards left the canvas — drop every signal they carried. */
  forget: (ids: readonly string[]) => void
  reset: () => void
}

/** Integers 1..65535, de-duplicated in first-seen order, at most {@link MAX_CONTEXT_PORTS}. */
export function normalizePorts(input: unknown): number[] {
  if (!Array.isArray(input)) return []
  const out: number[] = []
  for (const p of input) {
    if (out.length >= MAX_CONTEXT_PORTS) break
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) continue
    if (!out.includes(p)) out.push(p)
  }
  return out
}

const sameList = (a: readonly number[] | undefined, b: readonly number[]): boolean =>
  (a?.length ?? 0) === b.length && b.every((p, i) => a?.[i] === p)

/** `map` with `id` set to `ports`, or without `id` when `ports` is empty — `map` itself if unchanged. */
function withPorts(map: PortMap, id: string, ports: number[]): PortMap {
  if (sameList(map[id], ports)) return map
  const next = { ...map }
  if (ports.length > 0) next[id] = ports
  else delete next[id]
  return next
}

function without<T>(map: Readonly<Record<string, T>>, ids: readonly string[]): Record<string, T> {
  const next = { ...map }
  for (const id of ids) delete next[id]
  return next
}

export const useRoleSignalsStore = create<RoleSignalsState>((set) => ({
  ports: {},
  callsPorts: {},
  lastFocusedAt: {},
  setPorts: (id, ports) =>
    set((s) => {
      const next = withPorts(s.ports, id, normalizePorts(ports))
      return next === s.ports ? s : { ports: next }
    }),
  setCallsPorts: (id, ports) =>
    set((s) => {
      const next = withPorts(s.callsPorts, id, normalizePorts(ports))
      return next === s.callsPorts ? s : { callsPorts: next }
    }),
  markFocused: (ids, at) =>
    set((s) => {
      if (ids.length === 0 || !Number.isFinite(at)) return s
      const next = { ...s.lastFocusedAt }
      for (const id of ids) next[id] = at
      return { lastFocusedAt: next }
    }),
  clearPorts: (id) => set((s) => (id in s.ports ? { ports: without(s.ports, [id]) } : s)),
  forget: (ids) =>
    set((s) => {
      const hit = (m: Readonly<Record<string, unknown>>): boolean => ids.some((id) => id in m)
      if (!hit(s.ports) && !hit(s.callsPorts) && !hit(s.lastFocusedAt)) return s
      return {
        ports: without(s.ports, ids),
        callsPorts: without(s.callsPorts, ids),
        lastFocusedAt: without(s.lastFocusedAt, ids)
      }
    }),
  reset: () => set({ ports: {}, callsPorts: {}, lastFocusedAt: {} })
}))

type DetectedUrl = Awaited<ReturnType<Window['api']['detectPorts']>>[number]

/** Loopback hosts as `portDetect` reports them (it folds 0.0.0.0 / [::] / [::1] into `localhost`). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The PORT of every loopback URL a detection found (D9: the URL and host are not kept). */
export function loopbackPorts(urls: readonly Pick<DetectedUrl, 'host' | 'port'>[]): number[] {
  return normalizePorts(urls.filter((u) => LOOPBACK_HOSTS.has(u.host)).map((u) => u.port))
}

/** Record a detection's ports for terminal `id` — skipped once the board has left the canvas. */
export function recordDetectedPorts(
  id: string,
  urls: readonly Pick<DetectedUrl, 'host' | 'port'>[]
): void {
  const alive = useCanvasStore.getState().boards.some((b) => b.id === id && b.type === 'terminal')
  if (alive) useRoleSignalsStore.getState().setPorts(id, loopbackPorts(urls))
}

/**
 * THE renderer entry to the existing port detection (`window.api.detectPorts`): runs it and
 * records the terminal's loopback ports as a side effect, then hands the URLs back unchanged. The
 * globe button and the browser auto-connect poll both call this — no new poll. Rejections
 * propagate to the caller (both already handle them).
 */
export async function detectTerminalPorts(id: string): Promise<DetectedUrl[]> {
  const urls = await window.api.detectPorts(id)
  recordDetectedPorts(id, urls)
  return urls
}

/**
 * Wire the in-renderer feeds (call once; returns the unsubscribe). `now` is the clock seam.
 *  - selection → `lastFocusedAt` for every board newly added to `selectedIds` (click, marquee,
 *    focus action, OS-notification click — they all land there);
 *  - a board deleted (or a project switched away) → its signals are dropped;
 *  - a terminal that stops running (exit, restart, spawn failure) → its ports are cleared.
 */
export function installRoleSignalFeeds(now: () => number = Date.now): () => void {
  const offSelect = useCanvasStore.subscribe((s, prev) => {
    if (s.selectedIds === prev.selectedIds) return
    const added = s.selectedIds.filter((id) => !prev.selectedIds.includes(id))
    if (added.length > 0) useRoleSignalsStore.getState().markFocused(added, now())
  })
  const offBoards = useCanvasStore.subscribe((s, prev) => {
    if (s.boards === prev.boards) return
    const sig = useRoleSignalsStore.getState()
    const known = [sig.ports, sig.callsPorts, sig.lastFocusedAt].flatMap((m) => Object.keys(m))
    if (known.length === 0) return
    const live = new Set(s.boards.map((b) => b.id))
    const gone = [...new Set(known)].filter((id) => !live.has(id))
    if (gone.length > 0) sig.forget(gone)
  })
  const offRuntime = useTerminalRuntimeStore.subscribe((s, prev) => {
    if (s.running === prev.running) return
    for (const id of Object.keys(prev.running)) {
      if (prev.running[id] && s.running[id] !== true) {
        useRoleSignalsStore.getState().clearPorts(id)
      }
    }
  })
  return () => {
    offSelect()
    offBoards()
    offRuntime()
  }
}
