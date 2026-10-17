/**
 * Context derivation (spatial-awareness contract C3, decision D5): which boards on the canvas belong
 * together. MAIN runs it over the board mirror to serve `canvas://contexts` and to build
 * `group_boards` proposals, and the renderer imports it for `fit` packing units, so both sides
 * agree on what a "context" is.
 *
 * The rules (SPEC §3 C3, each pinned by a unit test):
 *  1. Docked terminals are excluded. They live inside a swarm board and are not canvas geometry.
 *  2. Named Groups are authoritative. Each is emitted as-is (`existingGroupId`, `'group'`, high);
 *     signals never split or merge one.
 *  3. Absorb: take the components of UNGROUPED boards joined by STRONG edges (preview, non-hub
 *     orchestration, port, dataflow). A component whose strong edges reach members of exactly ONE
 *     group is proposed whole via that group's `addBoardIds`, so a worker's browser rides along
 *     with the worker. Two groups ⇒ ambiguous ⇒ none of it is absorbed (it still clusters under 4).
 *  4. The remaining ungrouped boards cluster by union-find over the strong edges plus cwd /
 *     fileRef / (opt-in) title. A HUB (a source with ≥ {@link HUB_MIN_CABLES} outgoing
 *     orchestration cables) contributes no edges on purpose: one lead must not fuse all its workers
 *     into one blob. C9's TEAM unit (L9) is what keeps a lead with its workers.
 *  5. Singleton clusters are never emitted.
 *  6. Confidence: high on any group / preview / orchestration / port / dataflow edge, else medium
 *     on cwd / fileRef, else low.
 *  7. Name: planning title → terminal title → common cwd basename → `Context N`, sanitized.
 *  8. Deterministic: sorted ids, output sorted by first board id, no randomness, capped at
 *     {@link MAX_CONTEXTS}.
 *  9. Signals by board type only (defence in depth behind MAIN's sanitizer): see
 *     {@link projectBoard}. A field on any other type is ignored.
 *
 * Pure TypeScript: no Node built-ins, no DOM, no `src/main` / `src/renderer` imports. It compiles
 * under tsconfig.node AND tsconfig.web, which is also why it never reads `process.platform` (MAIN
 * passes {@link DeriveOptions.pathCase} instead).
 */
import { sanitizeGroupName } from './groupName'

export interface ContextBoardInput {
  id: string
  type: string
  title: string
  /** Terminal boards: the shell's working directory. */
  cwd?: string
  /** Browser boards: the terminal that drives the preview. */
  previewSourceId?: string
  /** A worker terminal docked inside a swarm board. Such a board is excluded (rule 1). */
  dockedIn?: string
  /** File boards: the project-relative path of the open file. */
  path?: string
  /** Planning boards: the files their file-reference chips point at. */
  fileRefs?: Array<{ path: string }>
  /** Terminal boards: detected loopback listening ports (C9 signal, L11). */
  ports?: number[]
  /** Browser boards: loopback ports the page requested (D10, L11). */
  callsPorts?: number[]
  /** Data-flow boards: the browser the board inspects. */
  sourceBoardId?: string
}

export interface ContextConnectorInput {
  sourceId: string
  targetId: string
  kind: 'preview' | 'orchestration'
}

export interface ContextGroupInput {
  id: string
  name: string
  boardIds: string[]
}

export type ContextSignal =
  | 'group'
  | 'preview'
  | 'orchestration'
  | 'port'
  | 'dataflow'
  | 'cwd'
  | 'fileRef'
  | 'title'

export interface DerivedContext {
  /** Stable: FNV-1a hash of the sorted board ids (see {@link contextKey}). */
  key: string
  /** At most `GROUP_NAME_MAX` (80) code units, sanitized with `sanitizeGroupName`. */
  suggestedName: string
  /** Sorted. */
  boardIds: string[]
  /** Why these boards belong together, in canonical order. An enum list, never raw paths. */
  signals: ContextSignal[]
  confidence: 'high' | 'medium' | 'low'
  /** Set when this context IS (or extends) an existing Named Group. */
  existingGroupId?: string
  /** Sorted ungrouped boards proposed to join `existingGroupId` (rule 3). */
  addBoardIds?: string[]
}

export interface DeriveOptions {
  /** A cwd equal to this carries NO signal: it is every terminal's default. */
  projectRoot?: string
  /** Opt-in, low-confidence title-similarity edges. Default false. */
  titleSignal?: boolean
  /**
   * How cwd / file paths compare. Default `'insensitive'`. MAIN sets it from the platform: this
   * module also runs in the renderer, so it cannot read `process.platform` itself.
   */
  pathCase?: 'insensitive' | 'sensitive'
}

