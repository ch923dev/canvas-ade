// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderMarkdownToHtml } from './fileBoardMarkdown'

describe('renderMarkdownToHtml', () => {
  it('renders headings, emphasis, inline code', () => {
    const h = renderMarkdownToHtml('# Title\n\nA **bold** and *em* and `code`.\n')
    expect(h).toContain('<h1>Title</h1>')
    expect(h).toContain('<strong>bold</strong>')
    expect(h).toContain('<em>em</em>')
    expect(h).toContain('<code>code</code>')
  })

  it('escapes raw HTML / scripts (no injection)', () => {
    const h = renderMarkdownToHtml('Hello <script>alert(1)</script> & done\n')
    expect(h).not.toContain('<script>')
    expect(h).toContain('&lt;script&gt;')
    expect(h).toContain('&amp;')
  })

  it('drops javascript: links but keeps http(s) + label', () => {
    expect(renderMarkdownToHtml('[x](javascript:alert(1))')).not.toContain('href="javascript')
    const ok = renderMarkdownToHtml('a [the label](https://example.com) b')
    expect(ok).toContain('href="https://example.com"')
    expect(ok).toContain('>the label</a>')
  })

  it('drops protocol-relative, data:, and keeps relative file links', () => {
    // Protocol-relative escapes the app origin → must NOT become an href/src.
    expect(renderMarkdownToHtml('[x](//evil.com)')).not.toContain('href="//')
    expect(renderMarkdownToHtml('![x](//evil.com/a.png)')).not.toContain('src="//')
    // data: links/images are dropped too.
    expect(renderMarkdownToHtml('[x](data:text/html,<b>)')).not.toContain('href="data:')
    // A legitimate same-origin relative link still renders.
    const rel = renderMarkdownToHtml('[doc](./README.md)')
    expect(rel).toContain('href="./README.md"')
  })

  it('renders lists, blockquote, fenced code', () => {
    const h = renderMarkdownToHtml('- a\n- b\n\n> quote\n\n```\ncode\n```\n')
    expect(h).toContain('<ul>')
    expect(h).toContain('<li>a</li>')
    expect(h).toContain('<blockquote>')
    expect(h).toContain('cm-md-code')
  })

  it('renders GFM tables + strikethrough', () => {
    const h = renderMarkdownToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n~~no~~\n')
    expect(h).toContain('<table>')
    expect(h).toContain('<th>A</th>')
    expect(h).toContain('<td>1</td>')
    expect(h).toContain('<del>no</del>')
  })
})
