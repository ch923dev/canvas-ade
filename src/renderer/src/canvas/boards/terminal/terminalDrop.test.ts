// src/renderer/src/canvas/boards/terminal/terminalDrop.test.ts
import { describe, it, expect } from 'vitest'
import { quotePathsForPaste } from './terminalDrop'

describe('quotePathsForPaste', () => {
  it('quotes each path and joins with spaces, trailing space', () => {
    expect(quotePathsForPaste(['C:\\a\\b.png'])).toBe('"C:\\a\\b.png" ')
    expect(quotePathsForPaste(['/x/y.png', '/x/z.txt'])).toBe('"/x/y.png" "/x/z.txt" ')
  })

  it('drops empty/blank paths (webUtils.getPathForFile returns "" for synthetic files)', () => {
    expect(quotePathsForPaste(['', '  ', '/ok'])).toBe('"/ok" ')
  })

  it('returns empty string for no usable paths', () => {
    expect(quotePathsForPaste(['', ''])).toBe('')
  })

  it('returns empty string for a single blank path', () => {
    expect(quotePathsForPaste([' '])).toBe('')
  })

  // FIND-007: a maliciously-named file must never inject shell commands when dropped on a terminal.
  it('drops a path containing a newline / CR (the bare-prompt submit-injection vector)', () => {
    expect(quotePathsForPaste(['/tmp/a\nrm -rf ~'])).toBe('')
    expect(quotePathsForPaste(['/tmp/a\rrm -rf ~'])).toBe('')
    // a safe sibling in the same multi-file drop still pastes
    expect(quotePathsForPaste(['/tmp/a\nevil', '/tmp/safe.txt'])).toBe('"/tmp/safe.txt" ')
  })

  it('drops a path containing a double-quote (the quote-breakout vector)', () => {
    expect(quotePathsForPaste(['/tmp/a"; rm -rf ~ #'])).toBe('')
  })

  it('KEEPS a path with spaces — spaces inside the quotes are safe and common', () => {
    expect(quotePathsForPaste(['C:\\Canvas ADE\\file.ts'])).toBe('"C:\\Canvas ADE\\file.ts" ')
  })
})
