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
  var lastThemeKey = null
  window.__renderDiagram = async function (encodedSource, id, themeVars) {
    if (!mermaid || typeof mermaid.render !== 'function') throw new Error('mermaid unavailable')
    var source = decodeURIComponent(encodedSource)
    var vars = themeVars && typeof themeVars === 'object' ? themeVars : {}
    // Only (re)initialize when the theme actually changes — every other setting is constant, so a
    // per-render initialize() just re-resets Mermaid's internal state for nothing. themeVars changes
    // only on an app theme flip (rare); on the common source-edit path this now runs exactly once.
    var themeKey = JSON.stringify(vars)
    if (themeKey !== lastThemeKey) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        theme: 'base',
        themeVariables: vars,
        maxTextSize: 50000,
        maxEdges: 2000,
        fontFamily: 'Geist, ui-sans-serif, system-ui, -apple-system, sans-serif',
        flowchart: { htmlLabels: false, useMaxWidth: false },
        sequence: { useMaxWidth: false },
        er: { useMaxWidth: false }
      })
      lastThemeKey = themeKey
    }
    // parse() validates + throws a descriptive error BEFORE any DOM mutation.
    await mermaid.parse(source)
    var out = await mermaid.render(id, source)
    return out && out.svg ? out.svg : ''
  }
})()
