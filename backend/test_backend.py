"""Run:  python backend/test_backend.py
Checks that the dashboard numbers come from the database: add data -> stats change."""
import io, os, sys, tempfile, unittest
from datetime import date, timedelta

os.environ["COCOLOOP_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import app as server  # noqa: E402
import analytics       # noqa: E402


class BackendTest(unittest.TestCase):
    def setUp(self):
        self.c = server.app.test_client()
        self.c.delete("/api/pickups")

    def stats(self):
        return self.c.get("/api/stats").get_json()

    def test_empty_database_means_empty_dashboard(self):
        s = self.stats()
        self.assertEqual(s["totals"]["kg"], 0)
        self.assertEqual(s["daily"], [])
        self.assertEqual(s["forecast"]["status"], "insufficient")

    def test_added_collection_appears_in_totals_vendor_table_and_graph(self):
        today = date.today().isoformat()
        r = self.c.post("/api/collections", json={"date": today, "vendor": "Ravi", "kg": 64})
        self.assertEqual(r.status_code, 201)
        s = self.stats()
        self.assertEqual(s["totals"]["kg"], 64)
        self.assertEqual(s["daily"][-1], {"date": today, "kg": 64})
        ravi = next(v for v in s["vendors"] if v["id"] == "v1")
        self.assertEqual((ravi["kg"], ravi["earned"], ravi["pickups"]), (64, 64, 1))
        self.c.post("/api/collections", json={"date": today, "vendor": "v1", "kg": 36})
        self.assertEqual(self.stats()["daily"][-1]["kg"], 100, "graph follows the data")

    def test_app_lifecycle_confirm_counts_only_when_confirmed(self):
        p = self.c.post("/api/pickups", json={"vendor": "v3", "sacks": 3, "estKg": 66}).get_json()
        self.assertEqual(self.stats()["totals"]["kg"], 0)
        self.c.patch(f"/api/pickups/{p['id']}", json={"status": "collected", "actualKg": 70})
        self.assertEqual(self.stats()["totals"]["kg"], 0, "not counted before the hub confirms")
        import time
        self.c.patch(f"/api/pickups/{p['id']}", json={"status": "confirmed", "payout": 70, "confirmedAt": int(time.time() * 1000)})
        self.assertEqual(self.stats()["totals"]["kg"], 70)

    def test_crud_on_collection_records_updates_the_dashboard(self):
        today = date.today().isoformat()
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        # Create
        r = self.c.post("/api/collections", json={"date": today, "vendor": "Ravi", "kg": 50})
        cid = r.get_json()["id"]
        # Read
        lst = self.c.get("/api/collections").get_json()
        self.assertEqual(lst["total"], 1)
        self.assertEqual(lst["records"][0], {"id": cid, "date": today, "vendor": "v1", "kg": 50, "payout": 50, "source": "manual"})
        # Update: weight, vendor and date
        r = self.c.put(f"/api/collections/{cid}", json={"date": yesterday, "vendor": "Manjula", "kg": 80})
        self.assertEqual(r.status_code, 200, r.get_json())
        s = self.stats()
        self.assertEqual(s["totals"]["kg"], 80)
        self.assertEqual(next(v for v in s["vendors"] if v["id"] == "v2")["kg"], 80)
        self.assertEqual(next(v for v in s["vendors"] if v["id"] == "v1")["kg"], 0)
        self.assertEqual(s["daily"][0], {"date": yesterday, "kg": 80})
        self.assertEqual(self.c.put(f"/api/collections/{cid}", json={"kg": -3}).status_code, 400)
        # Delete
        self.assertEqual(self.c.delete(f"/api/collections/{cid}").status_code, 200)
        self.assertEqual(self.stats()["totals"]["kg"], 0)
        self.assertEqual(self.c.get("/api/collections").get_json()["total"], 0)
        self.assertEqual(self.c.delete(f"/api/collections/{cid}").status_code, 404)

    def test_delete_one_pickup(self):
        p = self.c.post("/api/pickups", json={"vendor": "v4", "sacks": 2}).get_json()
        self.assertEqual(self.c.delete(f"/api/pickups/{p['id']}").status_code, 200)
        self.assertEqual(self.c.get("/api/pickups").get_json()["pickups"], [])

    def test_sample_records_are_excluded(self):
        self.c.post("/api/pickups", json={"vendor": "v2", "status": "confirmed", "actualKg": 50, "sample": True,
                                          "confirmedAt": 1})
        self.assertEqual(self.stats()["totals"]["kg"], 0)

    def test_csv_import_drives_weekly_totals_and_forecast(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_collections.csv")
        with open(path, "rb") as f:
            r = self.c.post("/api/import", data={"file": (io.BytesIO(f.read()), "data.csv")})
        self.assertEqual(r.status_code, 201, r.get_json())
        s = self.stats()
        self.assertEqual(s["forecast"]["status"], "ok")
        self.assertEqual(len(s["forecast"]["days"]), 7)
        self.assertEqual(s["forecast"]["days"][0]["date"], (date.today() + timedelta(days=1)).isoformat(), "forecast starts tomorrow")
        self.assertGreater(s["totals"]["kg"], 0)
        self.assertEqual(s["records"], 271)
        all_days = analytics.daily_series([(r["confirmedAt"], r["actualKg"]) for r in
                                           self.c.get("/api/pickups").get_json()["pickups"]])
        self.assertAlmostEqual(sum(w["kg"] for w in analytics.weekly(all_days)), s["totals"]["kg"], places=0)

    def test_bad_input_is_rejected(self):
        self.assertEqual(self.c.post("/api/collections", json={"vendor": "Nobody", "kg": 5}).status_code, 400)
        self.assertEqual(self.c.post("/api/collections", json={"vendor": "v1", "kg": -3}).status_code, 400)
        future = (date.today() + timedelta(days=2)).isoformat()
        self.assertEqual(self.c.post("/api/collections", json={"vendor": "v1", "kg": 5, "date": future}).status_code, 400)
        r = self.c.post("/api/import", data="date,vendor,kg\n2026-01-01,Ravi,abc\n", content_type="text/csv")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.c.post("/api/pickups", json={"vendor": "v1", "status": "flying"}).status_code, 400)

    def test_version_changes_on_every_write(self):
        v1 = self.c.get("/api/version").get_json()["version"]
        self.c.post("/api/collections", json={"vendor": "v5", "kg": 10})
        self.assertGreater(self.c.get("/api/version").get_json()["version"], v1)


class ModelTest(unittest.TestCase):
    def test_model_learns_a_weekly_pattern(self):
        start = date.today() - timedelta(days=42)
        series = [{"date": (start + timedelta(days=i)).isoformat(),
                   "kg": 200 + (80 if (start + timedelta(days=i)).weekday() >= 5 else 0)} for i in range(42)]
        fc = analytics.forecast(series)
        self.assertEqual(fc["status"], "ok")
        for d in fc["days"]:
            expected = 280 if date.fromisoformat(d["date"]).weekday() >= 5 else 200
            self.assertLess(abs(d["kg"] - expected), 15, d)
        self.assertLess(fc["evaluation"]["mae"], 15)

    def test_daily_series_fills_missing_days_with_zero(self):
        import time
        day = 86400000
        t = int(time.time() * 1000) - 3 * day
        s = analytics.daily_series([(t, 10), (t + 2 * day, 5)])
        self.assertEqual([d["kg"] for d in s[:3]], [10, 0, 5])


if __name__ == "__main__":
    unittest.main(verbosity=2)
