// =====================================================================
// CocoLoop app logic
//   1. Settings: stalls, drivers, statuses
//   2. Helpers and facts
//   3. Route planner (Travelling Salesman Problem, route.js)
//   4. Ward road map
//   5. Screens: Sign-in, Vendor, Driver, Hub, AI Insights (owner), IVR Call
//   6. Voice assistant
//   7. IVR call flow
//   8. Actions (assign, collect, confirm, sample data)
//   9. Clicks and inputs
//  10. Start the app
//
// Pickup lifecycle (never skips a step):
//   requested (vendor) -> assigned (hub picks a driver) -> collected (driver
//   weighs at the stall) -> confirmed (hub confirms the weight; payment recorded)
// Earnings are ONLY from confirmed, weighed kg × ₹1/kg. Never from estimates.
// =====================================================================

// ---------- 1. SETTINGS ----------
const RATE = 1;            // ₹ paid to the vendor per kg of shells (actual weight)
const KG_PER_SACK = 22;    // used only for ESTIMATES before weighing
const CART_KG = 250;       // e-cart capacity in kg
const HELPLINE = "1800-COCO-LOOP (demo)";

const VENDORS = [
  { id: "v1", name: "Ravi",       stall: "8th Cross Road", node: "S1", phone: "+91 ••••• ••101" },
  { id: "v2", name: "Manjula",    stall: "Bus Stand",      node: "S2", phone: "+91 ••••• ••102" },
  { id: "v3", name: "Imran",      stall: "Temple Road",    node: "S3", phone: "+91 ••••• ••103" },
  { id: "v4", name: "Lakshmamma", stall: "Market Gate",    node: "S4", phone: "+91 ••••• ••104" },
  { id: "v5", name: "Suresh",     stall: "College Gate",   node: "S5", phone: "+91 ••••• ••105" },
];
for (const v of VENDORS) { v.x = Route.NODES[v.node].x; v.y = Route.NODES[v.node].y; }
const vendorById = Object.fromEntries(VENDORS.map(v => [v.id, v]));

const DRIVERS = [
  { id: "d1", name: "Mahesh", cart: "E-cart 1" },
  { id: "d2", name: "Kiran",  cart: "E-cart 2" },
];
const driverById = Object.fromEntries(DRIVERS.map(d => [d.id, d]));

const SOURCE_LABEL = { app: "App", voice: "Voice", ivr: "IVR call" };
const STATUS = {
  requested: { label: "Waiting for driver", chip: "pending" },
  assigned:  { label: "Driver assigned",    chip: "assigned" },
  collected: { label: "Collected · awaiting hub", chip: "collected" },
  confirmed: { label: "Confirmed · paid",   chip: "done" },
};
const ACTIVE = ["requested", "assigned", "collected"];
const TAB_LABEL = { insights: "AI Insights", hub: "Hub", driver: "Driver", vendor: "Vendor", ivr: "IVR Call" };

// App state
let pickups = [];
let tab = null;
let vendorId = "v1";
let driverId = "d1";
let sacks = 3;
let confirmReset = false;
let firstLoad = true;
let userDir = null;                       // Firebase only: {driver:{d1:uid}, vendor:{v1:uid}}
const typedWeights = {}, confirmWeights = {}, assignChoice = {};
const lastStatus = {};
const routeOpts = { cost: "min", heavyTraffic: false };
const insightsOpts = { allowSample: true };
const photo = { url: null, name: "", type: "" };
const signIn = { error: "", busy: false };

const voice = { typed: "", lang: "en", listening: false, heard: "", reply: "", action: null, pendingSacks: null, updates: true, rec: null };
const ivr = { state: "idle", lang: "en", caller: "v1", digits: "", sacks: 0, prompt: "", log: [], speak: true };

// ---------- 2. HELPERS AND FACTS ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const time = ms => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const dayLabel = k => ML.fromKey(k).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const rupees = n => "₹" + Math.round(n).toLocaleString("en-IN");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sum = (list, f) => list.reduce((s, x) => s + (f(x) || 0), 0);
const isToday = ms => ms && ML.dateKey(ms) === ML.dateKey(Date.now());
const me = () => Auth.user();
const isRole = r => me() && me().role === r;
const chip = p => `<span class="chip ${STATUS[p.status]?.chip || ""}">${esc(STATUS[p.status]?.label || p.status)}</span>${p.sample ? ` <span class="chip sample">Sample</span>` : ""}`;

function toast(message) {
  const t = $("#toast");
  t.textContent = message; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3600);
}

// The account id stored on a pickup (used by Firebase security rules)
function uidFor(kind, id) {
  const u = me();
  if (Auth.mode() !== "firebase") return `demo-${id}`;
  if (u && u.role === kind && (u.vendorId === id || u.driverId === id)) return u.uid;
  return (userDir && userDir[kind] && userDir[kind][id]) || null;
}

function vendorFacts(id) {
  const mine = pickups.filter(p => p.vendor === id);
  const confirmed = mine.filter(p => p.status === "confirmed");
  const confirmedToday = confirmed.filter(p => isToday(p.confirmedAt));
  return {
    open: mine.find(p => ACTIVE.includes(p.status)),
    confirmed,
    earnedToday: sum(confirmedToday, p => p.payout),
    earnedTotal: sum(confirmed, p => p.payout),
    kgTotal: Math.round(sum(confirmed, p => p.actualKg) * 10) / 10,
    awaitingKg: Math.round(sum(mine.filter(p => p.status === "collected"), p => p.actualKg) * 10) / 10,
    last: [...confirmed].sort((a, b) => b.confirmedAt - a.confirmedAt)[0],
  };
}

async function bookPickup(id, n, source) {
  if (!Number.isInteger(n) || n < 1 || n > 20) return { ok: false, reason: "Sacks must be a whole number from 1 to 20." };
  if (vendorFacts(id).open) return { ok: false, reason: "This stall already has a pickup in progress." };
  const doc = { vendor: id, vendorUid: uidFor("vendor", id), sacks: n, estKg: n * KG_PER_SACK, status: "requested", requestedAt: Date.now(), source };
  if (photo.type && source !== "ivr") doc.shellType = photo.type;
  await Store.add(doc);
  return { ok: true };
}

// ---------- 3. ROUTE PLANNER (TSP, in route.js) ----------
const fmtKm = k => `${k.toFixed(1)} km`;
const fmtMin = m => `${Math.max(1, Math.round(m))} min`;

// One driver's route through their ASSIGNED pickups
function planRoute(dId) {
  const mine = pickups.filter(p => p.status === "assigned" && p.driverId === dId && vendorById[p.vendor])
    .sort((a, b) => a.requestedAt - b.requestedAt);   // request order, to compare with the TSP order
  const byNode = {};
  for (const p of mine) byNode[vendorById[p.vendor].node] = p;
  const r = Route.plan(Object.keys(byNode), routeOpts);
  let clock = 0;
  const order = r.order.map((node, i) => {
    const leg = r.legs[i];
    clock += leg.min;
    const arriveIn = clock;
    clock += Route.SERVICE_MIN;
    const pickup = byNode[node];
    return { pickup, vendor: vendorById[pickup.vendor], leg, arriveIn };
  });
  return { ...r, order, km: r.totalKm, loadKg: sum(mine, p => p.estKg || p.sacks * KG_PER_SACK) };
}

// When will the assigned driver reach this vendor? (null unless a driver is assigned)
function etaFor(vId) {
  const p = pickups.find(x => x.vendor === vId && x.status === "assigned");
  if (!p) return null;
  const r = planRoute(p.driverId);
  const i = r.order.findIndex(s => s.vendor.id === vId);
  if (i < 0) return null;
  return { stop: i + 1, of: r.order.length, min: Math.max(1, Math.round(r.order[i].arriveIn)), at: Date.now() + r.order[i].arriveIn * 60e3, driver: driverById[p.driverId] };
}

// ---------- 4. WARD ROAD MAP (SVG) ----------
function drawMap({ routeFor = null, showHotspots = false } = {}) {
  const W = 400, H = 260, X = x => (x * W).toFixed(1), Y = y => (y * H).toFixed(1);
  const N = Route.NODES;
  const width = { main: 9, street: 6, lane: 4 };
  let svg = `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ward road map with stalls and route">`;
  svg += `<rect width="${W}" height="${H}" fill="var(--block)"/>`;
  for (const t of ["lane", "street", "main"]) for (const [a, b, road] of Route.SEGMENTS) {
    if (Route.ROADS[road].type !== t) continue;
    const jam = routeOpts.heavyTraffic && road === "r4";
    svg += `<line x1="${X(N[a].x)}" y1="${Y(N[a].y)}" x2="${X(N[b].x)}" y2="${Y(N[b].y)}" stroke="${jam ? "var(--jam)" : "var(--road)"}" stroke-width="${width[t]}" stroke-linecap="round"/>`;
  }
  const names = [["Chord Road", .70, .93 + .055], ["Metro Road", .67 + .025, .52, 90], ["8th Cross Road", .52, .08 - .03], ["College Road", .19, .38 - .03], ["Market Road", .52, .66 - .03], ["Temple Road", .95 - .025, .26, 90], ["1st Main", .05 + .025, .80, 90], ["Shortcut Lane", .47, .58, -42]];
  const nameBoxes = [];   // keep distance/time labels from covering road names
  for (const [t, x, y, rot] of names) {
    if (!rot) nameBoxes.push([x * W - t.length * 2.4, y * H - 8, t.length * 4.8, 10]);
    svg += `<text x="${X(x)}" y="${Y(y)}" ${rot ? `transform="rotate(${rot} ${X(x)} ${Y(y)})"` : ""} text-anchor="middle" font-size="8.5" fill="var(--muted)" font-family="Figtree, system-ui, sans-serif" font-style="italic">${t}</text>`;
  }

  let r = null;
  if (routeFor) {
    r = planRoute(routeFor);
    const legPts = leg => leg.path.map(id => `${X(N[id].x)},${Y(N[id].y)}`).join(" ");
    r.legs.forEach((leg, i) => {
      const back = i === r.legs.length - 1;
      svg += `<polyline points="${legPts(leg)}" fill="none" stroke="var(--route)" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round" ${back ? 'stroke-dasharray="6 5" opacity=".7"' : ""}/>`;
    });
    const taken = VENDORS.flatMap(v => {
      const right = v.x > 0.7, below = v.y < 0.2, nx = v.x * W, ny = v.y * H, tw = v.name.length * 6.6;
      return [[nx - 12, ny - 12, 24, 24], [right ? nx - 14 - tw : nx + 14, ny + (below ? 7 : -21), tw, 15]];
    });
    taken.push([N.HUB.x * W - 18, N.HUB.y * H - 13, 36, 26], ...nameBoxes);
    const hit = b1 => taken.some(b2 => b1[0] < b2[0] + b2[2] && b2[0] < b1[0] + b1[2] && b1[1] < b2[1] + b2[3] && b2[1] < b1[1] + b1[3]);
    const pointAt = (pts, frac) => {
      const segs = []; let total = 0;
      for (let j = 0; j < pts.length - 1; j++) { const d = Math.hypot((pts[j + 1].x - pts[j].x) * W, (pts[j + 1].y - pts[j].y) * H); segs.push(d); total += d; }
      let left = total * frac, j = 0;
      while (j < segs.length - 1 && left > segs[j]) { left -= segs[j]; j++; }
      const t = segs[j] ? left / segs[j] : 0;
      return { x: (pts[j].x + (pts[j + 1].x - pts[j].x) * t) * W, y: (pts[j].y + (pts[j + 1].y - pts[j].y) * t) * H };
    };
    r.legs.forEach((leg, i) => {
      const pts = leg.path.map(id => N[id]);
      const dest = i === r.legs.length - 1 ? "Hub" : String(i + 1);
      const label = `→${dest}  ${fmtKm(leg.km)} · ${fmtMin(leg.min)}`;
      const w = label.length * 5.4 + 10, h = 16;
      let box = null;
      for (const f of [0.5, 0.35, 0.65, 0.22, 0.78, 0.42, 0.58, 0.12, 0.88]) {
        const c = pointAt(pts, f);
        const cand = [Math.min(Math.max(c.x - w / 2, 2), W - w - 2), Math.min(Math.max(c.y - h / 2, 2), H - h - 2), w, h];
        if (!hit(cand)) { box = cand; break; }
      }
      if (!box) { const c = pointAt(pts, 0.5); box = [Math.min(Math.max(c.x - w / 2, 2), W - w - 2), Math.min(Math.max(c.y - h / 2 + 14, 2), H - h - 2), w, h]; }
      taken.push(box);
      svg += `<g><rect x="${box[0].toFixed(1)}" y="${box[1].toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="8" fill="var(--surface)" stroke="var(--route)" stroke-width="1.2"/><text x="${(box[0] + w / 2).toFixed(1)}" y="${(box[1] + 11.5).toFixed(1)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--route)" font-family="Figtree, system-ui, sans-serif">${label}</text></g>`;
    });
  }

  for (const v of VENDORS) {
    const mine = pickups.filter(p => p.vendor === v.id);
    const active = mine.some(p => ACTIVE.includes(p.status));
    const kg = sum(mine.filter(p => p.status === "confirmed"), p => p.actualKg);
    const colour = active ? "var(--ember)" : mine.length ? "var(--ok)" : "var(--muted)";
    if (showHotspots && kg > 0) svg += `<circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${Math.min(34, 10 + Math.sqrt(kg) * 2.2)}" fill="var(--ok)" opacity=".18"/>`;
    const stopNo = r ? r.order.findIndex(s => s.vendor.id === v.id) + 1 : 0;
    svg += `<g${active && !stopNo ? ' class="pulse"' : ""}><circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${stopNo ? 10 : 8}" fill="${colour}" stroke="var(--surface)" stroke-width="3"/>${stopNo ? `<text x="${X(v.x)}" y="${(v.y * H + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="800" fill="#fff" font-family="Figtree, system-ui, sans-serif">${stopNo}</text>` : ""}</g>`;
    const right = v.x > 0.7, below = v.y < 0.2;
    svg += `<text x="${(v.x * W + (right ? -14 : 14)).toFixed(1)}" y="${(v.y * H + (below ? 18 : -10)).toFixed(1)}" text-anchor="${right ? "end" : "start"}" font-size="11.5" font-weight="700" fill="var(--fg)" stroke="var(--block)" stroke-width="3" paint-order="stroke" font-family="Figtree, system-ui, sans-serif">${esc(v.name)}</text>`;
  }
  const hub = N.HUB;
  svg += `<rect x="${(hub.x * W - 16).toFixed(1)}" y="${(hub.y * H - 11).toFixed(1)}" width="32" height="22" rx="5" fill="var(--palm)" stroke="var(--surface)" stroke-width="2"/><text x="${X(hub.x)}" y="${(hub.y * H + 4).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="800" fill="var(--palm-ink)" font-family="Figtree, system-ui, sans-serif">HUB</text></svg>`;
  return svg;
}
const LEGEND = `<div class="legend"><span><b style="background:var(--ember)"></b>Pickup in progress</span><span><b style="background:var(--ok)"></b>Collected (confirmed)</span><span><b style="background:var(--muted)"></b>No request yet</span></div>`;
const ROUTE_LEGEND = `<div class="legend"><span><b class="line"></b>TSP route along roads</span><span><b class="line dash"></b>Back to hub</span><span><b style="background:var(--ember)"></b>Numbered stops</span></div>`;
const MODEL_NOTE = `<p class="hint">Distances and times come from the CocoLoop ward road model (schematic roads with typical speeds), not live GPS.</p>`;

