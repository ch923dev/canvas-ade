/**
 * File board (S3) - Markdown -> safe HTML renderer for the rendered preview.
 *
 * No new dependency: it drives `@lezer/markdown` (the CommonMark + GFM parser already bundled
 * via the CM language pack) and emits HTML built from FIXED tags + escaped text only. Raw HTML
 * in the source is shown as escaped text, never injected; link/image URLs are scheme-filtered
 * (http/https/mailto/anchor/relative only) - so the output is XSS-safe by construction and needs
 * no DOM sanitizer. Fenced code blocks reuse the file board's own syntax highlighter.
 */
import { parser as markdownBase, GFM } from '@lezer/markdown'
import type { SyntaxNode } from '@lezer/common'
import { buildSnapshotHtml, resolveLanguage } from './fileBoardSyntax'

const md = markdownBase.configure(GFM)

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESCAPES[c])
}

/** Allow only safe link/image schemes; drop javascript:/data:/protocol-relative/etc. */
function safeUrl(url: string): string {
  const u = url.trim()
  // Protocol-relative (`//host`, `\\host`, `/\host`) inherits the page scheme, so it points OFF
  // the app origin — the nav guard would hand it to the OS browser. A real relative path never
  // starts with two separators, so reject the form outright (defense-in-depth above the guard).
  if (/^[/\\]{2}/.test(u)) return ''
  return /^(https?:\/\/|mailto:|#|\/|\.\.?\/|[\w.-]+\.[\w]{1,8})/i.test(u) ? esc(u) : ''
}

function kids(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = []
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c)
  return out
}

/** Inline content of a block (Paragraph/Heading/TableCell): escaped text in the gaps between
 *  inline child nodes, with marks (`*`, `` ` ``, `[`) rendered away. */
function inline(node: SyntaxNode, src: string): string {
  let out = ''
  let pos = node.from
  for (const c of kids(node)) {
    if (c.from > pos) out += esc(src.slice(pos, c.from))
    out += renderInline(c, src)
    pos = c.to
  }
  if (pos < node.to) out += esc(src.slice(pos, node.to))
  return out
}

function renderInline(node: SyntaxNode, src: string): string {
  // Any delimiter mark (EmphasisMark/CodeMark/LinkMark/StrikethroughMark/...) renders away; the
  // surrounding `inline()` emits the real text from the gaps between marks.
  if (node.name.endsWith('Mark')) return ''
  switch (node.name) {
    case 'Emphasis':
      return `<em>${inline(node, src)}</em>`
    case 'StrongEmphasis':
      return `<strong>${inline(node, src)}</strong>`
    case 'Strikethrough':
      return `<del>${inline(node, src)}</del>`
    case 'InlineCode':
      return `<code>${inline(node, src)}</code>`
    case 'HardBreak':
      return '<br/>'
    case 'Link': {
      const url = node.getChild('URL')
      const href = url ? safeUrl(src.slice(url.from, url.to)) : ''
      const text = linkText(node, src)
      return href ? `<a href="${href}" rel="noreferrer">${text}</a>` : text
    }
    case 'Image': {
      const url = node.getChild('URL')
      const srcUrl = url ? safeUrl(src.slice(url.from, url.to)) : ''
      // `linkAltText` returns RAW text; escape it exactly once here (whether it lands in the
      // `alt` attribute or the `![alt]` fallback) — never twice.
      const alt = linkAltText(node, src)
      return srcUrl ? `<img src="${srcUrl}" alt="${esc(alt)}"/>` : esc(`![${alt}]`)
    }
    case 'URL':
    case 'Autolink': {
      const raw = src.slice(node.from, node.to).replace(/^<|>$/g, '')
      const href = safeUrl(raw)
      return href ? `<a href="${href}" rel="noreferrer">${esc(raw)}</a>` : esc(raw)
    }
    case 'Escape':
      return esc(src.slice(node.from + 1, node.to))
    default:
      return inline(node, src)
  }
}

/** Link/image label = the inline content between the opening `[` and the URL. */
function linkText(node: SyntaxNode, src: string): string {
  let out = ''
  let pos = node.from
  for (const c of kids(node)) {
    if (c.name === 'URL' || c.name === 'LinkTitle') break
    // Emit the gap text (the label) BEFORE handling a mark, else `[label]` loses "label".
    if (c.from > pos) out += esc(src.slice(pos, c.from))
    if (c.name === 'LinkMark') {
      pos = c.to
      continue
    }
    out += renderInline(c, src)
    pos = c.to
  }
  return out.replace(/^\[|\]$/g, '')
}
/** Plain-text alt for an image: the label's source text with delimiter marks dropped. Built
 *  straight from source (NO HTML, NO regex tag-stripping) so the `Image` caller can escape it
 *  exactly once. This replaces a `.replace(/<[^>]+>/g,'')` strip that (a) CodeQL flags as
 *  incomplete multi-character sanitization and (b) double-escaped an already-escaped string. */
