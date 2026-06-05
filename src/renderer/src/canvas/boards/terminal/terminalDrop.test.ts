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
})
