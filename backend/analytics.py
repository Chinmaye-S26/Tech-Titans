"""
CocoLoop analytics: every number on the owner's dashboard is computed here,
from the rows in the database. Nothing is hard-coded.

  daily_series()  kg collected per day (confirmed, weighed pickups only)
  weekly()        kg per Monday-start week
  forecast()      ML forecast of the next 7 days:
                  ridge linear regression on  trend + day of week,
                  tested on held-out days against a simple baseline

Pure Python (no numpy needed), so it runs anywhere Flask runs.
"""
from datetime import date, datetime, timedelta
import math

MIN_DAYS = 14      # completed days of history needed before we forecast
HOLDOUT = 7        # days kept aside to test the model
EVAL_MIN = 28      # need this many days to also measure accuracy
LAMBDA = 0.05      # small ridge penalty: keeps the model stable when data is short


# ---------- dates ----------
def to_date(ms):
    """Timestamp in milliseconds -> local calendar date."""
    return datetime.fromtimestamp(ms / 1000).date()


def daily_series(rows, today=None):
    """rows: iterable of (confirmed_at_ms, kg). Returns [{date, kg}] for every
    day from the first record to today (days with no collections = 0 kg)."""
    today = today or date.today()
    by_day = {}
    for ms, kg in rows:
        d = to_date(ms)
        if d > today:
            continue
        by_day[d] = by_day.get(d, 0.0) + float(kg)
    if not by_day:
        return []
    out, d = [], min(by_day)
    while d <= today:
        out.append({"date": d.isoformat(), "kg": round(by_day.get(d, 0.0), 1)})
        d += timedelta(days=1)
    return out


def weekly(series):
    """Monday-start weekly totals: [{week, kg, days}]"""
    weeks = {}
    for row in series:
        d = date.fromisoformat(row["date"])
        monday = d - timedelta(days=d.weekday())
        w = weeks.setdefault(monday, {"week": monday.isoformat(), "kg": 0.0, "days": 0})
        w["kg"] += row["kg"]
        w["days"] += 1
    return [dict(w, kg=round(w["kg"], 1)) for _, w in sorted(weeks.items())]


# ---------- the model ----------
def features(d, t):
    """intercept, trend, and 6 day-of-week flags (Sunday is the baseline)."""
    x = [1.0, t / 30.0]
    wd = d.weekday()                      # Monday = 0 ... Sunday = 6
    x += [1.0 if wd == k else 0.0 for k in range(6)]
    return x


def solve(A, b):
    """Solve A·w = b by Gaussian elimination with partial pivoting."""
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        if abs(M[c][c]) < 1e-12:
            raise ValueError("not enough varied data to fit the model")
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                for k in range(c, n + 1):
                    M[r][k] -= f * M[c][k]
    return [M[i][n] / M[i][i] for i in range(n)]


def fit(X, y, lam=LAMBDA):
    """Ridge regression: w = (XᵀX + λI)⁻¹ Xᵀy (the intercept is not penalised)."""
    p = len(X[0])
    A = [[0.0] * p for _ in range(p)]
    b = [0.0] * p
    for x, yi in zip(X, y):
        for i in range(p):
            b[i] += x[i] * yi
            for j in range(p):
                A[i][j] += x[i] * x[j]
    for i in range(1, p):
        A[i][i] += lam
    return solve(A, b)


def predict(w, x):
    return sum(wi * xi for wi, xi in zip(w, x))


def train(series):
    X = [features(date.fromisoformat(r["date"]), i) for i, r in enumerate(series)]
    y = [r["kg"] for r in series]
    w = fit(X, y)
    resid = [yi - predict(w, xi) for xi, yi in zip(X, y)]
    sd = math.sqrt(sum(r * r for r in resid) / max(1, len(resid) - len(w)))
    return w, sd


def evaluate(series):
    """Hold out the last HOLDOUT days, train on the rest, and compare with the
    baseline "same as the same weekday last week". Lower error is better."""
    if len(series) < EVAL_MIN:
        return None
    train_part, test = series[:-HOLDOUT], series[-HOLDOUT:]
    w, _ = train(train_part)
    mae = base = 0.0
    for j, r in enumerate(test):
        i = len(train_part) + j
        pred = max(0.0, predict(w, features(date.fromisoformat(r["date"]), i)))
        naive = series[i - 7]["kg"]
        mae += abs(r["kg"] - pred)
        base += abs(r["kg"] - naive)
    mae, base = mae / len(test), base / len(test)
    return {"mae": round(mae, 1), "baselineMae": round(base, 1), "testDays": len(test),
            "betterThanBaselinePct": round((1 - mae / base) * 100) if base > 0 else None}


def forecast(series, today=None, horizon=7):
    """Train on completed days only (today is not finished yet)."""
    today = today or date.today()
    done = [r for r in series if date.fromisoformat(r["date"]) < today]
    if len(done) < MIN_DAYS:
        return {"status": "insufficient", "haveDays": len(done), "needed": MIN_DAYS, "days": []}
    w, sd = train(done)
    first = date.fromisoformat(done[0]["date"])

    def at(d):                                  # prediction for any calendar day
        kg = max(0.0, predict(w, features(d, (d - first).days)))
        return {"date": d.isoformat(), "kg": round(kg),
                "low": max(0, round(kg - 1.28 * sd)), "high": round(kg + 1.28 * sd)}

    days = [at(today + timedelta(days=h)) for h in range(1, horizon + 1)]   # tomorrow onwards
    names = ["intercept", "trend"] + ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    return {"status": "ok", "trainedDays": len(done), "days": days, "today": at(today), "evaluation": evaluate(done),
            "weights": {n: round(v, 2) for n, v in zip(names, w)}, "sd": round(sd, 1)}
