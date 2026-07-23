/**
 * Voice cloud STT — file-tree symbol provider (Phase 2, decision #1; MAIN only). Scans the
 * OPEN project's source files, extracts code-shaped identifiers, frequency-ranks them, and
 * exposes two sets:
 *   - `bias`: the top-30 (long biasing glossaries measurably backfire — STT-ACCURACY.md §3.1),
 *     fed to gpt-4o-transcribe's `prompt`.
 *   - `dict`: the FULL uncapped set, the formatRestore dictionary that recovers the long tail
 *     the prompt can't hold (§3.2).
 *
 * The scan is async + bounded (ignore node_modules/.git/build dirs, cap files + per-file bytes)
 * and cached: `get()` returns the last-built sets synchronously (empty until the first build —
 * biasing/restore just no-op), and rebuilds in the background when the project changes or the
 * cache goes stale. Nothing here touches the network or the key; it is pure local file reading.
 */
import { readdir, readFile } from 'fs/promises'
import type { Dirent } from 'fs'
import { join, extname } from 'path'
import type { CloudSymbolSets } from './cloudSttEngine'

/** Directories never worth scanning (deps, VCS, build output, our own data dir). */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.canvas',
  'dist',
  'build',
  'out',
  'release',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target'
])

/** Extensions we treat as code (identifiers here are worth biasing; prose files are skipped). */
const SOURCE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.scala',
  '.css',
  '.scss',
  '.vue',
  '.svelte'
])

/** Bounds so a huge repo can't stall MAIN or balloon memory. */
const MAX_FILES = 4000
const MAX_FILE_BYTES = 512 * 1024
const DEFAULT_BIAS_CAP = 30
const DEFAULT_DICT_CAP = 5000

/** JS/TS keywords + a few universal English fillers that are NOT worth biasing (they'd waste
 *  the ≤30 prompt slots and can only ever rewrite to themselves in formatRestore). */
const STOPWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'import',
  'export',
  'from',
  'default',
  'class',
  'extends',
  'interface',
  'type',
  'enum',
  'public',
  'private',
  'protected',
  'static',
  'async',
  'await',
  'true',
  'false',
  'null',
  'undefined',
  'void',
  'this',
  'super',
  'new',
  'delete',
  'typeof',
  'instanceof',
  'string',
  'number',
  'boolean',
  'object',
  'symbol',
  'any',
  'unknown',
  'never',
  'readonly',
  'yield',
  'while',
  'break',
  'continue',
  'switch',
  'case',
  'throw',
  'catch',
  'finally',
  'else',
  'then',
  'value',
  'index',
  'props',
  'state',
  'error',
  'result',
  'length',
  'push',
  'slice',
  'filter',
  'map',
  'forEach',
  'self',
  'none',
  'false',
  'true'
])

/**
 * True for an identifier distinctive enough to bias/restore: a camelCase hump, an ACRONYM run,
 * an underscore/dollar/digit, OR a long-enough lowercase word that is not a keyword/stopword.
 * Plain short common words are rejected — biasing on them hurts, and folding them adds noise.
 */
export function isDistinctive(id: string): boolean {
  if (/[a-z][A-Z]/.test(id) || /[A-Z]{2}[a-z]/.test(id)) return true // camelCase / ACRONYMFollowed
  if (/[_$]/.test(id)) return true // snake_case / $stores
  if (/[A-Z]/.test(id) && id.length >= 3) return true // PascalCase / SHOUT
  if (/\d/.test(id) && id.length >= 3) return true // has a digit (utf8, sha1, v2)
  return id.length >= 5 && !STOPWORDS.has(id) // an all-lowercase word long enough to be a term
}

/**
 * Extract distinctive identifiers (WITH repeats — the caller counts frequency) from one file's
 * text. Matches JS/C-family identifier tokens; dotted/qualified names split naturally (`a.b` →
 * `a`,`b`), which is correct: each is its own symbol and formatRestore rejoins by separator.
 */
export function extractIdentifiers(text: string): string[] {
  const out: string[] = []
  const re = /[A-Za-z_$][A-Za-z0-9_$]{1,}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const id = m[0]
    if (id.length <= 40 && isDistinctive(id)) out.push(id)
  }
  return out
}

/** Rank counted identifiers → { bias: top-N, dict: full (capped by frequency) }. */
export function rankSymbols(
  counts: Map<string, number>,
  opts: { biasCap?: number; dictCap?: number } = {}
): CloudSymbolSets {
  const biasCap = opts.biasCap ?? DEFAULT_BIAS_CAP
  const dictCap = opts.dictCap ?? DEFAULT_DICT_CAP
  // Sort by frequency desc, then alphabetically for a stable order across runs.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const dict = ranked.slice(0, dictCap).map(([id]) => id)
  const bias = ranked.slice(0, biasCap).map(([id]) => id)
  return { bias, dict }
}

