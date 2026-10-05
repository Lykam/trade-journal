// Candlestick charts for the demo's reviews, as SVG (the real site shows the
// owner's Playbook images instead). Entry and exit markers sit at fill prices.
export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Marker {
  /** Candle index. */
  x: number;
  price: number;
  side: "buy" | "sell";
}

const W = 720;
const H = 360;
const PAD = { l: 12, r: 64, t: 34, b: 18 };

export function chartSvg(candles: Candle[], markers: Marker[], title: string): string {
  const lo = Math.min(...candles.map((c) => c.l), ...markers.map((m) => m.price));
  const hi = Math.max(...candles.map((c) => c.h), ...markers.map((m) => m.price));
  const span = hi - lo || 1;
  const y = (p: number) => PAD.t + (1 - (p - lo) / span) * (H - PAD.t - PAD.b);
  const step = (W - PAD.l - PAD.r) / candles.length;
  const x = (i: number) => PAD.l + step * (i + 0.5);
  const body = Math.max(1, step * 0.6);
  const parts: string[] = [];
  for (let k = 0; k <= 4; k++) {
    const p = lo + (span * k) / 4;
    parts.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}" stroke="#1f1f1f"/>`);
    parts.push(`<text x="${W - PAD.r + 6}" y="${(y(p) + 4).toFixed(1)}" fill="#777" font-size="11">${p.toFixed(p < 10 ? 3 : 2)}</text>`);
  }
  candles.forEach((c, i) => {
    const color = c.c >= c.o ? "#22c55e" : "#ef4444";
    parts.push(`<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(c.h).toFixed(1)}" y2="${y(c.l).toFixed(1)}" stroke="${color}"/>`);
    const top = y(Math.max(c.o, c.c));
    parts.push(`<rect x="${(x(i) - body / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${body.toFixed(1)}" height="${Math.max(1, y(Math.min(c.o, c.c)) - top).toFixed(1)}" fill="${color}"/>`);
  });
  for (const m of markers) {
    if (m.x < 0 || m.x >= candles.length) continue;
    const cx = x(m.x);
    const cy = y(m.price);
    const d = m.side === "buy" ? `M${cx - 6},${cy + 11} L${cx + 6},${cy + 11} L${cx},${cy + 2} Z` : `M${cx - 6},${cy - 11} L${cx + 6},${cy - 11} L${cx},${cy - 2} Z`;
    parts.push(`<path d="${d}" fill="#f5a524" stroke="#0a0a0a"/>`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="monospace">` +
    `<rect width="${W}" height="${H}" fill="#0a0a0a"/>` +
    `<text x="${PAD.l}" y="20" fill="#f5a524" font-size="13" letter-spacing="1">${title}</text>` +
    `<text x="${W - PAD.r}" y="20" fill="#777" font-size="11" text-anchor="end">▲ BUY  ▼ SELL · SYNTHETIC</text>` +
    parts.join("") +
    `</svg>`
  );
}

export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
