/**
 * Board roles (spatial-awareness C9) — the pure role model behind the role-aware tidy
 * (`tidy_canvas mode:'roles'`). It answers three questions over the MAIN mirror's board summaries,
 * in the order the layout engine asks them (ROLE-LAYOUT.md §1):
 *  1. `deriveRoles` — what each board IS on the canvas (lead, swarm, agent, preview, …), its hero
 *     weight, the boards it is linked to, and a one-line `why` (ROLE-LAYOUT §2).
 *  2. `buildRoleUnits` — which boards are laid out TOGETHER. Precedence is
 *     Named Group > TEAM > context > single (ROLE-LAYOUT §1, SPEC C9).
 *  3. the scene + hero(es) of each unit (ROLE-LAYOUT §3), carried on every `RoleUnit`.
 * Pure TypeScript: compiled by BOTH the node and web tsconfigs — MAIN reads it for
 * `canvas://layout`, the renderer for C10's `roleLayout`. No Node built-ins, no DOM.
 * Rules: `docs/specs/spatial-awareness/ROLE-LAYOUT.md` §1–§3 · contract: `SPEC.md` C9.
 *
 * Decisions this module makes (each pinned by a test in `boardRoles.test.ts`):
 *  - `lead` comes ONLY from `opts.leadBoardId` (MAIN's `leadAuthority` is the one source of truth),
 *    never from a board type. `agent` is the caller's boolean (L11's classifier) — D9: the launch
 *    line never reaches this module, so no `why` can leak it.
 *  - An unknown board type is classed `file` (rigid, weight 25): an arrangement we cannot reason
 *    about must never be resized (D7), and it still gets exactly one unit.
 *  - A 1-board unit is always the `single` scene, even when that board is the lead, a hub or a doc:
 *    the other scenes describe compositions, and S11 says a lone board keeps its size.
 *  - A multi-board unit that matches no §3 row (e.g. a preview + a port-less shell) falls back to
 *    `docs` — the only template that never resizes, the D8 (a) "no role signal ⇒ position only"
 *    spirit — with no hero, so `primary` (L10) still decides.
 *  - Hubs head their own TEAM; a hub is never another hub's worker. A hub with no claimable
 *    target is not a team (it falls through to its context, else a single).
 *  - Riders: an unclaimed non-hub board joined to a TEAM member by a PREVIEW link (a browser's
 *    source terminal, or a terminal serving a port it calls) or a DATAFLOW link (a data-flow
 *    board's browser) rides with that team. Riders resolve to a fixed point, in rounds: a
 *    worker's browser joins in round 1, that browser's data-flow board in round 2. Within a round
 *    a board reachable from two teams takes the heavier hub (id tie-break), so the nearer team
 *    wins first and weight breaks ties at equal distance.
 *  - C3 contexts that ARE an existing Named Group (`existingGroupId`) are skipped: the group unit
 *    already holds the members, and their `addBoardIds` are only PROPOSALS — laying a non-member
 *    inside a group's packed rect would draw it under the group's outline.
 */

// ── C3 stub (owned by L6) — coordinator swaps this for `import type … from './deriveContexts'` at rebase ──
// Copied verbatim from SPEC C3 (types only). L6 writes `src/shared/deriveContexts.ts` in parallel;
// once it lands this block becomes
// `import type { ContextConnectorInput, ContextGroupInput, DerivedContext } from
// './deriveContexts'`.
interface ContextConnectorInput {
  sourceId: string
  targetId: string
  kind: 'preview' | 'orchestration'
}
interface ContextGroupInput {
  id: string
  name: string
  boardIds: string[]
}
type ContextSignal =
  | 'group'
  | 'preview'
  | 'orchestration'
  | 'port'
  | 'dataflow'
  | 'cwd'
  | 'fileRef'
  | 'title'
interface DerivedContext {
  key: string // stable: hash of the sorted boardIds
  suggestedName: string // ≤ GROUP_NAME_MAX (80), sanitized
  boardIds: string[] // sorted
  signals: ContextSignal[] // why these belong together (no raw paths)
  confidence: 'high' | 'medium' | 'low'
  existingGroupId?: string // set when this context IS / extends an existing Named Group
  addBoardIds?: string[] // ungrouped boards proposed to join `existingGroupId`
}
// ── end C3 stub ──