export const MAX_CONTEXTS = 50
/** A source with at least this many outgoing orchestration cables is a hub (rule 4). */
export const HUB_MIN_CABLES = 3
/** Minimum token Jaccard similarity for a title edge (rule 4, opt-in). */
export const TITLE_JACCARD_MIN = 0.5

type PathCase = NonNullable<DeriveOptions['pathCase']>
type Confidence = DerivedContext['confidence']

/** Canonical signal order. Also the order `signals` is emitted in. */
const SIGNAL_ORDER: readonly ContextSignal[] = [
  'group',
  'preview',
  'orchestration',
  'port',
  'dataflow',
  'cwd',
  'fileRef',
  'title'
]
const HIGH_SIGNALS: ReadonlySet<ContextSignal> = new Set([
  'group',
  'preview',
  'orchestration',
  'port',
  'dataflow'
])
const MEDIUM_SIGNALS: ReadonlySet<ContextSignal> = new Set(['cwd', 'fileRef'])

/**
 * Words that never count as a title match on their own: glue words, the per-type default board
 * titles (mirror of `DEFAULT_TITLE` in `boardDefaults.ts`), agent CLI names and URL noise. Without
 * this, two untouched "Terminal" boards would always match.
 */
const TITLE_STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an and at by for from in of on or the to with new copy untitled board ' +
    'terminal browser planning orchestrator file data flow kanban swarm ' +
    'claude codex gemini opencode http https www localhost'
  ).split(' ')
)

/**
 * The per-type default board titles, lowercased (mirror of `DEFAULT_TITLE` in `boardDefaults.ts`,
 * pinned by `src/renderer/src/lib/deriveContexts.parity.test.ts`). Such a title says nothing about
 * the context, so naming skips it.
 */
export const GENERIC_BOARD_TITLES: ReadonlySet<string> = new Set([
  'terminal',
  'browser',
  'planning',
  'orchestrator',
  'file',
  'data flow',
  'kanban',
  'swarm'
])

/**
 * A live board reduced to the signal fields its TYPE may carry (rule 9). Paths are cleaned but keep
 * their case (naming needs it); `''` / `[]` means "no signal".
 */
interface LiveBoard {
  id: string
  type: string
  title: string
  cwd: string
  ports: number[]
  previewSourceId: string
  callsPorts: number[]
  path: string
  fileRefs: string[]
  sourceBoardId: string
}

interface Edge {
  a: string
  b: string
  signal: ContextSignal
}

/** A context before naming, keying and the cap. */
interface Draft {
  boardIds: string[]
  signals: Set<ContextSignal>
  confidence: Confidence
  /** '' ⇒ gets `Context N` in output order. */
  name: string
  existingGroupId?: string
  addBoardIds?: string[]
}

/** Code-unit order: locale-free, so the output is identical on every machine. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Separators to `/`, duplicate slashes collapsed (a UNC `//` prefix kept), trailing `/` and a
 *  leading `./` stripped. Case is preserved (naming needs it); {@link foldPath} folds it. */
