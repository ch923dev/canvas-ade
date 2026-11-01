/**
 * The `tidy_canvas` contract (spatial-awareness SPEC C5 / C6), shared by BOTH sides of the trust
 * boundary so they validate with one rule set:
 *  - MAIN's `mcpTidy` parses an agent's (or Jarvis's) input BEFORE the D1 confirm, so the human is
 *    never asked to approve a call that cannot run;
 *  - the renderer applier re-parses the IPC-crossed `tidyBoards` command (defence in depth).
 * MAIN also runs the renderer's ack through {@link sanitizeTidyAck} before it reaches the agent.
 *
 * The vocabularies are 1:1 with `@expanse-ade/mcp` 0.27's TIDY_MODES / TILE_TEMPLATES /
 * TIDY_OVERFLOW (pinned by `mcpSpatialCapsParity.test.ts`; `TILE_TEMPLATES` ↔ the renderer's tile
 * presets by `layoutPresets.test.ts`).
 *
 * Pure: no Node / DOM / Electron imports (compiles under tsconfig.node and tsconfig.web alike).
 */

export const TIDY_MODES = ['fit', 'roles', 'smart', 'by-type', 'grid', 'tile'] as const
export type TidyCommandMode = (typeof TIDY_MODES)[number]

export const TILE_TEMPLATES = ['cols-2', 'cols-3', 'cols-4', 'main-sidebar', 'grid'] as const
export type TidyTileTemplate = (typeof TILE_TEMPLATES)[number]

export const TIDY_OVERFLOW = ['report', 'pages', 'shrink'] as const
export type TidyOverflowMode = (typeof TIDY_OVERFLOW)[number]

/** Longest board / group id the contract carries (= the package's `MAX_FOCUS_TARGET_ID`). */
export const TIDY_ID_MAX = 200
/** Most ids a `{ boardIds }` scope may name (= the MAIN mirror's board bound). */
export const TIDY_SCOPE_MAX_IDS = 500
/** Most `units[]` an ack reports (= `MAX_CONTEXTS`; a canvas has far fewer units in practice). */
export const TIDY_ACK_MAX_UNITS = 50
/** Longest `units[].why` sentence that reaches the agent. */
export const TIDY_ACK_WHY_MAX = 300

/**
 * What a tidy arranges: the whole canvas, what is on screen, one Named Group (C5), or an explicit
 * board list (the Jarvis facet's S12 scope — the package's wire never sends it).
 */
export type TidyScope = 'all' | 'visible' | { groupId: string } | { boardIds: string[] }

/** One arranged unit as the ack explains it (C6 `units`, roles only). */
export interface TidyAckUnit {
  scene: string
  heroIds: string[]
  why: string
}

/** The widened ack facts (C5 / C6). `moved` is always present; the rest when the mode reports them. */
export interface TidyAckFacts {
  moved: number
  fitZoom?: number
  readable?: boolean
  pages?: number
  units?: TidyAckUnit[]
}

/** Tidy arguments after {@link parseTidyArgs}: every field type-checked, every rule applied. */
export interface TidyArgs {
  mode: TidyCommandMode
  /** D8 (a): `true` when the caller omitted `mode` — an IMPLICIT `roles`. */
  implicit: boolean
  template?: TidyTileTemplate
  scope?: TidyScope
  overflow?: TidyOverflowMode
  fit?: boolean
  primary?: string
  resize?: boolean
}

/** The raw shape both callers hand in — every field `unknown`, because both cross a boundary. */
export interface TidyArgsInput {
  mode?: unknown
  template?: unknown
  scope?: unknown
  overflow?: unknown
  fit?: unknown
  primary?: unknown
  resize?: unknown
  implicit?: unknown
}

export type TidyArgsResult = { ok: true; args: TidyArgs } | { ok: false; error: string }

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v)

const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= TIDY_ID_MAX

const show = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === undefined ? String(v) : s.length > 40 ? `${s.slice(0, 40)}…` : s
}

function parseScope(raw: unknown): { scope: TidyScope } | { error: string } {
  if (raw === 'all' || raw === 'visible') return { scope: raw }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      error: `scope must be "all", "visible", { groupId } or { boardIds } (got ${show(raw)})`
    }
  }
  const keys = Object.keys(raw)
  const rec = raw as Record<string, unknown>
  if (keys.length === 1 && keys[0] === 'groupId') {
    return isId(rec.groupId)
      ? { scope: { groupId: rec.groupId } }
      : { error: 'scope.groupId must be a board-group id' }
  }
  if (keys.length === 1 && keys[0] === 'boardIds') {
    const ids = rec.boardIds
    if (!Array.isArray(ids) || ids.length > TIDY_SCOPE_MAX_IDS || !ids.every(isId)) {
      return { error: `scope.boardIds must be up to ${TIDY_SCOPE_MAX_IDS} board ids` }
    }
    return { scope: { boardIds: [...new Set(ids)] } }
  }
  return { error: 'scope takes exactly one of groupId / boardIds' }
}

