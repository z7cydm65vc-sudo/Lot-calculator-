/*
 * Pure calculation core for the Forex Risk Calculator.
 * No DOM access — shared by the app (window.RiskCalc) and the Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RiskCalc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Contract specs. `quote` is the currency the pip value is natively in.
  const PAIRS = {
    EURUSD: { kind: 'fx', contract: 100000, pip: 0.0001, quote: 'USD', hint: '1 pip = 0.0001 · $10 per pip per lot' },
    GBPUSD: { kind: 'fx', contract: 100000, pip: 0.0001, quote: 'USD', hint: '1 pip = 0.0001 · $10 per pip per lot' },
    AUDUSD: { kind: 'fx', contract: 100000, pip: 0.0001, quote: 'USD', hint: '1 pip = 0.0001 · $10 per pip per lot' },
    NZDUSD: { kind: 'fx', contract: 100000, pip: 0.0001, quote: 'USD', hint: '1 pip = 0.0001 · $10 per pip per lot' },
    USDJPY: { kind: 'fx', contract: 100000, pip: 0.01, quote: 'JPY', hint: '1 pip = 0.01 · ¥1,000 per pip per lot' },
    USDCHF: { kind: 'fx', contract: 100000, pip: 0.0001, quote: 'CHF', hint: '1 pip = 0.0001 · CHF 10 per pip per lot' },
    USDCAD: { kind: 'fx', contract: 100000, pip: 0.0001, quote: 'CAD', hint: '1 pip = 0.0001 · CAD 10 per pip per lot' },
    XAUUSD: { kind: 'fx', contract: 100, pip: 0.1, quote: 'USD', hint: '100 oz per lot · 1 pip = $0.10 move · $10 per pip per lot' },
    NAS100: { kind: 'index', quote: 'USD', hint: 'Stop in POINTS · 1 point = 1.0 index move' },
    US30: { kind: 'index', quote: 'USD', hint: 'Stop in POINTS · 1 point = 1.0 index move' },
  };

  // Rate needed to convert one quote-currency unit into USD (quote per USD).
  const QUOTE_RATE = { JPY: 'USDJPY', CHF: 'USDCHF', CAD: 'USDCAD' };
  const RATE_NAMES = ['GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD'];
  const SYMBOLS = { GBP: '£', USD: '$' };

  const EPS = 1e-9;

  /** Parse user text into a finite number, or null. Accepts "1,5" as 1.5. */
  function parseNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const s = v.trim().replace(',', '.');
    if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const positive = (v) => { const n = parseNum(v); return n !== null && n > 0 ? n : null; };
  const nonNegative = (v) => { const n = parseNum(v); return n !== null && n >= 0 ? n : null; };

  /** Exchange rates the given pair + account currency actually need. */
  function requiredRates(pair, currency) {
    const spec = PAIRS[pair];
    const out = [];
    if (spec && QUOTE_RATE[spec.quote]) out.push(QUOTE_RATE[spec.quote]);
    if (currency === 'GBP') out.push('GBPUSD');
    return out;
  }

  function isIndex(pair) { return !!PAIRS[pair] && PAIRS[pair].kind === 'index'; }

  /** Pip (or point) value for 1 lot in the instrument's quote currency. */
  function pipValueQuote(pair, pointValue) {
    const spec = PAIRS[pair];
    if (!spec) return null;
    if (spec.kind === 'index') return positive(pointValue);
    return spec.contract * spec.pip;
  }

  /**
   * Pip value for 1 lot in the account currency.
   * Returns { value, missing } — missing lists absent/invalid rate names.
   */
  function pipValueAccount(pair, currency, rates, pointValue) {
    const spec = PAIRS[pair];
    const missing = [];
    const q = pipValueQuote(pair, pointValue);
    let usd = q;
    const qr = QUOTE_RATE[spec.quote];
    if (qr) {
      const r = positive(rates && rates[qr]);
      if (r === null) missing.push(qr); else if (usd !== null) usd = usd / r;
    }
    let value = usd;
    if (currency === 'GBP') {
      const r = positive(rates && rates.GBPUSD);
      if (r === null) missing.push('GBPUSD'); else if (value !== null) value = value / r;
    }
    return { value: missing.length || q === null ? null : value, quoteValue: q, missing };
  }

  function stepDecimals(step) {
    const s = String(step);
    if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }

  /**
   * Round lots DOWN to the step, then verify lots × riskPerLot ≤ risk,
   * stepping down again if floating-point error pushes it over.
   */
  function floorLots(exact, step, riskPerLot, risk) {
    const dec = stepDecimals(step);
    let n = Math.floor(exact / step + EPS);
    const toLots = (k) => Number((k * step).toFixed(dec));
    while (n > 0 && toLots(n) * riskPerLot > risk + EPS) n -= 1;
    return n > 0 ? toLots(n) : 0;
  }

  /** Resolve the risk amount from fixed or % mode. */
  function resolveRisk(input) {
    if (input.riskMode === 'pct') {
      const bal = positive(input.balance);
      const pct = positive(input.riskPct);
      return { risk: bal !== null && pct !== null ? bal * pct / 100 : null, balance: bal, pct, missing: [bal === null && 'balance', pct === null && 'risk %'].filter(Boolean) };
    }
    const r = positive(input.riskAmount);
    return { risk: r, balance: null, pct: null, missing: r === null ? ['risk amount'] : [] };
  }

  function joinList(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  /** Shared per-lot cost model. Returns { ok:false, missing } or the cost figures. */
  function costModel(input) {
    const missing = [];
    const pair = input.pair;
    const index = isIndex(pair);
    const stop = positive(input.stop);
    if (stop === null) missing.push(index ? 'your stop loss (points)' : 'your stop loss');

    const slippageOn = !!input.slippageOn;
    let slip = 0;
    if (slippageOn) {
      slip = positive(input.slippage);
      if (slip === null) missing.push('the slippage amount');
    }
    const commission = nonNegative(input.commission === '' || input.commission == null ? '0' : input.commission);
    if (commission === null) missing.push('a valid commission');
    const lotStep = positive(input.lotStep);
    if (lotStep === null) missing.push('a valid lot step');

    const pointValue = index && input.pointValues ? input.pointValues[pair] : undefined;
    const pv = pipValueAccount(pair, input.currency, input.rates, pointValue);
    if (index && pv.quoteValue === null) missing.push('the ' + pair + ' point value');
    pv.missing.forEach((r) => missing.push('the ' + r + ' rate'));

    const rr = resolveRisk(input);
    rr.missing.forEach((m) => missing.push('your ' + m));

    if (missing.length) {
      return { ok: false, missing, message: 'Enter ' + joinList(missing), risk: rr.risk };
    }
    const adjStop = stop + (slippageOn ? slip : 0);
    const riskPerLot = adjStop * pv.value + commission;
    return {
      ok: true, stop, slippage: slippageOn ? slip : 0, adjStop, commission, lotStep,
      pipValue: pv.value, pipValueQuote: pv.quoteValue, riskPerLot,
      risk: rr.risk, balance: rr.balance, riskPct: rr.pct,
    };
  }

  function lossFor(m, lots) {
    const priceLoss = lots * m.adjStop * m.pipValue;
    const commissionTotal = lots * m.commission;
    return { priceLoss, commissionTotal, totalLoss: priceLoss + commissionTotal };
  }

  /** Main calculation: recommended lot size for the given inputs. */
  function calculate(input) {
    const m = costModel(input);
    if (!m.ok) return m;
    const exactLots = m.risk / m.riskPerLot;
    const lots = floorLots(exactLots, m.lotStep, m.riskPerLot, m.risk);
    const loss = lossFor(m, lots);
    return Object.assign(m, loss, {
      exactLots, lots,
      tooSmall: lots === 0,
      unused: m.risk - loss.totalLoss,
      usedPct: m.risk > 0 ? (loss.totalLoss / m.risk) * 100 : 0,
      balancePct: m.balance ? (loss.totalLoss / m.balance) * 100 : null,
    });
  }

  /** Check an arbitrary lot size against the risk. */
  function checkLots(input, lotsText) {
    const lots = positive(lotsText);
    const m = costModel(input);
    if (!m.ok) return m;
    if (lots === null) return { ok: false, missing: ['a lot size'], message: 'Enter a lot size to check' };
    const loss = lossFor(m, lots);
    const pctOfRisk = (loss.totalLoss / m.risk) * 100;
    let status = 'green';
    if (loss.totalLoss > m.risk * 1.1 + EPS) status = 'red';
    else if (loss.totalLoss > m.risk + EPS) status = 'amber';
    return Object.assign({ ok: true, lots, risk: m.risk }, loss, {
      pctOfRisk,
      pctOfBalance: m.balance ? (loss.totalLoss / m.balance) * 100 : null,
      status,
    });
  }

  return {
    PAIRS, RATE_NAMES, SYMBOLS, parseNum, requiredRates, isIndex,
    pipValueQuote, pipValueAccount, floorLots, stepDecimals, calculate, checkLots, joinList,
  };
});
