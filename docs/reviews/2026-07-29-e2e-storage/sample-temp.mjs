/* global process, setTimeout */
// Temp-footprint sampler (node) — pwsh samplers were killed mid-run twice
// (e2e specs taskkill shell trees; a pwsh sampler is collateral).
// Usage: node sample-temp.mjs <outCsv> <stopFile>
import { readdirSync, statSync, existsSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const [outCsv, stopFile] = process.argv.slice(2)
const temp = os.tmpdir()

function dirBytes(p) {
  let total = 0
  let stack = [p]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const fp = join(cur, e.name)
      if (e.isDirectory()) stack.push(fp)
      else if (e.isFile()) {
        try {
          total += statSync(fp).size
        } catch {
          /* deleted mid-walk */
        }
      }
    }
  }
  return total
}

writeFileSync(outCsv, 'ts,dirs,bytes,scanSec\n')
const tick = () => {
  if (existsSync(stopFile)) process.exit(0)
  const t0 = Date.now()
  let dirs = []
  try {
    dirs = readdirSync(temp, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && e.name.startsWith('playwright')
    )
  } catch {
    /* transient */
  }
  let bytes = 0
  for (const d of dirs) bytes += dirBytes(join(temp, d.name))
  const scan = (Date.now() - t0) / 1000
  const ts = new Date().toISOString()
  try {
    appendFileSync(outCsv, `${ts},${dirs.length},${bytes},${scan.toFixed(1)}\n`)
  } catch {
    /* keep looping */
  }
  setTimeout(tick, Math.max(1000, 10000 - scan * 1000))
}
tick()
