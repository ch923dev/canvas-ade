/**
 * SCA / supply-chain gate — the `pnpm audit --audit-level=high` replacement (2026-07-16).
 *
 * npmjs RETIRED the classic audit endpoints (`/-/npm/v1/security/audits[/quick]` → HTTP 410)
 * that `pnpm audit` speaks — on EVERY pnpm version, 9 and 10 alike — with the instruction to
 * use the bulk advisory endpoint instead. This script keeps the T9 HARD gate semantics on the
 * replacement API: enumerate every installed package@version, POST them to the bulk advisory
 * endpoint in chunks, semver-match each advisory's vulnerable range against the installed
 * versions, and FAIL (exit 1) on any finding at/above the threshold (default `high`).
 *
 * Failure semantics match the old step: a network / registry error is a HARD fail (a supply-
 * chain gate must not fail open). Findings below the threshold are printed but non-blocking
 * (the known PostCSS moderate stays visible, exactly like `--audit-level=high` behaved).
 *
 * A finding with no fixed version to move to can be WAIVED — see `WAIVERS` below for the (narrow)
 * contract. Waivers are per-advisory + per-package + per-range, are printed on every run, and a
 * waiver that stops matching anything FAILS the run so it cannot quietly outlive its reason.
 *
 * Zero new dependencies: package enumeration rides `pnpm licenses list --json` (walks the
 * whole installed tree, dev included, grouping Unknown-license packages too), and semver range
 * matching uses the `semver` package already guaranteed in the hoisted tree (electron-builder /
 * eslint chains) — loud, actionable error if either assumption ever breaks.
 *
 * Usage: node scripts/sca-audit.mjs [--audit-level=low|moderate|high|critical]
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let semver
try {
  semver = require('semver')
} catch {
  console.error(
    'sca-audit: the hoisted `semver` package is missing — run `pnpm install`, or add semver ' +
      'as an explicit devDependency if the hoisted layout ever stops providing it.'
  )
  process.exit(1)
}

const BULK_ENDPOINT = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'
const LEVELS = ['info', 'low', 'moderate', 'high', 'critical']
const CHUNK_SIZE = 100

/**
 * WAIVERS — narrow, documented exceptions for findings that have NO fixed version to move to.
 *
 * This is deliberately NOT a "shut the gate up" switch. A waiver is keyed to ONE advisory on ONE
 * package over ONE version range, so a different advisory on the same package — or the same
 * advisory on a version outside the range — still BLOCKS. Lowering `--audit-level` was rejected as
 * the alternative: it would have disarmed the gate for every future high, not just this one.
 *
 * A waiver is only ever justified when there is genuinely nothing to upgrade TO. If a fixed version
 * exists, bump it (the `pnpm.overrides` block in package.json) instead — that is what every other
 * finding in this repo's history did.
 *
 * Unused waivers are reported and FAIL the run, so a waiver cannot silently outlive its reason.
 */
// Currently EMPTY. History: the brace-expansion GHSA-mh99-v99m-4gvg waiver (1.x/2.x, added
// 2026-07-25) was dropped 2026-10-16 once upstream backported fixes (1.1.21 / 2.1.7) — those lines
// are now floored in pnpm.overrides like every other finding. Entry shape, for the next one:
//   { ghsa, name, versions: '<semver range>', added: 'YYYY-MM-DD', reason: '<why there is no fixed
//     version + why it is unreachable>', revisit: '<the condition that retires the waiver>' }
const WAIVERS = []

/** Does a waiver cover this finding? Matches the advisory by GHSA id, not by package alone. */
function waiverFor(finding) {
  return WAIVERS.find(
    (w) =>
      finding.name === w.name &&
      (finding.adv.url?.includes(w.ghsa) || finding.adv.github_advisory_id === w.ghsa) &&
      semver.satisfies(finding.version, w.versions, { includePrerelease: true, loose: true })
  )
}

