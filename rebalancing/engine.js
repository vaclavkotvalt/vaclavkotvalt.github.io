// Výpočetní jádro nástroje pro rebalancování. Čisté funkce bez DOM a bez I/O:
// vstupem je datový model (viz io.js) a nastavení, výstupem prostý objekt.
// Texty pro uživatele nevrací – jen kódy a čísla, popisky skládá zobrazení.

export const DEFAULTS = {
  bandAbs: 5,            // tolerance kolem cíle v p. b. …
  bandRel: 25,           // … nebo v % cílové váhy, platí užší z obou (pravidlo 5/25)
  bandMin: 2,            // ale nikdy užší než 2 p. b. (malé a nulové cíle, např. hotovost)
  horizonDays: 90,       // výběry v tomto horizontu se drží v hotovosti jako rezerva
  inflowWaitDays: 30,    // vklad do 30 dní → s obchodem se počká na něj
  taxWaitDays: 60,       // lot se osvobodí do 60 dní → zvážit čekání
  minTaxSaving: 10000,   // čekat jen pokud ušetří aspoň tolik CZK na dani
  minTrade: 20000,       // menší obchody se neprovádějí (CZK) …
  minTradePct: 0.5,      // … ani obchody pod 0,5 % majetku (šum, který nestojí za obchod)
  feePct: 0.1,           // poplatek brokera v % objemu …
  feeMinEur: 2,          // … minimálně 2 EUR za obchod
  fxSpreadPct: 0.25,     // náklad konverze měny v % převáděné částky
  taxFO: 15,             // daň z příjmů FO (§ 10 ZDP) v %
  taxPO: 21,             // daň z příjmů PO v %
  valueTestLimit: 100000,   // hodnotový test FO: úhrn hrubých příjmů ze všech prodejů CP za rok
  timeTestYears: 3,
  lotMethod: 'fifo',     // 'fifo' = nejstarší první (nejlépe doložitelné pro časový test), 'tax' = výběr konkrétních lotů
  taxableBandMult: 2,    // zdanitelné loty se ziskem prodávat jen nad 2× pásmem, a to jen ten přesah (0 = vypnuto)
  withdrawalWarnPct: 4,  // varovat, pokud pravidelné výběry přesahují 4 % majetku ročně
};

// ---------- data a pracovní dny ----------
const DAY = 864e5;
const toDate = (s) => new Date(s + 'T00:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => iso(new Date(toDate(s).getTime() + n * DAY));
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
// 29. 2. + rok = 28. 2. (lhůta končí posledním dnem měsíce), ne 1. 3.
export function addYears(s, n) {
  const d = toDate(s), m = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + n);
  if (d.getUTCMonth() !== m) d.setUTCDate(0);
  return iso(d);
}

function easterSunday(y) { // anonymní gregoriánský algoritmus
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const CZ_HOLIDAYS = ['01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26'];
export function isBusinessDay(s) {
  const w = toDate(s).getUTCDay();
  if (w === 0 || w === 6 || CZ_HOLIDAYS.includes(s.slice(5))) return false;
  const e = easterSunday(+s.slice(0, 4));
  return s !== addDays(e, -2) && s !== addDays(e, 1);
}
export function nextBusinessDay(s) { while (!isBusinessDay(s)) s = addDays(s, 1); return s; }

// Časový test: osvobozeno, pokud doba držení PŘESAHUJE 3 roky → první den je den po výročí
export const exemptFrom = (buyDate, years) => addDays(addYears(buyDate, years), 1);

const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);