function linkAltText(node: SyntaxNode, src: string): string {
  let out = ''
  let pos = node.from
  let stopped = false
  for (const c of kids(node)) {
    if (c.name === 'URL' || c.name === 'LinkTitle') {
      stopped = true
      break
    }
    if (c.from > pos) out += src.slice(pos, c.from)
    if (c.name.endsWith('Mark')) {
      pos = c.to
      continue
    }
    out += linkAltText(c, src)
    pos = c.to
  }
  // Trailing text after the last inline child — and the whole text of a LEAF node (no children).
  // Skipped when we stopped at the URL: the rest is the link target, never alt text.
  if (!stopped && pos < node.to) out += src.slice(pos, node.to)
  return out
}

function listItems(node: SyntaxNode, src: string): string {
  let out = ''
  for (const item of kids(node)) {
    if (item.name !== 'ListItem') continue
    // A ListItem holds block children (Paragraph, nested lists). Drop the leading ListMark.
    const blocks = kids(item).filter((c) => c.name !== 'ListMark')
    const inner = blocks.map((b) => renderBlock(b, src)).join('')
    // Tight lists: unwrap a lone Paragraph so we don't get <li><p>..</p></li> spacing.
    const tight = blocks.length === 1 && blocks[0].name === 'Paragraph'
    out += `<li>${tight ? inline(blocks[0], src) : inner}</li>`
  }
  return out
}

function renderTable(node: SyntaxNode, src: string): string {
  let head = ''
  let body = ''
  for (const row of kids(node)) {
    if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue
    const cells = kids(row)
      .filter((c) => c.name === 'TableCell')
      .map(
        (c) =>
          `<${row.name === 'TableHeader' ? 'th' : 'td'}>${inline(c, src)}</${row.name === 'TableHeader' ? 'th' : 'td'}>`
      )
      .join('')
    if (row.name === 'TableHeader') head += `<tr>${cells}</tr>`
    else body += `<tr>${cells}</tr>`
  }
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`
}

function fencedCode(node: SyntaxNode, src: string): string {
  const info = node.getChild('CodeInfo')
  const lang = info ? src.slice(info.from, info.to).trim().split(/\s+/)[0] : ''
  const textNode = node.getChild('CodeText')
  const code = textNode ? src.slice(textNode.from, textNode.to) : ''
  const { parser } = resolveLanguage(lang)
  return `<pre class="cm-md-code"><code>${buildSnapshotHtml(code, parser)}</code></pre>`
}

function renderBlock(node: SyntaxNode, src: string): string {
  const n = node.name
  if (/^ATXHeading[1-6]$/.test(n) || /^SetextHeading[12]$/.test(n)) {
    const level = n.endsWith('1') ? 1 : n.endsWith('2') ? 2 : Number(n.slice(-1))
    // Trim the space that follows the `#` mark (it lives in the gap, not the HeaderMark node).
    return `<h${level}>${inline(node, src).trim()}</h${level}>`
  }
  switch (n) {
    case 'Paragraph':
      return `<p>${inline(node, src)}</p>`
    case 'Blockquote':
      return `<blockquote>${kids(node)
        .filter((c) => c.name !== 'QuoteMark')
        .map((b) => renderBlock(b, src))
        .join('')}</blockquote>`
    case 'BulletList':
      return `<ul>${listItems(node, src)}</ul>`
    case 'OrderedList':
      return `<ol>${listItems(node, src)}</ol>`
    case 'FencedCode':
    case 'CodeBlock':
      return n === 'FencedCode'
        ? fencedCode(node, src)
        : `<pre class="cm-md-code"><code>${esc(src.slice(node.from, node.to))}</code></pre>`
    case 'HorizontalRule':
      return '<hr/>'
    case 'Table':
      return renderTable(node, src)
    case 'HTMLBlock':
      // Never inject raw HTML — show it escaped.
      return `<pre class="cm-md-code"><code>${esc(src.slice(node.from, node.to))}</code></pre>`
    default:
      return ''
  }
}

/** Render Markdown source to the preview's inner HTML (XSS-safe by construction). */
export function renderMarkdownToHtml(source: string): string {
  const tree = md.parse(source)
  let out = ''
  for (const b of kids(tree.topNode)) out += renderBlock(b, source)
  return out
}
