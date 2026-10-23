"""Stáhne makroekonomické řady z FRED a uloží čtvrtletní ukazatele do kvartaly/data.json.

Spouští se v GitHub Actions (.github/workflows/update-macro-data.yml), lze ho ale pustit
i lokálně: `python kvartaly/scripts/build_data.py`. Používá jen standardní knihovnu.
"""

import csv
import io
import json
import math
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={}"
OUT = Path(__file__).resolve().parent.parent / "data.json"
START_YEAR = 1947

# Zdrojové řady (FRED id -> agregace do čtvrtletí)
RAW = {
    "GDPC1": "last",      # reálný HDP (čtvrtletní)
    "GPDIC1": "last",     # reálné soukromé investice (čtvrtletní)
    "CPIAUCSL": "mean",   # CPI
    "UNRATE": "mean",     # míra nezaměstnanosti
    "PAYEMS": "mean",     # zaměstnanost mimo zemědělství
    "INDPRO": "mean",     # průmyslová produkce
    "TB3MS": "mean",      # 3M státní pokladniční poukázky
    "GS10": "mean",       # 10letý výnos
    "AAA": "mean",        # firemní dluhopisy Aaa
    "BAA": "mean",        # firemní dluhopisy Baa
    "WTISPLC": "mean",    # ropa WTI
    "USREC": "max",       # recese podle NBER (0/1)
}


def fetch(series_id, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(FRED_CSV.format(series_id), headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                text = r.read().decode("utf-8")
            break
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 ** (attempt + 1))
    rows = csv.reader(io.StringIO(text))
    next(rows)  # hlavička (DATE / observation_date, ID)
    out = []
    for date, value in rows:
        if value in ("", "."):
            continue
        out.append((date, float(value)))
    return out


def to_quarterly(obs, how):
    buckets = {}
    for date, value in obs:
        y, m = int(date[:4]), int(date[5:7])
        buckets.setdefault((y, (m - 1) // 3 + 1), []).append(value)
    if how == "mean":
        return {k: sum(v) / len(v) for k, v in buckets.items()}
    if how == "max":
        return {k: max(v) for k, v in buckets.items()}
    return {k: v[-1] for k, v in buckets.items()}


def main():
    q = {sid: to_quarterly(fetch(sid), how) for sid, how in RAW.items()}

    last = max(k for k in q["GDPC1"])  # konec vzorku = poslední zveřejněný HDP
    keys = [(y, n) for y in range(START_YEAR, last[0] + 1) for n in range(1, 5) if (y, n) <= last]

    def val(sid, k):
        return q[sid].get(k)

    def lag(k, n):
        y, qq = k
        idx = y * 4 + (qq - 1) - n
        return (idx // 4, idx % 4 + 1)

    def yoy(sid, k):
        a, b = val(sid, k), val(sid, lag(k, 4))
        return None if a is None or b is None or b == 0 else 100 * (a / b - 1)

    def qoq_ann(sid, k):
        a, b = val(sid, k), val(sid, lag(k, 1))
        return None if a is None or b is None or b <= 0 else 100 * ((a / b) ** 4 - 1)

    def diff(a, b):
        return None if a is None or b is None else a - b

    def d4(sid, k):
        return diff(val(sid, k), val(sid, lag(k, 4)))

    indicators = {
        "gdp_yoy":   ("Růst reálného HDP (r/r)", "%", lambda k: yoy("GDPC1", k)),
        "gdp_qoq":   ("Růst reálného HDP (q/q, anualizovaně)", "%", lambda k: qoq_ann("GDPC1", k)),
        "inv_yoy":   ("Růst reálných investic (r/r)", "%", lambda k: yoy("GPDIC1", k)),
        "ip_yoy":    ("Průmyslová produkce (r/r)", "%", lambda k: yoy("INDPRO", k)),
        "cpi_yoy":   ("Inflace CPI (r/r)", "%", lambda k: yoy("CPIAUCSL", k)),
        "unrate":    ("Míra nezaměstnanosti", "%", lambda k: val("UNRATE", k)),
        "unrate_d4": ("Změna nezaměstnanosti (r/r)", "p. b.", lambda k: d4("UNRATE", k)),
        "pay_yoy":   ("Zaměstnanost – payrolls (r/r)", "%", lambda k: yoy("PAYEMS", k)),
        "tb3":       ("Krátkodobá sazba (3M T-bill)", "%", lambda k: val("TB3MS", k)),
        "tb3_d4":    ("Změna krátkodobé sazby (r/r)", "p. b.", lambda k: d4("TB3MS", k)),
        "real_rate": ("Reálná krátkodobá sazba (3M − inflace)", "%", lambda k: diff(val("TB3MS", k), yoy("CPIAUCSL", k))),
        "gs10":      ("Výnos 10letého dluhopisu", "%", lambda k: val("GS10", k)),
        "term":      ("Sklon výnosové křivky (10Y − 3M)", "p. b.", lambda k: diff(val("GS10", k), val("TB3MS", k))),
        "credit":    ("Kreditní spread (Baa − Aaa)", "p. b.", lambda k: diff(val("BAA", k), val("AAA", k))),
        "oil_yoy":   ("Cena ropy WTI (r/r)", "%", lambda k: yoy("WTISPLC", k)),
    }

    def clean(x):
        return None if x is None or not math.isfinite(x) else round(x, 3)

    data = {
        "source": "FRED, Federal Reserve Bank of St. Louis",
        "country": "USA",
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "quarters": [f"{y}Q{n}" for y, n in keys],
        "recession": [int(val("USREC", k) or 0) for k in keys],
        "indicators": [
            {"id": iid, "name": name, "unit": unit, "values": [clean(f(k)) for k in keys]}
            for iid, (name, unit, f) in indicators.items()
        ],
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT}: {data['quarters'][0]}–{data['quarters'][-1]}, {len(indicators)} ukazatelů")


if __name__ == "__main__":
    main()
