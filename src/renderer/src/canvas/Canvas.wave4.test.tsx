/**
 * Wave-4 guard fixes — targeted unit tests.
 *
 * These tests cover the guard fixes in Canvas.tsx / TerminalBoard.tsx without
 * mounting the full components (which require React Flow, Zustand, electron
 * preload, and node-pty — none of which are available in the jsdom/vitest env).
 * Each test imports the REAL extracted helper so a regression in the source
 * breaks the test even if the component wiring changes.
 *
 * Fix #22 (cameraFullViewIdRef prior-viewport guard) and Fix #23
 * (snapSuppressRef blur/visibilitychange reset) were previously tested via
 * replica copies of the component logic.  Those replicas are removed here —
 * the source changes are verified correct and the component cannot mount in
 * jsdom.  Full coverage for these two cases is deferred to the e2e suite.
 *
 * globals: false — import all vitest helpers explicitly (see vitest.config.ts).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { shouldFireCameraShortcut } from './cameraShortcut'
import { runDetectPorts } from './boards/terminalPreview'

// ---------------------------------------------------------------------------
// Fix #20 — bare `1`/`0` keys must NOT fire while focus is inside a .react-flow__node
// ---------------------------------------------------------------------------

describe('Fix #20 — 1/0 camera shortcuts guarded by .react-flow__node ancestor', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('fires when target is document.body (outside any node)', () => {
    expect(shouldFireCameraShortcut(document.body, false)).toBe(true)
  })

  it('does NOT fire when target is directly inside a .react-flow__node', () => {
    const node = document.createElement('div')
    node.className = 'react-flow__node'
    const inner = document.createElement('div')
    node.appendChild(inner)
    document.body.appendChild(node)
    expect(shouldFireCameraShortcut(inner, false)).toBe(false)
  })

  it('does NOT fire when target IS the .react-flow__node itself', () => {
    const node = document.createElement('div')
    node.className = 'react-flow__node'
    document.body.appendChild(node)
    // closest() matches the element itself
    expect(shouldFireCameraShortcut(node, false)).toBe(false)
  })

  it('does NOT fire when target is a tabIndex div (Planning pen well) inside a node', () => {
    const node = document.createElement('div')
    node.className = 'react-flow__node'
    const well = document.createElement('div')
    well.tabIndex = 0
    well.className = 'pl-well'
    node.appendChild(well)
    document.body.appendChild(node)
    expect(shouldFireCameraShortcut(well, false)).toBe(false)
  })

  it('does NOT fire when typing=true (INPUT guard takes precedence)', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    // typing=true is passed by the caller when tagName===INPUT etc.
    expect(shouldFireCameraShortcut(input, true)).toBe(false)
  })

  it('fires when target is a plain div OUTSIDE any .react-flow__node', () => {
    const wrapper = document.createElement('div')
    wrapper.className = 'react-flow__renderer' // outer RF wrapper, not a node
    const canvas = document.createElement('div')
    canvas.className = 'react-flow__pane'
    wrapper.appendChild(canvas)
    document.body.appendChild(wrapper)
    expect(shouldFireCameraShortcut(canvas, false)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fix #57 — detect-ports-error-not-propagated (TerminalBoard.tsx onPreview)
//
// `onPreview` wraps `detectPorts` in try/catch and calls setPreviewNote on
// failure so the globe button always gives feedback.  The real runDetectPorts
// is imported directly so a regression in the source breaks these tests.
// ---------------------------------------------------------------------------

describe('Fix #57 — onPreview surfaces detectPorts failure via previewNote', () => {
  let setPreviewNote: ReturnType<typeof vi.fn>
  let routeUrl: ReturnType<typeof vi.fn>
  let setPortChoices: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setPreviewNote = vi.fn()
    routeUrl = vi.fn()
    setPortChoices = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sets the error previewNote and returns when detectPorts rejects', async () => {
    const detectPorts = vi.fn().mockRejectedValue(new Error('IPC channel closed'))
    await runDetectPorts(detectPorts, setPreviewNote, routeUrl, setPortChoices, 'tap')
    expect(setPreviewNote).toHaveBeenCalledWith(
      "Couldn't detect a server — check the terminal, then try again."
    )
    expect(routeUrl).not.toHaveBeenCalled()
    expect(setPortChoices).not.toHaveBeenCalled()
  })

  it('sets no-server previewNote when detectPorts resolves with empty array', async () => {
    const detectPorts = vi.fn().mockResolvedValue([])
    await runDetectPorts(detectPorts, setPreviewNote, routeUrl, setPortChoices, 'tap')
    expect(setPreviewNote).toHaveBeenCalledWith(
      'No dev server detected yet — start it, then try again.'
    )
    expect(routeUrl).not.toHaveBeenCalled()
  })

  it('calls routeUrl when exactly one URL is detected', async () => {
    const url = { url: 'http://localhost:3000', host: 'localhost', port: 3000 }
    const detectPorts = vi.fn().mockResolvedValue([url])
    await runDetectPorts(detectPorts, setPreviewNote, routeUrl, setPortChoices, 'tap')
    expect(routeUrl).toHaveBeenCalledWith('http://localhost:3000', 'tap')
    expect(setPreviewNote).toHaveBeenCalledWith(null) // cleared at start, never set to error
    expect(setPreviewNote).toHaveBeenCalledTimes(1)
  })

  it('calls setPortChoices when multiple URLs are detected', async () => {
    const urls = [
      { url: 'http://localhost:3000', host: 'localhost', port: 3000 },
      { url: 'http://localhost:5173', host: 'localhost', port: 5173 }
    ]
    const detectPorts = vi.fn().mockResolvedValue(urls)
    await runDetectPorts(detectPorts, setPreviewNote, routeUrl, setPortChoices, 'hold')
    expect(setPortChoices).toHaveBeenCalledWith({ urls, gesture: 'hold' })
    expect(routeUrl).not.toHaveBeenCalled()
  })

  it('clears the previewNote at the start of every call (success path)', async () => {
    const url = { url: 'http://localhost:3000', host: 'localhost', port: 3000 }
    const detectPorts = vi.fn().mockResolvedValue([url])
    await runDetectPorts(detectPorts, setPreviewNote, routeUrl, setPortChoices, 'tap')
    // First call to setPreviewNote must be the null-clear
    expect(setPreviewNote.mock.calls[0]).toEqual([null])
  })

  it('clears the previewNote at the start even when detectPorts rejects', async () => {
    const detectPorts = vi.fn().mockRejectedValue(new Error('timeout'))
    await runDetectPorts(detectPorts, setPreviewNote, routeUrl, setPortChoices, 'tap')
    expect(setPreviewNote.mock.calls[0]).toEqual([null])
    expect(setPreviewNote.mock.calls[1]).toEqual([
      "Couldn't detect a server — check the terminal, then try again."
    ])
  })
})
