/**
 * MCP Servers detail pane — the `mcp` section (Agents & AI group). Two parts: a read-only note that
 * Expanse ITSELF is an MCP server terminal agents connect to (via Orchestration), and the manager
 * for the user's OWN external MCP servers (feature: add external MCP servers) — a self-contained
 * list + Add/Edit/Test that writes each server into the selected agent CLIs' configs. The panel's
 * section renders the "MCP Servers" heading; this pane is just the body.
 */
import { type ReactElement } from 'react'
import { pane } from '../paneStyles'
import { McpServersManager } from '../McpServersManager'

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

      <div style={pane.divider} />

      <div style={pane.head}>Your servers</div>
      <div style={pane.hint}>
        Connect your own MCP servers for terminal agents to use. Written into each selected
        CLI&apos;s config on launch.
      </div>
      <McpServersManager />
    </div>
  )
}
