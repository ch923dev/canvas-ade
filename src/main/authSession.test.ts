import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSession, writeSession, clearSession, type SessionInfo } from './authSession'

const session: SessionInfo = {
  userId: 'user_123',
  email: 'you@email.com',
  expiresAt: 9999,
  plan: 'pro'
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'authsession-test-'))
})

describe('authSession', () => {
  it('write → read round-trips the session record', () => {
    writeSession(dir, session)
    expect(readSession(dir)).toEqual(session)
  })

  it('returns null when no session file exists', () => {
    expect(readSession(dir)).toBeNull()
  })

  it('returns null for a record missing required identity (userId/email)', () => {
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ plan: 'pro' }), 'utf8')
    expect(readSession(dir)).toBeNull()
  })

  it('returns null for a corrupt file rather than throwing', () => {
    writeFileSync(join(dir, 'session.json'), '{ not json', 'utf8')
    expect(readSession(dir)).toBeNull()
  })

  it('repairs an unknown plan to free', () => {
    writeFileSync(
      join(dir, 'session.json'),
      JSON.stringify({ userId: 'u', email: 'e@x.com', expiresAt: 1, plan: 'enterprise' }),
      'utf8'
    )
    expect(readSession(dir)?.plan).toBe('free')
  })

  it('clearSession makes the session read back as null', () => {
    writeSession(dir, session)
    clearSession(dir)
    expect(readSession(dir)).toBeNull()
  })
})
