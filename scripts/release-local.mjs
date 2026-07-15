// scripts/release-local.mjs
/**
 * Publish a PERSONAL build to the LOCAL update feed — the maintainer-only "local update
 * channel" (docs/contributing/releasing.md › Local update channel; posture in
 * src/main/localUpdateFeed.ts). The installed app (bootstrapped once with a release-local
 * build + the userData override file) then offers the update in-app: toast → Download →
 * Restart. No manual close-and-reinstall.
 *
 * Steps:
 *   1. Preflight — print branch/HEAD, warn on a dirty tree (personal WIP builds are fine).
 *   2. Stamp a version ABOVE the repo version but BELOW the next real release:
 *      package.json X.Y.Z → X.Y.(Z+1)-local.N (N increments per publish of the same base;
 *      read back from the feed's current latest.yml). package.json is NEVER edited — the
 *      stamp rides electron-builder's --config.extraMetadata.version.
 *   3. Build with BOTH gates on: ENABLE_AUTO_UPDATE=1 (the updater code path) and
 *      LOCAL_UPDATE_CHANNEL=1 (the loopback feed override — personal builds only).
 *   4. Package --win --publish never, output on C:\ — electron-builder pack on the M: ReFS
 *      volume trips Defender EPERM/EBUSY (known machine gotcha).
 *   5. Stage the feed dir: installer + .blockmap first, updates.json, latest.yml LAST — an
 *      app checking mid-publish must never see a manifest that points at a missing file.
 *   6. Ensure the loopback feed server is up (spawn scripts/serve-local-feed.mjs detached
 *      if the port is dead), then verify the served latest.yml carries the new stamp.
 *
 * DELIBERATELY NO UPLOAD PATH — this script cannot reach the production feed. Real releases
 * go through scripts/release.mjs / production.yml only.
 *
 * Usage:  node scripts/release-local.mjs
 * Env:    EXPANSE_LOCAL_FEED_DIR (default C:\expanse\local-feed)
 *         EXPANSE_LOCAL_FEED_PORT (default 8090)
 *         EXPANSE_LOCAL_BUILD_DIR (default C:\expanse\local-build)
 */
import { spawnSync, spawn } from 'node:child_process'
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  existsSync
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FEED_DIR = process.env.EXPANSE_LOCAL_FEED_DIR ?? 'C:\\expanse\\local-feed'
const PORT = Number(process.env.EXPANSE_LOCAL_FEED_PORT ?? 8090)
const OUT_DIR = process.env.EXPANSE_LOCAL_BUILD_DIR ?? 'C:\\expanse\\local-build'
const FEED_URL = `http://127.0.0.1:${PORT}`

const die = (msg) => {
  process.stderr.write(`[release-local] ERROR: ${msg}\n`)
  process.exit(1)
}

const run = (cmd, extraEnv = {}) => {
  process.stdout.write(`\n$ ${cmd}\n`)
  const r = spawnSync(cmd, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv }
  })
  if (r.status !== 0) die(`step failed (exit ${r.status}): ${cmd}`)
}

const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim() ?? ''

// 1 — preflight: show exactly what is being built (shared-dir sessions switch branches).
const branch = git(['branch', '--show-current'])
const head = git(['rev-parse', '--short', 'HEAD'])
const dirty = git(['status', '--porcelain'])
process.stdout.write(`[release-local] building ${branch}@${head}\n`)
if (dirty)
  process.stdout.write(`[release-local] WARNING: dirty tree (uncommitted changes ride along)\n`)

