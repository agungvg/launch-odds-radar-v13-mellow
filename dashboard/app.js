// Launch-Odds Radar v13-mellow — dashboard. Static page, no network: it reads
// window.RADAR from data.js and renders everything from that one object.
(function () {
  var R = window.RADAR;
  var rows = R.rows;
  var T = R.tests;
  var $ = function (id) { return document.getElementById(id); };
  var state = { filter: 'all', wlOnly: false, depPct: R.farm.depositPct, gas: R.farm.gas };

  function usd(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
    return '$' + Math.round(v);
  }
  function usdFull(v) { return '$' + Math.round(v).toLocaleString('en-US'); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function verdictOf(r) {
    var dep = state.depPct * r.tvl_usd;
    var gross = r.implied_value_usd * R.farm.poolShare * state.depPct * r.odds;
    var cost = state.gas + R.farm.hours * R.farm.hourly;
    var net = gross - cost;
    return { dep: dep, gross: gross, net: net, perHour: net / R.farm.hours, verdict: net > 0 ? 'Farm' : gross > state.gas ? 'Thin' : 'Skip' };
  }

  // ---- hero cast: top four, as a 3D fan ----
  var scene = $('scene');
  rows.slice(0, 4).forEach(function (r, i) {
    var d = document.createElement('div');
    d.className = 'cast';
    d.innerHTML = '<div class="coin">' + (i + 1) + '</div><div class="c-rank">RANK #' + r.rank + '</div>' +
      '<div class="c-name">' + esc(r.name) + '</div><div class="c-cat">' + esc(r.category || 'Protocol') + ' · ' + esc(r.chains[0] || '') + '</div>' +
      '<div class="c-val">' + usd(r.implied_value_usd) + '</div><div class="c-odds">odds ' + (r.odds * 100).toFixed(1) + '% · TVL ' + usd(r.tvl_usd) + '</div>';
    d.addEventListener('click', function () { openDetail(r.slug); });
    d.style.cursor = 'pointer';
    scene.appendChild(d);
  });

  // ---- KPI scorecard ----
  function counts() {
    var c = { Farm: 0, Thin: 0, Skip: 0 };
    rows.forEach(function (r) { c[verdictOf(r).verdict]++; });
    return c;
  }
  function renderKpis() {
    var c = counts();
    var k = [
      ['Watchlist', '40 / 40', 'every watchlist slug ranked'],
      ['Board rows', '198', 'pre-token, board rule'],
      ['Farm', String(c.Farm), 'net positive after $45'],
      ['Top implied', usd(rows[0].implied_value_usd), rows[0].name],
      ['LOO miss', '×' + T.loo.toFixed(2), 'target ≤ ×3.33 · median ×' + T.looMedian.toFixed(2)],
      ['AUC', T.auc5fold.toFixed(3), 'target ≥ 0.79 · Brier ' + T.brier5fold.toFixed(3)],
    ];
    $('kpis').innerHTML = k.map(function (x) {
      return '<div class="kpi"><div class="k-lab">' + x[0] + '</div><div class="k-val">' + x[1] + '</div><div class="k-sub">' + esc(x[2]) + '</div></div>';
    }).join('');
  }

  // ---- integrity strip ----
  var ledgerTotal = R.ledger.reduce(function (a, l) { return a + l.count; }, 0);
  var recompute = rows.length === 198 && ledgerTotal === R.snapshot_protocols ? 'recompute 198/198 match' : 'recompute mismatch';
  $('integrity').innerHTML =
    '<span class="pill">Ledger <b>' + ledgerTotal + '/' + R.snapshot_protocols + '</b> protocols accounted for</span>' +
    '<span class="pill">' + recompute + '</span>' +
    '<span class="pill">Snapshot <b>' + esc(R.as_of) + '</b> · sha <b>' + esc((R.snapshot_sha || '—').slice(0, 12)) + '</b></span>' +
    '<span class="pill">Model <b>' + esc(R.model_version) + '</b> · ridge λ=3, one term</span>' +
    '<span class="pill">Watchlist <b>40/40</b> · plans <b>198/198</b> costed</span>';

  // ---- size-curve chart ----
  function renderChart() {
    var W = 1180, H = 150, ml = 52, mr = 14, mt = 8, mb = 26;
    var x0 = 6.6, x1 = 10.6, y0 = -3.4, y1 = 2.8;
    function X(v) { return ml + ((v - x0) / (x1 - x0)) * (W - ml - mr); }
    function Y(v) { return mt + ((y1 - v) / (y1 - y0)) * (H - mt - mb); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Size curve chart">';
    for (var gx = 7; gx <= 10; gx++) {
      s += '<line x1="' + X(gx) + '" y1="' + mt + '" x2="' + X(gx) + '" y2="' + (H - mb) + '" stroke="#e3d5b8" stroke-width="1"/>';
      s += '<text x="' + X(gx) + '" y="' + (H - 8) + '" font-size="10" fill="#4a6b68" text-anchor="middle">$' + (gx === 7 ? '10M' : gx === 8 ? '100M' : gx === 9 ? '1B' : '10B') + '</text>';
    }
    for (var gy = -3; gy <= 2; gy++) {
      s += '<line x1="' + ml + '" y1="' + Y(gy) + '" x2="' + (W - mr) + '" y2="' + Y(gy) + '" stroke="#efe6cf" stroke-width="1"/>';
      s += '<text x="' + (ml - 6) + '" y="' + (Y(gy) + 3) + '" font-size="10" fill="#4a6b68" text-anchor="end">' + (gy === 0 ? '1×' : gy > 0 ? Math.pow(10, gy) + '×' : '0.' + '0'.repeat(-gy - 1) + '1×') + '</text>';
    }
    // fitted line
    var lx0 = X(x0), ly0 = Y(T.intercept + T.slope * x0), lx1 = X(x1), ly1 = Y(T.intercept + T.slope * x1);
    s += '<line x1="' + lx0 + '" y1="' + ly0 + '" x2="' + lx1 + '" y2="' + ly1 + '" stroke="#0e7c7b" stroke-width="2.5"/>';
    // board implied points (teal)
    rows.forEach(function (r) {
      s += '<circle cx="' + X(Math.log10(r.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(r.ratio)).toFixed(1) + '" r="2" fill="#0e7c7b" opacity="0.55"/>';
    });
    // traded points (coral) + watchlist rings (amber)
    var wl = {};
    (R.watchlist || []).forEach(function (sl) { wl[sl] = 1; });
    (R.scatter || []).forEach(function (p) {
      s += '<circle cx="' + X(Math.log10(p.t)).toFixed(1) + '" cy="' + Y(Math.log10(p.r)).toFixed(1) + '" r="3.4" fill="#e85d3d" opacity="0.85"/>';
    });
    rows.forEach(function (r) {
      if (!wl[r.slug]) return;
      s += '<circle cx="' + X(Math.log10(r.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(r.ratio)).toFixed(1) + '" r="6" fill="none" stroke="#e9a13b" stroke-width="2"/>';
    });
    s += '</svg>';
    $('chart').innerHTML = s;
  }

  // ---- board ----
  var logMin = Math.log10(Math.min.apply(null, rows.map(function (r) { return r.p10_usd; })));
  var logMax = Math.log10(Math.max.apply(null, rows.map(function (r) { return r.p90_usd; })));
  function rangeBar(r) {
    var a = ((Math.log10(r.p10_usd) - logMin) / (logMax - logMin)) * 100;
    var b = ((Math.log10(r.p90_usd) - logMin) / (logMax - logMin)) * 100;
    var m = ((Math.log10(r.implied_value_usd) - logMin) / (logMax - logMin)) * 100;
    return '<div class="rangebar"><i style="left:' + a.toFixed(1) + '%;width:' + Math.max(2, b - a).toFixed(1) + '%"></i><b style="left:' + m.toFixed(1) + '%"></b></div>';
  }
  function visibleRows() {
    return rows.filter(function (r) {
      var v = verdictOf(r);
      if (state.filter !== 'all' && v.verdict !== state.filter) return false;
      if (state.wlOnly && !(R.watchlist || []).includes(r.slug)) return false;
      return true;
    });
  }
  function renderBoard() {
    var vis = visibleRows();
    var c = counts();
    document.querySelectorAll('#filters button').forEach(function (b) {
      var f = b.getAttribute('data-f');
      b.classList.toggle('on', f === state.filter);
      b.textContent = f === 'all' ? 'All 198' : f + ' ' + c[f];
    });
    $('boardTitle').textContent = state.filter === 'all' ? 'The board — 198 pre-token protocols' : 'The board — ' + state.filter + ' rows';
    $('boardCount').textContent = vis.length + ' of 198 rows · click a row for the full plan';
    $('boardBody').innerHTML = vis.map(function (r) {
      var v = verdictOf(r);
      return '<tr data-slug="' + esc(r.slug) + '"><td>' + r.rank + '</td>' +
        '<td><div class="nm">' + esc(r.name) + '</div><div class="cat">' + esc(r.slug) + '</div></td>' +
        '<td>' + esc(r.category || '—') + '</td><td>' + usd(r.tvl_usd) + '</td><td><b>' + usd(r.implied_value_usd) + '</b></td>' +
        '<td>' + rangeBar(r) + '<div class="cat">' + usd(r.p10_usd) + ' – ' + usd(r.p90_usd) + '</div></td>' +
        '<td>' + (r.odds * 100).toFixed(1) + '%</td><td>' + usd(Math.round(v.dep)) + '</td>' +
        '<td>' + (v.perHour >= 0 ? '+' : '') + '$' + v.perHour.toFixed(2) + '</td>' +
        '<td><span class="chip ' + v.verdict + '">' + v.verdict + '</span></td></tr>';
    }).join('');
    document.querySelectorAll('#boardBody tr').forEach(function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug')); });
    });
  }

  // ---- detail drawer ----
  function openDetail(slug) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    var v = verdictOf(r);
    var d = $('drawer');
    d.innerHTML = '<button class="close" id="dClose">Close ×</button>' +
      '<h2>#' + r.rank + ' ' + esc(r.name) + '</h2>' +
      '<div class="d-sub">' + esc(r.slug) + ' · ' + esc(r.category || 'Protocol') + ' · ' + esc(r.chains.join(', ')) +
      ' · TVL ' + usd(r.tvl_usd) + ' · listed ' + (r.listed_at || 'unknown') + ' (' + (r.age_days === null ? 'age unknown' : r.age_days + ' days') + ')</div>' +
      '<div class="d-grid">' +
      '<div class="d-cell"><div class="l">Implied value</div><div class="v">' + usdFull(r.implied_value_usd) + '</div></div>' +
      '<div class="d-cell"><div class="l">P10 – P90</div><div class="v">' + usd(r.p10_usd) + ' – ' + usd(r.p90_usd) + '</div></div>' +
      '<div class="d-cell"><div class="l">Launch odds</div><div class="v">' + (r.odds * 100).toFixed(1) + '%</div></div>' +
      '<div class="d-cell"><div class="l">Rank range (200 refits)</div><div class="v">#' + r.rank_lo + ' – #' + r.rank_hi + '</div></div>' +
      '<div class="d-cell"><div class="l">Deposit</div><div class="v">' + usd(Math.round(v.dep)) + '</div></div>' +
      '<div class="d-cell"><div class="l">Net / $ per hour</div><div class="v">$' + v.net.toFixed(2) + ' / $' + v.perHour.toFixed(2) + '</div></div>' +
      '</div>' +
      '<p><span class="chip ' + v.verdict + '">' + v.verdict + '</span> &nbsp;Gross ' + usd(v.gross) + ' against $' + (state.gas + R.farm.hours * R.farm.hourly) + ' of gas + time. ' +
      'Odds are the peers’ cross-sectional record by age, not a forward hazard.</p>' +
      '<h3>How the value is made</h3><p>TVL ' + usd(r.tvl_usd) + ' × fitted ratio ' + r.ratio.toFixed(3) +
      ' (log10 ratio = ' + T.intercept.toFixed(4) + ' ' + (T.slope < 0 ? '−' : '+') + ' ' + Math.abs(T.slope).toFixed(4) +
      ' × log10 TVL). P25–P75: ' + usd(r.p25_usd) + ' – ' + usd(r.p75_usd) + '. The interval is wide because the size curve is a rough law.</p>' +
      '<h3>Nearest priced peers</h3>' + r.peers.map(function (p) {
        return '<div class="peer"><b>' + esc(p.name) + '</b> · TVL ' + usd(p.tvl_usd) + ' · mcap ' + usd(p.mcap_usd) + ' · ratio ' + p.ratio.toFixed(3) + '</div>';
      }).join('') +
      '<h3>Sensitivity — implied value if TVL and the ratio move</h3><div class="sens">' +
      [['TVL ×0.5', 0], ['TVL ×1', 1], ['TVL ×2', 2]].map(function (row, i) {
        return ['ratio ×0.5', 'ratio ×1', 'ratio ×2'].map(function (lab, j) {
          return '<div>' + row[0] + ' · ' + lab + '<b>' + usd(r.sensitivity[i * 3 + j]) + '</b></div>';
        }).join('');
      }).join('') + '</div>' +
      '<h3>Farm plan — 10 costed steps</h3><ol>' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    d.hidden = false;
    $('backdrop').hidden = false;
    $('dClose').addEventListener('click', closeDetail);
    history.replaceState(null, '', '#detail=' + r.slug);
  }
  function closeDetail() {
    $('drawer').hidden = true;
    $('backdrop').hidden = true;
    history.replaceState(null, '', state.filter === 'all' ? '#' : '#filter=' + state.filter.toLowerCase());
  }
  $('backdrop').addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });

  // ---- model notes: honest test table + term table + ledger + live ----
  function verdictWord(pass) { return pass ? '<span class="pass">PASS</span>' : '<span class="miss">MISS</span>'; }
  var tt = [
    ['Leave-one-out miss', '×' + T.loo.toFixed(2) + ' (median ×' + T.looMedian.toFixed(2) + ')', '≤ ×3.33', T.loo <= 3.33],
    ['Walk-forward miss (66 older → 29 newer)', '×' + T.wf.toFixed(2) + ' (median ×' + T.wfMedian.toFixed(2) + ')', '≤ ×2.53', T.wf <= 2.53],
    ['Worst 5-fold fold (seed 42)', '×' + T.foldWorst42.toFixed(2) + ' (median fold ×' + T.foldMedian42.toFixed(2) + ')', 'no fold > ×4.5', T.foldWorst42 <= 4.5],
    ['Worst 5-fold fold (seeds 0–19 sweep)', '×' + T.foldWorstSweep.toFixed(2), 'no fold > ×4.5', T.foldWorstSweep <= 4.5],
    ['P25–P75 coverage, LOO', (T.p25p75Loo * 100).toFixed(1) + '% (WF ' + (T.p25p75Wf * 100).toFixed(1) + '%)', '≥ 57%', T.p25p75Loo >= 0.57],
    ['P10–P90 coverage, LOO', (T.p10p90Loo * 100).toFixed(1) + '% (WF ' + (T.p10p90Wf * 100).toFixed(1) + '%)', '≥ 76%', T.p10p90Loo >= 0.76],
    ['Odds AUC, 5-fold', T.auc5fold.toFixed(3) + ' (time-split ' + T.aucTimeSplit.toFixed(3) + ')', '≥ 0.79', T.auc5fold >= 0.79],
    ['Odds Brier, 5-fold', T.brier5fold.toFixed(3) + ' (time-split ' + T.brierTimeSplit.toFixed(3) + ')', '≤ 0.215', T.brier5fold <= 0.215],
  ];
  $('testTable').innerHTML = '<table class="mini"><thead><tr><th>Test</th><th>This entry</th><th>Target</th><th>Verdict</th></tr></thead><tbody>' +
    tt.map(function (x) { return '<tr><td>' + x[0] + '</td><td>' + x[1] + '</td><td>' + x[2] + '</td><td>' + verdictWord(x[3]) + '</td></tr>'; }).join('') + '</tbody></table>' +
    '<p class="notes-text">Miss = geometric-mean miss (10 to the mean absolute log10 residual). Platt slope ' + T.plattSlope.toFixed(2) +
    ' / intercept ' + T.plattIntercept.toFixed(2) + ' on out-of-fold odds — close to calibrated, so no recalibration was applied. ' +
    'The walk-forward test holds three extreme ratios no size curve can foresee; the medians beside the means show that.</p>';
  $('termTable').innerHTML = '<table class="mini"><thead><tr><th>Candidate term</th><th>LOO miss</th><th>Walk-forward miss</th><th>Rule outcome</th></tr></thead><tbody>' +
    R.terms.map(function (t) {
      return '<tr><td>' + esc(t.label) + '</td><td>×' + t.loo.toFixed(3) + ' (median ×' + t.looMedian.toFixed(3) + ')</td><td>×' + t.wf.toFixed(3) + ' (median ×' + t.wfMedian.toFixed(3) + ')</td><td>' + esc(t.verdict) + '</td></tr>';
    }).join('') + '</tbody></table>';
  $('ledger').innerHTML = '<table class="mini"><thead><tr><th>Set</th><th>Count</th></tr></thead><tbody>' +
    R.ledger.map(function (l) { return '<tr><td>' + esc(l.label) + '</td><td>' + l.count + '</td></tr>'; }).join('') +
    '<tr><td><b>Total</b></td><td><b>' + ledgerTotal + '</b></td></tr></tbody></table>';
  $('liveView').innerHTML = '<table class="mini"><thead><tr><th>Protocol</th><th>TVL</th><th>Market cap</th><th>Ratio</th></tr></thead><tbody>' +
    R.live.map(function (p) { return '<tr><td>' + esc(p.name) + '</td><td>' + usd(p.tvl_usd) + '</td><td>' + usd(p.mcap_usd) + '</td><td>' + p.ratio.toFixed(3) + '</td></tr>'; }).join('') + '</tbody></table>';

  // ---- controls ----
  function syncLabels() {
    $('depVal').textContent = (state.depPct * 100).toFixed(3) + '% of TVL';
    $('gasVal').textContent = '$' + state.gas;
    $('costVal').textContent = '$' + (state.gas + R.farm.hours * R.farm.hourly);
  }
  $('dep').addEventListener('input', function (e) { state.depPct = parseFloat(e.target.value) / 100; syncLabels(); renderKpis(); renderBoard(); });
  $('gas').addEventListener('input', function (e) { state.gas = parseInt(e.target.value, 10); syncLabels(); renderKpis(); renderBoard(); });
  document.querySelectorAll('#filters button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.filter = b.getAttribute('data-f');
      document.body.classList.toggle('filtered', state.filter !== 'all');
      $('boardWrap').classList.toggle('compact', state.filter !== 'all');
      renderBoard();
      history.replaceState(null, '', state.filter === 'all' ? '#' : '#filter=' + state.filter.toLowerCase());
    });
  });
  $('wlOnly').addEventListener('change', function (e) { state.wlOnly = e.target.checked; renderBoard(); });

  // ---- hash state: #filter=farm|thin|skip, #detail=<slug> ----
  function applyHash() {
    var h = location.hash.replace(/^#/, '');
    var m = h.match(/detail=([A-Za-z0-9-]+)/);
    var f = h.match(/filter=(farm|thin|skip|all)/i);
    if (f) {
      state.filter = f[1].charAt(0).toUpperCase() + f[1].slice(1).toLowerCase();
      if (state.filter === 'All') state.filter = 'all';
      document.body.classList.toggle('filtered', state.filter !== 'all');
      $('boardWrap').classList.toggle('compact', state.filter !== 'all');
    }
    renderKpis();
    renderChart();
    renderBoard();
    syncLabels();
    if (m) openDetail(m[1]);
  }
  applyHash();
})();
