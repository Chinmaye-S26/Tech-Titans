"""
CocoLoop backend (Python + Flask + SQLite)
=========================================
Run:   pip install flask
       python backend/app.py
Open:  http://127.0.0.1:5000

This server
  1. stores every pickup in a SQLite database (backend/cocoloop.db)
  2. gives the web app a REST API to create / update / delete pickups
  3. computes the owner's dashboard (totals, per-vendor, daily and weekly
     graphs, ML forecast) FROM THE DATABASE, in analytics.py
  4. serves the web app itself, so phones on the same Wi-Fi/hotspot can open
     http://<this-laptop's-IP>:5000

API
  GET    /api/health                  server is up
  GET    /api/version                 changes whenever data changes (the app polls it)
  GET    /api/vendors                 the stalls
  GET    /api/pickups                 all pickups
  POST   /api/pickups                 new pickup (vendor request)
  PATCH  /api/pickups/<id>            update (assign, collect, confirm)
  DELETE /api/pickups[?sample=1]      delete all (or only sample) pickups
  POST   /api/collections             owner adds a past collection {date, vendor, kg}
  POST   /api/import                  upload a CSV file: date,vendor,kg
  GET    /api/stats                   everything the owner's dashboard shows
"""
import csv
import io
import os
import sqlite3
import time
import uuid
from datetime import date, datetime

from flask import Flask, abort, g, jsonify, request, send_from_directory

import analytics

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.dirname(HERE)                        # the cocoloop folder (index.html, app.js, ...)
DB_PATH = os.environ.get("COCOLOOP_DB", os.path.join(HERE, "cocoloop.db"))
RATE = 1.0                                             # ₹ per kg
KG_PER_SACK = 22
STATUSES = ("requested", "assigned", "collected", "confirmed")
SOURCES = ("app", "voice", "ivr", "manual", "csv")

VENDORS = [  # id, name, stall (same stalls as the web app)
    ("v1", "Ravi", "8th Cross Road"),
    ("v2", "Manjula", "Bus Stand"),
    ("v3", "Imran", "Temple Road"),
    ("v4", "Lakshmamma", "Market Gate"),
    ("v5", "Suresh", "College Gate"),
]

# JSON field (what the web app uses)  ->  database column
FIELDS = {
    "vendor": "vendor", "vendorUid": "vendor_uid", "sacks": "sacks", "estKg": "est_kg",
    "status": "status", "driverId": "driver_id", "driverUid": "driver_uid",
    "actualKg": "actual_kg", "payout": "payout", "rate": "rate", "paymentStatus": "payment_status",
    "requestedAt": "requested_at", "assignedAt": "assigned_at", "collectedAt": "collected_at",
    "confirmedAt": "confirmed_at", "source": "source", "shellType": "shell_type", "sample": "sample",
}
COLUMNS = {v: k for k, v in FIELDS.items()}

SCHEMA = """
CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, stall TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pickups (
  id TEXT PRIMARY KEY,
  vendor TEXT NOT NULL REFERENCES vendors(id),
  vendor_uid TEXT, sacks INTEGER, est_kg REAL,
  status TEXT NOT NULL CHECK (status IN ('requested','assigned','collected','confirmed')),
  driver_id TEXT, driver_uid TEXT,
  actual_kg REAL, payout REAL, rate REAL, payment_status TEXT,
  requested_at INTEGER, assigned_at INTEGER, collected_at INTEGER, confirmed_at INTEGER,
  source TEXT, shell_type TEXT, sample INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pickups_status ON pickups(status, confirmed_at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER);
INSERT OR IGNORE INTO meta (key, value) VALUES ('version', 1);
"""

app = Flask(__name__, static_folder=None)


# ---------- database helpers ----------
def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.executemany("INSERT OR IGNORE INTO vendors (id, name, stall) VALUES (?, ?, ?)", VENDORS)
    conn.commit()
    conn.close()


def bump_version(conn):
    conn.execute("UPDATE meta SET value = value + 1 WHERE key = 'version'")


def version():
    return db().execute("SELECT value FROM meta WHERE key = 'version'").fetchone()[0]


def to_json(row):
    out = {"id": row["id"]}
    for col, field in COLUMNS.items():
        v = row[col]
        if v is None:
            continue
        out[field] = bool(v) if col == "sample" else v
    return out


def now_ms():
    return int(time.time() * 1000)


def bad(message, code=400):
    return jsonify({"error": message}), code


def vendor_ids():
    return {r["id"] for r in db().execute("SELECT id FROM vendors")}


