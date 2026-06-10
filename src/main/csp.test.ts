import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEV_CSP, PROD_CSP, injectCspMeta } from './csp'

describe('CSP policy', () => {
  it('prod policy adds the hardening directives and blocks inline scripts', () => {
    expect(PROD_CSP).toContain("object-src 'none'")
    expect(PROD_CSP).toContain("base-uri 'self'")
    expect(PROD_CSP).toContain("frame-ancestors 'none'")
    expect(PROD_CSP).toContain("script-src 'self'")
    // The whole point of PROD: no inline-script execution (the real XSS vector).
    expect(PROD_CSP).not.toMatch(/script-src[^;]*'unsafe-inline'/)
  })

  it('dev policy keeps script unsafe-inline (Vite HMR) but still adds the hardening directives', () => {
    expect(DEV_CSP).toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(DEV_CSP).toContain("object-src 'none'")
    expect(DEV_CSP).toContain("base-uri 'self'")
    expect(DEV_CSP).toContain("frame-ancestors 'none'")
  })

  it('both keep style-src unsafe-inline (React inline style attrs cannot be nonced)', () => {
    expect(PROD_CSP).toMatch(/style-src[^;]*'unsafe-inline'/)
    expect(DEV_CSP).toMatch(/style-src[^;]*'unsafe-inline'/)
  })

  it('injectCspMeta swaps the meta content for the mode policy', () => {
    const html = '<meta http-equiv="Content-Security-Policy" content="PLACEHOLDER" />'
    expect(injectCspMeta(html, false)).toContain(PROD_CSP)
    expect(injectCspMeta(html, false)).not.toContain('PLACEHOLDER')
    expect(injectCspMeta(html, true)).toContain(DEV_CSP)
  })

  // BUG-021: a silent no-match would ship index.html's fallback (dev) CSP — with
  // script-src 'unsafe-inline' — in packaged builds. The function must throw instead.
  it('injectCspMeta throws loudly when no CSP meta tag matches', () => {
    const reshapes = [
      '<html><head></head></html>', // tag missing entirely
      '<meta content="X" http-equiv="Content-Security-Policy" />', // attributes reordered
      "<meta http-equiv='Content-Security-Policy' content='X' />", // single quotes
      '<meta http-equiv="Content-Security-Policy" id="csp" content="X" />' // extra attribute
    ]
    for (const html of reshapes) {
      expect(() => injectCspMeta(html, false)).toThrow(/CSP/)
      expect(() => injectCspMeta(html, true)).toThrow(/CSP/)
    }
  })

  // BUG-021: pin the REAL renderer index.html — if its meta tag is ever reshaped so the
  // build-time injection stops matching, this test (not a packaged-build audit) catches it.
  it('injectCspMeta matches the real src/renderer/index.html and injects the prod policy', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../renderer/index.html', import.meta.url)),
      'utf8'
    )
    const prod = injectCspMeta(html, false)
    // Assert on the content ATTRIBUTE (the index.html comment also mentions 'unsafe-inline').
    expect(prod).toContain(`content="${PROD_CSP}"`)
    expect(prod).not.toContain(`content="${DEV_CSP}"`)
    expect(injectCspMeta(html, true)).toContain(`content="${DEV_CSP}"`)
  })
})