// ---------- validace vstupu ----------
export function validate(data) {
  const issues = [];
  const tickers = new Set(data.instruments.map(i => i.ticker));
  for (const i of data.instruments) {
    if (!(i.price > 0) || !i.currency) { issues.push({ code: 'badPrice', ticker: i.ticker }); continue; }
    if (!(data.fx[i.currency] > 0)) issues.push({ code: 'missingFx', currency: i.currency });
  }
  const ids = new Set(data.clients.map(c => c.id));
  for (const c of data.clients) {
    const s = sum(Object.values(c.targets));
    if (Math.abs(s - 100) > 0.01) issues.push({ code: 'targetsSum', client: c.id, sum: s });
    for (const t of Object.keys(c.targets)) if (t !== 'CASH' && !tickers.has(t)) issues.push({ code: 'unknownTicker', client: c.id, ticker: t });
  }
  for (const l of data.lots) {
    if (!tickers.has(l.ticker)) issues.push({ code: 'unknownTicker', client: l.client, ticker: l.ticker });
    if (!ids.has(l.client)) issues.push({ code: 'unknownClient', client: l.client });
    if (!(l.qty > 0) || !l.date) issues.push({ code: 'badLot', client: l.client, ticker: l.ticker });
  }
  for (const c of data.cash) if (!(data.fx[c.currency] > 0)) issues.push({ code: 'missingFx', currency: c.currency });
  for (const f of data.flows) if (!f.date || !isFinite(f.amount)) issues.push({ code: 'badFlow', client: f.client });
  return issues;
}

// ---------- hlavní funkce ----------
export function analyze(data, settings = {}) {
  const S = { ...DEFAULTS, ...settings };
  const asOf = settings.asOf || data.asOf;
  const issues = validate(data);
  const fatal = issues.filter(i => ['badPrice', 'missingFx', 'unknownTicker', 'badLot'].includes(i.code));
  if (fatal.length) return { asOf, settings: S, issues, clients: [], summary: null };

  const inst = Object.fromEntries(data.instruments.map(i => [i.ticker, { ...i, pCZK: i.price * data.fx[i.currency] }]));
  const fxAt = historicFx(data.fxHistory);
  const ctx = { S, asOf, fx: data.fx, inst, fxAt, feeMinCZK: S.feeMinEur * (data.fx.EUR || 25) };
  const clients = data.clients.map(c => analyzeClient(c, data, ctx));

  const summary = {
    aum: sum(clients, c => c.total),
    count: { act: 0, wait: 0, ok: 0 },
    costs: sum(clients, c => c.plan ? c.plan.costs.total : 0),
    taxSaved: sum(clients, c => c.decision.taxSaved || 0),
  };
  for (const c of clients) summary.count[c.status]++;
  return { asOf, settings: S, issues, clients, summary, instruments: Object.values(inst), fx: data.fx };
}

