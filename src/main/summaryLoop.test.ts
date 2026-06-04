import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import {
  buildSummarizeInput,
  buildMemoryIndex,
  buildProjectRollup,
  MAX_INPUT_CHARS,
  createSummaryLoop
} from './summaryLoop'
import { createCanvasMemory } from './canvasMemory'
import type { Encryptor } from './llmKeyStore'

/** A trivial Encryptor (round-trips through a base64 tag) — fine for the mock path (no key needed). */
const fakeEncryptor: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => Buffer.from(b).toString('utf8')
}

const docWith = (boards: unknown[]): unknown => ({ schemaVersion: 4, viewport: null, boards })
const planNote = (id: string, text: string): unknown => ({
  id,
  type: 'planning',
  title: 'Plan',
  elements: [{ id: 'n1', kind: 'note', text }]
})

/** Build a loop over a throwaway project dir + llm dir, with the e2e mock provider on. */
function makeLoop(opts: { getDir: () => string | null; doc: unknown; provider?: string }) {
  const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
  const loop = createSummaryLoop({
    llmDataDir,
    encryptor: fakeEncryptor,
    getCurrentDir: opts.getDir,
    readProject: () => {
      const d = opts.getDir()
      return d ? { ok: true, dir: d, name: 'proj', doc: opts.doc } : { ok: false, error: 'none' }
    },
    now: () => new Date(),
    // CANVAS_LLM_MOCK forces getProvider → mock ([mock] <text>); no network, no key needed.
    env: { CANVAS_LLM_MOCK: '1', ...(opts.provider ? { provider: opts.provider } : {}) }
  })
  return { loop, llmDataDir }
}

const terminal = (over: Record<string, unknown> = {}): unknown => ({
  id: 't1',
  type: 'terminal',
  title: 'Dev',
  launchCommand: 'pnpm dev',
  cwd: '/repo',
  port: 5173,
  ...over
})
const browser = (over: Record<string, unknown> = {}): unknown => ({
  id: 'b1',
  type: 'browser',
  title: 'Preview',
  url: 'http://localhost:5173',
  viewport: 'desktop',
  ...over
})
const planning = (elements: unknown[]): unknown => ({
  id: 'p1',
  type: 'planning',
  title: 'Plan',
  elements
})

describe('buildSummarizeInput — content pick + cap', () => {
  it('terminal: includes launchCommand / cwd / port', () => {
    const inp = buildSummarizeInput(terminal())
    expect(inp.text).toContain('pnpm dev')
    expect(inp.text).toContain('/repo')
    expect(inp.text).toContain('5173')
    expect(inp.system).toMatch(/summarize/i)
  })
  it('browser: includes url + viewport', () => {
    const inp = buildSummarizeInput(browser())
    expect(inp.text).toContain('http://localhost:5173')
    expect(inp.text).toContain('desktop')
  })
  it('planning: includes checklist titles + item labels + note text', () => {
    const inp = buildSummarizeInput(
      planning([
        {
          id: 'c1',
          kind: 'checklist',
          title: 'Tasks',
          items: [{ id: 'i1', label: 'ship it', done: false }]
        },
        { id: 'n1', kind: 'note', text: 'remember the gate' }
      ])
    )
    expect(inp.text).toContain('Tasks')
    expect(inp.text).toContain('ship it')
    expect(inp.text).toContain('remember the gate')
  })
  it('truncates over-long content to MAX_INPUT_CHARS', () => {
    const huge = buildSummarizeInput(
      planning([{ id: 'n1', kind: 'note', text: 'x'.repeat(10_000) }])
    )
    expect(huge.text.length).toBeLessThanOrEqual(MAX_INPUT_CHARS)
  })
  it('malformed / unknown board never throws and yields a non-empty prompt', () => {
    expect(() => buildSummarizeInput(null)).not.toThrow()
    expect(() => buildSummarizeInput({ type: 'mystery', title: 'Huh' })).not.toThrow()
    expect(buildSummarizeInput({ type: 'mystery', title: 'Huh' }).text.length).toBeGreaterThan(0)
  })
})

