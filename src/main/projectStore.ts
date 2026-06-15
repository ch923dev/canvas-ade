/**
 * Project file I/O: read/write `canvas.json` (+ `.bak` fallback) in a project folder.
 * MAIN is a dumb atomic writer — it validates only the document envelope; deep
 * validation + migration happen in the renderer (`boardSchema.fromObject`). Holds the
 * single "current open dir" so `project:save` knows where to write.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync
} from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import { scaffoldProjectMemory } from './canvasMemory'

const CANVAS = 'canvas.json'
const CANVAS_BAK = 'canvas.json.bak'

/**
 * BUG-024/BUG-013: must mirror boardSchema.SCHEMA_VERSION (10). MAIN cannot import the
 * renderer module in shipped code, so this constant is duplicated here. It is tested (see
 * projectStore.test.ts, which cross-imports the renderer constant and asserts equality)
 * and must be bumped in lock-step whenever boardSchema.SCHEMA_VERSION increases.
 * Kept intentionally minimal — the renderer still owns migration; MAIN only writes the
 * canonical version marker on fresh-project creation.
 */
export const SCHEMA_VERSION = 10

/**
 * Mirrors boardSchema.MIN_READER_VERSION (ADR 0007) under the same lock-step rule: bumped
 * here whenever the renderer constant bumps (breaking changes only). v10 is additive, so
 * the compat floor stays at 9 — older v9+ apps can still open fresh v10 docs.
 */
export const MIN_READER_VERSION = 9

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

/**
 * Read ONLY canvas.json.bak (skip the primary) — the renderer-reported deep-validation
 * recovery path (T5). `readProject` would return the primary whenever it is merely
 * envelope-valid, so a deep-corrupt-but-envelope-valid primary masks the backup; this
 * forces the .bak so the renderer can retry `fromObject` against the last good snapshot.
 */
export function readBak(dir: string): ProjectResult {
  const backup = tryParse(join(dir, CANVAS_BAK))
  if (backup !== undefined) return { ok: true, dir, name: projectName(dir), doc: backup }
  return { ok: false, error: `No readable canvas.json.bak in ${dir}` }
}

/**
 * Atomically rotate the prior good `canvas.json` → `canvas.json.bak`. Uses write-file-atomic's
 * temp-write + rename (the same primitive the primary write uses) instead of a raw
 * `copyFileSync`, so a crash mid-rotation can never leave a torn `.bak`
 * (bak-rotation-non-atomic-copy). The caller has already verified `primary` parses, so reading
 * its bytes here is safe.
 */
export function rotateBakAtomic(primary: string, bakPath: string): void {
  writeFileAtomic.sync(bakPath, readFileSync(primary))
}

/** Atomic-write the new doc, THEN rotate the prior primary → .bak. */
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
  // BUG-007: capture the prior primary's bytes but rotate them into .bak only AFTER the
  // new primary is durable. Rotating first destroyed the last-good .bak in the T5
  // recovery flow (the prior primary is envelope-valid but deep-corrupt there): a crash
  // or write failure between the rotation and the primary write left BOTH files corrupt.
  let prior: Buffer | undefined
  if (tryParse(primary) !== undefined) {
    try {
      prior = readFileSync(primary)
    } catch {
      /* a missing/locked prior file must not block the new write */
    }
  }
  await writeFileAtomic(primary, JSON.stringify(doc, null, 2), 'utf8')
  if (prior !== undefined) {
    try {
      writeFileAtomic.sync(join(dir, CANVAS_BAK), prior)
    } catch {
      /* a locked .bak must not fail the (already durable) save */
    }
  }
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
  // BUG-042: reuse-if-exists failed, but unparseable canvas.json/.bak files may still be
  // on disk (exactly the state after "Could not open project" → retry via Create). Their
  // bytes are frequently hand-recoverable (truncated/garbled JSON), so rename them aside
  // instead of letting the fresh write (and the next save's rotation) destroy them.
  // Best-effort: a locked file must not block project creation.
  const ts = Date.now()
  for (const f of [CANVAS, CANVAS_BAK]) {
    const p = join(dir, f)
    if (existsSync(p)) {
      try {
        renameSync(p, join(dir, `${f}.corrupt-${ts}`))
      } catch {
        /* fall through — the fresh write below proceeds either way */
      }
    }
  }
  // PERSIST-C: route the fresh write through writeProject so a canvas.json is only ever
  // created via the one envelope-guarded + atomic path (the same guard project:save uses)
  // — a future change to the fresh-doc shape can't silently bypass it. There is no prior
  // file here (reuse-if-exists returned above), so the .bak rotation is a no-op.
  // BUG-024/BUG-013: use SCHEMA_VERSION (10) so fresh docs match the current schema
  // contract; include connectors:[] (added at v4->v5) so external tooling never sees a
  // stale marker.
  const fresh = {
    schemaVersion: SCHEMA_VERSION,
    minReaderVersion: MIN_READER_VERSION,
    viewport: null,
    boards: [],
    connectors: []
  }
  await writeProject(dir, fresh)
  scaffoldProjectMemory(dir) // T-M1: project data lives in <project>/.canvas/ (best-effort)
  return { ok: true, dir, name: projectName(dir), doc: fresh }
}

