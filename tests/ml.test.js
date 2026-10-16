// Run:  node tests/ml.test.js
// Checks that the forecasting model really learns, is evaluated honestly,
// and handles missing / insufficient data.
const assert = require("assert");
const ML = require("../ml.js");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("✔", name); };
const DAY = 86400000;

test("regression recovers known weights on noise-free data", () => {
  const series = [];
  for (let i = 0; i < 60; i++) {
    const date = ML.dateKey(Date.now() - (60 - i) * DAY);
    const x = ML.features(date, i);
    series.push({ date, kg: 100 + 30 * x[1] + 20 * x[2] - 10 * x[7] });   // Monday +20, Saturday -10
  }
  const m = ML.train(series);
  assert(Math.abs(m.w[0] - 100) < 2, "intercept ≈ 100, got " + m.w[0]);
  assert(Math.abs(m.w[1] - 30) < 2, "trend ≈ 30, got " + m.w[1]);
  assert(Math.abs(m.w[2] - 20) < 2, "Monday ≈ +20, got " + m.w[2]);
  assert(m.sd < 1, "near-zero error on clean data");
});

test("sample history is deterministic and labelled as sample", () => {
  const a = ML.sampleHistory(), b = ML.sampleHistory();
  assert.deepStrictEqual(a, b);
  assert(a.every(d => d.sample === true));
  assert.strictEqual(a.length, 84);
});

test("model beats the 'same day last week' baseline on sample data", () => {
  const r = ML.run([], { allowSample: true });
  assert.strictEqual(r.source, "sample");
  assert(r.evaluation, "evaluation exists");
  assert(r.evaluation.mae < r.evaluation.baselineMae, `MAE ${r.evaluation.mae.toFixed(1)} vs baseline ${r.evaluation.baselineMae.toFixed(1)}`);
  console.log(`   MAE ${r.evaluation.mae.toFixed(1)} kg, baseline ${r.evaluation.baselineMae.toFixed(1)} kg, MAPE ${r.evaluation.mape.toFixed(1)}%`);
});

test("forecast has 7 future days with sensible intervals", () => {
  const r = ML.run([]);
  assert.strictEqual(r.forecast.length, 7);
  for (const f of r.forecast) { assert(f.low <= f.kg && f.kg <= f.high); assert(f.kg > 0); }
  assert(r.forecast[0].date > r.series[r.series.length - 1].date);
});

test("too little real data is reported, not hidden", () => {
  const pickups = [{ status: "confirmed", actualKg: 50, confirmedAt: Date.now() - 3 * DAY }];
  const r = ML.run(pickups, { allowSample: false });
  assert.strictEqual(r.status, "insufficient");
  assert.strictEqual(r.realDays, 3);
});

test("only confirmed, weighed pickups count as real history", () => {
  const t = Date.now() - 2 * DAY;
  const s = ML.dailySeries([
    { status: "confirmed", actualKg: 40, confirmedAt: t },
    { status: "collected", actualKg: 99, collectedAt: t },     // not confirmed yet
    { status: "requested", sacks: 3, requestedAt: t },          // estimate only
    { status: "confirmed", actualKg: 0, confirmedAt: t },       // invalid weight
  ]);
  assert.strictEqual(s[0].kg, 40);
  assert.strictEqual(s.length, 2);                              // 2 days ago and yesterday (0 kg)
  assert.strictEqual(s[1].kg, 0);
});

test("weekly totals add up", () => {
  const h = ML.sampleHistory(28);
  const total = h.reduce((s, d) => s + d.kg, 0);
  assert.strictEqual(ML.weekly(h).reduce((s, w) => s + w.kg, 0), total);
});

console.log(`\nAll ${passed} ML tests passed.`);
