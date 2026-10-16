// =====================================================================
// CocoLoop IVR server (real phone line)
// ---------------------------------------------------------------------
// A cloud telephony provider (Twilio here; Exotel works the same way)
// answers the phone call and asks this server what to say next. Each
// key the caller presses is sent here. When the caller confirms, we
// save the pickup to Firebase, so it appears live on the Hub screen.
//
// Run:   node server.js          (Node.js 18 or newer, no npm install)
// Needs these environment variables (kept on the server, NEVER in the website):
//   FIREBASE_PROJECT_ID, FIREBASE_API_KEY   same values as firebase-config.js
//   FIREBASE_IVR_EMAIL, FIREBASE_IVR_PASSWORD
//        a Firebase account you create for this server, with role "hub" in
//        users/{uid}. firestore.rules only let signed-in hub/owner accounts
//        create pickups for a vendor, so the server signs in as this account.
// Without them it runs in "dry run" mode and only prints the pickup.
// =====================================================================

const http = require("http");

const PORT = process.env.PORT || 3000;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";
const API_KEY = process.env.FIREBASE_API_KEY || "";
const IVR_EMAIL = process.env.FIREBASE_IVR_EMAIL || "";
const IVR_PASSWORD = process.env.FIREBASE_IVR_PASSWORD || "";
const KG_PER_SACK = 22;

// Registered vendors: caller phone number -> stall id used in the app.
// Replace these with your vendors' real numbers (format: +91XXXXXXXXXX).
const CALLERS = {
  "+919000000101": "v1",   // Ravi, 8th Cross Road
  "+919000000102": "v2",   // Manjula, Bus Stand
  "+919000000103": "v3",   // Imran, Temple Road
  "+919000000104": "v4",   // Lakshmamma, Market Gate
  "+919000000105": "v5",   // Suresh, College Gate
};

// ---------- helpers to build the reply (TwiML = XML that tells Twilio what to do) ----------
const xmlEscape = s => String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
const say = text => `<Say voice="Polly.Aditi" language="en-IN">${xmlEscape(text)}</Say>`;
const twiml = inner => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const gather = (action, prompt, opts = "") =>
  `<Gather input="dtmf" action="${action}" method="POST" timeout="8" ${opts}>${say(prompt)}</Gather>`;

const MENU = "To request a pickup of coconut shells, press 1. To speak to the ward hub, press 2.";
const SACKS = "Enter the number of sacks, then press hash.";

// ---------- save a pickup to Firestore (REST API, no extra packages) ----------
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
let token = null, tokenUntil = 0, vendorUids = null;

// Sign in as the server's hub account (Firebase Auth REST API) and keep the ID token for ~55 min
async function idToken() {
  if (token && Date.now() < tokenUntil) return token;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: IVR_EMAIL, password: IVR_PASSWORD, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("IVR account sign-in failed: " + (data.error && data.error.message));
  token = data.idToken; tokenUntil = Date.now() + (Number(data.expiresIn) - 300) * 1000;
  return token;
}

// vendorId -> uid, read from the users collection (hub accounts may read it)
async function vendorUid(vendor) {
  if (!vendorUids) {
    const res = await fetch(`${FS}/users?pageSize=300`, { headers: { Authorization: "Bearer " + await idToken() } });
    if (!res.ok) throw new Error("Could not read users: " + res.status);
    vendorUids = {};
    for (const d of (await res.json()).documents || []) {
      const f = d.fields || {};
      if (f.role && f.role.stringValue === "vendor" && f.vendorId) vendorUids[f.vendorId.stringValue] = d.name.split("/").pop();
    }
  }
  return vendorUids[vendor] || null;
}

