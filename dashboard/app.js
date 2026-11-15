// Launch Radar's page. It reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked board, its filters, a per-protocol detail drawer with the model's factors and the
// protocol's farm plan, and the live-token set the model calibrated on. No network: every byte
// it shows arrived in data.js.
//
// The model the page states, and main.ts runs:
//   implied = TVL x category multiple x momentum x maturity x breadth
// The category multiple is not a constant: it is the median market-cap/TVL of the snapshot's own
// trading protocols in that category, shrunk toward the global median. Momentum reads the 7-day
// TVL change through a tanh, maturity reads the protocol's age, breadth its chain count.
(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;
  var app = document.getElementById('app');
  app.removeAttribute('aria-busy');

  var params = new URLSearchParams(location.search);
  var state = {
    q: params.get('q') || '',
    category: params.get('category') || 'all',
    chain: params.get('chain') || 'all',
    seg: params.get('seg') || 'all',
    sort: params.get('sort') || 'implied',
    dir: params.get('dir') === 'asc' ? 1 : -1,
    detail: params.get('detail') || null,
  };

  var usdFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFull.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.round(days) + 'd';
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  var bySlug = {};
  D.rows.forEach(function (r) { bySlug[r.slug] = r; });
  var categories = [];
  var chainsSeen = {};
  D.rows.forEach(function (r) {
    if (r.category && categories.indexOf(r.category) < 0) categories.push(r.category);
    r.chains.forEach(function (c) { chainsSeen[c] = true; });
  });
  categories.sort();
  var chainNames = Object.keys(chainsSeen).sort();

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return D.rows.filter(function (r) {
      if (state.seg === 'watchlist' && !r.watchlist) return false;
      if (state.seg === 'early' && r.watchlist) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
  }
  var SORTS = {
    implied: function (r) { return r.implied_value_usd; },
    tvl: function (r) { return r.tvl_usd; },
    change: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
    age: function (r) { return r.age_days === null ? -1 : r.age_days; },
    name: function (r) { return r.name.toLowerCase(); },
    rank: function (r) { return r.rank; },
  };
  function sortedRows(rows) {
    var key = SORTS[state.sort] || SORTS.implied;
    return rows.slice().sort(function (a, b) {
      var ka = key(a), kb = key(b);
      if (ka < kb) return -1 * state.dir;
      if (ka > kb) return 1 * state.dir;
      return a.rank - b.rank;
    });
  }

  /* ------------------------------------------------ masthead + model strip */
  function stat(value, label) {
    return el('div', { class: 'stat' }, el('b', { text: value }), el('span', { text: label }));
  }
  function masthead() {
    return el('header', { class: 'masthead' },
      el('div', null,
        el('h1', null, 'Launch Radar', el('span', { class: 'dot', text: ' .' })),
        el('p', { class: 'tagline', text: 'Protocols that record no token yet, ranked by what a launch would be worth if their record stayed as it is - and what to do to farm each one. Implied values are this board\u2019s own claim, from the snapshot\u2019s figures alone.' })
      ),
      el('div', { class: 'stats' },
        stat(String(D.board_size), 'ranked'),
        stat(String(D.watchlist_size) + '/' + String(D.watchlist_size), 'watchlist covered'),
        stat(String(D.early_size), 'early finds'),
        stat(D.as_of, 'snapshot date')
      )
    );
  }
  function modelStrip() {
    var cal = D.calibration;
    var rows = cal.categories.map(function (c) {
      return el('tr', null,
        el('td', { text: c.category === '' ? '(none named)' : c.category }),
        el('td', { text: String(c.samples) }),
        el('td', { text: c.multiple.toFixed(2) + 'x' }));
    });
    var table = el('table', { class: 'cal-table' },
      el('tr', null, el('th', { text: 'Category' }), el('th', { text: 'Trading protocols' }), el('th', { text: 'Multiple' })),
      rows);
    return el('section', { class: 'model-strip' },
      el('div', null,
        el('b', { text: 'The model. ' }),
        document.createTextNode('Each category\u2019s price per TVL dollar is read off the snapshot\u2019s own trading protocols (median market cap / TVL, shrunk toward the global median of '),
        el('b', { text: cal.global_multiple.toFixed(2) + 'x' }),
        document.createTextNode(' from ' + cal.trading_protocols + ' trading protocols), then adjusted per protocol: ')),
      el('div', { class: 'formula', text: 'implied = TVL x category multiple x momentum (7d change) x maturity (age) x breadth (chains)' }),
      el('details', null,
        el('summary', { text: 'The calibration table - every category multiple the board uses' }),
        table,
        el('p', { text: 'Momentum = 1 + 0.45 x tanh(clamped 7d change / 40). Maturity = 0.70 + 0.30 x age / 5 years, capped; an unreported listing date counts as the snapshot\u2019s median age of ' + cal.reference_age_days + ' days. Breadth = 1 + 0.025 per extra chain, capped at 8. Model version ' + D.model_version + '.' })
      )
    );
  }

  /* ------------------------------------------------ controls */
  function controls(count) {
    var search = el('input', { type: 'search', placeholder: 'Search name or slug', value: state.q });
    search.addEventListener('input', function () { state.q = search.value; render(); });
    var catSel = el('select', { 'aria-label': 'Category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c }); }));
    catSel.value = state.category;
    catSel.addEventListener('change', function () { state.category = catSel.value; render(); });
    var chainSel = el('select', { 'aria-label': 'Chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chainNames.map(function (c) { return el('option', { value: c, text: c }); }));
    chainSel.value = state.chain;
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; render(); });
    var sortSel = el('select', { 'aria-label': 'Sort' },
      el('option', { value: 'implied', text: 'Sort: implied value' }),
      el('option', { value: 'tvl', text: 'Sort: TVL' }),
      el('option', { value: 'change', text: 'Sort: 7d change' }),
      el('option', { value: 'age', text: 'Sort: age' }),
      el('option', { value: 'name', text: 'Sort: name' }));
    sortSel.value = state.sort;
    sortSel.addEventListener('change', function () { state.sort = sortSel.value; render(); });
    function segBtn(id, label) {
      var b = el('button', { text: label, class: state.seg === id ? 'on' : '' });
      b.addEventListener('click', function () { state.seg = id; render(); });
      return b;
    }
    return el('div', { class: 'controls' },
      search, catSel, chainSel,
      el('span', { class: 'seg' }, segBtn('all', 'Whole board'), segBtn('watchlist', 'Watchlist'), segBtn('early', 'Early finds')),
      sortSel,
      el('span', { class: 'count', text: count + ' shown' }));
  }

  /* ------------------------------------------------ board */
  var HEADERS = [
    ['rank', '#', ''],
    ['name', 'Protocol', ''],
    ['category', 'Category', ''],
    ['chains', 'Chains', ''],
    ['tvl', 'TVL', 'num'],
    ['change', '7d', 'num'],
    ['age', 'Age', 'num'],
    ['implied', 'Implied value', 'num'],
  ];
  function boardTable(rows) {
    var maxVal = rows.reduce(function (m, r) { return Math.max(m, r.implied_value_usd); }, 0);
    var head = el('tr', null, HEADERS.map(function (h) {
      var th = el('th', { class: h[2] + (state.sort === h[0] ? ' sorted' : ''), text: h[1] + (state.sort === h[0] ? (state.dir === -1 ? ' \u25bc' : ' \u25b2') : '') });
      th.addEventListener('click', function () {
        if (state.sort === h[0]) state.dir = -state.dir;
        else { state.sort = h[0]; state.dir = h[0] === 'name' ? 1 : -1; }
        render();
      });
      return th;
    }));
    var body = rows.map(function (r) {
      var tr = el('tr', null,
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', null,
          el('span', { class: 'pname', text: r.name }, r.watchlist ? el('span', { class: 'wl', text: '\u2605 watchlist' }) : null),
          el('span', { class: 'slug', text: r.slug })),
        el('td', { class: 'cat', text: r.category || 'uncategorised' }),
        el('td', { class: 'chains', text: r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num' },
          el('span', { class: 'val', text: fmtUsd(r.implied_value_usd) }),
          el('span', { class: 'bar' }, el('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / maxVal) * 100)) + '%' }))));
      tr.addEventListener('click', function () { state.detail = r.slug; render(); });
      return tr;
    });
    if (rows.length === 0) return el('div', { class: 'empty', text: 'No protocol matches this filter. Loosen the search, the category or the chain.' });
    return el('table', { class: 'board' }, el('thead', null, head), el('tbody', null, body));
  }

  /* ------------------------------------------------ detail drawer */
  function factorRow(label, value, widthPct) {
    return el('div', { class: 'row' },
      el('span', { class: 'lab', text: label }),
      el('span', { class: 'track' }, el('span', { class: 'fill', style: 'width:' + widthPct + '%' })),
      el('span', { class: 'fv', text: value }));
  }
  function drawer(r) {
    var m = r.model;
    var close = el('button', { class: 'close', text: '\u00d7', 'aria-label': 'Close detail' });
    close.addEventListener('click', function () { state.detail = null; render(); });
    var scrim = el('div', { class: 'scrim' });
    scrim.addEventListener('click', function () { state.detail = null; render(); });
    var steps = el('ol', { class: 'steps' }, r.farm_steps.map(function (s) { return el('li', { text: s }); }));
    var panel = el('aside', { class: 'drawer' },
      close,
      el('h2', { text: r.name }),
      el('div', { class: 'sub' },
        el('span', { class: 'badge', text: 'rank #' + r.rank + ' of ' + D.board_size }),
        r.watchlist ? el('span', { class: 'badge amber', text: 'watchlist' }) : el('span', { class: 'badge', text: 'early find' }),
        el('span', { class: 'badge', text: 'records no token' })),
      el('div', { class: 'kpis' },
        el('div', { class: 'kpi' }, el('b', { text: fmtUsd(r.implied_value_usd) }), el('span', { text: 'Implied value' })),
        el('div', { class: 'kpi' }, el('b', { text: fmtUsd(r.tvl_usd) }), el('span', { text: 'TVL' })),
        el('div', { class: 'kpi' }, el('b', { text: fmtPct(r.change_7d) }), el('span', { text: 'TVL change, 7d' })),
        el('div', { class: 'kpi' }, el('b', { text: fmtAge(r.age_days) }), el('span', { text: 'Running, no token' }))),
      el('h3', { text: 'How the value is built' }),
      el('div', { class: 'factors' },
        factorRow('TVL base', fmtUsd(r.tvl_usd), 100),
        factorRow('Category multiple', m.category_multiple.toFixed(2) + 'x', Math.min(100, m.category_multiple * 40)),
        factorRow('Momentum (7d)', m.momentum_multiplier.toFixed(2) + 'x', (m.momentum_multiplier - 0.5) * 100),
        factorRow('Maturity (age)', m.maturity_multiplier.toFixed(2) + 'x', m.maturity_multiplier * 100),
        factorRow('Breadth (chains)', m.breadth_multiplier.toFixed(2) + 'x', (m.breadth_multiplier - 1) * 400)),
      el('p', { class: 'sub', text: 'Category multiple calibrated from ' + (m.calibration_samples > 0 ? m.calibration_samples + ' trading protocol' + (m.calibration_samples === 1 ? '' : 's') + ' in ' + (r.category || 'this category') : 'no trading protocol in this category - the global median applies') + '. Implied value = TVL x multiple x momentum x maturity x breadth, rounded.' }),
      el('h3', { text: 'The farm plan' }),
      steps,
      el('h3', { text: 'The record' }),
      el('div', { class: 'record', text: 'slug ' + r.slug + ' | category ' + (r.category || 'none named') + ' | chains ' + (r.chains.join(', ') || 'none named') + ' | listed ' + (r.listed_at || 'unreported') + ' | TVL ' + fmtUsd(r.tvl_usd) + ' | records no token (no market cap, no CoinGecko id, no symbol in the snapshot)' }));
    return el('div', null, scrim, panel);
  }

  /* ------------------------------------------------ live set + footer */
  function liveSection() {
    var body = D.live.map(function (r) {
      return el('tr', null,
        el('td', null, el('span', { class: 'pname', text: r.name }), el('span', { class: 'slug', text: r.slug })),
        el('td', { class: 'cat', text: r.category || 'uncategorised' }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.mcap_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) + 'x' : 'n/a' }));
    });
    return el('section', { class: 'live' },
      el('h2', { text: 'Already trading - set aside, and used as the yardstick' }),
      el('p', { text: 'These protocols\u2019 tokens already trade, so the board never ranks them: it shows the market\u2019s own value. Their market-cap/TVL ratios are what calibrate the multiples above - the radar prices the launches to come by what the market already pays for the ones that arrived.' }),
      el('table', { class: 'live-t' },
        el('thead', null, el('tr', null,
          el('th', { text: 'Protocol' }), el('th', { text: 'Category' }),
          el('th', { class: 'num', text: 'TVL' }), el('th', { class: 'num', text: 'Market cap' }), el('th', { class: 'num', text: 'MCap / TVL' }))),
        el('tbody', null, body)));
  }
  function footer() {
    return el('footer', null,
      el('div', { text: 'A protocol \u201crecords no token\u201d in the snapshot is not proof it has none: DefiLlama\u2019s record is what this board reads. An implied value is this entry\u2019s own claim about a launch that may never happen, not a prediction and not advice.' }),
      el('div', { class: 'src', text: 'Source: ' + D.source + ' | snapshot as of ' + D.as_of + ' | watchlist floor ' + fmtUsd(D.floor_usd) + ' | model ' + D.model_version }));
  }

  function render() {
    var rows = sortedRows(visibleRows());
    app.textContent = '';
    app.appendChild(masthead());
    app.appendChild(modelStrip());
    app.appendChild(controls(rows.length));
    app.appendChild(boardTable(rows));
    app.appendChild(liveSection());
    app.appendChild(footer());
    if (state.detail && bySlug[state.detail]) document.body.appendChild(drawer(bySlug[state.detail]));
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.detail) { state.detail = null; render(); }
  });
  render();
})();
