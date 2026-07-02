/**
 * Voice V2 — model catalog + download/verify/delete (MAIN side; SPEC §4, plan V2).
 *
 * Models are NEVER bundled. The catalog is a pinned per-file manifest — each file carries
 * an immutable revision URL + sha256 + byte size — downloaded into
 * `userData/voice-models/<modelId>/`. Per-FILE download (HuggingFace mirror, pinned to a
 * revision commit) instead of the GitHub-release `.tar.bz2` archives deliberately: Node
 * has no bzip2, per-file hashes verify integrity without an archive-extraction dep, and
 * the LFS oid IS the published sha256. Download protocol: stream every file into a
 * `.staging-<id>/` dir while hashing → verify hash + size → atomic-ish rename of the whole
 * dir into place (a model dir either fully exists or not at all — no torn state).
 *
 * License note: the default Kroko model is CC-BY-SA (community model; we download from
 * their published URLs, never redistribute) — `licenseNote` surfaces in Settings (V4).
 * The zipformer-en-26 int8 alternative is fully Apache-2.0.
 */
import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { mkdir, readdir, rename, rm, stat } from 'fs/promises'
import { join } from 'path'

export type VoiceModelRole = 'encoder' | 'decoder' | 'joiner' | 'tokens'

export interface VoiceModelFile {
  /** Local filename inside the model dir (kept = remote basename). */
  name: string
  role: VoiceModelRole
  url: string
  sha256: string
  bytes: number
}

export interface VoiceModelSpec {
  id: string
  label: string
  language: string
  license: string
  /** Shown beside the model in Settings when present (the Kroko CC-BY-SA note). */
  licenseNote?: string
  totalBytes: number
  files: VoiceModelFile[]
}

const KROKO_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06/resolve/572aaf4e2e0c603c3fc2a574d096e755a178faa1'
const ZIP26_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/672fbf1b30579d6585301139bb363f42a0ad4a24'

/**
 * Pinned manifest (verified 2026-07-02). sha256 sources: HF LFS oid (= sha256) for the
 * .onnx files; the two small tokens.txt are plain git blobs → hashes self-computed at
 * authoring time. URLs pin the HF revision commit, so content can never drift under us —
 * the runtime hash check is defense-in-depth, not the only integrity layer.
 */