export type BoardRole =
  | 'lead'
  | 'swarm'
  | 'command'
  | 'agent'
  | 'preview'
  | 'plan'
  | 'tracker'
  | 'dataflow'
  | 'file'
  | 'server'
  | 'shell'

/** Hero weight per role (ROLE-LAYOUT §2): the heavier board takes the big slot. */
export const ROLE_WEIGHT: Readonly<Record<BoardRole, number>> = Object.freeze({
  lead: 100,
  swarm: 80,
  command: 70,
  agent: 60,
  preview: 50,
  plan: 40,
  tracker: 35,
  dataflow: 30,
  file: 25,
  server: 20,
  shell: 10
})

/** Per-unit arrangement (ROLE-LAYOUT §3). The scene picks the hero(es) and L10's template. */
export type Scene = 'lead' | 'hub' | 'pair' | 'stack' | 'peers' | 'docs' | 'single'

/**
 * One board as the role model sees it: geometry plus the CLASSIFICATIONS that reach MAIN (D9 —
 * never a raw launch line or path). Every signal is optional and ephemeral (L11 produces them).
 */
export interface RoleBoardInput {
  id: string
  /**
   * `BoardType` (`boardSchema.ts:122`): 'terminal' | 'browser' | 'planning' | 'command' | 'file' |
   * 'dataflow' | 'kanban' | 'swarm'. A free string: an unknown type classes as `file`.
   */
  type: string
  x: number
  y: number
  w: number
  h: number
  /** Browser: the terminal that drives this preview (`BrowserBoard.previewSourceId`). */
  previewSourceId?: string
  /** Set ⇒ a worker docked inside a swarm board: not canvas geometry, excluded everywhere. */
  dockedIn?: string
  /** Data-flow: the browser whose traffic it visualizes (`DataFlowBoard.sourceBoardId`). */
  sourceBoardId?: string
  /** Terminal: runs a known agent CLI (L11 `agentClassify`). */
  agent?: boolean
  /** Terminal: detected loopback listening ports. */
  ports?: number[]
  /** Browser: loopback ports its page requested (D10 observer). */
  callsPorts?: number[]
  /** Epoch ms of the last focus — the first hero tie-break. */
  lastFocusedAt?: number
}

export interface BoardRoleInfo {
  id: string
  role: BoardRole
  weight: number
  /**
   * The boards this one is linked to, directed from the board that NAMES the relation (§2):
   * preview → its source terminal and every terminal serving a port it calls; lead/command/swarm →
   * their orchestration-cable targets; dataflow → its browser. Reading order (y, x, id) — the
   * order-invariant stand-in for S1's "cable order" (C3 connectors carry no id to order by).
   * The reverse question ("who links to X?") is `roles.get(other).links.includes(X)`.
   */
  links: string[]
  /**
   * One short human sentence built from role, link counts and port numbers only — never a path
   * or a launch line (D9).
   */
  why: string
}

export interface RoleUnit {
  /** Stable: the group id · `team:<hubId>` · the C3 context key · `single:<boardId>`. */
  key: string
  /** Members, sorted by id (the canonical set; L10 ranks inside the unit itself). */
  boardIds: string[]
  source: 'group' | 'context' | 'team' | 'single'
  scene: Scene
  /** The hero, or co-heroes in slot order. `[]` for `peers` / `docs`: L10's `primary` decides. */
  heroIds: string[]
}

const HUB_ROLES: ReadonlySet<BoardRole> = new Set<BoardRole>(['lead', 'swarm', 'command'])
const TERMINAL_ROLES: ReadonlySet<BoardRole> = new Set<BoardRole>(['agent', 'server', 'shell'])

/**
 * Board type → role for every non-terminal `BoardType` (`boardSchema.ts:122`). Terminals classify
 * by signal instead (agent / ports). A Map, not an object literal: `type` is a free string and must
 * never hit a prototype key.
 */
const TYPE_ROLE: ReadonlyMap<string, BoardRole> = new Map<string, BoardRole>([
  ['swarm', 'swarm'],
  ['command', 'command'],
  ['browser', 'preview'],
  ['planning', 'plan'],
  ['kanban', 'tracker'],
  ['dataflow', 'dataflow'],
  ['file', 'file']
])

type BoardIndex = ReadonlyMap<string, RoleBoardInput>

