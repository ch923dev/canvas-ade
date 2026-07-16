/**
 * VENDORED — seek-bzip v2.0.0 (npm), MIT. See ./LICENSE + ./VERSION.md.
 * Source: github.com/cscott/seek-bzip (lib/bitreader.js + lib/crc32.js + lib/index.js),
 * ported to strict TypeScript and TRIMMED to the one entry point this repo needs:
 * whole-buffer bzip2 decode (`bunzip2`). The seek/table/block/stream APIs and the
 * CLI are dropped (perfect-freehand precedent: vendored, NOT an npm dependency —
 * a ~17 MB one-shot model-archive decode does not justify a supply-chain edge).
 *
 * Decode chain per block: huffman (grouped, MTF-selected) → RLE1 undo → inverse
 * Burrows-Wheeler → RLE2 undo, with per-block and whole-stream CRC verification.
 */

const MAX_HUFCODE_BITS = 20
const MAX_SYMBOLS = 258
const SYMBOL_RUNA = 0
const SYMBOL_RUNB = 1
const MIN_GROUPS = 2
const MAX_GROUPS = 6
const GROUP_SIZE = 50

const WHOLEPI = '314159265359'
const SQRTPI = '177245385090'

const BITMASK = [0x00, 0x01, 0x03, 0x07, 0x0f, 0x1f, 0x3f, 0x7f, 0xff]

class BitReader {
  private pos = 0
  private bitOffset = 0
  private curByte = 0
  private hasByte = false

  constructor(private readonly input: Uint8Array) {}

  eof(): boolean {
    return this.pos >= this.input.length && !this.hasByte
  }

  private ensureByte(): void {
    if (!this.hasByte) {
      if (this.pos >= this.input.length) throw bzipError('Unexpected input EOF')
      this.curByte = this.input[this.pos++]
      this.hasByte = true
    }
  }

  read(bits: number): number {
    let result = 0
    while (bits > 0) {
      this.ensureByte()
      const remaining = 8 - this.bitOffset
      if (bits >= remaining) {
        result <<= remaining
        result |= BITMASK[remaining] & this.curByte
        this.hasByte = false
        this.bitOffset = 0
        bits -= remaining
      } else {
        result <<= bits
        const shift = remaining - bits
        result |= (this.curByte & (BITMASK[bits] << shift)) >> shift
        this.bitOffset += bits
        bits = 0
      }
    }
    return result
  }

  /** Read 48 bits as a hex string (the block/eos signatures are 6-byte "pi" magics). */
  pi(): string {
    let s = ''
    for (let i = 0; i < 6; i++) s += this.read(8).toString(16).padStart(2, '0')
    return s
  }
}

/* CRC32 as used by bzip2 (jbzip2's table — NOT the zlib polynomial byte order). */
const crc32Lookup = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 24
    for (let k = 0; k < 8; k++) c = (c & 0x80000000) !== 0 ? (c << 1) ^ 0x04c11db7 : c << 1
    table[i] = c >>> 0
  }
  return table
})()

class Crc32 {
  private crc = 0xffffffff

  get(): number {
    return ~this.crc >>> 0
  }

  updateRun(value: number, count: number): void {
    while (count-- > 0) {
      this.crc = ((this.crc << 8) ^ crc32Lookup[((this.crc >>> 24) ^ value) & 0xff]) >>> 0
    }
  }
}

function bzipError(detail: string): TypeError {
  return new TypeError(`bzip2: ${detail}`)
}

/** Move-to-front decode step. */
function mtf(array: Uint8Array, index: number): number {
  const src = array[index]
  for (let i = index; i > 0; i--) array[i] = array[i - 1]
  array[0] = src
  return src
}

interface HufGroup {
  permute: Uint16Array
  limit: Float64Array // carries the MAX_VALUE sentinel — Uint32 would truncate it
  base: Uint32Array
  minLen: number
  maxLen: number
}

class GrowableOutput {
  private buffer = new Uint8Array(1 << 16)
  pos = 0

  writeRun(byte: number, count: number): void {
    if (this.pos + count > this.buffer.length) {
      let next = this.buffer.length * 2
      while (this.pos + count > next) next *= 2
      const grown = new Uint8Array(next)
      grown.set(this.buffer.subarray(0, this.pos))
      this.buffer = grown
    }
    this.buffer.fill(byte, this.pos, this.pos + count)
    this.pos += count
  }

  take(): Buffer {
    return Buffer.from(this.buffer.buffer, 0, this.pos)
  }
}

