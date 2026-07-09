/**
 * Project file I/O: read/write the canvas document (+ `.bak` fallback) in a project folder.
 * MAIN is a dumb atomic writer — it validates only the document envelope; deep validation +
 * migration happen in the renderer (`boardSchema.fromObject`). Holds the single "current open
 * dir" so `project:save` knows where to write.
 *
 * ADR 0009: the project document, its backup, and the `assets/` blob store all live under
 * `<project>/.canvas/` (isolated from the user's repo at the root). Reads PREFER `.canvas/` and
 * fall back to the legacy root location; writes always target `.canvas/`; `migrateProjectLayout`
 * relocates a legacy-root project on open. The stored `assetId` is unchanged (`assets/<sha1>.<ext>`)
 * — only the physical resolution base moves — so this is a LOCATION migration with NO schema bump.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync
} from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import { scaffoldProjectMemory, upgradeProjectGitignore } from './canvasMemory'

const CANVAS_DIR = '.canvas'
const CANVAS = 'canvas.json'
const CANVAS_BAK = 'canvas.json.bak'
const SESSION = 'session.json' // M1: viewport + backdrop sidecar (settings-class, git-ignored)
const ASSETS = 'assets'
const DOWNLOADS = 'downloads'

// ── On-disk path resolution (ADR 0009) ───────────────────────────────────────────
// Canonical locations live under `<project>/.canvas/`; the `legacy*` helpers point at the
// pre-0009 project root (the read-fallback + migration source).
const canvasRoot = (dir: string): string => join(dir, CANVAS_DIR)
const primaryPath = (dir: string): string => join(dir, CANVAS_DIR, CANVAS)
const bakPath = (dir: string): string => join(dir, CANVAS_DIR, CANVAS_BAK)
const sessionPath = (dir: string): string => join(dir, CANVAS_DIR, SESSION)
// Exported (Project Library + OSR downloads relocation): the `.canvas/assets` blob store and the
// `.canvas/downloads` folder that OSR Browser-board downloads now save into (ADR 0009).
export const assetsDirOf = (dir: string): string => join(dir, CANVAS_DIR, ASSETS)
export const downloadsDirOf = (dir: string): string => join(dir, CANVAS_DIR, DOWNLOADS)
const legacyPrimary = (dir: string): string => join(dir, CANVAS)
const legacyBak = (dir: string): string => join(dir, CANVAS_BAK)
const legacyAssets = (dir: string): string => join(dir, ASSETS)

/**
 * BUG-024/BUG-013: must mirror boardSchema.SCHEMA_VERSION (18). MAIN cannot import the
 * renderer module in shipped code, so this constant is duplicated here. It is tested (see
 * projectStore.test.ts, which cross-imports the renderer constant and asserts equality)
 * and must be bumped in lock-step whenever boardSchema.SCHEMA_VERSION increases.
 * Kept intentionally minimal — the renderer still owns migration; MAIN only writes the
 * canonical version marker on fresh-project creation. (v17 = Planning element appearance
 * props, ADDITIVE; re-sequences to 18 at the umbrella→main rebase — see boardSchemaVersion.ts.)
 */
export const SCHEMA_VERSION = 18

/**
 * Mirrors boardSchema.MIN_READER_VERSION (ADR 0007) under the same lock-step rule: bumped
 * here whenever the renderer constant bumps (breaking changes only). The floor moved to 12 with
 * the breaking `command` board type (v12), to 13 with the breaking `file` board type AND `fileref`
 * element kind (v13, file-tree S1), to 14 with the breaking `dataflow` board type (v14, JD-4), and to
 * 15 with the breaking `qhd`/`uhd` viewport presets (v15) — pre-15 apps reject the unrecognized
 * viewport, so they get the clean "update the app" message instead of a `.bak`-fallback parse failure.
 * The floor moved to 17 with the breaking `kanban` board type (v17, P4) — pre-17 apps have no
 * `kanban` case in `assertBoard` and would `.bak`-fallback, so they get the clean update prompt.
 * (v16 was additive and left the floor at 15.)
 */
export const MIN_READER_VERSION = 17

export type ProjectResult =
  | { ok: true; dir: string; name: string; doc: unknown; session?: unknown }
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

/**
 * Read the canvas document; on parse/envelope failure try the `.bak`, then the legacy-root
 * copies (ADR 0009). The `.canvas/` location is preferred at each tier so a migrated project
 * always wins, while an un-migrated (or partially-migrated) project still reads from the root.
 */