function analyzeClient(client, data, ctx) {
  const { S, asOf, fx, inst, fxAt } = ctx;
  const own = (x) => x.client === client.id;
  const cash = {};
  for (const c of data.cash.filter(own)) cash[c.currency] = (cash[c.currency] || 0) + c.amount;
  const flows = data.flows.filter(own).filter(f => f.date > asOf).sort((a, b) => a.date.localeCompare(b.date))
    .map(f => ({ ...f, days: daysBetween(asOf, f.date) }));

  const lots = data.lots.filter(own).map(l => {
    const i = inst[l.ticker];
    const ex = client.taxRegime === 'FO' ? exemptFrom(l.date, S.timeTestYears) : null;
    // Nákupní cena kurzem ČNB platným v den nákupu (§ 38 ZDP); bez historie kurzů dnešním kurzem
    const h = i.currency === 'CZK' ? null : fxAt(i.currency, l.date);
    const costFx = h ? h.rate : fx[i.currency];
    const costCZK = l.qty * l.cost * costFx;
    return {
      ...l, currency: i.currency,
      valueCZK: l.qty * i.pCZK,
      costFx, costFxDate: h ? h.date : null, costCZK,
      gainCZK: l.qty * i.pCZK - costCZK,
      exemptFrom: ex, exemptNow: ex != null && asOf >= ex,
    };
  });

  const tickers = [...new Set([...Object.keys(client.targets).filter(k => k !== 'CASH'), ...lots.map(l => l.ticker)])];
  const held = Object.fromEntries(tickers.map(t => [t, sum(lots.filter(l => l.ticker === t), l => l.qty)]));
  const state = valuation(held, cash, ctx);
  const rows = weightRows(state, client.targets, tickers, 0, S);

  const horizonEnd = addDays(asOf, S.horizonDays);
  const reserveNow = -sum(flows.filter(f => f.amount < 0 && f.date <= horizonEnd), f => f.amount);

  const triggers = [];
  const out = rows.filter(r => r.out);
  if (out.length) triggers.push({ code: 'drift', keys: out.map(r => r.key) });
  if (state.cashCZK < reserveNow) triggers.push({ code: 'liquidity', reserve: reserveNow, cash: state.cashCZK });

  const warnings = clientWarnings(client, flows, state, ctx);
  // Pohyby mezi datem souboru a datem ocenění už měly proběhnout – nástroj je nezapočte, hotovost musí sedět ze souboru
  // u tržního ocenění se počítá od data souboru (bez data v souboru od počátku), jinak od data ocenění
  const fileDate = 'fileAsOf' in data ? data.fileAsOf : data.asOf;
  const past = data.flows.filter(own).filter(f => f.date > (fileDate || '0000-00-00') && f.date <= asOf);
  if (past.length) warnings.push({ code: 'pastFlows', flows: past });
  const base = {
    id: client.id, profile: client.profile, taxRegime: client.taxRegime, note: client.note,
    targets: client.targets, total: state.total, cash, cashCZK: state.cashCZK, rows, lots, flows,
    maxDrift: Math.max(...rows.map(r => Math.abs(r.diff))),
    triggers, warnings,
  };

  const now = nextBusinessDay(addDays(asOf, 1));
  // Chybné cíle (součet ≠ 100 %): žádné obchody, dokud se neopraví – jinak by se obchodovalo podle špatného zadání
  const targetSum = sum(Object.values(client.targets));
  if (Math.abs(targetSum - 100) > 0.01) {
    return { ...base, status: 'act', decision: { date: null, reasons: [{ code: 'badTargets', sum: targetSum }] }, plan: null, alt: null, altFollow: null };
  }
  const plan = (date) => planAt(date, { client, lots, held, cash, flows, tickers }, ctx);
  // plný rebalancing bez daňově šetrného pravidla – pro srovnání s čekáním na osvobození
  const ctxFull = { ...ctx, S: { ...S, taxableBandMult: 0 } };
  const planFull = (date) => planAt(date, { client, lots, held, cash, flows, tickers }, ctxFull);
  if (!triggers.length) {
    const nextIn = flows.find(f => f.amount > 0);
    return { ...base, status: 'ok', decision: { date: null, reasons: [{ code: 'inBand' }], nextInflow: nextIn || null }, plan: null, alt: null, altFollow: null };
  }

  const reasons = triggers.map(t => ({ ...t }));
  let date = now;

  // 1) Vklad v blízké době: srovnat stejný výsledek dvěma cestami –
  //    a) zásah hned + druhé kolo obchodů po příchodu vkladu, b) počkat a obchodovat jednou
  const inflow = flows.find(f => f.amount > 0 && f.days <= S.inflowWaitDays);
  let altFollow = null;
  if (inflow && liquidityOk(state.cashCZK, flows, inflow.date)) {
    const dIn = nextBusinessDay(inflow.date);
    const pNow = plan(now), pWait = plan(dIn);
    altFollow = planAt(dIn, { client, lots, held: pNow.heldAfter, cash: pNow.cashAfter, flows: flows.filter(f => f.date > now), tickers }, ctx);
    const cmp = {
      date: inflow.date, tradeDate: dIn, amount: inflow.amount, days: daysBetween(asOf, dIn),
      costWait: pWait.costs.total, costNow: pNow.costs.total, costFollow: altFollow.costs.total,
      soldWait: pWait.sold, soldNow: pNow.sold + altFollow.sold,
      tradesWait: pWait.trades.length, tradesNow: pNow.trades.length + altFollow.trades.length,
    };
    if (cmp.costWait <= cmp.costNow + cmp.costFollow) { date = dIn; reasons.push({ code: 'waitInflow', ...cmp }); }
    else { reasons.push({ code: 'inflowNotWorthWaiting', ...cmp }); altFollow = null; }
  }
  let p = plan(date);

  // 2) Daň: když se zdanitelné loty brzy osvobodí, porovnat plný rebalancing teď a po osvobození
  //    (u zadržených lotů by se jinak teď obchodovalo jen napůl a za pár týdnů znovu)
  let taxSaved = 0, altFull = null;
  const pFull = p.heldBack.length ? planFull(date) : p;
  if (pFull.tax.amount > 0 && client.taxRegime === 'FO') {
    const soon = pFull.trades.flatMap(t => t.lots).filter(l => !l.exempt && l.exemptFrom && daysBetween(date, l.exemptFrom) <= S.taxWaitDays);
    if (soon.length) {
      const d2 = nextBusinessDay(soon.map(l => l.exemptFrom).sort().at(-1));
      const p2 = plan(d2);
      const saving = pFull.tax.amount - p2.tax.amount;
      if (saving >= S.minTaxSaving && liquidityOk(state.cashCZK, flows, d2)) {
        reasons.push({ code: 'waitTax', date: d2, saving, days: daysBetween(asOf, d2) });
        taxSaved = saving; p = p2; date = d2; altFull = planFull(now);
      } else if (p.tax.amount > 0) {
        reasons.push({ code: 'taxNotWorthWaiting', date: d2, saving });
      }
    }
  }
  if (p.tax.amount > 0) reasons.push({ code: 'taxDue', amount: p.tax.amount });
  if (client.taxRegime === 'PO' && p.trades.some(t => t.side === 'sell')) reasons.push({ code: 'poSellTaxable' });

  let status = date > now ? 'wait' : 'act';
  // Nic k obchodování, protože nadváhu drží jen zdanitelné loty: nechat ležet do jejich osvobození
  if (!p.trades.length && p.heldBack.length) {
    const ex = p.heldBack.map(h => h.exemptFrom).filter(Boolean).sort()[0] || null;
    reasons.push({ code: 'holdTaxable', date: ex });
    status = ex ? 'wait' : 'ok';
    date = ex;
  }
  return {
    ...base, status,
    decision: { date, reasons, taxSaved },
    plan: p,
    alt: status === 'wait' && p.trades.length ? (altFull || plan(now)) : null, // co by stál zásah hned …
    altFollow: status === 'wait' ? altFollow : null, // … a druhé kolo po příchodu vkladu
  };
}

