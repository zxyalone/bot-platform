// Symmetric pixel avatar derived from a stable seed, so a Bot keeps its face across renames.
const PALETTE = ["#5B6EE1", "#2E9E83", "#D9694A", "#B6559A", "#3C8DBC", "#8A6FD1", "#C58A1F", "#4F9B3F"];
const NS = "http://www.w3.org/2000/svg";

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function avatar(seed, size = 36) {
  let h = hash(seed);
  const next = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    return h;
  };
  const color = PALETTE[next() % PALETTE.length];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 8 8");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("class", "avatar");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", 8);
  bg.setAttribute("height", 8);
  bg.setAttribute("fill", color);
  bg.setAttribute("opacity", "0.16");
  svg.append(bg);
  for (let y = 1; y < 7; y++) {
    for (let x = 1; x < 4; x++) {
      if (next() % 100 < 58) {
        for (const px of [x, 7 - x]) {
          const r = document.createElementNS(NS, "rect");
          r.setAttribute("x", px);
          r.setAttribute("y", y);
          r.setAttribute("width", 1);
          r.setAttribute("height", 1);
          r.setAttribute("fill", color);
          svg.append(r);
        }
      }
    }
  }
  return svg;
}
