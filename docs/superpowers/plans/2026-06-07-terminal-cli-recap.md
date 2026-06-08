# Terminal / Agent-CLI Session Recap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip a terminal board to a recap (NOW headline + timestamped meaningful-moment notes) of what its Claude-Code agent is doing, sourced from the agent's transcript JSONL, identified per board via an invisible env var + a consent-gated SessionStart hook.

**Architecture:** A SessionStart hook (installed in the project's gitignored `.claude/settings.local.json`, only after a friendly per-project consent modal) writes `{boardId, session_id, transcript_path}` to an app-owned mapping file. The app watches the map, persists the transcript path on the board, reads the transcript (independent observer — not the noisy PTY scrollback), distills meaningful milestones, and the existing Tier-2 summarizer turns them into a NOW line + code-assembled timestamped timeline rendered on the board's flip back-face.

**Tech Stack:** Electron 42 + TypeScript + React 18; vitest (unit/integration); Playwright `_electron` (e2e); `write-file-atomic`; `node-pty`; `@xyflow/react`. Spec: `docs/superpowers/specs/2026-06-07-terminal-cli-recap-design.md`.

**Spike-first:** Task 0 (env-inheritance smoke test) GATES the rest. If it fails, switch to the cwd+spawn-order fallback (§8 of the spec) before building Tasks 5/8/10.

**Cross-zone:** `src/renderer/src/lib/boardSchema.ts` is owned by the `feat/text-font-toolbar` worktree (TextElement + schema v6). Our edit is additive optional fields (Task 7) — no version bump. Coordinate via `ACTIVE-WORK.md` before editing; expect a clean merge (different lines).

**Gate after each task:** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run` (from the worktree). E2E matrix runs on pre-push.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/recap-env-spike.mjs` (+ a throwaway hook) | Task 0 spike: prove a SessionStart hook sees `CANVAS_RECAP_BOARD`. |
| `src/main/agentTranscript.ts` | PURE: `detectAgentCli`, `claudeProjectSlug`, `extractMilestones`. No Electron/LLM/net. |
| `src/main/agentTranscript.test.ts` | Unit tests for the above. |
| `src/main/agentRecapMap.ts` | Hook install/merge into `settings.local.json` (idempotent) + remove; read mapping JSONL → `boardId→{sessionId,transcriptPath}`; watch it. |
| `src/main/agentRecapMap.test.ts` | Unit tests (fixture fs + temp dirs). |
| `src/main/hooks/recordSession.js` | Shipped hook script: stdin JSON + `CANVAS_RECAP_BOARD` env + map-path argv → append one mapping line. |
| `src/main/recapConsent.ts` | Per-project consent store (userData, atomic) + `recap:*` IPC handlers. |
| `src/main/recapConsent.test.ts` | Unit tests. |
| `src/main/agentRecapWatcher.ts` | Slice B: debounced transcript-mtime watcher → `summaryLoop.onIntent`. |
| `src/main/agentRecapWatcher.test.ts` | Unit tests. |
| `src/main/summaryLoop.ts` | EXTEND: `getAgentMilestones` dep + terminal recap branch (structured `{now,notes}` → code-assembled timeline). |
| `src/main/pty.ts` | ADD `setRecapEnvProvider` seam → merge extra env at spawn. |
| `src/main/index.ts` | WIRE: recap env provider, consent IPC, map watcher, `getAgentMilestones`, hook install at project open. |
| `src/main/projectIpc.ts` | hook install + consent check at `project:open` / `project:current`. |
| `src/renderer/src/lib/boardSchema.ts` | ADD optional `agentSessionId?` + `agentTranscriptPath?` to `TerminalBoard` (+ `toObject`). **Cross-zone.** |
| `src/preload/index.ts` | EXPOSE `window.api.recap.{getConsent,setConsent}`. |
| `src/renderer/src/canvas/RecapConsentModal.tsx` | Consent modal (portal/scrim, benefit-first, transparency). |
| `src/renderer/src/canvas/AppChrome.tsx` | Mount the consent modal; trigger once per project. |
| `src/renderer/src/canvas/SettingsModal.tsx` | ADD per-project "Agent recaps" toggle. |
| `src/renderer/src/canvas/boards/TerminalBoard.tsx` | Flip control + flipped state (xterm stays mounted). |
| `src/renderer/src/canvas/RecapView.tsx` | Back-face: NOW + timeline + ⟳ (reuses `stripHeading`). |
| `e2e/recap.e2e.ts` + `e2e/fixtures/fake-claude.*` | Live-chain proof. |

---

## Task 0: SPIKE — env-inheritance smoke test (GATES THE BUILD)

**Goal:** Confirm a Claude Code `SessionStart` hook inherits an env var (`CANVAS_RECAP_BOARD`) set on the shell that launched `claude`. If not, the whole env-var bridge needs the fallback.

**Files:**
- Create: `scripts/recap-env-spike.mjs` (throwaway; deleted at end of task)

- [ ] **Step 1: Write the spike script**

```js
// scripts/recap-env-spike.mjs  — run manually; proves hook env inheritance.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const proj = mkdtempSync(join(tmpdir(), 'recap-spike-'))
const out = join(proj, 'hook-saw.txt')
mkdirSync(join(proj, '.claude'), { recursive: true })
// A SessionStart hook that records whether it can see CANVAS_RECAP_BOARD.
const hook = join(proj, '.claude', 'spy.mjs')
writeFileSync(hook, `import {appendFileSync} from 'node:fs'
appendFileSync(${JSON.stringify(out)}, 'BOARD=' + (process.env.CANVAS_RECAP_BOARD ?? '<MISSING>') + '\\n')
`)
writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({
  hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: process.execPath, args: [hook] }] }] }
}, null, 2))

console.log('Project:', proj)
console.log('Now run, FROM A SHELL with the env var set, in that project dir:')
console.log(`  CANVAS_RECAP_BOARD=spike-123 claude -p "say hi" --dangerously-skip-permissions`)
console.log(`(Windows pwsh:  $env:CANVAS_RECAP_BOARD='spike-123'; claude -p "say hi")`)
console.log('Then check:', out)
console.log('Expected: a line "BOARD=spike-123". "BOARD=<MISSING>" => env NOT inherited (use fallback).')
```

- [ ] **Step 2: Run the spike + a real `claude`**

Run: `node scripts/recap-env-spike.mjs`, then follow its printed instructions (run `claude` in the printed project dir with `CANVAS_RECAP_BOARD=spike-123` exported). Inspect the output file.
Expected: `hook-saw.txt` contains `BOARD=spike-123` (PASS — env inherited).
If `BOARD=<MISSING>`: env NOT inherited — STOP and switch the design to the spawn-order fallback (spec §8) before Tasks 5/8/10. Record the result in the spec.

- [ ] **Step 3: Record the result + remove the throwaway script**

Append a one-line result note to the spec's §9 ("Spike result 2026-06-__: PASS/FAIL"). Then:
```bash
git rm scripts/recap-env-spike.mjs   # (or: rm if never added)
```

- [ ] **Step 4: Commit the spike result**

```bash
git add docs/superpowers/specs/2026-06-07-terminal-cli-recap-design.md
git commit -m "spike(terminal-recap): env-inheritance smoke test result"
```

---

## Task 1: `agentTranscript.ts` — detectAgentCli + claudeProjectSlug

**Files:**
- Create: `src/main/agentTranscript.ts`
- Test: `src/main/agentTranscript.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/agentTranscript.test.ts
import { describe, it, expect } from 'vitest'
import { detectAgentCli, claudeProjectSlug } from './agentTranscript'

describe('detectAgentCli', () => {
  it('detects claude across common launch shapes', () => {
    for (const cmd of ['claude', 'claude --resume x', '  claude  ', 'npx claude', 'pwsh -c claude'])
      expect(detectAgentCli(cmd)).toBe('claude')
  })
  it('returns unknown for non-claude / empty', () => {
    for (const cmd of ['aider', 'codex', '', undefined as unknown as string])
      expect(detectAgentCli(cmd)).toBe('unknown')
  })
})

describe('claudeProjectSlug', () => {
  it('replaces every non-alphanumeric with a dash (verified shape)', () => {
    expect(claudeProjectSlug('Z:\\Canvas ADE')).toBe('Z--Canvas-ADE')
  })
  it('handles posix paths + trailing slash', () => {
    expect(claudeProjectSlug('/home/u/proj/')).toBe('-home-u-proj-')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run src/main/agentTranscript.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement minimally**

```typescript
// src/main/agentTranscript.ts
export type AgentCli = 'claude' | 'unknown'

/** First meaningful token of a launchCommand → which agent CLI it runs. */
export function detectAgentCli(launchCommand?: string): AgentCli {
  if (typeof launchCommand !== 'string') return 'unknown'
  // tokens that wrap the real command; look past them for the agent binary
  const wrappers = new Set(['npx', 'pnpm', 'dlx', 'sudo', 'pwsh', 'powershell', 'cmd', 'bash', 'sh', 'zsh'])
  const flags = new Set(['-c', '/c', '-lc', '-l', '-i'])
  const toks = launchCommand.trim().split(/\s+/).filter(Boolean)
  for (const t of toks) {
    if (wrappers.has(t) || flags.has(t)) continue
    return /(^|[\\/])claude(\.\w+)?$/i.test(t) || t.toLowerCase() === 'claude' ? 'claude' : 'unknown'
  }
  return 'unknown'
}

/** Claude Code transcript dir slug: every non-alphanumeric char → '-'. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm vitest run src/main/agentTranscript.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentTranscript.ts src/main/agentTranscript.test.ts
git commit -m "feat(terminal-recap): detectAgentCli + claudeProjectSlug"
```

---

## Task 2: `agentTranscript.ts` — extractMilestones

**Files:**
- Modify: `src/main/agentTranscript.ts`
- Test: `src/main/agentTranscript.test.ts`

Claude transcript JSONL: one object per line. We keep only user messages + assistant *text* messages, with their real timestamps; we drop tool_use / tool_result. Records look like `{"type":"user","timestamp":"2026-06-07T14:32:00Z","message":{"role":"user","content":"..."}}` and assistant content can be a string or an array of blocks (`{type:'text',text}` / `{type:'tool_use',...}`). Be tolerant of shape.

- [ ] **Step 1: Write the failing test**

```typescript
// add to src/main/agentTranscript.test.ts
import { extractMilestones } from './agentTranscript'

const line = (o: unknown): string => JSON.stringify(o)
const T = '2026-06-07T14:32:00.000Z'

describe('extractMilestones', () => {
  it('keeps user + assistant TEXT turns, drops tool records, with real timestamps', () => {
    const jsonl = [
      line({ type: 'user', timestamp: T, message: { role: 'user', content: 'review the auth service' } }),
      line({ type: 'assistant', timestamp: T, message: { role: 'assistant', content: [{ type: 'text', text: 'Found 3 issues.' }] } }),
      line({ type: 'assistant', timestamp: T, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
      line({ type: 'tool_result', timestamp: T, message: { content: 'file body...' } }),
      'not json'
    ].join('\n')
    const ms = extractMilestones(jsonl, { maxMilestones: 12, maxTextChars: 200 })
    expect(ms.map((m) => m.role)).toEqual(['user', 'agent'])
    expect(ms[0]).toMatchObject({ role: 'user', text: 'review the auth service' })
    expect(ms[1]).toMatchObject({ role: 'agent', text: 'Found 3 issues.' })
    expect(typeof ms[0].ts).toBe('number')
  })
  it('caps to the last N and truncates long text', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      line({ type: 'user', timestamp: T, message: { role: 'user', content: 'x'.repeat(500) + i } })
    ).join('\n')
    const ms = extractMilestones(many, { maxMilestones: 12, maxTextChars: 50 })
    expect(ms).toHaveLength(12)
    expect(ms[0].text.length).toBeLessThanOrEqual(50)
  })
})
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run src/main/agentTranscript.test.ts`
Expected: FAIL — `extractMilestones` not exported.

- [ ] **Step 3: Implement**

```typescript
// add to src/main/agentTranscript.ts
export interface Milestone {
  ts: number
  role: 'user' | 'agent'
  text: string
}
export interface ExtractOpts {
  maxMilestones?: number
  maxTextChars?: number
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: unknown })?.type === 'text')
      .map((b) => String((b as { text?: unknown }).text ?? ''))
      .join('\n')
  }
  return ''
}

/** Parse a Claude transcript JSONL into meaningful milestones (user + assistant text only). */
export function extractMilestones(jsonl: string, opts: ExtractOpts = {}): Milestone[] {
  const maxN = opts.maxMilestones ?? 12
  const cap = opts.maxTextChars ?? 600
  const out: Milestone[] = []
  for (const raw of jsonl.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    let rec: { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } }
    try {
      rec = JSON.parse(s)
    } catch {
      continue // skip malformed lines
    }
    const role = rec.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = textFromContent(rec.message?.content).trim()
    if (!text) continue // assistant tool-only turns have no text → dropped
    const ts = Date.parse(String(rec.timestamp ?? '')) || 0
    out.push({ ts, role: role === 'user' ? 'user' : 'agent', text: text.slice(0, cap) })
  }
  return out.slice(-maxN)
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm vitest run src/main/agentTranscript.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentTranscript.ts src/main/agentTranscript.test.ts
git commit -m "feat(terminal-recap): extractMilestones (meaningful turns only)"
```

---

## Task 3: `recordSession.js` — the shipped hook script

**Files:**
- Create: `src/main/hooks/recordSession.js`
- Test: `src/main/agentRecapMap.test.ts` (the script is exercised by spawning node)

The hook receives Claude's JSON on stdin; map path is `process.argv[2]` (baked at install); board id is `process.env.CANVAS_RECAP_BOARD`. Plain JS (runs under the app's node, not bundled). No deps.

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/agentRecapMap.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

describe('recordSession.js hook script', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recap-hook-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('appends a mapping line from stdin + env + argv', () => {
    const map = join(dir, 'map.jsonl')
    const stdin = JSON.stringify({
      session_id: 'sess-1', transcript_path: '/h/.claude/projects/p/sess-1.jsonl', cwd: '/repo', source: 'startup'
    })
    execFileSync(process.execPath, ['src/main/hooks/recordSession.js', map], {
      input: stdin,
      env: { ...process.env, CANVAS_RECAP_BOARD: 'board-9' }
    })
    expect(existsSync(map)).toBe(true)
    const rec = JSON.parse(readFileSync(map, 'utf8').trim())
    expect(rec).toMatchObject({
      boardId: 'board-9', sessionId: 'sess-1',
      transcriptPath: '/h/.claude/projects/p/sess-1.jsonl', cwd: '/repo'
    })
    expect(typeof rec.ts).toBe('number')
  })
})
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run src/main/agentRecapMap.test.ts`
Expected: FAIL — script file missing.

- [ ] **Step 3: Implement the script**

```js
// src/main/hooks/recordSession.js — Claude SessionStart hook. No deps; runs under the app's node.
// argv[2] = absolute mapping-file path (baked at install). env.CANVAS_RECAP_BOARD = our board id.
'use strict'
const fs = require('node:fs')
try {
  const mapPath = process.argv[2]
  if (!mapPath) process.exit(0)
  let stdin = ''
  try { stdin = fs.readFileSync(0, 'utf8') } catch { stdin = '' }
  let d = {}
  try { d = JSON.parse(stdin) } catch { d = {} }
  const line = JSON.stringify({
    boardId: process.env.CANVAS_RECAP_BOARD || '',
    sessionId: d.session_id || '',
    transcriptPath: d.transcript_path || '',
    cwd: d.cwd || '',
    source: d.source || '',
    ts: Date.now()
  })
  fs.appendFileSync(mapPath, line + '\n')
} catch {
  /* never fail the agent's startup */
}
process.exit(0)
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm vitest run src/main/agentRecapMap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hooks/recordSession.js src/main/agentRecapMap.test.ts
git commit -m "feat(terminal-recap): recordSession hook script"
```

---

## Task 4: `agentRecapMap.ts` — install/merge + remove the hook

**Files:**
- Create: `src/main/agentRecapMap.ts`
- Test: `src/main/agentRecapMap.test.ts`

Install merges a SessionStart hook into `<cwd>/.claude/settings.local.json` without clobbering existing hooks; idempotent (won't double-add ours, keyed by our script path); removable.

- [ ] **Step 1: Write the failing test**

```typescript
// add to src/main/agentRecapMap.test.ts
import { installRecapHook, removeRecapHook, isRecapHookInstalled } from './agentRecapMap'

describe('recap hook install/merge', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recap-install-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const opts = (d: string) => ({ projectDir: d, nodePath: '/usr/bin/node', scriptPath: '/app/recordSession.js', mapPath: '/u/map.jsonl' })

  it('installs idempotently + preserves a pre-existing unrelated hook', () => {
    const settings = join(dir, '.claude', 'settings.local.json')
    // pre-existing user hook
    require('node:fs').mkdirSync(join(dir, '.claude'), { recursive: true })
    require('node:fs').writeFileSync(settings, JSON.stringify({
      hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo', args: ['hi'] }] }] }
    }))
    installRecapHook(opts(dir))
    installRecapHook(opts(dir)) // idempotent
    const cfg = JSON.parse(readFileSync(settings, 'utf8'))
    const entries = cfg.hooks.SessionStart.flatMap((b: { hooks: unknown[] }) => b.hooks)
    expect(entries.filter((h: { args?: string[] }) => h.args?.includes('/app/recordSession.js'))).toHaveLength(1)
    expect(entries.some((h: { command?: string }) => h.command === 'echo')).toBe(true)
    expect(isRecapHookInstalled(dir, '/app/recordSession.js')).toBe(true)
  })

  it('removes only our hook entry', () => {
    installRecapHook(opts(dir))
    removeRecapHook(dir, '/app/recordSession.js')
    expect(isRecapHookInstalled(dir, '/app/recordSession.js')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run src/main/agentRecapMap.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

```typescript
// src/main/agentRecapMap.ts (part 1 — install)
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import writeFileAtomic from 'write-file-atomic'
import { join } from 'node:path'

export interface InstallOpts {
  projectDir: string
  nodePath: string // process.execPath
  scriptPath: string // absolute path to recordSession.js
  mapPath: string // absolute path to the mapping file (app-owned, userData)
}

function settingsPath(projectDir: string): string {
  return join(projectDir, '.claude', 'settings.local.json')
}
function readSettings(projectDir: string): Record<string, unknown> {
  const p = settingsPath(projectDir)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
type HookCmd = { type: string; command: string; args?: string[] }
type HookBlock = { matcher?: string; hooks: HookCmd[] }

export function isRecapHookInstalled(projectDir: string, scriptPath: string): boolean {
  const cfg = readSettings(projectDir) as { hooks?: { SessionStart?: HookBlock[] } }
  const blocks = cfg.hooks?.SessionStart ?? []
  return blocks.some((b) => b.hooks?.some((h) => h.args?.includes(scriptPath)))
}

export function installRecapHook(opts: InstallOpts): void {
  if (isRecapHookInstalled(opts.projectDir, opts.scriptPath)) return
  const cfg = readSettings(opts.projectDir) as { hooks?: { SessionStart?: HookBlock[] } }
  cfg.hooks ??= {}
  cfg.hooks.SessionStart ??= []
  cfg.hooks.SessionStart.push({
    matcher: '',
    hooks: [{ type: 'command', command: opts.nodePath, args: [opts.scriptPath, opts.mapPath] }]
  })
  mkdirSync(join(opts.projectDir, '.claude'), { recursive: true })
  writeFileAtomic.sync(settingsPath(opts.projectDir), JSON.stringify(cfg, null, 2), 'utf8')
}

export function removeRecapHook(projectDir: string, scriptPath: string): void {
  if (!existsSync(settingsPath(projectDir))) return
  const cfg = readSettings(projectDir) as { hooks?: { SessionStart?: HookBlock[] } }
  const blocks = cfg.hooks?.SessionStart
  if (!blocks) return
  cfg.hooks!.SessionStart = blocks
    .map((b) => ({ ...b, hooks: b.hooks.filter((h) => !h.args?.includes(scriptPath)) }))
    .filter((b) => b.hooks.length > 0)
  writeFileAtomic.sync(settingsPath(projectDir), JSON.stringify(cfg, null, 2), 'utf8')
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm vitest run src/main/agentRecapMap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentRecapMap.ts src/main/agentRecapMap.test.ts
git commit -m "feat(terminal-recap): idempotent SessionStart hook install/merge/remove"
```

---

## Task 5: `agentRecapMap.ts` — read + watch the mapping file

**Files:**
- Modify: `src/main/agentRecapMap.ts`
- Test: `src/main/agentRecapMap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// add to src/main/agentRecapMap.test.ts
import { readRecapMap } from './agentRecapMap'

describe('readRecapMap', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recap-map-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns the LATEST entry per board, ignoring blank/malformed lines', () => {
    const map = join(dir, 'map.jsonl')
    require('node:fs').writeFileSync(map, [
      JSON.stringify({ boardId: 'b1', sessionId: 's1', transcriptPath: '/t/s1.jsonl', ts: 1 }),
      'garbage',
      JSON.stringify({ boardId: 'b1', sessionId: 's2', transcriptPath: '/t/s2.jsonl', ts: 2 }),
      JSON.stringify({ boardId: '', sessionId: 'x', transcriptPath: '/t/x.jsonl', ts: 3 }),
      ''
    ].join('\n'))
    const m = readRecapMap(map)
    expect(m.get('b1')).toEqual({ sessionId: 's2', transcriptPath: '/t/s2.jsonl' })
    expect(m.has('')).toBe(false)
  })
  it('returns an empty map when the file is absent', () => {
    expect(readRecapMap(join(dir, 'nope.jsonl')).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run src/main/agentRecapMap.test.ts`
Expected: FAIL — `readRecapMap` not exported.

- [ ] **Step 3: Implement read + watch**

```typescript
// add to src/main/agentRecapMap.ts
import { watch } from 'node:fs'

export interface RecapMapEntry {
  sessionId: string
  transcriptPath: string
}

/** Parse the mapping JSONL → boardId → latest {sessionId, transcriptPath}. Best-effort. */
export function readRecapMap(mapPath: string): Map<string, RecapMapEntry> {
  const out = new Map<string, RecapMapEntry>()
  if (!existsSync(mapPath)) return out
  let text = ''
  try {
    text = readFileSync(mapPath, 'utf8')
  } catch {
    return out
  }
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s) as { boardId?: string; sessionId?: string; transcriptPath?: string }
      if (r.boardId && r.transcriptPath) {
        out.set(r.boardId, { sessionId: r.sessionId ?? '', transcriptPath: r.transcriptPath })
      }
    } catch {
      /* skip */
    }
  }
  return out
}

/** Watch the mapping file; call onChange (debounced) with the freshly-parsed map. Returns a disposer. */
export function watchRecapMap(mapPath: string, onChange: (m: Map<string, RecapMapEntry>) => void, debounceMs = 200): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => onChange(readRecapMap(mapPath)), debounceMs)
  }
  let w: ReturnType<typeof watch> | null = null
  try {
    mkdirSync(join(mapPath, '..'), { recursive: true })
    w = watch(mapPath, { persistent: false }, fire)
  } catch {
    /* file may not exist yet; caller re-arms on demand */
  }
  fire() // prime
  return () => {
    if (timer) clearTimeout(timer)
    try {
      w?.close()
    } catch {
      /* already closed */
    }
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm vitest run src/main/agentRecapMap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentRecapMap.ts src/main/agentRecapMap.test.ts
git commit -m "feat(terminal-recap): read + watch the recap mapping file"
```

---

## Task 6: `recapConsent.ts` — per-project consent store + IPC

**Files:**
- Create: `src/main/recapConsent.ts`
- Test: `src/main/recapConsent.test.ts`

Mirrors the `llmConfig.ts` store pattern; keyed by project path. Decision: `'enabled' | 'declined'`; absent = undecided.

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/recapConsent.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConsent, writeConsent } from './recapConsent'

describe('recapConsent', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recap-consent-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns undefined (undecided) when unknown', () => {
    expect(readConsent(dir, '/some/project')).toBeUndefined()
  })
  it('round-trips a per-project decision', () => {
    writeConsent(dir, '/proj/a', 'enabled')
    writeConsent(dir, '/proj/b', 'declined')
    expect(readConsent(dir, '/proj/a')).toBe('enabled')
    expect(readConsent(dir, '/proj/b')).toBe('declined')
    expect(readConsent(dir, '/proj/c')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run src/main/recapConsent.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement store**

```typescript
// src/main/recapConsent.ts
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import writeFileAtomic from 'write-file-atomic'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'

export type RecapDecision = 'enabled' | 'declined'

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'recap-consent.json')
}
function readAll(userDataDir: string): Record<string, RecapDecision> {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return {}
  try {
    const p = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
    const out: Record<string, RecapDecision> = {}
    for (const [k, v] of Object.entries(p)) if (v === 'enabled' || v === 'declined') out[k] = v
    return out
  } catch {
    return {}
  }
}