const levelArg = process.argv.find((a) => a.startsWith('--audit-level='))?.split('=')[1] ?? 'high'
if (!LEVELS.includes(levelArg)) {
  console.error(`sca-audit: unknown --audit-level '${levelArg}' (use ${LEVELS.join('|')})`)
  process.exit(1)
}
const threshold = LEVELS.indexOf(levelArg)

/** Installed name → Set<version> via `pnpm licenses list --json` (all license groups). */
function collectInstalled() {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32' // pnpm is a .cmd shim on Windows
  })
  const groups = JSON.parse(raw)
  const installed = new Map()
  for (const entries of Object.values(groups)) {
    for (const e of entries) {
      if (!e?.name || !Array.isArray(e.versions)) continue
      const set = installed.get(e.name) ?? new Set()
      for (const v of e.versions) set.add(v)
      installed.set(e.name, set)
    }
  }
  return installed
}

async function queryBulk(chunk) {
  const body = Object.fromEntries(chunk.map(([name, versions]) => [name, [...versions]]))
  const res = await fetch(BULK_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`bulk advisory endpoint responded ${res.status}`)
  return res.json()
}

const installed = collectInstalled()
const entries = [...installed.entries()]
console.log(`sca-audit: ${entries.length} packages, threshold=${levelArg}`)

const findings = []
for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
  const advisories = await queryBulk(entries.slice(i, i + CHUNK_SIZE))
  for (const [name, list] of Object.entries(advisories)) {
    for (const adv of list) {
      const range = adv.vulnerable_versions || '*'
      for (const version of installed.get(name) ?? []) {
        // Loose+includePrerelease: advisory ranges must also catch installed prerelease
        // builds (e.g. the pinned node-pty beta) instead of silently skipping them.
        if (semver.satisfies(version, range, { includePrerelease: true, loose: true })) {
          findings.push({ name, version, severity: adv.severity ?? 'info', adv })
        }
      }
    }
  }
}

const usedWaivers = new Set()
for (const f of findings) {
  const w = waiverFor(f)
  if (w) {
    f.waiver = w
    usedWaivers.add(w)
  }
}

const blocking = findings.filter((f) => !f.waiver && LEVELS.indexOf(f.severity) >= threshold)
const waived = findings.filter((f) => f.waiver)
const advisory = findings.length - blocking.length - waived.length
for (const f of findings) {
  const mark = f.waiver ? 'WAIVE' : LEVELS.indexOf(f.severity) >= threshold ? 'BLOCK' : 'note '
  console.log(
    `  [${mark}] ${f.severity.padEnd(8)} ${f.name}@${f.version} — ${f.adv.title ?? f.adv.id} ${f.adv.url ?? ''}`
  )
}
for (const f of waived) {
  console.log(`sca-audit: WAIVED ${f.name}@${f.version} (${f.waiver.ghsa}) — ${f.waiver.reason}`)
  console.log(`sca-audit:   revisit: ${f.waiver.revisit}`)
}
if (advisory) console.log(`sca-audit: ${advisory} finding(s) below '${levelArg}' (non-blocking)`)

// A waiver that no longer matches anything has outlived its reason — the tree moved on and the
// exception is now dead weight that would silently mask a re-introduction. Fail so it gets deleted.
const staleWaivers = WAIVERS.filter((w) => !usedWaivers.has(w))
if (staleWaivers.length) {
  console.error(
    `sca-audit: FAIL — ${staleWaivers.length} waiver(s) no longer match any finding; delete them from WAIVERS:`
  )
  for (const w of staleWaivers)
    console.error(`  ${w.name} ${w.versions} (${w.ghsa}) added ${w.added}`)
  process.exit(1)
}

if (blocking.length) {
  console.error(`sca-audit: FAIL — ${blocking.length} finding(s) at/above '${levelArg}'`)
  process.exit(1)
}
console.log(
  waived.length
    ? `sca-audit: clean at threshold (${waived.length} waived — see above)`
    : 'sca-audit: clean at threshold'
)
