import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import {
  buildSummarizeInput,
  buildMemoryIndex,
  buildProjectRollup,
  terminalRuntimeLine,
  IDLE_AFTER_MS,
  MAX_INPUT_CHARS,
  MAX_OUTPUT_CHARS,
  sanitizeSummary,
  createSummaryLoop,
  type TerminalRuntime
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
  it('F-C/T-F2: EXCLUDES the board title (parity with boardFingerprint) for every type', () => {
    // A title-only rename must not change the prompt → no churned summarize, no stale name.
    expect(buildSummarizeInput(terminal({ title: 'RenamedTerm' })).text).not.toContain(
      'RenamedTerm'
    )
    expect(buildSummarizeInput(browser({ title: 'RenamedWeb' })).text).not.toContain('RenamedWeb')
    expect(
      buildSummarizeInput({ id: 'p1', type: 'planning', title: 'RenamedPlan', elements: [] }).text
    ).not.toContain('RenamedPlan')
    expect(buildSummarizeInput({ type: 'mystery', title: 'RenamedHuh' }).text).not.toContain(
      'RenamedHuh'
    )
  })
})

describe('terminalRuntimeLine — T-F1 runtime status phrase', () => {
  const NOW = 1_700_000_000_000
  it('returns null for an unknown runtime (getter not wired / no session)', () => {
    expect(terminalRuntimeLine(undefined, NOW)).toBeNull()
  })
  it('spawning / spawn-failed', () => {
    expect(terminalRuntimeLine({ state: 'spawning' }, NOW)).toBe('Status: starting up')
    expect(terminalRuntimeLine({ state: 'spawn-failed' }, NOW)).toBe('Status: failed to start')
  })
  it('running with recent activity → "running, last active …"', () => {
    const rt: TerminalRuntime = { state: 'running', lastActivityAt: NOW - 3000 }
    expect(terminalRuntimeLine(rt, NOW)).toMatch(/^Status: running, last active /)
  })
  it('running with NO activity timestamp → bare "running"', () => {
    expect(terminalRuntimeLine({ state: 'running' }, NOW)).toBe('Status: running')
  })
  it('running but stale beyond IDLE_AFTER_MS → degrades to "idle"', () => {
    const rt: TerminalRuntime = { state: 'running', lastActivityAt: NOW - IDLE_AFTER_MS - 1 }
    expect(terminalRuntimeLine(rt, NOW)).toMatch(/^Status: idle, last active /)
  })
  it('exited with / without an exit code', () => {
    expect(terminalRuntimeLine({ state: 'exited', exitCode: 0 }, NOW)).toBe(
      'Status: exited (code 0)'
    )
    expect(terminalRuntimeLine({ state: 'exited' }, NOW)).toBe('Status: exited')
  })
})

