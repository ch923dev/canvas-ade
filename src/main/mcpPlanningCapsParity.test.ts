import { describe, expect, it } from 'vitest'
import * as mcpPkg from '@expanse-ade/mcp'
import {
  SPEC_DETAIL_MAX,
  SPEC_EDGE_LABEL_MAX,
  SPEC_HREF_FILE_MAX,
  SPEC_ICON_MAX,
  SPEC_ID_MAX,
  SPEC_LABEL_MAX,
  SPEC_MAX_EDGES,
  SPEC_MAX_GROUPS,
  SPEC_MAX_NODES,
  SPEC_THEME_MAX,
  SPEC_TITLE_MAX
} from '@expanse-ade/diagram/spec'
import {
  MAX_DIAGRAM_SPEC_BYTES,
  MAX_PLANNING_DIAGRAM,
  MAX_PLANNING_ELEMENTS,
  MAX_PLANNING_ITEMS,
  MAX_PLANNING_LABEL,
  MAX_PLANNING_SECTION,
  MAX_PLANNING_TEXT,
  MAX_PLANNING_TITLE
} from './mcpPlanning'
import { MAX_SPEC_OPS } from './mcpPlanningEdit'

/**
 * Cross-repo caps parity (diagram Phase 3) — the MAIN-authoritative planning + DiagramSpec caps
 * MUST equal the @expanse-ade/mcp transport caps, exactly like the kanban MAX_CARD_* guard
 * (mcpKanban.test.ts): a wire cap LOOSER than the host lets a payload ack `true` on the wire and
 * then get rejected here. The package exports these from ≥0.21.0; on an older installed package an
 * entry reads `undefined` and SKIPS with a visible reason, so the guard arms the moment the pin
 * bumps — never blocks an old-pin checkout.
 */
describe('planning + diagram-spec caps ↔ @expanse-ade/mcp parity', () => {
  const pkg = mcpPkg as unknown as Record<string, number | undefined>
  const pairs: Array<[string, number]> = [
    // Planning-element transport caps (package name → host value; the per-call element cap is
    // named MAX_PLANNING_ELEMENTS_PER_CALL on the wire, MAX_PLANNING_ELEMENTS host-side).
    ['MAX_PLANNING_ELEMENTS_PER_CALL', MAX_PLANNING_ELEMENTS],
    ['MAX_PLANNING_ITEMS', MAX_PLANNING_ITEMS],
    ['MAX_PLANNING_TEXT', MAX_PLANNING_TEXT],
    ['MAX_PLANNING_TITLE', MAX_PLANNING_TITLE],
    ['MAX_PLANNING_LABEL', MAX_PLANNING_LABEL],
    ['MAX_PLANNING_DIAGRAM', MAX_PLANNING_DIAGRAM],
    ['MAX_PLANNING_SECTION', MAX_PLANNING_SECTION],
    // Structured-diagram caps — NAME-FOR-NAME mirrors of @expanse-ade/diagram/spec (extracted from lib/diagramSpec.ts).
    ['SPEC_MAX_NODES', SPEC_MAX_NODES],
    ['SPEC_MAX_EDGES', SPEC_MAX_EDGES],
    ['SPEC_MAX_GROUPS', SPEC_MAX_GROUPS],
    ['SPEC_ID_MAX', SPEC_ID_MAX],
    ['SPEC_LABEL_MAX', SPEC_LABEL_MAX],
    ['SPEC_DETAIL_MAX', SPEC_DETAIL_MAX],
    ['SPEC_EDGE_LABEL_MAX', SPEC_EDGE_LABEL_MAX],
    ['SPEC_TITLE_MAX', SPEC_TITLE_MAX],
    ['SPEC_ICON_MAX', SPEC_ICON_MAX],
    ['SPEC_HREF_FILE_MAX', SPEC_HREF_FILE_MAX],
    ['SPEC_THEME_MAX', SPEC_THEME_MAX],
    // The 16 KB confirm-reviewability bound + the specOps reviewability bound.
    ['MAX_DIAGRAM_SPEC_BYTES', MAX_DIAGRAM_SPEC_BYTES],
    ['MAX_SPEC_OPS', MAX_SPEC_OPS]
  ]
  for (const [name, hostValue] of pairs) {
    it(`${name} matches the package transport cap`, ({ skip }) => {
      const wire = pkg[name]
      if (wire === undefined) {
        skip(`installed @expanse-ade/mcp predates the ${name} export — bump the pin to arm`)
        return
      }
      expect(wire).toBe(hostValue)
    })
  }
})
