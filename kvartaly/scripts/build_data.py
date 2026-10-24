"""Stáhne makroekonomické řady z FRED a uloží čtvrtletní ukazatele do kvartaly/data.json.

Spouští se v GitHub Actions (.github/workflows/update-macro-data.yml), lze ho ale pustit
i lokálně: `python kvartaly/scripts/build_data.py`. Používá jen standardní knihovnu.
Pokud je nastavená proměnná prostředí FRED_API_KEY (zdarma na fredaccount.stlouisfed.org),
použije se oficiální FRED API, které je spolehlivější než stahování CSV z webu.
"""

import csv
import html as html_lib
import io
import json
import math
import os
import re
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
    "UMCSENT": "mean",    # spotřebitelský sentiment, Michiganská univerzita (od 1952)
    "USALOLITOAASTSAM": "mean",  # OECD předstihový ukazatel (CLI) pro USA, 100 = dlouhodobý trend (od 1955)
    "USREC": "max",       # recese podle NBER (0/1)
}


FRED_API = ("https://api.stlouisfed.org/fred/series/observations"
            "?series_id={}&api_key={}&file_type=json")
API_KEY = os.environ.get("FRED_API_KEY", "").strip()
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept": "text/csv,text/plain,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def get(url, tries=3, timeout=30):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8")
        except Exception as e:
            print(f"  pokus {attempt + 1}/{tries} selhal: {e}", flush=True)
            if attempt == tries - 1:
                raise
            time.sleep(2 ** (attempt + 1))


def fetch(series_id):
    """Vrátí [(YYYY-MM-DD, hodnota)]. S FRED_API_KEY používá oficiální API, jinak CSV z webu."""
    print(f"Stahuji {series_id}", flush=True)
    if API_KEY:
        obs = json.loads(get(FRED_API.format(series_id, API_KEY)))["observations"]
        rows = [(o["date"], o["value"]) for o in obs]
    else:
        rows = list(csv.reader(io.StringIO(get(FRED_CSV.format(series_id)))))[1:]  # bez hlavičky
    return [(date, float(value)) for date, value in rows if value not in ("", ".")]


# S&P 500 (měsíční průměry denních uzávěrek, data R. Shillera) – jen pro graf, ne pro podobnost
SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500/main/data/data.csv"


def fetch_shiller():
    """Vrátí (S&P 500, dlouhodobá úroková sazba) jako [(YYYY-MM-DD, hodnota)]; nuly jsou chybějící údaje."""
    print("Stahuji S&P 500", flush=True)
    rows = list(csv.DictReader(io.StringIO(get(SP500_CSV))))
    def col(name):
        return [(r["Date"], float(r[name])) for r in rows if r.get(name) not in (None, "") and float(r[name]) != 0]
    return col("SP500"), col("Long Interest Rate")


