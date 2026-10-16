// =====================================================================
// PLANNER: smart pickup priorities, zones and driver assignment
// ---------------------------------------------------------------------
// Transparent rules, not a black box:
//   priority = 50% waiting time + 30% quantity + 20% closeness to hub
//     waiting time : minutes since request, full marks at 120 min
//     quantity     : estimated kg (sacks × 22), full marks at 150 kg
//     closeness    : Dijkstra travel time from the hub, 0 min = full, 20+ min = none
//   zones: stalls within 6 minutes of each other (Dijkstra travel time)
//          are grouped so one driver can serve them together
//   auto-assign: highest priority first; prefer the driver already
//          serving that zone; never exceed the cart's capacity (kg)
// Travel times come from the CocoLoop ward road model in route.js
// (schematic roads, not GPS).
// =====================================================================

const Planner = (() => {
  const W_WAIT = 0.5, W_QTY = 0.3, W_NEAR = 0.2;
  const ZONE_MIN = 6;

  // Dijkstra travel time (minutes) from the hub to every node
  function travelFromHub() {
    return Route.dijkstra(Route.buildGraph(false), "HUB", "min").dist;
  }

  // Score requested pickups. vendorNode(p) -> stall node id
  function score(pickups, vendorNode, now = Date.now()) {
    const fromHub = travelFromHub();
    return pickups.map(p => {
      const waitMin = Math.max(0, (now - p.requestedAt) / 60000);
      const estKg = p.estKg || p.sacks * 22;
      const travel = fromHub[vendorNode(p)] ?? 20;
      const parts = {
        wait: Math.min(waitMin / 120, 1) * W_WAIT,
        qty: Math.min(estKg / 150, 1) * W_QTY,
        near: (1 - Math.min(travel / 20, 1)) * W_NEAR,
      };
      const total = Math.round((parts.wait + parts.qty + parts.near) * 100);
      const reasons = [
        `waiting ${Math.round(waitMin)} min (+${Math.round(parts.wait * 100)})`,
        `~${Math.round(estKg)} kg estimated (+${Math.round(parts.qty * 100)})`,
        `${travel.toFixed(0)} min from hub (+${Math.round(parts.near * 100)})`,
      ];
      return { pickup: p, score: total, waitMin, estKg, travel, parts, reasons };
    }).sort((a, b) => b.score - a.score);
  }

  // Group stall nodes into zones (single-linkage on Dijkstra travel time)
  function zones(nodes) {
    const g = Route.buildGraph(false);
    const times = {};
    for (const n of nodes) times[n] = Route.dijkstra(g, n, "min").dist;
    const zoneOf = {}; let next = 0;
    for (const n of nodes) {
      if (zoneOf[n] !== undefined) continue;
      const id = next++; const stack = [n]; zoneOf[n] = id;
      while (stack.length) {
        const a = stack.pop();
        for (const b of nodes) if (zoneOf[b] === undefined && times[a][b] <= ZONE_MIN) { zoneOf[b] = id; stack.push(b); }
      }
    }
    return zoneOf;   // node -> zone number
  }

  // Suggest assignments for requested pickups.
  // drivers: [{id, capacityKg, loadKg, zones:Set}] (current load from already-assigned pickups)
  // returns [{pickup, driverId|null, reason}]
  function autoAssign(scored, drivers, vendorNode) {
    const zoneOf = zones([...new Set(scored.map(s => vendorNode(s.pickup)))].concat(
      drivers.flatMap(d => [...d.nodes])));
    const state = drivers.map(d => ({ ...d, zoneSet: new Set([...d.nodes].map(n => zoneOf[n])) }));
    return scored.map(s => {
      const z = zoneOf[vendorNode(s.pickup)];
      const fits = state.filter(d => d.capacityKg - d.loadKg >= s.estKg);
      if (!fits.length) return { pickup: s.pickup, driverId: null, reason: "No cart has enough space left; keep for the next trip" };
      const sameZone = fits.filter(d => d.zoneSet.has(z));
      const pick = (sameZone.length ? sameZone : fits).sort((a, b) => (b.capacityKg - b.loadKg) - (a.capacityKg - a.loadKg))[0];
      pick.loadKg += s.estKg; pick.zoneSet.add(z);
      return { pickup: s.pickup, driverId: pick.id, reason: sameZone.length ? "Same zone as this driver's other stops" : "Most free space in the cart" };
    });
  }

  return { score, zones, autoAssign, weights: { wait: W_WAIT, qty: W_QTY, near: W_NEAR }, ZONE_MIN };
})();
if (typeof module !== "undefined") module.exports = Planner;
