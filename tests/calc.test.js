'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calc.js');

const RATES = { GBPUSD: '1.34', USDJPY: '148', USDCHF: '0.80', USDCAD: '1.38' };

function base(overrides) {
  return Object.assign({
    pair: 'EURUSD', currency: 'USD', stop: '20',
    riskMode: 'fixed', riskAmount: '100', balance: '', riskPct: '',
    commission: '7', lotStep: '0.01', slippageOn: false, slippage: '0.2',
    rates: RATES, pointValues: { NAS100: '1', US30: '1' },
  }, overrides);
}

function assertWithinRisk(r) {
  assert.ok(r.ok, r.message);
  assert.ok(r.totalLoss <= r.risk + 1e-9, `loss ${r.totalLoss} exceeds risk ${r.risk}`);
  // One more lot step would exceed the risk — i.e. we rounded down, not further.
  const next = (r.lots + r.lotStep) * r.riskPerLot;
  assert.ok(next > r.risk - 1e-9, `one more step (${next}) still fits in ${r.risk}`);
}

test('USD account, 1% of $100,000, $5 commission, 0.2 slippage, EURUSD', async (t) => {
  const cases = [[3.0, 27.02], [3.1, 26.31], [3.7, 22.72], [5.3, 16.66], [7.0, 12.98]];
  for (const [sl, expected] of cases) {
    await t.test(`SL ${sl} → ${expected}`, () => {
      const r = C.calculate(base({
        stop: String(sl), riskMode: 'pct', balance: '100000', riskPct: '1',
        commission: '5', slippageOn: true, slippage: '0.2',
      }));
      assert.equal(r.lots, expected);
      assert.equal(r.balancePct <= 1 + 1e-9, true);
      assertWithinRisk(r);
    });
  }
});

test('Risk 100, 20-pip stop, $7 commission, no slippage', async (t) => {
  const cases = [
    ['EURUSD', 'USD', 0.48], ['EURUSD', 'GBP', 0.63],
    ['USDJPY', 'USD', 0.70], ['USDJPY', 'GBP', 0.92],
    ['USDCHF', 'USD', 0.38], ['USDCHF', 'GBP', 0.51],
    ['USDCAD', 'USD', 0.65], ['USDCAD', 'GBP', 0.86],
  ];
  for (const [pair, currency, expected] of cases) {
    await t.test(`${pair} ${currency} account → ${expected}`, () => {
      const r = C.calculate(base({ pair, currency }));
      assert.equal(r.lots, expected);
      assertWithinRisk(r);
    });
  }
});

test('NAS100 $1/point, 50-point stop, no commission', async (t) => {
  for (const [currency, expected] of [['USD', 2.0], ['GBP', 2.68]]) {
    await t.test(`${currency} account → ${expected}`, () => {
      const r = C.calculate(base({ pair: 'NAS100', currency, stop: '50', commission: '0' }));
      assert.equal(r.lots, expected);
      assertWithinRisk(r);
    });
  }
});

test('switching account currency changes the lot size, not just the symbol', () => {
  const usd = C.calculate(base({ currency: 'USD' }));
  const gbp = C.calculate(base({ currency: 'GBP' }));
  assert.notEqual(usd.lots, gbp.lots);
  assert.ok(Math.abs(gbp.pipValue - 10 / 1.34) < 1e-9);
});

test('pip values in quote currency match contract specs', () => {
  assert.equal(C.pipValueQuote('EURUSD'), 10);
  assert.equal(C.pipValueQuote('USDJPY'), 1000);
  assert.equal(C.pipValueQuote('USDCHF'), 10);
  assert.equal(C.pipValueQuote('USDCAD'), 10);
  assert.ok(Math.abs(C.pipValueQuote('XAUUSD') - 10) < 1e-9);
  assert.equal(C.pipValueQuote('US30', '10'), 10);
});

test('only the rates the pair and account need are required', () => {
  assert.deepEqual(C.requiredRates('EURUSD', 'USD'), []);
  assert.deepEqual(C.requiredRates('EURUSD', 'GBP'), ['GBPUSD']);
  assert.deepEqual(C.requiredRates('USDJPY', 'GBP'), ['USDJPY', 'GBPUSD']);
  assert.deepEqual(C.requiredRates('NAS100', 'USD'), []);
});

test('missing inputs are named exactly', () => {
  const r = C.calculate(base({ currency: 'GBP', stop: '', rates: {} }));
  assert.equal(r.ok, false);
  assert.equal(r.message, 'Enter your stop loss and the GBPUSD rate');
});

test('invalid input (negative, zero, text) is rejected', () => {
  for (const stop of ['-5', '0', 'abc', '1e3']) {
    assert.equal(C.calculate(base({ stop })).ok, false, `stop ${stop}`);
  }
  assert.equal(C.calculate(base({ commission: '-1' })).ok, false);
  assert.equal(C.calculate(base({ lotStep: '0' })).ok, false);
});

test('one lot step exceeding the risk gives 0 lots', () => {
  const r = C.calculate(base({ riskAmount: '1', stop: '50' }));
  assert.equal(r.lots, 0);
  assert.equal(r.tooSmall, true);
  assert.equal(r.totalLoss, 0);
});

test('rounding never goes up, across many random inputs', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pairs = Object.keys(C.PAIRS);
  for (let i = 0; i < 5000; i++) {
    const r = C.calculate(base({
      pair: pairs[Math.floor(rnd() * pairs.length)],
      currency: rnd() < 0.5 ? 'USD' : 'GBP',
      stop: (rnd() * 100 + 0.1).toFixed(1),
      riskAmount: (rnd() * 5000 + 10).toFixed(2),
      commission: (rnd() * 10).toFixed(2),
      slippageOn: rnd() < 0.5,
      lotStep: ['0.01', '0.1', '0.001', '1'][Math.floor(rnd() * 4)],
    }));
    assert.ok(r.ok);
    assert.ok(r.totalLoss <= r.risk + 1e-9, JSON.stringify(r));
    assert.ok(r.lots <= r.exactLots + 1e-9);
  }
});

test('floorLots steps down when float error would push over risk', () => {
  // exact = 2 exactly: must keep 2.00, not drop to 1.99
  assert.equal(C.floorLots(2, 0.01, 50, 100), 2);
  // slightly over due to float: steps down
  assert.equal(C.floorLots(2, 0.01, 50.0000001, 100), 1.99);
});

test('check a lot size: green / amber / red', () => {
  const inp = base({ pair: 'EURUSD', currency: 'USD', commission: '0' }); // $200 per lot, risk 100
  assert.equal(C.checkLots(inp, '0.5').status, 'green');   // 100 = risk
  assert.equal(C.checkLots(inp, '0.54').status, 'amber');  // 108 → 8% over
  assert.equal(C.checkLots(inp, '0.56').status, 'red');    // 112 → 12% over
  const pct = C.checkLots(base({ riskMode: 'pct', balance: '10000', riskPct: '1', commission: '0' }), '0.5');
  assert.ok(Math.abs(pct.pctOfRisk - 100) < 1e-9);
  assert.ok(Math.abs(pct.pctOfBalance - 1) < 1e-9);
});
