// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { BrowserPickPanel, NEW_BROWSER } from './BrowserPickPanel'
import type { PreviewCandidate } from '../../../lib/previewTarget'

afterEach(cleanup)

const candidates: PreviewCandidate[] = [
  { id: 'b1', title: 'Browser 1', url: 'http://localhost:3000' },
  {
    id: 'b2',
    title: 'Browser 2',
    url: 'http://localhost:5173',
    connectedTo: { id: 't9', title: 'Other terminal' }
  }
]

describe('BrowserPickPanel', () => {
  it('renders every candidate plus the "+ New browser" row, Connect disabled', () => {
    const { getByText, getAllByRole } = render(
      <BrowserPickPanel candidates={candidates} onCancel={() => {}} onConfirm={() => {}} />
    )
    expect(getByText('Browser 1')).toBeTruthy()
    expect(getByText('Browser 2')).toBeTruthy()
    expect(getByText('+ New browser')).toBeTruthy()
    expect(getAllByRole('checkbox')).toHaveLength(3)
    expect((getByText('Connect') as HTMLButtonElement).disabled).toBe(true)
  })

  it('checking rows enables Connect with a count and confirms the checked keys', () => {
    const onConfirm = vi.fn()
    const { getByText, getAllByRole } = render(
      <BrowserPickPanel candidates={candidates} onCancel={() => {}} onConfirm={onConfirm} />
    )
    const boxes = getAllByRole('checkbox') as HTMLInputElement[]
    fireEvent.click(boxes[0]) // b1
    fireEvent.click(boxes[2]) // + New browser
    const connect = getByText('Connect 2') as HTMLButtonElement
    expect(connect.disabled).toBe(false)
    fireEvent.click(connect)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    const keys = onConfirm.mock.calls[0][0] as Set<string>
    expect(keys.has('b1')).toBe(true)
    expect(keys.has(NEW_BROWSER)).toBe(true)
    expect(keys.size).toBe(2)
  })

  it('unchecking removes the key again', () => {
    const onConfirm = vi.fn()
    const { getByText, getAllByRole } = render(
      <BrowserPickPanel candidates={candidates} onCancel={() => {}} onConfirm={onConfirm} />
    )
    const boxes = getAllByRole('checkbox') as HTMLInputElement[]
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[0])
    expect((getByText('Connect') as HTMLButtonElement).disabled).toBe(true)
  })

  it('warns about severing only when a checked candidate is already connected', () => {
    const { queryByText, getAllByRole } = render(
      <BrowserPickPanel candidates={candidates} onCancel={() => {}} onConfirm={() => {}} />
    )
    expect(queryByText(/Disconnects/)).toBeNull()
    const boxes = getAllByRole('checkbox') as HTMLInputElement[]
    fireEvent.click(boxes[0]) // b1 — not connected, no warning
    expect(queryByText(/Disconnects/)).toBeNull()
    fireEvent.click(boxes[1]) // b2 — connected elsewhere
    expect(queryByText(/Disconnects 1 browser from its current terminal./)).toBeTruthy()
  })

  it('Cancel fires onCancel without confirming', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const { getByText } = render(
      <BrowserPickPanel candidates={candidates} onCancel={onCancel} onConfirm={onConfirm} />
    )
    fireEvent.click(getByText('Cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
