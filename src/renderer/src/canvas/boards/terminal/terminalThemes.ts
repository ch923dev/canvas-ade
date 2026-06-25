/**
 * Terminal color themes + font families — closed registries with per-app sticky
 * last-used defaults, mirroring terminalFont.ts (ADR 0005). The live terminal runs on
 * xterm's DOM renderer (terminal-crisp umbrella, docs/research/2026-06-25-terminal-dom-
 * renderer): real subpixel AA + native color/weight, so swapping the ANSI palette or the
 * font is a LIVE `term.options` write — no atlas rebuild, no PTY respawn. Lane B.
 *
 * SCOPE: a "theme" here is ONLY the xterm 16-colour ANSI palette + bg/fg/cursor/selection
 * (the terminal's own surface). It deliberately does NOT touch the app's chrome accent —
 * the single functional blue (#4f8cff) stays the only chrome accent (DESIGN.md §2). A
 * font-family is a literal monospace stack (system / the bundled Geist Mono / Courier).
 *
 * FORWARD-COMPAT (ADR 0007, mirroring the backdrop sceneRegistry): ids are persisted
 * VERBATIM (boardSchema keeps a well-formed unknown id; it does NOT rewrite it). The
 * resolvers below degrade an absent OR unknown id to the default at USE time, so a theme
 * written by a NEWER build renders as the default here without being destroyed on a save
 * round-trip. (`resolveInitialThemeId` distinguishes the two: absent ⇒ the sticky
 * last-used; present-but-unknown ⇒ the hard default.)
 */
import type { ITheme } from '@xterm/xterm'

export interface TerminalTheme {
  /** Persisted id (board.themeId), kebab-case, stable forever. */
  id: string
  /** Picker label. */
  label: string
  /** Light palette (bg lighter than fg) — the picker tags it; all others are dark. */
  light?: boolean
  /** The xterm palette (a subset of ITheme; xterm fills any unset slot with its default). */
  colors: ITheme
}

/**
 * The CURRENT default palette (DESIGN.md §2), kept byte-identical to the pre-feature
 * inline `THEME` (only the listed keys are set, so xterm fills the bright variants exactly
 * as before). A board with no `themeId` resolves to this ⇒ existing boards are unchanged.
 */
const CANVAS: ITheme = {
  background: '#0e0e10', // --inset
  foreground: '#ededee', // --text
  cursor: '#4f8cff', // --accent
  cursorAccent: '#0e0e10',
  selectionBackground: 'rgba(79,140,255,0.25)',
  black: '#0e0e10',
  brightBlack: '#46464b',
  red: '#f2545b',
  green: '#3ecf8e',
  yellow: '#e8b339',
  blue: '#4f8cff',
  magenta: '#b18cff',
  cyan: '#3ecfce',
  white: '#9b9ba1',
  brightWhite: '#ededee'
}

/** A calm, low-chroma cool-dark companion to Canvas (custom; not a third-party palette). */
const MIDNIGHT: ITheme = {
  background: '#0b0f17',
  foreground: '#cdd6e4',
  cursor: '#6aa0ff',
  cursorAccent: '#0b0f17',
  selectionBackground: 'rgba(106,160,255,0.25)',
  black: '#0b0f17',
  brightBlack: '#3a4151',
  red: '#f2778a',
  brightRed: '#ff8fa0',
  green: '#54d6a0',
  brightGreen: '#74e6b8',
  yellow: '#e6c07b',
  brightYellow: '#f0d090',
  blue: '#6aa0ff',
  brightBlue: '#8ab6ff',
  magenta: '#c4a0ff',
  brightMagenta: '#d4b8ff',
  cyan: '#56cfd6',
  brightCyan: '#78dfe4',
  white: '#aeb6c4',
  brightWhite: '#e8edf5'
}

