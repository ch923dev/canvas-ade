/**
 * Jarvis J5 — KWS installer units. The fixture archive is a python-built tar.bz2 (the
 * reference libbzip2 encoder) whose inner files are pinned exactly like the production
 * manifest. Contract under test: happy-path install (files + generated keywords land,
 * staging gone), pinned-hash failures (archive AND per-file) leave NOTHING on disk,
 * status/paths honesty, delete.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_KWS_MODEL_ID,
  KWS_KEYWORDS_CONTENT,
  KWS_MODEL_CATALOG,
  deleteKwsModel,
  getKwsModelSpec,
  installKwsArchive,
  kwsModelDir,
  kwsModelPaths,
  kwsModelStatus,
  type KwsModelSpec
} from './voiceKwsModels'
import { voiceModelsRoot } from './voiceModels'

const ARCHIVE = readFileSync(join(__dirname, '__fixtures__', 'kws-mini.tar.bz2'))

const MINI_SPEC: KwsModelSpec = {
  id: 'kws-mini',
  label: 'mini',
  language: 'en',
  license: 'Apache-2.0',
  archiveUrl: 'https://example.invalid/kws-mini.tar.bz2',
  archiveSha256: '389c3897cdb3b7723365e8246c6c915f6797fef44699eb661538535886ec6f02',
  archiveBytes: 293,
  files: [
    {
      name: 'encoder.int8.onnx',
      sha256: '71c89a2f280b9c762c3270488047c1879fc5446e6d4ce32554761e513c282d74',
      bytes: 280
    },
    {
      name: 'decoder.int8.onnx',
      sha256: '0546b3354a5766788c46a148b9626068800f1368f07d5efd3675bd1ad88931eb',
      bytes: 70
    },
    {
      name: 'joiner.int8.onnx',
      sha256: '0a2cf9cbc39bd8019ec7215fe987ac69a31a245de761b2cc49f93a63b782b928',
      bytes: 30
    },
    {
      name: 'tokens.txt',
      sha256: '2951835de33689a441bfa61bc7af99b1f0305ca8ec0ab4dd508f14f57b27ca23',
      bytes: 8
    }
  ],
  totalBytes: 293
}

function fakeFetch(body: Buffer, status = 200): typeof fetch {
  return (async () => ({
    ok: status === 200,
    status,
    body: (async function* () {
      // Two chunks so the progress path sees more than one callback.
      const mid = Math.floor(body.length / 2)
      yield new Uint8Array(body.subarray(0, mid))
      yield new Uint8Array(body.subarray(mid))
    })()
  })) as unknown as typeof fetch
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kwsmodels-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('installKwsArchive', () => {
  it('lands the pinned files + the generated keywords file, and clears staging', async () => {
    const progress: number[] = []
    await installKwsArchive(dir, MINI_SPEC, {
      fetchImpl: fakeFetch(ARCHIVE),
      onProgress: (p) => progress.push(p.receivedBytes)
    })
    const out = kwsModelDir(dir, 'kws-mini')
    expect((await readFile(join(out, 'tokens.txt'))).toString()).toBe('a 1\nb 2\n')
    expect((await readFile(join(out, 'encoder.int8.onnx'))).length).toBe(280)
    expect((await readFile(join(out, 'keywords.txt'), 'utf8')).toString()).toBe(
      KWS_KEYWORDS_CONTENT
    )
    // The non-pinned README never lands; no staging residue survives.
    expect(existsSync(join(out, 'README.md'))).toBe(false)
    const residue = (await readdir(voiceModelsRoot(dir))).filter((n) => n.startsWith('.staging'))
    expect(residue).toEqual([])
    expect(progress.at(-1)).toBe(ARCHIVE.length)
  })

  it('a corrupted archive (pinned sha mismatch) throws and leaves NOTHING', async () => {
    const bad = Buffer.from(ARCHIVE)
    bad[bad.length - 5] ^= 0xff
    await expect(installKwsArchive(dir, MINI_SPEC, { fetchImpl: fakeFetch(bad) })).rejects.toThrow(
      /integrity/
    )
    expect(existsSync(kwsModelDir(dir, 'kws-mini'))).toBe(false)
    const residue = (await readdir(voiceModelsRoot(dir))).filter((n) => n.startsWith('.staging'))
    expect(residue).toEqual([])
  })

  it('a per-file pin mismatch throws and leaves NOTHING (mutable-release defense)', async () => {
    const spec: KwsModelSpec = {
      ...MINI_SPEC,
      files: [{ ...MINI_SPEC.files[0], sha256: '0'.repeat(64) }, ...MINI_SPEC.files.slice(1)]
    }
    await expect(installKwsArchive(dir, spec, { fetchImpl: fakeFetch(ARCHIVE) })).rejects.toThrow(
      /file integrity/
    )
    expect(existsSync(kwsModelDir(dir, 'kws-mini'))).toBe(false)
  })

  it('an archive missing a pinned file throws', async () => {
    const spec: KwsModelSpec = {
      ...MINI_SPEC,
      files: [...MINI_SPEC.files, { name: 'absent.onnx', sha256: '0'.repeat(64), bytes: 1 }]
    }
    await expect(installKwsArchive(dir, spec, { fetchImpl: fakeFetch(ARCHIVE) })).rejects.toThrow(
      /missing absent.onnx/
    )
  })

  it('an HTTP failure throws before anything is written', async () => {
    await expect(
      installKwsArchive(dir, MINI_SPEC, { fetchImpl: fakeFetch(ARCHIVE, 503) })
    ).rejects.toThrow(/HTTP 503/)
    expect(existsSync(kwsModelDir(dir, 'kws-mini'))).toBe(false)
  })
})

describe('catalog status / paths / delete', () => {
  it('the production catalog carries the pinned gigaspeech spec', () => {
    const spec = getKwsModelSpec(DEFAULT_KWS_MODEL_ID)
    expect(spec).toBeDefined()
    expect(spec!.archiveUrl).toContain('github.com/k2-fsa/sherpa-onnx/releases')
    expect(spec!.files).toHaveLength(4)
    expect(KWS_MODEL_CATALOG).toHaveLength(1)
  })

  it('status flips absent → ready only when every file AND keywords.txt land', async () => {
    // Synthetic id is not in the catalog — drive status through the real catalog id by
    // materializing its dir shape manually (status is size-exact per pin).
    const spec = getKwsModelSpec(DEFAULT_KWS_MODEL_ID)!
    expect(await kwsModelStatus(dir, spec.id)).toBe('absent')
    const out = kwsModelDir(dir, spec.id)
    await mkdir(out, { recursive: true })
    for (const f of spec.files) await writeFile(join(out, f.name), Buffer.alloc(f.bytes))
    expect(await kwsModelStatus(dir, spec.id)).toBe('absent') // keywords still missing
    await writeFile(join(out, 'keywords.txt'), KWS_KEYWORDS_CONTENT, 'utf8')
    expect(await kwsModelStatus(dir, spec.id)).toBe('ready')

    const paths = kwsModelPaths(dir, spec.id)!
    expect(paths.encoder).toContain('encoder')
    expect(paths.keywords.endsWith('keywords.txt')).toBe(true)

    await deleteKwsModel(dir, spec.id)
    expect(await kwsModelStatus(dir, spec.id)).toBe('absent')
    expect(existsSync(out)).toBe(false)
  })
})
