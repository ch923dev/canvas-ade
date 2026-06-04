import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
  fallback: ReactNode | ((reset: () => void, error: Error) => ReactNode)
  onError?: (error: Error, info: ErrorInfo) => void
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] isolated a render throw:', error, info.componentStack)
    this.props.onError?.(error, info)
  }

  private reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    if (this.state.error) {
      const { fallback } = this.props
      return typeof fallback === 'function' ? fallback(this.reset, this.state.error) : fallback
    }
    return this.props.children
  }
}
