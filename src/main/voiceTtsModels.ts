/**
 * Jarvis J1 — TTS model catalog + download/verify/delete (MAIN side; PLAN §J1, decision D2).
 *
 * Same integrity design as the STT catalog (voiceModels.ts): models are NEVER bundled;
 * every file carries an immutable HF revision URL + sha256 + byte size; downloads stream
 * into a `.staging-*` dir (hash-while-writing) and land via atomic rename. The pinned
 * per-file manifest lives in `voiceTtsManifest.json` (GENERATED — see
 * scripts/gen-tts-manifest.mjs) because TTS needs `espeak-ng-data/` (~355 small files):
 * hand-authoring the STT way doesn't scale.
 *
 * COMPONENT layout instead of the STT per-model dir: both engines need a byte-identical
 * `espeak-ng-data/` (18 MB, cross-checked at manifest authoring time), so it installs ONCE
 * as a shared component. A TTS model = its engine component + the shared 'espeak'
 * component; dirs are `voice-models/tts-<component>/`. Consequences:
 *   - installing the second engine skips espeak (already ready);
 *   - each component swaps into place atomically ON ITS OWN — a failure mid-Kokoro
 *     (345 MB) keeps an already-landed espeak, and the retry resumes past it;
 *   - delete removes a shared component only when no other installed model needs it.
 *
 * Licenses (D2, spike-verified 2026-07-10): Kokoro v0.19 Apache-2.0; Piper MIT (voice
 * trained on the Blizzard 2013 Lessac corpus — see the voice MODEL_CARD); espeak-ng data
 * GPL-3.0 (downloaded from the published sherpa-onnx mirrors, never redistributed).
 */
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { mkdir, rename, rm, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { streamBodyToFile, voiceModelsRoot, type DownloadDeps } from './voiceModels'
import ttsManifest from './voiceTtsManifest.json'

export interface TtsComponentFile {
  /** Repo-relative path — MAY be nested (`espeak-ng-data/lang/gmw/en`); kept verbatim on disk. */
  path: string
  sha256: string
  bytes: number
}

export interface TtsComponent {
  /** Immutable revision-pinned base (`…/resolve/<commit>`); file URL = `<baseUrl>/<path>`. */
  baseUrl: string
  totalBytes: number
  files: TtsComponentFile[]
}

/** Component registry (string-keyed so tests can register synthetic components). */
export const TTS_COMPONENTS: Record<string, TtsComponent> = {
  espeak: ttsManifest.espeak,
  kokoro: ttsManifest.kokoro,
  piper: ttsManifest.piper
}

/** The two D2 engines. 'vits' is sherpa's config key for Piper voices. */
export type TtsEngineKind = 'kokoro' | 'vits'

export interface TtsModelSpec {
  id: string
  label: string
  engine: TtsEngineKind
  language: string
  license: string
  /** Shown beside the model in Settings when present (mirrors the STT Kroko note). */
  licenseNote?: string
  /** Registry keys, download order. 'espeak' is the shared cross-engine component. */
  components: string[]
  /** Full install size; an install that reuses an already-shared component pays less. */
  totalBytes: number
  /** Default speaker id for synth calls (Kokoro sid 4 = af_sky, the PLAN §3.5 persona). */
  defaultSid: number
}

const componentsTotal = (keys: string[]): number =>
  keys.reduce((s, k) => s + TTS_COMPONENTS[k].totalBytes, 0)

/**
 * D2 catalog: Kokoro fp32 = the quality voice (needs 4 threads for sub-second first
 * audio — spike 2026-07-10; NEVER int8 on CPU, it's SLOWER than fp32); Piper medium = the
 * fast/low-end fallback (~10× realtime). Thread counts live with the engine config in
 * voiceEngineHost.buildTtsConfig, mirroring the STT split.
 */
export const TTS_MODEL_CATALOG: TtsModelSpec[] = [
  {
    id: 'kokoro-en-v0_19',
    label: 'Kokoro EN (quality)',
    engine: 'kokoro',
    language: 'en',
    license: 'Apache-2.0',
    licenseNote:
      'Kokoro-82M v0.19 (Apache-2.0), sherpa-onnx export. Requires the shared espeak-ng ' +
      'data files (GPL-3.0), downloaded from the published mirror.',
    components: ['espeak', 'kokoro'],
    totalBytes: componentsTotal(['espeak', 'kokoro']),
    defaultSid: 4
  },
  {
    id: 'piper-en_US-lessac-medium',
    label: 'Piper EN Lessac (fast)',
    engine: 'vits',
    language: 'en',
    license: 'MIT',
    licenseNote:
      'Piper (MIT) lessac-medium voice, trained on the Blizzard 2013 Lessac corpus (see ' +
      'the voice MODEL_CARD). Requires the shared espeak-ng data files (GPL-3.0).',
    components: ['espeak', 'piper'],
    totalBytes: componentsTotal(['espeak', 'piper']),
    defaultSid: 0
  }
]

export const DEFAULT_TTS_MODEL_ID = TTS_MODEL_CATALOG[0].id

export function getTtsModelSpec(id: string): TtsModelSpec | undefined {
  return TTS_MODEL_CATALOG.find((m) => m.id === id)
}

/** Component install dir, under the SAME root as the STT models (shares sweepStaging). */
export function ttsComponentDir(userData: string, key: string): string {
  return join(voiceModelsRoot(userData), `tts-${key}`)
}

export type TtsModelStatus = 'ready' | 'absent'

/**
 * 'ready' = every manifest file present at its exact pinned byte size (hashes are checked
 * at download time only — same trade-off as the STT catalog; the staging-dir swap means a
 * partial download never lands here).
 */
export async function ttsComponentStatus(userData: string, key: string): Promise<TtsModelStatus> {
  const comp = TTS_COMPONENTS[key]
  if (!comp) return 'absent'
  const dir = ttsComponentDir(userData, key)
  for (const f of comp.files) {
    try {
      const s = await stat(join(dir, f.path))
      if (s.size !== f.bytes) return 'absent'
    } catch {
      return 'absent'
    }
  }
  return 'ready'
}

export async function ttsModelStatus(userData: string, id: string): Promise<TtsModelStatus> {
  const spec = getTtsModelSpec(id)
  if (!spec) return 'absent'
  for (const key of spec.components) {
    if ((await ttsComponentStatus(userData, key)) === 'absent') return 'absent'
  }
  return 'ready'
}

/**
 * Full sha256 re-verify of a LANDED component (readiness itself stays size-only — this is
 * the explicit-download repair probe, not the per-session check). False = at least one
 * file's content diverged from its pin (size-preserving corruption) or is unreadable.
 */
export async function ttsComponentHashesOk(userData: string, key: string): Promise<boolean> {
  const comp = TTS_COMPONENTS[key]
  if (!comp) return false
  const dir = ttsComponentDir(userData, key)
  for (const f of comp.files) {
    const hash = createHash('sha256')
    try {
      for await (const chunk of createReadStream(join(dir, f.path))) {
        hash.update(chunk as Uint8Array)
      }
    } catch {
      return false
    }
    if (hash.digest('hex') !== f.sha256) return false
  }
  return true
}

/** Absolute paths the engine host needs to build an OfflineTts (voiceEngineHost). */
export interface TtsModelPaths {
  engine: TtsEngineKind
  model: string
  tokens: string
  /** The shared espeak-ng-data dir (sherpa `dataDir`). */
  dataDir: string
  /** Kokoro only — its speaker-embedding bank. */
  voices?: string
}

export function ttsModelPaths(userData: string, id: string): TtsModelPaths | null {
  const spec = getTtsModelSpec(id)
  if (!spec) return null
  // The engine component is the one carrying the .onnx graph; shared data components
  // (espeak) never do.
  const engineKey = spec.components.find((k) =>
    TTS_COMPONENTS[k]?.files.some((f) => f.path.endsWith('.onnx'))
  )
  const comp = engineKey ? TTS_COMPONENTS[engineKey] : undefined
  const dataKey = spec.components.find((k) => k !== engineKey)
  if (!engineKey || !comp || !dataKey) return null
  const dir = ttsComponentDir(userData, engineKey)
  const byName = (pred: (p: string) => boolean): string | undefined =>
    comp.files.find((f) => pred(f.path))?.path
  const model = byName((p) => p.endsWith('.onnx'))
  const tokens = byName((p) => p === 'tokens.txt')
  if (!model || !tokens) return null
  const voices = byName((p) => p === 'voices.bin')
  return {
    engine: spec.engine,
    model: join(dir, model),
    tokens: join(dir, tokens),
    dataDir: join(ttsComponentDir(userData, dataKey), 'espeak-ng-data'),
    ...(voices ? { voices: join(dir, voices) } : null)
  }
}

/**
 * Download every NOT-yet-ready component of the model (a shared component installed by the
 * other engine is skipped — and so is a component surviving from a failed earlier run,
 * which is what makes retries resume). Per component: stream into `.staging-tts-<key>/`
 * while hashing → verify sha256 + size per file → atomic rename into place. Any failure
 * removes that component's staging dir and rethrows; already-landed components stay.
 *
 * `verifyReady` (the EXPLICIT user download — Settings row): hash-verify landed components
 * and re-fetch any that fail, so Download repairs size-preserving corruption instead of
 * no-op'ing `ok:true` against a permanently broken install (readiness is size-only). The
 * STT catalog needs no equivalent — its re-download always re-fetches everything.
 */
export async function downloadTtsModel(
  userData: string,
  id: string,
  deps: DownloadDeps = {},
  opts: { verifyReady?: boolean } = {}
): Promise<void> {
  const spec = getTtsModelSpec(id)
  if (!spec) throw new Error(`tts model unknown: ${id}`)
  const fetchImpl = deps.fetchImpl ?? fetch
  const pending: string[] = []
  for (const key of spec.components) {
    if ((await ttsComponentStatus(userData, key)) !== 'ready') {
      pending.push(key)
    } else if (opts.verifyReady && !(await ttsComponentHashesOk(userData, key))) {
      pending.push(key)
    }
  }
  const totalBytes = componentsTotal(pending)
  const fileCount = pending.reduce((s, k) => s + TTS_COMPONENTS[k].files.length, 0)
  const root = voiceModelsRoot(userData)
  let received = 0
  let fileIndex = 0
  for (const key of pending) {
    const comp = TTS_COMPONENTS[key]
    const staging = join(root, `.staging-tts-${key}`)
    const finalDir = ttsComponentDir(userData, key)
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      for (const f of comp.files) {
        fileIndex++
        const res = await fetchImpl(`${comp.baseUrl}/${f.path}`)
        if (!res.ok || !res.body) {
          throw new Error(`tts model download failed: ${f.path} → HTTP ${res.status}`)
        }
        // Manifest paths may be nested (espeak-ng-data/lang/…) — create the parent chain.
        const dest = join(staging, f.path)
        await mkdir(dirname(dest), { recursive: true })
        const hash = createHash('sha256')
        let fileBytes = 0
        await streamBodyToFile(res.body as AsyncIterable<Uint8Array>, dest, (chunk) => {
          hash.update(chunk)
          fileBytes += chunk.byteLength
          received += chunk.byteLength
          deps.onProgress?.({
            id,
            receivedBytes: received,
            totalBytes,
            fileIndex,
            fileCount
          })
        })
        const digest = hash.digest('hex')
        if (digest !== f.sha256) {
          throw new Error(`tts model integrity failure: ${f.path} sha256 ${digest} != pinned`)
        }
        if (fileBytes !== f.bytes) {
          throw new Error(`tts model size mismatch: ${f.path} ${fileBytes}B != ${f.bytes}B`)
        }
      }
      await rm(finalDir, { recursive: true, force: true })
      await rename(staging, finalDir)
    } catch (err) {
      await rm(staging, { recursive: true, force: true })
      throw err
    }
  }
}

