/**
 * Jarvis J5 — persistent conversation history (D4′). Two concerns, one purpose:
 *
 * 1. The per-project history file `<project>/.canvas/memory/jarvis/history.json`
 *    (ADR 0009 isolation — it lives in the same `.canvas/memory/` tree the context
 *    subsystem writes, so the default-private `.canvas/.gitignore` already covers it).
 *    Pure file I/O keyed by an explicit projectDir (testable without Electron), atomic
 *    writes, one repair funnel both read and write pass through (jarvisConfig pattern).
 *
 * 2. The per-project CONSENT for writing it — same posture as the recap/context
 *    subsystem: an explicit per-project grant stored in userData (NEVER the project
 *    folder), decisions 'enabled' | 'declined', absent = undecided → jarvisIpc asks
 *    through the existing fail-closed confirm before the first persist.
 *
 * Rolling-summary compression (D4′): the prompt window stays HISTORY_PROMPT_WINDOW
 * turns; once the stored transcript grows past COMPRESS_TRIGGER, everything older than
 * the window folds into a deterministic one-line-per-turn summary that rides the system
 * prompt — free, offline, and testable (no paid summarization call for a voice sidekick).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { HISTORY_PROMPT_WINDOW, type JarvisTurn } from './jarvisPersona'

export interface JarvisHistoryFile {
  turns: JarvisTurn[]
  /** Rolling summary of the turns already folded out of `turns` ('' = none yet). */
  summary: string
}

/** Mirror of jarvisIpc's transcript bound (one spoken utterance). */
const MAX_TURN_TEXT_LEN = 4000
/** Stored-turn hard cap (same as jarvisIpc's MAX_HISTORY_TURNS — repair-time bound). */
const MAX_STORED_TURNS = 200
/** Summary hard cap; oldest lines drop first (the newest context matters most). */
export const MAX_SUMMARY_LEN = 4000
/** One folded turn's summary line length. */
const SUMMARY_LINE_LEN = 160
/** Compress once the transcript is this far past the prompt window (hysteresis — folding
 *  on every turn past 24 would rewrite the summary constantly for no prompt benefit). */
export const COMPRESS_TRIGGER = HISTORY_PROMPT_WINDOW * 2

export function jarvisHistoryFileFor(projectDir: string): string {
  return join(projectDir, '.canvas', 'memory', 'jarvis', 'history.json')
}

export function emptyJarvisHistory(): JarvisHistoryFile {
  return { turns: [], summary: '' }
}

/** Coerce an unknown parsed value into a valid history file (read/write both funnel here). */
export function repairJarvisHistory(p: unknown): JarvisHistoryFile {
  if (typeof p !== 'object' || p === null) return emptyJarvisHistory()
  const o = p as { turns?: unknown; summary?: unknown }
  const turns: JarvisTurn[] = Array.isArray(o.turns)
    ? o.turns
        .filter(
          (t): t is { role: string; text: string } =>
            typeof t === 'object' &&
            t !== null &&
            ((t as { role?: unknown }).role === 'user' ||
              (t as { role?: unknown }).role === 'assistant') &&
            typeof (t as { text?: unknown }).text === 'string'
        )
        .map((t) => ({
          role: t.role as JarvisTurn['role'],
          text: t.text.slice(0, MAX_TURN_TEXT_LEN)
        }))
        .slice(-MAX_STORED_TURNS)
    : []
  const summary = typeof o.summary === 'string' ? o.summary.slice(-MAX_SUMMARY_LEN) : ''
  return { turns, summary }
}

