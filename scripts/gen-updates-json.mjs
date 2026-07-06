// scripts/gen-updates-json.mjs
/**
 * Generate the update-feed tier manifest (`updates.json`) from the source at build/updates.json.
 *
 * The manifest is the side-channel that gives auto-update its THREE tiers (optional /
 * recommended / mandatory). electron-updater only knows "is there a newer version"; this file
 * — a sibling of latest.yml on the feed — carries:
 *   • minSupported : a running version strictly below this is FORCED to update (the blocking
 *                    modal). The app-binary analogue of the schema `minReaderVersion` floor
 *                    (ADR 0007). This is the ONLY force trigger.
 *   • tiers        : version → "recommended" (a louder banner). Anything absent is "optional".
 *
 * This script stamps `latest` from package.json (informational — main reads the version from
 * electron-updater's latest.yml, not here), validates every version string, and writes the
 * result to <out>/updates.json ready for upload by scripts/release.mjs.
 *
 * Usage:  node scripts/gen-updates-json.mjs [--out <dir>]   (default --out release/feed)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const outDir = outIdx >= 0 ? args[outIdx + 1] : 'release/feed'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const die = (msg) => {
  process.stderr.write(`[gen-updates-json] ERROR: ${msg}\n`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const src = JSON.parse(readFileSync(join(root, 'build/updates.json'), 'utf8'))

if (!SEMVER.test(pkg.version)) die(`package.json version is not semver: ${pkg.version}`)
if (src.minSupported != null && !SEMVER.test(src.minSupported))
  die(`minSupported is not semver: ${src.minSupported}`)
for (const [v, tier] of Object.entries(src.tiers ?? {})) {
  if (!SEMVER.test(v)) die(`tiers key is not semver: ${v}`)
  if (tier !== 'recommended' && tier !== 'optional')
    die(`tier for ${v} must be "recommended" or "optional", got "${tier}"`)
}

// The published manifest: drop the source's `_comment`, stamp `latest`.
const manifest = {
  latest: pkg.version,
  ...(src.minSupported != null ? { minSupported: src.minSupported } : {}),
  tiers: src.tiers ?? {}
}

const outPath = join(root, outDir, 'updates.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
process.stdout.write(
  `[gen-updates-json] wrote ${outPath}\n` +
    `  latest=${manifest.latest}  minSupported=${manifest.minSupported ?? '(none)'}  ` +
    `tiers=${Object.keys(manifest.tiers).length}\n`
)