describe('buildSummarizeInput — T-F1 runtime folded into terminal input', () => {
  const NOW = 1_700_000_000_000
  it('terminal: a running runtime appends a Status line', () => {
    const inp = buildSummarizeInput(terminal(), { state: 'running', lastActivityAt: NOW }, NOW)
    expect(inp.text).toContain('pnpm dev')
    expect(inp.text).toContain('Status: running')
  })
  it('terminal: no runtime → no Status line (current behavior preserved)', () => {
    expect(buildSummarizeInput(terminal()).text).not.toContain('Status:')
  })
  it('non-terminal ignores a runtime arg entirely', () => {
    expect(
      buildSummarizeInput(browser(), { state: 'running', lastActivityAt: NOW }, NOW).text
    ).not.toContain('Status:')
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

describe('sanitizeSummary — BUG-016 bound + clean untrusted LLM output', () => {
  it('caps an over-long completion to MAX_OUTPUT_CHARS', () => {
    expect(sanitizeSummary('x'.repeat(MAX_OUTPUT_CHARS * 3)).length).toBe(MAX_OUTPUT_CHARS)
  })
  it('strips control chars (NUL / BEL / ESC) but keeps \\n and \\t', () => {
    const dirty = 'a\u0000b\u0007c\u001bd\ne\tf'
    const clean = sanitizeSummary(dirty)
    expect(clean).toBe('abcd\ne\tf')
    // eslint-disable-next-line no-control-regex -- asserts control chars are stripped
    expect(clean).not.toMatch(/[\u0000\u0007\u001b]/)
  })
  it('normalizes CRLF / lone CR to LF', () => {
    expect(sanitizeSummary('a\r\nb\rc')).toBe('a\nb\nc')
  })
  it('neutralizes a forged Markdown heading at line start (no new `# `)', () => {
    const out = sanitizeSummary('intro\n# Injected heading\n## also')
    // every line that began with # is escaped to \# so it no longer renders as a heading
    expect(out).not.toMatch(/^#/m)
    expect(out).toContain('\\# Injected heading')
    expect(out).toContain('\\## also')
  })
  it('a non-string yields an empty string (never throws)', () => {
    expect(sanitizeSummary(undefined)).toBe('')
    expect(sanitizeSummary(12345 as unknown)).toBe('')
  })
})

describe('createSummaryLoop — BUG-016 sanitizes provider output before writing board-<id>.md', () => {
  it('a giant control-char-laced completion is bounded + cleaned on disk', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
    // A malicious local/openrouter-style response: > MAX_OUTPUT_CHARS, NUL/BEL bytes, a forged
    // top-level heading. Non-mock provider so result.text is the raw `content` from the response.
    const evil = `# FORGED HEADING\u0000\u0007${'Z'.repeat(MAX_OUTPUT_CHARS * 2)}`
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: evil } }] }),
      text: async () => ''
    })) as unknown as Parameters<typeof createSummaryLoop>[0]['fetch']
    const loop = createSummaryLoop({
      llmDataDir,
      encryptor: fakeEncryptor,
      getCurrentDir: () => proj,
      readProject: () => ({
        ok: true,
        dir: proj,
        name: 'proj',
        doc: docWith([planNote('p1', 'hello world')])
      }),
      now: () => new Date(),
      fetch: fetchImpl,
      env: { provider: 'openrouter', OPENROUTER_API_KEY: 'test-key' }
    })
    try {
      await loop.onIntent({ boardId: 'p1' })
      const md = createCanvasMemory(proj).readBoard('p1')
      expect(md).toBeDefined()
      // The file = "# <title>\n\n<sanitized>\n"; the sanitized body must be capped + control-free
      // + must NOT contain a forged top-level heading on its own line.
      expect(md!.length).toBeLessThan(MAX_OUTPUT_CHARS + 200) // title + framing only
      // eslint-disable-next-line no-control-regex -- asserts control chars are stripped
      expect(md).not.toMatch(/[\u0000\u0007]/)
      expect(md).not.toMatch(/^# FORGED HEADING/m)
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
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

  it('BUG-017: ensures the .canvas scaffold (.gitignore present) before writing memory files', async () => {
    // Simulate scaffoldProjectMemory having failed silently at open: the project dir exists but
    // .canvas/.gitignore was never written. A successful summarize must (re)create the scaffold so
    // the generated memory stays default-private. Pre-fix onIntent never called ensureScaffold →
    // board-p1.md was written but .canvas/.gitignore stayed absent.
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const { loop, llmDataDir } = makeLoop({
      getDir: () => proj,
      doc: docWith([planNote('p1', 'hello world')])
    })
    try {
      expect(existsSync(join(proj, '.canvas', '.gitignore'))).toBe(false) // pre-condition
      await loop.onIntent({ boardId: 'p1' })
      expect(existsSync(join(proj, '.canvas', '.gitignore'))).toBe(true)
      expect(existsSync(join(proj, '.canvas', 'memory', 'board-p1.md'))).toBe(true)
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })
})

describe('createSummaryLoop — T-F1 getTerminalRuntime injection', () => {
  it('folds an injected runtime into the written terminal prose', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
    const loop = createSummaryLoop({
      llmDataDir,
      encryptor: fakeEncryptor,
      getCurrentDir: () => proj,
      readProject: () => ({ ok: true, dir: proj, name: 'proj', doc: docWith([terminal()]) }),
      getTerminalRuntime: () => ({ state: 'running', lastActivityAt: new Date().getTime() }),
      now: () => new Date(),
      env: { CANVAS_LLM_MOCK: '1' } // mock echoes the input text → Status line lands in prose
    })
    try {
      await loop.onIntent({ boardId: 't1' })
      expect(createCanvasMemory(proj).readBoard('t1')).toContain('Status: running')
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })

  it('a throwing getTerminalRuntime never fails the summarize (still writes prose)', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
    const loop = createSummaryLoop({
      llmDataDir,
      encryptor: fakeEncryptor,
      getCurrentDir: () => proj,
      readProject: () => ({ ok: true, dir: proj, name: 'proj', doc: docWith([terminal()]) }),
      getTerminalRuntime: () => {
        throw new Error('pty state unavailable')
      },
      now: () => new Date(),
      env: { CANVAS_LLM_MOCK: '1' }
    })
    try {
      await loop.onIntent({ boardId: 't1' })
      const md = createCanvasMemory(proj).readBoard('t1')
      expect(md).toBeDefined()
      expect(md).not.toContain('Status:') // getter threw → status omitted, summary still written
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

describe('createSummaryLoop — BUG-006 project-switch TOCTOU guard', () => {
  it('does NOT write into the captured dir when the project switched during the await', async () => {
    const projA = mkdtempSync(join(tmpdir(), 'm3-projA-'))
    const projB = mkdtempSync(join(tmpdir(), 'm3-projB-'))
    const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
    // First getCurrentDir() (the capture at the top of onIntent) returns A; every call AFTER that
    // — i.e. the post-await re-check — returns B, simulating the user opening project B while the
    // (mocked-but-still-async) runSummarize is in flight.
    let calls = 0
    const getCurrentDir = (): string => (calls++ === 0 ? projA : projB)
    const loop = createSummaryLoop({
      llmDataDir,
      encryptor: fakeEncryptor,
      getCurrentDir,
      // readProject uses the dir it is HANDED (the captured A), not getCurrentDir(), so the read
      // resolves against A — the write is what must be suppressed.
      readProject: (dir) => ({ ok: true, dir, name: 'projA', doc: docWith([planNote('p1', 'x')]) }),
      now: () => new Date(),
      env: { CANVAS_LLM_MOCK: '1' } // forces a provider so runSummarize resolves ok (would write)
    })
    try {
      await loop.onIntent({ boardId: 'p1' })
      // Pre-fix this wrote board-p1.md into projA (the stale captured dir). Post-fix: nothing.
      expect(existsSync(join(projA, '.canvas', 'memory', 'board-p1.md'))).toBe(false)
      expect(existsSync(join(projB, '.canvas', 'memory', 'board-p1.md'))).toBe(false)
    } finally {
      rmSync(projA, { recursive: true, force: true })
      rmSync(projB, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })

  it('still writes when the project did NOT change across the await (guard is not over-eager)', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const { loop, llmDataDir } = makeLoop({
      getDir: () => proj,
      doc: docWith([planNote('p1', 'hello world')])
    })
    try {
      await loop.onIntent({ boardId: 'p1' })
      expect(createCanvasMemory(proj).readBoard('p1')).toContain('[mock]')
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })
})

describe('createSummaryLoop — BUG-014 index rebuilt from FRESH doc, not the stale snapshot', () => {
  it('a board added during the await appears in MEMORY.md (index uses the post-await read)', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
    // readProject is called twice: once at the top of onIntent (capture), once after the await
    // (BUG-014 fresh re-read). The first read sees just p1; by the second a save has added p2.
    let reads = 0
    const docFirst = docWith([planNote('p1', 'hello world')])
    const docFresh = docWith([planNote('p1', 'hello world'), planNote('p2', 'added mid-await')])
    const loop = createSummaryLoop({
      llmDataDir,
      encryptor: fakeEncryptor,
      getCurrentDir: () => proj,
      readProject: () => ({
        ok: true,
        dir: proj,
        name: 'proj',
        doc: reads++ === 0 ? docFirst : docFresh
      }),
      now: () => new Date(),
      env: { CANVAS_LLM_MOCK: '1' }
    })
    try {
      await loop.onIntent({ boardId: 'p1' })
      const index = createCanvasMemory(proj).readIndex()
      // Pre-fix the index was built from the stale 1-board snapshot → p2 omitted. Post-fix the
      // post-await re-read lists both boards.
      expect(index).toContain('board-p1.md')
      expect(index).toContain('board-p2.md')
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

describe('createSummaryLoop — BUG-015 in-flight guard is per (project,board)', () => {
  it('a same-id board in a DIFFERENT project is summarized, not blocked by a sibling in-flight call', async () => {
    const projA = mkdtempSync(join(tmpdir(), 'm3-projA-'))
    const projB = mkdtempSync(join(tmpdir(), 'm3-projB-'))
    const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
    // Both projects hold a board with the SAME id 'shared'. `current` is the open project; we flip
    // it between the two onIntent calls so intent #1 captures projA and intent #2 captures projB.
    // A controllable fetch keeps #1 in flight while #2 is fired, so they truly overlap. Pre-fix
    // the boardId-keyed guard saw 'shared' already in-flight and dropped #2 → projB never written.
    let current = projA
    let fetchCalls = 0
    let releaseFirst: () => void = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let unblock: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const fetchImpl = (async () => {
      const n = ++fetchCalls
      const reply = {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'sum' } }] }),
        text: async () => ''
      }
      if (n === 1) {
        releaseFirst()
        await gate // hold call #1 in flight until the test has fired #2
        return reply
      }
      return reply
    }) as unknown as Parameters<typeof createSummaryLoop>[0]['fetch']
    const loop = createSummaryLoop({
      llmDataDir,
      encryptor: fakeEncryptor,
      getCurrentDir: () => current,
      readProject: (dir) => ({
        ok: true,
        dir,
        name: 'proj',
        doc: docWith([planNote('shared', 'hello world')])
      }),
      now: () => new Date(),
      fetch: fetchImpl,
      env: { provider: 'openrouter', OPENROUTER_API_KEY: 'test-key' }
    })
    try {
      const first = loop.onIntent({ boardId: 'shared' }) // captures projA, now in flight
      await firstStarted
      current = projB // user switched to project B
      await loop.onIntent({ boardId: 'shared' }) // pre-fix: dropped; post-fix: runs for projB
      current = projA // switch back so call #1's TOCTOU re-check still matches its captured projA
      unblock() // let call #1 finish
      await first
      await new Promise((r) => setTimeout(r, 10))
      expect(createCanvasMemory(projA).readBoard('shared')).toContain('sum')
      expect(createCanvasMemory(projB).readBoard('shared')).toContain('sum')
    } finally {
      rmSync(projA, { recursive: true, force: true })
      rmSync(projB, { recursive: true, force: true })
      rmSync(llmDataDir, { recursive: true, force: true })
    }
  })

  it('a dropped second intent (same project+board) is re-fired after the first call FAILS', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'm3-proj-'))
    const llmDataDir = mkdtempSync(join(tmpdir(), 'm3-llm-'))
    // Non-mock provider with an injected transport: the 1st summarize fails (HTTP 500), the 2nd
    // succeeds. We fire intent #1 (slow-failing) and, while it is in flight, intent #2 for the
    // SAME board — that 2nd is parked in `pending`. Pre-fix it was silently dropped; post-fix the
    // `finally` re-fires it after the failed first call, so the retry's success writes the prose.
    let fetchCalls = 0
    let releaseFirst: () => void = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      // resolved when the first fetch begins, so the test can fire the 2nd intent mid-flight
      releaseFirst = resolve
    })
    const fetchImpl = (async () => {
      const n = ++fetchCalls
      if (n === 1) {
        releaseFirst()
        // give the test a tick to fire the 2nd intent before the first resolves
        await new Promise((r) => setTimeout(r, 10))
        return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'retry ok' } }] }),
        text: async () => ''
      }
    }) as unknown as Parameters<typeof createSummaryLoop>[0]['fetch']
    const loop = createSummaryLoop({
      llmDataDir,
      encryptor: fakeEncryptor,
      getCurrentDir: () => proj,
      readProject: () => ({
        ok: true,
        dir: proj,
        name: 'proj',
        doc: docWith([planNote('p1', 'hello world')])
      }),
      now: () => new Date(),
      fetch: fetchImpl,
      env: { provider: 'openrouter', OPENROUTER_API_KEY: 'test-key' }
    })
    try {
      const first = loop.onIntent({ boardId: 'p1' })
      await firstStarted // first fetch is now running
      await loop.onIntent({ boardId: 'p1' }) // parked in pending (guard hit)
      await first // first fails → finally re-fires the pending retry
      // The retry uses fetch call #2 (success). Drain any trailing microtasks/timers.
      await new Promise((r) => setTimeout(r, 20))
      expect(fetchCalls).toBeGreaterThanOrEqual(2)
      expect(createCanvasMemory(proj).readBoard('p1')).toContain('retry ok')
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
