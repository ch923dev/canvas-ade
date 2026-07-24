import { describe, it, expect } from 'vitest'
import {
  MODEL_TIER_CLAUDE_ALIAS,
  ROLE_PACKS,
  WRITE_ROLE_CONCURRENCY_CAP,
  isWriteRolePack,
  packDispatchPrompt,
  packOptionValues,
  rolePackById,
  validateRolePack,
  type RolePack
} from './rolePacks'
import { AGENT_PRESETS, presetById } from '../canvas/boards/terminal/agentPresets'
import { composeCommand } from '../canvas/boards/terminal/composeCommand'
import { singleLinePrompt } from './commandDispatch'

const claudePreset = presetById('claude') ?? AGENT_PRESETS[0]
const pack = (id: string): RolePack => {
  const p = rolePackById(id)
  if (!p) throw new Error(`catalog pack missing: ${id}`)
  return p
}

describe('ROLE_PACKS catalog', () => {
  it('ships the four Phase-0 packs with unique ids', () => {
    expect(ROLE_PACKS.map((p) => p.id)).toEqual(['builder', 'code-reviewer', 'explorer', 'planner'])
    expect(new Set(ROLE_PACKS.map((p) => p.id)).size).toBe(ROLE_PACKS.length)
  })

  it('every catalog pack passes schema validation (validated data, not ad-hoc objects)', () => {
    for (const p of ROLE_PACKS) expect(validateRolePack(p)).toEqual([])
  })

  it('builder is the only write-posture pack; the three read packs are plan-mode', () => {
    expect(isWriteRolePack(pack('builder'))).toBe(true)
    for (const id of ['code-reviewer', 'explorer', 'planner']) {
      expect(isWriteRolePack(pack(id))).toBe(false)
      expect(pack(id).permissionMode).toBe('plan')
    }
  })

  it('explorer proves the cheap-read axis (cheap tier → haiku alias, read-only)', () => {
    expect(pack('explorer').model.tier).toBe('cheap')
    expect(MODEL_TIER_CLAUDE_ALIAS.cheap).toBe('haiku')
  })

  it('the write cap is 1 until worktree isolation lands (Phase 3)', () => {
    expect(WRITE_ROLE_CONCURRENCY_CAP).toBe(1)
  })

  it('rolePackById resolves catalog ids and returns undefined for Custom/unknown', () => {
    expect(rolePackById('builder')?.name).toBe('Builder')
    expect(rolePackById('nope')).toBeUndefined()
    expect(rolePackById(undefined)).toBeUndefined()
    expect(rolePackById(null)).toBeUndefined()
  })
})

describe('validateRolePack', () => {
  it('rejects a non-object and enumerates missing/invalid fields', () => {
    expect(validateRolePack(null)).toEqual(['pack must be an object'])
    const errors = validateRolePack({})
    expect(errors).toContain('id must be a non-empty string')
    expect(errors).toContain('tier must be lead|connected|worker')
    expect(errors).toContain('model must be an object')
    expect(errors).toContain('systemPrompt must be a non-empty string')
    expect(errors).toContain('acceptance must be an object')
  })

  it('rejects bad enum values + malformed optional fields', () => {
    const errors = validateRolePack({
      ...pack('explorer'),
      permissionMode: 'yolo',
      model: { tier: 'huge', effort: 'extreme', pin: '  ' },
      isolation: 'vm',
      confirmPolicy: 'never-ask',
      domainHint: '   '
    })
    expect(errors).toContain('permissionMode must be plan|default|acceptEdits|bypassPermissions')
    expect(errors).toContain('model.tier must be cheap|mid|expensive')
    expect(errors).toContain('model.effort must be low|medium|high when set')
    expect(errors).toContain('model.pin must be a non-empty string when set')
    expect(errors).toContain('isolation must be none|worktree')
    expect(errors).toContain('confirmPolicy must be per-write|batch|session-consented')
    expect(errors).toContain('domainHint must be a non-empty string when set')
  })

  it('enforces Q4: session-consented autonomy is read-only-only', () => {
    // A write-posture pack pre-consented for a session would autonomously write the host — refused.
    const errors = validateRolePack({ ...pack('builder'), confirmPolicy: 'session-consented' })
    expect(errors).toEqual([
      'confirmPolicy session-consented requires the read-only permissionMode plan (Q4)'
    ])
    // The same policy on a plan-mode pack is fine (code-reviewer/explorer ship it).
    expect(validateRolePack(pack('code-reviewer'))).toEqual([])
  })
})

describe('packOptionValues → composeCommand (the launch is DATA through the existing pipeline)', () => {
  it('builder: mid tier + bypass posture → the trust-gate-clearing worker default', () => {
    expect(packOptionValues(pack('builder'))).toEqual({
      model: 'sonnet',
      'skip-permissions': true
    })
    expect(composeCommand(claudePreset, packOptionValues(pack('builder')))).toBe(
      'claude --model sonnet --dangerously-skip-permissions'
    )
  })

  it('code-reviewer: expensive tier + read posture', () => {
    expect(composeCommand(claudePreset, packOptionValues(pack('code-reviewer')))).toBe(
      'claude --model opus --permission-mode plan'
    )
  })

  it('explorer: cheap tier + low effort + read posture (proof criterion 2)', () => {
    expect(composeCommand(claudePreset, packOptionValues(pack('explorer')))).toBe(
      'claude --model haiku --effort low --permission-mode plan'
    )
  })

  it('planner: mid tier + read posture', () => {
    expect(composeCommand(claudePreset, packOptionValues(pack('planner')))).toBe(
      'claude --model sonnet --permission-mode plan'
    )
  })

  it('model.pin wins over the tier alias', () => {
    const pinned: RolePack = {
      ...pack('explorer'),
      model: { tier: 'cheap', pin: 'claude-haiku-4-5-20251001' }
    }
    expect(packOptionValues(pinned).model).toBe('claude-haiku-4-5-20251001')
  })

  it('swapping the pack swaps launch + posture with ZERO code fork (proof criterion 1)', () => {
    // Same function, same preset, same composition path — only the data differs.
    const build = composeCommand(claudePreset, packOptionValues(pack('builder')))
    const review = composeCommand(claudePreset, packOptionValues(pack('code-reviewer')))
    expect(build).not.toBe(review)
    expect(build).toContain('--dangerously-skip-permissions') // write posture
    expect(review).toContain('--permission-mode plan') // read posture
  })
})

describe('packDispatchPrompt', () => {
  it('prepends the role brief; no pack = unchanged (Custom path)', () => {
    const p = packDispatchPrompt(pack('code-reviewer'), 'Review the diff on feat/x.')
    expect(p.startsWith(pack('code-reviewer').systemPrompt)).toBe(true)
    expect(p.endsWith('Review the diff on feat/x.')).toBe(true)
    expect(packDispatchPrompt(undefined, 'as-is')).toBe('as-is')
  })

  it('collapses to one gated-write-safe line through singleLinePrompt', () => {
    const line = singleLinePrompt(packDispatchPrompt(pack('builder'), 'Add the toggle.'))
    expect(line).not.toMatch(/[\r\n]/)
    expect(line).toContain('BUILDER worker')
    expect(line).toContain('Add the toggle.')
  })
})