// Kurz ČNB platný v daný den = poslední vyhlášený kurz k tomuto dni (o víkendu a svátku ten předchozí)
export function historicFx(history) {
  const idx = {};
  for (const [cur, days] of Object.entries(history?.rates || {})) idx[cur] = Object.keys(days).sort();
  return (cur, day) => {
    const keys = idx[cur];
    if (!keys || !keys.length || day < keys[0] || daysBetween(keys.at(-1), day) > 7) return null;
    let lo = 0, hi = keys.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (keys[mid] <= day) lo = mid; else hi = mid - 1; }
    return { date: keys[lo], rate: history.rates[cur][keys[lo]] };
  };
}

function valuation(held, cash, ctx) {
  const values = Object.fromEntries(Object.entries(held).map(([t, q]) => [t, q * ctx.inst[t].pCZK]));
  const cashCZK = sum(Object.entries(cash), ([c, a]) => a * ctx.fx[c]);
  return { values, cashCZK, total: sum(Object.values(values)) + cashCZK };
}

function band(target, S) {
  return Math.max(S.bandMin, Math.min(S.bandAbs, (S.bandRel / 100) * target));
}

// Váhy počítané z majetku po odečtení rezervy na plánované výběry
function weightRows(state, targets, tickers, reserve, S) {
  const base = state.total - reserve;
  const rows = tickers.map(t => ({ key: t, value: state.values[t] || 0 }));
  rows.push({ key: 'CASH', value: state.cashCZK - reserve });
  return rows.map(r => {
    const target = targets[r.key] || 0, weight = base > 0 ? (r.value / base) * 100 : 0, b = band(target, S);
    return { ...r, weight, target, diff: weight - target, band: b, out: Math.abs(weight - target) > b };
  });
}

