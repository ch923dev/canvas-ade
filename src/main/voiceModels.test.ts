/**
 * Voice V2 — model catalog + download pipeline units (mocked fetch; real temp fs).
 * The download contract under test: stream → hash-while-writing → verify sha256 + size →
 * atomic staging-dir swap; ANY failure leaves no staging dir and never touches the final
 * model dir.
 */
import { createHash } from 'crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VOICE_MODEL_ID,
  VOICE_MODEL_CATALOG,
  deleteModel,
  downloadModel,
  getModelSpec,
  modelDir,
  modelPaths,
  modelStatus,
  streamBodyToFile,
  sweepStaging,
  voiceModelsRoot,
  type VoiceModelSpec
} from './voiceModels'

describe('catalog invariants', () => {
  it('has a default model and unique ids', () => {
    expect(getModelSpec(DEFAULT_VOICE_MODEL_ID)).toBeDefined()
    const ids = VOICE_MODEL_CATALOG.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every model carries the four engine roles exactly once, plus the optional VAD (V5)', () => {
    for (const m of VOICE_MODEL_CATALOG) {
      const required = m.files.filter((f) => !f.optional).map((f) => f.role)
      expect(required.sort()).toEqual(['decoder', 'encoder', 'joiner', 'tokens'])
      const optional = m.files.filter((f) => f.optional)
      expect(optional.map((f) => f.role)).toEqual(['vad'])
    }
  })

  it('totalBytes equals the sum of the file sizes; every pin looks like a sha256', () => {
    for (const m of VOICE_MODEL_CATALOG) {
      expect(m.totalBytes).toBe(m.files.reduce((s, f) => s + f.bytes, 0))
      for (const f of m.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
        // Immutable revision-pinned URLs only — a `main` ref could drift under us.
        expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//)
      }
    }
  })

  it('the default is the Kroko model with its CC-BY-SA note (approved 2026-07-02)', () => {
    const def = getModelSpec(DEFAULT_VOICE_MODEL_ID)!
    expect(def.license).toBe('CC-BY-SA-4.0')
    expect(def.licenseNote).toBeTruthy()
  })
})

// ── download / status / delete against a temp root ────────────────────────────────────

/** Tiny synthetic spec so tests don't stream 70 MB. */
const specFile = (
  name: string,
  role: 'encoder' | 'decoder' | 'joiner' | 'tokens' | 'vad',
  body: string,
  optional?: boolean
) => ({
  name,
  role,
  url: `https://models.test/${name}`,
  sha256: createHash('sha256').update(body).digest('hex'),
  bytes: Buffer.byteLength(body),
  ...(optional ? { optional } : null)
})

const BODIES: Record<string, string> = {
  'enc.onnx': 'encoder-bytes',
  'dec.onnx': 'decoder-bytes',
  'join.onnx': 'joiner-bytes',
  'tokens.txt': '<blk> 0\n',
  'vad.onnx': 'vad-bytes'
}

const TEST_SPEC: VoiceModelSpec = {
  id: 'test-model',
  label: 'Test',
  language: 'en',
  license: 'Apache-2.0',
  totalBytes: Object.values(BODIES).reduce((s, b) => s + Buffer.byteLength(b), 0),
  files: [
    specFile('enc.onnx', 'encoder', BODIES['enc.onnx']),
    specFile('dec.onnx', 'decoder', BODIES['dec.onnx']),
    specFile('join.onnx', 'joiner', BODIES['join.onnx']),
    specFile('tokens.txt', 'tokens', BODIES['tokens.txt']),
    specFile('vad.onnx', 'vad', BODIES['vad.onnx'], true)
  ]
}

const fakeFetch = (overrides: Record<string, string | number> = {}): typeof fetch =>
  vi.fn(async (url: unknown) => {
    const name = String(url).split('/').pop()!
    const override = overrides[name]
    if (typeof override === 'number') {
      return { ok: false, status: override, body: null } as unknown as Response
    }
    const body = typeof override === 'string' ? override : BODIES[name]
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        // Two chunks so the hash/progress paths see streaming, not a single write.
        const buf = Buffer.from(body)
        yield new Uint8Array(buf.subarray(0, Math.ceil(buf.length / 2)))
        yield new Uint8Array(buf.subarray(Math.ceil(buf.length / 2)))
      })()
    } as unknown as Response
  }) as unknown as typeof fetch

let userData: string

// Scoped to the fs-touching suites below — the catalog-invariant tests above must see
// the REAL catalog only.
const useSyntheticModel = (): void => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'voice-models-test-'))
    // Register the synthetic spec by mutating the catalog for the test lifetime.
    VOICE_MODEL_CATALOG.push(TEST_SPEC)
  })
  afterEach(() => {
    VOICE_MODEL_CATALOG.splice(VOICE_MODEL_CATALOG.indexOf(TEST_SPEC), 1)
    rmSync(userData, { recursive: true, force: true })
  })
}

