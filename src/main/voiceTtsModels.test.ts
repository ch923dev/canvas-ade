/**
 * Jarvis J1 — TTS catalog + component download pipeline units (mocked fetch; real temp fs).
 * Contract under test beyond the STT suite (voiceModels.test.ts): the COMPONENT layout —
 * shared 'espeak' installs once, nested manifest paths land verbatim, per-component atomic
 * swap lets retries resume, and delete never strands/steals a shared component.
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TTS_MODEL_ID,
  TTS_COMPONENTS,
  TTS_MODEL_CATALOG,
  deleteTtsModel,
  downloadTtsModel,
  getTtsModelSpec,
  ttsComponentDir,
  ttsComponentStatus,
  ttsModelPaths,
  ttsModelStatus,
  type TtsModelSpec
} from './voiceTtsModels'
import { voiceModelsRoot } from './voiceModels'

describe('catalog invariants (the real generated manifest)', () => {
  it('has a default model and unique ids', () => {
    expect(getTtsModelSpec(DEFAULT_TTS_MODEL_ID)).toBeDefined()
    const ids = TTS_MODEL_CATALOG.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every model = the shared espeak component + exactly one engine component', () => {
    for (const m of TTS_MODEL_CATALOG) {
      expect(m.components).toContain('espeak')
      const engine = m.components.filter((k) => k !== 'espeak')
      expect(engine).toHaveLength(1)
      expect(TTS_COMPONENTS[engine[0]]).toBeDefined()
    }
  })

  it('components carry valid pins: sha256 shape, positive sizes, revision-pinned baseUrl', () => {
    for (const [key, c] of Object.entries(TTS_COMPONENTS)) {
      // Immutable revision-pinned URLs only — a `main` ref could drift under us.
      expect(c.baseUrl, key).toMatch(/\/resolve\/[0-9a-f]{40}$/)
      expect(c.totalBytes).toBe(c.files.reduce((s, f) => s + f.bytes, 0))
      for (const f of c.files) {
        expect(f.sha256, `${key}:${f.path}`).toMatch(/^[0-9a-f]{64}$/)
        expect(f.bytes, `${key}:${f.path}`).toBeGreaterThan(0)
      }
    }
  })

  it('model totalBytes = sum of its components; engine components have .onnx + tokens', () => {
    for (const m of TTS_MODEL_CATALOG) {
      expect(m.totalBytes).toBe(m.components.reduce((s, k) => s + TTS_COMPONENTS[k].totalBytes, 0))
      const engine = TTS_COMPONENTS[m.components.find((k) => k !== 'espeak')!]
      expect(engine.files.some((f) => f.path.endsWith('.onnx'))).toBe(true)
      expect(engine.files.some((f) => f.path === 'tokens.txt')).toBe(true)
    }
  })

  it('espeak files all live under espeak-ng-data/ (the sherpa dataDir shape)', () => {
    for (const f of TTS_COMPONENTS.espeak.files) {
      expect(f.path).toMatch(/^espeak-ng-data\//)
    }
  })

  it('the Kokoro default carries voices.bin and the af_sky persona sid (D2/PLAN §3.5)', () => {
    const def = getTtsModelSpec(DEFAULT_TTS_MODEL_ID)!
    expect(def.engine).toBe('kokoro')
    expect(def.defaultSid).toBe(4)
    expect(TTS_COMPONENTS.kokoro.files.some((f) => f.path === 'voices.bin')).toBe(true)
    expect(ttsModelPaths('/x', DEFAULT_TTS_MODEL_ID)?.voices).toBeTruthy()
  })
})

// ── download / status / delete against a temp root (synthetic components) ─────────────

const bodyOf = (path: string): string => `content-of-${path}`
const compFile = (path: string) => ({
  path,
  sha256: createHash('sha256').update(bodyOf(path)).digest('hex'),
  bytes: Buffer.byteLength(bodyOf(path))
})

/** Shared component with a NESTED path (the espeak shape) + two engine components. */
const SHARED_FILES = [compFile('espeak-ng-data/en_dict'), compFile('espeak-ng-data/lang/gmw/en')]
const ENGINE_A_FILES = [compFile('a-model.onnx'), compFile('tokens.txt')]
const ENGINE_B_FILES = [compFile('b-model.onnx'), compFile('tokens.txt'), compFile('voices.bin')]