export function readConsent(userDataDir: string, projectPath: string): RecapDecision | undefined {
  return readAll(userDataDir)[projectPath]
}
export function writeConsent(userDataDir: string, projectPath: string, decision: RecapDecision): void {
  const all = readAll(userDataDir)
  all[projectPath] = decision
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(all, null, 2), 'utf8')
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm vitest run src/main/recapConsent.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the IPC handlers (+ test the guard contract)**

Add to `src/main/recapConsent.ts`:

```typescript
// src/main/recapConsent.ts (append)
export function registerRecapHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string,
  getCurrentDir: () => string | null,
  onDecision: (projectPath: string, decision: RecapDecision) => void
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)
  ipcMain.handle('recap:getConsent', (e): RecapDecision | 'undecided' => {
    if (guard(e)) return 'declined'
    const dir = getCurrentDir()
    if (!dir) return 'declined'
    return readConsent(userDataDir, dir) ?? 'undecided'
  })
  ipcMain.handle('recap:setConsent', (e, decision: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    const dir = getCurrentDir()
    if (!dir || (decision !== 'enabled' && decision !== 'declined')) return { ok: false }
    writeConsent(userDataDir, dir, decision)
    onDecision(dir, decision) // install/remove the hook
    return { ok: true }
  })
}
```

