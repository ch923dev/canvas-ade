// scripts/gen-updates-json.mjs
/**
 * Generate the update-feed tier manifest (`updates.json`) from the source at build/updates.json.
 *
 * The manifest is the side-channel that gives auto-update its THREE tiers (optional /
 * recommended / mandatory). electron-updater only knows "is there a newer version"; this file
 * — a sibling of latest.yml on the feed — carries:
 *   • minSupported     : a running version strictly below this is FORCED to update (the blocking
 *                        modal). The app-binary analogue of the schema `minReaderVersion` floor
 *                        (ADR 0007). This is the ONLY force trigger.
 *   • minReaderVersion : this release's canvas compat floor (informational; older apps ignore it).
 *   • tiers            : version → "recommended" (a louder banner). Anything absent is "optional".
 *
 * FORCE ON FORMAT CHANGE (project-workspaces O-2): when MIN_READER_VERSION
 * (src/renderer/src/lib/boardSchemaVersion.ts) rises, build/updates.json must record it in
 * `minSupportedByFloor` and raise `minSupported` in the SAME change. This script REFUSES to
 * write a manifest otherwise (the rules live in scripts/release-floor.mjs, which the unit test
 * scripts/release-floor.test.ts also runs against the real files — so the floor-raising PR
 * fails `pnpm test` long before a release).
 *
 * This script stamps `latest` from package.json (informational — main reads the version from
 * electron-updater's latest.yml, not here), validates every version string + the floor record,
 * and writes the result to <out>/updates.json ready for upload by scripts/release.mjs.
 *
 * Usage:  node scripts/gen-updates-json.mjs [--out <dir>]   (default --out release/feed)
 *         node scripts/gen-updates-json.mjs --check         (validate only, write nothing)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planProductionManifest, readMinReaderVersion } from './release-floor.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const outIdx = args.indexOf('--out')
const outDir = outIdx >= 0 ? args[outIdx + 1] : 'release/feed'

const die = (msg) => {
  process.stderr.write(`[gen-updates-json] ERROR: ${msg}\n`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const src = JSON.parse(readFileSync(join(root, 'build/updates.json'), 'utf8'))
let floor
try {
  floor = readMinReaderVersion(root)
} catch (err) {
  die(err.message)
}

const { manifest, errors } = planProductionManifest({
  source: src,
  appVersion: pkg.version,
  floor
})
if (errors.length > 0) die(errors.join('\n  '))

const summary =
  `  latest=${manifest.latest}  minSupported=${manifest.minSupported ?? '(none)'}  ` +
  `minReaderVersion=${manifest.minReaderVersion}  tiers=${Object.keys(manifest.tiers).length}\n`

if (checkOnly) {
  process.stdout.write(`[gen-updates-json] OK (check only, nothing written)\n` + summary)
} else {
  const outPath = join(root, outDir, 'updates.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  process.stdout.write(`[gen-updates-json] wrote ${outPath}\n` + summary)
}