// ---------- 5. SCREENS ----------

// 5.0 Sign-in
function signInScreen() {
  const u = me();
  if (Auth.mode() === "firebase" && u && !u.role) {
    return `<section class="panel stack narrow">
      <h2>Your account has no role yet</h2>
      <p>${esc(u.error || "The owner needs to give this account a role before you can use CocoLoop.")}</p>
      <p class="hint">Send the owner your user ID: <code>${esc(u.uid)}</code>. They add it in Firestore as <code>users/${esc(u.uid)}</code> with a role (see README, "Firebase setup").</p>
      <button class="btn ghost" id="signOutBtn2">Sign out</button></section>`;
  }
  if (Auth.mode() === "firebase") {
    return `<section class="panel stack narrow">
      <p class="eyebrow">Secure sign-in · Firebase</p><h2>Sign in to CocoLoop</h2>
      <form id="emailForm" class="stack">
        <div><label class="f" for="email">Email</label><input id="email" type="email" autocomplete="username" value="${esc(signIn.email || "")}" required></div>
        <div><label class="f" for="password">Password</label><input id="password" type="password" autocomplete="current-password" required></div>
        ${signIn.error ? `<p class="err">${esc(signIn.error)}</p>` : ""}
        <button class="btn" type="submit"${signIn.busy ? " disabled" : ""}>${signIn.busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p class="hint">Accounts are created by the owner in the Firebase console. No account yet?</p>
      <button class="btn ghost" id="useDemo">Use demo mode on this device instead</button></section>`;
  }
  const group = r => Auth.DEMO_USERS.filter(x => x.role === r).map(x =>
    `<button class="userbtn" data-demo-user="${x.uid}"><b>${esc(x.name)}</b><span>${Auth.ROLE_NAME[x.role]}${x.vendorId ? " · " + esc(vendorById[x.vendorId].stall) : ""}</span></button>`).join("");
  return `<section class="stack">
    <div class="banner warn"><b>Demo sign-in, not secure.</b> ${Auth.firebaseConfigured() ? "You chose demo mode on this device" : "Firebase is not set up yet"}, so anyone can choose any role here and ${location.protocol.startsWith("http") ? "data is saved by the CocoLoop Python server if it is running (otherwise on this device)" : "data stays on this device"}. Real role-based security starts after the Firebase setup in the README.</div>
    <h2>Choose who you are (demo)</h2>
    <div class="usergrid">
      <div><p class="eyebrow">Owner</p>${group("owner")}</div>
      <div><p class="eyebrow">Hub staff</p>${group("hub")}</div>
      <div><p class="eyebrow">Drivers</p>${group("driver")}</div>
      <div><p class="eyebrow">Vendors</p>${group("vendor")}</div>
    </div></section>`;
}

