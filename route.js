// =====================================================================
// ROUTE: road network + Travelling Salesman Problem (TSP)
// ---------------------------------------------------------------------
// The ward is a GRAPH:
//   nodes = road junctions, the hub, and the vendor stalls
//   edges = road segments, each with a length (km) and a speed (km/h)
// The driver's route is a TSP: start at the hub, visit every waiting
// stall once, return to the hub, with the smallest total distance or time.
//   1. distance matrix between hub + stalls (shortest road path, Dijkstra)
//   2. TSP solved with Held–Karp dynamic programming (exact, up to 12
//      stops) or nearest neighbour + 2-opt for bigger days.
// =====================================================================

const Route = (() => {
  // Map size: 3.0 km wide. Positions below are 0..1 across the map.
  const MAP_W_KM = 3.0, MAP_H_KM = 3.0 * 260 / 400;
  const SERVICE_MIN = 3;               // minutes to weigh + load at each stall

  // Road types and normal speeds
  const SPEED = { main: 30, street: 18, lane: 12 };   // km/h
  const TRAFFIC_SPEED = 8;                             // Chord Road in heavy traffic

  // Streets of the ward
  const ROADS = {
    r1: { name: "8th Cross Road", type: "street" },
    r2: { name: "College Road",   type: "street" },
    r3: { name: "Market Road",    type: "street" },
    r4: { name: "Chord Road",     type: "main" },
    cA: { name: "1st Main Road",  type: "lane" },
    cB: { name: "4th Main Road",  type: "street" },
    cC: { name: "Metro Road",     type: "main" },
    cD: { name: "Temple Road",    type: "street" },
    dg: { name: "Shortcut Lane",  type: "lane" },
  };

  // Junctions: column A-D × row 1-4, plus the hub and the 5 stalls
  const X = { A: 0.05, B: 0.36, C: 0.67, D: 0.95 };
  const Y = { 1: 0.08, 2: 0.38, 3: 0.66, 4: 0.93 };
  const COL_ROAD = { A: "cA", B: "cB", C: "cC", D: "cD" };
  const ROW_ROAD = { 1: "r1", 2: "r2", 3: "r3", 4: "r4" };

  const NODES = {};
  for (const c of "ABCD") for (const r of "1234") {
    NODES[c + r] = { x: X[c], y: Y[r], label: `${ROADS[COL_ROAD[c]].name} × ${ROADS[ROW_ROAD[r]].name}` };
  }
  NODES.HUB = { x: 0.52, y: 0.93, label: "Ward hub" };
  NODES.S1 = { x: 0.20, y: 0.08, label: "Ravi's stall" };
  NODES.S2 = { x: 0.81, y: 0.08, label: "Manjula's stall" };
  NODES.S3 = { x: 0.95, y: 0.52, label: "Imran's stall" };
  NODES.S4 = { x: 0.20, y: 0.66, label: "Lakshmamma's stall" };
  NODES.S5 = { x: 0.52, y: 0.38, label: "Suresh's stall" };

  // Road segments: [from, to, road]. Two-way roads.
  const SEGMENTS = [
    ["A1", "S1", "r1"], ["S1", "B1", "r1"], ["B1", "C1", "r1"], ["C1", "S2", "r1"], ["S2", "D1", "r1"],
    ["A2", "B2", "r2"], ["B2", "S5", "r2"], ["S5", "C2", "r2"], ["C2", "D2", "r2"],
    ["A3", "S4", "r3"], ["S4", "B3", "r3"], ["B3", "C3", "r3"], ["C3", "D3", "r3"],
    ["A4", "B4", "r4"], ["B4", "HUB", "r4"], ["HUB", "C4", "r4"], ["C4", "D4", "r4"],
    ["A1", "A2", "cA"], ["A2", "A3", "cA"], ["A3", "A4", "cA"],
    ["B2", "B3", "cB"], ["B3", "B4", "cB"],            // no road between B1 and B2 (a big block)
    ["C1", "C2", "cC"], ["C2", "C3", "cC"], ["C3", "C4", "cC"],
    ["D1", "D2", "cD"], ["D2", "S3", "cD"], ["S3", "D3", "cD"], ["D3", "D4", "cD"],
    ["B3", "C2", "dg"],
  ];

  const km = (a, b) => Math.hypot((NODES[a].x - NODES[b].x) * MAP_W_KM, (NODES[a].y - NODES[b].y) * MAP_H_KM);

  // Build the graph (adjacency list). Each edge knows its km and minutes.
  function buildGraph(heavyTraffic) {
    const g = {};
    for (const id in NODES) g[id] = [];
    for (const [a, b, road] of SEGMENTS) {
      const type = ROADS[road].type;
      const speed = road === "r4" && heavyTraffic ? TRAFFIC_SPEED : SPEED[type];
      const d = km(a, b);
      const e = { km: d, min: (d / speed) * 60, road };
      g[a].push({ to: b, ...e });
      g[b].push({ to: a, ...e });
    }
    return g;
  }

  // ---------- DIJKSTRA'S ALGORITHM ----------
  // From one start node, find the cheapest cost to every node.
  // cost = "km" (shortest distance) or "min" (fastest time).
  function dijkstra(graph, start, cost) {
    const dist = {}, prev = {}, done = new Set();
    for (const id in graph) dist[id] = Infinity;
    dist[start] = 0;

    while (done.size < Object.keys(graph).length) {
      // 1. pick the unvisited node with the smallest known cost
      let u = null;
      for (const id in dist) if (!done.has(id) && (u === null || dist[id] < dist[u])) u = id;
      if (u === null || dist[u] === Infinity) break;
      done.add(u);
      // 2. relax its edges: is going through u cheaper for each neighbour?
      for (const edge of graph[u]) {
        const alt = dist[u] + edge[cost];
        if (alt < dist[edge.to]) { dist[edge.to] = alt; prev[edge.to] = u; }
      }
    }
    return { dist, prev };
  }

  // Walk back from the end to the start to get the node path
  function pathTo(prev, start, end) {
    const path = [end];
    while (path[0] !== start) {
      const p = prev[path[0]];
      if (p === undefined) return null;
      path.unshift(p);
    }
    return path;
  }

  // Measure a path in both km and minutes
  function measure(graph, path) {
    let k = 0, m = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const e = graph[path[i]].find(x => x.to === path[i + 1]);
      k += e.km; m += e.min;
    }
    return { km: k, min: m };
  }

  // ---------- TRAVELLING SALESMAN PROBLEM (TSP) ----------
  // The driver starts at the hub, must visit EVERY waiting stall exactly once,
  // and come back to the hub. Which order gives the smallest total trip?
  // That is the Travelling Salesman Problem.
  //
  // Step 1. Distance matrix: the road cost between every pair of points
  //         (hub + stalls). Roads are not straight lines, so each cell is the
  //         shortest road path between the two points (found with Dijkstra).
  // Step 2. Solve the TSP on that matrix:
  //         - up to 12 stops: Held–Karp dynamic programming (EXACT optimum)
  //         - more stops:     nearest-neighbour tour, improved with 2-opt
  const EXACT_LIMIT = 12;

  function tourCost(M, tour) {          // tour = [0, a, b, ..., 0]
    let t = 0;
    for (let i = 0; i < tour.length - 1; i++) t += M[tour[i]][tour[i + 1]];
    return t;
  }

  // Held–Karp: best[mask][j] = cheapest way to start at the hub (index 0),
  // visit exactly the stops in "mask", and end at stop j.
  // best[mask][j] = min over k in mask (k ≠ j) of best[mask without j][k] + M[k][j]
  // Runs in O(n² · 2ⁿ) instead of trying all n! orders.
  function heldKarp(M) {
    const n = M.length - 1;               // stops are 1..n, hub is 0
    if (n === 0) return { tour: [0], cost: 0, states: 0 };
    const FULL = 1 << n;
    const best = Array.from({ length: FULL }, () => new Array(n + 1).fill(Infinity));
    const parent = Array.from({ length: FULL }, () => new Array(n + 1).fill(-1));
    let states = 0;
    for (let j = 1; j <= n; j++) best[1 << (j - 1)][j] = M[0][j];
    for (let mask = 1; mask < FULL; mask++) {
      for (let j = 1; j <= n; j++) {
        if (!(mask & (1 << (j - 1))) || best[mask][j] === Infinity) continue;
        states++;
        for (let k = 1; k <= n; k++) {            // extend the path to stop k
          if (mask & (1 << (k - 1))) continue;
          const next = mask | (1 << (k - 1)), c = best[mask][j] + M[j][k];
          if (c < best[next][k]) { best[next][k] = c; parent[next][k] = j; }
        }
      }
    }
    let end = 1, cost = Infinity;          // close the loop back to the hub
    for (let j = 1; j <= n; j++) { const c = best[FULL - 1][j] + M[j][0]; if (c < cost) { cost = c; end = j; } }
    const tour = [0];
    for (let mask = FULL - 1, j = end; j !== -1 && j !== 0; ) {   // walk the parents back
      tour.splice(1, 0, j);
      const pj = parent[mask][j];
      mask &= ~(1 << (j - 1)); j = pj;
    }
    tour.push(0);
    return { tour, cost, states };
  }

  // Heuristic for big days: nearest stop next, then 2-opt (reverse a section
  // of the tour whenever that makes it shorter, until no reversal helps).
  function nearestNeighbour(M) {
    const n = M.length - 1, left = new Set(Array.from({ length: n }, (_, i) => i + 1)), tour = [0];
    let here = 0;
    while (left.size) {
      let pick = null;
      for (const k of left) if (pick === null || M[here][k] < M[here][pick]) pick = k;
      tour.push(pick); left.delete(pick); here = pick;
    }
    tour.push(0);
    return tour;
  }
  function twoOpt(M, tour) {
    let t = tour.slice(), improved = true;
    while (improved) {
      improved = false;
      for (let i = 1; i < t.length - 2; i++) for (let k = i + 1; k < t.length - 1; k++) {
        const cand = [...t.slice(0, i), ...t.slice(i, k + 1).reverse(), ...t.slice(k + 1)];
        if (tourCost(M, cand) < tourCost(M, t) - 1e-9) { t = cand; improved = true; }
      }
    }
    return t;
  }

  function solveTSP(M) {
    const n = M.length - 1;
    if (n <= EXACT_LIMIT) { const r = heldKarp(M); return { ...r, method: "Held–Karp dynamic programming (exact)" }; }
    const tour = twoOpt(M, nearestNeighbour(M));
    return { tour, cost: tourCost(M, tour), method: "Nearest neighbour + 2-opt (heuristic)" };
  }

  // ---------- THE DRIVER'S ROUTE ----------
  // stops: stall node ids in the order they were requested. Returns the TSP
  // order, every leg's road path, totals, the distance matrix, and how much
  // shorter the TSP tour is than simply going in request order.
  function plan(stops, { cost = "min", heavyTraffic = false } = {}) {
    const graph = buildGraph(heavyTraffic);
    const points = ["HUB", ...new Set(stops)];

    // Step 1: distance matrix (shortest road path between every pair)
    const runs = {};
    for (const p of points) runs[p] = dijkstra(graph, p, cost);
    const M = points.map(a => points.map(b => runs[a].dist[b]));

    // Step 2: solve the TSP
    const tsp = solveTSP(M);
    const order = tsp.tour.slice(1, -1).map(i => points[i]);
    const requestTour = [0, ...points.slice(1).map((_, i) => i + 1), ...(points.length > 1 ? [0] : [])];
    const requestCost = points.length > 1 ? tourCost(M, requestTour) : 0;

    // Legs: hub → stop1 → stop2 → … → hub, each along real roads
    const seq = ["HUB", ...order, ...(order.length ? ["HUB"] : [])];
    const legs = [];
    for (let i = 0; i < seq.length - 1; i++) {
      const path = pathTo(runs[seq[i]].prev, seq[i], seq[i + 1]);
      legs.push({ from: seq[i], to: seq[i + 1], path, ...measure(graph, path) });
    }
    const totalKm = legs.reduce((s, l) => s + l.km, 0);
    const driveMin = legs.reduce((s, l) => s + l.min, 0);
    return {
      order, legs, totalKm, driveMin, totalMin: driveMin + SERVICE_MIN * order.length,
      tsp: { method: tsp.method, cost: tsp.cost, requestCost, unit: cost, points, matrix: M, states: tsp.states ?? null },
    };
  }

  return { NODES, ROADS, SEGMENTS, SPEED, TRAFFIC_SPEED, SERVICE_MIN, MAP_W_KM, EXACT_LIMIT, buildGraph, dijkstra, pathTo, measure, tourCost, heldKarp, nearestNeighbour, twoOpt, solveTSP, plan };
})();
if (typeof module !== "undefined") module.exports = Route;
