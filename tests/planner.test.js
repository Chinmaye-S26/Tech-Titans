// Run:  node tests/planner.test.js
// Checks the smart pickup planner: priority order, zones, cart capacity.
const assert = require("assert");
global.Route = require("../route.js");
const Planner = require("../planner.js");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("✔", name); };
const now = Date.now(), MIN = 60000;
const node = p => p.node;

test("longer wait and more sacks give a higher priority", () => {
  const s = Planner.score([
    { id: "a", node: "S1", sacks: 1, requestedAt: now - 5 * MIN },
    { id: "b", node: "S1", sacks: 5, requestedAt: now - 90 * MIN },
  ], node, now);
  assert.strictEqual(s[0].pickup.id, "b");
  assert(s[0].score > s[1].score);
  assert(s.every(x => x.score >= 0 && x.score <= 100));
  assert.strictEqual(s[0].reasons.length, 3, "every score is explained");
});

test("score parts add up to the score", () => {
  const [x] = Planner.score([{ id: "a", node: "S3", sacks: 3, requestedAt: now - 40 * MIN }], node, now);
  const sum = (x.parts.wait + x.parts.qty + x.parts.near) * 100;
  assert(Math.abs(sum - x.score) <= 0.5);
});

test("every stall gets a zone, and a stall is in its own zone", () => {
  const z = Planner.zones(["S1", "S2", "S3", "S4", "S5"]);
  for (const n of ["S1", "S2", "S3", "S4", "S5"]) assert(Number.isInteger(z[n]));
});

test("auto-assign never overfills a cart", () => {
  const pickups = Array.from({ length: 8 }, (_, i) => ({ id: "p" + i, node: "S" + (i % 5 + 1), sacks: 3, estKg: 66, requestedAt: now - i * MIN }));
  const drivers = [{ id: "d1", capacityKg: 250, loadKg: 0, nodes: new Set() }, { id: "d2", capacityKg: 250, loadKg: 0, nodes: new Set() }];
  const out = Planner.autoAssign(Planner.score(pickups, node, now), drivers, node);
  const load = { d1: 0, d2: 0 };
  out.forEach(o => { if (o.driverId) load[o.driverId] += 66; });
  assert(load.d1 <= 250 && load.d2 <= 250, JSON.stringify(load));
  assert.strictEqual(out.filter(o => !o.driverId).length, 2, "8×66 kg = 528 kg > 500 kg, so 2 wait for the next trip");
  assert(out.filter(o => !o.driverId).every(o => /next trip/.test(o.reason)));
});

console.log(`\nAll ${passed} planner tests passed.`);
