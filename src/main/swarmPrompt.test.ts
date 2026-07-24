import { describe, expect, it } from 'vitest'
import { composeSwarmSystem } from './swarmPrompt'
import { ROLE_PACKS } from '../shared/rolePacks'

/**
 * The orchestrator system prompt is a CONTRACT (07 §4) — these pins keep the load-bearing
 * rules from silently falling out of a later rewording.
 */
describe('composeSwarmSystem — 07 §4 rules are encoded', () => {
  const s = composeSwarmSystem(false)

  it('encodes the four-field task spec', () => {
    for (const f of ['objective', 'context', 'boundaries', 'outputFormat']) {
      expect(s).toContain(f)
    }
  })

  it('encodes the effort ladder (1 / 2-4 / 3-5 / 10+)', () => {
    expect(s).toMatch(/1 worker/i)
    expect(s).toContain('2-4')
    expect(s).toContain('3-5')
    expect(s).toContain('10+')
  })

  it('encodes write serialization as DISCLOSED (no silent caps)', () => {
    expect(s).toMatch(/AT MOST ONE write-role/i)
    expect(s).toMatch(/SAY SO/i)
  })

  it('encodes one-voice (never paste raw worker output)', () => {
    expect(s).toMatch(/never paste raw worker output/i)
  })

  it('encodes the human gate + denied-confirm acceptance', () => {
    expect(s).toMatch(/human confirmation/i)
    expect(s).toMatch(/do not retry/i)
  })

  it('lists every shipped role pack in the catalog', () => {
    for (const p of ROLE_PACKS) expect(s).toContain(`- ${p.id} `)
  })

  it('paused variant tells the model dispatch tools refuse', () => {
    expect(composeSwarmSystem(true)).toMatch(/RUN IS PAUSED/i)
  })
})