// 5a. Vendor
function vendorScreen() {
  const locked = isRole("vendor");
  if (locked) vendorId = me().vendorId;
  const v = vendorById[vendorId];
  const f = vendorFacts(vendorId);
  const o = f.open;

  let status;
  if (o && o.status === "requested") status = `<div class="status"><div class="dot pending">…</div><div><h3>Waiting for a driver</h3><p class="hint">${plural(o.sacks, "sack")} (about ${o.estKg || o.sacks * KG_PER_SACK} kg, estimate) · requested ${time(o.requestedAt)}. The hub will assign a driver.</p></div></div>`;
  else if (o && o.status === "assigned") {
    const eta = etaFor(vendorId);
    status = `<div class="status"><div class="dot assigned">🛺</div><div><h3>${esc(driverById[o.driverId]?.name || "Driver")} is coming${eta ? ` · about ${eta.min} min` : ""}</h3><p class="hint">${plural(o.sacks, "sack")}${eta ? ` · stop ${eta.stop} of ${eta.of} · expected by ${time(eta.at)}` : ""}</p></div></div>`;
  } else if (o && o.status === "collected") status = `<div class="status"><div class="dot collected">⚖</div><div><h3>Collected ${o.actualKg} kg · waiting for hub confirmation</h3><p class="hint">Your payment is added after the hub confirms the weight.</p></div></div>`;
  else if (f.last) status = `<div class="status"><div class="dot done">✓</div><div><h3>Stall is clean</h3><p class="hint">Last confirmed pickup: ${f.last.actualKg} kg on ${new Date(f.last.confirmedAt).toLocaleDateString("en-IN")} · ${rupees(f.last.payout)} added</p></div></div>`;
  else status = `<div class="status"><div class="dot none">+</div><div><h3>No pickups yet</h3><p class="hint">When shells pile up, request a pickup. It's free.</p></div></div>`;

  const micLabel = voice.listening ? "Listening… tap to stop" : "Tap and speak";
  const examples = voice.lang === "kn" ? "ಉದಾ: “ಮೂರು ಚೀಲ ಇದೆ”, “ನನ್ನ ಗಳಿಕೆ ಎಷ್ಟು?”, “ಪಿಕಪ್ ಎಲ್ಲಿದೆ?”" : "Try: “3 sacks ready”, “How much did I earn?”, “Where is my pickup?”";
  const knNote = voice.lang === "kn" && Voice.canSpeak && !Voice.hasKannadaVoice() ? `<p class="hint">This device has no Kannada voice installed, so replies are spoken in English. The Kannada text is shown here.</p>` : "";
  const confirm = voice.pendingSacks
    ? `<div class="confirmrow"><button class="btn" id="voiceConfirm">Confirm pickup · ${plural(voice.pendingSacks, "sack")}</button><button class="btn ghost" id="voiceCancel">Cancel</button></div>` : "";
  const action = voice.action ? `<p class="action"><span>Understood as</span> <code>${esc(JSON.stringify(voice.action))}</code></p>` : "";

  const photoBox = `<details class="photo"${photo.url ? " open" : ""}><summary>Shell photo (optional)</summary>
    <div class="stack">
      <p class="banner info">${esc(Classifier.status)}</p>
      <label class="btn ghost filebtn" for="photoIn">📷 Take or choose a photo</label>
      <input id="photoIn" type="file" accept="image/*" capture="environment" hidden>
      ${photo.url ? `<img class="preview" src="${photo.url}" alt="Shell photo preview">` : ""}
      <div><label class="f" for="shellType">What is in the sack? (you decide)</label>
        <select id="shellType"><option value="">Not specified</option>${Classifier.CATEGORIES.map(c => `<option value="${c.id}"${photo.type === c.id ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select></div>
      <p class="hint">The photo stays on this phone (it is not uploaded). Your choice is added to your next pickup request.</p>
    </div></details>`;

  return `
  <p class="eyebrow">Vendor app</p>
  <h2>Request a shell pickup</h2>
  <p class="lede">Tap, speak, or call the helpline. You get paid ${rupees(RATE)} per kg, using the weight measured at your stall and confirmed by the hub.</p>
  <div class="grid2">
    <section class="panel stack">
      ${locked ? `<div><span class="f">Your stall</span><p class="fixed">${esc(v.name)} · ${esc(v.stall)}</p></div>`
        : `<div><label class="f" for="vendorSel">Stall (owner view)</label><select id="vendorSel">${VENDORS.map(x => `<option value="${x.id}"${x.id === vendorId ? " selected" : ""}>${esc(x.name)} · ${esc(x.stall)}</option>`).join("")}</select></div>`}
      <div class="voicebox" aria-label="Voice assistant">
        <div class="voicehead">
          <h3>Voice assistant</h3>
          <div class="seg" role="group" aria-label="Voice language">
            <button data-vlang="en" aria-pressed="${voice.lang === "en"}">English</button>
            <button data-vlang="kn" aria-pressed="${voice.lang === "kn"}">ಕನ್ನಡ</button>
          </div>
        </div>
        <button class="mic${voice.listening ? " on" : ""}" id="micBtn" aria-label="${micLabel}">
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>
          <span>${micLabel}</span>
        </button>
        <p class="hint">${examples}</p>
        <p class="heard" id="heard">${voice.heard ? `You said: “${esc(voice.heard)}”` : ""}</p>
        ${action}
        ${voice.reply ? `<p class="reply">${esc(voice.reply)}</p>` : ""}
        ${knNote}
        ${confirm}
        <form id="typeForm" class="typerow">
          <label class="f" for="typeSay">No microphone? Type what you would say</label>
          <div class="typeinner"><input id="typeSay" type="text" autocomplete="off" placeholder="e.g. 4 sacks ready" value="${esc(voice.typed)}"><button class="btn small" type="submit">Send</button></div>
        </form>
        <label class="check"><input type="checkbox" id="voiceUpdates"${voice.updates ? " checked" : ""}> Speak updates about my pickup</label>
      </div>
      <div>
        <span class="f" id="sacksLbl">Or choose sacks</span>
        <div class="stepper" role="group" aria-labelledby="sacksLbl">
          <button id="minus" aria-label="One sack fewer">−</button>
          <output>${sacks}<small>about ${sacks * KG_PER_SACK} kg (estimate)</small></output>
          <button id="plus" aria-label="One sack more">+</button>
        </div>
      </div>
      <button class="btn" id="requestBtn"${o ? " disabled" : ""}>${o ? "Pickup in progress" : "Request pickup"}</button>
      ${photoBox}
    </section>
    <section class="panel stack">
      ${status}
      <div><p class="eyebrow">Earned today (confirmed) · ${esc(v.name)}</p><div class="money">${rupees(f.earnedToday)}</div><p class="hint">Paid weekly by UPI</p></div>
      <dl class="kv"><dt>Total earned (confirmed)</dt><dd>${rupees(f.earnedTotal)}</dd><dt>Shells collected (confirmed)</dt><dd>${f.kgTotal} kg</dd>
        <dt>Waiting for hub confirmation</dt><dd>${f.awaitingKg} kg</dd><dt>Rate</dt><dd>${rupees(RATE)} / kg</dd></dl>
      <p class="hint">Estimates (sacks × ${KG_PER_SACK} kg) are only for planning. Payment always uses the confirmed weight.</p>
    </section>
  </div>`;
}

// TSP explanation panel for the Driver screen
function tspPanel(r) {
  const N = Route.NODES, t = r.tsp, unit = t.unit === "min" ? "min" : "km";
  const fmt = v => unit === "min" ? fmtMin(v) : fmtKm(v);
  const short = id => id === "HUB" ? "Hub" : (VENDORS.find(v => v.node === id)?.name || id);
  const saved = t.requestCost - t.cost, pct = t.requestCost > 0 ? Math.round((saved / t.requestCost) * 100) : 0;
  const head = `<tr><th></th>${t.points.map(p => `<th>${esc(short(p))}</th>`).join("")}</tr>`;
  const rows = t.points.map((a, i) => `<tr><th>${esc(short(a))}</th>${t.matrix[i].map((v, j) => `<td>${i === j ? "–" : fmt(v)}</td>`).join("")}</tr>`).join("");
  const tour = ["Hub", ...r.order.map(s => s.vendor.name), "Hub"].map(esc).join(" → ");
  const legs = r.legs.map(l => `<li><b>${esc(short(l.from))} → ${esc(short(l.to))}</b>: ${fmtKm(l.km)} · ${fmtMin(l.min)}<br><span class="hint">${l.path.map(id => esc(N[id].label)).join(" → ")}</span></li>`).join("");
  return `<div class="tspbox">
    <p class="tsphead"><b>TSP solved:</b> ${esc(t.method)}</p>
    <p class="tsptour">${tour}</p>
    ${r.order.length > 1 ? `<p class="hint">Visiting in request order would cost <b>${fmt(t.requestCost)}</b>. The TSP order costs <b>${fmt(t.cost)}</b>${saved > 1e-6 ? ` — <b>${fmt(saved)} less (${pct}%)</b>` : " — request order was already the best"}.</p>` : `<p class="hint">With one stop the tour is simply Hub → stall → Hub.</p>`}
  </div>
  <details class="how"><summary>How the TSP route was found</summary>
    <p class="hint"><b>Step 1 — distance matrix.</b> Road ${t.unit === "min" ? "travel time" : "distance"} between every pair of points (shortest path on the road network):</p>
    <div class="matrixwrap"><table class="matrix">${head}${rows}</table></div>
    <p class="hint"><b>Step 2 — solve the TSP.</b> ${r.order.length <= Route.EXACT_LIMIT
      ? `Held–Karp dynamic programming checks the best way to reach every subset of stops, ending at each stop (${t.states} states), and keeps the cheapest. This gives the exact optimum without trying all ${factorial(r.order.length)} orders one by one.`
      : `Nearest stop next builds a tour, then 2-opt reverses sections of it while that makes it shorter.`}</p>
    <p class="hint"><b>Step 3 — follow the roads.</b> Each leg of the tour is drawn along the streets:</p>
    <ol class="dsteps">${legs}</ol>
    <p class="hint">Roads: main ${Route.SPEED.main} km/h, street ${Route.SPEED.street} km/h, lane ${Route.SPEED.lane} km/h${routeOpts.heavyTraffic ? `, Chord Road in traffic ${Route.TRAFFIC_SPEED} km/h` : ""}. Optimising for: ${routeOpts.cost === "min" ? "travel time" : "distance"}.</p>
  </details>`;
}
const factorial = n => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f.toLocaleString("en-IN"); };

// 5b. Driver
function driverScreen() {
  const locked = isRole("driver");
  if (locked) driverId = me().driverId;
  const d = driverById[driverId];
  const r = planRoute(driverId);
  const { order } = r;
  const backAt = Date.now() + r.totalMin * 60e3;
  const loadPct = Math.min(100, Math.round((r.loadKg / CART_KG) * 100));
  const collected = pickups.filter(p => p.driverId === driverId && p.status === "collected");

  const stops = order.length
    ? `<ol class="stops">${order.map((s, i) => {
        const p = s.pickup, typed = typedWeights[p.id] ?? "";
        return `<li class="stop"><span class="n">${i + 1}</span><div>
          <h3>${esc(s.vendor.name)} · ${esc(s.vendor.stall)} ${p.sample ? `<span class="chip sample">Sample</span>` : ""}</h3>
          <p class="legline"><b>${fmtKm(s.leg.km)}</b> · <b>${fmtMin(s.leg.min)}</b> drive · arrive ~${time(Date.now() + s.arriveIn * 60e3)}</p>
          <p class="hint">${plural(p.sacks, "sack")} (~${p.estKg || p.sacks * KG_PER_SACK} kg est.) · via ${SOURCE_LABEL[p.source] || "App"}${p.shellType ? ` · vendor says: ${esc(Classifier.CATEGORIES.find(c => c.id === p.shellType)?.label || p.shellType)}` : ""}</p>
          <div class="row">
            <div><label class="f" for="kg-${esc(p.id)}">Weight on scale (kg)</label>
              <input type="number" inputmode="numeric" min="1" max="500" id="kg-${esc(p.id)}" data-kg="${esc(p.id)}" value="${esc(typed)}" placeholder="weigh first" required></div>
            <button class="btn small" data-collect="${esc(p.id)}">Log weight &amp; mark collected</button>
          </div></div></li>`;
      }).join("")}</ol>`
    : `<div class="empty"><strong>No pickups assigned</strong>When the hub assigns pickups to ${esc(d.name)}, they appear here with the shortest route.</div>`;


  return `
  <p class="eyebrow">Driver app</p>
  <div class="toolbar"><h2>${esc(d.name)}'s route · ${esc(d.cart)}</h2>${order.length ? `<button class="btn ghost" id="readStop">🔊 Read next stop</button>` : ""}</div>
  ${locked ? "" : `<div class="routeopts"><label class="f" for="driverSel" style="margin:0">Driver (hub view)</label><select id="driverSel" class="inline">${DRIVERS.map(x => `<option value="${x.id}"${x.id === driverId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div>`}
  <p class="lede">Only pickups the hub assigned to this driver are shown. The route is a <b>Travelling Salesman Problem</b>: start at the hub, visit every stall once, come back, with the smallest total trip.</p>
  <div class="routeopts">
    <div class="seg" role="group" aria-label="Optimise route for">
      <button data-cost="min" aria-pressed="${routeOpts.cost === "min"}">Fastest time</button>
      <button data-cost="km" aria-pressed="${routeOpts.cost === "km"}">Shortest distance</button>
    </div>
    <label class="check"><input type="checkbox" id="trafficToggle"${routeOpts.heavyTraffic ? " checked" : ""}> Heavy traffic on Chord Road</label>
  </div>
  <div class="grid2">
    <section class="panel">${drawMap({ routeFor: driverId })}${ROUTE_LEGEND}
      <div class="totals">
        <div><span class="v">${order.length}</span><span class="l">Stops</span></div>
        <div><span class="v">${fmtKm(r.totalKm)}</span><span class="l">Total distance</span></div>
        <div><span class="v">${order.length ? fmtMin(r.driveMin) : "0 min"}</span><span class="l">Driving time</span></div>
        <div><span class="v">${order.length ? time(backAt) : "–"}</span><span class="l">Back at hub (incl. ${Route.SERVICE_MIN} min per stop)</span></div>
      </div>
      <div class="capacity"><div class="caphead"><span>Cart load (estimate)</span><b>${Math.round(r.loadKg)} / ${CART_KG} kg</b></div><div class="bar"><i style="width:${loadPct}%"></i></div></div>
      ${MODEL_NOTE}
      ${r.legs.length ? tspPanel(r) : ""}
    </section>
    <section class="panel stack">${stops}
      ${collected.length ? `<div><h3>Collected, waiting for hub confirmation</h3><ul class="feed">${collected.map(p => `<li>${chip(p)}<span>${esc(vendorById[p.vendor]?.name)} · ${p.actualKg} kg</span><span class="time">${time(p.collectedAt)}</span></li>`).join("")}</ul></div>` : ""}
    </section>
  </div>`;
}

// 5c. Hub: smart pickup planner + confirmation
function driverStates() {
  return DRIVERS.map(d => {
    const mine = pickups.filter(p => p.driverId === d.id && p.status === "assigned");
    return { id: d.id, capacityKg: CART_KG, loadKg: sum(mine, p => p.estKg || p.sacks * KG_PER_SACK), nodes: new Set(mine.map(p => vendorById[p.vendor]?.node).filter(Boolean)) };
  });
}
const nodeOf = p => vendorById[p.vendor]?.node;

function plannerData() {
  const requested = pickups.filter(p => p.status === "requested" && vendorById[p.vendor]);
  const scored = Planner.score(requested, nodeOf);
  const suggestions = Planner.autoAssign(scored, driverStates(), nodeOf);
  const zoneOf = Planner.zones(VENDORS.map(v => v.node));
  const zoneName = {};
  for (const v of VENDORS) (zoneName[zoneOf[v.node]] ??= []).push(v.name);
  return { scored, suggestions, zoneOf, zoneName };
}

function hubScreen() {
  const byStatus = s => pickups.filter(p => p.status === s);
  const confirmedToday = byStatus("confirmed").filter(p => isToday(p.confirmedAt));
  const kgToday = sum(confirmedToday, p => p.actualKg);
  const usable = kgToday * 0.5 * 0.9;
  const sampleCount = pickups.filter(p => p.sample).length;
  const { scored, suggestions, zoneOf, zoneName } = plannerData();
  const sugBy = Object.fromEntries(suggestions.map(s => [s.pickup.id, s]));

  const plannerRows = scored.length ? `<ol class="prio">${scored.map((s, i) => {
    const p = s.pickup, v = vendorById[p.vendor], sug = sugBy[p.id];
    const chosen = assignChoice[p.id] ?? sug?.driverId ?? "";
    const z = zoneOf[v.node];
    return `<li class="prioitem">
      <div class="priohead"><span class="rank">${i + 1}</span><div><h3>${esc(v.name)} · ${esc(v.stall)} ${p.sample ? `<span class="chip sample">Sample</span>` : ""}</h3>
        <p class="hint">${plural(p.sacks, "sack")} · ~${Math.round(s.estKg)} kg est. · zone ${z + 1} (${esc(zoneName[z].join(", "))}) · via ${SOURCE_LABEL[p.source] || "App"}</p></div>
        <div class="score" title="Priority score out of 100"><b>${s.score}</b><span>priority</span></div></div>
      <div class="scorebar" aria-hidden="true"><i class="w" style="width:${s.parts.wait * 100}%"></i><i class="q" style="width:${s.parts.qty * 100}%"></i><i class="n" style="width:${s.parts.near * 100}%"></i></div>
      <p class="why">${s.reasons.map(esc).join(" · ")}</p>
      <div class="assignrow">
        <label class="f" for="as-${esc(p.id)}">Driver</label>
        <select id="as-${esc(p.id)}" data-assign-choice="${esc(p.id)}" class="inline">
          <option value="">Choose…</option>${DRIVERS.map(d => `<option value="${d.id}"${chosen === d.id ? " selected" : ""}>${esc(d.name)}</option>`).join("")}
        </select>
        <button class="btn small" data-assign="${esc(p.id)}">Assign</button>
        <span class="hint">${sug?.driverId ? `Suggested: ${esc(driverById[sug.driverId].name)} (${esc(sug.reason)})` : esc(sug?.reason || "")}</span>
      </div></li>`;
  }).join("")}</ol>` : `<div class="empty"><strong>No requests waiting</strong>New vendor requests appear here, ranked by priority.</div>`;

  const loads = DRIVERS.map(d => {
    const r = planRoute(d.id);
    const pct = Math.min(100, Math.round((r.loadKg / CART_KG) * 100));
    return `<div class="loadcard"><div class="caphead"><b>${esc(d.name)}</b><span>${plural(r.order.length, "stop")} · ${fmtKm(r.totalKm)} · ${r.order.length ? fmtMin(r.driveMin) : "0 min"}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div><p class="hint">${Math.round(r.loadKg)} / ${CART_KG} kg estimated load</p></div>`;
  }).join("");

  const toConfirm = byStatus("collected");
  const confirmRows = toConfirm.length ? `<ul class="confirmlist">${toConfirm.map(p => {
    const v = vendorById[p.vendor], val = confirmWeights[p.id] ?? p.actualKg;
    return `<li><div><h3>${esc(v?.name)} · ${esc(v?.stall)} ${p.sample ? `<span class="chip sample">Sample</span>` : ""}</h3><p class="hint">Driver ${esc(driverById[p.driverId]?.name || "–")} logged ${p.actualKg} kg at ${time(p.collectedAt)} (estimate was ~${p.estKg || p.sacks * KG_PER_SACK} kg)</p></div>
      <div class="row"><div><label class="f" for="ck-${esc(p.id)}">Confirmed weight (kg)</label><input type="number" min="1" max="500" id="ck-${esc(p.id)}" data-ck="${esc(p.id)}" value="${esc(val)}"></div>
      <button class="btn small" data-confirm="${esc(p.id)}">Confirm &amp; record ${rupees((Number(val) || 0) * RATE)}</button></div></li>`;
  }).join("")}</ul>` : `<div class="empty"><strong>Nothing to confirm</strong>Pickups appear here after a driver logs the weight.</div>`;

  const recent = [...pickups].sort((a, b) => (b.confirmedAt || b.collectedAt || b.assignedAt || b.requestedAt) - (a.confirmedAt || a.collectedAt || a.assignedAt || a.requestedAt)).slice(0, 8);
  const feed = recent.length ? `<ul class="feed">${recent.map(p => {
    const v = vendorById[p.vendor] || { name: "Unknown" };
    const detail = p.status === "confirmed" ? `${p.actualKg} kg · ${rupees(p.payout)} recorded` : p.status === "collected" ? `${p.actualKg} kg weighed` : p.status === "assigned" ? `${esc(driverById[p.driverId]?.name || "")}` : plural(p.sacks, "sack");
    return `<li>${chip(p)}<span>${esc(v.name)} · ${detail} <span class="via">${SOURCE_LABEL[p.source] || "App"}</span></span><span class="time">${time(p.confirmedAt || p.collectedAt || p.assignedAt || p.requestedAt)}</span></li>`;
  }).join("")}</ul>` : `<div class="empty"><strong>No activity yet</strong>Request a pickup as a vendor, or load the sample day.</div>`;

  const canReset = isRole("owner");
  const resetButtons = confirmReset
    ? `<span class="confirm">Delete every pickup? <button class="btn danger" id="resetYes">Delete all</button><button class="btn ghost" id="resetNo">Cancel</button></span>`
    : (canReset ? `<button class="btn ghost" id="resetBtn"${pickups.length ? "" : " disabled"}>Delete all</button>` : "");

  return `
  <div class="toolbar">
    <div><p class="eyebrow">Ward hub · smart pickup planner</p><h2>Ward 45 · Today</h2></div>
    <div class="actions"><button class="btn ghost" id="sampleBtn">Load sample day</button>${sampleCount ? `<button class="btn ghost" id="clearSample">Remove sample data</button>` : ""}${resetButtons}</div>
  </div>
  ${sampleCount ? `<div class="banner info">${plural(sampleCount, "sample record")} loaded for the demo (marked <span class="chip sample">Sample</span>). They are excluded from the owner's actual statistics and from ML training.</div>` : ""}
  <div class="kpis">
    <div class="kpi${byStatus("requested").length ? " alert" : ""}"><div class="v">${byStatus("requested").length}</div><div class="l">Waiting for a driver</div></div>
    <div class="kpi"><div class="v">${byStatus("assigned").length}</div><div class="l">Assigned to drivers</div></div>
    <div class="kpi"><div class="v">${toConfirm.length}</div><div class="l">Awaiting your confirmation</div></div>
    <div class="kpi"><div class="v">${kgToday} kg</div><div class="l">Confirmed today · ${rupees(sum(confirmedToday, p => p.payout))} to vendors · ~${Math.round(usable * 0.7)} kg cocopeat (est.)</div></div>
  </div>
  <div class="grid2">
    <section class="panel stack">
      <div class="toolbar"><h3>Pickup priorities</h3>${scored.length ? `<button class="btn small" id="autoAssign">Assign all suggested</button>` : ""}</div>
      <p class="hint">Priority = ${Planner.weights.wait * 100}% waiting time + ${Planner.weights.qty * 100}% quantity + ${Planner.weights.near * 100}% closeness to hub. Stalls within ${Planner.ZONE_MIN} min of each other form a zone, so one driver can serve them together. Cart capacity ${CART_KG} kg.</p>
      <div class="scorekey"><span><i class="w"></i>Waiting</span><span><i class="q"></i>Quantity</span><span><i class="n"></i>Closeness</span></div>
      ${plannerRows}
    </section>
    <section class="stack">
      <section class="panel stack"><h3>Driver loads and routes</h3>${loads}${MODEL_NOTE}</section>
      <section class="panel stack"><h3>Confirm collected weights</h3><p class="hint">Payment is recorded only when you confirm the weighed kg.</p>${confirmRows}</section>
    </section>
  </div>
  <div class="grid2" style="margin-top:16px">
    <section class="panel"><h3 style="margin-bottom:10px">Shell hotspots (confirmed kg)</h3>${drawMap({ showHotspots: true })}${LEGEND}</section>
    <section class="panel"><h3 style="margin-bottom:6px">Live activity</h3>${feed}</section>
  </div>`;
}

// 5d. AI Insights (owner only)
function insightsScreen() {
  if (!Auth.can("insights")) return `<section class="panel"><h2>Owner only</h2><p>AI Insights is available to the owner account.</p></section>`;
  if (Store.mode() === "api") return serverInsights();
  const real = pickups.filter(p => !p.sample);
  const sampleCount = pickups.length - real.length;
  const by = s => real.filter(p => p.status === s);
  const confirmed = by("confirmed");
  const totalKg = sum(confirmed, p => p.actualKg);
  const totalPaid = sum(confirmed, p => p.payout);
  const due = sum(confirmed.filter(p => p.paymentStatus === "due"), p => p.payout);

  const vendorRows = VENDORS.map(v => {
    const mine = real.filter(p => p.vendor === v.id), c = mine.filter(p => p.status === "confirmed");
    return { v, n: c.length, kg: sum(c, p => p.actualKg), earned: sum(c, p => p.payout), active: mine.filter(p => ACTIVE.includes(p.status)).length };
  }).sort((a, b) => b.kg - a.kg);

  // ML forecast
  let fc;
  try { fc = ML.run(real, { allowSample: insightsOpts.allowSample }); } catch (e) { fc = { status: "error", message: e.message }; }
  let forecastHtml;
  if (fc.status === "error") forecastHtml = `<div class="banner warn">The forecast could not be calculated: ${esc(fc.message)}</div>`;
  else if (fc.status === "insufficient") forecastHtml = `<div class="empty"><strong>Not enough real history yet</strong>The model needs at least ${fc.needed} days of confirmed collections; you have ${fc.realDays}. Tick "use sample history" above to see a labelled demo forecast.</div>`;
  else {
    const isSample = fc.source === "sample";
    const hist = fc.series.slice(-21).map(d => ({ label: dayLabel(d.date), value: d.kg, kind: isSample ? "sample" : "actual", title: `${dayLabel(d.date)}: ${d.kg} kg (${isSample ? "sample" : "actual"})` }));
    const fut = fc.forecast.map(d => ({ label: dayLabel(d.date), value: d.kg, low: d.low, high: d.high, kind: "forecast", title: `${dayLabel(d.date)}: predicted ${d.kg} kg (likely ${d.low}–${d.high})` }));
    const weeks = ML.weekly(fc.series).filter(w => w.days === 7).slice(-8).map(w => ({ label: dayLabel(w.week), value: w.kg, kind: isSample ? "sample" : "actual" }));
    const next7 = sum(fc.forecast, d => d.kg);
    const ev = fc.evaluation;
    const better = ev ? Math.round((1 - ev.mae / ev.baselineMae) * 100) : null;
    const t = fc.forecast[0];
    forecastHtml = `
      <div class="banner ${isSample ? "warn" : "ok"}">${isSample
        ? `<b>Trained on SAMPLE data.</b> Real confirmed history is ${fc.realDays} day(s); at least ${ML.MIN_DAYS} are needed. These numbers show how the model works. They are not real operating results.`
        : `<b>Trained on real data:</b> ${fc.trainedDays} days of confirmed collections.`}</div>
      <div class="kpis">
        <div class="kpi forecast"><div class="v">${t.kg} kg</div><div class="l">Predicted ${dayLabel(t.date)} (likely ${t.low}–${t.high} kg)</div></div>
        <div class="kpi forecast"><div class="v">${Math.round(next7).toLocaleString("en-IN")} kg</div><div class="l">Predicted next 7 days (${dayLabel(fc.forecast[0].date)}–${dayLabel(fc.forecast[6].date)})</div></div>
        <div class="kpi"><div class="v">${ev ? ev.mae.toFixed(1) + " kg" : "–"}</div><div class="l">${ev ? `Average error on ${ev.testDays} held-out days (MAPE ${ev.mape.toFixed(1)}%)` : "Needs 28+ days to measure accuracy"}</div></div>
        <div class="kpi"><div class="v">${ev ? (better >= 0 ? better + "% better" : -better + "% worse") : "–"}</div><div class="l">${ev ? `than the simple baseline (${ev.baselineMae.toFixed(1)} kg error)` : "Baseline comparison not available"}</div></div>
      </div>
      <h3>Daily collections and 7-day forecast</h3>
      ${Charts.bars([...hist, ...fut], { ariaLabel: "Daily collected kg and forecast" })}
      ${Charts.legend([[isSample ? "sample" : "actual", isSample ? "Sample history (synthetic)" : "Actual confirmed kg"], ["forecast", "ML prediction (bar) with likely range (line)"]])}
      <h3>Weekly totals</h3>
      ${Charts.bars(weeks, { height: 160, ariaLabel: "Weekly collected kg" })}
      ${Charts.legend([[isSample ? "sample" : "actual", isSample ? "Sample history (synthetic), week starting" : "Actual confirmed kg, week starting"]])}
      <details class="how"><summary>How the prediction works</summary>
        <p>A linear regression model (ridge, in <code>ml.js</code>) learns the daily kg from two things: the day of the week (weekends are busier) and the overall trend. It is trained on ${fc.trainedDays} days, tested on the last ${ML.HOLDOUT} days it did not see, and compared with a simple rule ("same as the same weekday last week"). The likely range covers about 80% of past errors. Run <code>node tests/ml.test.js</code> to test it.</p>
      </details>`;
  }

  // High-demand areas and recommendations (from real records only)
  const zoneOf = Planner.zones(VENDORS.map(v => v.node));
  const zones = {};
  for (const row of vendorRows) { const z = zoneOf[row.v.node]; (zones[z] ??= { names: [], kg: 0, active: 0 }); zones[z].names.push(row.v.name); zones[z].kg += row.kg; zones[z].active += row.active; }
  const zoneList = Object.entries(zones).sort((a, b) => b[1].kg - a[1].kg || b[1].active - a[1].active);
  const anyReal = totalKg > 0 || real.some(p => ACTIVE.includes(p.status));
  const requested = pickups.filter(p => p.status === "requested");
  const top = Planner.score(requested, nodeOf).slice(0, 3);
  const pendingKg = sum(pickups.filter(p => p.status === "requested" || p.status === "assigned"), p => p.estKg || p.sacks * KG_PER_SACK);
  const tmr = fc.status === "ok" ? fc.forecast[0].kg : null;

  return `
  <div class="toolbar"><div><p class="eyebrow">Owner only · AI Insights</p><h2>CocoLoop insights</h2></div>
    <label class="check"><input type="checkbox" id="allowSample"${insightsOpts.allowSample ? " checked" : ""}> Use sample history when real history is too short</label></div>
  <p class="lede">Actual figures come only from pickups recorded in CocoLoop${sampleCount ? ` (${plural(sampleCount, "sample record")} excluded)` : ""}. Predictions are labelled as predictions.</p>

  <section class="panel stack">
    <h3>Actual operations <span class="chip done">Actual</span></h3>
    <div class="kpis">
      <div class="kpi"><div class="v">${totalKg.toLocaleString("en-IN")} kg</div><div class="l">Shells collected (confirmed, all time)</div></div>
      <div class="kpi"><div class="v">${by("requested").length} · ${by("assigned").length} · ${by("collected").length}</div><div class="l">Pending · assigned · awaiting confirmation</div></div>
      <div class="kpi"><div class="v">${confirmed.length}</div><div class="l">Completed (hub-confirmed) pickups</div></div>
      <div class="kpi"><div class="v">${rupees(totalPaid)}</div><div class="l">Vendor earnings recorded · ${rupees(due)} due for UPI payout</div></div>
    </div>
    <div class="tablewrap"><table class="tbl"><thead><tr><th>Vendor</th><th>Confirmed pickups</th><th>Kg (actual)</th><th>Earnings</th><th>In progress</th></tr></thead>
      <tbody>${vendorRows.map(r => `<tr><td>${esc(r.v.name)} · ${esc(r.v.stall)}</td><td>${r.n}</td><td>${r.kg}</td><td>${rupees(r.earned)}</td><td>${r.active}</td></tr>`).join("")}</tbody></table></div>
  </section>

  <section class="panel stack" style="margin-top:16px">
    <h3>Shell supply forecast <span class="chip forecast">ML prediction</span></h3>
    ${forecastHtml}
  </section>

  <div class="grid2" style="margin-top:16px">
    <section class="panel stack">
      <h3>High-demand areas <span class="chip done">Actual</span></h3>
      ${anyReal ? `<ol class="zones">${zoneList.map(([z, d]) => `<li><b>Zone ${+z + 1}</b>: ${esc(d.names.join(", "))}<span class="hint"> · ${d.kg} kg confirmed · ${d.active} in progress</span></li>`).join("")}</ol>`
        : `<div class="empty"><strong>No real collections yet</strong>Zones are ranked once pickups are recorded.</div>`}
      <p class="hint">Zones group stalls within ${Planner.ZONE_MIN} minutes of each other on the ward road model.</p>
    </section>
    <section class="panel stack">
      <h3>Recommendations</h3>
      <ul class="recs">
        <li><b>Next pickups:</b> ${top.length ? top.map(s => `${esc(vendorById[s.pickup.vendor].name)} (priority ${s.score})`).join(", ") : "no requests waiting"}.</li>
        <li><b>Today's plan:</b> ${pendingKg ? `about ${Math.round(pendingKg)} kg estimated still to collect → ${Math.ceil(pendingKg / CART_KG)} cart trip(s) of ${CART_KG} kg.` : "nothing waiting to collect."}</li>
        <li><b>Tomorrow:</b> ${tmr != null ? `predicted ${tmr} kg → plan ${Math.ceil(tmr / CART_KG)} cart trip(s)${fc.source === "sample" ? " <span class=\"chip sample\">based on sample data</span>" : ""}.` : "no forecast available yet."}</li>
      </ul>
      <p class="hint">Recommendations use the transparent priority rules in <code>planner.js</code> and the forecast above.</p>
    </section>
  </div>`;
}

// 5d-2. Owner dashboard from the Python backend (API mode)
// Every number and graph here comes from GET /api/stats, which the server
// calculates from its SQLite database. Add data -> the graphs change.
const srv = { stats: null, forVersion: null, loading: false, error: "", form: { date: "", vendor: "v1", kg: "" }, busy: false, msg: "",
  recs: { list: [], total: 0, vendor: "", limit: 15, editId: null, delId: null, msg: "" } };
function loadRecords() {
  return Store.listCollections(srv.recs.vendor, srv.recs.limit).then(r => { srv.recs.list = r.records; srv.recs.total = r.total; });
}
function ensureStats() {
  if (Store.mode() !== "api" || srv.loading) return;
  const v = Store.version();
  if (v === null || v === srv.forVersion) return;
  srv.loading = true;
  Promise.all([Store.getStats(), loadRecords()])
    .then(([s]) => { srv.stats = s; srv.forVersion = v; srv.error = ""; })
    .catch(e => { srv.error = e.message; srv.forVersion = v; })
    .finally(() => { srv.loading = false; if (tab === "insights") render(); });
}

function serverInsights() {
  ensureStats();
  const s = srv.stats;
  if (!s) return `<section class="panel"><h2>CocoLoop insights</h2><p class="hint">${srv.error ? `Couldn't load the dashboard: ${esc(srv.error)}` : "Loading from the Python backend…"}</p></section>`;
  const t = s.totals, c = s.statusCounts, fc = s.forecast;
  const updated = new Date(s.generatedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit" });

  const daily = s.daily.map(d => ({ label: d.date === s.today ? "Today" : dayLabel(d.date), value: d.kg, kind: "actual",
    title: `${dayLabel(d.date)}: ${d.kg} kg actual${d.date === s.today ? " (today so far)" : ""}` }));
  const fut = fc.status === "ok" ? fc.days.filter(d => d.date > s.today).map(d => ({ label: dayLabel(d.date), value: d.kg, low: d.low, high: d.high, kind: "forecast",
    title: `${dayLabel(d.date)}: predicted ${d.kg} kg (likely ${d.low}–${d.high})` })) : [];
  const weeks = s.weekly.map(w => ({ label: dayLabel(w.week), value: w.kg, kind: "actual", title: `Week of ${dayLabel(w.week)}: ${w.kg} kg${w.days < 7 ? ` (${w.days} days so far)` : ""}` }));

  let fcHtml;
  if (fc.status === "ok") {
    const ev = fc.evaluation, next7 = fc.days.reduce((a, d) => a + d.kg, 0), first = fc.days[0];
    fcHtml = `<div class="kpis">
        <div class="kpi forecast"><div class="v">${first.kg} kg</div><div class="l">Predicted ${dayLabel(first.date)} (likely ${first.low}–${first.high} kg)</div></div>
        <div class="kpi forecast"><div class="v">${Math.round(next7).toLocaleString("en-IN")} kg</div><div class="l">Predicted next 7 days</div></div>
        <div class="kpi"><div class="v">${ev ? ev.mae + " kg" : "–"}</div><div class="l">${ev ? `Average error on ${ev.testDays} held-out days` : "Needs 28+ days to measure accuracy"}</div></div>
        <div class="kpi"><div class="v">${ev && ev.betterThanBaselinePct != null ? (ev.betterThanBaselinePct >= 0 ? ev.betterThanBaselinePct + "% better" : -ev.betterThanBaselinePct + "% worse") : "–"}</div><div class="l">${ev ? `than "same weekday last week" (${ev.baselineMae} kg error)` : "Baseline comparison not available"}</div></div>
      </div>
      <details class="how"><summary>How the prediction works (Python, <code>backend/analytics.py</code>)</summary>
        <p>Ridge linear regression on the daily kg in the database: trend + day of week. Trained on ${fc.trainedDays} completed days. Learned weights: ${Object.entries(fc.weights).map(([k, v]) => `${esc(k)} ${v}`).join(", ")}. The likely range is ±1.28 × the model's typical error (${fc.sd} kg).</p>
      </details>`;
  } else if (fc.status === "insufficient") {
    fcHtml = `<div class="empty"><strong>Forecast starts after ${fc.needed} days of history</strong>The database has ${fc.haveDays} completed day(s) of confirmed collections. Add more below, or import <code>backend/sample_collections.csv</code>.</div>`;
  } else fcHtml = `<div class="banner warn">The forecast could not be calculated: ${esc(fc.message || "")}</div>`;

  const f = srv.form;
  const today = ML.dateKey(Date.now());
  return `
  <div class="toolbar"><div><p class="eyebrow">Owner only · AI Insights</p><h2>CocoLoop insights</h2></div>
    <span class="chip done">From the Python backend</span></div>
  <div class="banner ok">Calculated by the Python server from its database: <b>${s.records}</b> confirmed collection record(s) over ${s.historyDays} day(s). Updated ${esc(updated)} · refreshes automatically when any data changes.</div>

  <section class="panel stack" style="margin-top:16px">
    <h3>Add collection data <span class="chip">Saved in the database</span></h3>
    <form id="addColForm" class="addrow">
      <div><label class="f" for="acDate">Date</label><input type="date" id="acDate" max="${today}" value="${esc(f.date || today)}" required></div>
      <div><label class="f" for="acVendor">Vendor</label><select id="acVendor">${(s.vendors.slice().sort((a, b) => a.id < b.id ? -1 : 1)).map(v => `<option value="${v.id}"${v.id === f.vendor ? " selected" : ""}>${esc(v.name)} · ${esc(v.stall)}</option>`).join("")}</select></div>
      <div><label class="f" for="acKg">Weighed kg</label><input type="number" id="acKg" min="0.1" max="2000" step="0.1" inputmode="decimal" placeholder="e.g. 64" value="${esc(f.kg)}" required></div>
      <div class="addbtn"><button class="btn small" type="submit"${srv.busy ? " disabled" : ""}>Add to database</button></div>
    </form>
    <div class="csvrow">
      <label class="btn ghost filebtn" for="csvIn">⬆ Import CSV (date,vendor,kg)</label><input type="file" id="csvIn" accept=".csv,text/csv" hidden>
      <span class="hint">Try <code>backend/sample_collections.csv</code>. Each row is saved as a confirmed, weighed collection.</span>
    </div>
    ${srv.msg ? `<p class="hint" role="status">${esc(srv.msg)}</p>` : ""}
  </section>

  ${recordsPanel(s, today)}

  <section class="panel stack" style="margin-top:16px">
    <h3>Actual operations <span class="chip done">Actual</span></h3>
    <div class="kpis">
      <div class="kpi"><div class="v">${t.kg.toLocaleString("en-IN")} kg</div><div class="l">Shells collected (confirmed, all time)</div></div>
      <div class="kpi"><div class="v">${c.requested} · ${c.assigned} · ${c.collected}</div><div class="l">Pending · assigned · awaiting confirmation</div></div>
      <div class="kpi"><div class="v">${t.pickups}</div><div class="l">Completed (confirmed) pickups</div></div>
      <div class="kpi"><div class="v">${rupees(t.paid)}</div><div class="l">Vendor earnings · ${rupees(t.due)} due for UPI payout</div></div>
    </div>
    <div class="tablewrap"><table class="tbl"><thead><tr><th>Vendor</th><th>Confirmed pickups</th><th>Kg (actual)</th><th>Earnings</th><th>In progress</th></tr></thead>
      <tbody>${s.vendors.map(v => `<tr><td>${esc(v.name)} · ${esc(v.stall)}</td><td>${v.pickups}</td><td>${Math.round(v.kg * 10) / 10}</td><td>${rupees(v.earned)}</td><td>${v.active}</td></tr>`).join("")}</tbody></table></div>
  </section>

  <section class="panel stack" style="margin-top:16px">
    <h3>Daily collections${fut.length ? " and 7-day forecast" : ""} <span class="chip done">Actual</span>${fut.length ? ` <span class="chip forecast">ML prediction</span>` : ""}</h3>
    ${Charts.bars([...daily, ...fut], { ariaLabel: "Daily collected kg from the database" })}
    ${Charts.legend([["actual", "Actual confirmed kg (from the database)"], ...(fut.length ? [["forecast", "ML prediction (bar) with likely range (line)"]] : [])])}
    ${fcHtml}
  </section>

  <section class="panel stack" style="margin-top:16px">
    <h3>Weekly totals <span class="chip done">Actual</span></h3>
    ${Charts.bars(weeks, { height: 170, ariaLabel: "Weekly collected kg from the database" })}
    ${Charts.legend([["actual", "Actual confirmed kg, week starting (Monday)"]])}
  </section>`;
}

// Collection records: Read (table), Update (Edit → Save), Delete (Delete → Yes, delete)
function recordsPanel(s, today) {
  const R = srv.recs;
  const vName = id => { const v = s.vendors.find(x => x.id === id); return v ? `${v.name} · ${v.stall}` : id; };
  const vOpts = sel => s.vendors.slice().sort((a, b) => a.id < b.id ? -1 : 1).map(v => `<option value="${v.id}"${v.id === sel ? " selected" : ""}>${esc(v.name)}</option>`).join("");
  const row = r => {
    if (R.editId === r.id) return `<tr class="editing">
      <td><input type="date" id="edDate" max="${today}" value="${esc(r.date)}"></td>
      <td><select id="edVendor">${vOpts(r.vendor)}</select></td>
      <td><input type="number" id="edKg" min="0.1" max="2000" step="0.1" value="${esc(r.kg)}"></td>
      <td>${rupees(r.payout)}</td><td>${esc(r.source || "")}</td>
      <td class="acts"><button class="btn small" data-rec-save="${r.id}">Save</button><button class="btn ghost" data-rec-cancel="1">Cancel</button></td></tr>`;
    if (R.delId === r.id) return `<tr class="deleting"><td colspan="5">Delete ${esc(vName(r.vendor))}, ${r.kg} kg on ${dayLabel(r.date)}? This cannot be undone.</td>
      <td class="acts"><button class="btn danger" data-rec-del-yes="${r.id}">Yes, delete</button><button class="btn ghost" data-rec-cancel="1">Cancel</button></td></tr>`;
    return `<tr><td>${dayLabel(r.date)}</td><td>${esc(vName(r.vendor))}</td><td>${r.kg}</td><td>${rupees(r.payout)}</td><td>${esc(r.source || "")}</td>
      <td class="acts"><button class="btn ghost" data-rec-edit="${r.id}">✎ Edit</button><button class="btn ghost" data-rec-del="${r.id}">🗑 Delete</button></td></tr>`;
  };
  return `<section class="panel stack" style="margin-top:16px">
    <h3>Collection records <span class="chip">Create · Read · Update · Delete</span></h3>
    <div class="csvrow"><label class="f" for="recVendor" style="margin:0">Show vendor</label>
      <select id="recVendor"><option value="">All vendors</option>${vOpts(R.vendor)}</select>
      <span class="hint">${R.total} record(s) in the database${R.total > R.list.length ? ` · showing the latest ${R.list.length}` : ""}. Editing or deleting a record recalculates every graph below.</span></div>
    ${R.list.length ? `<div class="tablewrap"><table class="tbl rectbl"><thead><tr><th>Date</th><th>Vendor</th><th>Kg</th><th>Payout</th><th>Source</th><th>Actions</th></tr></thead>
      <tbody>${R.list.map(row).join("")}</tbody></table></div>` : `<div class="empty"><strong>No records yet</strong>Add a collection above or import a CSV.</div>`}
    ${R.total > R.list.length ? `<button class="btn ghost" data-rec-more="1">Show more</button>` : ""}
    ${R.msg ? `<p class="hint" role="status">${esc(R.msg)}</p>` : ""}
  </section>`;
}

// 5e. IVR call
function ivrScreen() {
  if (isRole("vendor")) ivr.caller = me().vendorId;
  const inCall = ivr.state !== "idle" && ivr.state !== "ended";
  const keys = ["1","2","3","4","5","6","7","8","9","*","0","#"];
  const log = ivr.log.length
    ? `<ol class="calllog">${ivr.log.map(l => `<li class="${l.who === "IVR" ? "sys" : "me"}"><b>${l.who === "IVR" ? "IVR" : "Caller"}:</b> ${esc(l.text)}</li>`).join("")}</ol>`
    : `<p class="hint">The call transcript appears here.</p>`;
  return `
  <p class="eyebrow">IVR phone line (in-app simulation)</p>
  <h2>Call the CocoLoop helpline</h2>
  <p class="lede">For vendors with basic phones. They call, hear a menu in Kannada or English, and book a pickup with the keypad. This screen works like that call; the real phone line is in <code>ivr-server/</code>.</p>
  <div class="grid2">
    <section class="panel">
      <div class="phone">
        <div class="phonetop">
          <label class="f" for="callerSel">Calling from (caller ID)</label>
          <select id="callerSel"${inCall || isRole("vendor") ? " disabled" : ""}>
            ${VENDORS.map(v => `<option value="${v.id}"${v.id === ivr.caller ? " selected" : ""}>${esc(v.name)} · ${esc(v.phone)}</option>`).join("")}
            ${isRole("vendor") ? "" : `<option value="unknown"${ivr.caller === "unknown" ? " selected" : ""}>Unregistered number</option>`}
          </select>
        </div>
        <div class="ivrscreen" aria-live="polite">
          <p class="ivrstate">${inCall ? `On call · ${esc(HELPLINE)}` : ivr.state === "ended" ? "Call ended" : "Ready to call"}</p>
          <p class="ivrprompt">${esc(ivr.prompt || "Press the green button to call the helpline.")}</p>
          <p class="ivrdigits">${esc(ivr.digits)}</p>
        </div>
        <div class="keypad">${keys.map(k => `<button class="key" data-key="${k}"${inCall ? "" : " disabled"} aria-label="Key ${k}">${k}</button>`).join("")}</div>
        <div class="callrow">${inCall ? `<button class="btn danger callbtn" id="hangUp">Hang up</button>` : `<button class="btn callbtn" id="callBtn">📞 Call helpline</button>`}</div>
        <label class="check"><input type="checkbox" id="ivrSpeak"${ivr.speak ? " checked" : ""}> Speak the menu out loud</label>
      </div>
    </section>
    <section class="panel stack">
      <h3>Call transcript</h3>
      ${log}
      <details class="how"><summary>How the real phone line works</summary>
        <ol>
          <li>The vendor calls a CocoLoop number from any phone.</li>
          <li>A cloud telephony service (Exotel in India, or Twilio) answers and plays the menu.</li>
          <li>Each key press is sent to our IVR server (<code>ivr-server/server.js</code>).</li>
          <li>The server finds the stall from the caller's number and saves the pickup to Firebase.</li>
          <li>The pickup appears on the Hub planner, marked "IVR call".</li>
        </ol>
      </details>
    </section>
  </div>`;
}

// Draw the page
function render() {
  const u = me();
  const live = Store.mode() === "live" || Store.mode() === "api";
  $("#sync").className = "sync " + (live ? "live" : "demo");
  $("#syncText").textContent = Store.mode() === "api" ? "Live · Python backend" : live ? "Live · Firebase" : Auth.mode() === "firebase" ? "Firebase · not signed in" : "Demo mode · this device · not secure";
  $("#userChip").innerHTML = u && u.role ? `<span>${esc(Auth.ROLE_NAME[u.role])} · ${esc(u.name)}</span><button class="linkbtn" id="signOutBtn">Sign out</button>` : "";

  const nav = $("nav.roles");
  if (!u || !u.role) { nav.hidden = true; $("#view").innerHTML = signInScreen(); return; }
  const tabs = Auth.tabsFor(u.role);
  if (!tabs.includes(tab)) tab = tabs[0];
  nav.hidden = tabs.length < 2;
  nav.style.setProperty("--n", tabs.length);
  nav.innerHTML = tabs.map(t => `<button role="tab" data-tab="${t}" aria-selected="${t === tab}">${TAB_LABEL[t]}</button>`).join("");

  const focused = document.activeElement && document.activeElement.id;
  const screens = { vendor: vendorScreen, driver: driverScreen, hub: hubScreen, insights: insightsScreen, ivr: ivrScreen };
  $("#view").innerHTML = screens[tab]();
  if (focused && document.getElementById(focused)) document.getElementById(focused).focus();
}

// ---------- 6. VOICE ASSISTANT ----------
function reply(en, kn) {
  voice.reply = voice.lang === "kn" && kn ? kn : en;
  Voice.say(en, kn, voice.lang);
}

// Speech -> structured action -> reply. Facts come only from recorded pickups.
async function handleSpeech(text) {
  voice.pendingSacks = null;
  if (!text.trim()) { voice.action = null; reply("I didn't hear anything. Tap the mic and speak again.", "ಏನೂ ಕೇಳಿಸಲಿಲ್ಲ. ಮತ್ತೆ ಮಾತನಾಡಿ."); render(); return; }
  const { intent, sacks: n } = Voice.understand(text);
  const f = vendorFacts(vendorId);
  voice.action = { action: { request: "request_pickup", earnings: "check_earnings", status: "check_status" }[intent] || "unknown", ...(intent === "request" ? { sacks: n ?? null } : {}) };

  if (intent === "earnings") {
    reply(`Confirmed earnings today: ${f.earnedToday} rupees. Total confirmed: ${f.earnedTotal} rupees.${f.awaitingKg ? ` ${f.awaitingKg} kilos are waiting for hub confirmation.` : ""}`,
          `ಇಂದು ದೃಢಪಟ್ಟ ಗಳಿಕೆ ${f.earnedToday} ರೂಪಾಯಿ. ಒಟ್ಟು ${f.earnedTotal} ರೂಪಾಯಿ.`);
  } else if (intent === "status") {
    const o = f.open;
    if (!o) reply("You have no pickup in progress. Say how many sacks are ready to book one.", "ಯಾವುದೇ ಪಿಕಪ್ ಬಾಕಿ ಇಲ್ಲ.");
    else if (o.status === "requested") reply("Your request is waiting for the hub to assign a driver.", "ನಿಮ್ಮ ವಿನಂತಿ ಚಾಲಕರಿಗಾಗಿ ಕಾಯುತ್ತಿದೆ.");
    else if (o.status === "assigned") { const eta = etaFor(vendorId); reply(`${driverById[o.driverId]?.name || "The driver"} is on the way${eta ? `, about ${eta.min} minutes away` : ""}.`, `ಚಾಲಕರು ಬರುತ್ತಿದ್ದಾರೆ${eta ? `. ಸುಮಾರು ${eta.min} ನಿಮಿಷಗಳು` : ""}.`); }
    else reply(`Your shells were collected: ${o.actualKg} kilos. Payment is added after the hub confirms.`, "ನಿಮ್ಮ ಚಿಪ್ಪುಗಳನ್ನು ಸಂಗ್ರಹಿಸಲಾಗಿದೆ. ಹಬ್ ದೃಢೀಕರಣಕ್ಕಾಗಿ ಕಾಯುತ್ತಿದೆ.");
  } else if (intent === "request") {
    if (f.open) reply("You already have a pickup in progress.", "ನಿಮ್ಮ ಪಿಕಪ್ ಈಗಾಗಲೇ ಪ್ರಗತಿಯಲ್ಲಿದೆ.");
    else if (n == null) reply("How many sacks are ready? Please say a number, like 3 sacks.", "ಎಷ್ಟು ಚೀಲಗಳು ಇವೆ? ಸಂಖ್ಯೆ ಹೇಳಿ.");
    else if (!Number.isInteger(n) || n < 1 || n > 20) reply(`${n} is not allowed. Please say a number of sacks from 1 to 20.`, "1 ರಿಂದ 20 ಚೀಲಗಳವರೆಗೆ ಮಾತ್ರ ಹೇಳಿ.");
    else { voice.pendingSacks = n; sacks = n; reply(`${plural(n, "sack")}. Tap confirm to book the pickup.`, `${n} ಚೀಲಗಳು. ಪಿಕಪ್ ಬುಕ್ ಮಾಡಲು ಖಚಿತಪಡಿಸಿ ಒತ್ತಿ.`); }
  } else {
    reply("Sorry, I didn't understand. Say how many sacks are ready, ask about your earnings, or ask where your pickup is.", "ಕ್ಷಮಿಸಿ, ಅರ್ಥವಾಗಲಿಲ್ಲ. ಎಷ್ಟು ಚೀಲಗಳು ಇವೆ ಎಂದು ಹೇಳಿ.");
  }
  render();
}

function toggleMic() {
  if (voice.listening) { voice.rec && voice.rec.stop(); return; }
  voice.heard = ""; voice.reply = ""; voice.pendingSacks = null; voice.action = null;
  voice.rec = Voice.listen(voice.lang,
    text => { voice.heard = text; const h = $("#heard"); if (h) h.textContent = `You said: “${text}”`; },
    finalText => { voice.listening = false; voice.rec = null; handleSpeech(finalText); },
    err => {
      voice.listening = false;
      const msg = {
        "unsupported": "Voice input needs Google Chrome. Type your request below instead.",
        "not-allowed": "The microphone is blocked. Click the lock icon in the address bar, allow the microphone, and try again.",
        "service-not-allowed": "Speech recognition is not allowed on this page. Type your request below instead.",
        "no-speech": "I didn't hear anything. Tap the mic and speak again.",
        "audio-capture": "No microphone was found. Type your request below instead.",
        "network": "Voice input needs internet. Type your request below instead.",
        "language-not-supported": "Speech recognition for this language isn't available in this browser. Switch to English or type below.",
        "aborted": "",
      }[err];
      voice.reply = msg ?? `Voice input stopped (${err}). Type your request below instead.`;
      render();
    });
  voice.listening = !!voice.rec;
  render();
}

// Spoken updates for the vendor whose screen is open
function announceChanges() {
  for (const p of pickups) {
    const before = lastStatus[p.id];
    if (!firstLoad && before && before !== p.status && voice.updates && tab === "vendor" && p.vendor === vendorId) {
      if (p.status === "assigned") { const eta = etaFor(p.vendor); Voice.say(`${driverById[p.driverId]?.name || "A driver"} is assigned${eta ? `, about ${eta.min} minutes away` : ""}.`, `ಚಾಲಕರು ಬರುತ್ತಿದ್ದಾರೆ.`, voice.lang); }
      if (p.status === "collected") Voice.say(`Shells collected: ${p.actualKg} kilos. Payment after hub confirmation.`, "ನಿಮ್ಮ ಚಿಪ್ಪುಗಳನ್ನು ಸಂಗ್ರಹಿಸಲಾಗಿದೆ.", voice.lang);
      if (p.status === "confirmed") { Voice.say(`Payment confirmed. ${p.payout} rupees added to your earnings.`, `ಪಾವತಿ ದೃಢಪಟ್ಟಿದೆ. ${p.payout} ರೂಪಾಯಿ ಸೇರಿಸಲಾಗಿದೆ.`, voice.lang); toast(`${rupees(p.payout)} added for ${p.actualKg} kg`); }
    }
    lastStatus[p.id] = p.status;
  }
  firstLoad = false;
}

// ---------- 7. IVR CALL FLOW ----------
const IVR_TEXT = {
  welcome:  ["Welcome to CocoLoop. For English, press 1. ಕನ್ನಡಕ್ಕಾಗಿ 2 ಒತ್ತಿ.", null],
  unknown:  ["Sorry, this number is not registered with CocoLoop. Please contact your ward hub. Goodbye.", "ಈ ಸಂಖ್ಯೆ ನೋಂದಣಿ ಆಗಿಲ್ಲ. ದಯವಿಟ್ಟು ವಾರ್ಡ್ ಹಬ್ ಸಂಪರ್ಕಿಸಿ."],
  menu:     ["To request a pickup, press 1. To hear your confirmed earnings, press 2. To check your pickup, press 3.",
             "ಪಿಕಪ್ ಬೇಕಾದರೆ 1 ಒತ್ತಿ. ಗಳಿಕೆ ಕೇಳಲು 2 ಒತ್ತಿ. ಪಿಕಪ್ ಸ್ಥಿತಿ ತಿಳಿಯಲು 3 ಒತ್ತಿ."],
  sacks:    ["Enter the number of sacks, then press hash.", "ಎಷ್ಟು ಚೀಲಗಳು ಇವೆ ಎಂದು ನಮೂದಿಸಿ, ನಂತರ # ಒತ್ತಿ."],
  badSacks: ["Please enter a number from 1 to 20, then press hash.", "1 ರಿಂದ 20 ರೊಳಗಿನ ಸಂಖ್ಯೆ ನಮೂದಿಸಿ, ನಂತರ # ಒತ್ತಿ."],
  invalid:  ["Invalid choice. Please try again.", "ತಪ್ಪು ಆಯ್ಕೆ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ."],
  already:  ["You already have a pickup in progress. Goodbye.", "ನಿಮ್ಮ ಪಿಕಪ್ ಈಗಾಗಲೇ ಪ್ರಗತಿಯಲ್ಲಿದೆ. ಧನ್ಯವಾದಗಳು."],
  booked:   ["Thank you. Your pickup is booked. The hub will assign a driver. Goodbye.",
             "ಧನ್ಯವಾದಗಳು. ನಿಮ್ಮ ಪಿಕಪ್ ಬುಕ್ ಆಗಿದೆ. ಹಬ್ ಚಾಲಕರನ್ನು ನೇಮಿಸುತ್ತದೆ."],
};

function ivrSay(en, kn) {
  ivr.prompt = ivr.lang === "kn" && kn ? kn : en;
  ivr.log.push({ who: "IVR", text: ivr.prompt });
  if (ivr.speak) Voice.say(en, kn, ivr.lang);
}
const ivrSayKey = key => ivrSay(...IVR_TEXT[key]);

function ivrStart() {
  ivr.state = "lang"; ivr.lang = "en"; ivr.digits = ""; ivr.log = [];
  ivr.log.push({ who: "Caller", text: `Calls ${HELPLINE} from ${ivr.caller === "unknown" ? "an unregistered number" : vendorById[ivr.caller].phone}` });
  ivrSayKey("welcome");
}
function ivrEnd(text) { ivr.state = "ended"; if (text) ivr.log.push({ who: "Caller", text }); }

function ivrStatusText(id) {
  const o = vendorFacts(id).open;
  if (!o) return ["You have no pickup in progress.", "ಯಾವುದೇ ಪಿಕಪ್ ಬಾಕಿ ಇಲ್ಲ."];
  if (o.status === "requested") return ["Your request is waiting for a driver.", "ನಿಮ್ಮ ವಿನಂತಿ ಚಾಲಕರಿಗಾಗಿ ಕಾಯುತ್ತಿದೆ."];
  if (o.status === "assigned") { const eta = etaFor(id); return [`A driver is on the way${eta ? `, about ${eta.min} minutes away` : ""}.`, `ಚಾಲಕರು ಬರುತ್ತಿದ್ದಾರೆ${eta ? `. ಸುಮಾರು ${eta.min} ನಿಮಿಷಗಳು` : ""}.`]; }
  return [`Your shells were collected, ${o.actualKg} kilos, and are waiting for hub confirmation.`, "ನಿಮ್ಮ ಚಿಪ್ಪುಗಳನ್ನು ಸಂಗ್ರಹಿಸಲಾಗಿದೆ. ಹಬ್ ದೃಢೀಕರಣಕ್ಕಾಗಿ ಕಾಯುತ್ತಿದೆ."];
}

async function ivrKey(k) {
  ivr.log.push({ who: "Caller", text: `Pressed ${k}` });
  const id = ivr.caller;
  if (ivr.state === "lang") {
    if (k !== "1" && k !== "2") return ivrSayKey("invalid");
    ivr.lang = k === "2" ? "kn" : "en";
    if (id === "unknown") { ivrSayKey("unknown"); return ivrEnd(); }
    ivr.state = "menu"; return ivrSayKey("menu");
  }
  if (ivr.state === "menu") {
    const f = vendorFacts(id);
    if (k === "1") { ivr.state = "sacks"; ivr.digits = ""; return ivrSayKey("sacks"); }
    if (k === "2") return ivrSay(`Your confirmed earnings today are ${f.earnedToday} rupees, and ${f.earnedTotal} rupees in total. ${IVR_TEXT.menu[0]}`,
                                 `ಇಂದು ದೃಢಪಟ್ಟ ಗಳಿಕೆ ${f.earnedToday} ರೂಪಾಯಿ. ${IVR_TEXT.menu[1]}`);
    if (k === "3") { const [en, kn] = ivrStatusText(id); return ivrSay(`${en} ${IVR_TEXT.menu[0]}`, `${kn} ${IVR_TEXT.menu[1]}`); }
    return ivrSay(`${IVR_TEXT.invalid[0]} ${IVR_TEXT.menu[0]}`, `${IVR_TEXT.invalid[1]} ${IVR_TEXT.menu[1]}`);
  }
  if (ivr.state === "sacks") {
    if (k === "*") { ivr.digits = ""; return ivrSayKey("sacks"); }
    if (k !== "#") { if (ivr.digits.length < 2) ivr.digits += k; return; }
    const n = parseInt(ivr.digits, 10); ivr.digits = "";
    if (!n || n < 1 || n > 20) return ivrSayKey("badSacks");
    ivr.sacks = n; ivr.state = "confirm";
    return ivrSay(`You entered ${plural(n, "sack")}. To confirm, press 1. To re-enter, press 2.`, `ನೀವು ${n} ಚೀಲಗಳನ್ನು ನಮೂದಿಸಿದ್ದೀರಿ. ಖಚಿತಪಡಿಸಲು 1, ಮತ್ತೆ ನಮೂದಿಸಲು 2 ಒತ್ತಿ.`);
  }
  if (ivr.state === "confirm") {
    if (k === "2") { ivr.state = "sacks"; return ivrSayKey("sacks"); }
    if (k !== "1") return ivrSayKey("invalid");
    const res = await bookPickup(id, ivr.sacks, "ivr");
    ivrSayKey(res.ok ? "booked" : "already");
    return ivrEnd();
  }
}

// ---------- 8. ACTIONS ----------
async function assignPickup(id, dId) {
  if (!driverById[dId]) { toast("Choose a driver first."); return false; }
  const uid = uidFor("driver", dId);
  if (Auth.mode() === "firebase" && !uid) { toast(`${driverById[dId].name} has no account in Firebase yet (users collection).`); return false; }
  await Store.update(id, { status: "assigned", driverId: dId, driverUid: uid, assignedAt: Date.now() });
  return true;
}

async function loadSampleDay() {
  const now = Date.now(), min = 60e3, base = { sample: true };
  const v = id => ({ vendor: id, vendorUid: uidFor("vendor", id) });
  const d = id => ({ driverId: id, driverUid: uidFor("driver", id) });
  await Store.add({ ...base, ...v("v2"), sacks: 2, estKg: 44, status: "confirmed", source: "ivr", ...d("d2"), actualKg: 46, payout: 46 * RATE, rate: RATE, paymentStatus: "due", requestedAt: now - 140 * min, assignedAt: now - 120 * min, collectedAt: now - 95 * min, confirmedAt: now - 80 * min });
  await Store.add({ ...base, ...v("v4"), sacks: 4, estKg: 88, status: "collected", source: "voice", ...d("d1"), actualKg: 90, requestedAt: now - 90 * min, assignedAt: now - 70 * min, collectedAt: now - 20 * min });
  await Store.add({ ...base, ...v("v1"), sacks: 3, estKg: 66, status: "assigned", source: "app", ...d("d1"), requestedAt: now - 50 * min, assignedAt: now - 30 * min });
  await Store.add({ ...base, ...v("v3"), sacks: 2, estKg: 44, status: "requested", source: "ivr", requestedAt: now - 45 * min });
  await Store.add({ ...base, ...v("v5"), sacks: 5, estKg: 110, status: "requested", source: "app", requestedAt: now - 12 * min });
}

// ---------- 9. CLICKS AND INPUTS ----------
document.addEventListener("click", async e => {
  const b = e.target.closest("button");
  if (!b || b.form) return;              // buttons inside forms are handled by "submit"
  try {
    if (b.dataset.tab) { tab = b.dataset.tab; confirmReset = false; if (Voice.canSpeak) speechSynthesis.cancel(); render(); scrollTo(0, 0); return; }
    if (b.dataset.demoUser) { Auth.signInDemo(b.dataset.demoUser); return; }
    if (b.id === "useDemo") { Auth.useDemoInstead(); return; }
    if (b.id === "signOutBtn" || b.id === "signOutBtn2") { await Auth.signOut(); return; }

    // Vendor
    // Owner: collection records CRUD
    if (b.dataset.recEdit) { srv.recs.editId = b.dataset.recEdit; srv.recs.delId = null; srv.recs.msg = ""; render(); return; }
    if (b.dataset.recDel) { srv.recs.delId = b.dataset.recDel; srv.recs.editId = null; srv.recs.msg = ""; render(); return; }
    if (b.dataset.recCancel) { srv.recs.editId = srv.recs.delId = null; render(); return; }
    if (b.dataset.recMore) { srv.recs.limit += 25; await loadRecords(); render(); return; }
    if (b.dataset.recSave) {
      const c = { date: $("#edDate").value, vendor: $("#edVendor").value, kg: $("#edKg").value };
      try { const r = await Store.updateCollection(b.dataset.recSave, c); srv.recs.editId = null; srv.recs.msg = `Updated: ${vendorById[r.vendor]?.name || r.vendor}, ${r.kg} kg on ${dayLabel(r.date)}. Graphs recalculated.`; }
      catch (err) { srv.recs.msg = `Not updated: ${err.message}`; }
      render(); return;
    }
    if (b.dataset.recDelYes) {
      try { await Store.deleteCollection(b.dataset.recDelYes); srv.recs.delId = null; srv.recs.msg = "Record deleted. Graphs recalculated."; }
      catch (err) { srv.recs.msg = `Not deleted: ${err.message}`; }
      render(); return;
    }

    if (b.dataset.vlang) { voice.lang = b.dataset.vlang; voice.reply = ""; render(); return; }
    if (b.id === "micBtn") { toggleMic(); return; }
    if (b.id === "voiceConfirm") {
      const n = voice.pendingSacks; voice.pendingSacks = null; b.disabled = true;
      const res = await bookPickup(vendorId, n, "voice");
      voice.action = { action: "request_pickup", sacks: n, result: res.ok ? "created" : "rejected" };
      reply(res.ok ? `Done. Pickup requested for ${plural(n, "sack")}. The hub will assign a driver.` : res.reason,
            res.ok ? `ಆಯಿತು. ${n} ಚೀಲಗಳಿಗೆ ಪಿಕಪ್ ವಿನಂತಿ ಆಗಿದೆ.` : null);
      render(); return;
    }
    if (b.id === "voiceCancel") { voice.pendingSacks = null; voice.reply = "Cancelled. No pickup was requested."; voice.action = { action: "request_pickup", result: "cancelled" }; render(); return; }
    if (b.id === "minus") { sacks = Math.max(1, sacks - 1); render(); return; }
    if (b.id === "plus") { sacks = Math.min(20, sacks + 1); render(); return; }
    if (b.id === "requestBtn") {
      b.disabled = true;
      const res = await bookPickup(vendorId, sacks, "app");
      toast(res.ok ? `Pickup requested for ${vendorById[vendorId].name}'s stall` : res.reason);
      render(); return;
    }

    // Driver
    if (b.dataset.cost) { routeOpts.cost = b.dataset.cost; render(); return; }
    if (b.id === "readStop") {
      const s = planRoute(driverId).order[0];
      if (s) Voice.say(`Next stop: ${s.vendor.name}, ${s.vendor.stall}. ${s.leg.km.toFixed(1)} kilometres, about ${Math.max(1, Math.round(s.leg.min))} minutes. ${plural(s.pickup.sacks, "sack")}.`, null, "en");
      return;
    }
    if (b.dataset.collect) {
      const id = b.dataset.collect;
      const kg = Number(document.getElementById("kg-" + id).value);
      if (!Number.isFinite(kg) || kg < 1 || kg > 500) { toast("Enter the weight on the scale, between 1 and 500 kg."); return; }
      b.disabled = true;
      await Store.update(id, { status: "collected", actualKg: Math.round(kg * 10) / 10, collectedAt: Date.now() });
      delete typedWeights[id];
      toast(`Logged ${kg} kg. Waiting for hub confirmation.`);
      return;
    }

    // Hub
    if (b.dataset.assign) {
      const id = b.dataset.assign, dId = document.getElementById("as-" + id).value;
      b.disabled = true;
      if (await assignPickup(id, dId)) { delete assignChoice[id]; toast(`Assigned to ${driverById[dId].name}`); } else render();
      return;
    }
    if (b.id === "autoAssign") {
      b.disabled = true;
      const { suggestions } = plannerData();
      let n = 0;
      for (const s of suggestions) if (s.driverId && await assignPickup(s.pickup.id, s.driverId)) n++;
      const left = suggestions.length - n;
      toast(`${plural(n, "pickup")} assigned${left ? ` · ${left} waiting (no cart space)` : ""}`);
      return;
    }
    if (b.dataset.confirm) {
      const id = b.dataset.confirm;
      const kg = Number(document.getElementById("ck-" + id).value);
      if (!Number.isFinite(kg) || kg < 1 || kg > 500) { toast("Enter the confirmed weight, between 1 and 500 kg."); return; }
      const w = Math.round(kg * 10) / 10;
      b.disabled = true;
      await Store.update(id, { status: "confirmed", actualKg: w, payout: Math.round(w * RATE * 100) / 100, rate: RATE, paymentStatus: "due", confirmedAt: Date.now() });
      delete confirmWeights[id];
      toast(`Confirmed ${w} kg · ${rupees(w * RATE)} recorded for the vendor`);
      return;
    }
    if (b.id === "sampleBtn") { b.disabled = true; await loadSampleDay(); toast("Sample day loaded (marked as Sample)"); return; }
    if (b.id === "clearSample") { b.disabled = true; await Store.removeSample(); toast("Sample data removed"); return; }
    if (b.id === "resetBtn") { confirmReset = true; render(); return; }
    if (b.id === "resetNo") { confirmReset = false; render(); return; }
    if (b.id === "resetYes") { confirmReset = false; await Store.removeAll(); toast("All pickups deleted"); render(); return; }

    // IVR
    if (b.id === "callBtn") { ivrStart(); render(); return; }
    if (b.id === "hangUp") { if (Voice.canSpeak) speechSynthesis.cancel(); ivrEnd("Hung up"); ivr.prompt = "Call ended."; render(); return; }
    if (b.dataset.key) { await ivrKey(b.dataset.key); render(); return; }
  } catch (err) {
    console.error(err);
    toast(err && err.code === "permission-denied" ? "Not allowed for your role (blocked by security rules)." : "Couldn't save. Check the internet connection and try again.");
    render();
  }
});