function cleanPath(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let p = raw.trim().replace(/\\/g, '/')
  const unc = p.startsWith('//')
  p = p.replace(/\/{2,}/g, '/')
  if (unc) p = `/${p}`
  p = p.replace(/^(\.\/)+/, '')
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

function foldPath(p: string, pathCase: PathCase): string {
  return pathCase === 'insensitive' ? p.toLowerCase() : p
}

/**
 * The comparison key for a cwd or file path: separators normalized, trailing slash stripped and,
 * unless `pathCase` is `'sensitive'`, case-folded. `''` for a missing or blank path.
 */
export function normalizeContextPath(raw: unknown, pathCase: PathCase = 'insensitive'): string {
  return foldPath(cleanPath(raw), pathCase)
}

/**
 * The stable key of a board set: FNV-1a (32-bit, over UTF-16 code units) of the sorted ids joined
 * by NUL, in base 36. Order-independent; no Node `crypto`, so it runs on both sides of the IPC.
 */
export function contextKey(boardIds: readonly string[]): string {
  const s = [...boardIds].sort(compareStrings).join('\u0000')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `ctx-${(h >>> 0).toString(36).padStart(7, '0')}`
}

/** Valid TCP ports only (integers 1..65535), deduped. */
function validPorts(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const out = new Set<number>()
  for (const p of raw) if (Number.isInteger(p) && p >= 1 && p <= 65535) out.add(p as number)
  return [...out]
}

function idField(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

/**
 * Rule 9: read each signal field only from the board type that owns it. `cwd` / `ports` from
 * terminals, `previewSourceId` / `callsPorts` from browsers, `path` from file boards, `fileRefs`
 * from planning boards, `sourceBoardId` from data-flow boards.
 */
function projectBoard(board: ContextBoardInput): LiveBoard {
  const is = (type: string): boolean => board.type === type
  const refs = is('planning') && Array.isArray(board.fileRefs) ? board.fileRefs : []
  return {
    id: board.id,
    type: board.type,
    title: typeof board.title === 'string' ? board.title : '',
    cwd: is('terminal') ? cleanPath(board.cwd) : '',
    ports: is('terminal') ? validPorts(board.ports) : [],
    previewSourceId: is('browser') ? idField(board.previewSourceId) : '',
    callsPorts: is('browser') ? validPorts(board.callsPorts) : [],
    path: is('file') ? cleanPath(board.path) : '',
    fileRefs: refs.map((ref) => cleanPath(ref?.path)).filter((p) => p !== ''),
    sourceBoardId: is('dataflow') ? idField(board.sourceBoardId) : ''
  }
}

/**
 * Union-find with the smaller id as the root, so a set's representative never depends on the order
 * the edges arrive in.
 */
function makeUnionFind(ids: readonly string[]): {
  find: (id: string) => string
  union: (a: string, b: string) => void
} {
  const parent = new Map<string, string>(ids.map((id) => [id, id]))
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    let cur = id
    while (cur !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    if (ra < rb) parent.set(rb, ra)
    else parent.set(ra, rb)
  }
  return { find, union }
}

/**
 * Sources with ≥ {@link HUB_MIN_CABLES} distinct orchestration targets. Targets count while they
 * exist at all, docked or not: the cable count is a property of the source (a lead driving three
 * workers is a lead, even when one of them sits docked in a swarm).
 */
function hubSources(
  connectors: readonly ContextConnectorInput[],
  allIds: ReadonlySet<string>
): Set<string> {
  const targets = new Map<string, Set<string>>()
  for (const c of connectors) {
    if (c?.kind !== 'orchestration' || c.sourceId === c.targetId) continue
    if (!allIds.has(c.sourceId) || !allIds.has(c.targetId)) continue
    const set = targets.get(c.sourceId) ?? new Set<string>()
    set.add(c.targetId)
    targets.set(c.sourceId, set)
  }
  const hubs = new Set<string>()
  for (const [source, set] of targets) if (set.size >= HUB_MIN_CABLES) hubs.add(source)
  return hubs
}

/**
 * The STRONG edges among live boards: preview (`previewSourceId` and `kind:'preview'` cables),
 * orchestration cables from a non-hub source, port (a browser's `callsPorts` meeting a terminal's
 * `ports`, D10) and dataflow (`sourceBoardId`). Rule 3 absorbs over these; rule 4 clusters over them.
 */
function strongLinks(
  live: ReadonlyMap<string, LiveBoard>,
  connectors: readonly ContextConnectorInput[],
  hubs: ReadonlySet<string>
): Edge[] {
  const edges: Edge[] = []
  const linkField = (board: LiveBoard, target: string, signal: ContextSignal): void => {
    if (target !== '' && target !== board.id && live.has(target)) {
      edges.push({ a: board.id, b: target, signal })
    }
  }
  const byPort = new Map<number, string[]>()
  for (const board of live.values()) {
    linkField(board, board.previewSourceId, 'preview')
    linkField(board, board.sourceBoardId, 'dataflow')
    for (const port of board.ports) pushTo(byPort, port, board.id)
  }
  for (const board of live.values()) {
    for (const port of board.callsPorts) {
      for (const server of byPort.get(port) ?? []) linkField(board, server, 'port')
    }
  }
  for (const c of connectors) {
    if (!c || c.sourceId === c.targetId || !live.has(c.sourceId) || !live.has(c.targetId)) continue
    if (c.kind === 'preview') edges.push({ a: c.sourceId, b: c.targetId, signal: 'preview' })
    else if (c.kind === 'orchestration' && !hubs.has(c.sourceId)) {
      edges.push({ a: c.sourceId, b: c.targetId, signal: 'orchestration' })
    }
  }
  return edges
}

/** Rule 2 input: each group's live members (sorted, deduped). Groups left empty are dropped. */
function liveGroups(
  groups: readonly ContextGroupInput[],
  live: ReadonlyMap<string, LiveBoard>
): Array<{ group: ContextGroupInput; members: string[] }> {
  const out: Array<{ group: ContextGroupInput; members: string[] }> = []
  const seen = new Set<string>()
  for (const group of groups) {
    if (typeof group?.id !== 'string' || seen.has(group.id) || !Array.isArray(group.boardIds)) {
      continue
    }
    seen.add(group.id)
    const members = [...new Set(group.boardIds.filter((id) => live.has(id)))].sort(compareStrings)
    if (members.length > 0) out.push({ group, members })
  }
  return out.sort((x, y) => compareStrings(x.group.id, y.group.id))
}

/**
 * Rule 3. Joins the ungrouped boards into components over the strong edges, then proposes each
 * component whose strong edges reach members of exactly ONE group, whole, for that group. Returns,
 * per group id, the absorbed ids (sorted) and the edge kinds that carried them: the edges that
 * reach the group and the edges inside the component.
 */
function absorb(
  ungrouped: readonly string[],
  strong: readonly Edge[],
  memberOf: ReadonlyMap<string, ReadonlySet<string>>
): Map<string, { ids: string[]; signals: Set<ContextSignal> }> {
  const isStray = new Set(ungrouped)
  const uf = makeUnionFind(ungrouped)
  for (const e of strong) if (isStray.has(e.a) && isStray.has(e.b)) uf.union(e.a, e.b)
  const reach = new Map<string, { groups: Set<string>; signals: Set<ContextSignal> }>()
  const reachOf = (strayId: string): { groups: Set<string>; signals: Set<ContextSignal> } => {
    const root = uf.find(strayId)
    const entry = reach.get(root) ?? {
      groups: new Set<string>(),
      signals: new Set<ContextSignal>()
    }
    reach.set(root, entry)
    return entry
  }
  for (const e of strong) {
    const strayA = isStray.has(e.a)
    const strayB = isStray.has(e.b)
    if (!strayA && !strayB) continue
    const entry = reachOf(strayA ? e.a : e.b)
    entry.signals.add(e.signal)
    if (strayA && strayB) continue
    for (const groupId of memberOf.get(strayA ? e.b : e.a) ?? []) entry.groups.add(groupId)
  }
  const out = new Map<string, { ids: string[]; signals: Set<ContextSignal> }>()
  for (const id of ungrouped) {
    const entry = reach.get(uf.find(id))
    if (!entry || entry.groups.size !== 1) continue
    const [groupId] = entry.groups
    const target = out.get(groupId) ?? { ids: [], signals: new Set<ContextSignal>() }
    target.ids.push(id)
    for (const s of entry.signals) target.signals.add(s)
    out.set(groupId, target)
  }
  return out
}

/** Lowercased letter/digit runs of a title. */
function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0)
  )
}

