// scripts/release.mjs
/**
 * Cut an update-feed release for one platform and stage it for upload to the R2 bucket.
 *
 * Steps:
 *   1. Build with the auto-update gate ON (ENABLE_AUTO_UPDATE=1 → __ENABLE_AUTO_UPDATE__ true).
 *   2. electron-builder --<platform> --publish never  (the generic provider is read-only; the
 *      upload is this script's job, step 5).
 *   3. Assemble a CLEAN feed dir (release/feed/) with only the files the feed serves:
 *      latest*.yml + installer(s) + *.blockmap — NOT win-unpacked or other build junk.
 *   4. Generate updates.json (the tier manifest) into release/feed/.
 *   5. Upload release/feed/ → R2. If R2_REMOTE is set (an rclone remote, e.g. "r2:expanse-updates")
 *      the copy runs; otherwise the exact command is PRINTED so nothing uploads by accident.
 *
 * Usage:  node scripts/release.mjs [--win|--mac|--linux]   (default --win)
 *         R2_REMOTE=r2:expanse-updates node scripts/release.mjs --win   # actually upload
 *
 * NOTE: signing is orthogonal — the production CI path signs; this script is the feed mechanics.
 * Run it only for a build you intend to publish. See docs/contributing/releasing.md › Update levels.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const platform = args.includes('--mac') ? 'mac' : args.includes('--linux') ? 'linux' : 'win'
const builderFlag = { win: '--win', mac: '--mac', linux: '--linux' }[platform]

const run = (cmd, extraEnv = {}) => {
  process.stdout.write(`\n$ ${cmd}\n`)
  const r = spawnSync(cmd, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv }
  })
  if (r.status !== 0) {
    process.stderr.write(`[release] step failed (exit ${r.status}): ${cmd}\n`)
    process.exit(r.status ?? 1)
  }
}

// 1 + 2 — build with the gate on, package without auto-publishing.
run('pnpm exec electron-vite build', { ENABLE_AUTO_UPDATE: '1' })
run(`pnpm exec electron-builder ${builderFlag} --publish never`, { ENABLE_AUTO_UPDATE: '1' })

// 3 — assemble a clean feed dir with ONLY the served files.
const releaseDir = join(root, 'release')
const feedDir = join(releaseDir, 'feed')
if (existsSync(feedDir)) rmSync(feedDir, { recursive: true, force: true })
mkdirSync(feedDir, { recursive: true })

const isFeedFile = (f) =>
  /^latest.*\.yml$/.test(f) || f.endsWith('.blockmap') || /\.(exe|dmg|zip|AppImage)$/.test(f)
const staged = readdirSync(releaseDir).filter(isFeedFile)
if (staged.length === 0) {
  process.stderr.write(
    `[release] no feed artifacts found in ${releaseDir} — did the build produce an installer?\n`
  )
  process.exit(1)
}
for (const f of staged) copyFileSync(join(releaseDir, f), join(feedDir, f))
process.stdout.write(
  `\n[release] staged ${staged.length} feed file(s):\n  ${staged.join('\n  ')}\n`
)

// 4 — generate the tier manifest into the feed dir.
run('node scripts/gen-updates-json.mjs --out release/feed')

// 5 — upload (or print the command).
const remote = process.env.R2_REMOTE
if (remote) {
  run(`rclone copy "${feedDir}" "${remote}" --progress`)
  process.stdout.write(`\n[release] uploaded to ${remote}\n`)
} else {
  process.stdout.write(
    `\n[release] R2_REMOTE unset — NOTHING uploaded. To publish, run:\n` +
      `  rclone copy "${feedDir}" r2:expanse-updates --progress\n` +
      `  (or: wrangler r2 object put … / gcloud storage cp …)\n` +
      `Set up the rclone R2 remote once per machine — see docs/contributing/releasing.md.\n`
  )
}
