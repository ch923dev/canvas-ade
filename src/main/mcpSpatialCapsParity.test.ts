import { describe, expect, it } from 'vitest'
import * as mcpPkg from '@expanse-ade/mcp'
import { GROUP_NAME_MAX } from '../shared/groupName'
import { MAX_CONTEXTS } from '../shared/deriveContexts'
import { SPAWN_GROUP_MAX_NAME } from './mcpLifecycle'
import { MAX_GROUP_BATCH, MAX_GROUP_MEMBERS } from './mcpGroups'
import { TIDY_ID_MAX, TIDY_MODES, TIDY_OVERFLOW, TILE_TEMPLATES } from '../shared/tidyContract'

/**
 * Cross-repo parity for the spatial wire (`@expanse-ade/mcp` 0.27.0, SPEC C6) — the
 * `mcpPlanningCapsParity.test.ts` pattern extended to the caps + vocabularies the package exports so
 * the host can pin them. A wire cap LOOSER than the host's lets a payload pass the schema and then
 * fail host-side; a wire vocabulary WIDER than the host's lets an agent pick a value the host has
 * never heard of. An export missing from the installed package SKIPS with a visible reason.
 *
 * The per-row `MAX_GROUP_MEMBERS` (50) is not `boardRegistry`'s 500, which bounds the MIRROR.
 * The tidy vocabularies pair with the SHARED `tidyContract.ts` (the one rule set MAIN and the
 * renderer applier both parse with, I2); its `TILE_TEMPLATES` ↔ the renderer's tile presets is
 * pinned on the renderer side (`layoutPresets.test.ts` — a renderer module cannot be imported
 * under this file's node tsconfig).
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
    ['MAX_GROUP_MEMBERS', MAX_GROUP_MEMBERS, 'mcpGroups MAX_GROUP_MEMBERS'],
    // tidy_canvas `primary` / `scope.groupId`: the wire's id cap = the shared contract's.
    ['MAX_FOCUS_TARGET_ID', TIDY_ID_MAX, 'shared/tidyContract TIDY_ID_MAX']
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

  // A wire vocabulary must equal the shared contract's exactly: wider lets an agent pick a value
  // the host rejects as unknown; narrower means a host mode no agent can reach.
  const vocabularies: Array<[string, readonly string[]]> = [
    ['TIDY_MODES', TIDY_MODES],
    ['TILE_TEMPLATES', TILE_TEMPLATES],
    ['TIDY_OVERFLOW', TIDY_OVERFLOW]
  ]
  for (const [name, host] of vocabularies) {
    it(`${name} matches shared/tidyContract ${name}`, () => {
      expect(new Set(pkg[name] as readonly string[])).toEqual(new Set(host))
    })
  }
})
