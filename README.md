# CocoLoop

**Team Tech Titans** · Dhumbi Shree B R (Team Leader), Chinmaye S, Lekhana H, Sri Lakshmi M S · BGSCET ISE · Anveshan 2026

CocoLoop turns Bengaluru's tender coconut shells into cocopeat, coir and income.
One web app. Each person signs in and sees only the screens for their role:

| Screen | Who can open it | What it does |
|---|---|---|
| **AI Insights** | Owner only | Actual totals per vendor, **ML demand forecast** (next day and next 7 days, with error checked on held-out days), high-demand zones, recommendations |
| **Hub** | Owner, hub staff | **Smart pickup planner**: priority score with reasons, zones, suggested driver within cart capacity, assign; confirm weighed kg (this is when the ₹1/kg payment is recorded); hotspot map; activity feed |
| **Driver** | Owner, hub staff, drivers (own pickups only) | **TSP-optimised route** (Held–Karp) with **distance and time** per leg, savings vs request order, cart load, log the weight on the scale |
| **Vendor** | Owner, vendors (own stall only) | Request a pickup by **tap or voice** (English / ಕನ್ನಡ) with a confirmation step, optional shell photo, status, confirmed earnings |
| **IVR Call** | Owner, vendors | Phone call with a spoken **Kannada/English keypad menu** that books a pickup |

A pickup goes **Requested → Driver assigned → Collected (weighed) → Confirmed by hub**. Earnings are counted only at the last step, from the weighed kg.

Built with **HTML, CSS, JavaScript** (no build tools), **Firebase Authentication + Firestore** (when set up), the browser's **Web Speech API**, and a small **Node.js IVR server**.

---

## Files

| File | What's inside | Owner |
|---|---|---|
| `index.html` | Page layout, loads everything | Everyone |
| `style.css` | Colours, fonts, layout (light + dark mode) | Everyone |
| `app.js` | All screens, sign-in screen, pickup lifecycle, planner and Insights screens, voice actions, IVR call flow | Vendor + voice: Chinmaye · Driver: Dhumbi Shree · Hub + Insights: Lekhana |
| `auth.js` | Sign-in (Firebase email/password, or demo users) and which tabs each role can open | Sri Lakshmi |
| `store.js` | Saves pickups: Firestore (live, only the pickups your role may read) or this browser (demo) | Sri Lakshmi |
| `firestore.rules` | **Server-side security**: who can read and change which pickups | Sri Lakshmi |
| `route.js` | Road network (graph), distance matrix, **Travelling Salesman Problem solver** (Held–Karp exact; nearest neighbour + 2-opt for big days), km and minutes per leg | Dhumbi Shree |
| `ml.js` | **Demand forecast**: ridge linear regression (day of week + trend), tested on held-out days | Dhumbi Shree |
| `planner.js` | **Smart pickup planner**: priority score, zones, capacity-aware driver suggestions | Lekhana |
| `charts.js` | Small SVG bar charts (actual / sample / forecast look different) | Lekhana |
| `classifier.js` | Shell photo classifier **placeholder (not active)** and how to add a real model | Chinmaye |
| `voice.js` | Speech-to-text, text-to-speech, understanding "3 sacks" | Chinmaye |
| `firebase-config.js` | Your Firebase web config (public web keys, not secrets) | Sri Lakshmi |
| `tests/route.test.js`, `tests/ml.test.js`, `tests/planner.test.js` | Automatic checks, e.g. `node tests/route.test.js` (TSP vs brute force) | Everyone |
| `ivr-server/server.js` | Real phone line via Twilio/Exotel; saves pickups to Firestore | Sri Lakshmi + Dhumbi Shree |
| `backend/app.py` | **Python backend (Flask + SQLite)**: REST API for pickups, serves the app, owner dashboard numbers | Sri Lakshmi |
| `backend/analytics.py` | **Dashboard maths in Python**: daily and weekly totals, per-vendor totals, ML forecast (ridge regression), accuracy check | Lekhana |
| `backend/test_backend.py` | Python tests: `python backend/test_backend.py` | Everyone |
| `backend/sample_collections.csv` | 8 weeks of example collections to import from the dashboard (date,vendor,kg) | Everyone |

