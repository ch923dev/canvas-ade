// @vitest-environment jsdom
import { it, expect, vi, afterEach, beforeEach, describe } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import { useState } from 'react'
import { ImageCard } from './ImageCard'
import type { ImageElement } from '../../../lib/boardSchema'

afterEach(cleanup)

const assetId = 'assets/' + 'a'.repeat(40) + '.png'
const imageA: ImageElement = { id: 'i1', kind: 'image', x: 0, y: 0, w: 120, h: 80, assetId }
const imageB: ImageElement = { id: 'i2', kind: 'image', x: 0, y: 0, w: 120, h: 80, assetId }

beforeEach(() => {
  // jsdom has no object-URL plumbing — stub it.
  let counter = 0
  ;(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(
    () => `blob:fake-${++counter}`
  )
  ;(URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = vi.fn()
})

function setApi(read: () => Promise<Uint8Array | null>): void {
  ;(window as unknown as { api: unknown }).api = { asset: { read: vi.fn(read) } }
}

it('renders an <img> with the object URL when bytes load', async () => {
  setApi(async () => new Uint8Array([1, 2, 3]))
  render(<ImageCard image={imageA} interactive={true} onDragStart={() => {}} />)
  await waitFor(() => {
    const img = document.querySelector('img') as HTMLImageElement | null
    expect(img?.getAttribute('src')).toMatch(/^blob:fake/)
  })
})

it('renders a fallback when the asset is missing', async () => {
  setApi(async () => null)
  render(<ImageCard image={imageA} interactive={true} onDragStart={() => {}} />)
  await waitFor(() => expect(screen.getByText(/missing image/i)).toBeTruthy())
})

describe('useAssetUrl revoke race (BUG-036)', () => {
  /**
   * Reproduce the race by placing two ImageCards at DIFFERENT positions in the tree
   * so React unmounts the first and mounts the second in the same commit batch.
   *
   * Parent renders either [A, null] or [null, B]:
   *   slot 0 = A present (or null)
   *   slot 1 = B present (or null)
   *
   * Switching from [A, null] → [null, B] causes React to unmount A (slot 0 → null)
   * and mount B (slot 1 null → B) in the same commit. Within that commit's passive-
   * effect flush, A's useEffect cleanup runs BEFORE B's useEffect setup — the race
   * window. Without the fix, A's cleanup revokes the shared blob URL before B can
   * claim it, so B renders with a revoked URL (broken image).
   */
  it('does not revoke the shared blob URL while the incoming sibling still needs it', async () => {
    setApi(async () => new Uint8Array([1, 2, 3]))

    // Parent holds a boolean: true = show A at slot 0, false = show B at slot 1.
    let setShowA!: (v: boolean) => void
    function Host() {
      const [showA, _setShowA] = useState(true)
      setShowA = _setShowA
      return (
        <div>
          {showA ? (
            <ImageCard key="a" image={imageA} interactive={false} onDragStart={() => {}} />
          ) : null}
          {!showA ? (
            <ImageCard key="b" image={imageB} interactive={false} onDragStart={() => {}} />
          ) : null}
        </div>
      )
    }

    render(<Host />)

    // Wait for A to load and populate the cache.
    await waitFor(() => {
      const img = document.querySelector('img') as HTMLImageElement | null
      expect(img?.getAttribute('src')).toMatch(/^blob:fake/)
    })

    const revokeObjectURL = URL.revokeObjectURL as ReturnType<typeof vi.fn>
    expect(revokeObjectURL).not.toHaveBeenCalled()

    // Capture the shared blob URL that A is rendering with.
    const sharedUrl = (document.querySelector('img') as HTMLImageElement).getAttribute('src')!

    // Switch: A unmounts, B mounts — same React batch.
    // act() flushes all effects including layout effects and passive effects.
    await act(async () => {
      setShowA(false)
    })

    // The shared blob URL must NOT have been revoked: B's layout effect should have
    // incremented refs BEFORE A's effect cleanup ran, preventing the ref count from
    // dropping to 0.
    expect(revokeObjectURL).not.toHaveBeenCalledWith(sharedUrl)

    // B must be showing an <img> (not the "missing image" placeholder).
    const imgEl = document.querySelector('img') as HTMLImageElement | null
    expect(imgEl).not.toBeNull()
    // The src must be a blob URL (either the shared one, or the same content re-read).
    expect(imgEl?.getAttribute('src')).toMatch(/^blob:fake/)
  })
})
