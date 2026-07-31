import { describe, it, expect } from 'vitest'
import {
  MODEL_TIER_CLAUDE_ALIAS,
  ROLE_PACKS,
  WRITE_ROLE_CONCURRENCY_CAP,
  WRITE_ROLE_CONCURRENCY_CAP_SHARED,
  isWriteRolePack,
  launchLooksReadOnly,
  packDispatchPrompt,
  packOptionValues,
  rolePackById,
  validateRolePack,
  writeRoleConcurrencyCap,
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
  it('ships the five catalog packs with unique ids', () => {
    expect(ROLE_PACKS.map((p) => p.id)).toEqual([
      'builder',
      'code-reviewer',
      'explorer',
      'researcher',
      'planner'
    ])
    expect(new Set(ROLE_PACKS.map((p) => p.id)).size).toBe(ROLE_PACKS.length)
  })

  it('every catalog pack passes schema validation (validated data, not ad-hoc objects)', () => {
    for (const p of ROLE_PACKS) expect(validateRolePack(p)).toEqual([])
  })

  it('builder is the only write-posture pack; the four read packs are plan-mode', () => {
    expect(isWriteRolePack(pack('builder'))).toBe(true)
    for (const id of ['code-reviewer', 'explorer', 'researcher', 'planner']) {
      expect(isWriteRolePack(pack(id))).toBe(false)
      expect(pack(id).permissionMode).toBe('plan')
    }
  })

  it('every pack carries an entryCondition — the catalog routes by purpose, not by id-guessing', () => {
    for (const p of ROLE_PACKS) expect(p.entryCondition?.trim()).toBeTruthy()
  })

  it('explorer proves the cheap-read axis (cheap tier → haiku alias, read-only)', () => {
    expect(pack('explorer').model.tier).toBe('cheap')
    expect(MODEL_TIER_CLAUDE_ALIAS.cheap).toBe('haiku')
  })

  it('S3: the write cap is a FUNCTION of what actually provisioned, not a bare constant', () => {
    // 2 for writers that each hold their own worktree (07 §4.3), still 1 the moment one does not
    // — a cap raised past the isolation that justifies it is worse than no change at all.
    expect(WRITE_ROLE_CONCURRENCY_CAP).toBe(2)
    expect(WRITE_ROLE_CONCURRENCY_CAP_SHARED).toBe(1)
    expect(writeRoleConcurrencyCap(true)).toBe(2)
    expect(writeRoleConcurrencyCap(false)).toBe(1)
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

  it('researcher: mid tier + read posture (external-source work needs a mid model, not a cheap one)', () => {
    expect(composeCommand(claudePreset, packOptionValues(pack('researcher')))).toBe(
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

describe('launchLooksReadOnly (the gate reads the ACTUAL command — PR #381 review)', () => {
  it('accepts a command whose LAST --permission-mode is plan with no bypass flag', () => {
    expect(launchLooksReadOnly('claude --model haiku --permission-mode plan')).toBe(true)
    expect(launchLooksReadOnly('claude --permission-mode=plan')).toBe(true)
    expect(launchLooksReadOnly('claude --permission-mode plan --add-dir ../docs')).toBe(true)
    // Every read pack's own composed launch proves its posture.
    for (const id of ['code-reviewer', 'explorer', 'researcher', 'planner']) {
      expect(launchLooksReadOnly(composeCommand(claudePreset, packOptionValues(pack(id))))).toBe(
        true
      )
    }
  })

  it('fails CLOSED on anything else — bypass, mode changed, last-flag override, no flag, no cmd', () => {
    expect(
      launchLooksReadOnly('claude --permission-mode plan --dangerously-skip-permissions')
    ).toBe(false)
    expect(launchLooksReadOnly('claude --permission-mode bypassPermissions')).toBe(false)
    // The CLI honours the LAST flag — so must the check.
    expect(
      launchLooksReadOnly('claude --permission-mode plan --permission-mode bypassPermissions')
    ).toBe(false)
    expect(launchLooksReadOnly('claude --model haiku')).toBe(false)
    expect(launchLooksReadOnly('codex --full-auto')).toBe(false)
    expect(launchLooksReadOnly('')).toBe(false)
    expect(launchLooksReadOnly(undefined)).toBe(false)
  })
})

describe('packDispatchPrompt', () => {
  it('prepends the role brief; no pack = unchanged (Custom path)', () => {
    const p = packDispatchPrompt(pack('code-reviewer'), 'Review the diff on feat/x.')
    expect(p.startsWith(pack('code-reviewer').systemPrompt)).toBe(true)
    expect(p.endsWith('Review the diff on feat/x.')).toBe(true)
    expect(packDispatchPrompt(undefined, 'as-is')).toBe('as-is')
  })

  it('an edited brief override wins; an explicitly EMPTIED override means "no brief"', () => {
    // "What the user SAW is what ships": the dialog commits the editable brief with the config.
    const extended = pack('explorer').systemPrompt + ' Also list every caller you find.'
    expect(packDispatchPrompt(pack('explorer'), 'Where is the cap?', extended)).toBe(
      `${extended}\n\nWhere is the cap?`
    )
    expect(packDispatchPrompt(pack('explorer'), 'Where is the cap?', '   ')).toBe(
      'Where is the cap?'
    )
    // Absent override (pre-feature task) falls back to the pack default.
    expect(
      packDispatchPrompt(pack('explorer'), 'q', undefined).startsWith(pack('explorer').systemPrompt)
    ).toBe(true)
  })

  it('collapses to one gated-write-safe line through singleLinePrompt', () => {
    const line = singleLinePrompt(packDispatchPrompt(pack('builder'), 'Add the toggle.'))
    expect(line).not.toMatch(/[\r\n]/)
    expect(line).toContain('You are a Builder')
    expect(line).toContain('Add the toggle.')
  })
})

/**
 * Brief contract pins — the six-section template from the 2026-07-31 prompt-overhaul report
 * (docs/research/2026-07-31-swarm-prompt-overhaul.md §3.1). These keep the two incident fixes
 * (V1 subject-over-scoping, missing routing hints) from silently regressing in a reword.
 */
describe('role briefs — six-section template (2026-07-31 overhaul)', () => {
  it('every brief names write_result (the report contract) and stays inside the ride-along budget', () => {
    for (const p of ROLE_PACKS) {
      expect(p.systemPrompt).toContain('write_result')
      // The brief rides EVERY dispatch (packDispatchPrompt) — keep it collapsed-short (~120-word
      // target, hard ceiling here so growth is a deliberate decision, not drift).
      expect(singleLinePrompt(p.systemPrompt).split(' ').length).toBeLessThanOrEqual(180)
    }
  })

  it('every escape lane ends in a routing hint — a failed verdict must be orchestrator-actionable', () => {
    for (const p of ROLE_PACKS) {
      expect(p.systemPrompt).toMatch(/capability|researcher/i)
    }
  })

  it('explorer is capability-scoped to the workspace, not "this codebase" (V1 fix)', () => {
    const brief = pack('explorer').systemPrompt
    expect(brief).not.toMatch(/about this codebase/i)
    expect(brief).toMatch(/workspace/i)
    // Empty-project floor: a workspace lacking what the question assumes is a DONE finding.
    expect(brief).toMatch(/new or empty project/i)
    expect(brief).toMatch(/that is itself the finding/i)
    // The scope-mismatch verdict routes: web/library questions name the researcher.
    expect(brief).toMatch(/researcher/i)
  })

  it('researcher fills the catalog hole: external sources, read-only, sources-cited reports', () => {
    const p = pack('researcher')
    expect(p.systemPrompt).toMatch(/web search/i)
    expect(p.systemPrompt).toMatch(/never edit files/i)
    expect(p.confirmPolicy).toBe('session-consented') // Q4-legal: plan posture
    const props = p.reportSchema.properties as Record<string, unknown>
    expect(props.sources).toBeDefined() // explorer's shape with sources replacing refs
    expect(props.refs).toBeUndefined()
    expect(props.open_questions).toBeDefined()
    expect(props.confidence).toBeDefined()
  })

  it('code-reviewer keeps no-speculation but must not omit real findings (literal-conservatism guard)', () => {
    const brief = pack('code-reviewer').systemPrompt
    expect(brief).toMatch(/prefer no finding over a speculative one/i)
    expect(brief).toMatch(/every real problem you find at every severity/i)
  })
})
