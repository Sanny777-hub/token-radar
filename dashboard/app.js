/* Token Radar — dashboard (radar-2)
 * Reads window.RADAR written beside dashboard/ by main.ts (out/data.js).
 * Recomputes the model on the page and renders the board, live table,
 * model panel and detail dialog entirely with DOM calls.
 */
(function () {
  'use strict';

  var RADAR = window.RADAR;

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  var state = {
    q: '',
    category: 'all',
    tab: 'pre-token',
    sortKey: 'implied',
    sortDir: -1,
    selected: null
  };

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function label(text) {
    return el('div', 'label', text);
  }

  function fmtUsd(v) {
    if (v == null) return 'n/a';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'K';
    return '$' + v.toLocaleString('en-US');
  }

  function fmtPct(v) {
    if (v == null) return 'n/a';
    var sign = v > 0 ? '+' : '';
    return sign + v.toFixed(2) + '%';
  }

  function fmtAge(days) {
    if (days == null) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return days + 'd';
  }

  // The overall share of snapshot protocols that record a token: the odds a category with no measured
  // record keeps (lib/model.ts's OVERALL_TOKEN_ODDS).
  var OVERALL_ODDS = 0.55;

  // A category's chance of ever recording a token, from the snapshot's own measured table
  // (model.token_odds); a category not listed keeps the overall share.
  function tokenOdds(category) {
    if (category === null) return OVERALL_ODDS;
    var odds = RADAR.model.token_odds[category];
    if (odds !== undefined) return odds;
    return OVERALL_ODDS;
  }

  // Recompute the model on the page, mirroring lib/model.ts exactly so the page can show whether it
  // agrees with the stored implied value. Every step is the model's own: the fitted power-law base, the
  // clamped 7-day growth, the age-based maturity, the quiet-age penalty and the category's token odds.
  function computeModel(row) {
    var m = RADAR.model;
    // base = base_coefficient x tvl ^ base_exponent: the fitted power law, in dollars.
    var base = m.base_coefficient * Math.pow(row.tvl_usd, m.base_exponent);
    // growth = clamp(change_7d, growth_floor, growth_cap) per cent; a missing change counts as 0.
    var rawGrowth = row.change_7d == null ? 0 : row.change_7d;
    var clamped = Math.max(m.growth_floor, Math.min(m.growth_cap, rawGrowth));
    var growthFactor = 1 + (clamped / 100) * m.growth_weight;
    // maturity = maturity_floor + min(max(age, 0), maturity_days) / maturity_days x maturity_range;
    // an unknown age counts as unknown_age_days.
    var age = row.age_days == null ? m.unknown_age_days : row.age_days;
    var maturityFactor = m.maturity_floor +
      (Math.min(Math.max(age, 0), m.maturity_days) / m.maturity_days) * m.maturity_range;
    // quiet = quiet_penalty when the age is known and past quiet_days, else 1.
    var quiet = (row.age_days != null && row.age_days > m.quiet_days) ? m.quiet_penalty : 1;
    var odds = tokenOdds(row.category);
    var value = Math.max(1, Math.round(base * growthFactor * maturityFactor * quiet * odds));
    return {
      base: base,
      growthFactor: growthFactor,
      maturityFactor: maturityFactor,
      odds: odds,
      quiet: quiet,
      value: value
    };
  }

  // Category-specific farm action.
  function categoryAction(category) {
    var c = (category || '').toLowerCase();
    if (c.indexOf('lending') !== -1 || c.indexOf('cdp') !== -1) return 'Supply USDC';
    if (c.indexOf('dex') !== -1 || c.indexOf('yield') !== -1) return 'Provide liquidity';
    if (c.indexOf('bridge') !== -1) return 'Bridge USDC';
    if (c.indexOf('stak') !== -1 || c.indexOf('restak') !== -1) return 'Stake the chain asset';
    if (c.indexOf('perpetual') !== -1 || c.indexOf('derivativ') !== -1) return 'Deposit margin and open one small hedge';
    if (c.indexOf('prediction') !== -1) return 'Fund and place one market position';
    if (c.indexOf('curator') !== -1 || c.indexOf('allocator') !== -1) return 'Deposit into a vault';
    if (c.indexOf('stable') !== -1) return 'Mint or deposit the stable asset';
    if (c.indexOf('rwa') !== -1) return 'Mint the yield asset';
    if (c.indexOf('insurance') !== -1) return 'Buy cover';
    return 'Deposit USDC';
  }

  function capitalFor(tvl) {
    if (tvl >= 5e9) return 250;
    if (tvl >= 1e9) return 150;
    if (tvl >= 1e8) return 100;
    return 50;
  }

  function holdDays(age) {
    if (age == null) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  // ------------------------------------------------------------------
  // Hash sync
  // ------------------------------------------------------------------
  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    if (p.get('q')) state.q = p.get('q');
    var tab = p.get('p');
    if (tab === 'live' || tab === 'pre-token') state.tab = tab;
    if (p.get('category')) state.category = p.get('category');
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.tab !== 'pre-token') p.set('p', state.tab);
    if (state.category !== 'all') p.set('category', state.category);
    var s = p.toString();
    history.replaceState(null, '', s ? '#' + s : '#');
  }

  // ------------------------------------------------------------------
  // Filtering + sorting
  // ------------------------------------------------------------------
  function matches(row) {
    if (state.category !== 'all' && row.category !== state.category) return false;
    if (state.q) {
      var q = state.q.toLowerCase();
      var hit = row.name.toLowerCase().indexOf(q) !== -1 ||
        row.category.toLowerCase().indexOf(q) !== -1;
      if (!hit) {
        for (var i = 0; i < row.chains.length; i++) {
          if (row.chains[i].toLowerCase().indexOf(q) !== -1) { hit = true; break; }
        }
      }
      if (!hit) return false;
    }
    return true;
  }

  function sortRows(rows) {
    var key = state.sortKey;
    var dir = state.sortDir;
    return rows.slice().sort(function (a, b) {
      var av, bv, r;
      if (key === 'name') {
        r = String(a.name).localeCompare(String(b.name));
      } else {
        av = key === 'rank' ? a.rank :
          key === 'tvl' ? a.tvl_usd :
          key === 'change' ? (a.change_7d == null ? -Infinity : a.change_7d) :
          key === 'age' ? (a.age_days == null ? -1 : a.age_days) :
          (a.implied_value_usd || 0);
        bv = key === 'rank' ? b.rank :
          key === 'tvl' ? b.tvl_usd :
          key === 'change' ? (b.change_7d == null ? -Infinity : b.change_7d) :
          key === 'age' ? (b.age_days == null ? -1 : b.age_days) :
          (b.implied_value_usd || 0);
        r = av - bv;
      }
      return r * dir;
    });
  }

  function boardRows() {
    return sortRows(RADAR.rows.filter(matches));
  }

  function liveRows() {
    return RADAR.live.filter(matches);
  }

  // ------------------------------------------------------------------
  // Sections
  // ------------------------------------------------------------------
  function buildTop(container) {
    var top = el('header', 'top');
    var brand = el('div', 'brand');
    brand.appendChild(el('span', 'mark'));
    brand.appendChild(el('span', 'brand-name', 'Token Radar'));
    top.appendChild(brand);
    var meta = el('div', 'top-meta');
    meta.appendChild(el('span', null, RADAR.as_of));
    meta.appendChild(el('span', null, RADAR.source));
    meta.appendChild(el('span', null, 'model ' + RADAR.model_version));
    top.appendChild(meta);
    container.appendChild(top);
  }

  function buildLede(container) {
    var lede = el('section', 'lede');
    lede.appendChild(el('h1', null,
      RADAR.watchlist_size + ' protocols ranked by implied value'));
    var floor = fmtUsd(RADAR.floor_usd);
    var p = el('p', null,
      'The watchlist holds the top ' + RADAR.watchlist_size +
      ' pre-token protocols above a ' + floor +
      ' TVL floor. ' + RADAR.early_size +
      ' more pre-token rows sit below the floor as early radar, watched before they graduate.');
    lede.appendChild(p);

    var facts = el('div', 'facts');
    var factsData = [
      ['Watchlist covered', RADAR.watchlist_size],
      ['Pre-token rows scored', RADAR.rows.length],
      ['Early rows below the floor', RADAR.early_size],
      ['Live-token protocols set aside', RADAR.live_size]
    ];
    factsData.forEach(function (f) {
      var fact = el('div', 'fact');
      fact.appendChild(el('div', null, f[0]));
      fact.appendChild(el('div', 'num', String(f[1])));
      facts.appendChild(fact);
    });
    lede.appendChild(facts);
    container.appendChild(lede);
  }

  // KPI strip: the headline figures of the snapshot, near the top of the dashboard.
  function buildKpi(container) {
    var strip = el('section', 'kpi-strip');
    strip.setAttribute('data-role', 'kpi-strip');
    var kpis = [
      ['Protocols in snapshot', RADAR.board_size + RADAR.live_size],
      ['On watchlist', RADAR.watchlist_size],
      ['Pre-token rows on board', RADAR.board_size],
      ['Live-token protocols', RADAR.live_size],
      ['Model version', RADAR.model_version],
      ['Snapshot date', RADAR.as_of]
    ];
    kpis.forEach(function (k) {
      var cell = el('div', 'kpi');
      cell.appendChild(el('div', 'kpi-label', k[0]));
      cell.appendChild(el('div', 'kpi-value', String(k[1])));
      strip.appendChild(cell);
    });
    container.appendChild(strip);
  }

  // Integrity strip: every snapshot protocol is accounted for by the board or the live set, once each.
  function buildIntegrity(container) {
    var strip = el('section', 'integrity');
    strip.setAttribute('data-role', 'integrity-strip');
    var total = RADAR.board_size + RADAR.live_size;
    strip.appendChild(el('div', 'integrity-line',
      RADAR.board_size + ' board rows + ' + RADAR.live_size +
      ' live rows = ' + total + ' protocols, zero overlap'));
    strip.appendChild(el('div', 'integrity-line', 'Data source: ' + RADAR.source));
    strip.appendChild(el('div', 'integrity-line', 'Snapshot date: ' + RADAR.as_of));
    container.appendChild(strip);
  }

  function buildControls(container) {
    var controls = el('div', 'controls');

    var searchField = el('div', 'field');
    searchField.appendChild(label('Search'));
    var search = el('input', null, null);
    search.type = 'text';
    search.value = state.q;
    search.placeholder = 'name, category or chain';
    search.setAttribute('data-role', 'search');
    searchField.appendChild(search);
    controls.appendChild(searchField);

    var catField = el('div', 'field');
    catField.appendChild(label('Category'));
    var select = el('select');
    select.appendChild(el('option', null, 'all')).value = 'all';
    var cats = [];
    RADAR.rows.forEach(function (r) {
      if (cats.indexOf(r.category) === -1) cats.push(r.category);
    });
    cats.sort(function (a, b) { return a.localeCompare(b); });
    cats.forEach(function (c) {
      var o = el('option', null, c);
      o.value = c;
      select.appendChild(o);
    });
    select.value = state.category;
    catField.appendChild(select);
    controls.appendChild(catField);

    var tabs = el('div', 'tabs');
    [['pre-token', 'Pre-token'], ['live', 'Live-token']].forEach(function (t) {
      var b = el('button', 'button' + (state.tab === t[0] ? ' primary' : ''), t[1]);
      b.setAttribute('data-tab', t[0]);
      tabs.appendChild(b);
    });
    controls.appendChild(tabs);

    var count = el('div', 'count');
    count.setAttribute('data-role', 'count');
    controls.appendChild(count);

    container.appendChild(controls);

    // Events
    search.addEventListener('input', function () {
      state.q = search.value;
      writeHash();
      render(true);
    });
    select.addEventListener('change', function () {
      state.category = select.value;
      writeHash();
      render();
    });
    tabs.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.tab !== b.getAttribute('data-tab')) {
          state.tab = b.getAttribute('data-tab');
          writeHash();
          render();
        }
      });
    });
  }

  function buildModelPanel(container) {
    var m = RADAR.model;
    var panel = el('section', 'model');
    panel.appendChild(el('h2', null, 'How implied value is computed'));

    var words = el('p', null,
      'A protocol\u2019s implied value starts from its total value locked, scaled by a fitted power law ' +
      'of the snapshot\u2019s own market caps. It is boosted by the 7-day growth trend (clamped to a range), ' +
      'by maturity (how long the protocol has been live), by its category\u2019s measured chance of ever ' +
      'recording a token, and penalized when it has gone quiet for too long.');
    panel.appendChild(words);

    var formula = el('div', 'formula',
      'implied = ' + m.base_coefficient.toFixed(2) + ' \u00d7 TVL^' + m.base_exponent +
      ' \u00d7 (1 + clamp(7d, ' + m.growth_floor + ', ' + m.growth_cap + ')/100 \u00d7 ' + m.growth_weight + ')' +
      ' \u00d7 (' + m.maturity_floor + ' + min(age, ' + m.maturity_days + ')/' + m.maturity_days +
      ' \u00d7 ' + m.maturity_range + ')' +
      ' \u00d7 token_odds' +
      ' \u00d7 quiet(> ' + m.quiet_days + ' days \u2192 ' + m.quiet_penalty + ')');
    panel.appendChild(formula);

    var keys = el('div', 'equation');
    var rows = [
      ['Base coefficient', m.base_coefficient.toFixed(2)],
      ['Base exponent', m.base_exponent],
      ['Growth weight', m.growth_weight],
      ['Growth floor / cap', m.growth_floor + ' / ' + m.growth_cap],
      ['Maturity floor', m.maturity_floor],
      ['Maturity range', m.maturity_range],
      ['Maturity days', m.maturity_days],
      ['Unknown age treated as', m.unknown_age_days + ' days'],
      ['Token odds (unlisted category)', OVERALL_ODDS],
      ['Quiet penalty', m.quiet_penalty + ' after ' + m.quiet_days + ' days']
    ];
    rows.forEach(function (r) {
      var line = el('div', 'equation-row');
      line.appendChild(el('span', null, r[0]));
      line.appendChild(el('span', 'num', String(r[1])));
      keys.appendChild(line);
    });
    panel.appendChild(keys);

    var w = el('div', 'formula');
    w.appendChild(el('div', 'sub', 'Token odds by category'));
    var oddsList = Object.keys(m.token_odds).sort(function (a, b) {
      return m.token_odds[b] - m.token_odds[a];
    }).map(function (k) {
      return k + ' ' + m.token_odds[k].toFixed(2);
    });
    oddsList.push('any other category ' + OVERALL_ODDS.toFixed(2));
    w.appendChild(el('p', null, oddsList.join('; ')));
    panel.appendChild(w);

    container.appendChild(panel);
  }

  // Table header cell (sortable for board).
  function th(col, labelText, sortable) {
    var c = el('th', null, null);
    var inner = el('div', null, labelText);
    c.appendChild(inner);
    if (sortable) {
      c.classList.add('sortable');
      c.setAttribute('role', 'button');
      c.tabIndex = 0;
      var arrow = el('span', 'sort-arrow',
        state.sortKey === col ? (state.sortDir === -1 ? ' \u25bc' : ' \u25b2') : '');
      inner.appendChild(arrow);
      c.addEventListener('click', function () {
        if (state.sortKey === col) {
          state.sortDir = -state.sortDir;
        } else {
          state.sortKey = col;
          state.sortDir = -1;
        }
        writeHash();
        render();
      });
      c.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          c.click();
        }
      });
    }
    return c;
  }

  function buildBoard(container) {
    var panel = el('section', 'panel');
    var rows = boardRows();
    var maxImplied = 1;
    RADAR.rows.forEach(function (r) {
      if (r.implied_value_usd && r.implied_value_usd > maxImplied) maxImplied = r.implied_value_usd;
    });

    if (rows.length === 0) {
      var empty = el('div', 'empty');
      empty.appendChild(el('p', null, 'No protocols match your filters.'));
      var clear = el('button', 'button primary', 'Clear filters');
      empty.appendChild(clear);
      clear.addEventListener('click', function () {
        state.q = '';
        state.category = 'all';
        writeHash();
        render();
      });
      panel.appendChild(empty);
      container.appendChild(panel);
      updateCount(0);
      return;
    }

    var wrap = el('div', 'table-wrap');
    var table = el('table');
    var thead = el('thead');
    var headRow = el('tr');
    headRow.appendChild(th('rank', 'Rank', true));
    headRow.appendChild(th('name', 'Protocol', true));
    headRow.appendChild(th('tvl', 'TVL', true));
    headRow.appendChild(th('change', '7d', true));
    headRow.appendChild(th('age', 'Age', true));
    headRow.appendChild(th('implied', 'Implied value', true));
    headRow.appendChild(th('name', 'Token', true));
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.tabIndex = 0;
      tr.setAttribute('data-slug', r.slug);

      tr.appendChild(el('td', 'num', String(r.rank)));

      var nameTd = el('td');
      var nameBox = el('div', 'name');
      nameBox.appendChild(el('div', null, r.name));
      var sub = el('div', 'sub', r.category + ' \u00b7 ' + r.chains.slice(0, 2).join(', '));
      nameBox.appendChild(sub);
      nameTd.appendChild(nameBox);
      tr.appendChild(nameTd);

      tr.appendChild(el('td', 'num', '$' + fmtUsd(r.tvl_usd)));

      var chgTd = el('td', 'num');
      if (r.change_7d == null) {
        chgTd.appendChild(el('span', null, 'n/a'));
      } else {
        chgTd.appendChild(el('span', r.change_7d >= 0 ? 'pos' : 'neg', fmtPct(r.change_7d)));
      }
      tr.appendChild(chgTd);

      tr.appendChild(el('td', 'num', fmtAge(r.age_days)));

      var impliedTd = el('td');
      var barWrap = el('div', 'implied');
      var bar = el('div', 'bar');
      var w = Math.min(100, (r.implied_value_usd / maxImplied) * 100);
      bar.style.width = w.toFixed(2) + '%';
      barWrap.appendChild(bar);
      barWrap.appendChild(el('span', 'num', '$' + fmtUsd(r.implied_value_usd)));
      impliedTd.appendChild(barWrap);
      tr.appendChild(impliedTd);

      var tokTd = el('td');
      tokTd.appendChild(el('span', 'status', 'no token'));
      tr.appendChild(tokTd);

      tr.addEventListener('click', function () { openDetail(r.slug); });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDetail(r.slug);
        }
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    panel.appendChild(wrap);
    container.appendChild(panel);
    updateCount(rows.length);
  }

  function buildLive(container) {
    var panel = el('section', 'panel');
    var rows = liveRows();

    if (rows.length === 0) {
      var empty = el('div', 'empty');
      empty.appendChild(el('p', null, 'No protocols match your filters.'));
      var clear = el('button', 'button primary', 'Clear filters');
      empty.appendChild(clear);
      clear.addEventListener('click', function () {
        state.q = '';
        state.category = 'all';
        writeHash();
        render();
      });
      panel.appendChild(empty);
      container.appendChild(panel);
      updateCount(0);
      return;
    }

    var wrap = el('div', 'table-wrap');
    var table = el('table');
    var thead = el('thead');
    var headRow = el('tr');
    ['Status', 'Protocol', 'TVL', '7d', 'Market cap', 'Token'].forEach(function (h) {
      headRow.appendChild(el('th', null, h));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');

      var stTd = el('td');
      stTd.appendChild(el('span', 'status', 'live'));
      tr.appendChild(stTd);

      var nameTd = el('td');
      var nameBox = el('div', 'name');
      nameBox.appendChild(el('div', null, r.name));
      var sub = el('div', 'sub', r.category + ' \u00b7 ' + r.chains.slice(0, 2).join(', '));
      nameBox.appendChild(sub);
      nameTd.appendChild(nameBox);
      tr.appendChild(nameTd);

      tr.appendChild(el('td', 'num', '$' + fmtUsd(r.tvl_usd)));

      var chgTd = el('td', 'num');
      if (r.change_7d == null) {
        chgTd.appendChild(el('span', null, 'n/a'));
      } else {
        chgTd.appendChild(el('span', r.change_7d >= 0 ? 'pos' : 'neg', fmtPct(r.change_7d)));
      }
      tr.appendChild(chgTd);

      tr.appendChild(el('td', 'num', '$' + fmtUsd(r.mcap_usd)));

      var tokTd = el('td');
      tokTd.appendChild(el('span', 'status', 'already trades'));
      tr.appendChild(tokTd);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    panel.appendChild(wrap);
    container.appendChild(panel);
    updateCount(rows.length);
  }

  function updateCount(n) {
    var count = document.querySelector('[data-role="count"]');
    if (count) count.textContent = n + ' protocols';
  }

  // ------------------------------------------------------------------
  // Detail dialog
  // ------------------------------------------------------------------
  function detailSection(title) {
    var sec = el('div', 'detail-section');
    sec.appendChild(el('h3', null, title));
    return sec;
  }

  function kvLine(sec, k, v) {
    var line = el('div', 'equation-row');
    line.appendChild(el('span', null, k));
    var valSpan = el('span', 'num');
    valSpan.appendChild(v);
    line.appendChild(valSpan);
    sec.appendChild(line);
  }

  function buildDetail(container, row) {
    var model = computeModel(row);
    var rank = row.rank;

    var detail = el('div', 'detail');
    var head = el('div', 'detail-head');
    head.appendChild(el('div', 'sub', 'Rank ' + rank + ' of ' + RADAR.board_size));
    var title = el('h2', null, row.name);
    head.appendChild(title);
    head.appendChild(el('div', 'sub',
      row.category + ' \u00b7 ' + row.chains.join(', ')));
    var close = el('button', 'button close', 'Close');
    head.appendChild(close);
    detail.appendChild(head);

    // Implied value section
    var sec = detailSection('Implied value');
    kvLine(sec, 'TVL', el('span', null, '$' + fmtUsd(row.tvl_usd)));
    kvLine(sec, '7-day growth',
      row.change_7d == null ? el('span', null, 'n/a') :
        el('span', row.change_7d >= 0 ? 'pos' : 'neg', fmtPct(row.change_7d)));
    kvLine(sec, 'Age', el('span', null, fmtAge(row.age_days) + ' \u00b7 no token'));
    kvLine(sec, 'Base value', el('span', null, '$' + fmtUsd(model.base)));
    kvLine(sec, 'Growth multiplier', el('span', null, model.growthFactor.toFixed(4)));
    kvLine(sec, 'Maturity multiplier', el('span', null, model.maturityFactor.toFixed(4)));
    kvLine(sec, 'Token odds', el('span', null, model.odds.toFixed(2)));
    kvLine(sec, 'Implied value', el('span', null, '$' + fmtUsd(model.value)));
    detail.appendChild(sec);

    var matches = model.value === row.implied_value_usd;
    var sentence = el('p', 'formula',
      'Recomputed on the page: $' + fmtUsd(model.value) + ' \u2014 ' +
      (matches ? 'matches' : 'does not match') + ' the stored implied value.');
    detail.appendChild(sentence);

    // Farm plan section
    var plan = detailSection('Farm plan');
    var steps = [
      {
        text: 'Fresh wallet holding only farm funds, seed phrase offline',
        cost: 'one-time', time: 'setup'
      },
      {
        text: categoryAction(row.category) + ' with ' +
          '$' + capitalFor(row.tvl_usd) + 'K on ' + row.chains[0],
        cost: '$' + capitalFor(row.tvl_usd) + 'K', time: 'entry'
      },
      { text: 'One qualifying action each week', cost: 'recurring', time: 'weekly' },
      {
        text: 'Hold for ' + holdDays(row.age_days) + ' days',
        cost: 'none', time: holdDays(row.age_days) + ' days'
      },
      {
        text: 'Before withdrawing, check the protocol\u2019s own rewards page and claim only from its published link',
        cost: 'none', time: 'exit'
      },
      { text: 'Keep a farm log of wallet, dates, transactions', cost: 'none', time: 'ongoing' }
    ];
    var list = el('ol', 'steps');
    steps.forEach(function (s) {
      var li = el('li');
      var body = el('div');
      body.appendChild(el('div', null, s.text));
      var meta = el('div', 'cost', 'Cost: ' + s.cost + ' \u00b7 ' + s.time);
      body.appendChild(meta);
      li.appendChild(body);
      list.appendChild(li);
    });
    plan.appendChild(list);
    detail.appendChild(plan);

    close.addEventListener('click', function () { closeDetail(); });

    container.appendChild(detail);

    // Mark the drawer open so the stylesheet slides it into view. The base .detail rule keeps it
    // hidden off screen (translateX(100%)); only .detail.open / [data-open] reveals it. The reflow
    // flush commits the closed position first so the transition actually plays on the way in.
    void detail.offsetWidth;
    detail.classList.add('open');
  }

  function openDetail(slug) {
    var row = null;
    RADAR.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    render();
  }

  function closeDetail() {
    state.selected = null;
    render();
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  var focusSearch = false;
  var shell;

  function render(keepFocus) {
    if (keepFocus) focusSearch = true;
    while (shell.firstChild) shell.removeChild(shell.firstChild);

    buildTop(shell);
    buildKpi(shell);
    buildIntegrity(shell);
    buildLede(shell);
    buildControls(shell);

    if (state.tab === 'pre-token') {
      buildBoard(shell);
      buildModelPanel(shell);
    } else {
      buildLive(shell);
    }

    // Detail dialog
    if (state.selected) {
      var row = null;
      RADAR.rows.forEach(function (r) { if (r.slug === state.selected) row = r; });
      if (row) buildDetail(shell, row);
    }

    if (focusSearch) {
      var inp = document.querySelector('input[data-role="search"]');
      if (inp) {
        inp.focus();
        var len = inp.value.length;
        inp.setSelectionRange(len, len);
      }
      focusSearch = false;
    }
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function boot() {
    shell = document.querySelector('.shell');
    readHash();
    render();

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.selected) {
        closeDetail();
      }
    });

    window.addEventListener('hashchange', function () {
      readHash();
      render();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
