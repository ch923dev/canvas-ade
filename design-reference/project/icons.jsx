// icons.jsx — monochrome line icons + board type glyphs for Canvas ADE.
// All 1.5px stroke, currentColor, 16px default. Exported to window.
(function () {
  const S = ({ d, size = 16, sw = 1.5, fill = "none", children, style, vb = 24 }) =>
    React.createElement(
      "svg",
      {
        width: size, height: size, viewBox: `0 0 ${vb} ${vb}`,
        fill, stroke: "currentColor", strokeWidth: sw,
        strokeLinecap: "round", strokeLinejoin: "round", style,
      },
      d ? React.createElement("path", { d }) : children
    );

  const P = {
    play: "M8 5l11 7-11 7z",
    pause: "M9 5v14M15 5v14",
    restart: "M4 12a8 8 0 1 0 2.3-5.6M5 4v3.5H8.5",
    stop: "M7 7h10v10H7z",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    fit: "M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4",
    overview: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    select: "M5 4l14 6.5-6 1.8-2.2 5.7z",
    note: "M5 5h14v10l-4 4H5zM15 19v-4h4",
    text: "M5 6h14M12 6v12M9 18h6",
    arrow: "M5 19L19 5M19 5h-7M19 5v7",
    pen: "M5 19l2-6 9-9 4 4-9 9-6 2zM14 6l4 4",
    refresh: "M4 12a8 8 0 1 0 2.3-5.6M5 4v3.5H8.5",
    back: "M15 6l-6 6 6 6",
    forward: "M9 6l6 6-6 6",
    chevron: "M6 9l6 6 6-6",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.5-4.5",
    diamond: "M12 3l9 9-9 9-9-9z",
    grid: "M4 9h16M4 15h16M9 4v16M15 4v16",
    cmd: "M9 9V7a2 2 0 1 0-2 2zM15 9h2a2 2 0 1 0-2-2zM9 15v2a2 2 0 1 1-2-2zM15 15h2a2 2 0 1 1-2 2zM9 9h6v6H9z",
    maximize: "M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7",
    x: "M6 6l12 12M18 6L6 18",
    copy: "M9 9.5A1.5 1.5 0 0 1 10.5 8H18a1.5 1.5 0 0 1 1.5 1.5V18A1.5 1.5 0 0 1 18 19.5h-7.5A1.5 1.5 0 0 1 9 18zM6 15.5A1.5 1.5 0 0 1 4.5 14V5.5A1.5 1.5 0 0 1 6 4h7.5A1.5 1.5 0 0 1 15 5.5",
    check: "M5 12.5l4.5 4.5L19 7",
    trash: "M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13",
  };

  function Icon({ name, size = 16, sw = 1.5, style }) {
    if (name === "mobile")
      return S({ size, sw, style, children: [
        React.createElement("rect", { key: "r", x: 8, y: 3, width: 8, height: 18, rx: 1.6 }),
        React.createElement("path", { key: "l", d: "M11 18h2" }),
      ]});
    if (name === "tablet")
      return S({ size, sw, style, children: [
        React.createElement("rect", { key: "r", x: 5, y: 4, width: 14, height: 16, rx: 1.6 }),
        React.createElement("path", { key: "l", d: "M11 17h2" }),
      ]});
    if (name === "desktop")
      return S({ size, sw, style, children: [
        React.createElement("rect", { key: "r", x: 3, y: 4, width: 18, height: 12, rx: 1.4 }),
        React.createElement("path", { key: "l", d: "M9 20h6M12 16v4" }),
      ]});
    return S({ d: P[name] || P.diamond, size, sw, style });
  }

  // Board type glyphs — small, monochrome, never illustrative.
  function TypeGlyph({ type, running }) {
    if (type === "terminal")
      return React.createElement(
        "span",
        { style: { fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 500, letterSpacing: "-0.04em", lineHeight: 1, display: "inline-flex", alignItems: "center" } },
        "›",
        React.createElement("span", {
          className: running ? "ca-caret-run" : "",
          style: { display: "inline-block", width: 6, height: 11, marginLeft: 1, background: running ? "var(--ok)" : "var(--text-3)", borderRadius: 1, transform: "translateY(0.5px)" },
        })
      );
    if (type === "browser")
      return S({ size: 15, sw: 1.4, vb: 24, children: [
        React.createElement("rect", { key: "r", x: 3.5, y: 5, width: 17, height: 14, rx: 1.6 }),
        React.createElement("path", { key: "b", d: "M3.5 9h17", strokeWidth: 1.4 }),
        React.createElement("circle", { key: "d", cx: 6.4, cy: 7, r: 0.6, fill: "currentColor", stroke: "none" }),
      ]});
    // planning
    return S({ size: 15, sw: 1.4, vb: 24, children: [
      React.createElement("rect", { key: "r", x: 4, y: 4, width: 16, height: 16, rx: 2, strokeDasharray: "2.4 2.6" }),
      React.createElement("path", { key: "p", d: "M8.5 15.5l3-1 5-5-2-2-5 5z", strokeDasharray: "0" }),
    ]});
  }

  window.Icon = Icon;
  window.TypeGlyph = TypeGlyph;
})();
