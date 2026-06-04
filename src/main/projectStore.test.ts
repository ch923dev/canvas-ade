import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  readProject,
  readBak,
  writeProject,
  rotateBakAtomic,
  createProject,
  writeAsset,
  readAsset,
  collectAssetIds,
  gcAssets
} from './projectStore'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-proj-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const doc = { schemaVersion: 2, viewport: null, boards: [] }

describe('projectStore', () => {
  it('createProject writes a fresh empty doc', async () => {
    const r = await createProject(dir, 'My Proj', {})
    expect(r.ok).toBe(true)
    expect(existsSync(join(dir, 'canvas.json'))).toBe(true)
  })

  it('createProject reuses an existing canvas.json (no overwrite)', async () => {
    writeFileSync(
      join(dir, 'canvas.json'),
      JSON.stringify({ schemaVersion: 2, viewport: null, boards: [{ keep: true }] })
    )
    const r = await createProject(dir, 'My Proj', {})
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.doc as { boards: unknown[] }).boards).toHaveLength(1)
  })

  it('createProject writes the fresh doc through the envelope-guarded path (PERSIST-C)', async () => {
    await createProject(dir, 'My Proj', {})
    // The created file must be re-readable through the same guard project:save writes
    // by — locking the fresh-doc shape to the single validated write path.
    const r = readProject(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc).toEqual({ schemaVersion: 2, viewport: null, boards: [] })
  })

  it('createProject scaffolds the .canvas memory tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'projmem-'))
    try {
      await createProject(dir, 'p', {})
      expect(existsSync(join(dir, '.canvas', 'memory'))).toBe(true)
      expect(existsSync(join(dir, '.canvas', 'audit'))).toBe(true)
      expect(readFileSync(join(dir, '.canvas', '.gitignore'), 'utf8')).toBe('*\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('write then read round-trips', async () => {
    await writeProject(dir, doc)
    const r = readProject(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc).toEqual(doc)
  })

  it('rotates the prior good file to canvas.json.bak on write', async () => {
    await writeProject(dir, { schemaVersion: 2, viewport: null, boards: [{ v: 1 }] })
    await writeProject(dir, { schemaVersion: 2, viewport: null, boards: [{ v: 2 }] })
    const bak = JSON.parse(readFileSync(join(dir, 'canvas.json.bak'), 'utf8'))
    expect(bak.boards[0].v).toBe(1)
  })

  it('rotateBakAtomic copies the primary to the .bak byte-identically, leaving no temp file', () => {
    // bak-rotation-non-atomic-copy: the rotation must go through the atomic write/rename
    // primitive (no torn .bak on a mid-copy crash), not a raw copyFileSync.
    const primary = join(dir, 'canvas.json')
    const bak = join(dir, 'canvas.json.bak')
    const content = JSON.stringify({ schemaVersion: 2, viewport: null, boards: [{ v: 1 }] })
    writeFileSync(primary, content)

    rotateBakAtomic(primary, bak)

    expect(readFileSync(bak, 'utf8')).toBe(content)
    // write-file-atomic writes a temp sibling then renames; on success nothing is left behind.
    const stray = readdirSync(dir).filter((f) => f !== 'canvas.json' && f !== 'canvas.json.bak')
    expect(stray).toEqual([])
  })

  it('falls back to .bak when canvas.json is corrupt', async () => {
    await writeProject(dir, doc) // valid
    writeFileSync(
      join(dir, 'canvas.json.bak'),
      JSON.stringify({ schemaVersion: 2, viewport: null, boards: [{ ok: true }] })
    )
    writeFileSync(join(dir, 'canvas.json'), '{ this is not json')
    const r = readProject(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.doc as { boards: { ok: boolean }[] }).boards[0].ok).toBe(true)
  })

  it('returns an error (never writes) when both files are corrupt', () => {
    writeFileSync(join(dir, 'canvas.json'), 'nope')
    writeFileSync(join(dir, 'canvas.json.bak'), 'also nope')
    const r = readProject(dir)
    expect(r.ok).toBe(false)
  })

  it('returns an error when no canvas.json exists', () => {
    expect(readProject(dir).ok).toBe(false)
  })

  it('rejects an envelope-invalid doc and never touches the primary (PERSIST-1)', async () => {
    await writeProject(dir, doc) // seed a valid primary
    await expect(writeProject(dir, { nope: true })).rejects.toThrow()
    // The good primary must survive — a renderer bug must not clobber it with junk.
    const r = readProject(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc).toEqual(doc)
  })

  // T5: readBak skips the primary and reads ONLY canvas.json.bak — the renderer calls it
  // after a DEEP-validation failure (the primary is envelope-valid, so readProject would
  // happily return that same deep-corrupt primary; only the .bak can recover).
  it('readBak returns the .bak doc even when canvas.json is envelope-valid but deep-corrupt', () => {
    // Primary: envelope-valid (numeric schemaVersion + boards[]) but a board has a
    // non-string id — readProject would return THIS (envelope check passes), so the
    // renderer needs readBak to reach the backup instead.
    writeFileSync(
      join(dir, 'canvas.json'),
      JSON.stringify({ schemaVersion: 5, viewport: null, boards: [{ id: 123 }] })
    )
    writeFileSync(
      join(dir, 'canvas.json.bak'),
      JSON.stringify({ schemaVersion: 2, viewport: null, boards: [{ ok: true }] })
    )
    const r = readBak(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.doc as { boards: { ok: boolean }[] }).boards[0].ok).toBe(true)
  })

  it('readBak returns { ok: false } when no .bak exists', () => {
    writeFileSync(join(dir, 'canvas.json'), JSON.stringify(doc))
    const r = readBak(dir)
    expect(r.ok).toBe(false)
  })
})

