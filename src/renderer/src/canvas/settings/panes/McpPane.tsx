/**
 * MCP Servers detail pane — the `mcp` tile. READ-ONLY by design (PLAN › Non-goals): managing
 * *external* MCP servers does not exist yet and is its own future session (memory
 * `mcp-add-server-feature`). So this pane explains what IS true today — Expanse itself is an MCP
 * server that terminal agents connect to (via Orchestration) — and flags external-server management
 * as coming, with NO fake "Add server" button. When that session ships, this pane grows the list.
 */
import { type ReactElement } from 'react'
import { pane } from '../paneStyles'

export function McpPane(): ReactElement {
  return (
    <div style={pane.section}>
      <div style={pane.acctRow} data-test="mcp-self-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={pane.acctEmail}>Expanse as a server</div>
          <div style={pane.acctSub}>
            This canvas exposes MCP tools that your terminal agents drive over their cables. Enable
            it per project in Orchestration.
          </div>
        </div>
      </div>
      <div style={pane.notice} role="note" data-test="mcp-external-coming">
        Connecting your own external MCP servers is coming in a later update. There is nothing to
        add here yet.
      </div>
    </div>
  )
}
