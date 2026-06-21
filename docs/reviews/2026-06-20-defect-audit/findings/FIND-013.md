# FIND-013 — O(n^2) soft-wrap-fragment filter in parsePortsFromOutput blocks MAIN ~0.7–1s on a 256KB buffer densely packed with localhost URLs (adversarial/agent-induced)

| | |
|---|---|
| **Severity** | Low |
| **Category** | performance cliff |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/main/portDetect.ts:84-86` |
| **Discovery slice** | M-RECAP-MISC (run 1) |

## Summary
The prefix-fragment filter `found.filter(a => !found.some(b => b.text.length > a.text.length && b.text.startsWith(a.text)))` is O(n^2) in the number of matched URLs (n = count of localhost/loopback URL matches in the buffer), with a String.startsWith on each pair. parsePortsFromOutput runs synchronously in MAIN on the `terminal:detectPorts` IPC over the session's output ring buffer (pty.ts:355), which is capped at RING_CAP_BYTES = 256KB. A buffer densely packed with short localhost URLs (e.g. `http://localhost:1` ~18 bytes) yields ~14,000 matches → ~2x10^8 startsWith comparisons on a single synchronous MAIN-thread call, a multi-second stall that freezes the whole app (all windows, all PTYs). Triggered on an explicit user action (preview-connect / browser-board auto-connect poll), and the source is the agent's own terminal output — an agent could be induced to print many URLs. Bounded by the 256KB cap so it is a one-shot stall, not unbounded; hence Low.

## Trigger
A terminal board's 256KB output buffer contains thousands of short localhost/loopback URLs (pathological/adversarial dev-server output, or an agent printing a list of ports), then the user triggers preview-connect or the browser board's auto-connect poll calls window.api.detectPorts(id).

## Evidence / concrete faulty path (code-grounded)
Repro: feed parsePortsFromOutput a 256KB string of repeated `http://0.0.0.0\n` (the shortest URL_RE match, ~15 bytes/line). Measured n=17,476 matches; the lines-84-86 filter executes in ~626–838ms across 3 JIT-warmed runs on node V8 — a synchronous block of MAIN. Faulty path: pty.ts:355 `const raw = sessions.get(id)?.buf.data ?? parked.get(id)?.buf.data ?? ''` (capped at RING_CAP_BYTES, pty.ts:96/116) → pty.ts:356 `return parsePortsFromOutput(raw)` → portDetect.ts:84-86 `const real = found.filter((a) => !found.some((b) => b.text.length > a.text.length && b.text.startsWith(a.text)))`. Reachable via TerminalBoard.tsx:338 (user action) and useBrowserAutoConnect.ts:93 (1s poll). Input is bounded, so it is a one-shot ~0.7–1s freeze, not unbounded — consistent with Low.

## Verifier reasoning (why CONFIRMED; scope & severity)
The O(n^2) filter at portDetect.ts:84-86 is real and the path is reachable in the shipped app. `parsePortsFromOutput` runs synchronously in MAIN on the `terminal:detectPorts` IPC (pty.ts:352-356), over `sessions.get(id)?.buf.data ?? parked.get(id)?.buf.data`, which is ring-capped at RING_CAP_BYTES = 256*1024 (pty.ts:116) via appendRing's slice (pty.ts:96). The nested `found.filter(a => !found.some(b => b.text.length > a.text.length && b.text.startsWith(a.text)))` is quadratic in the number of URL matches. Two shipped callers reach it: the user preview-connect action (TerminalBoard.tsx:338 → window.api.detectPorts) and the browser-board auto-connect poll (useBrowserAutoConnect.ts:93, 1s interval while not-connected, with 1→2→4s backoff). I measured it: a 256KB buffer packed with `http://0.0.0.0` yields ~17,476 matches and the filter alone takes ~600–840ms steady-state (JIT-warmed) on node V8 — a synchronous MAIN-thread block that freezes all windows/PTYs for that duration. So the mechanism is confirmed. Two corrections to the candidate's writeup that cap the severity: (1) the magnitude is overstated — it is ~0.7–1s, not "multi-second" (in the dense-identical case the `&&` short-circuits on the length comparison so `startsWith` is rarely invoked; it is ~2.7e8 cheap length compares that dominate, not startsWith). (2) The trigger is pathological/adversarial: normal dev-server output prints a handful of localhost URLs, never thousands; reaching n≈16–17k requires crafted/agent-induced output. It is bounded (one-shot per call by the 256KB cap, partially amplified by the backoff'd auto-connect poll), no crash, no data loss. This is a genuine algorithmic-complexity defect (not a re-render/a11y/style/UX item), so in-scope for a defect lens, and Low is the correct severity.

## Fix direction (audit only — NOT applied)
Replace the O(n^2) found.filter(a => found.some(b => b.startsWith(a))) prefix-filter with a single-pass approach (sort matches by text length, keep the longest per host:port), or cap the number of matches processed, so a 256KB buffer densely packed with localhost URLs cannot block MAIN ~1s.

## Files this card touches
- `src/main/portDetect.ts (parsePortsFromOutput 84-86)`

## Collision flags (sequence with)
- None — independently fixable in parallel.