const tmp = (): string => mkdtempSync(join(tmpdir(), 'w4-store-'))
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s))

describe('W4 assets pipeline', () => {
  it('writeAsset content-addresses + dedups identical bytes', async () => {
    const dir = tmp()
    try {
      const a = await writeAsset(dir, bytes('hello'), 'png')
      const b = await writeAsset(dir, bytes('hello'), 'png')
      expect(a.assetId).toBe(b.assetId)
      expect(a.assetId).toMatch(/^assets\/[a-f0-9]{40}\.png$/)
      expect(readdirSync(join(dir, 'assets'))).toHaveLength(1)
      expect(existsSync(join(dir, a.assetId))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writeAsset rejects an unsupported ext', async () => {
    const dir = tmp()
    try {
      await expect(writeAsset(dir, bytes('x'), 'exe')).rejects.toThrow(/ext/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readAsset returns bytes, null on missing, null on traversal', async () => {
    const dir = tmp()
    try {
      const { assetId } = await writeAsset(dir, bytes('data'), 'png')
      expect(readAsset(dir, assetId)).toEqual(bytes('data'))
      expect(readAsset(dir, 'assets/' + 'f'.repeat(40) + '.png')).toBeNull()
      expect(readAsset(dir, '../secret')).toBeNull()
      expect(readAsset(dir, 'assets/../../etc/passwd')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('collectAssetIds walks planning image elements across boards', () => {
    const doc = {
      schemaVersion: 4,
      viewport: null,
      boards: [
        {
          id: 'p1',
          type: 'planning',
          elements: [
            { id: 'i1', kind: 'image', assetId: 'assets/a.png' },
            { id: 'n1', kind: 'note', text: '' }
          ]
        },
        { id: 't1', type: 'terminal' },
        {
          id: 'p2',
          type: 'planning',
          elements: [{ id: 'i2', kind: 'image', assetId: 'assets/b.png' }]
        }
      ]
    }
    expect(collectAssetIds(doc)).toEqual(new Set(['assets/a.png', 'assets/b.png']))
  })

  it('gcAssets quarantine-moves orphans to .trash, keeps referenced, no-ops on absent assets/', async () => {
    const dir = tmp()
    try {
      const keep = await writeAsset(dir, bytes('keep'), 'png')
      const drop = await writeAsset(dir, bytes('drop'), 'png')
      gcAssets(dir, new Set([keep.assetId]))
      expect(existsSync(join(dir, keep.assetId))).toBe(true)
      // orphan is removed from the live assets dir
      expect(existsSync(join(dir, drop.assetId))).toBe(false)
      // orphan is recoverable in the quarantine
      const dropFile = drop.assetId.split('/')[1] // 'assets/<sha1>.png' → '<sha1>.png'
      expect(existsSync(join(dir, 'assets', '.trash', dropFile))).toBe(true)
      // no-ops on absent assets/
      const empty = tmp()
      try {
        expect(() => gcAssets(empty, new Set())).not.toThrow()
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gcAssets moves an orphan to assets/.trash, keeps referenced, never hard-deletes', async () => {
    const dir = tmp()
    try {
      const keep = await writeAsset(dir, bytes('keep2'), 'png')
      const orphan = await writeAsset(dir, bytes('orphan'), 'png')
      gcAssets(dir, new Set([keep.assetId]))
      expect(existsSync(join(dir, keep.assetId))).toBe(true) // referenced kept in place
      expect(existsSync(join(dir, orphan.assetId))).toBe(false) // removed from the live assets dir
      const orphanFile = orphan.assetId.split('/')[1] // 'assets/<sha1>.png' → '<sha1>.png'
      expect(existsSync(join(dir, 'assets', '.trash', orphanFile))).toBe(true) // recoverable in quarantine
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gcAssets does not sweep or delete its own .trash dir', () => {
    const dir = tmp()
    try {
      mkdirSync(join(dir, 'assets', '.trash'), { recursive: true })
      expect(() => gcAssets(dir, new Set())).not.toThrow()
      expect(existsSync(join(dir, 'assets', '.trash'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
