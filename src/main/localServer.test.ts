import { describe, it, expect } from 'vitest'
import { shouldStartLocalServer, startLocalServerIfNeeded } from './localServer'

/**
 * Audit R8 (P-4). The fixture server's URL has zero production consumers, so production must not
 * pay its loopback bind on the boot path — but the same server IS the host for 26 `@preview` e2e
 * specs, the smoke self-test, and hand-driven `pnpm dev` checks. This gate is the entire change,
 * and each `true` case below is a workflow that breaks silently if it flips.
 */
describe('shouldStartLocalServer', () => {
  const env = (e: { CANVAS_E2E?: string; CANVAS_SMOKE?: string } = {}): typeof e => e

  it('does NOT start in a production build — the bound port is read by nothing there', () => {
    expect(shouldStartLocalServer({ isDev: false, env: env() })).toBe(false)
  })

  it('starts under CANVAS_E2E (the 26 @preview specs load their pages from it)', () => {
    expect(shouldStartLocalServer({ isDev: false, env: env({ CANVAS_E2E: '1' }) })).toBe(true)
  })

  it('starts under CANVAS_SMOKE — both the keep-open ("1") and the exit flavors', () => {
    // runSelfTest(defaultPreviewUrl) is gated on CANVAS_SMOKE, which takes two values.
    expect(shouldStartLocalServer({ isDev: false, env: env({ CANVAS_SMOKE: '1' }) })).toBe(true)
    expect(shouldStartLocalServer({ isDev: false, env: env({ CANVAS_SMOKE: 'exit' }) })).toBe(true)
  })

  it('starts in dev so pnpm dev keeps serving /static, /download and /json (AUDIT §9 item 4)', () => {
    expect(shouldStartLocalServer({ isDev: true, env: env() })).toBe(true)
  })

  it('treats an empty env var as unset rather than as an opt-in', () => {
    expect(shouldStartLocalServer({ isDev: false, env: env({ CANVAS_E2E: '' }) })).toBe(false)
    expect(shouldStartLocalServer({ isDev: false, env: env({ CANVAS_SMOKE: '' }) })).toBe(false)
  })
})

describe('startLocalServerIfNeeded', () => {
  // The point of R8 is that production opens NO socket. Asserting the returned status alone would
  // pass even if a bind had happened, so this asserts the absence of a server object and a URL.
  it('binds nothing at all in a production build', async () => {
    const r = await startLocalServerIfNeeded({ isDev: false, env: {} })
    expect(r).toEqual({ server: null, url: '', status: 'skipped' })
  })

  it('binds on 127.0.0.1 and reports its URL where a consumer exists', async () => {
    const r = await startLocalServerIfNeeded({ isDev: true, env: {} })
    try {
      expect(r.status).toBe('started')
      expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(r.server?.port).toBeGreaterThan(0)
    } finally {
      r.server?.close()
    }
  })
})
