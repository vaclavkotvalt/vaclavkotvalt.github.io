// Testy výpočetního jádra: node --test rebalancing/test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fromSheets } from './io.js';
import { analyze, exemptFrom, nextBusinessDay, taxOf, historicFx, addYears, DEFAULTS } from './engine.js';

const raw = JSON.parse(fs.readFileSync(new URL('./data.json', import.meta.url)));
const data = fromSheets(raw.sheets);
const res = analyze(data);
const C = (id) => res.clients.find(c => c.id === `Klient ${id}`);
const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('načtení dat', () => {
  assert.equal(data.asOf, '2026-10-23');
  assert.equal(data.fx.EUR, 24.3);
  assert.equal(data.lots.length, 24);
  assert.deepEqual(res.issues, []);
});

test('ocenění odpovídá ručnímu výpočtu', () => {
  // Klient C: 880×142,5×24,3 + 1900×12,6×24,3 + 16000×4,62×24,3 + 360×78,4×21 + 18 000
  near(C('C').total, 3047220 + 581742 + 1796256 + 592704 + 18000);
  near(C('A').rows.find(r => r.key === 'VWCE').weight, 70.8, 0.05);
});

test('časový test a pracovní dny', () => {
  assert.equal(exemptFrom('2023-11-20', 3), '2026-11-21');
  assert.equal(nextBusinessDay('2026-11-21'), '2026-11-23'); // sobota → pondělí
  assert.equal(nextBusinessDay('2026-11-17'), '2026-11-18'); // státní svátek
  assert.equal(addYears('2024-02-29', 3), '2027-02-28'); // lhůta končí posledním dnem února
  assert.equal(exemptFrom('2024-02-29', 3), '2027-03-01');
});

test('hodnotový test FO: do 100 000 Kč hrubých příjmů bez daně', () => {
  const lot = (p, g) => ({ exempt: false, proceedsCZK: p, gainCZK: g });
  assert.equal(taxOf([lot(90000, 30000)], 'FO', DEFAULTS).amount, 0);
  assert.equal(taxOf([lot(150000, 30000)], 'FO', DEFAULTS).amount, 4500);
  assert.equal(taxOf([lot(150000, 30000), lot(80000, -40000)], 'FO', DEFAULTS).amount, 0); // ztráta se započte
  assert.equal(taxOf([lot(150000, 30000)], 'PO', DEFAULTS).amount, 6300);
  // do úhrnu 100 000 Kč se konzervativně počítají i prodeje osvobozené časovým testem
  const ex = { exempt: true, proceedsCZK: 50000, gainCZK: 20000 };
  assert.equal(taxOf([lot(80000, 30000), ex], 'FO', DEFAULTS).amount, 4500);
});

test('Klient A: počkat na vklad, prodat jen osvobozený lot', () => {
  const a = C('A');
  assert.equal(a.status, 'wait');
  assert.equal(a.plan.date, '2026-11-10');
  const sell = a.plan.trades.find(t => t.side === 'sell');
  assert.equal(sell.ticker, 'VWCE');
  assert.ok(sell.lots.every(l => l.exempt && l.date === '2021-03-15'));
  assert.equal(a.plan.tax.amount, 0);
});

test('Klient B: prodeje kryjí výběry, bez daně', () => {
  const b = C('B');
  assert.equal(b.status, 'act');
  assert.ok(b.triggers.some(t => t.code === 'liquidity'));
  assert.equal(b.plan.reserve, 85000 * 3 + 1500000);
  assert.equal(b.plan.tax.amount, 0);
  assert.ok(b.plan.cashAfter.CZK >= b.plan.reserve - 1);
  assert.ok(b.warnings.some(w => w.code === 'withdrawalRate'));
});

test('Klient C: v pásmu, nic nedělat', () => {
  assert.equal(C('C').status, 'ok');
  assert.equal(C('C').plan, null);
});

test('Klient D (s.r.o.): jen nákupy z hotovosti', () => {
  const d = C('D');
  assert.equal(d.status, 'act');
  assert.ok(d.plan.trades.every(t => t.side === 'buy'));
  assert.ok(d.plan.after.every(r => Math.abs(r.diff) < 0.5));
});

test('Klient E: počkat na osvobození lotu z 20. 11. 2023', () => {
  const e = C('E');
  assert.equal(e.status, 'wait');
  assert.equal(e.plan.date, '2026-11-23');
  assert.equal(e.plan.tax.amount, 0);
  assert.ok(e.alt.tax.amount > 80000); // zásah hned by stál ~81 tis. Kč na dani
  assert.ok(e.plan.cashAfter.CZK >= 250000 - 1); // rezerva na prosincový výběr
});

test('nikde nevznikne záporná hotovost', () => {
  for (const c of res.clients) if (c.plan) for (const v of Object.values(c.plan.cashAfter)) assert.ok(v > -0.01, c.id);
});

test('Klient A: čekání na vklad je levnější než zásah hned + druhé kolo', () => {
  const a = C('A'), r = a.decision.reasons.find(x => x.code === 'waitInflow');
  assert.ok(a.altFollow && a.altFollow.trades.length > 0);
  assert.ok(r.costWait < r.costNow + r.costFollow);
  assert.ok(r.costNow < r.costWait); // samotný zásah hned je levnější – proto je potřeba srovnávat obě kola
  assert.ok(r.soldWait < r.soldNow);
});

