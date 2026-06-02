import { it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { ImageCard } from './ImageCard'
import type { ImageElement } from '../../../lib/boardSchema'

afterEach(cleanup)

const image: ImageElement = {
  id: 'i1',
  kind: 'image',
  x: 0,
  y: 0,
  w: 120,
  h: 80,
  assetId: 'assets/' + 'a'.repeat(40) + '.png'
}

beforeEach(() => {
  // jsdom has no object-URL plumbing — stub it.
  ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:fake')
  ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn()
})

function setApi(read: () => Promise<Uint8Array | null>): void {
  ;(window as unknown as { api: unknown }).api = { asset: { read: vi.fn(read) } }
}

it('renders an <img> with the object URL when bytes load', async () => {
  setApi(async () => new Uint8Array([1, 2, 3]))
  render(<ImageCard image={image} interactive={true} onDragStart={() => {}} />)
  await waitFor(() => {
    const img = document.querySelector('img') as HTMLImageElement | null
    expect(img?.getAttribute('src')).toBe('blob:fake')
  })
})

it('renders a fallback when the asset is missing', async () => {
  setApi(async () => null)
  render(<ImageCard image={image} interactive={true} onDragStart={() => {}} />)
  await waitFor(() => expect(screen.getByText(/missing image/i)).toBeTruthy())
})
