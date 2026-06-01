/**
 * Project file I/O: read/write `canvas.json` (+ `.bak` fallback) in a project folder.
 * MAIN is a dumb atomic writer — it validates only the document envelope; deep
 * validation + migration happen in the renderer (`boardSchema.fromObject`). Holds the
 * single "current open dir" so `project:save` knows where to write.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

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
export function createProject(
  dir: string,
  _name: string,
  _opts: { gitInit?: boolean }
): ProjectResult {
  // `gitInit` is accepted for forward-compat with Slice C (worktrees) but is inert here.
  mkdirSync(dir, { recursive: true })
  const existing = readProject(dir)
  if (existing.ok) return existing
  const fresh = { schemaVersion: 2, viewport: null, boards: [] }
  writeFileAtomic.sync(join(dir, CANVAS), JSON.stringify(fresh, null, 2), 'utf8')
  return { ok: true, dir, name: projectName(dir), doc: fresh }
}
