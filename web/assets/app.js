/* 本币货币债券工作台 —— 主应用 */
(function () {
  'use strict';

  var S = { bundle: null, live: null, page: 'overview', nYears: 5, theme: 'dark', calMonth: null };
  var MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

  /* ------------------------------------------------ 基础工具 */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    d = d === undefined ? 2 : d;
    return Number(v).toFixed(d);
  }
  function fmtBig(v) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    return Math.round(v).toLocaleString('zh-CN');
  }
  function last(arr) {
    for (var i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) return { i: i, v: arr[i] };
    return null;
  }
  function prev(arr, i) {
    for (var j = i - 1; j >= 0; j--) if (arr[j] !== null && arr[j] !== undefined && !isNaN(arr[j])) return arr[j];
    return null;
  }
  function delta(cur, pre, dec) {
    if (cur === null || cur === undefined || pre === null || pre === undefined) return '<span class="flat">—</span>';
    var d = cur - pre;
    var cls = Math.abs(d) < 1e-9 ? 'flat' : (d > 0 ? 'up' : 'down');
    return '<span class="' + cls + '">' + (d > 0 ? '▲' : d < 0 ? '▼' : '－') + ' ' + fmt(Math.abs(d), dec) + '</span>';
  }
  function datasets() { return (S.bundle && S.bundle.datasets) || {}; }
  function ds(key) { return datasets()[key] || null; }
  function lvs(key) { return (S.live && S.live.series && S.live.series[key]) || null; }

  /** 取一条序列：Wind / 森浦 实时源优先。
   *  合并规则——底稿为底，同日期以实时源覆盖，实时源多出的日期追加在后。 */
  function get(key, name) {
    var d = ds(key), L = lvs(key);
    var base = (d && d.series) ? d.series[name] : null;
    var live = (L && L.series) ? L.series[name] : null;
    if (!base && !live) return null;
    if (!live) return { dates: d.dates, values: base, unit: d.unit, src: '底稿', over: 0, added: 0 };
    if (!base) return { dates: L.dates, values: live, unit: L.unit || (d && d.unit), src: L.src || '实时', over: 0, added: L.dates.length };
    var map = {}, seen = {};
    d.dates.forEach(function (x, i) { if (!seen[x]) { seen[x] = 1; } map[x] = base[i]; });
    var over = 0, added = 0;
    L.dates.forEach(function (x, i) {
      var v = live[i];
      if (v === null || v === undefined || isNaN(v)) return;
      if (seen[x]) over++;
      else { seen[x] = 1; added++; }
      map[x] = v;                       // 实时源覆盖同日期
    });
    var order = Object.keys(map).sort();
    return {
      dates: order, values: order.map(function (x) { return map[x]; }),
      unit: d.unit, src: (over || added) ? (L.src || '实时') : '底稿', over: over, added: added
    };
  }

  /* ------------------------------------------------ 月/季 aggregation */
  function monthlyAgg(dates, values, how) {
    var m = {}, order = [];
    for (var i = 0; i < dates.length; i++) {
      var v = values[i];
      if (v === null || v === undefined || isNaN(v)) continue;
      var k = dates[i].slice(0, 7);
      if (!m[k]) { m[k] = []; order.push(k); }
      m[k].push(v);
    }
    var out = [];
    order.forEach(function (k) {
      var a = m[k];
      var v = how === 'sum' ? a.reduce(function (x, y) { return x + y; }, 0)
        : how === 'last' ? a[a.length - 1]
          : a.reduce(function (x, y) { return x + y; }, 0) / a.length;
      out.push({ ym: k, v: v });
    });
    return out;
  }
  /** 季节性：{years:[], byYear:{y:[12]}, avg:[12]} */
  function seasonal(dates, values, how, nYears) {
    var agg = monthlyAgg(dates, values, how);
    var byYear = {}, years = [];
    agg.forEach(function (r) {
      var y = parseInt(r.ym.slice(0, 4), 10), m = parseInt(r.ym.slice(5, 7), 10) - 1;
      if (!byYear[y]) { byYear[y] = new Array(12).fill(null); years.push(y); }
      byYear[y][m] = r.v;
    });
    years.sort();
    var use = years.slice(-nYears);
    var avg = new Array(12).fill(null);
    for (var m2 = 0; m2 < 12; m2++) {
      var s = 0, c = 0;
      use.forEach(function (y) { var v = byYear[y][m2]; if (v !== null && !isNaN(v)) { s += v; c++; } });
      avg[m2] = c ? s / c : null;
    }
    return { years: use, byYear: byYear, avg: avg, allYears: years };
  }

  /* ------------------------------------------------ 日度季节性（横轴=月·日） */
  // 以非闰年为基准的 365 格“年内第几天”轴：1月1日=0 … 12月31日=364
  var MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  var MONTH_LEN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function dayOfYear(dateStr) {
    var m = parseInt(dateStr.slice(5, 7), 10) - 1, d = parseInt(dateStr.slice(8, 10), 10);
    if (isNaN(m) || isNaN(d)) return null;
    var idx = MONTH_START[m] + (d - 1);
    return idx > 364 ? 364 : idx;
  }
  // 365 个“X月X日”标签（供 tooltip 显示）
  function monthDayLabels() {
    var lab = new Array(365);
    for (var m = 0; m < 12; m++) for (var d = 1; d <= MONTH_LEN[m]; d++) lab[MONTH_START[m] + (d - 1)] = (m + 1) + '月' + d + '日';
    return lab;
  }
  // X 轴只标每月 1 日
  function monthDayTicks() {
    return MONTH_START.map(function (idx, m) { return { i: idx, label: (m + 1) + '月1日' }; });
  }
  /** 日度季节性：{years, byYear:{y:[365]}, avg:[365]}，值为各日真实数据 */
  function seasonalDay(dates, values, nYears) {
    var byYear = {}, years = [];
    for (var i = 0; i < dates.length; i++) {
      var v = values[i];
      if (v === null || v === undefined || isNaN(v)) continue;
      var idx = dayOfYear(dates[i]); if (idx === null) continue;
      var y = parseInt(dates[i].slice(0, 4), 10);
      if (!byYear[y]) { byYear[y] = new Array(365).fill(null); years.push(y); }
      byYear[y][idx] = v;
    }
    years.sort();
    var use = years.slice(-nYears);
    var avg = new Array(365).fill(null);
    for (var k = 0; k < 365; k++) {
      var s = 0, c = 0;
      use.forEach(function (y) { var vv = byYear[y][k]; if (vv !== null && vv !== undefined && !isNaN(vv)) { s += vv; c++; } });
      avg[k] = c ? s / c : null;
    }
    return { years: use, byYear: byYear, avg: avg, allYears: years };
  }

  /* ------------------------------------------------ 日度序列工具：前向填充 / 全口径净投放 */
  /** 前向填充：null/NaN 沿用上一个有效值（首个无效则留空） */
  function carryForward(vals) {
    var out = [], lastv = null;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v === null || v === undefined || isNaN(v)) out.push(lastv);
      else { lastv = v; out.push(v); }
    }
    return out;
  }
  /** 把日度序列展开为“连续自然日”，缺失日沿用上日值（余额口径） */
  function dailyCarryForward(g) {
    if (!g || !g.dates || !g.dates.length) return g;
    var map = {};
    g.dates.forEach(function (d, i) { var v = g.values[i]; if (v !== null && v !== undefined && !isNaN(v)) map[d] = v; });
    var d0 = new Date(g.dates[0] + 'T00:00:00'), d1 = new Date(g.dates[g.dates.length - 1] + 'T00:00:00');
    var dates = [], vals = [], lastv = null;
    for (var t = new Date(d0.getTime()); t <= d1; t.setDate(t.getDate() + 1)) {
      var dsx = ymd(t); if (map[dsx] !== undefined) lastv = map[dsx];
      dates.push(dsx); vals.push(lastv);
    }
    return { dates: dates, values: vals };
  }
  /** 全口径央行日度净投放（流量）：OMO(隔夜/7D/14D/28D/63D) + 国库定存 + 买断(3M/6M) + MLF。
   *  买断/MLF 仅有月度净投放，按当月自然日均摊到日。 */
  function comprehensiveNetDaily() {
    var map = {};
    var rr = ds('reverse_repo_balance');
    if (rr && rr.series) {
      ['隔夜', '7D', '14D', '28D', '63D'].forEach(function (t) {
        var inj = rr.series['投放:' + t] || [], out = rr.series['到期:' + t] || [];
        for (var i = 0; i < rr.dates.length; i++) {
          var a = inj[i], b = out[i];
          if ((a === null || a === undefined) && (b === null || b === undefined)) continue;
          map[rr.dates[i]] = (map[rr.dates[i]] || 0) + ((a || 0) - (b || 0));
        }
      });
    }
    var cus = get('funding_omo', '国库定存净投放');
    if (cus) cus.dates.forEach(function (d, i) { var v = cus.values[i]; if (v !== null && v !== undefined && !isNaN(v)) map[d] = (map[d] || 0) + v; });
    function spreadMonthly(g) {
      if (!g) return;
      g.dates.forEach(function (d, i) {
        var v = g.values[i]; if (v === null || v === undefined || isNaN(v)) return;
        var y = +d.slice(0, 4), m = +d.slice(5, 7), dim = new Date(y, m, 0).getDate(), per = v / dim;
        for (var day = 1; day <= dim; day++) {
          var dd = y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
          map[dd] = (map[dd] || 0) + per;
        }
      });
    }
    spreadMonthly(get('pbc_mid_long', '3M买断式净投放'));
    spreadMonthly(get('pbc_mid_long', '6M买断式净投放'));
    spreadMonthly(get('pbc_mid_long', 'MLF月度净投放'));
    var keys = Object.keys(map).sort();
    return { dates: keys, values: keys.map(function (k) { return map[k]; }) };
  }
  /** 由日度净投放流量 → 年内累计（每年 1/1 起算，展开为连续自然日，缺失沿用上日） */
  function cumulativeFromDaily(nd) {
    if (!nd || !nd.dates.length) return null;
    var map = {}; nd.dates.forEach(function (d, i) { map[d] = nd.values[i]; });
    var d0 = new Date(nd.dates[0] + 'T00:00:00'), d1 = new Date(nd.dates[nd.dates.length - 1] + 'T00:00:00');
    var dates = [], vals = [], cum = 0, curY = null;
    for (var t = new Date(d0.getTime()); t <= d1; t.setDate(t.getDate() + 1)) {
      var dsx = ymd(t), y = dsx.slice(0, 4);
      if (curY === null) curY = y;
      if (y !== curY) { cum = 0; curY = y; }
      var f = map[dsx]; if (f !== undefined) cum += f;
      dates.push(dsx); vals.push(cum);
    }
    return { dates: dates, values: vals };
  }

  /* ------------------------------------------------ UI 组件 */
  function card(title, hint, body, cls) {
    return '<div class="card ' + (cls || '') + '"><header><h4>' + esc(title) + '</h4>' +
      (hint ? '<span class="hint">' + esc(hint) + '</span>' : '') + '</header>' + body + '</div>';
  }
  function kpi(k, v, d, unit, src, spark) {
    return '<div class="kpi"><div class="k"><span>' + esc(k) + '</span><span class="src">' + esc(src || '') + '</span></div>' +
      '<div class="v">' + v + '<span style="font-size:11px;color:var(--text-3);margin-left:2px">' + esc(unit || '') + '</span></div>' +
      '<div class="d">' + d + '</div>' +
      (spark ? '<div class="spark">' + spark + '</div>' : '') + '</div>';
  }
  function alertBar(title, items) {
    return '<div class="alertbar"><h3><span class="tagwarn">关注</span>' + esc(title) + '</h3>' +
      '<div class="cols"><ul>' + items.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul></div></div>';
  }
  function tbl(headers, rows, cls) {
    var h = '<div class="tb-wrap"><table class="tb ' + (cls || '') + '"><thead><tr>' +
      headers.map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') + '</tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr>' + r.map(function (c) { return '<td>' + (c && c.html ? c.html : esc(c)) + '</td>'; }).join('') + '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  /** 事件轴：把 events 映射到某个日期数组的索引 */
  function markers(dates, types) {
    var evs = (datasets().events || []).concat(CURATED_EVENTS).concat((S.live && S.live.news || []).map(function (x) {
      return { date: x.date, type: '官媒', title: x.title };
    }));
    var out = [], used = {};
    for (var i = 0; i < dates.length; i++) {
      evs.forEach(function (e) {
        var d = (e.date || '').slice(0, 10);
        if (d === dates[i] && !used[d + e.type] && (!types || types.indexOf(e.type) >= 0)) {
          used[d + e.type] = 1;
          out.push({ x: i, label: e.type, color: evColor(e.type), title: e.title });
        }
      });
    }
    return out.slice(0, 40);
  }
  function evColor(t) {
    return { '降准': '#f0b13b', 'MLF': '#4f9cf9', '税期': '#f2637b', '政策利率': '#9b7bf0', '结构性': '#e8734d', '政府债缴款': '#5ec8a8', '官媒': '#63b3f2' }[t] || '#8b93a7';
  }
  // 分析师补充的 政策利率(降息) / 结构性货币工具 事件（底稿未自动生成，据公开信息维护）
  var CURATED_EVENTS = [
    { date: '2024-05-17', type: '结构性', title: '设立科技创新和技术改造再贷款 5000亿元' },
    { date: '2024-07-22', type: '政策利率', title: '7天期逆回购操作利率 −10BP 至 1.70%' },
    { date: '2024-09-27', type: '政策利率', title: '7天期逆回购利率 −20BP 至 1.50%；降准0.5pct' },
    { date: '2025-05-07', type: '政策利率', title: '7天期逆回购利率 −10BP 至 1.40%；降准0.5pct' },
    { date: '2026-09-28', type: '结构性', title: 'PSL利率降至1.5%；“六张网”扩围；科创技改再贷款+2000亿、支农支小再贷款+5000亿' }
  ];
  function evList(from, to, types) {
    var evs = (datasets().events || []).concat(CURATED_EVENTS).filter(function (e) {
      var d = (e.date || '').slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (types && types.indexOf(e.type) < 0) return false;
      return true;
    }).slice().reverse();
    if (!evs.length) return '<div class="empty">窗口内无事件</div>';
    return '<div class="evlist">' + evs.slice(0, 80).map(function (e) {
      return '<div class="ev"><span class="d">' + esc(e.date.slice(0, 10)) + '</span>' +
        '<span class="ty ty-' + esc(e.type) + '">' + esc(e.type) + '</span>' +
        '<span class="ti">' + esc(e.title) + '</span></div>';
    }).join('') + '</div>';
  }
  var DRIVER_NOTE = {
    '降准': '释放长期资金、降低银行负债成本，通常带动资金利率下行与存单利率回落，利好短端。',
    'MLF': 'MLF 大额投放/到期直接改变中长期流动性总量，影响银行资产端配置与存单发行意愿。',
    '税期': '每月申报截止前后，资金从银行体系流向国库，阶段性收紧流动性，资金利率易冲高。',
    '政策利率': 'OMO/LPR/MLF 利率调整直接定价资金中枢，是资金面最直接的驱动。',
    '结构性': '结构性货币政策工具（再贷款/PSL/专项工具）定向支持重点领域，量的层面补充流动性、影响信贷结构与预期。',
    '政府债缴款': '政府债集中发行缴款回笼流动性；反之到期与财政支出形成投放，是季节性波动主因。',
    '官媒': '央行官媒/公开讲话传递政策取向，影响市场预期与交易行为。'
  };

  /* ------------------------------------------------ 通用子专题骨架 */
  /**
   * cfg = {key, names:[], how:'mean'|'sum'|'last', dec, unit, note, extra}
   */
  function subtopic(cfg) {
    var html = '';
    var d = ds(cfg.key);
    var recent = cfg.recent || 250;
    // 季节性
    var sAll = [];
    cfg.names.forEach(function (nm) {
      var g = get(cfg.key, nm);
      if (!g) return;
      var s = seasonal(g.dates, g.values, cfg.how, S.nYears);
      sAll.push({ name: nm, s: s, g: g });
    });
    if (!sAll.length) return '<div class="empty">该专题暂无数据</div>';

    // ---- 当周/当季变化提示
    var tips = [];
    sAll.forEach(function (o) {
      var L = last(o.g.values); if (!L) return;
      var p5 = prev(o.g.values, L.i), p20 = null;
      var j = L.i; for (var k = L.i - 1, c = 0; k >= 0 && c < 20; k--) { if (o.g.values[k] !== null && !isNaN(o.g.values[k])) { p20 = o.g.values[k]; c++; } }
      var d5 = (p5 !== null) ? (L.v - p5) : null;
      var d20 = (p20 !== null) ? (L.v - p20) : null;
      // 去年同期
      var ly = null, lyY = new Date(o.g.dates[L.i]).getFullYear() - 1;
      var target = o.g.dates[L.i].slice(4);
      for (var m = 0; m < o.g.dates.length; m++) {
        if (o.g.dates[m].slice(0, 4) === String(lyY) && o.g.dates[m].slice(4) === target) { ly = o.g.values[m]; }
      }
      var t = '<b>' + o.name + '</b> 最新 ' + fmt(L.v, cfg.dec) + cfg.unit + '（' + o.g.dates[L.i] + '）';
      if (d5 !== null) t += '，较前值 ' + delta(L.v, p5, cfg.dec);
      if (d20 !== null) t += '，近一月 ' + delta(L.v, p20, cfg.dec);
      if (ly !== null && !isNaN(ly)) t += '，较去年同期 ' + delta(L.v, ly, cfg.dec);
      tips.push(t);
    });
    html += alertBar('近期变化与需关注事项', tips);

    // ---- 季节性图（每年一条线）
    var chartHost = 'c_season_' + cfg.key;
    html += '<div class="grid g23">';
    html += card('季节性规律：横轴为月份、每年一条线（' + S.nYears + '年）',
      cfg.how === 'sum' ? '月度合计' : cfg.how === 'last' ? '月末值' : '月度均值',
      '<div id="' + chartHost + '"></div>' +
      '<div class="chips" id="chips_' + cfg.key + '"></div>');
    html += card('近' + S.nYears + '年逐月复盘',
      '行为年份、列为月份；颜色越红数值越高',
      '<div id="mx_' + cfg.key + '"></div>');
    html += '</div>';

    // ---- 近期量价走势 + 驱动因素
    html += '<div class="grid g23">';
    html += card('近期量价走势（含驱动事件标注）', '最近 ' + recent + ' 个交易日',
      '<div id="ts_' + cfg.key + '"></div>');
    html += card('关键驱动因素', '降准 / 降息 / 税期 / 政府债缴款 / 央行操作',
      '<div id="ev_' + cfg.key + '"></div>' +
      '<div class="note" style="margin-top:8px">' +
      Object.keys(DRIVER_NOTE).map(function (k) {
        return '<div><b style="color:' + evColor(k) + '">' + k + '</b>：' + DRIVER_NOTE[k] + '</div>';
      }).join('') + '</div>');
    html += '</div>';

    if (cfg.extra) html += cfg.extra();

    // ---- 渲染回调
    setTimeout(function () {
      var host = document.getElementById(chartHost);
      if (!host) return;
      var cur = sAll[0];
      function drawSeason(idx) {
        cur = sAll[idx];
        var yrs = cur.s.years;
        var series = yrs.map(function (y) {
          return { name: String(y), data: cur.s.byYear[y], axis: 0, dec: cfg.dec, width: (y === yrs[yrs.length - 1] ? 2.6 : 1.5) };
        });
        series.push({ name: '均值', data: cur.s.avg, axis: 0, color: '#8b93a7', dash: '5 4', width: 1.6, dec: cfg.dec });
        Charts.render(host, {
          labels: MONTHS, xKind: 'month', series: series,
          y0: { dec: cfg.dec }, height: 330,
          toolFmt: function (v, s) { return fmt(v, cfg.dec) + cfg.unit; }
        });
        var mx = document.getElementById('mx_' + cfg.key);
        if (mx) Charts.matrix(mx, { years: cur.s.years, byYear: cur.s.byYear, dec: cfg.dec, unit: cfg.unit, invert: cfg.invert });
      }
      var chips = document.getElementById('chips_' + cfg.key);
      if (chips) {
        chips.innerHTML = sAll.map(function (o, i) {
          return '<span class="chip' + (i === 0 ? ' on' : '') + '" data-i="' + i + '">' + esc(o.name) + '</span>';
        }).join('');
        $$('.chip', chips).forEach(function (c) {
          c.onclick = function () {
            $$('.chip', chips).forEach(function (x) { x.classList.remove('on'); });
            c.classList.add('on'); drawSeason(+c.dataset.i);
          };
        });
      }
      drawSeason(0);

      // 近期走势
      var g0 = sAll[0].g, st = Math.max(0, g0.dates.length - recent);
      var labels = g0.dates.slice(st);
      var mk = markers(labels);
      var tseries = sAll.map(function (o, i) {
        return { name: o.name, data: o.g.values.slice(st), axis: 0, dec: cfg.dec, type: cfg.lineType || 'line' };
      });
      var tsHost = document.getElementById('ts_' + cfg.key);
      if (tsHost) Charts.render(tsHost, {
        labels: labels, series: tseries, y0: { dec: cfg.dec }, markers: mk, height: 300,
        toolFmt: function (v, s) { return fmt(v, cfg.dec) + cfg.unit; }
      });

      var evHost = document.getElementById('ev_' + cfg.key);
      if (evHost) evHost.innerHTML = evList(labels[0], labels[labels.length - 1]);
    }, 0);
    return html;
  }

  /* ================================================== 交易笔记（本地留档） */
  /* 笔记结构：{id, date:'YYYY-MM-DD', tag, title, text, ts}
     存储：localStorage（始终） + 服务端 data/notes.json（本地服务版可用），
     公网/单文件离线版仅存本机浏览器；留档累积，不做任何清理。 */
  var NOTES_LS = 'mmb_notes_v1';
  var NOTE_TAGS = ['资金面', '存单', '债券', '央行', '票据', '衍生品', '其他'];
  var S_NOTES = null;   // 缓存

  function noteKey() { return NOTES_LS; }
  function notesRaw() {
    if (S_NOTES) return S_NOTES;
    var arr = [];
    try {
      arr = JSON.parse(localStorage.getItem(noteKey()) || '[]');
      if (!Array.isArray(arr)) arr = [];
    } catch (e) { arr = []; }
    S_NOTES = arr;
    return S_NOTES;
  }
  /** 与服务端留档合并（按 id 去重），返回后刷新缓存 */
  function notesMergeServer(list) {
    if (!Array.isArray(list) || !list.length) return;
    var cur = notesRaw(), seen = {};
    cur.forEach(function (n) { seen[n.id] = 1; });
    list.forEach(function (n) { if (n && n.id && !seen[n.id]) { cur.push(n); seen[n.id] = 1; } });
    notesSort(); notesPersist(false);
  }
  function notesSort() {
    var a = notesRaw();
    a.sort(function (x, y) { return (x.date < y.date ? 1 : x.date > y.date ? -1 : (y.ts || 0) - (x.ts || 0)); });
  }
  function notesSaveLocal() {
    try { localStorage.setItem(noteKey(), JSON.stringify(notesRaw())); } catch (e) { }
  }
  function notesPersist(toServer) {
    notesSaveLocal();
    if (toServer === false) return;
    if (window.__MMB_BUNDLE__) return;               // 离线快照版：只存本机
    try {
      fetch('/api/notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notesRaw() })
      }).then(function () { }).catch(function () { });
    } catch (e) { }
  }
  function noteAdd(o) {
    var arr = notesRaw();
    var n = {
      id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: o.date, tag: o.tag || '其他', title: o.title || '', text: o.text || '',
      ts: Date.now()
    };
    arr.push(n); notesSort(); notesPersist(true);
    return n;
  }
  function noteDel(id) {
    var arr = notesRaw();
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) { arr.splice(i, 1); break; }
    notesPersist(true);
  }
  function noteGet(id) {
    var a = notesRaw();
    for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
    return null;
  }
  /** 按日期归组：{date:[note,...]} */
  function notesByDate() {
    var m = {};
    notesRaw().forEach(function (n) { (m[n.date] = m[n.date] || []).push(n); });
    return m;
  }
  function notesInRange(d0, d1) {
    return notesRaw().filter(function (n) { return (!d0 || n.date >= d0) && (!d1 || n.date <= d1); });
  }
  function notesSearch(kw) {
    kw = String(kw || '').trim();
    if (!kw) return [];
    var low = kw.toLowerCase();
    return notesRaw().filter(function (n) {
      return ((n.text || '') + (n.title || '') + (n.tag || '') + (n.date || '')).toLowerCase().indexOf(low) >= 0;
    });
  }
  function todayStr() { return ymd(new Date()); }

  /* 总览季节性图上的笔记圆点：笔记日期 → “月·日”轴索引（365 格） */
  var ovCur = 0;
  var ovNoteShow = function () { };
  function noteDots(sd, latestYear) {
    var byDate = notesByDate(), out = [];
    Object.keys(byDate).forEach(function (d) {
      var idx = dayOfYear(d);
      if (idx === null || idx === undefined) return;
      var list = byDate[d];
      var yv = (sd.byYear[latestYear] && sd.byYear[latestYear][idx]);
      if (yv === null || yv === undefined || isNaN(yv)) yv = (sd.avg || [])[idx];
      var brief = list.map(function (n) {
        return '· [' + (n.tag || '其他') + '] ' + (n.title || n.text || '').replace(/\s+/g, ' ').slice(0, 46);
      }).map(esc).join('<br>');
      out.push({
        x: idx,
        y: (yv === null || yv === undefined || isNaN(yv)) ? null : yv,
        r: list.length > 1 ? 5.6 : 4.2, color: '#f0b13b', id: d,
        title: d + '（' + list.length + ' 条笔记）',
        tip: '<b style="color:#f0b13b">' + esc(d) + ' · ' + list.length + ' 条</b><br>' + brief
      });
    });
    return out;
  }

  /* ------------------------------------------------ 核心指标定义
     KPI / 总览季节性图 / 智能问答 三处共用，确保指标口径与顺序完全一致 */
  var OV_METRICS = [
    { label: 'DR001', key: 'funding_rates', name: 'DR001', unit: '%', dec: 4, how: 'mean' },
    { label: 'R001', key: 'funding_rates', name: 'R001', unit: '%', dec: 4, how: 'mean' },
      { label: '隔夜分层 R001-DR001', key: 'funding_rates', name: 'R001', unit: 'bp', dec: 1, how: 'mean', spread: { key: 'funding_rates', name: 'DR001' } },
      { label: 'DR007', key: 'funding_rates', name: 'DR007', unit: '%', dec: 4, how: 'mean' },
      { label: 'R007', key: 'funding_rates', name: 'R007', unit: '%', dec: 4, how: 'mean' },
      { label: '7天分层 R007-DR007', key: 'funding_rates', name: 'R007', unit: 'bp', dec: 1, how: 'mean', spread: { key: 'funding_rates', name: 'DR007' } },
      { label: '1Y股份行存单发行', key: 'ncd_issue_rate_shibor', name: '1Y股份行存单', unit: '%', dec: 4, how: 'mean' },
      { label: '1Y AAA存单二级', key: 'ncd_secondary_curve', name: '1Y', unit: '%', dec: 4, how: 'mean' },
      { label: '10Y国债', key: 'variety_rate', name: '10Y国债', unit: '%', dec: 4, how: 'mean' },
      { label: '大行净融出', key: 'repo_institution', name: '大行净融出', unit: '亿', dec: 0, how: 'mean' },
      { label: '货基净融出', key: 'repo_institution', name: '货基净融出', unit: '亿', dec: 0, how: 'mean' },
      { label: '基金净融入', key: 'nonbank_demand', name: '基金', unit: '亿', dec: 0, how: 'mean' },
      { label: '券商净融入', key: 'nonbank_demand', name: '券商自营', unit: '亿', dec: 0, how: 'mean' },
      { label: '基金回购融入余额', key: 'nonbank_demand', name: '基金回购融入', unit: '亿', dec: 0, how: 'mean' },
      { label: '市场回购余额', key: 'lev_all', name: '银行间回购余额', unit: '万亿', dec: 2, how: 'mean', scale: 1 / 10000 },
    { label: '银行间杠杆率', key: 'lev_interbank', name: '银行间杠杆率', unit: '倍', dec: 4, how: 'mean' }
  ];

  /* ------------------------------------------------ 交易笔记 UI（总览页右侧栏） */
  function notesEditorHtml() {
    var defDate = (S.bundle && S.bundle.meta && S.bundle.meta.latest_date) || todayStr();
    return '<div class="nt">' +
      '<div class="nt-form">' +
      '<div class="nt-row">' +
      '<input type="date" id="ntDate" value="' + esc(defDate) + '">' +
      '<select id="ntTag" class="sel">' + NOTE_TAGS.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('') + '</select>' +
      '<button class="btn sm pri" id="ntSave">＋ 记一笔</button>' +
      '</div>' +
      '<input type="text" id="ntTitle" class="nt-title" placeholder="标题（可选，如：跨月资金面偏紧）">' +
      '<textarea id="ntText" class="nt-text" rows="4" placeholder="当天交易观察：资金面／存单／债券／央行操作／交易动作…（Ctrl+Enter 保存）"></textarea>' +
      '</div>' +
      '<div class="nt-detail" id="ovNoteDetail" style="display:none"></div>' +
      '<div class="nt-head">' +
      '<input type="text" id="ntSearch" class="nt-search" placeholder="搜索：关键词 / 日期 / 标签">' +
      '<span class="note" id="ntCount"></span>' +
      '<button class="btn sm" id="ntExport">导出</button>' +
      '<button class="btn sm" id="ntImport">导入</button>' +
      '<input type="file" id="ntFile" accept=".json" style="display:none">' +
      '</div>' +
      '<div class="nt-list" id="ntList"></div>' +
      '</div>';
  }
  function notesListHtml(kw) {
    var arr = kw ? notesSearch(kw) : notesRaw();
    if (!arr.length) return '<div class="empty">' + (kw ? '没有匹配的笔记' : '还没有笔记，在上方记录第一笔') + '</div>';
    return arr.slice(0, 300).map(function (n) {
      return '<div class="nt-item" data-id="' + esc(n.id) + '" data-date="' + esc(n.date) + '">' +
        '<div class="nt-meta"><span class="nt-date">' + esc(n.date) + '</span>' +
        '<span class="nt-tag">' + esc(n.tag || '其他') + '</span><span class="sp"></span>' +
        '<span class="nt-del" data-del="' + esc(n.id) + '">删除</span></div>' +
        (n.title ? '<div class="nt-t">' + esc(n.title) + '</div>' : '') +
        '<div class="nt-x">' + esc(n.text || '') + '</div></div>';
    }).join('');
  }
  function notesDetailHtml(date) {
    var list = notesByDate()[date] || [];
    if (!list.length) return '';
    return '<div class="nt-detail-in"><div class="nt-detail-h">' + esc(date) + ' · ' + list.length + ' 条笔记' +
      '<span class="sp"></span><span class="nt-close" id="ntClose">收起</span></div>' +
      list.map(function (n) {
        return '<div class="nt-full"><div class="nt-meta"><span class="nt-tag">' + esc(n.tag || '其他') + '</span>' +
          (n.title ? '<b>' + esc(n.title) + '</b>' : '') + '</div>' +
          '<div class="nt-x">' + esc(n.text || '').replace(/\n/g, '<br>') + '</div></div>';
      }).join('') + '</div>';
  }

  /* ================================================== 页面：总览 */
  function pOverview() {
    var h = '';
    // KPI
    var kpis = [];
    function pushMetric(m) {
      var sc = m.scale || 1;
      if (m.spread) {
        var a = get(m.key, m.name), b = get(m.spread.key, m.spread.name);
        if (!a || !b) return;
        var mb = {};
        b.values.forEach(function (v, i) { if (v !== null && !isNaN(v)) mb[b.dates[i]] = v; });
        var dates = [], vals = [];
        a.values.forEach(function (v, i) {
          var x = mb[a.dates[i]];
          if (v === null || v === undefined || isNaN(v) || x === undefined) return;
          dates.push(a.dates[i]); vals.push((v - x) * 100);
        });
        if (!vals.length) return;
        var L = last(vals); if (!L) return;
        var p5 = null;
        for (var k = L.i - 1, c = 0; k >= 0 && c < 5; k--) { if (vals[k] !== null && !isNaN(vals[k])) { p5 = vals[k]; c++; } }
        kpis.push(kpi(m.label, fmt(L.v, m.dec), delta(L.v, p5, m.dec), m.unit, a.src, '<span style="font-size:10px">' + dates[L.i] + '</span>'));
      } else {
        var g = get(m.key, m.name); if (!g) return;
        var L2 = last(g.values); if (!L2) return;
        var p5b = null;
        for (var k2 = L2.i - 1, c2 = 0; k2 >= 0 && c2 < 5; k2--) { if (g.values[k2] !== null && !isNaN(g.values[k2])) { p5b = g.values[k2]; c2++; } }
        kpis.push(kpi(m.label, fmt(L2.v * sc, m.dec), delta(L2.v * sc, p5b === null ? null : p5b * sc, m.dec), m.unit, g.src, '<span style="font-size:10px">' + g.dates[L2.i] + '</span>'));
      }
    }
    OV_METRICS.forEach(pushMetric);

    h += '<div class="kpis">' + kpis.join('') + '</div>';

    // 重点提示
    var notes = [];
    (S.bundle.notes || {}).liq && (S.bundle.notes.liq || []).slice(0, 8).forEach(function (t) { notes.push(t); });
    (S.bundle.notes || {}).ncd && (S.bundle.notes.ncd || []).slice(0, 4).forEach(function (t) { notes.push(t); });
    var cal = ds('block_calendar') || [];
    var calRows = cal.filter(function (r) { return r && r[1] && r[7]; });
    if (calRows.length) {
      notes.push('未来流动性日历：' + calRows.slice(0, 4).map(function (r) { return esc(r[1]) + ' ' + esc(r[7]); }).join('；'));
    }
    var ev = (S.bundle.datasets.events || []).filter(function (e) { return e.date >= lastDate(-30); });
    ev.slice(0, 6).forEach(function (e) { notes.push('<b style="color:' + evColor(e.type) + '">[' + esc(e.type) + ']</b> ' + e.date + ' ' + esc(e.title)); });
    h += alertBar('近期重点交易事项与需关注事项（截至 ' + (S.bundle.meta.latest_date || '') + '）', notes.slice(0, 14));

    // 季节性主图（可切换指标）
    // 季节性图指标项 = 总览 KPI 全部选项；数据为日度，横轴为“月·日”
    var picks = OV_METRICS.map(function (m) { return Object.assign({ t: m.label }, m); });
    h += '<div class="grid g23">' +
      card('核心指标季节性（横轴 月·日 · 日度数据）', '缺失沿用上一日 · 点击图例可隐藏/显示年份；金色圆点=当日有交易笔记，点击可看',
        '<div class="chips" id="ovChips"></div><div id="ovSeason"></div>') +
      card('每日交易笔记（留档累积）', '按日记录 · 图上自动打点 · 仅存本机',
        notesEditorHtml()) + '</div>';
    h += '<div class="grid g23">' +
      card('近' + S.nYears + '年逐月复盘（月均）', '行=年份 列=月份', '<div id="ovMx"></div>') +
      card('笔记归档说明', '', '<div class="note">' +
        '<div>1. 笔记保存在本机浏览器（localStorage）；本地服务版会同步写入 <code>data/notes.json</code>，多端留档累积。</div>' +
        '<div>2. 有笔记的日期在季节性图上以<b style="color:var(--warn)">金色圆点</b>标出，鼠标悬浮看摘要、点击查看全文。</div>' +
        '<div>3. 笔记同时供「智能问答」检索，例如问「9月资金面笔记」。</div>' +
        '<div>4. 可用「导出」把全部笔记存成 JSON 备份，「导入」可合并回历史笔记。</div></div>') +
      '</div>';

    // 各专题近一年走势：与总览 KPI 卡片顺序完全一致（16 项）+ 存单净融资量 + FR007 互换，
    // 共 18 个。分层类（隔夜/7天）用 mode='spr' 直接绘 R-DR 利差（bp）。
    var thumbs = [
      // —— 资金价格（顺序与指标卡一致）——
      ['DR001', 'funding_rates', ['DR001'], 4, '%'],
      ['R001', 'funding_rates', ['R001'], 4, '%'],
      ['隔夜分层 R001-DR001', 'funding_rates', ['R001', 'DR001'], 1, 'bp', 'spr'],
      ['DR007', 'funding_rates', ['DR007'], 4, '%'],
      ['R007', 'funding_rates', ['R007'], 4, '%'],
      ['7天分层 R007-DR007', 'funding_rates', ['R007', 'DR007'], 1, 'bp', 'spr'],
      // —— 存单 / 债券 ——
      ['1Y股份行存单发行', 'ncd_issue_rate_shibor', ['1Y股份行存单'], 4, '%'],
      ['1Y AAA存单二级', 'ncd_secondary_curve', ['1Y'], 4, '%'],
      ['10Y国债', 'variety_rate', ['10Y国债'], 4, '%'],
      // —— 机构融出 / 融入 ——
      ['大行净融出', 'repo_institution', ['大行净融出'], 0, '亿'],
      ['货基净融出', 'repo_institution', ['货基净融出'], 0, '亿'],
      ['基金净融入', 'nonbank_demand', ['基金'], 0, '亿'],
      ['券商净融入', 'nonbank_demand', ['券商自营'], 0, '亿'],
      ['基金回购融入余额', 'nonbank_demand', ['基金回购融入'], 0, '亿'],
      ['市场回购余额', 'lev_all', ['银行间回购余额'], 2, '万亿'],
      ['银行间杠杆率', 'lev_interbank', ['银行间杠杆率'], 4, '倍'],
      // —— 补充 ——
      ['存单净融资', 'ncd_weekly', ['存单净发行'], 0, '亿'],
      ['FR007 1Y 互换', 'irs', ['FR007:1Y'], 4, '%']
    ];
    // 各专题近一年缩略走势
    h += '<div class="sect-title">各专题近一年走势（' + thumbs.length + ' 项，与总览 KPI 一致）</div><div class="grid g3">';
    var tHosts = [];
    thumbs.forEach(function (t, i) {
      var id = 'th_' + i;
      tHosts.push({ id: id, t: t });
      h += card(t[0], t[4], '<div id="' + id + '" style="height:180px"></div>');
    });
    h += '</div>';

    setTimeout(function () {
      var chips = $('#ovChips'), host = $('#ovSeason'), mx = $('#ovMx');
      function draw(i) {
        var p = picks[i];
        var g = get(p.key, p.name);
        if (!g) { host.innerHTML = '<div class="empty">无数据</div>'; return; }
        var vals = g.values;
        if (p.scale) vals = vals.map(function (v) { return v === null ? null : v * p.scale; });
        if (p.spread) {
          var bs = get(p.spread.key, p.spread.name);
          if (bs) {
            var mm = {};
            bs.values.forEach(function (v, k) { if (v !== null && !isNaN(v)) mm[bs.dates[k]] = v; });
            vals = g.values.map(function (v, k) {
              var dv = mm[g.dates[k]];
              return (v !== null && dv !== undefined) ? (v - dv) * 100 : null;
            });
          } else {
            vals = g.values.map(function () { return null; });
          }
          p.unit = 'bp'; p.dec = 1;
        }
        var full = dailyCarryForward({ dates: g.dates, values: vals });
        var sd = seasonalDay(full.dates, full.values, S.nYears);
        var yrs = sd.years;
        var series = yrs.map(function (y) {
          return { name: y + '年', data: sd.byYear[y], axis: 0, dec: p.dec, width: y === yrs[yrs.length - 1] ? 2.6 : 1.5, color: y === yrs[yrs.length - 1] ? '#f2637b' : undefined };
        });
        series.push({ name: '均值', data: sd.avg, axis: 0, color: '#8b93a7', dash: '5 4', width: 1.6, dec: p.dec });
        ovCur = i;
        Charts.render(host, {
          labels: monthDayLabels(), xKind: 'date', xTicks: monthDayTicks(), series: series, y0: { dec: p.dec }, height: 320,
          toolFmt: function (v) { return fmt(v, p.dec) + p.unit; },
          dots: noteDots(sd, yrs[yrs.length - 1]),
          onDot: function (d) { ovNoteShow(d.id); }
        });
        if (mx) {
          var sm = seasonal(g.dates, vals, p.how, S.nYears);
          Charts.matrix(mx, { years: sm.years, byYear: sm.byYear, dec: p.dec, unit: p.unit });
        }
      }
      chips.innerHTML = picks.map(function (p, i) { return '<span class="chip' + (i === 0 ? ' on' : '') + '" data-i="' + i + '">' + esc(p.t) + '</span>'; }).join('');
      $$('.chip', chips).forEach(function (c) {
        c.onclick = function () { $$('.chip', chips).forEach(function (x) { x.classList.remove('on'); }); c.classList.add('on'); draw(+c.dataset.i); };
      });

      /* ---- 交易笔记：录入 / 列表 / 检索 / 导入导出 ---- */
      var nList = $('#ntList'), nDetail = $('#ovNoteDetail'), nSearch = $('#ntSearch'), nCount = $('#ntCount');
      function refreshList() {
        if (!nList) return;
        var kw = nSearch ? String(nSearch.value || '').trim() : '';
        nList.innerHTML = notesListHtml(kw);
        $$('.nt-del', nList).forEach(function (b) {
          b.onclick = function (ev) {
            ev.stopPropagation();
            noteDel(b.dataset.del);
            refreshList(); if (nDetail) nDetail.style.display = 'none'; draw(ovCur); toast('笔记已删除');
          };
        });
        $$('.nt-item', nList).forEach(function (it) {
          it.onclick = function () { showDate(it.dataset.date); };
        });
        if (nCount) nCount.textContent = '共 ' + notesRaw().length + ' 条';
      }
      function showDate(d) {
        if (!nDetail) return;
        nDetail.innerHTML = notesDetailHtml(d);
        nDetail.style.display = d ? 'block' : 'none';
        $$('.nt-item', nList).forEach(function (x) { x.classList.toggle('on', x.dataset.date === d); });
        var cl = $('#ntClose'); if (cl) cl.onclick = function () { nDetail.style.display = 'none'; };
      }
      ovNoteShow = showDate;
      var btnSave = $('#ntSave');
      if (btnSave) btnSave.onclick = function () {
        var d = ($('#ntDate') || {}).value || todayStr();
        var tx = ($('#ntText') || {}).value || '';
        var ti = ($('#ntTitle') || {}).value || '';
        if (!tx.trim() && !ti.trim()) { toast('请先填写笔记内容', true); return; }
        noteAdd({ date: d, tag: ($('#ntTag') || {}).value || '其他', title: ti.trim(), text: tx.trim() });
        var tEl = $('#ntText'), tiEl = $('#ntTitle');
        if (tEl) tEl.value = ''; if (tiEl) tiEl.value = '';
        refreshList(); draw(ovCur); toast('笔记已保存（' + d + '）');
      };
      var nText = $('#ntText');
      if (nText) nText.addEventListener('keydown', function (e) { if (e.ctrlKey && e.key === 'Enter' && btnSave) btnSave.click(); });
      if (nSearch) nSearch.addEventListener('input', refreshList);
      var bExp = $('#ntExport'), bImp = $('#ntImport'), fImp = $('#ntFile');
      if (bExp) bExp.onclick = function () {
        var blob = new Blob([JSON.stringify(notesRaw(), null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '交易笔记_' + todayStr() + '.json';
        a.click();
        toast('已导出 ' + notesRaw().length + ' 条笔记');
      };
      if (bImp && fImp) {
        bImp.onclick = function () { fImp.click(); };
        fImp.onchange = function () {
          var f = fImp.files && fImp.files[0]; if (!f) return;
          var fr = new FileReader();
          fr.onload = function () {
            try {
              var arr = JSON.parse(String(fr.result));
              if (!Array.isArray(arr)) throw new Error('格式不是数组');
              var before = notesRaw().length;
              notesMergeServer(arr);
              refreshList(); draw(ovCur);
              toast('已导入，新增 ' + (notesRaw().length - before) + ' 条');
            } catch (e) { toast('导入失败：' + (e.message || e), true); }
          };
          fr.readAsText(f, 'utf-8');
        };
      }
      refreshList();
      draw(0);
    tHosts.forEach(function (o) {
      var t = o.t, g0 = get(t[1], t[2][0]); if (!g0) return;
      var st = Math.max(0, g0.dates.length - 250), labels = g0.dates.slice(st);
      var series;
      if (t[5] === 'spr') {
        // 分层类：A - B 以 bp 计
        var ga = get(t[1], t[2][0]), gb = get(t[1], t[2][1]);
        if (!ga || !gb) return;
        var mb = {};
        gb.values.forEach(function (v, k) { if (v !== null && !isNaN(v)) mb[gb.dates[k]] = v; });
        var data = ga.values.map(function (v, k) {
          var dv = mb[ga.dates[k]];
          return (v !== null && dv !== undefined) ? (v - dv) * 100 : null;
        });
        series = [{ name: t[0], data: data.slice(st), axis: 0, dec: t[3] }];
      } else {
        series = t[2].map(function (nm) {
          var gg = get(t[1], nm);
          return gg ? { name: nm, data: gg.values.slice(st), axis: 0, dec: t[3] } : null;
        }).filter(Boolean);
      }
      var el = document.getElementById(o.id);
      if (el) Charts.render(el, { labels: labels, series: series, y0: { dec: t[3] }, height: 176, showLegend: false, toolFmt: function (v) { return fmt(v, t[3]) + t[4]; } });
    });
    }, 0);
    return h;
  }
  /** 本地日期 YYYY-MM-DD（不能用 toISOString，UTC+8 凌晨会偏成前一天） */
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function lastDate(offset) {
    var d = new Date(); d.setDate(d.getDate() + (offset || 0));
    return ymd(d);
  }

  /* ================================================== 页面：流动性日历 */
  /** 生成指定月份（默认底稿最后一个有日度 OMO 数据的月份，如 2026-09）的逐日日历行。
   *  数据口径：
   *   - OMO 隔夜/7D/14D 起息(投放)/到期：底稿日度真实值，覆盖全月；
   *   - 3M/6M买断、MLF、国库定存 起息/到期：Wind EDB + 森浦 Qeubee 实时日明细（pbc_ops_daily）；
   *   - 政府债净缴款(合计)：底稿日度真实值（=净发行），覆盖全月；
   *   - 地方债净缴款：Wind 日度净融资（2024-09 起）；国债净缴款 = 合计 − 地方债（残差）；
   *   - 存单起息：Wind 日度发行（发行日口径）按「起息日 = 发行日 + 1 工作日」平移（2021-10 起）；
   *   - 存单到期：周度值按 7 天均摊到日。
   */
  function taxDeadline(Y, M) {
    // 税期截止日：每月 15 日，遇周末/节假日顺延至下一工作日
    var d = new Date(Y, M - 1, 15);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return ymd(d);
  }
  function calendarRows(anchorYm) {
    var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function nz(x) { return (x === null || x === undefined || isNaN(x)) ? null : x; }
    function mapOf(key, name) {
      var g = get(key, name), o = {};
      if (g && g.dates) for (var i = 0; i < g.dates.length; i++) o[g.dates[i]] = g.values[i];
      return o;
    }
    function addAny(a) { var s = 0, any = false; for (var i = 0; i < a.length; i++) { var x = nz(a[i]); if (x !== null) { s += x; any = true; } } return any ? s : null; }

    // 锚点月份 = 底稿逆回购日度数据的最后一个月（或用户下拉选择）
    var rr = ds('reverse_repo_balance');
    var anchorDate = (rr && rr.dates && rr.dates.length) ? rr.dates[rr.dates.length - 1] : lastDate(0);
    if (!anchorYm) anchorYm = anchorDate.slice(0, 7);
    var Y = +anchorYm.slice(0, 4), M = +anchorYm.slice(5, 7);
    var dim = new Date(Y, M, 0).getDate();

    var mOnIn = mapOf('reverse_repo_balance', '投放:隔夜'), mOnOut = mapOf('reverse_repo_balance', '到期:隔夜');
    var m7In = mapOf('reverse_repo_balance', '投放:7D'), m7Out = mapOf('reverse_repo_balance', '到期:7D');
    var m14In = mapOf('reverse_repo_balance', '投放:14D'), m14Out = mapOf('reverse_repo_balance', '到期:14D');
    var mGov = mapOf('gov_bond_weekly', '净发行');
    var mLgb = mapOf('gov_bond_split', '地方债净缴款');
    var mNcdIn = mapOf('ncd_issue_daily', '存单起息');

    // 存单到期（周度 → 按 7 天均摊到日）
    var nw = get('ncd_maturity_weekly', '存单到期量'), mNcdOut = {};
    if (nw) for (var i = 0; i < nw.dates.length; i++) {
      var v = nw.values[i]; if (v === null || isNaN(v)) continue;
      var s0 = nw.dates[i];
      for (var k = 0; k < 7; k++) { var dd = ymd(new Date(new Date(s0 + 'T00:00:00').getTime() + k * 864e5)); mNcdOut[dd] = (mNcdOut[dd] || 0) + v / 7; }
    }

    // 买断/MLF/国库定存 起息/到期：实时源（Wind EDB + 森浦 Qeubee 日明细，见 pbc_ops_daily）；
    // 其中 3M/6M 买断投放为 Wind 逐操作序列，买断到期由投放期限表推导并向森浦权威到期日吸附；
    // 底稿 omo_detail 快照作为兜底。
    var mB3i = mapOf('pbc_ops_daily', '3M买断投放'), mB3o = mapOf('pbc_ops_daily', '3M买断到期');
    var mB6i = mapOf('pbc_ops_daily', '6M买断投放'), mB6o = mapOf('pbc_ops_daily', '6M买断到期');
    var mMlfi = mapOf('pbc_ops_daily', 'MLF投放'), mMlfo = mapOf('pbc_ops_daily', 'MLF到期');
    var mCusi = mapOf('pbc_ops_daily', '国库定存投放'), mCuso = mapOf('pbc_ops_daily', '国库定存到期');
    var omo = ds('omo_detail') || [], mOmo = {};
    omo.forEach(function (e) {
      var d = (e['日期'] || '').slice(0, 10); if (d.length < 10) return;
      var op = e['操作'] || '', amt = e['投放到期']; if (amt === null || isNaN(amt)) amt = 0;
      var o = mOmo[d] || (mOmo[d] = {});
      if (/买断式逆回购3M/.test(op) && /投放/.test(op)) o.b3i = (o.b3i || 0) + amt;
      else if (/买断式逆回购3M/.test(op) && /到期/.test(op)) o.b3o = (o.b3o || 0) + amt;
      else if (/买断式逆回购6M/.test(op) && /投放/.test(op)) o.b6i = (o.b6i || 0) + amt;
      else if (/买断式逆回购6M/.test(op) && /到期/.test(op)) o.b6o = (o.b6o || 0) + amt;
      else if (/MLF/.test(op) && /投放/.test(op)) o.mlfi = (o.mlfi || 0) + amt;
      else if (/MLF/.test(op) && /到期/.test(op)) o.mlfo = (o.mlfo || 0) + amt;
      else if (/国库/.test(op) && /投放/.test(op)) o.cusi = (o.cusi || 0) + amt;
      else if (/国库/.test(op) && /到期/.test(op)) o.cuso = (o.cuso || 0) + amt;
    });
    function fb(map, snap, key) { var v = nz(map[dsx]); if (v !== null && v !== 0) return v; var s = snap[key]; return (s === undefined || s === 0) ? null : s; }

    var rows = [];
    for (var day = 1; day <= dim; day++) {
      var dsx = Y + '-' + pad2(M) + '-' + pad2(day);
      var o = mOmo[dsx] || {};
      var onIn = nz(mOnIn[dsx]), onOut = nz(mOnOut[dsx]);
      var d7In = nz(m7In[dsx]), d7Out = nz(m7Out[dsx]);
      var d14In = nz(m14In[dsx]), d14Out = nz(m14Out[dsx]);
      var gov = nz(mGov[dsx]);
      var lgb = nz(mLgb[dsx]);
      var cny = (gov !== null && lgb !== null) ? (gov - lgb) : null;
      var ncdIn = nz(mNcdIn[dsx]);
      var ncdOut = nz(mNcdOut[dsx]);
      var injSum = addAny([onIn, d7In, d14In]), wdrSum = addAny([onOut, d7Out, d14Out]);
      var omoNet = (injSum !== null || wdrSum !== null) ? ((injSum || 0) - (wdrSum || 0)) : null;
      rows.push({
        date: dsx, weekday: WD[new Date(dsx + 'T00:00:00').getDay()],
        onIn: onIn, onOut: onOut, d7In: d7In, d7Out: d7Out, d14In: d14In, d14Out: d14Out,
        b3i: fb(mB3i, o, 'b3i'), b3o: fb(mB3o, o, 'b3o'), b6i: fb(mB6i, o, 'b6i'), b6o: fb(mB6o, o, 'b6o'),
        mlfi: fb(mMlfi, o, 'mlfi'), mlfo: fb(mMlfo, o, 'mlfo'), cusi: fb(mCusi, o, 'cusi'), cuso: fb(mCuso, o, 'cuso'),
        gov: gov, cny: cny, lgb: lgb, ncdIn: ncdIn, ncdOut: ncdOut, omoNet: omoNet
      });
    }
    return { ym: Y + '年' + M + '月', ymKey: Y + '-' + pad2(M), rows: rows, taxDay: taxDeadline(Y, M) };
  }

  function pCalendar() {
    var h = '';
    var cal = calendarRows(S.calMonth);
    var rows = cal.rows;

    // 月份下拉：近 5 年（以底稿最后一个月为上限）
    var rr = ds('reverse_repo_balance');
    var lastYm = (rr && rr.dates && rr.dates.length) ? rr.dates[rr.dates.length - 1].slice(0, 7) : lastDate(0).slice(0, 7);
    var months = [], d = new Date(+lastYm.slice(0, 4), +lastYm.slice(5, 7) - 1, 1);
    for (var i = 0; i < 60; i++) {
      months.unshift(d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1));
      d.setMonth(d.getMonth() - 1);
    }
    var curYm = S.calMonth || lastYm;

    h += '<div class="alertbar"><h3><span class="tagwarn">全月</span>流动性日历 · ' + esc(cal.ym) +
      '（' + rows[0].date + ' ~ ' + rows[rows.length - 1].date + '，共 ' + rows.length + ' 日）</h3>' +
      '<div class="cols"><ul>' +
      '<li><b>OMO 隔夜/7D/14D 起息(投放)·到期</b>、<b>3M/6M买断·MLF·国库定存 起息/到期</b> 与 <b>政府债净缴款(合计)</b> 为全月真实日度数据（买断/MLF/国库定存来自 <b>Wind EDB + 森浦 Qeubee</b> 实时源；3M/6M 买断到期由投放期限表推导并向森浦权威到期日吸附）。</li>' +
      '<li><b>地方债净缴款</b>为 Wind 日度净融资（<b>2024-09 起</b>）；<b>国债净缴款 = 政府债净缴款合计 − 地方债</b>（残差推算）。更早月份分项显示 <code>—</code>；<b>3M/6M 买断 2024-10 起</b>才有数据。</li>' +
      '<li><b>存单起息</b>为 <b>Wind 日度发行数据</b>（按「起息日 = 发行日 + 1 个工作日」平移，2021-10 起）；<b>存单到期</b>由周度值按 7 天均摊到日。</li>' +
      '<li><span style="color:var(--up);font-weight:700">红色日期</span> = <b>缴税截止日</b>（每月 15 日，遇周末顺延）；本月至 <b>' + cal.taxDay + '</b>。</li>' +
      '</ul></div></div>';

    h += '<div style="margin:0 0 8px"><label style="font-size:12px;color:var(--text-3);margin-right:6px">选择月份（近5年）：</label>' +
      '<select id="calMonth" class="sel">' + months.map(function (m) {
        return '<option value="' + m + '"' + (m === curYm ? ' selected' : '') + '>' + m.replace('-', ' 年 ') + ' 月</option>';
      }).join('') + '</select>' +
      ' <span style="font-size:11px;color:var(--text-3)">切换月份后表格与提示同步更新</span></div>';

    function cell(v, colorize) {
      if (v === null || v === undefined) return { html: '<span class="na">—</span>' };
      if (colorize) return { html: '<span class="' + (v >= 0 ? 'down' : 'up') + '">' + fmtBig(v) + '</span>' };
      return { html: fmtBig(v) };
    }
    function dateCell(r, taxDay) {
      var isTax = r.date === taxDay;
      return { html: '<span class="' + (isTax ? 'taxday' : '') + '">' + r.date + (isTax ? '<span class="taxtag">缴税截止</span>' : '') + '</span>' };
    }
    h += card('流动性日历（逐日 · 全月）', '单位：亿元 · 点击月份下拉切换',
      '<div class="tb-wrap">' + tbl(
        ['日期', '星期',
          '隔夜OMO起息', '隔夜OMO到期', '7DOMO起息', '7DOMO到期', '14DOMO起息', '14DOMO到期', 'OMO净投放',
          '3M买断起息', '3M买断到期', '6M买断起息', '6M买断到期',
          'MLF起息', 'MLF到期', '国库定存起息', '国库定存到期',
          '国债净缴款', '地方债净缴款', '政府债净缴款(合计)', '存单起息', '存单到期'],
        rows.map(function (r) {
          return [
            dateCell(r, cal.taxDay), r.weekday,
            cell(r.onIn), cell(r.onOut), cell(r.d7In), cell(r.d7Out), cell(r.d14In), cell(r.d14Out),
            cell(r.omoNet, true),
            cell(r.b3i), cell(r.b3o), cell(r.b6i), cell(r.b6o),
            cell(r.mlfi), cell(r.mlfo), cell(r.cusi), cell(r.cuso),
            cell(r.cny, true), cell(r.lgb, true), cell(r.gov), cell(r.ncdIn), cell(r.ncdOut)
          ];
        })) + '</div>');
    setTimeout(function () {
      var sel = document.getElementById('calMonth');
      if (sel) sel.onchange = function () { S.calMonth = sel.value; render(); };
    }, 0);

    // 仅保留：政府债净缴款季节性（每月合计）折线 + 热力图
    h += '<div class="grid g23">';
    h += card('政府债净缴款季节性（每月合计）', '横轴月份 · 每年一条线', '<div id="calS"></div>');
    h += card('近' + S.nYears + '年政府债净缴款逐月复盘（热力图）', '行=年份 列=月份 · 亿元', '<div id="calM"></div>');
    h += '</div>';
    setTimeout(function () {
      var g = get('gov_bond_monthly', '政府债月度净融资额');
      if (g) {
        var s = seasonal(g.dates, g.values, 'sum', S.nYears);
        var yrs = s.years;
        Charts.render($('#calS'), {
          labels: MONTHS, xKind: 'month',
          series: yrs.map(function (y) {
            return { name: y + '年', data: s.byYear[y], axis: 0, dec: 0, width: y === yrs[yrs.length - 1] ? 2.6 : 1.5, color: y === yrs[yrs.length - 1] ? '#f2637b' : undefined };
          }).concat([{ name: '均值', data: s.avg, axis: 0, color: '#8b93a7', dash: '5 4', dec: 0 }]),
          y0: { dec: 0 }, height: 300, toolFmt: function (v) { return fmtBig(v) + ' 亿'; }
        });
        Charts.matrix($('#calM'), { years: s.years, byYear: s.byYear, dec: 0, unit: '亿' });
      }
    }, 0);
    return h;
  }

  /* ================================================== 页面：央行操作与官媒 */
  function pPbc() {
    var omo = ds('omo_detail') || [];
    var h = '';
    var tips = [];
    var net = 0;
    omo.forEach(function (e) {
      if (/投放/.test(e['操作'] || '')) net += (e['投放到期'] || 0);
      if (/到期/.test(e['操作'] || '')) net -= (e['投放到期'] || 0);
    });
    (S.bundle.notes.liq || []).filter(function (t) { return /央行|公开市场|逆回购/.test(t); }).slice(0, 5).forEach(function (t) { tips.push(t); });
    tips.push('近期公开市场净投放合计约 <b>' + fmtBig(net) + ' 亿元</b>（按底稿明细汇总）');
    h += alertBar('央行操作要点', tips);

    // 余额季节性：OMO（日度·月日轴·缺失沿用上日） + 中长期(买断+MLF)（月度）
    h += '<div class="grid g2">';
    h += card('OMO 余额季节性（日余额 · 横轴 月·日）', '缺失沿用上日余额 · 2022-2026 每年一条日线', '<div id="omoBalS"></div>');
    h += card('中长期（买断+MLF）余额季节性', '月度余额 · 每年一条线', '<div id="mlBalS"></div>');
    h += '</div>';

    // 央行净投放季节性（年内累计·全口径）+ 逐月热力图
    h += '<div class="grid g23">';
    h += card('央行净投放季节性（年内累计 · 全口径）', 'OMO+买断+MLF+国库定存 · 横轴 月·日 · 缺失沿用上日', '<div id="pbcS"></div>');
    h += card('近5年逐月净投放（热力图）', '亿元 · 行=年 列=月', '<div id="pbcM"></div>');
    h += '</div>';

    // 官媒 / 公开讲话（微信公众号：中国人民银行、金融时报 等——摘要与简评 + 实时刷新）
    var MEDIA = [
      { src: '中国人民银行', date: '2026-09-30', title: '10月8日开展1.2万亿元买断式逆回购（3个月）',
        sum: '为保持流动性充裕，10月8日以固定数量、利率招标、多重价位方式开展12000亿元买断式逆回购，期限3个月(89天)，到期日2027-01-05；对冲当月1万亿到期，加量续作净投放2000亿元。',
        cm: '中期流动性持续加量，护航政府债发行与稳增长；买断式余额升至约6.5万亿。买断式/MLF放量之下，短期降准或延后。' },
      { src: '中国人民银行', date: '2026-09-28', title: '14天期逆回购3000亿 + 结构性工具优化',
        sum: '9月28日开展3000亿元14天期逆回购；并优化结构性工具——PSL利率下调0.25pct至1.5%、“六张网”扩围、科创技改再贷款+2000亿、支农支小再贷款+5000亿。',
        cm: '总量稳、结构进，“四箭齐发”兼顾稳增长与产业导向；跨节资金以隔夜+14天搭配呵护。' },
      { src: '中国人民银行', date: '2026-09-24', title: '9月28日-10月8日开展隔夜逆回购（日上限1万亿）',
        sum: '新增隔夜逆回购品种，国庆前后每日操作量上限由6000亿上调至1万亿，固定利率数量招标，“削峰填谷”覆盖跨节流动性压力。',
        cm: '隔夜品种或逐步成为短期流动性调节核心，并为隔夜利率成为主要政策利率铺路；短端调控更精细。' },
      { src: '金融时报', date: '2026-09-30', title: '资金面点评：DR001/DR007 围绕政策利率下方运行',
        sum: '9月30日 DR001 加权1.3611%、DR007 1.3665%，位于政策利率(1.4%)下方；隔夜逆回购跨节投放，资金面平稳充裕。',
        cm: '短端利率平稳印证央行呵护；关注10月政府债净融资高峰下宽货币的延续性。' },
      { src: '中国人民银行', date: '2026-09', title: '货币政策委员会2026年第三季度例会',
        sum: '会议明确下阶段综合运用并适时调整货币政策工具，保持流动性充裕，加大稳增长支持力度。',
        cm: '总量态度温和偏宽松，为四季度政府债放量与新型政策性金融工具落地营造适宜货币环境。' }
    ];
    function renderMedia() {
      var host = $('#mediaBody'); if (!host) return;
      var news = (S.live && S.live.news) || [];
      var html = MEDIA.map(function (x) {
        return '<div class="ev" style="display:block;padding:8px 0;border-bottom:1px dashed var(--border)">' +
          '<div><span class="d">' + esc(x.date) + '</span> <span class="ty ty-官媒">' + esc(x.src) + '</span> <b>' + esc(x.title) + '</b></div>' +
          '<div style="margin:5px 0 2px;color:var(--text-2)"><b>摘要：</b>' + esc(x.sum) + '</div>' +
          '<div style="color:var(--accent)"><b>简评：</b>' + esc(x.cm) + '</div></div>';
      }).join('');
      if (news.length) {
        html += '<div class="sect-title" style="margin-top:8px">实时供稿（' + news.length + ' 条）</div><div class="evlist">' + news.map(function (x) {
          return '<div class="ev"><span class="d">' + esc(x.date) + '</span><span class="ty ty-官媒">' + esc(x.src || '官媒') + '</span><span class="ti">' + esc(x.title) + '</span></div>';
        }).join('') + '</div>';
      } else {
        html += '<div class="note">以上为据央行公告与官媒报道整理的摘要与简评（分析师维护）；点击上方「刷新供稿」可拉取实时利率时讯/政策舆情。</div>';
      }
      host.innerHTML = html;
    }
    h += '<div class="grid g2">';
    h += card('官媒发声（微信公众号 · 摘要与简评）', '中国人民银行 / 金融时报 等',
      '<div style="margin-bottom:6px"><button id="mediaRefresh" class="btn" type="button">⟳ 刷新供稿</button> <span id="mediaStatus" style="font-size:11px;color:var(--text-3)"></span></div>' +
      '<div id="mediaBody"></div>');
    h += card('政策与流动性事件轴', '近5年 · 降准 / 降息 / 结构性货币工具 / 税期 / MLF',
      evList(lastDate(-1826), lastDate(60), ['降准', '政策利率', '结构性', '税期', 'MLF']));
    h += '</div>';

    setTimeout(function () {
      // 1) OMO 余额季节性（日度·月·日轴，缺失沿用上日余额）
      var omoBal = get('reverse_repo_balance', '逆回购余额');
      if (omoBal) {
        var obFull = dailyCarryForward(omoBal);
        var sd = seasonalDay(obFull.dates, obFull.values, 5);
        var oy = sd.years;
        var oseries = oy.map(function (y) {
          return { name: y + '年', data: sd.byYear[y], axis: 0, dec: 0, width: y === oy[oy.length - 1] ? 2.6 : 1.5, color: y === oy[oy.length - 1] ? '#f2637b' : undefined };
        });
        oseries.push({ name: '均值', data: sd.avg, axis: 0, color: '#8b93a7', dash: '5 4', width: 1.6, dec: 0 });
        Charts.render($('#omoBalS'), { labels: monthDayLabels(), xKind: 'date', xTicks: monthDayTicks(), series: oseries, y0: { dec: 0 }, height: 300, toolFmt: function (v) { return fmtBig(v) + ' 亿'; } });
      }
      // 2) 中长期（买断+MLF）余额季节性（月度）
      var mlfb = get('mid_long_injection', 'MLF余额');
      var bb3 = get('mid_long_injection', '3M买断式'), bb6 = get('mid_long_injection', '6M买断式');
      if (mlfb) {
        var comb = mlfb.values.map(function (v, i) {
          if (v === null || v === undefined || isNaN(v)) return null;
          return v + ((bb3 && bb3.values[i]) || 0) + ((bb6 && bb6.values[i]) || 0);
        });
        var sm = seasonal(mlfb.dates, comb, 'last', S.nYears);
        var my = sm.years;
        var mseries = my.map(function (y) {
          return { name: y + '年', data: sm.byYear[y], axis: 0, dec: 0, width: y === my[my.length - 1] ? 2.6 : 1.5, color: y === my[my.length - 1] ? '#f2637b' : undefined };
        });
        mseries.push({ name: '均值', data: sm.avg, axis: 0, color: '#8b93a7', dash: '5 4', width: 1.6, dec: 0 });
        Charts.render($('#mlBalS'), { labels: MONTHS, xKind: 'month', series: mseries, y0: { dec: 0 }, height: 300, toolFmt: function (v) { return fmtBig(v) + ' 亿'; } });
      }
      // 3) 央行净投放季节性（年内累计·全口径，横轴 月·日，缺失沿用上日）+ 逐月热力图
      var nd = comprehensiveNetDaily();
      if (nd && nd.dates.length) {
        var nc = cumulativeFromDaily(nd);
        var ncf = dailyCarryForward(nc);
        var sn = seasonalDay(ncf.dates, ncf.values, 5);
        var ny = sn.years;
        var nseries = ny.map(function (y) {
          return { name: y + '年', data: sn.byYear[y], axis: 0, dec: 0, width: y === ny[ny.length - 1] ? 2.6 : 1.5, color: y === ny[ny.length - 1] ? '#f2637b' : undefined };
        });
        nseries.push({ name: '均值', data: sn.avg, axis: 0, color: '#8b93a7', dash: '5 4', width: 1.6, dec: 0 });
        Charts.render($('#pbcS'), { labels: monthDayLabels(), xKind: 'date', xTicks: monthDayTicks(), series: nseries, y0: { dec: 0 }, height: 300, toolFmt: function (v) { return fmtBig(v) + ' 亿'; } });
        var sm2 = seasonal(nd.dates, nd.values, 'sum', 5);
        Charts.matrix($('#pbcM'), { years: sm2.years, byYear: sm2.byYear, dec: 0, unit: '亿' });
      }
      // 4) 官媒渲染 + 刷新按钮（实时拉取供稿）
      renderMedia();
      var btn = $('#mediaRefresh');
      if (btn) btn.onclick = function () {
        var st = $('#mediaStatus');
        if (st) st.textContent = '刷新中…';
        fetch('data/live.json?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('http')); }).then(function (j) {
          S.live = j || {}; renderMedia();
          if (st) st.textContent = '已刷新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ((j && j.news && j.news.length) ? '（实时 ' + j.news.length + ' 条）' : '');
        }).catch(function () {
          renderMedia();
          if (st) st.textContent = '离线版：已刷新内置供稿';
        });
      };
    }, 0);
    return h;
  }

  /* ------------------------------------------------ 资金页：日度季节性面板（月分区/税期/月末/点选） */
  var FUND_BANDS = (function () { var b = []; for (var m = 0; m < 12; m++) b.push({ m: m, i0: MONTH_START[m], i1: m < 11 ? MONTH_START[m + 1] - 1 : 364 }); return b; })();
  var FUND_TAX = (function () { var b = []; for (var m = 0; m < 12; m++) { b.push({ i0: MONTH_START[m] + 12, i1: Math.min(364, MONTH_START[m] + 17) }); } return b; })();
  var FUND_ME = (function () { var b = []; for (var m = 0; m < 12; m++) { var last = m < 11 ? MONTH_START[m + 1] - 1 : 364; b.push({ i0: last - 2, i1: last }); } return b; })();
  var FUND_DRIVER = {
    0: '1月：跨年流动性回笼后逐步恢复，叠加春节前取现与信贷“开门红”集中投放，资金需求旺，利率与分层易走高。',
    1: '2月：春节因素致现金大量走款，节前紧、节后到期续作放量，波动显著放大。',
    2: '3月：季末，MPA 考核与存款冲量，银行融出意愿下降，非银分层通常明显走阔。',
    3: '4月：季初，财政支出集中投放，资金面通常转松，利率与分层回落。',
    4: '5月：企业所得税汇算清缴大月，税期缴款规模大，资金面易阶段性收紧。',
    5: '6月：半年末考核叠加季末与税期，利率与分层共振走高。',
    6: '7月：季初但为传统缴税大月，税期冲击明显，随后通常转松。',
    7: '8月：政府债发行高峰、缴款集中回笼，资金面阶段性承压。',
    8: '9月：季末叠加国庆跨节，银行备付与考核需求上升，利率与分层走高。',
    9: '10月：季初+国庆后现金回流，通常转松；关注政府债净融资与买断式续作。',
    10: '11月：税期叠加年末考核临近，资金面逐步收紧，分层走阔。',
    11: '12月：年末考核与跨年备付，利率与分层通常显著走高。'
  };
  /** 解析指标 → {dates, values, unit, dec, src}；支持 spread(分层) 与 derive(派生) */
  function resolveMetric(m) {
    if (!m) return null;
    if (m.derive) { try { return m.derive(); } catch (e) { return null; } }
    if (m.spread) {
      var a = get(m.key, m.name), b = get(m.spread.key, m.spread.name);
      if (!a || !b) return null;
      var bm = {}; b.values.forEach(function (v, i) { if (v !== null && !isNaN(v)) bm[b.dates[i]] = v; });
      var dates = [], vals = [];
      a.values.forEach(function (v, i) { var dv = bm[a.dates[i]]; if (v !== null && !isNaN(v) && dv !== undefined) { dates.push(a.dates[i]); vals.push((v - dv) * 100); } });
      return { dates: dates, values: vals, unit: m.unit || 'bp', dec: m.dec || 1, src: a.src };
    }
    var g = get(m.key, m.name);
    if (!g) return null;
    return { dates: g.dates, values: g.values, unit: m.unit, dec: m.dec, src: g.src };
  }
  function renderFundingChart(g, m) {
    var host = document.getElementById(g.id + '_chart');
    if (!host) return;
    var r = resolveMetric(m);
    if (!r || !r.dates.length) { host.innerHTML = '<div class="empty">无数据</div>'; return; }
    var full = dailyCarryForward({ dates: r.dates, values: r.values });
    var sd = seasonalDay(full.dates, full.values, 5);
    var yrs = sd.years;
    var series = yrs.map(function (y) {
      return { name: y + '年', data: sd.byYear[y], axis: 0, dec: r.dec, width: y === yrs[yrs.length - 1] ? 2.6 : 1.5, color: y === yrs[yrs.length - 1] ? '#f2637b' : undefined };
    });
    series.push({ name: '均值', data: sd.avg, axis: 0, color: '#8b93a7', dash: '5 4', width: 1.6, dec: r.dec });
    Charts.render(host, {
      labels: monthDayLabels(), xKind: 'date', xTicks: monthDayTicks(),
      monthBands: FUND_BANDS, taxSpans: FUND_TAX, monthEndSpans: FUND_ME, selectedMonth: (g.sel === undefined ? null : g.sel),
      onPick: function (mo) { g.sel = mo; renderFundingChart(g, m); if (g.summary) renderFundingSummary(g, m); },
      series: series, y0: { dec: r.dec }, height: 300,
      toolFmt: function (v) { return fmt(v, r.dec) + r.unit; }
    });
  }
  function renderFundingHeatmap(g, m) {
    var host = document.getElementById(g.id + '_hm');
    if (!host) return;
    var r = resolveMetric(m);
    if (!r) { host.innerHTML = '<div class="empty">无</div>'; return; }
    var sm = seasonal(r.dates, r.values, 'mean', 5);
    Charts.matrix(host, { years: sm.years, byYear: sm.byYear, dec: r.dec, unit: r.unit });
  }
  /** 汇总某指标近5年在指定月份的统计（月均/税期日T/月末） */
  function summarizeMetricMonth(mm, mo) {
    var r = resolveMetric(mm); if (!r) return null;
    var byDate = {}; r.dates.forEach(function (d, i) { if (r.values[i] !== null && !isNaN(r.values[i])) byDate[d] = r.values[i]; });
    var yset = {}; r.dates.forEach(function (d) { yset[d.slice(0, 4)] = 1; });
    var yrList = Object.keys(yset).sort().slice(-5);
    var per = [];
    yrList.forEach(function (y) {
      var ym = y + '-' + String(mo + 1).padStart(2, '0');
      var days = r.dates.filter(function (d) { return d.slice(0, 7) === ym && byDate[d] !== undefined; }).sort();
      if (!days.length) return;
      var vals = days.map(function (d) { return byDate[d]; });
      var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      var tIdx = -1; for (var k = 0; k < days.length; k++) { if (+days[k].slice(8, 10) >= 15) { tIdx = k; break; } }
      if (tIdx < 0) tIdx = days.length - 1;
      per.push({ y: y, mean: mean, t: vals[tIdx], me: vals[vals.length - 1] });
    });
    if (!per.length) return null;
    function avg(fn) { var a = per.map(fn).filter(function (x) { return x !== null && !isNaN(x); }); return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
    return {
      label: mm.t, unit: r.unit, dec: r.dec,
      mean5: avg(function (p) { return p.mean; }),
      tAvg: avg(function (p) { return p.t; }), tJump: avg(function (p) { return p.t - p.mean; }),
      meAvg: avg(function (p) { return p.me; }), meJump: avg(function (p) { return p.me - p.mean; }),
      per: per
    };
  }
  function signJump(v, dec) { if (v === null || v === undefined || isNaN(v)) return '—'; return (v >= 0 ? '+' : '−') + fmt(Math.abs(v), dec); }
  function renderFundingSummary(g, m) {
    var host = document.getElementById(g.id + '_sum');
    if (!host) return;
    var mo = (g.sel === null || g.sel === undefined) ? 8 : g.sel;
    var rows = g.metrics.map(function (mm) { return summarizeMetricMonth(mm, mo); }).filter(Boolean);
    var mn = (mo + 1) + '月';
    if (!rows.length) { host.innerHTML = '<div class="card"><div class="empty">' + mn + ' 暂无数据</div></div>'; return; }
    var body = '<div class="note" style="margin-bottom:8px"><b>驱动因子：</b>' + esc(FUND_DRIVER[mo]) + '</div>';
    body += rows.map(function (row) {
      return '<div style="padding:6px 0;border-bottom:1px dashed var(--border)">' +
        '<b>' + esc(row.label) + '</b>：近5年' + mn + '月均 <b>' + fmt(row.mean5, row.dec) + esc(row.unit) + '</b><br>' +
        '<span style="color:var(--text-2)">税期日T</span> 均值 <b>' + fmt(row.tAvg, row.dec) + esc(row.unit) + '</b>（较月均 ' + signJump(row.tJump, row.dec) + '，' + (row.tJump >= 0 ? '税期冲高' : '税期走低') + '）；' +
        '<span style="color:var(--text-2)">月末最后一个工作日</span> 均值 <b>' + fmt(row.meAvg, row.dec) + esc(row.unit) + '</b>（较月均 ' + signJump(row.meJump, row.dec) + '）。</div>';
    }).join('');
    host.innerHTML = '<div class="card"><header><h4>近5年' + mn + ' 走势摘要与驱动因子（' + esc(g.title) + '）</h4><span class="hint">点击上方月份色带可切换月份</span></header>' + body + '</div>';
  }
  function renderFundingGroups(groups) {
    groups.forEach(function (g) {
      var chipsHost = document.getElementById(g.id + '_chips');
      var active = g.active || 0;
      function draw() {
        var m = g.metrics[active];
        if (g.sel === null || g.sel === undefined) { var r0 = resolveMetric(m); if (r0 && r0.dates.length) g.sel = +r0.dates[r0.dates.length - 1].slice(5, 7) - 1; }
        renderFundingChart(g, m); renderFundingHeatmap(g, m); if (g.summary) renderFundingSummary(g, m);
      }
      if (chipsHost) {
        chipsHost.innerHTML = g.metrics.map(function (mm, i) { return '<span class="chip' + (i === active ? ' on' : '') + '" data-i="' + i + '">' + esc(mm.t) + '</span>'; }).join('');
        Array.prototype.slice.call(chipsHost.querySelectorAll('.chip')).forEach(function (c) {
          c.onclick = function () {
            Array.prototype.slice.call(chipsHost.querySelectorAll('.chip')).forEach(function (x) { x.classList.remove('on'); });
            c.classList.add('on'); active = +c.dataset.i; g.active = active; draw();
          };
        });
      }
      draw();
    });
  }
  /** 顶部关注栏：1-7 组近期情况与明显异常 */
  function fundingAlerts() {
    var out = [];
    function L(key, name) { var g = get(key, name); if (!g) return null; var x = last(g.values); return x ? { d: g.dates[x.i], v: x.v, i: x.i, arr: g.values } : null; }
    function spreadLatest(ka, na, kb, nb) { var a = get(ka, na), b = get(kb, nb); if (!a || !b) return null; var bm = {}; b.values.forEach(function (v, i) { if (v !== null && !isNaN(v)) bm[b.dates[i]] = v; }); for (var i = a.dates.length - 1; i >= 0; i--) { var dv = bm[a.dates[i]]; if (a.values[i] !== null && dv !== undefined) return { d: a.dates[i], v: (a.values[i] - dv) * 100, i: i }; } return null; }
    function dev20(o) { if (!o) return null; var a = []; for (var k = Math.max(0, o.i - 20); k < o.i; k++) if (o.arr[k] !== null && !isNaN(o.arr[k])) a.push(o.arr[k]); if (a.length < 5) return null; var mn = a.reduce(function (x, y) { return x + y; }, 0) / a.length; return o.v - mn; }
    function tag(o, unit, dec, thr) { var dv = dev20(o); if (dv === null || Math.abs(dv) < thr) return ''; return '，较近20均' + (dv > 0 ? '<span class="up">高' + fmt(dv, dec) + unit + '</span>' : '<span class="down">低' + fmt(-dv, dec) + unit + '</span>') + ' <span class="tagwarn">异常</span>'; }
    var d1 = L('funding_rates', 'DR001'), r7 = L('funding_rates', 'R007');
    if (d1 && r7) out.push('<b>① 价格</b>：' + d1.d + ' DR001 <b>' + fmt(d1.v, 2) + '%</b> / R007 <b>' + fmt(r7.v, 2) + '%</b>' + tag(d1, 'bp', 1, 8));
    var ovn = spreadLatest('funding_rates', 'R001', 'funding_rates', 'DR001'), svn = spreadLatest('funding_rates', 'R007', 'funding_rates', 'DR007');
    if (ovn && svn) out.push('<b>② 分层</b>：隔夜分层 <b>' + fmt(ovn.v, 1) + 'bp</b> / 7天分层 <b>' + fmt(svn.v, 1) + 'bp</b>' + (ovn.v > 20 ? ' <span class="tagwarn">隔夜分层偏阔</span>' : ''));
    var pv = L('repo_volume', '银行间质押式回购');
    if (pv) out.push('<b>③ 交易量</b>：银行间质押式回购 <b>' + fmtBig(pv.v) + '亿</b>（' + pv.d + '）');
    var big = L('repo_institution', '大行净融出'), mmf = L('repo_institution', '货基净融出');
    if (big && mmf) out.push('<b>④ 净融出</b>：大行 <b>' + fmtBig(big.v) + '亿</b> / 货基 <b>' + fmtBig(mmf.v) + '亿</b>' + (big.v < 10000 ? ' <span class="tagwarn">大行融出偏少</span>' : ''));
    var fund = L('nonbank_demand', '基金'), sec = L('nonbank_demand', '券商自营');
    if (fund && sec) out.push('<b>⑤ 净融入</b>：基金 <b>' + fmtBig(fund.v) + '亿</b> / 券商 <b>' + fmtBig(sec.v) + '亿</b>');
    var fr = L('nonbank_demand', '基金回购融入');
    if (fr) out.push('<b>⑥ 杠杆(回购融入)</b>：基金回购融入 <b>' + fmtBig(fr.v) + '亿</b>' + tag(fr, '亿', 0, 3000));
    var li = L('lev_interbank', '银行间杠杆率'), la = L('lev_all', '全市场杠杆率');
    if (li && la) out.push('<b>⑦ 杠杆率</b>：银行间 <b>' + fmt(li.v, 4) + '倍</b> / 全市场 <b>' + fmt(la.v, 4) + '倍</b>' + tag(li, '', 4, 0.01));
    return out;
  }
  var FUND_GROUPS = [
    { id: 'fg1', title: '价格指标', summary: true, metrics: [
      { t: 'DR001', key: 'funding_rates', name: 'DR001', unit: '%', dec: 4 },
      { t: 'R001', key: 'funding_rates', name: 'R001', unit: '%', dec: 4 },
      { t: 'DR007', key: 'funding_rates', name: 'DR007', unit: '%', dec: 4 },
      { t: 'R007', key: 'funding_rates', name: 'R007', unit: '%', dec: 4 }] },
    { id: 'fg2', title: '分层指标', summary: true, metrics: [
      { t: '隔夜分层 R001-DR001', key: 'funding_rates', name: 'R001', unit: 'bp', dec: 1, spread: { key: 'funding_rates', name: 'DR001' } },
      { t: '7天分层 R007-DR007', key: 'funding_rates', name: 'R007', unit: 'bp', dec: 1, spread: { key: 'funding_rates', name: 'DR007' } }] },
    { id: 'fg3', title: '交易量指标', metrics: [
      { t: '同业拆借', key: 'repo_volume', name: '银行间同业拆借', unit: '亿', dec: 0 },
      { t: '质押式回购', key: 'repo_volume', name: '银行间质押式回购', unit: '亿', dec: 0 },
      { t: '买断式回购', key: 'repo_volume', name: '银行间买断式回购', unit: '亿', dec: 0 },
      { t: 'R001成交', key: 'repo_volume', name: 'R001', unit: '亿', dec: 0 },
      { t: 'R007成交', key: 'repo_volume', name: 'R007', unit: '亿', dec: 0 },
      { t: 'R014成交', key: 'repo_volume', name: 'R014', unit: '亿', dec: 0 },
      { t: 'R021成交', key: 'repo_volume', name: 'R021', unit: '亿', dec: 0 },
      { t: 'R1M成交', key: 'repo_volume', name: 'R1M', unit: '亿', dec: 0 }] },
    { id: 'fg4', title: '机构行为·净融出', metrics: [
      { t: '银行体系净融出', key: 'repo_institution', name: '银行体系净融出', unit: '亿', dec: 0 },
      { t: '大行净融出', key: 'repo_institution', name: '大行净融出', unit: '亿', dec: 0 },
      { t: '货基净融出', key: 'repo_institution', name: '货基净融出', unit: '亿', dec: 0 }] },
    { id: 'fg5', title: '机构行为·净融入', metrics: [
      { t: '基金净融入', key: 'nonbank_demand', name: '基金', unit: '亿', dec: 0 },
      { t: '券商净融入', key: 'nonbank_demand', name: '券商自营', unit: '亿', dec: 0 },
      { t: '保险净融入', key: 'nonbank_demand', name: '保险', unit: '亿', dec: 0 },
      { t: '理财净融入', key: 'nonbank_demand', name: '理财', unit: '亿', dec: 0 },
      { t: '其他资管净融入', key: 'nonbank_demand', name: '其他资管产品', unit: '亿', dec: 0 }] },
    { id: 'fg6', title: '机构行为·杠杆(回购融入)', metrics: [
      { t: '基金回购融入', key: 'nonbank_demand', name: '基金回购融入', unit: '亿', dec: 0 },
      { t: '非基金回购融入', unit: '亿', dec: 0, derive: function () { var tot = get('nonbank_demand', '非银净融入合计'), f = get('nonbank_demand', '基金回购融入'); if (!tot || !f) return null; var fm = {}; f.values.forEach(function (v, i) { if (v !== null && !isNaN(v)) fm[f.dates[i]] = v; }); var dates = [], vals = []; tot.values.forEach(function (v, i) { if (v !== null && !isNaN(v)) { dates.push(tot.dates[i]); vals.push(v - (fm[tot.dates[i]] || 0)); } }); return { dates: dates, values: vals, unit: '亿', dec: 0, src: tot.src }; } },
      { t: '全市场待购回(逆回购融入)', unit: '亿', dec: 0, derive: function () { var g = get('lev_interbank', '待购回余额'); return g ? { dates: g.dates, values: g.values, unit: '亿', dec: 0, src: g.src } : null; } }] },
    { id: 'fg7', title: '机构行为·杠杆率', metrics: [
      { t: '银行间杠杆率', key: 'lev_interbank', name: '银行间杠杆率', unit: '倍', dec: 4 },
      { t: '交易所杠杆率', key: 'lev_exchange', name: '交易所杠杆率', unit: '倍', dec: 4 },
      { t: '全市场杠杆率', key: 'lev_all', name: '全市场杠杆率', unit: '倍', dec: 4 },
      { t: '非银杠杆率', key: 'lev_nonbank', name: '非银杠杆率', unit: '倍', dec: 4 }] }
  ];

  /* ------------------------------------------------ 资金页：日度季节性面板（月分区/税期/月末/点选） */
  var FUND_BANDS = (function () { var b = []; for (var m = 0; m < 12; m++) b.push({ m: m, i0: MONTH_START[m], i1: m < 11 ? MONTH_START[m + 1] - 1 : 364 }); return b; })();
  var FUND_TAX = (function () { var b = []; for (var m = 0; m < 12; m++) { b.push({ i0: MONTH_START[m] + 12, i1: Math.min(364, MONTH_START[m] + 17) }); } return b; })();
  var FUND_ME = (function () { var b = []; for (var m = 0; m < 12; m++) { var last = m < 11 ? MONTH_START[m + 1] - 1 : 364; b.push({ i0: last - 2, i1: last }); } return b; })();
  var FUND_DRIVER = {
    0: '1月：跨年流动性回笼后逐步恢复，叠加春节前取现与信贷“开门红”集中投放，资金需求旺，利率与分层易走高。',
    1: '2月：春节因素致现金大量走款，节前紧、节后到期续作放量，波动显著放大。',
    2: '3月：季末，MPA 考核与存款冲量，银行融出意愿下降，非银分层通常明显走阔。',
    3: '4月：季初，财政支出集中投放，资金面通常转松，利率与分层回落。',
    4: '5月：企业所得税汇算清缴大月，税期缴款规模大，资金面易阶段性收紧。',
    5: '6月：半年末考核叠加季末与税期，利率与分层共振走高。',
    6: '7月：季初但为传统缴税大月，税期冲击明显，随后通常转松。',
    7: '8月：政府债发行高峰、缴款集中回笼，资金面阶段性承压。',
    8: '9月：季末叠加国庆跨节，银行备付与考核需求上升，利率与分层走高。',
    9: '10月：季初+国庆后现金回流，通常转松；关注政府债净融资与买断式续作。',
    10: '11月：税期叠加年末考核临近，资金面逐步收紧，分层走阔。',
    11: '12月：年末考核与跨年备付，利率与分层通常显著走高。'
  };
  /** 解析指标 → {dates, values, unit, dec, src}；支持 spread(分层) 与 derive(派生) */
  function resolveMetric(m) {
    if (!m) return null;
    if (m.derive) { try { return m.derive(); } catch (e) { return null; } }
    if (m.spread) {
      var a = get(m.key, m.name), b = get(m.spread.key, m.spread.name);
      if (!a || !b) return null;
      var bm = {}; b.values.forEach(function (v, i) { if (v !== null && !isNaN(v)) bm[b.dates[i]] = v; });
      var dates = [], vals = [];
      a.values.forEach(function (v, i) { var dv = bm[a.dates[i]]; if (v !== null && !isNaN(v) && dv !== undefined) { dates.push(a.dates[i]); vals.push((v - dv) * 100); } });
      return { dates: dates, values: vals, unit: m.unit || 'bp', dec: m.dec || 1, src: a.src };
    }
    var g = get(m.key, m.name);
    if (!g) return null;
    return { dates: g.dates, values: g.values, unit: m.unit, dec: m.dec, src: g.src };
  }
  function renderFundingChart(g, m) {
    var host = document.getElementById(g.id + '_chart');
    if (!host) return;
    var r = resolveMetric(m);
    if (!r || !r.dates.length) { host.innerHTML = '<div class="empty">无数据</div>'; return; }
    var full = dailyCarryForward({ dates: r.dates, values: r.values });
    var sd = seasonalDay(full.dates, full.values, 5);
    var yrs = sd.years;
    var series = yrs.map(function (y) {
      return { name: y + '年', data: sd.byYear[y], axis: 0, dec: r.dec, width: y === yrs[yrs.length - 1] ? 2.6 : 1.5, color: y === yrs[yrs.length - 1] ? '#f2637b' : undefined };
    });
    series.push({ name: '均值', data: sd.avg, axis: 0, color: '#8b93a7', dash: '5 4', width: 1.6, dec: r.dec });
    Charts.render(host, {
      labels: monthDayLabels(), xKind: 'date', xTicks: monthDayTicks(),
      monthBands: FUND_BANDS, taxSpans: FUND_TAX, monthEndSpans: FUND_ME, selectedMonth: (g.sel === undefined ? null : g.sel),
      onPick: function (mo) { g.sel = mo; renderFundingChart(g, m); if (g.summary) renderFundingSummary(g, m); },
      series: series, y0: { dec: r.dec }, height: 300,
      toolFmt: function (v) { return fmt(v, r.dec) + r.unit; }
    });
  }
  function renderFundingHeatmap(g, m) {
    var host = document.getElementById(g.id + '_hm');
    if (!host) return;
    var r = resolveMetric(m);
    if (!r) { host.innerHTML = '<div class="empty">无</div>'; return; }
    var sm = seasonal(r.dates, r.values, 'mean', 5);
    Charts.matrix(host, { years: sm.years, byYear: sm.byYear, dec: r.dec, unit: r.unit });
  }
  /** 汇总某指标近5年在指定月份的统计（月均/税期日T/月末） */
  function summarizeMetricMonth(mm, mo) {
    var r = resolveMetric(mm); if (!r) return null;
    var byDate = {}; r.dates.forEach(function (d, i) { if (r.values[i] !== null && !isNaN(r.values[i])) byDate[d] = r.values[i]; });
    var yset = {}; r.dates.forEach(function (d) { yset[d.slice(0, 4)] = 1; });
    var yrList = Object.keys(yset).sort().slice(-5);
    var per = [];
    yrList.forEach(function (y) {
      var ym = y + '-' + String(mo + 1).padStart(2, '0');
      var days = r.dates.filter(function (d) { return d.slice(0, 7) === ym && byDate[d] !== undefined; }).sort();
      if (!days.length) return;
      var vals = days.map(function (d) { return byDate[d]; });
      var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      var tIdx = -1; for (var k = 0; k < days.length; k++) { if (+days[k].slice(8, 10) >= 15) { tIdx = k; break; } }
      if (tIdx < 0) tIdx = days.length - 1;
      per.push({ y: y, mean: mean, t: vals[tIdx], me: vals[vals.length - 1] });
    });
    if (!per.length) return null;
    function avg(fn) { var a = per.map(fn).filter(function (x) { return x !== null && !isNaN(x); }); return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
    return {
      label: mm.t, unit: r.unit, dec: r.dec,
      mean5: avg(function (p) { return p.mean; }),
      tAvg: avg(function (p) { return p.t; }), tJump: avg(function (p) { return p.t - p.mean; }),
      meAvg: avg(function (p) { return p.me; }), meJump: avg(function (p) { return p.me - p.mean; }),
      per: per
    };
  }
  function signJump(v, dec) { if (v === null || v === undefined || isNaN(v)) return '—'; return (v >= 0 ? '+' : '−') + fmt(Math.abs(v), dec); }
  function renderFundingSummary(g, m) {
    var host = document.getElementById(g.id + '_sum');
    if (!host) return;
    var mo = (g.sel === null || g.sel === undefined) ? 8 : g.sel;
    var rows = g.metrics.map(function (mm) { return summarizeMetricMonth(mm, mo); }).filter(Boolean);
    var mn = (mo + 1) + '月';
    if (!rows.length) { host.innerHTML = '<div class="card"><div class="empty">' + mn + ' 暂无数据</div></div>'; return; }
    var body = '<div class="note" style="margin-bottom:8px"><b>驱动因子：</b>' + esc(FUND_DRIVER[mo]) + '</div>';
    body += rows.map(function (row) {
      return '<div style="padding:6px 0;border-bottom:1px dashed var(--border)">' +
        '<b>' + esc(row.label) + '</b>：近5年' + mn + '月均 <b>' + fmt(row.mean5, row.dec) + esc(row.unit) + '</b><br>' +
        '<span style="color:var(--text-2)">税期日T</span> 均值 <b>' + fmt(row.tAvg, row.dec) + esc(row.unit) + '</b>（较月均 ' + signJump(row.tJump, row.dec) + '，' + (row.tJump >= 0 ? '税期冲高' : '税期走低') + '）；' +
        '<span style="color:var(--text-2)">月末最后一个工作日</span> 均值 <b>' + fmt(row.meAvg, row.dec) + esc(row.unit) + '</b>（较月均 ' + signJump(row.meJump, row.dec) + '）。</div>';
    }).join('');
    host.innerHTML = '<div class="card"><header><h4>近5年' + mn + ' 走势摘要与驱动因子（' + esc(g.title) + '）</h4><span class="hint">点击上方月份色带可切换月份</span></header>' + body + '</div>';
  }
  function renderFundingGroups(groups) {
    groups.forEach(function (g) {
      var chipsHost = document.getElementById(g.id + '_chips');
      var active = g.active || 0;
      function draw() {
        var m = g.metrics[active];
        if (g.sel === null || g.sel === undefined) { var r0 = resolveMetric(m); if (r0 && r0.dates.length) g.sel = +r0.dates[r0.dates.length - 1].slice(5, 7) - 1; }
        renderFundingChart(g, m); renderFundingHeatmap(g, m); if (g.summary) renderFundingSummary(g, m);
      }
      if (chipsHost) {
        chipsHost.innerHTML = g.metrics.map(function (mm, i) { return '<span class="chip' + (i === active ? ' on' : '') + '" data-i="' + i + '">' + esc(mm.t) + '</span>'; }).join('');
        Array.prototype.slice.call(chipsHost.querySelectorAll('.chip')).forEach(function (c) {
          c.onclick = function () {
            Array.prototype.slice.call(chipsHost.querySelectorAll('.chip')).forEach(function (x) { x.classList.remove('on'); });
            c.classList.add('on'); active = +c.dataset.i; g.active = active; draw();
          };
        });
      }
      draw();
    });
  }
  /** 顶部关注栏：1-7 组近期情况与明显异常 */
  function fundingAlerts() {
    var out = [];
    function L(key, name) { var g = get(key, name); if (!g) return null; var x = last(g.values); return x ? { d: g.dates[x.i], v: x.v, i: x.i, arr: g.values } : null; }
    function spreadLatest(ka, na, kb, nb) { var a = get(ka, na), b = get(kb, nb); if (!a || !b) return null; var bm = {}; b.values.forEach(function (v, i) { if (v !== null && !isNaN(v)) bm[b.dates[i]] = v; }); for (var i = a.dates.length - 1; i >= 0; i--) { var dv = bm[a.dates[i]]; if (a.values[i] !== null && dv !== undefined) return { d: a.dates[i], v: (a.values[i] - dv) * 100, i: i }; } return null; }
    function dev20(o) { if (!o) return null; var a = []; for (var k = Math.max(0, o.i - 20); k < o.i; k++) if (o.arr[k] !== null && !isNaN(o.arr[k])) a.push(o.arr[k]); if (a.length < 5) return null; var mn = a.reduce(function (x, y) { return x + y; }, 0) / a.length; return o.v - mn; }
    function tag(o, unit, dec, thr) { var dv = dev20(o); if (dv === null || Math.abs(dv) < thr) return ''; return '，较近20均' + (dv > 0 ? '<span class="up">高' + fmt(dv, dec) + unit + '</span>' : '<span class="down">低' + fmt(-dv, dec) + unit + '</span>') + ' <span class="tagwarn">异常</span>'; }
    var d1 = L('funding_rates', 'DR001'), r7 = L('funding_rates', 'R007');
    if (d1 && r7) out.push('<b>① 价格</b>：' + d1.d + ' DR001 <b>' + fmt(d1.v, 2) + '%</b> / R007 <b>' + fmt(r7.v, 2) + '%</b>' + tag(d1, 'bp', 1, 8));
    var ovn = spreadLatest('funding_rates', 'R001', 'funding_rates', 'DR001'), svn = spreadLatest('funding_rates', 'R007', 'funding_rates', 'DR007');
    if (ovn && svn) out.push('<b>② 分层</b>：隔夜分层 <b>' + fmt(ovn.v, 1) + 'bp</b> / 7天分层 <b>' + fmt(svn.v, 1) + 'bp</b>' + (ovn.v > 20 ? ' <span class="tagwarn">隔夜分层偏阔</span>' : ''));
    var pv = L('repo_volume', '银行间质押式回购');
    if (pv) out.push('<b>③ 交易量</b>：银行间质押式回购 <b>' + fmtBig(pv.v) + '亿</b>（' + pv.d + '）');
    var big = L('repo_institution', '大行净融出'), mmf = L('repo_institution', '货基净融出');
    if (big && mmf) out.push('<b>④ 净融出</b>：大行 <b>' + fmtBig(big.v) + '亿</b> / 货基 <b>' + fmtBig(mmf.v) + '亿</b>' + (big.v < 10000 ? ' <span class="tagwarn">大行融出偏少</span>' : ''));
    var fund = L('nonbank_demand', '基金'), sec = L('nonbank_demand', '券商自营');
    if (fund && sec) out.push('<b>⑤ 净融入</b>：基金 <b>' + fmtBig(fund.v) + '亿</b> / 券商 <b>' + fmtBig(sec.v) + '亿</b>');
    var fr = L('nonbank_demand', '基金回购融入');
    if (fr) out.push('<b>⑥ 杠杆(回购融入)</b>：基金回购融入 <b>' + fmtBig(fr.v) + '亿</b>' + tag(fr, '亿', 0, 3000));
    var li = L('lev_interbank', '银行间杠杆率'), la = L('lev_all', '全市场杠杆率');
    if (li && la) out.push('<b>⑦ 杠杆率</b>：银行间 <b>' + fmt(li.v, 4) + '倍</b> / 全市场 <b>' + fmt(la.v, 4) + '倍</b>' + tag(li, '', 4, 0.01));
    return out;
  }
  var FUND_GROUPS = [
    { id: 'fg1', title: '价格指标', summary: true, metrics: [
      { t: 'DR001', key: 'funding_rates', name: 'DR001', unit: '%', dec: 4 },
      { t: 'R001', key: 'funding_rates', name: 'R001', unit: '%', dec: 4 },
      { t: 'DR007', key: 'funding_rates', name: 'DR007', unit: '%', dec: 4 },
      { t: 'R007', key: 'funding_rates', name: 'R007', unit: '%', dec: 4 }] },
    { id: 'fg2', title: '分层指标', summary: true, metrics: [
      { t: '隔夜分层 R001-DR001', key: 'funding_rates', name: 'R001', unit: 'bp', dec: 1, spread: { key: 'funding_rates', name: 'DR001' } },
      { t: '7天分层 R007-DR007', key: 'funding_rates', name: 'R007', unit: 'bp', dec: 1, spread: { key: 'funding_rates', name: 'DR007' } }] },
    { id: 'fg3', title: '交易量指标', metrics: [
      { t: '同业拆借', key: 'repo_volume', name: '银行间同业拆借', unit: '亿', dec: 0 },
      { t: '质押式回购', key: 'repo_volume', name: '银行间质押式回购', unit: '亿', dec: 0 },
      { t: '买断式回购', key: 'repo_volume', name: '银行间买断式回购', unit: '亿', dec: 0 },
      { t: 'R001成交', key: 'repo_volume', name: 'R001', unit: '亿', dec: 0 },
      { t: 'R007成交', key: 'repo_volume', name: 'R007', unit: '亿', dec: 0 },
      { t: 'R014成交', key: 'repo_volume', name: 'R014', unit: '亿', dec: 0 },
      { t: 'R021成交', key: 'repo_volume', name: 'R021', unit: '亿', dec: 0 },
      { t: 'R1M成交', key: 'repo_volume', name: 'R1M', unit: '亿', dec: 0 }] },
    { id: 'fg4', title: '机构行为·净融出', metrics: [
      { t: '银行体系净融出', key: 'repo_institution', name: '银行体系净融出', unit: '亿', dec: 0 },
      { t: '大行净融出', key: 'repo_institution', name: '大行净融出', unit: '亿', dec: 0 },
      { t: '货基净融出', key: 'repo_institution', name: '货基净融出', unit: '亿', dec: 0 }] },
    { id: 'fg5', title: '机构行为·净融入', metrics: [
      { t: '基金净融入', key: 'nonbank_demand', name: '基金', unit: '亿', dec: 0 },
      { t: '券商净融入', key: 'nonbank_demand', name: '券商自营', unit: '亿', dec: 0 },
      { t: '保险净融入', key: 'nonbank_demand', name: '保险', unit: '亿', dec: 0 },
      { t: '理财净融入', key: 'nonbank_demand', name: '理财', unit: '亿', dec: 0 },
      { t: '其他资管净融入', key: 'nonbank_demand', name: '其他资管产品', unit: '亿', dec: 0 }] },
    { id: 'fg6', title: '机构行为·杠杆(回购融入)', metrics: [
      { t: '基金回购融入', key: 'nonbank_demand', name: '基金回购融入', unit: '亿', dec: 0 },
      { t: '非基金回购融入', unit: '亿', dec: 0, derive: function () { var tot = get('nonbank_demand', '非银净融入合计'), f = get('nonbank_demand', '基金回购融入'); if (!tot || !f) return null; var fm = {}; f.values.forEach(function (v, i) { if (v !== null && !isNaN(v)) fm[f.dates[i]] = v; }); var dates = [], vals = []; tot.values.forEach(function (v, i) { if (v !== null && !isNaN(v)) { dates.push(tot.dates[i]); vals.push(v - (fm[tot.dates[i]] || 0)); } }); return { dates: dates, values: vals, unit: '亿', dec: 0, src: tot.src }; } },
      { t: '全市场待购回(逆回购融入)', unit: '亿', dec: 0, derive: function () { var g = get('lev_interbank', '待购回余额'); return g ? { dates: g.dates, values: g.values, unit: '亿', dec: 0, src: g.src } : null; } }] },
    { id: 'fg7', title: '机构行为·杠杆率', metrics: [
      { t: '银行间杠杆率', key: 'lev_interbank', name: '银行间杠杆率', unit: '倍', dec: 4 },
      { t: '交易所杠杆率', key: 'lev_exchange', name: '交易所杠杆率', unit: '倍', dec: 4 },
      { t: '全市场杠杆率', key: 'lev_all', name: '全市场杠杆率', unit: '倍', dec: 4 },
      { t: '非银杠杆率', key: 'lev_nonbank', name: '非银杠杆率', unit: '倍', dec: 4 }] }
  ];

  /* ================================================== 页面：资金 */
  function pFunding() {
    var h = '';
    h += alertBar('资金面近期关注（价格 / 分层 / 交易量 / 机构行为 / 杠杆 / 杠杆率）', fundingAlerts());
    FUND_GROUPS.forEach(function (g, gi) {
      h += '<div class="sect-title" style="margin-top:16px">' + (gi + 1) + '、' + esc(g.title) + ' · 季节性（横轴 月·日 · 近5年 · 缺失沿用上日）</div>';
      h += '<div class="chips" id="' + g.id + '_chips"></div>';
      h += '<div class="grid g2">' +
        card(g.title + '（点击月份色带框选该月 · 跨5年）', '红=税期窗口 橙=月末 ｜ 悬停看具体“某月某日”', '<div id="' + g.id + '_chart"></div>') +
        card(g.title + ' 热力图（年×月）', '行=年 列=月', '<div id="' + g.id + '_hm"></div>') +
        '</div>';
      if (g.summary) h += '<div id="' + g.id + '_sum" style="margin-top:8px"></div>';
    });
    setTimeout(function () { renderFundingGroups(FUND_GROUPS); }, 0);
    return h;
  }

  /* ------------------------------------------------ 存单页：可复用季节性面板（月/日 + 单选/多选标签 + 交互摘要） */
  var NCD_NET_DS = { '全部': 'ncd_month_net_all', '国有行': 'ncd_month_net_gov', '股份行': 'ncd_month_net_stock', '城商行': 'ncd_month_net_city', '农商行': 'ncd_month_net_rural' };
  function ncdStockSeries(bank) {
    var d = ds('ncd_stock_monthly'); if (!d) return null;
    if (bank === '全部') {
      var keys = ['国有行', '股份行', '城商行', '农商行', '其他银行'];
      var vals = d.dates.map(function (_, i) { var s = 0, any = false; keys.forEach(function (k) { var v = (d.series[k] || [])[i]; if (v !== null && v !== undefined && !isNaN(v)) { s += v; any = true; } }); return any ? s : null; });
      return { dates: d.dates, values: vals, unit: '亿', dec: 0, label: '全部' };
    }
    if (!d.series[bank]) return null;
    return { dates: d.dates, values: d.series[bank], unit: '亿', dec: 0, label: bank };
  }
  var NCD_BANK_NAMES = ['工行', '农行', '建行', '中行', '交行', '邮储', '中信', '光大', '华夏', '平安', '招商', '浦发', '兴业', '民生', '广发', '浙商', '上海银行', '杭州银行', '江苏银行', '南京银行', '北京银行', '宁波银行'];
  function ncdStockBankSeries(bank) {
    var d = ds('ncd_stock_bank'); if (!d || !d.series[bank]) return null;
    return { dates: d.dates, values: d.series[bank], unit: '亿', dec: 0, label: bank };
  }
  function ncdMonthlyNet(bank, term) {
    var key = NCD_NET_DS[bank]; var d = ds(key); if (!d) return null;
    var iss = d.series[term + '发行'] || [], rep = d.series[term + '偿还'] || [];
    var vals = d.dates.map(function (_, i) { var a = iss[i], b = rep[i]; if ((a === null || a === undefined) && (b === null || b === undefined)) return null; return (a || 0) - (b || 0); });
    return { dates: d.dates, values: vals, unit: '亿', dec: 0, label: bank + '·' + term };
  }
  function ncdYtdNet(bank) {
    var m = ncdMonthlyNet(bank, '全部'); if (!m) return null;
    var dates = [], vals = [], cum = 0, curY = null;
    for (var i = 0; i < m.dates.length; i++) { var y = m.dates[i].slice(0, 4); if (curY === null) curY = y; if (y !== curY) { cum = 0; curY = y; } var v = m.values[i]; if (v !== null && !isNaN(v)) cum += v; dates.push(m.dates[i]); vals.push(cum); }
    return { dates: dates, values: vals, unit: '亿', dec: 0, label: bank };
  }
  function ncdWeightedTerm(bank) {
    var key = NCD_NET_DS[bank]; var d = ds(key); if (!d) return null;
    var terms = [['1M', 30], ['3M', 90], ['6M', 180], ['9M', 270], ['1Y', 360]];
    var vals = d.dates.map(function (_, i) { var num = 0, den = 0; terms.forEach(function (t) { var iss = (d.series[t[0] + '发行'] || [])[i]; if (iss !== null && iss !== undefined && !isNaN(iss)) { num += t[1] * iss; den += iss; } }); return den > 0 ? num / den : null; });
    return { dates: d.dates, values: vals, unit: '天', dec: 0, label: bank };
  }
  function ncdRateSeries(bank) {
    var d = ds('ncd_rate_by_bank'); if (!d) return null; var nm = (bank === '全部') ? '1Y合计' : bank; if (!d.series[nm]) return null;
    return { dates: d.dates, values: d.series[nm], unit: '%', dec: 4, label: bank };
  }
  function ncdSecCurve(term) { var d = ds('ncd_secondary_curve'); if (!d || !d.series[term]) return null; return { dates: d.dates, values: d.series[term], unit: '%', dec: 4, label: term }; }
  function ncdSecSpread(pair) {
    var curve = ds('ncd_secondary_curve'); if (!curve) return null;
    function cur(t) { var v = curve.series[t]; return v ? { dates: curve.dates, values: v } : null; }
    function fr(n) { var dd = ds('funding_rates'); var v = dd && dd.series[n]; return v ? { dates: dd.dates, values: v } : null; }
    var a, b, label, m = pair.match(/^(\w+)\*(\w+)$/);
    if (m) { a = cur(m[1]); b = cur(m[2]); label = m[1] + '-' + m[2]; }
    else { var mm = pair.match(/^1Y-(DR001|R007)$/); if (mm) { a = cur('1Y'); b = fr(mm[1]); label = '1Y-' + mm[1]; } else return null; }
    if (!a || !b) return null;
    var bm = {}; b.values.forEach(function (v, i) { if (v !== null && !isNaN(v)) bm[b.dates[i]] = v; });
    var dates = [], vals = []; a.values.forEach(function (v, i) { var dv = bm[a.dates[i]]; if (v !== null && !isNaN(v) && dv !== undefined) { dates.push(a.dates[i]); vals.push((v - dv) * 100); } });
    return { dates: dates, values: vals, unit: 'bp', dec: 1, label: label };
  }
  function summarizeSeries(s, mo) {
    if (!s) return null;
    var byDate = {}; s.dates.forEach(function (d, i) { if (s.values[i] !== null && !isNaN(s.values[i])) byDate[d] = s.values[i]; });
    var yset = {}; s.dates.forEach(function (d) { yset[d.slice(0, 4)] = 1; });
    var yrList = Object.keys(yset).sort().slice(-5); var per = [];
    yrList.forEach(function (y) {
      var ym = y + '-' + String(mo + 1).padStart(2, '0');
      var days = s.dates.filter(function (d) { return d.slice(0, 7) === ym && byDate[d] !== undefined; }).sort();
      if (!days.length) return;
      var vals = days.map(function (d) { return byDate[d]; });
      per.push({ y: y, mean: vals.reduce(function (a, b) { return a + b; }, 0) / vals.length, last: vals[vals.length - 1] });
    });
    if (!per.length) return null;
    function avg(fn) { var a = per.map(fn).filter(function (x) { return x !== null && !isNaN(x); }); return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
    var means = per.map(function (p) { return p.mean; });
    return { label: s.label, unit: s.unit, dec: s.dec, mean5: avg(function (p) { return p.mean; }), min5: Math.min.apply(null, means), max5: Math.max.apply(null, means), latest: per[per.length - 1].last, per: per };
  }
  function initPanelSel(g) {
    g.sel = {}; g.dims.forEach(function (dim) { g.sel[dim.key] = dim.multi ? dim.def.slice() : dim.def; });
    g.month = null;
  }
  function renderPanelTags(g) {
    var host = document.getElementById(g.id + '_tags'); if (!host) return;
    var html = '';
    g.dims.forEach(function (dim) {
      html += '<span style="margin:0 8px 0 0;font-size:12px;color:var(--text-3)">' + esc(dim.label) + (dim.multi ? '(可多选)' : '') + '：</span>';
      var sel = g.sel[dim.key];
      dim.options.forEach(function (op) {
        var on = dim.multi ? (sel.indexOf(op) >= 0) : (sel === op);
        html += '<span class="chip' + (on ? ' on' : '') + '" data-dim="' + dim.key + '" data-v="' + esc(op) + '" data-multi="' + (dim.multi ? 1 : 0) + '">' + esc(op) + '</span>';
      });
    });
    host.innerHTML = html;
    Array.prototype.slice.call(host.querySelectorAll('.chip')).forEach(function (c) {
      c.onclick = function () {
        var dim = g.dims.filter(function (d) { return d.key === c.dataset.dim; })[0];
        if (c.dataset.multi === '1') {
          var arr = g.sel[dim.key].slice(), idx = arr.indexOf(c.dataset.v);
          if (idx >= 0) { if (arr.length > 1) arr.splice(idx, 1); } else arr.push(c.dataset.v);
          g.sel[dim.key] = arr;
        } else { g.sel[dim.key] = c.dataset.v; }
        renderPanelTags(g); drawPanel(g);
      };
    });
  }
  function panelChartSeries(g, s0) {
    var src = (g.mode === 'day') ? dailyCarryForward(s0) : s0;
    var sd = (g.mode === 'day') ? seasonalDay(src.dates, src.values, 5) : seasonal(src.dates, src.values, 'last', 5);
    return sd;
  }
  function renderPanelChart(g, series) {
    var host = document.getElementById(g.id + '_chart'); if (!host) return;
    if (!series.length) { host.innerHTML = '<div class="empty">无数据</div>'; return; }
    var labels, xTicks, xKind, bands;
    if (g.mode === 'day') { labels = monthDayLabels(); xTicks = monthDayTicks(); xKind = 'date'; bands = FUND_BANDS; }
    else { labels = MONTHS; xTicks = null; xKind = 'month'; bands = MONTHS.map(function (_, m) { return { m: m, i0: m, i1: m }; }); }
    var cs = [];
    if (series.length === 1) {
      var sd = panelChartSeries(g, series[0]), yrs = sd.years, dec = series[0].dec;
      yrs.forEach(function (y) { cs.push({ name: y + '年', data: sd.byYear[y], axis: 0, dec: dec, width: y === yrs[yrs.length - 1] ? 2.6 : 1.5, color: y === yrs[yrs.length - 1] ? '#f2637b' : undefined }); });
      cs.push({ name: '均值', data: sd.avg, axis: 0, color: '#8b93a7', dash: '5 4', width: 1.6, dec: dec });
    } else {
      var PAL = (window.Charts && Charts.PALETTE) || ['#4f9cf9', '#f2637b', '#5ec8a8', '#f0b13b', '#9b7bf0'];
      series.forEach(function (s0, si) {
        var col = PAL[si % PAL.length], sd = panelChartSeries(g, s0), yrs = sd.years, curY = yrs[yrs.length - 1];
        cs.push({ name: s0.label + ' ' + curY, data: sd.byYear[curY], axis: 0, dec: s0.dec, width: 2.4, color: col });
        cs.push({ name: s0.label + ' 均值', data: sd.avg, axis: 0, color: col, dash: '5 4', width: 1.4, dec: s0.dec });
      });
    }
    Charts.render(host, {
      labels: labels, xKind: xKind, xTicks: xTicks, monthBands: bands, selectedMonth: (g.month === undefined ? null : g.month),
      onPick: function (mo) { g.month = mo; drawPanel(g); },
      series: cs, y0: { dec: series[0].dec }, height: 300,
      toolFmt: function (v) { return fmt(v, series[0].dec) + series[0].unit; }
    });
  }
  function renderPanelHeatmap(g, s0) {
    var host = document.getElementById(g.id + '_hm'); if (!host || !s0) { if (host) host.innerHTML = '<div class="empty">无</div>'; return; }
    var sm = seasonal(s0.dates, s0.values, (g.mode === 'day' ? 'mean' : 'last'), 5);
    Charts.matrix(host, { years: sm.years, byYear: sm.byYear, dec: s0.dec, unit: s0.unit });
  }
  function renderPanelSummary(g, series) {
    var host = document.getElementById(g.id + '_sum'); if (!host) return;
    var mo = (g.month === null || g.month === undefined) ? 8 : g.month; var mn = (mo + 1) + '月';
    var rows = series.map(function (s) { return summarizeSeries(s, mo); }).filter(Boolean);
    var body = '<div class="note" style="margin-bottom:8px"><b>驱动因子：</b>' + esc(g.driver ? g.driver(mo) : '') + '</div>';
    if (!rows.length) body += '<div class="empty">该月无数据</div>';
    else body += rows.map(function (r) {
      return '<div style="padding:5px 0;border-bottom:1px dashed var(--border)"><b>' + esc(r.label) + '</b>：近5年' + mn + '均值 <b>' + fmt(r.mean5, r.dec) + esc(r.unit) + '</b>（区间 ' + fmt(r.min5, r.dec) + ' ~ ' + fmt(r.max5, r.dec) + esc(r.unit) + '），最新 ' + fmt(r.latest, r.dec) + esc(r.unit) + '</div>';
    }).join('');
    host.innerHTML = '<div class="card"><header><h4>近5年' + mn + ' 走势摘要与驱动因子（' + esc(g.title) + '）</h4><span class="hint">点击' + (g.mode === 'day' ? '月份色带' : '月份') + '可切换</span></header>' + body + '</div>';
  }
  function drawPanel(g) {
    var series = (g.resolve(g.sel) || []).filter(Boolean);
    if ((g.month === null || g.month === undefined)) { if (series[0] && series[0].dates.length) g.month = +series[0].dates[series[0].dates.length - 1].slice(5, 7) - 1; else g.month = 8; }
    renderPanelChart(g, series); renderPanelHeatmap(g, series[0]); if (g.summary) renderPanelSummary(g, series);
  }
  function renderPanel(g) { renderPanelTags(g); drawPanel(g); }

  var NCD_DRIVER = {
    0: '1月：跨年后存单大量到期续作，叠加信贷“开门红”备资，发行放量、利率易上行；国有行/股份行发力。',
    1: '2月：春节因素，实体需求偏弱、发行缩量，利率通常回落。',
    2: '3月：季末 MPA 考核与存款冲量，发行放量、存量冲高，利率走高。',
    3: '4月：季初考核压力缓解，发行回落、利率回落。',
    4: '5月：税期缴款，银行融出收缩，发行缩量。',
    5: '6月：半年末考核，发行放量、存量冲高。',
    6: '7月：季初，发行回落。',
    7: '8月：政府债发行高峰+信贷需求回升，存单发行回升，利率承压。',
    8: '9月：季末+国庆跨节备付，发行放量、利率走高；1Y 占比常提升、久期拉长。',
    9: '10月：季初，发行回落、利率回落。',
    10: '11月：年末临近+缴税，发行缩量、利率缓升。',
    11: '12月：年末考核+跨年备付，发行放量、利率显著走高，久期拉长。'
  };
  var NCD2_DRIVER = {
    0: '1月：跨年后资金转松+配置盘进场，二级收益率通常下行，1Y-1M 等期限利差随宽松预期收窄或走阔。',
    1: '2月：春节前后资金波动，二级收益率跟随资金面，短端更敏感。',
    2: '3月：季末考核，资金收敛，二级收益率上行、利差走阔。',
    3: '4月：季初转松，收益率回落。',
    4: '5月：税期，收益率小幅上行。',
    5: '6月：半年末考核，收益率上行、利差走阔。',
    6: '7月：季初转松，收益率回落。',
    7: '8月：政府债供给+信贷回升，收益率承压。',
    8: '9月：季末+跨节，收益率上行、1Y 相对短端更抗跌或走阔。',
    9: '10月：季初转松，收益率回落。',
    10: '11月：年末临近，收益率缓升。',
    11: '12月：年末考核+跨年，收益率显著上行，1Y-DR001/R007 利差走阔。'
  };
  var NCD1_GROUPS = [
    { id: 'n1s', title: '存量（分交易对手）', mode: 'month', summary: true, dims: [{ key: 'bank', label: '交易对手', multi: false, options: ['全部', '国有行', '股份行', '城商行', '农商行', '其他银行'], def: '全部' }], resolve: function (s) { return [ncdStockSeries(s.bank)]; }, driver: function (m) { return NCD_DRIVER[m]; } },
    { id: 'n1bank', title: '存量（具体交易对手）', mode: 'month', summary: false, dims: [{ key: 'bank', label: '具体交易对手', multi: false, options: NCD_BANK_NAMES, def: '工行' }], resolve: function (s) { return [ncdStockBankSeries(s.bank)]; } },
    { id: 'n1yn', title: '年度累计净发行量（分交易对手）', mode: 'month', summary: true, dims: [{ key: 'bank', label: '交易对手', multi: false, options: ['全部', '国有行', '股份行', '城商行', '农商行'], def: '全部' }], resolve: function (s) { return [ncdYtdNet(s.bank)]; }, driver: function (m) { return NCD_DRIVER[m]; } },
    { id: 'n1net', title: '净发行量（分期限、分交易对手）', mode: 'month', summary: true, dims: [{ key: 'term', label: '期限', multi: true, options: ['1M', '3M', '6M', '9M', '1Y'], def: ['1Y'] }, { key: 'bank', label: '交易对手', multi: true, options: ['全部', '国有行', '股份行', '城商行', '农商行'], def: ['全部'] }], resolve: function (s) { var o = []; (s.bank || []).forEach(function (bk) { (s.term || []).forEach(function (t) { o.push(ncdMonthlyNet(bk, t)); }); }); return o; }, driver: function (m) { return NCD_DRIVER[m]; } },
    { id: 'n1term', title: '发行期限（分交易对手）', mode: 'month', summary: true, dims: [{ key: 'bank', label: '交易对手', multi: false, options: ['全部', '国有行', '股份行', '城商行', '农商行'], def: '全部' }], resolve: function (s) { return [ncdWeightedTerm(s.bank)]; }, driver: function (m) { return NCD_DRIVER[m]; } },
    { id: 'n1rate', title: '1Y期发行利率（分交易对手）', mode: 'day', summary: true, dims: [{ key: 'term', label: '期限', multi: false, options: ['1Y'], def: '1Y' }, { key: 'bank', label: '交易对手', multi: true, options: ['全部', '国有行', '股份行', '城商行', '农商行'], def: ['全部'] }], resolve: function (s) { return (s.bank || []).map(function (bk) { return ncdRateSeries(bk); }); }, driver: function (m) { return NCD_DRIVER[m]; } }
  ];
  var NCD2_GROUPS = [
    { id: 'n2c', title: 'AAA存单二级收益率（分期限）', mode: 'day', summary: true, dims: [{ key: 'term', label: '期限', multi: true, options: ['1M', '3M', '6M', '9M', '1Y'], def: ['1Y', '3M', '1M'] }], resolve: function (s) { return (s.term || []).map(function (t) { return ncdSecCurve(t); }); }, driver: function (m) { return NCD2_DRIVER[m]; } },
    { id: 'n2s', title: 'AAA存单二级期限利差', mode: 'day', summary: true, dims: [{ key: 'pair', label: '利差', multi: true, options: ['3M*1M', '6M*3M', '9M*6M', '1Y*9M', '1Y-DR001', '1Y-R007'], def: ['1Y-9M', '1Y-DR001'] }], resolve: function (s) { return (s.pair || []).map(function (p) { return ncdSecSpread(p); }); }, driver: function (m) { return NCD2_DRIVER[m]; } }
  ];
  function ncd1Alerts() {
    var out = [];
    function L(key, name) { var d = ds(key); if (!d || !d.series[name]) return null; var v = d.series[name]; for (var i = v.length - 1; i >= 0; i--) if (v[i] !== null && !isNaN(v[i])) return { d: d.dates[i], v: v[i] }; return null; }
    var stock = L('ncd_stock_weekly', '总计');
    if (stock) out.push('<b>① 存单存量</b>：全市场 <b>' + fmtBig(stock.v) + '亿</b>（' + stock.d + '）');
    var d = ds('ncd_month_net_all'); if (d) { var iss = d.series['全部发行'] || [], rep = d.series['全部偿还'] || []; for (var i = iss.length - 1; i >= 0; i--) { if (iss[i] !== null && rep[i] !== null) { out.push('<b>② 月度净发行</b>：' + d.dates[i].slice(0, 7) + ' <b>' + fmtBig(iss[i] - rep[i]) + '亿</b>'); break; } } }
    var term = ncdWeightedTerm('全部'); if (term) { var lt = last(term.values); if (lt) out.push('<b>③ 发行期限(加权)</b>：<b>' + fmt(lt.v, 0) + '天</b>（' + term.dates[lt.i].slice(0, 7) + '）'); }
    var rate = L('ncd_rate_by_bank', '1Y合计');
    if (rate) { var rd = ds('ncd_rate_by_bank'); var v = (rd && rd.series['1Y合计']) || []; var ri = v.indexOf(rate.v); var d20 = []; for (var k = (ri < 0 ? -1 : ri - 1), c = 0; k >= 0 && c < 20; k--) { if (v[k] !== null && !isNaN(v[k])) { d20.push(v[k]); c++; } } var mn = d20.length ? d20.reduce(function (a, b) { return a + b; }, 0) / d20.length : rate.v; var dev = (rate.v - mn) * 100; out.push('<b>④ 1Y发行利率(合计)</b>：<b>' + fmt(rate.v, 2) + '%</b>（' + rate.d + '）' + (Math.abs(dev) >= 8 ? '，较近20日' + (dev > 0 ? '<span class="up">高' + fmt(dev, 0) + 'bp</span>' : '<span class="down">低' + fmt(-dev, 0) + 'bp</span>') + ' <span class="tagwarn">异常</span>' : '')); }
    return out;
  }
  function ncd2Alerts() {
    var out = [];
    function L(key, name) { var d = ds(key); if (!d || !d.series[name]) return null; var v = d.series[name]; for (var i = v.length - 1; i >= 0; i--) if (v[i] !== null && !isNaN(v[i])) return { d: d.dates[i], v: v[i] }; return null; }
    var y1 = L('ncd_secondary_curve', '1Y'), m1 = L('ncd_secondary_curve', '1M');
    if (y1) out.push('<b>① AAA 1Y 二级收益率</b>：<b>' + fmt(y1.v, 2) + '%</b>（' + y1.d + '）');
    var sp = ncdSecSpread('1Y-9M'); if (sp) { var lt = last(sp.values); if (lt) out.push('<b>② 1Y-9M 期限利差</b>：<b>' + fmt(lt.v, 0) + 'bp</b>（' + sp.dates[lt.i] + '）'); }
    var sp2 = ncdSecSpread('1Y-DR001'); if (sp2) { var lt2 = last(sp2.values); if (lt2) out.push('<b>③ 1Y-DR001 利差</b>：<b>' + fmt(lt2.v, 0) + 'bp</b>' + (lt2.v < 0 ? ' <span class="tagwarn">倒挂</span>' : '')); }
    return out;
  }
  function ncdPage(groups, gi0, axisNote) {
    var h = '';
    groups.forEach(function (g, i) {
      initPanelSel(g);
      h += '<div class="sect-title" style="margin-top:16px">' + (gi0 + i + 1) + '、' + esc(g.title) + ' · 季节性（' + axisNote(g) + ' · 近5年）</div>';
      h += '<div class="chips" id="' + g.id + '_tags"></div>';
      h += '<div class="grid g2">' +
        card(g.title, (g.mode === 'day' ? '横轴 月·日 · 缺失沿用上一日 · 点击月份色带框选该月' : '横轴 1-12月 · 点击月份框选该月'), '<div id="' + g.id + '_chart"></div>') +
        card(g.title + ' 热力图（年×月）', '行=年 列=月', '<div id="' + g.id + '_hm"></div>') +
        '</div>';
      if (g.summary) h += '<div id="' + g.id + '_sum" style="margin-top:8px"></div>';
    });
    setTimeout(function () { groups.forEach(renderPanel); }, 0);
    return h;
  }

  /* ================================================== 页面：存单一级 */
  function pNcd1() {
    var h = '';
    h += alertBar('存单一级近期关注（存量 / 净发行 / 发行期限 / 发行利率）', ncd1Alerts());
    h += ncdPage(NCD1_GROUPS, 0, function (g) { return g.mode === 'day' ? '横轴 月·日' : '横轴 1-12月'; });
    return h;
  }

  /* ================================================== 页面：存单二级 */
  function pNcd2() {
    var h = '';
    h += alertBar('存单二级近期关注（AAA 二级收益率 / 期限利差）', ncd2Alerts());
    h += ncdPage(NCD2_GROUPS, 0, function (g) { return '横轴 月·日'; });
    return h;
  }

  /* ------------------------------------------------ 票据页：国股转贴收益率 + 转贴净买入 */
  function billRateSeries(term) { var d = ds('bill_rate'); if (!d || !d.series[term + '国股转贴']) return null; return { dates: d.dates, values: d.series[term + '国股转贴'], unit: '%', dec: 4, label: term }; }
  function billNetBuySeries(cp) {
    var d = ds('bill_net_buy'); if (!d) return null;
    if (cp === '全部') {
      var keys = ['国有／政策性银行', '股份制', '城商行', '外资行', '农村金融机构', '财务公司', '非银机构', '非法人产品'];
      var vals = d.dates.map(function (_, i) { var s = 0, any = false; keys.forEach(function (k) { var v = (d.series[k] || [])[i]; if (v !== null && v !== undefined && !isNaN(v)) { s += v; any = true; } }); return any ? s : null; });
      return { dates: d.dates, values: vals, unit: '亿', dec: 0, label: '全部' };
    }
    if (!d.series[cp]) return null;
    return { dates: d.dates, values: d.series[cp], unit: '亿', dec: 0, label: cp };
  }
  var BILL_DRIVER = {
    0: '1月：年初信贷集中投放、票据冲量，转贴利率通常明显下行（冲存款/规模），各对手净买入分化。',
    1: '2月：春节因素成交清淡，转贴利率低位盘整。',
    2: '3月：季末信贷冲量+MPA 考核，票据需求旺，转贴利率大幅下行。',
    3: '4月：季初票据需求回落，转贴利率回升。',
    4: '5月：税期+信贷节奏，利率窄幅波动。',
    5: '6月：半年末考核，票据冲量，利率再度下行。',
    6: '7月：季初需求回落，利率回升。',
    7: '8月：信贷需求平稳，利率窄幅波动。',
    8: '9月：季末+跨季，票据冲量，利率下行。',
    9: '10月：季初，利率回升。',
    10: '11月：年末规模预留，利率缓升。',
    11: '12月：年末信贷冲刺+跨年，票据需求旺，利率下行。'
  };
  var BILL_GROUPS = [
    { id: 'bl1', title: '国股转贴收益率（分期限）', mode: 'day', summary: true, dims: [{ key: 'term', label: '期限', multi: true, options: ['1M', '3M', '6M'], def: ['3M', '6M'] }], resolve: function (s) { return (s.term || []).map(function (t) { return billRateSeries(t); }); }, driver: function (m) { return BILL_DRIVER[m]; } },
    { id: 'bl2', title: '转贴净买入量（分交易对手）', mode: 'day', summary: true, dims: [{ key: 'cp', label: '交易对手', multi: true, options: ['全部', '国有／政策性银行', '股份制', '城商行', '外资行', '农村金融机构', '财务公司', '非银机构', '非法人产品'], def: ['全部', '非银机构'] }], resolve: function (s) { return (s.cp || []).map(function (c) { return billNetBuySeries(c); }); }, driver: function (m) { return BILL_DRIVER[m]; } }
  ];
  function billAlerts() {
    var out = [];
    function L(key, name) { var d = ds(key); if (!d || !d.series[name]) return null; var v = d.series[name]; for (var i = v.length - 1; i >= 0; i--) if (v[i] !== null && !isNaN(v[i])) return { d: d.dates[i], v: v[i], i: i }; return null; }
    var r1 = L('bill_rate', '1M国股转贴'), r3 = L('bill_rate', '3M国股转贴'), r6 = L('bill_rate', '6M国股转贴');
    if (r3 && r6) out.push('<b>① 国股转贴收益率</b>：' + (r1 ? '1M ' + fmt(r1.v, 2) + '% / ' : '') + '3M <b>' + fmt(r3.v, 2) + '%</b> / 6M <b>' + fmt(r6.v, 2) + '%</b>（' + r3.d + '），6M-3M ' + fmt((r6.v - r3.v) * 100, 0) + 'bp');
    var nb = billNetBuySeries('全部'); if (nb) { var lt = last(nb.values); if (lt) out.push('<b>② 转贴净买入(全部)</b>：<b>' + fmtBig(lt.v) + '亿</b>（' + nb.dates[lt.i] + '）'); }
    var nnb = billNetBuySeries('非银机构'); if (nnb) { var lt2 = last(nnb.values); if (lt2) out.push('<b>③ 非银机构净买入</b>：<b>' + fmtBig(lt2.v) + '亿</b>（' + nnb.dates[lt2.i] + '）'); }
    return out;
  }

  /* ================================================== 页面：票据 */
  function pBill() {
    var h = '';
    h += alertBar('票据近期关注（国股转贴收益率 / 转贴净买入量）', billAlerts());
    h += ncdPage(BILL_GROUPS, 0, function (g) { return '横轴 月·日'; });
    return h;
  }

  /* ------------------------------------------------ 债券页：收益率 / 品种利差 / 期限利差 */
  function bondYield(variety, term) {
    if (variety === '国债' || variety === '地方债') {
      var d = ds('bond_curve'); if (!d || !d.series[variety + term]) return null;
      return { dates: d.dates, values: d.series[variety + term], unit: '%', dec: 4, label: variety + term };
    }
    if (term !== '10Y') return null; // 国开/农发/口行 底稿仅 10Y
    var dv = ds('bond_variety'); if (!dv || !dv.series['10Y' + variety]) return null;
    return { dates: dv.dates, values: dv.series['10Y' + variety], unit: '%', dec: 4, label: variety + term };
  }
  function bondVarietySpread(pair) {
    if (pair === '10Y国开-国债' || pair === '10Y农发-国债' || pair === '10Y口行-国债') {
      var d = ds('bond_variety'); if (!d || !d.series[pair]) return null;
      return { dates: d.dates, values: d.series[pair], unit: 'bp', dec: 1, label: pair };
    }
    var m = pair.match(/^(\d+Y)地方债-国债$/); if (!m) return null;
    var lg = ds('lgb_spread'); if (!lg || !lg.series[m[1]]) return null;
    return { dates: lg.dates, values: lg.series[m[1]], unit: 'bp', dec: 1, label: pair };
  }
  function bondTermSpread(pair) {
    var m = pair.match(/^(\d+Y)(国债|地方债)-(\d+Y)(国债|地方债)$/); if (!m) return null;
    var v = m[2], t1 = m[1], t2 = m[3], d = ds('bond_curve');
    if (!d || !d.series[v + t1] || !d.series[v + t2]) return null;
    var a = d.series[v + t1], b = d.series[v + t2], dates = [], vals = [];
    for (var i = 0; i < d.dates.length; i++) { if (a[i] !== null && !isNaN(a[i]) && b[i] !== null && !isNaN(b[i])) { dates.push(d.dates[i]); vals.push((a[i] - b[i]) * 100); } }
    return { dates: dates, values: vals, unit: 'bp', dec: 1, label: pair };
  }
  var BOND_DRIVER = {
    0: '1月：年初配置盘进场、宽松预期，收益率通常下行；关注地方债发行前置与供给。',
    1: '2月：节后复工+配置需求，收益率窄幅波动。',
    2: '3月：季末+信贷冲量，长端受供给与考核影响，收益率易上行。',
    3: '4月：季初配置回落，收益率回升。',
    4: '5月：政府债发行加速+税期，供给压力下收益率上行。',
    5: '6月：半年末+供给高峰，收益率承压，曲线趋平。',
    6: '7月：季初配置回暖，收益率回落。',
    7: '8月：政府债净融资高位，供给压制长端。',
    8: '9月：季末+跨季，收益率上行；地方债利差易走阔。',
    9: '10月：季初配置进场，收益率回落。',
    10: '11月：年末机构止盈+供给，收益率缓升。',
    11: '12月：年末配置冲刺+跨年，收益率易下行，超长端受青睐。'
  };
  var BOND_GROUPS = [
    { id: 'bd1', title: '债券收益率（分品种分期限）', mode: 'day', summary: true,
      dims: [
        { key: 'term', label: '期限', multi: true, options: ['1Y', '3Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y'], def: ['10Y', '30Y'] },
        { key: 'variety', label: '品种', multi: true, options: ['国债', '地方债', '国开', '农发', '口行'], def: ['国债', '国开'] }],
      resolve: function (s) { var o = []; (s.variety || []).forEach(function (v) { (s.term || []).forEach(function (t) { o.push(bondYield(v, t)); }); }); return o; },
      driver: function (m) { return BOND_DRIVER[m]; } },
    { id: 'bd2', title: '品种利差', mode: 'day', summary: true,
      dims: [{ key: 'pair', label: '利差', multi: true, options: ['10Y国开-国债', '10Y农发-国债', '10Y口行-国债', '5Y地方债-国债', '10Y地方债-国债', '30Y地方债-国债'], def: ['10Y国开-国债', '10Y地方债-国债'] }],
      resolve: function (s) { return (s.pair || []).map(function (p) { return bondVarietySpread(p); }); },
      driver: function (m) { return BOND_DRIVER[m]; } },
    { id: 'bd3', title: '期限利差', mode: 'day', summary: true,
      dims: [{ key: 'pair', label: '利差', multi: true, options: ['30Y国债-10Y国债', '10Y国债-7Y国债', '7Y国债-5Y国债', '5Y国债-3Y国债', '3Y国债-1Y国债', '30Y地方债-10Y地方债', '10Y地方债-7Y地方债', '7Y地方债-5Y地方债', '5Y地方债-3Y地方债', '3Y地方债-1Y地方债'], def: ['30Y国债-10Y国债', '10Y地方债-7Y地方债'] }],
      resolve: function (s) { return (s.pair || []).map(function (p) { return bondTermSpread(p); }); },
      driver: function (m) { return BOND_DRIVER[m]; } }
  ];
  function bondAlerts() {
    var out = [];
    function L(key, name) { var d = ds(key); if (!d || !d.series[name]) return null; var v = d.series[name]; for (var i = v.length - 1; i >= 0; i--) if (v[i] !== null && !isNaN(v[i])) return { d: d.dates[i], v: v[i] }; return null; }
    var g10 = L('bond_curve', '国债10Y'), g30 = L('bond_curve', '国债30Y');
    if (g10) out.push('<b>① 国债收益率</b>：10Y <b>' + fmt(g10.v, 2) + '%</b>' + (g30 ? ' / 30Y <b>' + fmt(g30.v, 2) + '%</b>' : '') + '（' + g10.d + '）');
    var vs = bondVarietySpread('10Y国开-国债'); if (vs) { var lt = last(vs.values); if (lt) out.push('<b>② 10Y国开-国债</b>：<b>' + fmt(lt.v, 0) + 'bp</b>'); }
    var ts = bondTermSpread('30Y国债-10Y国债'); if (ts) { var lt2 = last(ts.values); if (lt2) out.push('<b>③ 30Y-10Y国债</b>：<b>' + fmt(lt2.v, 0) + 'bp</b>' + (lt2.v < 20 ? ' <span class="tagwarn">偏平</span>' : '')); }
    return out;
  }

  /* ================================================== 页面：债券（久期/换手/利差） */
  function pBond() {
    var h = '';
    h += alertBar('债券近期关注（收益率 / 品种利差 / 期限利差）', bondAlerts());
    h += ncdPage(BOND_GROUPS, 0, function (g) { return '横轴 月·日'; });
    return h;
  }

  /* ------------------------------------------------ 衍生品页：收益率 / 期限利差 / 隐含预期 */
  function irsYield(kind) {
    var d = ds('irs'); if (!d || !d.series[kind]) return null;
    return { dates: d.dates, values: d.series[kind], unit: '%', dec: 4, label: kind };
  }
  function irsTermSpread(pair) {
    var m = pair.match(/^FR007:1Y\*FR007:5Y$/);
    var a, b, label;
    if (m) { a = irsYield('FR007:1Y'); b = irsYield('FR007:5Y'); label = 'FR007 1Y*5Y'; }
    else { a = irsYield('3M SHIBOR:1Y'); b = irsYield('3M SHIBOR:5Y'); label = '3M SHIBOR 1Y*5Y'; }
    if (!a || !b) return null;
    var bm = {}; b.values.forEach(function (v, i) { if (v !== null && !isNaN(v)) bm[b.dates[i]] = v; });
    var dates = [], vals = [];
    a.values.forEach(function (v, i) { var dv = bm[a.dates[i]]; if (v !== null && !isNaN(v) && dv !== undefined) { dates.push(a.dates[i]); vals.push((v - dv) * 100); } });
    return { dates: dates, values: vals, unit: 'bp', dec: 1, label: label };
  }
  var DERIV_DRIVER = {
    0: '1月：跨年后资金面转松+宽松预期，IRS 收益率通常下行；1s5s 斜率随降息预期走陡。',
    1: '2月：节前节后资金波动，互换收益率跟随资金面，短端更敏感。',
    2: '3月：季末考核+信贷冲量，资金收敛，IRS 上行；关注税期与 MPA。',
    3: '4月：季初转松，IRS 收益率回落。',
    4: '5月：税期缴款+政府债发行，资金收敛，IRS 小幅上行。',
    5: '6月：半年末考核，资金收敛、IRS 上行，1s5s 走平。',
    6: '7月：季初转松，IRS 回落。',
    7: '8月：政府债供给+信贷回升，IRS 承压。',
    8: '9月：季末+跨节备付，资金收敛，IRS 上行。',
    9: '10月：季初转松，IRS 回落；关注政策利率动向对远端的定价。',
    10: '11月：年末临近，IRS 缓升；关注降准降息落地时点。',
    11: '12月：年末考核+跨年，资金收敛、IRS 显著上行，曲线走平。'
  };
  var DERIV_GROUPS = [
    { id: 'dv1', title: '衍生品收益率（分品种）', mode: 'day', summary: true,
      dims: [{ key: 'kind', label: '品种', multi: true, options: ['FR007:1Y', 'FR007:5Y', '3M SHIBOR:1Y', '3M SHIBOR:5Y'], def: ['FR007:1Y', 'FR007:5Y'] }],
      resolve: function (s) { return (s.kind || []).map(function (k) { return irsYield(k); }); },
      driver: function (m) { return DERIV_DRIVER[m]; } },
    { id: 'dv2', title: '衍生品期限利差（分品种）', mode: 'day', summary: true,
      dims: [{ key: 'pair', label: '利差', multi: true, options: ['FR007:1Y*FR007:5Y', '3M SHIBOR:1Y*3M SHIBOR:5Y'], def: ['FR007:1Y*FR007:5Y'] }],
      resolve: function (s) { return (s.pair || []).map(function (p) { return irsTermSpread(p); }); },
      driver: function (m) { return DERIV_DRIVER[m]; } }
  ];
  function derivAlerts() {
    var out = [];
    function L(key, name) { var d = ds(key); if (!d || !d.series[name]) return null; var v = d.series[name]; for (var i = v.length - 1; i >= 0; i--) if (v[i] !== null && !isNaN(v[i])) return { d: d.dates[i], v: v[i] }; return null; }
    function dev20(g) { if (!g) return null; var c = 0, s = 0, n = 0; for (var i = g.values.length - 1; i >= 0 && n < 20; i--) { if (g.values[i] !== null && !isNaN(g.values[i])) { s += g.values[i]; n++; } } var li = last(g.values); if (!li || !n) return null; return { v: li.v, d: li.d, dev: (li.v - s / n) }; }
    var kinds = ['FR007:1Y', 'FR007:5Y', '3M SHIBOR:1Y', '3M SHIBOR:5Y'];
    kinds.forEach(function (k) {
      var g = irsYield(k); var r = dev20(g);
      if (r) out.push('<b>① ' + k + '</b>：<b>' + fmt(r.v, 2) + '%</b>（' + r.d + '）' + (Math.abs(r.dev * 100) >= 8 ? '，较近20日' + (r.dev > 0 ? '<span class="up">高' + fmt(r.dev * 100, 0) + 'bp</span>' : '<span class="down">低' + fmt(-r.dev * 100, 0) + 'bp</span>') + ' <span class="tagwarn">异常</span>' : ''));
    });
    var sp = irsTermSpread('FR007:1Y*FR007:5Y'), r2 = dev20(sp);
    if (r2) out.push('<b>② FR007 1s5s 斜率</b>：<b>' + fmt(r2.v, 0) + 'bp</b>' + (r2.v < 0 ? ' <span class="tagwarn">倒挂</span>' : '') + (Math.abs(r2.dev) >= 5 ? '，较近20日' + (r2.dev > 0 ? '<span class="up">走阔' + fmt(r2.dev, 0) + 'bp</span>' : '<span class="down">收窄' + fmt(-r2.dev, 0) + 'bp</span>') : ''));
    var sp3 = irsTermSpread('3M SHIBOR:1Y*3M SHIBOR:5Y'), lt3 = sp3 && last(sp3.values);
    if (lt3) out.push('<b>② 3M SHIBOR 1s5s 斜率</b>：<b>' + fmt(lt3.v, 0) + 'bp</b>' + (lt3.v < 0 ? ' <span class="tagwarn">倒挂</span>' : ''));
    var r7 = get('funding_rates', 'R007'), s1 = get('irs', 'FR007:1Y');
    if (r7 && s1) {
      var m = {}; s1.values.forEach(function (v, i) { if (v !== null) m[s1.dates[i]] = v; });
      var lr = last(r7.values), ls = last(s1.values);
      var d = null;
      for (var i = r7.dates.length - 1; i >= 0; i--) { var s = m[r7.dates[i]]; if (r7.values[i] !== null && s !== undefined) { d = (r7.values[i] - s) * 100; break; } }
      if (d !== null) {
        var tendency = d < -2 ? '定价降息' : (d > 2 ? '定价加息' : '基本持平');
        var ic = d < -2 ? '<span class="down">▼</span>' : (d > 2 ? '<span class="up">▲</span>' : '');
        out.push('<b>③ 隐含升降息预期（IRS反推）</b>：R007−FR007S1Y = <b>' + fmt(d, 1) + 'bp</b> → ' + ic + '<b>' + tendency + '</b>');
      }
    }
    if (!out.length) out.push('暂无 IRS 数据，请连接实时源或上传底稿。');
    return out;
  }
  function derivImplicitCard() {
    var r7 = get('funding_rates', 'R007'), s1 = get('irs', 'FR007:1Y');
    if (!r7 || !s1) return '<div class="note">缺少 R007 或 FR007:1Y 数据，无法反推。</div>';
    var lr = last(r7.values), ls = last(s1.values);
    var m = {}; s1.values.forEach(function (v, i) { if (v !== null) m[s1.dates[i]] = v; });
    var sp = [], dts = [];
    for (var i = 0; i < r7.dates.length; i++) {
      var s = m[r7.dates[i]];
      if (r7.values[i] !== null && s !== undefined) { dts.push(r7.dates[i]); sp.push((r7.values[i] - s) * 100); }
    }
    var lsp = last(sp);
    var box = '<div class="kpis">' +
      kpi('FR007 即期（R007代理）', fmt(lr ? lr.v : 0, 4), '', '%', r7.src, '') +
      kpi('FR007 1Y 互换', fmt(ls ? ls.v : 0, 4), '', '%', s1.src, '') +
      kpi('隐含 1 年变动', lsp ? fmt(lsp.v, 1) : '-', '', 'bp', 'IRS反推', '') +
      kpi('市场倾向', (lsp && lsp.v < -2) ? '定价降息' : (lsp && lsp.v > 2) ? '定价加息' : '基本持平',
        (lsp && lsp.v < -2) ? '<span class="down">▼</span>' : (lsp && lsp.v > 2) ? '<span class="up">▲</span>' : '', '', '', '') +
      '</div>';
    setTimeout(function () {
      var st = Math.max(0, dts.length - 500);
      Charts.render($('#dvImp'), {
        labels: dts.slice(st), height: 280, y0: { dec: 1 },
        series: [{ name: 'R007 − FR007S1Y', data: sp.slice(st), dec: 1, color: '#f2637b' }],
        markers: markers(dts.slice(st), ['降准', '政策利率']),
        y0d: 0, toolFmt: function (x) { return fmt(x, 1) + ' bp'; }
      });
    }, 0);
    return box;
  }
  /* ================================================== 页面：衍生品 */
  function pDeriv() {
    var h = '';
    h += alertBar('衍生品近期关注（IRS 收益率 / 期限利差 / 隐含升降息预期）', derivAlerts());
    h += ncdPage(DERIV_GROUPS, 1, function (g) { return '横轴 月·日'; });
    h += '<div class="sect-title" style="margin-top:16px">3、隐含加息／降息预期（FR007 IRS 反推） · 近500个交易日</div>';
    h += card('隐含加息／降息预期（IRS 反推）',
      '口径：R007 即期 − FR007 1Y 互换；为负说明市场定价未来资金中枢下移（降息预期）',
      derivImplicitCard() + '<div id="dvImp"></div>');
    return h;
  }

  /* ================================================== 页面：人工试算 */
  function pCalc() {
    var h = '<div class="alertbar"><h3><span class="tagwarn">说明</span>人工试算</h3>' +
      '<div class="cols"><ul><li>所有计算<b>在浏览器本地完成</b>，不联网、不回传，输入参数不会离开本机。</li>' +
      '<li>修改任意输入框即时重算；可用「载入当前市场值」把底稿最新数据带入参数。</li></ul></div></div>';
    h += '<div class="chips" id="calcChips"></div>';
    h += '<div class="calc-grid"><div class="calc-form" id="calcForm"></div><div><div class="calc-out" id="calcOut"></div><div id="calcTable" style="margin-top:12px"></div></div></div>';
    setTimeout(function () {
      var chips = $('#calcChips'), form = $('#calcForm'), out = $('#calcOut'), tb = $('#calcTable');
      var cur = 0;
      function draw(i) {
        cur = i;
        var p = Calc.panels[i];
        form.innerHTML = '<div style="font-weight:700;margin-bottom:8px">' + esc(p.title) + '</div>' +
          '<div class="note" style="margin-bottom:10px">' + esc(p.desc) + '</div>' +
          p.fields.map(function (f) {
            return '<div class="fld"><label>' + esc(f.label) + '</label><input data-k="' + f.k + '" value="' + esc(f.def) + '"></div>';
          }).join('') +
          '<button class="btn pri" id="calcGo" style="width:100%;margin-top:6px">计算</button>' +
          '<button class="btn" id="calcLoad" style="width:100%;margin-top:6px">载入当前市场值</button>';
        $$('input', form).forEach(function (ip) { ip.oninput = run; ip.onchange = run; });
        $('#calcGo', form).onclick = run;
        $('#calcLoad', form).onclick = loadMarket;
        run();
      }
      function vals() {
        var v = {};
        $$('input', form).forEach(function (ip) { v[ip.dataset.k] = ip.value; });
        return v;
      }
      function run() {
        var p = Calc.panels[cur], v = vals(), r = [];
        try { r = p.out(v); } catch (e) { r = [{ k: '计算错误', v: String(e.message || e) }]; }
        out.innerHTML = r.map(function (o) {
          return '<div class="o"><div class="k">' + esc(o.k) + '</div><div class="v ' + (o.cls || '') + '">' + esc(o.v) + '</div></div>';
        }).join('');
        tb.innerHTML = p.table ? '<div class="card"><header><h4>明细</h4></header>' + p.table(v) + '</div>' : '';
      }
      function loadMarket() {
        var p = Calc.panels[cur], v = vals(), map = {};
        function set(k, val, dec) { var ip = $('input[data-k="' + k + '"]', form); if (ip && val !== null && val !== undefined && !isNaN(val)) ip.value = fmt(val, dec === undefined ? 4 : dec); }
        if (p.id === 'bond') {
          var y10 = get('variety_rate', '10Y国债'); var l = y10 && last(y10.values);
          if (l) { set('cpn', l.v); set('ytm', l.v); }
        } else if (p.id === 'scen' || p.id === 'carry' || p.id === 'ride') {
          var dm = get('duration_center', '久期中枢(15日窗口)'); var ld = dm && last(dm.values);
          if (ld) set('mdur', ld.v, 2);
          if (p.id === 'ride' || p.id === 'carry') {
            var y10b = get('variety_rate', '10Y国债'), y1 = get('variety_rate', '5Y国债');
            var a = y10b && last(y10b.values), b = y1 && last(y1.values);
            if (a) { set('yLong', a.v); if (p.id === 'carry') set('ra', a.v); }
            if (b) set('yShort', b.v);
            var d7 = get('funding_rates', 'DR007'); var lr = d7 && last(d7.values);
            if (lr) { if (p.id === 'carry') set('rf', lr.v); if (p.id === 'ride') set('yShort', lr.v); }
          }
        } else if (p.id === 'spread') {
          var vg = get('variety_rate', '10Y国开'), v10 = get('variety_rate', '10Y国债');
          var a2 = vg && last(vg.values), b2 = v10 && last(v10.values);
          if (a2 && b2) set('s0', (a2.v - b2.v) * 100, 2);
        } else if (p.id === 'irs' || p.id === 'implied') {
          var i1 = get('irs', 'FR007:1Y'), i5 = get('irs', 'FR007:5Y');
          var x1 = i1 && last(i1.values), x5 = i5 && last(i5.values);
          var d7b = get('funding_rates', 'DR007'); var xr = d7b && last(d7b.values);
          if (x1) { if (p.id === 'irs') set('fix', x1.v); set('s1y', x1.v); }
          if (x5) set('s5y', x5.v);
          if (xr) { set('flt', xr.v); set('spot', xr.v); }
        }
        run();
      }
      chips.innerHTML = Calc.panels.map(function (p, i) { return '<span class="chip' + (i === 0 ? ' on' : '') + '" data-i="' + i + '">' + esc(p.title) + '</span>'; }).join('');
      $$('.chip', chips).forEach(function (c) {
        c.onclick = function () { $$('.chip', chips).forEach(function (x) { x.classList.remove('on'); }); c.classList.add('on'); draw(+c.dataset.i); };
      });
      draw(0);
    }, 0);
    return h;
  }

  /* ================================================== 页面：数据底稿 */
  function pDraft() {
    var h = '';
    h += '<div class="alertbar"><h3><span class="tagwarn">取数优先级</span>Wind / 森浦 优先，底稿兜底</h3>' +
      '<div class="cols"><ul>' +
      '<li>同一日期上，<b>Wind 或森浦的实时值直接覆盖底稿值</b>；底稿只用于填补实时源没有的历史区间与无法自动取数的指标。</li>' +
      '<li>KPI 卡片右上角角标显示该指标当前实际来源（<b>Wind</b> / <b>森浦Qeubee</b> / <b>底稿</b>）。</li>' +
      '<li>下方清单中「被实时覆盖」＝该数据集的部分或全部日期已被 Wind / 森浦 替换。</li>' +
      '</ul></div></div>';

    // 三张底稿
    var info = (S.bundle.meta && S.bundle.meta.source_info) || [];
    h += '<div class="grid g3">' + info.map(function (f) {
      return card(f.file.replace('【兴证固收】', '').replace('.xlsx', ''),
        f.exists ? (f.size_mb + ' MB') : '文件缺失',
        '<div class="note">' +
        '<div>文件名：<code>' + esc(f.file) + '</code></div>' +
        '<div>更新：<b>' + esc(f.mtime || '-') + '</b></div>' +
        '<div>路径：<span style="font-size:10.5px">' + esc(f.path) + '</span></div>' +
        '</div>');
    }).join('') + '</div>';

    // 数据集清单
    var origins = S.bundle.origins || {};
    var rows = [];
    Object.keys(datasets()).forEach(function (key) {
      var d = datasets()[key];
      var L = lvs(key);
      var nd = (d && d.dates) ? d.dates.length : (Array.isArray(d) ? d.length : 0);
      var lastD = (d && d.dates && d.dates.length) ? d.dates[d.dates.length - 1] : '—';
      var liveInfo = '—';
      var over = 0, added = 0, src = '';
      if (L && L.series) {
        var names = Object.keys(L.series);
        liveInfo = (L.src || '实时') + '：' + names.join('、');
        src = L.src || '实时';
        names.forEach(function (n) {
          var g = get(key, n);
          if (g) { over += (g.over || 0); added += (g.added || 0); }
        });
      }
      rows.push([
        key,
        origins[key] || '—',
        src ? '<b style="color:var(--down)">' + esc(src) + '</b>' : '<span class="no">仅底稿</span>',
        String(nd), lastD,
        (over || added) ? '<span class="ok">覆盖 ' + over + ' 点 / 新增 ' + added + ' 点</span>' : '<span class="no">未覆盖</span>'
      ]);
    });
    rows.sort(function (a, b) { return (a[2] === b[2]) ? a[0].localeCompare(b[0]) : (a[2].indexOf('仅底稿') >= 0 ? 1 : -1); });

    h += card('数据集清单（共 ' + rows.length + ' 个）', '来源底稿 / 实时覆盖情况',
      '<div class="tb-wrap" style="max-height:520px">' +
      '<table class="tb"><thead><tr><th>数据集</th><th>来源底稿</th><th>实时源</th><th>点数</th><th>最新日期</th><th>实时覆盖</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' + r.map(function (c, i) {
          return '<td>' + (i === 2 || i === 5 ? c : esc(c)) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>');

    h += '<div class="grid g2">';
    h += card('更新底稿', '替换最新版 Excel 后需重新抽取',
      '<div class="note">' +
      '<div>1. 把最新版三张底稿覆盖到原目录（<code>' + esc((info[0] && info[0].path.replace(/[^\\/]+$/, '')) || '…') + '</code>），注意文件名保持一致。</div>' +
      '<div>2. 点顶部「上传更新」直接上传 xlsx，服务端会自动重跑抽取（推荐，无需手工拷贝）。</div>' +
      '<div>3. 或在命令行执行 <code>python extract.py</code> 后刷新页面。</div>' +
      '<div style="margin-top:6px">底稿为<b>兜底层</b>：即使不更新，Wind / 森浦可取的指标仍会实时刷新。</div>' +
      '</div>');
    h += card('底稿与实时源的口径差异（已核对）', '取数时需注意',
      '<div class="note">' +
      '<div><b>公开市场净投放</b>：森浦 <code>pbcOmoTimeSeriesStat</code> 为全口径（含 MLF、买断式到期），Wind <code>A4087688</code> 与底稿为逆回购口径。2026-09-28 森浦 -1603 亿、Wind 4397 亿，差在 6000 亿 MLF 到期是否计入。</div>' +
      '<div><b>DR001 / DR007</b>：Wind（M1006336 / M1006337）与森浦完全一致，2026-10-08~10 均为 1.3691/1.3822、1.3067/1.3295、1.2812/1.3241。</div>' +
      '<div style="margin-top:6px">页面默认以 <b>Wind</b> 为准；如需切换口径，在「数据源与设置」里关闭对应源后刷新。</div>' +
      '</div>');
    h += '</div>';
    return h;
  }

  /* ================================================== 页面：数据源与设置 */
  var SRC_TABLE = [
    ['资金利率（DR/R、SHIBOR）', 'DR001/DR007/R001/R007 = DR001.IBO 等；也可用 WSD "DR007.IBO"', 'mmrRateOverviewDr001Dr007、mmrRateOverviewR001R007、mmdRepoDailyIb、mmdShiborRepoFixing', '可全自动'],
    ['回购成交量与期限结构', '成交量:银行间质押式回购', 'mmdRepoDealStatIb、mmrIrsFr007Hist', '可全自动'],
    ['分机构净融出/净融入', '需 CFETS 机构口径（Wind 部分有）', 'mmdRepoDailyIb（含机构维度）、finInterbankLeverageByOrg', '森浦可替代'],
    ['银行间/交易所杠杆率', '待购回余额 + 中债登/上清所托管量', 'interbankLeverageWeeklyStat、finInterbankLeverageByOrg', '森浦可替代'],
    ['央行公开市场操作', '中国:公开市场操作:货币净投放/投放量/回笼量', 'pbcOmoTimeSeriesStat、pbcOmoRepo、pbcOmoBalance', '可全自动（已实测）'],
    ['MLF / 买断式逆回购 / 降准', '中国:中期借贷便利(MLF):投放金额/余额', 'pbcOmoMlfStat、pbcRrr、pbcMlfRate', '可全自动'],
    ['央行官媒与公开讲话', 'Wind 新闻/公告模块（文本，需人工清洗）', 'PolicyNews（政策舆情）、articles（利率时讯）', '森浦可取，需关键词过滤'],
    ['存单一级发行', '同业存单发行利率(分银行)、发行量/偿还量/净融资', 'ncdIssuance、ncdNetFinancingStatNew、ncdIssueStatByBankTypeStat', '可全自动'],
    ['存单加权发行期限', '需按发行明细加权计算', 'ncdIssueRateTrendByBankTypeSummary、ncdTermStructureStat', '森浦可直接取'],
    ['存单募集率/发行成功率', '需发行明细计算', 'ncdIssueSuccessRateStat', '森浦可直接取'],
    ['存单到期量（周/月）', '需明细汇总', 'ncdMaturityStatByBankTypeStat、ncdMlfMaturityMain', '可全自动'],
    ['存单二级 AAA 收益率曲线', '中债商业银行同业存单到期收益率(AAA)', 'cdcYieldCurveHis、dailyReportDealMatrixNcdPriceMatrix', '可全自动'],
    ['存单存量（分银行）', '需托管口径', 'ncdStockStatDailyStat、ncdStockStatByBankTypeStat', '森浦可直接取'],
    ['基金久期（敏感性久期中枢）', '无标准指标，需自建回归', '—（无可替代）', '必须人工上传'],
    ['利率债换手率', '需成交明细/托管量计算', 'bondTradeDayComposite、bondTradeDayBroker', '森浦可算'],
    ['品种利差 / 期限利差', '中债收益率曲线各期限', 'cdcYieldCurveHis、spreadOverviewStat', '可全自动'],
    ['地方债-国债利差', '中债地方债/国债曲线', 'cdcYieldCurveHis、csiBondValuation', '可全自动'],
    ['新老券利差', '需个券收益率', 'bondDimInfo + 估值（需拼装）', '部分可自动'],
    ['利率互换（IRS）', '利率互换:FR007:1年/5年 等', 'mmdIrsDailyStat、mmrIrsFr007Hist、mmrIrsShibor3mHist', '可全自动'],
    ['国债期货（T/TL/TS）', 'Wind 期货日行情/持仓', 'tfDailyQuote、tfPositionStat、treasuryFutureLongShortRatio', '可全自动'],
    ['债券借贷', '债券借贷结算额', 'mmdBondLendingDailyStat', '可全自动'],
    ['超储率（测算）', '需央行报表 + 测算模型', '无直接指标', '必须人工上传'],
    ['票据利率（国股转贴）', '普兰金服口径', '—（外部数据源）', '必须人工上传'],
    ['汇率与逆周期因子', 'CNYMUSD、FCCNYFIX、USDCNY', 'macroCnUsTreasurySpread 等宏观类', 'Wind 可自动']
  ];
  function pSource() {
    var st = (S.live && S.live.status) || { qeubee: 'unknown', wind: 'unknown' };
    var h = '<div class="grid g2">';
    h += card('数据源连接状态', '',
      tbl(['数据源', '状态', '说明'], [
        ['森浦 Qeubee', statusCell(st.qeubee), '通过本地桥接 / MCP 调用；已实测可返回 2026-10-10 数据'],
        ['Wind 万得', statusCell(st.wind), '需本机安装 Wind 终端并授权 WindPy；当前会话返回 -103（无权限）'],
        ['本地 Excel 底稿', '<span class="ok">已加载</span>', '三张兴证固收底稿，' + (S.bundle.meta.latest_date || '') + ' 截止'],
        ['人工上传', '<span class="ok">可用</span>', '顶部「上传更新」按钮，文件仅在本机解析']
      ]));
    h += card('数据保密约定', '', '<div class="note">' +
      '<div>1. 所有数据文件保存在本机 <code>workbench/data/</code>，网页通过 <code>http://127.0.0.1</code> 本地服务读取，<b>不经过任何外部网络</b>。</div>' +
      '<div>2. 页面不加载任何外部 CDN 资源，图表引擎为本地自研 SVG 实现，断网可用。</div>' +
      '<div>3. 上传的 Excel 在本地解析后立即写入本地目录，不上传云端。</div>' +
      '<div>4. 如需部署到内网共享，建议把 <code>workbench/</code> 整个目录放到内网机器，并仅开放内网端口。</div>' +
      '<div>5. 底稿版权归原始提供方，请勿二次分发。</div></div>');
    h += '</div>';
    h += card('Wind / 森浦 Qeubee 自动供数可行性评估', '点击表头可筛选；「可全自动」表示无需人工上传',
      '<div class="tb-wrap"><table class="src"><thead><tr><th>指标／专题</th><th>Wind 取数方式</th><th>森浦 Qeubee 取数方式</th><th>结论</th></tr></thead><tbody>' +
      SRC_TABLE.map(function (r) {
        var cls = r[3].indexOf('可全自动') >= 0 ? 'ok' : r[3].indexOf('必须人工') >= 0 ? 'no' : 'pt';
        return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td class="' + cls + '">' + esc(r[3]) + '</td></tr>';
      }).join('') + '</tbody></table></div>');
    h += card('实时取数说明', '', '<div class="note">' +
      '<div><b>工作方式</b>：点击顶部「实时取数」→ 调用本地桥接 <code>bridge.py</code> → 依次尝试 Wind(WindPy) → 森浦 Qeubee → 失败则保留本地底稿值。</div>' +
      '<div><b>刷新结果</b>写入 <code>data/live.json</code>，页面读取后覆盖同名序列，KPI 上的来源角标会变为「实时」。</div>' +
      '<div><b>无法自动取数的指标</b>（基金久期、超储率测算、票据利率等）保持本地底稿值，可用「上传更新」替换。</div>' +
      '</div>');
    return h;
  }
  function statusCell(s) {
    if (s === 'ok') return '<span class="ok">已连接</span>';
    if (s === 'off') return '<span class="no">未连接</span>';
    if (s === 'warn') return '<span class="pt">部分可用</span>';
    return '<span class="no">未知</span>';
  }

  /* ================================================== 智能问答（工具）
     完全本地：基于 bundle/live 数据集 + 每日交易笔记做规则化检索与统计，
     不做任何联网调用、不调用大模型。 */
  var QA_ALIAS = {
    'DR001': ['dr001', '银行间隔夜', '存款类隔夜'],
    'R001': ['r001', '隔夜回购', '隔夜加权'],
    '隔夜分层 R001-DR001': ['隔夜分层', '隔夜利差', 'r001-dr001'],
    'DR007': ['dr007', '7天dr', '七天dr', '存款类7天'],
    'R007': ['r007', '7天回购', '七天回购', '7天加权'],
    '7天分层 R007-DR007': ['7天分层', '七天分层', 'r007-dr007'],
    '1Y股份行存单发行': ['1y存单发行', '存单发行利率', '一年存单发行', '股份行存单'],
    '1Y AAA存单二级': ['1y存单二级', 'aaa存单', '存单二级', '1年存单'],
    '10Y国债': ['10y国债', '十年国债', '10年国债'],
    '大行净融出': ['大行融出', '国有大行净融出'],
    '货基净融出': ['货基融出', '货币基金净融出'],
    '基金净融入': ['基金融入'],
    '券商净融入': ['券商融入', '券商自营'],
    '基金回购融入余额': ['基金回购', '基金杠杆'],
    '市场回购余额': ['回购余额', '银行间回购余额'],
    '银行间杠杆率': ['杠杆率', '银行间杠杆']
  };
  // 问答额外支持的指标（总览 KPI 之外）
  var QA_EXTRA = [
    { label: 'R014', key: 'funding_rates', name: 'R014', unit: '%', dec: 4, how: 'mean', aliases: ['r014', '14天回购'] },
    { label: 'DR014', key: 'funding_rates', name: 'DR014', unit: '%', dec: 4, how: 'mean', aliases: ['dr014'] },
    { label: '1M AAA存单二级', key: 'ncd_secondary_curve', name: '1M', unit: '%', dec: 4, how: 'mean', aliases: ['1m存单', '1个月存单'] },
    { label: '3M AAA存单二级', key: 'ncd_secondary_curve', name: '3M', unit: '%', dec: 4, how: 'mean', aliases: ['3m存单', '3个月存单'] },
    { label: '6M AAA存单二级', key: 'ncd_secondary_curve', name: '6M', unit: '%', dec: 4, how: 'mean', aliases: ['6m存单'] },
    { label: '9M AAA存单二级', key: 'ncd_secondary_curve', name: '9M', unit: '%', dec: 4, how: 'mean', aliases: ['9m存单'] },
    { label: '3M股份行存单发行', key: 'ncd_issue_rate_shibor', name: '3M股份行存单', unit: '%', dec: 4, how: 'mean', aliases: ['3m存单发行'] },
    { label: '5Y国债', key: 'variety_rate', name: '5Y国债', unit: '%', dec: 4, how: 'mean', aliases: ['5y国债', '五年国债'] },
    { label: '30Y国债', key: 'variety_rate', name: '30Y国债', unit: '%', dec: 4, how: 'mean', aliases: ['30y国债', '三十国债', '30年国债', '超长国债'] },
    { label: '10Y国开', key: 'variety_rate', name: '10Y国开', unit: '%', dec: 4, how: 'mean', aliases: ['10y国开', '国开债', '十年国开'] },
    { label: '国债10Y(曲线)', key: 'bond_curve', name: '国债10Y', unit: '%', dec: 4, how: 'mean', aliases: ['国债10y', '国债曲线'] },
    { label: '国债30Y(曲线)', key: 'bond_curve', name: '国债30Y', unit: '%', dec: 4, how: 'mean', aliases: ['国债30y', '超长端'] },
    { label: '地方债10Y', key: 'bond_curve', name: '地方债10Y', unit: '%', dec: 4, how: 'mean', aliases: ['地方债10y'] },
    { label: '1M国股转贴', key: 'bill_rate', name: '1M国股转贴', unit: '%', dec: 4, how: 'mean', aliases: ['1m转贴', '票据1m'] },
    { label: '3M国股转贴', key: 'bill_rate', name: '3M国股转贴', unit: '%', dec: 4, how: 'mean', aliases: ['3m转贴', '票据3m', '转贴利率'] },
    { label: '6M国股转贴', key: 'bill_rate', name: '6M国股转贴', unit: '%', dec: 4, how: 'mean', aliases: ['6m转贴', '票据6m'] },
    { label: 'FR007 5Y互换', key: 'irs', name: 'FR007:5Y', unit: '%', dec: 4, how: 'mean', aliases: ['fr007:5y', 'fr007 5y', '5年互换'] },
    { label: '3M SHIBOR 1Y互换', key: 'irs', name: '3M SHIBOR:1Y', unit: '%', dec: 4, how: 'mean', aliases: ['shibor互换', '3m shibor:1y'] },
    { label: '存单净融资', key: 'ncd_weekly', name: '存单净发行', unit: '亿', dec: 0, how: 'sum', aliases: ['存单净发行', '净融资'] },
    { label: '银行体系净融出', key: 'repo_institution', name: '银行体系净融出', unit: '亿', dec: 0, how: 'mean', aliases: ['银行体系融出'] },
    { label: '非银净融入合计', key: 'nonbank_demand', name: '非银净融入合计', unit: '亿', dec: 0, how: 'mean', aliases: ['非银净融入', '非银融入'] },
    { label: '全市场杠杆率', key: 'lev_all', name: '全市场杠杆率', unit: '倍', dec: 4, how: 'mean', aliases: ['全市场杠杆'] }
  ];
  var QA_REG = null;
  function qaRegistry() {
    if (QA_REG) return QA_REG;
    var arr = OV_METRICS.map(function (m) {
      var o = {};
      for (var k in m) o[k] = m[k];
      o.aliases = (QA_ALIAS[m.label] || []).concat([m.label, m.name || '']);
      return o;
    }).concat(QA_EXTRA.map(function (m) {
      var o = {};
      for (var k in m) o[k] = m[k];
      o.aliases = (m.aliases || []).concat([m.label, m.name || '']);
      return o;
    }));
    arr.forEach(function (m) {
      m._keys = (m.aliases || []).concat([m.label, m.name || ''])
        .filter(Boolean).map(function (x) { return String(x).toLowerCase().replace(/\s+/g, ''); });
    });
    QA_REG = arr;
    return QA_REG;
  }
  /** 在问题中找指标：取最长匹配，返回 [metric,...]（最多 2 个，便于算利差） */
  function qaFindMetrics(q) {
    var qq = String(q).toLowerCase().replace(/\s+/g, '');
    var scored = [];
    qaRegistry().forEach(function (m) {
      var best = 0, bpos = 1e9;
      m._keys.forEach(function (k) {
        if (!k) return;
        var i = qq.indexOf(k);
        if (i >= 0 && k.length > best) { best = k.length; bpos = i; }
      });
      if (best) scored.push({ m: m, s: best, p: bpos });
    });
    // 先按匹配长度（越具体越优先），再按在问题中出现的位置（保留提问里 A-B 的顺序）
    scored.sort(function (a, b) { return (b.s - a.s) || (a.p - b.p); });
    // 选中后再按「问题里的先后顺序」排，保证「A 与 B 利差」是 A − B
    var top = scored.slice(0, 2);
    top.sort(function (a, b) { return a.p - b.p; });
    return top.map(function (x) { return x.m; });
  }
  /** 取序列（处理 spread / scale） */
  function qaSeries(m) {
    var g = get(m.key, m.name);
    if (!g) return null;
    var vals = g.values;
    if (m.spread) {
      var b = get(m.spread.key, m.spread.name);
      if (!b) return null;
      var mm = {};
      b.values.forEach(function (v, i) { if (v !== null && v !== undefined && !isNaN(v)) mm[b.dates[i]] = v; });
      vals = g.values.map(function (v, i) {
        var dv = mm[g.dates[i]];
        return (v !== null && v !== undefined && !isNaN(v) && dv !== undefined) ? (v - dv) * 100 : null;
      });
    } else if (m.scale) {
      vals = g.values.map(function (v) { return (v === null || v === undefined) ? null : v * m.scale; });
    }
    return { label: m.label, dates: g.dates, values: vals, unit: m.unit, dec: m.dec, src: g.src };
  }
  /** 解析时间范围：返回 {d0,d1,label,mode,n} */
  function qaPeriod(q, dates) {
    var lastD = dates[dates.length - 1];
    var ly = parseInt(lastD.slice(0, 4), 10), lm = parseInt(lastD.slice(5, 7), 10);
    var qq = String(q);
    function ymStr(y, m) { return y + '-' + String(m).padStart(2, '0'); }
    var m;
    // 具体日期
    if ((m = qq.match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/))) {
      var d = m[1] + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[3]).padStart(2, '0');
      return { d0: d, d1: d, label: d, mode: 'date' };
    }
    if ((m = qq.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/))) {
      var y = ly;
      if (/去\s*年|去年同期/.test(qq)) y = ly - 1;
      var d2 = y + '-' + String(+m[1]).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0');
      return { d0: d2, d1: d2, label: d2, mode: 'date' };
    }
    // 近 N 日/天/交易日
    if ((m = qq.match(/近\s*(\d+)\s*(个)?\s*(交易日|日|天)/))) {
      var n = Math.max(1, parseInt(m[1], 10));
      var i0 = Math.max(0, dates.length - n);
      return { d0: dates[i0], d1: lastD, label: '近' + n + '个交易日', mode: 'recent', n: n };
    }
    // 年 + 月
    if ((m = qq.match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*月?/))) {
      var ym = ymStr(+m[1], +m[2]);
      return { d0: ym + '-01', d1: ym + '-31', label: m[1] + '年' + (+m[2]) + '月', mode: 'month', ym: ym };
    }
    // 仅月份
    if ((m = qq.match(/(?:^|[^\d])(\d{1,2})\s*月(?!\s*\d)/))) {
      var mm2 = +m[1];
      if (mm2 >= 1 && mm2 <= 12) {
        var yy = ly;
        if (/去\s*年|去年同期/.test(qq)) yy = ly - 1;
        var ym3 = ymStr(yy, mm2);
        return { d0: ym3 + '-01', d1: ym3 + '-31', label: yy + '年' + mm2 + '月', mode: 'month', ym: ym3 };
      }
    }
    if (/本\s*月/.test(qq)) {
      var ymc = ymStr(ly, lm);
      return { d0: ymc + '-01', d1: ymc + '-31', label: '本月（' + ymc + '）', mode: 'month', ym: ymc };
    }
    if (/上\s*月/.test(qq)) {
      var pm = lm === 1 ? 12 : lm - 1, py = lm === 1 ? ly - 1 : ly;
      var ymp = ymStr(py, pm);
      return { d0: ymp + '-01', d1: ymp + '-31', label: '上月（' + ymp + '）', mode: 'month', ym: ymp };
    }
    if (/今年|年初至今|ytd|年内/.test(qq)) {
      return { d0: ly + '-01-01', d1: lastD, label: ly + '年初至今', mode: 'year', ym: String(ly) };
    }
    if (/去\s*年/.test(qq)) {
      return { d0: (ly - 1) + '-01-01', d1: (ly - 1) + '-12-31', label: (ly - 1) + '年全年', mode: 'year' };
    }
    return null;
  }
  /** 区间统计 */
  function qaStats(s, d0, d1) {
    var vs = [], ds = [];
    for (var i = 0; i < s.dates.length; i++) {
      if (d0 && s.dates[i] < d0) continue;
      if (d1 && s.dates[i] > d1) continue;
      var v = s.values[i];
      if (v === null || v === undefined || isNaN(v)) continue;
      vs.push(v); ds.push(s.dates[i]);
    }
    if (!vs.length) return null;
    var sum = vs.reduce(function (a, b) { return a + b; }, 0);
    var mx = vs[0], mn = vs[0], mxd = ds[0], mnd = ds[0];
    vs.forEach(function (v, i) { if (v > mx) { mx = v; mxd = ds[i]; } if (v < mn) { mn = v; mnd = ds[i]; } });
    return {
      n: vs.length, mean: sum / vs.length, max: mx, maxD: mxd, min: mn, minD: mnd,
      first: vs[0], firstD: ds[0], last: vs[vs.length - 1], lastD: ds[ds.length - 1],
      dates: ds, values: vs
    };
  }
  function qaPrevRange(s, p) {
    // 与 p 等长的前一段（按观测点），或上月/上年同月
    if (!p) return null;
    if (p.mode === 'month') {
      var y = +p.ym.slice(0, 4), m = +p.ym.slice(5, 7);
      var pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
      var ym = py + '-' + String(pm).padStart(2, '0');
      return { d0: ym + '-01', d1: ym + '-31', label: py + '年' + pm + '月' };
    }
    if (p.mode === 'year') {
      return { d0: (+p.ym - 1) + '-01-01', d1: (+p.ym - 1) + '-12-31', label: (+p.ym - 1) + '年全年' };
    }
    if (p.mode === 'recent') {
      var n = p.n, idx = s.dates.indexOf(p.d0);
      if (idx < 0) idx = s.dates.length - n;
      var i0 = Math.max(0, idx - n), i1 = Math.max(0, idx - 1);
      if (i1 <= i0) return null;
      return { d0: s.dates[i0], d1: s.dates[i1], label: '前' + (i1 - i0 + 1) + '个交易日' };
    }
    if (p.mode === 'date') {
      var i = s.dates.indexOf(p.d0);
      var j = i > 0 ? i - 1 : -1;
      if (j < 0) return null;
      return { d0: s.dates[j], d1: s.dates[j], label: '上一交易日（' + s.dates[j] + '）' };
    }
    return null;
  }
  function qaNotesBlock(d0, d1, kw) {
    var list = [];
    if (d0 || d1) list = notesInRange(d0, d1);
    if (kw) {
      var extra = notesSearch(kw);
      extra.forEach(function (n) { if (list.indexOf(n) < 0) list.push(n); });
    }
    if (!list.length) return '';
    list.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var h = '<div class="qa-sec"><b>相关交易笔记</b>（' + list.length + ' 条）</div><div class="qa-notes">';
    list.slice(0, 8).forEach(function (n) {
      h += '<div class="qa-note"><span class="nt-tag">' + esc(n.tag || '其他') + '</span>' +
        '<span class="nt-date">' + esc(n.date) + '</span> ' +
        (n.title ? '<b>' + esc(n.title) + '</b>：' : '') + esc((n.text || '').slice(0, 120)) + '</div>';
    });
    return h + '</div>';
  }
  function qaChartBlock(s, st) {
    return '<div id="qaChart" style="height:200px;margin-top:6px"></div>';
  }
  /** 主入口：返回 {html, chart:{labels,values,dec,unit,name}} */
  function qaAnswer(q) {
    q = String(q || '').trim();
    if (!q) return { html: '<div class="empty">请输入问题，或点击上方示例</div>' };
    var out = [];
    var mets = qaFindMetrics(q);
    var isNoteQ = /笔记|备注|复盘|记录|记了/.test(q);
    var isSeason = /季节|历史|往年|同期|历年/.test(q);
    var isMeta = /数据截止|截止日|最新日期|更新到/.test(q);

    // 1) 纯笔记检索
    if (isNoteQ && !mets.length) {
      var kw = q.replace(/笔记|备注|复盘|记录|记了|的|有哪些|是什么|查询|搜|搜索/g, '').trim();
      var ns = notesSearch(kw || '');
      // 拆词兜底：「9月资金面」→ 9月（按日期范围）+ 资金面（关键词）
      if (!ns.length && kw) {
        var mmk = kw.match(/(\d{1,2})\s*月/);
        var rest = kw.replace(/(\d{1,2})\s*月/, '').trim();
        var seenN = {};
        var union = [];
        (rest ? [rest] : []).concat(mmk ? [mmk[0]] : []).forEach(function (t) {
          notesSearch(t).forEach(function (n) { if (!seenN[n.id]) { seenN[n.id] = 1; union.push(n); } });
        });
        if (mmk) {
          var yy = (qaPeriod(kw, [String((S.bundle && S.bundle.meta && S.bundle.meta.latest_date) || todayStr())]) || {}).d0;
          var yr = (yy || todayStr()).slice(0, 4);
          var ymm = yr + '-' + String(+mmk[1]).padStart(2, '0');
          notesInRange(ymm + '-01', ymm + '-31').forEach(function (n) {
            if (!seenN[n.id]) { seenN[n.id] = 1; union.push(n); }
          });
        }
        if (union.length) ns = union;
      }
      if (!ns.length) return { html: '<div class="qa-ans">没有找到与「' + esc(kw || q) + '」相关的笔记。当前共 ' + notesRaw().length + ' 条笔记，可在总览页「每日交易笔记」录入。</div>' };
      var h0 = '<div class="qa-ans"><b>笔记检索「' + esc(kw || '全部') + '」：命中 ' + ns.length + ' 条</b></div><div class="qa-notes">' +
        ns.slice(0, 20).map(function (n) {
          return '<div class="qa-note"><span class="nt-tag">' + esc(n.tag || '其他') + '</span><span class="nt-date">' + esc(n.date) + '</span> ' +
            (n.title ? '<b>' + esc(n.title) + '</b>：' : '') + esc(n.text || '') + '</div>';
        }).join('') + '</div>';
      return { html: h0 };
    }
    // 2) 元信息
    if (isMeta) {
      return {
        html: '<div class="qa-ans"><b>数据截止</b>：' + esc((S.bundle && S.bundle.meta && S.bundle.meta.latest_date) || '—') +
          '；实时源状态 森浦=' + esc(((S.live || {}).status || {}).qeubee || '未知') + '、Wind=' + esc(((S.live || {}).status || {}).wind || '未知') +
          '；交易笔记 ' + notesRaw().length + ' 条。</div>'
      };
    }
    if (!mets.length) {
      return {
        html: '<div class="qa-ans">没能识别问题里的指标。可试试这些问法：</div>' +
          '<div class="note">' + QA_EXAMPLES.map(function (x) { return '· ' + esc(x); }).join('<br>') + '</div>' +
          '<div class="note" style="margin-top:6px">已收录指标：' + esc(qaRegistry().map(function (m) { return m.label; }).join('、')) + '</div>'
      };
    }
    var m0 = mets[0];
    var s = qaSeries(m0);
    if (!s) return { html: '<div class="qa-ans">指标「' + esc(m0.label) + '」当前没有可用数据（底稿未提供该序列）。</div>' };

    // 利差：两个指标
    var two = null;
    if (mets.length > 1 && /利差|价差|减|－|-|与/.test(q)) {
      var s2 = qaSeries(mets[1]);
      if (s2) {
        var mp = {};
        s2.values.forEach(function (v, i) { if (v !== null && v !== undefined && !isNaN(v)) mp[s2.dates[i]] = v; });
        var dd = [], vv = [];
        s.values.forEach(function (v, i) {
          var o = mp[s.dates[i]];
          if (v === null || v === undefined || isNaN(v) || o === undefined) return;
          dd.push(s.dates[i]); vv.push((v - o) * (/bp|基点/.test(q) ? 100 : 1));
        });
        if (vv.length) {
          two = { label: m0.label + ' − ' + mets[1].label, dates: dd, values: vv, unit: /bp|基点/.test(q) ? 'bp' : (m0.unit === s2.unit ? m0.unit : ''), dec: /bp|基点/.test(q) ? 1 : Math.max(m0.dec, s2.dec), src: '计算' };
          s = two;
        }
      }
    }

    var p = qaPeriod(q, s.dates);
    var lastD = s.dates[s.dates.length - 1];
    var L = last(s.values);
    var head = '<div class="qa-ans"><b>' + esc(s.label) + '</b>（' + esc(s.src || '底稿') + '，' + esc(s.dates[0]) + ' ~ ' + esc(lastD) + '）</div>';
    out.push(head);

    // 季节性
    if (isSeason) {
      var mon = p && p.mode === 'month' ? +p.ym.slice(5, 7) : (p && p.mode === 'date' ? +p.d0.slice(5, 7) : null);
      var mq = q.match(/(\d{1,2})\s*月/);
      if (mon === null && mq) mon = +mq[1];
      if (mon) {
        var sm = seasonal(s.dates, s.values, m0.how || 'mean', 6);
        var rows = sm.years.map(function (y) {
          var v = (sm.byYear[y] || [])[mon - 1];
          return [y + '年' + mon + '月', v === null || v === undefined || isNaN(v) ? '—' : fmt(v, s.dec) + s.unit];
        });
        var vs2 = sm.years.map(function (y) { return (sm.byYear[y] || [])[mon - 1]; }).filter(function (v) { return v !== null && v !== undefined && !isNaN(v); });
        var av = vs2.length ? vs2.reduce(function (a, b) { return a + b; }, 0) / vs2.length : null;
        out.push('<div class="qa-sec"><b>' + mon + '月季节性</b>（' + sm.years.length + ' 年，' + (m0.how === 'sum' ? '月合计' : '月均') + '）</div>');
        out.push(tbl(['年份', mon + '月'], rows));
        out.push('<div class="note">均值 ' + (av === null ? '—' : fmt(av, s.dec) + s.unit) +
          '；最高 ' + (vs2.length ? fmt(Math.max.apply(null, vs2), s.dec) : '—') + s.unit +
          '，最低 ' + (vs2.length ? fmt(Math.min.apply(null, vs2), s.dec) : '—') + s.unit + '。</div>');
        out.push(qaNotesBlock(null, null, mon + '月'));
        return { html: out.join('') };
      }
    }

    var chart = null;
    if (!p) {
      // 无时间限定：给最新值 + 近 20 个交易日概况
      var p20 = { d0: s.dates[Math.max(0, s.dates.length - 20)], d1: lastD, label: '近20个交易日', mode: 'recent', n: 20 };
      var st20 = qaStats(s, p20.d0, p20.d1);
      var prev5 = null;
      for (var k = L.i - 1, c = 0; k >= 0 && c < 5; k--) { if (s.values[k] !== null && !isNaN(s.values[k])) { prev5 = s.values[k]; c++; } }
      out.push('<div class="qa-kpi"><div class="o"><div class="k">最新值（' + esc(s.dates[L.i]) + '）</div><div class="v">' + fmt(L.v, s.dec) + '<span class="u">' + esc(s.unit) + '</span></div></div>' +
        '<div class="o"><div class="k">较 5 个交易日前</div><div class="v">' + (prev5 === null ? '—' : (L.v - prev5 >= 0 ? '+' : '') + fmt(L.v - prev5, s.dec)) + '<span class="u">' + esc(s.unit) + '</span></div></div>' +
        (st20 ? '<div class="o"><div class="k">近20日均</div><div class="v">' + fmt(st20.mean, s.dec) + '<span class="u">' + esc(s.unit) + '</span></div></div>' : '') +
        '</div>');
      out.push('<div class="note">如需区间统计，可问「近20个交易日 ' + esc(m0.label) + ' 均值/最高/最低」或「2026年9月 ' + esc(m0.label) + '」。</div>');
      out.push(qaChartBlock());
      chart = { labels: s.dates.slice(Math.max(0, s.dates.length - 120)), values: s.values.slice(Math.max(0, s.dates.length - 120)), dec: s.dec, unit: s.unit, name: s.label };
      out.push(qaNotesBlock(s.dates[Math.max(0, s.dates.length - 20)], lastD, m0.label));
      return { html: out.join(''), chart: chart };
    }

    var st = qaStats(s, p.d0, p.d1);
    if (!st) {
      out.push('<div class="qa-ans">区间 ' + esc(p.label) + '（' + esc(p.d0) + '~' + esc(p.d1) + '）内没有数据，最新数据到 ' + esc(lastD) + '。</div>');
      return { html: out.join('') };
    }
    var sc = 1;   // qaSeries() 内部已应用 scale，此处不再重复缩放
    var wantMax = /最高|最大|峰值|高点/.test(q);
    var wantMin = /最低|最小|低点/.test(q);
    var wantChg = /变化|变动|环比|同比|上行|下行|较|比|涨|跌|走高|走低/.test(q);
    out.push('<div class="qa-kpi">' +
      '<div class="o"><div class="k">' + esc(p.label) + '均值</div><div class="v">' + fmt(st.mean * sc, s.dec) + '<span class="u">' + esc(s.unit) + '</span></div></div>' +
      '<div class="o"><div class="k">最高（' + esc(st.maxD) + '）</div><div class="v">' + fmt(st.max * sc, s.dec) + '<span class="u">' + esc(s.unit) + '</span></div></div>' +
      '<div class="o"><div class="k">最低（' + esc(st.minD) + '）</div><div class="v">' + fmt(st.min * sc, s.dec) + '<span class="u">' + esc(s.unit) + '</span></div></div>' +
      '<div class="o"><div class="k">期末（' + esc(st.lastD) + '）</div><div class="v">' + fmt(st.last * sc, s.dec) + '<span class="u">' + esc(s.unit) + '</span></div></div>' +
      '</div>');
    out.push('<div class="note">样本 ' + st.n + ' 个交易日（' + esc(st.firstD) + ' ~ ' + esc(st.lastD) + '）。</div>');
    if (wantChg) {
      var pv = qaPrevRange(s, p);
      var stP = pv ? qaStats(s, pv.d0, pv.d1) : null;
      if (stP) {
        var diff = st.mean - stP.mean;
        var cls = Math.abs(diff) < 1e-9 ? 'flat' : (diff > 0 ? 'up' : 'down');
        out.push('<div class="qa-sec"><b>对比</b>：' + esc(p.label) + ' 均值 ' + fmt(st.mean * sc, s.dec) + s.unit +
          ' vs ' + esc(pv.label) + ' ' + fmt(stP.mean * sc, s.dec) + s.unit +
          ' → <span class="' + cls + '">' + (diff > 0 ? '▲ +' : diff < 0 ? '▼ ' : '－ ') + fmt(Math.abs(diff * sc), s.dec) + s.unit + '</span></div>');
      } else {
        out.push('<div class="note">未找到可对比的上一段区间。</div>');
      }
    }
    if (wantMax) out.push('<div class="note">区间最高 <b>' + fmt(st.max * sc, s.dec) + s.unit + '</b>，出现在 ' + esc(st.maxD) + '。</div>');
    if (wantMin) out.push('<div class="note">区间最低 <b>' + fmt(st.min * sc, s.dec) + s.unit + '</b>，出现在 ' + esc(st.minD) + '。</div>');
    out.push(qaChartBlock());
    chart = { labels: st.dates.slice(-160), values: st.values.slice(-160), dec: s.dec, unit: s.unit, name: s.label + ' · ' + p.label };
    out.push(qaNotesBlock(p.d0, p.d1, m0.label));
    return { html: out.join(''), chart: chart };
  }

  var QA_EXAMPLES = [
    'DR007 最新是多少',
    '2026年9月 DR001 均值',
    '近20个交易日 R001 最高和最低',
    '9月 DR007 较上月变化',
    '历史上9月 DR007 季节性',
    '10Y国债 与 1Y AAA存单二级 利差 bp',
    '9月资金面笔记',
    '大行净融出 近10个交易日 走势'
  ];
  var QA_HIST = [];
  function pQa() {
    var h = '<div class="grid g23">' +
      card('智能问答（本地数据 · 不联网）', '基于本机底稿/实时数据 + 每日交易笔记作答',
        '<div class="qa">' +
        '<div class="qa-row"><input type="text" id="qaInput" class="qa-input" placeholder="例如：2026年9月 DR001 均值？近20个交易日 R007 最高？">' +
        '<button class="btn pri" id="qaAsk">提问</button></div>' +
        '<div class="chips" id="qaEg"></div>' +
        '<div id="qaOut" class="qa-out"></div>' +
        '</div>') +
      card('可以问什么', '', '<div class="note">' +
        '<div><b>① 最新值</b>：DR007 最新是多少 / 银行间杠杆率现在多少</div>' +
        '<div><b>② 区间统计</b>：2026年9月 R001 均值 / 近20个交易日 大行净融出 最高</div>' +
        '<div><b>③ 变化对比</b>：9月 DR007 较上月变化 / 本月 10Y国债 环比</div>' +
        '<div><b>④ 季节性</b>：历史上9月 DR007 季节性 / 往年3月 存单净融资</div>' +
        '<div><b>⑤ 利差</b>：10Y国债 与 1Y AAA存单二级 利差 bp</div>' +
        '<div><b>⑥ 笔记检索</b>：9月资金面笔记 / 跨月 复盘</div>' +
        '<div><b>⑦ 数据信息</b>：数据截止 / 更新到什么时候</div>' +
        '<div style="margin-top:6px;color:var(--text-3)">全部在本机完成，不调用任何外部接口，也不会把数据外发。' +
        '问答结果由规则统计生成，仅供参考。</div></div>') +
      '</div>';
    h += '<div class="sect-title">历史提问</div>' +
      card('最近 20 条', '', '<div id="qaHist" class="qa-hist"></div>');
    setTimeout(function () {
      var inp = $('#qaInput'), btn = $('#qaAsk'), out = $('#qaOut'), eg = $('#qaEg'), hist = $('#qaHist');
      function renderHist() {
        if (!hist) return;
        hist.innerHTML = QA_HIST.length ? QA_HIST.slice(0, 20).map(function (x) {
          return '<div class="qa-h"><span class="nt-date">' + esc(x.t) + '</span> <span class="qa-q">' + esc(x.q) + '</span></div>';
        }).join('') : '<div class="empty">还没有提问</div>';
      }
      function ask(q) {
        if (!out) return;
        var r = qaAnswer(q);
        out.innerHTML = '<div class="qa-qline">问：' + esc(q) + '</div>' + (r.html || '');
        if (r.chart) {
          var host = $('#qaChart');
          if (host) {
            setTimeout(function () {
              Charts.render(host, {
                labels: r.chart.labels, series: [{ name: r.chart.name, data: r.chart.values, axis: 0, dec: r.chart.dec, width: 2 }],
                y0: { dec: r.chart.dec }, height: 196, showLegend: false,
                toolFmt: function (v) { return fmt(v, r.chart.dec) + (r.chart.unit || ''); }
              });
            }, 0);
          }
        }
        QA_HIST.unshift({ q: q, t: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
        try { localStorage.setItem('mmb_qa_hist', JSON.stringify(QA_HIST.slice(0, 50))); } catch (e) { }
        renderHist();
      }
      if (eg) {
        eg.innerHTML = QA_EXAMPLES.map(function (x) { return '<span class="chip">' + esc(x) + '</span>'; }).join('');
        $$('.chip', eg).forEach(function (c) {
          c.onclick = function () { if (inp) { inp.value = c.textContent; ask(c.textContent); } };
        });
      }
      if (btn) btn.onclick = function () { var q = inp ? inp.value.trim() : ''; if (q) ask(q); };
      if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && btn) btn.click(); });
      try {
        var sv = localStorage.getItem('mmb_qa_hist');
        if (sv) QA_HIST = JSON.parse(sv) || [];
      } catch (e) { }
      renderHist();
      if (out) out.innerHTML = '<div class="empty">输入问题后回车，或点击上方示例</div>';
    }, 0);
    return h;
  }

  /* ================================================== 路由 */
  var PAGES = {
    overview: { t: '总览', f: pOverview },
    calendar: { t: '流动性日历', f: pCalendar },
    pbc: { t: '央行操作与官媒', f: pPbc },
    funding: { t: '资金：量价·机构·杠杆率', f: pFunding },
    ncd: { t: '存单：一级与二级', f: pNcd1 },
    ncd2: { t: '存单二级：AAA 分期限', f: pNcd2 },
    bill: { t: '票据：转贴利率·净买入', f: pBill },
    bond: { t: '债券：久期·换手率·利差', f: pBond },
    deriv: { t: '衍生品：IRS·隐含预期', f: pDeriv },
    calc: { t: '人工试算', f: pCalc },
    qa: { t: '智能问答', f: pQa },
    draft: { t: '数据底稿', f: pDraft },
    source: { t: '数据源与设置', f: pSource }
  };
  function render() {
    var p = PAGES[S.page];
    $('#pageTitle').textContent = p.t;
    $('#content').innerHTML = p.f();
    $('#content').scrollTop = 0;
  }

  /* ================================================== 启动 */
  function toast(msg, err) {
    var t = $('#toast');
    t.textContent = msg; t.className = 'toast on' + (err ? ' err' : '');
    setTimeout(function () { t.className = 'toast'; }, 3200);
  }

  async function boot() {
    // 主题
    var th = localStorage.getItem('mmb_theme');
    if (th) setTheme(th);
    // 导航
    $$('#nav .nav-item').forEach(function (it) {
      it.onclick = function () {
        $$('#nav .nav-item').forEach(function (x) { x.classList.remove('on'); });
        it.classList.add('on'); S.page = it.dataset.p; render();
      };
    });
    $('#themeSeg').onclick = function (e) {
      if (e.target.dataset.t) setTheme(e.target.dataset.t);
    };
    // 上传
    $('#btnUpload').onclick = function () { $('#upMask').classList.add('on'); };
    $('#upClose').onclick = function () { $('#upMask').classList.remove('on'); };
    $('#srcClose').onclick = function () { $('#srcMask').classList.remove('on'); };
    setupUpload();
    $('#btnRefresh').onclick = async function () {
      // 单文件 / 公网快照版没有本地服务，直接给出明确说明，避免报“未连接”
      if (window.__MMB_BUNDLE__ || location.protocol === 'file:') {
        toast('当前为离线快照版（数据已内嵌），实时取数请用本机服务版：start.bat → http://127.0.0.1:8765', true);
        return;
      }
      toast('正在尝试从 Wind / 森浦 取数…');
      try {
        var r = await fetch('/api/live/refresh', { method: 'POST' });
        if (!r.ok) { toast('实时取数失败：服务返回 HTTP ' + r.status + '，请用 start.bat 启动本机服务后重试', true); return; }
        var j = null;
        try { j = await r.json(); } catch (e2) { toast('实时取数失败：服务返回内容不是 JSON（HTTP ' + r.status + '）', true); return; }
        toast(j && j.msg ? j.msg : '刷新完成', !(j && j.ok));
        await loadLive(); render();
      } catch (e) { toast('未连接本地服务，请以 start.bat 启动后使用实时取数', true); }
    };

    // 数据：优先内嵌（单文件离线版），其次本地文件，最后 /api
    if (window.__MMB_BUNDLE__) {
      S.bundle = window.__MMB_BUNDLE__;
    } else {
      var tries = [], got = null;
      for (var u of ['data/bundle.json', '/api/bundle']) {
        try {
          var r = await fetch(u);
          var j = await r.json();
          if (j && j.datasets) { got = j; break; }
          tries.push(u + ' → HTTP ' + r.status + '，返回无 datasets 字段' + (j && j.error ? '（' + j.error + '）' : ''));
        } catch (e3) {
          tries.push(u + ' → ' + (e3.message || e3));
        }
      }
      if (!got) {
        $('#content').innerHTML = '<div class="empty" style="text-align:left;line-height:1.9">' +
          '<b>未能加载数据包 bundle.json</b><br>已尝试：<br>' +
          tries.map(function (t) { return '· ' + esc(t); }).join('<br>') +
          '<br><br>处理：在 <code>workbench/</code> 下运行 <code>python extract.py</code> 重新生成，' +
          '或用 <b>start.bat</b> 重启本地服务后访问 http://127.0.0.1:8765</div>';
        return;
      }
      S.bundle = got;
    }
    await loadLive();
    $('#asOf').textContent = '数据截止 ' + (S.bundle.meta.latest_date || '—');
    $('#footAsOf').textContent = '底稿：' + (S.bundle.meta.latest_date || '—');
    render();
    // 内嵌数据场景（单文件）隐藏刷新
    if (location.protocol === 'file:') {
      $('#btnRefresh').onclick = function () { toast('单文件离线版不支持实时取数，请用 start.bat 启动服务版', true); };
    }
  }
  async function loadLive() {
    if (window.__MMB_LIVE__) {
      S.live = window.__MMB_LIVE__;
    } else {
      try {
        var r = await fetch('data/live.json?t=' + Date.now());
        if (r.ok) S.live = await r.json();
      } catch (e) { }
    }
    var st = (S.live && S.live.status) || {};
    setDot('#dotQeubee', st.qeubee); setDot('#dotWind', st.wind);
    // 交易笔记留档：本地服务版从 data/notes.json 合并（离线快照版只存本机浏览器）
    if (!window.__MMB_BUNDLE__) {
      try {
        var rn = await fetch('data/notes.json?t=' + Date.now());
        if (rn.ok) {
          var jn = await rn.json();
          notesMergeServer(jn && jn.notes ? jn.notes : jn);
        }
      } catch (e) { }
    }
  }
  function setDot(sel, s) {
    var e = $(sel); if (!e) return;
    e.className = 'src-dot ' + (s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : 'off');
    var t = e.textContent.replace(/[●]/g, '').trim();
    e.innerHTML = '<i></i>' + t + (s === 'ok' ? ' ·实时' : s === 'warn' ? ' ·部分' : ' ·未连');
  }
  function setTheme(t) {
    S.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('mmb_theme', t);
    $$('#themeSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.t === t); });
    if (S.bundle) render();
  }
  function setupUpload() {
    var drop = $('#drop'), log = $('#upLog');
    var input = document.createElement('input');
    input.type = 'file'; input.accept = '.xlsx'; input.multiple = true;
    input.onchange = function () { upload(input.files); };
    drop.onclick = function () { input.click(); };
    drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = function () { drop.classList.remove('over'); };
    drop.ondrop = function (e) {
      e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files);
    };
    async function upload(files) {
      if (!files || !files.length) return;
      if (window.__MMB_BUNDLE__ || location.protocol === 'file:') {
        log.innerHTML = '<span class="no">当前为离线快照版（数据已内嵌），上传更新需用本机服务版：' +
          '运行 <code>start.bat</code> 后访问 http://127.0.0.1:8765</span>';
        return;
      }
      log.innerHTML = '正在上传解析…';
      try {
        var okAny = false;
        for (var i = 0; i < files.length; i++) {
          var fd = new FormData();
          fd.append('file', files[i]);
          var r = await fetch('/api/upload', { method: 'POST', body: fd });
          var j = null;
          if (!r.ok) {
            log.innerHTML += '<div><span class="no">✗</span> ' + esc(files[i].name) +
              '：服务返回 HTTP ' + r.status + '（请用 start.bat 启动本机服务后重试）</div>';
            continue;
          }
          try { j = await r.json(); } catch (e2) {
            log.innerHTML += '<div><span class="no">✗</span> ' + esc(files[i].name) + '：服务返回内容不是 JSON</div>';
            continue;
          }
          if (j && j.ok) okAny = true;
          log.innerHTML += '<div>' + (j && j.ok ? '<span class="ok">✓</span> ' : '<span class="no">✗</span> ') +
            esc(files[i].name) + '：' + esc((j && j.msg) || '无返回信息') + '</div>';
        }
        if (!okAny) { toast('上传未成功，详见弹窗日志', true); return; }
        var rb = await fetch('data/bundle.json?t=' + Date.now());
        if (!rb.ok) { toast('底稿已解析，但重新读取 bundle.json 失败（HTTP ' + rb.status + '）', true); return; }
        S.bundle = await rb.json();
        render(); toast('底稿已更新');
      } catch (e) {
        log.innerHTML = '<span class="no">未连接本地服务，请运行 start.bat 后再上传（' + esc(e.message || e) + '）</span>';
      }
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
  window.__mmb = S;
  // 供自动化验证 / 调试使用（不影响业务逻辑）
  S.notes = {
    add: noteAdd, del: noteDel, all: notesRaw, byDate: notesByDate,
    search: notesSearch, dots: noteDots, merge: notesMergeServer
  };
  S.qa = { answer: qaAnswer, metrics: qaRegistry, period: qaPeriod, series: qaSeries, stats: qaStats };
})();
