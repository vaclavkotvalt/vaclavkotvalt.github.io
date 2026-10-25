// Testy výpočetního jádra: node --test rebalancing/test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fromSheets } from './io.js';
import { analyze, exemptFrom, nextBusinessDay, taxOf, DEFAULTS } from './engine.js';

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
});

test('hodnotový test FO: do 100 000 Kč hrubých příjmů bez daně', () => {
  const lot = (p, g) => ({ exempt: false, proceedsCZK: p, gainCZK: g });
  assert.equal(taxOf([lot(90000, 30000)], 'FO', DEFAULTS).amount, 0);
  assert.equal(taxOf([lot(150000, 30000)], 'FO', DEFAULTS).amount, 4500);
  assert.equal(taxOf([lot(150000, 30000), lot(80000, -40000)], 'FO', DEFAULTS).amount, 0); // ztráta se započte
  assert.equal(taxOf([lot(150000, 30000)], 'PO', DEFAULTS).amount, 6300);
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
