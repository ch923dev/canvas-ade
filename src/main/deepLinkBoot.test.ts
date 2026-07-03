/**
 * Deep-link router units (extracted from index.ts): the pre-ready buffer semantics —
 * valid links queue until connect(), then flush IN ORDER and route live afterwards;
 * malformed links are dropped at the door (parse validation is authDeepLink.test.ts's
 * job — here we only prove the router consults it).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { setAsDefaultProtocolClient: vi.fn(), on: vi.fn() } }))

import { createDeepLinkRouter } from './deepLinkBoot'

const VALID_A = 'expanse://auth/callback?code=a&state=s'
const VALID_B = 'expanse://auth/callback?code=b&state=s'

describe('createDeepLinkRouter — pre-ready buffer', () => {
  it('buffers valid links before connect, then flushes them in arrival order', () => {
    const router = createDeepLinkRouter(() => null)
    router.handle(VALID_A)
    router.handle(VALID_B)
    const sink = vi.fn()
    router.connect(sink)
    expect(sink.mock.calls.map((c) => c[0])).toEqual([VALID_A, VALID_B])
  })

  it('routes live after connect (no re-buffering), and drops malformed URLs always', () => {
    const router = createDeepLinkRouter(() => null)
    const sink = vi.fn()
    router.connect(sink)
    router.handle(VALID_A)
    expect(sink).toHaveBeenCalledTimes(1)
    router.handle('https://not-expanse.example/x')
    router.handle('garbage')
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('a malformed URL never enters the pre-connect buffer', () => {
    const router = createDeepLinkRouter(() => null)
    router.handle('https://not-expanse.example/x')
    const sink = vi.fn()
    router.connect(sink)
    expect(sink).not.toHaveBeenCalled()
  })
})
