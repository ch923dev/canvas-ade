/**
 * External MCP servers — point-in-time Test/connect probe (feature: add external MCP servers, Phase 4).
 *
 * Given a resolved (decrypted) external server, open a short-lived MCP client, run the handshake
 * (`initialize`) + `tools/list`, and report `{ ok, toolCount, detail }` — then tear the client down.
 * This is POINT-IN-TIME only: Expanse holds NO live connection (the agent CLI owns that); the result
 * is recorded as the server's `lastTest`. Uses the `@modelcontextprotocol/sdk` client already in the
 * tree (StreamableHTTP for http, stdio child for local commands).
 *
 * MAIN-only. The SDK client is imported directly here (electron-vite bundles it into the main
 * chunk). 🔒 A failure `detail` is a short, truncated message and NEVER echoes a header/env VALUE.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ResolvedServer } from './types'

export interface ProbeResult {
  ok: boolean
  toolCount?: number
  /** One short human line for the row — never contains a secret value. */
  detail?: string
}

const DEFAULT_TIMEOUT_MS = 10_000

/** A short, secret-free failure line (truncated). We surface the message text only, never values. */
function shortDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const oneLine = msg.replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? oneLine.slice(0, 197) + '…' : oneLine || 'connection failed'
}

/** Reject after `ms` so a hung endpoint can't wedge the Test. */
function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms)
    // Node's unref keeps the timer from holding the event loop open on its own.
    if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref()
  })
}

/** Build the SDK transport for a resolved server, or throw a secret-free error. */
function buildTransport(s: ResolvedServer): Transport {
  if (s.transport === 'http') {
    if (!s.url) throw new Error('No URL configured')
    const headers = Object.fromEntries((s.headers ?? []).map((h) => [h.name, h.value]))
    return new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers } })
  }
  if (!s.command) throw new Error('No command configured')
  // Merge the SDK's safe default env (so PATH etc. resolve the command) with the user's vars.
  const env = {
    ...getDefaultEnvironment(),
    ...Object.fromEntries((s.env ?? []).map((e) => [e.name, e.value]))
  }
  return new StdioClientTransport({ command: s.command, args: s.args ?? [], env })
}

/**
 * Connect to `server`, list its tools, and report the outcome. Never throws — every failure path
 * resolves to `{ ok:false, detail }`. The client is always closed in `finally` (a stdio child is
 * killed on close), bounded by `timeoutMs`.
 */
export async function probeExternalServer(
  server: ResolvedServer,
  opts: { timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let transport: Transport
  try {
    transport = buildTransport(server)
  } catch (err) {
    return { ok: false, detail: shortDetail(err) }
  }
  const client = new Client({ name: 'expanse-mcp-probe', version: '1.0.0' }, { capabilities: {} })
  try {
    await Promise.race([client.connect(transport), timeout(timeoutMs)])
    const listed = await Promise.race([client.listTools(), timeout(timeoutMs)])
    return { ok: true, toolCount: listed.tools.length }
  } catch (err) {
    return { ok: false, detail: shortDetail(err) }
  } finally {
    try {
      await client.close()
    } catch {
      /* best-effort teardown — a close error on an already-dead transport is irrelevant */
    }
  }
}
