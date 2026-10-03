/* Forex Risk Calculator — UI layer. All maths lives in calc.js (RiskCalc). */
(function () {
  'use strict';
  const C = window.RiskCalc;
  const $ = (id) => document.getElementById(id);

  const STORE_KEY = 'frc.state.v1';
  const RATES_KEY = 'frc.rates.v1';
  const OVERRIDES_KEY = 'frc.overrides.v1';
  const RATE_MAX_AGE_MS = 30 * 60 * 1000;
  const RATE_DECIMALS = { GBPUSD: 5, USDJPY: 3, USDCHF: 5, USDCAD: 5 };
  const BAL_QUICK = [10000, 25000, 50000, 100000, 200000];
  const PCT_QUICK = ['0.25', '0.5', '0.75', '1'];

  // ---------- storage ----------
  function load(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function defaultAccount(name) {
    return {
      id: uid(), name: name || 'My account', currency: 'USD', pair: 'EURUSD',
      riskMode: 'fixed', riskAmount: '100', balance: '100000', riskPct: '1',
      commission: '0', lotStep: '0.01', slippageOn: true, slippage: '0.2',
      pointValues: { NAS100: '1', US30: '1' },
    };
  }

  let state = load(STORE_KEY, null);
  if (!state || !Array.isArray(state.accounts) || !state.accounts.length) {
    state = { accounts: [defaultAccount()], currentId: null, theme: 'dark' };
  }
  state.accounts = state.accounts.map((a) => Object.assign(defaultAccount(), a, {
    pointValues: Object.assign({ NAS100: '1', US30: '1' }, a.pointValues),
  }));
  if (!state.accounts.some((a) => a.id === state.currentId)) state.currentId = state.accounts[0].id;

  let rates = load(RATES_KEY, { live: {}, updated: null, source: null });
  let overrides = load(OVERRIDES_KEY, {});
  const session = { stop: '', checkLots: '' }; // not persisted on purpose

  const acc = () => state.accounts.find((a) => a.id === state.currentId);
  const persist = () => save(STORE_KEY, state);
  const sym = () => C.SYMBOLS[acc().currency];

  // ---------- formatting ----------
  function money(n, s) {
    const v = Number.isFinite(n) ? n : 0;
    const sign = v < 0 ? '−' : '';
    return sign + (s || sym()) + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function shortMoney(n) { return sym() + (n >= 1000 ? (n / 1000) + 'K' : n); }
  function fmtLots(lots, step) {
    const d = Math.max(2, C.stepDecimals(C.parseNum(step) || 0.01));
    return lots.toFixed(d);
  }
  function fmtNum(n, d) { return Number(n).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function fmtRate(name, v) { return Number(v).toFixed(RATE_DECIMALS[name] || 5); }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 1400);
  }

  // ---------- rates ----------
  function effectiveRates() {
    const out = {};
    C.RATE_NAMES.forEach((n) => {
      const o = C.parseNum(overrides[n] == null ? '' : String(overrides[n]));
      out[n] = o !== null && o > 0 ? o : (rates.live[n] || null);
    });
    return out;
  }
  const isOverridden = (n) => overrides[n] != null && overrides[n] !== '';

  async function fetchJSON(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }
  function fromUsdTable(t) {
    if (!t || !(t.GBP > 0 && t.JPY > 0 && t.CHF > 0 && t.CAD > 0)) throw new Error('bad payload');
    return { GBPUSD: 1 / t.GBP, USDJPY: t.JPY, USDCHF: t.CHF, USDCAD: t.CAD };
  }
  async function refreshRates(force) {
    if (!force && rates.updated && Date.now() - new Date(rates.updated).getTime() < RATE_MAX_AGE_MS) return;
    if (!navigator.onLine) return;
    const sources = [
      ['frankfurter.app', 'https://api.frankfurter.app/latest?from=USD&to=GBP,JPY,CHF,CAD', (j) => fromUsdTable(j.rates)],
      ['open.er-api.com', 'https://open.er-api.com/v6/latest/USD', (j) => fromUsdTable(j.rates)],
    ];
    for (const [name, url, parse] of sources) {
      try {
        const live = parse(await fetchJSON(url));
        rates = { live, updated: new Date().toISOString(), source: name };
        save(RATES_KEY, rates);
        renderRates(false);
        recalc();
        return;
      } catch (e) { /* try next source */ }
    }
  }

  function rateMetaText(n) {
    if (isOverridden(n)) return { text: 'Manual rate', manual: true };
    if (rates.live[n]) return { text: 'Live · updated ' + fmtTime(rates.updated) + (rates.source ? ' · ' + rates.source : '') + (navigator.onLine ? '' : ' · offline'), manual: false };
    return { text: navigator.onLine ? 'Fetching live rate… or type it' : 'Offline — type the rate', manual: false };
  }

  function renderRates(rebuild) {
    const box = $('rates');
    const need = C.requiredRates(acc().pair, acc().currency);
    const eff = effectiveRates();
    if (rebuild !== false || box.dataset.need !== need.join(',')) {
      box.dataset.need = need.join(',');
      box.innerHTML = '';
      need.forEach((n) => {
        const row = document.createElement('div');
        row.className = 'rate';
        row.innerHTML =
          '<label class="rate-name" for="rate-' + n + '">' + n + '</label>' +
          '<input id="rate-' + n + '" class="input" type="text" inputmode="decimal" autocomplete="off">' +
          '<button type="button" class="linkbtn" data-live="' + n + '">Use live</button>' +
          '<div class="rate-meta" id="rate-meta-' + n + '"></div>';
        box.appendChild(row);
        const inp = row.querySelector('input');
        inp.addEventListener('input', () => {
          if (inp.value.trim() === '') delete overrides[n]; else overrides[n] = inp.value.trim();
          save(OVERRIDES_KEY, overrides);
          markValidity(inp, 'positive');
          updateRateMeta(n);
          recalc();
        });
        inp.addEventListener('blur', () => { if (inp.value.trim() === '') renderRates(false); });
        row.querySelector('[data-live]').addEventListener('click', () => {
          delete overrides[n]; save(OVERRIDES_KEY, overrides);
          inp.value = rates.live[n] ? fmtRate(n, rates.live[n]) : '';
          inp.classList.remove('invalid');
          updateRateMeta(n); recalc();
        });
      });
    }
    need.forEach((n) => {
      const inp = $('rate-' + n);
      if (document.activeElement !== inp) {
        inp.value = isOverridden(n) ? overrides[n] : (eff[n] ? fmtRate(n, eff[n]) : '');
        markValidity(inp, 'positive');
      }
      updateRateMeta(n);
    });
  }
  function updateRateMeta(n) {
    const el = $('rate-meta-' + n);
    if (!el) return;
    const m = rateMetaText(n);
    el.textContent = m.text;
    el.classList.toggle('manual', m.manual);
    const btn = el.parentNode.querySelector('[data-live]');
    btn.hidden = !(isOverridden(n) && rates.live[n]);
  }

  // ---------- validation ----------
  function markValidity(inp, rule) {
    const v = inp.value.trim();
    let ok = true;
    if (v !== '') {
      const n = C.parseNum(v);
      ok = n !== null && (rule === 'nonneg' ? n >= 0 : n > 0);
    }
    inp.classList.toggle('invalid', !ok);
  }
  const FIELD_RULE = { commission: 'nonneg' };

  // ---------- form <-> account ----------
  function renderAccounts() {
    const sel = $('account');
    sel.innerHTML = '';
    state.accounts.forEach((a) => {
      const o = document.createElement('option');
      o.value = a.id; o.textContent = a.name + ' (' + a.currency + ')';
      sel.appendChild(o);
    });
    sel.value = state.currentId;
  }

  function renderPairOptions() {
    const sel = $('pair');
    Object.keys(C.PAIRS).forEach((p) => {
      const o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o);
    });
  }

  function setSeg(attr, value) {
    document.querySelectorAll('[data-' + attr + ']').forEach((b) => {
      const on = b.dataset[attr] === value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });
  }

  function renderChips() {
    const a = acc();
    const bal = $('bal-quick'); bal.innerHTML = '';
    BAL_QUICK.forEach((v) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = shortMoney(v);
      b.classList.toggle('on', C.parseNum(a.balance) === v);
      b.addEventListener('click', () => { a.balance = String(v); $('balance').value = a.balance; $('balance').classList.remove('invalid'); afterChange(); renderChips(); });
      bal.appendChild(b);
    });
    const pct = $('pct-quick'); pct.innerHTML = '';
    PCT_QUICK.forEach((v) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = v + '%';
      b.classList.toggle('on', C.parseNum(a.riskPct) === Number(v));
      b.addEventListener('click', () => { a.riskPct = v; $('riskPct').value = v; $('riskPct').classList.remove('invalid'); afterChange(); renderChips(); });
      pct.appendChild(b);
    });
  }

  function renderPairInfo() {
    const a = acc();
    $('pair').value = a.pair;
    $('pair-hint').textContent = C.PAIRS[a.pair].hint +
      (C.isIndex(a.pair) ? ' · $' + (a.pointValues[a.pair] || '?') + ' per point per lot (set in Settings)' : '');
    $('stop-label').textContent = C.isIndex(a.pair) ? 'Stop loss (points)' : 'Stop loss (pips)';
  }

  function loadForm() {
    const a = acc();
    renderAccounts();
    setSeg('currency', a.currency);
    setSeg('riskmode', a.riskMode);
    $('risk-fixed').hidden = a.riskMode !== 'fixed';
    $('risk-pct').hidden = a.riskMode !== 'pct';
    document.querySelectorAll('.sym').forEach((s) => { s.textContent = sym(); });
    document.querySelectorAll('[data-field]').forEach((inp) => {
      inp.value = a[inp.dataset.field] == null ? '' : a[inp.dataset.field];
      markValidity(inp, FIELD_RULE[inp.dataset.field]);
    });
    document.querySelectorAll('[data-point]').forEach((inp) => {
      inp.value = a.pointValues[inp.dataset.point] || '';
      markValidity(inp, 'positive');
    });
    $('slippageOn').checked = !!a.slippageOn;
    $('slippage').disabled = !a.slippageOn;
    $('stop').value = session.stop;
    $('checkLots').value = session.checkLots;
    renderPairInfo();
    renderChips();
    renderRates(true);
    recalc();
  }

  function afterChange() { persist(); recalc(); }

  // ---------- calculation output ----------
  function calcInput() {
    const a = acc();
    return {
      pair: a.pair, currency: a.currency, stop: session.stop,
      riskMode: a.riskMode, riskAmount: a.riskAmount, balance: a.balance, riskPct: a.riskPct,
      commission: a.commission, lotStep: a.lotStep, slippageOn: a.slippageOn, slippage: a.slippage,
      rates: effectiveRates(), pointValues: a.pointValues,
    };
  }

  function row(dt, dd) { return '<dt>' + dt + '</dt><dd>' + dd + '</dd>'; }

  let lastLotsText = '';
  function recalc() {
    const a = acc();
    const inp = calcInput();
    const r = C.calculate(inp);
    const unit = C.isIndex(a.pair) ? 'points' : 'pips';

    // "= £X at risk" line in % mode
    if (a.riskMode === 'pct') {
      const b = C.parseNum(a.balance), p = C.parseNum(a.riskPct);
      $('pct-eq').textContent = b > 0 && p > 0 ? '= ' + money(b * p / 100) + ' at risk' : '';
    }

    const msg = $('res-msg');
    if (!r.ok) {
      msg.textContent = r.message;
      msg.className = 'res-msg';
      msg.hidden = false;
      $('res-main').hidden = true;
      lastLotsText = '';
    } else {
      msg.hidden = true;
      $('res-main').hidden = false;
      lastLotsText = fmtLots(r.lots, a.lotStep);
      const lotsEl = $('res-lots');
      lotsEl.textContent = lastLotsText;
      lotsEl.classList.toggle('zero', r.tooSmall);
      $('res-loss').innerHTML = 'Loss at stop <b>' + money(r.totalLoss) + '</b> of ' + money(r.risk) + ' risk';
      const used = Math.max(0, Math.min(100, r.usedPct));
      $('res-bar').style.width = used + '%';

      const warn = $('res-warn');
      if (r.tooSmall) {
        const one = r.lotStep * r.riskPerLot;
        warn.textContent = 'Even ' + fmtLots(r.lotStep, a.lotStep) + ' lots would lose ' + money(one) +
          ', which is more than your ' + money(r.risk) + ' risk. Use a tighter stop or a bigger risk.';
        warn.hidden = false;
      } else warn.hidden = true;

      const need = C.requiredRates(a.pair, a.currency);
      const ratesUsed = need.length ? need.map((n) => n + ' ' + fmtRate(n, inp.rates[n]) + (isOverridden(n) ? ' (manual)' : '')).join('<br>') : 'None needed';
      const pvLabel = (C.isIndex(a.pair) ? 'Point' : 'Pip') + ' value per lot';
      let html = '';
      html += row('Exact lots', fmtNum(r.exactLots, 4));
      html += row(pvLabel, money(r.pipValue));
      html += row('Rate(s) used', ratesUsed);
      html += row('Stop used', r.slippage ? fmtNum(r.stop, 1) + ' + ' + fmtNum(r.slippage, 1) + ' slip = ' + fmtNum(r.adjStop, 1) + ' ' + unit : fmtNum(r.adjStop, 1) + ' ' + unit);
      html += row('Price loss', money(r.priceLoss));
      html += row('Commission', money(r.commissionTotal));
      html += row('Total loss', money(r.totalLoss));
      html += row('Unused risk', money(r.unused));
      if (a.riskMode === 'pct' && r.balancePct != null) html += row('Actual % of balance', fmtNum(r.balancePct, 3) + '%');
      $('res-break').innerHTML = html;
    }
    renderCheck(inp);
  }

  function renderCheck(inp) {
    const out = $('check-out');
    out.className = 'check-out';
    if (session.checkLots.trim() === '') { out.textContent = 'Enter a lot size to see the loss at your stop.'; return; }
    const c = C.checkLots(inp, session.checkLots);
    if (!c.ok) { out.textContent = c.message; return; }
    out.classList.add(c.status);
    const label = c.status === 'green' ? 'Within risk' : c.status === 'amber' ? 'Over risk (up to 10%)' : 'More than 10% over risk';
    out.innerHTML =
      '<div class="big">' + money(c.totalLoss) + ' loss at stop</div>' +
      '<div>' + label + ' · ' + fmtNum(c.pctOfRisk, 1) + '% of your ' + money(c.risk) + ' risk' +
      (c.pctOfBalance != null ? ' · ' + fmtNum(c.pctOfBalance, 2) + '% of balance' : '') + '</div>' +
      '<div class="hint">Price ' + money(c.priceLoss) + ' + commission ' + money(c.commissionTotal) + '</div>';
  }

  // ---------- events ----------
  function bind() {
    $('account').addEventListener('change', (e) => { state.currentId = e.target.value; persist(); loadForm(); });

    $('acc-new').addEventListener('click', () => {
      const cur = acc();
      const name = (prompt('Name for the new account', cur.name + ' copy') || '').trim();
      if (!name) return;
      const copy = JSON.parse(JSON.stringify(cur));
      copy.id = uid(); copy.name = name;
      state.accounts.push(copy); state.currentId = copy.id;
      persist(); loadForm(); toast('Account created');
    });
    $('acc-rename').addEventListener('click', () => {
      const a = acc();
      const name = (prompt('Rename account', a.name) || '').trim();
      if (!name) return;
      a.name = name; persist(); renderAccounts();
    });
    $('acc-delete').addEventListener('click', () => {
      const a = acc();
      if (!confirm('Delete "' + a.name + '"? This cannot be undone.')) return;
      state.accounts = state.accounts.filter((x) => x.id !== a.id);
      if (!state.accounts.length) state.accounts.push(defaultAccount());
      state.currentId = state.accounts[0].id;
      persist(); loadForm(); toast('Account deleted');
    });

    document.querySelectorAll('[data-currency]').forEach((b) => b.addEventListener('click', () => {
      const a = acc();
      if (a.currency === b.dataset.currency) return;
      a.currency = b.dataset.currency;
      persist(); loadForm();
    }));
    document.querySelectorAll('[data-riskmode]').forEach((b) => b.addEventListener('click', () => {
      acc().riskMode = b.dataset.riskmode; persist(); loadForm();
    }));

    $('pair').addEventListener('change', (e) => {
      acc().pair = e.target.value;
      session.stop = ''; $('stop').value = '';
      $('stop').classList.remove('invalid');
      persist(); renderPairInfo(); renderRates(true); recalc();
      $('stop').focus();
    });

    $('stop').addEventListener('input', (e) => { session.stop = e.target.value; markValidity(e.target); recalc(); });
    $('checkLots').addEventListener('input', (e) => { session.checkLots = e.target.value; markValidity(e.target); recalc(); });

    document.querySelectorAll('[data-field]').forEach((inp) => inp.addEventListener('input', () => {
      acc()[inp.dataset.field] = inp.value;
      markValidity(inp, FIELD_RULE[inp.dataset.field]);
      if (inp.id === 'balance' || inp.id === 'riskPct') renderChips();
      afterChange();
    }));
    document.querySelectorAll('[data-point]').forEach((inp) => inp.addEventListener('input', () => {
      acc().pointValues[inp.dataset.point] = inp.value;
      markValidity(inp, 'positive');
      renderPairInfo(); afterChange();
    }));
    $('slippageOn').addEventListener('change', (e) => {
      acc().slippageOn = e.target.checked; $('slippage').disabled = !e.target.checked; afterChange();
    });

    $('copy').addEventListener('click', async () => {
      if (!lastLotsText) return;
      try { await navigator.clipboard.writeText(lastLotsText); }
      catch (e) {
        const t = document.createElement('textarea'); t.value = lastLotsText; document.body.appendChild(t);
        t.select(); try { document.execCommand('copy'); } catch (_) {} t.remove();
      }
      toast('Copied ' + lastLotsText);
    });

    $('theme').addEventListener('click', () => {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      applyTheme(); persist();
    });

    window.addEventListener('online', () => { refreshRates(true); renderRates(false); });
    window.addEventListener('offline', () => renderRates(false));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRates(false); });
    // Keep settings collapsed/open state per device
    const det = $('settings');
    try { det.open = localStorage.getItem('frc.settingsOpen') === '1'; } catch (e) {}
    det.addEventListener('toggle', () => { try { localStorage.setItem('frc.settingsOpen', det.open ? '1' : '0'); } catch (e) {} });
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme === 'light' ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]').content = state.theme === 'light' ? '#f2f4f8' : '#0b0f17';
  }

  // ---------- boot ----------
  renderPairOptions();
  applyTheme();
  bind();
  loadForm();
  refreshRates(false);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
