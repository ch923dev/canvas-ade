/**
 * File-tree glyphs for the Pick file & lines modal (v19 / #346 redesign) — a small, self-contained
 * inline-SVG icon set (NO external icon dep) in the VS-Code-material spirit but on this app's calm
 * one-accent contract: recognizable by SHAPE, not a rainbow. Everything paints in `currentColor`, so
 * the tree row's own colour drives the icon (neutral file, accent-tinted folder, accent on selection).
 * Duotone = a faint `fill-opacity` body under a 1px stroke, which reads as "material" without glow.
 */
import type { ReactElement } from 'react'

/** A caret that rotates from ▶ (closed) to ▼ (open); the row animates the rotation (motion = state). */
export function TreeChevron({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      className={'pfl-chevron' + (open ? ' open' : '')}
      width="9"
      height="9"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 3.5 10.5 8 6 12.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Folder — closed (tabbed) / open (tilted front). Duotone; painted in the row's colour. */
export function FolderIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      className="pfl-ic pfl-ic-folder"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      {open ? (
        <>
          <path
            d="M1.7 4.4c0-.55.45-1 1-1h2.75c.3 0 .58.14.77.38l.63.8c.19.24.47.38.77.38H13.3c.55 0 1 .45 1 1v1.1H1.7V4.4Z"
            fill="currentColor"
            fillOpacity="0.16"
            stroke="currentColor"
            strokeWidth="1.05"
            strokeLinejoin="round"
          />
          <path
            d="M1.35 7.05h13.3l-1.06 4.7c-.1.46-.5.78-.97.78H3.38c-.47 0-.88-.32-.98-.78L1.35 7.05Z"
            fill="currentColor"
            fillOpacity="0.11"
            stroke="currentColor"
            strokeWidth="1.05"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <path
          d="M1.7 4.35c0-.55.45-1 1-1h2.9c.3 0 .58.14.77.38l.66.84c.19.24.47.38.77.38H13.3c.55 0 1 .45 1 1v5.35c0 .55-.45 1-1 1H2.7c-.55 0-1-.45-1-1V4.35Z"
          fill="currentColor"
          fillOpacity="0.16"
          stroke="currentColor"
          strokeWidth="1.05"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

type FileCategory = 'code' | 'data' | 'doc' | 'style' | 'markup' | 'image' | 'file'

const BY_EXT: Record<string, FileCategory> = {}
const put = (cat: FileCategory, exts: string[]): void => {
  for (const e of exts) BY_EXT[e] = cat
}
put('code', [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'rb',
  'php',
  'sh',
  'vue',
  'svelte'
])
put('data', ['json', 'jsonc', 'yaml', 'yml', 'toml', 'env', 'lock', 'ini', 'plist', 'xml'])
put('doc', ['md', 'mdx', 'txt', 'rst', 'adoc', 'log'])
put('style', ['css', 'scss', 'sass', 'less'])
put('markup', ['html', 'htm'])
put('image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'heic'])

function categoryOf(name: string): FileCategory {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return BY_EXT[ext] ?? 'file'
}

/** The document body every file glyph sits on — a rounded sheet with a folded corner (duotone). */
function Sheet({ children }: { children?: ReactElement | ReactElement[] }): ReactElement {
  return (
    <svg
      className="pfl-ic pfl-ic-file"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M3.4 2.4c0-.5.4-.9.9-.9h4.5L12.6 5v8.6c0 .5-.4.9-.9.9H4.3c-.5 0-.9-.4-.9-.9V2.4Z"
        fill="currentColor"
        fillOpacity="0.08"
        stroke="currentColor"
        strokeWidth="1.05"
        strokeLinejoin="round"
      />
      <path
        d="M8.7 1.7V4.4c0 .5.4.9.9.9h2.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.05"
        strokeLinejoin="round"
      />
      {children}
    </svg>
  )
}

/** File glyph — a sheet plus a category mark (code `</>`, data `{}`, doc lines, style `#`, image, markup `<>`). */
export function FileIcon({ name }: { name: string }): ReactElement {
  const mark = (d: string, w = 1): ReactElement => (
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  )
  switch (categoryOf(name)) {
    case 'code':
      return <Sheet>{mark('M6.6 8.2 5.2 9.9l1.4 1.7 M9.4 8.2 10.8 9.9l-1.4 1.7')}</Sheet>
    case 'markup':
      return <Sheet>{mark('M6.6 8.2 5.2 9.9l1.4 1.7 M9.4 8.2 10.8 9.9l-1.4 1.7')}</Sheet>
    case 'data':
      return (
        <Sheet>
          {mark('M6.7 7.9c-.7 0-1 .3-1 1v.4c0 .4-.2.6-.6.6.4 0 .6.2.6.6v.4c0 .7.3 1 1 1', 0.95)}
          {mark('M9.3 7.9c.7 0 1 .3 1 1v.4c0 .4.2.6.6.6-.4 0-.6.2-.6.6v.4c0 .7-.3 1-1 1', 0.95)}
        </Sheet>
      )
    case 'doc':
      return <Sheet>{mark('M5.4 8.6h5.2 M5.4 10.4h5.2 M5.4 12.2h3', 0.95)}</Sheet>
    case 'style':
      return (
        <Sheet>{mark('M6.7 8.1 6.1 12 M9.5 8.1 8.9 12 M5.6 9.4h4.3 M5.3 10.7h4.3', 0.9)}</Sheet>
      )
    case 'image':
      return (
        <Sheet>
          <circle cx="6.4" cy="9.1" r="0.85" fill="currentColor" />
          {mark('M4.4 13.1 6.9 10.3l1.5 1.5 1.9-2.3 1.4 1.7', 1)}
        </Sheet>
      )
    default:
      return <Sheet />
  }
}
