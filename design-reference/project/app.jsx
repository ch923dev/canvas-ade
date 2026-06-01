// app.jsx — Canvas engine (pan/zoom/LOD), boards layer, app chrome, tweaks.
(function () {
  const { useState, useEffect, useRef, useCallback } = React;
  const { TerminalBoard, BrowserBoard, PlanningBoard, BoardFrame, Icon } = window;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const Z_MIN = 0.1, Z_MAX = 2.5, LOD_Z = 0.4;

  // ── Scene data ─────────────────────────────────────────────────────────
  let _id = 0; const uid = () => "b" + ++_id;
  const PROJECTS = {
    "expanse": {
      label: "expanse", boards: [
        { id: uid(), type: "planning", x: 30,  y: -404, w: 516, h: 366, title: "plan · canvas rebuild" },
        { id: uid(), type: "terminal", x: 596, y: -404, w: 410, h: 320, title: "agent · tests", running: false, live: false,
          log: [ { k:"user", t:"add unit tests for useCamera()" }, { k:"tool", t:"Read  src/canvas/useCamera.ts" }, { k:"edit", t:"useCamera.test.ts", add:64, del:0 }, { k:"tool", t:"Run   pnpm test useCamera" }, { k:"ok", t:"7 passed (212ms)" } ], working:"" },
        { id: uid(), type: "browser",  x: 40,  y: 0,    w: 760, h: 540, title: "app preview", viewport: "desktop" },
        { id: uid(), type: "terminal", x: 850, y: 0,    w: 430, h: 360, title: "agent · main", running: true, live: true },
      ],
    },
    "untitled": { label: "untitled", boards: [] },
  };

  // ── Camera hook ──────────────────────────────────────────────────────────
  function useCamera() {
    const [cam, setCam] = useState({ x: 120, y: 470, z: 0.62 });
    const animRef = useRef(null);
    const animate = useCallback((to, ms = 240) => {
      cancelAnimationFrame(animRef.current);
      const t0 = performance.now();
      setCam((from) => {
        const step = (now) => {
          const p = clamp((now - t0) / ms, 0, 1);
          const e = 1 - Math.pow(1 - p, 3);
          setCam({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e });
          if (p < 1) animRef.current = requestAnimationFrame(step);
        };
        animRef.current = requestAnimationFrame(step);
        return from;
      });
    }, []);
    return [cam, setCam, animate];
  }

  function fitBox(box, vw, vh, pad = 90) {
    if (!box) return { x: vw / 2, y: vh / 2, z: 1 };
    const z = clamp(Math.min((vw - pad * 2) / box.w, (vh - pad * 2) / box.h), Z_MIN, Z_MAX);
    return { x: vw / 2 - (box.x + box.w / 2) * z, y: vh / 2 - (box.y + box.h / 2) * z, z };
  }
  function boardsBox(bs) {
    if (!bs.length) return null;
    const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
    const x1 = Math.max(...bs.map(b => b.x + b.w)), y1 = Math.max(...bs.map(b => b.y + b.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ── Resize handles ─────────────────────────────────────────────────────
  const HANDLES = [["nw",0,0],["ne",1,0],["se",1,1],["sw",0,1],["n",.5,0],["e",1,.5],["s",.5,1],["w",0,.5]];
  function ResizeHandles({ onStart }) {
    return HANDLES.map(([dir, fx, fy]) => {
      const corner = dir.length === 2;
      const cur = { nw:"nwse", ne:"nesw", se:"nwse", sw:"nesw", n:"ns", s:"ns", e:"ew", w:"ew" }[dir] + "-resize";
      return React.createElement("div", {
        key: dir, onMouseDown: (e) => onStart(e, dir),
        style: {
          position: "absolute", left: `${fx * 100}%`, top: `${fy * 100}%`,
          width: corner ? 10 : 16, height: corner ? 10 : 16, transform: "translate(-50%,-50%)",
          cursor: cur, zIndex: 5,
          ...(corner ? { background: "var(--surface-overlay)", border: "1px solid var(--border-strong)", borderRadius: 2,
                         boxShadow: dir === "se" ? "0 0 0 1px var(--accent)" : "none" } : {}),
        },
      });
    });
  }

  // ── App ───────────────────────────────────────────────────────────────
  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "accent": "#4f8cff", "grid": "dots", "density": "compact", "corners": "soft", "dimOnFocus": true
  }/*EDITMODE-END*/;

  function App() {
    const [t, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
    const [projId, setProjId] = useState("expanse");
    const [boards, setBoards] = useState(PROJECTS["expanse"].boards);
    const [sel, setSel] = useState(null);
    const [focusId, setFocusId] = useState(null);
    const [hover, setHover] = useState(null);
    const [menu, setMenu] = useState(false);
    const [fullId, setFullId] = useState(null);
    const [bmenu, setBmenu] = useState(null); // { id, x, y }
    const [cam, setCam, animate] = useCamera();
    const wrapRef = useRef(null);
    const vp = useRef({ w: window.innerWidth, h: window.innerHeight });

    // frame everything on first paint — readable zoom floor so boards never
    // open as LOD cards in a small window
    useEffect(() => {
      const r = wrapRef.current.getBoundingClientRect();
      const box = boardsBox(PROJECTS["expanse"].boards);
      const z = clamp(fitBox(box, r.width, r.height, 130).z, 0.5, 0.82);
      setCam({ x: r.width / 2 - (box.x + box.w / 2) * z, y: r.height / 2 - (box.y + box.h / 2) * z, z });
    }, []);

    // apply tweaks to :root
    useEffect(() => {
      const r = document.documentElement.style;
      r.setProperty("--accent", t.accent);
      r.setProperty("--accent-wash", "color-mix(in srgb, " + t.accent + " 14%, transparent)");
      r.setProperty("--titlebar-h", t.density === "roomy" ? "40px" : "34px");
      r.setProperty("--r-board", t.corners === "sharp" ? "3px" : "8px");
    }, [t.accent, t.density, t.corners]);

    const switchProj = (id) => {
      setProjId(id); setMenu(false); setSel(null); setFocusId(null);
      const bs = PROJECTS[id].boards; setBoards(bs);
      const r = wrapRef.current.getBoundingClientRect();
      animate(bs.length ? fitBox(boardsBox(bs), r.width, r.height) : { x: r.width / 2, y: r.height / 2, z: 1 });
    };

    // wheel: pan / ctrl-zoom
    useEffect(() => {
      const el = wrapRef.current;
      const onWheel = (e) => {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) {
          setCam((c) => {
            const nz = clamp(c.z * Math.exp(-e.deltaY * 0.0022), Z_MIN, Z_MAX);
            const cx = e.clientX - r.left, cy = e.clientY - r.top;
            const wx = (cx - c.x) / c.z, wy = (cy - c.y) / c.z;
            return { x: cx - wx * nz, y: cy - wy * nz, z: nz };
          });
        } else {
          setCam((c) => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }));
        }
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      const onResize = () => { vp.current = { w: window.innerWidth, h: window.innerHeight }; };
      window.addEventListener("resize", onResize);
      return () => { el.removeEventListener("wheel", onWheel); window.removeEventListener("resize", onResize); };
    }, []);

    // keyboard
    useEffect(() => {
      const onKey = (e) => {
        if (e.key === "Escape") { setSel(null); setFocusId(null); setFullId(null); setBmenu(null); }
        if ((e.key === "Backspace" || e.key === "Delete") && sel && !fullId) { setBoards((b) => b.filter((x) => x.id !== sel)); setSel(null); }
        if (e.key === "1") zoomToFit();
        if (e.key === "0") setCam((c) => ({ ...c, z: 1 }));
      };
      window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
    }, [sel, boards, fullId]);

    // pan on empty canvas
    const panRef = useRef(null);
    const onBgDown = (e) => {
      if (e.button !== 0) return;
      setSel(null); setFocusId(null);
      const start = { mx: e.clientX, my: e.clientY };
      setCam((c) => { panRef.current = { ...start, cx: c.x, cy: c.y }; return c; });
      const move = (ev) => { const p = panRef.current; if (!p) return; setCam((c) => ({ ...c, x: p.cx + (ev.clientX - p.mx), y: p.cy + (ev.clientY - p.my) })); document.body.style.cursor = "grabbing"; };
      const up = () => { panRef.current = null; document.body.style.cursor = ""; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    };

    // drag board by titlebar
    const dragBoard = (e, id) => {
      e.stopPropagation(); if (e.button !== 0) return;
      setSel(id);
      const b0 = boards.find((b) => b.id === id);
      const start = { mx: e.clientX, my: e.clientY, x: b0.x, y: b0.y };
      const move = (ev) => setBoards((bs) => bs.map((b) => b.id === id ? { ...b, x: start.x + (ev.clientX - start.mx) / cam.z, y: start.y + (ev.clientY - start.my) / cam.z } : b));
      const up = () => { document.body.style.cursor = ""; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
      document.body.style.cursor = "grabbing";
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    };

    // resize board
    const resizeBoard = (e, id, dir) => {
      e.stopPropagation(); if (e.button !== 0) return;
      setSel(id);
      const b0 = boards.find((b) => b.id === id);
      const start = { mx: e.clientX, my: e.clientY, ...b0 };
      const move = (ev) => {
        const dx = (ev.clientX - start.mx) / cam.z, dy = (ev.clientY - start.my) / cam.z;
        setBoards((bs) => bs.map((b) => {
          if (b.id !== id) return b;
          let { x, y, w, h } = start;
          if (dir.includes("e")) w = start.w + dx;
          if (dir.includes("s")) h = start.h + dy;
          if (dir.includes("w")) { w = start.w - dx; x = start.x + dx; }
          if (dir.includes("n")) { h = start.h - dy; y = start.y + dy; }
          if (w < 240) { if (dir.includes("w")) x = start.x + start.w - 240; w = 240; }
          if (h < 160) { if (dir.includes("n")) y = start.y + start.h - 160; h = 160; }
          return { ...b, x, y, w, h };
        }));
      };
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    };

    const zoomToFit = () => { const r = wrapRef.current.getBoundingClientRect(); animate(fitBox(boardsBox(boards), r.width, r.height)); };
    const overview = () => { const r = wrapRef.current.getBoundingClientRect(); animate(fitBox(boardsBox(boards), r.width, r.height, 150), 300); };
    const focusBoard = (b) => { const r = wrapRef.current.getBoundingClientRect(); setSel(b.id); setFocusId(b.id); animate(fitBox(b, r.width, r.height, 70)); };
    const zoomBy = (f) => setCam((c) => { const r = wrapRef.current.getBoundingClientRect(); const nz = clamp(c.z * f, Z_MIN, Z_MAX); const cx = r.width/2, cy = r.height/2; const wx=(cx-c.x)/c.z, wy=(cy-c.y)/c.z; return { x: cx-wx*nz, y: cy-wy*nz, z: nz }; });

    const addBoard = (type) => {
      const r = wrapRef.current.getBoundingClientRect();
      const dim = type === "browser" ? { w: 700, h: 500 } : type === "planning" ? { w: 516, h: 366 } : { w: 420, h: 340 };
      const wx = (r.width / 2 - cam.x) / cam.z - dim.w / 2, wy = (r.height / 2 - cam.y) / cam.z - dim.h / 2;
      const nb = { id: uid(), type, x: wx, y: wy, ...dim,
        title: type === "terminal" ? "agent · new" : type === "browser" ? "app preview" : "plan",
        running: type === "terminal", live: type === "terminal",
        viewport: "desktop" };
      setBoards((b) => [...b, nb]); setSel(nb.id);
    };

    const duplicateBoard = (id) => {
      setBmenu(null);
      setBoards((bs) => {
        const src = bs.find((b) => b.id === id); if (!src) return bs;
        const nb = { ...src, id: uid(), x: src.x + 36, y: src.y + 36 };
        setSel(nb.id);
        return [...bs, nb];
      });
    };
    const deleteBoard = (id) => { setBmenu(null); setBoards((b) => b.filter((x) => x.id !== id)); setSel((s) => s === id ? null : s); };
    const openMenu = (e, id) => { e.stopPropagation(); setSel(id); setBmenu({ id, x: e.clientX, y: e.clientY }); };

    const lod = cam.z < LOD_Z;
    const gridStyle = (() => {
      const step = 24 * cam.z;
      const op = clamp((cam.z - 0.18) / 0.22, 0.15, 1);
      if (t.grid === "plain") return { background: "var(--void)" };
      if (t.grid === "lines") return {
        background: "var(--void)",
        backgroundImage: `linear-gradient(var(--grid-dot) 1px, transparent 1px), linear-gradient(90deg, var(--grid-dot) 1px, transparent 1px)`,
        backgroundSize: `${step}px ${step}px`, backgroundPosition: `${cam.x}px ${cam.y}px`, opacity: 1, ["--g-op"]: op };
      return {
        background: "var(--void)",
        backgroundImage: `radial-gradient(circle, color-mix(in srgb, var(--grid-dot) ${op*100}%, transparent) 1px, transparent 1.4px)`,
        backgroundSize: `${step}px ${step}px`, backgroundPosition: `${cam.x}px ${cam.y}px` };
    })();

    return React.createElement(React.Fragment, null,
      // ── canvas surface ──
      React.createElement("div", {
        ref: wrapRef, onMouseDown: onBgDown,
        style: { position: "fixed", inset: 0, overflow: "hidden", cursor: "grab", ...gridStyle } },
        React.createElement("div", { style: { position: "absolute", left: 0, top: 0, transform: `translate(${cam.x}px,${cam.y}px) scale(${cam.z})`, transformOrigin: "0 0" } },
          boards.map((b) => React.createElement("div", {
            key: b.id,
            onMouseDown: (e) => e.stopPropagation(),
            onMouseEnter: () => setHover(b.id), onMouseLeave: () => setHover((h) => h === b.id ? null : h),
            onClick: (e) => { e.stopPropagation(); setSel(b.id); },
            onDoubleClick: (e) => { e.stopPropagation(); focusBoard(b); },
            style: { position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h } },
            // wrapper holds frame + handles
            React.createElement("div", { style: { position: "absolute", inset: 0 } },
              React.createElement("div", { style: { position: "absolute", inset: 0, pointerEvents: lod ? "none" : "auto" } },
                lod
                  ? React.createElement(BoardFrame, { type: b.type, title: b.title, selected: sel === b.id, lod: true, running: b.running, status: b.type === "terminal" ? { dot: b.running ? "var(--ok)" : "var(--text-3)" } : b.type === "browser" ? { dot: "var(--ok)" } : null })
                  : React.createElement(LiveBoard, { b, selected: sel === b.id, hovered: hover === b.id, dim: !!(focusId && t.dimOnFocus && focusId !== b.id), onTitleBar: (e) => dragBoard(e, b.id), onFull: () => setFullId(b.id), onMore: (e) => openMenu(e, b.id) })),
              (sel === b.id || hover === b.id) && !lod && React.createElement(ResizeHandles, { onStart: (e, dir) => resizeBoard(e, b.id, dir) })
            )
          ))
        ),
        boards.length === 0 && React.createElement(EmptyState, { onAdd: addBoard })
      ),
      // ── top-left: project switcher ──
      React.createElement("div", { style: chrome.tl },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, position: "relative" } },
          React.createElement("button", { onClick: () => setMenu((m) => !m), style: chrome.proj },
            React.createElement("span", { style: { color: "var(--accent)", display: "inline-flex" } }, React.createElement(Icon, { name: "diamond", size: 15 })),
            React.createElement("span", { style: { fontWeight: 600, fontSize: 13, color: "var(--text)" } }, PROJECTS[projId].label),
            React.createElement("span", { style: { color: "var(--text-3)", display: "inline-flex" } }, React.createElement(Icon, { name: "chevron", size: 14 }))),
          React.createElement("span", { style: { fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" } }, "· " + boards.length + (boards.length === 1 ? " board" : " boards")),
          menu && React.createElement("div", { style: chrome.menu },
            React.createElement("div", { style: { fontSize: 10, letterSpacing: "0.07em", color: "var(--text-faint)", padding: "4px 10px 6px", fontFamily: "var(--mono)" } }, "PROJECTS"),
            Object.keys(PROJECTS).map((id) => React.createElement("button", { key: id, onClick: () => switchProj(id), style: { ...chrome.menuItem, color: id === projId ? "var(--text)" : "var(--text-2)" } },
              React.createElement(Icon, { name: "diamond", size: 13, style: { color: id === projId ? "var(--accent)" : "var(--text-faint)" } }),
              PROJECTS[id].label,
              id === "untitled" && React.createElement("span", { style: { marginLeft: "auto", fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--mono)" } }, "empty"))))
        )
      ),
      // ── top-right: camera cluster ──
      React.createElement("div", { style: chrome.tr },
        React.createElement("div", { style: chrome.pill },
          React.createElement(Tool, { name: "fit", title: "Zoom to fit (1)", onClick: zoomToFit }),
          React.createElement("div", { style: chrome.div }),
          React.createElement(Tool, { name: "minus", title: "Zoom out", onClick: () => zoomBy(0.8) }),
          React.createElement("button", { onClick: () => setCam((c)=>({...c,z:1})), style: { fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-2)", width: 44, textAlign: "center", border: "none", background: "none", cursor: "pointer" } }, Math.round(cam.z * 100) + "%"),
          React.createElement(Tool, { name: "plus", title: "Zoom in", onClick: () => zoomBy(1.25) }),
          React.createElement("div", { style: chrome.div }),
          React.createElement(Tool, { name: "overview", title: "Overview", onClick: overview })
        )
      ),
      // ── bottom-center: board dock ──
      React.createElement("div", { style: chrome.dock },
        React.createElement("div", { style: { ...chrome.pill, padding: 4, gap: 3 } },
          React.createElement(Tool, { name: "select", title: "Select", active: true, big: true }),
          React.createElement("div", { style: chrome.div }),
          React.createElement(DockBtn, { type: "terminal", label: "Terminal", onClick: () => addBoard("terminal") }),
          React.createElement(DockBtn, { type: "browser", label: "Browser", onClick: () => addBoard("browser") }),
          React.createElement(DockBtn, { type: "planning", label: "Planning", onClick: () => addBoard("planning") })
        )
      ),
      // ── tweaks ──
      React.createElement(TweaksUI, { t, setTweak }),
      // ── board context menu ──
      bmenu && React.createElement(BoardMenu, {
        x: bmenu.x, y: bmenu.y, type: (boards.find((b) => b.id === bmenu.id) || {}).type,
        onClose: () => setBmenu(null),
        onFull: () => { setFullId(bmenu.id); setBmenu(null); },
        onDup: () => duplicateBoard(bmenu.id),
        onDel: () => deleteBoard(bmenu.id),
      }),
      // ── full view overlay ──
      fullId && React.createElement(FullView, { b: boards.find((b) => b.id === fullId), onClose: () => setFullId(null) })
    );
  }

  function LiveBoard({ b, selected, hovered, dim, onTitleBar, onFull, onMore }) {
    const c = { selected, hovered, dimmed: dim, onTitleBar, onFull, onMore };
    if (b.type === "terminal") return React.createElement(TerminalBoard, { title: b.title, live: b.live, running: b.running, log: b.log, working: b.working, ...c });
    if (b.type === "browser")  return React.createElement(BrowserBoard, { title: b.title, viewport: b.viewport, ...c });
    return React.createElement(PlanningBoard, { title: b.title, ...c });
  }

  function Tool({ name, title, active, onClick, big }) {
    const [h, setH] = useState(false);
    return React.createElement("button", { title, onClick, onMouseEnter: () => setH(true), onMouseLeave: () => setH(false),
      style: { width: big ? 32 : 28, height: 28, display: "grid", placeItems: "center", border: "none", borderRadius: 6, cursor: "pointer",
        background: active ? "var(--accent-wash)" : h ? "var(--surface-overlay)" : "transparent",
        color: active ? "var(--accent)" : h ? "var(--text)" : "var(--text-3)", transition: "color .1s, background .1s" } },
      React.createElement(Icon, { name, size: 16 }));
  }

  function DockBtn({ type, label, onClick }) {
    const [h, setH] = useState(false);
    return React.createElement("button", { onClick, onMouseEnter: () => setH(true), onMouseLeave: () => setH(false),
      style: { height: 32, padding: "0 11px 0 9px", display: "inline-flex", alignItems: "center", gap: 7, border: "none", borderRadius: 6, cursor: "pointer",
        background: h ? "var(--surface-overlay)" : "transparent", color: h ? "var(--text)" : "var(--text-2)", fontSize: 12.5, fontWeight: 500, fontFamily: "var(--ui)", transition: "color .1s, background .1s" } },
      React.createElement("span", { style: { color: h ? "var(--accent)" : "var(--text-3)", display: "inline-flex" } }, React.createElement(window.TypeGlyph, { type })),
      label);
  }

  function EmptyState({ onAdd }) {
    return React.createElement("div", { style: { position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" } },
      React.createElement("div", { style: { textAlign: "center", pointerEvents: "auto", marginTop: -40 } },
        React.createElement("div", { style: { color: "var(--text-faint)", display: "flex", justifyContent: "center", marginBottom: 20, opacity: .6 } }, React.createElement(Icon, { name: "diamond", size: 38, sw: 1.2 })),
        React.createElement("div", { style: { fontSize: 17, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.01em" } }, "Empty canvas"),
        React.createElement("div", { style: { fontSize: 13, color: "var(--text-3)", marginTop: 7, maxWidth: 320, lineHeight: 1.5 } }, "Drop a board to start — spin up a coding agent, preview your running app, or sketch a plan."),
        React.createElement("div", { style: { display: "flex", gap: 10, justifyContent: "center", marginTop: 22 } },
          [["terminal","Terminal"],["browser","Browser"],["planning","Planning"]].map(([type,label]) =>
            React.createElement("button", { key: type, onClick: () => onAdd(type),
              style: { display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 14px", borderRadius: 8, cursor: "pointer",
                background: "transparent", border: "1px dashed var(--border)", color: "var(--text-2)", fontSize: 13, fontWeight: 500, fontFamily: "var(--ui)" } },
              React.createElement("span", { style: { color: "var(--text-3)", display: "inline-flex" } }, React.createElement(window.TypeGlyph, { type })),
              React.createElement("span", { style: { color: "var(--text-faint)", fontFamily: "var(--mono)", fontSize: 13 } }, "+"), label)))
      )
    );
  }

  function TweaksUI({ t, setTweak }) {
    const { TweaksPanel, TweakSection, TweakColor, TweakRadio, TweakToggle } = window;
    return React.createElement(TweaksPanel, null,
      React.createElement(TweakSection, { label: "Accent" }),
      React.createElement(TweakColor, { label: "Accent", value: t.accent, options: ["#4f8cff", "#3ecf8e", "#ff7a45", "#cfd2d6"], onChange: (v) => setTweak("accent", v) }),
      React.createElement(TweakSection, { label: "Canvas" }),
      React.createElement(TweakRadio, { label: "Grid", value: t.grid, options: ["dots", "lines", "plain"], onChange: (v) => setTweak("grid", v) }),
      React.createElement(TweakSection, { label: "Boards" }),
      React.createElement(TweakRadio, { label: "Density", value: t.density, options: ["compact", "roomy"], onChange: (v) => setTweak("density", v) }),
      React.createElement(TweakRadio, { label: "Corners", value: t.corners, options: ["soft", "sharp"], onChange: (v) => setTweak("corners", v) }),
      React.createElement(TweakToggle, { label: "Dim others on focus", value: t.dimOnFocus, onChange: (v) => setTweak("dimOnFocus", v) })
    );
  }

  function BoardMenu({ x, y, type, onClose, onFull, onDup, onDel }) {
    const W = 190;
    const px = Math.min(x, window.innerWidth - W - 12);
    const py = Math.min(y, window.innerHeight - 160);
    const items = [
      { name: "maximize", label: "Full view", on: onFull },
      { name: "copy", label: type === "browser" ? "Duplicate board" : "Duplicate", on: onDup },
      { sep: true },
      { name: "trash", label: "Delete", on: onDel, danger: true },
    ];
    return React.createElement(React.Fragment, null,
      React.createElement("div", { onMouseDown: onClose, onContextMenu: (e) => { e.preventDefault(); onClose(); }, style: { position: "fixed", inset: 0, zIndex: 90 } }),
      React.createElement("div", { style: { position: "fixed", left: px, top: py, width: W, padding: 5, borderRadius: 10, background: "var(--surface-overlay)", border: "1px solid var(--border)", boxShadow: "var(--shadow-pop)", zIndex: 91 } },
        items.map((it, i) => it.sep
          ? React.createElement("div", { key: i, style: { height: 1, background: "var(--border-subtle)", margin: "5px 6px" } })
          : React.createElement(MenuItem, { key: i, name: it.name, label: it.label, on: it.on, danger: it.danger, onClose }))));
  }
  function MenuItem({ name, label, on, danger, onClose }) {
    const [h, setH] = useState(false);
    return React.createElement("button", { onMouseEnter: () => setH(true), onMouseLeave: () => setH(false),
      onClick: () => { on && on(); onClose && onClose(); },
      style: { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 9px", border: "none", cursor: "pointer", borderRadius: 6, textAlign: "left",
        background: h ? (danger ? "color-mix(in srgb, var(--err) 15%, transparent)" : "var(--surface-raised)") : "transparent",
        color: danger ? "var(--err)" : h ? "var(--text)" : "var(--text-2)", fontSize: 12.5, fontFamily: "var(--ui)" } },
      React.createElement(Icon, { name, size: 15, style: { opacity: .85 } }), label);
  }

  function FullView({ b, onClose }) {
    if (!b) return null;
    return React.createElement("div", { onMouseDown: onClose, style: { position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,.66)", display: "flex", padding: "54px 28px 28px" } },
      React.createElement("div", { onMouseDown: (e) => e.stopPropagation(), style: { position: "relative", flex: 1, borderRadius: "var(--r-board)", overflow: "hidden", boxShadow: "0 28px 90px -24px rgba(0,0,0,.85)" } },
        React.createElement(LiveBoard, { b, selected: true })),
      React.createElement("div", { style: { position: "fixed", top: 14, left: 28, display: "inline-flex", alignItems: "center", gap: 9, color: "var(--text-3)", fontSize: 11, fontFamily: "var(--mono)", letterSpacing: "0.04em" } }, "FULL VIEW"),
      React.createElement("button", { onClick: onClose, title: "Exit full view (Esc)", style: {
          position: "fixed", top: 11, right: 28, height: 30, padding: "0 10px 0 9px", display: "inline-flex", alignItems: "center", gap: 7,
          borderRadius: 8, background: "var(--surface-raised)", border: "1px solid var(--border)", boxShadow: "var(--shadow-pop)", color: "var(--text-2)", cursor: "pointer", zIndex: 101 } },
        React.createElement(Icon, { name: "x", size: 15 }),
        React.createElement("span", { style: { fontFamily: "var(--mono)", fontSize: 11 } }, "Esc")));
  }

  const chrome = {
    tl: { position: "fixed", top: 14, left: 16, zIndex: 50 },
    tr: { position: "fixed", top: 14, right: 16, zIndex: 50 },
    dock: { position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 50 },
    proj: { display: "inline-flex", alignItems: "center", gap: 7, height: 34, padding: "0 9px 0 8px", borderRadius: 8, cursor: "pointer",
      background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", boxShadow: "var(--shadow-pop)" },
    pill: { display: "inline-flex", alignItems: "center", gap: 2, padding: 3, borderRadius: 9, background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", boxShadow: "var(--shadow-pop)" },
    div: { width: 1, height: 18, background: "var(--border-subtle)", margin: "0 3px" },
    menu: { position: "absolute", top: 40, left: 0, width: 220, padding: 5, borderRadius: 10, background: "var(--surface-overlay)", border: "1px solid var(--border)", boxShadow: "var(--shadow-pop)", zIndex: 60 },
    menuItem: { display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "8px 10px", border: "none", background: "none", cursor: "pointer", borderRadius: 6, fontSize: 13, fontFamily: "var(--ui)", textAlign: "left" },
  };

  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
})();