---

## ⭐ Run it with the Python backend (do this first)

All data is stored in a **SQLite database** by a **Python (Flask) server**. The owner's dashboard is **calculated by the server from the database**: add data, and the graphs change within 2 seconds. Nothing on the dashboard is hard-coded.

1. Install **Python 3.10+** from python.org. On Windows, tick **"Add Python to PATH"** during install.
2. In VS Code: **Terminal → New Terminal**. Make sure you're in the `cocoloop` folder, then:
   ```bash
   pip install flask
   python backend/app.py
   ```
   You'll see `CocoLoop backend running … Open: http://127.0.0.1:5000`. **Keep this terminal open.**
   If Windows says `python` or `pip` is not recognised, use `py -m pip install flask` and `py backend/app.py`.
3. In Chrome, open **http://127.0.0.1:5000** (not Live Server, not double-clicking `index.html`). The badge says **Live · Python backend**.
4. Choose **Dhumbi Shree B R (Owner)** → **AI Insights**. With an empty database every number is 0 and the graphs are empty.
5. **Add data:** in **Add collection data**, choose a date, vendor and kg → **Add to database**. The totals, vendor table and daily graph update.
6. **Import a file:** **Import CSV** → choose `backend/sample_collections.csv` (271 records, 8 weeks). Weekly totals fill in, and the **ML forecast** appears (it needs 14 days of history).
7. **Live from a phone:** connect the phone to the **same hotspot** as the laptop. Find the laptop's IP (Windows: `ipconfig` → IPv4 Address, e.g. `192.168.43.25`) and open `http://192.168.43.25:5000` on the phone. If it doesn't load, allow Python through the Windows firewall when asked.
8. **Check it:** `python backend/test_backend.py` → **OK** (9 tests: adding data changes the totals and graph, CSV import, only confirmed kg counts, sample records excluded, bad input rejected, the model learns a weekly pattern).

**Start clean before judging:** Hub → **Delete all** (this empties the database). The database file is `backend/cocoloop.db`; delete it to start completely fresh.

**CRUD demo (Owner → AI Insights → "Collection records" table):** Create = "Add to database" or Import CSV; Read = the table (filter by vendor); Update = ✎ Edit → change kg/vendor/date → Save; Delete = 🗑 Delete → Yes, delete. Every change recalculates the totals and graphs.

**What to tell the judges:** *"The frontend only displays. All data goes through our Python REST API into SQLite. The dashboard calls `/api/stats`, which runs SQL aggregations and our regression model in `analytics.py`. Here, I'll add 50 kg for Ravi now, and you'll see the graph change."*

| API | What it does |
|---|---|
| `GET /api/pickups`, `POST /api/pickups`, `PATCH /api/pickups/<id>` | Vendor requests, hub assigns, driver collects, hub confirms |
| `POST /api/collections` | Owner adds a collection `{date, vendor, kg}` |
| `GET /api/collections?vendor=v1` | **Read**: list collection records (newest first) |
| `PUT /api/collections/<id>` | **Update**: change date, vendor or kg of a record |
| `DELETE /api/collections/<id>`, `DELETE /api/pickups/<id>` | **Delete** one record / one pickup |
| `POST /api/import` | Upload a CSV `date,vendor,kg` |
| `GET /api/stats` | Totals, status counts, per-vendor table, daily and weekly series, forecast |
| `GET /api/version` | Changes on every write; every screen checks it every 2 s and reloads |

Without the Python server (double-clicking `index.html` or Live Server), the app still works in **demo mode** on one device.

## Step 1: Run it in VS Code (5 minutes)

