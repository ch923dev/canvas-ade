/**
 * Stage the daemon's runtime OUTSIDE the install dir (DESIGN.md D1). A running exe cannot be
 * overwritten on Windows (measured: `Device or resource busy`), so a daemon launched from the
 * install dir would block the NSIS update install — the feature's founding use case. The staged
 * copy lives in `%LOCALAPPDATA%\expanse-ptyhost\<appVersion>\` and consists of:
 *
 *   electron.exe (or Expanse.exe renamed to ptyhost.exe) · icudtl.dat ·
 *   v8_context_snapshot.bin · snapshot_blob.bin        — the measured-minimal run-as-node set
 *   ptyHostDaemon.js                                    — the bundled daemon entry
 *   node_modules/node-pty/{package.json,lib/**,build/Release/*.node,*.dll}
 *                                                       — Electron-ABI native, no recompile
 *
 * Copy-if-missing keyed on a completion marker; a torn copy (no marker) re-copies. Old version
 * dirs are swept best-effort (a still-running old daemon holds its exe → EBUSY → skipped, and
 * that's correct: it drains and idle-exits on its own).
 *
 * Pure planning core (paths in → copy list out) is separated from the fs walk so units can
 * assert the plan without an Electron runtime.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The 4-file measured-minimal ELECTRON_RUN_AS_NODE set (DESIGN.md D1 evidence). */
export const RUNTIME_FILES = ['icudtl.dat', 'v8_context_snapshot.bin', 'snapshot_blob.bin'] as const
/** Staged exe name — distinct from the app's, so Task Manager reads honestly. */
export const STAGED_EXE = 'expanse-ptyhost.exe'
export const DAEMON_JS = 'ptyHostDaemon.js'
const MARKER = '.staged-ok'

export interface StageSources {
  /** Directory holding electron.exe/Expanse.exe + icudtl.dat + snapshots. */
  runtimeDir: string
  /** The exe inside runtimeDir to copy (electron.exe in dev, Expanse.exe packaged). */
  exeName: string
  /** Absolute path of the bundled daemon script (out/main/ptyHostDaemon.js — may live in asar;
   *  Electron's fs asar patch makes copyFile read it transparently). */
  daemonJs: string
  /** Root of the node-pty package to subset-copy (app.asar.unpacked when packaged). */
  nodePtyDir: string
}

export interface CopyStep {
  from: string
  to: string
}

/** Files under node-pty worth staging: JS runtime + native binaries, no build residue. */
export function wantNodePtyFile(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/')
  if (norm === 'package.json') return true
  if (norm.startsWith('lib/') && norm.endsWith('.js')) return true
  if (norm.startsWith('build/Release/')) {
    // .node natives + any runtime DLLs; skip compile residue (.pdb/.iobj/.ipdb/.exp/.lib/obj/).
    return /\.(node|dll|exe)$/i.test(norm) && !norm.includes('/obj/')
  }
  return false
}

/** Recursively list files under `root`, relative paths, forward-slashed. */
function walk(root: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(root, rel))
    else out.push(rel)
  }
  return out
}

/** Pure: compute every copy step for a stage. */
export function planStage(src: StageSources, stageDir: string): CopyStep[] {
  const steps: CopyStep[] = [
    { from: path.join(src.runtimeDir, src.exeName), to: path.join(stageDir, STAGED_EXE) },
    ...RUNTIME_FILES.map((f) => ({
      from: path.join(src.runtimeDir, f),
      to: path.join(stageDir, f)
    })),
    { from: src.daemonJs, to: path.join(stageDir, DAEMON_JS) }
  ]
  for (const rel of walk(src.nodePtyDir)) {
    if (wantNodePtyFile(rel)) {
      steps.push({
        from: path.join(src.nodePtyDir, rel),
        to: path.join(stageDir, 'node_modules', 'node-pty', rel)
      })
    }
  }
  return steps
}

/** The staged daemon invocation for client.ts: argv0 + script path. */
export function stagedEntry(stageDir: string): { exe: string; script: string } {
  return { exe: path.join(stageDir, STAGED_EXE), script: path.join(stageDir, DAEMON_JS) }
}

/**
 * Ensure `stageDir` holds a complete copy; returns the entry. Skips all IO when the
 * completion marker exists. Not concurrency-safe across processes — MAIN is the only
 * writer, and it stages once per boot at most (client.ts).
 */
export function ensureStaged(src: StageSources, stageDir: string): { exe: string; script: string } {
  const marker = path.join(stageDir, MARKER)
  if (!fs.existsSync(marker)) {
    for (const step of planStage(src, stageDir)) {
      fs.mkdirSync(path.dirname(step.to), { recursive: true })
      fs.copyFileSync(step.from, step.to)
    }
    fs.writeFileSync(marker, JSON.stringify({ stagedAt: new Date().toISOString() }))
  }
  return stagedEntry(stageDir)
}

/** Best-effort sweep of other-version stage dirs (locked = old daemon still running → skip). */
export function sweepOldStages(stageRoot: string, keepDirName: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(stageRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === keepDirName) continue
    try {
      fs.rmSync(path.join(stageRoot, e.name), { recursive: true, force: true })
    } catch {
      /* an old daemon still runs from it — it idle-exits and a later boot sweeps it */
    }
  }
}