/** Token Jaccard ≥ {@link TITLE_JACCARD_MIN}, and the shared tokens hold ≥ 1 non-stopword. */
function titlesMatch(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  let shared = 0
  let content = false
  for (const t of a) {
    if (!b.has(t)) continue
    shared++
    if (!TITLE_STOPWORDS.has(t)) content = true
  }
  return content && shared / (a.size + b.size - shared) >= TITLE_JACCARD_MIN
}

/** Edges that join every board of a bucket (a chain is enough for union-find). */
function chain(ids: readonly string[], signal: ContextSignal, out: Edge[]): void {
  for (let i = 1; i < ids.length; i++) out.push({ a: ids[i - 1], b: ids[i], signal })
}

/** Rule 4: the cwd / fileRef / title edges among the remaining boards. */
function weakEdges(
  remaining: readonly string[],
  live: ReadonlyMap<string, LiveBoard>,
  opts: { pathCase: PathCase; rootKey: string; titleSignal: boolean }
): Edge[] {
  const edges: Edge[] = []
  const byCwd = new Map<string, string[]>()
  const byFile = new Map<string, { refs: Set<string>; files: Set<string> }>()
  const fileEntry = (path: string): { refs: Set<string>; files: Set<string> } => {
    const key = foldPath(path, opts.pathCase)
    const entry = byFile.get(key) ?? { refs: new Set<string>(), files: new Set<string>() }
    byFile.set(key, entry)
    return entry
  }
  for (const id of remaining) {
    const board = live.get(id)!
    const cwd = foldPath(board.cwd, opts.pathCase)
    if (cwd !== '' && cwd !== opts.rootKey) pushTo(byCwd, cwd, id)
    if (board.path !== '') fileEntry(board.path).files.add(id)
    for (const ref of board.fileRefs) fileEntry(ref).refs.add(id)
  }
  for (const ids of byCwd.values()) chain(ids, 'cwd', edges)
  for (const { refs, files } of byFile.values()) {
    const ids = [...new Set([...refs, ...files])].sort(compareStrings)
    // A file shared only by file boards is not a rule-4 edge: one side must be a ref holder.
    if (refs.size > 0) chain(ids, 'fileRef', edges)
  }
  if (opts.titleSignal) {
    const tokens = remaining.map((id) => [id, titleTokens(live.get(id)!.title)] as const)
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        if (titlesMatch(tokens[i][1], tokens[j][1])) {
          edges.push({ a: tokens[i][0], b: tokens[j][0], signal: 'title' })
        }
      }
    }
  }
  return edges
}

