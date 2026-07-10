/**
 * Monochrome line icons + board type glyphs (port of design-reference/icons.jsx).
 * All 1.5px stroke, `currentColor`, 16px default, 24-unit viewBox. Never
 * illustrative — these are functional chrome marks (DESIGN.md §6).
 */
import type { CSSProperties, ReactElement } from 'react'

/** Single-path icon names (drawn from `PATHS`). */
export type IconName =
  | 'play'
  | 'pause'
  | 'restart'
  | 'stop'
  | 'more'
  | 'fit'
  | 'plus'
  | 'minus'
  | 'select'
  | 'note'
  | 'text'
  | 'arrow'
  | 'pen'
  | 'erase'
  | 'diagram'
  | 'refresh'
  | 'back'
  | 'forward'
  | 'chevron'
  | 'search'
  | 'diamond'
  | 'wallpaper'
  | 'grid'
  | 'maximize'
  | 'minimize'
  | 'x'
  | 'copy'
  | 'check'
  | 'trash'
  | 'settings'
  // Settings tile-launcher category marks (settings/settingsSections.ts).
  | 'user'
  | 'card'
  | 'cpu'
  | 'plug'
  | 'mic'
  | 'info'
  | 'bell'
  | 'globe'
  | 'external'
  | 'camera'
  | 'download'
  | 'file'
  | 'volume'
  | 'volume-low'
  | 'volume-x'
  | 'magnet'
  | 'align-left'
  | 'align-center-h'
  | 'align-right'
  | 'align-top'
  | 'align-middle'
  | 'align-bottom'
  | 'distribute-h'
  | 'distribute-v'
  | 'connector'
  // DevTools Network inspector: the toggle (a network-activity pulse) + the dock-position switch.
  | 'activity'
  | 'dock-bottom'
  | 'dock-right'
  // Agentic-CLI preset glyphs (New Terminal dialog). Monochrome `currentColor` marks that
  // approximate each brand's recognizable silhouette in the system's stroked style (kept
  // de-colored / non-illustrative per DESIGN.md §6). codex + shell are multi-primitive and
  // special-cased in the Icon body; the rest are single paths in PATHS.
  | 'agent-claude'
  | 'agent-codex'
  | 'agent-gemini'
  | 'agent-opencode'
  | 'agent-shell'

/** Icons drawn from multiple primitives (rect + path) rather than one path. */
export type DeviceIconName = 'mobile' | 'tablet' | 'desktop'

