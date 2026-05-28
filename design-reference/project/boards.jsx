// boards.jsx — Board chrome + Terminal / Browser / Planning content + app preview.
// Pure presentational; the canvas engine (app.jsx) handles position/drag/resize.
// Exported to window: BoardFrame, TerminalBoard, BrowserBoard, PlanningBoard, AppPreview.
(function () {
  const { useState, useEffect, useRef } = React;
  const Icon = window.Icon, TypeGlyph = window.TypeGlyph;

  const TYPE_TAG = { terminal: "TERMINAL", browser: "BROWSER", planning: "PLANNING" };

  function IconBtn({ name, title, active, danger, onClick, size = 15 }) {
    const [h, setH] = useState(false);
    return React.createElement(
      "button",
      {
        title, onClick,
        onMouseEnter: () => setH(true), onMouseLeave: () => setH(false),
        onMouseDown: (e) => e.stopPropagation(),
        style: {
          width: 24, height: 24, display: "grid", placeItems: "center",
          borderRadius: 5, border: "1px solid transparent", cursor: "pointer",
          background: h ? "var(--surface-overlay)" : "transparent",
          color: active ? "var(--accent)" : danger && h ? "var(--err)" : h ? "var(--text-2)" : "var(--text-3)",
          transition: "color .1s, background .1s",
        },
      },
      React.createElement(Icon, { name, size })
    );
  }

  // ── Status pill (agent identity / connection) ──────────────────────────
  function StatusPill({ dot, label, mono = true }) {
    return React.createElement(
      "span",
      { style: {
          display: "inline-flex", alignItems: "center", gap: 6,
          fontFamily: mono ? "var(--mono)" : "var(--ui)", fontSize: 11,
          color: "var(--text-3)", whiteSpace: "nowrap",
      } },
      React.createElement("span", {
        className: dot === "var(--ok)" ? "ca-pulse" : "",
        style: { width: 7, height: 7, borderRadius: 999, background: dot, flex: "none" },
      }),
      label
    );
  }

  // ── Shared board chrome shell ───────────────────────────────────────────
  function BoardFrame(props) {
    const { type, title, selected, dimmed, lod, status, actions, children,
            contentBg = "var(--surface)", running, hovered, onTitleBar, onFull, onMore } = props;

    if (lod) {
      return React.createElement(
        "div",
        { style: {
            position: "absolute", inset: 0, borderRadius: "var(--r-board)",
            background: "var(--surface-raised)",
            border: `1px solid ${selected ? "var(--accent)" : "var(--border-subtle)"}`,
            boxShadow: selected ? "0 0 0 1.5px var(--accent), var(--shadow-board)" : "var(--shadow-board)",
            display: "flex", alignItems: "center", gap: 14, padding: "0 22px",
            opacity: dimmed ? 0.55 : 1, overflow: "hidden",
        } },
        React.createElement("div", { style: { color: "var(--text-2)", flex: "none", transform: "scale(1.6)", transformOrigin: "left center" } },
          React.createElement(TypeGlyph, { type, running })),
        React.createElement("div", { style: { minWidth: 0, flex: 1 } },
          React.createElement("div", { style: { fontSize: 9, letterSpacing: "0.08em", color: "var(--text-faint)", fontFamily: "var(--mono)" } }, TYPE_TAG[type]),
          React.createElement("div", { style: { fontSize: 15, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 } }, title)),
        status && React.createElement("span", {
          style: { width: 9, height: 9, borderRadius: 999, background: status.dot, flex: "none" },
          className: status.dot === "var(--ok)" ? "ca-pulse" : "",
        })
      );
    }

    return React.createElement(
      "div",
      { style: {
          position: "absolute", inset: 0, borderRadius: "var(--r-board)",
          background: contentBg, overflow: "hidden",
          border: `1px solid ${selected ? "var(--accent)" : hovered ? "var(--border)" : "var(--border-subtle)"}`,
          boxShadow: selected ? "0 0 0 1.5px var(--accent), var(--shadow-board)" : "var(--shadow-board)",
          opacity: dimmed ? 0.55 : 1,
          display: "flex", flexDirection: "column", transition: "opacity .15s, border-color .1s",
      } },
      // running progress sliver
      running && React.createElement("div", { className: "ca-progress", style: {
        position: "absolute", top: 0, left: 0, right: 0, height: 2, overflow: "hidden", zIndex: 3 } },
        React.createElement("div", { className: "ca-progress-bar" })),
      // title bar
      React.createElement(
        "div",
        { onMouseDown: onTitleBar, style: {
            height: "var(--titlebar-h)", flex: "none", display: "flex", alignItems: "center",
            gap: 8, padding: "0 8px 0 10px", cursor: "grab",
            background: selected ? "var(--accent-wash)" : "var(--surface-raised)",
            borderBottom: "1px solid var(--border-subtle)",
        } },
        React.createElement("span", { style: { color: selected ? "var(--text-2)" : "var(--text-3)", display: "inline-flex", flex: "none" } },
          React.createElement(TypeGlyph, { type, running })),
        React.createElement("span", { style: {
          fontSize: 9.5, letterSpacing: "0.07em", fontWeight: 600, color: "var(--text-faint)",
          fontFamily: "var(--mono)", flex: "none" } }, TYPE_TAG[type]),
        React.createElement("span", { style: {
          fontSize: 12, fontWeight: 500, color: selected ? "var(--text)" : "var(--text-2)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 } }, title),
        status && React.createElement(StatusPill, status),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 1, flex: "none" } },
          actions,
          onFull && React.createElement(IconBtn, { name: "maximize", title: "Full view", size: 14, onClick: onFull }),
          React.createElement(IconBtn, { name: "more", title: "More", onClick: (e) => onMore && onMore(e) }))
      ),
      // content
      React.createElement("div", { style: { flex: 1, minHeight: 0, position: "relative", background: contentBg } }, children)
    );
  }

  // ── Terminal board ───────────────────────────────────────────────────────
  const BRAILLE = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

  const DEFAULT_LOG = [
    { k: "user", t: "refactor the canvas camera into a hook and add pinch-zoom" },
    { k: "think", t: "Reading the canvas implementation and current camera handling." },
    { k: "tool", t: "Read  src/canvas/Stage.tsx" },
    { k: "tool", t: "Read  src/canvas/useCamera.ts" },
    { k: "say", t: "Extracting the pan/zoom math into useCamera() and wiring a" },
    { k: "say", t: "gesture handler for trackpad pinch." },
    { k: "edit", t: "src/canvas/useCamera.ts", add: 48, del: 12 },
    { k: "edit", t: "src/canvas/Stage.tsx", add: 9, del: 31 },
    { k: "tool", t: "Run   pnpm typecheck" },
    { k: "ok", t: "tsc — no errors" },
  ];

  function Line({ l }) {
    const base = { fontFamily: "var(--mono)", fontSize: 12.5, lineHeight: "19px", whiteSpace: "pre-wrap", wordBreak: "break-word" };
    if (l.k === "user")
      return React.createElement("div", { style: { ...base, color: "var(--text-2)", margin: "2px 0 8px" } },
        React.createElement("span", { style: { color: "var(--accent)" } }, "› "), l.t);
    if (l.k === "think")
      return React.createElement("div", { style: { ...base, color: "var(--text-faint)", fontStyle: "italic" } }, l.t);
    if (l.k === "tool")
      return React.createElement("div", { style: { ...base, color: "var(--text-3)" } },
        React.createElement("span", { style: { color: "var(--text-faint)" } }, "› "), l.t);
    if (l.k === "say")
      return React.createElement("div", { style: { ...base, color: "var(--text-2)" } }, l.t);
    if (l.k === "edit")
      return React.createElement("div", { style: { ...base, color: "var(--text-2)", display: "flex", gap: 10 } },
        React.createElement("span", { style: { color: "var(--text-faint)" } }, "✎"),
        React.createElement("span", null, l.t),
        React.createElement("span", { style: { color: "var(--ok)" } }, "+" + l.add),
        React.createElement("span", { style: { color: "var(--err)" } }, "−" + l.del));
    if (l.k === "ok")
      return React.createElement("div", { style: { ...base, color: "var(--ok)" } },
        React.createElement("span", { style: { opacity: .8 } }, "✓ "), l.t);
    return React.createElement("div", { style: base }, l.t);
  }

  function TerminalBoard({ title = "agent · main", live = false, status, log = DEFAULT_LOG, running = true, working = "Editing src/canvas/Stage.tsx…", selected, hovered, dimmed, onTitleBar, onFull, onMore }) {
    const [shown, setShown] = useState(live ? 1 : log.length);
    const [frame, setFrame] = useState(0);
    const scrollRef = useRef(null);

    useEffect(() => {
      if (!live) return;
      if (shown >= log.length) return;
      const id = setTimeout(() => setShown((s) => s + 1), 520 + Math.random() * 380);
      return () => clearTimeout(id);
    }, [live, shown, log.length]);

    useEffect(() => {
      if (!running) return;
      const id = setInterval(() => setFrame((f) => (f + 1) % BRAILLE.length), 90);
      return () => clearInterval(id);
    }, [running]);

    useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [shown]);

    const done = !live || shown >= log.length;
    return React.createElement(
      BoardFrame,
      {
        type: "terminal", title, running: running && (!live || !done),
        selected, hovered, dimmed, onTitleBar, onFull, onMore,
        contentBg: "var(--inset)",
        status: status || { dot: running ? "var(--ok)" : "var(--text-3)", label: (running ? "claude-code · 02:14" : "claude-code · idle") },
        actions: React.createElement(React.Fragment, null,
          React.createElement(IconBtn, { name: running ? "pause" : "play", title: running ? "Pause" : "Run" }),
          React.createElement(IconBtn, { name: "restart", title: "Restart" })),
      },
      React.createElement("div", { style: { position: "absolute", inset: 0, display: "flex", flexDirection: "column" } },
        React.createElement("div", { ref: scrollRef, style: { flex: 1, overflow: "hidden", padding: "12px 14px 4px", maskImage: "linear-gradient(to bottom, transparent 0, #000 14px)" } },
          log.slice(0, shown).map((l, i) => React.createElement(Line, { key: i, l })),
          running && done && React.createElement("div", { style: { fontFamily: "var(--mono)", fontSize: 12.5, lineHeight: "19px", color: "var(--text-2)", display: "flex", gap: 8, marginTop: 2 } },
            React.createElement("span", { style: { color: "var(--accent)", width: 10, display: "inline-block" } }, running ? BRAILLE[frame] : ""),
            working)
        ),
        // prompt
        React.createElement("div", { style: {
          flex: "none", borderTop: "1px solid var(--border-subtle)", padding: "8px 14px",
          fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--text-3)", display: "flex", alignItems: "center", gap: 7, background: "color-mix(in srgb, var(--inset) 70%, var(--surface))" } },
          React.createElement("span", { style: { color: "var(--accent)" } }, "›"),
          React.createElement("span", { style: { color: "var(--text-faint)" } }, "send a follow-up instruction"),
          React.createElement("span", { className: "ca-blink", style: { width: 7, height: 14, background: "var(--text-3)", borderRadius: 1, marginLeft: -2 } }))
      )
    );
  }

  // ── Browser board ─────────────────────────────────────────────────────────
  const VIEWPORTS = {
    mobile:  { w: 390, h: 844, icon: "mobile",  label: "Mobile" },
    tablet:  { w: 834, h: 1112, icon: "tablet",  label: "Tablet" },
    desktop: { w: 1280, h: 800, icon: "desktop", label: "Desktop" },
  };

  function VpToggle({ vp, active, onClick }) {
    const v = VIEWPORTS[vp];
    return React.createElement("button", {
      title: v.label, onClick, onMouseDown: (e) => e.stopPropagation(),
      style: {
        height: 22, padding: "0 8px", display: "inline-flex", alignItems: "center", gap: 5,
        border: "none", borderRadius: 4, cursor: "pointer",
        background: active ? "var(--accent-wash)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-3)",
        fontSize: 11, fontWeight: 500, fontFamily: "var(--ui)",
      } },
      React.createElement(Icon, { name: v.icon, size: 13 }),
      active && React.createElement("span", null, v.label)
    );
  }

  function BrowserBoard({ title = "app preview", viewport = "desktop", onViewport, selected, hovered, dimmed, onTitleBar, onFull, onMore }) {
    const [vp, setVp] = useState(viewport);
    useEffect(() => setVp(viewport), [viewport]);
    const set = (v) => { setVp(v); onViewport && onViewport(v); };
    const v = VIEWPORTS[vp];
    return React.createElement(
      BoardFrame,
      {
        type: "browser", title, selected, hovered, dimmed, onTitleBar, onFull, onMore,
        status: { dot: "var(--ok)", label: "connected" },
        actions: React.createElement("div", { style: {
            display: "flex", alignItems: "center", gap: 1, padding: 2, marginRight: 2,
            background: "var(--inset)", borderRadius: 6, border: "1px solid var(--border-subtle)" } },
          ["mobile","tablet","desktop"].map((k) =>
            React.createElement(VpToggle, { key: k, vp: k, active: vp === k, onClick: () => set(k) }))),
      },
      // url bar
      React.createElement("div", { style: {
          height: 30, flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "0 10px",
          borderBottom: "1px solid var(--border-subtle)", background: "var(--surface-raised)", position: "absolute", top: 0, left: 0, right: 0, zIndex: 2 } },
        React.createElement("div", { style: { display: "flex", gap: 2, color: "var(--text-faint)" } },
          React.createElement(Icon, { name: "back", size: 14 }),
          React.createElement(Icon, { name: "forward", size: 14 }),
          React.createElement(Icon, { name: "refresh", size: 13 })),
        React.createElement("div", { style: {
            flex: 1, height: 20, borderRadius: 5, background: "var(--inset)", border: "1px solid var(--border-subtle)",
            display: "flex", alignItems: "center", gap: 7, padding: "0 9px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" } },
          React.createElement("span", { style: { width: 6, height: 6, borderRadius: 999, background: "var(--ok)" } }),
          "localhost:5173",
          React.createElement("span", { style: { color: "var(--text-faint)" } }, "/dashboard")),
        React.createElement("span", { style: { fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)", whiteSpace: "nowrap" } }, v.w + " × " + v.h)),
      // device stage
      React.createElement(DeviceStage, { vp })
    );
  }

  function DeviceStage({ vp }) {
    const ref = useRef(null);
    const [scale, setScale] = useState(1);
    const v = VIEWPORTS[vp];
    useEffect(() => {
      const el = ref.current; if (!el) return;
      const fit = () => {
        const pad = 22, top = 30;
        const aw = el.clientWidth - pad * 2, ah = el.clientHeight - top - pad * 2;
        setScale(Math.min(aw / v.w, ah / v.h, 1.1));
      };
      fit();
      const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect();
    }, [vp]);
    const mobile = vp === "mobile";
    return React.createElement("div", { ref, style: {
        position: "absolute", inset: 0, paddingTop: 30, display: "grid", placeItems: "center", overflow: "hidden",
        background: "repeating-linear-gradient(45deg, var(--inset), var(--inset) 9px, color-mix(in srgb, var(--inset) 60%, var(--void)) 9px, color-mix(in srgb, var(--inset) 60%, var(--void)) 18px)" } },
      React.createElement("div", { style: {
          width: v.w * scale, height: v.h * scale, flex: "none",
          borderRadius: mobile ? 22 : 8, overflow: "hidden",
          border: "1px solid var(--border-strong)",
          boxShadow: "0 1px 0 rgba(255,255,255,.05) inset, 0 18px 50px -16px rgba(0,0,0,.78)" } },
        React.createElement("div", { style: {
            width: v.w, height: v.h, transform: `scale(${scale})`, transformOrigin: "top left", background: "#fbfbfa" } },
          React.createElement(AppPreview, { vp })))
    );
  }

  // ── The user's running app (placeholder; light theme to read as "their app") ──
  function AppPreview({ vp }) {
    const mobile = vp === "mobile";
    const ink = "#1b1c1e", soft = "#6b7076", line = "#ececec", chip = "#f3f3f1";
    const card = (h, label) => React.createElement("div", { style: { background: "#fff", border: "1px solid " + line, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 8 } },
      React.createElement("div", { style: { width: 30, height: 30, borderRadius: 7, background: chip } }),
      React.createElement("div", { style: { height: 8, width: "62%", background: "#e9e9e7", borderRadius: 3 } }),
      React.createElement("div", { style: { height: 7, width: "92%", background: "#f0f0ee", borderRadius: 3 } }),
      React.createElement("div", { style: { height: 7, width: "78%", background: "#f0f0ee", borderRadius: 3 } }),
      label && React.createElement("div", { style: { marginTop: 4, fontSize: 10, fontWeight: 600, color: "#3b6fe0" } }, label));
    return React.createElement("div", { style: { width: "100%", height: "100%", background: "#fbfbfa", color: ink, fontFamily: "var(--ui)", display: "flex", flexDirection: "column", overflow: "hidden" } },
      mobile && React.createElement("div", { style: { height: 30, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px", fontSize: 11, fontWeight: 600, color: ink } },
        React.createElement("span", null, "9:41"),
        React.createElement("span", { style: { width: 44, height: 6, background: "#dcdcda", borderRadius: 99 } })),
      // top nav
      React.createElement("div", { style: { height: mobile ? 48 : 56, flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", padding: mobile ? "0 18px" : "0 28px", borderBottom: "1px solid " + line } },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 9 } },
          React.createElement("div", { style: { width: 22, height: 22, borderRadius: 6, background: ink } }),
          React.createElement("span", { style: { fontWeight: 700, fontSize: 14, letterSpacing: "-0.01em" } }, "Northwind")),
        mobile
          ? React.createElement("div", { style: { width: 18, height: 12, display: "flex", flexDirection: "column", justifyContent: "space-between" } },
              [0,1,2].map((i) => React.createElement("div", { key: i, style: { height: 2, background: soft, borderRadius: 2 } })))
          : React.createElement("div", { style: { display: "flex", gap: 22, fontSize: 13, color: soft, alignItems: "center" } },
              ["Overview","Reports","Team"].map((t,i) => React.createElement("span", { key: t, style: { color: i === 0 ? ink : soft, fontWeight: i === 0 ? 600 : 400 } }, t)),
              React.createElement("div", { style: { background: ink, color: "#fff", fontSize: 12, fontWeight: 600, padding: "7px 13px", borderRadius: 7 } }, "New report"))),
      // body
      React.createElement("div", { style: { flex: 1, overflow: "hidden", padding: mobile ? "18px" : "26px 28px", display: "flex", flexDirection: "column", gap: mobile ? 14 : 18 } },
        React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 7 } },
          React.createElement("div", { style: { fontSize: 11, fontWeight: 600, color: "#3b6fe0", letterSpacing: "0.02em" } }, "DASHBOARD"),
          React.createElement("div", { style: { fontSize: mobile ? 22 : 28, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 } }, "Good morning, Avery"),
          React.createElement("div", { style: { fontSize: 13, color: soft, maxWidth: 440 } }, "Here's what moved across your workspace since yesterday.")),
        React.createElement("div", { style: { display: "flex", gap: 10 } },
          ["Revenue","Active","Churn"].map((t,i) => React.createElement("div", { key: t, style: { flex: 1, background: "#fff", border: "1px solid " + line, borderRadius: 10, padding: mobile ? "10px 12px" : "13px 15px", display: "flex", flexDirection: "column", gap: 6 } },
            React.createElement("div", { style: { fontSize: 11, color: soft } }, t),
            React.createElement("div", { style: { fontSize: mobile ? 17 : 20, fontWeight: 700, letterSpacing: "-0.01em" } }, ["$48.2k","1,284","2.1%"][i]),
            React.createElement("div", { style: { fontSize: 10.5, fontWeight: 600, color: i === 2 ? "#d1485a" : "#1f9d57" } }, ["+12%","+4%","−0.3%"][i])))),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 12, overflow: "hidden" } },
          card(0, "View pipeline"), card(0, null), !mobile && card(0, null), !mobile && card(0, "Open"))
      )
    );
  }

  // ── Planning board ─────────────────────────────────────────────────────────
  function Note({ x, y, w, tint, children, rot = 0 }) {
    const tints = {
      yellow: "#2a2818", blue: "#16202b", green: "#16241d", plain: "var(--surface-raised)",
    };
    const edge = { yellow: "#3d3a22", blue: "#22354a", green: "#21392c", plain: "var(--border)" };
    return React.createElement("div", { style: {
        position: "absolute", left: x, top: y, width: w, transform: `rotate(${rot}deg)`,
        background: tints[tint] || tints.plain, border: "1px solid " + (edge[tint] || edge.plain),
        borderRadius: 6, padding: "9px 11px", boxShadow: "0 6px 18px -8px rgba(0,0,0,.6)",
        fontSize: 12, lineHeight: "17px", color: "var(--text)", fontFamily: "var(--ui)" } }, children);
  }

  function PlanTool({ name, active }) {
    return React.createElement("button", { onMouseDown: (e) => e.stopPropagation(), style: {
        width: 26, height: 26, display: "grid", placeItems: "center", border: "none", cursor: "pointer",
        borderRadius: 5, background: active ? "var(--accent-wash)" : "transparent", color: active ? "var(--accent)" : "var(--text-3)" } },
      React.createElement(Icon, { name, size: 15 }));
  }

  function Checkbox({ done }) {
    return React.createElement("span", { style: {
        width: 16, height: 16, flex: "none", borderRadius: 5, display: "grid", placeItems: "center",
        border: "1.5px solid " + (done ? "var(--accent)" : "var(--border-strong)"),
        background: done ? "var(--accent)" : "transparent", color: "#0a0a0b", transition: "background .12s, border-color .12s" } },
      done && React.createElement(Icon, { name: "check", size: 11, sw: 2.4 }));
  }

  function ChecklistCard({ x, y, w, title, items: init }) {
    const [items, setItems] = useState(init);
    const done = items.filter((i) => i.done).length;
    const pct = Math.round((done / items.length) * 100);
    const toggle = (i) => setItems((s) => s.map((it, idx) => idx === i ? { ...it, done: !it.done } : it));
    return React.createElement("div", { style: {
        position: "absolute", left: x, top: y, width: w,
        background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8,
        padding: "11px 12px 12px", boxShadow: "0 6px 18px -8px rgba(0,0,0,.55)", display: "flex", flexDirection: "column", gap: 9 } },
      React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
        React.createElement("span", { style: { fontSize: 12.5, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.01em" } }, title),
        React.createElement("span", { style: { fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" } }, done + "/" + items.length)),
      React.createElement("div", { style: { height: 3, borderRadius: 99, background: "var(--inset)", overflow: "hidden" } },
        React.createElement("div", { style: { width: pct + "%", height: "100%", background: "var(--accent)", transition: "width .18s" } })),
      React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 1 } },
        items.map((it, i) => React.createElement("button", { key: i, onMouseDown: (e) => e.stopPropagation(), onClick: () => toggle(i), style: {
            display: "flex", alignItems: "center", gap: 9, border: "none", background: "none", cursor: "pointer", padding: 0, textAlign: "left", width: "100%" } },
          React.createElement(Checkbox, { done: it.done }),
          React.createElement("span", { style: { fontSize: 12, lineHeight: "16px", color: it.done ? "var(--text-faint)" : "var(--text-2)", textDecoration: it.done ? "line-through" : "none", textDecorationColor: "var(--text-faint)" } }, it.t))))
    );
  }

  const PLAN_CHECKLIST = [
    { t: "Camera hook — pan + zoom", done: true },
    { t: "Fit-to-content + overview", done: true },
    { t: "LOD card render < 40%", done: false },
    { t: "Terminal PTY bridge", done: false },
    { t: "Browser viewports + frame", done: false },
  ];

  function PlanningBoard({ title = "plan · canvas rebuild", selected, hovered, dimmed, onTitleBar, onFull, onMore }) {
    return React.createElement(
      BoardFrame,
      { type: "planning", title, selected, hovered, dimmed, onTitleBar, onFull, onMore,
        contentBg: "var(--surface)",
        actions: selected && React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 1, padding: 2, background: "var(--inset)", borderRadius: 6, border: "1px solid var(--border-subtle)", marginRight: 2 } },
          React.createElement(PlanTool, { name: "select", active: true }),
          React.createElement(PlanTool, { name: "note" }),
          React.createElement(PlanTool, { name: "check" }),
          React.createElement(PlanTool, { name: "arrow" }),
          React.createElement(PlanTool, { name: "pen" })),
      },
      React.createElement("div", { style: {
          position: "absolute", inset: 0, overflow: "hidden",
          backgroundImage: "radial-gradient(var(--grid-dot) 1px, transparent 1px)",
          backgroundSize: "13px 13px", backgroundPosition: "6px 6px" } },
        React.createElement("svg", { style: { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" } },
          React.createElement("defs", null,
            React.createElement("marker", { id: "ah", markerWidth: 8, markerHeight: 8, refX: 6, refY: 4, orient: "auto" },
              React.createElement("path", { d: "M0 0 L7 4 L0 8 z", fill: "var(--border-strong)" }))),
          React.createElement("path", { d: "M270 150 C 300 150, 300 116, 322 110", stroke: "var(--border-strong)", strokeWidth: 1.5, fill: "none", markerEnd: "url(#ah)" })),
        React.createElement("div", { style: { position: "absolute", left: 22, top: 18, fontSize: 14, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.01em" } }, "Canvas rebuild"),
        React.createElement("div", { style: { position: "absolute", left: 22, top: 40, fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)" } }, "milestone 2 · this week"),
        React.createElement(ChecklistCard, { x: 22, y: 70, w: 240, title: "Milestone 2", items: PLAN_CHECKLIST }),
        React.createElement(Note, { x: 322, y: 86, w: 158, tint: "blue", rot: 1 },
          React.createElement("b", { style: { fontWeight: 600 } }, "Order of work"), React.createElement("br"), "terminal + browser boards first → planning last"),
        React.createElement(Note, { x: 332, y: 188, w: 148, tint: "yellow", rot: -1.2 },
          "pinch-zoom needs trackpad gesture handler"),
        React.createElement("div", { style: { position: "absolute", left: 286, top: 64, fontSize: 12, color: "var(--text-2)", fontFamily: "var(--mono)", transform: "rotate(-3deg)" } }, "next ↑")
      )
    );
  }

  Object.assign(window, { BoardFrame, TerminalBoard, BrowserBoard, PlanningBoard, AppPreview, IconBtn, VIEWPORTS });
})();
