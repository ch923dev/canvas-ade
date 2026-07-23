import { describe, it, expect } from 'vitest'
import { encodeWav, decodeWav, wavDurationSeconds } from './voiceWav'

// Ported from scripts/stt-eval/wav.test.ts (PR #368) — the TS encoder must stay byte-identical.

/** 16 kHz mono s16le, `n` samples of silence — the shape the capture path emits. */
const silence = (n: number): Buffer => Buffer.alloc(n * 2)

describe('encodeWav', () => {
  it('writes a canonical 44-byte header', () => {
    const wav = encodeWav(silence(100), 16000)
    expect(wav.length).toBe(44 + 200)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data')
    expect(wav.readUInt32LE(4)).toBe(36 + 200) // RIFF size excludes the first 8 bytes
    expect(wav.readUInt32LE(40)).toBe(200) // data size
  })

  it('records rate, channels, byte rate and block align consistently', () => {
    const wav = encodeWav(silence(10), 16000, 1)
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // channels
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt32LE(28)).toBe(32000) // 16000 * 1 * 2
    expect(wav.readUInt16LE(32)).toBe(2) // block align
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
  })

  it('rejects a nonsense sample rate instead of writing a corrupt header', () => {
    expect(() => encodeWav(silence(4), 0)).toThrow(/bad sampleRate/)
    expect(() => encodeWav(silence(4), -16000)).toThrow(/bad sampleRate/)
  })

  it('accepts a plain Uint8Array and a raw ArrayBuffer as well as a Buffer', () => {
    expect(() => encodeWav(new Uint8Array(20), 16000)).not.toThrow()
    // The capture frames arrive as ArrayBuffer over the port — the engine concats Buffers, but
    // encodeWav must accept the raw shape too.
    expect(() => encodeWav(new ArrayBuffer(20), 16000)).not.toThrow()
  })
})

describe('decodeWav', () => {
  it('round-trips what encodeWav wrote', () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])
    const out = decodeWav(encodeWav(pcm, 16000))
    expect(out.sampleRate).toBe(16000)
    expect(out.channels).toBe(1)
    expect(out.bitsPerSample).toBe(16)
    expect(Buffer.from(out.pcm).equals(pcm)).toBe(true)
  })

  it('computes duration from frames', () => {
    // 16000 samples at 16 kHz mono = exactly 1 second.
    expect(decodeWav(encodeWav(silence(16000), 16000)).durationMs).toBeCloseTo(1000)
    expect(wavDurationSeconds(encodeWav(silence(8000), 16000))).toBeCloseTo(0.5)
  })

  it('skips unknown chunks rather than assuming data starts at byte 44', () => {
    const base = encodeWav(silence(4), 16000)
    const list = Buffer.alloc(8 + 4)
    list.write('LIST', 0, 'ascii')
    list.writeUInt32LE(4, 4)
    const spliced = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)])
    spliced.writeUInt32LE(spliced.length - 8, 4)
    const out = decodeWav(spliced)
    expect(out.sampleRate).toBe(16000)
    expect(out.pcm.length).toBe(8)
  })

  it('handles the pad byte after an odd-sized chunk', () => {
    const base = encodeWav(silence(4), 16000)
    const odd = Buffer.alloc(8 + 3 + 1) // 3-byte payload + 1 pad byte
    odd.write('junk', 0, 'ascii')
    odd.writeUInt32LE(3, 4)
    const spliced = Buffer.concat([base.subarray(0, 36), odd, base.subarray(36)])
    spliced.writeUInt32LE(spliced.length - 8, 4)
    expect(decodeWav(spliced).pcm.length).toBe(8)
  })

  it('rejects non-RIFF input', () => {
    expect(() => decodeWav(Buffer.alloc(64))).toThrow(/not a RIFF/)
    expect(() => decodeWav(Buffer.from('hello'))).toThrow(/not a RIFF/)
  })

  it('rejects compressed (non-PCM) audio rather than misreading it', () => {
    const wav = encodeWav(silence(4), 16000)
    wav.writeUInt16LE(3, 20) // IEEE float
    expect(() => decodeWav(wav)).toThrow(/not PCM/)
  })

  it('rejects a bit depth the voice stack cannot consume', () => {
    const wav = encodeWav(silence(4), 16000)
    wav.writeUInt16LE(24, 34)
    expect(() => decodeWav(wav)).toThrow(/24-bit not supported/)
  })

  it('reports a missing data chunk instead of returning empty audio', () => {
    const header = encodeWav(silence(0), 16000).subarray(0, 36)
    const buf = Buffer.from(header)
    buf.writeUInt32LE(buf.length - 8, 4)
    expect(() => decodeWav(buf)).toThrow(/no data chunk/)
  })
})