document.addEventListener("submit", async e => {
  e.preventDefault();
  if (e.target.id === "addColForm") {
    srv.form = { date: $("#acDate").value, vendor: $("#acVendor").value, kg: $("#acKg").value };
    srv.busy = true; srv.msg = ""; render();
    try {
      const r = await Store.addCollection(srv.form);
      srv.msg = `Saved: ${vendorById[r.vendor]?.name || r.vendor}, ${r.kg} kg on ${dayLabel(r.date)}. The graphs below were recalculated by the server.`;
      srv.form.kg = "";
    } catch (err) { srv.msg = `Not saved: ${err.message}`; }
    srv.busy = false; render();
    return;
  }
  if (e.target.id === "typeForm") {
    const text = $("#typeSay").value;
    voice.heard = text; voice.typed = "";
    handleSpeech(text);
  }
  if (e.target.id === "emailForm") {
    const email = $("#email").value.trim(), password = $("#password").value;   // read before re-render clears the form
    signIn.email = email;
    signIn.busy = true; signIn.error = ""; render();
    try { await Auth.signInEmail(email, password); }
    catch (err) { signIn.error = { "auth/invalid-credential": "Wrong email or password.", "auth/user-not-found": "No account with this email.", "auth/wrong-password": "Wrong password.", "auth/network-request-failed": "No internet connection." }[err.code] || `Sign-in failed (${err.code || err.message}).`; }
    signIn.busy = false; render();
  }
});

