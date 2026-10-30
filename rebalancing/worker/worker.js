// Cloudflare Worker pro nástroj Rebalancování portfolií: aktuální cena ETF podle ISIN.
//
//   GET /quotes?isin=IE00B5BMR087,IE00BK5BQT80&cur=USD,EUR   (nejvýš 8 ISINů)
//
// `cur` je nepovinná nápověda (měna z Excelu) – přednostně se vybere kotace v této měně.
// Stránka posílá jen ISINy, žádná data klientů. Jeden soubor bez závislostí: dá se vložit
// přímo do editoru v Cloudflare dashboardu („Create Worker“ → „Edit code“).
//
// Postup pro každý ISIN:
//  1. kandidátní symboly: OpenFIGI (ISIN → tickery na burzách) + vyhledávání Yahoo podle ISIN,
//  2. poslední závěrečná cena z Yahoo Finance pro kandidáty,
//  3. výběr kotace: měna z nápovědy → EUR → USD → ostatní podporované; při shodě nejčerstvější.

// Bezplatný plán Cloudflare dovolí 50 dílčích dotazů na jeden požadavek:
// 1 (OpenFIGI) + 8 × (1 vyhledávání + 4 kotace) = 41 → nejvýš 8 ISINů najednou, stránka posílá po dávkách
const MAX_ISINS = 8;
const MAX_CANDIDATES = 4;
const CACHE_SECONDS = 6 * 3600;
const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CZK']; // měny, pro které má stránka kurzy ČNB
const UA = { 'User-Agent': 'Mozilla/5.0 (rebalancing tool; vaclavkotvalt.cz)' };
// Kód burzy v OpenFIGI → přípona symbolu na Yahoo, v pořadí preference
// (US burzy mají na Yahoo symbol bez přípony, Praha .PR – kvůli akciím, nejen ETF)
const EXCHANGES = [['GY', '.DE'], ['LN', '.L'], ['US', ''], ['UN', ''], ['UW', ''], ['UQ', ''], ['CP', '.PR'],
  ['NA', '.AS'], ['IM', '.MI'], ['FP', '.PA'], ['SW', '.SW'], ['GS', '.SG'], ['GF', '.F'], ['GM', '.MU'], ['GD', '.DU']];
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
// Domácí burza podle země v ISIN má přednost (likvidní hlavní kotace, ne vedlejší kotace v zahraničí).
// ETF (IE, LU) domácí burzu nemají – tam platí pořadí EXCHANGES.
const HOME = { US: '', CZ: '.PR', DE: '.DE', GB: '.L', NL: '.AS', FR: '.PA', IT: '.MI', CH: '.SW' };
const suffixOf = (symbol) => (symbol.includes('.') ? '.' + symbol.split('.').pop() : '');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors, ...extra } });

async function getJson(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
  return r.json();
}

// ISIN → [{symbol, rank}] z OpenFIGI (bez API klíče max. 10 dotazů v jednom požadavku)
async function figiSymbols(isins) {
  const out = Object.fromEntries(isins.map(i => [i, []]));
  for (let k = 0; k < isins.length; k += 10) {
    const chunk = isins.slice(k, k + 10);
    try {
      const res = await getJson('https://api.openfigi.com/v3/mapping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map(isin => ({ idType: 'ID_ISIN', idValue: isin }))),
      });
      res.forEach((r, j) => {
        for (const d of r.data || []) {
          const ex = EXCHANGES.findIndex(([code]) => code === d.exchCode);
          // třídy akcií: BRK/B → BRK-B (zápis Yahoo)
          if (ex >= 0 && d.ticker) out[chunk[j]].push({ symbol: d.ticker.replace(/\s+/g, '').replace(/[/.]/g, '-') + EXCHANGES[ex][1], rank: ex, name: d.name });
        }
      });
    } catch (e) { /* OpenFIGI je jen jeden ze zdrojů kandidátů */ }
  }
  return out;
}

