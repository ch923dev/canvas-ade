// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useBackdropMedia } from './useBackdropMedia'

const read = vi.fn<(assetId: string) => Promise<Uint8Array | null>>()

beforeEach(() => {
  read.mockReset()
  window.api = { asset: { read } } as never
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:test-${++n}`)
  URL.revokeObjectURL = vi.fn()
})

describe('useBackdropMedia', () => {
  it('is idle with no assetId and never touches the asset channel', () => {
    const { result } = renderHook(() => useBackdropMedia(undefined))
    expect(result.current).toEqual({ status: 'idle' })
    expect(read).not.toHaveBeenCalled()
  })

  it('loads bytes into a Blob URL (image ⇒ video:false)', async () => {
    read.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const { result } = renderHook(() => useBackdropMedia('assets/aa.png'))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current).toEqual({ status: 'ready', url: 'blob:test-1', video: false })
  })

  it('flags webm/mp4 as video', async () => {
    read.mockResolvedValue(new Uint8Array([1]))
    const { result } = renderHook(() => useBackdropMedia('assets/clip.mp4'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect((result.current as { video: boolean }).video).toBe(true)
  })

  it('reports missing when the read returns null (deleted asset)', async () => {
    read.mockResolvedValue(null)
    const { result } = renderHook(() => useBackdropMedia('assets/gone.png'))
    await waitFor(() => expect(result.current.status).toBe('missing'))
  })

  it('reports missing when the read rejects', async () => {
    read.mockRejectedValue(new Error('ipc down'))
    const { result } = renderHook(() => useBackdropMedia('assets/x.png'))
    await waitFor(() => expect(result.current.status).toBe('missing'))
  })

  it('revokes the old URL when the assetId changes', async () => {
    read.mockResolvedValue(new Uint8Array([1]))
    const { result, rerender } = renderHook(({ id }) => useBackdropMedia(id), {
      initialProps: { id: 'assets/a.png' }
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ id: 'assets/b.png' })
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1'))
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: 'ready', url: 'blob:test-2' })
    )
  })

  it('revokes on unmount', async () => {
    read.mockResolvedValue(new Uint8Array([1]))
    const { result, unmount } = renderHook(() => useBackdropMedia('assets/a.png'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1')
  })

  it('a late resolve after clearing the assetId does not clobber idle', async () => {
    let resolve!: (b: Uint8Array | null) => void
    read.mockReturnValue(new Promise((r) => (resolve = r)))
    const { result, rerender } = renderHook(({ id }) => useBackdropMedia(id), {
      initialProps: { id: 'assets/a.png' as string | undefined }
    })
    rerender({ id: undefined })
    resolve(new Uint8Array([1]))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toEqual({ status: 'idle' })
  })
})