export interface WalkDeps {
  readdir?: typeof readdir
  readFile?: typeof readFile
  maxFiles?: number
  maxFileBytes?: number
}

/**
 * Walk a project dir and count distinctive identifiers across its source files. Bounded by
 * MAX_FILES / MAX_FILE_BYTES; ignored dirs are pruned. Never throws — an unreadable file/dir is
 * skipped so a permission hiccup can't fail dictation.
 */
export async function scanProjectSymbols(
  dir: string,
  deps: WalkDeps = {}
): Promise<{ counts: Map<string, number>; files: number }> {
  const rd = deps.readdir ?? readdir
  const rf = deps.readFile ?? readFile
  const maxFiles = deps.maxFiles ?? MAX_FILES
  const maxBytes = deps.maxFileBytes ?? MAX_FILE_BYTES
  const counts = new Map<string, number>()
  let files = 0
  const queue: string[] = [dir]

  while (queue.length && files < maxFiles) {
    const current = queue.shift()!
    let entries: Dirent[]
    try {
      entries = (await rd(current, { withFileTypes: true })) as Dirent[]
    } catch {
      continue // unreadable dir — skip
    }
    for (const ent of entries) {
      if (files >= maxFiles) break
      const name = ent.name
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(name) && !name.startsWith('.')) queue.push(join(current, name))
        continue
      }
      if (!ent.isFile() || !SOURCE_EXT.has(extname(name).toLowerCase())) continue
      files++
      let text: string
      try {
        const buf = await rf(join(current, name))
        text = buf.toString('utf8', 0, Math.min(buf.length, maxBytes))
      } catch {
        continue
      }
      for (const id of extractIdentifiers(text)) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return { counts, files }
}

export interface SymbolProvider {
  /** The current cached sets — synchronous, empty until the first build completes. */
  get(): CloudSymbolSets
  /** Force a rebuild (project open / manual). Debounced + de-duped internally. */
  refresh(): void
  /** Drop the cache (project close). */
  reset(): void
}

export interface SymbolProviderDeps {
  getProjectDir: () => string | null
  /** Injectable scanner for tests; default walks the real fs. */
  scan?: (dir: string) => Promise<{ counts: Map<string, number>; files: number }>
  biasCap?: number
  dictCap?: number
  /** Rebuild if the cache is older than this on a get() (default 5 min). */
  ttlMs?: number
}

const EMPTY: CloudSymbolSets = { bias: [], dict: [] }

/**
 * Cache + refresh wrapper. `get()` returns the last-built sets immediately and kicks off a
 * background rebuild when the project dir changed or the cache went stale — so a single utterance
 * never blocks on the scan, and the first hold after a project switch just runs unbiased until
 * the (fast) rebuild lands.
 */
export function createSymbolProvider(deps: SymbolProviderDeps): SymbolProvider {
  const scan = deps.scan ?? ((dir: string) => scanProjectSymbols(dir))
  const ttlMs = deps.ttlMs ?? 5 * 60_000
  let cache: CloudSymbolSets = EMPTY
  let cachedDir: string | null = null
  let builtAt = 0
  let building = false

  const rebuild = (dir: string): void => {
    if (building) return
    building = true
    void scan(dir)
      .then(({ counts }) => {
        cache = rankSymbols(counts, { biasCap: deps.biasCap, dictCap: deps.dictCap })
        cachedDir = dir
        builtAt = Date.now()
      })
      .catch(() => {
        // Leave the previous cache in place — a failed scan must not break dictation.
      })
      .finally(() => {
        building = false
      })
  }

  const maybeRefresh = (): void => {
    const dir = deps.getProjectDir()
    if (!dir) {
      cache = EMPTY
      cachedDir = null
      return
    }
    if (dir !== cachedDir || Date.now() - builtAt > ttlMs) rebuild(dir)
  }

  return {
    get(): CloudSymbolSets {
      maybeRefresh()
      // Only serve a cache built for the CURRENT project (a just-switched project returns EMPTY
      // until its background build lands, never the previous project's symbols).
      return cachedDir && cachedDir === deps.getProjectDir() ? cache : EMPTY
    },
    refresh(): void {
      const dir = deps.getProjectDir()
      if (dir) rebuild(dir)
    },
    reset(): void {
      cache = EMPTY
      cachedDir = null
      builtAt = 0
    }
  }
}