const component = (files: ReturnType<typeof compFile>[]) => ({
  baseUrl: 'https://models.test/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  totalBytes: files.reduce((s, f) => s + f.bytes, 0),
  files
})

const MODEL_A: TtsModelSpec = {
  id: 'test-a',
  label: 'Test A',
  engine: 'vits',
  language: 'en',
  license: 'MIT',
  components: ['test-shared', 'test-a-engine'],
  totalBytes: 0,
  defaultSid: 0
}
const MODEL_B: TtsModelSpec = {
  id: 'test-b',
  label: 'Test B',
  engine: 'kokoro',
  language: 'en',
  license: 'Apache-2.0',
  components: ['test-shared', 'test-b-engine'],
  totalBytes: 0,
  defaultSid: 4
}

const fakeFetch = (overrides: Record<string, string | number> = {}): typeof fetch =>
  vi.fn(async (url: unknown) => {
    const path = String(url).split('/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/')[1]
    const override = overrides[path]
    if (typeof override === 'number') {
      return { ok: false, status: override, body: null } as unknown as Response
    }
    const body = typeof override === 'string' ? override : bodyOf(path)
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
// the REAL catalog only (mirrors the STT suite's useSyntheticModel discipline).
const useSyntheticComponents = (): void => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'voice-tts-models-test-'))
    TTS_COMPONENTS['test-shared'] = component(SHARED_FILES)
    TTS_COMPONENTS['test-a-engine'] = component(ENGINE_A_FILES)
    TTS_COMPONENTS['test-b-engine'] = component(ENGINE_B_FILES)
    TTS_MODEL_CATALOG.push(MODEL_A, MODEL_B)
  })
  afterEach(() => {
    TTS_MODEL_CATALOG.splice(TTS_MODEL_CATALOG.indexOf(MODEL_A), 1)
    TTS_MODEL_CATALOG.splice(TTS_MODEL_CATALOG.indexOf(MODEL_B), 1)
    delete TTS_COMPONENTS['test-shared']
    delete TTS_COMPONENTS['test-a-engine']
    delete TTS_COMPONENTS['test-b-engine']
    rmSync(userData, { recursive: true, force: true })
  })
}

/** Install a component directly on disk (bypassing download) at its pinned sizes. */
const installComponent = (key: string): void => {
  const dir = ttsComponentDir(userData, key)
  for (const f of TTS_COMPONENTS[key].files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true })
    writeFileSync(join(dir, f.path), bodyOf(f.path))
  }
}

