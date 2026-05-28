// frames.jsx — static state frames for the Frames Overview, reusing the live
// board components on the product's own dark canvas.
(function () {
  const { TerminalBoard, BrowserBoard, PlanningBoard, BoardFrame, Icon, TypeGlyph } = window;
  const { DesignCanvas, DCSection, DCArtboard } = window;

  // A window into the product: void + dot grid, boards positioned absolutely.
  function Frame({ children, grid = true }) {
    return React.createElement("div", { style: {
      position: "absolute", inset: 0, background: "var(--void)", overflow: "hidden",
      backgroundImage: grid ? "radial-gradient(circle, var(--grid-dot) 1px, transparent 1.4px)" : "none",
      backgroundSize: "22px 22px" } }, children);
  }
  // Sized, positioned board wrapper.
  function Box({ x, y, w, h, children }) {
    return React.createElement("div", { style: { position: "absolute", left: x, top: y, width: w, height: h } }, children);
  }
  function HandleDemo() {
    const corners = [["nw",0,0],["ne",1,0],["se",1,1],["sw",0,1]];
    return corners.map(([d,fx,fy]) => React.createElement("div", { key: d, style: {
      position: "absolute", left: `${fx*100}%`, top: `${fy*100}%`, width: 9, height: 9, transform: "translate(-50%,-50%)",
      background: "var(--surface-overlay)", border: "1px solid var(--border-strong)", borderRadius: 2,
      boxShadow: d === "se" ? "0 0 0 1px var(--accent)" : "none", zIndex: 5 } }));
  }

  const TEST_LOG = [
    { k: "user", t: "add unit tests for useCamera()" },
    { k: "tool", t: "Read  src/canvas/useCamera.ts" },
    { k: "edit", t: "useCamera.test.ts", add: 64, del: 0 },
    { k: "tool", t: "Run   pnpm test useCamera" },
    { k: "ok", t: "7 passed (212ms)" },
  ];

  function App() {
    return React.createElement(DesignCanvas, null,
      // ── Overview ──
      React.createElement(DCSection, { id: "overview", title: "Zoomed-out overview", subtitle: "Boards collapse to LOD cards below 40% zoom — glyph, title, status only" },
        React.createElement(DCArtboard, { id: "ov", label: "Project canvas · ~32%", width: 900, height: 520 },
          React.createElement(Frame, null,
            React.createElement(Box, { x: 60, y: 54, w: 250, h: 92 }, React.createElement(BoardFrame, { type: "planning", title: "plan · canvas rebuild", lod: true })),
            React.createElement(Box, { x: 340, y: 54, w: 230, h: 92 }, React.createElement(BoardFrame, { type: "terminal", title: "agent · tests", lod: true, status: { dot: "var(--text-3)" } })),
            React.createElement(Box, { x: 60, y: 188, w: 380, h: 120 }, React.createElement(BoardFrame, { type: "browser", title: "app preview", lod: true, status: { dot: "var(--ok)" } })),
            React.createElement(Box, { x: 480, y: 188, w: 250, h: 120 }, React.createElement(BoardFrame, { type: "terminal", title: "agent · main", lod: true, running: true, status: { dot: "var(--ok)" } })),
            React.createElement(Box, { x: 150, y: 350, w: 250, h: 92 }, React.createElement(BoardFrame, { type: "terminal", title: "agent · migrations", lod: true, status: { dot: "var(--warn)" } })),
            // mini camera pill
            React.createElement("div", { style: { position: "absolute", top: 16, right: 16, display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8, background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", boxShadow: "var(--shadow-pop)", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-2)" } }, "32%"))
        )),

      // ── Board states / chrome anatomy ──
      React.createElement(DCSection, { id: "states", title: "Board states", subtitle: "Identical chrome geometry across all types — resting, hover, selected, LOD" },
        ["resting","hover","selected","lod"].map((st) =>
          React.createElement(DCArtboard, { key: st, id: "st-"+st, label: st === "lod" ? "LOD card" : st.charAt(0).toUpperCase()+st.slice(1), width: 300, height: 210 },
            React.createElement(Frame, null,
              React.createElement(Box, { x: 24, y: st === "lod" ? 70 : 24, w: 252, h: st === "lod" ? 70 : 162 },
                st === "lod"
                  ? React.createElement(BoardFrame, { type: "terminal", title: "agent · main", lod: true, running: true, status: { dot: "var(--ok)" } })
                  : React.createElement(React.Fragment, null,
                      React.createElement(TerminalBoard, { title: "agent · main", live: false, running: true, working: "Editing Stage.tsx…", selected: st === "selected", hovered: st === "hover", log: TEST_LOG }),
                      st === "hover" && React.createElement(HandleDemo),
                      st === "selected" && React.createElement(HandleDemo)))
            ))
        )),

      // ── Terminal ──
      React.createElement(DCSection, { id: "terminal", title: "Terminal board · mid-run", subtitle: "Live coding agent — streamed output, tool calls, file edits, run progress, follow-up prompt" },
        React.createElement(DCArtboard, { id: "term", label: "claude-code · running", width: 480, height: 420 },
          React.createElement(Frame, null,
            React.createElement(Box, { x: 26, y: 26, w: 428, h: 368 }, React.createElement(TerminalBoard, { title: "agent · main", live: false, running: true, working: "Editing src/canvas/Stage.tsx…", selected: true }))))),

      // ── Browser ──
      React.createElement(DCSection, { id: "browser", title: "Browser board · responsive preview", subtitle: "One board, three viewport toggles → device frame resizes to mobile / tablet / desktop" },
        React.createElement(DCArtboard, { id: "br-desktop", label: "Desktop · 1280×800", width: 720, height: 500 },
          React.createElement(Frame, null, React.createElement(Box, { x: 24, y: 24, w: 672, h: 452 }, React.createElement(BrowserBoard, { title: "app preview", viewport: "desktop", selected: true })))),
        React.createElement(DCArtboard, { id: "br-tablet", label: "Tablet · 834×1112", width: 540, height: 560 },
          React.createElement(Frame, null, React.createElement(Box, { x: 24, y: 24, w: 492, h: 512 }, React.createElement(BrowserBoard, { title: "app preview", viewport: "tablet" })))),
        React.createElement(DCArtboard, { id: "br-mobile", label: "Mobile · 390×844", width: 420, height: 560 },
          React.createElement(Frame, null, React.createElement(Box, { x: 24, y: 24, w: 372, h: 512 }, React.createElement(BrowserBoard, { title: "app preview", viewport: "mobile" }))))),

      // ── Planning ──
      React.createElement(DCSection, { id: "planning", title: "Planning board · whiteboard layer", subtitle: "Notes, text, arrows and sketches — tool cluster appears when the board is selected" },
        React.createElement(DCArtboard, { id: "plan", label: "selected · tools visible", width: 620, height: 420 },
          React.createElement(Frame, null, React.createElement(Box, { x: 26, y: 26, w: 568, h: 368 }, React.createElement(PlanningBoard, { title: "plan · canvas rebuild", selected: true }))))),

      // ── Full view ──
      React.createElement(DCSection, { id: "full", title: "Full view & duplicate", subtitle: "Maximize any board edge-to-edge (Esc to exit) · duplicate a Browser board to compare two viewports" },
        React.createElement(DCArtboard, { id: "full1", label: "Terminal · full view", width: 760, height: 470 },
          React.createElement("div", { style: { position: "absolute", inset: 0, background: "#070708" } },
            React.createElement("div", { style: { position: "absolute", top: 13, left: 20, fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.05em", color: "var(--text-3)" } }, "FULL VIEW"),
            React.createElement("div", { style: { position: "absolute", top: 9, right: 20, height: 28, padding: "0 10px 0 9px", display: "inline-flex", alignItems: "center", gap: 7, borderRadius: 8, background: "var(--surface-raised)", border: "1px solid var(--border)", color: "var(--text-2)", fontFamily: "var(--mono)", fontSize: 11 } },
              React.createElement(Icon, { name: "x", size: 14 }), "Esc"),
            React.createElement(Box, { x: 26, y: 44, w: 708, h: 410 }, React.createElement(TerminalBoard, { title: "agent · main", live: false, running: true, working: "Editing src/canvas/Stage.tsx…", selected: true }))))),

      // ── Empty ──
      React.createElement(DCSection, { id: "empty", title: "Empty project", subtitle: "First board prompt — chrome stays, the canvas invites a board" },
        React.createElement(DCArtboard, { id: "empty1", label: "new project", width: 760, height: 460 },
          React.createElement(Frame, null, React.createElement(EmptyMock))))
    );
  }

  function EmptyMock() {
    const btn = (type, label) => React.createElement("div", { style: {
      display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 14px", borderRadius: 8,
      border: "1px dashed var(--border)", color: "var(--text-2)", fontSize: 13, fontWeight: 500 } },
      React.createElement("span", { style: { color: "var(--text-3)", display: "inline-flex" } }, React.createElement(TypeGlyph, { type })),
      React.createElement("span", { style: { color: "var(--text-faint)", fontFamily: "var(--mono)" } }, "+"), label);
    return React.createElement("div", { style: { position: "absolute", inset: 0, display: "grid", placeItems: "center" } },
      React.createElement("div", { style: { textAlign: "center", marginTop: -10 } },
        React.createElement("div", { style: { color: "var(--text-faint)", display: "flex", justifyContent: "center", marginBottom: 18, opacity: .6 } }, React.createElement(Icon, { name: "diamond", size: 36, sw: 1.2 })),
        React.createElement("div", { style: { fontSize: 17, fontWeight: 600, color: "var(--text)" } }, "Empty canvas"),
        React.createElement("div", { style: { fontSize: 13, color: "var(--text-3)", marginTop: 7, maxWidth: 330, lineHeight: 1.5, marginInline: "auto" } }, "Drop a board to start — spin up a coding agent, preview your running app, or sketch a plan."),
        React.createElement("div", { style: { display: "flex", gap: 10, justifyContent: "center", marginTop: 22 } }, btn("terminal","Terminal"), btn("browser","Browser"), btn("planning","Planning"))),
      // mini dock
      React.createElement("div", { style: { position: "absolute", bottom: 18, left: "50%", transform: "translateX(-50%)", display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 9, background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", boxShadow: "var(--shadow-pop)", color: "var(--text-3)", fontSize: 12.5 } },
        React.createElement(Icon, { name: "select", size: 15, style: { color: "var(--accent)" } }),
        "Terminal", "·", "Browser", "·", "Planning"));
  }

  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
})();
