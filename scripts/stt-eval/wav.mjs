// Minimal WAV (RIFF/PCM) reader+writer for the STT eval corpus.
//
// WHY THIS EXISTS. The app's capture path produces raw headerless 16 kHz mono Int16 PCM
// (src/renderer/src/voice/captureMath.ts), and of every batch STT vendor surveyed only
// Deepgram documents accepting raw headerless PCM — Groq, OpenAI, AssemblyAI, ElevenLabs
// and Speechmatics all list container formats only. So the corpus is stored as WAV and
// each engine adapter gets a real container. 44 bytes of header, no dependency.
//
// Scope: canonical 44-byte PCM WAV only (fmt chunk 16 bytes, audioFormat 1). We write
// that shape, and the reader tolerates extra/reordered chunks (some recorders emit LIST
// or fact chunks before data) but rejects anything non-PCM rather than guessing.

const RIFF = 0x46464952 // 'RIFF' little-endian
const WAVE = 0x45564157 // 'WAVE'
const FMT_ = 0x20746d66 // 'fmt '
const DATA = 0x61746164 // 'data'

/** PCM s16le is what the whole voice stack speaks; anything else is a caller bug. */
const BYTES_PER_SAMPLE = 2

/**
 * Wrap raw PCM16 little-endian mono samples in a canonical WAV container.
 * `pcm` is a Buffer/Uint8Array of interleaved s16le bytes (mono here, so just samples).
 */
export function encodeWav(pcm, sampleRate = 16000, channels = 1) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`encodeWav: bad sampleRate ${sampleRate}`)
  }
  const body = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm)
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  // RIFF size = everything after this field. Header is 44 bytes, so 36 + payload.
  header.writeUInt32LE(36 + body.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20) // audioFormat 1 = PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32) // block align
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(body.length, 40)
  return Buffer.concat([header, body])
}

/**
 * Parse a PCM WAV back to `{sampleRate, channels, bitsPerSample, pcm, durationMs}`.
 * Walks the chunk list rather than assuming data starts at byte 44, so files written by
 * a browser MediaRecorder or a converter with extra chunks still read.
 */
export function decodeWav(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length < 12 || b.readUInt32LE(0) !== RIFF || b.readUInt32LE(8) !== WAVE) {
    throw new Error('decodeWav: not a RIFF/WAVE file')
  }
  let fmt = null
  let pcm = null
  let off = 12
  // Chunks are [id:4][size:4][payload:size], payload padded to even length.
  while (off + 8 <= b.length) {
    const id = b.readUInt32LE(off)
    const size = b.readUInt32LE(off + 4)
    const payload = off + 8
    if (payload + size > b.length) break // truncated tail — take what we have
    if (id === FMT_ && size >= 16) {
      const audioFormat = b.readUInt16LE(payload)
      if (audioFormat !== 1) {
        throw new Error(`decodeWav: audioFormat ${audioFormat} is not PCM`)
      }
      fmt = {
        channels: b.readUInt16LE(payload + 2),
        sampleRate: b.readUInt32LE(payload + 4),
        bitsPerSample: b.readUInt16LE(payload + 14)
      }
    } else if (id === DATA) {
      pcm = b.subarray(payload, payload + size)
    }
    off = payload + size + (size % 2) // skip the pad byte on odd-sized chunks
  }
  if (!fmt) throw new Error('decodeWav: no fmt chunk')
  if (!pcm) throw new Error('decodeWav: no data chunk')
  if (fmt.bitsPerSample !== 16) {
    throw new Error(`decodeWav: ${fmt.bitsPerSample}-bit not supported (need 16)`)
  }
  const frames = pcm.length / (fmt.channels * BYTES_PER_SAMPLE)
  return { ...fmt, pcm, durationMs: (frames / fmt.sampleRate) * 1000 }
}

/** Duration in seconds without materialising samples — used for cost/latency reporting. */
export function wavDurationSeconds(buf) {
  return decodeWav(buf).durationMs / 1000
}