Add a test asserting `registerRecapHandlers` writes through on a non-foreign call using a fake `ipcMain` (mirror `llmIpc.integration.test.ts` if present; otherwise call the captured handler directly with a fake event `{ senderFrame: undefined }`). Run `pnpm vitest run src/main/recapConsent.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/recapConsent.ts src/main/recapConsent.test.ts
git commit -m "feat(terminal-recap): per-project consent store + recap:* IPC"
```

---

## Task 7: boardSchema — optional fields on TerminalBoard (CROSS-ZONE)

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts:40-46` (TerminalBoard) + its `toObject` terminal branch
- Test: existing `boardSchema` test file (add a round-trip case)

> **CROSS-ZONE:** coordinate on `ACTIVE-WORK.md` with `feat/text-font-toolbar` first. Additive optional fields → **no `SCHEMA_VERSION` bump**, no migration. Do NOT touch their TextElement/v6 lines.

- [ ] **Step 1: Add the fields**

```typescript
// src/renderer/src/lib/boardSchema.ts — TerminalBoard
export interface TerminalBoard extends BoardCommon {
  type: 'terminal'
  shell?: string
  launchCommand?: string
  cwd?: string
  port?: number
  /** App-learned (via the recap hook) Claude session id for this board. */
  agentSessionId?: string
  /** App-learned absolute path to this board's transcript JSONL. */
  agentTranscriptPath?: string
}
```

- [ ] **Step 2: Persist them in `toObject`**

Locate the terminal branch of `boardSchema.toObject` (the function that whitelists fields for serialization). Add `agentSessionId` and `agentTranscriptPath` alongside `shell`/`launchCommand`/`cwd`/`port` so they survive save/load. (If `toObject` spreads all known keys, confirm these are included.)

- [ ] **Step 3: Write a round-trip test**

```typescript
// in the boardSchema test file
it('persists agentSessionId + agentTranscriptPath on a terminal board', () => {
  const b = { id: 'b1', type: 'terminal', x: 0, y: 0, w: 400, h: 300, title: 'T',
    agentSessionId: 's1', agentTranscriptPath: '/t/s1.jsonl' }
  const out = toObject({ schemaVersion: SCHEMA_VERSION, viewport: { x: 0, y: 0, zoom: 1 }, boards: [b] })
  const t = out.boards[0] as Record<string, unknown>
  expect(t.agentSessionId).toBe('s1')
  expect(t.agentTranscriptPath).toBe('/t/s1.jsonl')
})
```

- [ ] **Step 4: Run + gate**

Run: `pnpm vitest run src/renderer/src/lib` then `pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/boardSchema.ts src/renderer/src/lib/*boardSchema*.test.ts
git commit -m "feat(terminal-recap): persist agentSessionId + agentTranscriptPath on TerminalBoard"
```

---

## Task 8: `pty.ts` — recap env provider seam

**Files:**
- Modify: `src/main/pty.ts` (the `pty.spawn(... env ...)` at ~:466-471)
- Test: `src/main/pty.integration.test.ts` (add a case) — or a focused unit if the spawn is injectable

- [ ] **Step 1: Add the injectable seam**

```typescript
// src/main/pty.ts — module scope (near other module state)
type RecapEnvProvider = (opts: { id: string; launchCommand?: string; cwd?: string }) => Record<string, string> | undefined
let recapEnvProvider: RecapEnvProvider | undefined
/** index.ts wires the policy (consent + claude detection) here; pty.ts stays decoupled. */
export function setRecapEnvProvider(fn: RecapEnvProvider | undefined): void {
  recapEnvProvider = fn
}
```

- [ ] **Step 2: Merge the extra env at spawn**

Change the spawn `env` at `pty.ts:466-471`:

```typescript
    let recapEnv: Record<string, string> | undefined
    try {
      recapEnv = recapEnvProvider?.({ id: opts.id, launchCommand: opts.launchCommand, cwd: opts.cwd })
    } catch {
      recapEnv = undefined // policy must never break a spawn
    }
    proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: safeCwd(opts.cwd),
      env: { ...process.env, ...(recapEnv ?? {}) } as Record<string, string>
    })
