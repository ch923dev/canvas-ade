// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { BackdropPicker, IMAGE_CAP_BYTES } from './BackdropPicker'
import { useCanvasStore } from '../store/canvasStore'
import { useToastStore } from '../store/toastStore'

const write =
  vi.fn<(bytes: Uint8Array, ext: string) => Promise<{ assetId: string } | { error: string }>>()

beforeEach(() => {
  write.mockReset()
  window.api = { asset: { write } } as never
  useCanvasStore.setState({ background: null })
  useToastStore.getState().clearToasts()
})

afterEach(cleanup)

function openPicker(): void {
  fireEvent.click(screen.getByTitle('Backdrop'))
}

/** A File whose size lies (jsdom Files are tiny) — cap checks read .size only. */
function fakeFile(name: string, size: number): File {
  const f = new File([new Uint8Array([1, 2, 3])], name)
  Object.defineProperty(f, 'size', { value: size })
  return f
}

function pickFile(f: File): void {
  const input = document.querySelector('[data-test="backdrop-file-input"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [f], configurable: true })
  fireEvent.change(input)
}

describe('BackdropPicker', () => {
  it('None is checked by default; choosing it writes kind none', () => {
    render(<BackdropPicker />)
    openPicker()
    const none = screen.getByRole('menuitemradio', { name: 'None' })
    expect(none.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(none)
    expect(useCanvasStore.getState().background?.kind).toBe('none')
  })

  it('sliders + grid toggle are disabled while source is none (spec §3)', () => {
    render(<BackdropPicker />)
    openPicker()
    const ctl = (k: string): HTMLInputElement =>
      document.querySelector(`[data-test="backdrop-${k}"]`) as HTMLInputElement
    expect(ctl('dim').disabled).toBe(true)
    expect(ctl('saturation').disabled).toBe(true)
    expect(ctl('griddots').disabled).toBe(true)
  })

  it('a good wallpaper pick writes the asset and sets kind file + assetId', async () => {
    write.mockResolvedValue({ assetId: 'assets/abc.png' })
    render(<BackdropPicker />)
    openPicker()
    pickFile(fakeFile('wall.png', 1024))
    await waitFor(() =>
      expect(useCanvasStore.getState().background).toMatchObject({
        kind: 'file',
        assetId: 'assets/abc.png'
      })
    )
    expect(write).toHaveBeenCalledWith(expect.any(Uint8Array), 'png')
  })

  it('rejects an over-cap image with a toast and never writes (spec §6)', async () => {
    render(<BackdropPicker />)
    openPicker()
    pickFile(fakeFile('huge.png', IMAGE_CAP_BYTES + 1))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => /too large/i.test(t.message))).toBe(true)
    )
    expect(write).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().background).toBeNull()
  })

  it('rejects an unsupported extension with a toast', async () => {
    render(<BackdropPicker />)
    openPicker()
    pickFile(fakeFile('notes.txt', 10))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => /unsupported/i.test(t.message))).toBe(true)
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('surfaces a read/IPC rejection as a toast (fire-and-forget caller, no silent failure)', async () => {
    write.mockRejectedValue(new Error('ipc gone'))
    render(<BackdropPicker />)
    openPicker()
    pickFile(fakeFile('wall.png', 10))
    await waitFor(() =>
      expect(
        useToastStore.getState().toasts.some((t) => /failed to read backdrop file/i.test(t.message))
      ).toBe(true)
    )
    expect(useCanvasStore.getState().background).toBeNull()
  })

  it('surfaces an asset-write error as a toast (no silent failure)', async () => {
    write.mockResolvedValue({ error: 'disk full' })
    render(<BackdropPicker />)
    openPicker()
    pickFile(fakeFile('wall.png', 10))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => /disk full/.test(t.message))).toBe(true)
    )
    expect(useCanvasStore.getState().background).toBeNull()
  })

  it('dim slider applies live through setBackground once a source is active', () => {
    useCanvasStore.getState().setBackground({ kind: 'scene', scene: 'x' })
    render(<BackdropPicker />)
    openPicker()
    fireEvent.change(document.querySelector('[data-test="backdrop-dim"]') as HTMLInputElement, {
      target: { value: '0.5' }
    })
    expect(useCanvasStore.getState().background?.dim).toBe(0.5)
  })

  it('grid-dots toggle writes background.gridDots', () => {
    useCanvasStore.getState().setBackground({ kind: 'scene', scene: 'x' })
    render(<BackdropPicker />)
    openPicker()
    fireEvent.click(document.querySelector('[data-test="backdrop-griddots"]') as HTMLInputElement)
    expect(useCanvasStore.getState().background?.gridDots).toBe(true)
  })
})
