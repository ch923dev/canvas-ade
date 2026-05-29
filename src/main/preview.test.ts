import { describe, it, expect } from 'vitest'
import { isErrorResponseCode } from './preview'

// Bug #5: a dead/refused URL loads a Chromium error page whose did-finish-load must
// not flip the board back to "connected". The httpResponseCode from did-navigate is
// the secondary failure signal alongside the did-fail-load latch.
describe('isErrorResponseCode', () => {
  it('treats 0 (error page commit) as a failure', () => {
    expect(isErrorResponseCode(0)).toBe(true)
  })

  it('treats >= 400 (HTTP error page) as a failure', () => {
    expect(isErrorResponseCode(400)).toBe(true)
    expect(isErrorResponseCode(404)).toBe(true)
    expect(isErrorResponseCode(500)).toBe(true)
    expect(isErrorResponseCode(503)).toBe(true)
  })

  it('treats -1 (non-HTTP navigation: file:/about:) as a normal load', () => {
    expect(isErrorResponseCode(-1)).toBe(false)
  })

  it('treats 2xx / 3xx as a normal load', () => {
    expect(isErrorResponseCode(200)).toBe(false)
    expect(isErrorResponseCode(204)).toBe(false)
    expect(isErrorResponseCode(301)).toBe(false)
    expect(isErrorResponseCode(302)).toBe(false)
    expect(isErrorResponseCode(399)).toBe(false)
  })
})
