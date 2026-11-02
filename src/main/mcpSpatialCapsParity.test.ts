import { describe, expect, it } from 'vitest'
import * as mcpPkg from '@expanse-ade/mcp'
import { GROUP_NAME_MAX } from '../shared/groupName'
import { MAX_CONTEXTS } from '../shared/deriveContexts'
import { SPAWN_GROUP_MAX_NAME } from './mcpLifecycle'
import { MAX_GROUP_BATCH, MAX_GROUP_MEMBERS } from './mcpGroups'
import { PENDING_TIDY_MODES, SUPPORTED_TIDY_MODES } from './mcpTidy'

/**
 * Cross-repo parity for the spatial wire (`@expanse-ade/mcp` 0.27.0, SPEC C6) — the
 * `mcpPlanningCapsParity.test.ts` pattern extended to the caps + vocabularies the package exports so
 * the host can pin them. A wire cap LOOSER than the host's lets a payload pass the schema and then
 * fail host-side; a wire vocabulary WIDER than the host's lets an agent pick a value the host has
 * never heard of. An export missing from the installed package SKIPS with a visible reason.
 *
 * The per-row `MAX_GROUP_MEMBERS` (50) is not `boardRegistry`'s 500, which bounds the MIRROR.
 * `TILE_TEMPLATES` ↔ `layoutPresets.ts` pairs when I2 wires `mode:'tile'` (MAIN rejects it until
 * then, and a renderer module cannot be imported under this file's node tsconfig).
 */
describe('spatial caps ↔ @expanse-ade/mcp parity', () => {
  const pkg = mcpPkg as unknown as Record<string, unknown>
  const pairs: Array<[string, number, string]> = [
    // One group name, three host clamps: the shared sanitizer, spawn_group's, and the wire.
    ['GROUP_NAME_MAX', GROUP_NAME_MAX, 'shared/groupName GROUP_NAME_MAX'],
    ['SPAWN_GROUP_MAX_NAME', GROUP_NAME_MAX, 'shared/groupName GROUP_NAME_MAX'],
    ['SPAWN_GROUP_MAX_NAME', SPAWN_GROUP_MAX_NAME, 'mcpLifecycle SPAWN_GROUP_MAX_NAME'],
    // canvas://contexts: the package only serializes the host's deriveContexts digest.
    ['MAX_CONTEXTS', MAX_CONTEXTS, 'shared/deriveContexts MAX_CONTEXTS'],
    // group_boards / edit_groups: the wire's batch + member caps, re-checked host-side by mcpGroups.
    ['MAX_GROUP_BATCH', MAX_GROUP_BATCH, 'mcpGroups MAX_GROUP_BATCH'],
    ['MAX_GROUP_MEMBERS', MAX_GROUP_MEMBERS, 'mcpGroups MAX_GROUP_MEMBERS']
  ]
  for (const [name, hostValue, hostName] of pairs) {
    it(`${name} matches ${hostName}`, ({ skip }) => {
      const wire = pkg[name]
      if (wire === undefined) {
        skip(`installed @expanse-ade/mcp predates the ${name} export — bump the pin to arm`)
        return
      }
      expect(wire).toBe(hostValue)
    })
  }

  it('every TIDY_MODES value is one the host either runs or rejects as "not supported yet"', () => {
    // A new wire mode must be a deliberate host decision, never an "unknown mode" surprise. Once I2
    // wires fit/roles/tile, PENDING empties into SUPPORTED and this stays green unchanged.
    const host = new Set<string>([...SUPPORTED_TIDY_MODES, ...PENDING_TIDY_MODES])
    expect(new Set(mcpPkg.TIDY_MODES)).toEqual(host)
  })
})
