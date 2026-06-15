/*
 * Diagram-worker render bridge (S4). Loaded as an EXTERNAL script (not inline) so it is authorized
 * by the worker CSP `script-src 'self' 'unsafe-eval'` WITHOUT needing `'unsafe-inline'` — keeping the
 * worker policy as tight as possible (inline-script injection stays blocked; eval is granted only
 * for Mermaid's dagre layout). MAIN (src/main/diagramWorker.ts) calls window.__renderDiagram via
 * webContents.executeJavaScript and awaits the returned promise: it resolves to the sanitized SVG
 * string, or rejects with a descriptive parse/render error.
 *
 * Every security-critical Mermaid setting is FORCED here (never trusted from the caller):
 * securityLevel 'strict' (DOMPurify-sanitized SVG, tags in text encoded), htmlLabels off, a
 * maxTextSize / maxEdges DoS cap. Only the THEME variables (resolved app-token colors) come from
 * MAIN. `encodedSource` arrives URI-encoded so MAIN can embed it injection-safely in the
 * executeJavaScript expression (encodeURIComponent output is pure ASCII — no quotes, backslashes,
 * or JS line terminators); we decode it back to the raw Mermaid text here.
 */
;(function () {
  var mermaid = window.mermaid
  window.__diagramWorkerReady = !!(mermaid && typeof mermaid.render === 'function')
  window.__renderDiagram = async function (encodedSource, id, themeVars) {
    if (!mermaid || typeof mermaid.render !== 'function') throw new Error('mermaid unavailable')
    var source = decodeURIComponent(encodedSource)
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: 'base',
      themeVariables: themeVars && typeof themeVars === 'object' ? themeVars : {},
      maxTextSize: 50000,
      maxEdges: 2000,
      fontFamily: 'Geist, ui-sans-serif, system-ui, -apple-system, sans-serif',
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      er: { useMaxWidth: false }
    })
    // parse() validates + throws a descriptive error BEFORE any DOM mutation.
    await mermaid.parse(source)
    var out = await mermaid.render(id, source)
    return out && out.svg ? out.svg : ''
  }
})()
