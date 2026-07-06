import { describe, it, expect, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { UpdateBadgeDot } from './UpdateBadgeDot'
import { useUpdateStore } from '../store/updateStore'

const dot = (c: HTMLElement): HTMLElement | null =>
  c.querySelector<HTMLElement>('[data-test="update-badge"]')

beforeEach(() => {
  cleanup()
  useUpdateStore.setState({ status: null })
})

describe('UpdateBadgeDot', () => {
  it('renders nothing when no update is waiting', () => {
    const { container } = render(<UpdateBadgeDot />)
    expect(dot(container)).toBeNull()
  })

  it('renders the dot when an update is available', () => {
    useUpdateStore.setState({ status: { state: 'available', version: '1', tier: 'optional' } })
    const { container } = render(<UpdateBadgeDot />)
    expect(dot(container)).toBeTruthy()
  })

  it('uses the warn color for a mandatory update', () => {
    useUpdateStore.setState({ status: { state: 'mandatory', version: '1' } })
    const { container } = render(<UpdateBadgeDot />)
    expect(dot(container)!.style.background).toContain('--warn')
  })

  it('uses the ok color once the update is downloaded', () => {
    useUpdateStore.setState({ status: { state: 'ready', version: '1' } })
    const { container } = render(<UpdateBadgeDot />)
    expect(dot(container)!.style.background).toContain('--ok')
  })
})
