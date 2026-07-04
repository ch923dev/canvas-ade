import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Encryptor } from '../llmKeyStore'
import { createMcpServersStore, validateSave, maskServer } from './mcpServersStore'
import type { ExternalMcpServer, SaveServerInput } from './types'

// Reversible non-crypto fake (mirrors llmKeyStore.test): tags plaintext so a test can prove the
// on-disk bytes are NOT the raw value while staying decryptable. `available` toggles the no-keyring path.
function fakeEncryptor(available = true): Encryptor {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from('ENC:' + plain, 'utf8'),
    decryptString: (enc) => enc.toString('utf8').replace(/^ENC:/, '')
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpservers-test-'))
})

const httpInput = (over: Partial<SaveServerInput> = {}): SaveServerInput => ({
  name: 'linear',
  enabled: true,
  transport: 'http',
  url: 'https://mcp.linear.app/sse',
  headers: [{ name: 'Authorization', value: 'Bearer secret-token' }],
  targets: ['claude', 'gemini'],
  ...over
})

const stdioInput = (over: Partial<SaveServerInput> = {}): SaveServerInput => ({
  name: 'github',
  enabled: true,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: [{ name: 'GITHUB_TOKEN', value: 'ghp_secret' }],
  targets: ['claude'],
  ...over
})

describe('validateSave', () => {
  const none: ExternalMcpServer[] = []
  it('accepts a valid http + stdio input', () => {
    expect(validateSave(httpInput(), none).ok).toBe(true)
    expect(validateSave(stdioInput(), none).ok).toBe(true)
  })
  it('rejects empty / invalid / reserved names', () => {
    expect(validateSave(httpInput({ name: '' }), none)).toMatchObject({ error: 'name-empty' })
    expect(validateSave(httpInput({ name: 'bad name!' }), none)).toMatchObject({
      error: 'name-invalid'
    })
    expect(validateSave(httpInput({ name: 'canvas-ade' }), none)).toMatchObject({
      error: 'name-reserved'
    })
  })
  it('rejects a duplicate name (but allows re-saving the same row)', () => {
    const existing: ExternalMcpServer[] = [
      { id: 'a', name: 'linear', enabled: true, transport: 'http', url: 'x', targets: [] }
    ]
    expect(validateSave(httpInput({ name: 'linear' }), existing)).toMatchObject({
      error: 'name-duplicate'
    })
    expect(validateSave(httpInput({ id: 'a', name: 'linear' }), existing).ok).toBe(true)
  })
  it('rejects bad urls and missing command', () => {
    expect(validateSave(httpInput({ url: '' }), none)).toMatchObject({ error: 'url-required' })
    expect(validateSave(httpInput({ url: 'ftp://x' }), none)).toMatchObject({
      error: 'url-invalid'
    })
    expect(validateSave(stdioInput({ command: '  ' }), none)).toMatchObject({
      error: 'command-required'
    })
  })
  it('rejects an unknown target CLI', () => {
    expect(validateSave(httpInput({ targets: ['claude', 'nope' as never] }), none)).toMatchObject({
      error: 'targets-invalid'
    })
  })
})

describe('createMcpServersStore', () => {
  it('round-trips a server; secrets decrypt only via getResolved', () => {
    const store = createMcpServersStore(dir, fakeEncryptor())
    const r = store.upsert(httpInput())
    expect(r.ok).toBe(true)
    const id = (r as { ok: true; id: string }).id
    const resolved = store.getResolved(id)
    expect(resolved?.headers?.[0]).toEqual({ name: 'Authorization', value: 'Bearer secret-token' })
  })

  it('never writes a secret value to disk (ciphertext only) and never masks it out', () => {
    const store = createMcpServersStore(dir, fakeEncryptor())
    store.upsert(stdioInput())
    const raw = readFileSync(join(dir, 'mcp-servers.json'), 'utf8')
    expect(raw).not.toContain('ghp_secret')
    const masked = store.listMasked()[0]
    expect(masked.env?.[0]).toEqual({ name: 'GITHUB_TOKEN', hasValue: true })
    expect(JSON.stringify(masked)).not.toContain('ghp_secret')
  })

  it('blank secret value on update KEEPS the stored secret', () => {
    const store = createMcpServersStore(dir, fakeEncryptor())
    const id = (store.upsert(httpInput()) as { ok: true; id: string }).id
    // Re-save with a blank Authorization value (the "leave blank to keep" path).
    store.upsert(httpInput({ id, headers: [{ name: 'Authorization', value: '' }] }))
    expect(store.getResolved(id)?.headers?.[0].value).toBe('Bearer secret-token')
  })

  it('a new non-empty secret without a keyring fails with encryption-unavailable', () => {
    const store = createMcpServersStore(dir, fakeEncryptor(false))
    expect(store.upsert(httpInput())).toMatchObject({
      ok: false,
      reason: 'encryption-unavailable'
    })
  })

  it('switching transport drops the other transport’s fields', () => {
    const store = createMcpServersStore(dir, fakeEncryptor())
    const id = (store.upsert(httpInput()) as { ok: true; id: string }).id
    store.upsert(stdioInput({ id, name: 'linear' }))
    const row = store.list()[0]
    expect(row.url).toBeUndefined()
    expect(row.headers).toBeUndefined()
    expect(row.command).toBe('npx')
  })

  it('setEnabled + remove + recordTest mutate as expected', () => {
    const store = createMcpServersStore(dir, fakeEncryptor())
    const id = (store.upsert(stdioInput()) as { ok: true; id: string }).id
    store.setEnabled(id, false)
    expect(store.listResolvedEnabled()).toHaveLength(0)
    store.recordTest(id, { ok: true, at: 123, toolCount: 5 })
    expect(store.listMasked()[0].lastTest).toEqual({ ok: true, at: 123, toolCount: 5 })
    store.remove(id)
    expect(store.list()).toHaveLength(0)
  })

  it('saving new config clears a stale lastTest', () => {
    const store = createMcpServersStore(dir, fakeEncryptor())
    const id = (store.upsert(stdioInput()) as { ok: true; id: string }).id
    store.recordTest(id, { ok: true, at: 1, toolCount: 2 })
    store.upsert(stdioInput({ id, args: ['-y', 'other'] }))
    expect(store.listMasked()[0].lastTest).toBeUndefined()
  })

  it('maskServer omits values but keeps names + presence', () => {
    const s: ExternalMcpServer = {
      id: '1',
      name: 'x',
      enabled: true,
      transport: 'http',
      url: 'https://x',
      headers: [
        { name: 'A', value: 'ENC:zzz' },
        { name: 'B', value: '' }
      ],
      targets: ['claude']
    }
    expect(maskServer(s).headers).toEqual([
      { name: 'A', hasValue: true },
      { name: 'B', hasValue: false }
    ])
  })
})