export function readProject(dir: string): ProjectResult {
  const primary = tryParse(primaryPath(dir)) ?? tryParse(legacyPrimary(dir))
  if (primary !== undefined)
    return { ok: true, dir, name: projectName(dir), doc: primary, session: readSession(dir) }
  const backup = tryParse(bakPath(dir)) ?? tryParse(legacyBak(dir))
  if (backup !== undefined)
    return { ok: true, dir, name: projectName(dir), doc: backup, session: readSession(dir) }
  return { ok: false, error: `No readable canvas.json in ${dir}` }
}

/**
 * Read ONLY the backup (skip the primary) — the renderer-reported deep-validation recovery
 * path (T5). `readProject` would return the primary whenever it is merely envelope-valid, so a
 * deep-corrupt-but-envelope-valid primary masks the backup; this forces the `.bak` so the
 * renderer can retry `fromObject` against the last good snapshot. Prefers `.canvas/`, falls back
 * to the legacy-root backup (ADR 0009).
 */
export function readBak(dir: string): ProjectResult {
  const backup = tryParse(bakPath(dir)) ?? tryParse(legacyBak(dir))
  if (backup !== undefined)
    return { ok: true, dir, name: projectName(dir), doc: backup, session: readSession(dir) }
  return { ok: false, error: `No readable canvas.json.bak in ${dir}` }
}

/**
 * M1: read the raw session sidecar (`.canvas/session.json` — camera viewport + backdrop), or null
 * when absent/unparseable. Deliberately NOT deep-validated here: the RENDERER runs it through
 * `boardSchema.reconcileSession` (the same guards `fromObject` uses) before it may override the
 * inline canvas.json values, so a parseable-but-invalid sidecar can never win. A miss → null → the
 * load falls back to the doc's inline viewport/background (fitView / no backdrop).
 */
