// scripts/release-floor.mjs
/**
 * "A canvas-format change forces older apps to update" (project-workspaces O-2, §4.9) — the pure
 * decision logic shared by BOTH release paths, kept here so it is unit-testable
 * (scripts/release-floor.test.ts) without building an installer.
 *
 * The canvas compat floor is `MIN_READER_VERSION` (src/renderer/src/lib/boardSchemaVersion.ts,
 * ADR 0007): an app whose schema is below a doc's floor refuses to open it ("saved by a newer
 * version of the app"). When a release RAISES that floor, every older install must be forced to
 * update — the update feed's `minSupported` (ADR 0012) is set to that release's version, so an
 * app strictly below it gets the blocking `mandatory` tier. Ordinary releases change nothing.
 *
 *   • PRODUCTION (scripts/gen-updates-json.mjs, run by scripts/release.mjs): the committed
 *     build/updates.json is the record. Its `minSupportedByFloor` maps each floor to the
 *     `minSupported` that floor demands. `planProductionManifest` REFUSES (returns errors) when
 *     the source floor has no entry — so the PR that bumps MIN_READER_VERSION cannot pass
 *     `pnpm test` (the guard in release-floor.test.ts) or cut a release without also raising
 *     `minSupported` in the same change.
 *   • LOCAL (scripts/release-local.mjs): there is no committed record — the previous
 *     `<feed>/updates.json` is the record. `planLocalManifest` compares its `minReaderVersion`
 *     with this build's floor; a rise forces (`minSupported` = this stamp), anything else keeps
 *     the personal-build rule of never adding a force.
 *
 * Both published manifests gain `minReaderVersion` (this release's floor). Older apps ignore the
 * unknown key (src/main/autoUpdate.ts `coerceUpdateMeta` keeps only `minSupported` + `tiers`).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Version strings the feed accepts (same pattern gen-updates-json has always validated). */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Where the canvas compat floor lives — the ONE source of the number (never hard-code it). */
export const FLOOR_SOURCE = 'src/renderer/src/lib/boardSchemaVersion.ts'

const FLOOR_DECL = /^export const MIN_READER_VERSION\s*(?::\s*number\s*)?=\s*(\d+)\s*;?\s*$/gm

/**
 * Read `MIN_READER_VERSION` out of boardSchemaVersion.ts source text. Throws unless there is
 * exactly ONE `export const MIN_READER_VERSION = <integer>` line: a refactor that hides the
 * literal (an expression, a re-export) must fail loudly here and in the unit test, never
 * silently skip the force.
 */