// Stačí hotovost (vč. vkladů) na všechny výběry do daného data?
function liquidityOk(cashCZK, flows, until) {
  let bal = cashCZK;
  for (const f of flows) {
    if (f.date > until) break;
    bal += f.amount;
    if (bal < 0) return false;
  }
  return true;
}

function fee(valueCZK, ctx) { return Math.max((ctx.S.feePct / 100) * valueCZK, ctx.feeMinCZK); }

// Pořadí lotů k prodeji. FIFO = nejstarší první; 'tax' = osvobozené, pak ztrátové, pak s nejmenším ziskem na kus
function orderLots(lots, date, regime, method) {
  const info = lots.map(l => ({ ...l, exempt: regime === 'FO' && date >= l.exemptFrom, gps: l.gainCZK / l.qty }));
  if (method === 'fifo') return info.sort((a, b) => a.date.localeCompare(b.date));
  return info.sort((a, b) => (b.exempt - a.exempt) || (a.exempt ? a.date.localeCompare(b.date) : a.gps - b.gps));
}

function takeLots(lots, qty, date, regime, method) {
  const out = [];
  for (const l of orderLots(lots, date, regime, method)) {
    if (qty <= 0) break;
    const q = Math.min(qty, l.qty);
    out.push({ date: l.date, qty: q, cost: l.cost, gainCZK: l.gps * q, exempt: l.exempt, exemptFrom: l.exemptFrom });
    qty -= q;
  }
  return out;
}

// Pokrytí záporných zůstatků konverzí z měny s největším přebytkem (CZK musí držet rezervu)
function settleFx(cash, reserve, ctx) {
  const need = (c) => (c === 'CZK' ? reserve : 0);
  const conversions = [];
  for (const cur of Object.keys(cash)) {
    let deficitCZK = (need(cur) - cash[cur]) * ctx.fx[cur];
    while (deficitCZK > 0.005) {
      const src = Object.keys(cash).filter(c => c !== cur)
        .map(c => [c, (cash[c] - need(c)) * ctx.fx[c]]).filter(([, s]) => s > 0.005).sort((a, b) => b[1] - a[1])[0];
      if (!src) break;
      const spread = ctx.S.fxSpreadPct / 100;
      const gross = Math.min(src[1], deficitCZK / (1 - spread)); // kolik CZK hodnoty se ze zdroje odebere
      const net = gross * (1 - spread);
      cash[src[0]] -= gross / ctx.fx[src[0]];
      cash[cur] += net / ctx.fx[cur];
      conversions.push({ from: src[0], to: cur, amountCZK: gross, costCZK: gross - net });
      deficitCZK -= net;
    }
  }
  const deficit = sum(Object.keys(cash), c => Math.max(0, (need(c) - cash[c]) * ctx.fx[c]));
  return { conversions, deficit };
}

