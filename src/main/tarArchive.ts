/**
 * Minimal in-memory tar reader (J5 wake word — the KWS model archives ship as tar.bz2
 * from the k2-fsa GitHub release; the bzip2 layer is the vendored seek-bzip port).
 * Read-only, whole-buffer, ustar-aware: 512-byte headers, octal sizes, `prefix` field
 * honored, entries padded to 512. Deliberately NOT an npm `tar` dependency — this is
 * ~60 lines for one archive shape we pin by sha256, not a general tar surface.
 */

export interface TarEntry {
  /** Full name (ustar prefix + name), forward slashes as stored. */
  name: string
  data: Buffer
}

const BLOCK = 512

function readString(buf: Buffer, offset: number, length: number): string {
  const end = buf.indexOf(0, offset)
  const stop = end === -1 || end > offset + length ? offset + length : end
  return buf.subarray(offset, stop).toString('utf8')
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const s = readString(buf, offset, length).trim()
  if (!s) return 0
  const n = parseInt(s, 8)
  if (!Number.isFinite(n) || n < 0) throw new Error('tar: bad octal field')
  return n
}

/**
 * List every REGULAR file in the archive. Directories, symlinks and pax/gnu extension
 * entries are skipped (the pinned model archives contain none that matter — the sha256
 * pin upstream means a surprising archive is a failed download, and unknown entry types
 * simply don't land on disk).
 */
export function readTarEntries(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let pos = 0
  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK)
    // Two consecutive zero blocks = end of archive; a single zero block ends it too.
    if (header.every((b) => b === 0)) break
    const name = readString(header, 0, 100)
    const size = readOctal(header, 124, 12)
    const typeflag = header[156]
    const prefix = readString(header, 345, 155)
    const full = prefix ? `${prefix}/${name}` : name
    pos += BLOCK
    if (pos + size > tar.length) throw new Error('tar: entry overruns archive')
    // '0' or NUL = regular file; everything else (dirs '5', links, pax 'x'/'g', gnu 'L')
    // is skipped WITH its payload.
    if (typeflag === 0x30 || typeflag === 0) {
      entries.push({ name: full, data: Buffer.from(tar.subarray(pos, pos + size)) })
    }
    pos += Math.ceil(size / BLOCK) * BLOCK
  }
  return entries
}

/** Find one entry by its path BASENAME (the model archives nest under one root dir). */
export function findTarEntry(entries: TarEntry[], basename: string): TarEntry | undefined {
  return entries.find((e) => e.name.split('/').pop() === basename)
}
