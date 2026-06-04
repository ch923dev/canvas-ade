import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

const Boom = (): React.ReactElement => {
  throw new Error('kaboom')
}

describe('ErrorBoundary', () => {
  it('renders the fallback instead of propagating a child throw', () => {
    render(
      <ErrorBoundary fallback={<div>recovery-ui</div>}>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('recovery-ui')).toBeTruthy()
  })

  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary fallback={<div>recovery-ui</div>}>
        <div>ok</div>
      </ErrorBoundary>
    )
    expect(screen.getByText('ok')).toBeTruthy()
  })

  it('calls a function fallback with a reset callback and the error', () => {
    render(
      <ErrorBoundary fallback={(_reset, err) => <div>caught: {err.message}</div>}>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('caught: kaboom')).toBeTruthy()
  })
})