// 2 — stamp: X.Y.Z (package.json) → X.Y.(Z+1)-local.N, N read back from the current feed.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version)
if (!m) die(`package.json version is not plain X.Y.Z: ${pkg.version}`)
const nextBase = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`

let n = 1
const feedYml = join(FEED_DIR, 'latest.yml')
if (existsSync(feedYml)) {
  const prev = /^version:\s*(.+)$/m.exec(readFileSync(feedYml, 'utf8'))?.[1]?.trim()
  const prevM = prev && /^(\d+\.\d+\.\d+)-local\.(\d+)$/.exec(prev)
  if (prevM && prevM[1] === nextBase) n = Number(prevM[2]) + 1
  else if (prevM && cmpTriplet(prevM[1], nextBase) > 0)
    die(
      `feed already serves ${prev} but this checkout would stamp ${nextBase}-local.1 (LOWER — ` +
        `the installed app would never see it). Are you on a stale branch? (${branch}@${head})`
    )
}
const stamped = `${nextBase}-local.${n}`
process.stdout.write(`[release-local] version stamp: ${pkg.version} → ${stamped}\n`)

function cmpTriplet(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}

// 2.5 — sync + verify runtime deps BEFORE packaging. electron-builder collects node_modules AS-ON-DISK
// (depth-1) into the asar, so if a dependency pin was bumped in package.json/lockfile but `pnpm install`
// never ran, the packaged app silently ships the STALE bundled copy. That is exactly how a build pinned
// to @expanse-ade/mcp 0.20.0 shipped 0.19.0 and the agent lost the kanban card-detail write params. A
// frozen install makes node_modules match the lockfile (and fails LOUDLY if the lockfile ≠ package.json);
// we then assert the key runtime package resolved to its exact pin, pinpointing any drift by name.
run('pnpm install --frozen-lockfile')
const mcpPin = pkg.dependencies?.['@expanse-ade/mcp']
if (mcpPin) {
  const installedPkg = join(root, 'node_modules', '@expanse-ade', 'mcp', 'package.json')
  if (!existsSync(installedPkg)) {
    die(`@expanse-ade/mcp is not installed after a frozen install — ${installedPkg} missing`)
  }
  const installed = JSON.parse(readFileSync(installedPkg, 'utf8')).version
  // An exact pin (X.Y.Z, optionally a prerelease) MUST match byte-for-byte — this is the guard that
  // catches the stale-bundle bug. A range pin (^/~) is left to the frozen install's lockfile match.
  const exactPin = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(mcpPin)
  if (exactPin && installed !== mcpPin) {
    die(
      `bundled @expanse-ade/mcp MISMATCH: package.json pins ${mcpPin} but node_modules has ${installed}. ` +
        `The packaged app would ship ${installed}. Run \`pnpm install\` and re-run this script.`
    )
  }
  process.stdout.write(
    `[release-local] runtime dep OK: @expanse-ade/mcp ${installed} (pin ${mcpPin})\n`
  )
}

// 3 + 4 — build with BOTH gates on, package to C:\ (ReFS/Defender gotcha on M:).
const gates = { ENABLE_AUTO_UPDATE: '1', LOCAL_UPDATE_CHANNEL: '1' }
if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true })
run('pnpm exec electron-vite build', gates)
run(
  `pnpm exec electron-builder --win --publish never ` +
    `--config.extraMetadata.version=${stamped} ` +
    `--config.directories.output="${OUT_DIR}"`,
  gates
)

// 5 — stage the feed. Order matters: payload first, manifest (latest.yml) LAST.
mkdirSync(FEED_DIR, { recursive: true })
const built = readdirSync(OUT_DIR)
const payload = built.filter(
  (f) => f.includes(stamped) && (f.endsWith('.exe') || f.endsWith('.blockmap'))
)
if (payload.length === 0) die(`no ${stamped} installer found in ${OUT_DIR} — did the build fail?`)
if (!built.includes('latest.yml')) die(`no latest.yml in ${OUT_DIR}`)
for (const f of payload) copyFileSync(join(OUT_DIR, f), join(FEED_DIR, f))
// updates.json: never a floor, never a tier — a personal build must never force-block.
writeFileSync(
  join(FEED_DIR, 'updates.json'),
  JSON.stringify({ latest: stamped, tiers: {} }, null, 2) + '\n'
)
copyFileSync(join(OUT_DIR, 'latest.yml'), join(FEED_DIR, 'latest.yml'))
// prune superseded payloads (the manifest now points elsewhere; keep the feed dir lean).
for (const f of readdirSync(FEED_DIR)) {
  if ((f.endsWith('.exe') || f.endsWith('.blockmap')) && !f.includes(stamped))
    rmSync(join(FEED_DIR, f), { force: true })
}
process.stdout.write(`[release-local] staged ${payload.length + 2} feed file(s) → ${FEED_DIR}\n`)

// 6 — ensure the loopback server, then verify the served manifest.
const probe = async () => {
  try {
    const res = await fetch(`${FEED_URL}/latest.yml`, { signal: AbortSignal.timeout(1500) })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

let served = await probe()
if (served === null) {
  process.stdout.write(`[release-local] feed server not running — starting it (detached)\n`)
  spawn(process.execPath, [join(root, 'scripts', 'serve-local-feed.mjs')], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      EXPANSE_LOCAL_FEED_DIR: FEED_DIR,
      EXPANSE_LOCAL_FEED_PORT: String(PORT)
    }
  }).unref()
  for (let i = 0; i < 15 && served === null; i++) {
    await new Promise((r) => setTimeout(r, 200))
    served = await probe()
  }
}
if (served === null)
  die(`feed server unreachable at ${FEED_URL} — start scripts/serve-local-feed.mjs manually`)
if (!served.includes(stamped))
  die(`served latest.yml does not carry ${stamped} — stale server dir?`)

process.stdout.write(
  `\n[release-local] ✅ published ${stamped} to ${FEED_URL}\n` +
    `  Installed Expanse (local channel) offers it on next launch, or immediately via\n` +
    `  Settings → About → Check for updates. Download → Restart — done.\n` +
    `  (First-time setup: docs/contributing/releasing.md › Local update channel.)\n`
)