```

- [ ] **Step 3: Test the seam**

```typescript
// add to src/main/pty.integration.test.ts (or a new pty.recapenv.test.ts if spawn is hard to drive)
import { setRecapEnvProvider } from './pty'
it('recap env provider is consulted with the spawn opts', () => {
  const seen: unknown[] = []
  setRecapEnvProvider((o) => { seen.push(o); return { CANVAS_RECAP_BOARD: o.id } })
  // drive a spawn via the existing test harness for pty:spawn with { id:'b1', launchCommand:'claude' }
  // assert seen[0] === { id:'b1', launchCommand:'claude', cwd: undefined }
  setRecapEnvProvider(undefined) // reset
})
```

(If the existing pty test harness can't easily assert child env, assert the provider is *called* with the right opts — env propagation itself was proven in Task 0.)

- [ ] **Step 4: Run + gate**

Run: `pnpm vitest run src/main/pty` then `pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty.ts src/main/pty*.test.ts
git commit -m "feat(terminal-recap): setRecapEnvProvider seam → inject CANVAS_RECAP_BOARD at spawn"
```

---

## Task 9: `summaryLoop.ts` — terminal recap (structured {now,notes} → timeline)

**Files:**
- Modify: `src/main/summaryLoop.ts`
- Test: `src/main/summaryLoop.test.ts`

Add a `getAgentMilestones` dep; when a terminal board has milestones, summarize with a structured prompt → `{now, notes[]}`, then CODE assembles the markdown with REAL timestamps. Tolerant parse: non-JSON → NOW = whole text, no timeline.

- [ ] **Step 1: Write the failing test (markdown assembly + tolerant parse)**

```typescript
// add to src/main/summaryLoop.test.ts
import { buildRecapMarkdown, parseRecapPayload, RECAP_SYSTEM } from './summaryLoop'
import type { Milestone } from './agentTranscript'

