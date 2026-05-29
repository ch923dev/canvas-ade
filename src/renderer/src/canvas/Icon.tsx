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
  | 'overview'
  | 'plus'
  | 'minus'
  | 'select'
  | 'note'
  | 'text'
  | 'arrow'
  | 'pen'
  | 'refresh'
  | 'back'
  | 'forward'
  | 'chevron'
  | 'search'
  | 'diamond'
  | 'grid'
  | 'maximize'
  | 'x'
  | 'copy'
  | 'check'
  | 'trash'
  | 'settings'

/** Icons drawn from multiple primitives (rect + path) rather than one path. */
export type DeviceIconName = 'mobile' | 'tablet' | 'desktop'

const PATHS: Record<IconName, string> = {
  play: 'M8 5l11 7-11 7z',
  pause: 'M9 5v14M15 5v14',
  restart: 'M4 12a8 8 0 1 0 2.3-5.6M5 4v3.5H8.5',
  stop: 'M7 7h10v10H7z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  fit: 'M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4',
  overview: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  select: 'M5 4l14 6.5-6 1.8-2.2 5.7z',
  note: 'M5 5h14v10l-4 4H5zM15 19v-4h4',
  text: 'M5 6h14M12 6v12M9 18h6',
  arrow: 'M5 19L19 5M19 5h-7M19 5v7',
  pen: 'M5 19l2-6 9-9 4 4-9 9-6 2zM14 6l4 4',
  refresh: 'M4 12a8 8 0 1 0 2.3-5.6M5 4v3.5H8.5',
  back: 'M15 6l-6 6 6 6',
  forward: 'M9 6l6 6-6 6',
  chevron: 'M6 9l6 6 6-6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.5-4.5',
  diamond: 'M12 3l9 9-9 9-9-9z',
  grid: 'M4 9h16M4 15h16M9 4v16M15 4v16',
  maximize: 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7',
  x: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9.5A1.5 1.5 0 0 1 10.5 8H18a1.5 1.5 0 0 1 1.5 1.5V18A1.5 1.5 0 0 1 18 19.5h-7.5A1.5 1.5 0 0 1 9 18zM6 15.5A1.5 1.5 0 0 1 4.5 14V5.5A1.5 1.5 0 0 1 6 4h7.5A1.5 1.5 0 0 1 15 5.5',
  check: 'M5 12.5l4.5 4.5L19 7',
  trash: 'M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13',
  settings: 'M4 8h7M15 8h5M4 16h5M13 16h7M13 6v4M9 14v4'
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
  return (
    <Svg size={size} sw={sw} style={style}>
      <path d={PATHS[name] ?? PATHS.diamond} />
    </Svg>
  )
}
