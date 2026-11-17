// Launch Radar's page. It reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked board, a top-ten short list with the method stated up front, its filters, a
// per-protocol detail drawer with the model's factors, the evidence behind its category
// multiple, the record's own warning signs and the protocol's farm plan, and the live-token
// set the model calibrated on. No network: every byte it shows arrived in data.js.
//
// The model the page states, and main.ts runs:
//   implied = TVL x category multiple x momentum x maturity x breadth
// The category multiple is not a constant: it is the median market-cap/TVL of the snapshot's own
// trading protocols in that category, shrunk toward the global median. Momentum reads the 7-day
// TVL change through a tanh, maturity reads the protocol's age, breadth its chain count. The
// drawer's evidence block shows, for the open protocol, the trading peers that median rests on.
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
  var calByCategory = {};
  D.calibration.categories.forEach(function (c) { calByCategory[c.category] = c; });

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return D.rows.filter(function (r) {
      if (state.seg === 'watchlist' && !r.watchlist) return false;
      if (state.seg === 'early' && (r.watchlist || r.above_floor)) return false;
      if (state.seg === 'above' && !r.above_floor) return false;
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
        el('p', { class: 'scopeline' },
          document.createTextNode('Scope 01 \u00b7 pre-token only \u00b7 every multiple calibrated on '),
          el('b', { text: 'this snapshot' })),
        el('p', { class: 'tagline', text: 'Protocols that record no token yet, ranked by what a launch would be worth if their record stayed as it is - and what to do to farm each one. Implied values are this board\u2019s own claim, from the snapshot\u2019s figures alone.' })
      ),
      el('div', { class: 'stats' },
        stat(String(D.board_size), 'ranked'),
        stat(String(D.watchlist_size) + '/' + String(D.watchlist_size), 'watchlist covered'),
        stat(String(D.early_size + D.above_size), 'beyond the list'),
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
        el('td', { text: c.median.toFixed(2) + 'x' }),
        el('td', { text: c.multiple.toFixed(2) + 'x' }));
    });
    var table = el('table', { class: 'cal-table' },
      el('tr', null, el('th', { text: 'Category' }), el('th', { text: 'Trading protocols' }), el('th', { text: 'Median' }), el('th', { text: 'Applied multiple' })),
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
        el('p', { text: 'Momentum = 1 + 0.45 x tanh(clamped 7d change / 40). Maturity = 0.70 + 0.30 x age / 5 years, capped; an unreported listing date counts as the snapshot\u2019s median age of ' + cal.reference_age_days + ' days. Breadth = 1 + 0.025 per extra chain, capped at 8. Model version ' + D.model_version + '. Open any protocol to see the peers its own multiple rests on.' })
      )
    );
  }

  /* ------------------------------------------------ the short list: method + top ten, up front */
  function shortlistSection() {
    var top = D.rows.slice(0, 10);
    var items = top.map(function (r) {
      var row = el('button', { class: 'sl-row', type: 'button' },
        el('span', { class: 'sl-rank', text: '#' + r.rank }),
        el('span', { class: 'sl-main' },
          el('span', { class: 'sl-name', text: r.name },
            r.watchlist ? el('span', { class: 'wl', text: '\u2605 watchlist' }) : null,
            r.above_floor ? el('span', { class: 'abv', text: 'above the floor' }) : null,
            r.risk_flags.length ? el('span', { class: 'flags', text: '\u2691 ' + r.risk_flags.length }) : null),
          el('span', { class: 'sl-sig', text: r.signal })),
        el('span', { class: 'sl-nums' },
          el('b', { text: fmtUsd(r.implied_value_usd) }),
          el('span', { text: 'TVL ' + fmtUsd(r.tvl_usd) + ' \u00b7 7d ' + fmtPct(r.change_7d) })));
      row.addEventListener('click', function () { state.detail = r.slug; render(); });
      return row;
    });
    return el('section', { class: 'shortlist' },
      el('h2', { text: 'The short list - where a farmer starts' }),
      el('p', { class: 'sl-method' },
        document.createTextNode('The method, in one breath: every protocol here records no token in the snapshot. Each is priced by what the market already pays per TVL dollar for its category - read off this snapshot\u2019s own trading protocols, never a hand-kept list - then adjusted for its week\u2019s growth, its age and its chains. The watchlist is the floor, not the ceiling: the board also ranks '),
        el('b', { text: String(D.above_size) + ' protocols above that floor' }),
        document.createTextNode(' the house\u2019s list leaves out, and '),
        el('b', { text: String(D.early_size) + ' early finds below it' }),
        document.createTextNode('. These ten rows are the board\u2019s head: open any one for the evidence behind its price, its warning signs and its farm plan.')),
      el('div', { class: 'sl-list' }, items));
  }

  /* ------------------------------------------------ scope: highlights + distribution */
  function hlCard(eye, r, big, sub) {
    var card = el('button', { class: 'hl-card', type: 'button' },
      el('span', { class: 'eye', text: eye }),
      el('span', { class: 'nm', text: r.name }),
      el('span', { class: 'big', text: big }),
      el('span', { class: 'sub', text: sub }));
    card.addEventListener('click', function () { state.detail = r.slug; render(); });
    return card;
  }
  function scopeSection() {
    var top = D.rows[0];
    var topEarly = null;
    var mover = null;
    var elder = null;
    D.rows.forEach(function (r) {
      if (!r.watchlist && topEarly === null) topEarly = r;
      if (r.change_7d !== null && (mover === null || r.change_7d > mover.change_7d)) mover = r;
      if (r.age_days !== null && (elder === null || r.age_days > elder.age_days)) elder = r;
    });
    var cards = [];
    if (top) cards.push(hlCard('Top of the board', top, fmtUsd(top.implied_value_usd) + ' implied', 'rank #1 \u00b7 ' + (top.category || 'uncategorised') + ' \u00b7 TVL ' + fmtUsd(top.tvl_usd)));
    if (topEarly) cards.push(hlCard('Top find beyond the list', topEarly, fmtUsd(topEarly.implied_value_usd) + ' implied', 'rank #' + topEarly.rank + ' \u00b7 ' + (topEarly.above_floor ? 'above the watchlist floor' : 'below the watchlist floor') + ' \u00b7 TVL ' + fmtUsd(topEarly.tvl_usd)));
    if (mover) cards.push(hlCard('Biggest 7d mover', mover, fmtPct(mover.change_7d) + ' TVL in 7d', 'rank #' + mover.rank + ' \u00b7 ' + fmtUsd(mover.implied_value_usd) + ' implied'));
    if (elder) cards.push(hlCard('Longest running, no token', elder, fmtAge(elder.age_days) + ' and counting', 'listed ' + (elder.listed_at || 'unreported') + ' \u00b7 rank #' + elder.rank));

    var bands = [
      { min: 1e9, label: '$1B and up' },
      { min: 1e8, label: '$100M - $1B' },
      { min: 1e7, label: '$10M - $100M' },
      { min: 1e6, label: '$1M - $10M' },
      { min: 0, label: 'under $1M' },
    ];
    var counts = bands.map(function () { return 0; });
    D.rows.forEach(function (r) {
      for (var i = 0; i < bands.length; i++) {
        if (r.implied_value_usd >= bands[i].min) { counts[i]++; break; }
      }
    });
    var maxCount = Math.max.apply(null, counts.concat([1]));
    var distRows = bands.map(function (b, i) {
      var pct = D.rows.length ? Math.round((counts[i] / D.rows.length) * 100) : 0;
      return el('div', { class: 'drow' },
        el('span', { class: 'dlab', text: b.label }),
        el('span', { class: 'dtrack' }, el('span', { class: 'dfill', style: 'width:' + Math.max(2, Math.round((counts[i] / maxCount) * 100)) + '%' })),
        el('span', { class: 'dnum', text: counts[i] + ' \u00b7 ' + pct + '%' }));
    });
    var dist = el('div', { class: 'dist' },
      el('h2', { text: 'Where the implied value sits' }),
      distRows,
      el('p', { class: 'dnote', text: 'Rows per implied-value band, across all ' + D.rows.length + ' ranked protocols.' }));

    return el('section', { class: 'scope' },
      el('div', null, el('h2', { text: 'On the scope - the rows that stand out' }), el('div', { class: 'hl-grid' }, cards)),
      dist);
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
      el('span', { class: 'seg' }, segBtn('all', 'Whole board'), segBtn('watchlist', 'Watchlist'), segBtn('above', 'Above floor'), segBtn('early', 'Early finds')),
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
  function activeFilters() {
    var parts = [];
    if (state.q.trim()) parts.push('search \u201c' + state.q.trim() + '\u201d');
    if (state.category !== 'all') parts.push('category ' + state.category);
    if (state.chain !== 'all') parts.push('chain ' + state.chain);
    if (state.seg === 'watchlist') parts.push('the watchlist segment');
    if (state.seg === 'above') parts.push('the above-floor segment');
    if (state.seg === 'early') parts.push('the early-finds segment');
    return parts;
  }
  function emptyState() {
    var parts = activeFilters();
    var clear = el('button', { class: 'clear-btn', text: 'Clear the search and filters', type: 'button' });
    clear.addEventListener('click', function () {
      state.q = ''; state.category = 'all'; state.chain = 'all'; state.seg = 'all';
      render();
    });
    return el('div', { class: 'empty' },
      el('span', { class: 'big', text: 'Nothing on the scope matches.' }),
      document.createTextNode(parts.length
        ? 'No ranked protocol fits ' + parts.join(' + ') + '. The board itself holds ' + D.board_size + ' protocols - one of the filters is doing the excluding.'
        : 'The board holds ' + D.board_size + ' protocols, and none is showing.'),
      el('div', null, clear));
  }
  function boardTable(rows) {
    if (rows.length === 0) return emptyState();
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
          el('span', { class: 'pname', text: r.name },
            r.watchlist ? el('span', { class: 'wl', text: '\u2605 watchlist' }) : null,
            r.above_floor ? el('span', { class: 'abv', text: 'above the floor' }) : null,
            r.risk_flags.length ? el('span', { class: 'flags', title: r.risk_flags.join('; '), text: '\u2691 ' + r.risk_flags.length }) : null),
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
    return el('div', { class: 'board-wrap' },
      el('table', { class: 'board' }, el('thead', null, head), el('tbody', null, body)));
  }

  /* ------------------------------------------------ detail drawer */
  function factorRow(label, value, widthPct) {
    return el('div', { class: 'row' },
      el('span', { class: 'lab', text: label }),
      el('span', { class: 'track' }, el('span', { class: 'fill', style: 'width:' + widthPct + '%' })),
      el('span', { class: 'fv', text: value }));
  }
  function kpi(value, label) {
    return el('div', { class: 'kpi' }, el('b', { text: value }), el('span', { text: label }));
  }
  function evidenceBlock(r, m) {
    var cal = D.calibration;
    var catName = r.category || 'this category';
    var entry = calByCategory[r.category || ''];
    var kids = [el('div', { class: 'ehead', text: 'Why this multiple - the evidence' })];
    if (entry && entry.samples > 0) {
      kids.push(el('div', null,
        document.createTextNode('The ' + catName + ' multiple of '),
        el('b', { text: m.category_multiple.toFixed(2) + 'x' }),
        document.createTextNode(' rests on ' + entry.samples + ' trading protocol' + (entry.samples === 1 ? '' : 's') + ' in this snapshot. Their market-cap / TVL ratios run ' + entry.ratio_min.toFixed(2) + 'x to ' + entry.ratio_max.toFixed(2) + 'x, with a median of ' + entry.median.toFixed(2) + 'x; shrunk toward the global median of ' + cal.global_multiple.toFixed(2) + 'x (a prior of 4 samples), the median is applied as ' + entry.multiple.toFixed(2) + 'x.')));
      if (entry.peers && entry.peers.length) {
        kids.push(el('div', { class: 'peers', text: 'Nearest the median: ' + entry.peers.map(function (p) { return p.name + ' ' + p.ratio.toFixed(2) + 'x'; }).join(' \u00b7 ') }));
      }
    } else {
      kids.push(el('div', null,
        document.createTextNode('No protocol in ' + catName + ' trades in this snapshot, so there is no category median to read. The board applies the '),
        el('b', { text: 'global median of ' + cal.global_multiple.toFixed(2) + 'x' }),
        document.createTextNode(', the median market-cap / TVL across all ' + cal.trading_protocols + ' trading protocols, until this category has trading peers of its own.')));
    }
    return el('div', { class: 'evidence' }, kids);
  }
  function signalsBlock(r) {
    var kids = [el('div', { class: 'ehead', text: 'The read - and what to watch' })];
    kids.push(el('div', { text: r.signal + '.' }));
    if (r.risk_flags.length) {
      kids.push(el('ul', { class: 'flaglist' }, r.risk_flags.map(function (f) { return el('li', { text: f }); })));
    } else {
      kids.push(el('div', { class: 'noflags', text: 'Its record carries none of the board\u2019s warning signs: no shrinking week, no missing figures, more than one chain, a history past six months, and a category multiple with trading evidence behind it.' }));
    }
    return el('div', { class: 'evidence sig' }, kids);
  }
  function drawer(r) {
    var m = r.model;
    var close = el('button', { class: 'close', text: '\u00d7', 'aria-label': 'Close detail' });
    close.addEventListener('click', function () { state.detail = null; render(); });
    var scrim = el('div', { class: 'scrim' });
    scrim.addEventListener('click', function () { state.detail = null; render(); });
    var steps = el('ol', { class: 'steps' }, r.farm_steps.map(function (s) { return el('li', { text: s }); }));
    var median = D.rows.length ? D.rows[Math.floor(D.rows.length / 2)].implied_value_usd : 0;
    var arith = el('div', null,
      el('div', { class: 'arith' },
        document.createTextNode(fmtUsd(r.tvl_usd) + ' TVL \u00d7 ' + m.category_multiple.toFixed(2) + ' \u00d7 ' + m.momentum_multiplier.toFixed(2) + ' \u00d7 ' + m.maturity_multiplier.toFixed(2) + ' \u00d7 ' + m.breadth_multiplier.toFixed(2) + ' '),
        el('span', { class: 'eq', text: '\u2248 ' + fmtUsd(r.implied_value_usd) })),
      el('p', { class: 'arith-note', text: 'Factors rounded to two places here; the board multiplies the unrounded factors and rounds the result once, to whole dollars. Against the board\u2019s median implied value of ' + fmtUsd(median) + ', this row stands at ' + (median > 0 ? (r.implied_value_usd / median).toFixed(1) : '0') + '\u00d7 the median.' }));
    var panel = el('aside', { class: 'drawer' },
      close,
      el('h2', { text: r.name }),
      el('div', { class: 'sub' },
        el('span', { class: 'badge', text: 'rank #' + r.rank + ' of ' + D.board_size }),
        r.watchlist ? el('span', { class: 'badge amber', text: 'watchlist' }) : r.above_floor ? el('span', { class: 'badge', text: 'above the floor - beyond the list' }) : el('span', { class: 'badge', text: 'early find' }),
        el('span', { class: 'badge', text: 'records no token' })),
      el('div', { class: 'kpis' },
        kpi(fmtUsd(r.implied_value_usd), 'Implied value'),
        kpi(fmtUsd(r.tvl_usd), 'TVL'),
        kpi(fmtPct(r.change_7d), 'TVL change, 7d'),
        kpi(fmtAge(r.age_days), 'Running, no token'),
        kpi(r.category || 'none named', 'Category'),
        kpi(r.chains.length ? r.chains.length + ' \u00b7 ' + r.chains[0] : 'none named', 'Chains')),
      el('h3', { text: 'How the value is built' }),
      el('div', { class: 'factors' },
        factorRow('TVL base', fmtUsd(r.tvl_usd), 100),
        factorRow('Category multiple', m.category_multiple.toFixed(2) + 'x', Math.min(100, m.category_multiple * 40)),
        factorRow('Momentum (7d)', m.momentum_multiplier.toFixed(2) + 'x', (m.momentum_multiplier - 0.5) * 100),
        factorRow('Maturity (age)', m.maturity_multiplier.toFixed(2) + 'x', m.maturity_multiplier * 100),
        factorRow('Breadth (chains)', m.breadth_multiplier.toFixed(2) + 'x', (m.breadth_multiplier - 1) * 400)),
      arith,
      evidenceBlock(r, m),
      signalsBlock(r),
      el('h3', { text: 'The farm plan' }),
      steps,
      el('h3', { text: 'The record' }),
      el('div', { class: 'record', text: 'slug ' + r.slug + ' | category ' + (r.category || 'none named') + ' | chains ' + (r.chains.join(', ') || 'none named') + ' | listed ' + (r.listed_at || 'unreported') + ' | TVL ' + fmtUsd(r.tvl_usd) + ' | records no token (no market cap, no CoinGecko id, no symbol in the snapshot)' }));
    return el('div', { class: 'drawer-root' }, scrim, panel);
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
      el('p', { text: 'These protocols\u2019 tokens already trade, so the board never ranks them: it shows the market\u2019s own value. Their market-cap/TVL ratios are what calibrate the multiples above - the radar prices the launches to come by what the market already pays for the ones that arrived. Shown: the ' + D.live.length + ' largest by market cap of the snapshot\u2019s trading protocols.' }),
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
    app.appendChild(shortlistSection());
    app.appendChild(scopeSection());
    app.appendChild(modelStrip());
    app.appendChild(controls(rows.length));
    app.appendChild(boardTable(rows));
    app.appendChild(liveSection());
    app.appendChild(footer());
    document.querySelectorAll('.drawer-root').forEach(function (n) { n.remove(); });
    if (state.detail && bySlug[state.detail]) document.body.appendChild(drawer(bySlug[state.detail]));
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.detail) { state.detail = null; render(); }
  });
  render();
})();