/** Solarized Dark (Ethan Schoonover) — canonical xterm mapping. */
const SOLARIZED_DARK: ITheme = {
  background: '#002b36', // base03
  foreground: '#93a1a1', // base1
  cursor: '#93a1a1',
  cursorAccent: '#002b36',
  selectionBackground: 'rgba(38,139,210,0.30)',
  black: '#073642',
  brightBlack: '#586e75',
  red: '#dc322f',
  brightRed: '#cb4b16',
  green: '#859900',
  brightGreen: '#586e75',
  yellow: '#b58900',
  brightYellow: '#657b83',
  blue: '#268bd2',
  brightBlue: '#839496',
  magenta: '#d33682',
  brightMagenta: '#6c71c4',
  cyan: '#2aa198',
  brightCyan: '#93a1a1',
  white: '#eee8d5',
  brightWhite: '#fdf6e3'
}

/** Solarized Light — same hue palette on the light base. */
const SOLARIZED_LIGHT: ITheme = {
  background: '#fdf6e3', // base3
  foreground: '#657b83', // base00
  cursor: '#586e75',
  cursorAccent: '#fdf6e3',
  selectionBackground: 'rgba(38,139,210,0.20)',
  black: '#073642',
  brightBlack: '#002b36',
  red: '#dc322f',
  brightRed: '#cb4b16',
  green: '#859900',
  brightGreen: '#586e75',
  yellow: '#b58900',
  brightYellow: '#657b83',
  blue: '#268bd2',
  brightBlue: '#839496',
  magenta: '#d33682',
  brightMagenta: '#6c71c4',
  cyan: '#2aa198',
  brightCyan: '#93a1a1',
  white: '#eee8d5',
  brightWhite: '#fdf6e3'
}

/** Dracula (dracula-theme.com) — canonical ANSI mapping. */
const DRACULA: ITheme = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: 'rgba(68,71,90,0.60)', // #44475a "current line"
  black: '#21222c',
  brightBlack: '#6272a4',
  red: '#ff5555',
  brightRed: '#ff6e6e',
  green: '#50fa7b',
  brightGreen: '#69ff94',
  yellow: '#f1fa8c',
  brightYellow: '#ffffa5',
  blue: '#bd93f9',
  brightBlue: '#d6acff',
  magenta: '#ff79c6',
  brightMagenta: '#ff92df',
  cyan: '#8be9fd',
  brightCyan: '#a4ffff',
  white: '#f8f8f2',
  brightWhite: '#ffffff'
}

export const DEFAULT_TERMINAL_THEME_ID = 'canvas'

/** The closed theme registry. Registration order = picker display order. */
export const TERMINAL_THEMES: readonly TerminalTheme[] = [
  { id: 'canvas', label: 'Canvas', colors: CANVAS },
  { id: 'midnight', label: 'Midnight', colors: MIDNIGHT },
  { id: 'solarized', label: 'Solarized', colors: SOLARIZED_DARK },
  { id: 'dracula', label: 'Dracula', colors: DRACULA },
  { id: 'solarized-light', label: 'Solarized Light', light: true, colors: SOLARIZED_LIGHT }
]

const THEME_BY_ID = new Map(TERMINAL_THEMES.map((t) => [t.id, t]))
const DEFAULT_THEME = THEME_BY_ID.get(DEFAULT_TERMINAL_THEME_ID) as TerminalTheme

export interface TerminalFontFamily {
  /** Persisted id (board.fontFamilyId). */
  id: string
  /** Picker label. */
  label: string
  /**
   * CSS custom property holding the literal monospace stack. xterm measures glyphs with
   * the literal `fontFamily` and `var()` does NOT resolve there, so the stack is read off
   * this var (the same trick the inline --term-mono read used) and the literal is handed
   * to xterm.
   */
  cssVar: string
  /** Literal fallback used when the var is unset (jsdom unit tests / stripped CSS). */
  fallback: string
}

export const DEFAULT_TERMINAL_FONT_FAMILY_ID = 'system'

/** The closed font-family registry. */
export const TERMINAL_FONT_FAMILIES: readonly TerminalFontFamily[] = [
  {
    id: 'system',
    label: 'System',
    cssVar: '--term-mono',
    fallback: "'Cascadia Mono', Consolas, 'SF Mono', Menlo, ui-monospace, monospace"
  },
  {
    id: 'geist',
    label: 'Geist Mono',
    cssVar: '--term-mono-geist',
    fallback: "'Geist Mono', ui-monospace, monospace"
  },
  {
    id: 'courier',
    label: 'Courier',
    cssVar: '--term-mono-courier',
    fallback: "'Courier New', Courier, monospace"
  }
]

