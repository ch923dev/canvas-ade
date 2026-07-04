/**
 * External MCP servers — the encrypted registry store (Phase 1).
 *
 * Persists user-registered external MCP servers to `<userData>/mcp-servers.json` (atomic, 0o600 —
 * NEVER the project folder). Secret VALUES (header + env values) are encrypted at rest via an
 * injected {@link Encryptor} (Electron's `safeStorage`, passed from index.ts — kept out of this
 * module so it unit-tests without Electron, exactly like `llmKeyStore`). Plaintext secrets exist
 * only transiently in MAIN: `getResolved` decrypts immediately before a config write or a Test, and
 * the renderer only ever receives {@link MaskedServer} (names + presence, never values).
 *
 * 🔒 Secret values are never logged and never cross to the renderer.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { chmodSync } from 'node:fs'
import type { Encryptor } from '../llmKeyStore'
import { SERVER_NAME, type CliId } from '../cliProvisioners/shared'
import type {
  ExternalMcpServer,
  ExternalMcpTestResult,
  MaskedSecret,
  MaskedServer,
  NamedSecret,
  ResolvedServer,
  SaveResult,
  SaveServerInput,
  Transport
} from './types'

const CLI_SET: readonly CliId[] = ['claude', 'codex', 'gemini', 'opencode']
/** Config-key rule: a safe ident across a JSON key AND a TOML table header (`[mcp_servers.<name>]`). */
const NAME_RE = /^[A-Za-z0-9_.-]+$/

interface StoreFile {
  version: 1
  servers: ExternalMcpServer[]
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'mcp-servers.json')
}

/** Read the registry, tolerating an absent/corrupt file (→ empty, mirrors `llmKeyStore`). */
function readFile(userDataDir: string): StoreFile {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return { version: 1, servers: [] }
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as StoreFile).servers)) {
      return { version: 1, servers: (parsed as StoreFile).servers }
    }
  } catch {
    console.warn('[mcpServersStore] mcp-servers.json unreadable — starting from empty')
  }
  return { version: 1, servers: [] }
}

/** Write the registry atomically, owner-only (0o600). chmod after write closes a pre-existing lax mode. */
function writeFile(userDataDir: string, data: StoreFile): void {
  mkdirSync(userDataDir, { recursive: true })
  const f = fileFor(userDataDir)
  writeFileAtomic.sync(f, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(f, 0o600)
  } catch {
    /* best-effort — Windows has no POSIX perms */
  }
}

// ── Validation (pure — shared by upsert + the IPC layer + tests) ────────────────────────────────

export type ValidationError =
  | 'name-empty'
  | 'name-invalid'
  | 'name-reserved'
  | 'name-duplicate'
  | 'url-required'
  | 'url-invalid'
  | 'command-required'
  | 'targets-invalid'

/** Validate a save input against the existing rows (excluding the row being updated). Pure. */
export function validateSave(
  input: SaveServerInput,
  existing: readonly ExternalMcpServer[]
): { ok: true } | { ok: false; error: ValidationError } {
  const name = input.name?.trim() ?? ''
  if (name === '') return { ok: false, error: 'name-empty' }
  if (!NAME_RE.test(name)) return { ok: false, error: 'name-invalid' }
  if (name === SERVER_NAME) return { ok: false, error: 'name-reserved' }
  if (existing.some((s) => s.id !== input.id && s.name === name)) {
    return { ok: false, error: 'name-duplicate' }
  }
  if (input.transport === 'http') {
    const url = input.url?.trim() ?? ''
    if (url === '') return { ok: false, error: 'url-required' }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, error: 'url-invalid' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'url-invalid' }
    }
  } else {
    if ((input.command?.trim() ?? '') === '') return { ok: false, error: 'command-required' }
  }
  if (!Array.isArray(input.targets) || input.targets.some((t) => !CLI_SET.includes(t))) {
    return { ok: false, error: 'targets-invalid' }
  }
  return { ok: true }
}

// ── Masking (never leaks a secret value) ────────────────────────────────────────────────────────

function maskSecrets(list: NamedSecret[] | undefined): MaskedSecret[] | undefined {
  return list?.map((s) => ({ name: s.name, hasValue: s.value !== '' }))
}

export function maskServer(s: ExternalMcpServer): MaskedServer {
  return {
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    transport: s.transport,
    url: s.url,
    command: s.command,
    args: s.args,
    headers: maskSecrets(s.headers),
    env: maskSecrets(s.env),
    targets: s.targets,
    lastTest: s.lastTest
  }
}

// ── Store ───────────────────────────────────────────────────────────────────────────────────────

export interface McpServersStore {
  /** Raw rows (MAIN-only — ciphertext secrets). */
  list(): ExternalMcpServer[]
  /** Renderer-safe rows (secret values omitted). */
  listMasked(): MaskedServer[]
  /** Enabled rows with secrets DECRYPTED — MAIN-only, for writers + Test. */
  listResolvedEnabled(): ResolvedServer[]
  /** One row with secrets decrypted, or undefined. MAIN-only. */
  getResolved(id: string): ResolvedServer | undefined
  /** Create (no id) or update (id present). Blank secret value = keep the stored one. */
  upsert(input: SaveServerInput): SaveResult
  remove(id: string): void
  setEnabled(id: string, on: boolean): void
  recordTest(id: string, result: ExternalMcpTestResult): void
}

