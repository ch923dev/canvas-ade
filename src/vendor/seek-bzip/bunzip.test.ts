/**
 * Vendored seek-bzip port — decode verification against fixtures produced by CPython's
 * stdlib bz2 (compresslevel 9), i.e. the reference libbzip2 encoder: text (huffman-heavy),
 * long runs (both RLE layers incl. the 4-run+count form), and seeded pseudo-random binary
 * (BWT worst case). Plus the malformed-input contract: throw, never a partial buffer.
 */
import { describe, expect, it } from 'vitest'
import { bunzip2 } from './bunzip'

const b64 = (s: string): Buffer => Buffer.from(s, 'base64')

const FIXTURES: Array<{ name: string; bz2: string; expect: string }> = [
  {
    name: 'text (repeating english)',
    bz2: 'QlpoOTFBWSZTWX8/3DwAAXuRgEABP///8DAAuAo0NAAAAUaGgAAAClUmppgmCM1NtR+EwTsTBOJNCZE0JvJ0J+k4k7kyJ3E1JsJ5J6E1JmT+JkTYTBPJMycyaE9EzJ2J/k1JmJgmCdCr2T2T4LuSKcKEg/n+4eA=',
    expect: Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(20)).toString(
      'base64'
    )
  },
  {
    name: 'heavy runs (RLE paths)',
    bz2: 'QlpoOTFBWSZTWdi1DzIAAAfVAMAAACA4AAYBAAggADEGTECQkaepRjaMCbFzuq+uQ34u5IpwoSGxah5k',
    expect: Buffer.concat([
      Buffer.alloc(300, 'A'),
      Buffer.from('B'),
      Buffer.alloc(255, 'C'),
      Buffer.alloc(512, 0),
      Buffer.from('end')
    ]).toString('base64')
  }
]

describe('bunzip2 (vendored seek-bzip)', () => {
  for (const f of FIXTURES) {
    it(`decodes ${f.name} byte-identically`, () => {
      expect(bunzip2(b64(f.bz2)).equals(b64(f.expect))).toBe(true)
    })
  }

  it('decodes seeded pseudo-random binary byte-identically', async () => {
    // The 2 KB fixture is unwieldy inline — regenerate the expectation deterministically
    // (python random.seed(42) byte stream is not reproducible in JS, so this fixture
    // pair ships as files under __fixtures__).
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const bz = readFileSync(join(here, '__fixtures__', 'rand.bin.bz2'))
    const raw = readFileSync(join(here, '__fixtures__', 'rand.bin'))
    expect(bunzip2(bz).equals(raw)).toBe(true)
  })

  it('throws on bad magic', () => {
    expect(() => bunzip2(Buffer.from('not bzip at all'))).toThrow(/bad magic/)
  })

  it('throws on a corrupted body (CRC), never returns partial output', () => {
    const good = b64(FIXTURES[0].bz2)
    const bad = Buffer.from(good)
    bad[bad.length - 20] ^= 0xff
    expect(() => bunzip2(bad)).toThrow()
  })

  it('throws on truncated input', () => {
    const good = b64(FIXTURES[0].bz2)
    expect(() => bunzip2(good.subarray(0, good.length - 6))).toThrow()
  })
})
