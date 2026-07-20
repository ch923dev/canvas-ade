// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { DIAGRAM_MOTION_KEY, useDiagramMotionStore } from './diagramMotionStore'

beforeEach(() => {
  window.localStorage.removeItem(DIAGRAM_MOTION_KEY)
  useDiagramMotionStore.setState({ setting: 'auto' })
})

describe('diagramMotionStore (M7 — the app-setting half of the motion gate)', () => {
  it('defaults to auto and persists an off toggle', () => {
    expect(useDiagramMotionStore.getState().setting).toBe('auto')
    useDiagramMotionStore.getState().setSetting('off')
    expect(useDiagramMotionStore.getState().setting).toBe('off')
    expect(window.localStorage.getItem(DIAGRAM_MOTION_KEY)).toBe('off')
    useDiagramMotionStore.getState().setSetting('auto')
    expect(window.localStorage.getItem(DIAGRAM_MOTION_KEY)).toBe('auto')
  })

  it('identity-skips a same-value set (no storage rewrite, no notify)', () => {
    let notified = 0
    const unsub = useDiagramMotionStore.subscribe(() => {
      notified += 1
    })
    useDiagramMotionStore.getState().setSetting('auto')
    expect(notified).toBe(0)
    expect(window.localStorage.getItem(DIAGRAM_MOTION_KEY)).toBeNull() // untouched
    unsub()
  })
})
