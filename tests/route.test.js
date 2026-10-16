// Run:  node tests/route.test.js
// Checks the road shortest paths (Dijkstra), the TSP solver (Held–Karp, 2-opt) and the driver's route in route.js.
const assert = require("assert");
const Route = require("../route.js");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("✔", name); };
const close = (a, b) => Math.abs(a - b) < 1e-9;
const ids = Object.keys(Route.NODES);

// Floyd–Warshall: a completely different all-pairs shortest-path algorithm,
// used only to double-check Dijkstra's answers.
function floydWarshall(graph, cost) {
  const d = {};
  for (const a of ids) { d[a] = {}; for (const b of ids) d[a][b] = a === b ? 0 : Infinity; }
  for (const a of ids) for (const e of graph[a]) d[a][e.to] = Math.min(d[a][e.to], e[cost]);
  for (const k of ids) for (const i of ids) for (const j of ids)
    if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  return d;
}

for (const heavyTraffic of [false, true]) for (const cost of ["km", "min"]) {
  const tag = `${cost === "km" ? "distance" : "time"}${heavyTraffic ? ", heavy traffic" : ""}`;
  const g = Route.buildGraph(heavyTraffic);

  test(`Dijkstra matches Floyd–Warshall on all ${ids.length}×${ids.length} pairs (${tag})`, () => {
    const fw = floydWarshall(g, cost);
    for (const a of ids) {
      const { dist } = Route.dijkstra(g, a, cost);
      for (const b of ids) assert(close(dist[b], fw[a][b]), `${a}→${b}: ${dist[b]} vs ${fw[a][b]}`);
    }
  });

  test(`every Dijkstra path follows real roads and its length equals the reported cost (${tag})`, () => {
    for (const a of ids) {
      const { dist, prev } = Route.dijkstra(g, a, cost);
      for (const b of ids) {
        const path = Route.pathTo(prev, a, b);
        assert(path && path[0] === a && path[path.length - 1] === b, `no path ${a}→${b}`);
        for (let i = 0; i < path.length - 1; i++)
          assert(g[path[i]].some(e => e.to === path[i + 1]), `${path[i]}–${path[i + 1]} is not a road`);
        assert(close(Route.measure(g, path)[cost], dist[b]));
      }
    }
  });
}

// ---------- TSP ----------
const perms = a => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(r => [x, ...r]));
const bruteForce = M => {               // try every order (only possible for small n)
  const stops = Array.from({ length: M.length - 1 }, (_, i) => i + 1);
  return Math.min(...perms(stops).map(p => Route.tourCost(M, [0, ...p, 0])));
};
let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const randomMatrix = n => {             // random points on a plane (symmetric, triangle inequality)
  const pts = Array.from({ length: n + 1 }, () => [rand() * 10, rand() * 10]);
  return pts.map(a => pts.map(b => Math.hypot(a[0] - b[0], a[1] - b[1])));
};

test("Held–Karp gives the exact optimum: equals brute force on 200 random cases (1–7 stops)", () => {
  for (let t = 0; t < 200; t++) {
    const M = randomMatrix(1 + (t % 7));
    const hk = Route.heldKarp(M);
    assert(close(hk.cost, bruteForce(M)), `case ${t}`);
    assert(close(Route.tourCost(M, hk.tour), hk.cost));
    assert.strictEqual(hk.tour[0], 0); assert.strictEqual(hk.tour[hk.tour.length - 1], 0);
    assert.strictEqual(new Set(hk.tour.slice(1, -1)).size, M.length - 1, "every stop exactly once");
  }
});

test("Held–Karp also works on non-symmetric costs (one-way traffic)", () => {
  for (let t = 0; t < 50; t++) {
    const n = 2 + (t % 5);
    const M = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === j ? 0 : 1 + rand() * 9));
    assert(close(Route.heldKarp(M).cost, bruteForce(M)), `case ${t}`);
  }
});

test("2-opt never makes the nearest-neighbour tour longer, and visits every stop once", () => {
  for (let t = 0; t < 50; t++) {
    const M = randomMatrix(15 + (t % 10));
    const nn = Route.nearestNeighbour(M), opt = Route.twoOpt(M, nn);
    assert(Route.tourCost(M, opt) <= Route.tourCost(M, nn) + 1e-9);
    assert.strictEqual(new Set(opt.slice(1, -1)).size, M.length - 1);
  }
});

test("the driver's route on the ward uses the TSP optimum, never worse than request order", () => {
  for (const cost of ["km", "min"]) {
    const r = Route.plan(["S4", "S2", "S5", "S1", "S3"], { cost });
    assert(r.tsp.method.startsWith("Held–Karp"));
    assert(close(r.tsp.cost, bruteForce(r.tsp.matrix)));
    assert(r.tsp.cost <= r.tsp.requestCost + 1e-9);
    assert(close(cost === "km" ? r.totalKm : r.driveMin, r.tsp.cost), "drawn route = TSP cost");
  }
});

test("route starts and ends at the hub, and totals add up", () => {
  const r = Route.plan(["S2", "S4", "S5"], { cost: "km" });
  assert.strictEqual(r.legs[0].from, "HUB");
  assert.strictEqual(r.legs[r.legs.length - 1].to, "HUB");
  assert.strictEqual(r.legs.length, r.order.length + 1);
  assert(close(r.totalKm, r.legs.reduce((s, l) => s + l.km, 0)));
  assert(close(r.totalMin, r.driveMin + Route.SERVICE_MIN * r.order.length));
  assert(r.legs.every(l => l.km > 0 && l.min > 0));
});

test("heavy traffic on Chord Road never makes the fastest trip quicker", () => {
  const stops = ["S1", "S3", "S4"];
  const normal = Route.plan(stops, { cost: "min" }), jam = Route.plan(stops, { cost: "min", heavyTraffic: true });
  assert(jam.driveMin >= normal.driveMin - 1e-9);
});

test("no stops means no route", () => {
  const r = Route.plan([], {});
  assert.deepStrictEqual(r.order, []);
  assert.strictEqual(r.legs.length, 0);
  assert.strictEqual(r.totalKm, 0);
});

console.log(`\nAll ${passed} route tests passed.`);
