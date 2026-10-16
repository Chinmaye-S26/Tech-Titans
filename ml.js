// =====================================================================
// ML: shell supply forecasting
// ---------------------------------------------------------------------
// Model: linear regression (ridge) on daily collected kilograms.
//   features = intercept + trend (day number) + day of week (Mon..Sat,
//              Sunday is the baseline)
// Trained on daily totals of CONFIRMED pickups (actual weighed kg).
// If there are fewer than MIN_DAYS of real history, the dashboard
// uses clearly labelled SAMPLE (synthetic) history instead.
//
// Evaluation: the last 14 days are held out. We report MAE (mean absolute
// error in kg) and compare it with a simple baseline ("same as the same
// weekday last week"). A model is only useful if it beats the baseline.
// =====================================================================

const ML = (() => {
  const MIN_DAYS = 21;     // need at least 3 weeks of real days to train
  const HOLDOUT = 14;      // days kept aside to test the model
  const DAY = 86400000;

  // ---------- dates ----------
  const pad = n => String(n).padStart(2, "0");
  const dateKey = d => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const fromKey = k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = fromKey(k); d.setDate(d.getDate() + n); return dateKey(d); };
  const today = () => dateKey(Date.now());

  // ---------- real history from records ----------
  // Daily kg from CONFIRMED pickups only (actual weighed kg), excluding today
  // (today is not finished). Days with no collections between the first
  // record and yesterday count as 0 kg.
  function dailySeries(pickups) {
    const byDay = {};
    for (const p of pickups) {
      if (p.sample) continue;                     // demo sample records never train the model
      if (p.status !== "confirmed" || !(p.actualKg > 0)) continue;
      const k = dateKey(p.confirmedAt || p.collectedAt || p.requestedAt);
      byDay[k] = (byDay[k] || 0) + p.actualKg;
    }
    const keys = Object.keys(byDay).filter(k => k < today()).sort();
    if (!keys.length) return [];
    const out = [];
    for (let k = keys[0]; k < today(); k = addDays(k, 1)) out.push({ date: k, kg: byDay[k] || 0 });
    return out;
  }

  // ---------- sample (synthetic) history ----------
  // Deterministic, so everyone sees the same demo numbers.
  // Pattern: ~240 kg/day for the 5 demo stalls, busier weekends, slow upward trend, noise.
  function sampleHistory(days = 84, seed = 7) {
    let s = seed >>> 0;
    const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
    const dowFactor = [1.25, 0.88, 0.95, 1.0, 1.0, 1.08, 1.22];   // Sun..Sat
    const out = [];
    const start = addDays(today(), -days);
    for (let i = 0; i < days; i++) {
      const k = addDays(start, i);
      const kg = (240 + 0.6 * i) * dowFactor[fromKey(k).getDay()] + 18 * gauss();
      out.push({ date: k, kg: Math.max(0, Math.round(kg)), sample: true });
    }
    return out;
  }

  // ---------- features and linear algebra ----------
  function features(dateK, t) {
    const dow = fromKey(dateK).getDay();          // 0 = Sunday
    const x = [1, t / 30];
    for (let d = 1; d <= 6; d++) x.push(dow === d ? 1 : 0);
    return x;
  }

  // Solve A·w = b (Gaussian elimination with partial pivoting)
  function solve(A, b) {
    const n = b.length, M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) throw new Error("Singular matrix: not enough varied data");
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  // Ridge regression: w = (XᵀX + λI)⁻¹ Xᵀy  (the intercept is not penalised)
  function fit(X, y, lambda = 0.5) {
    const p = X[0].length;
    const A = Array.from({ length: p }, () => Array(p).fill(0)), b = Array(p).fill(0);
    X.forEach((x, i) => { for (let a = 0; a < p; a++) { b[a] += x[a] * y[i]; for (let c = 0; c < p; c++) A[a][c] += x[a] * x[c]; } });
    for (let a = 1; a < p; a++) A[a][a] += lambda;
    return solve(A, b);
  }
  const dot = (w, x) => w.reduce((s, wi, i) => s + wi * x[i], 0);

  function train(series) {
    const X = series.map((d, i) => features(d.date, i)), y = series.map(d => d.kg);
    const w = fit(X, y);
    const resid = y.map((v, i) => v - dot(w, X[i]));
    const sd = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / Math.max(1, resid.length - X[0].length));
    return { w, sd, n: series.length };
  }

  // ---------- evaluate on held-out days ----------
  function evaluate(series) {
    if (series.length < MIN_DAYS + HOLDOUT - 7) return null;
    const trainPart = series.slice(0, -HOLDOUT), test = series.slice(-HOLDOUT);
    const m = train(trainPart);
    let mae = 0, base = 0, ape = 0, apeN = 0;
    test.forEach((d, j) => {
      const i = trainPart.length + j;
      const pred = Math.max(0, dot(m.w, features(d.date, i)));
      const naive = series[i - 7].kg;                       // same weekday last week
      mae += Math.abs(d.kg - pred); base += Math.abs(d.kg - naive);
      if (d.kg > 0) { ape += Math.abs(d.kg - pred) / d.kg; apeN++; }
    });
    return { mae: mae / test.length, baselineMae: base / test.length, mape: apeN ? (ape / apeN) * 100 : null, testDays: test.length };
  }

  // ---------- forecast ----------
  // Returns { status, source, series, forecast[], evaluation, trainedDays }
  //   status: "ok" | "insufficient"
  //   source: "real" | "sample"
  function run(pickups, { allowSample = true, horizon = 7 } = {}) {
    const real = dailySeries(pickups);
    const realDays = real.length;
    let series = real, source = "real";
    if (realDays < MIN_DAYS) {
      if (!allowSample) return { status: "insufficient", source: "real", realDays, needed: MIN_DAYS, series: real, forecast: [] };
      series = sampleHistory(); source = "sample";
    }
    const m = train(series);
    const last = series[series.length - 1].date;
    const forecast = [];
    for (let h = 1; h <= horizon; h++) {
      const k = addDays(last, h);
      const kg = Math.max(0, dot(m.w, features(k, series.length - 1 + h)));
      forecast.push({ date: k, kg: Math.round(kg), low: Math.max(0, Math.round(kg - 1.28 * m.sd)), high: Math.round(kg + 1.28 * m.sd) });
    }
    return { status: "ok", source, realDays, series, forecast, evaluation: evaluate(series), trainedDays: m.n, weights: m.w, sd: m.sd };
  }

  // Weekly totals (Monday-start weeks) from a daily series
  function weekly(series) {
    const byWeek = {};
    for (const d of series) {
      const dt = fromKey(d.date); const monday = new Date(dt); monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
      const k = dateKey(monday);
      byWeek[k] = byWeek[k] || { week: k, kg: 0, days: 0 };
      byWeek[k].kg += d.kg; byWeek[k].days++;
    }
    return Object.values(byWeek).sort((a, b) => a.week < b.week ? -1 : 1);
  }

  return { MIN_DAYS, HOLDOUT, dateKey, fromKey, addDays, dailySeries, sampleHistory, features, fit, solve, train, evaluate, run, weekly };
})();
if (typeof module !== "undefined") module.exports = ML;
