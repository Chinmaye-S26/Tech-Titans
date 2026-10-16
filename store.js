// =====================================================================
// STORE: where pickups are saved
// ---------------------------------------------------------------------
//   API  -> Python backend (backend/app.py, SQLite database). Used when the
//           app is opened from the Python server (http://127.0.0.1:5000).
//           Every device sees the same data; the owner dashboard is
//           calculated by the server from the database.
//   LIVE -> Firebase Firestore (only after a real Firebase sign-in).
//           Each role loads only the pickups firestore.rules allow.
//   DEMO -> localStorage (this browser only). Clearly labelled as demo.
//
// Pickup document (collection "pickups") — see README "Data model":
// { vendor: "v1", vendorUid, sacks: 3, estKg: 66,          // vendor's request (estimate)
//   status: "requested" | "assigned" | "collected" | "confirmed",
//   driverId: "d1", driverUid,                              // set by hub when assigned
//   actualKg: 64,                                           // weighed by driver at the stall
//   payout: 64, rate: 1, paymentStatus: "due",              // set ONLY when hub confirms actual weight
//   requestedAt, assignedAt, collectedAt, confirmedAt,      // times (ms)
//   source: "app" | "voice" | "ivr", shellType, sample: true|undefined }
// =====================================================================

const Store = (() => {
  const LS_KEY = "cocoloop-pickups-v2";
  let mode = "demo";
  let col = null, unsub = null, storageHooked = false;
  let onChange = () => {};
  let cache = [];
  let apiTimer = null, apiVersion = null, apiFails = 0;
  const POLL_MS = 2000;

  // ---------- Python backend (REST API) ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || (body.errors || []).join("; ") || `Server error ${res.status}`);
    return body;
  }
  async function refreshFromApi() {
    const body = await api("/api/pickups");
    apiVersion = body.version; cache = body.pickups; onChange(cache);
  }
  // Check every 2 s whether anything changed on the server (any device)
  async function poll() {
    try {
      const { version } = await api("/api/version");
      apiFails = 0;
      if (version !== apiVersion) await refreshFromApi();
    } catch (e) {
      if (++apiFails === 3) onChange(cache, "Can't reach the CocoLoop server. Is python backend/app.py still running?");
    }
  }
  async function startApi() {
    try {
      const h = await api("/api/health");
      if (!h.ok) throw new Error("not CocoLoop");
    } catch (e) { return false; }
    mode = "api";
    await refreshFromApi();
    apiTimer = setInterval(poll, POLL_MS);
    return true;
  }
  const onServer = () => location.protocol.startsWith("http");

  const newId = () => Math.random().toString(36).slice(2, 10);

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (e) { return []; }
  }
  function writeLocal(list) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (e) {}
    cache = list; onChange(cache);
  }

  // live = true only when Auth is in Firebase mode with a signed-in user
  function start(callback, { live = false, query = null } = {}) {
    onChange = callback;
    stop();
    if (live && typeof firebase !== "undefined" && firebase.apps && firebase.apps.length) {
      try {
        col = firebase.firestore().collection("pickups");
        const ref = query ? col.where(query[0], "==", query[1]) : col;
        mode = "live";
        unsub = ref.onSnapshot(
          snap => { cache = snap.docs.map(d => ({ id: d.id, ...d.data() })); onChange(cache); },
          err => { console.error(err); onChange(cache, "Couldn't load pickups from Firebase: " + (err.code || err.message)); }
        );
        return mode;
      } catch (e) { console.error(e); }
    }
    if (onServer()) {
      mode = "api"; cache = []; onChange(cache);            // try the Python backend first
      startApi().then(ok => { if (!ok) goDemo(); });
      return mode;
    }
    goDemo();
    return mode;
  }

  function stop() {
    if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
    if (apiTimer) { clearInterval(apiTimer); apiTimer = null; apiVersion = null; }
    mode = "demo"; col = null;
  }

  function goDemo(message) {
    mode = "demo"; col = null;
    cache = readLocal(); onChange(cache, message);
    if (!storageHooked) {
      storageHooked = true;
      window.addEventListener("storage", e => { if (mode === "demo" && e.key === LS_KEY) { cache = readLocal(); onChange(cache); } });
    }
  }

  async function add(pickup) {
    if (mode === "api") { await api("/api/pickups", { method: "POST", body: JSON.stringify(pickup) }); await refreshFromApi(); return; }
    if (mode === "live") { await col.add(pickup); return; }
    writeLocal([...readLocal(), { id: newId(), ...pickup }]);
  }
  async function update(id, changes) {
    if (mode === "api") { await api(`/api/pickups/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) }); await refreshFromApi(); return; }
    if (mode === "live") { await col.doc(id).update(changes); return; }
    writeLocal(readLocal().map(p => (p.id === id ? { ...p, ...changes } : p)));
  }
  async function removeAll() {
    if (mode === "api") { await api("/api/pickups", { method: "DELETE" }); await refreshFromApi(); return; }
    if (mode === "live") { for (const p of cache) await col.doc(p.id).delete(); return; }
    writeLocal([]);
  }
  async function removeSample() {
    if (mode === "api") { await api("/api/pickups?sample=1", { method: "DELETE" }); await refreshFromApi(); return; }
    if (mode === "live") { for (const p of cache.filter(p => p.sample)) await col.doc(p.id).delete(); return; }
    writeLocal(readLocal().filter(p => !p.sample));
  }

  // Firebase only: map driverId/vendorId -> uid from the users collection (owner and hub can read it)
  async function loadUserDirectory() {
    if (mode !== "live") return null;
    const snap = await firebase.firestore().collection("users").get();
    const dir = { driver: {}, vendor: {} };
    snap.forEach(d => { const u = d.data(); if (u.role === "driver" && u.driverId) dir.driver[u.driverId] = d.id; if (u.role === "vendor" && u.vendorId) dir.vendor[u.vendorId] = d.id; });
    return dir;
  }

  // Owner dashboard (API mode): numbers calculated by the Python server
  const getStats = () => api("/api/stats?days=28");
  async function addCollection(c) { const r = await api("/api/collections", { method: "POST", body: JSON.stringify(c) }); await refreshFromApi(); return r; }
  // Collection records CRUD (owner): Read, Update, Delete (Create = addCollection / importCsv)
  const listCollections = (vendor = "", limit = 15) => api(`/api/collections?limit=${limit}${vendor ? "&vendor=" + encodeURIComponent(vendor) : ""}`);
  async function updateCollection(id, c) { const r = await api(`/api/collections/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(c) }); await refreshFromApi(); return r; }
  async function deleteCollection(id) { const r = await api(`/api/collections/${encodeURIComponent(id)}`, { method: "DELETE" }); await refreshFromApi(); return r; }
  async function importCsv(file) {
    const fd = new FormData(); fd.append("file", file);
    const res = await fetch("/api/import", { method: "POST", body: fd });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || (body.errors || []).join("; ") || `Server error ${res.status}`);
    await refreshFromApi(); return body;
  }

  return { start, stop, add, update, removeAll, removeSample, loadUserDirectory, getStats, addCollection, importCsv, listCollections, updateCollection, deleteCollection,
           mode: () => mode, version: () => apiVersion };
})();