document.addEventListener("change", async e => {
  const t = e.target;
  if (t.id === "csvIn" && t.files && t.files[0]) {
    srv.msg = "Importing…"; render();
    try { const r = await Store.importCsv(t.files[0]); srv.msg = `Imported ${r.added} collection record(s) into the database.`; }
    catch (err) { srv.msg = `Import failed: ${err.message}`; }
    render(); return;
  }
  if (t.id === "recVendor") { srv.recs.vendor = t.value; srv.recs.limit = 15; srv.recs.editId = srv.recs.delId = null; await loadRecords(); render(); return; }
  if (t.id === "vendorSel") { vendorId = t.value; voice.pendingSacks = null; voice.reply = ""; voice.heard = ""; voice.action = null; render(); }
  if (t.id === "driverSel") { driverId = t.value; render(); }
  if (t.id === "callerSel") { ivr.caller = t.value; render(); }
  if (t.id === "voiceUpdates") voice.updates = t.checked;
  if (t.id === "ivrSpeak") { ivr.speak = t.checked; if (!ivr.speak && Voice.canSpeak) speechSynthesis.cancel(); }
  if (t.id === "trafficToggle") { routeOpts.heavyTraffic = t.checked; render(); }
  if (t.id === "allowSample") { insightsOpts.allowSample = t.checked; render(); }
  if (t.dataset && t.dataset.assignChoice) assignChoice[t.dataset.assignChoice] = t.value;
  if (t.id === "shellType") photo.type = t.value;
  if (t.id === "photoIn" && t.files && t.files[0]) {
    if (photo.url) URL.revokeObjectURL(photo.url);
    photo.url = URL.createObjectURL(t.files[0]); photo.name = t.files[0].name; render();
  }
});
document.addEventListener("input", e => {
  const t = e.target;
  if (t.dataset && t.dataset.kg) typedWeights[t.dataset.kg] = t.value;
  if (t.dataset && t.dataset.ck) {
    confirmWeights[t.dataset.ck] = t.value;
    const btn = document.querySelector(`[data-confirm="${t.dataset.ck}"]`);
    if (btn) btn.textContent = `Confirm & record ${rupees((Number(t.value) || 0) * RATE)}`;
  }
  if (t.id === "typeSay") voice.typed = t.value;
});
document.addEventListener("keydown", e => {
  if (tab !== "ivr" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (/^[0-9*#]$/.test(e.key) && ivr.state !== "idle" && ivr.state !== "ended") ivrKey(e.key).then(render);
});

// ---------- 10. START ----------
const fromLink = location.hash.slice(1);
Auth.init(async user => {
  pickups = []; firstLoad = true; userDir = null;
  if (user && user.role) {
    if (user.vendorId) vendorId = user.vendorId;
    if (user.driverId) driverId = user.driverId;
    if (Auth.tabsFor(user.role).includes(fromLink)) tab = fromLink; else tab = null;
    const live = Auth.mode() === "firebase";
    Store.start((list, message) => { pickups = list; announceChanges(); render(); if (message) toast(message); },
                { live, query: Auth.pickupQuery() });
    if (live && (user.role === "owner" || user.role === "hub")) {
      try { userDir = await Store.loadUserDirectory(); } catch (e) { console.error(e); toast("Couldn't load the user list from Firebase."); }
    }
  } else {
    Store.stop();
  }
  render();
});
