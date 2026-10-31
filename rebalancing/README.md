# Rebalancování portfolií

Nástroj pro portfolio manažera: ukáže, kteří klienti se vzdálili od cílového portfolia, co konkrétně
koupit a prodat, kolik zásah stojí na daních a poplatcích a kdy se vyplatí počkat.
Vznikl jako řešení case study Dvořák & Zedník Wealth Management.

- **Nástroj:** <https://vaclavkotvalt.cz/rebalancing/> (statická stránka, nic se neinstaluje)
- **Pravidla, předpoklady a výstup pro data ze zadání:** sekce „Jak nástroj rozhoduje“ na stránce
  a přiložený popis řešení

## Struktura

Výpočet je oddělený od zobrazení. Jádro nezná prohlížeč, Excel ani internet – dostane data
a nastavení a vrátí prostý objekt s výsledky.

| Soubor | Co dělá |
|---|---|
| [`engine.js`](engine.js) | **Výpočetní jádro.** Čisté funkce bez závislostí: ocenění, odchylky, pravidla zásahu, návrh obchodů, výběr lotů, daně, náklady, čekání na vklad a na osvobození. |
| [`io.js`](io.js) | Převod listů Excelu na datový model (`fromSheets`) a doplnění tržních cen a kurzů (`applyMarket`). |
| [`index.html`](index.html) | Jen zobrazení: přehled klientů, detail, grafy, export příkazů, zpráva pro klienta. Texty skládá z kódů, které vrací jádro. |
| [`test.mjs`](test.mjs) | Testy jádra na datech ze zadání (klienti A–E) i na okrajových případech. |
| [`data.json`](data.json) | Data ze zadání (listy Excelu beze změny), vytváří `scripts/xlsx_to_json.py`. |
| [`sablona.xlsx`](sablona.xlsx) | Šablona pro vlastní data, vytváří `scripts/make_template.py`. |
| `market.json`, `isin_prices.json`, `fx_history.json` | Denní ceny ETF a kurzy ČNB (včetně historie od roku 2010 pro nákupní ceny). |
| [`scripts/update_market.py`](scripts/update_market.py) | Stahuje kurzy ČNB a ceny; spouští ho každý pracovní den GitHub Actions ([workflow](../.github/workflows/update-market-data.yml)). |
| [`worker/`](worker/) | Služba na Cloudflare, která dohledá cenu libovolného ETF nebo akcie podle ISIN ([návod](worker/NAVOD.md)). |

## Použití jádra v jiném systému

Jádro je jeden ES modul bez závislostí, běží v prohlížeči i v Node.js (≥ 18):

```js
import { analyze, orders } from './engine.js';

const result = analyze(data, { bandAbs: 5, feePct: 0.1 });   // nastavení je nepovinné

for (const c of result.clients) {
  console.log(c.id, c.status, c.decision.date);              // 'act' | 'wait' | 'ok'
  for (const t of c.plan?.trades ?? []) console.log(' ', t.side, t.qty, t.ticker, Math.round(t.valueCZK));
}
console.table(orders(result));                               // plochý seznam příkazů (např. pro CSV)
```

**Vstup** (`data`) – stejný tvar vrací `fromSheets()` z Excelu, jde ho ale sestavit z libovolného zdroje:

```js
{
  asOf: '2026-10-23',                                  // datum ocenění
  fx: { CZK: 1, EUR: 24.3, USD: 21 },                  // kurzy (CZK za 1 jednotku)
  instruments: [{ ticker, isin, currency, price, assetClass, name }],
  clients: [{ id, taxRegime: 'FO' | 'PO', targets: { VWCE: 60, CASH: 0 }, profile, note }],
  lots:  [{ client, ticker, date, qty, cost }],        // každý nákup zvlášť (časový test, FIFO)
  cash:  [{ client, currency, amount }],
  flows: [{ client, date, amount, note }],             // + vklad, − výběr (CZK)
  fxHistory: { rates: { EUR: { '2021-03-15': 26.195 } } }   // nepovinné: kurz ČNB ke dni nákupu
}
```

**Výstup** – pro každého klienta mimo jiné:

| Pole | Obsah |
|---|---|
| `status` | `act` (zasáhnout teď), `wait` (počkat do `decision.date`), `ok` |
| `rows` | váhy teď, cíl, odchylka, tolerance, `out` = mimo toleranci |
| `decision.reasons` | kódy důvodů (`drift`, `liquidity`, `waitInflow`, `waitTax`, `harvest`, …) s čísly |
| `plan.trades` | obchody: strana, kusy, cena, objem, poplatek, prodávané loty s osvobozením |
| `plan.costs` | `fees`, `fx`, `tax`, `total` v CZK |
| `plan.after` | váhy po obchodech |
| `alt`, `altFollow` | co by stál zásah hned (pro srovnání „proč počkat“) |
| `warnings` | upozornění pro manažera (např. výše renty, prošlé pohyby) |

Výsledky neobsahují texty, jen kódy a čísla – jazyk a formulace jsou věcí zobrazení.
Všechna pravidla mají parametr v `DEFAULTS` (tolerance, horizonty, poplatky, sazby daně, metoda lotů).

## Testy

```bash
node --test rebalancing/test.mjs                 # jádro: data ze zadání a okrajové případy
node --test rebalancing/worker/worker.test.mjs   # služba pro ceny (bez internetu, falešné odpovědi)
```

Testy mimo jiné hlídají ruční přepočty daní (např. zisk lotu klienta A s kurzem ČNB ke dni nákupu),
že nikde nevznikne záporná hotovost a že doporučení pro klienty A–E odpovídají popisu řešení.

## Odkud jsou data

- **Kurzy:** Česká národní banka – denní kurzy devizového trhu, aktuální i historie od roku 2010.
- **Ceny ETF a akcií:** závěrečné ceny z Yahoo Finance (neoficiální zdroj); zhruba 40 běžných ETF
  se stahuje každý večer, ostatní ISINy z nahraného Excelu dohledá služba ve `worker/`.
  Služba dostává jen ISINy, nikdy data klientů.
- **Vlastní Excel** se zpracuje jen v prohlížeči a nikam se neodesílá.