export function readJarvisHistory(projectDir: string): JarvisHistoryFile {
  const file = jarvisHistoryFileFor(projectDir)
  if (!existsSync(file)) return emptyJarvisHistory()
  try {
    return repairJarvisHistory(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyJarvisHistory()
  }
}

export function writeJarvisHistory(projectDir: string, h: JarvisHistoryFile): void {
  const file = jarvisHistoryFileFor(projectDir)
  mkdirSync(join(projectDir, '.canvas', 'memory', 'jarvis'), { recursive: true })
  writeFileAtomic.sync(file, JSON.stringify(repairJarvisHistory(h), null, 2), 'utf8')
}

/** Clear = delete the file (the jarvis/ dir may stay — it is empty and ignored). */
export function clearJarvisHistory(projectDir: string): void {
  try {
    rmSync(jarvisHistoryFileFor(projectDir), { force: true })
  } catch {
    /* locked/failed delete is not worth a turn error — the next write clobbers it */
  }
}

/** One folded turn, for the ear of the model, one line. */
function summaryLine(t: JarvisTurn): string {
  const who = t.role === 'user' ? 'User' : 'Assistant'
  const text = t.text.replace(/\s+/g, ' ').trim()
  return `${who}: ${text.slice(0, SUMMARY_LINE_LEN)}${text.length > SUMMARY_LINE_LEN ? '…' : ''}`
}

/**
 * Fold everything older than the prompt window into the rolling summary once the
 * transcript passes COMPRESS_TRIGGER. Pure — jarvisIpc runs it before each persist.
 * The summary is append-only until MAX_SUMMARY_LEN, then the OLDEST lines drop.
 */
export function compressJarvisHistory(
  h: JarvisHistoryFile,
  window: number = HISTORY_PROMPT_WINDOW,
  trigger: number = COMPRESS_TRIGGER
): JarvisHistoryFile {
  if (h.turns.length <= trigger) return h
  const folded = h.turns.slice(0, h.turns.length - window)
  const kept = h.turns.slice(h.turns.length - window)
  const lines = [h.summary, ...folded.map(summaryLine)].filter((l) => l.length > 0)
  let summary = lines.join('\n')
  if (summary.length > MAX_SUMMARY_LEN) {
    summary = summary.slice(-MAX_SUMMARY_LEN)
    const firstBreak = summary.indexOf('\n')
    if (firstBreak >= 0) summary = summary.slice(firstBreak + 1) // drop the cut partial line
  }
  return { turns: kept, summary }
}

// ── Per-project consent (userData store — recapConsent/orchestrationConsent posture) ──

export type JarvisHistoryDecision = 'enabled' | 'declined'

/**
 * BUG-022 canonicalization, copied from recapConsent/orchestrationConsent (deliberately
 * duplicated there too — each consent store is self-contained): trim a trailing
 * separator + case-fold Windows-style paths so the SAME project reopened via an
 * equivalent spelling never re-prompts.
 */
function canonicalizeProjectPath(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  return /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')
    ? trimmed.toLowerCase()
    : trimmed
}

function consentFileFor(userDataDir: string): string {
  return join(userDataDir, 'jarvis-history-consent.json')
}

function readAllConsents(userDataDir: string): Record<string, JarvisHistoryDecision> {
  const f = consentFileFor(userDataDir)
  if (!existsSync(f)) return {}
  try {
    const p = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
    const out: Record<string, JarvisHistoryDecision> = {}
    for (const [k, v] of Object.entries(p)) {
      if (v === 'enabled' || v === 'declined') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** The persisted decision for a project; undefined = undecided (ask before persisting). */
export function readJarvisHistoryConsent(
  userDataDir: string,
  projectPath: string
): JarvisHistoryDecision | undefined {
  return readAllConsents(userDataDir)[canonicalizeProjectPath(projectPath)]
}

/** Drop a project's stored decision so the next persist RE-ASKS (the Settings
 *  re-choose-'Per project' gesture — a decline must not be permanent). */
export function deleteJarvisHistoryConsent(userDataDir: string, projectPath: string): void {
  const all = readAllConsents(userDataDir)
  const key = canonicalizeProjectPath(projectPath)
  if (!(key in all)) return
  delete all[key]
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(consentFileFor(userDataDir), JSON.stringify(all, null, 2), 'utf8')
}

export function writeJarvisHistoryConsent(
  userDataDir: string,
  projectPath: string,
  decision: JarvisHistoryDecision
): void {
  const all = readAllConsents(userDataDir)
  all[canonicalizeProjectPath(projectPath)] = decision
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(consentFileFor(userDataDir), JSON.stringify(all, null, 2), 'utf8')
}