function planAt(date, cl, ctx) {
  const { S, inst } = ctx;
  const { client } = cl;
  const cash0 = { ...cl.cash };
  // pohyby do data obchodu proběhnou přes hotovost (v CZK)
  for (const f of cl.flows) if (f.date <= date) cash0.CZK = (cash0.CZK || 0) + f.amount;
  const reserveFlows = cl.flows.filter(f => f.amount < 0 && f.date > date && f.date <= addDays(date, S.horizonDays));
  const reserve = -sum(reserveFlows, f => f.amount);
  const before = valuation(cl.held, cash0, ctx);
  const investable = before.total - reserve;
  const tgt = (k) => ((client.targets[k] || 0) / 100) * investable;
  const minTrade = Math.max(S.minTrade, (S.minTradePct / 100) * investable);
  const beforeRows = weightRows(before, client.targets, cl.tickers, reserve, S);
  if (investable <= 0) {
    return { date, reserve, reserveFlows, investable, error: 'insufficient', trades: [], conversions: [], heldBack: [], sold: 0, heldAfter: cl.held, cashAfter: cash0, tax: { amount: 0 }, costs: { fees: 0, fx: 0, tax: 0, total: 0 }, before: beforeRows, after: beforeRows };
  }

  const trades = [];
  // Prodeje. Daňově šetrné pravidlo: lot osvobozený nebo ve ztrátě se prodává volně; zdanitelný lot
  // se ziskem jen tehdy, když je pozice nad cílem o víc než taxableBandMult × pásmo, a jen o ten přesah.
  // Zbytek nadváhy se srovná nákupy ostatních složek a vklady.
  const heldBack = [];
  const lotsOf = (t) => cl.lots.filter(l => l.ticker === t);
  const take = (t, q) => takeLots(lotsOf(t), q, date, client.taxRegime, S.lotMethod);
  for (const t of cl.tickers) {
    const delta = tgt(t) - before.values[t];
    if (delta >= 0 || cl.held[t] === 0) continue;
    const exit = (client.targets[t] || 0) === 0;
    if (!exit && -delta < minTrade) continue;
    let qty = exit ? cl.held[t] : Math.min(cl.held[t], Math.round(-delta / inst[t].pCZK));
    if (qty <= 0) continue;
    if (S.taxableBandMult > 0 && !exit) {
      let free = 0;
      for (const l of orderLots(lotsOf(t), date, client.taxRegime, S.lotMethod)) { if (l.exempt || l.gps <= 0) free += l.qty; else break; }
      const row = beforeRows.find(r => r.key === t);
      const ceiling = row.target + S.taxableBandMult * row.band; // v % majetku
      const excess = Math.max(0, Math.ceil((before.values[t] - (ceiling / 100) * investable) / inst[t].pCZK));
      const cap = Math.min(qty, Math.max(free, excess));
      if (cap < qty) {
        heldBack.push({ ticker: t, wanted: qty, qty: qty - cap, diff: row.diff, band: row.band, target: row.target, mult: S.taxableBandMult, ceiling, forLiquidity: 0 });
        qty = cap * inst[t].pCZK >= minTrade ? cap : 0;
        heldBack.at(-1).qty = heldBack.at(-1).wanted - qty;
      }
    }
    if (qty > 0) trades.push({ ticker: t, side: 'sell', qty, lots: take(t, qty) });
  }
  const netOf = () => sum(trades, tr => tr.qty * inst[tr.ticker].pCZK - fee(tr.qty * inst[tr.ticker].pCZK, ctx));
  // Výběry mají přednost před daní: když hotovost nepokryje rezervu, prodat i zadržené zdanitelné kusy
  let shortfall = reserve - (before.cashCZK + netOf());
  for (const h of [...heldBack].sort((a, b) => b.diff - a.diff)) {
    if (shortfall <= 0) break;
    const pz = inst[h.ticker].pCZK;
    const add = Math.min(h.qty, Math.ceil(shortfall / (pz * (1 - S.feePct / 100))));
    let tr = trades.find(x => x.ticker === h.ticker && x.side === 'sell');
    if (!tr) { tr = { ticker: h.ticker, side: 'sell', qty: 0, lots: [] }; trades.push(tr); }
    tr.qty += add; tr.lots = take(h.ticker, tr.qty);
    h.qty -= add; h.forLiquidity = add;
    shortfall = reserve - (before.cashCZK + netOf());
  }
  for (const h of heldBack) {
    h.sold = h.wanted - h.qty;
    const ex = take(h.ticker, h.wanted).filter(l => !l.exempt && l.exemptFrom).map(l => l.exemptFrom).sort();
    h.exemptFrom = ex.length ? nextBusinessDay(ex[0]) : null;
  }
  // Nákupy: rozpočet = hotovost po prodejích − rezerva − cílová hotovost
  const buyWish = cl.tickers.map(t => [t, tgt(t) - before.values[t]]).filter(([, d]) => d >= minTrade);
  const sellNet = netOf();
  const budget = before.cashCZK + sellNet - reserve - tgt('CASH');
  const wish = sum(buyWish, ([, d]) => d);
  const scale = wish > 0 ? Math.min(1, Math.max(0, budget) / wish) : 0;
  const k = 1 + S.feePct / 100 + S.fxSpreadPct / 100;
  for (const [t, d] of buyWish) {
    const qty = Math.floor((d * scale) / (inst[t].pCZK * k));
    if (qty > 0 && qty * inst[t].pCZK >= Math.min(minTrade, d)) trades.push({ ticker: t, side: 'buy', qty, lots: [] });
  }

  // Zaúčtování a konverze; při nedostatku hotovosti (minimální poplatky, zaokrouhlení) ubrat kusy z největšího nákupu
  let cash, fx;
  for (let guard = 0; guard < 1000; guard++) {
    cash = { ...cash0 };
    for (const tr of trades) {
      const i = inst[tr.ticker], v = tr.qty * i.pCZK, f = fee(v, ctx);
      tr.price = i.price; tr.currency = i.currency; tr.valueCZK = v; tr.feeCZK = f;
      cash[i.currency] = (cash[i.currency] || 0) + ((tr.side === 'sell' ? v - f : -v - f) / ctx.fx[i.currency]);
    }
    fx = settleFx(cash, reserve, ctx);
    if (fx.deficit <= 0.5) break;
    const buys = trades.filter(tr => tr.side === 'buy' && tr.qty > 0).sort((a, b) => b.valueCZK - a.valueCZK);
    if (!buys.length) break;
    buys[0].qty -= Math.max(1, Math.ceil(fx.deficit / inst[buys[0].ticker].pCZK / 2));
  }
  const finalTrades = trades.filter(tr => tr.qty > 0);

  // Daně: poplatek za prodej je výdaj, rozpočte se na prodávané loty podle počtu kusů
  const pieces = (tr, lots) => lots.map(l => ({ ...l, ticker: tr.ticker, proceedsCZK: l.qty * inst[tr.ticker].pCZK,
    gainCZK: l.gainCZK - fee(tr.qty * inst[tr.ticker].pCZK, ctx) * l.qty / tr.qty }));
  for (const tr of finalTrades) if (tr.side === 'sell') tr.lots = pieces(tr, tr.lots);
  const soldLots = finalTrades.flatMap(tr => tr.lots);
  const tax = taxOf(soldLots, client.taxRegime, S);
  for (const tr of finalTrades) tr.gainCZK = sum(tr.lots, l => l.gainCZK);
  // Ušetřená daň u zadržených lotů = daň plánu s plným prodejem dané pozice − skutečná daň plánu
  for (const h of heldBack) {
    const fullTr = { ticker: h.ticker, qty: h.wanted };
    const others = soldLots.filter(l => l.ticker !== h.ticker);
    h.taxAvoided = Math.max(0, taxOf([...others, ...pieces(fullTr, take(h.ticker, h.wanted))], client.taxRegime, S).amount - tax.amount);
  }

  const heldAfter = { ...cl.held };
  for (const tr of finalTrades) heldAfter[tr.ticker] += tr.side === 'buy' ? tr.qty : -tr.qty;
  const after = valuation(heldAfter, cash, ctx);
  const fees = sum(finalTrades, tr => tr.feeCZK), fxCost = sum(fx.conversions, c => c.costCZK);
  return {
    date, reserve, reserveFlows, investable,
    trades: finalTrades, conversions: fx.conversions, cashAfter: cash, heldAfter,
    heldBack: heldBack.filter(h => h.qty > 0 || h.forLiquidity > 0),
    sold: sum(finalTrades.filter(tr => tr.side === 'sell'), tr => tr.valueCZK),
    tax, costs: { fees, fx: fxCost, tax: tax.amount, total: fees + fxCost + tax.amount },
    turnover: sum(finalTrades, tr => tr.valueCZK),
    before: beforeRows,
    after: weightRows(after, client.targets, cl.tickers, reserve, S),
  };
}

