// Denní předstažení cen běžných ETF podle ISIN (rebalancing/isin_prices.json).
// Používá stejný kód jako Cloudflare Worker, jen ho spouští v Node na GitHub Actions.
// Při chybě u ISINu se ponechá předchozí cena se svým datem.
// Použití: node rebalancing/worker/prefetch.mjs [ISIN,ISIN…]  (bez argumentu celý universe.json)
import fs from 'node:fs';
import worker from './worker.js';

const OUT = new URL('../isin_prices.json', import.meta.url);
const universe = JSON.parse(fs.readFileSync(new URL('./universe.json', import.meta.url))).isins;
const extra = (process.argv[2] || '').split(',').filter(Boolean);
const list = extra.length ? Object.fromEntries(extra.map(i => [i, universe[i] || ''])) : universe;
const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT)) : { prices: {} };
const prices = { ...old.prices };
const isins = Object.keys(list);

for (let k = 0; k < isins.length; k += 8) {
  const chunk = isins.slice(k, k + 8);
  const url = `https://worker.local/quotes?isin=${chunk.join(',')}&cur=${chunk.map(i => list[i]).join(',')}`;
  const res = await (await worker.fetch(new Request(url), {}, null)).json();
  for (const [isin, r] of Object.entries(res.results || {})) {
    if (r.price > 0) { prices[isin] = r; console.log(isin, r.symbol, r.price, r.currency, r.date); }
    else console.log(isin, 'CHYBA', r.error, r.tried || '');
  }
}
fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), prices }, null, 1) + '\n');
console.log(`Hotovo: ${Object.values(prices).length} cen`);