/** Rule 6. */
function confidenceOf(signals: ReadonlySet<ContextSignal>): Confidence {
  for (const s of signals) if (HIGH_SIGNALS.has(s)) return 'high'
  for (const s of signals) if (MEDIUM_SIGNALS.has(s)) return 'medium'
  return 'low'
}

/**
 * Basename of the deepest directory every member cwd sits in, or `''` when there is none, it is
 * the project root (or above it), or it is a bare drive. Display case comes from the first member.
 */
function commonCwdBasename(cwds: readonly string[], pathCase: PathCase, rootKey: string): string {
  if (cwds.length === 0) return ''
  const [first, ...rest] = cwds.map((c) => c.split('/'))
  const same = (segs: string[], i: number): boolean =>
    i < segs.length && foldPath(segs[i], pathCase) === foldPath(first[i], pathCase)
  let depth = first.length
  for (const segs of rest) {
    let i = 0
    while (i < depth && same(segs, i)) i++
    depth = i
  }
  const common = first.slice(0, depth)
  const commonKey = foldPath(common.join('/'), pathCase)
  if (rootKey !== '' && (commonKey === rootKey || rootKey.startsWith(`${commonKey}/`))) return ''
  const base = common[common.length - 1] ?? ''
  return /^[a-z]:$/i.test(base) ? '' : base
}

/** Rule 7, minus the `Context N` fallback (assigned in output order by {@link finalize}). */
function nameFromMembers(
  ids: readonly string[],
  live: ReadonlyMap<string, LiveBoard>,
  pathCase: PathCase,
  rootKey: string
): string {
  for (const type of ['planning', 'terminal']) {
    for (const id of ids) {
      const board = live.get(id)!
      if (board.type !== type) continue
      const name = sanitizeGroupName(board.title)
      if (name !== '' && !GENERIC_BOARD_TITLES.has(name.toLowerCase())) return name
    }
  }
  const cwds = ids
    .map((id) => live.get(id)!.cwd)
    .filter((c) => c !== '' && foldPath(c, pathCase) !== rootKey)
  return sanitizeGroupName(commonCwdBasename(cwds, pathCase, rootKey))
}

/** Lexicographic over the sorted board ids, then the group id: a total, locale-free order. */
function compareDrafts(x: Draft, y: Draft): number {
  const n = Math.min(x.boardIds.length, y.boardIds.length)
  for (let i = 0; i < n; i++) {
    const c = compareStrings(x.boardIds[i], y.boardIds[i])
    if (c !== 0) return c
  }
  if (x.boardIds.length !== y.boardIds.length) return x.boardIds.length - y.boardIds.length
  return compareStrings(x.existingGroupId ?? '', y.existingGroupId ?? '')
}

const CAP_RANK: Readonly<Record<Confidence, number>> = { high: 1, medium: 2, low: 3 }

/**
 * Rule 8. Over the cap, Named Groups (the user's own structure) survive first, then higher
 * confidence, then larger contexts. The survivors are then sorted by first board id, unnamed ones
 * get `Context N` in that order, and a duplicate key (two groups with the same live members) gets a
 * `-2`, `-3`… suffix so every key stays unique.
 */