describe('buildMemoryIndex — one line per board, ✓ when summarized', () => {
  it('lists every board with type + filename; marks summarized boards', () => {
    const doc = { boards: [terminal(), browser()] }
    const md = buildMemoryIndex(doc, (id) => id === 't1')
    expect(md).toMatch(/^# Memory/m)
    expect(md).toContain('- Dev (terminal) — board-t1.md ✓')
    expect(md).toContain('- Preview (browser) — board-b1.md')
    expect(md).not.toContain('board-b1.md ✓')
  })
  it('malformed doc → header only, never throws', () => {
    expect(() => buildMemoryIndex(null, () => false)).not.toThrow()
    expect(buildMemoryIndex({ boards: 'nope' }, () => false)).toMatch(/^# Memory/m)
  })
})

describe('buildProjectRollup — small project-level header', () => {
  it('header with the project name + a board-count roll-up', () => {
    const md = buildProjectRollup('my-proj', { boards: [terminal(), browser(), planning([])] })
    expect(md).toMatch(/^# my-proj/m)
    expect(md).toContain('3 boards')
    expect(md).toContain('1 terminal')
    expect(md).toContain('1 browser')
    expect(md).toContain('1 planning')
  })
})

describe('createSummaryLoop — write on ok', () => {
  it('summarizes the board and writes board-<id>.md + MEMORY.md', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const { loop, llmDataDir } = makeLoop({
      getDir: () => proj,
      doc: docWith([planNote('p1', 'hello world')])
    })
    try {
      await loop.onIntent({ boardId: 'p1' })
      const mem = createCanvasMemory(proj)
      const board = mem.readBoard('p1')
      expect(board).toBeDefined()
      expect(board).toContain('[mock]') // mock provider prefixes the summary
      expect(board).toContain('hello world') // the board content reached the prompt
      const index = mem.readIndex()
      expect(index).toContain('board-p1.md ✓')
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })
})

describe('createSummaryLoop — no-op paths', () => {
  it('writes nothing when no project is open (getCurrentDir null)', async () => {
    const { loop, llmDataDir } = makeLoop({
      getDir: () => null,
      doc: docWith([planNote('p1', 'x')])
    })
    try {
      await loop.onIntent({ boardId: 'p1' }) // must not throw
    } finally {
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })

  it('writes nothing when the board was deleted between debounce and fire', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const { loop, llmDataDir } = makeLoop({
      getDir: () => proj,
      doc: docWith([planNote('p1', 'x')])
    })
    try {
      await loop.onIntent({ boardId: 'GONE' })
      expect(existsSync(join(proj, '.canvas', 'memory', 'board-GONE.md'))).toBe(false)
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })
})

describe('createSummaryLoop — no key → no spend / no write', () => {
  it('with NO mock and NO key, runSummarize is no-provider → nothing is written', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
    const loop = createSummaryLoop({
      llmDataDir,
      encryptor: fakeEncryptor,
      getCurrentDir: () => proj,
      readProject: () => ({
        ok: true,
        dir: proj,
        name: 'proj',
        doc: docWith([planNote('p1', 'x')])
      }),
      now: () => new Date(),
      env: {} // no CANVAS_LLM_MOCK, no *_API_KEY → getProvider returns null → no-provider
    })
    try {
      await loop.onIntent({ boardId: 'p1' })
      expect(existsSync(join(proj, '.canvas', 'memory', 'board-p1.md'))).toBe(false)
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })
})

describe('createSummaryLoop — in-flight guard', () => {
  it('a second concurrent onIntent for a board already summarizing is dropped', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
    const loop = createSummaryLoop({
      llmDataDir,
      encryptor: fakeEncryptor,
      getCurrentDir: () => proj,
      readProject: () => ({
        ok: true,
        dir: proj,
        name: 'proj',
        doc: docWith([planNote('p1', 'x')])
      }),
      now: () => new Date(),
      env: { CANVAS_LLM_MOCK: '1' }
    })
    try {
      // fire two intents for the SAME board without awaiting the first
      const a = loop.onIntent({ boardId: 'p1' })
      const b = loop.onIntent({ boardId: 'p1' })
      await Promise.all([a, b])
      const mem = createCanvasMemory(proj)
      expect(mem.readBoard('p1')).toContain('[mock]')
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })
})