/**
 * Validate one tidy request (C5 / C6). An omitted `mode` resolves to an IMPLICIT `roles` (D8 a); an
 * explicit `implicit:true` is accepted only with `roles` (the renderer re-reading MAIN's command).
 * `template` is required with `tile` and rejected otherwise; `primary` / `resize` are roles-only;
 * `overflow` `pages` / `shrink` apply to `fit` / `roles` only (the legacy packers and `tile` cannot
 * page or shrink, so accepting them would silently drop the request).
 */
export function parseTidyArgs(raw: TidyArgsInput): TidyArgsResult {
  const fail = (error: string): TidyArgsResult => ({ ok: false, error })
  if (raw.implicit !== undefined && typeof raw.implicit !== 'boolean') {
    return fail('implicit must be a boolean')
  }
  let mode: TidyCommandMode
  let implicit = raw.implicit === true
  if (raw.mode === undefined) {
    mode = 'roles'
    implicit = true
  } else if (oneOf(TIDY_MODES, raw.mode)) {
    mode = raw.mode
  } else {
    return fail(`unknown mode ${show(raw.mode)} (one of: ${TIDY_MODES.join(', ')})`)
  }
  if (implicit && mode !== 'roles') return fail('implicit applies to mode roles only')
  const args: TidyArgs = { mode, implicit }

  if (raw.template !== undefined) {
    if (mode !== 'tile') return fail(`template is only valid with mode 'tile'`)
    if (!oneOf(TILE_TEMPLATES, raw.template)) {
      return fail(`unknown template ${show(raw.template)} (one of: ${TILE_TEMPLATES.join(', ')})`)
    }
    args.template = raw.template
  } else if (mode === 'tile') {
    return fail(`template is required when mode is 'tile' (one of: ${TILE_TEMPLATES.join(', ')})`)
  }

  if (raw.scope !== undefined) {
    const parsed = parseScope(raw.scope)
    if ('error' in parsed) return fail(parsed.error)
    args.scope = parsed.scope
  }

  if (raw.overflow !== undefined) {
    if (!oneOf(TIDY_OVERFLOW, raw.overflow)) {
      return fail(`unknown overflow ${show(raw.overflow)} (one of: ${TIDY_OVERFLOW.join(', ')})`)
    }
    if (raw.overflow !== 'report' && mode !== 'fit' && mode !== 'roles') {
      return fail(`overflow '${raw.overflow}' applies to mode fit / roles only`)
    }
    args.overflow = raw.overflow
  }

  if (raw.fit !== undefined) {
    if (typeof raw.fit !== 'boolean') return fail('fit must be a boolean')
    args.fit = raw.fit
  }

  for (const field of ['primary', 'resize'] as const) {
    if (raw[field] !== undefined && mode !== 'roles') {
      return fail(`${field} is roles-only: use it with mode 'roles' or omit mode`)
    }
  }
  if (raw.primary !== undefined) {
    if (!isId(raw.primary)) return fail('primary must be a board id')
    args.primary = raw.primary
  }
  if (raw.resize !== undefined) {
    if (typeof raw.resize !== 'boolean') return fail('resize must be a boolean')
    args.resize = raw.resize
  }
  return { ok: true, args }
}

/** True when the tidy may change board SIZES (the confirm copy must say so — W5). */
export function tidyResizes(args: TidyArgs): boolean {
  return (
    args.mode === 'tile' ||
    args.overflow === 'shrink' ||
    (args.mode === 'roles' && args.resize !== false)
  )
}

const nonNegInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined

function clampStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const cps = [...v]
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : v
}

/**
 * Re-shape the renderer's ack into the facts the agent receives (C6): finite numbers only, bounded
 * `units[]` with bounded strings. Anything malformed is dropped, never passed through.
 */
export function sanitizeTidyAck(ack: Record<string, unknown>): TidyAckFacts {
  const out: TidyAckFacts = { moved: nonNegInt(ack.moved) ?? 0 }
  if (typeof ack.fitZoom === 'number' && Number.isFinite(ack.fitZoom) && ack.fitZoom > 0) {
    out.fitZoom = Math.round(ack.fitZoom * 1000) / 1000
  }
  if (typeof ack.readable === 'boolean') out.readable = ack.readable
  const pages = nonNegInt(ack.pages)
  if (pages !== undefined && pages > 1) out.pages = pages
  if (Array.isArray(ack.units)) {
    const units: TidyAckUnit[] = []
    for (const u of ack.units.slice(0, TIDY_ACK_MAX_UNITS)) {
      if (u === null || typeof u !== 'object') continue
      const rec = u as Record<string, unknown>
      if (typeof rec.scene !== 'string' || typeof rec.why !== 'string') continue
      const heroIds = Array.isArray(rec.heroIds) ? rec.heroIds.filter(isId).slice(0, 8) : []
      units.push({
        scene: clampStr(rec.scene, 20),
        heroIds,
        why: clampStr(rec.why, TIDY_ACK_WHY_MAX)
      })
    }
    if (units.length > 0) out.units = units
  }
  return out
}
