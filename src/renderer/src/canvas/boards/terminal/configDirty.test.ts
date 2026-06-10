import { describe, it, expect } from 'vitest'
import { configDirty, type ConfigDraft } from './configDirty'

const board = {
  title: 'Terminal',
  shell: undefined as string | undefined,
  launchCommand: undefined as string | undefined,
  cwd: undefined as string | undefined
}

const clean: ConfigDraft = {
  title: 'Terminal',
  shell: '',
  shellTouched: false,
  launchCommand: '',
  cwd: ''
}

describe('configDirty (D2-B unsaved-changes guard)', () => {
  it('untouched draft is clean', () => {
    expect(configDirty(board, clean)).toBe(false)
  })

  it('whitespace-only title is clean (apply falls back to the board title)', () => {
    expect(configDirty(board, { ...clean, title: '   ' })).toBe(false)
  })

  it('a real title change is dirty', () => {
    expect(configDirty(board, { ...clean, title: 'Builds' })).toBe(true)
  })

  it('launchCommand typed is dirty; trimmed-to-empty stays clean', () => {
    expect(configDirty(board, { ...clean, launchCommand: 'claude' })).toBe(true)
    expect(configDirty(board, { ...clean, launchCommand: '   ' })).toBe(false)
  })

  it('launchCommand equal to the persisted value (modulo trim) is clean', () => {
    const b = { ...board, launchCommand: 'claude' }
    expect(configDirty(b, { ...clean, launchCommand: ' claude ' })).toBe(false)
    expect(configDirty(b, { ...clean, launchCommand: 'codex' })).toBe(true)
  })

  it('the display auto-seed (untouched shell select) is NOT an edit', () => {
    // The effect seeds the select to list[0] for display on a board with no explicit
    // shell — without shellTouched that must not read as dirty (the #9 respawn lesson).
    expect(configDirty(board, { ...clean, shell: 'C:/pwsh.exe' })).toBe(false)
  })

  it('a touched shell pick is dirty when it differs, clean when it matches', () => {
    expect(configDirty(board, { ...clean, shell: 'C:/pwsh.exe', shellTouched: true })).toBe(true)
    const b = { ...board, shell: 'C:/pwsh.exe' }
    expect(configDirty(b, { ...clean, shell: 'C:/pwsh.exe', shellTouched: true })).toBe(false)
  })

  it('cwd follows the same trim + empty→undefined normalization', () => {
    expect(configDirty(board, { ...clean, cwd: '  ' })).toBe(false)
    expect(configDirty(board, { ...clean, cwd: 'Z:/proj' })).toBe(true)
    expect(configDirty({ ...board, cwd: 'Z:/proj' }, { ...clean, cwd: ' Z:/proj ' })).toBe(false)
  })
})