const FONT_BY_ID = new Map(TERMINAL_FONT_FAMILIES.map((f) => [f.id, f]))
const DEFAULT_FONT = FONT_BY_ID.get(DEFAULT_TERMINAL_FONT_FAMILY_ID) as TerminalFontFamily

/**
 * xterm palette for an id — an absent OR unknown id degrades to the default (forward-compat).
 * Returns the registry's shared `colors`; the LIVE-apply site spreads it into a fresh object
 * (xterm ref-compares `term.options.theme`, so mutating in place is a no-op).
 */
export function terminalThemeColors(id: string | undefined): ITheme {
  if (id != null) {
    const t = THEME_BY_ID.get(id)
    if (t) return t.colors
  }
  return DEFAULT_THEME.colors
}

/**
 * Resolve a font-family id to a LITERAL stack string (var() does not resolve inside xterm's
 * fontFamily). Absent OR unknown degrades to the system default. Reads the registry's CSS
 * var off :root and falls back to the literal when the var is unset (tests / stripped CSS).
 */
export function resolveTerminalFontFamily(id: string | undefined): string {
  const f = (id != null ? FONT_BY_ID.get(id) : undefined) ?? DEFAULT_FONT
  const fromVar = getComputedStyle(document.documentElement).getPropertyValue(f.cssVar).trim()
  return fromVar || f.fallback
}

// ── Sticky last-used defaults (per machine, all projects) — mirror terminalFont.ts ──
const STICKY_THEME_KEY = 'ca.terminal.themeId'
const STICKY_FONT_FAMILY_KEY = 'ca.terminal.fontFamilyId'

/** Read the sticky theme id (only if it is still a KNOWN id). Default on miss / unknown. */
export function readStickyThemeId(): string {
  try {
    const raw = window.localStorage.getItem(STICKY_THEME_KEY)
    if (raw != null && THEME_BY_ID.has(raw)) return raw
  } catch {
    /* storage disabled (private mode / test) */
  }
  return DEFAULT_TERMINAL_THEME_ID
}

/** Persist the sticky theme id. No-op for an unknown id or when storage is unavailable. */
export function writeStickyThemeId(id: string): void {
  try {
    if (THEME_BY_ID.has(id)) window.localStorage.setItem(STICKY_THEME_KEY, id)
  } catch {
    /* storage disabled — the sticky default just won't persist */
  }
}

/** Read the sticky font-family id (only if still KNOWN). Default on miss / unknown. */
export function readStickyFontFamilyId(): string {
  try {
    const raw = window.localStorage.getItem(STICKY_FONT_FAMILY_KEY)
    if (raw != null && FONT_BY_ID.has(raw)) return raw
  } catch {
    /* storage disabled */
  }
  return DEFAULT_TERMINAL_FONT_FAMILY_ID
}

/** Persist the sticky font-family id. No-op for an unknown id / unavailable storage. */
export function writeStickyFontFamilyId(id: string): void {
  try {
    if (FONT_BY_ID.has(id)) window.localStorage.setItem(STICKY_FONT_FAMILY_KEY, id)
  } catch {
    /* storage disabled */
  }
}

/**
 * The KNOWN id a new board / the dialog should start at: the board's own pin (if set &
 * known), else the sticky last-used; a present-but-UNKNOWN id degrades to the hard default
 * (so the picker shows a valid selection and a future theme doesn't render as an empty
 * choice). Mirrors resolveInitialFont. Construction + the dialog seed both call this.
 */
export function resolveInitialThemeId(boardThemeId: string | undefined): string {
  if (boardThemeId == null) return readStickyThemeId()
  return THEME_BY_ID.has(boardThemeId) ? boardThemeId : DEFAULT_TERMINAL_THEME_ID
}

/** Font-family analogue of resolveInitialThemeId. */
export function resolveInitialFontFamilyId(boardFontFamilyId: string | undefined): string {
  if (boardFontFamilyId == null) return readStickyFontFamilyId()
  return FONT_BY_ID.has(boardFontFamilyId) ? boardFontFamilyId : DEFAULT_TERMINAL_FONT_FAMILY_ID
}
