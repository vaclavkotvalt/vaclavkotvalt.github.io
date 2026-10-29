"""Denní aktualizace tržních dat pro nástroj Rebalancování: rebalancing/market.json.

- Kurzy: ČNB, kurzy devizového trhu (denni_kurz.txt).
- Ceny ETF: poslední závěrečná cena z Yahoo Finance, záložně ze Stooq.

Když se některý údaj nepodaří stáhnout (nebo vypadá nesmyslně), ponechá se
předchozí hodnota se svým datem – stránka pak ukáže, že je starší.
Spouští .github/workflows/update-market-data.yml každý pracovní den večer.
"""
import csv
import datetime as dt
import io
import json
import pathlib
import urllib.request

OUT = pathlib.Path(__file__).resolve().parent.parent / "market.json"
HIST = pathlib.Path(__file__).resolve().parent.parent / "fx_history.json"
HIST_FROM = 2010  # od kterého roku držet denní kurzy ČNB (pro nákupní ceny lotů)
UA = {"User-Agent": "Mozilla/5.0 (rebalancing tool; vaclavkotvalt.cz)"}

# Ticker v nástroji → kandidátní symboly u zdrojů (zkouší se popořadě) a očekávaná měna
INSTRUMENTS = {
    "VWCE": {"isin": "IE00BK5BQT80", "currency": "EUR", "yahoo": ["VWCE.DE"], "stooq": ["vwce.de"]},
    "AVWS": {"isin": "IE0003R87OG3", "currency": "EUR", "yahoo": ["AVWS.DE"], "stooq": ["avws.de"]},
    "EUNA": {"isin": "IE00BDBRDM35", "currency": "EUR", "yahoo": ["EUNA.DE"], "stooq": ["euna.de"]},
    "IGLN": {"isin": "IE00B4ND3602", "currency": "USD", "yahoo": ["IGLN.L"], "stooq": ["igln.uk"]},
}
FX = ["EUR", "USD"]
MAX_JUMP = 0.25  # denní změna nad 25 % = podezřelý údaj, ponechat předchozí


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def cnb_rates():
    text = get("https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt")
    lines = text.strip().splitlines()
    day = dt.datetime.strptime(lines[0].split()[0], "%d.%m.%Y").date().isoformat()
    rates = {}
    for row in lines[2:]:
        _, _, amount, code, rate = row.split("|")
        if code in FX:
            rates[code] = float(rate.replace(",", ".")) / float(amount)
    return day, rates


