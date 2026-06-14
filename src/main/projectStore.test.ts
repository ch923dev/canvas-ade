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
  gcAssets,
  SCHEMA_VERSION as MAIN_SCHEMA_VERSION,
  MIN_READER_VERSION as MAIN_MIN_READER_VERSION
} from './projectStore'
// BUG-014: cross-import the AUTHORITATIVE renderer constants from the dependency-free version module
// (boardSchemaVersion, which boardSchema re-exports) so this main-side test doesn't drag boardSchema's
// DOM-bound deps (terminalFont -> window) into the node tsconfig. This test never ships, so the
// renderer->main import is fine; see llmModels.lockstep.test.ts for the same pattern. Assert the
// on-disk fresh-doc fields + MAIN's mirror equal them, so a one-sided bump fails.
import {
  SCHEMA_VERSION as RENDERER_SCHEMA_VERSION,
  MIN_READER_VERSION as RENDERER_MIN_READER_VERSION
} from '../renderer/src/lib/boardSchemaVersion'

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
    // BUG-024/BUG-014: fresh doc uses the authoritative renderer SCHEMA_VERSION/
    // MIN_READER_VERSION + connectors field, not the old hardcoded 2 (and not a literal that
    // can drift — these read from boardSchema so a one-sided MAIN bump fails this assertion).
    const r = readProject(dir)
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.doc).toEqual({
        schemaVersion: RENDERER_SCHEMA_VERSION,
        minReaderVersion: RENDERER_MIN_READER_VERSION,
        viewport: null,
        boards: [],
        connectors: []
      })
  })

  // BUG-024/BUG-014: createProject must stamp a fresh canvas.json with the CURRENT schema
  // version so external tooling (MCP, user scripts) and the backup never see a stale/old
  // version marker on disk. The drift guard asserts the on-disk values against the
  // AUTHORITATIVE renderer constants (boardSchema), not literals — a hardcoded literal here
  // cannot detect the lock-step drift that shipped MAIN at 9 while the renderer moved to 10.
  it('BUG-014: createProject writes schemaVersion/minReaderVersion equal to boardSchema (no drift)', async () => {
    const r = await createProject(dir, 'My Proj', {})
    expect(r.ok).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(dir, 'canvas.json'), 'utf8'))
    // On-disk writer version must equal the renderer's authoritative SCHEMA_VERSION (10).
    expect(onDisk.schemaVersion).toBe(RENDERER_SCHEMA_VERSION)
    // ADR 0007: fresh docs also carry the compat floor, lock-stepped with
    // boardSchema.MIN_READER_VERSION (still 9 — v10 is additive).
    expect(onDisk.minReaderVersion).toBe(RENDERER_MIN_READER_VERSION)
    // The fresh doc must also carry the connectors field added at v4->v5 migration.
    expect(onDisk).toHaveProperty('connectors')
  })

  // BUG-013/BUG-014: MAIN's duplicated SCHEMA_VERSION/MIN_READER_VERSION must stay in
  // lock-step with the renderer's boardSchema source of truth. This asserts the constants
  // themselves (not just the on-disk value), so a future ONE-SIDED bump on either side fails
  // here — the mirror llmModels.lockstep.test.ts uses for DEFAULT_MODELS.
  it('BUG-013: MAIN projectStore versions are lock-stepped with renderer boardSchema', () => {
    expect(MAIN_SCHEMA_VERSION).toBe(RENDERER_SCHEMA_VERSION)
    expect(MAIN_MIN_READER_VERSION).toBe(RENDERER_MIN_READER_VERSION)
  })

  // BUG-042: createProject on a folder where BOTH canvas.json and .bak are unparseable
  // (the natural retry-after-"Could not open project" flow) must rename the corrupt
  // files aside — their bytes are often hand-recoverable — instead of silently
  // overwriting the primary with a fresh empty doc.
  it('BUG-042: createProject renames unparseable canvas.json/.bak aside instead of destroying their bytes', async () => {
    writeFileSync(join(dir, 'canvas.json'), '{ truncated-by-sync-tool')
    writeFileSync(join(dir, 'canvas.json.bak'), 'garbled')
    const r = await createProject(dir, 'p', {})
    expect(r.ok).toBe(true)
    // A fresh doc was written through the guarded path.
    const onDisk = JSON.parse(readFileSync(join(dir, 'canvas.json'), 'utf8'))
    expect(onDisk.boards).toEqual([])
    // The corrupt bytes survive in rename-aside siblings, byte-identical.
    const files = readdirSync(dir)
    const primaryAside = files.find((f) => /^canvas\.json\.corrupt-\d+$/.test(f))
    const bakAside = files.find((f) => /^canvas\.json\.bak\.corrupt-\d+$/.test(f))
    expect(primaryAside).toBeDefined()
    expect(bakAside).toBeDefined()
    expect(readFileSync(join(dir, primaryAside!), 'utf8')).toBe('{ truncated-by-sync-tool')
    expect(readFileSync(join(dir, bakAside!), 'utf8')).toBe('garbled')
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

  // BUG-007: writeProject must make the NEW primary durable BEFORE rotating the prior
  // primary into .bak. The pre-fix order (rotate first) destroyed the last-good .bak in
  // the T5 recovery flow — the prior primary is envelope-valid but deep-corrupt there,
  // so a crash/write-failure between the rotation and the primary write left BOTH files
  // corrupt: total on-disk project loss.
  it('BUG-007: a failed primary write never clobbers the last-good .bak (first save after T5 recovery)', async () => {
    const corrupt = JSON.stringify({ schemaVersion: 8, viewport: null, boards: [{ id: 123 }] })
    const good = JSON.stringify({ schemaVersion: 8, viewport: null, boards: [{ ok: true }] })
    writeFileSync(join(dir, 'canvas.json'), corrupt) // envelope-valid, deep-corrupt
    writeFileSync(join(dir, 'canvas.json.bak'), good) // the only good snapshot
    // Envelope-valid doc whose serialization throws (circular ref) — the primary write
    // fails at exactly the point that sat AFTER the pre-fix rotation.
    const evil: Record<string, unknown> = { schemaVersion: 8, viewport: null, boards: [] }
    evil.self = evil
    await expect(writeProject(dir, evil)).rejects.toThrow()
    // Pre-fix the .bak now held the deep-corrupt primary; it must stay the good snapshot.
    expect(readFileSync(join(dir, 'canvas.json.bak'), 'utf8')).toBe(good)
    expect(readFileSync(join(dir, 'canvas.json'), 'utf8')).toBe(corrupt)
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

  it('writeAsset accepts backdrop video exts (webm/mp4 — renderer accept-list parity)', async () => {
    const dir = tmp()
    try {
      const webm = await writeAsset(dir, bytes('vid-webm'), 'webm')
      const mp4 = await writeAsset(dir, bytes('vid-mp4'), 'MP4') // case-normalized
      expect(webm.assetId).toMatch(/^assets\/[a-f0-9]{40}\.webm$/)
      expect(mp4.assetId).toMatch(/^assets\/[a-f0-9]{40}\.mp4$/)
      expect(readAsset(dir, webm.assetId)).toEqual(bytes('vid-webm'))
      expect(readAsset(dir, mp4.assetId)).toEqual(bytes('vid-mp4'))
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

  it('collectAssetIds includes the v9 background wallpaper assetId (image + video)', () => {
    // Regression: gcAssets runs against this set on every project:open. A file
    // wallpaper (image OR webm/mp4 video) lives at the v9 root background.assetId,
    // NOT in any board element — omitting it swept the user's wallpaper to .trash on
    // reopen, then useBackdropMedia read it as missing and reverted to kind:'none'.
    const img = {
      schemaVersion: 9,
      viewport: null,
      boards: [{ id: 'p1', type: 'planning', elements: [] }],
      background: { kind: 'file', assetId: 'assets/wallpaper.png', dim: 0.4, saturation: 1 }
    }
    expect(collectAssetIds(img)).toEqual(new Set(['assets/wallpaper.png']))

    // Video wallpaper, union with a board image element.
    const vid = {
      schemaVersion: 9,
      viewport: null,
      boards: [
        { id: 'p1', type: 'planning', elements: [{ kind: 'image', assetId: 'assets/a.png' }] }
      ],
      background: { kind: 'file', assetId: 'assets/clip.webm' }
    }
    expect(collectAssetIds(vid)).toEqual(new Set(['assets/a.png', 'assets/clip.webm']))

    // A scene/none background carries no assetId — nothing extra collected.
    const scene = {
      schemaVersion: 9,
      viewport: null,
      boards: [],
      background: { kind: 'scene', scene: 'blossom-river' }
    }
    expect(collectAssetIds(scene)).toEqual(new Set())
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

  // BUG-016: gcAssets is called in project:open against the PRIMARY doc's asset ids.
  // If the primary is envelope-valid but deep-corrupt, the renderer triggers T5 recovery
  // (reopenFromBak). But gcAssets already ran and may have quarantined assets that are
  // referenced ONLY by the backup — leaving the recovery path with broken/missing images.
  //
  // The fix: before calling gcAssets, union the backup doc's asset ids with the primary's
  // so any asset referenced by EITHER doc is retained. This test verifies that an asset
  // referenced exclusively by the backup doc is NOT quarantined when gcAssets is called
  // with the combined id set (as the fix will arrange).
  //
  // PRE-FIX CONFIRMATION: calling gcAssets with ONLY the primary asset ids (empty set)
  // quarantines a backup-only asset.
  it('BUG-016 (pre-fix confirmation): gcAssets sweeps a backup-only asset when called with only primary ids', async () => {
    const dir = tmp()
    try {
      // Write an asset referenced only by the backup (not in the deep-corrupt primary).
      const backupOnly = await writeAsset(dir, bytes('backup-only-image'), 'png')
      // Simulate: primary has NO image references (deep-corrupt, boards=[]),
      // so collectAssetIds(primary) = empty set.
      const primaryIds = new Set<string>() // empty — the corrupt primary has no images
      gcAssets(dir, primaryIds)
      // Pre-fix: the backup-only asset is quarantined — readAsset can no longer reach it.
      // After the fix this asset must survive (the fix unions backup ids before sweeping).
      expect(existsSync(join(dir, backupOnly.assetId))).toBe(false) // quarantined pre-fix
      const assetFile = backupOnly.assetId.split('/')[1]
      expect(existsSync(join(dir, 'assets', '.trash', assetFile))).toBe(true) // in trash
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // BUG-016 (post-fix verification): gcAssets called with UNION of primary + backup ids
  // must retain assets referenced by the backup, even when absent from the primary.
  it('BUG-016 (fix): gcAssets with union of primary+backup ids does not quarantine backup-only assets', async () => {
    const dir = tmp()
    try {
      const backupOnly = await writeAsset(dir, bytes('backup-only-image-2'), 'png')
      const primaryOnly = await writeAsset(dir, bytes('primary-only-image'), 'png')
      // Union: protect both primary AND backup assets.
      const unionIds = new Set<string>([backupOnly.assetId, primaryOnly.assetId])
      gcAssets(dir, unionIds)
      // Both assets must survive when the union is used.
      expect(existsSync(join(dir, backupOnly.assetId))).toBe(true)
      expect(existsSync(join(dir, primaryOnly.assetId))).toBe(true)
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
