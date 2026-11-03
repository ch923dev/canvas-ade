import { describe, it, expect } from 'vitest'
import { isNewerAppRequiredError } from './openError'
import { fromObject } from './boardSchema'
import { SCHEMA_VERSION } from './boardSchemaVersion'

/** The message fromObject throws for a doc whose compat floor is above this build. */
function newerDocMessage(): string {
  const next = SCHEMA_VERSION + 1
  try {
    fromObject({ schemaVersion: next, minReaderVersion: next, viewport: {}, boards: [] })
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('expected fromObject to refuse an above-floor doc')
}

describe('isNewerAppRequiredError', () => {
  it('matches the real "saved by a newer version" refusal (ADR 0007)', () => {
    expect(isNewerAppRequiredError(newerDocMessage())).toBe(true)
  })

  it('rejects every other open failure and empty values', () => {
    expect(isNewerAppRequiredError('ENOSPC: no space left on device')).toBe(false)
    expect(isNewerAppRequiredError('fromObject: value is not a CanvasDoc')).toBe(false)
    expect(isNewerAppRequiredError('')).toBe(false)
    expect(isNewerAppRequiredError(null)).toBe(false)
    expect(isNewerAppRequiredError(undefined)).toBe(false)
  })
})