export function taxOf(soldLots, regime, S) {
  if (regime === 'PO') {
    const net = sum(soldLots, l => l.gainCZK);
    return { regime, net, base: Math.max(0, net), amount: Math.max(0, net) * S.taxPO / 100 };
  }
  // Hodnotový test (§ 4 odst. 1 písm. t): úhrn příjmů z prodeje cenných papírů za rok do 100 000 Kč.
  // Zákon z úhrnu nevyjímá prodeje osvobozené časovým testem → konzervativně se počítají všechny.
  // Časový test (písm. u) osvobozuje jednotlivé loty; ztráty se započtou jen proti zdanitelným ziskům.
  const taxable = soldLots.filter(l => !l.exempt);
  const proceedsAll = sum(soldLots, l => l.proceedsCZK);
  const net = sum(taxable, l => l.gainCZK);
  const valueTest = taxable.length > 0 && proceedsAll <= S.valueTestLimit;
  const base = valueTest ? 0 : Math.max(0, net);
  return { regime, net, base, proceedsAll, valueTest, amount: base * S.taxFO / 100 };
}

// Upozornění, která nejsou pravidlem rebalancování, ale manažer je má vidět
function clientWarnings(client, flows, state, ctx) {
  const w = [];
  // Pravidelné výběry (stejná částka aspoň 3×) přepočtené na rok vs. majetek bez jednorázových výběrů
  const outs = flows.filter(f => f.amount < 0);
  const byAmt = {};
  for (const f of outs) byAmt[f.amount] = (byAmt[f.amount] || 0) + 1;
  const recurring = Object.entries(byAmt).filter(([, n]) => n >= 3).map(([a]) => -Number(a));
  if (recurring.length) {
    const yearly = sum(recurring) * 12;
    const oneOff = -sum(outs.filter(f => !recurring.includes(-f.amount)), f => f.amount);
    const rate = (yearly / (state.total - oneOff)) * 100;
    if (rate > ctx.S.withdrawalWarnPct) w.push({ code: 'withdrawalRate', rate, yearly });
  }
  if (outs.length) {
    const total = -sum(outs, f => f.amount);
    if (total > state.total) w.push({ code: 'outflowsExceed', total });
  }
  return w;
}

// Seznam příkazů pro export (CSV apod.)
export function orders(result) {
  const rows = [];
  for (const c of result.clients) {
    if (!c.plan) continue;
    for (const t of c.plan.trades) rows.push({
      client: c.id, date: c.plan.date, status: c.status, side: t.side, ticker: t.ticker, qty: t.qty,
      price: t.price, currency: t.currency, valueCZK: Math.round(t.valueCZK), feeCZK: Math.round(t.feeCZK),
      gainCZK: Math.round(t.gainCZK || 0), lots: t.lots.map(l => `${l.date}:${l.qty}${l.exempt ? '(osv.)' : ''}`).join(' '),
    });
  }
  return rows;
}