export function createMcpServersStore(userDataDir: string, encryptor: Encryptor): McpServersStore {
  const encrypt = (plain: string): string => encryptor.encryptString(plain).toString('base64')
  const decrypt = (name: string, enc: string): string => {
    if (enc === '') return ''
    if (!encryptor.isEncryptionAvailable()) {
      console.warn(`[mcpServersStore] secret "${name}" present but no keyring — treating as empty`)
      return ''
    }
    try {
      return encryptor.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      console.warn(`[mcpServersStore] secret "${name}" failed to decrypt — treating as empty`)
      return ''
    }
  }
  const resolveSecrets = (list: NamedSecret[] | undefined): NamedSecret[] | undefined =>
    list?.map((s) => ({ name: s.name, value: decrypt(s.name, s.value) }))

  const toResolved = (s: ExternalMcpServer): ResolvedServer => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    transport: s.transport,
    url: s.url,
    headers: resolveSecrets(s.headers),
    command: s.command,
    args: s.args,
    env: resolveSecrets(s.env),
    targets: s.targets
  })

  /**
   * Build the persisted secret list for a save: a non-empty value is (re-)encrypted; a blank value
   * KEEPS the prior ciphertext when the name existed before (the "leave blank to keep" contract),
   * else persists as empty. Returns null if a NEW non-empty secret needs encryption but none is
   * available (the caller maps that to `encryption-unavailable`).
   */
  const persistSecrets = (
    next: NamedSecret[] | undefined,
    prev: NamedSecret[] | undefined
  ): NamedSecret[] | null | undefined => {
    if (!next) return undefined
    const prevByName = new Map((prev ?? []).map((s) => [s.name, s.value]))
    const out: NamedSecret[] = []
    for (const s of next) {
      if (s.value !== '') {
        if (!encryptor.isEncryptionAvailable()) return null
        out.push({ name: s.name, value: encrypt(s.value) })
      } else {
        out.push({ name: s.name, value: prevByName.get(s.name) ?? '' })
      }
    }
    return out
  }

  return {
    list() {
      return readFile(userDataDir).servers
    },
    listMasked() {
      return readFile(userDataDir).servers.map(maskServer)
    },
    listResolvedEnabled() {
      return readFile(userDataDir)
        .servers.filter((s) => s.enabled)
        .map(toResolved)
    },
    getResolved(id) {
      const s = readFile(userDataDir).servers.find((x) => x.id === id)
      return s ? toResolved(s) : undefined
    },
    upsert(input): SaveResult {
      const store = readFile(userDataDir)
      const v = validateSave(input, store.servers)
      if (!v.ok) return { ok: false, reason: 'validation', detail: v.error }

      const prev = input.id ? store.servers.find((s) => s.id === input.id) : undefined
      const headers = persistSecrets(input.headers, prev?.headers)
      const env = persistSecrets(input.env, prev?.env)
      if (headers === null || env === null) {
        return { ok: false, reason: 'encryption-unavailable' }
      }

      const name = input.name.trim()
      const isHttp: boolean = input.transport === 'http'
      const row: ExternalMcpServer = {
        id: prev?.id ?? randomUUID(),
        name,
        enabled: input.enabled,
        transport: input.transport as Transport,
        // Keep only the fields for the active transport so a toggle doesn't leave stale config.
        url: isHttp ? input.url?.trim() : undefined,
        headers: isHttp ? headers : undefined,
        command: isHttp ? undefined : input.command?.trim(),
        args: isHttp ? undefined : input.args,
        env: isHttp ? undefined : env,
        targets: input.targets,
        // Config changed ⇒ the prior test result is stale; drop it (a fresh Test re-establishes it).
        lastTest: undefined
      }

      const servers = prev
        ? store.servers.map((s) => (s.id === prev.id ? row : s))
        : [...store.servers, row]
      writeFile(userDataDir, { version: 1, servers })
      return { ok: true, id: row.id }
    },
    remove(id) {
      const store = readFile(userDataDir)
      const servers = store.servers.filter((s) => s.id !== id)
      if (servers.length !== store.servers.length) writeFile(userDataDir, { version: 1, servers })
    },
    setEnabled(id, on) {
      const store = readFile(userDataDir)
      let changed = false
      const servers = store.servers.map((s) => {
        if (s.id !== id || s.enabled === on) return s
        changed = true
        return { ...s, enabled: on }
      })
      if (changed) writeFile(userDataDir, { version: 1, servers })
    },
    recordTest(id, result) {
      const store = readFile(userDataDir)
      let changed = false
      const servers = store.servers.map((s) => {
        if (s.id !== id) return s
        changed = true
        return { ...s, lastTest: result }
      })
      if (changed) writeFile(userDataDir, { version: 1, servers })
    }
  }
}