def vendor_lookup():
    """Accept a vendor id (v1) or a name (Ravi), any case."""
    m = {}
    for r in db().execute("SELECT id, name FROM vendors"):
        m[r["id"].lower()] = r["id"]
        m[r["name"].lower()] = r["id"]
    return m


def clean(data, creating):
    """Validate a pickup coming from the app. Returns (columns_dict, error)."""
    cols = {}
    for field, value in data.items():
        if field not in FIELDS:
            continue                                          # ignore unknown fields
        col = FIELDS[field]
        if col == "sample":
            value = 1 if value else 0
        cols[col] = value
    if creating and "vendor" not in cols:
        return None, "vendor is required"
    if "vendor" in cols and cols["vendor"] not in vendor_ids():
        return None, f"unknown vendor '{cols['vendor']}'"
    if "status" in cols and cols["status"] not in STATUSES:
        return None, f"status must be one of {', '.join(STATUSES)}"
    if "source" in cols and cols["source"] not in SOURCES:
        return None, f"source must be one of {', '.join(SOURCES)}"
    for col in ("sacks", "est_kg", "actual_kg", "payout"):
        if col in cols and cols[col] is not None:
            try:
                cols[col] = float(cols[col]) if col != "sacks" else int(cols[col])
            except (TypeError, ValueError):
                return None, f"{COLUMNS[col]} must be a number"
            if cols[col] < 0 or cols[col] > 5000:
                return None, f"{COLUMNS[col]} is out of range"
    if creating:
        cols.setdefault("status", "requested")
        cols.setdefault("requested_at", now_ms())
        cols.setdefault("source", "app")
    return cols, None


def insert_pickup(conn, cols):
    cols = dict(cols, id=cols.get("id") or uuid.uuid4().hex[:12])
    names = ", ".join(cols)
    conn.execute(f"INSERT INTO pickups ({names}) VALUES ({', '.join('?' for _ in cols)})", list(cols.values()))
    return cols["id"]


def confirmed_collection(vendor, kg, day, source):
    """A finished, weighed and hub-confirmed collection on a given day (12:00)."""
    ts = int(datetime(day.year, day.month, day.day, 12, 0).timestamp() * 1000)
    return {"vendor": vendor, "sacks": max(1, round(kg / KG_PER_SACK)), "est_kg": kg, "status": "confirmed",
            "actual_kg": kg, "payout": round(kg * RATE, 2), "rate": RATE, "payment_status": "due",
            "requested_at": ts, "collected_at": ts, "confirmed_at": ts, "source": source, "sample": 0}


# ---------- API: pickups ----------
@app.get("/api/health")
def health():
    return jsonify({"ok": True, "server": "CocoLoop Python backend", "version": version()})


@app.get("/api/version")
def get_version():
    return jsonify({"version": version()})


@app.get("/api/vendors")
def get_vendors():
    return jsonify([dict(r) for r in db().execute("SELECT id, name, stall FROM vendors ORDER BY id")])


@app.get("/api/pickups")
def list_pickups():
    rows = db().execute("SELECT * FROM pickups ORDER BY requested_at")
    return jsonify({"version": version(), "pickups": [to_json(r) for r in rows]})


@app.post("/api/pickups")
def create_pickup():
    cols, err = clean(request.get_json(silent=True) or {}, creating=True)
    if err:
        return bad(err)
    conn = db()
    new_id = insert_pickup(conn, cols)
    bump_version(conn)
    conn.commit()
    return jsonify(to_json(conn.execute("SELECT * FROM pickups WHERE id = ?", (new_id,)).fetchone())), 201


@app.patch("/api/pickups/<pid>")
def update_pickup(pid):
    cols, err = clean(request.get_json(silent=True) or {}, creating=False)
    if err:
        return bad(err)
    cols.pop("id", None)
    conn = db()
    if not conn.execute("SELECT 1 FROM pickups WHERE id = ?", (pid,)).fetchone():
        return bad("pickup not found", 404)
    if cols:
        conn.execute(f"UPDATE pickups SET {', '.join(c + ' = ?' for c in cols)} WHERE id = ?", [*cols.values(), pid])
        bump_version(conn)
        conn.commit()
    return jsonify(to_json(conn.execute("SELECT * FROM pickups WHERE id = ?", (pid,)).fetchone()))


@app.delete("/api/pickups")
def delete_pickups():
    conn = db()
    if request.args.get("sample"):
        n = conn.execute("DELETE FROM pickups WHERE sample = 1").rowcount
    else:
        n = conn.execute("DELETE FROM pickups").rowcount
    bump_version(conn)
    conn.commit()
    return jsonify({"deleted": n})