// ISIN → symboly z vyhledávání Yahoo (vrací jen část burz, proto doplněk k OpenFIGI)
async function yahooSearch(isin) {
  try {
    const j = await getJson(`https://query2.finance.yahoo.com/v1/finance/search?q=${isin}&quotesCount=10&newsCount=0`);
    return (j.quotes || []).filter(q => q.symbol).map(q => ({ symbol: q.symbol, rank: 50, name: q.longname || q.shortname }));
  } catch (e) { return []; }
}

// Poslední závěrečná cena symbolu; londýnské kotace v pencích (GBp) se převedou na GBP
async function yahooQuote(symbol) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10d&interval=1d`);
  const res = j.chart?.result?.[0];
  const closes = res?.indicators?.quote?.[0]?.close || [];
  let i = closes.length - 1;
  while (i >= 0 && closes[i] == null) i--;
  if (i < 0) throw new Error('bez ceny');
  let price = closes[i], currency = res.meta?.currency;
  if (currency === 'GBp' || currency === 'GBX') { price /= 100; currency = 'GBP'; }
  const date = new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10);
  return { symbol, price: Math.round(price * 10000) / 10000, currency, date, exchange: res.meta?.exchangeName };
}

async function quoteIsin(isin, hint, figi) {
  const seen = new Set();
  const home = HOME[isin.slice(0, 2)];
  const cands = [...figi, ...(await yahooSearch(isin))]
    .filter(c => !seen.has(c.symbol) && seen.add(c.symbol))
    .map(c => (home !== undefined && suffixOf(c.symbol) === home ? { ...c, rank: -1 } : c))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_CANDIDATES);
  if (!cands.length) return { error: 'ISIN se nepodařilo najít na žádné burze' };
  const quotes = (await Promise.all(cands.map(c => yahooQuote(c.symbol).then(q => ({ ...q, rank: c.rank, name: c.name })).catch(() => null))))
    .filter(q => q && CURRENCIES.includes(q.currency) && q.price > 0);
  if (!quotes.length) return { error: 'pro nalezené kotace není cena', tried: cands.map(c => c.symbol) };
  // jen kotace z posledních dní (stará = málo likvidní burza), pak podle měny a preference burzy
  const newest = quotes.map(q => q.date).sort().at(-1);
  const fresh = quotes.filter(q => (Date.parse(newest) - Date.parse(q.date)) / 864e5 <= 5);
  const curRank = (c) => (c === hint ? 0 : c === 'EUR' ? 1 : c === 'USD' ? 2 : 3);
  fresh.sort((a, b) => curRank(a.currency) - curRank(b.currency) || a.rank - b.rank);
  const q = fresh[0];
  return { price: q.price, currency: q.currency, date: q.date, symbol: q.symbol, exchange: q.exchange, name: q.name || null, source: 'Yahoo Finance' };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname !== '/quotes') return json({ ok: true, usage: '/quotes?isin=IE00B5BMR087,IE00BK5BQT80&cur=USD,EUR' });

    const isins = (url.searchParams.get('isin') || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
    const hints = (url.searchParams.get('cur') || '').toUpperCase().split(',').map(s => s.trim());
    if (!isins.length) return json({ error: 'chybí parametr isin' }, 400);
    if (isins.length > MAX_ISINS) return json({ error: `nejvýš ${MAX_ISINS} ISINů najednou` }, 400);

    // cache Cloudflare: stejný dotaz se po dobu 6 hodin neopakuje
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const key = new Request(url.toString(), { method: 'GET' });
    if (cache) { const hit = await cache.match(key); if (hit) return hit; }

    const valid = isins.filter(i => ISIN_RE.test(i));
    const figi = await figiSymbols(valid);
    const results = {};
    await Promise.all(isins.map(async (isin, k) => {
      results[isin] = ISIN_RE.test(isin) ? await quoteIsin(isin, hints[k] || null, figi[isin] || []) : { error: 'neplatný ISIN' };
    }));
    const resp = json({ updated: new Date().toISOString(), results }, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
    if (cache && ctx) ctx.waitUntil(cache.put(key, resp.clone()));
    return resp;
  },
};
