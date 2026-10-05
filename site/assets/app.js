// Fondflöden – klientlogik.
// Data: data/index.json (lista över kvartal) och data/<kvartal>.json (byggs av scripts/build-data.ps1).
(function () {
  "use strict";

  var INDEX_RE = /index|indx|\bomx|passiv|tracker|\betf\b|\bzero\b/i;
  var nf0 = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 });
  var nf1 = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  var app = document.getElementById("app");
  var state = {
    index: null,      // innehållet i index.json
    q: null,          // valt kvartal, t.ex. "2026Q2"
    cache: {},        // kvartal -> rådata
    raw: null,        // aktuellt kvartals rådata
    stocks: [],
    funds: [],
    fundById: {},
    totals: null,
    excludeIndex: false,
    sorts: {}         // tabellnyckel -> { col, dir }
  };

  // ---------- Hjälpfunktioner ----------

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
  function pct(v, decimals) {
    if (v == null || !isFinite(v)) return "–";
    var s = (decimals ? nf1 : nf0).format(v * 100) + " %";
    return signed(s, v);
  }
  function int(v) { return nf0.format(v || 0); }
  function cls(v) { return v > 0 ? "pos" : v < 0 ? "neg" : ""; }
  function quarterLabel(id) { return id ? "Q" + id.slice(5) + " " + id.slice(0, 4) : ""; }
  function prettyName(name) {
    if (!name || name !== name.toUpperCase()) return name || "";
    return name.split(/(\s+)/).map(function (w) {
      return w.length > 3 && /^[A-ZÅÄÖÉ]/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w;
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

  // ---------- Data ----------

  function getJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(url + ": " + r.status);
      return r.json();
    });
  }

  function loadQuarter(id) {
    if (state.cache[id]) return Promise.resolve(state.cache[id]);
    return getJSON("data/" + id + ".json").then(function (d) { state.cache[id] = d; return d; });
  }

  function prepare(raw) {
    state.raw = raw;
    state.funds = raw.funds.map(function (x) {
      return { id: x[0], name: x[1], co: x[2], bench: x[3], aum1: x[4], aum2: x[5], h: x[6], isIndex: INDEX_RE.test(x[1]) };
    });
    state.fundById = {};
    state.funds.forEach(function (f) { state.fundById[f.id] = f; });
    compute();
  }

  // Räknar fram per aktie och per fond. Förändringar räknas bara för fonder som rapporterat båda kvartalen.
  function compute() {
    var stocks = state.raw.stocks.map(function (s, i) {
      return {
        i: i, isin: s[0], name: prettyName(s[1]), sector: s[2] || "Övrigt", price: s[3] || 0, split: s[4],
        h2: 0, f2: 0, h1b: 0, h2b: 0, f1b: 0, f2b: 0, flow: 0, nNew: 0, nExit: 0, trades: []
      };
    });
    var t = { funds: 0, buy: 0, sell: 0, value: 0, held: 0 };

    state.funds.forEach(function (f) {
      var both = f.aum1 != null && f.aum2 != null;
      f.both = both;
      f.seVal = 0; f.bought = 0; f.sold = 0; f.nHold = 0;
      var excluded = state.excludeIndex && f.isIndex;
      if (both && !excluded) t.funds++;
      f.h.forEach(function (r) {
        var s = stocks[r[0]], s1 = r[1] || 0, s2 = r[2] || 0, d = (s2 - s1) * s.price;
        if (s2 && f.aum2 != null) { f.seVal += s2 * s.price; f.nHold++; }
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

    state.stocks = stocks;
    state.totals = t;
  }

  // ---------- Tabeller ----------

  // cols: { key, label, align: "l"|"r", cell(row) -> html, value(row) -> sorteringsvärde, sortable }
  function table(key, cols, rows, opts) {
    opts = opts || {};
    var sort = state.sorts[key] || opts.sort;
    if (sort) {
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
    funds: { key: "f2", label: "Fonder", cell: function (s) { return int(s.f2); }, value: function (s) { return s.f2; } },
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

  // ---------- Vyer ----------

  function viewOverview() {
    var S = state.stocks;
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
    var newCols = [col.rank, col.stock,
      { key: "n", label: "Nya fonder", cell: function (s) { return '<span class="pos">+' + s.nNew + "</span>"; } },
      { key: "flow", label: "Nettoköp (mkr)", cell: function (s) { return '<span class="' + cls(s.flow) + '">' + mkr(s.flow, true) + "</span>"; } },
      fundsWide];
    var exitCols = [col.rank, col.stock,
      { key: "n", label: "Avvecklat", cell: function (s) { return '<span class="neg">−' + s.nExit + "</span>"; } },
      { key: "flow", label: "Nettoköp (mkr)", cell: function (s) { return '<span class="' + cls(s.flow) + '">' + mkr(s.flow, true) + "</span>"; } },
      fundsWide];
    var arrivedCols = [col.rank, col.stock,
      { key: "v", label: "Innehav (mkr)", cell: function (s) { return mkr(s.val2); } },
      { key: "f", label: "Fonder", cell: function (s) { return int(s.f2); } }];
    var goneCols = [col.rank, col.stock,
      { key: "v", label: "Förra kv. (mkr)", cell: function (s) { return mkr(s.val1); } },
      { key: "f", label: "Fonder", cell: function (s) { return int(s.f1b); } }];
    var st = { static: true };

    return '<div class="grid-2">' +
      block("Störst nettoköp", "Förändring i antal aktier × kurs vid kvartalsslut", table("ov-buy", flowCols, buys, st) + '<a class="more" href="#/aktier">Alla aktier →</a>') +
      block("Störst nettosälj", "", table("ov-sell", flowCols, sells, st)) +
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

  function block(title, desc, inner) {
    return '<section class="block"><div class="block-head"><h2>' + title + "</h2></div>" +
      (desc ? '<p class="desc">' + desc + "</p>" : "") + inner + "</section>";
  }

  var stockFilter = { q: "", sector: "", min: "100" };

  function viewStocks() {
    var sectors = {};
    state.stocks.forEach(function (s) { if (s.f2 || s.f1b) sectors[s.sector] = 1; });
    var sectorOpts = Object.keys(sectors).sort(function (a, b) { return a.localeCompare(b, "sv"); }).map(function (x) {
      return '<option value="' + esc(x) + '"' + (stockFilter.sector === x ? " selected" : "") + ">" + esc(x) + "</option>";
    }).join("");
    var minOpts = [["0", "Alla storlekar"], ["10", "Över 10 mkr"], ["100", "Över 100 mkr"], ["1000", "Över 1 000 mkr"]].map(function (o) {
      return '<option value="' + o[0] + '"' + (stockFilter.min === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
    }).join("");
    return '<div class="page-head"><h1>Aktier</h1><p class="meta">Svenska aktier som ägs av svenska fonder, ' + quarterLabel(state.q) + " jämfört med " + quarterLabel(state.raw.meta.prevId) + ".</p></div>" +
      '<div class="toolbar">' +
      '<input class="input" type="search" id="stockSearch" placeholder="Sök aktie eller ISIN" value="' + esc(stockFilter.q) + '" autocomplete="off">' +
      '<select class="select-sm" id="stockSector"><option value="">Alla sektorer</option>' + sectorOpts + "</select>" +
      '<select class="select-sm" id="stockMin" aria-label="Minsta fondinnehav" title="Fondernas sammanlagda innehav i aktien">' + minOpts + "</select>" +
      '<span class="count" id="stockCount"></span></div>' +
      '<div id="stockTable"></div>';
  }

  function renderStockTable() {
    var q = stockFilter.q.trim().toLowerCase(), min = +stockFilter.min * 1e6;
    var rows = state.stocks.filter(function (s) {
      if (!s.f2 && !s.f1b) return false;
      if (Math.max(s.val2, s.val1) < min) return false;
      if (stockFilter.sector && s.sector !== stockFilter.sector) return false;
      return !q || s.name.toLowerCase().indexOf(q) >= 0 || s.isin.toLowerCase().indexOf(q) >= 0;
    });
    var nameWithSub = stockCol(function (s) { return esc(s.sector) + " · " + int(s.f2) + " fonder · " + mkr(s.val2) + " mkr"; });
    var fundsWide = { key: "f2", label: "Fonder", hideSm: true, cell: col.funds.cell, value: col.funds.value };
    $("stockTable").innerHTML = table("stocks", [nameWithSub, col.sector, fundsWide, col.dFunds, col.value, col.flow, col.chg], rows,
      { sort: { col: "flow", dir: -1 }, empty: "Inga aktier matchar filtret." });
    $("stockCount").textContent = rows.length + " aktier";
  }

  function viewStock(isin) {
    var s = state.stocks.filter(function (x) { return x.isin === isin; })[0];
    if (!s) return notFound("Aktien finns inte i " + quarterLabel(state.q) + ".");
    document.title = s.name + " – Fondflöden";
    var trades = s.trades;
    var unchanged = s.f2b - trades.filter(function (t) { return t.s2; }).length;
    var cols = [
      { key: "fund", label: "Fond", align: "l", cls: "name", cell: function (t) { return nameCell(fundHref(t.f), t.f.name, changeLabel(t.s1, t.s2) + " " + esc(t.f.co)); }, value: function (t) { return t.f.name; } },
      { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (t) { return esc(t.f.co); }, value: function (t) { return t.f.co; } },
      { key: "chg", label: "Ändring", align: "l", hideSm: true, cell: function (t) { return changeLabel(t.s1, t.s2); } },
      { key: "s1", label: "Antal " + quarterLabel(state.raw.meta.prevId), hideSm: true, cell: function (t) { return int(t.s1); }, value: function (t) { return t.s1; } },
      { key: "s2", label: "Antal " + quarterLabel(state.q), hideSm: true, cell: function (t) { return int(t.s2); }, value: function (t) { return t.s2; } },
      { key: "d", label: "Förändring (mkr)", cell: function (t) { return '<span class="' + cls(t.d) + '">' + mkr(t.d, true) + "</span>"; }, value: function (t) { return t.d; } },
      { key: "w", label: "Andel av fond", cell: function (t) { return t.f.aum2 ? nf1.format(t.s2 * s.price / t.f.aum2 * 100) + " %" : "–"; }, value: function (t) { return t.f.aum2 ? t.s2 * s.price / t.f.aum2 : null; } }
    ];
    var note = s.isNew ? '<p class="notice">Ingen fond ägde aktien förra kvartalet. Det beror oftast på en notering, avknoppning eller ett nytt aktieslag, så innehaven räknas inte som köp i översikten.</p>'
      : s.isGone ? '<p class="notice">Ingen fond äger aktien längre. Det beror oftast på uppköp, avnotering eller byte av aktieslag.</p>' : "";
    return '<div class="page-head"><div class="crumbs"><a href="#/aktier">Aktier</a> / ' + esc(s.name) + "</div><h1>" + esc(s.name) + '</h1><p class="meta">' +
      esc(s.sector) + " · " + esc(s.isin) + (s.price ? " · Kurs " + nf1.format(s.price) + " kr (" + esc(state.raw.meta.curr) + ")" : "") +
      (s.split ? " · Splitjusterad ×" + nf1.format(s.split) : "") + "</p></div>" +
      '<dl class="figures">' +
      fig("Fonder som äger", int(s.f2)) + fig("Fondernas innehav", bigSek(s.val2)) +
      fig("Nettoköp", s.netFlow == null ? "–" : '<span class="' + cls(s.flow) + '">' + bigSek(s.flow, true) + "</span>") +
      fig("Δ antal aktier", '<span class="' + cls(s.chg) + '">' + pct(s.chg, true) + "</span>") +
      fig("Nya fonder", int(s.nNew)) + fig("Avvecklat", int(s.nExit)) + "</dl>" + note +
      '<section class="block' + (note ? " section-gap" : "") + '"><div class="block-head"><h2>Fondernas affärer</h2><span class="note">' + trades.length + " fonder har ändrat innehavet" +
      (unchanged > 0 ? ", " + unchanged + " oförändrade" : "") + "</span></div>" +
      table("stock-trades", cols, trades, { sort: { col: "d", dir: -1 }, empty: "Ingen fond ändrade sitt innehav." }) + "</section>";
  }

  function fig(label, value) { return "<div><dt>" + label + "</dt><dd>" + value + "</dd></div>"; }

  var fundFilter = { q: "", co: "" };

  function viewFunds() {
    var cos = {};
    state.funds.forEach(function (f) { if (f.aum2 != null && f.nHold) cos[f.co] = 1; });
    var coOpts = Object.keys(cos).sort(function (a, b) { return a.localeCompare(b, "sv"); }).map(function (x) {
      return '<option value="' + esc(x) + '"' + (fundFilter.co === x ? " selected" : "") + ">" + esc(x) + "</option>";
    }).join("");
    return '<div class="page-head"><h1>Fonder</h1><p class="meta">Svenska fonder som äger svenska aktier, ' + quarterLabel(state.q) + ".</p></div>" +
      '<div class="toolbar">' +
      '<input class="input" type="search" id="fundSearch" placeholder="Sök fond" value="' + esc(fundFilter.q) + '" autocomplete="off">' +
      '<select class="select-sm" id="fundCo"><option value="">Alla fondbolag</option>' + coOpts + "</select>" +
      '<span class="count" id="fundCount"></span></div><div id="fundTable"></div>';
  }

  function renderFundTable() {
    var q = fundFilter.q.trim().toLowerCase();
    var rows = state.funds.filter(function (f) {
      if (f.aum2 == null || !f.nHold) return false;
      if (state.excludeIndex && f.isIndex) return false;
      if (fundFilter.co && f.co !== fundFilter.co) return false;
      return !q || f.name.toLowerCase().indexOf(q) >= 0 || f.co.toLowerCase().indexOf(q) >= 0;
    });
    var cols = [
      { key: "name", label: "Fond", align: "l", cls: "name", cell: function (f) { return nameCell(fundHref(f), f.name, esc(f.co)) + (f.isIndex && !/index/i.test(f.name) ? ' <span class="label hide-sm">Index</span>' : ""); }, value: function (f) { return f.name; } },
      { key: "co", label: "Fondbolag", align: "l", cls: "muted", hideSm: true, cell: function (f) { return esc(f.co); }, value: function (f) { return f.co; } },
      { key: "aum", label: "Förmögenhet (mkr)", hideSm: true, cell: function (f) { return mkr(f.aum2); }, value: function (f) { return f.aum2; } },
      { key: "se", label: "Sv. aktier (mkr)", cell: function (f) { return mkr(f.seVal); }, value: function (f) { return f.seVal; } },
      { key: "n", label: "Innehav", hideSm: true, cell: function (f) { return int(f.nHold); }, value: function (f) { return f.nHold; } },
      { key: "b", label: "Köpt (mkr)", hideSm: true, cell: function (f) { return f.both ? '<span class="pos">' + mkr(f.bought, true) + "</span>" : "–"; }, value: function (f) { return f.both ? f.bought : null; } },
      { key: "s", label: "Sålt (mkr)", hideSm: true, cell: function (f) { return f.both ? '<span class="neg">' + mkr(f.sold, true) + "</span>" : "–"; }, value: function (f) { return f.both ? f.sold : null; } },
      { key: "net", label: "Netto (mkr)", cell: function (f) { var v = f.bought + f.sold; return f.both ? '<span class="' + cls(v) + '">' + mkr(v, true) + "</span>" : "–"; }, value: function (f) { return f.both ? f.bought + f.sold : null; } }
    ];
    $("fundTable").innerHTML = table("funds", cols, rows, { sort: { col: "se", dir: -1 }, empty: "Inga fonder matchar filtret." });
    $("fundCount").textContent = rows.length + " fonder";
  }

  function viewFund(id) {
    var f = state.fundById[id];
    if (!f) return notFound("Fonden finns inte i " + quarterLabel(state.q) + ".");
    document.title = f.name + " – Fondflöden";
    var S = state.stocks;
    var rows = f.h.map(function (r) {
      var s = S[r[0]], s1 = r[1] || 0, s2 = r[2] || 0;
      return { s: s, s1: s1, s2: s2, d: (s2 - s1) * s.price, v: s2 * s.price };
    }).filter(function (r) { return f.both ? (r.s1 || r.s2) : r.s2; });
    var cols = [
      { key: "name", label: "Aktie", align: "l", cls: "name", cell: function (r) { return nameCell(stockHref(r.s), r.s.name, (f.both ? changeLabel(r.s1, r.s2) + " " : "") + mkr(r.v) + " mkr"); }, value: function (r) { return r.s.name; } },
      { key: "chg", label: "Ändring", align: "l", hideSm: true, cell: function (r) { return f.both ? changeLabel(r.s1, r.s2) : "–"; } },
      { key: "s2", label: "Antal", hideSm: true, cell: function (r) { return int(r.s2); }, value: function (r) { return r.s2; } },
      { key: "d", label: "Förändring (mkr)", cell: function (r) { return f.both ? '<span class="' + cls(r.d) + '">' + mkr(r.d, true) + "</span>" : "–"; }, value: function (r) { return f.both ? r.d : null; } },
      { key: "v", label: "Värde (mkr)", hideSm: true, cell: function (r) { return mkr(r.v); }, value: function (r) { return r.v; } },
      { key: "w", label: "Andel av fond", cell: function (r) { return f.aum2 ? nf1.format(r.v / f.aum2 * 100) + " %" : "–"; }, value: function (r) { return r.v; } }
    ];
    var defaultSort = f.both ? { col: "d", dir: -1 } : { col: "v", dir: -1 };
    return '<div class="page-head"><div class="crumbs"><a href="#/fonder">Fonder</a> / ' + esc(f.name) + "</div><h1>" + esc(f.name) +
      (f.isIndex && !/index/i.test(f.name) ? ' <span class="label">Index</span>' : "") + '</h1><p class="meta">' + esc(f.co) + (f.bench ? " · Jämförelseindex: " + esc(f.bench) : "") + "</p></div>" +
      '<dl class="figures">' + fig("Fondförmögenhet", bigSek(f.aum2)) + fig("Svenska aktier", bigSek(f.seVal)) + fig("Antal svenska innehav", int(f.nHold)) +
      fig("Köpt", f.both ? '<span class="pos">' + bigSek(f.bought, true) + "</span>" : "–") +
      fig("Sålt", f.both ? '<span class="neg">' + bigSek(f.sold, true) + "</span>" : "–") + "</dl>" +
      (f.both ? "" : '<p class="notice" style="margin-bottom:20px">Fonden saknas i rapporten för ' + quarterLabel(state.raw.meta.prevId) + ", så förändringar kan inte beräknas.</p>") +
      '<section class="block"><div class="block-head"><h2>Svenska aktier</h2></div>' + table("fund-" + f.id, cols, rows, { sort: defaultSort }) + "</section>";
  }

  function viewAbout() {
    document.title = "Om datan – Fondflöden";
    var m = state.raw ? state.raw.meta : {};
    return '<div class="page-head"><h1>Om datan</h1></div><div class="prose">' +
      "<p>Svenska fondbolag rapporterar varje kvartal sina fonders innehav till Finansinspektionen, som publicerar uppgifterna öppet. Fondflöden jämför två kvartal och visar vilka svenska aktier fonderna har köpt och sålt.</p>" +
      "<h2>Så räknas det</h2><ul>" +
      "<li><b>Nettoköp</b> är förändringen i antal aktier multiplicerad med kursen vid det senaste kvartalsslutet. Kursrörelser påverkar alltså inte siffran.</li>" +
      "<li>Förändringar räknas bara för fonder som rapporterat <b>båda</b> kvartalen.</li>" +
      "<li>Aktier som ingen fond ägde förra kvartalet, eller som ingen fond äger längre, redovisas separat. Det beror nästan alltid på noteringar, avknoppningar, uppköp eller byte av aktieslag.</li>" +
      "<li>Vid aktiesplit justeras förra kvartalets antal när de flesta fonder visar samma förändringskvot.</li>" +
      "<li>Indexfonder identifieras på namnet. Deras affärer speglar oftast in- och utflöden i fonden snarare än aktiva beslut.</li>" +
      "<li>Endast aktier med svensk ISIN-kod ingår. Obligationer och fondandelar är borttagna.</li></ul>" +
      "<h2>Uppdatering</h2><p>Datan hämtas automatiskt från Finansinspektionen en gång i veckan. Fonderna rapporterar ungefär sex veckor efter kvartalsslut, och sena rapporter kan tillkomma efteråt.</p>" +
      (m.src ? "<p>Källfiler för " + quarterLabel(state.q) + ": <code>" + esc(m.src[0]) + "</code> och <code>" + esc(m.src[1]) + "</code>.</p>" : "") +
      '<h2>Källa</h2><p><a href="https://www.fi.se/sv/vara-register/fondinnehav-per-kvartal/" target="_blank" rel="noopener">Finansinspektionen – Fondinnehav per kvartal</a></p>' +
      "<p>Informationen på sidan är inte investeringsrådgivning.</p></div>";
  }

  // Adressen sätts ihop här så att den inte ligger i klartext i HTML-koden för spamrobotar.
  var CONTACT = ["axelsfondfloden", "gmail.com"].join("@");

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

  function notFound(msg) {
    return '<div class="notice">' + esc(msg) + ' <a href="#/">Till översikten</a></div>';
  }

  // ---------- Routing ----------

  function route() {
    var parts = location.hash.replace(/^#\/?/, "").split("/");
    return { page: parts[0] || "oversikt", arg: decodeURIComponent(parts[1] || "") };
  }

  function render() {
    if (!state.raw) return;
    var r = route();
    document.title = "Fondflöden";
    var html;
    switch (r.page) {
      case "aktier": html = viewStocks(); break;
      case "aktie": html = viewStock(r.arg); break;
      case "fonder": html = viewFunds(); break;
      case "fond": html = viewFund(r.arg); break;
      case "om": html = viewAbout(); break;
      case "kontakt": html = viewContact(); break;
      default: html = viewOverview();
    }
    app.innerHTML = html;
    if (r.page === "aktier") renderStockTable();
    if (r.page === "fonder") renderFundTable();
    var navKey = { aktie: "aktier", fond: "fonder" }[r.page] || r.page;
    document.querySelectorAll("[data-nav]").forEach(function (a) {
      if (a.getAttribute("data-nav") === navKey) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }

  function renderSummary() {
    var t = state.totals, m = state.raw.meta;
    $("summary").innerHTML = "<b>" + quarterLabel(m.id) + "</b> jämfört med <b>" + quarterLabel(m.prevId) + "</b> · <b>" + int(t.funds) + "</b> fonder" +
      '<span class="hide-sm"> · <b>' + int(t.held) + "</b> aktier · Innehav <b>" + bigSek(t.value) + "</b></span> · Nettoköp <b class=\"" + cls(t.buy + t.sell) + "\">" + bigSek(t.buy + t.sell, true) + "</b>";
    $("updated").textContent = "Uppdaterad " + m.built;
  }

  function selectQuarter(id) {
    state.q = id;
    store("ff-quarter", id);
    app.setAttribute("aria-busy", "true");
    return loadQuarter(id).then(function (raw) {
      prepare(raw);
      renderSummary();
      render();
      app.removeAttribute("aria-busy");
    });
  }

  // ---------- Händelser ----------

  window.addEventListener("hashchange", function () {
    render();
    window.scrollTo(0, 0);
  });

  document.addEventListener("click", function (e) {
    if (e.target.id === "copyMail") {
      var btn = e.target;
      var done = function () { btn.textContent = "Kopierad"; setTimeout(function () { btn.textContent = "Kopiera"; }, 2000); };
      if (navigator.clipboard) {
        navigator.clipboard.writeText(CONTACT).then(done, function () { selectText(btn.previousElementSibling); });
      } else {
        selectText(btn.previousElementSibling);
      }
      return;
    }
    var b = e.target.closest("[data-sort]");
    if (!b) return;
    var p = b.getAttribute("data-sort").split(":"), key = p[0], c = p[1];
    var cur = state.sorts[key];
    var text = c === "name" || c === "sector" || c === "fund" || c === "co";
    if (!cur) {
      // första klicket på en kolumn som redan är förvald sorterar omvänt
      var th = b.closest("th");
      cur = th.hasAttribute("aria-sort") ? { col: c, dir: th.getAttribute("aria-sort") === "ascending" ? 1 : -1 } : null;
    }
    state.sorts[key] = cur && cur.col === c ? { col: c, dir: -cur.dir } : { col: c, dir: text ? 1 : -1 };
    if (key === "stocks") renderStockTable();
    else if (key === "funds") renderFundTable();
    else render();
    var again = document.querySelector('[data-sort="' + key + ":" + c + '"]');
    if (again) again.focus();
  });

  document.addEventListener("input", function (e) {
    if (e.target.id === "stockSearch") { stockFilter.q = e.target.value; renderStockTable(); }
    if (e.target.id === "fundSearch") { fundFilter.q = e.target.value; renderFundTable(); }
  });
  document.addEventListener("change", function (e) {
    var id = e.target.id;
    if (id === "stockSector") { stockFilter.sector = e.target.value; renderStockTable(); }
    if (id === "stockMin") { stockFilter.min = e.target.value; renderStockTable(); }
    if (id === "fundCo") { fundFilter.co = e.target.value; renderFundTable(); }
    if (id === "quarter") selectQuarter(e.target.value);
    if (id === "excludeIndex") {
      state.excludeIndex = e.target.checked;
      store("ff-exclude-index", state.excludeIndex);
      compute(); renderSummary(); render();
    }
  });

  // ---------- Start ----------

  state.excludeIndex = !!store("ff-exclude-index");
  $("excludeIndex").checked = state.excludeIndex;

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
