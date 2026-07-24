// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { renderSpecIcon } from '@expanse-ade/diagram'
import { specIconVocabularyInSync, SPEC_HOST_ICONS } from './specHostIcons'
// Side-effect import: wires the seams exactly as main.tsx does (styles import, worker factory,
// icon renderer registration) — these tests pin the seams a package bump could silently break.
import './diagramPackageBridge'

describe('diagramPackageBridge — @expanse-ade/diagram host seams', () => {
  it('keeps the host icon pin in sync with the package SPEC_ICON_NAMES vocabulary', () => {
    // SPEC_HOST_ICONS is compile-checked against IconName (satisfies); this closes the loop the
    // other way: the package list cannot grow/shrink without this pin (and the registry) following.
    expect(specIconVocabularyInSync()).toBe(true)
  })

  it('registers a renderer that draws a host Icon svg for every vocabulary name', () => {
    for (const name of SPEC_HOST_ICONS) {
      const node = renderSpecIcon(name, { size: 13, style: { color: 'var(--text-3)' } })
      expect(node).not.toBeNull()
      const { container, unmount } = render(<>{node}</>)
      expect(container.querySelector('svg')).toBeTruthy()
      unmount()
    }
  })
})
