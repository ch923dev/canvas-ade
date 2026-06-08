import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { RecapView } from './RecapView'

describe('RecapView', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      memory: {
        readBoards: vi
          .fn()
          .mockResolvedValue({ b1: '# T\n\n**Now:** doing X\n\n- 14:32 — review auth\n' }),
        refresh: vi.fn().mockResolvedValue({ ok: true })
      }
    }
  })

  it('renders the recap body (heading stripped)', async () => {
    const { container } = render(<RecapView boardId="b1" />)
    await waitFor(() => {
      const body = container.querySelector('[data-test=recap-body]')
      expect(body?.textContent).toContain('**Now:** doing X')
    })
    const body = container.querySelector('[data-test=recap-body]')
    expect(body?.textContent).toContain('14:32 — review auth')
    // The leading "# T" markdown heading is stripped by stripHeading.
    expect(body?.textContent).not.toContain('# T')
  })

  it('shows the empty state when the board has no cached recap', async () => {
    ;(
      window as unknown as { api: { memory: { readBoards: ReturnType<typeof vi.fn> } } }
    ).api.memory.readBoards = vi.fn().mockResolvedValue({})
    const { container } = render(<RecapView boardId="b1" />)
    await waitFor(() => {
      expect(container.querySelector('[data-test=recap-empty]')).toBeTruthy()
    })
    expect(container.querySelector('[data-test=recap-body]')).toBeNull()
    expect(screen.getByText(/No recap yet/)).toBeTruthy()
  })

  it('refresh forces a re-summary then reloads the prose', async () => {
    const readBoards = vi
      .fn()
      .mockResolvedValueOnce({}) // initial load: empty
      .mockResolvedValueOnce({ b1: '# T\n\nFresh recap line\n' }) // after refresh
    const refresh = vi.fn().mockResolvedValue({ ok: true })
    ;(window as unknown as { api: unknown }).api = { memory: { readBoards, refresh } }
    const { container } = render(<RecapView boardId="b1" />)
    await waitFor(() => expect(container.querySelector('[data-test=recap-empty]')).toBeTruthy())
    ;(container.querySelector('[data-test=recap-view] button') as HTMLButtonElement).click()
    await waitFor(() => {
      const body = container.querySelector('[data-test=recap-body]')
      expect(body?.textContent).toContain('Fresh recap line')
    })
    expect(refresh).toHaveBeenCalledWith('b1')
  })
})