export function parseMinReaderVersion(sourceText) {
  const hits = [...String(sourceText).matchAll(FLOOR_DECL)]
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one "export const MIN_READER_VERSION = <integer>" line in ${FLOOR_SOURCE}, ` +
        `found ${hits.length}`
    )
  }
  const floor = Number(hits[0][1])
  if (!Number.isSafeInteger(floor) || floor < 1) {
    throw new Error(
      `MIN_READER_VERSION in ${FLOOR_SOURCE} is not a positive integer: ${hits[0][1]}`
    )
  }
  return floor
}

/** `parseMinReaderVersion` on the checkout at `root`. */
export function readMinReaderVersion(root) {
  return parseMinReaderVersion(readFileSync(join(root, FLOOR_SOURCE), 'utf8'))
}

/**
 * Compare two versions EXACTLY as the app does when it applies `minSupported`
 * (src/main/autoUpdate.ts `cmpVersion`): numeric X.Y.Z, any pre-release suffix IGNORED.
 * Mirrored (not imported) because these scripts run under plain node with no TS step.
 */
export function cmpVersion(a, b) {
  const parse = (v) =>
    String(v)
      .split('-')[0]
      .split('.')
      .map((n) => Number(n) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** The X.Y.Z part of a version (`0.48.1-local.2` → `0.48.1`). */
export const baseOf = (v) => String(v).split('-')[0]

const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0

/**
 * The canvas floor when the force-on-format-change rule landed (WS-12). A feed updates.json with
 * no `minReaderVersion` key was written by an older release script, whose build's floor was at
 * most this. A historical constant, NOT the current floor — that is always read from source.
 */
export const PRE_RULE_FLOOR = 23

// ─────────────────────────────────────────────────────────────────────────────
// Production — build/updates.json is the committed record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate build/updates.json against this checkout's canvas floor and build the published
 * manifest. Returns `{ manifest, errors }`; a non-empty `errors` means DO NOT publish (and is
 * what the guard test asserts is empty for the real repo files).
 *
 * The floor rule: `source.minSupportedByFloor` must carry an entry for `floor` (the PR that
 * raises the floor adds `"<floor>": "<that PR's package.json version>"`), entries must rise
 * strictly with the floor (a copy-pasted older version fails), and `minSupported` must be at
 * least the current floor's entry — so the floor raise and the force ship in the SAME change.
 *
 * @param {{ source: any, appVersion: string, floor: number }} input
 * @returns {{ manifest: { latest: string, minSupported?: string, minReaderVersion: number, tiers: Record<string,string> } | null, errors: string[] }}
 */
export function planProductionManifest({ source, appVersion, floor }) {
  const errors = []
  const src = source && typeof source === 'object' ? source : {}

  if (!SEMVER.test(String(appVersion)))
    errors.push(`package.json version is not semver: ${appVersion}`)
  if (!isPositiveInt(floor)) errors.push(`canvas floor is not a positive integer: ${floor}`)
  const minSupported = src.minSupported
  if (minSupported != null && !SEMVER.test(String(minSupported)))
    errors.push(`minSupported is not semver: ${minSupported}`)
  const tiers = src.tiers ?? {}
  for (const [v, tier] of Object.entries(tiers)) {
    if (!SEMVER.test(v)) errors.push(`tiers key is not semver: ${v}`)
    if (tier !== 'recommended' && tier !== 'optional')
      errors.push(`tier for ${v} must be "recommended" or "optional", got "${tier}"`)
  }

  // The floor record.
  const byFloor = src.minSupportedByFloor
  const entries = []
  if (!byFloor || typeof byFloor !== 'object' || Array.isArray(byFloor)) {
    errors.push(
      'build/updates.json has no "minSupportedByFloor" object (canvas floor → minSupported)'
    )
  } else {
    for (const [k, v] of Object.entries(byFloor)) {
      if (!/^\d+$/.test(k) || !isPositiveInt(Number(k)))
        errors.push(`minSupportedByFloor key is not a positive integer floor: "${k}"`)
      else if (!SEMVER.test(String(v)))
        errors.push(`minSupportedByFloor["${k}"] is not semver: ${v}`)
      else entries.push([Number(k), String(v)])
    }
  }
  entries.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < entries.length; i++) {
    const [pf, pv] = entries[i - 1]
    const [f, v] = entries[i]
    if (cmpVersion(v, pv) <= 0)
      errors.push(
        `minSupportedByFloor["${f}"] = ${v} must be ABOVE minSupportedByFloor["${pf}"] = ${pv} — ` +
          `use the version of the release that raised the floor to ${f}`
      )
  }

  if (entries.length > 0 && isPositiveInt(floor)) {
    const recorded = entries[entries.length - 1][0]
    if (floor > recorded) {
      errors.push(
        `the canvas floor rose: MIN_READER_VERSION is ${floor} but build/updates.json records ` +
          `${recorded}. A floor raise must force older apps to update (project-workspaces O-2). ` +
          `In build/updates.json add "${floor}": "${appVersion}" to "minSupportedByFloor" AND set ` +
          `"minSupported": "${appVersion}" (this change's package.json version). ` +
          `See docs/contributing/releasing.md › Update levels.`
      )
    } else if (floor < recorded) {
      errors.push(
        `MIN_READER_VERSION is ${floor} but build/updates.json records floor ${recorded}. Floors ` +
          `never go down (ADR 0007); if the raise to ${recorded} was reverted before it was ` +
          `released, remove the "${recorded}" entry from "minSupportedByFloor".`
      )
    } else {
      const required = entries[entries.length - 1][1]
      if (minSupported == null || cmpVersion(String(minSupported), required) < 0)
        errors.push(
          `minSupported is ${minSupported ?? '(none)'} but canvas floor ${floor} requires at least ` +
            `${required} (minSupportedByFloor["${floor}"]) — raise "minSupported" to ${required}`
        )
      if (SEMVER.test(String(appVersion)) && cmpVersion(required, appVersion) > 0)
        errors.push(
          `minSupportedByFloor["${floor}"] = ${required} is ahead of this release (${appVersion})`
        )
    }
  }
  // A floor above the release itself would force-block the very build it ships (an endless
  // update loop) — a typo guard, never true of a correct record.
  if (
    minSupported != null &&
    SEMVER.test(String(minSupported)) &&
    SEMVER.test(String(appVersion)) &&
    cmpVersion(String(minSupported), appVersion) > 0
  )
    errors.push(
      `minSupported ${minSupported} is above this release (${appVersion}) — every install, ` +
        `including this one, would be forced to update forever`
    )

  if (errors.length > 0) return { manifest: null, errors }
  return {
    manifest: {
      latest: appVersion,
      ...(minSupported != null ? { minSupported: String(minSupported) } : {}),
      minReaderVersion: floor,
      tiers
    },
    errors
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Local — the previous <feed>/updates.json is the record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the local feed's CURRENT updates.json (call BEFORE overwriting it).
 * @returns {{ status: 'missing' } | { status: 'unreadable', reason: string } | { status: 'ok', data: any }}
 */
export function readPreviousFeedManifest(feedDir) {
  const path = join(feedDir, 'updates.json')
  if (!existsSync(path)) return { status: 'missing' }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return { status: 'unreadable', reason: `cannot read ${path}: ${err?.message ?? err}` }
  }
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { status: 'unreadable', reason: `${path} is not a JSON object` }
    return { status: 'ok', data }
  } catch (err) {
    return { status: 'unreadable', reason: `${path} is not valid JSON: ${err?.message ?? err}` }
  }
}