describe('recap assembly', () => {
  const ms: Milestone[] = [
    { ts: Date.parse('2026-06-07T14:32:00Z'), role: 'user', text: 'review auth' },
    { ts: Date.parse('2026-06-07T14:35:00Z'), role: 'agent', text: 'found 3 issues' }
  ]
  it('parses structured payload', () => {
    expect(parseRecapPayload('{"now":"doing X","notes":["a","b"]}')).toEqual({ now: 'doing X', notes: ['a', 'b'] })
  })
  it('tolerates non-JSON → NOW only', () => {
    expect(parseRecapPayload('just prose')).toEqual({ now: 'just prose', notes: [] })
  })
  it('assembles markdown with REAL timestamps (HH:MM), not model text', () => {
    const md = buildRecapMarkdown('T', { now: 'Reviewing auth; resume → refresh-token', notes: ['You: review auth', 'Found 3 issues'] }, ms)
    expect(md).toContain('**Now:** Reviewing auth')
    expect(md).toMatch(/- \d\d:\d\d — You: review auth/)
    expect(md).toMatch(/- \d\d:\d\d — Found 3 issues/)
  })
})
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run src/main/summaryLoop.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement the helpers + dep + branch**

```typescript
// src/main/summaryLoop.ts — add imports
import { detectAgentCli, type Milestone } from './agentTranscript'

// add constants
export const RECAP_SYSTEM =
  'You are summarizing an AI coding agent session for a developer who wants to resume it. ' +
  'Return ONLY JSON: {"now": "<1-2 sentences: what the agent is doing now + the resume point>", ' +
  '"notes": ["<one short note per numbered milestone, in order>"]}. ' +
  'Be factual; do not invent. Do not include timestamps (the app adds them).'
export const MAX_MILESTONES = 12

export function parseRecapPayload(text: string): { now: string; notes: string[] } {
  try {
    const o = JSON.parse(text) as { now?: unknown; notes?: unknown }
    if (typeof o?.now === 'string') {
      const notes = Array.isArray(o.notes) ? o.notes.map((n) => String(n)) : []
      return { now: o.now, notes }
    }
  } catch {
    /* fall through */
  }
  return { now: text.trim(), notes: [] }
}

function hhmm(ts: number): string {
  if (!ts) return '--:--'
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** CODE assembles the recap markdown — real timestamps from milestones, notes from the model. */
export function buildRecapMarkdown(
  title: string,
  payload: { now: string; notes: string[] },
  milestones: Milestone[]
): string {
  const head = `# ${sanitizeTitle(title) || 'Recap'}\n\n**Now:** ${sanitizeSummary(payload.now).trim()}\n`
  const n = Math.min(payload.notes.length, milestones.length)
  if (n === 0) return head + '\n'
  const lines: string[] = ['']
  for (let i = 0; i < n; i++) {
    const note = sanitizeSummary(payload.notes[i]).replace(/\n/g, ' ').trim()
    lines.push(`- ${hhmm(milestones[i].ts)} — ${note}`)
  }
  return head + lines.join('\n') + '\n'
}

/** Build the numbered-milestone summarize input for a terminal recap. */
export function buildRecapInput(milestones: Milestone[]): SummarizeInput {
  const numbered = milestones
    .map((m, i) => `${i + 1}. [${m.role === 'user' ? 'you' : 'agent'}] ${m.text}`)
    .join('\n')
    .slice(0, MAX_INPUT_CHARS)
  return { system: RECAP_SYSTEM, text: numbered || 'No activity yet.' }
}
```

Add the dep to `SummaryLoopDeps`:

```typescript
// src/main/summaryLoop.ts — SummaryLoopDeps (append a field)
  /**
   * Terminal recap (this feature): MAIN-internal accessor for a board's distilled transcript
   * milestones. Optional + defensive (mirrors getTerminalRuntime): absent/throwing/empty → the
   * loop falls back to the config+runtime summary. NEVER an action surface — read-only.
   */
  getAgentMilestones?: (boardId: string, board: unknown) => Milestone[] | undefined
```

- [ ] **Step 4: Branch `doIntent` to the recap path**

In `doIntent`, after `board` is resolved and before the existing `runSummarize`, insert the recap branch:

```typescript
// src/main/summaryLoop.ts — inside doIntent, replacing the single summarize call
let milestones: Milestone[] | undefined
try {
  if ((board as RawBoard)?.type === 'terminal' && detectAgentCli(str((board as RawBoard).launchCommand)) === 'claude') {
    milestones = deps.getAgentMilestones?.(boardId, board)
  }
} catch {
  milestones = undefined
}
const config = readLlmConfig(deps.llmDataDir)
const useRecap = !!milestones && milestones.length > 0
const result = await runSummarize(
  config,
  useRecap ? buildRecapInput(milestones!) : buildSummarizeInput(board, runtime, now().getTime()),
  { fetch: fetchImpl, env, keyStore: createKeyStore(deps.llmDataDir, deps.encryptor), budget: createBudgetStore(deps.llmDataDir, now) }
)
if (!result.ok) return
if (deps.getCurrentDir() !== dir) return // BUG-006 TOCTOU (unchanged)
const mem = createCanvasMemory(dir)
try { mem.ensureScaffold() } catch (err) { console.warn('[summaryLoop] ensureScaffold failed (non-fatal)', err) }
const title = sanitizeTitle(str((board as RawBoard).title)) || boardId
const md = useRecap
  ? buildRecapMarkdown(title, parseRecapPayload(result.text), milestones!)
  : `# ${title}\n\n${sanitizeSummary(result.text)}\n`
mem.writeBoard(boardId, md)
// ... (index + project rollup rebuild unchanged) ...
```

(Keep the existing `buildMemoryIndex` / `buildProjectRollup` rebuild + the `finally` re-fire logic exactly as-is.)

- [ ] **Step 5: Write an integration test for the branch (fake fetch returns {now,notes})**

```typescript
// add to src/main/summaryLoop.test.ts
it('writes a NOW + timestamped timeline when getAgentMilestones returns milestones', async () => {
  // temp project dir + a fake fetch that returns {now,notes}; provider via a key or CANVAS_LLM_MOCK.
  // assert createCanvasMemory(dir).readBoard(id) contains "**Now:**" and a "- HH:MM — " line.
})
```

(Model it on the existing summaryLoop integration test: inject `fetch`, `env` with a key, `getCurrentDir`, `readProject`, and a stub `getAgentMilestones`.)

- [ ] **Step 6: Run + gate**

Run: `pnpm vitest run src/main/summaryLoop.test.ts && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/summaryLoop.ts src/main/summaryLoop.test.ts
git commit -m "feat(terminal-recap): summaryLoop terminal recap path (NOW + code-assembled timeline)"
```

---

## Task 10: `index.ts` + `projectIpc.ts` — wire it all together

**Files:**
- Modify: `src/main/index.ts` (:258-279 region)
- Modify: `src/main/projectIpc.ts` (project:open / project:current; add a recap-install hook callback)

- [ ] **Step 1: Compute the app-owned constants + map in index.ts**

```typescript
// src/main/index.ts — near other paths
import { readRecapMap, watchRecapMap, installRecapHook, removeRecapHook, type RecapMapEntry } from './agentRecapMap'
import { registerRecapHandlers, readConsent, type RecapDecision } from './recapConsent'
import { setRecapEnvProvider } from './pty'
import { detectAgentCli } from './agentTranscript'
import { join } from 'node:path'

const userData = app.getPath('userData')
const recapMapPath = join(userData, 'recap', 'session-map.jsonl')
const recordScript = join(__dirname, 'hooks', 'recordSession.js') // asarUnpack'd; see Step 6
let recapMap = new Map<string, RecapMapEntry>()
```

- [ ] **Step 2: Wire the env provider (consent-gated, claude-only)**

```typescript
// src/main/index.ts
setRecapEnvProvider(({ id, launchCommand, cwd }) => {
  const dir = getCurrentDir()
  if (!dir) return undefined
  if (readConsent(userData, dir) !== 'enabled') return undefined
  if (detectAgentCli(launchCommand) !== 'claude') return undefined
  return { CANVAS_RECAP_BOARD: id } // invisible; map path is baked into the hook args
})
```

- [ ] **Step 3: Start the map watcher + persist learned paths onto boards**

```typescript
// src/main/index.ts — after mainWindow exists
const stopRecapWatch = watchRecapMap(recapMapPath, (m) => {
  recapMap = m
  // push learned {sessionId, transcriptPath} onto the live boards (renderer persists to canvas.json)
  const patches = [...m.entries()].map(([boardId, e]) => ({ boardId, ...e }))
  mainWindow?.webContents.send('recap:learned', patches)
})
app.on('before-quit', () => stopRecapWatch())
```

(Renderer applies `recap:learned` via the existing board-patch path — see Task 12/15.)

- [ ] **Step 4: Provide `getAgentMilestones` to the summary loop**

```typescript
// src/main/index.ts — extend the createSummaryLoop({...}) call
import { extractMilestones } from './agentTranscript'
import { readFileSync, existsSync } from 'node:fs'

