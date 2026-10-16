// =====================================================================
// CHARTS: small SVG bar charts (no libraries)
// Bars can be "actual" (solid), "sample" (striped) or "forecast"
// (outlined, with a range line for the prediction interval).
// =====================================================================

const Charts = (() => {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // bars: [{label, value, kind:"actual"|"sample"|"forecast", low?, high?, title?}]
  function bars(bars, { height = 190, unit = "kg", ariaLabel = "Chart" } = {}) {
    if (!bars.length) return `<div class="empty"><strong>No data yet</strong>Collections appear here after the hub confirms them.</div>`;
    const W = 640, H = height, left = 44, right = 8, top = 26, bottom = 34;
    const max = Math.max(1, ...bars.map(b => Math.max(b.value, b.high || 0)));
    const step = niceStep(max / 4), yMax = Math.ceil(max / step) * step;
    const y = v => top + (H - top - bottom) * (1 - v / yMax);
    const slot = (W - left - right) / bars.length, bw = Math.max(4, slot * 0.66);
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">`;
    s += `<defs><pattern id="stripe" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--sample-bg)"/><rect width="3" height="6" fill="var(--sample)"/></pattern></defs>`;
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      s += `<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`;
      s += `<text x="${left - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${Math.round(v)}</text>`;
    }
    const every = Math.ceil(bars.length / 10);
    bars.forEach((b, i) => {
      const x = left + i * slot + (slot - bw) / 2, h = Math.max(0, y(0) - y(b.value));
      const fill = b.kind === "forecast" ? "var(--forecast-bg)" : b.kind === "sample" ? "url(#stripe)" : "var(--palm)";
      const stroke = b.kind === "forecast" ? `stroke="var(--forecast)" stroke-width="1.5" stroke-dasharray="4 3"` : "";
      s += `<rect x="${x.toFixed(1)}" y="${y(b.value).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${fill}" ${stroke}><title>${esc(b.title || `${b.label}: ${Math.round(b.value)} ${unit}`)}</title></rect>`;
      if (b.kind === "forecast" && b.high != null) {
        const cx = x + bw / 2;
        s += `<line x1="${cx}" x2="${cx}" y1="${y(b.high)}" y2="${y(b.low)}" stroke="var(--forecast)" stroke-width="1.5"/><line x1="${cx - 4}" x2="${cx + 4}" y1="${y(b.high)}" y2="${y(b.high)}" stroke="var(--forecast)"/><line x1="${cx - 4}" x2="${cx + 4}" y1="${y(b.low)}" y2="${y(b.low)}" stroke="var(--forecast)"/>`;
      }
      const last = bars.length - 1;
      if (i === last || (i % every === 0 && last - i >= Math.max(2, every * 0.6))) s += `<text x="${(i === last ? x + bw : x + bw / 2).toFixed(1)}" y="${H - bottom + 16}" text-anchor="${i === last ? "end" : "middle"}" font-size="11" fill="var(--muted)">${esc(b.label)}</text>`;
    });
    s += `<text x="4" y="12" font-size="11" fill="var(--muted)">${esc(unit)}</text></svg>`;
    return s;
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
    return 10 * p;
  }

  const legend = items => `<div class="legend">${items.map(([kind, text]) =>
    `<span><b class="sw sw-${kind}"></b>${esc(text)}</span>`).join("")}</div>`;

  return { bars, legend };
})();
