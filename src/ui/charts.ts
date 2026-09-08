/**
 * Server-rendered inline SVG for the warmup pages. Colours are the app's
 * status tokens (var(--ok) etc.) so the charts follow the theme, and every
 * series is also named in a legend and available as a table on the page.
 */

import type { DailyPoint } from '../warmup/stats.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * Small per-row trend: one bar per day of what was sent, split into inbox
 * (good), category (warning), spam + missing (critical). Empty days stay
 * empty so a pause is visible as a gap.
 */
export function sparklineSvg(points: DailyPoint[], days = 14, width = 96, height = 22): string {
  const series = padDays(points, days);
  const max = Math.max(1, ...series.map((d) => d.inbox + d.category + d.spam + d.missing || d.sent));
  const gap = 1;
  const bw = (width - gap * (days - 1)) / days;
  const rects: string[] = [];
  series.forEach((d, i) => {
    const x = i * (bw + gap);
    const total = d.inbox + d.category + d.spam + d.missing;
    const stack = total > 0 ? [
      [d.inbox, 'var(--ok)'],
      [d.category, 'var(--warn)'],
      [d.spam + d.missing, 'var(--err)'],
    ] as const : [[d.sent, 'var(--muted)']] as const;
    let y = height;
    for (const [v, fill] of stack) {
      if (!v) continue;
      const h = Math.max(1, (v / max) * (height - 1));
      y -= h;
      rects.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" rx="1"/>`);
    }
  });
  const title = `Last ${days} days, per day: inbox (green), category (amber), spam or missing (red); grey = sent, placement pending`;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${rects.join('')}</svg>`;
}

function padDays(points: DailyPoint[], days: number): DailyPoint[] {
  const byDate = new Map(points.map((p) => [p.date, p]));
  const out: DailyPoint[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    out.push(byDate.get(key) ?? { date: key, sent: 0, inbox: 0, spam: 0, category: 0, missing: 0, received: 0, replies: 0 });
  }
  return out;
}

/**
 * Placement over time: stacked daily bars (inbox / category / spam / missing)
 * with a y-axis, light gridlines, and per-bar hover titles. One scale.
 */
export function placementChartSvg(points: DailyPoint[], days = 30, width = 760, height = 200): string {
  const series = padDays(points, days);
  const pad = { l: 34, r: 8, t: 8, b: 22 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const max = Math.max(1, ...series.map((d) => Math.max(d.sent, d.inbox + d.category + d.spam + d.missing)));
  const nice = niceCeil(max);
  const gap = 2;
  const bw = Math.max(2, (plotW - gap * (days - 1)) / days);
  const y = (v: number) => pad.t + plotH - (v / nice) * plotH;

  const grid: string[] = [];
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (nice / ticks) * i;
    const yy = y(v);
    grid.push(`<line x1="${pad.l}" x2="${width - pad.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`);
    grid.push(`<text x="${pad.l - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${Math.round(v)}</text>`);
  }

  const bars: string[] = [];
  series.forEach((d, i) => {
    const x = pad.l + i * (bw + gap);
    const total = d.inbox + d.category + d.spam + d.missing;
    const pending = Math.max(0, d.sent - total);
    const stack: [number, string][] = [
      [d.inbox, 'var(--ok)'],
      [d.category, 'var(--warn)'],
      [d.spam, 'var(--err)'],
      [d.missing, 'color-mix(in srgb, var(--err) 55%, var(--bg))'],
      [pending, 'var(--line)'],
    ];
    let top = pad.t + plotH;
    const parts: string[] = [];
    for (const [v, fill] of stack) {
      if (!v) continue;
      const h = (v / nice) * plotH;
      top -= h;
      parts.push(`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h - 1).toFixed(1)}" fill="${fill}" rx="1.5"/>`);
    }
    const label = `${d.date}: sent ${d.sent}, inbox ${d.inbox}, category ${d.category}, spam ${d.spam}, missing ${d.missing}, received ${d.received}, replies ${d.replies}`;
    bars.push(`<g class="bar"><title>${esc(label)}</title><rect x="${(x - gap / 2).toFixed(1)}" y="${pad.t}" width="${(bw + gap).toFixed(1)}" height="${plotH}" fill="transparent"/>${parts.join('')}</g>`);
    if (i % Math.ceil(days / 6) === 0 || i === days - 1) {
      bars.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${d.date.slice(5)}</text>`);
    }
  });

  return `<svg class="placement-chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" role="img" aria-label="Warmup placement per day"><title>Warmup placement per day</title>${grid.join('')}${bars.join('')}</svg>`;
}

function niceCeil(v: number): number {
  if (v <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

export const CHART_LEGEND = [
  { key: 'inbox', label: 'Inbox', color: 'var(--ok)' },
  { key: 'category', label: 'Promotions / Other', color: 'var(--warn)' },
  { key: 'spam', label: 'Spam', color: 'var(--err)' },
  { key: 'missing', label: 'Missing', color: 'color-mix(in srgb, var(--err) 55%, var(--bg))' },
  { key: 'pending', label: 'Sent, placement pending', color: 'var(--line)' },
];
