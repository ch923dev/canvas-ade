import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readProject, writeProject, createProject } from './projectStore'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-proj-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const doc = { schemaVersion: 2, viewport: null, boards: [] }

describe('projectStore', () => {
  it('createProject writes a fresh empty doc', () => {
    const r = createProject(dir, 'My Proj', {})
    expect(r.ok).toBe(true)
    expect(existsSync(join(dir, 'canvas.json'))).toBe(true)
  })

  it('createProject reuses an existing canvas.json (no overwrite)', () => {
    writeFileSync(
      join(dir, 'canvas.json'),
      JSON.stringify({ schemaVersion: 2, viewport: null, boards: [{ keep: true }] })
    )
    const r = createProject(dir, 'My Proj', {})
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.doc as { boards: unknown[] }).boards).toHaveLength(1)
  })

  it('write then read round-trips', async () => {
    await writeProject(dir, doc)
    const r = readProject(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc).toEqual(doc)
  })

  it('rotates the prior good file to canvas.json.bak on write', async () => {
    await writeProject(dir, { schemaVersion: 2, viewport: null, boards: [{ v: 1 }] })
    await writeProject(dir, { schemaVersion: 2, viewport: null, boards: [{ v: 2 }] })
    const bak = JSON.parse(readFileSync(join(dir, 'canvas.json.bak'), 'utf8'))
    expect(bak.boards[0].v).toBe(1)
  })

  it('falls back to .bak when canvas.json is corrupt', async () => {
    await writeProject(dir, doc) // valid
    writeFileSync(
      join(dir, 'canvas.json.bak'),
      JSON.stringify({ schemaVersion: 2, viewport: null, boards: [{ ok: true }] })
    )
    writeFileSync(join(dir, 'canvas.json'), '{ this is not json')
    const r = readProject(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.doc as { boards: { ok: boolean }[] }).boards[0].ok).toBe(true)
  })

  it('returns an error (never writes) when both files are corrupt', () => {
    writeFileSync(join(dir, 'canvas.json'), 'nope')
    writeFileSync(join(dir, 'canvas.json.bak'), 'also nope')
    const r = readProject(dir)
    expect(r.ok).toBe(false)
  })

  it('returns an error when no canvas.json exists', () => {
    expect(readProject(dir).ok).toBe(false)
  })
})