export const VOICE_MODEL_CATALOG: VoiceModelSpec[] = [
  {
    id: 'kroko-en-2025-08-06',
    label: 'Kroko EN (low latency)',
    language: 'en',
    license: 'CC-BY-SA-4.0',
    licenseNote:
      'Community model by Banafo (Kroko ASR), CC-BY-SA 4.0 — downloaded from their published mirror.',
    totalBytes: 70_092_599 + 617_488 + 336_817 + 6_310,
    files: [
      {
        name: 'encoder.onnx',
        role: 'encoder',
        url: `${KROKO_BASE}/encoder.onnx`,
        sha256: 'd4881c57449d581e0770fd53fa66c2fdc6cd167d92ece7c715e603defc96d9d4',
        bytes: 70_092_599
      },
      {
        name: 'decoder.onnx',
        role: 'decoder',
        url: `${KROKO_BASE}/decoder.onnx`,
        sha256: '455ba38466fce8d5a57e7db68a323b684079ca4d9e1dd93a740d9b2429aae3b1',
        bytes: 617_488
      },
      {
        name: 'joiner.onnx',
        role: 'joiner',
        url: `${KROKO_BASE}/joiner.onnx`,
        sha256: 'd406f616736350e2a7df3e39398b78eb2fc1a2ca6973a19d3853fa3227e25b52',
        bytes: 336_817
      },
      {
        name: 'tokens.txt',
        role: 'tokens',
        url: `${KROKO_BASE}/tokens.txt`,
        sha256: '396dbeb5f4858875690716084f54e90d339679d0ba3e6b5b584f3d7589254d2d',
        bytes: 6_310
      }
    ]
  },
  {
    id: 'zipformer-en-2023-06-26-int8',
    label: 'Zipformer EN int8 (Apache)',
    language: 'en',
    license: 'Apache-2.0',
    totalBytes: 71_083_163 + 1_307_236 + 259_335 + 5_048,
    files: [
      {
        name: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
        role: 'encoder',
        url: `${ZIP26_BASE}/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
        sha256: '563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1',
        bytes: 71_083_163
      },
      {
        name: 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
        role: 'decoder',
        url: `${ZIP26_BASE}/decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
        sha256: '98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02',
        bytes: 1_307_236
      },
      {
        name: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
        role: 'joiner',
        url: `${ZIP26_BASE}/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
        sha256: 'd944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297',
        bytes: 259_335
      },
      {
        name: 'tokens.txt',
        role: 'tokens',
        url: `${ZIP26_BASE}/tokens.txt`,
        sha256: '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb',
        bytes: 5_048
      }
    ]
  }
]

export const DEFAULT_VOICE_MODEL_ID = VOICE_MODEL_CATALOG[0].id

export function getModelSpec(id: string): VoiceModelSpec | undefined {
  return VOICE_MODEL_CATALOG.find((m) => m.id === id)
}

/** Root for all downloaded models; `modelsRoot` overrides userData-derived layout in tests. */
export function voiceModelsRoot(userData: string): string {
  return join(userData, 'voice-models')
}

export function modelDir(userData: string, id: string): string {
  return join(voiceModelsRoot(userData), id)
}

export type VoiceModelStatus = 'ready' | 'absent'

/**
 * 'ready' = every manifest file present at its exact pinned byte size. Hashes are checked
 * at download time only (hashing 70 MB on every status poll would be wasteful); a
 * partially-staged download never lands here thanks to the staging-dir rename.
 */
export async function modelStatus(userData: string, id: string): Promise<VoiceModelStatus> {
  const spec = getModelSpec(id)
  if (!spec) return 'absent'
  const dir = modelDir(userData, id)
  for (const f of spec.files) {
    try {
      const s = await stat(join(dir, f.name))
      if (s.size !== f.bytes) return 'absent'
    } catch {
      return 'absent'
    }
  }
  return 'ready'
}

/** Absolute file paths the engine host needs to build an OnlineRecognizer. */
export interface VoiceModelPaths {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

export function modelPaths(userData: string, id: string): VoiceModelPaths | null {
  const spec = getModelSpec(id)
  if (!spec) return null
  const dir = modelDir(userData, id)
  const byRole = (role: VoiceModelRole): string | undefined =>
    spec.files.find((f) => f.role === role)?.name
  const encoder = byRole('encoder')
  const decoder = byRole('decoder')
  const joiner = byRole('joiner')
  const tokens = byRole('tokens')
  if (!encoder || !decoder || !joiner || !tokens) return null
  return {
    encoder: join(dir, encoder),
    decoder: join(dir, decoder),
    joiner: join(dir, joiner),
    tokens: join(dir, tokens)
  }
}

export interface DownloadProgress {
  id: string
  receivedBytes: number
  totalBytes: number
  /** Which file of the manifest is currently streaming (1-based), for UI copy. */
  fileIndex: number
  fileCount: number
}

export interface DownloadDeps {
  fetchImpl?: typeof fetch
  onProgress?: (p: DownloadProgress) => void
}

/**
 * Download every manifest file into `.staging-<id>/`, hashing while streaming; verify
 * sha256 + size per file; then swap the staging dir into place. Any failure (network,
 * bad status, hash/size mismatch) removes the staging dir and rethrows — the model dir
 * itself is only ever touched in the final swap.
 */
export async function downloadModel(
  userData: string,
  id: string,
  deps: DownloadDeps = {}
): Promise<void> {
  const spec = getModelSpec(id)
  if (!spec) throw new Error(`voice model unknown: ${id}`)
  const fetchImpl = deps.fetchImpl ?? fetch
  const root = voiceModelsRoot(userData)
  const staging = join(root, `.staging-${id}`)
  const finalDir = modelDir(userData, id)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    let received = 0
    for (let i = 0; i < spec.files.length; i++) {
      const f = spec.files[i]
      const res = await fetchImpl(f.url)
      if (!res.ok || !res.body) {
        throw new Error(`voice model download failed: ${f.name} → HTTP ${res.status}`)
      }
      const hash = createHash('sha256')
      const out = createWriteStream(join(staging, f.name))
      let fileBytes = 0
      try {
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          hash.update(chunk)
          fileBytes += chunk.byteLength
          received += chunk.byteLength
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
          deps.onProgress?.({
            id,
            receivedBytes: received,
            totalBytes: spec.totalBytes,
            fileIndex: i + 1,
            fileCount: spec.files.length
          })
        }
      } finally {
        await new Promise((r) => out.end(r))
      }
      const digest = hash.digest('hex')
      if (digest !== f.sha256) {
        throw new Error(`voice model integrity failure: ${f.name} sha256 ${digest} != pinned`)
      }
      if (fileBytes !== f.bytes) {
        throw new Error(`voice model size mismatch: ${f.name} ${fileBytes}B != ${f.bytes}B`)
      }
    }
    // Swap into place. rename() is atomic on the same volume; a previous install (e.g.
    // re-download after corruption) is removed first.
    await rm(finalDir, { recursive: true, force: true })
    await rename(staging, finalDir)
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    throw err
  }
}

export async function deleteModel(userData: string, id: string): Promise<void> {
  const spec = getModelSpec(id)
  if (!spec) throw new Error(`voice model unknown: ${id}`)
  await rm(modelDir(userData, id), { recursive: true, force: true })
}

/** Sweep leftover `.staging-*` dirs (crash mid-download); called at registration time. */
export async function sweepStaging(userData: string): Promise<void> {
  const root = voiceModelsRoot(userData)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((e) => e.startsWith('.staging-'))
      .map((e) => rm(join(root, e), { recursive: true, force: true }))
  )
}
