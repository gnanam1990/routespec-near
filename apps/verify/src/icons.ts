/**
 * The console's stroke-icon language (UI-SPEC 5.5, ADR-0026), for the plain-DOM verify page:
 * 24-unit grid, 1.75 stroke, round caps and joins, currentColor only. Path data is the same as
 * `apps/console/src/components/Icon.tsx`. Icons are decorative (aria-hidden); meaning is always
 * carried by the adjacent text.
 */
const SVG = 'http://www.w3.org/2000/svg';

const PATHS = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12M18 6L6 18'],
  circle: [{ circle: [12, 12, 8.5] }],
  question: [{ circle: [12, 12, 8.5] }, 'M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.5M12 17h.01'],
  slash: [{ circle: [12, 12, 8.5] }, 'M6 18L18 6'],
  clock: [{ circle: [12, 12, 8.5] }, 'M12 7.5V12l3 2'],
  alert: ['M12 3.8l9 15.7H3z', 'M12 10v4.5M12 17.2h.01'],
  info: [{ circle: [12, 12, 8.5] }, 'M12 11v5M12 8h.01'],
  copy: [
    { rect: [8.5, 8.5, 11, 11, 1.5] },
    'M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5',
  ],
  disconnected: [
    'M3 3l18 18',
    'M8.5 16.5a5 5 0 0 1 7-7M5 13a9.5 9.5 0 0 1 3-2.5M12 19.5h.01M16 13.5a5 5 0 0 1 .9 1.2',
  ],
} as const satisfies Record<
  string,
  ReadonlyArray<string | { circle: readonly number[] } | { rect: readonly number[] }>
>;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({
    class: 'icon',
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.75',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }))
    svg.setAttribute(k, v);
  for (const part of PATHS[name]) {
    if (typeof part === 'string') {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', part);
      svg.append(p);
    } else if ('circle' in part) {
      const [cx, cy, r] = part.circle;
      const c = document.createElementNS(SVG, 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', String(cy));
      c.setAttribute('r', String(r));
      svg.append(c);
    } else {
      const [x, y, w, h, rx] = part.rect;
      const r = document.createElementNS(SVG, 'rect');
      for (const [k, v] of Object.entries({ x, y, width: w, height: h, rx })) r.setAttribute(k, String(v));
      svg.append(r);
    }
  }
  return svg;
}
