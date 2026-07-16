/**
 * Jarvis J5 — wake-word (KWS) model install/verify/delete (D3).
 *
 * Same never-bundled / pinned-integrity design as the STT+TTS catalogs, with one
 * difference: the English KWS zipformer has NO per-file mirror anywhere trustworthy —
 * k2-fsa (the sherpa-onnx authors) publish it only as a GitHub-release `tar.bz2` with a
 * published checksum. So this installer downloads the ARCHIVE (streamed to a staging
 * file, hash-while-writing, pinned sha256+size), decompresses it in memory (the vendored
 * seek-bzip port), extracts exactly the four files the spotter needs via the minimal
 * ustar reader, verifies EACH extracted file against its own pinned sha256+size
 * (defense-in-depth: release assets are mutable, the pins are not), writes the fixed
 * pre-encoded keywords file, and atomically renames the staging dir into place.
 *
 * KEYWORDS ARE PRE-ENCODED AND FIXED. sherpa's KeywordSpotter takes bpe-token lines, has
 * no runtime raw-text encoding in this addon build, and a malformed keywords file ABORTS
 * the native process (spiked 2026-07-17) — so the file is generated here from a constant
 * validated against the real model (SAPI-synthesized positive + negative audio), never
 * from user text. Wake phrase v1: "Hey Jarvis" (a renamed persona keeps this phrase —
 * runtime re-encoding for arbitrary names is a follow-up, needs a JS sentencepiece).
 */
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { streamBodyToFile, voiceModelsRoot, type DownloadDeps } from './voiceModels'
import { bunzip2 } from '../vendor/seek-bzip/bunzip'
import { findTarEntry, readTarEntries } from './tarArchive'

/** One file extracted from the archive, pinned independently of the archive itself. */
export interface KwsModelFile {
  /** Basename inside the archive's root dir; kept as the on-disk name. */
  name: string
  sha256: string
  bytes: number
}

export interface KwsModelSpec {
  id: string
  label: string
  language: string
  license: string
  licenseNote?: string
  /** The pinned release archive (authors' published URL + published checksum). */
  archiveUrl: string
  archiveSha256: string
  archiveBytes: number
  /** Extracted + individually pinned (int8 trio + tokens). */
  files: KwsModelFile[]
  totalBytes: number
}

/**
 * The fixed wake phrase, pre-encoded against THIS model's bpe (sentencepiece
 * bpe.model, encoded at authoring time, detection-validated on synthesized audio).
 * "HEY JARVIS" = ▁HE Y ▁JA R VI S. Written as `keywords.txt` beside the model.
 */
export const KWS_KEYWORDS_CONTENT = '▁HE Y ▁JA R VI S\n'
/** The phrase the Settings row shows for the line above. */
export const KWS_WAKE_PHRASE = 'Hey Jarvis'

const GIGASPEECH_FILES: KwsModelFile[] = [
  {
    name: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    sha256: '1e721676515bcd42a186979733981213c66c80db680e1cc582dfedf3be76e678',
    bytes: 4_807_159
  },
  {
    name: 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    sha256: 'e40ff43297abe815e8898494c17e71bba2152d9d40fa3eb803f75d0f7533329a',
    bytes: 277_985
  },
  {
    name: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    sha256: 'eae9da0c7e1e6c6a3f4cc42d167899c388f6c6701b94cb96320e4f55df79624c',
    bytes: 163_380
  },
  {
    name: 'tokens.txt',
    sha256: 'fd2ded4050a55d2b1578870ba8697d02371980217806b7558bd0a5cc60f3ba53',
    bytes: 5_006
  }
]

/** Pinned 2026-07-17: archive sha256 = the authors' published checksum.txt entry,
 *  re-verified locally; per-file pins self-computed from the verified archive. */
export const KWS_MODEL_CATALOG: KwsModelSpec[] = [
  {
    id: 'kws-zipformer-gigaspeech-3.3M',
    label: 'Wake word EN (zipformer 3.3M)',
    language: 'en',
    license: 'Apache-2.0',
    licenseNote:
      'k2-fsa keyword-spotting zipformer (GigaSpeech, Apache-2.0), downloaded from the ' +
      'authors’ published GitHub release.',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2',
    archiveSha256: 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a',
    archiveBytes: 17_626_723,
    files: GIGASPEECH_FILES,
    totalBytes: 17_626_723 // progress reports archive bytes — that is what streams
  }
]

export const DEFAULT_KWS_MODEL_ID = KWS_MODEL_CATALOG[0].id

export function getKwsModelSpec(id: string): KwsModelSpec | undefined {
  return KWS_MODEL_CATALOG.find((m) => m.id === id)
}

/** Model dir under the shared voice-models root (shares its staging sweep). */
export function kwsModelDir(userData: string, id: string): string {
  return join(voiceModelsRoot(userData), `kws-${id}`)
}

export type KwsModelStatus = 'ready' | 'absent'

