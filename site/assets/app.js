// Fondflöden – klientlogik.
// Data byggs av scripts/build-data.ps1:
//   data/index.json            kvartal som finns
//   data/<kvartal>.json        svenska aktier + nyckeltal för alla fonder
//   data/<kvartal>-world.json  utländska aktier
//   data/history.json          ägande och nettoköp per aktie sedan 2018
(function () {
  "use strict";

  var INDEX_RE = /index|indx|\bomx|passiv|tracker|\betf\b|\bzero\b/i;

  // Gränser för "indexnära men dyr": aktiv risk under 3 % och avgift på minst 0,7 %
  var CLOSET_AR = 3;
  var CLOSET_FEE = 0.7;

  // Kända aktiva fonder (FI:s institutnummer) som visas under Förvaltare
  var FEATURED = ["51272", "51718", "60730", "51545", "51670", "60908", "51540", "51791", "51381",
    "60503", "60012", "60214", "51760", "51669", "60194", "51318", "51544"];

  var CONTACT = ["axelsfondfloden", "gmail.com"].join("@");

  var nf0 = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 });
  var nf1 = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf2 = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var regionNames = null;
  try { regionNames = new Intl.DisplayNames(["sv"], { type: "region" }); } catch (e) { /* äldre webbläsare */ }

  var app = document.getElementById("app");
  var state = {
    index: null,
    q: null,
    market: "se",           // "se" eller "world"
    excludeIndex: false,
    data: {},               // kvartal -> { se, world, fi }
    history: null,
    loading: {},
    sorts: {},
    charts: []
  };

  // ---------- Formatering ----------

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fixMinus(s) { return s.replace(/^-/, "−"); }
  function signed(s, v) { return v > 0 ? "+" + s : fixMinus(s); }
  function mkr(v, withSign) {
    if (v == null || !isFinite(v)) return "–";
    var m = v / 1e6;
    var s = Math.abs(m) >= 100 ? nf0.format(m) : nf1.format(m);
    return withSign ? signed(s, m) : fixMinus(s);
  }
  function bigSek(v, withSign) {
    if (v == null || !isFinite(v)) return "–";
    var s = Math.abs(v) >= 1e9 ? nf1.format(v / 1e9) + " mdkr" : nf0.format(v / 1e6) + " mkr";
    return withSign ? signed(s, v) : fixMinus(s);
  }
  function msek(m, withSign) { return m == null ? "–" : mkr(m * 1e6, withSign); }
  function pct(v, decimals) {
    if (v == null || !isFinite(v)) return "–";
    var s = (decimals ? nf1 : nf0).format(v * 100) + " %";
    return signed(s, v);
  }
  function pctPlain(v, digits) { return v == null ? "–" : (digits === 2 ? nf2 : nf1).format(v) + " %"; }
  function int(v) { return nf0.format(v || 0); }
  function cls(v) { return v > 0 ? "pos" : v < 0 ? "neg" : ""; }
  function quarterLabel(id) { return id ? "Q" + id.slice(5) + " " + id.slice(0, 4) : ""; }
  function countryName(code) {
    if (!code) return "";
    try { return regionNames ? regionNames.of(code) : code; } catch (e) { return code; }
  }
  function prettyName(name) {
    if (!name || name !== name.toUpperCase()) return name || "";
    return name.split(/(\s+)/).map(function (w) {
      return w.length > 3 && /^[A-ZÅÄÖÉÜ]/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w;
    }).join("");
  }
  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { return null; }
  }
  function stockHref(s) { return "#/aktie/" + s.isin; }
  function fundHref(f) { return "#/fond/" + encodeURIComponent(f.id); }
  function feeText(f) {
    if (f.feeMax == null) return "–";
    return f.feeMin != null && f.feeMin < f.feeMax ? nf2.format(f.feeMin) + "–" + nf2.format(f.feeMax) + " %" : nf2.format(f.feeMax) + " %";
  }

  // ---------- Data ----------

  function getJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(url + ": " + r.status);
      return r.json();
    });
  }

  // Laddar något en gång och ritar om sidan när det är klart
  function need(key, loader) {
    if (state.loading[key] === "done") return true;
    if (!state.loading[key]) {
      state.loading[key] = "pending";
      loader().then(function () { state.loading[key] = "done"; render(); }, function (err) {
        console.error(err);
        state.loading[key] = "error";
        render();
      });
    }
    return false;
  }
  function failed(key) { return state.loading[key] === "error"; }

  function quarterData() { return state.data[state.q]; }

  function loadSe(q) {
    return getJSON("data/" + q + ".json").then(function (raw) {
      var d = state.data[q] = state.data[q] || {};
      d.fi = {};
      (raw.fundInfo || []).forEach(function (x) {
        d.fi[x[0]] = { id: x[0], name: x[1], co: x[2], bench: x[3], aum: x[4], feeMin: x[5], feeMax: x[6], perf: !!x[7],
          ar: x[8], sd: x[9], eq: x[10], nStocks: x[11], isIndex: INDEX_RE.test(x[1]) };
      });
      d.meta = raw.meta;
      d.se = prepare(raw);
    });
  }
  function needWorld() {
    var q = state.q;
    return need("world-" + q, function () {
      return getJSON("data/" + q + "-world.json").then(function (raw) { state.data[q].world = prepare(raw); });
    });
  }
  function needHistory() {
    return need("history", function () {
      return getJSON("data/history.json").then(function (h) {
        h.qIndex = {};
        h.quarters.forEach(function (q, i) { h.qIndex[q] = i; });
        state.history = h;
      });
    });
  }

  function prepare(raw) {
    var ds = { raw: raw };
    ds.funds = raw.funds.map(function (x) {
      return { id: x[0], name: x[1], co: x[2], bench: x[3], aum1: x[4], aum2: x[5], h: x[6], isIndex: INDEX_RE.test(x[1]) };
    });
    ds.fundById = {};
    ds.funds.forEach(function (f) { ds.fundById[f.id] = f; });
    compute(ds);
    return ds;
  }

  // Räknar fram per aktie och per fond. Förändringar räknas bara för fonder som rapporterat båda kvartalen.
  function compute(ds) {
    var stocks = ds.raw.stocks.map(function (s, i) {
      return {
        i: i, isin: s[0], name: prettyName(s[1]), sector: s[2] || "Övrigt", price: s[3] || 0, split: s[4], country: s[5] || "",
        h2: 0, f2: 0, h1b: 0, h2b: 0, f1b: 0, f2b: 0, flow: 0, nNew: 0, nExit: 0, trades: []
      };
    });
    var t = { funds: 0, buy: 0, sell: 0, value: 0, held: 0 };
    ds.funds.forEach(function (f) {
      var both = f.aum1 != null && f.aum2 != null;
      f.both = both;
      f.val = 0; f.bought = 0; f.sold = 0; f.nHold = 0;
      var excluded = state.excludeIndex && f.isIndex;
      if (both && !excluded) t.funds++;
      f.h.forEach(function (r) {
        var s = stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0, d = (s2 - s1) * s.price;
        if (s2 && f.aum2 != null) { f.val += s2 * s.price; f.nHold++; }
        if (both) { if (d > 0) f.bought += d; else f.sold += d; }
        if (excluded) return;
        if (s2 && f.aum2 != null) { s.h2 += s2; s.f2++; }
        if (!both) return;
        if (s1) s.f1b++;
        if (s2) s.f2b++;
        s.h1b += s1; s.h2b += s2; s.flow += d;
        if (!s1 && s2) s.nNew++;
        if (s1 && !s2) s.nExit++;
        if (s1 !== s2) s.trades.push({ f: f, s1: s1, s2: s2, d: d });
      });
    });
    stocks.forEach(function (s) {
      s.val2 = s.h2 * s.price;
      s.val1 = s.h1b * s.price;
      s.chg = s.h1b ? (s.h2b - s.h1b) / s.h1b : null;
      s.dF = s.f2b - s.f1b;
      // Ingen fond ägde aktien förra kvartalet (notering, avknoppning, nytt aktieslag)
      // eller ingen äger den längre (uppköp, avnotering). Räknas inte som köp eller sälj.
      s.isNew = s.h1b === 0 && s.h2b > 0;
      s.isGone = s.h2b === 0 && s.h1b > 0;
      s.netFlow = s.isNew || s.isGone ? null : s.flow;
      if (s.f2) t.held++;
      t.value += s.val2;
      if (s.netFlow > 0) t.buy += s.netFlow; else if (s.netFlow < 0) t.sell += s.netFlow;
    });
    ds.stocks = stocks;
    ds.byIsin = {};
    stocks.forEach(function (s) { ds.byIsin[s.isin] = s; });
    ds.totals = t;
  }

  function recomputeAll() {
    Object.keys(state.data).forEach(function (q) {
      var d = state.data[q];
      if (d.se) compute(d.se);
      if (d.world) compute(d.world);
    });
  }

  // Aktuell marknad: returnerar dataset eller null medan det laddas
  function marketDs() {
    var d = quarterData();
    if (state.market === "se") return d.se;
    return needWorld() ? d.world : null;
  }

  // ---------- Historik ----------

  function histFor(isin) {
    var h = state.history;
    if (!h || !h.stocks[isin]) return null;
    var e = h.stocks[isin];
    var byQ = {};
    e[3].forEach(function (r) { byQ[r[0]] = r; });
    return { name: prettyName(e[0]), sector: e[1], country: e[2], byQ: byQ };
  }

  function flowOf(r) { return r ? (state.excludeIndex ? r[4] : r[3]) : null; }

  // Antal kvartal i rad (bakåt från valt kvartal) med nettoköp eller nettosälj
  function streak(hs, qi) {
    var first = flowOf(hs.byQ[qi]);
    if (first == null || Math.abs(first) < 0.5) return { n: 0, sign: 0, sum: 0 };
    var sign = first > 0 ? 1 : -1, n = 0, sum = 0;
    for (var k = qi; k >= 0; k--) {
      var v = flowOf(hs.byQ[k]);
      if (v == null || Math.abs(v) < 0.5 || (v > 0 ? 1 : -1) !== sign) break;
      n++; sum += v;
    }
    return { n: n, sign: sign, sum: sum };
  }

  function streakList(ds, sign) {
    var h = state.history, qi = h.qIndex[state.q];
    if (qi == null) return [];
    var out = [];
    ds.stocks.forEach(function (s) {
      if (s.val2 < 100e6 || s.isNew || s.isGone) return;
      var hs = histFor(s.isin);
      if (!hs) return;
      var st = streak(hs, qi);
      if (st.sign === sign && st.n >= 2) out.push({ s: s, n: st.n, sum: st.sum });
    });
    return out.sort(function (a, b) { return b.n - a.n || Math.abs(b.sum) - Math.abs(a.sum); });
  }

  // ---------- Tabeller ----------

  // cols: { key, label, align, cls, hideSm, cell(row, n), value(row) }
  function table(key, cols, rows, opts) {
    opts = opts || {};
    var sort = state.sorts[key] || opts.sort;
    if (sort && !opts.static) {
      var col = cols.filter(function (c) { return c.key === sort.col; })[0];
      if (col && col.value) {
        rows = rows.slice().sort(function (a, b) {
          var x = col.value(a), y = col.value(b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          if (typeof x === "string") return sort.dir * x.localeCompare(y, "sv");
          return sort.dir * (x - y);
        });
      }
    }
    if (opts.limit) rows = rows.slice(0, opts.limit);
    var head = cols.map(function (c) {
      var thCls = [c.align === "l" ? "l" : "", c.hideSm ? "hide-sm" : ""].join(" ").trim();
      var al = thCls ? ' class="' + thCls + '"' : "";
      if (!c.value || opts.static) return "<th" + al + ' scope="col">' + c.label + "</th>";
      var active = sort && sort.col === c.key;
      var aria = active ? ' aria-sort="' + (sort.dir > 0 ? "ascending" : "descending") + '"' : "";
      var arrow = active ? (sort.dir > 0 ? " ▲" : " ▼") : "";
      return "<th" + al + aria + ' scope="col"><button type="button" data-sort="' + key + ":" + c.key + '">' + c.label + arrow + "</button></th>";
    }).join("");
    var body = rows.map(function (r, n) {
      return "<tr>" + cols.map(function (c) {
        var classes = [c.align === "l" ? "l" : "", c.cls || "", c.hideSm ? "hide-sm" : ""].join(" ").trim();
        return "<td" + (classes ? ' class="' + classes + '"' : "") + ">" + c.cell(r, n) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    if (!rows.length) body = '<tr><td class="empty" colspan="' + cols.length + '">' + (opts.empty || "Inga rader.") + "</td></tr>";
    return '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }

  function bar(value, max, kind) {
    var w = max ? Math.max(1, Math.min(100, Math.abs(value) / max * 100)) : 0;
    return '<span class="bar ' + kind + '"><i style="width:' + w.toFixed(1) + '%"></i></span>';
  }

  function changeLabel(s1, s2) {
    if (!s1 && s2) return '<span class="label new">Ny</span>';
    if (s1 && !s2) return '<span class="label out">Avvecklad</span>';
    if (s2 > s1) return '<span class="label up">Ökad</span>';
    if (s2 < s1) return '<span class="label down">Minskad</span>';
    return '<span class="label">Oförändrad</span>';
  }

  // Namncell med en extra rad som bara visas på mobil, där kolumnerna den ersätter är dolda.
  function nameCell(href, name, sub) {
    return '<a href="' + href + '">' + esc(name) + "</a>" + (sub ? '<span class="sub show-sm">' + sub + "</span>" : "");
  }

  function stockCol(subFn) {
    return { key: "name", label: "Aktie", align: "l", cls: "name", value: function (s) { return s.name; },
      cell: function (s) { return nameCell(stockHref(s), s.name, subFn && subFn(s)); } };
  }

  var col = {
    rank: { key: "rank", label: "#", cls: "rank", hideSm: true, cell: function (r, n) { return n + 1; } },
    stock: stockCol(),
    sector: { key: "sector", label: "Sektor", align: "l", cls: "muted", hideSm: true, cell: function (s) { return esc(s.sector); }, value: function (s) { return s.sector; } },
    country: { key: "country", label: "Land", align: "l", cls: "muted", hideSm: true, cell: function (s) { return esc(countryName(s.country)); }, value: function (s) { return countryName(s.country); } },
    funds: { key: "f2", label: "Fonder", hideSm: true, cell: function (s) { return int(s.f2); }, value: function (s) { return s.f2; } },
    dFunds: { key: "dF", label: "Δ fonder", hideSm: true, cell: function (s) { return '<span class="' + cls(s.dF) + '">' + (s.dF ? signed(String(s.dF), s.dF) : "0") + "</span>"; }, value: function (s) { return s.dF; } },
    value: { key: "val2", label: "Innehav (mkr)", hideSm: true, cell: function (s) { return mkr(s.val2); }, value: function (s) { return s.val2; } },
    flow: { key: "flow", label: "Nettoköp (mkr)", cell: function (s) {
      if (s.isNew) return '<span class="label new">Ny</span>';
      if (s.isGone) return '<span class="label out">Borta</span>';
      return '<span class="' + cls(s.flow) + '">' + mkr(s.flow, true) + "</span>";
    }, value: function (s) { return s.netFlow; } },
    chg: { key: "chg", label: "Δ antal aktier", cell: function (s) { return '<span class="' + cls(s.chg) + '">' + pct(s.chg) + "</span>"; }, value: function (s) { return s.isNew || s.isGone ? null : s.chg; } }
  };

  function flowCol(max) {
    return { key: "flow", label: "Nettoköp (mkr)", cell: function (s) {
      return '<span class="barcell"><span class="' + cls(s.flow) + '">' + mkr(s.flow, true) + "</span>" + bar(s.flow, max, s.flow >= 0 ? "pos" : "neg") + "</span>";
    } };
  }

  // ---------- Byggstenar ----------

  function block(title, desc, inner, extraCls) {
    return '<section class="block' + (extraCls ? " " + extraCls : "") + '"><div class="block-head"><h2>' + title + "</h2></div>" +
      (desc ? '<p class="desc">' + desc + "</p>" : "") + inner + "</section>";
  }
  function fig(label, value, note) {
    return "<div><dt>" + label + "</dt><dd>" + value + "</dd>" + (note ? '<span class="fig-note">' + note + "</span>" : "") + "</div>";
  }
  function loadingBlock(text) { return '<div class="loading"><span class="spinner" aria-hidden="true"></span>' + (text || "Laddar…") + "</div>"; }
  function errorBlock() { return '<div class="notice">Datan kunde inte laddas. Ladda om sidan för att försöka igen.</div>'; }
  function notFound(msg) { return '<div class="notice">' + esc(msg) + ' <a href="#/">Till översikten</a></div>'; }

  // Diagram ritas efter att sidan satts in, och ritas om när fönstrets bredd ändras
  function chart(draw) {
    var id = "chart-" + state.charts.length;
    state.charts.push({ id: id, draw: draw });
    return '<div class="chart" id="' + id + '"></div>';
  }
  function drawCharts() {
    state.charts.forEach(function (c) {
      var node = $(c.id);
      if (node) c.draw(node);
    });
  }

  function marketWord() { return state.market === "se" ? "svenska" : "utländska"; }

  // ---------- Översikt ----------

  function viewOverview() {
    var ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar utländska aktier…");
    var S = ds.stocks;
    var cont = S.filter(function (s) { return s.price && !s.isNew && !s.isGone; });
    var buys = cont.filter(function (s) { return s.flow > 0; }).sort(function (a, b) { return b.flow - a.flow; }).slice(0, 15);
    var sells = cont.filter(function (s) { return s.flow < 0; }).sort(function (a, b) { return a.flow - b.flow; }).slice(0, 15);
    var news = cont.filter(function (s) { return s.nNew > 0; }).sort(function (a, b) { return b.nNew - a.nNew || b.flow - a.flow; }).slice(0, 10);
    var exits = cont.filter(function (s) { return s.nExit > 0; }).sort(function (a, b) { return b.nExit - a.nExit || a.flow - b.flow; }).slice(0, 10);
    var arrived = S.filter(function (s) { return s.isNew; }).sort(function (a, b) { return b.val2 - a.val2; }).slice(0, 10);
    var gone = S.filter(function (s) { return s.isGone; }).sort(function (a, b) { return b.val1 - a.val1; }).slice(0, 10);
    var maxFlow = Math.max(buys.length ? buys[0].flow : 0, sells.length ? -sells[0].flow : 0);

    var fundsWide = { key: "f2", label: "Fonder", hideSm: true, cell: col.funds.cell };
    var flowCols = [col.rank, col.stock, flowCol(maxFlow), col.chg, fundsWide];
    var plainFlow = { key: "flow", label: "Nettoköp (mkr)", cell: function (s) { return '<span class="' + cls(s.flow) + '">' + mkr(s.flow, true) + "</span>"; } };
    var newCols = [col.rank, col.stock, { key: "n", label: "Nya fonder", cell: function (s) { return '<span class="pos">+' + s.nNew + "</span>"; } }, plainFlow, fundsWide];
    var exitCols = [col.rank, col.stock, { key: "n", label: "Avvecklat", cell: function (s) { return '<span class="neg">−' + s.nExit + "</span>"; } }, plainFlow, fundsWide];
    var arrivedCols = [col.rank, col.stock, { key: "v", label: "Innehav (mkr)", cell: function (s) { return mkr(s.val2); } }, { key: "f", label: "Fonder", cell: function (s) { return int(s.f2); } }];
    var goneCols = [col.rank, col.stock, { key: "v", label: "Förra kv. (mkr)", cell: function (s) { return mkr(s.val1); } }, { key: "f", label: "Fonder", cell: function (s) { return int(s.f1b); } }];
    var st = { static: true };

    // Köpsviter kräver historiken
    var hasHist = needHistory();
    var buyStreaks = hasHist ? streakList(ds, 1) : null;
    var sellStreaks = hasHist ? streakList(ds, -1) : null;
    var streakCols = function (sign) {
      return [col.rank, col.stock,
        { key: "n", label: "Kvartal i rad", cell: function (r) { return '<span class="streak ' + (sign > 0 ? "pos" : "neg") + '">' + r.n + "</span>"; } },
        { key: "sum", label: "Summa (mkr)", cell: function (r) { return '<span class="' + cls(r.sum) + '">' + msek(r.sum, true) + "</span>"; } }];
    };
    var streakRows = function (list) { return list.map(function (r) { r.name = r.s.name; r.isin = r.s.isin; return r; }); };

    var top = buys[0], bottom = sells[0], longest = buyStreaks && buyStreaks[0];
    var highlights = '<div class="highlights">' +
      highlight("Mest köpt", top && top.name, top && stockHref(top), top ? '<span class="pos">' + bigSek(top.flow, true) + "</span>" : "", top ? int(top.nNew) + " nya fonder" : "") +
      highlight("Mest sålt", bottom && bottom.name, bottom && stockHref(bottom), bottom ? '<span class="neg">' + bigSek(bottom.flow, true) + "</span>" : "", bottom ? int(bottom.nExit) + " fonder sålde allt" : "") +
      (hasHist ? highlight("Längsta köpsvit", longest && longest.s.name, longest && stockHref(longest.s), longest ? longest.n + " kvartal i rad" : "Ingen", longest ? msek(longest.sum, true) + " mkr under perioden" : "")
        : highlight("Längsta köpsvit", null, null, '<span class="muted">Laddar…</span>', "")) +
      "</div>";

    return watchBlock() + highlights +
      '<div class="grid-2 section-gap">' +
      block("Störst nettoköp", "Förändring i antal aktier × kurs vid kvartalsslut", table("ov-buy", flowCols, buys, st) + '<a class="more" href="#/aktier">Alla aktier →</a>') +
      block("Störst nettosälj", "&nbsp;", table("ov-sell", flowCols, sells, st)) +
      "</div>" +
      sectorBlock(hasHist) +
      '<div class="grid-2 section-gap">' +
      block("Längsta köpsviter", "Aktier som fonderna nettoköpt flest kvartal i rad", buyStreaks ? table("ov-bs", streakCols(1), streakRows(buyStreaks.slice(0, 10)), st) : loadingBlock("Laddar historik…")) +
      block("Längsta säljsviter", "Aktier som fonderna nettosålt flest kvartal i rad", sellStreaks ? table("ov-ss", streakCols(-1), streakRows(sellStreaks.slice(0, 10)), st) : loadingBlock("Laddar historik…")) +
      "</div>" +
      '<div class="grid-2 section-gap">' +
      block("Flest nya fondägare", "Fonder som inte ägde aktien förra kvartalet", table("ov-new", newCols, news, st)) +
      block("Flest avvecklade innehav", "Fonder som sålt hela sitt innehav", table("ov-exit", exitCols, exits, st)) +
      "</div>" +
      '<div class="grid-2 section-gap">' +
      block("Nya i fonderna", "Ägdes inte av någon fond förra kvartalet: noteringar, avknoppningar, nya aktieslag. Räknas inte som köp.", table("ov-arr", arrivedCols, arrived, st)) +
      block("Borta ur fonderna", "Ägs inte längre av någon fond: uppköp, avnoteringar, byte av aktieslag. Räknas inte som sälj.", table("ov-gone", goneCols, gone, st)) +
      "</div>";
  }

  function highlight(label, name, href, value, note) {
    return '<div class="hl"><div class="hl-label">' + label + "</div>" +
      (!name ? '<div class="hl-name muted">–</div>' : href ? '<a class="hl-name" href="' + href + '">' + esc(name) + "</a>" : '<div class="hl-name">' + esc(name) + "</div>") +
      '<div class="hl-value">' + value + "</div>" + (note ? '<div class="hl-note">' + note + "</div>" : "") + "</div>";
  }

  // ---------- Aktier ----------

  var stockFilter = { q: "", sector: "", min: "100" };

  function viewStocks() {
    var ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar utländska aktier…");
    var sectors = {};
    ds.stocks.forEach(function (s) { if (s.f2 || s.f1b) sectors[s.sector] = 1; });
    var sectorOpts = Object.keys(sectors).sort(function (a, b) { return a.localeCompare(b, "sv"); }).map(function (x) {
      return '<option value="' + esc(x) + '"' + (stockFilter.sector === x ? " selected" : "") + ">" + esc(x) + "</option>";
    }).join("");
    var minOpts = [["0", "Alla storlekar"], ["10", "Över 10 mkr"], ["100", "Över 100 mkr"], ["1000", "Över 1 000 mkr"]].map(function (o) {
      return '<option value="' + o[0] + '"' + (stockFilter.min === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
    }).join("");
    return '<div class="page-head"><h1>' + (state.market === "se" ? "Svenska aktier" : "Utländska aktier") + '</h1><p class="meta">Aktier som ägs av svenska fonder, ' +
      quarterLabel(state.q) + " jämfört med " + quarterLabel(quarterData().meta.prevId) + ".</p></div>" +
      '<div class="toolbar">' +
      '<input class="input" type="search" id="stockSearch" placeholder="Sök aktie eller ISIN" value="' + esc(stockFilter.q) + '" autocomplete="off">' +
      '<select class="select-sm" id="stockSector" aria-label="Sektor"><option value="">Alla sektorer</option>' + sectorOpts + "</select>" +
      '<select class="select-sm" id="stockMin" aria-label="Minsta fondinnehav" title="Fondernas sammanlagda innehav i aktien">' + minOpts + "</select>" +
      '<span class="count" id="stockCount"></span></div>' +
      '<div id="stockTable"></div>';
  }

  function renderStockTable() {
    var ds = marketDs();
    if (!ds || !$("stockTable")) return;
    var q = stockFilter.q.trim().toLowerCase(), min = +stockFilter.min * 1e6;
    var rows = ds.stocks.filter(function (s) {
      if (!s.f2 && !s.f1b) return false;
      if (Math.max(s.val2, s.val1) < min) return false;
      if (stockFilter.sector && s.sector !== stockFilter.sector) return false;
      return !q || s.name.toLowerCase().indexOf(q) >= 0 || s.isin.toLowerCase().indexOf(q) >= 0;
    });
    var world = state.market === "world";
    var nameWithSub = stockCol(function (s) { return (world && s.country ? esc(countryName(s.country)) + " · " : "") + esc(s.sector) + " · " + int(s.f2) + " fonder · " + mkr(s.val2) + " mkr"; });
    var cols = [nameWithSub].concat(world ? [col.country] : [], [col.sector, col.funds, col.dFunds, col.value, col.flow, col.chg]);
    $("stockTable").innerHTML = table("stocks-" + state.market, cols, rows, { sort: { col: "flow", dir: -1 }, empty: "Inga aktier matchar filtret." });
    $("stockCount").textContent = int(rows.length) + " aktier";
  }

  // ---------- Aktie ----------

  function viewStock(isin) {
    var d = quarterData();
    var s = d.se.byIsin[isin];
    if (!s) {
      if (!needWorld()) return failed("world-" + state.q) ? errorBlock() : loadingBlock();
      s = d.world.byIsin[isin];
    }
    var hasHist = needHistory();
    var hs = hasHist ? histFor(isin) : null;
    if (!s && !hs) return notFound("Aktien finns inte i " + quarterLabel(state.q) + ".");
    var name = s ? s.name : hs.name;
    document.title = name + " – Fondflöden";
    var world = isin.slice(0, 2) !== "SE";
    var crumbs = '<div class="crumbs"><a href="#/aktier" data-market="' + (world ? "world" : "se") + '">' + (world ? "Utländska aktier" : "Aktier") + "</a> / " + esc(name) + "</div>";
    var metaParts = [];
    if (s ? s.sector : hs.sector) metaParts.push(esc(s ? s.sector : hs.sector));
    if (world) metaParts.push(esc(countryName(s ? s.country : hs.country)));
    metaParts.push(esc(isin));
    if (s && s.price) metaParts.push("Kurs " + nf1.format(s.price) + " kr (" + esc(d.meta.curr) + ")");
    if (s && s.split) metaParts.push("Splitjusterad ×" + nf1.format(s.split));

    var html = '<div class="page-head">' + crumbs + '<div class="title-row"><h1>' + esc(name) + "</h1>" + starBtn("stocks", isin) + '</div><p class="meta">' + metaParts.join(" · ") + "</p></div>";

    if (s) {
      html += '<dl class="figures">' +
        fig("Fonder som äger", int(s.f2)) + fig("Fondernas innehav", bigSek(s.val2)) +
        fig("Nettoköp " + quarterLabel(state.q), s.netFlow == null ? "–" : '<span class="' + cls(s.flow) + '">' + bigSek(s.flow, true) + "</span>") +
        fig("Δ antal aktier", '<span class="' + cls(s.chg) + '">' + pct(s.chg, true) + "</span>") +
        fig("Nya fonder", int(s.nNew)) + fig("Avvecklat", int(s.nExit)) + "</dl>";
      if (s.isNew) html += '<p class="notice">Ingen fond ägde aktien förra kvartalet. Det beror oftast på en notering, avknoppning eller ett nytt aktieslag, så innehaven räknas inte som köp i översikten.</p>';
      if (s.isGone) html += '<p class="notice">Ingen fond äger aktien längre. Det beror oftast på uppköp, avnotering eller byte av aktieslag.</p>';
    }

    html += '<section class="block section-gap"><div class="block-head"><h2>Historik</h2>';
    if (!hasHist) {
      html += "</div>" + (failed("history") ? errorBlock() : loadingBlock("Laddar historik…")) + "</section>";
    } else if (!hs) {
      html += '</div><p class="desc">Det finns ingen historik för den här aktien. Små innehav tas inte med.</p></section>';
    } else {
      var h = state.history, qi = h.qIndex[state.q];
      var st = qi != null ? streak(hs, qi) : { n: 0 };
      if (st.n >= 2) html += '<span class="pill ' + (st.sign > 0 ? "pos" : "neg") + '">' + (st.sign > 0 ? "Nettoköpt " : "Nettosålt ") + st.n + " kvartal i rad</span>";
      html += "</div>";
      var pts = h.quarters.map(function (q, i) {
        var r = hs.byQ[i];
        return { q: q, value: r ? flowOf(r) : null, funds: r ? r[1] : null, val: r ? r[2] : null, highlight: q === state.q };
      });
      var flowPts = pts.slice(1);
      html += '<div class="grid-2 charts">' +
        '<div class="chart-card"><div class="chart-title">Nettoköp per kvartal <span>mkr' + (state.excludeIndex ? ", utan indexfonder" : "") + "</span></div>" +
        chart(function (node) {
          FFCharts.columns(node, flowPts, { tip: function (p) {
            return "<b>" + quarterLabel(p.q) + "</b><br>" + (p.value == null ? "Ingen data" : '<span class="' + cls(p.value) + '">' + msek(p.value, true) + " mkr</span>");
          } });
        }) + "</div>" +
        '<div class="chart-card"><div class="chart-title">Antal fonder som äger</div>' +
        chart(function (node) {
          FFCharts.line(node, pts.map(function (p) { return { q: p.q, value: p.funds, val: p.val }; }), {
            format: function (v) { return int(v); },
            tip: function (p) { return "<b>" + quarterLabel(p.q) + "</b><br>" + (p.value == null ? "Inga fonder" : int(p.value) + " fonder<br>Innehav " + msek(p.val) + " mkr"); }
          });
        }) + "</div></div>";
      html += "</section>";
    }

    if (s) {
      var trades = s.trades;
      var unchanged = s.f2b - trades.filter(function (t) { return t.s2; }).length;
      var cols = [
        { key: "fund", label: "Fond", align: "l", cls: "name", cell: function (t) { return nameCell(fundHref(t.f), t.f.name, changeLabel(t.s1, t.s2) + " " + esc(t.f.co)); }, value: function (t) { return t.f.name; } },
        { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (t) { return esc(t.f.co); }, value: function (t) { return t.f.co; } },
        { key: "chg", label: "Ändring", align: "l", hideSm: true, cell: function (t) { return changeLabel(t.s1, t.s2); } },
        { key: "s1", label: "Antal " + quarterLabel(d.meta.prevId), hideSm: true, cell: function (t) { return int(t.s1); }, value: function (t) { return t.s1; } },
        { key: "s2", label: "Antal " + quarterLabel(state.q), hideSm: true, cell: function (t) { return int(t.s2); }, value: function (t) { return t.s2; } },
        { key: "d", label: "Förändring (mkr)", cell: function (t) { return '<span class="' + cls(t.d) + '">' + mkr(t.d, true) + "</span>"; }, value: function (t) { return t.d; } },
        { key: "w", label: "Andel av fond", cell: function (t) { return t.f.aum2 ? nf1.format(t.s2 * s.price / t.f.aum2 * 100) + " %" : "–"; }, value: function (t) { return t.f.aum2 ? t.s2 * s.price / t.f.aum2 : null; } }
      ];
      html += '<section class="block section-gap"><div class="block-head"><h2>Fondernas affärer ' + quarterLabel(state.q) + '</h2><span class="note">' + trades.length + " fonder har ändrat innehavet" +
        (unchanged > 0 ? ", " + unchanged + " oförändrade" : "") + "</span></div>" +
        table("stock-trades", cols, trades, { sort: { col: "d", dir: -1 }, empty: "Ingen fond ändrade sitt innehav." }) + "</section>";
    }
    return html;
  }

  // ---------- Fonder ----------

  var fundFilter = { q: "", co: "", type: "" };

  function fundList() {
    var d = quarterData();
    return Object.keys(d.fi).map(function (id) { return d.fi[id]; });
  }

  function viewFunds() {
    var ds = marketDs();
    if (!ds) return failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar utländska aktier…");
    var cos = {};
    fundList().forEach(function (f) { cos[f.co] = 1; });
    var coOpts = Object.keys(cos).sort(function (a, b) { return a.localeCompare(b, "sv"); }).map(function (x) {
      return '<option value="' + esc(x) + '"' + (fundFilter.co === x ? " selected" : "") + ">" + esc(x) + "</option>";
    }).join("");
    var typeOpts = [["", "Alla fonder"], ["active", "Aktiva aktiefonder"], ["index", "Indexfonder"], ["closet", "Indexnära med hög avgift"]].map(function (o) {
      return '<option value="' + o[0] + '"' + (fundFilter.type === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
    }).join("");
    return '<div class="page-head"><h1>Fonder</h1><p class="meta">Alla svenska värdepappersfonder, ' + quarterLabel(state.q) + ". Köp och sälj avser " + marketWord() + " aktier.</p></div>" +
      '<div class="toolbar">' +
      '<input class="input" type="search" id="fundSearch" placeholder="Sök fond eller fondbolag" value="' + esc(fundFilter.q) + '" autocomplete="off">' +
      '<select class="select-sm" id="fundType" aria-label="Typ av fond">' + typeOpts + "</select>" +
      '<select class="select-sm" id="fundCo" aria-label="Fondbolag"><option value="">Alla fondbolag</option>' + coOpts + "</select>" +
      '<span class="count" id="fundCount"></span></div><div id="fundTable"></div>';
  }

  // Blandfonder mäts mot blandade index och hör inte hemma i jämförelsen av aktiefonder
  var MIXED_RE = /balanser|generation|stratega|\bmix|fokus \d|pension|flex|ränt|obligation|allokering|försiktig|offensiv \d/i;

  function fundCategory(f) {
    if (f.isIndex) return "index";
    if (f.eq == null || f.eq < 0.8 || MIXED_RE.test(f.name)) return "other";
    if (f.ar === 0) return "other"; // 0,0 betyder i praktiken att uppgiften saknas
    if (f.ar != null && f.ar < CLOSET_AR && f.feeMax != null && f.feeMax >= CLOSET_FEE) return "closet";
    return "active";
  }

  function renderFundTable() {
    var ds = marketDs();
    if (!ds || !$("fundTable")) return;
    var q = fundFilter.q.trim().toLowerCase();
    var rows = fundList().filter(function (f) {
      if (state.excludeIndex && f.isIndex) return false;
      if (fundFilter.co && f.co !== fundFilter.co) return false;
      if (fundFilter.type && fundCategory(f) !== fundFilter.type) return false;
      return !q || f.name.toLowerCase().indexOf(q) >= 0 || f.co.toLowerCase().indexOf(q) >= 0;
    }).map(function (f) { return { f: f, m: ds.fundById[f.id] }; });
    var mv = function (r) { return r.m ? r.m.val : 0; };
    var net = function (r) { return r.m && r.m.both ? r.m.bought + r.m.sold : null; };
    var cols = [
      { key: "name", label: "Fond", align: "l", cls: "name", value: function (r) { return r.f.name; }, cell: function (r) {
        var c = fundCategory(r.f);
        return nameCell(fundHref(r.f), r.f.name, esc(r.f.co) + " · " + feeText(r.f)) +
          (c === "index" && !/index/i.test(r.f.name) ? ' <span class="label hide-sm">Index</span>' : "") +
          (c === "closet" ? ' <span class="label warn hide-sm" title="Låg aktiv risk men hög avgift">Indexnära</span>' : "");
      } },
      { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (r) { return esc(r.f.co); }, value: function (r) { return r.f.co; } },
      { key: "aum", label: "Förmögenhet (mkr)", hideSm: true, cell: function (r) { return mkr(r.f.aum); }, value: function (r) { return r.f.aum; } },
      { key: "fee", label: "Avgift", hideSm: true, cell: function (r) { return r.f.feeMax == null ? "–" : nf2.format(r.f.feeMax) + " %"; }, value: function (r) { return r.f.feeMax; } },
      { key: "ar", label: "Aktiv risk", hideSm: true, cell: function (r) { return pctPlain(r.f.ar); }, value: function (r) { return r.f.ar; } },
      { key: "mv", label: (state.market === "se" ? "Sv." : "Utl.") + " aktier (mkr)", cell: function (r) { return mv(r) ? mkr(mv(r)) : "–"; }, value: mv },
      { key: "net", label: "Netto (mkr)", cell: function (r) { var v = net(r); return v == null ? "–" : '<span class="' + cls(v) + '">' + mkr(v, true) + "</span>"; }, value: net }
    ];
    $("fundTable").innerHTML = table("funds-" + state.market, cols, rows, { sort: { col: "mv", dir: -1 }, empty: "Inga fonder matchar filtret." });
    $("fundCount").textContent = int(rows.length) + " fonder";
  }

  // ---------- Fond ----------

  function viewFund(id) {
    var d = quarterData();
    var f = d.fi[id] || d.se.fundById[id];
    if (!f) return notFound("Fonden finns inte i " + quarterLabel(state.q) + ".");
    document.title = f.name + " – Fondflöden";
    var hasWorld = needWorld();
    var seF = d.se.fundById[id];
    var wF = hasWorld ? d.world.fundById[id] : null;
    var cat = d.fi[id] ? fundCategory(d.fi[id]) : "other";

    var html = '<div class="page-head"><div class="crumbs"><a href="#/fonder">Fonder</a> / ' + esc(f.name) + '</div><div class="title-row"><h1>' + esc(f.name) +
      (cat === "index" && !/index/i.test(f.name) ? ' <span class="label">Index</span>' : "") +
      (cat === "closet" ? ' <span class="label warn">Indexnära</span>' : "") +
      '</h1><div class="actions">' + starBtn("funds", id) +
      '<a class="btn" href="#/jamfor/' + encodeURIComponent(id) + '">Jämför</a>' +
      (d.fi[id] ? '<button type="button" class="btn" data-pf-add="' + esc(id) + '">' + (inPortfolio(id) ? "I din portfölj ✓" : "+ Min portfölj") + "</button>" : "") +
      '</div></div><p class="meta">' + esc(f.co) + (f.bench ? " · Jämförelseindex: " + esc(f.bench) : "") + "</p></div>";

    if (d.fi[id]) {
      var fi = d.fi[id];
      html += '<dl class="figures">' + fig("Fondförmögenhet", bigSek(fi.aum)) +
        fig("Förvaltningsavgift", feeText(fi), fi.perf ? "+ prestationsbaserad avgift" : "") +
        fig("Aktiv risk", pctPlain(fi.ar), "Avvikelse mot index, 24 mån") +
        fig("Standardavvikelse", pctPlain(fi.sd), "24 månader") +
        fig("Svenska aktier", bigSek(seF ? seF.val : 0)) +
        fig("Utländska aktier", hasWorld ? bigSek(wF ? wF.val : 0) : "…") + "</dl>";
      if (cat === "closet") {
        html += '<p class="notice warn-notice">Fonden har en aktiv risk på ' + pctPlain(fi.ar) + " men tar ut upp till " + nf2.format(fi.feeMax) +
          ' % i avgift. Den följer alltså sitt jämförelseindex ganska nära, men kostar som en aktiv fond. <a href="#/avgifter">Läs mer om avgifter</a></p>';
      }
    }

    html += fundHoldings(f, seF, "Svenska aktier", d.se, d.meta);
    if (!hasWorld) html += '<section class="block section-gap"><div class="block-head"><h2>Utländska aktier</h2></div>' + (failed("world-" + state.q) ? errorBlock() : loadingBlock()) + "</section>";
    else if (wF) html += fundHoldings(f, wF, "Utländska aktier", d.world, d.meta);
    return html;
  }

  function fundHoldings(info, f, title, ds, meta) {
    if (!f) return "";
    var rows = f.h.map(function (r) {
      var s = ds.stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0;
      return { s: s, s1: s1, s2: s2, d: (s2 - s1) * s.price, v: s2 * s.price };
    }).filter(function (r) { return f.both ? (r.s1 || r.s2) : r.s2; });
    var aum = f.aum2;
    var cols = [
      { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (r) { return nameCell(stockHref(r.s), r.s.name, (f.both ? changeLabel(r.s1, r.s2) + " " : "") + mkr(r.v) + " mkr"); }, value: function (r) { return r.s.name; } },
      { key: "chg", label: "Ändring", align: "l", hideSm: true, cell: function (r) { return f.both ? changeLabel(r.s1, r.s2) : "–"; } },
      { key: "s2", label: "Antal", hideSm: true, cell: function (r) { return int(r.s2); }, value: function (r) { return r.s2; } },
      { key: "d", label: "Förändring (mkr)", cell: function (r) { return f.both ? '<span class="' + cls(r.d) + '">' + mkr(r.d, true) + "</span>" : "–"; }, value: function (r) { return f.both ? r.d : null; } },
      { key: "v", label: "Värde (mkr)", hideSm: true, cell: function (r) { return mkr(r.v); }, value: function (r) { return r.v; } },
      { key: "w", label: "Andel av fond", cell: function (r) { return aum ? nf1.format(r.v / aum * 100) + " %" : "–"; }, value: function (r) { return r.v; } }
    ];
    var note = f.both ? (rows.length + " innehav · köpt " + mkr(f.bought, true) + " mkr · sålt " + mkr(f.sold, true) + " mkr")
      : "Fonden saknas i rapporten för " + quarterLabel(meta.prevId) + ", så förändringar kan inte beräknas.";
    return '<section class="block section-gap"><div class="block-head"><h2>' + title + '</h2><span class="note">' + note + "</span></div>" +
      table("fund-" + title + "-" + info.id, cols, rows, { sort: f.both ? { col: "d", dir: -1 } : { col: "v", dir: -1 } }) + "</section>";
  }

  // ---------- Förvaltare ----------

  function viewManagers() {
    document.title = "Kända förvaltare – Fondflöden";
    var d = quarterData(), ds = d.se;
    var funds = FEATURED.map(function (id) { return { info: d.fi[id], m: ds.fundById[id] }; })
      .filter(function (x) { return x.info && x.m; })
      .sort(function (a, b) { return b.info.aum - a.info.aum; });

    // Konsensus: hur många av de kända fonderna som köpt respektive sålt varje aktie
    var tally = {};
    funds.forEach(function (x) {
      if (!x.m.both) return;
      x.m.h.forEach(function (r) {
        var s = ds.stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0;
        if (s1 === s2 || s.isNew || s.isGone) return;
        var t = tally[s.isin] = tally[s.isin] || { s: s, buyers: [], sellers: [], sum: 0 };
        var dd = (s2 - s1) * s.price;
        t.sum += dd;
        (s2 > s1 ? t.buyers : t.sellers).push(x.info.name);
      });
    });
    var all = Object.keys(tally).map(function (k) { return tally[k]; });
    var bought = all.filter(function (t) { return t.buyers.length >= 2 && t.buyers.length > t.sellers.length; })
      .sort(function (a, b) { return (b.buyers.length - b.sellers.length) - (a.buyers.length - a.sellers.length) || b.sum - a.sum; }).slice(0, 10);
    var sold = all.filter(function (t) { return t.sellers.length >= 2 && t.sellers.length > t.buyers.length; })
      .sort(function (a, b) { return (b.sellers.length - b.buyers.length) - (a.sellers.length - a.buyers.length) || a.sum - b.sum; }).slice(0, 10);
    var consCols = function (buy) {
      return [
        { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (t) { return nameCell(stockHref(t.s), t.s.name, (buy ? t.buyers : t.sellers).join(", ")); } },
        { key: "n", label: buy ? "Köpte" : "Sålde", cell: function (t) {
          return '<span class="vote ' + (buy ? "pos" : "neg") + '" title="' + esc((buy ? t.buyers : t.sellers).join(", ")) + '">' + (buy ? t.buyers.length : t.sellers.length) + "</span>" +
            '<span class="vote-other"> / ' + (buy ? t.sellers.length : t.buyers.length) + "</span>";
        } },
        { key: "sum", label: "Netto (mkr)", cell: function (t) { return '<span class="' + cls(t.sum) + '">' + mkr(t.sum, true) + "</span>"; } }
      ];
    };

    var cards = funds.map(function (x) {
      var f = x.m, info = x.info;
      var trades = f.h.map(function (r) {
        var s = ds.stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0;
        return { s: s, s1: s1, s2: s2, d: (s2 - s1) * s.price };
      }).filter(function (t) { return t.s1 !== t.s2; });
      var buys = trades.filter(function (t) { return t.d > 0; }).sort(function (a, b) { return b.d - a.d; }).slice(0, 3);
      var sells = trades.filter(function (t) { return t.d < 0; }).sort(function (a, b) { return a.d - b.d; }).slice(0, 3);
      var list = function (items, empty) {
        if (!f.both) return '<li class="muted">Ingen jämförelse</li>';
        return items.map(function (t) {
          return '<li><a href="' + stockHref(t.s) + '">' + esc(t.s.name) + "</a>" + (!t.s1 ? ' <span class="label new">Ny</span>' : !t.s2 ? ' <span class="label out">Ut</span>' : "") +
            '<span class="' + cls(t.d) + '">' + mkr(t.d, true) + "</span></li>";
        }).join("") || '<li class="muted">' + empty + "</li>";
      };
      return '<article class="mgr">' +
        '<header><a class="mgr-name" href="' + fundHref(info) + '">' + esc(info.name) + '</a><div class="mgr-co">' + esc(info.co) + "</div></header>" +
        '<div class="mgr-stats"><span><b>' + bigSek(info.aum) + "</b> förmögenhet</span><span><b>" + feeText(info) + "</b> avgift</span><span><b>" + pctPlain(info.ar) + "</b> aktiv risk</span></div>" +
        '<div class="mgr-cols"><div><h3>Köpte mest</h3><ul>' + list(buys, "Inga köp") + "</ul></div>" +
        "<div><h3>Sålde mest</h3><ul>" + list(sells, "Inga sälj") + "</ul></div></div>" +
        "</article>";
    }).join("");

    return '<div class="page-head"><h1>Kända förvaltare</h1><p class="meta lead">Vad gör Sveriges mest kända aktiva aktiefonder? ' + funds.length + " fonder, " +
      quarterLabel(state.q) + " jämfört med " + quarterLabel(d.meta.prevId) + ". Endast svenska aktier.</p></div>" +
      '<div class="grid-2">' +
      block("Köpt av flera", "Aktier där fler av fonderna köpt än sålt", table("mgr-buy", consCols(true), bought, { static: true, empty: "Inga gemensamma köp." })) +
      block("Sålt av flera", "Aktier där fler av fonderna sålt än köpt", table("mgr-sell", consCols(false), sold, { static: true, empty: "Inga gemensamma sälj." })) +
      "</div>" +
      '<h2 class="section-title">Fonderna</h2><div class="mgr-grid">' + cards + "</div>";
  }

  // ---------- Avgifter ----------

  var feeFilter = { scope: "all", list: "closet" };

  function viewFees() {
    document.title = "Avgifter – Fondflöden";
    var d = quarterData(), ds = d.se;
    var funds = fundList().filter(function (f) { return f.ar != null && f.feeMax != null && f.aum >= 100e6 && fundCategory(f) !== "other"; });
    if (feeFilter.scope === "se") {
      funds = funds.filter(function (f) { var m = ds.fundById[f.id]; return m && m.val / f.aum >= 0.6; });
    }
    funds.forEach(function (f) { f.cat = fundCategory(f); });
    var closet = funds.filter(function (f) { return f.cat === "closet"; });
    var closetAum = closet.reduce(function (a, f) { return a + f.aum; }, 0);
    var closetCost = closet.reduce(function (a, f) { return a + f.aum * f.feeMax / 100; }, 0);
    var indexFee = funds.filter(function (f) { return f.cat === "index"; }).map(function (f) { return f.feeMax; }).sort(function (a, b) { return a - b; });
    var medianIndexFee = indexFee.length ? indexFee[Math.floor(indexFee.length / 2)] : 0.2;
    var overpay = closet.reduce(function (a, f) { return a + f.aum * Math.max(0, f.feeMax - medianIndexFee) / 100; }, 0);

    var maxAr = Math.min(14, Math.max.apply(null, funds.map(function (f) { return f.ar; }).concat([6])));
    var maxFee = Math.min(2.5, Math.max.apply(null, funds.map(function (f) { return f.feeMax; }).concat([1.5])));
    var points = funds.map(function (f) { return { x: f.ar, y: f.feeMax, cat: f.cat, f: f }; });

    var listRows = feeFilter.list === "closet" ? closet : funds;
    var cols = [
      { key: "name", label: "Fond", align: "l", cls: "name", value: function (f) { return f.name; }, cell: function (f) {
        return nameCell(fundHref(f), f.name, esc(f.co) + " · aktiv risk " + pctPlain(f.ar)) + (feeFilter.list !== "closet" ? " " + catLabel(f.cat, true) : "");
      } },
      { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (f) { return esc(f.co); }, value: function (f) { return f.co; } },
      { key: "fee", label: "Avgift", cell: function (f) { return nf2.format(f.feeMax) + " %"; }, value: function (f) { return f.feeMax; } },
      { key: "ar", label: "Aktiv risk", hideSm: true, cell: function (f) { return pctPlain(f.ar); }, value: function (f) { return f.ar; } },
      { key: "aum", label: "Förmögenhet (mkr)", hideSm: true, cell: function (f) { return mkr(f.aum); }, value: function (f) { return f.aum; } },
      { key: "cost", label: "Avgifter per år (mkr)", cell: function (f) { return mkr(f.aum * f.feeMax / 100); }, value: function (f) { return f.aum * f.feeMax / 100; } }
    ];

    var seg = function (name, value, label, current) {
      return '<button type="button" class="seg-btn" data-fee-' + name + '="' + value + '" aria-pressed="' + (current === value) + '">' + label + "</button>";
    };

    return '<div class="page-head"><h1>Avgiftskollen</h1><p class="meta lead">Betalar du för aktiv förvaltning som du inte får? Varje punkt är en aktiefond. ' +
      "Ju längre till vänster, desto mer liknar fonden sitt jämförelseindex. Ju högre upp, desto dyrare.</p></div>" +
      '<div class="highlights">' +
      highlight("Indexnära med hög avgift", int(closet.length) + " fonder", null, "av " + int(funds.length) + " aktiefonder", "Aktiv risk under " + CLOSET_AR + " % och avgift från " + nf1.format(CLOSET_FEE) + " %") +
      highlight("Sparat kapital i dem", bigSek(closetAum), null, "", "Fondförmögenhet " + quarterLabel(state.q)) +
      highlight("Avgifter per år", bigSek(closetCost), null, '<span class="neg">~' + bigSek(overpay) + " mer</span>", "än med en indexfond (median " + nf2.format(medianIndexFee) + " %)") +
      "</div>" +
      '<section class="block section-gap"><div class="block-head"><h2>Avgift mot aktiv risk</h2>' +
      '<div class="seg" role="group" aria-label="Urval">' + seg("scope", "all", "Alla aktiefonder", feeFilter.scope) + seg("scope", "se", "Sverigefonder", feeFilter.scope) + "</div></div>" +
      '<div class="legend">' + catLabel("closet") + catLabel("active") + catLabel("index") + "</div>" +
      '<div class="chart-card">' + chart(function (node) {
        FFCharts.scatter(node, points, {
          height: node.clientWidth < 500 ? 320 : 400,
          xMax: maxAr, yMax: maxFee, top: "closet",
          zone: { x: CLOSET_AR, y: CLOSET_FEE, label: "Indexnära men dyr" },
          xLabel: "Aktiv risk, % (avvikelse mot jämförelseindex)", yLabel: "Avgift, %",
          tip: function (p) {
            return "<b>" + esc(p.f.name) + "</b><br>" + esc(p.f.co) + "<br>Avgift " + feeText(p.f) + " · Aktiv risk " + pctPlain(p.f.ar) + "<br>" + bigSek(p.f.aum);
          },
          onClick: function (p) { location.hash = fundHref(p.f); }
        });
      }) + "</div></section>" +
      '<section class="block section-gap"><div class="block-head"><h2>' + (feeFilter.list === "closet" ? "Indexnära fonder med hög avgift" : "Alla aktiefonder") + "</h2>" +
      '<div class="seg" role="group" aria-label="Lista">' + seg("list", "closet", "Indexnära", feeFilter.list) + seg("list", "all", "Alla", feeFilter.list) + "</div></div>" +
      table("fees-" + feeFilter.list, cols, listRows, { sort: { col: "cost", dir: -1 }, empty: "Inga fonder i urvalet." }) + "</section>" +
      '<section class="block section-gap prose"><h2>Så ska du läsa det</h2>' +
      "<p><b>Aktiv risk</b> (tracking error) mäter hur mycket fondens avkastning har avvikit från jämförelseindex de senaste 24 månaderna. En indexfond ligger nära 0 %. En vanlig tumregel är att en fond under 3 % i praktiken följer index ganska nära.</p>" +
      "<p><b>Avgift</b> är den högsta fasta förvaltningsavgiften bland fondens andelsklasser, vilket oftast är den som privatpersoner betalar. Prestationsbaserade avgifter ingår inte.</p>" +
      "<p>Låg aktiv risk är inte fel i sig, men då bör avgiften vara låg. Siffrorna rapporteras av fondbolagen till Finansinspektionen. Endast aktiefonder (minst 80 % aktier, inga bland- eller generationsfonder) med över 100 mkr i förmögenhet visas.</p></section>";
  }

  function catLabel(cat, small) {
    var t = { closet: "Indexnära med hög avgift", active: "Aktiv fond", index: "Indexfond", other: "Övrig" }[cat];
    if (small) return cat === "closet" ? '<span class="label warn hide-sm">Indexnära</span>' : cat === "index" ? '<span class="label hide-sm">Index</span>' : "";
    return '<span class="legend-item"><i class="dot c-' + cat + '"></i>' + t + "</span>";
  }

  // ---------- Bevakningslista ----------

  function watchGet() {
    var w = store("ff-watch");
    return w && Array.isArray(w.stocks) && Array.isArray(w.funds) ? w : { stocks: [], funds: [] };
  }
  function watching(kind, id) { return watchGet()[kind].indexOf(id) >= 0; }
  function watchToggle(kind, id) {
    var w = watchGet(), i = w[kind].indexOf(id);
    if (i >= 0) w[kind].splice(i, 1); else w[kind].push(id);
    store("ff-watch", w);
  }
  function starBtn(kind, id) {
    var on = watching(kind, id);
    return '<button type="button" class="star' + (on ? " on" : "") + '" data-watch="' + kind + ":" + esc(id) + '" aria-pressed="' + on + '">' +
      '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.1l-3.9 2.2.9-4.3-3.3-3 4.4-.5z"/></svg>' +
      (on ? "Bevakas" : "Bevaka") + "</button>";
  }

  function watchBlock() {
    var w = watchGet();
    if (!w.stocks.length && !w.funds.length) return "";
    var d = quarterData();
    var needsWorld = w.stocks.some(function (i) { return i.slice(0, 2) !== "SE"; });
    var hasWorld = !needsWorld || needWorld();
    var hasHist = state.loading.history === "done";
    var qi = hasHist ? state.history.qIndex[state.q] : null;
    var stocks = w.stocks.map(function (isin) { return d.se.byIsin[isin] || (hasWorld && d.world ? d.world.byIsin[isin] : null); }).filter(Boolean);
    var funds = w.funds.map(function (id) { return d.fi[id] || d.se.fundById[id]; }).filter(Boolean);
    var stockCols = [stockCol(function (s) { return int(s.f2) + " fonder"; }), col.flow, col.chg,
      { key: "f2", label: "Fonder", hideSm: true, cell: function (s) { return int(s.f2) + (s.dF ? ' <span class="' + cls(s.dF) + '">(' + signed(String(s.dF), s.dF) + ")</span>" : ""); } }];
    if (hasHist) stockCols.push({ key: "streak", label: "Svit", hideSm: true, cell: function (s) {
      var hs = histFor(s.isin), st = hs && qi != null ? streak(hs, qi) : null;
      return st && st.n >= 2 ? '<span class="streak ' + (st.sign > 0 ? "pos" : "neg") + '">' + st.n + "</span>" : "–";
    } });
    var fundNet = function (f) {
      var a = d.se.fundById[f.id], b = d.world && d.world.fundById[f.id], v = 0, any = false;
      [a, b].forEach(function (m) { if (m && m.both) { v += m.bought + m.sold; any = true; } });
      return any ? v : null;
    };
    var fundCols = [
      { key: "name", label: "Fond", align: "l", cls: "name", cell: function (f) { return nameCell(fundHref(f), f.name, esc(f.co)); } },
      { key: "net", label: "Nettoköp (mkr)", cell: function (f) { var v = fundNet(f); return v == null ? "–" : '<span class="' + cls(v) + '">' + mkr(v, true) + "</span>"; } },
      { key: "fee", label: "Avgift", cell: function (f) { return f.feeMax == null ? "–" : nf2.format(f.feeMax) + " %"; } }
    ];
    var parts = [];
    if (stocks.length) parts.push(block("Dina bevakade aktier", "", table("watch-s", stockCols, stocks, { static: true })));
    if (funds.length) parts.push(block("Dina bevakade fonder", "", table("watch-f", fundCols, funds, { static: true })));
    return '<div class="watch ' + (parts.length > 1 ? "grid-2" : "") + '">' + parts.join("") + "</div>";
  }

  // ---------- Sektorrotation ----------

  function sectorFlows(market) {
    var h = state.history, out = {};
    Object.keys(h.stocks).forEach(function (isin) {
      if ((isin.slice(0, 2) === "SE") !== (market === "se")) return;
      var e = h.stocks[isin], sec = e[1] || "Övrigt";
      var row = out[sec] = out[sec] || {};
      e[3].forEach(function (r) { var v = flowOf(r); if (v != null) row[r[0]] = (row[r[0]] || 0) + v; });
    });
    return out;
  }

  function sectorBlock(hasHist) {
    var title = "Sektorrotation";
    if (!hasHist) return '<div class="section-gap">' + block(title, "", loadingBlock("Laddar historik…")) + "</div>";
    var h = state.history, qi = h.qIndex[state.q];
    if (qi == null || qi < 1) return "";
    var flows = sectorFlows(state.market);
    var sectors = Object.keys(flows).filter(function (s) { return s !== "Övrigt"; });
    sectors.sort(function (a, b) { return (flows[b][qi] || 0) - (flows[a][qi] || 0); });
    var maxNow = Math.max.apply(null, sectors.map(function (s) { return Math.abs(flows[s][qi] || 0); }).concat([1]));

    var bars = '<ul class="divbars">' + sectors.map(function (s) {
      var v = flows[s][qi] || 0, w = Math.abs(v) / maxNow * 50;
      return "<li><span class=\"db-label\">" + esc(s) + '</span><span class="db-track"><i class="' + (v >= 0 ? "pos" : "neg") + '" style="width:' + w.toFixed(1) +
        "%;" + (v >= 0 ? "left:50%" : "right:50%") + '"></i></span><span class="db-val ' + cls(v) + '">' + bigSek(v * 1e6, true) + "</span></li>";
    }).join("") + "</ul>";

    var first = Math.max(1, qi - 7), cols = [];
    for (var k = first; k <= qi; k++) cols.push(k);
    var maxAll = 1;
    sectors.forEach(function (s) { cols.forEach(function (k) { maxAll = Math.max(maxAll, Math.abs(flows[s][k] || 0)); }); });
    var heat = '<div class="table-wrap"><table class="heat"><thead><tr><th class="l">Sektor</th>' + cols.map(function (k, n) {
      var q = h.quarters[k];
      return '<th class="' + (n < cols.length - 4 ? "hide-sm" : "") + '">Q' + q.slice(5) + " " + q.slice(2, 4) + "</th>";
    }).join("") + "</tr></thead><tbody>" + sectors.map(function (s) {
      return '<tr><td class="l">' + esc(s) + "</td>" + cols.map(function (k, n) {
        var v = flows[s][k] || 0, a = Math.min(1, Math.abs(v) / maxAll);
        var pctMix = Math.round(8 + a * 62);
        var bg = Math.abs(v) < 1 ? "" : ' style="background:color-mix(in srgb, var(' + (v > 0 ? "--bar-pos" : "--bar-neg") + ") " + pctMix + '%, transparent)"';
        return '<td class="' + (n < cols.length - 4 ? "hide-sm" : "") + '"' + bg + ' title="' + esc(s + ", " + quarterLabel(h.quarters[k]) + ": " + bigSek(v * 1e6, true)) + '">' +
          (Math.abs(v) < 50 ? "0,0" : fixMinus((v > 0 ? "+" : "") + nf1.format(v / 1000))) + "</td>";
      }).join("") + "</tr>";
    }).join("") + "</tbody></table></div>";

    return '<div class="grid-2 section-gap">' +
      block(title, "Fondernas nettoköp per sektor " + quarterLabel(state.q) + (state.excludeIndex ? ", utan indexfonder" : ""), bars) +
      block("Sektorer över tid", "Nettoköp per kvartal, miljarder kronor", heat) + "</div>";
  }

  // ---------- Gemensamt för portfölj och jämförelse ----------

  function fundDatalist() {
    return '<datalist id="fundNames">' + fundList().slice().sort(function (a, b) { return a.name.localeCompare(b.name, "sv"); })
      .map(function (f) { return '<option value="' + esc(f.name) + '"></option>'; }).join("") + "</datalist>";
  }
  function fundByName(name) {
    var n = String(name || "").trim().toLowerCase(), list = fundList();
    for (var i = 0; i < list.length; i++) if (list[i].name.toLowerCase() === n) return list[i];
    return null;
  }

  // Alla aktieinnehav i en fond (svenska och utländska) med värde i kronor
  function fundPositions(id) {
    var d = quarterData(), out = [];
    [d.se, d.world].forEach(function (ds) {
      var f = ds && ds.fundById[id];
      if (!f || f.aum2 == null) return;
      f.h.forEach(function (r) {
        var s = ds.stocks[r[0]], s2 = r[2] || 0;
        if (s2 && s.price) out.push({ s: s, v: s2 * s.price });
      });
    });
    return out;
  }

  // Vikter normerade mot fondens samlade aktieinnehav
  function stockWeights(id) {
    var pos = fundPositions(id), tot = 0, w = {}, s = {};
    pos.forEach(function (o) { tot += o.v; });
    pos.forEach(function (o) { w[o.s.isin] = (w[o.s.isin] || 0) + o.v / (tot || 1); s[o.s.isin] = o.s; });
    return { w: w, s: s, n: pos.length };
  }

  function overlap(idA, idB) {
    var a = stockWeights(idA), b = stockWeights(idB), sum = 0, common = [];
    Object.keys(a.w).forEach(function (k) {
      if (!b.w[k]) return;
      sum += Math.min(a.w[k], b.w[k]);
      common.push({ s: a.s[k], wa: a.w[k], wb: b.w[k] });
    });
    return { value: sum, common: common, a: a, b: b };
  }

  function shareBars(items, total, limit) {
    return '<ul class="sharebars">' + items.slice(0, limit || 10).map(function (it) {
      var p = total ? it.v / total : 0;
      return '<li><span class="sb-label">' + esc(it.label) + '</span><span class="sb-track"><i style="width:' + (p * 100).toFixed(1) + '%"></i></span><span class="sb-val">' + nf1.format(p * 100) + " %</span></li>";
    }).join("") + "</ul>";
  }

  function kr(v) { return nf0.format(Math.round(v || 0)) + " kr"; }

  // ---------- Min fondportfölj ----------

  function loadPortfolio() {
    var p = store("ff-portfolio");
    return Array.isArray(p) ? p.filter(function (x) { return x && x.id && x.amount > 0; }) : [];
  }
  function savePortfolio(p) { store("ff-portfolio", p); }
  function inPortfolio(id) { return loadPortfolio().some(function (x) { return x.id === id; }); }
  function encodePortfolio(p) { return p.map(function (x) { return x.id + "-" + Math.round(x.amount); }).join("."); }
  function decodePortfolio(s) {
    return String(s || "").split(".").map(function (t) { var a = t.split("-"); return { id: a[0], amount: +a[1] || 0 }; })
      .filter(function (x) { return x.id && x.amount > 0; });
  }
  function addToPortfolio(id, amount) {
    var p = loadPortfolio(), ex = p.filter(function (x) { return x.id === id; })[0];
    if (ex) ex.amount += amount; else p.push({ id: id, amount: amount });
    savePortfolio(p);
  }

  function viewPortfolio(arg) {
    document.title = "Min fondportfölj – Fondflöden";
    var head = '<div class="page-head"><h1>Min fondportfölj</h1><p class="meta lead">Fyll i dina fonder och hur mycket du har i varje. Då ser du vilka aktier du faktiskt äger, ' +
      "vad du betalar i avgifter och om dina fonder äger samma saker. Portföljen sparas bara i din webbläsare.</p></div>";
    if (!needWorld()) return head + (failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar fondernas innehav…"));
    var d = quarterData();
    var shared = !!arg;
    var p = (shared ? decodePortfolio(arg) : loadPortfolio()).filter(function (x) { return d.fi[x.id]; });

    var form = shared
      ? '<div class="notice pf-shared">Du tittar på en delad portfölj. <button type="button" class="btn btn-primary" data-pf-adopt="' + esc(arg) + '">Spara som min portfölj</button></div>'
      : '<form class="pf-form" id="pfForm" autocomplete="off">' + fundDatalist() +
        '<input class="input" id="pfFund" list="fundNames" placeholder="Sök och välj fond" aria-label="Fond">' +
        '<input class="input pf-amount" id="pfAmount" type="number" min="1" step="any" inputmode="numeric" placeholder="Belopp i kr" aria-label="Belopp i kronor">' +
        '<button class="btn btn-primary" type="submit">Lägg till</button><span class="form-msg" id="pfMsg" role="status"></span></form>';

    if (!p.length) {
      return head + form + '<div class="empty-state"><h2>Lägg till din första fond</h2><p>Skriv namnet på en fond du äger, till exempel <i>Swedbank Robur Ny Teknik</i>, ' +
        "och hur många kronor du har i den. Du kan också trycka på <b>+ Min portfölj</b> på en fonds sida.</p></div>";
    }

    var total = 0, feeKr = 0, other = 0, byIsin = {};
    var rows = p.map(function (x) {
      var fi = d.fi[x.id], sumW = 0;
      fundPositions(x.id).forEach(function (o) {
        var w = o.v / fi.aum;
        sumW += w;
        var e = byIsin[o.s.isin] = byIsin[o.s.isin] || { s: o.s, kr: 0, via: [] };
        e.kr += x.amount * w;
        if (e.via.indexOf(fi.name) < 0) e.via.push(fi.name);
      });
      sumW = Math.min(1, sumW);
      other += x.amount * (1 - sumW);
      total += x.amount;
      var fee = fi.feeMax != null ? x.amount * fi.feeMax / 100 : 0;
      feeKr += fee;
      return { x: x, fi: fi, fee: fee, eq: sumW };
    });
    var holdings = Object.keys(byIsin).map(function (k) { return byIsin[k]; }).sort(function (a, b) { return b.kr - a.kr; });
    var inStocks = total - other;
    var top10 = holdings.slice(0, 10).reduce(function (a, e) { return a + e.kr; }, 0);

    var group = function (keyFn) {
      var m = {};
      holdings.forEach(function (e) { var k = keyFn(e.s); m[k] = (m[k] || 0) + e.kr; });
      return Object.keys(m).map(function (k) { return { label: k, v: m[k] }; }).sort(function (a, b) { return b.v - a.v; });
    };
    var sectors = group(function (s) { return s.sector || "Övrigt"; });
    var countries = group(function (s) { return countryName(s.country) || "Okänt"; });

    // Fonder som äger samma aktier
    var pairs = [];
    for (var i = 0; i < p.length; i++) for (var j = i + 1; j < p.length; j++) {
      var ov = overlap(p[i].id, p[j].id).value;
      if (ov >= 0.4) pairs.push({ a: d.fi[p[i].id], b: d.fi[p[j].id], v: ov });
    }
    pairs.sort(function (a, b) { return b.v - a.v; });

    var fundCols = [
      { key: "name", label: "Fond", align: "l", cls: "name", cell: function (r) { return nameCell(fundHref(r.fi), r.fi.name, esc(r.fi.co) + " · " + feeText(r.fi)); } },
      { key: "amount", label: "Belopp (kr)", cell: function (r) {
        return shared ? nf0.format(r.x.amount) : '<input class="input pf-edit" type="number" min="0" step="any" inputmode="numeric" value="' + Math.round(r.x.amount) + '" data-pf-id="' + esc(r.x.id) + '" aria-label="Belopp i ' + esc(r.fi.name) + '">';
      } },
      { key: "share", label: "Andel", hideSm: true, cell: function (r) { return nf1.format(r.x.amount / total * 100) + " %"; } },
      { key: "fee", label: "Avgift per år", cell: function (r) { return r.fi.feeMax == null ? "–" : kr(r.fee); } },
      { key: "eq", label: "Aktier", hideSm: true, cell: function (r) { return nf0.format(r.eq * 100) + " %"; } }
    ];
    if (!shared) fundCols.push({ key: "rm", label: "", cell: function (r) { return '<button type="button" class="icon-btn" data-pf-remove="' + esc(r.x.id) + '" aria-label="Ta bort ' + esc(r.fi.name) + '">✕</button>'; } });

    var holdCols = [
      { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (e) { return nameCell(stockHref(e.s), e.s.name, kr(e.kr) + " · via " + esc(e.via.join(", "))); } },
      { key: "kr", label: "Belopp", cell: function (e) { return kr(e.kr); } },
      { key: "p", label: "Andel", cell: function (e) { return nf1.format(e.kr / total * 100) + " %"; } },
      { key: "via", label: "Via", align: "l", cls: "muted", hideSm: true, cell: function (e) { return esc(e.via.join(", ")); } }
    ];

    var weightedFee = total ? feeKr / total * 100 : 0;
    var shareUrl = location.href.split("#")[0] + "#/portfolj/" + encodePortfolio(p);

    return head + form +
      '<div class="highlights section-gap">' +
      highlight("Portföljens värde", kr(total), null, "", p.length + (p.length === 1 ? " fond" : " fonder") + " · " + nf0.format(inStocks / total * 100) + " % i aktier") +
      highlight("Avgifter per år", kr(feeKr), null, nf2.format(weightedFee) + " % i snitt", "Högsta avgiftsklassen i varje fond") +
      highlight("Du äger", int(holdings.length) + " aktier", null, "", "De tio största är " + nf0.format(top10 / total * 100) + " % av portföljen") +
      "</div>" +
      (pairs.length ? '<div class="notice overlap-notice section-gap"><b>Dina fonder äger delvis samma aktier.</b><ul>' + pairs.slice(0, 4).map(function (x) {
        return '<li><a href="#/jamfor/' + encodeURIComponent(x.a.id) + "/" + encodeURIComponent(x.b.id) + '">' + esc(x.a.name) + " och " + esc(x.b.name) + "</a> överlappar till " + nf0.format(x.v * 100) + " %.</li>";
      }).join("") + "</ul></div>" : "") +
      '<section class="block section-gap"><div class="block-head"><h2>Dina fonder</h2>' +
      (shared ? "" : '<button type="button" class="btn" id="pfShare" data-url="' + esc(shareUrl) + '">Kopiera delningslänk</button>') + "</div>" +
      table("pf-funds", fundCols, rows, { static: true }) + "</section>" +
      '<div class="grid-2 section-gap pf-grid">' +
      block("Dina största innehav", "Det du äger genom dina fonder, enligt fondernas senaste rapport " + quarterLabel(state.q), table("pf-hold", holdCols, holdings.slice(0, 25), { static: true }) +
        (holdings.length > 25 ? '<p class="desc more-note">… och ' + int(holdings.length - 25) + " aktier till.</p>" : "")) +
      '<div class="stack">' + block("Sektorer", "", shareBars(sectors, total, 11)) +
      block("Länder", "", shareBars(countries, total, 8)) +
      (other > total * 0.02 ? '<p class="desc">' + nf0.format(other / total * 100) + " % av portföljen ligger i räntor, kassa, fondandelar eller mindre innehav som inte syns här.</p>" : "") +
      "</div></div>";
  }

  // ---------- Jämför fonder ----------

  function viewCompare(idA, idB) {
    document.title = "Jämför fonder – Fondflöden";
    var head = '<div class="page-head"><h1>Jämför fonder</h1><p class="meta lead">Hur lika är två fonder egentligen? Överlappet visar hur stor del av innehaven som är gemensam.</p></div>';
    if (!needWorld()) return head + (failed("world-" + state.q) ? errorBlock() : loadingBlock("Laddar fondernas innehav…"));
    var d = quarterData(), A = d.fi[idA], B = d.fi[idB];
    var form = '<form class="cmp-form" id="cmpForm" autocomplete="off">' + fundDatalist() +
      '<input class="input" id="cmpA" list="fundNames" placeholder="Första fonden" aria-label="Första fonden" value="' + esc(A ? A.name : "") + '">' +
      '<button type="button" class="icon-btn" id="cmpSwap" aria-label="Byt plats" title="Byt plats">⇄</button>' +
      '<input class="input" id="cmpB" list="fundNames" placeholder="Andra fonden" aria-label="Andra fonden" value="' + esc(B ? B.name : "") + '">' +
      '<button class="btn btn-primary" type="submit">Jämför</button><span class="form-msg" id="cmpMsg" role="status"></span></form>';
    if (!A || !B) {
      return head + form + '<div class="empty-state"><h2>Välj två fonder</h2><p>Till exempel <a href="#/jamfor/51718/60730">SEB Sverigefond och Handelsbanken Sverige Selektiv</a>, ' +
        'eller <a href="#/jamfor/51545/51670">Swedbank Robur Småbolagsfond Sverige och Lannebo Småbolag</a>.</p></div>';
    }
    var ov = overlap(idA, idB);
    var v = ov.value;
    var verdict = v >= 0.6 ? "Fonderna är mycket lika. Att äga båda ger liten extra spridning."
      : v >= 0.3 ? "Fonderna är ganska lika men har en del egna innehav."
      : "Fonderna är olika. De kompletterar varandra.";
    var common = ov.common.sort(function (a, b) { return Math.min(b.wa, b.wb) - Math.min(a.wa, a.wb); });
    var only = function (x, y) {
      return Object.keys(x.w).filter(function (k) { return !y.w[k]; }).map(function (k) { return { s: x.s[k], w: x.w[k] }; })
        .sort(function (a, b) { return b.w - a.w; }).slice(0, 10);
    };
    var onlyA = only(ov.a, ov.b), onlyB = only(ov.b, ov.a);
    var pw = function (w) { return nf1.format(w * 100) + " %"; };
    var row = function (label, fn) { return "<tr><th class=\"l\" scope=\"row\">" + label + "</th><td>" + fn(A) + "</td><td>" + fn(B) + "</td></tr>"; };

    return head + form +
      '<div class="cmp-hero section-gap"><div class="cmp-score"><div class="cmp-num">' + nf0.format(v * 100) + ' %</div><div class="cmp-cap">överlapp</div></div>' +
      '<div class="cmp-text"><p><b>' + esc(verdict) + "</b></p><p class=\"desc\">" + int(common.length) + " gemensamma aktier av " + int(ov.a.n) + " respektive " + int(ov.b.n) +
      ". Överlappet är summan av den lägsta vikten för varje gemensam aktie.</p>" +
      '<div class="cmp-bar" aria-hidden="true"><i style="width:' + (v * 100).toFixed(1) + '%"></i></div></div></div>' +
      '<div class="table-wrap section-gap"><table class="cmp-table"><thead><tr><th class="l"></th><th><a href="' + fundHref(A) + '">' + esc(A.name) + '</a></th><th><a href="' + fundHref(B) + '">' + esc(B.name) + "</a></th></tr></thead><tbody>" +
      row("Fondbolag", function (f) { return esc(f.co); }) +
      row("Förmögenhet", function (f) { return bigSek(f.aum); }) +
      row("Avgift", function (f) { return feeText(f); }) +
      row("Aktiv risk", function (f) { return pctPlain(f.ar); }) +
      row("Standardavvikelse", function (f) { return pctPlain(f.sd); }) +
      row("Antal aktier", function (f) { return int(f.id === idA ? ov.a.n : ov.b.n); }) +
      row("Jämförelseindex", function (f) { return esc(f.bench || "–"); }) +
      "</tbody></table></div>" +
      '<section class="block section-gap"><div class="block-head"><h2>Gemensamma innehav</h2><span class="note">Andel av fondernas aktieinnehav</span></div>' +
      table("cmp-common", [
        { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (c) { return nameCell(stockHref(c.s), c.s.name, ""); } },
        { key: "a", label: esc(shortName(A.name)), cell: function (c) { return pw(c.wa); } },
        { key: "b", label: esc(shortName(B.name)), cell: function (c) { return pw(c.wb); } }
      ], common.slice(0, 25), { static: true, empty: "Fonderna har inga gemensamma aktier." }) + "</section>" +
      '<div class="grid-2 section-gap">' +
      block("Bara i " + esc(A.name), "", table("cmp-a", [
        { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (c) { return nameCell(stockHref(c.s), c.s.name, ""); } },
        { key: "w", label: "Vikt", cell: function (c) { return pw(c.w); } }], onlyA, { static: true, empty: "Inga egna innehav." })) +
      block("Bara i " + esc(B.name), "", table("cmp-b", [
        { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (c) { return nameCell(stockHref(c.s), c.s.name, ""); } },
        { key: "w", label: "Vikt", cell: function (c) { return pw(c.w); } }], onlyB, { static: true, empty: "Inga egna innehav." })) +
      "</div>";
  }

  function shortName(n) { return n.length > 22 ? n.slice(0, 20) + "…" : n; }

  // ---------- Sök ----------

  var search = { open: false, sel: 0, items: [] };

  function openSearch() {
    if (!state.q || !quarterData() || !quarterData().se) return;
    search.open = true;
    $("searchModal").hidden = false;
    document.body.classList.add("modal-open");
    var input = $("searchInput");
    input.value = "";
    runSearch();
    input.focus();
    needWorld();
  }
  function closeSearch() {
    search.open = false;
    $("searchModal").hidden = true;
    document.body.classList.remove("modal-open");
    $("searchBtn").focus();
  }

  function scoreMatch(name, q) {
    var n = name.toLowerCase();
    if (n.indexOf(q) === 0) return 0;
    if (n.indexOf(" " + q) >= 0) return 1;
    if (n.indexOf(q) >= 0) return 2;
    return -1;
  }

  function runSearch() {
    var q = $("searchInput").value.trim().toLowerCase();
    var d = quarterData(), items = [];
    if (!q) {
      var w = watchGet();
      w.stocks.forEach(function (isin) {
        var s = d.se.byIsin[isin] || (d.world && d.world.byIsin[isin]);
        if (s) items.push({ kind: "Bevakade", label: s.name, sub: s.sector, href: stockHref(s) });
      });
      w.funds.forEach(function (id) { var f = d.fi[id]; if (f) items.push({ kind: "Bevakade", label: f.name, sub: f.co, href: fundHref(f) }); });
    } else {
      var stocks = [];
      [d.se, d.world].forEach(function (ds) {
        if (!ds) return;
        ds.stocks.forEach(function (s) {
          if (!s.f2 && !s.f1b) return;
          var sc = s.isin.toLowerCase() === q ? 0 : scoreMatch(s.name, q);
          if (sc >= 0) stocks.push({ s: s, sc: sc });
        });
      });
      stocks.sort(function (a, b) { return a.sc - b.sc || b.s.val2 - a.s.val2; });
      stocks.slice(0, 8).forEach(function (x) {
        items.push({ kind: "Aktier", label: x.s.name, sub: (x.s.isin.slice(0, 2) === "SE" ? "" : countryName(x.s.country) + " · ") + x.s.sector + " · " + int(x.s.f2) + " fonder", href: stockHref(x.s) });
      });
      var funds = fundList().map(function (f) { return { f: f, sc: Math.min(scoreMatch(f.name, q), 99) }; }).filter(function (x) { return x.sc >= 0; });
      funds.sort(function (a, b) { return a.sc - b.sc || b.f.aum - a.f.aum; });
      funds.slice(0, 6).forEach(function (x) { items.push({ kind: "Fonder", label: x.f.name, sub: x.f.co + " · " + bigSek(x.f.aum), href: fundHref(x.f) }); });
      var pages = [["Avgiftskollen", "#/avgifter"], ["Kända förvaltare", "#/forvaltare"], ["Min fondportfölj", "#/portfolj"], ["Jämför fonder", "#/jamfor"], ["Om datan", "#/om"], ["Kontakt", "#/kontakt"]];
      pages.forEach(function (pg) { if (scoreMatch(pg[0], q) >= 0) items.push({ kind: "Sidor", label: pg[0], sub: "", href: pg[1] }); });
    }
    search.items = items;
    search.sel = 0;
    var html = "", last = "";
    items.forEach(function (it, i) {
      if (it.kind !== last) { html += '<li class="sr-group" role="presentation">' + it.kind + "</li>"; last = it.kind; }
      html += '<li role="option" id="sr-' + i + '" class="sr-item" data-sr="' + i + '"' + (i === 0 ? ' aria-selected="true"' : "") + '><span class="sr-label">' + esc(it.label) + "</span>" +
        (it.sub ? '<span class="sr-sub">' + esc(it.sub) + "</span>" : "") + "</li>";
    });
    if (!items.length) {
      html = '<li class="sr-empty">' + (q ? "Inga träffar på \"" + esc(q) + "\"." : "Sök bland " + int(d.se.stocks.length + (d.world ? d.world.stocks.length : 0)) + " aktier och " + int(fundList().length) + " fonder.") + "</li>";
    }
    $("searchResults").innerHTML = html;
  }

  function moveSel(delta) {
    if (!search.items.length) return;
    search.sel = (search.sel + delta + search.items.length) % search.items.length;
    document.querySelectorAll(".sr-item").forEach(function (li) { li.removeAttribute("aria-selected"); });
    var cur = $("sr-" + search.sel);
    if (cur) { cur.setAttribute("aria-selected", "true"); cur.scrollIntoView({ block: "nearest" }); }
  }
  function pickSel(i) {
    var it = search.items[i == null ? search.sel : i];
    if (!it) return;
    closeSearch();
    location.hash = it.href;
  }

  // ---------- Om och kontakt ----------

  function viewAbout() {
    document.title = "Om datan – Fondflöden";
    var m = quarterData().meta;
    return '<div class="page-head"><h1>Om datan</h1></div><div class="prose">' +
      "<p>Svenska fondbolag rapporterar varje kvartal sina fonders innehav till Finansinspektionen, som publicerar uppgifterna öppet. Fondflöden jämför kvartalen och visar vilka aktier fonderna har köpt och sålt.</p>" +
      "<h2>Så räknas det</h2><ul>" +
      "<li><b>Nettoköp</b> är förändringen i antal aktier multiplicerad med kursen vid det senaste kvartalsslutet. Kursrörelser påverkar alltså inte siffran.</li>" +
      "<li>Förändringar räknas bara för fonder som rapporterat <b>båda</b> kvartalen.</li>" +
      "<li>Aktier som ingen fond ägde förra kvartalet, eller som ingen fond äger längre, redovisas separat. Det beror nästan alltid på noteringar, avknoppningar, uppköp eller byte av aktieslag.</li>" +
      "<li>Vid aktiesplit justeras förra kvartalets antal när de flesta fonder visar samma förändringskvot.</li>" +
      "<li>Indexfonder identifieras på namnet. Deras affärer speglar oftast in- och utflöden i fonden snarare än aktiva beslut.</li>" +
      "<li><b>Köpsviter</b> räknas på historiken sedan 2018. Kvartal med nettoköp under 0,5 mkr räknas inte.</li>" +
      "<li>Utländska aktier visas om svenska fonder sammanlagt äger minst 20 mkr. Obligationer och fondandelar är borttagna.</li></ul>" +
      "<h2>Uppdatering</h2><p>Datan hämtas automatiskt från Finansinspektionen en gång i veckan. Fonderna rapporterar ungefär sex veckor efter kvartalsslut, och sena rapporter kan tillkomma efteråt.</p>" +
      (m && m.src ? "<p>Källfiler för " + quarterLabel(state.q) + ": <code>" + esc(m.src[0]) + "</code> och <code>" + esc(m.src[1]) + "</code>.</p>" : "") +
      '<h2>Källa</h2><p><a href="https://www.fi.se/sv/vara-register/fondinnehav-per-kvartal/" target="_blank" rel="noopener">Finansinspektionen – Fondinnehav per kvartal</a></p>' +
      "<p>Informationen på sidan är inte investeringsrådgivning.</p></div>";
  }

  function viewContact() {
    document.title = "Kontakt – Fondflöden";
    return '<div class="page-head"><h1>Kontakt</h1></div><div class="prose">' +
      "<p>Har du frågor, hittat ett fel i datan eller idéer på vad som borde finnas på sajten? Hör gärna av dig.</p>" +
      '<div class="contact-card"><span class="contact-label">E-post</span>' +
      '<a class="contact-mail" href="mailto:' + CONTACT + '">' + CONTACT + "</a>" +
      '<button type="button" class="btn" id="copyMail">Kopiera</button></div></div>';
  }

  function selectText(node) {
    var range = document.createRange();
    range.selectNodeContents(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---------- Routing ----------

  var MARKET_PAGES = { oversikt: 1, aktier: 1, fonder: 1 };

  function route() {
    var parts = location.hash.replace(/^#\/?/, "").split("/");
    return { page: parts[0] || "oversikt", arg: decodeURIComponent(parts[1] || ""), arg2: decodeURIComponent(parts[2] || "") };
  }

  function render() {
    if (!state.q || !quarterData() || !quarterData().se) return;
    var r = route();
    document.title = "Fondflöden";
    state.charts = [];
    var html;
    switch (r.page) {
      case "aktier": html = viewStocks(); break;
      case "aktie": html = viewStock(r.arg); break;
      case "fonder": html = viewFunds(); break;
      case "fond": html = viewFund(r.arg); break;
      case "forvaltare": html = viewManagers(); break;
      case "avgifter": html = viewFees(); break;
      case "portfolj": html = viewPortfolio(r.arg); break;
      case "jamfor": html = viewCompare(r.arg, r.arg2); break;
      case "om": html = viewAbout(); break;
      case "kontakt": html = viewContact(); break;
      default: html = viewOverview();
    }
    app.innerHTML = html;
    if (r.page === "aktier") renderStockTable();
    if (r.page === "fonder") renderFundTable();
    drawCharts();
    var navKey = { aktie: "aktier", fond: "fonder" }[r.page] || r.page;
    document.querySelectorAll("[data-nav]").forEach(function (a) {
      if (a.getAttribute("data-nav") === navKey) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    $("marketSwitch").hidden = !MARKET_PAGES[r.page];
    renderSummary();
    if (search.open) runSearch();
  }

  function renderSummary() {
    var d = quarterData(), m = d.meta;
    var ds = state.market === "se" ? d.se : d.world;
    var head = "<b>" + quarterLabel(m.id) + "</b> jämfört med <b>" + quarterLabel(m.prevId) + "</b>";
    if (!ds) { $("summary").innerHTML = head; return; }
    var t = ds.totals;
    $("summary").innerHTML = head + " · <b>" + int(t.funds) + "</b> fonder" +
      '<span class="hide-sm"> · <b>' + int(t.held) + "</b> " + marketWord() + " aktier · Innehav <b>" + bigSek(t.value) + "</b></span> · Nettoköp <b class=\"" +
      cls(t.buy + t.sell) + "\">" + bigSek(t.buy + t.sell, true) + "</b>";
    $("updated").textContent = "Uppdaterad " + m.built;
    document.querySelectorAll("[data-market]").forEach(function (b) {
      if (b.closest("#marketSwitch")) b.setAttribute("aria-pressed", String(b.getAttribute("data-market") === state.market));
    });
  }

  function selectQuarter(id) {
    state.q = id;
    store("ff-quarter", id);
    if (state.data[id] && state.data[id].se) { render(); return Promise.resolve(); }
    app.innerHTML = loadingBlock();
    return loadSe(id).then(render);
  }

  function setMarket(m) {
    if (m !== "se" && m !== "world") return;
    state.market = m;
    store("ff-market", m);
  }

  // ---------- Händelser ----------

  window.addEventListener("hashchange", function () {
    render();
    window.scrollTo(0, 0);
  });

  var resizeTimer = null, lastWidth = window.innerWidth;
  window.addEventListener("resize", function () {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawCharts, 150);
  });

  document.addEventListener("click", function (e) {
    if (e.target.id === "copyMail") {
      var btn = e.target;
      var done = function () { btn.textContent = "Kopierad"; setTimeout(function () { btn.textContent = "Kopiera"; }, 2000); };
      if (navigator.clipboard) navigator.clipboard.writeText(CONTACT).then(done, function () { selectText(btn.previousElementSibling); });
      else selectText(btn.previousElementSibling);
      return;
    }
    var mk = e.target.closest("[data-market]");
    if (mk) {
      setMarket(mk.getAttribute("data-market"));
      if (mk.closest("#marketSwitch")) render();
      return; // länkar med data-market (brödsmulor) navigerar som vanligt
    }
    // Sök
    if (e.target.closest("#searchBtn")) { openSearch(); return; }
    if (e.target.closest("[data-search-close]")) { closeSearch(); return; }
    var sr = e.target.closest("[data-sr]");
    if (sr) { pickSel(+sr.getAttribute("data-sr")); return; }

    // Bevakning
    var wt = e.target.closest("[data-watch]");
    if (wt) {
      var key0 = wt.getAttribute("data-watch"), kind = key0.split(":")[0], wid = key0.slice(kind.length + 1);
      watchToggle(kind, wid);
      wt.outerHTML = starBtn(kind, wid);
      var again0 = document.querySelector('[data-watch="' + key0 + '"]');
      if (again0) again0.focus();
      return;
    }

    // Portfölj
    var pfAdd = e.target.closest("[data-pf-add]");
    if (pfAdd) {
      var pid = pfAdd.getAttribute("data-pf-add");
      if (!inPortfolio(pid)) addToPortfolio(pid, 10000);
      location.hash = "#/portfolj";
      return;
    }
    var pfRm = e.target.closest("[data-pf-remove]");
    if (pfRm) {
      var rid = pfRm.getAttribute("data-pf-remove");
      savePortfolio(loadPortfolio().filter(function (x) { return x.id !== rid; }));
      render();
      return;
    }
    var adopt = e.target.closest("[data-pf-adopt]");
    if (adopt) {
      savePortfolio(decodePortfolio(adopt.getAttribute("data-pf-adopt")));
      location.hash = "#/portfolj";
      return;
    }
    if (e.target.id === "pfShare") {
      var sb = e.target, url = sb.getAttribute("data-url");
      var ok = function () { sb.textContent = "Länken är kopierad"; setTimeout(function () { sb.textContent = "Kopiera delningslänk"; }, 2500); };
      var fallback = function () { sb.outerHTML = '<input class="input share-url" readonly value="' + esc(url) + '" onfocus="this.select()">'; };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(ok, fallback); else fallback();
      return;
    }
    if (e.target.closest("#cmpSwap")) {
      var a = $("cmpA"), bb = $("cmpB"), t = a.value;
      a.value = bb.value; bb.value = t;
      return;
    }

    var fs = e.target.closest("[data-fee-scope],[data-fee-list]");
    if (fs) {
      if (fs.hasAttribute("data-fee-scope")) feeFilter.scope = fs.getAttribute("data-fee-scope");
      else feeFilter.list = fs.getAttribute("data-fee-list");
      render();
      return;
    }
    var b = e.target.closest("[data-sort]");
    if (!b) return;
    var p = b.getAttribute("data-sort").split(":"), key = p[0], c = p[1];
    var cur = state.sorts[key];
    var text = ["name", "sector", "fund", "co", "country"].indexOf(c) >= 0;
    if (!cur) {
      var th = b.closest("th");
      cur = th.hasAttribute("aria-sort") ? { col: c, dir: th.getAttribute("aria-sort") === "ascending" ? 1 : -1 } : null;
    }
    state.sorts[key] = cur && cur.col === c ? { col: c, dir: -cur.dir } : { col: c, dir: text ? 1 : -1 };
    if (key.indexOf("stocks-") === 0) renderStockTable();
    else if (key.indexOf("funds-") === 0) renderFundTable();
    else { var y = window.scrollY; render(); window.scrollTo(0, y); }
    var again = document.querySelector('[data-sort="' + key + ":" + c + '"]');
    if (again) again.focus({ preventScroll: true });
  });

  document.addEventListener("submit", function (e) {
    if (e.target.id === "pfForm") {
      e.preventDefault();
      var f = fundByName($("pfFund").value), amount = parseFloat(String($("pfAmount").value).replace(",", "."));
      if (!f) { $("pfMsg").textContent = "Välj en fond i listan."; $("pfFund").focus(); return; }
      if (!(amount > 0)) { $("pfMsg").textContent = "Fyll i hur många kronor du har i fonden."; $("pfAmount").focus(); return; }
      addToPortfolio(f.id, amount);
      render();
      if ($("pfFund")) $("pfFund").focus();
    }
    if (e.target.id === "cmpForm") {
      e.preventDefault();
      var A = fundByName($("cmpA").value), B = fundByName($("cmpB").value);
      if (!A || !B) { $("cmpMsg").textContent = "Välj två fonder i listan."; return; }
      location.hash = "#/jamfor/" + encodeURIComponent(A.id) + "/" + encodeURIComponent(B.id);
    }
  });

  document.addEventListener("keydown", function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); search.open ? closeSearch() : openSearch(); return; }
    if (e.key === "/" && !typing && !search.open) { e.preventDefault(); openSearch(); return; }
    if (!search.open) return;
    if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    else if (e.key === "Enter" && e.target.id === "searchInput") { e.preventDefault(); pickSel(); }
  });

  document.addEventListener("input", function (e) {
    if (e.target.id === "searchInput") { runSearch(); return; }
    if (e.target.id === "stockSearch") { stockFilter.q = e.target.value; renderStockTable(); }
    if (e.target.id === "fundSearch") { fundFilter.q = e.target.value; renderFundTable(); }
  });
  document.addEventListener("change", function (e) {
    var id = e.target.id;
    if (id === "stockSector") { stockFilter.sector = e.target.value; renderStockTable(); }
    if (id === "stockMin") { stockFilter.min = e.target.value; renderStockTable(); }
    if (id === "fundCo") { fundFilter.co = e.target.value; renderFundTable(); }
    if (id === "fundType") { fundFilter.type = e.target.value; renderFundTable(); }
    if (id === "quarter") selectQuarter(e.target.value);
    if (e.target.hasAttribute && e.target.hasAttribute("data-pf-id")) {
      var pid = e.target.getAttribute("data-pf-id"), val = parseFloat(String(e.target.value).replace(",", "."));
      var p = loadPortfolio();
      p.forEach(function (x) { if (x.id === pid) x.amount = val > 0 ? val : x.amount; });
      savePortfolio(p);
      render();
    }
    if (id === "excludeIndex") {
      state.excludeIndex = e.target.checked;
      store("ff-exclude-index", state.excludeIndex);
      recomputeAll();
      render();
    }
  });

  // ---------- Start ----------

  state.excludeIndex = !!store("ff-exclude-index");
  $("excludeIndex").checked = state.excludeIndex;
  setMarket(store("ff-market") || "se");

  getJSON("data/index.json").then(function (idx) {
    state.index = idx;
    var ids = idx.quarters.map(function (q) { return q.id; });
    if (!ids.length) throw new Error("Inga kvartal i index.json");
    var sel = $("quarter");
    sel.innerHTML = idx.quarters.map(function (q) {
      return '<option value="' + q.id + '">' + quarterLabel(q.id) + " vs " + quarterLabel(q.prevId) + "</option>";
    }).join("");
    sel.disabled = ids.length < 2;
    var saved = store("ff-quarter");
    var id = ids.indexOf(saved) >= 0 ? saved : ids[0];
    sel.value = id;
    return selectQuarter(id);
  }).catch(function (err) {
    console.error(err);
    $("summary").textContent = "Kunde inte läsa data.";
    app.innerHTML = '<div class="notice">Datan kunde inte laddas. Försök igen om en stund.</div>';
  });
})();