function finalize(drafts: Draft[]): DerivedContext[] {
  const rank = (d: Draft): number => (d.existingGroupId !== undefined ? 0 : CAP_RANK[d.confidence])
  const kept = [...drafts]
    .sort(
      (x, y) => rank(x) - rank(y) || y.boardIds.length - x.boardIds.length || compareDrafts(x, y)
    )
    .slice(0, MAX_CONTEXTS)
    .sort(compareDrafts)
  const keys = new Map<string, number>()
  let unnamed = 0
  return kept.map((d) => {
    const base = contextKey(d.boardIds)
    const n = (keys.get(base) ?? 0) + 1
    keys.set(base, n)
    return {
      key: n === 1 ? base : `${base}-${n}`,
      suggestedName: d.name !== '' ? d.name : `Context ${++unnamed}`,
      boardIds: d.boardIds,
      signals: SIGNAL_ORDER.filter((s) => d.signals.has(s)),
      confidence: d.confidence,
      ...(d.existingGroupId !== undefined ? { existingGroupId: d.existingGroupId } : {}),
      ...(d.addBoardIds !== undefined ? { addBoardIds: d.addBoardIds } : {})
    }
  })
}

/**
 * Derive the canvas's contexts from the board mirror (C3). Pure and deterministic: the same boards,
 * connectors and groups in any order give the same output. Board and group ids are assumed unique
 * (the mirror guarantees it); on a duplicate the first occurrence wins.
 */
export function deriveContexts(
  boards: readonly ContextBoardInput[],
  connectors: readonly ContextConnectorInput[],
  groups: readonly ContextGroupInput[],
  opts: DeriveOptions = {}
): DerivedContext[] {
  const pathCase: PathCase = opts.pathCase === 'sensitive' ? 'sensitive' : 'insensitive'
  const rootKey = normalizeContextPath(opts.projectRoot, pathCase)

  // Rule 1: every board that exists counts toward hub detection; only undocked ones are contexts.
  // `dockedIn` is read from terminals only (rule 9): only a terminal can be docked.
  const allIds = new Set<string>()
  const live = new Map<string, LiveBoard>()
  for (const board of boards) {
    if (typeof board?.id !== 'string' || board.id === '' || allIds.has(board.id)) continue
    allIds.add(board.id)
    const docked = board.type === 'terminal' && idField(board.dockedIn) !== ''
    if (!docked) live.set(board.id, projectBoard(board))
  }
  const strong = strongLinks(live, connectors, hubSources(connectors, allIds))

  // Rule 2: Named Groups, as the user drew them.
  const named = liveGroups(groups, live)
  const memberOf = new Map<string, Set<string>>()
  for (const { group, members } of named) {
    for (const id of members) {
      memberOf.set(id, (memberOf.get(id) ?? new Set<string>()).add(group.id))
    }
  }
  const ungrouped = [...live.keys()].filter((id) => !memberOf.has(id)).sort(compareStrings)

  // Rule 3: absorb strongly linked stray components into their one group.
  const absorbed = absorb(ungrouped, strong, memberOf)
  const drafts: Draft[] = named.map(({ group, members }) => {
    const add = absorbed.get(group.id)
    return {
      boardIds: members,
      signals: new Set<ContextSignal>(['group', ...(add?.signals ?? [])]),
      confidence: 'high',
      name: sanitizeGroupName(group.name) || nameFromMembers(members, live, pathCase, rootKey),
      existingGroupId: group.id,
      ...(add ? { addBoardIds: add.ids } : {})
    }
  })

  // Rule 4: cluster what is left; rule 5: drop singletons.
  const taken = new Set<string>([...absorbed.values()].flatMap((a) => a.ids))
  const remaining = ungrouped.filter((id) => !taken.has(id))
  const inRemaining = new Set(remaining)
  const edges = [
    ...strong.filter((e) => inRemaining.has(e.a) && inRemaining.has(e.b)),
    ...weakEdges(remaining, live, { pathCase, rootKey, titleSignal: opts.titleSignal === true })
  ]
  const uf = makeUnionFind(remaining)
  for (const e of edges) uf.union(e.a, e.b)
  const clusters = new Map<string, { ids: string[]; signals: Set<ContextSignal> }>()
  for (const id of remaining) {
    const root = uf.find(id)
    const cluster = clusters.get(root) ?? { ids: [], signals: new Set<ContextSignal>() }
    cluster.ids.push(id)
    clusters.set(root, cluster)
  }
  for (const e of edges) clusters.get(uf.find(e.a))!.signals.add(e.signal)
  for (const { ids, signals } of clusters.values()) {
    if (ids.length < 2) continue
    drafts.push({
      boardIds: ids,
      signals,
      confidence: confidenceOf(signals),
      name: nameFromMembers(ids, live, pathCase, rootKey)
    })
  }

  return finalize(drafts)
}
