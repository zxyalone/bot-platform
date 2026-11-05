// One consistent line icon set, drawn on a 24px grid.
const PATHS = {
  plus: ["M12 5v14", "M5 12h14"],
  x: ["M6 6l12 12", "M18 6L6 18"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  send: ["M12 19V5", "M6 11l6-6 6 6"],
  stop: ["M8 8h8v8H8z"],
  refresh: ["M20 11a8 8 0 0 0-14-4.5L4 9", "M4 4v5h5", "M4 13a8 8 0 0 0 14 4.5l2-2.5", "M20 20v-5h-5"],
  panel: ["M4 5h16v14H4z", "M15 5v14"],
  settings: ["M4 7h10", "M18 7h2", "M4 17h2", "M10 17h10", "M14 5v4h4V5z", "M6 15v4h4v-4z"],
  back: ["M15 6l-6 6 6 6"],
  inbox: ["M4 13l2.5-8h11L20 13", "M4 13v6h16v-6", "M4 13h5l1.5 2.5h3L15 13h5"],
  attach: ["M20 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.4-2.4l8.2-8.2"],
  search: ["M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z", "M20 20l-4-4"],
  list: ["M9 6h11", "M9 12h11", "M9 18h11", "M4 6h1", "M4 12h1", "M4 18h1"],
  flask: ["M10 3h4", "M11 3v6l-5.5 9.5A1 1 0 0 0 6.4 20h11.2a1 1 0 0 0 .9-1.5L13 9V3", "M8 15h8"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  check: ["M5 12.5l4.5 4.5L19 7"],
};

const NS = "http://www.w3.org/2000/svg";

export function icon(name, size = 18) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  for (const d of PATHS[name] ?? []) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
