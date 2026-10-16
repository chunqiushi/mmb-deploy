/* 人工试算引擎 —— 全部在浏览器本地计算，不联网 */
(function (global) {
  'use strict';

  function n(v, d) { var x = parseFloat(v); return isNaN(x) ? (d === undefined ? 0 : d) : x; }
  function f4(v) { return (Math.round(v * 10000) / 10000).toFixed(4); }
  function f2(v) { return (Math.round(v * 100) / 100).toFixed(2); }
  function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }

  /* ---------------------------------------------------- 债券基础计算 */
  function bondMath(face, couponPct, freq, years, ytmPct) {
    face = n(face, 100); freq = Math.max(1, n(freq, 1)); years = n(years, 1); ytmPct = n(ytmPct);
    var y = ytmPct / 100 / freq;
    if (y <= -1) y = -0.99;
    var per = Math.max(1, Math.ceil(years * freq - 1e-9));
    var cpn = face * couponPct / 100 / freq;
    var cf = [], price = 0, wsum = 0, csum = 0;
    for (var i = 1; i <= per; i++) {
      var t = years - (per - i) / freq;
      var c = cpn + (i === per ? face : 0);
      var pv = c / Math.pow(1 + y, t * freq);
      cf.push({ t: t, cf: c, pv: pv });
      price += pv; wsum += t * pv; csum += t * t * pv;
    }
    var dur = price ? wsum / price : 0;
    var mdur = dur / (1 + y);
    var conv = price ? (csum / price) / Math.pow(1 + y, 2) : 0;
    return { price: price, dur: dur, mdur: mdur, conv: conv, dv01: price * mdur * 0.0001, cf: cf };
  }

  function ytmFromPrice(face, couponPct, freq, years, price) {
    var lo = -0.02, hi = 0.6, mid = 0;
    for (var k = 0; k < 160; k++) {
      mid = (lo + hi) / 2;
      var p = bondMath(face, couponPct, freq, years, mid * 100).price;
      if (p > price) lo = mid; else hi = mid;
    }
    return mid * 100;
  }

  function accrued(face, couponPct, freq, days, periodDays) {
    var f = Math.max(1, n(freq, 1));
    return face * couponPct / 100 / f * (n(days) / Math.max(1, n(periodDays, 365 / f)));
  }

  var panels = [];

  /* 1 债券定价 */
  panels.push({
    id: 'bond', title: '债券定价与风险指标', icon: '∑',
    desc: '输入票面与收益率求净价/全价/久期/凸性/DV01；或填净价反算到期收益率。',
    fields: [
      { k: 'face', label: '面值', def: 100 },
      { k: 'cpn', label: '票面利率 %', def: 1.68 },
      { k: 'freq', label: '年付息次数', def: 1 },
      { k: 'yrs', label: '剩余期限（年）', def: 9.85 },
      { k: 'ytm', label: '到期收益率 %（正算）', def: 1.6822 },
      { k: 'px', label: '净价（填则反算YTM）', def: '' },
      { k: 'accD', label: '应计天数', def: 0 },
      { k: 'accP', label: '付息周期天数', def: 365 }
    ],
    out: function (v) {
      var ytm = (n(v.px) > 0) ? ytmFromPrice(v.face, v.cpn, v.freq, v.yrs, n(v.px)) : n(v.ytm);
      var b = bondMath(v.face, v.cpn, v.freq, v.yrs, ytm);
      var ai = accrued(v.face, v.cpn, v.freq, v.accD, v.accP);
      return [
        { k: '到期收益率', v: f4(ytm) + ' %' },
        { k: '净价', v: f2(b.price) + ' 元' },
        { k: '应计利息', v: f2(ai) + ' 元' },
        { k: '全价', v: f2(b.price + ai) + ' 元' },
        { k: '麦考利久期', v: f4(b.dur) + ' 年' },
        { k: '修正久期', v: f4(b.mdur) + ' 年' },
        { k: '凸性', v: f2(b.conv) },
        { k: 'DV01（每百面值·每bp）', v: (b.dv01 * 10000).toFixed(4) + ' 元' }
      ];
    },
    table: function (v) {
      var ytm = (n(v.px) > 0) ? ytmFromPrice(v.face, v.cpn, v.freq, v.yrs, n(v.px)) : n(v.ytm);
      var b = bondMath(v.face, v.cpn, v.freq, v.yrs, ytm);
      var h = '<div class="tb-wrap"><table class="tb"><thead><tr><th>期次</th><th>时间(年)</th><th>现金流</th><th>现值</th></tr></thead><tbody>';
      b.cf.forEach(function (c, i) {
        h += '<tr><td>' + (i + 1) + '</td><td>' + f4(c.t) + '</td><td>' + f2(c.cf) + '</td><td>' + f2(c.pv) + '</td></tr>';
      });
      return h + '</tbody></table></div>';
    }
  });

  /* 2 情景损益 */
  panels.push({
    id: 'scen', title: '收益率情景与损益', icon: '∑',
    desc: '给定持仓面额与修正久期，测算不同收益率变动下的市值损益（含凸性二阶修正）。',
    fields: [
      { k: 'amt', label: '持仓面额（万元）', def: 10000 },
      { k: 'px', label: '净价', def: 100 },
      { k: 'mdur', label: '修正久期（年）', def: 5.4 },
      { k: 'conv', label: '凸性', def: 38 },
      { k: 'steps', label: '情景 bp（逗号分隔）', def: '-50,-25,-10,-5,0,5,10,25,50' }
    ],
    out: function (v) {
      var mv = n(v.amt) * 10000 * n(v.px) / 100, d = n(v.mdur), c = n(v.conv), out = [];
      v.steps.split(/[,，]/).map(function (s) { return n(s.trim()); }).forEach(function (bp) {
        if (isNaN(bp)) return;
        var dy = bp / 10000;
        var pct = (-d * dy + 0.5 * c * dy * dy) * 100;
        var pnl = mv * pct / 100;
        out.push({ k: (bp > 0 ? '+' : '') + bp + ' bp', v: pct.toFixed(3) + '% ／ ' + Math.round(pnl / 10000).toLocaleString() + ' 万元', cls: pct >= 0 ? 'up' : 'down' });
      });
      return out;
    }
  });

  /* 3 杠杆套息 */
  panels.push({
    id: 'carry', title: '杠杆套息测算', icon: '∑',
    desc: '以回购融资加杠杆买入资产，测算扣融资成本后的持有期损益与盈亏平衡收益率。',
    fields: [
      { k: 'ra', label: '资产收益率 %', def: 1.70 },
      { k: 'rf', label: '回购融资成本 %', def: 1.35 },
      { k: 'lev', label: '杠杆倍数（总资产/自有资金）', def: 1.50 },
      { k: 'eq', label: '自有资金（万元）', def: 10000 },
      { k: 'days', label: '持有天数', def: 30 },
      { k: 'dv', label: '预期收益率变动 bp', def: 0 },
      { k: 'mdur', label: '资产修正久期（年）', def: 5.0 }
    ],
    out: function (v) {
      var L = Math.max(1, n(v.lev, 1)), ra = n(v.ra), rf = n(v.rf), d = n(v.days), eq = n(v.eq), md = n(v.mdur), dv = n(v.dv);
      var carry = (ra - rf) / 100 * d / 365 * 100;         // 未加杠杆的套息，%
      var levCarry = carry * L;                             // 占自有资金
      var pnlPct = -md * dv / 10000 * 100 * L;              // 资本利得（占自有资金）
      var total = levCarry + pnlPct;
      var breakeven = rf + (-pnlPct / L) / (d / 365) / 100 * 1; // 简化
      var be = rf - (total - levCarry) / (d / 365) / 100;
      return [
        { k: '未加杠杆套息', v: f4(carry) + ' %' },
        { k: '加杠杆后套息（占自有）', v: f4(levCarry) + ' %', cls: levCarry >= 0 ? 'up' : 'down' },
        { k: '资本利得（占自有）', v: f4(pnlPct) + ' %', cls: pnlPct >= 0 ? 'up' : 'down' },
        { k: '持有期合计', v: f4(total) + ' %', cls: total >= 0 ? 'up' : 'down' },
        { k: '年化合计', v: f4(total * 365 / Math.max(1, d)) + ' %', cls: total >= 0 ? 'up' : 'down' },
        { k: '盈亏平衡收益率', v: f4(rf + (0 - pnlPct) / L / (d / 365) / 100) + ' %' },
        { k: '损益金额', v: f2(eq * total / 100) + ' 万元', cls: total >= 0 ? 'up' : 'down' }
      ];
    }
  });

  /* 4 骑乘与曲线 */
  panels.push({
    id: 'ride', title: '骑乘收益与曲线斜率', icon: '∑',
    desc: '在收益率曲线形态不变的假设下，测算沿曲线下滑带来的骑乘收益。',
    fields: [
      { k: 'yLong', label: '长端收益率 %', def: 1.6822 },
      { k: 'yShort', label: '短端收益率 %', def: 1.2197 },
      { k: 'tLong', label: '长端期限（年）', def: 10 },
      { k: 'tShort', label: '短端期限（年）', def: 1 },
      { k: 'hold', label: '持有期（年）', def: 0.5 },
      { k: 'mdur', label: '持有期末修正久期', def: 4.8 }
    ],
    out: function (v) {
      var yl = n(v.yLong), ys = n(v.yShort), tl = n(v.tLong), ts = n(v.tShort), h = n(v.hold), md = n(v.mdur);
      var slope = (yl - ys) / Math.max(0.01, tl - ts);                 // %/年
      var slideBp = slope * h * 100;                                    // 沿曲线下滑带来的收益率下行 bp
      var ridePct = slideBp * md / 10000 * 100;                         // 资本利得 %
      var carryPct = yl * h;                                            // 票息 %
      return [
        { k: '曲线斜率', v: f1(slope * 100) + ' bp / 年' },
        { k: '持有期下滑', v: f1(slideBp) + ' bp' },
        { k: '骑乘资本利得', v: f4(ridePct) + ' %', cls: ridePct >= 0 ? 'up' : 'down' },
        { k: '票息收益', v: f4(carryPct) + ' %' },
        { k: '持有期合计', v: f4(ridePct + carryPct) + ' %', cls: (ridePct + carryPct) >= 0 ? 'up' : 'down' },
        { k: '年化', v: f4((ridePct + carryPct) / Math.max(0.01, h)) + ' %' }
      ];
    }
  });

  /* 5 利差回归 */
  panels.push({
    id: 'spread', title: '利差回归空间测算', icon: '∑',
    desc: '给定当前利差与目标利差（历史均值/分位），测算利差变动带来的相对收益。',
    fields: [
      { k: 's0', label: '当前利差 bp', def: 7.37 },
      { k: 's1', label: '目标利差 bp', def: 15.0 },
      { k: 'mdA', label: '交易腿A修正久期', def: 4.8 },
      { k: 'mdB', label: '对冲腿B修正久期', def: 5.0 },
      { k: 'amt', label: '名义面额（万元）', def: 10000 },
      { k: 'days', label: '持有天数', def: 60 }
    ],
    out: function (v) {
      var ds = (n(v.s1) - n(v.s0));        // 正=走阔
      var net = ds * (n(v.mdA) - n(v.mdB)) / 10000 * 100; // 久期中性的近似
      var gross = ds * n(v.mdA) / 10000 * 100;
      var amt = n(v.amt);
      return [
        { k: '利差变动', v: f1(ds) + ' bp' },
        { k: '单边价格影响', v: f4(gross) + ' %', cls: gross >= 0 ? 'down' : 'up' },
        { k: '久期中性净损益', v: f4(net) + ' %', cls: net >= 0 ? 'up' : 'down' },
        { k: '损益金额', v: f2(amt * net / 100) + ' 万元', cls: net >= 0 ? 'up' : 'down' },
        { k: '年化（按持有天数）', v: f4(net * 365 / Math.max(1, n(v.days))) + ' %' }
      ];
    }
  });

  /* 6 利率互换试算 */
  panels.push({
    id: 'irs', title: '利率互换（IRS）试算', icon: '∑',
    desc: '付固定收浮动（FR007）的现金流测算：给定浮动端假设，计算净成本与盈亏平衡固定利率。',
    fields: [
      { k: 'notional', label: '名义本金（万元）', def: 10000 },
      { k: 'fix', label: '固定利率 %', def: 1.43 },
      { k: 'flt', label: '浮动端假设 FR007 %', def: 1.35 },
      { k: 'yrs', label: '期限（年）', def: 1 },
      { k: 'freq', label: '重置频率（次/年）', def: 4 },
      { k: 'side', label: '方向（1=付固定收浮动，-1=收固定付浮动）', def: 1 }
    ],
    out: function (v) {
      var N = n(v.notional), fx = n(v.fix), fl = n(v.flt), T = n(v.yrs), fr = Math.max(1, n(v.freq)), sd = n(v.side) >= 0 ? 1 : -1;
      var net = sd * (fl - fx) / 100 * N;                  // 万元/年
      var total = net * T;
      return [
        { k: '每年净现金流', v: f2(net) + ' 万元', cls: net >= 0 ? 'up' : 'down' },
        { k: '全期净现金流', v: f2(total) + ' 万元', cls: total >= 0 ? 'up' : 'down' },
        { k: '每季现金流', v: f2(net / fr * (fr / 4 || 1)) + ' 万元' },
        { k: '盈亏平衡固定利率', v: f4(fl) + ' %' },
        { k: '固定-浮动基差', v: f1((fx - fl) * 100) + ' bp' }
      ];
    }
  });

  /* 7 流动性缺口 */
  panels.push({
    id: 'gap', title: '流动性缺口测算', icon: '∑',
    desc: '把未来一段时间内的资金到期、政府债缴款、存单到期与央行投放放在一起，估算缺口。',
    fields: [
      { k: 'days', label: '测算窗口（天）', def: 14 },
      { k: 'omo', label: '公开市场到期（亿元）', def: 10845 },
      { k: 'mlf', label: 'MLF/买断式到期（亿元）', def: 10000 },
      { k: 'ncd', label: '存单到期（亿元）', def: 7558 },
      { k: 'gov', label: '政府债净缴款（亿元）', def: 3220 },
      { k: 'inject', label: '预计央行投放（亿元）', def: 8000 },
      { k: 'rr', label: '当前逆回购余额（亿元）', def: 15145 }
    ],
    out: function (v) {
      var out = n(v.omo) + n(v.mlf) + n(v.ncd);
      var drain = out + n(v.gov);
      var gap = drain - n(v.inject);
      return [
        { k: '到期合计', v: f1(out).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' 亿元' },
        { k: '叠加缴款后流出', v: f1(drain).toLocaleString() + ' 亿元' },
        { k: '流动性缺口', v: f1(gap).toLocaleString() + ' 亿元', cls: gap > 0 ? 'up' : 'down' },
        { k: '缺口/逆回购余额', v: f2(gap / Math.max(1, n(v.rr)) * 100) + ' %' },
        { k: '日均缺口', v: f1(gap / Math.max(1, n(v.days))).toLocaleString() + ' 亿元/天' }
      ];
    }
  });

  /* 8 隐含加息/降息预期（IRS 反推） */
  panels.push({
    id: 'implied', title: '隐含加息／降息预期反推', icon: '∑',
    desc: '用「FR007 即期 − FR007 互换利率」反推市场对未来的政策利率路径预期。',
    fields: [
      { k: 'spot', label: 'FR007 即期 %（当前7天回购利率）', def: 1.3241 },
      { k: 's1y', label: 'FR007 1Y 互换利率 %', def: 1.43 },
      { k: 's5y', label: 'FR007 5Y 互换利率 %', def: 1.62 },
      { k: 'omo', label: '当前 7天OMO 政策利率 %', def: 1.40 }
    ],
    out: function (v) {
      var sp = n(v.spot), s1 = n(v.s1y), s5 = n(v.s5y), omo = n(v.omo);
      var e1 = (s1 - sp) * 100;      // 正=预期未来上行
      var e5 = (s5 - sp) * 100;
      var vsOmo1 = (s1 - omo) * 100;
      return [
        { k: '1年隐含变动', v: f1(e1) + ' bp', cls: e1 > 0 ? 'up' : 'down' },
        { k: '5年隐含变动', v: f1(e5) + ' bp', cls: e5 > 0 ? 'up' : 'down' },
        { k: '1年互换 vs OMO', v: f1(vsOmo1) + ' bp', cls: vsOmo1 > 0 ? 'up' : 'down' },
        { k: '1s5s 曲线斜率', v: f1((s5 - s1) * 100) + ' bp' },
        { k: '市场倾向', v: (e1 < -2 ? '定价降息' : e1 > 2 ? '定价加息' : '基本持平'), cls: e1 < -2 ? 'down' : e1 > 2 ? 'up' : 'flat' }
      ];
    }
  });

  global.Calc = { panels: panels, bondMath: bondMath, ytmFromPrice: ytmFromPrice };
})(window);
