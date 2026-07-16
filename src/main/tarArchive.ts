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
 * Parse a pax extended-header body for its `path` record. Records are
 * `<len> <key>=<value>\n` with `len` counting the WHOLE record in bytes (names in the
 * model archives are ASCII, so string indices equal byte offsets here).
 */
function parsePaxPath(body: string): string | null {
  let i = 0
  while (i < body.length) {
    const sp = body.indexOf(' ', i)
    if (sp < 0) break
    const len = parseInt(body.slice(i, sp), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const rec = body.slice(sp + 1, i + len)
    const eq = rec.indexOf('=')
    if (eq > 0 && rec.slice(0, eq) === 'path') return rec.slice(eq + 1).replace(/\n$/, '')
    i += len
  }
  return null
}

/**
 * List every REGULAR file in the archive. Directories and links are skipped. Long names
 * are honored through ALL THREE mechanisms in the wild: the ustar `prefix` field, GNU
 * `L` longname entries (what GNU tar — and therefore the k2-fsa release archives — emits
 * once dir+file exceeds 100 chars; found live in the J5 dev check: the KWS model's inner
 * paths are 102-103 chars), and pax `x` extended headers (`path=` record — python
 * tarfile's default). An unhandled long name would silently truncate to 100 chars and
 * the pinned-file lookup would miss.
 */
export function readTarEntries(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let pos = 0
  let pendingLongName: string | null = null
  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK)
    // Two consecutive zero blocks = end of archive; a single zero block ends it too.
    if (header.every((b) => b === 0)) break
    const rawName = readString(header, 0, 100)
    const size = readOctal(header, 124, 12)
    const typeflag = header[156]
    const prefix = readString(header, 345, 155)
    pos += BLOCK
    if (pos + size > tar.length) throw new Error('tar: entry overruns archive')
    if (typeflag === 0x4c) {
      // GNU 'L': the payload IS the next entry's full name (NUL-padded).
      pendingLongName = tar
        .subarray(pos, pos + size)
        .toString('utf8')
        .replace(/\0+$/, '')
    } else if (typeflag === 0x78) {
      // pax 'x' (per-file): a path= record overrides the next entry's name.
      pendingLongName =
        parsePaxPath(tar.subarray(pos, pos + size).toString('utf8')) ?? pendingLongName
    } else if (typeflag === 0x67) {
      // pax 'g' (global): ignored — never carries a per-file path in these archives.
    } else if (typeflag === 0x30 || typeflag === 0) {
      const full = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName)
      pendingLongName = null
      entries.push({ name: full, data: Buffer.from(tar.subarray(pos, pos + size)) })
    } else {
      pendingLongName = null // a dir/link consumes any pending long name
    }
    pos += Math.ceil(size / BLOCK) * BLOCK
  }
  return entries
}

/** Find one entry by its path BASENAME (the model archives nest under one root dir). */
export function findTarEntry(entries: TarEntry[], basename: string): TarEntry | undefined {
  return entries.find((e) => e.name.split('/').pop() === basename)
}
