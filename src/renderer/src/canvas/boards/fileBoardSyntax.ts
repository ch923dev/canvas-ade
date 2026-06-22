/**
 * File board (S3) - the pure CodeMirror 6 theme + Lezer highlighter + language resolution,
 * factored out of `FileBoard.tsx` (keeps that component under the max-lines gate and isolates
 * the editor-engine concern). No React here.
 *
 * One syntax palette feeds BOTH the live editor's `HighlightStyle` and the static snapshot's
 * colour highlighter, so the two render paths can't drift. CodeMirror 6 runs under the prod
 * CSP `script-src 'self'` (no eval / no blob workers) - that is the whole reason it replaced
 * Monaco (KICKOFF section 3).
 */
import { EditorView, keymap } from '@uiw/react-codemirror'
import type { Extension } from '@uiw/react-codemirror'
import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from '@codemirror/language'
import { search, searchKeymap } from '@codemirror/search'
import { highlightCode, tags as t } from '@lezer/highlight'
import type { Highlighter, Tag } from '@lezer/highlight'
// Explicit per-language imports (NOT the `@uiw/codemirror-extensions-langs` barrel): the barrel
// statically bundles ~103 grammars (the whole `@codemirror/legacy-modes` pack) and its runtime
// `loadLanguage(name)` name-indexing defeats tree-shaking, so the FileBoard chunk dragged in every
// grammar. We import ONLY the modern `@codemirror/lang-*` packs reachable from `LANG_BY_EXT` and
// resolve them through a static map below, so the bundler can drop everything else.
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { css } from '@codemirror/lang-css'
import { sass } from '@codemirror/lang-sass'
import { less } from '@codemirror/lang-less'
import { html } from '@codemirror/lang-html'
import { xml } from '@codemirror/lang-xml'
import { vue } from '@codemirror/lang-vue'
import { php } from '@codemirror/lang-php'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { sql, StandardSQL } from '@codemirror/lang-sql'

// -- Size / format gates -----------------------------------------------------------
/** Text files larger than this aren't loaded into the editor - show the guard instead. */
export const LARGE_TEXT_BYTES = 2 * 1024 * 1024
/** Raster/SVG images larger than this aren't decoded - show the guard instead. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024
/** Above this char count we skip the Lezer parse (keep the snapshot snappy) -> plain text. */
const HIGHLIGHT_MAX_CHARS = 200_000
/** Chars sniffed for a NUL -> "this is binary, don't show it as code". */
const BINARY_SNIFF_CHARS = 4096

// -- Viewer font size (sticky, localStorage-backed; NO per-board schema) -----------
// A global "viewer font" preference, mirroring the terminal's sticky default. Boards open at
// this size; A-/A+ (or Ctrl/Cmd +/-) adjust the live board AND update the sticky default, so
// new boards + reloads inherit it. Deliberately not persisted per-board (keeps S3 schema-free).
export const DEFAULT_FILE_FONT = 13
const FILE_FONT_MIN = 9
const FILE_FONT_MAX = 28
const FILE_FONT_KEY = 'canvas-ade:file-font'

export function clampFileFont(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FILE_FONT
  return Math.min(FILE_FONT_MAX, Math.max(FILE_FONT_MIN, Math.round(n)))
}

export function readStickyFileFont(): number {
  try {
    const raw = localStorage.getItem(FILE_FONT_KEY)
    return raw ? clampFileFont(Number(raw)) : DEFAULT_FILE_FONT
  } catch {
    return DEFAULT_FILE_FONT
  }
}

export function writeStickyFileFont(n: number): void {
  try {
    localStorage.setItem(FILE_FONT_KEY, String(clampFileFont(n)))
  } catch {
    /* private mode / quota — sticky persistence is best-effort */
  }
}