test('tržní ceny přepíšou ceny ze souboru, chybějící zůstanou', async () => {
  const { applyMarket } = await import('./io.js');
  const market = { fx: { EUR: { rate: 25, date: '2026-10-26' } }, prices: { VWCE: { price: 150, currency: 'EUR', date: '2026-10-26' }, IGLN: { price: 80, currency: 'EUR', date: '2026-10-26' } } };
  const m = applyMarket(data, market);
  assert.equal(m.data.instruments.find(i => i.ticker === 'VWCE').price, 150);
  assert.equal(m.data.instruments.find(i => i.ticker === 'IGLN').price, 78.4); // jiná měna → ponechat
  assert.equal(m.data.fx.EUR, 25);
  assert.equal(m.data.fx.USD, 21);
  assert.equal(m.asOf, '2026-10-26');
  assert.deepEqual(m.kept.sort(), ['AVWS', 'EUNA', 'IGLN']);
  // vklad klienta A (10. 11.) už měl proběhnout, když se počítá k 20. 11.
  const later = analyze(m.data, { asOf: '2026-11-20' });
  assert.ok(later.clients.find(c => c.id === 'Klient A').warnings.some(w => w.code === 'pastFlows'));
});

test('daňově šetrné pravidlo: zdanitelné loty jen nad 2× tolerancí, jen přesah', async () => {
  const { applyMarket } = await import('./io.js');
  // AVWS na dvojnásobku ceny: u klienta A je nad cílem, ale pod 2× tolerancí → neprodávat
  const market = { fx: {}, prices: { AVWS: { price: 25.2, currency: 'EUR', date: '2026-10-23' } } };
  const r = analyze(applyMarket(data, market).data);
  const a = r.clients.find(c => c.id === 'Klient A');
  const h = a.plan.heldBack.find(x => x.ticker === 'AVWS');
  assert.ok(h && h.sold === 0 && h.taxAvoided > 50000);
  assert.ok(!a.plan.trades.some(t => t.ticker === 'AVWS' && t.side === 'sell'));
  assert.equal(a.plan.tax.amount, 0);
  // bez pravidla by se AVWS prodávalo se ziskem a daní
  const full = analyze(applyMarket(data, market).data, { taxableBandMult: 0 }).clients.find(c => c.id === 'Klient A');
  assert.ok(full.plan.tax.amount > 50000);
});

test('nákupní cena kurzem ČNB ke dni nákupu, poplatek z prodeje jako výdaj, FIFO', () => {
  const hist = JSON.parse(fs.readFileSync(new URL('./fx_history.json', import.meta.url)));
  const fxAt = historicFx(hist);
  assert.equal(fxAt('EUR', '2021-03-15').rate, 26.195);
  assert.equal(fxAt('EUR', '2021-03-13').date, '2021-03-12'); // sobota → kurz z pátku
  assert.equal(DEFAULTS.lotMethod, 'fifo');
  const r = analyze({ ...data, fxHistory: hist });
  const a = r.clients.find(c => c.id === 'Klient A');
  const lot = a.lots.find(l => l.date === '2021-03-15');
  near(lot.costCZK, 1500 * 92.1 * 26.195);
  const sold = a.plan.trades.find(t => t.side === 'sell').lots[0];
  // 217 × (142,5 × 24,3 − 92,1 × 26,195) − poplatek 0,1 % z prodeje
  near(sold.gainCZK, 217 * (142.5 * 24.3 - 92.1 * 26.195) - 0.001 * 217 * 142.5 * 24.3);
  // klient E při prodeji hned: FIFO bere 180 ks z roku 2020 (osvobozené) a 620 ks z 20. 11. 2023 (zdanitelné)
  const e = r.clients.find(c => c.id === 'Klient E');
  const alt = e.alt.trades.find(t => t.ticker === 'VWCE').lots;
  assert.deepEqual(alt.map(l => [l.date, l.qty, l.exempt]), [['2020-01-13', 180, true], ['2023-11-20', 620, false]]);
  near(e.alt.tax.amount, 0.15 * (620 * (142.5 * 24.3 - 98.7 * 24.545) - 0.001 * 800 * 142.5 * 24.3 * 620 / 800), 1);
});

test('Excel bez cen, kurzů a data ocenění: doplní se z tržních dat', async () => {
  const { applyMarket } = await import('./io.js');
  // listy bez „Kurzy“, „Čti mě“ a bez cen v „Instrumenty“
  const sheets = Object.fromEntries(Object.entries(raw.sheets).filter(([k]) => !['Kurzy', 'Čti mě'].includes(k)));
  sheets.Instrumenty = sheets.Instrumenty.map((r, i) => i === 0 ? r : [...r.slice(0, 5), null]);
  const d = fromSheets(sheets);
  assert.equal(d.asOf, null);
  assert.deepEqual(d.fx, { CZK: 1 });
  assert.ok(analyze(d).issues.some(x => x.code === 'badPrice'));
  const market = { fx: { EUR: { rate: 24.3, date: '2026-10-23' }, USD: { rate: 21, date: '2026-10-23' } },
    prices: { VWCE: { price: 142.5, currency: 'EUR', date: '2026-10-23' }, AVWS: { price: 12.6, currency: 'EUR', date: '2026-10-23' },
      EUNA: { price: 4.62, currency: 'EUR', date: '2026-10-23' }, IGLN: { price: 78.4, currency: 'USD', date: '2026-10-23' } } };
  const r = analyze(applyMarket(d, market).data);
  assert.deepEqual(r.issues, []);
  assert.equal(r.asOf, '2026-10-23');
  // stejné ceny jako v zadání → stejné výsledky
  assert.deepEqual(r.clients.map(c => c.status), res.clients.map(c => c.status));
});