# Ocenění trhu (měsíčně od 1871, aktuální odhady) – tabulky z multpl.com
MULTPL = "https://www.multpl.com/{}/table/by-month"
MONTHS = {m: i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def fetch_multpl(slug):
    print(f"Stahuji multpl.com/{slug}", flush=True)
    html = get(MULTPL.format(slug))
    out = []
    for mon, year, val in re.findall(r"<td>\s*(\w{3})\s+\d+,\s+(\d{4})\s*</td>\s*<td>(.*?)</td>", html, re.S):
        # nejdřív zrušit HTML entity (multpl používá např. &#x2002; jako mezeru), pak značky
        num = re.search(r"-?\d+(?:\.\d+)?", re.sub(r"<[^>]+>", "", html_lib.unescape(val)))
        if mon in MONTHS and num:
            out.append((f"{year}-{MONTHS[mon]:02d}-01", float(num.group())))
    if len(out) < 100:
        raise ValueError(f"neočekávaný formát tabulky ({len(out)} řádků)")
    return out


# Sentiment investorů AAII (týdně od 1987), veřejný soubor .xls
AAII_XLS = "https://www.aaii.com/files/surveys/sentiment.xls"


def fetch_aaii():
    """Vrátí [(YYYY-MM-DD, býci − medvědi v p. b.)]."""
    import xlrd  # instaluje se ve workflow
    print("Stahuji AAII sentiment", flush=True)
    req = urllib.request.Request(AAII_XLS, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        book = xlrd.open_workbook(file_contents=r.read())
    sh = book.sheet_by_index(0)
    head = col_bull = col_bear = None
    for i in range(min(sh.nrows, 20)):
        row = [str(c).strip().lower() for c in sh.row_values(i)]
        if "bullish" in row and "bearish" in row:
            head, col_bull, col_bear = i, row.index("bullish"), row.index("bearish")
            break
    if head is None:
        raise ValueError("v souboru AAII chybí sloupce Bullish/Bearish")
    out = []
    for i in range(head + 1, sh.nrows):
        d, bull, bear = sh.cell(i, 0), sh.cell(i, col_bull).value, sh.cell(i, col_bear).value
        if d.ctype != xlrd.XL_CELL_DATE or not isinstance(bull, float) or not isinstance(bear, float):
            continue
        y, m, dd = xlrd.xldate_as_tuple(d.value, book.datemode)[:3]
        scale = 100 if abs(bull) <= 1 and abs(bear) <= 1 else 1  # podíly vs. procenta
        out.append((f"{y}-{m:02d}-{dd:02d}", (bull - bear) * scale))
    if len(out) < 100:
        raise ValueError(f"neočekávaný formát souboru AAII ({len(out)} řádků)")
    return out


def optional(name, fn):
    """Doplňkové zdroje mimo FRED: při výpadku se ukazatel vynechá, zbytek dat se uloží."""
    try:
        return fn()
    except Exception as e:
        print(f"{name} se nepodařilo stáhnout: {e}", flush=True)
        return None


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

    shiller = optional("S&P 500", fetch_shiller)
    sp = to_quarterly(shiller[0], "mean") if shiller else None
    long_rate = to_quarterly(shiller[1], "mean") if shiller else {}
    extra = {
        "SP500": sp,
        "EY": optional("Earnings yield", lambda: to_quarterly(fetch_multpl("s-p-500-earnings-yield"), "mean")),
        "CAPE": optional("CAPE", lambda: to_quarterly(fetch_multpl("shiller-pe"), "mean")),
        "AAII": optional("AAII", lambda: to_quarterly(fetch_aaii(), "mean")),
    }
    q.update({k: v for k, v in extra.items() if v})

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
        "sp_yoy":    ("Výnos S&P 500 (r/r)", "%", lambda k: yoy("SP500", k)),
        "ey":        ("Výnos ze zisků S&P 500 (E/P)", "%", lambda k: val("EY", k)),
        "cape":      ("Shillerovo P/E (CAPE)", "×", lambda k: val("CAPE", k)),
        "sent_umich": ("Spotřebitelský sentiment (Univ. of Michigan)", "index", lambda k: val("UMCSENT", k)),
        "sent_aaii": ("Sentiment investorů AAII (býci − medvědi)", "p. b.", lambda k: val("AAII", k)),
        "oecd_cli":  ("Předstihový ukazatel OECD (CLI)", "index", lambda k: val("USALOLITOAASTSAM", k)),
    }
    source_of = {"sp_yoy": "SP500", "ey": "EY", "cape": "CAPE", "sent_aaii": "AAII"}
    indicators = {i: v for i, v in indicators.items() if source_of.get(i, "GDPC1") in q}

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
    if sp:
        data["sp500"] = {
            "name": "S&P 500",
            "source": "Robert Shiller / datasets/s-and-p-500",
            "values": [None if sp.get(k) is None else round(sp[k], 2) for k in keys],
        }
    # Výnos 10Y pro graf: FRED GS10 (od 1953), dřívější kvartály doplní Shillerova dlouhodobá sazba
    us10y = [val("GS10", k) if val("GS10", k) is not None else long_rate.get(k) for k in keys]
    if any(v is not None for v in us10y):
        data["us10y"] = {
            "name": "US10Y",
            "source": "FRED GS10; před 1953 R. Shiller",
            "values": [clean(v) for v in us10y],
        }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT}: {data['quarters'][0]}–{data['quarters'][-1]}, {len(indicators)} ukazatelů")


if __name__ == "__main__":
    main()