1. Unzip `CocoLoop_App.zip`. In **VS Code**: **File → Open Folder…** → choose the `cocoloop` folder.
2. **Easiest:** in the VS Code file list, right-click `index.html` → **Reveal in File Explorer** (Mac: Reveal in Finder) → double-click it. It opens in Chrome.
3. **Better (needed for the microphone on some laptops):** VS Code → **Extensions** (Ctrl+Shift+X) → install **Live Server** (by Ritwick Dey) → right-click `index.html` → **Open with Live Server**. It opens `http://127.0.0.1:5500/index.html`.
4. You see **"Choose who you are (demo)"** with a yellow **Demo sign-in, not secure** box. Firebase isn't set up yet, so anyone can pick any role and data stays in this browser.
5. Try the full flow (about 2 minutes):
   1. **Ravi** (vendor) → **Request pickup**. Status: *Waiting for a driver*. Earnings stay ₹0.
   2. **Sign out** (top right) → **Ward 45 hub** → Pickup priorities shows Ravi with a score → **Assign** (or **Assign all suggested**).
   3. Sign out → **Mahesh** (driver) → the route appears → type the weight on the scale, e.g. `64` → **Log weight & mark collected**.
   4. Sign out → **Ward 45 hub** → **Confirm collected weights** → **Confirm & record ₹64**.
   5. Sign out → **Ravi** → earnings now ₹64.
   6. Sign out → **Dhumbi Shree B R** (owner) → **AI Insights**.
6. **Run the automatic checks** (needs Node.js 18+ from nodejs.org): VS Code → **Terminal → New Terminal**, then
   ```bash
   node tests/route.test.js
   node tests/ml.test.js
   node tests/planner.test.js
   ```
   Each should end with "All … tests passed."

To edit code: change a file, **Ctrl+S**, refresh Chrome (Live Server refreshes by itself). Press **F12 → Console** to see errors.

## Step 2: Create the Firebase project (15 minutes, one person)

1. Go to **console.firebase.google.com** and sign in. (Firebase requires **2-Step Verification** on your Google account; turn it on when asked.) If college Wi-Fi blocks it, use a **mobile hotspot**.
2. **Create a project** → name `cocoloop` → Analytics off → **Create project**.
3. **Build → Firestore Database → Create database** → location **asia-south1 (Mumbai)** → **Start in production mode** → Create.
4. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save.**
5. **Project Overview** → web icon **`</>`** → nickname `cocoloop-web` → **Register app**. Keep the `firebaseConfig` block open.

## Step 3: Accounts, roles and security rules (15 minutes)

1. **Paste the config:** open `firebase-config.js` and copy each value from Firebase into the matching line (keep the quotes). These are public web keys, not secrets. Never put a service-account file or private key in the website.
2. **Publish the rules:** Firestore Database → **Rules** → delete everything → paste all of `firestore.rules` → **Publish**.
3. **Create accounts:** Authentication → **Users → Add user**: one per person, e.g. `owner@cocoloop.in`, `hub@cocoloop.in`, `mahesh@cocoloop.in`, `kiran@cocoloop.in`, `ravi@cocoloop.in` … Copy each **User UID**.
4. **Give each account a role:** Firestore Database → **Start collection** → ID `users`. For each account add a document whose **Document ID is that User UID**:

   | Person | Fields (all type *string*) |
   |---|---|
   | Owner | `role` = `owner`, `name` = `Dhumbi Shree B R` |
   | Hub staff | `role` = `hub`, `name` = `Ward 45 hub` |
   | Driver Mahesh | `role` = `driver`, `driverId` = `d1`, `name` = `Mahesh` |
   | Driver Kiran | `role` = `driver`, `driverId` = `d2`, `name` = `Kiran` |
   | Vendor Ravi | `role` = `vendor`, `vendorId` = `v1`, `name` = `Ravi` (v2 Manjula, v3 Imran, v4 Lakshmamma, v5 Suresh) |

   The website cannot set roles: the rules let only the owner write to `users`, so do this in the console.
5. Refresh the app. The badge says **Firebase · not signed in** and an email/password form appears. Sign in. The badge turns green: **Live · Firebase**.
6. **Test the security** (Firestore → Rules → **Rules Playground**, or with two browsers):
   - signed in as Ravi: the Hub tab is not shown, and Ravi sees only his own pickups;
   - signed in as Mahesh: only pickups assigned to Mahesh;
   - in Rules Playground, simulate an `update` on a pickup as a vendor UID setting `payout` → it must be **denied**.

If someone signs in and sees "Your account has no role yet", their `users/{UID}` document is missing or misspelled. "Use demo mode on this device instead" lets you keep demoing without accounts.

## Step 4: Put it online so phones can open it (10 minutes)