describe('downloadTtsModel', () => {
  useSyntheticComponents()

  it('streams, verifies, and lands components atomically — nested paths verbatim', async () => {
    const progress: number[] = []
    await downloadTtsModel(userData, 'test-a', {
      fetchImpl: fakeFetch(),
      onProgress: (p) => progress.push(p.receivedBytes)
    })
    expect(await ttsModelStatus(userData, 'test-a')).toBe('ready')
    expect(
      existsSync(join(ttsComponentDir(userData, 'test-shared'), 'espeak-ng-data/lang/gmw/en'))
    ).toBe(true)
    expect(readdirSync(voiceModelsRoot(userData)).filter((e) => e.startsWith('.staging'))).toEqual(
      []
    )
    // Progress is monotonic and ends at the pending-components total.
    const total =
      TTS_COMPONENTS['test-shared'].totalBytes + TTS_COMPONENTS['test-a-engine'].totalBytes
    expect(progress.at(-1)).toBe(total)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
  })

  it('skips an already-installed shared component (the second-engine install)', async () => {
    await downloadTtsModel(userData, 'test-a', { fetchImpl: fakeFetch() })
    const fetchB = fakeFetch()
    await downloadTtsModel(userData, 'test-b', { fetchImpl: fetchB })
    expect(await ttsModelStatus(userData, 'test-b')).toBe('ready')
    // Only the B engine files were fetched — espeak was shared.
    const urls = (fetchB as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(urls).toHaveLength(ENGINE_B_FILES.length)
    expect(urls.every((u) => !u.includes('espeak-ng-data'))).toBe(true)
  })

  it('rejects on hash mismatch, cleans staging, keeps already-landed components (resume)', async () => {
    await expect(
      downloadTtsModel(userData, 'test-a', {
        fetchImpl: fakeFetch({ 'a-model.onnx': 'tampered-bytes!' })
      })
    ).rejects.toThrow(/integrity failure: a-model\.onnx/)
    expect(existsSync(join(voiceModelsRoot(userData), '.staging-tts-test-a-engine'))).toBe(false)
    expect(existsSync(ttsComponentDir(userData, 'test-a-engine'))).toBe(false)
    // The shared component downloaded FIRST stays — the retry resumes past it.
    expect(await ttsComponentStatus(userData, 'test-shared')).toBe('ready')
    await downloadTtsModel(userData, 'test-a', { fetchImpl: fakeFetch() })
    expect(await ttsModelStatus(userData, 'test-a')).toBe('ready')
  })

  it('rejects on HTTP failure with cleanup', async () => {
    await expect(
      downloadTtsModel(userData, 'test-a', {
        fetchImpl: fakeFetch({ 'espeak-ng-data/en_dict': 503 })
      })
    ).rejects.toThrow(/HTTP 503/)
    expect(readdirSync(voiceModelsRoot(userData)).filter((e) => e.startsWith('.staging'))).toEqual(
      []
    )
  })

  it('throws on an unknown model id', async () => {
    await expect(downloadTtsModel(userData, 'nope', { fetchImpl: fakeFetch() })).rejects.toThrow(
      /unknown/
    )
  })
})

describe('ttsModelStatus / ttsModelPaths / deleteTtsModel', () => {
  useSyntheticComponents()

  it('status is absent for missing component, wrong size, and unknown id', async () => {
    expect(await ttsModelStatus(userData, 'test-a')).toBe('absent')
    installComponent('test-shared')
    expect(await ttsModelStatus(userData, 'test-a')).toBe('absent') // engine still missing
    installComponent('test-a-engine')
    expect(await ttsModelStatus(userData, 'test-a')).toBe('ready')
    writeFileSync(join(ttsComponentDir(userData, 'test-a-engine'), 'tokens.txt'), 'wrong-size!')
    expect(await ttsModelStatus(userData, 'test-a')).toBe('absent')
    expect(await ttsModelStatus(userData, 'unknown-id')).toBe('absent')
  })

  it('paths map engine files + the shared dataDir; voices only when the manifest has it', () => {
    const a = ttsModelPaths(userData, 'test-a')!
    expect(a.engine).toBe('vits')
    expect(a.model).toBe(join(ttsComponentDir(userData, 'test-a-engine'), 'a-model.onnx'))
    expect(a.tokens).toBe(join(ttsComponentDir(userData, 'test-a-engine'), 'tokens.txt'))
    expect(a.dataDir).toBe(join(ttsComponentDir(userData, 'test-shared'), 'espeak-ng-data'))
    expect(a.voices).toBeUndefined()
    const b = ttsModelPaths(userData, 'test-b')!
    expect(b.voices).toBe(join(ttsComponentDir(userData, 'test-b-engine'), 'voices.bin'))
    expect(ttsModelPaths(userData, 'nope')).toBeNull()
  })

  it('delete keeps the shared component while the other engine is installed, then removes it', async () => {
    await downloadTtsModel(userData, 'test-a', { fetchImpl: fakeFetch() })
    await downloadTtsModel(userData, 'test-b', { fetchImpl: fakeFetch() })
    await deleteTtsModel(userData, 'test-a')
    expect(await ttsModelStatus(userData, 'test-a')).toBe('absent')
    expect(await ttsModelStatus(userData, 'test-b')).toBe('ready') // espeak survived
    await deleteTtsModel(userData, 'test-b')
    expect(await ttsComponentStatus(userData, 'test-shared')).toBe('absent')
    expect(existsSync(ttsComponentDir(userData, 'test-shared'))).toBe(false)
  })
})