/**
 * Remove the model's components — EXCEPT any component another still-installed catalog
 * model needs (the shared espeak dir only goes when the last engine that uses it goes).
 * Keep-set is computed BEFORE anything is removed, so the decision can't observe its own
 * partial effects. `inFlightIds` (voiceIpc's live download set) extends the keep-set to
 * components of models still INSTALLING — a not-yet-ready install skips its shared
 * components (already landed), so deleting the sibling mid-flight would otherwise rm a
 * dir the in-flight install completes against and silently strand it 'absent'.
 */
export async function deleteTtsModel(
  userData: string,
  id: string,
  opts: { inFlightIds?: readonly string[] } = {}
): Promise<void> {
  const spec = getTtsModelSpec(id)
  if (!spec) throw new Error(`tts model unknown: ${id}`)
  const keep = new Set<string>()
  for (const other of TTS_MODEL_CATALOG) {
    if (other.id === id) continue
    if (
      opts.inFlightIds?.includes(other.id) ||
      (await ttsModelStatus(userData, other.id)) === 'ready'
    ) {
      for (const k of other.components) keep.add(k)
    }
  }
  for (const key of spec.components) {
    if (!keep.has(key)) {
      await rm(ttsComponentDir(userData, key), { recursive: true, force: true })
    }
  }
}