**GitHub Pages (recommended: judges also get your code link)**
1. github.com → **New repository** → name `cocoloop` → Public → Create.
2. **Add file → Upload files** → drag in all the files (and the `ivr-server` folder) → **Commit changes**.
3. **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → Save.
4. Wait 1–2 minutes. Your link: `https://<your-username>.github.io/cocoloop/`
5. Shortcut links: add `#vendor`, `#driver`, `#hub`, `#ivr` or `#insights` to the end. A link only opens a tab your role is allowed to see.

The voice assistant's microphone needs **https**, which GitHub Pages gives you. It also works when you double-click `index.html` on a laptop.

---

## Step 5: Route optimisation with the Travelling Salesman Problem (TSP)

**Where:** Driver tab.

The driver starts at the hub, must visit **every** assigned stall **once**, and come back. Choosing the order with the smallest total trip is the **Travelling Salesman Problem**.

1. The map shows the ward's **roads** (main roads 30 km/h, streets 18 km/h, lanes 12 km/h).
2. The **TSP tour** is drawn along the roads, with each stop numbered in the TSP order. Every leg has a label: **→ stop number · distance · time** (e.g. `→1 2.1 km · 5 min`).
3. Below the map: **total distance, driving time, and when the cart is back at the hub** (including 3 min loading at each stop).
4. The green **TSP solved** box shows the tour (e.g. *Hub → Imran → Manjula → Suresh → Lakshmamma → Hub*) and how much it **saves compared with visiting in request order** (e.g. *4 min less, 16%*).
5. **Fastest time / Shortest distance:** what the TSP minimises.
6. **Heavy traffic on Chord Road:** slows that road to 8 km/h; the costs change and the TSP is solved again.
7. **How the TSP route was found:** the **distance matrix** (every pair of points), the algorithm used and its number of states, and each leg's road path.

**How it works (`route.js`):**
- **Step 1, distance matrix.** The ward is a graph: 22 nodes (16 road junctions, the hub, 5 stalls) and 30 two-way roads, each with km and minutes. Roads aren't straight lines, so each matrix cell is the **shortest road path** between two points (computed with Dijkstra's algorithm, `dijkstra()`).
- **Step 2, solve the TSP** (`solveTSP()`):
  - **Up to 12 stops: Held–Karp dynamic programming (`heldKarp()`), the exact optimum.** `best[set][j]` = cheapest way to leave the hub, visit exactly the stops in `set`, and end at stop `j`. It builds bigger sets from smaller ones: `best[set][j] = min over k of best[set − j][k] + cost(k, j)`, then closes the loop back to the hub. Time is O(n²·2ⁿ) instead of trying all n! orders (for 10 stops: about 100,000 steps instead of 3.6 million orders).
  - **More than 12 stops: nearest neighbour + 2-opt** (`nearestNeighbour()`, `twoOpt()`). Build a tour by always going to the nearest unvisited stop, then keep reversing sections of the tour while that makes it shorter.
- **Step 3, follow the roads.** Each leg of the tour is drawn along the actual road path.
- **Checked by `tests/route.test.js`:** Held–Karp equals brute force (trying every order) on 250 random cases, including one-way costs; 2-opt never makes a tour longer; every tour visits each stop exactly once; the road shortest paths match Floyd–Warshall on all 22×22 pairs.

**If judges ask "Why do you still use Dijkstra?":** *"TSP needs the travel cost between every pair of stops. On a road network that's the shortest road path, not a straight line, so Dijkstra only fills the distance matrix. The TSP solver decides the order."*

**Next step:** real Bengaluru roads from OpenStreetMap; the same TSP code works on that matrix.

## Step 6: Voice assistant

**Where:** Vendor tab → **Voice assistant** box.

1. Choose **English** or **ಕನ್ನಡ**.
2. Tap **Tap and speak**. The first time, Chrome asks to use the microphone: click **Allow**.
3. Say one of these:
   - *"3 sacks ready"* / *"ಮೂರು ಚೀಲ ಇದೆ"* → the assistant reads it back → tap **Confirm pickup**. Nothing is booked until you confirm. Numbers outside 1–20, a missing number, or a second request while one is open are rejected with a spoken reason.
   - *"How much did I earn?"* / *"ನನ್ನ ಗಳಿಕೆ ಎಷ್ಟು?"* → it speaks today's earnings.
   - *"Where is my pickup?"* → it says whether the cart is on the way.
