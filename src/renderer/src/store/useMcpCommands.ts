import { useEffect } from 'react'

/**
 * Apply MAIN → renderer MCP commands — the inverse of {@link useMcpPublish} (which
 * pushes board facts out). MAIN posts a typed command; this acks it on the reply
 * channel. T0.3 handles only `ping` (proves the round-trip); M3 (lifecycle) adds
 * board CRUD here against `canvasStore`. A no-op if the bridge is absent (a
 * non-electron test runtime).
 */
export function useMcpCommands(): void {
  useEffect(() => {
    const onCommand = window.api?.mcp?.onCommand
    if (!onCommand) return
    return onCommand((command, reply) => {
      switch (command.type) {
        case 'ping':
          reply({ ok: true, type: 'ping' })
          break
        default:
          reply({ ok: false, error: `unknown command: ${command.type}` })
      }
    })
  }, [])
}