/**
 * Decode ONE block's header + symbols into the intermediate dbuf, returning the
 * state `readBlock` needs (or null on the end-of-stream signature).
 */
function getNextBlock(
  reader: BitReader,
  dbufSize: number
): { dbuf: Uint32Array; dbufCount: number; origPointer: number; targetCRC: number } | null {
  const h = reader.pi()
  if (h === SQRTPI) return null // last-block signature: stream CRC follows
  if (h !== WHOLEPI) throw bzipError('bad block signature')
  const targetCRC = reader.read(32) >>> 0
  if (reader.read(1)) throw bzipError('obsolete randomised input not supported')
  const origPointer = reader.read(24)
  if (origPointer > dbufSize) throw bzipError('initial position out of bounds')

  // Sparse symbol map → symToByte translation table.
  const t16 = reader.read(16)
  const symToByte = new Uint8Array(256)
  let symTotal = 0
  for (let i = 0; i < 16; i++) {
    if (t16 & (1 << (0xf - i))) {
      const o = i * 16
      const k = reader.read(16)
      for (let j = 0; j < 16; j++) if (k & (1 << (0xf - j))) symToByte[symTotal++] = o + j
    }
  }

  const groupCount = reader.read(3)
  if (groupCount < MIN_GROUPS || groupCount > MAX_GROUPS) throw bzipError('bad group count')
  const nSelectors = reader.read(15)
  if (nSelectors === 0) throw bzipError('no selectors')

  const mtfSymbol = new Uint8Array(256)
  for (let i = 0; i < groupCount; i++) mtfSymbol[i] = i
  const selectors = new Uint8Array(nSelectors)
  for (let i = 0; i < nSelectors; i++) {
    let j = 0
    for (; reader.read(1); j++) if (j >= groupCount) throw bzipError('bad selector run')
    selectors[i] = mtf(mtfSymbol, j)
  }

  // Huffman tables per group.
  let symCount = symTotal + 2
  const groups: HufGroup[] = []
  for (let j = 0; j < groupCount; j++) {
    const length = new Uint8Array(symCount)
    const temp = new Uint16Array(MAX_HUFCODE_BITS + 1)
    let t = reader.read(5)
    for (let i = 0; i < symCount; i++) {
      for (;;) {
        if (t < 1 || t > MAX_HUFCODE_BITS) throw bzipError('bad code length')
        if (!reader.read(1)) break
        if (!reader.read(1)) t++
        else t--
      }
      length[i] = t
    }
    let minLen = length[0]
    let maxLen = length[0]
    for (let i = 1; i < symCount; i++) {
      if (length[i] > maxLen) maxLen = length[i]
      else if (length[i] < minLen) minLen = length[i]
    }
    const huf: HufGroup = {
      permute: new Uint16Array(MAX_SYMBOLS),
      limit: new Float64Array(MAX_HUFCODE_BITS + 2),
      base: new Uint32Array(MAX_HUFCODE_BITS + 1),
      minLen,
      maxLen
    }
    groups.push(huf)
    let pp = 0
    for (let i = minLen; i <= maxLen; i++) {
      temp[i] = 0
      huf.limit[i] = 0
      for (let s = 0; s < symCount; s++) if (length[s] === i) huf.permute[pp++] = s
    }
    for (let i = 0; i < symCount; i++) temp[length[i]]++
    pp = 0
    let cum = 0
    for (let i = minLen; i < maxLen; i++) {
      pp += temp[i]
      huf.limit[i] = pp - 1
      pp <<= 1
      cum += temp[i]
      huf.base[i + 1] = pp - cum
    }
    huf.limit[maxLen + 1] = Number.MAX_VALUE // sentinel for the read-next-symbol loop
    huf.limit[maxLen] = pp + temp[maxLen] - 1
    huf.base[minLen] = 0
  }

  // Huffman-decode symbols → dbuf (RLE1 undone inline via RUNA/RUNB arithmetic).
  const byteCount = new Uint32Array(256)
  for (let i = 0; i < 256; i++) mtfSymbol[i] = i
  let runPos = 0
  let dbufCount = 0
  let selector = 0
  let runLen = 0
  const dbuf = new Uint32Array(dbufSize)
  let groupSymsLeft = 0
  let huf: HufGroup = groups[selectors[0]]
  for (;;) {
    if (!groupSymsLeft--) {
      groupSymsLeft = GROUP_SIZE - 1
      if (selector >= nSelectors) throw bzipError('selector overflow')
      huf = groups[selectors[selector++]]
    }
    let i = huf.minLen
    let j = reader.read(i)
    for (; ; i++) {
      if (i > huf.maxLen) throw bzipError('symbol overran max length')
      if (j <= huf.limit[i]) break
      j = (j << 1) | reader.read(1)
    }
    j -= huf.base[i]
    if (j < 0 || j >= MAX_SYMBOLS) throw bzipError('symbol out of range')
    const nextSym = huf.permute[j]
    if (nextSym === SYMBOL_RUNA || nextSym === SYMBOL_RUNB) {
      if (!runPos) {
        runPos = 1
        runLen = 0
      }
      runLen += nextSym === SYMBOL_RUNA ? runPos : 2 * runPos
      runPos <<= 1
      continue
    }
    if (runPos) {
      runPos = 0
      if (dbufCount + runLen > dbufSize) throw bzipError('run exceeds block size')
      const uc = symToByte[mtfSymbol[0]]
      byteCount[uc] += runLen
      while (runLen--) dbuf[dbufCount++] = uc
    }
    if (nextSym > symTotal) break // terminator
    if (dbufCount >= dbufSize) throw bzipError('block overflow')
    const uc = symToByte[mtf(mtfSymbol, nextSym - 1)]
    byteCount[uc]++
    dbuf[dbufCount++] = uc
  }

  // Inverse Burrows-Wheeler: thread the sorted-order links through dbuf.
  if (origPointer < 0 || origPointer >= dbufCount) throw bzipError('bad orig pointer')
  let cum = 0
  for (let i = 0; i < 256; i++) {
    const next = cum + byteCount[i]
    byteCount[i] = cum
    cum = next
  }
  for (let i = 0; i < dbufCount; i++) {
    const uc = dbuf[i] & 0xff
    dbuf[byteCount[uc]] |= i << 8
    byteCount[uc]++
  }
  return { dbuf, dbufCount, origPointer, targetCRC }
}