4. Under the mic, **"Understood as"** shows the structured action, e.g. `{"action":"request_pickup","sacks":3}` (also `check_earnings`, `check_status`, `unknown`).
5. Leave **"Speak updates about my pickup"** ticked. The phone speaks when a driver is assigned, when the shells are weighed, and when the hub confirms the payment.
6. Driver tab: **🔊 Read next stop** speaks the next stall's name.

**How it works:** `voice.js` uses Chrome's built-in speech recognition (`kn-IN` or `en-IN`) and speech synthesis. `understand()` finds the number of sacks (digits, English words, Kannada words like ಮೂರು, or Kannada digits like ೩) and the intent (request / earnings / status).

**If the mic doesn't work:** use the **"Type what you would say"** box; it goes through the same understanding code. Listening needs internet. Speaking Kannada needs a Kannada voice installed on the device; otherwise it speaks English and shows the Kannada text.

**Ask a Kannada speaker on your team to check the Kannada sentences** in `app.js` (search for `ಕ`) and fix any wording.

---

## Step 7: IVR phone line

### 7A. In-app IVR call (use this for the demo)

**Where:** **IVR Call** tab.

1. **Calling from:** choose a vendor (this is the caller ID, which tells the system which stall is calling).
2. Tap **📞 Call helpline**. The menu is spoken out loud.
3. Press **1** for English (or **2** for ಕನ್ನಡ) → **1** to request a pickup → type the sacks, e.g. **3**, then **#** → **1** to confirm.
4. The pickup appears on the Driver and Hub screens marked **"via IVR call"**.
5. Try **Unregistered number** to show that unknown callers are rejected.

