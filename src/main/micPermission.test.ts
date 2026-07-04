import { describe, it, expect } from 'vitest'
import {
  isAppUrl,
  permissionRequestDecision,
  permissionCheckDecision,
  registerMicPermissionPosture,
  type PermissionRequestDetailsLike,
  type PermissionCheckDetailsLike
} from './micPermission'

const DEV_ORIGIN = 'http://localhost:5173'
const DEV_URL = `${DEV_ORIGIN}/index.html?e2e=1`
const PACKAGED_URL = 'file:///C:/apps/expanse/resources/app.asar/out/renderer/index.html'

describe('isAppUrl', () => {
  it('dev: matches the dev-server origin regardless of path/query', () => {
    expect(isAppUrl(DEV_URL, DEV_ORIGIN)).toBe(true)
    expect(isAppUrl(`${DEV_ORIGIN}/`, DEV_ORIGIN)).toBe(true)
  })
  it('dev: rejects other origins AND stray file: URLs', () => {
    expect(isAppUrl('http://localhost:3000/', DEV_ORIGIN)).toBe(false)
    expect(isAppUrl('https://evil.example/', DEV_ORIGIN)).toBe(false)
    expect(isAppUrl(PACKAGED_URL, DEV_ORIGIN)).toBe(false)
  })
  it('packaged (null appOrigin): accepts file:, rejects http(s)', () => {
    expect(isAppUrl(PACKAGED_URL, null)).toBe(true)
    expect(isAppUrl('file:///', null)).toBe(true)
    expect(isAppUrl('http://localhost:5173/', null)).toBe(false)
    expect(isAppUrl('https://evil.example/', null)).toBe(false)
  })
  it('rejects absent/malformed URLs', () => {
    expect(isAppUrl(undefined, DEV_ORIGIN)).toBe(false)
    expect(isAppUrl('', null)).toBe(false)
    expect(isAppUrl('not a url', null)).toBe(false)
  })
})

describe('permissionRequestDecision', () => {
  const req = (
    permission: string,
    details: PermissionRequestDetailsLike = { requestingUrl: DEV_URL }
  ): boolean => permissionRequestDecision(permission, details, DEV_ORIGIN)

  it('grants media for an audio-only request from the app page', () => {
    expect(req('media', { requestingUrl: DEV_URL, mediaTypes: ['audio'] })).toBe(true)
  })
  it('denies media requests that include video (or name no types)', () => {
    expect(req('media', { requestingUrl: DEV_URL, mediaTypes: ['video'] })).toBe(false)
    expect(req('media', { requestingUrl: DEV_URL, mediaTypes: ['audio', 'video'] })).toBe(false)
    expect(req('media', { requestingUrl: DEV_URL, mediaTypes: [] })).toBe(false)
    expect(req('media', { requestingUrl: DEV_URL })).toBe(false)
  })
  it('grants clipboard-sanitized-write (renderer copy buttons)', () => {
    expect(req('clipboard-sanitized-write')).toBe(true)
  })
  it('denies every other permission (grant-all default is closed)', () => {
    for (const p of [
      'clipboard-read',
      'notifications',
      'geolocation',
      'fullscreen',
      'pointerLock',
      'keyboardLock',
      'openExternal',
      'display-capture',
      'midi',
      'midiSysex',
      'hid',
      'serial',
      'usb',
      'storage-access',
      'idle-detection',
      'window-management',
      'unknown-future-permission'
    ]) {
      expect(req(p)).toBe(false)
    }
  })
  it('denies audio for a non-app origin', () => {
    expect(
      permissionRequestDecision(
        'media',
        { requestingUrl: 'https://evil.example/', mediaTypes: ['audio'] },
        DEV_ORIGIN
      )
    ).toBe(false)
  })
  it('packaged: grants audio from the file: app document', () => {
    expect(
      permissionRequestDecision(
        'media',
        { requestingUrl: PACKAGED_URL, mediaTypes: ['audio'] },
        null
      )
    ).toBe(true)
  })
})

describe('permissionCheckDecision', () => {
  const check = (
    permission: string,
    details: PermissionCheckDetailsLike = {},
    origin: string = DEV_URL
  ): boolean => permissionCheckDecision(permission, origin, details, DEV_ORIGIN)

  it('allows audio media checks + typeless enumeration checks for the app page', () => {
    expect(check('media', { mediaType: 'audio' })).toBe(true)
    expect(check('media', {})).toBe(true) // enumerateDevices() — mic picker labels
  })
  it('denies video media checks', () => {
    expect(check('media', { mediaType: 'video' })).toBe(false)
  })
  it('allows clipboard-sanitized-write, denies the rest', () => {
    expect(check('clipboard-sanitized-write')).toBe(true)
    expect(check('clipboard-read')).toBe(false)
    expect(check('notifications')).toBe(false)
    expect(check('geolocation')).toBe(false)
  })
  it('denies everything for a non-app origin', () => {
    expect(check('media', { mediaType: 'audio' }, 'https://evil.example')).toBe(false)
    expect(check('clipboard-sanitized-write', {}, 'https://evil.example')).toBe(false)
  })
})

describe('registerMicPermissionPosture', () => {
  it('wires both handlers to the pure decisions', () => {
    let requestHandler:
      | ((
          wc: unknown,
          permission: string,
          cb: (granted: boolean) => void,
          details: PermissionRequestDetailsLike
        ) => void)
      | null = null
    let checkHandler:
      | ((
          wc: unknown,
          permission: string,
          requestingOrigin: string,
          details: PermissionCheckDetailsLike
        ) => boolean)
      | null = null
    registerMicPermissionPosture(
      {
        setPermissionRequestHandler: (h) => (requestHandler = h),
        setPermissionCheckHandler: (h) => (checkHandler = h)
      },
      DEV_ORIGIN
    )

    const granted: boolean[] = []
    requestHandler!(null, 'media', (g) => granted.push(g), {
      requestingUrl: DEV_URL,
      mediaTypes: ['audio']
    })
    requestHandler!(null, 'geolocation', (g) => granted.push(g), { requestingUrl: DEV_URL })
    expect(granted).toEqual([true, false])

    expect(checkHandler!(null, 'media', DEV_URL, { mediaType: 'audio' })).toBe(true)
    expect(checkHandler!(null, 'media', 'https://evil.example', { mediaType: 'audio' })).toBe(false)
  })
})