async function savePickup(vendor, sacks, phone) {
  const pickup = { vendor, sacks, estKg: sacks * KG_PER_SACK, status: "requested", requestedAt: Date.now(), source: "ivr" };
  if (!PROJECT_ID || !API_KEY || !IVR_EMAIL || !IVR_PASSWORD) {
    console.log("[dry run] would save pickup:", pickup);
    return true;
  }
  try {
    const uid = await vendorUid(vendor);
    if (!uid) { console.error(`No vendor account with vendorId "${vendor}" in users. Not saved.`); return false; }
    const body = { fields: {
      vendor: { stringValue: vendor },
      vendorUid: { stringValue: uid },
      sacks: { integerValue: String(sacks) },
      estKg: { integerValue: String(pickup.estKg) },
      status: { stringValue: "requested" },
      requestedAt: { integerValue: String(pickup.requestedAt) },
      source: { stringValue: "ivr" },
    } };
    const res = await fetch(`${FS}/pickups`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + await idToken() }, body: JSON.stringify(body) });
    if (!res.ok) { console.error("Firestore error", res.status, await res.text()); return false; }
    console.log(`Saved IVR pickup: ${vendor} (${phone}), ${sacks} sacks`);
    return true;
  } catch (e) { console.error(e.message); return false; }
}

// ---------- call flow ----------
// /ivr/welcome  -> greeting + main menu
// /ivr/menu     -> handles the menu key
// /ivr/sacks    -> handles the number of sacks
// /ivr/confirm  -> handles confirm (1) or re-enter (2), then saves
async function handle(path, params, query) {
  const from = params.From || "";
  const vendor = CALLERS[from];
  const digits = params.Digits || "";

  if (path === "/ivr/welcome") {
    if (!vendor) return say("Sorry, this number is not registered with CocoLoop. Please contact your ward hub. Goodbye.") + "<Hangup/>";
    return gather("/ivr/menu", `Welcome to CocoLoop. ${MENU}`, 'numDigits="1"') + `<Redirect method="POST">/ivr/welcome</Redirect>`;
  }
  if (path === "/ivr/menu") {
    if (digits === "1") return gather("/ivr/sacks", SACKS, 'finishOnKey="#"') + `<Redirect method="POST">/ivr/menu?again=1</Redirect>`;
    if (digits === "2") return say("Please wait while we connect you to the ward hub.") + say("The hub is not available right now. Please call again later. Goodbye.") + "<Hangup/>";
    return gather("/ivr/menu", `Invalid choice. ${MENU}`, 'numDigits="1"');
  }
  if (path === "/ivr/sacks") {
    const n = parseInt(digits, 10);
    if (!n || n < 1 || n > 20) return gather("/ivr/sacks", `Please enter a number from 1 to 20. ${SACKS}`, 'finishOnKey="#"');
    return gather(`/ivr/confirm?sacks=${n}`, `You entered ${n} sack${n === 1 ? "" : "s"}. To confirm, press 1. To re-enter, press 2.`, 'numDigits="1"');
  }
  if (path === "/ivr/confirm") {
    const n = parseInt(query.get("sacks"), 10);
    if (digits === "2") return gather("/ivr/sacks", SACKS, 'finishOnKey="#"');
    if (digits !== "1" || !n) return gather(`/ivr/confirm?sacks=${n}`, "To confirm, press 1. To re-enter, press 2.", 'numDigits="1"');
    const ok = await savePickup(vendor, n, from);
    return say(ok ? "Thank you. Your pickup is booked. The hub will assign a driver. Goodbye."
                  : "Sorry, we could not book your pickup right now. Please try again later. Goodbye.") + "<Hangup/>";
  }
  return null;
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("CocoLoop IVR server is running. Point your Twilio number's voice webhook to /ivr/welcome");
  }
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", async () => {
    try {
      const params = Object.fromEntries(new URLSearchParams(raw));   // Twilio sends form data
      const inner = await handle(url.pathname, params, url.searchParams);
      if (inner === null) { res.writeHead(404); return res.end("Not found"); }
      console.log(`${url.pathname} from=${params.From || "?"} digits=${params.Digits || ""}`);
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(twiml(inner));
    } catch (err) {
      console.error(err);
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(twiml(say("Sorry, something went wrong. Please call again later.") + "<Hangup/>"));
    }
  });
}).listen(PORT, () => console.log(`CocoLoop IVR server on http://localhost:${PORT}  (${PROJECT_ID ? "saving to Firebase project " + PROJECT_ID : "dry run: set FIREBASE_PROJECT_ID and FIREBASE_API_KEY to save"})`));