You can also type the keys on the laptop keyboard (0–9, *, #).

### 7B. Real phone line with `ivr-server/server.js` (if time allows)

The server works with **Twilio** (easy free trial) and the same flow can be set up on **Exotel** (Indian provider, needs company KYC).

1. Install **Node.js 18+** from nodejs.org.
2. In a terminal:
   ```bash
   cd ivr-server
   set FIREBASE_PROJECT_ID=your-project-id        # Windows (Mac/Linux: export ...)
   set FIREBASE_API_KEY=your-api-key
   set FIREBASE_IVR_EMAIL=ivr@cocoloop.in          # an account with role "hub" in users
   set FIREBASE_IVR_PASSWORD=its-password
   node server.js
   ```
   You'll see `CocoLoop IVR server on http://localhost:3000`. These values stay on the server only. Without them it runs in **dry run** (prints the pickup, saves nothing).
3. Make it reachable from the internet: install **ngrok** (ngrok.com) and run `ngrok http 3000`. Copy the `https://….ngrok-free.app` link.
4. Twilio: create a free account → get a trial phone number → **Phone Numbers → your number → Voice → "A call comes in"** → Webhook → `https://….ngrok-free.app/ivr/welcome` (HTTP POST) → Save.
5. In `server.js`, put your real phone number in `CALLERS` (format `+91XXXXXXXXXX`). On a Twilio trial you must also verify that number in Twilio.
6. Call the Twilio number, follow the menu, and watch the pickup appear on the Hub.

Note: a Twilio trial number is usually a foreign number, so calls from India may cost international rates. For the demo, use **7A**; mention 7B as the production path.

---

## Step 8: AI and smart features

### 8A. Smart pickup planner (Hub tab) — `planner.js`
Not a black box. Each waiting request gets a **priority score out of 100**:

`50% waiting time (full at 120 min) + 30% quantity (full at 150 kg) + 20% closeness to hub (Dijkstra minutes)`

The coloured bar and the line under it show exactly where the points came from. Stalls within **6 minutes** of each other (Dijkstra travel time) form a **zone**. **Assign all suggested** goes from the highest score down, prefers the driver already serving that zone, and never exceeds the **250 kg** cart (using the estimate, 22 kg per sack). If no cart has space it says "keep for the next trip".

### 8B. Demand forecast (AI Insights tab, owner only) — `ml.js`
- **Model:** ridge linear regression on day-of-week and trend, trained in the browser.
- **Honest test:** the last **14 days are hidden** during training, then predicted. The screen shows the average error (MAE, MAPE) and compares it with a simple baseline ("same day last week"). On the sample data: **14.1 kg error vs 21.2 kg** for the baseline.
- **Output:** tomorrow and next 7 days, each with a likely range (80% interval).
- **Real vs sample:** it trains only on **hub-confirmed, weighed** pickups. It needs **21 days** of real history. Until then it uses a clearly labelled **synthetic sample history** (striped bars, yellow "Trained on SAMPLE data" banner). Untick *"Use sample history…"* to see the honest "not enough real data" message.
- Checked by `node tests/ml.test.js` (7 tests).

### 8C. Shell photo (Vendor tab) — `classifier.js`
Vendors can attach a photo and **choose the category themselves** (clean shells / mixed with plastic / not sure). **The AI classifier is not active**: there is no trained coconut-shell model, so the app does not guess. The photo stays on the phone; only the chosen category is saved. To add a real model: collect 100+ labelled photos per category, train with **Teachable Machine (Image project)**, test accuracy on unseen photos, export TensorFlow.js into a `model/` folder, then load it in `classifier.js` (steps in the file).

### 8D. Sample data
Hub → **Load sample day** adds 5 pickups marked **Sample** (all states). They are excluded from the owner's actual totals and from ML training. **Remove sample data** deletes only those.

---

## Data model (Firestore)

**`users/{uid}`** — `role` (owner | hub | driver | vendor), `name`, `vendorId` (vendors, e.g. `v1`), `driverId` (drivers, e.g. `d1`). Written only by the owner.

**`pickups/{id}`**

| Field | Set by | Meaning |
|---|---|---|
| `vendor`, `vendorUid` | vendor / IVR | Stall id and the vendor's account |
| `sacks`, `estKg` | vendor | Request; `estKg = sacks × 22` is an **estimate for planning only** |
| `source`, `shellType` | vendor | app / voice / ivr; category chosen by the vendor |
| `status` | everyone in turn | `requested` → `assigned` → `collected` → `confirmed` |
| `driverId`, `driverUid`, `assignedAt` | hub | Which driver |
| `actualKg`, `collectedAt` | driver | Weight on the scale |
| `actualKg` (final), `payout`, `rate`, `paymentStatus`, `confirmedAt` | hub | `payout = confirmed kg × ₹1`; `paymentStatus = "due"` until paid by UPI |
| `requestedAt` | vendor | Time (ms) |
| `sample` | demo only | `true` for sample records |

## Who can do what (enforced in `firestore.rules`)

| | Read pickups | Create | Change |
|---|---|---|---|
| **Owner** | all | yes | anything; delete; manage roles |
| **Hub** | all | yes (e.g. phone requests) | assign, confirm weight and payment |
| **Driver** | only assigned to them | no | only `assigned → collected` with `actualKg` 1–500 on their own pickup |
| **Vendor** | only their own | only for their own stall, `status = requested`, 1–20 sacks, no weight or payout | no |

Hiding tabs in the app is only for convenience; the rules are what actually block access. **In demo mode there is no security** (that's why it is labelled).

---

## Still needed for the real thing

| Item | Why | Who / where |
|---|---|---|
| Firebase config + Email/Password auth + rules + `users` documents | Real sign-in and real security (Steps 2–3). **Not tested against a live Firebase project yet**: test with the checklist in Step 3.6 | Sri Lakshmi |
| IVR server account | A Firebase account with role `hub`, and env vars `FIREBASE_IVR_EMAIL` / `FIREBASE_IVR_PASSWORD` on the server (Step 7B) | Sri Lakshmi |
| Twilio or Exotel number | Real phone calls | Dhumbi Shree |
| 21+ days of confirmed collections | So the forecast trains on real data instead of the sample | Hub, by using the app |
| Labelled shell photos + trained model | To switch on the photo classifier | Chinmaye |
| Real roads (OpenStreetMap) and GPS | Routes are on a schematic ward model, not live GPS | Next version |

## 24-hour plan

| When | Chinmaye (Vendor + voice) | Dhumbi Shree (Driver + IVR) | Lekhana (Hub) | Sri Lakshmi (Firebase + IVR server) |
|---|---|---|---|---|
| **Hours 0–2** | Run Step 1, read `vendorScreen()` and `voice.js` | Run Step 1, read `planRoute()` and `ivrKey()` | Run Step 1, read `hubScreen()` | Steps 2–4: Firebase + GitHub Pages |
| **Hours 2–8** | Test voice in English + Kannada, fix Kannada wording | Learn `route.js`; practise explaining the TSP (Held–Karp) | Bar chart: kg per stall | Step 7B: run IVR server locally |
| **Hours 8–14** | More voice phrases (e.g. "cancel my pickup") | Polish IVR menu wording | Download today's report (CSV) | Twilio + ngrok test call |
| **Hours 14–20** | Polish + fix bugs | Polish + fix bugs | Polish + fix bugs | Test on 4 phones; practise demo |
| **Hours 20–24** | **Freeze code.** Rehearse the live demo together. Reset data before judging. | | | |

Rule: **after hour 20, no new features.** A working demo beats an extra feature.

---

## The live demo (2 minutes)

Open the app in two windows (or two devices once Firebase is live).

1. **Owner** → Hub → **Delete all** to start clean. Hub → **Load sample day** if you want a busy board (marked Sample).
2. **Voice** (Imran): say *"4 sacks ready"* → read-back → **Confirm**. **IVR** (Suresh): Call → **2** (ಕನ್ನಡ) → **1** → **3 #** → **1**.
3. **Hub**: show the **priority scores and reasons**, zones and suggested drivers → **Assign all suggested**. Imran's phone says a driver is assigned.
4. **Driver** (Kiran): the **TSP tour** with **km and minutes** per leg and the saving vs request order; open **How the TSP route was found** to show the distance matrix; type the weight **→ collected**.
5. **Hub**: **Confirm** the weight → the vendor hears the payment.
6. **Owner → AI Insights**: actual totals per vendor, then the forecast: *"This is trained on labelled sample data because we don't have 21 days of real history yet. On held-out days it beats the simple baseline: 14 kg error vs 21 kg."*

Say: *"Three ways to request, a transparent planner, payment only on the weighed kg, and every role sees only what it should."*

---

## How it works (for judges)

- **Live sync:** every pickup is a Firestore document (see Data model). Each screen listens with `onSnapshot` to only the pickups its role may read.
- **Voice assistant:** Web Speech API speech-to-text (`kn-IN` / `en-IN`) → `understand()` extracts intent and number of sacks → read-back for confirmation → text-to-speech replies and status announcements.
- **IVR:** a state machine (language → menu → sacks → confirm). In production, Twilio/Exotel sends each key press to `ivr-server/server.js`, which replies with TwiML and saves the pickup to Firestore through its REST API. Caller ID identifies the stall, so vendors never type their name.
- **Offline-safe:** without Firebase or internet, `store.js` saves to `localStorage` so the demo never breaks.
- **Route (TSP):** distance matrix of shortest road paths between the hub and every stall, then the Travelling Salesman Problem solved exactly with Held–Karp dynamic programming (nearest neighbour + 2-opt above 12 stops). Each leg shows km, minutes and arrival time. Next step: real OpenStreetMap roads and live traffic.
- **Cocopeat estimate:** wet shells lose about 50% weight when dried, about 10% is waste; the rest is about 70% cocopeat and 30% fibre.
- **Security:** Firebase email/password sign-in; roles in `users/{uid}`; `firestore.rules` enforce who reads and changes what. Demo mode is labelled "not secure". Next step: phone OTP login for vendors.
- **AI:** a transparent priority planner (`planner.js`) and a tested demand forecast (`ml.js`). The photo classifier is a labelled placeholder until a model is trained on real shell photos.

## Next version

Flutter Android app · Google Maps routing with real GPS · production IVR number on Exotel · WhatsApp Business API · UPI payouts · trained shell-photo classifier · forecast on real history · OpenStreetMap roads.