const summaryLoop = createSummaryLoop({
  llmDataDir,
  encryptor: llmEncryptor,
  getCurrentDir,
  readProject,
  getTerminalRuntime,
  getAgentMilestones: (boardId, board) => {
    const path =
      (board as { agentTranscriptPath?: string })?.agentTranscriptPath ?? recapMap.get(boardId)?.transcriptPath
    if (!path || !existsSync(path)) return undefined
    try {
      return extractMilestones(readFileSync(path, 'utf8'), { maxMilestones: 12, maxTextChars: 600 })
    } catch {
      return undefined
    }
  }
})
```

- [ ] **Step 5: Register recap IPC + hook-install policy + project-open install**

```typescript
// src/main/index.ts
registerRecapHandlers(ipcMain, () => mainWindow, userData, getCurrentDir, (projectPath, decision) => {
  if (decision === 'enabled') installRecapHook({ projectDir: projectPath, nodePath: process.execPath, scriptPath: recordScript, mapPath: recapMapPath })
  else removeRecapHook(projectPath, recordScript)
})
```

In `projectIpc.ts`, accept an `onProjectOpen(dir)` callback (default no-op) and call it where `scaffoldProjectMemory(r.dir)` is called in BOTH `project:open` and `project:current`. Wire it from index.ts to: `if (readConsent(userData, dir) === 'enabled') installRecapHook({...})` (so an already-consented project re-ensures the hook on open).

- [ ] **Step 6: asarUnpack the hook script**

In `electron-builder.yml` / `electron.vite.config.ts`, ensure `src/main/hooks/recordSession.js` is copied to `out/main/hooks/` at build AND `asarUnpack`ed (like `**/*.node`) so it has a real on-disk path for the hook `command`/`args`. Add `hooks/**` to the unpack globs; add a vite copy step (or place under a `resources/` dir resolved via `process.resourcesPath`). Verify `existsSync(recordScript)` in a `pnpm build` smoke.

- [ ] **Step 7: Run + gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run`
Expected: clean / PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts src/main/projectIpc.ts electron-builder.yml electron.vite.config.ts
git commit -m "feat(terminal-recap): wire env provider, consent IPC, map watcher, getAgentMilestones, hook install"
```

---

## Task 11: `agentRecapWatcher.ts` — hands-free transcript mtime watcher (Slice B)

**Files:**
- Create: `src/main/agentRecapWatcher.ts`
- Test: `src/main/agentRecapWatcher.test.ts`
- Modify: `src/main/index.ts` (start it from the `recap:learned` flow)

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/agentRecapWatcher.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createRecapWatcher } from './agentRecapWatcher'

describe('createRecapWatcher', () => {
  it('debounces and fires onIntent per board on change', async () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const w = createRecapWatcher({ debounceMs: 100, onIntent: (id) => fired.push(id), watchFile: () => () => {} })
    w.track('b1', '/t/s1.jsonl')
    w.kick('b1') // simulate an mtime change
    w.kick('b1')
    vi.advanceTimersByTime(150)
    expect(fired).toEqual(['b1'])
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run src/main/agentRecapWatcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement (inject `watchFile` so the unit test stays fs-free)**

```typescript
// src/main/agentRecapWatcher.ts
import { watch } from 'node:fs'

export interface RecapWatcherDeps {
  onIntent: (boardId: string) => void
  debounceMs?: number
  /** injectable for tests; default wraps fs.watch */
  watchFile?: (path: string, onChange: () => void) => () => void
}
export interface RecapWatcher {
  track(boardId: string, transcriptPath: string): void
  untrack(boardId: string): void
  kick(boardId: string): void // test seam: simulate a change
  dispose(): void
}

