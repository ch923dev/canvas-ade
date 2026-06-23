import { describe, it, expect } from 'vitest'
import {
  isApiResource,
  registrableDomain,
  urlDomain,
  filterNetRecords,
  type FilterableRecord
} from './netFilter'

describe('isApiResource', () => {
  it('matches data calls case-insensitively (raw CDP types are capitalized), rejects assets/documents', () => {
    expect(isApiResource('Fetch')).toBe(true)
    expect(isApiResource('XHR')).toBe(true)
    expect(isApiResource('websocket')).toBe(true)
    expect(isApiResource('EventSource')).toBe(true)
    expect(isApiResource('Script')).toBe(false)
    expect(isApiResource('Stylesheet')).toBe(false)
    expect(isApiResource('Image')).toBe(false)
    expect(isApiResource('Font')).toBe(false)
    expect(isApiResource('Document')).toBe(false)
  })
})

describe('registrableDomain', () => {
  it('reduces subdomains to the registrable domain', () => {
    expect(registrableDomain('app.onlysales.io')).toBe('onlysales.io')
    expect(registrableDomain('api-temp.onlysales.io')).toBe('onlysales.io')
    expect(registrableDomain('onlysales.io')).toBe('onlysales.io')
    expect(registrableDomain('widget.intercom.io')).toBe('intercom.io')
  })
  it('keeps three labels for known second-level suffixes (co.uk / com.au)', () => {
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk')
    expect(registrableDomain('example.com.au')).toBe('example.com.au')
  })
  it('passes single-label hosts (localhost) through', () => {
    expect(registrableDomain('localhost')).toBe('localhost')
  })
})

describe('urlDomain', () => {
  it('strips scheme + port and returns the registrable domain; safe on junk', () => {
    expect(urlDomain('http://localhost:3000/home')).toBe('localhost')
    expect(urlDomain('https://api.onlysales.io/v1/users')).toBe('onlysales.io')
    expect(urlDomain('not a url')).toBe('')
  })
})

describe('filterNetRecords', () => {
  const recs: FilterableRecord[] = [
    { url: 'https://app.onlysales.io/api/users', type: 'Fetch' },
    { url: 'https://app.onlysales.io/assets/track.js', type: 'Script' },
    { url: 'https://api.segment.io/v1/track', type: 'Fetch' },
    { url: 'https://fonts.gstatic.com/s/x.woff2', type: 'Font' }
  ]
  it('API-only drops assets, keeps data calls from every origin', () => {
    const out = filterNetRecords(recs, { apiOnly: true, firstParty: false })
    expect(out.map((r) => r.url)).toEqual([
      'https://app.onlysales.io/api/users',
      'https://api.segment.io/v1/track'
    ])
  })
  it('first-party drops third-party origins, honoring app subdomains', () => {
    const out = filterNetRecords(recs, {
      apiOnly: false,
      firstParty: true,
      firstPartyDomain: 'onlysales.io'
    })
    expect(out.map((r) => r.url)).toEqual([
      'https://app.onlysales.io/api/users',
      'https://app.onlysales.io/assets/track.js'
    ])
  })
  it('both on → just the app’s own API', () => {
    const out = filterNetRecords(recs, {
      apiOnly: true,
      firstParty: true,
      firstPartyDomain: 'onlysales.io'
    })
    expect(out.map((r) => r.url)).toEqual(['https://app.onlysales.io/api/users'])
  })
  it('first-party is a no-op without a domain', () => {
    expect(filterNetRecords(recs, { apiOnly: false, firstParty: true })).toHaveLength(4)
  })
})