# ---------- API: owner adds data ----------
def parse_day(text):
    try:
        d = date.fromisoformat(str(text).strip())
    except ValueError:
        try:
            d = datetime.strptime(str(text).strip(), "%d-%m-%Y").date()
        except ValueError:
            raise ValueError(f"date '{text}' must look like 2026-10-15 or 15-10-2026")
    if d > date.today():
        raise ValueError(f"date {d} is in the future")
    return d


def parse_kg(text):
    try:
        kg = float(str(text).strip())
    except ValueError:
        raise ValueError(f"kg '{text}' is not a number")
    if not 0 < kg <= 2000:
        raise ValueError(f"kg {kg} must be between 0 and 2000")
    return kg


@app.post("/api/collections")
def add_collection():
    data = request.get_json(silent=True) or {}
    vendor = vendor_lookup().get(str(data.get("vendor", "")).strip().lower())
    if not vendor:
        return bad("choose a valid vendor")
    try:
        day, kg = parse_day(data.get("date", date.today().isoformat())), parse_kg(data.get("kg"))
    except ValueError as e:
        return bad(str(e))
    conn = db()
    new_id = insert_pickup(conn, confirmed_collection(vendor, kg, day, "manual"))
    bump_version(conn)
    conn.commit()
    return jsonify({"added": 1, "id": new_id, "date": day.isoformat(), "vendor": vendor, "kg": kg}), 201


@app.post("/api/import")
def import_csv():
    """CSV with a header row: date,vendor,kg  (vendor = v1..v5 or the name)."""
    if "file" in request.files:
        text = request.files["file"].read().decode("utf-8-sig")
    else:
        text = request.get_data(as_text=True)
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or not {"date", "vendor", "kg"} <= {f.strip().lower() for f in reader.fieldnames}:
        return bad("the CSV needs a header row: date,vendor,kg")
    lookup, rows, errors = vendor_lookup(), [], []
    for n, raw in enumerate(reader, start=2):
        r = {k.strip().lower(): (v or "").strip() for k, v in raw.items() if k}
        if not any(r.values()):
            continue
        vendor = lookup.get(r.get("vendor", "").lower())
        try:
            if not vendor:
                raise ValueError(f"unknown vendor '{r.get('vendor')}'")
            rows.append(confirmed_collection(vendor, parse_kg(r.get("kg")), parse_day(r.get("date")), "csv"))
        except ValueError as e:
            errors.append(f"line {n}: {e}")
    if errors:
        return jsonify({"added": 0, "errors": errors[:20]}), 400
    conn = db()
    for cols in rows:
        insert_pickup(conn, cols)
    bump_version(conn)
    conn.commit()
    return jsonify({"added": len(rows)}), 201


# ---------- API: collection records (full CRUD for the owner) ----------
#   Create  POST   /api/collections          (above)
#   Read    GET    /api/collections?vendor=v1&limit=50
#   Update  PUT    /api/collections/<id>      {date, vendor, kg}
#   Delete  DELETE /api/collections/<id>
def collection_json(r):
    return {"id": r["id"], "date": datetime.fromtimestamp(r["confirmed_at"] / 1000).date().isoformat(),
            "vendor": r["vendor"], "kg": r["actual_kg"], "payout": r["payout"], "source": r["source"]}


@app.get("/api/collections")
def list_collections():
    limit = max(1, min(500, int(request.args.get("limit", 50))))
    sql, args = "SELECT * FROM pickups WHERE status = 'confirmed' AND sample = 0", []
    vendor = request.args.get("vendor")
    if vendor:
        sql += " AND vendor = ?"; args.append(vendor)
    total = db().execute(sql.replace("SELECT *", "SELECT COUNT(*)"), args).fetchone()[0]
    rows = db().execute(sql + " ORDER BY confirmed_at DESC, id LIMIT ?", [*args, limit])
    return jsonify({"total": total, "records": [collection_json(r) for r in rows]})


def find_collection(conn, cid):
    return conn.execute("SELECT * FROM pickups WHERE id = ? AND status = 'confirmed'", (cid,)).fetchone()


