// Test logiky Workeru bez internetu: fetch se nahradí falešnými odpověďmi.
// node --test rebalancing/worker/worker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const charts = {
  'SXR8.DE': { currency: 'EUR', close: 590.1 },
  'CSPX.L': { currency: 'USD', close: 680.2 },
  'IGLN.L': { currency: 'USD', close: 78.19 },
  'SGLN.L': { currency: 'GBp', close: 4512 },
};
const figi = {
  IE00B5BMR087: [{ ticker: 'SXR8', exchCode: 'GY' }, { ticker: 'CSPX', exchCode: 'LN' }, { ticker: 'CSPX', exchCode: 'XX' }],
  IE00B4ND3602: [{ ticker: 'IGLN', exchCode: 'LN' }],
  IE00B4VBMR80: [{ ticker: 'SGLN', exchCode: 'LN' }],
};
const day = Math.floor(Date.parse('2026-10-29T16:00:00Z') / 1000);
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
  if (url.includes('openfigi')) return ok(JSON.parse(init.body).map(j => ({ data: figi[j.idValue] || [] })));
  if (url.includes('/search')) return ok({ quotes: [] });
  const sym = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
  const c = charts[sym];
  if (!c) return new Response('{}', { status: 404 });
  return ok({ chart: { result: [{ meta: { currency: c.currency, exchangeName: 'X' }, timestamp: [day - 86400, day], indicators: { quote: [{ close: [c.close - 1, c.close] }] } }] } });
};
const call = async (q) => (await worker.fetch(new Request('https://w.test/quotes?' + q), {}, null)).json();

test('nápověda měny vybere kotaci v té měně, jinak EUR', async () => {
  assert.equal((await call('isin=IE00B5BMR087&cur=USD')).results.IE00B5BMR087.symbol, 'CSPX.L');
  assert.equal((await call('isin=IE00B5BMR087')).results.IE00B5BMR087.symbol, 'SXR8.DE');
});
test('pence (GBp) se převedou na GBP', async () => {
  const r = (await call('isin=IE00B4VBMR80')).results.IE00B4VBMR80;
  assert.equal(r.currency, 'GBP'); assert.equal(r.price, 45.12);
});
test('neplatný a neznámý ISIN vrátí chybu, ne cenu', async () => {
  const r = (await call('isin=NEPLATNY,IE00BXXXXXX1')).results;
  assert.ok(r.NEPLATNY.error); assert.ok(r.IE00BXXXXXX1.error);
});
test('limit ISINů a CORS', async () => {
  const many = Array.from({ length: 9 }, (_, i) => 'IE00B5BMR08' + i).join(',');
  const resp = await worker.fetch(new Request('https://w.test/quotes?isin=' + many), {}, null);
  assert.equal(resp.status, 400);
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), '*');
});