/**
 * Decide the local feed's updates.json for the build stamped `stamped` whose canvas floor is
 * `floor`, given the previous feed manifest (`readPreviousFeedManifest`).
 *
 *   • floor ROSE (previous `minReaderVersion` < floor) → `minSupported` = `stamped`: every install
 *     below this build gets the blocking update modal.
 *   • otherwise no NEW force. A `minSupported` an earlier floor raise left on the feed is carried
 *     forward (it only ever reaches installs that cannot read the current format; dropping it would
 *     let an install that skipped the floor-raise build escape the force). A feed that never had a
 *     floor raise stays floor-less — the ordinary personal build still never forces.
 *   • previous file written BEFORE this rule (no `minReaderVersion` key) → its floor is taken as
 *     `PRE_RULE_FLOOR`: every build that wrote such a file predates the rule, so its floor was at
 *     most that. This keeps the force working even if no local release ran between this rule
 *     landing and the first floor raise.
 *   • previous file missing / unreadable / with a malformed `minReaderVersion` → treated as
 *     "floor unchanged" (no force) plus a warning: the rise can't be proven.
 *
 * @param {{ previous: ReturnType<typeof readPreviousFeedManifest>, stamped: string, floor: number }} input
 * @returns {{ manifest: { latest: string, minSupported?: string, minReaderVersion: number, tiers: {} }, forced: boolean, carried: boolean, previousFloor: number | null, warnings: string[] }}
 */
export function planLocalManifest({ previous, stamped, floor }) {
  const warnings = []
  let prev = null
  if (previous?.status === 'ok') prev = previous.data
  else if (previous?.status === 'unreadable')
    warnings.push(
      `previous feed updates.json is unreadable (${previous.reason}) — treating the canvas floor ` +
        `as unchanged, so this build forces NO update`
    )
  else
    warnings.push(
      `no previous feed updates.json — treating the canvas floor as unchanged, so this build ` +
        `forces NO update (this run records floor ${floor} for the next one)`
    )

  let previousFloor = null
  if (prev && isPositiveInt(prev.minReaderVersion)) previousFloor = prev.minReaderVersion
  else if (prev && !('minReaderVersion' in prev)) previousFloor = PRE_RULE_FLOOR
  else if (prev)
    warnings.push(
      `previous feed updates.json has a malformed canvas floor (minReaderVersion: ` +
        `${JSON.stringify(prev.minReaderVersion)}) — treating the floor as unchanged, so this ` +
        `build forces NO update (this run records floor ${floor} for the next one)`
    )

  const manifest = { latest: stamped, minReaderVersion: floor, tiers: {} }
  const forced = previousFloor !== null && floor > previousFloor
  let carried = false

  if (forced) {
    manifest.minSupported = stamped
    const prevLatest = typeof prev.latest === 'string' ? prev.latest : null
    if (prevLatest && SEMVER.test(prevLatest) && baseOf(prevLatest) === baseOf(stamped))
      warnings.push(
        `an install on ${prevLatest} will NOT be forced: it shares this build's base ` +
          `${baseOf(stamped)}, and the app compares versions without the "-local.N" suffix ` +
          `(src/main/autoUpdate.ts cmpVersion). Bump package.json's version, then re-run, to force it`
      )
  } else if (prev && typeof prev.minSupported === 'string') {
    if (SEMVER.test(prev.minSupported) && cmpVersion(prev.minSupported, stamped) <= 0) {
      manifest.minSupported = prev.minSupported
      carried = true
    } else
      warnings.push(
        `dropping the previous feed's minSupported "${prev.minSupported}" (not a version at or ` +
          `below ${stamped})`
      )
  }
  // Key order mirrors the production manifest: latest, minSupported, minReaderVersion, tiers.
  const ordered = {
    latest: manifest.latest,
    ...(manifest.minSupported ? { minSupported: manifest.minSupported } : {}),
    minReaderVersion: manifest.minReaderVersion,
    tiers: manifest.tiers
  }
  return { manifest: ordered, forced, carried, previousFloor, warnings }
}