/** The CM language packs we ship, keyed by the short, extension-style ids `LANG_BY_EXT` resolves
 *  to. Each thunk is the EXACT call the `@uiw/codemirror-extensions-langs` barrel made for that id
 *  (see its generated `langs` map) — same grammar, same options — so highlighting is byte-for-byte
 *  identical to the old `loadLanguage` path; we just import the packs explicitly so the bundler can
 *  drop the ~80 unreachable grammars. Every value is a modern `LanguageSupport` (no legacy
 *  StreamLanguage in this set), so the snapshot parser path below always resolves. */
const LANG_FACTORY = {
  ts: () => javascript({ typescript: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  json: () => json(),
  py: () => python(),
  rs: () => rust(),
  go: () => go(),
  java: () => java(),
  c: () => cpp(),
  h: () => cpp(),
  cpp: () => cpp(),
  cc: () => cpp(),
  cxx: () => cpp(),
  hpp: () => cpp(),
  hxx: () => cpp(),
  css: () => css(),
  scss: () => sass(),
  sass: () => sass({ indented: true }),
  less: () => less(),
  html: () => html(),
  htm: () => html(),
  xml: () => xml(),
  vue: () => vue(),
  php: () => php(),
  sql: () => sql({ dialect: StandardSQL }),
  md: () => markdown(),
  markdown: () => markdown(),
  yaml: () => yaml(),
  yml: () => yaml()
} satisfies Record<string, () => LanguageSupport>

/** Short, extension-style language id — the keys of `LANG_FACTORY`, i.e. the only grammars we
 *  bundle. Typed as the literal union so a bad value in `LANG_BY_EXT` fails the build, not at
 *  runtime (mirrors the old `LanguageName` guard, scoped to the reachable set). */
type LanguageName = keyof typeof LANG_FACTORY

/** Construct the `LanguageSupport` for a bundled language id (`null` for any other name — the same
 *  "unknown ⇒ plain text" contract the old barrel `loadLanguage` had). Signature preserved so
 *  callers (markdown code-fence highlighting, `resolveLanguage`) are unchanged. */
function loadLanguage(name: LanguageName): LanguageSupport | null {
  const factory = LANG_FACTORY[name]
  return factory ? factory() : null
}

/** ext -> CM language pack name (the short, extension-style ids like `ts`/`js`/`rs`). Only modern
 *  `LanguageSupport` packs are mapped; anything unmapped renders as plain text (still editable).
 *  Typed as `LanguageName` so a bad value fails the build, not at runtime. */
const LANG_BY_EXT: Record<string, LanguageName> = {
  ts: 'ts',
  mts: 'mts',
  cts: 'cts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'mjs',
  cjs: 'cjs',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  py: 'py',
  rs: 'rs',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'h',
  cpp: 'cpp',
  cc: 'cc',
  cxx: 'cxx',
  hpp: 'hpp',
  hxx: 'hxx',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  html: 'html',
  htm: 'htm',
  xml: 'xml',
  vue: 'vue',
  php: 'php',
  sql: 'sql',
  md: 'md',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yml'
}

/** Image extensions handled by the `<img>` path (svg is read as text, the rest as bytes). */
export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

/** What a file board can DO with a given extension — drives the default view ("auto recognition"):
 *  non-editable types (images) open straight to preview; previewable+editable types (Markdown)
 *  default to preview with a Source toggle; everything else is the source editor. */
export interface FileCaps {
  editable: boolean
  previewable: boolean
  preview?: 'markdown' | 'image'
}
export function fileCaps(ext: string): FileCaps {
  if (ext in IMAGE_MIME_BY_EXT) return { editable: false, previewable: true, preview: 'image' }
  if (ext === 'md' || ext === 'markdown') {
    return { editable: true, previewable: true, preview: 'markdown' }
  }
  return { editable: true, previewable: false }
}

// -- Syntax palette (muted, anchored to the dark surface tokens) -------------------
// Calm hues that read on `--surface` (#141416); the accent stays the only saturated UI
// colour (syntax colour is functional, like terminal output).
const C = {
  comment: '#6b6b72',
  keyword: '#7aa2ff',
  string: '#8fcf9f',
  number: '#e0a861',
  regexp: '#d98a6a',
  property: '#9cc1ff',
  func: '#62c8c0',
  type: '#e3c08d',
  ident: '#d7d7db',
  muted: '#8b8b91',
  invalid: '#f2545b'
}

const SYNTAX: { tag: Tag; color: string }[] = [
  { tag: t.comment, color: C.comment },
  { tag: t.lineComment, color: C.comment },
  { tag: t.blockComment, color: C.comment },
  { tag: t.docComment, color: C.comment },
  { tag: t.keyword, color: C.keyword },
  { tag: t.controlKeyword, color: C.keyword },
  { tag: t.operatorKeyword, color: C.keyword },
  { tag: t.moduleKeyword, color: C.keyword },
  { tag: t.definitionKeyword, color: C.keyword },
  { tag: t.self, color: C.keyword },
  { tag: t.string, color: C.string },
  { tag: t.special(t.string), color: C.string },
  { tag: t.regexp, color: C.regexp },
  { tag: t.escape, color: C.regexp },
  { tag: t.number, color: C.number },
  { tag: t.bool, color: C.number },
  { tag: t.atom, color: C.number },
  { tag: t.null, color: C.number },
  { tag: t.variableName, color: C.ident },
  { tag: t.propertyName, color: C.property },
  { tag: t.function(t.variableName), color: C.func },
  { tag: t.function(t.propertyName), color: C.func },
  { tag: t.typeName, color: C.type },
  { tag: t.className, color: C.type },
  { tag: t.namespace, color: C.type },
  { tag: t.tagName, color: C.keyword },
  { tag: t.attributeName, color: C.property },
  { tag: t.attributeValue, color: C.string },
  { tag: t.operator, color: C.muted },
  { tag: t.punctuation, color: C.muted },
  { tag: t.bracket, color: C.muted },
  { tag: t.meta, color: C.muted },
  { tag: t.labelName, color: C.property },
  { tag: t.heading, color: C.keyword },
  { tag: t.link, color: C.string },
  { tag: t.url, color: C.string },
  { tag: t.invalid, color: C.invalid }
]

/** The live editor's token colours (resolves tag `.set` fallback internally). */
const HIGHLIGHT_STYLE = HighlightStyle.define(SYNTAX.map((s) => ({ tag: s.tag, color: s.color })))

/** The static snapshot's highlighter: returns a colour string (not a class) so
 *  `highlightCode` hands it straight to our HTML builder. Walks each tag's `.set` so a
 *  specific tag (e.g. `lineComment`) falls back to its parent (`comment`). */
const TAG_COLOR = new Map<Tag, string>(SYNTAX.map((s) => [s.tag, s.color]))
const SNAPSHOT_HIGHLIGHTER: Highlighter = {
  style: (tagList) => {
    for (const tag of tagList) {
      for (const sub of tag.set) {
        const c = TAG_COLOR.get(sub)
        if (c) return c
      }
    }
    return null
  }
}

/** Editor chrome - surfaces/caret/selection/gutter from the design tokens. */
const EDITOR_THEME = EditorView.theme(
  {
    '&': { color: 'var(--text)', backgroundColor: 'transparent', height: '100%' },
    // Font size is driven by the `--cm-font` CSS var (set per-board by FileBoard) so the live
    // editor and the static snapshot scale together; line-height stays unitless (scales with it).
    '.cm-content': {
      fontFamily: 'var(--mono)',
      fontSize: 'var(--cm-font, 13px)',
      padding: '8px 0',
      caretColor: 'var(--accent)'
    },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55', overflow: 'auto' },
    '&.cm-focused': { outline: 'none' },
    // Opaque background (== the board content surface, `contentBg` in FileBoard) so a horizontal
    // scroll slides the content UNDER the sticky line-number gutter and it's masked, not bleeding
    // through. A transparent gutter let the scrolled code overlap the line numbers (the gutter stays
    // pinned via `position: sticky; left: 0`, so without an opaque fill the content shows through).
    '.cm-gutters': {
      backgroundColor: 'var(--surface)',
      color: 'var(--text-faint)',
      border: 'none',
      fontFamily: 'var(--mono)',
      fontSize: 'var(--cm-font, 13px)'
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 10px' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.035)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-3)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--accent-wash)' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-wash)' },
    '.cm-matchingBracket': {
      backgroundColor: 'rgba(79, 140, 255, 0.16)',
      outline: '1px solid var(--border)'
    },
    // Find-in-file search panel (dark, token-aligned).
    '.cm-panels': { backgroundColor: 'var(--surface-raised)', color: 'var(--text)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-subtle)' },
    '.cm-search': { fontFamily: 'var(--ui)', fontSize: '12px', padding: '4px 8px' },
    '.cm-search label': { color: 'var(--text-2)' },
    '.cm-textfield': {
      backgroundColor: 'var(--inset)',
      color: 'var(--text)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--r-ctl)'
    },
    '.cm-button': {
      backgroundColor: 'var(--surface-overlay)',
      backgroundImage: 'none',
      color: 'var(--text)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--r-ctl)'
    },
    '.cm-searchMatch': { backgroundColor: 'rgba(232, 179, 57, 0.28)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(79, 140, 255, 0.4)' }
  },
  { dark: true }
)

// `highlightCode`'s tree/parser types, borrowed structurally so we don't import @lezer/common.
type LezerTree = Parameters<typeof highlightCode>[1]
interface LezerParser {
  parse(input: string): LezerTree
}

// -- Pure helpers ------------------------------------------------------------------
export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

/** A NUL byte in the first chunk => binary (don't show it as code). Scanned by char code so
 *  no NUL literal lives in the source. */
export function looksBinary(text: string): boolean {
  const n = Math.min(text.length, BINARY_SNIFF_CHARS)
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 0) return true
  return false
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Resolve a file extension to its editor extension + (if a `LanguageSupport`) a parser the
 *  snapshot can drive. Synchronous - the langs pack statically bundles every grammar, so there
 *  is no worker, no eval, no `?worker` import. */
export function resolveLanguage(ext: string): {
  support: Extension | null
  parser: LezerParser | null
} {
  const name = LANG_BY_EXT[ext]
  const support = name ? loadLanguage(name) : null
  if (!support) return { support: null, parser: null }
  // Only LanguageSupport (has `.language`) exposes a drivable parser; legacy StreamLanguages
  // (unmapped here) fall through to plain text.
  const parser = 'language' in support && support.language?.parser ? support.language.parser : null
  return { support, parser }
}

/** The editor extension stack: our theme + syntax highlighting + find-in-file, language first. */
export function buildEditorExtensions(support: Extension | null): Extension[] {
  const exts: Extension[] = [
    EDITOR_THEME,
    syntaxHighlighting(HIGHLIGHT_STYLE),
    // Find-in-file: the search panel infra + Cmd/Ctrl+F (open) / Enter (next) / Esc (close)
    // keymap. The panel renders at the top of the editor (themed below for dark).
    search({ top: true }),
    keymap.of(searchKeymap)
  ]
  if (support) exts.unshift(support)
  return exts
}

/**
 * Build the static snapshot's inner HTML: highlighted `<span>`s with newlines preserved for
 * `<pre>`. XSS-safe by construction: every run of FILE text is escaped via `escapeHtml`, and
 * the only attribute is `style="color:<hex>"` where the hex is a FIXED value from our own
 * palette (never file data). Falls back to escaped plain text when there is no parser or the
 * file is over the highlight cap.
 */
export function buildSnapshotHtml(code: string, parser: LezerParser | null): string {
  if (!parser || code.length > HIGHLIGHT_MAX_CHARS) return escapeHtml(code)
  let html = ''
  const tree = parser.parse(code)
  highlightCode(
    code,
    tree,
    SNAPSHOT_HIGHLIGHTER,
    (text, color) => {
      const esc = escapeHtml(text)
      html += color ? `<span style="color:${color}">${esc}</span>` : esc
    },
    () => {
      html += '\n'
    }
  )
  return html
}