export function readSession(dir: string): unknown {
  const f = sessionPath(dir)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

/**
 * M1: write the session sidecar. Split OUT of canvas.json so a bare camera pan / backdrop tweak
 * rewrites a few hundred bytes instead of the whole board tree (+ its .bak rotation). `fsync:false`:
 * disposable settings-class data (the inline copy in canvas.json is the fallback), so skipping the
 * fsync is the documented perf trade — a lost sidecar degrades to fitView / no backdrop, never data
 * loss. Its own temp file (never shared with the canvas.json write) so the two atomic writes never
 * collide.
 */
export async function writeSession(dir: string, session: unknown): Promise<void> {
  mkdirSync(canvasRoot(dir), { recursive: true })
  await writeFileAtomic(sessionPath(dir), JSON.stringify(session), {
    encoding: 'utf8',
    fsync: false
  })
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
  // ADR 0009: the document lives under `.canvas/`, so ensure that dir (not just the project root).
  mkdirSync(canvasRoot(dir), { recursive: true })
  const primary = primaryPath(dir)
  // BUG-007: capture the prior primary's bytes but rotate them into .bak only AFTER the
  // new primary is durable. Rotating first destroyed the last-good .bak in the T5
  // recovery flow (the prior primary is envelope-valid but deep-corrupt there): a crash
  // or write failure between the rotation and the primary write left BOTH files corrupt.
  //
  // H2: read the prior ONCE. The old code ran `tryParse(primary)` (readFileSync + JSON.parse of
  // the WHOLE prior doc) purely as a gate, then a SECOND `readFileSync` for the bytes — two full
  // reads + a parse per autosave. Read the bytes once and gate on THOSE: only an envelope-valid
  // prior is worth rotating (backing up a corrupt/foreign primary would poison the recovery path,
  // exactly the `tryParse` gate's intent — `isEnvelope(JSON.parse(...))` reproduces it).
  let prior: Buffer | undefined
  try {
    const bytes = readFileSync(primary)
    if (isEnvelope(JSON.parse(bytes.toString('utf8')))) prior = bytes
  } catch {
    /* missing / locked / unparseable prior — skip the rotation, keep the last-good .bak */
  }
  await writeFileAtomic(primary, JSON.stringify(doc, null, 2), 'utf8')
  if (prior !== undefined) {
    try {
      // H1: async (was `writeFileAtomic.sync`). The sync rotation blocked Electron's single main
      // thread on EVERY ~1s autosave — which also services PTY control IPC, preview frame relays,
      // and the MCP/local servers — and bought nothing: the primary above is already fsync-durable
      // via its own await, and the .bak holds the last-good PRIOR doc, so even a mid-write exit
      // leaves a valid recovery floor. The quit flush is fully awaited end-to-end (flushChannel →
      // renderer saver.flush → project:save IPC → this await), so the .bak also lands before the
      // hard app.exit(0). Order (primary durable THEN .bak) and every guard are unchanged.
      await writeFileAtomic(bakPath(dir), prior)
    } catch {
      /* a locked .bak must not fail the (already durable) save */
    }
  }
}

// ── Legacy-root → `.canvas/` migration (ADR 0009) ────────────────────────────────

/** Move a single file `src → dst` (rename, copy-fallback cross-volume). No-op if `src` is
 *  absent or `dst` already exists (never clobber a canonical file). Best-effort. */
function moveAside(src: string, dst: string): void {
  if (!existsSync(src) || existsSync(dst)) return
  try {
    renameSync(src, dst)
  } catch {
    try {
      copyFileSync(src, dst)
      unlinkSync(src)
    } catch {
      /* best-effort — a locked file must not abort the migration */
    }
  }
}

/** Move a whole directory `src → dst`. Fast path: rename when `dst` is absent (carries any
 *  `.trash` along). Otherwise content-addressed merge — move missing entries, drop duplicates
 *  (identical sha ⇒ identical bytes) — then remove the legacy dir only if it ends up empty
 *  (never recursively, so a failed move can't be turned into data loss). Best-effort. */
function moveDir(src: string, dst: string): void {
  if (!existsSync(src)) return
  if (!existsSync(dst)) {
    try {
      renameSync(src, dst)
      return
    } catch {
      /* cross-volume or locked — fall through to the copy-merge below */
    }
  }
  let files: string[]
  try {
    files = readdirSync(src)
  } catch {
    return
  }
  mkdirSync(dst, { recursive: true })
  for (const f of files) {
    const s = join(src, f)
    const d = join(dst, f)
    try {
      if (existsSync(d)) {
        rmSync(s, { recursive: true, force: true }) // already canonical (identical content) — drop
      } else {
        renameSync(s, d)
      }
    } catch {
      try {
        copyFileSync(s, d)
        unlinkSync(s)
      } catch {
        /* best-effort per entry */
      }
    }
  }
  try {
    rmdirSync(src) // succeeds only when empty — a leftover/locked entry leaves the dir in place
  } catch {
    /* non-empty / locked — leave it; readAsset still falls back to the legacy location */
  }
}

/**
 * ADR 0009: relocate a legacy-root project (`<dir>/canvas.json` + `.bak` + `assets/`) into
 * `<dir>/.canvas/` on open. Idempotent (no-op once the canonical primary exists), best-effort
 * (a locked/failed move never aborts the open — the readers fall back to the legacy root). Also
 * upgrades a recognized old `.canvas/.gitignore` so the relocated `canvas.json` is not silently
 * un-tracked. The doc content (every `assetId`) is byte-identical before and after — no schema
 * bump (orthogonal to ADR 0007).
 */
export function migrateProjectLayout(dir: string): void {
  try {
    if (!existsSync(primaryPath(dir)) && existsSync(legacyPrimary(dir))) {
      mkdirSync(canvasRoot(dir), { recursive: true })
      moveAside(legacyPrimary(dir), primaryPath(dir))
      moveAside(legacyBak(dir), bakPath(dir))
      moveDir(legacyAssets(dir), assetsDirOf(dir))
    }
    // Always reconcile the ignore file (covers a project whose files were already relocated but
    // whose `.gitignore` is still the old `*`). A user-customised file is left untouched.
    upgradeProjectGitignore(dir)
  } catch (err) {
    console.warn('[projectStore] migrateProjectLayout failed (non-fatal)', err)
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
  // ADR 0009: relocate a legacy-root project into `.canvas/` first, so reuse-if-exists and the
  // corrupt-rename-aside below operate on the canonical location.
  migrateProjectLayout(dir)
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
    const p = join(canvasRoot(dir), f)
    if (existsSync(p)) {
      try {
        renameSync(p, join(canvasRoot(dir), `${f}.corrupt-${ts}`))
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
// (`ASSETS = 'assets'` is declared with the path helpers at the top of the module.)
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
 * MAIN-side write ceiling (DoS backstop) — mirrors fileIpc.ts's `MAX_READ_BYTES`. The renderer
 * already size-gates for UX (e.g. BackdropPicker's `IMAGE_CAP_BYTES` 30 MiB / `VIDEO_CAP_BYTES`
 * 200 MiB), but not every caller does (usePlanningImageIO's paste/drop path has no client-side
 * cap at all), and a renderer-side cap is advisory only regardless. 256 MiB sits safely above the
 * largest renderer gate; a write over it is rejected before the bytes are hashed or touched.
 */
const MAX_WRITE_BYTES = 256 * 1024 * 1024

/**
 * Content-address `bytes` (sha1) into `<dir>/.canvas/assets/<sha1>.<ext>` and return the stored
 * `assetId` — `assets/<sha1>.<ext>`, UNCHANGED by ADR 0009 (a logical id, not a physical path;
 * only the resolution base moved into `.canvas/`). Dedups: identical bytes → identical id; the
 * write is skipped when the file already exists.
 */
export async function writeAsset(
  dir: string,
  bytes: Uint8Array,
  ext: string
): Promise<{ assetId: string }> {
  const e = String(ext).toLowerCase()
  if (!ASSET_EXTS.has(e)) throw new Error(`writeAsset: unsupported ext ${ext}`)
  if (bytes.byteLength > MAX_WRITE_BYTES) {
    throw new Error(
      `writeAsset: too large to write (${bytes.byteLength} bytes > ${MAX_WRITE_BYTES})`
    )
  }
  const sha1 = createHash('sha1').update(bytes).digest('hex')
  const assetId = `${ASSETS}/${sha1}.${e}`
  const abs = join(assetsDirOf(dir), `${sha1}.${e}`)
  if (!existsSync(abs)) {
    mkdirSync(assetsDirOf(dir), { recursive: true })
    await writeFileAtomic(abs, Buffer.from(bytes))
  }
  return { assetId }
}

/** Read a stored asset's bytes; null on a malformed assetId, missing file, or read error.
 *  ADR 0009: prefer `.canvas/assets/`; fall back to the legacy root `assets/` so an un-migrated
 *  (or partially-migrated) project's blobs still resolve. ASSET_RE blocks traversal either way. */
export function readAsset(dir: string, assetId: string): Uint8Array | null {
  if (typeof assetId !== 'string' || !ASSET_RE.test(assetId)) return null
  const canonical = join(canvasRoot(dir), assetId)
  const abs = existsSync(canonical) ? canonical : join(dir, assetId)
  if (!existsSync(abs)) return null
  try {
    return new Uint8Array(readFileSync(abs))
  } catch {
    return null
  }
}

/**
 * Every assetId a doc references (version-independent), from three sources:
 *  - planning `image` elements (`boards[].elements[].assetId`, since W4)
 *  - planning `diagram` elements' derived `svgCache` (`boards[].elements[].svgCache`, since v11/S4).
 *    MUST be included for the SAME reason as images: `gcAssets` runs at every project:open against
 *    this set, so omitting it sweeps the cached SVG to `.trash` on reopen, forcing a needless
 *    re-render (and a blank diagram until it completes) — the documented backdrop-asset gotcha.
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
        const kind = el && (el as { kind?: unknown }).kind
        if (kind === 'image') {
          const a = (el as { assetId?: unknown }).assetId
          if (typeof a === 'string' && a.length > 0) ids.add(a)
        } else if (kind === 'diagram') {
          const a = (el as { svgCache?: unknown }).svgCache
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
 * Mark-and-sweep: quarantine-move every file in `<dir>/.canvas/assets/` whose `assets/<file>`
 * path is NOT in `referenced` into `<dir>/.canvas/assets/.trash/` (recoverable). Hard-deletion
 * is intentionally avoided — a mis-read/corrupt load must not permanently destroy blobs.
 * No-op when `assets/` is absent. Called ONLY at project open — the undo stack is empty
 * across sessions, so a swept blob is truly unreferenced.
 *
 * Safety: `collectAssetIds` / `readAsset` match only `ASSET_RE`
 * (`assets/<40-hex>.<ext>`), so the `.trash` directory name can never be a valid assetId
 * and is never returned as a referenced or readable asset.
 */
export function gcAssets(dir: string, referenced: Set<string>): void {
  const assetsDir = assetsDirOf(dir) // ADR 0009: the canonical blob store under `.canvas/`
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