/** Code-unit string order — locale-independent, so MAIN and the renderer always agree. */
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const cmpNum = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0)
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const coord = (v: number | undefined): number => (isFiniteNum(v) ? v : 0)

/** Valid loopback ports (integers 1..65535), deduped, ascending. MAIN sanitizes them too. */
function validPorts(ports: readonly number[] | undefined): number[] {
  if (!Array.isArray(ports)) return []
  const ok = ports.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535)
  return [...new Set(ok)].sort((a, b) => a - b)
}

/** The canvas boards keyed in id order — docked terminals excluded (they live in their swarm). */
function liveIndex(boards: readonly RoleBoardInput[]): Map<string, RoleBoardInput> {
  const live = boards.filter((b) => !b.dockedIn).sort((a, b) => cmpStr(a.id, b.id))
  return new Map(live.map((b) => [b.id, b]))
}

/** Reading order over board ids: top-left y, then x, then id (C4 step 3's order). */
function readingOrder(index: BoardIndex): (a: string, b: string) => number {
  return (a, b) => {
    const A = index.get(a)
    const B = index.get(b)
    return cmpNum(coord(A?.y), coord(B?.y)) || cmpNum(coord(A?.x), coord(B?.x)) || cmpStr(a, b)
  }
}

function classify(b: RoleBoardInput, leadId: string | null): BoardRole {
  if (leadId !== null && b.id === leadId) return 'lead'
  if (b.type === 'terminal') {
    if (b.agent === true) return 'agent'
    return validPorts(b.ports).length > 0 ? 'server' : 'shell'
  }
  return TYPE_ROLE.get(b.type) ?? 'file'
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** `:5173, :3000` — at most three ports, then `+N more`. Port numbers are classifications (D9). */
function portList(ports: readonly number[]): string {
  const shown = ports
    .slice(0, 3)
    .map((p) => `:${p}`)
    .join(', ')
  return ports.length > 3 ? `${shown} +${ports.length - 3} more` : shown
}

/** The `why` sentence: reads ONLY role, link counts and port numbers — no path or secret source. */
function whyFor(role: BoardRole, b: RoleBoardInput, links: readonly string[]): string {
  const cabled = links.length > 0 ? `, cabled to ${plural(links.length, 'board')}` : ''
  switch (role) {
    case 'lead':
      return `Designated lead${cabled}`
    case 'swarm':
      return `Swarm board${cabled}`
    case 'command':
      return `Command board${cabled}`
    case 'agent':
      return 'Terminal running an agent CLI'
    case 'preview': {
      const calls = validPorts(b.callsPorts)
      const hasSource = !!b.previewSourceId && links.includes(b.previewSourceId)
      const base = hasSource ? 'Browser preview of a linked terminal' : 'Browser preview'
      return calls.length > 0 ? `${base}, calling ${portList(calls)}` : base
    }
    case 'plan':
      return 'Planning board'
    case 'tracker':
      return 'Kanban board'
    case 'dataflow':
      return links.length > 0 ? 'Data-flow board bound to a browser' : 'Data-flow board'
    case 'file':
      return b.type === 'file' ? 'File board' : 'Unrecognized board type, kept as-is'
    case 'server':
      return `Terminal listening on ${portList(validPorts(b.ports))}`
    case 'shell':
      return 'Plain terminal: no agent, no listening port'
  }
}

/**
 * Classify every canvas board (ROLE-LAYOUT §2). Docked boards are left out of the map entirely —
 * they are not canvas geometry — and no link ever points at one. The map iterates in id order.
 *
 * - `lead` ⇐ `opts.leadBoardId` only (MAIN's lead authority supplies it; null/absent ⇒ no lead).
 * - terminal: `agent` ⇐ `agent === true`; else `server` ⇐ ≥ 1 valid port; else `shell`.
 * - by type: browser `preview` · planning `plan` · kanban `tracker` · dataflow · file · swarm ·
 *   command.
 */
export function deriveRoles(
  boards: readonly RoleBoardInput[],
  connectors: readonly ContextConnectorInput[],
  opts: { leadBoardId?: string | null }
): Map<string, BoardRoleInfo> {
  const index = liveIndex(boards)
  const leadId = opts.leadBoardId ?? null
  const roleOf = new Map<string, BoardRole>()
  for (const b of index.values()) roleOf.set(b.id, classify(b, leadId))

  const linked = new Map<string, Set<string>>()
  for (const id of index.keys()) linked.set(id, new Set())
  const link = (from: string, to: string | undefined): void => {
    if (to !== undefined && to !== from && index.has(to)) linked.get(from)?.add(to)
  }

  // Any terminal serving a port counts for preview→server — an agent that runs its own dev
  // server is just as much the page's backend as a plain `server`.
  const serving = [...index.values()]
    .filter((b) => b.type === 'terminal')
    .map((b) => ({ id: b.id, ports: validPorts(b.ports) }))
    .filter((t) => t.ports.length > 0)
  for (const b of index.values()) {
    if (b.type === 'browser') {
      link(b.id, b.previewSourceId)
      const calls = validPorts(b.callsPorts)
      for (const t of serving) if (t.ports.some((p) => calls.includes(p))) link(b.id, t.id)
    } else if (b.type === 'dataflow') {
      link(b.id, b.sourceBoardId)
    }
  }
  for (const c of connectors) {
    if (!index.has(c.sourceId) || !index.has(c.targetId)) continue
    if (c.kind === 'orchestration') {
      // Only a hub's cables are "lead→workers" links; a cable from a plain terminal names no team.
      if (HUB_ROLES.has(roleOf.get(c.sourceId) ?? 'file')) link(c.sourceId, c.targetId)
    } else if (c.kind === 'preview') {
      // `previewConnectorsFor` runs terminal → browser; the link is recorded on the browser's side.
      if (index.get(c.targetId)?.type === 'browser') link(c.targetId, c.sourceId)
      else if (index.get(c.sourceId)?.type === 'browser') link(c.sourceId, c.targetId)
    }
  }

  const order = readingOrder(index)
  const out = new Map<string, BoardRoleInfo>()
  for (const b of index.values()) {
    const role = roleOf.get(b.id) ?? 'file'
    const links = [...(linked.get(b.id) ?? [])].sort(order)
    out.set(b.id, { id: b.id, role, weight: ROLE_WEIGHT[role], links, why: whyFor(role, b, links) })
  }
  return out
}

function rankIds(
  ids: readonly string[],
  index: BoardIndex,
  roles: ReadonlyMap<string, BoardRoleInfo>
): string[] {
  const weight = (id: string): number => roles.get(id)?.weight ?? 0
  const focus = (id: string): number => {
    const t = index.get(id)?.lastFocusedAt
    return isFiniteNum(t) ? t : -Infinity
  }
  const area = (id: string): number => {
    const b = index.get(id)
    const a = b ? b.w * b.h : 0
    return isFiniteNum(a) ? a : 0
  }
  return [...ids].sort(
    (a, b) =>
      cmpNum(weight(b), weight(a)) ||
      cmpNum(focus(b), focus(a)) ||
      cmpNum(area(b), area(a)) ||
      cmpStr(a, b)
  )
}

/**
 * Board ids in HERO order (ROLE-LAYOUT §2): heavier role first; within one weight the newer
 * `lastFocusedAt`, then the larger area (w×h), then the id. Exported so L10 fills slots in the
 * same order the scene picked its hero by.
 */
export function rankBoards(
  ids: readonly string[],
  boards: readonly RoleBoardInput[],
  roles: ReadonlyMap<string, BoardRoleInfo>
): string[] {
  return rankIds(ids, new Map(boards.map((b) => [b.id, b])), roles)
}

function sceneFor(
  ids: readonly string[],
  index: BoardIndex,
  roles: ReadonlyMap<string, BoardRoleInfo>
): { scene: Scene; heroIds: string[] } {
  if (ids.length <= 1) return { scene: 'single', heroIds: [...ids] }
  const ranked = rankIds(ids, index, roles)
  const roleOf = (id: string): BoardRole => roles.get(id)?.role ?? 'file'
  const having = (pred: (r: BoardRole) => boolean): string[] =>
    ranked.filter((id) => pred(roleOf(id)))

  // §3, top to bottom — the first match wins.
  const leads = having((r) => r === 'lead')
  if (leads.length > 0) return { scene: 'lead', heroIds: [leads[0]] }
  const hubs = having((r) => r === 'swarm' || r === 'command')
  if (hubs.length > 0) return { scene: 'hub', heroIds: [hubs[0]] }
  const agents = having((r) => r === 'agent')
  const previews = having((r) => r === 'preview')
  if (agents.length > 0 && previews.length > 0) {
    // Co-heroes: the top agent + the top preview linked to it (its source, or a port it serves),
    // else the top preview.
    const top = agents[0]
    const mine = previews.find((p) => roles.get(p)?.links.includes(top) ?? false)
    return { scene: 'pair', heroIds: [top, mine ?? previews[0]] }
  }
  if (previews.length > 0 && having((r) => r === 'server').length > 0) {
    // The top preview; when ≥ 2 previews in the unit share its source (mobile + desktop of one
    // app, S5) they are all co-heroes, in rank order.
    const top = previews[0]
    const source = index.get(top)?.previewSourceId
    const twins = source ? previews.filter((p) => index.get(p)?.previewSourceId === source) : []
    return { scene: 'stack', heroIds: twins.length >= 2 ? twins : [top] }
  }
  if (having((r) => TERMINAL_ROLES.has(r)).length >= 2) return { scene: 'peers', heroIds: [] }
  // `docs` proper (only plan / tracker / file / dataflow) — and the fallback for any mix no row
  // above matched (see the header): shelf keeps every size, and no hero is forced.
  return { scene: 'docs', heroIds: [] }
}

/**
 * The scene + hero(es) of one unit's boards (ROLE-LAYOUT §3). `buildRoleUnits` already stamps
 * this on every unit; exported so L10 can re-ask for a scoped subset (S12) without new units.
 */
export function classifyScene(
  boardIds: readonly string[],
  boards: readonly RoleBoardInput[],
  roles: ReadonlyMap<string, BoardRoleInfo>
): { scene: Scene; heroIds: string[] } {
  return sceneFor(boardIds, new Map(boards.map((b) => [b.id, b])), roles)
}

/**
 * Units = Named Groups ∪ TEAM units ∪ C3 contexts ∪ singles — every non-docked board in exactly
 * one unit, docked boards in none. Precedence, highest first:
 *  1. **Named Group** — authoritative. A board in several goes to the smallest (fewest live
 *     members, then group id): C4 step 1's rule, so `roles` and `fit` agree on membership.
 *  2. **TEAM** — a lead / command / swarm board (unclaimed by a group) plus its direct
 *     orchestration-cable targets that are not grouped, not docked and not hubs themselves. C3
 *     deliberately drops a ≥ 3-cable hub's edges, so without this a lead and its workers would
 *     never share a unit. A target of two hubs goes to the heavier hub (id tie-break).
 *     **Riders** then join, to a fixed point: an unclaimed non-hub board preview- or
 *     dataflow-linked to a team member.
 *  3. **context** — each C3 context (smallest first, then key) minus every claimed board: a
 *     remainder of ≥ 2 stays a `context` unit under the C3 key; a remainder of 1 falls through to
 *     a single. Group contexts (`existingGroupId`) are skipped — see the header.
 *  4. **single** — whatever is left, one unit per board.
 * Output order is reading order of each unit's top-left (y, x), then key — input-order invariant.
 */
export function buildRoleUnits(
  boards: readonly RoleBoardInput[],
  connectors: readonly ContextConnectorInput[],
  groups: readonly ContextGroupInput[],
  contexts: readonly DerivedContext[],
  roles: ReadonlyMap<string, BoardRoleInfo>
): RoleUnit[] {
  const index = liveIndex(boards)
  // A board missing from `roles` (caller passed a stale map) is treated as an inert rigid `file`
  // rather than dropped — every live board must still land in exactly one unit.
  const roleOf = (id: string): BoardRole => roles.get(id)?.role ?? 'file'
  const weightOf = (id: string): number => roles.get(id)?.weight ?? 0
  const isHub = (id: string): boolean => HUB_ROLES.has(roleOf(id))
  /** Hub `a` outranks hub `b`: heavier role, then the smaller id. */
  const outranks = (a: string, b: string): boolean =>
    weightOf(a) > weightOf(b) || (weightOf(a) === weightOf(b) && a < b)
  const liveIds = (ids: readonly string[]): string[] =>
    [...new Set(ids)].filter((id) => index.has(id)).sort(cmpStr)
  const smallest = (a: { id: string; ids: string[] }, b: { id: string; ids: string[] }): number =>
    a.ids.length - b.ids.length || cmpStr(a.id, b.id)

  const drafts = new Map<string, { source: RoleUnit['source']; ids: Set<string> }>()
  const owner = new Map<string, string>()
  const claim = (key: string, source: RoleUnit['source'], id: string): void => {
    if (owner.has(id)) return
    owner.set(id, key)
    const draft = drafts.get(key) ?? { source, ids: new Set<string>() }
    draft.ids.add(id)
    drafts.set(key, draft)
  }

  // 1 · Named Groups.
  const named = groups.map((g) => ({ id: g.id, ids: liveIds(g.boardIds) }))
  for (const id of index.keys()) {
    const home = named.filter((g) => g.ids.includes(id)).sort(smallest)[0]
    if (home) claim(home.id, 'group', id)
  }

  // 2 · TEAM units. `teamOf` maps every member (hub included) to its hub.
  const hubOf = new Map<string, string>()
  for (const c of connectors) {
    const hub = c.sourceId
    const worker = c.targetId
    if (c.kind !== 'orchestration' || hub === worker) continue
    if (!index.has(hub) || !index.has(worker) || !isHub(hub) || isHub(worker)) continue
    if (owner.has(hub) || owner.has(worker)) continue
    const prev = hubOf.get(worker)
    if (prev === undefined || outranks(hub, prev)) hubOf.set(worker, hub)
  }
  const teamOf = new Map<string, string>()
  for (const [worker, hub] of hubOf) {
    teamOf.set(worker, hub)
    teamOf.set(hub, hub)
  }
  // 2b · Riders, over the UNDIRECTED rider links: a preview's links (its source + port-served
  // terminals) and a data-flow board's link (its browser). Fixed point in rounds: each round reads
  // only the teams as they stood when it began and assigns all of its picks together, so the
  // result never depends on input order. Every round claims ≥ 1 board, so it ends in ≤ n rounds.
  const riderLinks = new Map<string, Set<string>>()
  const touch = (a: string, b: string): void => {
    const set = riderLinks.get(a) ?? new Set<string>()
    set.add(b)
    riderLinks.set(a, set)
  }
  for (const [id, info] of roles) {
    if ((info.role !== 'preview' && info.role !== 'dataflow') || !index.has(id)) continue
    for (const other of info.links) {
      touch(id, other)
      touch(other, id)
    }
  }
  for (;;) {
    const picks = new Map<string, string>()
    for (const id of index.keys()) {
      if (owner.has(id) || teamOf.has(id) || isHub(id)) continue
      let best: string | undefined
      for (const n of riderLinks.get(id) ?? []) {
        const hub = teamOf.get(n)
        if (hub !== undefined && (best === undefined || outranks(hub, best))) best = hub
      }
      if (best !== undefined) picks.set(id, best)
    }
    if (picks.size === 0) break
    for (const [id, hub] of picks) teamOf.set(id, hub)
  }
  for (const [member, hub] of teamOf) claim(`team:${hub}`, 'team', member)

  // 3 · C3 contexts, minus everything already claimed.
  const derived = contexts
    .filter((c) => !c.existingGroupId)
    .map((c) => ({ id: c.key, ids: liveIds(c.boardIds) }))
    .sort(smallest)
  for (const c of derived) {
    const rest = c.ids.filter((id) => !owner.has(id))
    if (rest.length >= 2) for (const id of rest) claim(c.id, 'context', id)
  }

  // 4 · Singles.
  for (const id of index.keys()) claim(`single:${id}`, 'single', id)

  const units: RoleUnit[] = []
  const topLeft = new Map<string, { x: number; y: number }>()
  for (const [key, draft] of drafts) {
    const boardIds = [...draft.ids].sort(cmpStr)
    units.push({ key, boardIds, source: draft.source, ...sceneFor(boardIds, index, roles) })
    topLeft.set(key, {
      x: Math.min(...boardIds.map((id) => coord(index.get(id)?.x))),
      y: Math.min(...boardIds.map((id) => coord(index.get(id)?.y)))
    })
  }
  const at = (key: string): { x: number; y: number } => topLeft.get(key) ?? { x: 0, y: 0 }
  return units.sort(
    (a, b) =>
      cmpNum(at(a.key).y, at(b.key).y) || cmpNum(at(a.key).x, at(b.key).x) || cmpStr(a.key, b.key)
  )
}
