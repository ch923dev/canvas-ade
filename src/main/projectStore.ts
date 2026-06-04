/**
 * Project file I/O: read/write `canvas.json` (+ `.bak` fallback) in a project folder.
 * MAIN is a dumb atomic writer — it validates only the document envelope; deep
 * validation + migration happen in the renderer (`boardSchema.fromObject`). Holds the
 * single "current open dir" so `project:save` knows where to write.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import { scaffoldProjectMemory } from './canvasMemory'

const CANVAS = 'canvas.json'
const CANVAS_BAK = 'canvas.json.bak'

export type ProjectResult =
  | { ok: true; dir: string; name: string; doc: unknown }
  | { ok: false; error: string }

let currentDir: string | null = null
export function getCurrentDir(): string | null {
  return currentDir
}
export function setCurrentDir(dir: string | null): void {
  currentDir = dir
}

/** Folder basename = the project's display name. */
export function projectName(dir: string): string {
  const parts = dir.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || dir
}

/** Envelope-only check — deep validation is the renderer's job. */
function isEnvelope(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { schemaVersion?: unknown }).schemaVersion === 'number' &&
    Array.isArray((v as { boards?: unknown }).boards)
  )
}

function tryParse(file: string): unknown | undefined {
  if (!existsSync(file)) return undefined
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return isEnvelope(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** Read canvas.json; on parse/envelope failure try canvas.json.bak; else error. */
export function readProject(dir: string): ProjectResult {
  const primary = tryParse(join(dir, CANVAS))
  if (primary !== undefined) return { ok: true, dir, name: projectName(dir), doc: primary }
  const backup = tryParse(join(dir, CANVAS_BAK))
  if (backup !== undefined) return { ok: true, dir, name: projectName(dir), doc: backup }
  return { ok: false, error: `No readable canvas.json in ${dir}` }
}

/** Rotate the prior good canvas.json → .bak, then atomic-write the new doc. */
export async function writeProject(dir: string, doc: unknown): Promise<void> {
  // PERSIST-1: envelope-guard the INCOMING doc before any disk touch. MAIN trusts the
  // renderer's deep validation, but a renderer serialization bug could otherwise write a
  // structurally-invalid primary (and the next write would rotate that junk into .bak,
  // eroding the recovery path). Reject loudly instead of persisting garbage; the prior
  // good primary + .bak stay intact. Mirrors the read-side envelope check.
  if (!isEnvelope(doc)) {
    throw new Error('writeProject: refusing to write an envelope-invalid document')
  }
  mkdirSync(dir, { recursive: true })
  const primary = join(dir, CANVAS)
  if (tryParse(primary) !== undefined) {
    try {
      copyFileSync(primary, join(dir, CANVAS_BAK))
    } catch {
      /* a missing/locked prior file must not block the new write */
    }
  }
  await writeFileAtomic(primary, JSON.stringify(doc, null, 2), 'utf8')
}

/** Ensure the folder; reuse an existing canvas.json, else write a fresh empty doc. */
export async function createProject(
  dir: string,
  _name: string,
  _opts: { gitInit?: boolean }
): Promise<ProjectResult> {
  // `gitInit` is accepted for forward-compat with Slice C (worktrees) but is inert here.
  mkdirSync(dir, { recursive: true })
  const existing = readProject(dir)
  if (existing.ok) {
    scaffoldProjectMemory(dir) // open-if-absent on a reused project (best-effort)
    return existing
  }
  // PERSIST-C: route the fresh write through writeProject so a canvas.json is only ever
  // created via the one envelope-guarded + atomic path (the same guard project:save uses)
  // — a future change to the fresh-doc shape can't silently bypass it. There is no prior
  // file here (reuse-if-exists returned above), so the .bak rotation is a no-op.
  const fresh = { schemaVersion: 2, viewport: null, boards: [] }
  await writeProject(dir, fresh)
  scaffoldProjectMemory(dir) // T-M1: project data lives in <project>/.canvas/ (best-effort)
  return { ok: true, dir, name: projectName(dir), doc: fresh }
}

// ── W4 assets pipeline ──────────────────────────────────────────────────────────
const ASSETS = 'assets'
/** A safe stored assetId: exactly `assets/<40-hex sha1>.<ext>`; blocks any traversal. */
const ASSET_RE = /^assets[/\\][a-f0-9]{40}\.[a-z0-9]+$/
const ASSET_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

/**
 * Content-address `bytes` (sha1) into `<dir>/assets/<sha1>.<ext>` and return the
 * RELATIVE POSIX path (the stored `assetId`). Dedups: identical bytes → identical
 * path; the write is skipped when the file already exists.
 */
export async function writeAsset(
  dir: string,
  bytes: Uint8Array,
  ext: string
): Promise<{ assetId: string }> {
  const e = String(ext).toLowerCase()
  if (!ASSET_EXTS.has(e)) throw new Error(`writeAsset: unsupported ext ${ext}`)
  const sha1 = createHash('sha1').update(bytes).digest('hex')
  const assetId = `${ASSETS}/${sha1}.${e}`
  const abs = join(dir, ASSETS, `${sha1}.${e}`)
  if (!existsSync(abs)) {
    mkdirSync(join(dir, ASSETS), { recursive: true })
    await writeFileAtomic(abs, Buffer.from(bytes))
  }
  return { assetId }
}

/** Read a stored asset's bytes; null on a malformed assetId, missing file, or read error. */
export function readAsset(dir: string, assetId: string): Uint8Array | null {
  if (typeof assetId !== 'string' || !ASSET_RE.test(assetId)) return null
  const abs = join(dir, assetId)
  if (!existsSync(abs)) return null
  try {
    return new Uint8Array(readFileSync(abs))
  } catch {
    return null
  }
}

/** Every assetId referenced by a doc's planning image elements (version-independent). */
export function collectAssetIds(doc: unknown): Set<string> {
  const ids = new Set<string>()
  const boards = (doc as { boards?: unknown })?.boards
  if (!Array.isArray(boards)) return ids
  for (const b of boards) {
    const els = (b as { elements?: unknown })?.elements
    if (!Array.isArray(els)) continue
    for (const el of els) {
      if (el && (el as { kind?: unknown }).kind === 'image') {
        const a = (el as { assetId?: unknown }).assetId
        if (typeof a === 'string' && a.length > 0) ids.add(a)
      }
    }
  }
  return ids
}

/**
 * Mark-and-sweep: delete every file in `<dir>/assets/` whose `assets/<file>` path is
 * NOT in `referenced`. No-op when `assets/` is absent. Called ONLY at project open —
 * the undo stack is empty across sessions, so a swept blob is truly unreferenced.
 */
export function gcAssets(dir: string, referenced: Set<string>): void {
  const assetsDir = join(dir, ASSETS)
  if (!existsSync(assetsDir)) return
  let files: string[]
  try {
    files = readdirSync(assetsDir)
  } catch {
    return
  }
  for (const f of files) {
    if (!referenced.has(`${ASSETS}/${f}`)) {
      try {
        unlinkSync(join(assetsDir, f))
      } catch {
        /* a locked / already-removed file must not abort the sweep */
      }
    }
  }
}
