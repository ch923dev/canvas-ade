/**
 * T-F5: kill the DEFAULT_MODELS drift class. main's `llmConfig.DEFAULT_MODELS` (the source
 * of truth) and the renderer's hand-mirrored `lib/llmModels.DEFAULT_MODELS` are kept in sync
 * by hand to avoid a renderer→main import in shipped code. This TEST is allowed to import both
 * (it never ships) and asserts they are deep-equal, so a one-sided edit fails CI instead of
 * silently shipping a stale Settings default. (Model ids re-verified current 2026-06-04:
 * openrouter google/gemini-2.5-flash · openai gpt-4.1-nano · anthropic claude-haiku-4-5.)
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_MODELS as MAIN_MODELS } from './llmConfig'
import { DEFAULT_MODELS as RENDERER_MODELS } from '../renderer/src/lib/llmModels'

describe('DEFAULT_MODELS lockstep (main ↔ renderer)', () => {
  it('the renderer mirror deep-equals the main source of truth', () => {
    expect({ ...RENDERER_MODELS }).toEqual({ ...MAIN_MODELS })
  })

  it('covers every provider in the main union (no missing/extra keys)', () => {
    expect(Object.keys(RENDERER_MODELS).sort()).toEqual(Object.keys(MAIN_MODELS).sort())
  })
})