describe('downloadModel', () => {
  useSyntheticModel()
  it('streams, verifies, and lands the model dir atomically (no staging residue)', async () => {
    const progress: number[] = []
    await downloadModel(userData, 'test-model', {
      fetchImpl: fakeFetch(),
      onProgress: (p) => progress.push(p.receivedBytes)
    })
    expect(await modelStatus(userData, 'test-model')).toBe('ready')
    expect(readdirSync(voiceModelsRoot(userData)).filter((e) => e.startsWith('.staging'))).toEqual(
      []
    )
    // Progress is monotonic and ends at the manifest total.
    expect(progress.at(-1)).toBe(TEST_SPEC.totalBytes)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
  })

  it('rejects on hash mismatch and leaves neither staging nor model dir', async () => {
    await expect(
      downloadModel(userData, 'test-model', {
        fetchImpl: fakeFetch({ 'dec.onnx': 'tampered-bytes!' })
      })
    ).rejects.toThrow(/integrity failure: dec\.onnx/)
    expect(existsSync(modelDir(userData, 'test-model'))).toBe(false)
    expect(existsSync(join(voiceModelsRoot(userData), '.staging-test-model'))).toBe(false)
  })

  it('rejects on HTTP failure with cleanup', async () => {
    await expect(
      downloadModel(userData, 'test-model', { fetchImpl: fakeFetch({ 'enc.onnx': 503 }) })
    ).rejects.toThrow(/HTTP 503/)
    expect(existsSync(join(voiceModelsRoot(userData), '.staging-test-model'))).toBe(false)
  })

  it('replaces a corrupt existing install on re-download', async () => {
    const dir = modelDir(userData, 'test-model')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'enc.onnx'), 'stale-junk')
    await downloadModel(userData, 'test-model', { fetchImpl: fakeFetch() })
    expect(await modelStatus(userData, 'test-model')).toBe('ready')
  })

  it('throws on an unknown model id', async () => {
    await expect(downloadModel(userData, 'nope', { fetchImpl: fakeFetch() })).rejects.toThrow(
      /unknown/
    )
  })
})

describe('modelStatus / modelPaths / deleteModel / sweepStaging', () => {
  useSyntheticModel()

  it('status is absent for missing dir, wrong size, and unknown id', async () => {
    expect(await modelStatus(userData, 'test-model')).toBe('absent')
    const dir = modelDir(userData, 'test-model')
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(BODIES)) writeFileSync(join(dir, name), body)
    expect(await modelStatus(userData, 'test-model')).toBe('ready')
    writeFileSync(join(dir, 'join.onnx'), 'wrong-size-now')
    expect(await modelStatus(userData, 'test-model')).toBe('absent')
    expect(await modelStatus(userData, 'unknown-id')).toBe('absent')
  })

  it('modelPaths maps roles to absolute files; null for unknown id', () => {
    const p = modelPaths(userData, 'test-model')!
    expect(p.encoder).toBe(join(modelDir(userData, 'test-model'), 'enc.onnx'))
    expect(p.tokens).toBe(join(modelDir(userData, 'test-model'), 'tokens.txt'))
    expect(modelPaths(userData, 'nope')).toBeNull()
  })

  it('the optional VAD never gates readiness and only enters paths when on disk (V5)', async () => {
    const dir = modelDir(userData, 'test-model')
    mkdirSync(dir, { recursive: true })
    // A pre-V5 install: all four required files, no vad.onnx.
    for (const [name, body] of Object.entries(BODIES)) {
      if (name !== 'vad.onnx') writeFileSync(join(dir, name), body)
    }
    expect(await modelStatus(userData, 'test-model')).toBe('ready')
    expect(modelPaths(userData, 'test-model')!.vad).toBeUndefined()
    // A fresh V5 download carries it → the path appears.
    writeFileSync(join(dir, 'vad.onnx'), BODIES['vad.onnx'])
    expect(modelPaths(userData, 'test-model')!.vad).toBe(join(dir, 'vad.onnx'))
  })

  it('a fresh download fetches the optional VAD file too', async () => {
    await downloadModel(userData, 'test-model', { fetchImpl: fakeFetch() })
    expect(existsSync(join(modelDir(userData, 'test-model'), 'vad.onnx'))).toBe(true)
    expect(modelPaths(userData, 'test-model')!.vad).toBeDefined()
  })

  it('deleteModel removes the install; sweepStaging clears only .staging-* leftovers', async () => {
    await downloadModel(userData, 'test-model', { fetchImpl: fakeFetch() })
    await deleteModel(userData, 'test-model')
    expect(await modelStatus(userData, 'test-model')).toBe('absent')

    const root = voiceModelsRoot(userData)
    mkdirSync(join(root, '.staging-crashed'), { recursive: true })
    mkdirSync(join(root, 'kept-model'), { recursive: true })
    await sweepStaging(userData)
    expect(existsSync(join(root, '.staging-crashed'))).toBe(false)
    expect(existsSync(join(root, 'kept-model'))).toBe(true)
  })
})

// ── streamBodyToFile (TTS-1 regression: write-side 'error' must reject, never crash) ───

describe('streamBodyToFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'voice-stream-test-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const body = (...chunks: string[]): AsyncIterable<Uint8Array> =>
    (async function* () {
      for (const c of chunks) yield new Uint8Array(Buffer.from(c))
    })()

  it('streams chunks to the file and reports each to onChunk', async () => {
    const seen: number[] = []
    await streamBodyToFile(body('hello ', 'world'), join(dir, 'out.bin'), (c) =>
      seen.push(c.byteLength)
    )
    expect(readFileSync(join(dir, 'out.bin'), 'utf8')).toBe('hello world')
    expect(seen).toEqual([6, 5])
  })

  it("REJECTS on a write-stream 'error' (ENOSPC/EPERM class) instead of an unhandled emission", async () => {
    // A dest whose parent is a regular FILE makes the async open fail — the same
    // listenerless 'error' emission that previously escaped to uncaughtException
    // (crashShutdown) mid-download.
    writeFileSync(join(dir, 'blocker'), 'i am a file')
    await expect(
      streamBodyToFile(body('data-that-never-lands'), join(dir, 'blocker', 'out.bin'), () => {})
    ).rejects.toThrow()
  })
})
