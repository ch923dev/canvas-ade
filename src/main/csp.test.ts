import { describe, it, expect } from 'vitest'
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
})
