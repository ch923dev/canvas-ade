/**
 * PTY-host discovery state — the pure half of client.ts (no electron import), so the pipe-name
 * derivation and the state-file repair are unit-testable under plain vitest/node.
 *
 * The state file (`ptyhost-state.json` in userData) is how a RELAUNCHED app finds the daemon a
 * previous run spawned: pipe name + token + pid, validated strictly — anything malformed reads
 * as "no daemon" and the client spawns fresh.
 */
import crypto from 'node:crypto'
import { PROTOCOL_VERSION } from './protocol'

/** Per-profile pipe name: the userData hash isolates dev/e2e/packaged instances; the random
 *  suffix rotates per daemon generation so a stale state file can never alias a new daemon. */
export function pipeNameFor(userDataDir: string, randomSuffix: string): string {
  const h = crypto.createHash('sha1').update(userDataDir).digest('hex').slice(0, 12)
  return `\\\\.\\pipe\\expanse-ptyhost-${h}-${randomSuffix}`
}

export interface PtyHostState {
  pipe: string
  token: string
  daemonPid: number
  protocolVersion: number
}

/** Validate a parsed state file — anything malformed reads as "no daemon". */
export function repairState(p: unknown): PtyHostState | null {
  if (typeof p !== 'object' || p === null) return null
  const o = p as Partial<Record<keyof PtyHostState, unknown>>
  if (
    typeof o.pipe === 'string' &&
    o.pipe.startsWith('\\\\.\\pipe\\expanse-ptyhost-') &&
    typeof o.token === 'string' &&
    o.token.length >= 32 &&
    typeof o.daemonPid === 'number' &&
    o.protocolVersion === PROTOCOL_VERSION
  ) {
    return {
      pipe: o.pipe,
      token: o.token,
      daemonPid: o.daemonPid,
      protocolVersion: o.protocolVersion
    }
  }
  return null
}