def yahoo(symbol):
    j = json.loads(get(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=10d&interval=1d"))
    res = j["chart"]["result"][0]
    closes = res["indicators"]["quote"][0]["close"]
    last = max(i for i, c in enumerate(closes) if c is not None)
    day = dt.datetime.fromtimestamp(res["timestamp"][last], dt.timezone.utc).date().isoformat()
    cur = res["meta"].get("currency")
    price = closes[last]
    if cur == "GBp":  # londýnské kotace v pencích
        cur, price = "GBP", price / 100
    return price, cur, day


def stooq(symbol):
    rows = list(csv.DictReader(io.StringIO(get(f"https://stooq.com/q/l/?s={symbol}&f=sd2t2ohlcv&h&e=csv"))))
    r = rows[0]
    if r.get("Close") in (None, "", "N/D"):
        raise ValueError("bez ceny")
    return float(r["Close"]), None, r["Date"]


def isin_symbols(isin):
    """Symboly, pod kterými Yahoo vede daný ISIN – kontrola, že kotace patří správnému fondu."""
    j = json.loads(get(f"https://query2.finance.yahoo.com/v1/finance/search?q={isin}&quotesCount=20&newsCount=0"))
    return [(q.get("symbol"), q.get("exchange"), q.get("longname") or q.get("shortname")) for q in j.get("quotes", [])]


def fetch_price(ticker, spec):
    errors = []
    for source, fn in (("Yahoo Finance", yahoo), ("Stooq", stooq)):
        for sym in spec[source.split()[0].lower()]:
            try:
                price, cur, day = fn(sym)
                if cur and cur != spec["currency"]:
                    raise ValueError(f"měna {cur}, čekáno {spec['currency']}")
                return {"price": round(price, 4), "currency": spec["currency"], "date": day, "source": f"{source} ({sym})"}
            except Exception as e:  # noqa: BLE001 – zkusit další zdroj
                errors.append(f"{source} {sym}: {e}")
    raise RuntimeError("; ".join(errors))


def cnb_year(year):
    """Denní kurzy ČNB za celý rok (rok.txt) → {měna: {datum: kurz za 1 jednotku}}."""
    text = get(f"https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/rok.txt?rok={year}")
    out = {c: {} for c in FX}
    cols = {}
    for line in text.strip().splitlines():
        parts = line.split("|")
        if parts[0] == "Datum":  # hlavička se může během roku změnit (nové měny)
            cols = {}
            for i, h in enumerate(parts[1:], 1):
                amount, code = h.split()
                if code in FX:
                    cols[code] = (i, float(amount))
            continue
        day = dt.datetime.strptime(parts[0], "%d.%m.%Y").date().isoformat()
        for code, (i, amount) in cols.items():
            out[code][day] = round(float(parts[i].replace(",", ".")) / amount, 4)
    return out


def update_history():
    """Historie kurzů pro přepočet nákupních cen: chybějící roky + vždy aktuální rok."""
    hist = json.loads(HIST.read_text()) if HIST.exists() else {"source": "ČNB, kurzy devizového trhu", "rates": {c: {} for c in FX}}
    have = {d[:4] for d in hist["rates"].get("EUR", {})}
    this_year = dt.date.today().year
    for year in range(HIST_FROM, this_year + 1):
        if str(year) in have and year != this_year:
            continue
        try:
            for code, days in cnb_year(year).items():
                hist["rates"].setdefault(code, {}).update(days)
            print(f"ČNB {year}: OK")
        except Exception as e:  # noqa: BLE001
            print(f"ČNB {year}: nepodařilo se stáhnout ({e})")
    for code in hist["rates"]:
        hist["rates"][code] = dict(sorted(hist["rates"][code].items()))
    HIST.write_text(json.dumps(hist, ensure_ascii=False, separators=(",", ":")) + "\n")


def main():
    update_history()
    old = json.loads(OUT.read_text()) if OUT.exists() else {"fx": {}, "prices": {}}
    out = {"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"), "fx": dict(old.get("fx", {})), "prices": dict(old.get("prices", {}))}

    try:
        day, rates = cnb_rates()
        for code, rate in rates.items():
            out["fx"][code] = {"rate": round(rate, 4), "date": day, "source": "ČNB"}
        print(f"ČNB {day}: {rates}")
    except Exception as e:  # noqa: BLE001
        print(f"ČNB: nepodařilo se stáhnout ({e}), ponechávám předchozí kurzy")

    for ticker, spec in INSTRUMENTS.items():
        check = None
        try:
            found = isin_symbols(spec["isin"])
            match = [f for f in found if f[0] in spec["yahoo"]]
            check = {"isin": spec["isin"], "ok": bool(match), "name": match[0][2] if match else None,
                     "symbols": [f[0] for f in found]}
            print(f"{ticker} {spec['isin']}: {check}")
        except Exception as e:  # noqa: BLE001 – kontrola je jen informativní
            print(f"{ticker}: kontrola ISIN se nepovedla ({e})")
        try:
            p = fetch_price(ticker, spec)
            if check:
                p["isinCheck"] = check
            prev = old.get("prices", {}).get(ticker)
            if prev and abs(p["price"] / prev["price"] - 1) > MAX_JUMP:
                print(f"{ticker}: podezřelý skok {prev['price']} → {p['price']}, ponechávám předchozí")
                continue
            out["prices"][ticker] = p
            print(f"{ticker}: {p}")
        except Exception as e:  # noqa: BLE001
            print(f"{ticker}: nepodařilo se stáhnout ({e}), ponechávám předchozí")

    if not out["fx"] or not out["prices"]:
        raise SystemExit("Žádná použitelná data – market.json se nemění.")
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")


if __name__ == "__main__":
    main()
