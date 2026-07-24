#!/usr/bin/env node
/**
 * Capture a committed bench baseline (audit R2).
 *
 * WHY MACHINE STATE IS HALF OF THIS SCRIPT. The 2026-06-25 terminal-renderer report recorded fps
 * and frame times but not the conditions they were taken under. A month later the same numbers were
 * unreachable, and ruling out the obvious causes cost a full investigation: the app source at that
 * commit, the entire dependency tree at that commit's lockfile (installed clean), and the Electron
 * version were each measured and each exonerated. What was left was the machine — which by then was
 * sitting at 76% CPU at rest. A bench number without its conditions is not a baseline, it is an
 * anecdote, so this script refuses to emit one without them.
 *
 *   pnpm bench:baseline                  # build, run every bench, write docs/reviews/<date>-bench/
 *   pnpm bench:baseline -- --out <dir>   # write somewhere else
 *   pnpm bench:baseline -- --no-build    # reuse the existing out/ (skips the CANVAS_E2E build)
 *   pnpm bench:baseline -- --grep <re>   # restrict to matching benches
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}

/** `YYYY-MM-DD` in local time — matches the repo's `docs/reviews/<date>-…/` convention. */
function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Sample CPU utilisation over a real interval.
 *
 * `os.loadavg()` is the obvious call and is USELESS here — it returns [0,0,0] on Windows, which is
 * the platform this baseline is captured on. Differencing `os.cpus()` cumulative tick counters is
 * portable and measures the thing we actually care about: how much headroom the bench will have.
 */
function sampleCpu(ms = 1000) {
  const totals = (cpus) =>
    cpus.map((c) => {
      const t = c.times
      return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq }
    })
  const before = totals(os.cpus())
  // Deliberately blocking: this runs once, before any measurement, and an async wait would just
  // add scheduling noise to the very number being sampled.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const after = totals(os.cpus())
  let idle = 0
  let total = 0
  for (let i = 0; i < before.length; i++) {
    idle += after[i].idle - before[i].idle
    total += after[i].total - before[i].total
  }
  return total === 0 ? null : Math.round((1 - idle / total) * 1000) / 10
}

/** Best-effort display + GPU facts. Windows-only (PowerShell); other platforms report null rather
 *  than guessing, since a wrong refresh rate would silently invalidate every p50 reading. */
function displayInfo() {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,DriverVersion,CurrentRefreshRate,CurrentHorizontalResolution,CurrentVerticalResolution | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', timeout: 20000 }
    )
    return JSON.parse(out)
  } catch {
    return null
  }
}

/** Processes worth naming in a baseline — the ones that plausibly contend for CPU/GPU. Counted, not
 *  enumerated: the point is the load, not an inventory of what the user had open. */
function contendingProcesses() {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-Process | Where-Object { $_.ProcessName -match 'electron|node|pwsh|powershell|Docker|chrome|msedge|Code' } | Group-Object ProcessName | ForEach-Object { [pscustomobject]@{ name=$_.Name; count=$_.Count } } | ConvertTo-Json -Compress"
      ],
      { encoding: 'utf8', timeout: 20000 }
    )
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return null
  }
}

function machineState() {
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? null,
    logicalProcessors: cpus.length,
    totalMemGb: Math.round((totalMem / 1024 ** 3) * 10) / 10,
    freeMemGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    cpuLoadAtRestPct: sampleCpu(),
    display: displayInfo(),
    contendingProcesses: contendingProcesses(),
    node: process.version
  }
}

const outDir = value('--out', join('docs', 'reviews', `${today()}-bench`))
const ndjson = join(os.tmpdir(), `canvas-bench-${process.pid}.ndjson`)

console.log('[bench:baseline] sampling machine state…')
const machine = machineState()
console.log(
  `[bench:baseline] ${machine.logicalProcessors} logical processors · ` +
    `CPU at rest ${machine.cpuLoadAtRestPct}% · ${machine.freeMemGb}/${machine.totalMemGb} GB free`
)
// The whole reason this script exists. A baseline captured on a busy machine is still useful — but
// only if whoever compares against it later knows that is what they are comparing against.
if (machine.cpuLoadAtRestPct !== null && machine.cpuLoadAtRestPct > 25) {
  console.warn(
    `[bench:baseline] WARNING: ${machine.cpuLoadAtRestPct}% CPU load before the bench even starts. ` +
      'These numbers describe a loaded machine. Recorded in BASELINE.json — do not compare them ' +
      'against numbers taken on a quiet one.'
  )
}

if (!flag('--no-build')) {
  console.log('[bench:baseline] building with CANVAS_E2E=1…')
  execFileSync('pnpm', ['exec', 'electron-vite', 'build'], {
    stdio: 'inherit',
    env: { ...process.env, CANVAS_E2E: '1' },
    shell: true
  })
}

if (existsSync(ndjson)) rmSync(ndjson)

const args = ['exec', 'playwright', 'test', '--config', 'playwright.bench.config.ts']
const grep = value('--grep', null)
if (grep !== null) args.push('--grep', grep)

console.log('[bench:baseline] running benches…')
let benchFailed = false
try {
  execFileSync('pnpm', args, {
    stdio: 'inherit',
    env: { ...process.env, BENCH_JSON: ndjson },
    shell: true
  })
} catch {
  // Write out whatever WAS measured before failing. A partial baseline plus a loud failure is more
  // useful than losing a ten-minute run because the last configuration tripped.
  benchFailed = true
}

const runs = existsSync(ndjson)
  ? readFileSync(ndjson, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
  : []
if (existsSync(ndjson)) rmSync(ndjson)

if (runs.length === 0) {
  console.error(
    '[bench:baseline] no bench records were produced — refusing to write an empty baseline.'
  )
  process.exit(1)
}

const baseline = {
  capturedAt: new Date().toISOString(),
  appVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
  commit: (() => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  })(),
  complete: !benchFailed,
  machine,
  runs
}

mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'BASELINE.json')
writeFileSync(outFile, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
console.log(`[bench:baseline] wrote ${outFile} (${runs.length} run(s))`)

if (benchFailed) {
  console.error('[bench:baseline] a bench FAILED — the baseline above is partial.')
  process.exit(1)
}