export function createRecapWatcher(deps: RecapWatcherDeps): RecapWatcher {
  const debounceMs = deps.debounceMs ?? 20_000
  const watchFile = deps.watchFile ?? ((p, cb) => {
    let w: ReturnType<typeof watch> | null = null
    try { w = watch(p, { persistent: false }, () => cb()) } catch { /* not yet */ }
    return () => { try { w?.close() } catch { /* closed */ } }
  })
  const disposers = new Map<string, () => void>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const fire = (id: string): void => {
    const t = timers.get(id)
    if (t) clearTimeout(t)
    timers.set(id, setTimeout(() => deps.onIntent(id), debounceMs))
  }
  return {
    track(boardId, transcriptPath) {
      disposers.get(boardId)?.()
      disposers.set(boardId, watchFile(transcriptPath, () => fire(boardId)))
    },
    untrack(boardId) {
      disposers.get(boardId)?.()
      disposers.delete(boardId)
      const t = timers.get(boardId)
      if (t) clearTimeout(t)
      timers.delete(boardId)
    },
    kick: fire,
    dispose() {
      for (const d of disposers.values()) d()
      for (const t of timers.values()) clearTimeout(t)
      disposers.clear()
      timers.clear()
    }
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm vitest run src/main/agentRecapWatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it in index.ts**

In the `recap:learned` handler (Task 10 Step 3), for each `{boardId, transcriptPath}` call `recapWatcher.track(boardId, transcriptPath)` (create one `createRecapWatcher({ onIntent: (id) => void summaryLoop.onIntent({ boardId: id }), debounceMs: 25_000 })` at startup; `dispose()` on `before-quit`).

- [ ] **Step 6: Gate + commit**

```bash
pnpm typecheck && pnpm vitest run src/main/agentRecapWatcher.test.ts
git add src/main/agentRecapWatcher.ts src/main/agentRecapWatcher.test.ts src/main/index.ts
git commit -m "feat(terminal-recap): hands-free transcript mtime watcher (slice B)"
```

---

## Task 12: preload — `window.api.recap`

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add the api + types**

```typescript
// src/preload/index.ts — near memory/llm api
export type RecapConsentState = 'enabled' | 'declined' | 'undecided'

// inside the `api` object:
recap: {
  getConsent: (): Promise<RecapConsentState> => ipcRenderer.invoke('recap:getConsent'),
  setConsent: (decision: 'enabled' | 'declined'): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('recap:setConsent', decision),
  /** main → renderer: learned {boardId, sessionId, transcriptPath}[] to persist on boards. */
  onLearned: (cb: (patches: { boardId: string; sessionId: string; transcriptPath: string }[]) => void): (() => void) => {
    const h = (_e: unknown, p: { boardId: string; sessionId: string; transcriptPath: string }[]): void => cb(p)
    ipcRenderer.on('recap:learned', h)
    return () => ipcRenderer.removeListener('recap:learned', h)
  }
}
```

- [ ] **Step 2: Gate + commit**

```bash
pnpm typecheck
git add src/preload/index.ts
git commit -m "feat(terminal-recap): preload window.api.recap (consent + learned)"
```

---

## Task 13: `RecapConsentModal.tsx` + mount + per-project trigger

**Files:**
- Create: `src/renderer/src/canvas/RecapConsentModal.tsx`
- Modify: `src/renderer/src/canvas/AppChrome.tsx`
- Test: `src/renderer/src/canvas/RecapConsentModal.test.tsx`

- [ ] **Step 1: Write the component (mirror SettingsModal portal/scrim)**

```tsx
// src/renderer/src/canvas/RecapConsentModal.tsx
import { createPortal } from 'react-dom'
import { useState, type ReactElement } from 'react'

export function RecapConsentModal({ onClose }: { onClose: () => void }): ReactElement {
  const [busy, setBusy] = useState(false)
  const [showSnippet, setShowSnippet] = useState(false)
  const decide = async (decision: 'enabled' | 'declined'): Promise<void> => {
    setBusy(true)
    try { await window.api.recap.setConsent(decision) } finally { setBusy(false); onClose() }
  }
  return createPortal(
    <div style={scrim} data-test="recap-consent-scrim" onPointerDown={() => !busy && onClose()}>
      <div style={card} role="dialog" aria-label="Agent recaps" data-test="recap-consent-modal"
           onPointerDown={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Turn on agent recaps for this project?</h2>
        <p>See what each terminal agent is doing at a glance. Expanse gives every terminal a
           flip-to-recap — a short “now” summary + a timestamped timeline of what the agent and you
           decided — so you can resume instantly instead of re-reading the whole session.</p>
        <p>To do this, Expanse adds <b>one hook</b> to this project’s <code>.claude/settings.local.json</code>
           (<b>gitignored — never committed</b>; it does <b>not</b> touch your global <code>~/.claude</code>
           or your own hooks). It records only each session’s id + transcript path.</p>
        <button style={linkBtn} onClick={() => setShowSnippet((v) => !v)} data-test="recap-what">
          {showSnippet ? '▾' : '▸'} What gets added?
        </button>
        {showSnippet && (
          <pre style={snippet}>{`.claude/settings.local.json
{ "hooks": { "SessionStart": [ { "matcher": "",
  "hooks": [ { "type": "command", "command": "<node>", "args": ["recordSession.js", "<map>"] } ] } ] } }`}</pre>
        )}
        <div style={assure}>
          <b>🔒 Your data stays yours</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>No Expanse server, no account, no telemetry — nothing is ever sent to us.</li>
            <li>Transcripts are read locally, on your machine.</li>
            <li>The only thing that leaves is a short, secret-scrubbed slice sent to the LLM provider
                <i> you</i> choose, with <i>your</i> key — only if you set one. Pick a local model → nothing leaves.</li>
            <li>File contents and command output are never sent.</li>
          </ul>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button disabled={busy} onClick={() => void decide('declined')} data-test="recap-decline">Not now</button>
          <button disabled={busy} onClick={() => void decide('enabled')} data-test="recap-enable"
                  style={{ fontWeight: 600 }}>Enable recaps</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
// styles (mirror SettingsModal token usage)
const scrim = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', zIndex: 1000 } as const
const card = { background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--r-board)', padding: 20, maxWidth: 460, boxShadow: 'var(--shadow-board)' } as const
const linkBtn = { background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 12 } as const
const snippet = { background: 'var(--inset)', padding: 10, borderRadius: 8, fontSize: 11, overflow: 'auto' } as const
const assure = { background: 'var(--inset)', borderRadius: 8, padding: 12, fontSize: 12, marginTop: 10 } as const
```

- [ ] **Step 2: Mount + trigger once per project in AppChrome**

```tsx
// src/renderer/src/canvas/AppChrome.tsx — add
const [askRecap, setAskRecap] = useState(false)
useEffect(() => {
  // ask once per project: when consent is 'undecided' for the current project
  let cancelled = false
  void window.api.recap.getConsent().then((s) => { if (!cancelled && s === 'undecided') setAskRecap(true) })
  return () => { cancelled = true }
}, [/* re-run on project change: pass the current project id/path as a dep from the store */])
// ...
{askRecap && <RecapConsentModal onClose={() => setAskRecap(false)} />}
```

(Use the project switch signal already available to AppChrome — e.g. the ProjectSwitcher store value — as the effect dep so it re-asks when a *different* undecided project opens.)

- [ ] **Step 3: Write a component test (enable path calls setConsent)**

```tsx
// src/renderer/src/canvas/RecapConsentModal.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RecapConsentModal } from './RecapConsentModal'

describe('RecapConsentModal', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = { recap: { setConsent: vi.fn().mockResolvedValue({ ok: true }) } }
  })
  it('Enable → setConsent("enabled") + closes', async () => {
    const onClose = vi.fn()
    render(<RecapConsentModal onClose={onClose} />)
    fireEvent.click(screen.getByTestId('recap-enable'))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((window as unknown as { api: { recap: { setConsent: ReturnType<typeof vi.fn> } } }).api.recap.setConsent)
      .toHaveBeenCalledWith('enabled')
  })
})
```

- [ ] **Step 4: Run + gate**

Run: `pnpm vitest run src/renderer/src/canvas/RecapConsentModal.test.tsx && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/RecapConsentModal.tsx src/renderer/src/canvas/RecapConsentModal.test.tsx src/renderer/src/canvas/AppChrome.tsx
git commit -m "feat(terminal-recap): consent modal (benefit-first + privacy assurance) + per-project trigger"
```

---

## Task 14: Settings — "Agent recaps" feature-flag toggle

**Files:**
- Modify: `src/renderer/src/canvas/SettingsModal.tsx`

- [ ] **Step 1: Add the toggle**

Add a section that loads the current consent (`window.api.recap.getConsent()`), renders a checkbox "Agent recaps (this project)", and on change calls `window.api.recap.setConsent('enabled'|'declined')`. Mirror the existing `useEffect` cancellation-guard load pattern (`SettingsModal.tsx:45-68`). Disable with a hint when no project is open.

- [ ] **Step 2: Gate + commit**

```bash
pnpm typecheck && pnpm vitest run src/renderer
git add src/renderer/src/canvas/SettingsModal.tsx
git commit -m "feat(terminal-recap): Settings 'Agent recaps' per-project toggle"
```

---

## Task 15: TerminalBoard flip + `RecapView`

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`
- Create: `src/renderer/src/canvas/RecapView.tsx`
- Apply `recap:learned` board patches (canvasStore.updateBoard)
- Test: `src/renderer/src/canvas/RecapView.test.tsx`

- [ ] **Step 1: RecapView (back face) — reuse stripHeading**

```tsx
// src/renderer/src/canvas/RecapView.tsx
import { useEffect, useState, useCallback, type ReactElement } from 'react'
import { stripHeading } from '../lib/digest'
import { IconBtn } from './BoardFrame'

export function RecapView({ boardId }: { boardId: string }): ReactElement {
  const [md, setMd] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const out = await window.api.memory.readBoards([boardId])
    setMd(out[boardId])
  }, [boardId])
  useEffect(() => { void load() }, [load])
  const refresh = useCallback(async () => {
    setBusy(true)
    try { await window.api.memory.refresh(boardId); await load() } finally { setBusy(false) }
  }, [boardId, load])
  const body = md ? stripHeading(md) : ''
  return (
    <div style={{ position: 'absolute', inset: 0, padding: 14, overflow: 'auto', background: 'var(--surface)' }}
         data-test="recap-view">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>RECAP</span>
        <IconBtn name="refresh" title="Refresh recap" active={busy} onClick={() => void refresh()} />
      </div>
      {body
        ? <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.5 }} data-test="recap-body">{body}</div>
        : <div style={{ color: 'var(--text-3)', fontSize: 12 }} data-test="recap-empty">
            No recap yet. {busy ? 'Updating…' : 'Click ⟳, or enable Agent recaps in Settings.'}
          </div>}
    </div>
  )
}
```

- [ ] **Step 2: Add the flip control + flipped face to TerminalBoard**

Add `const [flipped, setFlipped] = useState(false)` and a flip `IconBtn` in the `actions` cluster (`TerminalBoard.tsx:698`):

```tsx
<IconBtn name="back" title={flipped ? 'Show terminal' : 'Show recap'} active={flipped} onClick={() => setFlipped((v) => !v)} />
```

Wrap the content well in a flip container so the xterm stays mounted (front), `RecapView` is the back:

```tsx
// inside the BoardFrame content slot, wrap existing terminal well + add back face
<div style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d',
  transition: prefersReducedMotion() ? 'none' : 'transform .35s',
  transform: flipped ? 'rotateY(180deg)' : 'none' }}>
  <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden' }}>
    {/* existing terminal well (xterm mount) stays here — never unmounted */}
  </div>
  <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}>
    {flipped && <RecapView boardId={board.id} />}
  </div>
</div>
```

(Keep `attachWebgl`/`fit` on the front exactly as-is. `prefersReducedMotion` is imported from `../lib/motion`.)

- [ ] **Step 3: Apply `recap:learned` patches to boards**

In the canvas bootstrap (where other main→renderer listeners live, e.g. App.tsx), subscribe:

```tsx
useEffect(() => window.api.recap.onLearned((patches) => {
  const s = useCanvasStore.getState()
  for (const p of patches) {
    if (s.boards[p.boardId]) s.updateBoard(p.boardId, { agentSessionId: p.sessionId, agentTranscriptPath: p.transcriptPath })
  }
}), [])
```

- [ ] **Step 4: Component test for RecapView**

```tsx
// src/renderer/src/canvas/RecapView.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { RecapView } from './RecapView'

