/**
 * `units[].why` for the role-aware tidy (spatial-awareness C10, ROLE-LAYOUT §8 "the ack explains
 * itself"): one short human sentence per unit, e.g. `hero = browser 'App': preview of :5173`.
 *
 * D9: built from ROLES, port numbers, board ids and (optionally) caller-supplied titles ONLY —
 * never a path, cwd or launch line (none of those even reach `RoleBoardInput`). Titles are
 * stripped of control / bidi / zero-width characters and clamped, so a hostile title cannot
 * reshape the agent-facing ack.
 */
import type { BoardRole, BoardRoleInfo, RoleBoardInput } from '../../../shared/boardRoles'

const NOUN: Readonly<Record<BoardRole, string>> = {
  lead: 'lead',
  swarm: 'swarm',
  command: 'command board',
  agent: 'agent',
  preview: 'browser',
  plan: 'plan',
  tracker: 'kanban',
  dataflow: 'data-flow board',
  file: 'file',
  server: 'server',
  shell: 'shell'
}

/** Longest title echoed into a sentence. */
const TITLE_MAX = 40

// C0/C1 controls, zero-width + bidi controls, BOM — never echoed into the ack.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

export interface WhyContext {
  boards: ReadonlyMap<string, RoleBoardInput>
  roles: ReadonlyMap<string, BoardRoleInfo>
  titles?: Readonly<Record<string, string>>
  /** Docked workers per host board (they are not canvas geometry, but explain a swarm hero). */
  docked?: ReadonlyMap<string, number>
}

const roleOf = (ctx: WhyContext, id: string): BoardRole => ctx.roles.get(id)?.role ?? 'file'
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const t = raw.replace(UNSAFE, '').replace(/\s+/g, ' ').replace(/'/g, '’').trim()
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t
}

/** `browser 'App'`, or `browser #b8b4c254` without a title. */
export function nameOf(ctx: WhyContext, id: string): string {
  const title = cleanTitle(ctx.titles?.[id])
  return `${NOUN[roleOf(ctx, id)]} ${title ? `'${title}'` : `#${id.slice(0, 8)}`}`
}

/** Valid loopback ports, deduped and ascending (the classification D9 lets through). */
function ports(list: readonly number[] | undefined): number[] {
  if (!Array.isArray(list)) return []
  const ok = list.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535)
  return [...new Set(ok)].sort((a, b) => a - b)
}

const portList = (ps: readonly number[]): string =>
  ps
    .slice(0, 2)
    .map((p) => `:${p}`)
    .join(', ') + (ps.length > 2 ? ` +${ps.length - 2}` : '')

/** Why this board is the hero — role + ports + link counts only. */
export function heroDetail(ctx: WhyContext, id: string): string {
  const b = ctx.boards.get(id)
  const info = ctx.roles.get(id)
  const role = roleOf(ctx, id)
  const links = info?.links.length ?? 0
  switch (role) {
    case 'preview': {
      // The source terminal's port names the app; the ports the page CALLS (D10) come second.
      const source = b?.previewSourceId ? ctx.boards.get(b.previewSourceId) : undefined
      const own = ports(source?.ports)
      const calls = ports(b?.callsPorts).filter((p) => !own.includes(p))
      if (own.length > 0) {
        return `preview of ${portList(own)}${calls.length > 0 ? `, calls ${portList(calls)}` : ''}`
      }
      if (calls.length > 0) return `preview calling ${portList(calls)}`
      return source ? `preview of ${nameOf(ctx, source.id)}` : 'browser preview'
    }
    case 'lead':
    case 'swarm':
    case 'command': {
      if (links > 0) return `cabled to ${plural(links, 'board')}`
      const docked = ctx.docked?.get(id) ?? 0
      return docked > 0 ? `${plural(docked, 'docked worker')} inside` : 'no cables yet'
    }
    case 'agent':
      return 'runs an agent CLI'
    case 'server':
      return `listening on ${portList(ports(b?.ports))}`
    case 'shell':
      return 'plain shell'
    default:
      return 'kept at its size'
  }
}

export type WhyKind = 'single' | 'hero' | 'grid' | 'shelf' | 'implicit' | 'order'

export interface WhyInput {
  kind: WhyKind
  boardIds: readonly string[]
  heroIds: readonly string[]
  primary?: string
  /** grid columns × rows. */
  grid?: { cols: number; rows: number }
}

/** One sentence describing how a unit was arranged. */
export function unitWhy(ctx: WhyContext, w: WhyInput): string {
  const n = w.boardIds.length
  const heroPart = (): string => {
    if (w.heroIds.length === 0) return `${n} boards`
    const names = w.heroIds.map((id) => nameOf(ctx, id)).join(' + ')
    const lead = w.heroIds.find((id) => roleOf(ctx, id) === 'preview') ?? w.heroIds[0]
    const tag = w.heroIds.length > 1 ? 'co-heroes' : 'hero'
    const primary = w.primary !== undefined && w.heroIds.includes(w.primary) ? ' (primary)' : ''
    return `${tag} = ${names}: ${heroDetail(ctx, lead)}${primary}`
  }
  switch (w.kind) {
    case 'single':
      return `single: ${nameOf(ctx, w.boardIds[0])} kept at its size`
    case 'hero':
      return heroPart()
    case 'grid': {
      const terms = w.boardIds.every((id) => ['agent', 'server', 'shell'].includes(roleOf(ctx, id)))
      const g = w.grid ?? { cols: n, rows: 1 }
      return `peers: ${n} ${terms ? 'terminals' : 'boards'} in a ${g.cols}×${g.rows} grid`
    }
    case 'shelf':
      return `docs: ${n} boards in reading order, sizes kept`
    case 'implicit':
      return `plain shells: ${n} terminals packed by position, sizes kept (implicit tidy)`
    case 'order':
      return `${heroPart()}; role order only, sizes kept (resize:false)`
  }
}
