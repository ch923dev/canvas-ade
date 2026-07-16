import { describe, it, expect } from 'vitest'
import { jarvisDefaults, type JarvisConfig } from './jarvisConfig'
import {
  HISTORY_PROMPT_WINDOW,
  composeMessages,
  composePersonaBlock,
  composeSystem,
  type JarvisTurn
} from './jarvisPersona'

const cfg = (over: Partial<JarvisConfig> = {}): JarvisConfig => ({ ...jarvisDefaults(), ...over })

describe('jarvisPersona (J3 prompt composition)', () => {
  it('identity carries the configured name', () => {
    expect(composePersonaBlock(cfg({ name: 'Friday' }))).toContain('You are Friday')
  })

  it('each preset swaps only the tone block', () => {
    const butler = composePersonaBlock(cfg({ tonePreset: 'butler' }))
    const mission = composePersonaBlock(cfg({ tonePreset: 'mission-control' }))
    const pair = composePersonaBlock(cfg({ tonePreset: 'pair-programmer' }))
    expect(butler).toContain('butler')
    expect(mission).toContain('mission control')
    expect(pair).toContain('pair programmer')
    // The spoken-style contract is present in all of them.
    for (const p of [butler, mission, pair]) {
      expect(p).toContain('text-to-speech')
      expect(p).toContain('no markdown')
    }
  })

  it('custom tone uses the free text; an empty custom falls back to butler', () => {
    expect(
      composePersonaBlock(cfg({ tonePreset: 'custom', customToneText: 'Talk like a pirate.' }))
    ).toContain('Talk like a pirate.')
    expect(composePersonaBlock(cfg({ tonePreset: 'custom', customToneText: '  ' }))).toContain(
      'butler'
    )
  })

  it('verbosity switches the response-length rule', () => {
    expect(composePersonaBlock(cfg({ verbosity: 'concise' }))).toContain(
      'ONE or TWO short sentences'
    )
    expect(composePersonaBlock(cfg({ verbosity: 'narrative' }))).toContain('short paragraph')
  })

  it('system: persona block first WITH the cache breakpoint, manifest after WITHOUT one', () => {
    const system = composeSystem(cfg(), 'Boards (2):\n- [abc] terminal "auth"')
    expect(system).toHaveLength(2)
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(system[0].text).toContain('You are Jarvis')
    expect(system[1].cache_control).toBeUndefined()
    expect(system[1].text).toContain('Workspace:')
  })

  it('system: no manifest → persona block only', () => {
    expect(composeSystem(cfg(), null)).toHaveLength(1)
    expect(composeSystem(cfg(), '  ')).toHaveLength(1)
  })

  it('system: a rolling history summary rides between persona and manifest (D4′)', () => {
    const system = composeSystem(cfg(), 'Boards (1):', false, 'User: earlier ask')
    expect(system).toHaveLength(3)
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' }) // prefix unchanged
    expect(system[1].text).toContain('Earlier conversation')
    expect(system[1].text).toContain('User: earlier ask')
    expect(system[1].cache_control).toBeUndefined()
    expect(system[2].text).toContain('Workspace:')
    // Empty/blank summary adds nothing.
    expect(composeSystem(cfg(), null, false, '')).toHaveLength(1)
    expect(composeSystem(cfg(), null, false, '  ')).toHaveLength(1)
  })

  it('messages: history window + the new user turn, oldest first', () => {
    const history: JarvisTurn[] = [
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'two' }
    ]
    expect(composeMessages(history, 'three')).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' }
    ])
  })

  it('messages: history beyond the window falls off the front', () => {
    const history: JarvisTurn[] = Array.from({ length: HISTORY_PROMPT_WINDOW + 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as JarvisTurn['role'],
      text: `t${i}`
    }))
    const msgs = composeMessages(history, 'new')
    expect(msgs).toHaveLength(HISTORY_PROMPT_WINDOW + 1)
    expect(msgs[0].content).toBe(`t${10}`)
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'new' })
  })
})