@app.put("/api/collections/<cid>")
def update_collection(cid):
    conn = db()
    old = find_collection(conn, cid)
    if not old:
        return bad("collection record not found", 404)
    data = request.get_json(silent=True) or {}
    vendor = vendor_lookup().get(str(data.get("vendor", old["vendor"])).strip().lower())
    if not vendor:
        return bad("choose a valid vendor")
    try:
        day = parse_day(data.get("date", collection_json(old)["date"]))
        kg = parse_kg(data.get("kg", old["actual_kg"]))
    except ValueError as e:
        return bad(str(e))
    cols = confirmed_collection(vendor, kg, day, old["source"] or "manual")
    for keep in ("requested_at", "collected_at", "source", "sample"):
        cols.pop(keep, None)                       # keep the original history of the pickup
    conn.execute(f"UPDATE pickups SET {', '.join(c + ' = ?' for c in cols)} WHERE id = ?", [*cols.values(), cid])
    bump_version(conn)
    conn.commit()
    return jsonify(collection_json(find_collection(conn, cid)))


@app.delete("/api/collections/<cid>")
def delete_collection(cid):
    conn = db()
    if not find_collection(conn, cid):
        return bad("collection record not found", 404)
    conn.execute("DELETE FROM pickups WHERE id = ?", (cid,))
    bump_version(conn)
    conn.commit()
    return jsonify({"deleted": 1, "id": cid})


@app.delete("/api/pickups/<pid>")
def delete_pickup(pid):
    conn = db()
    n = conn.execute("DELETE FROM pickups WHERE id = ?", (pid,)).rowcount
    if not n:
        return bad("pickup not found", 404)
    bump_version(conn)
    conn.commit()
    return jsonify({"deleted": 1, "id": pid})


# ---------- API: owner dashboard ----------
@app.get("/api/stats")
def stats():
    conn = db()
    days = max(7, min(90, int(request.args.get("days", 28))))
    real = "sample = 0"

    totals = conn.execute(f"""
        SELECT COUNT(*) AS pickups, COALESCE(SUM(actual_kg), 0) AS kg, COALESCE(SUM(payout), 0) AS paid,
               COALESCE(SUM(CASE WHEN payment_status = 'due' THEN payout END), 0) AS due
        FROM pickups WHERE status = 'confirmed' AND {real}""").fetchone()
    status_counts = {s: 0 for s in STATUSES}
    for r in conn.execute(f"SELECT status, COUNT(*) AS n FROM pickups WHERE {real} GROUP BY status"):
        status_counts[r["status"]] = r["n"]
    sources = {r["source"] or "app": r["n"] for r in conn.execute(f"SELECT source, COUNT(*) AS n FROM pickups WHERE {real} GROUP BY source")}

    vendors = [dict(r) for r in conn.execute(f"""
        SELECT v.id, v.name, v.stall,
               COUNT(CASE WHEN p.status = 'confirmed' THEN 1 END)               AS pickups,
               COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.actual_kg END), 0) AS kg,
               COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.payout END), 0)    AS earned,
               COUNT(CASE WHEN p.status != 'confirmed' THEN 1 END)              AS active
        FROM vendors v LEFT JOIN pickups p ON p.vendor = v.id AND p.{real}
        GROUP BY v.id ORDER BY kg DESC, v.id""")]

    rows = conn.execute(f"""SELECT confirmed_at, actual_kg FROM pickups
                            WHERE status = 'confirmed' AND {real} AND confirmed_at IS NOT NULL AND actual_kg > 0""").fetchall()
    series = analytics.daily_series([(r["confirmed_at"], r["actual_kg"]) for r in rows])
    try:
        fc = analytics.forecast(series)
    except ValueError as e:
        fc = {"status": "error", "message": str(e), "days": []}

    return jsonify({
        "generatedAt": now_ms(), "version": version(), "today": date.today().isoformat(),
        "totals": {k: round(totals[k], 1) for k in ("pickups", "kg", "paid", "due")},
        "statusCounts": status_counts, "sources": sources, "vendors": vendors,
        "records": len(rows), "historyDays": len(series),
        "daily": series[-days:], "weekly": analytics.weekly(series)[-8:],
        "forecast": fc, "minDays": analytics.MIN_DAYS,
    })


# ---------- the web app ----------
@app.get("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/<path:name>")
def static_files(name):
    if name.startswith(("backend", "ivr-server", "tests", ".")) or not os.path.isfile(os.path.join(WEB_DIR, name)):
        abort(404)
    return send_from_directory(WEB_DIR, name)


@app.after_request
def no_cache(resp):
    resp.headers["Cache-Control"] = "no-store"
    return resp


init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  CocoLoop backend running.\n  Database: {DB_PATH}\n  Open:     http://127.0.0.1:{port}\n"
          f"  Phones on the same Wi-Fi/hotspot: http://<this laptop's IP address>:{port}\n")
    app.run(host="0.0.0.0", port=port, debug=False)
