import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import {
  createPkcePair,
  createState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  type FetchLike
} from './workosAuth'

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('createPkcePair', () => {
  it('derives the S256 challenge from the verifier (base64url, no padding)', () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/) // base64url alphabet only — no + / =
    expect(challenge).toBe(base64url(createHash('sha256').update(verifier).digest()))
  })

  it('produces a fresh verifier on each call', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier)
  })
})

describe('createState', () => {
  it('is a fresh base64url nonce each call', () => {
    const a = createState()
    const b = createState()
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
  })
})

describe('buildAuthorizeUrl', () => {
  it('builds the WorkOS authorize URL with PKCE + state', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'client_123',
        redirectUri: 'expanse://auth/callback',
        codeChallenge: 'CHALLENGE',
        state: 'STATE'
      })
    )
    expect(url.origin + url.pathname).toBe('https://api.workos.com/user_management/authorize')
    expect(url.searchParams.get('client_id')).toBe('client_123')
    expect(url.searchParams.get('redirect_uri')).toBe('expanse://auth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('provider')).toBe('authkit')
    expect(url.searchParams.get('state')).toBe('STATE')
  })
})

describe('exchangeCodeForTokens', () => {
  it('POSTs client_id + code + code_verifier (NO secret) and maps the response', async () => {
    let capturedUrl = ''
    let capturedBody: Record<string, unknown> = {}
    const fakeFetch: FetchLike = async (url, init) => {
      capturedUrl = url
      capturedBody = JSON.parse(init.body) as Record<string, unknown>
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: { id: 'user_1', email: 'a@b.com' },
          access_token: 'at',
          refresh_token: 'rt'
        }),
        text: async () => ''
      }
    }

    const result = await exchangeCodeForTokens(
      { clientId: 'client_123', code: 'CODE', codeVerifier: 'VERIFIER' },
      fakeFetch
    )

    expect(capturedUrl).toBe('https://api.workos.com/user_management/authenticate')
    expect(capturedBody).toEqual({
      client_id: 'client_123',
      grant_type: 'authorization_code',
      code: 'CODE',
      code_verifier: 'VERIFIER'
    })
    expect(capturedBody.client_secret).toBeUndefined() // public PKCE client — no secret
    expect(result).toEqual({
      user: { id: 'user_1', email: 'a@b.com' },
      accessToken: 'at',
      refreshToken: 'rt'
    })
  })

  it('throws on a non-OK HTTP response', async () => {
    const fakeFetch: FetchLike = async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => 'bad request'
    })
    await expect(
      exchangeCodeForTokens({ clientId: 'c', code: 'x', codeVerifier: 'v' }, fakeFetch)
    ).rejects.toThrow(/HTTP 400/)
  })

  it('throws when the response is missing tokens', async () => {
    const fakeFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: 'u', email: 'e@x.com' } }),
      text: async () => ''
    })
    await expect(
      exchangeCodeForTokens({ clientId: 'c', code: 'x', codeVerifier: 'v' }, fakeFetch)
    ).rejects.toThrow(/unexpected response shape/)
  })
})
