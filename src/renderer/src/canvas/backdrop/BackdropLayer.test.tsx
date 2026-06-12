// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import {
  BackdropLayer,
  BACKDROP_MISSING_TOAST_ID,
  BACKDROP_UNKNOWN_SCENE_TOAST_ID
} from './BackdropLayer'
import { useCanvasStore } from '../../store/canvasStore'
import { useToastStore } from '../../store/toastStore'
import { getScene } from './sceneRegistry'

const read = vi.fn<(assetId: string) => Promise<Uint8Array | null>>()

beforeEach(() => {
  read.mockReset()
  window.api = { asset: { read } } as never
  URL.createObjectURL = vi.fn(() => 'blob:test-1')
  URL.revokeObjectURL = vi.fn()
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })) as never
  useCanvasStore.setState({ background: null })
  useToastStore.getState().clearToasts()
})

afterEach(cleanup)

const toasts = () => useToastStore.getState().toasts

describe('BackdropLayer', () => {
  it('renders nothing when background is null (feature untouched)', () => {
    const { container } = render(<BackdropLayer />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when kind is none', () => {
    useCanvasStore.getState().setBackground({ kind: 'none' })
    const { container } = render(<BackdropLayer />)
    expect(container.firstChild).toBeNull()
  })

  it('registers no document listeners while no ready video is mounted', () => {
    const spy = vi.spyOn(document, 'addEventListener')
    render(<BackdropLayer />) // background null
    useCanvasStore.getState().setBackground({ kind: 'scene', scene: 'x' }) // re-render, still no video
    expect(spy.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(false)
    spy.mockRestore()
  })

  it('file backdrop: renders the image with the saturate filter + dim veil', async () => {
    read.mockResolvedValue(new Uint8Array([1]))
    useCanvasStore
      .getState()
      .setBackground({ kind: 'file', assetId: 'assets/wall.png', dim: 0.4, saturation: 0.9 })
    const { container } = render(<BackdropLayer />)
    await waitFor(() => expect(container.querySelector('img.backdrop-media')).not.toBeNull())
    const img = container.querySelector('img.backdrop-media') as HTMLImageElement
    expect(img.src).toContain('blob:test-1')
    expect(img.style.filter).toBe('saturate(0.9)')
    const dim = container.querySelector('.backdrop-dim') as HTMLDivElement
    expect(dim.style.opacity).toBe('0.4')
  })

  it('file backdrop: a video asset renders a muted looping <video>', async () => {
    read.mockResolvedValue(new Uint8Array([1]))
    useCanvasStore.getState().setBackground({ kind: 'file', assetId: 'assets/clip.webm' })
    const { container } = render(<BackdropLayer />)
    await waitFor(() => expect(container.querySelector('video.backdrop-media')).not.toBeNull())
    const video = container.querySelector('video.backdrop-media') as HTMLVideoElement
    expect(video.muted).toBe(true)
    expect(video.loop).toBe(true)
  })

  it('missing wallpaper: reverts kind to none + raises the keyed toast (spec §3)', async () => {
    read.mockResolvedValue(null)
    useCanvasStore.getState().setBackground({ kind: 'file', assetId: 'assets/gone.png' })
    render(<BackdropLayer />)
    await waitFor(() => expect(toasts().some((t) => t.id === BACKDROP_MISSING_TOAST_ID)).toBe(true))
    expect(useCanvasStore.getState().background?.kind).toBe('none')
  })

  it('unknown scene id: plain void + toast, the SETTING is preserved (forward-compat)', () => {
    useCanvasStore.getState().setBackground({ kind: 'scene', scene: 'not-shipped-yet' })
    const { container } = render(<BackdropLayer />)
    // Layer present (dim veil only) — no media element.
    expect(container.querySelector('[data-test="backdrop-layer"]')).not.toBeNull()
    expect(container.querySelector('.backdrop-media')).toBeNull()
    expect(toasts().some((t) => t.id === BACKDROP_UNKNOWN_SCENE_TOAST_ID)).toBe(true)
    expect(useCanvasStore.getState().background?.scene).toBe('not-shipped-yet')
  })

  it('never reads the camera: no viewport subscription, pointer-events none via class', () => {
    useCanvasStore.getState().setBackground({ kind: 'scene', scene: 'x' })
    const { container } = render(<BackdropLayer />)
    const layer = container.querySelector('[data-test="backdrop-layer"]') as HTMLDivElement
    expect(layer.className).toBe('backdrop-layer')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
  })

  describe('known scene lifecycle (S6/S7)', () => {
    const def = getScene('blossom-river')!
    const handle = { start: vi.fn(), stop: vi.fn(), renderStill: vi.fn() }
    let createSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      handle.start.mockClear()
      handle.stop.mockClear()
      handle.renderStill.mockClear()
      createSpy = vi.spyOn(def, 'create').mockReturnValue(handle)
    })

    afterEach(() => {
      createSpy.mockRestore()
      Reflect.deleteProperty(document, 'hidden')
    })

    it('mounts the canvas host with the saturate filter and STARTS the handle (AC-1/AC-5)', () => {
      useCanvasStore
        .getState()
        .setBackground({ kind: 'scene', scene: 'blossom-river', saturation: 0.8 })
      const { container } = render(<BackdropLayer />)
      const canvas = container.querySelector(
        'canvas[data-test="backdrop-scene"]'
      ) as HTMLCanvasElement
      expect(canvas).not.toBeNull()
      expect(canvas.style.filter).toBe('saturate(0.8)')
      expect(canvas.className).toBe('backdrop-media')
      expect(createSpy).toHaveBeenCalledWith(canvas, { palette: undefined, reducedMotion: false })
      expect(handle.start).toHaveBeenCalled()
      expect(handle.renderStill).not.toHaveBeenCalled()
      expect(toasts().some((t) => t.id === BACKDROP_UNKNOWN_SCENE_TOAST_ID)).toBe(false)
    })

    it('reduced motion: renders exactly one still, never starts the loop (AC-6)', () => {
      window.matchMedia = vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      })) as never
      useCanvasStore.getState().setBackground({ kind: 'scene', scene: 'blossom-river' })
      render(<BackdropLayer />)
      expect(createSpy).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), {
        palette: undefined,
        reducedMotion: true
      })
      expect(handle.renderStill).toHaveBeenCalled()
      expect(handle.start).not.toHaveBeenCalled()
    })

    it('document.hidden stops the loop; visible resumes it (AC-7)', () => {
      useCanvasStore.getState().setBackground({ kind: 'scene', scene: 'blossom-river' })
      render(<BackdropLayer />)
      handle.start.mockClear()
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(handle.stop).toHaveBeenCalled()
      expect(handle.start).not.toHaveBeenCalled()
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(handle.start).toHaveBeenCalled()
    })

    it('unmount stops the handle (no orphan rAF)', () => {
      useCanvasStore.getState().setBackground({ kind: 'scene', scene: 'blossom-river' })
      const { unmount } = render(<BackdropLayer />)
      unmount()
      expect(handle.stop).toHaveBeenCalled()
    })

    it('switching to None tears the canvas down and stops the handle (AC-11)', () => {
      useCanvasStore.getState().setBackground({ kind: 'scene', scene: 'blossom-river' })
      const { container } = render(<BackdropLayer />)
      expect(container.querySelector('[data-test="backdrop-scene"]')).not.toBeNull()
      act(() => {
        useCanvasStore.getState().setBackground({ kind: 'none' })
      })
      expect(handle.stop).toHaveBeenCalled()
      expect(container.querySelector('[data-test="backdrop-scene"]')).toBeNull()
    })
  })
})