/** Walk the BWT links emitting output with the final RLE (4-run + count) undone. */
function readBlock(
  block: { dbuf: Uint32Array; dbufCount: number; origPointer: number; targetCRC: number },
  out: GrowableOutput
): void {
  const crc = new Crc32()
  const { dbuf, targetCRC } = block
  let dbufCount = block.dbufCount
  let pos = 0
  let current = 0
  let run = 0
  if (dbufCount) {
    pos = dbuf[block.origPointer]
    current = pos & 0xff
    pos >>= 8
    run = -1
  }
  while (dbufCount) {
    dbufCount--
    const previous = current
    pos = dbuf[pos]
    current = pos & 0xff
    pos >>= 8
    let copies: number
    let outbyte: number
    if (run++ === 3) {
      copies = current
      outbyte = previous
      current = -1
    } else {
      copies = 1
      outbyte = current
    }
    crc.updateRun(outbyte, copies)
    out.writeRun(outbyte, copies)
    if (current !== previous) run = 0
  }
  if (crc.get() !== targetCRC) {
    throw bzipError(
      `bad block CRC (got ${crc.get().toString(16)} expected ${targetCRC.toString(16)})`
    )
  }
}

/**
 * Decode a whole single-stream bzip2 buffer. Throws on any malformed input or
 * CRC mismatch — the caller (the model-archive installer) treats a throw as a
 * failed download, never a partial extract.
 */
export function bunzip2(input: Uint8Array): Buffer {
  if (input.length < 4 || input[0] !== 0x42 || input[1] !== 0x5a || input[2] !== 0x68) {
    throw bzipError('bad magic')
  }
  const level = input[3] - 0x30
  if (level < 1 || level > 9) throw bzipError('level out of range')
  const reader = new BitReader(input.subarray(4))
  const dbufSize = 100000 * level
  const out = new GrowableOutput()
  let streamCRC = 0
  for (;;) {
    const block = getNextBlock(reader, dbufSize)
    if (block) {
      streamCRC = (block.targetCRC ^ ((streamCRC << 1) | (streamCRC >>> 31))) >>> 0
      readBlock(block, out)
    } else {
      const targetStreamCRC = reader.read(32) >>> 0
      if (targetStreamCRC !== streamCRC) {
        throw bzipError(
          `bad stream CRC (got ${streamCRC.toString(16)} expected ${targetStreamCRC.toString(16)})`
        )
      }
      return out.take()
    }
  }
}