const PATHS: Record<IconName, string> = {
  play: 'M8 5l11 7-11 7z',
  pause: 'M9 5v14M15 5v14',
  restart: 'M4 12a8 8 0 1 0 2.3-5.6M5 4v3.5H8.5',
  stop: 'M7 7h10v10H7z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  fit: 'M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  select: 'M5 4l14 6.5-6 1.8-2.2 5.7z',
  note: 'M5 5h14v10l-4 4H5zM15 19v-4h4',
  text: 'M5 6h14M12 6v12M9 18h6',
  arrow: 'M5 19L19 5M19 5h-7M19 5v7',
  pen: 'M5 19l2-6 9-9 4 4-9 9-6 2zM14 6l4 4',
  erase: 'M16 7l5 5-9 9H7l-3-3z M9 21h12',
  // diagram — two flowchart nodes joined by an elbow connector (the Mermaid Diagram tool mark).
  diagram: 'M4 4h7v5H4zM13 15h7v5h-7zM7.5 9v3.5a2 2 0 0 0 2 2H13',
  refresh: 'M4 12a8 8 0 1 0 2.3-5.6M5 4v3.5H8.5',
  back: 'M15 6l-6 6 6 6',
  forward: 'M9 6l6 6-6 6',
  chevron: 'M6 9l6 6 6-6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.5-4.5',
  diamond: 'M12 3l9 9-9 9-9-9z',
  grid: 'M4 9h16M4 15h16M9 4v16M15 4v16',
  maximize: 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7',
  // Restore/exit-full-view: the maximize arrows reversed — brackets at the inner
  // corners with the strokes pointing back toward each board corner.
  minimize: 'M20 10h-6V4M14 10l6-6M4 14h6v6M10 14l-6 6',
  x: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9.5A1.5 1.5 0 0 1 10.5 8H18a1.5 1.5 0 0 1 1.5 1.5V18A1.5 1.5 0 0 1 18 19.5h-7.5A1.5 1.5 0 0 1 9 18zM6 15.5A1.5 1.5 0 0 1 4.5 14V5.5A1.5 1.5 0 0 1 6 4h7.5A1.5 1.5 0 0 1 15 5.5',
  check: 'M5 12.5l4.5 4.5L19 7',
  trash: 'M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13',
  settings: 'M4 8h7M15 8h5M4 16h5M13 16h7M13 6v4M9 14v4',
  // Settings tile-launcher category marks (person, card, chip, plug, mic, info-circle).
  user: 'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M5.5 20a6.5 6.5 0 0 1 13 0',
  card: 'M3 6h18v12H3zM3 10.5h18',
  cpu: 'M6 6h12v12H6zM9.5 9.5h5v5h-5zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3',
  plug: 'M9 3v5M15 3v5M7.5 8h9v3a4.5 4.5 0 0 1-9 0zM12 15.5V21',
  mic: 'M12 4a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3M6 11a6 6 0 0 0 12 0M12 17v4',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v5M12 8h.01',
  bell: 'M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 0 0 4 0',
  wallpaper: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15.5 9h.01',
  globe:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18',
  external: 'M14 5h5v5M19 5l-7 7M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  camera: 'M4 8h3l1.5-2h7L17 8h3v11H4zM12 16.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  download: 'M12 4v10M8 11l4 4 4-4M5 19h14',
  // Document outline (Project Library row icon).
  file: 'M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10zM13 3v7h7',
  // Speaker + sound waves (audible / mute toggle, OS-3 Phase 4). `volume-low` keeps only the inner
  // wave (reduced level); `volume-x` swaps the waves for an X (muted / silent).
  volume: 'M4 9v6h4l5 4V5L8 9H4M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10',
  'volume-low': 'M4 9v6h4l5 4V5L8 9H4M16 9.5a3.5 3.5 0 0 1 0 5',
  'volume-x': 'M4 9v6h4l5 4V5L8 9H4M17 9.5l5 5M22 9.5l-5 5',
  magnet: 'M7 4v7a5 5 0 0 0 10 0V4M7 4h3.5M13.5 4H17M7 9h3.5M13.5 9H17',
  // Align: a reference edge line + two bars snapped to that edge.
  'align-left': 'M4 4v16M8 8h11M8 16h7',
  'align-center-h': 'M12 4v16M6 8h12M8 16h8',
  'align-right': 'M20 4v16M5 8h11M9 16h7',
  'align-top': 'M4 4h16M8 8v11M16 8v7',
  'align-middle': 'M4 12h16M8 6v12M16 8v8',
  'align-bottom': 'M4 20h16M8 5v11M16 9v7',
  // Distribute: three bars with equal gaps along the axis.
  'distribute-h': 'M5 4v16M19 4v16M11 7h2v10h-2z',
  'distribute-v': 'M4 5h16M4 19h16M7 11v2h10v-2z',
  // Connector: two node rings joined by a diagonal link (the draw-a-cable affordance).
  connector: 'M9 17a2 2 0 1 1-4 0 2 2 0 1 1 4 0M19 7a2 2 0 1 1-4 0 2 2 0 1 1 4 0M8.5 15.5l7-7',
  // DevTools Network: an activity pulse (toggle) + panel-with-docked-region glyphs (dock switch).
  activity: 'M22 12h-4l-3 8L9 4l-3 8H2',
  'dock-bottom': 'M4 4h16v16H4zM4 15h16',
  'dock-right': 'M4 4h16v16H4zM15 4v16',
  // Agentic-CLI preset brand marks (monochrome approximations):
  // claude — Anthropic radial burst (8 rays from centre).
  'agent-claude':
    'M12 12V4M12 12v8M12 12H4M12 12h8M12 12L6.3 6.3M12 12l5.7 5.7M12 12l-5.7 5.7M12 12l5.7-5.7',
  // gemini — Google Gemini four-point sparkle.
  'agent-gemini':
    'M12 2c.6 5.8 4.2 9.4 10 10-5.8.6-9.4 4.2-10 10-.6-5.8-4.2-9.4-10-10 5.8-.6 9.4-4.2 10-10z',
  // opencode — code brackets.
  'agent-opencode': 'M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5',
  // codex (OpenAI blossom) + shell (terminal window) are special-cased in the Icon body;
  // these single-path entries are fallbacks only.
  'agent-codex': 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  'agent-shell': 'M5 8l4 4-4 4M13 16h6'
}

interface SvgProps {
  size: number
  sw: number
  style?: CSSProperties
  children: ReactElement | ReactElement[]
}

function Svg({ size, sw, style, children }: SvgProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      // PLAN-02 (a11y): glyphs are decorative chrome — the labelled control around them
      // carries the accessible name (IconBtn `aria-label`), so hide the SVG from AT and
      // keep it out of the tab order to avoid a duplicate / nameless announcement.
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export interface IconProps {
  name: IconName | DeviceIconName
  size?: number
  sw?: number
  style?: CSSProperties
}

export function Icon({ name, size = 16, sw = 1.5, style }: IconProps): ReactElement {
  if (name === 'mobile')
    return (
      <Svg size={size} sw={sw} style={style}>
        <rect x={8} y={3} width={8} height={18} rx={1.6} />
        <path d="M11 18h2" />
      </Svg>
    )
  if (name === 'tablet')
    return (
      <Svg size={size} sw={sw} style={style}>
        <rect x={5} y={4} width={14} height={16} rx={1.6} />
        <path d="M11 17h2" />
      </Svg>
    )
  if (name === 'desktop')
    return (
      <Svg size={size} sw={sw} style={style}>
        <rect x={3} y={4} width={18} height={12} rx={1.4} />
        <path d="M9 20h6M12 16v4" />
      </Svg>
    )
  // codex — OpenAI "blossom": three overlapping ellipses at 60° (six-fold knot silhouette).
  if (name === 'agent-codex')
    return (
      <Svg size={size} sw={sw} style={style}>
        <ellipse cx={12} cy={12} rx={3.3} ry={8.2} />
        <ellipse cx={12} cy={12} rx={3.3} ry={8.2} transform="rotate(60 12 12)" />
        <ellipse cx={12} cy={12} rx={3.3} ry={8.2} transform="rotate(120 12 12)" />
      </Svg>
    )
  // shell — a terminal window: framed rect with a `>` prompt + cursor line.
  if (name === 'agent-shell')
    return (
      <Svg size={size} sw={sw} style={style}>
        <rect x={3.5} y={5} width={17} height={14} rx={2} />
        <path d="M7.5 10l2.8 2-2.8 2M12.8 14H16.5" />
      </Svg>
    )
  return (
    <Svg size={size} sw={sw} style={style}>
      <path d={PATHS[name] ?? PATHS.diamond} />
    </Svg>
  )
}