describe('RecapView', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      memory: { readBoards: vi.fn().mockResolvedValue({ b1: '# T\n\n**Now:** doing X\n\n- 14:32 — review auth\n' }),
                refresh: vi.fn().mockResolvedValue({ ok: true }) }
    }
  })
  it('renders the recap body (heading stripped)', async () => {
    render(<RecapView boardId="b1" />)
    await waitFor(() => expect(screen.getByTestId('recap-body').textContent).toContain('**Now:** doing X'))
    expect(screen.getByTestId('recap-body').textContent).toContain('14:32 — review auth')
  })
})
```

- [ ] **Step 5: Run + gate**

Run: `pnpm vitest run src/renderer/src/canvas/RecapView.test.tsx && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/RecapView.tsx src/renderer/src/canvas/RecapView.test.tsx src/renderer/src/canvas/boards/TerminalBoard.tsx src/renderer/src/canvas/App.tsx
git commit -m "feat(terminal-recap): flip terminal to recap back-face + apply learned transcript paths"
```

---

## Task 16: e2e — fake-claude fixture + flip/refresh chain

**Files:**
- Create: `e2e/recap.e2e.ts`
- Create: `e2e/fixtures/fake-claude.mjs` (writes a transcript JSONL + emits a mapping line)
- May modify: `src/main/e2eMain.ts` (a CANVAS_E2E seam to point the recap map + a deterministic recap fetch, if needed)

The e2e proves the chain WITHOUT a network LLM. Strategy: (1) seed a terminal board; (2) write a canned `board-<id>.md` into the temp project's `.canvas/memory/` via an e2e hook (proves flip + RecapView render — deterministic); (3) drive `memory:refresh` with a fake-claude transcript + the mock provider to prove the summarize path produces a NOW line.

- [ ] **Step 1: Fake-claude fixture**

```js
// e2e/fixtures/fake-claude.mjs — pretends to be `claude`: writes a transcript + a mapping line, then idles.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const map = process.env.CANVAS_RECAP_MAP
const home = process.env.CANVAS_FAKE_HOME // e2e-controlled
const board = process.env.CANVAS_RECAP_BOARD || 'b'
const slug = (process.env.CANVAS_FAKE_CWD || 'p').replace(/[^a-zA-Z0-9]/g, '-')
const dir = join(home, '.claude', 'projects', slug)
mkdirSync(dir, { recursive: true })
const sid = 'fake-sess'
const tp = join(dir, sid + '.jsonl')
const T = '2026-06-07T14:32:00.000Z'
writeFileSync(tp, [
  JSON.stringify({ type: 'user', timestamp: T, message: { role: 'user', content: 'review the auth service' } }),
  JSON.stringify({ type: 'assistant', timestamp: T, message: { role: 'assistant', content: [{ type: 'text', text: 'Found 3 issues in token.ts' }] } })
].join('\n') + '\n')
if (map) appendFileSync(map, JSON.stringify({ boardId: board, sessionId: sid, transcriptPath: tp, cwd: process.env.CANVAS_FAKE_CWD, ts: 1 }) + '\n')
setInterval(() => {}, 1 << 30) // keep "running"
```

- [ ] **Step 2: Write the e2e spec**

```typescript
// e2e/recap.e2e.ts
import { test, expect } from './fixtures'
import { seed } from './helpers'

test('flip shows the recap for a terminal board', async ({ page }) => {
  // (a) seed a terminal board + write a canned recap md via an e2e hook (deterministic UI proof)
  const id = await page.evaluate(() => {
    const g = globalThis as unknown as { __canvasE2E: { seedBoard: (t: string, p?: object) => string } }
    return g.__canvasE2E.seedBoard('terminal', { launchCommand: 'claude', agentTranscriptPath: 'x' })
  })
  await page.evaluate(async (boardId) => {
    const g = globalThis as unknown as { __canvasE2E: { writeRecapMd?: (id: string, md: string) => void } }
    g.__canvasE2E.writeRecapMd?.(boardId, '# T\n\n**Now:** Reviewing auth; resume → refresh-token\n\n- 14:32 — review auth\n')
  }, id)
  // (b) flip: click the flip control, assert RecapView shows NOW + a timeline line
  await page.getByTestId(`flip-${id}`).click() // add data-test={`flip-${board.id}`} to the flip IconBtn
  await expect(page.getByTestId('recap-body')).toContainText('Reviewing auth')
  await expect(page.getByTestId('recap-body')).toContainText('14:32 — review auth')
})
```

(Add an e2e hook `writeRecapMd(id, md)` in `e2eHooks.ts` that calls the same `memory` path or writes via a main IPC test seam; and add `data-test={`flip-${board.id}`}` to the flip `IconBtn`.)

- [ ] **Step 3: Run the e2e locally (Windows leg)**

Run: `pnpm build; pnpm test:e2e` (or the project's e2e command) — single spec: `pnpm exec playwright test e2e/recap.e2e.ts`
Expected: PASS (flip reveals the recap).

- [ ] **Step 4: Commit**

```bash
git add e2e/recap.e2e.ts e2e/fixtures/fake-claude.mjs src/renderer/src/smoke/e2eHooks.ts src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "test(terminal-recap): e2e flip-to-recap chain + fake-claude fixture"
```

---

## Task 17: Full gate + real-`claude` live verification (SIGN-OFF)

**Files:** none (verification + docs)

- [ ] **Step 1: Full local gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run`
Expected: all clean. Record the test count.

- [ ] **Step 2: Pre-push e2e matrix**

Run: `git push -u origin feat/terminal-recap` (pre-push hook runs `pnpm test:e2e:matrix` — Win-native + Linux-Docker). If the browser-trio flakes, rerun (memory `e2e-browser-trio-flake`).
Expected: matrix green.

- [ ] **Step 3: Real-`claude` live verification (the bar)**

`pnpm dev`. Open a project, accept the consent modal (Enable). Open a terminal board, run a REAL `claude` doing a real task (e.g. "review the auth service in this repo"). Let it work, then **flip the board** → confirm the recap shows an accurate NOW line + a timestamped timeline of meaningful moments (no read/edit/grep noise). Edit/continue → confirm the watcher refreshes it within ~25s. Capture a screenshot to `.shots/`.

- [ ] **Step 4: Record the verification + spec sign-off**

Append a "Verified 2026-06-__: live `claude` recap accurate; screenshot `.shots/recap.png`" banner to the spec. Commit.

```bash
git add docs/superpowers/specs/2026-06-07-terminal-cli-recap-design.md .shots/recap.png
git commit -m "docs(terminal-recap): live-verified — flip-to-recap working with real claude"
```

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` flow: open a PR to `main` (after the cross-zone `boardSchema.ts` coordination with text-font-toolbar), re-run the gate, merge sequentially per CLAUDE.md.

---

## Self-Review (author checklist — completed)

- **Spec coverage:** transcript source (T1–T2), hook+env identity (T0,T3–T5,T8,T10), consent modal + control plane (T6,T12–T14), recap content NOW+timeline (T9), flip UI (T15), slice B watcher (T11), persistence/resume groundwork (T7), cost/security (T6/T9 secret-scrub via `sanitizeSummary`; no tool bodies — T2 drops tool records), e2e + live verify (T16–T17). All mapped.
- **Placeholder scan:** code provided for every code step; UI wiring steps name exact files/anchors. Two intentionally-described (not code-dumped) spots — the boardSchema `toObject` branch (Task 7 Step 2) and the AppChrome project-change effect dep (Task 13 Step 2) — depend on lines owned/!verified and are called out explicitly for the implementer to confirm against the live file.
- **Type consistency:** `Milestone`, `RecapMapEntry`, `RecapDecision`, `RecapConsentState`, `getAgentMilestones`, `buildRecapMarkdown`/`parseRecapPayload`/`buildRecapInput`, `setRecapEnvProvider`, `installRecapHook`/`removeRecapHook`/`readRecapMap`/`watchRecapMap`, `createRecapWatcher` — names consistent across tasks.
- **Secret-scrub note:** `sanitizeSummary` (existing) already strips control/bidi + caps; add the `sk-…`/`ghp_…`/`AKIA…` redaction either into `buildRecapInput` (before egress) — add as a small step in Task 9 if not already covered by a pre-egress scrub. (Implementer: add a `redactSecrets(text)` pass in `buildRecapInput`.)