/** 'ready' = every pinned file at its exact size + the generated keywords file present. */
export async function kwsModelStatus(userData: string, id: string): Promise<KwsModelStatus> {
  const spec = getKwsModelSpec(id)
  if (!spec) return 'absent'
  const dir = kwsModelDir(userData, id)
  for (const f of spec.files) {
    try {
      const s = await stat(join(dir, f.name))
      if (s.size !== f.bytes) return 'absent'
    } catch {
      return 'absent'
    }
  }
  if (!existsSync(join(dir, 'keywords.txt'))) return 'absent'
  return 'ready'
}

/** Absolute paths the engine host needs to build a KeywordSpotter. */
export interface KwsModelPaths {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
  keywords: string
}

export function kwsModelPaths(userData: string, id: string): KwsModelPaths | null {
  const spec = getKwsModelSpec(id)
  if (!spec) return null
  const dir = kwsModelDir(userData, id)
  const by = (pred: (n: string) => boolean): string | undefined =>
    spec.files.find((f) => pred(f.name))?.name
  const encoder = by((n) => n.startsWith('encoder'))
  const decoder = by((n) => n.startsWith('decoder'))
  const joiner = by((n) => n.startsWith('joiner'))
  if (!encoder || !decoder || !joiner) return null
  return {
    encoder: join(dir, encoder),
    decoder: join(dir, decoder),
    joiner: join(dir, joiner),
    tokens: join(dir, 'tokens.txt'),
    keywords: join(dir, 'keywords.txt')
  }
}

/**
 * Download + install. Stream the archive into `.staging-kws-<id>.tar.bz2` (hash while
 * writing, progress per chunk) → verify the archive pin → decompress + extract in
 * memory → verify each pinned file → write files + keywords into `.staging-kws-<id>/`
 * → atomic rename. Any failure removes all staging residue and rethrows; the model dir
 * either fully exists or not at all.
 */
export async function downloadKwsModel(
  userData: string,
  id: string,
  deps: DownloadDeps = {}
): Promise<void> {
  const spec = getKwsModelSpec(id)
  if (!spec) throw new Error(`kws model unknown: ${id}`)
  return installKwsArchive(userData, spec, deps)
}

/** The spec-driven core of the install (exported so units drive a synthetic spec). */
export async function installKwsArchive(
  userData: string,
  spec: KwsModelSpec,
  deps: DownloadDeps = {}
): Promise<void> {
  const id = spec.id
  const fetchImpl = deps.fetchImpl ?? fetch
  const root = voiceModelsRoot(userData)
  const stagingArchive = join(root, `.staging-kws-${id}.tar.bz2`)
  const stagingDir = join(root, `.staging-kws-${id}`)
  const finalDir = kwsModelDir(userData, id)
  await rm(stagingArchive, { force: true })
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  try {
    const res = await fetchImpl(spec.archiveUrl)
    if (!res.ok || !res.body) {
      throw new Error(`kws model download failed: HTTP ${res.status}`)
    }
    const hash = createHash('sha256')
    let received = 0
    await streamBodyToFile(res.body as AsyncIterable<Uint8Array>, stagingArchive, (chunk) => {
      hash.update(chunk)
      received += chunk.byteLength
      deps.onProgress?.({
        id,
        receivedBytes: received,
        totalBytes: spec.archiveBytes,
        fileIndex: 1,
        fileCount: 1
      })
    })
    const digest = hash.digest('hex')
    if (digest !== spec.archiveSha256) {
      throw new Error(`kws archive integrity failure: sha256 ${digest} != pinned`)
    }
    if (received !== spec.archiveBytes) {
      throw new Error(`kws archive size mismatch: ${received}B != ${spec.archiveBytes}B`)
    }
    const entries = readTarEntries(bunzip2(await readFile(stagingArchive)))
    await mkdir(stagingDir, { recursive: true })
    for (const f of spec.files) {
      const entry = findTarEntry(entries, f.name)
      if (!entry) throw new Error(`kws archive missing ${f.name}`)
      const fileDigest = createHash('sha256').update(entry.data).digest('hex')
      if (fileDigest !== f.sha256 || entry.data.length !== f.bytes) {
        throw new Error(`kws file integrity failure: ${f.name}`)
      }
      await writeFile(join(stagingDir, f.name), entry.data)
    }
    await writeFile(join(stagingDir, 'keywords.txt'), KWS_KEYWORDS_CONTENT, 'utf8')
    await rm(finalDir, { recursive: true, force: true })
    await rename(stagingDir, finalDir)
  } finally {
    await rm(stagingArchive, { force: true })
    await rm(stagingDir, { recursive: true, force: true })
  }
}

/** Remove the installed model dir (no shared components on the KWS side). */
export async function deleteKwsModel(userData: string, id: string): Promise<void> {
  const spec = getKwsModelSpec(id)
  if (!spec) throw new Error(`kws model unknown: ${id}`)
  await rm(kwsModelDir(userData, id), { recursive: true, force: true })
}