// ── W4 assets pipeline ──────────────────────────────────────────────────────────
const ASSETS = 'assets'
/** A safe stored assetId: exactly `assets/<40-hex sha1>.<ext>`; blocks any traversal. */
const ASSET_RE = /^assets[/\\][a-f0-9]{40}\.[a-z0-9]+$/
/**
 * MAIN re-validates asset extensions independently of the renderer (untrusted) — a
 * deliberate cross-trust-boundary duplication of the renderer accept lists, NOT a
 * shared import. `assetExtsParity.test.ts` (S11b) drift-guards it: every ext in the
 * renderer's `acceptExts` (IMAGE_EXTS + VIDEO_EXTS + MIME_BY_EXT keys) must be a
 * subset of this set, so a new ext added on one side fails a unit test rather than a
 * user's import (the webm regression, addendum section 6). `svg` is MAIN-only here.
 */
export const ASSET_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'webm', 'mp4'])

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

/**
 * Every assetId a doc references (version-independent), from two sources:
 *  - planning `image` elements (`boards[].elements[].assetId`, since W4)
 *  - the v9 root `background.assetId` — a `kind:'file'` wallpaper (image OR webm/mp4
 *    video). MUST be included: `gcAssets` runs at every project:open against this set,
 *    so omitting the backdrop asset sweeps the user's wallpaper to `.trash` on reopen,
 *    which `useBackdropMedia` then reads as missing and silently reverts to `kind:'none'`.
 */
export function collectAssetIds(doc: unknown): Set<string> {
  const ids = new Set<string>()
  const boards = (doc as { boards?: unknown })?.boards
  if (Array.isArray(boards)) {
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
  }
  // v9 root background wallpaper (kind:'file'); scenes carry no assetId.
  const bgId = (doc as { background?: { assetId?: unknown } })?.background?.assetId
  if (typeof bgId === 'string' && bgId.length > 0) ids.add(bgId)
  return ids
}

const TRASH = '.trash'

/**
 * Mark-and-sweep: quarantine-move every file in `<dir>/assets/` whose `assets/<file>`
 * path is NOT in `referenced` into `<dir>/assets/.trash/` (recoverable). Hard-deletion
 * is intentionally avoided — a mis-read/corrupt load must not permanently destroy blobs.
 * No-op when `assets/` is absent. Called ONLY at project open — the undo stack is empty
 * across sessions, so a swept blob is truly unreferenced.
 *
 * Safety: `collectAssetIds` / `readAsset` match only `ASSET_RE`
 * (`assets/<40-hex>.<ext>`), so the `.trash` directory name can never be a valid assetId
 * and is never returned as a referenced or readable asset.
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
    if (f === TRASH) continue // never sweep the quarantine dir itself
    if (!referenced.has(`${ASSETS}/${f}`)) {
      try {
        const trashDir = join(assetsDir, TRASH)
        mkdirSync(trashDir, { recursive: true })
        copyFileSync(join(assetsDir, f), join(trashDir, f))
        unlinkSync(join(assetsDir, f)) // move = copy-then-unlink; the quarantine copy is retained
      } catch {
        /* a locked / already-moved file must not abort the sweep */
      }
    }
  }
}
