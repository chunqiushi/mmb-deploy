/* 离线 SVG 图表引擎 —— 不依赖任何外部 CDN，纯本地渲染
 * 支持：多序列折线、柱线组合、双 Y 轴、事件竖线标注、十字光标 Tooltip
 */
(function (global) {
  'use strict';

  var PALETTE = ['#4f9cf9', '#f2637b', '#5ec8a8', '#f0b13b', '#9b7bf0',
    '#4dc9de', '#e8734d', '#8bc34a', '#c58de8', '#7f93b5', '#d98c5f', '#63b3f2'];
  var YEAR_COLORS = {
    2026: '#f2637b', 2025: '#4f9cf9', 2024: '#5ec8a8', 2023: '#f0b13b',
    2022: '#9b7bf0', 2021: '#4dc9de', 2020: '#e8734d', 2019: '#8bc34a', 2018: '#7f93b5'
  };

  function css(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function theme() {
    return {
      text: css('--chart-text', '#8b93a7'),
      grid: css('--chart-grid', 'rgba(128,140,170,.16)'),
      axis: css('--chart-axis', 'rgba(128,140,170,.4)'),
      bg: css('--chart-bg', 'transparent')
    };
  }
  function fmt(v, dec) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    var n = Number(v);
    if (dec !== undefined) return n.toFixed(dec);
    if (Math.abs(n) >= 10000) return (n / 10000).toFixed(2) + '万';
    if (Math.abs(n) >= 100) return n.toFixed(1);
    if (Math.abs(n) >= 1) return n.toFixed(2);
    return n.toFixed(3);
  }
  function niceStep(range, target) {
    if (!isFinite(range) || range <= 0) return 1;
    var raw = range / target, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), norm = raw / mag;
    var step = norm >= 7 ? 10 : norm >= 3 ? 5 : norm >= 1.5 ? 2 : 1;
    return step * mag;
  }
  function ticks(min, max, count) {
    if (!isFinite(min) || !isFinite(max)) return [0];
    if (min === max) { min -= 1; max += 1; }
    var step = niceStep(max - min, count || 5), lo = Math.floor(min / step) * step, out = [];
    for (var v = lo; v <= max + step * 0.5; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }
  function el(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* ---------------------------------------------------------------- 主渲染 */
  /**
   * cfg = {
   *   labels:[],            x 轴刻度（字符串）
   *   xKind:'month'|'date'|'cat',
   *   series:[{name,data,type:'line'|'bar',axis:0|1,color,dash,width}],
   *   y0:{title,unit,dec,min,max}, y1:{...},
   *   markers:[{x:index,label,color,title}],
   *   dots:[{x:index,y:value|null,color,r,title,tip,id}],   // 可点击圆点（如交易笔记锚点）
   *   onDot(fn),                                            // 圆点点击回调，收到 dot 对象
   *   height, showLegend, toolFmt(fn), stackBars:bool
   * }
   */
  function render(host, cfg) {
    host.innerHTML = '';
    var T = theme();
    var W = Math.max(host.clientWidth || 720, 320);
    var H = cfg.height || 300;
    var pad = { t: 26, r: cfg.y1 ? 54 : 16, b: cfg.xKind === 'month' ? 30 : 34, l: 56 };
    var labels = cfg.labels || [];
    var n = labels.length;
    if (!n) { host.innerHTML = '<div class="empty">暂无数据</div>'; return null; }

    var svg = el('svg', { width: '100%', height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'chart-svg' });
    var iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

    // ---- 数值范围
    function range(axis) {
      var mn = Infinity, mx = -Infinity, any = false;
      cfg.series.forEach(function (s) {
        if (s.hidden || (s.axis || 0) !== axis) return;
        (s.data || []).forEach(function (v) {
          if (v === null || v === undefined || isNaN(v)) return;
          any = true; if (v < mn) mn = v; if (v > mx) mx = v;
        });
      });
      if (!any) return null;
      if (mn === mx) { mn -= Math.abs(mn) * 0.1 + 0.5; mx += Math.abs(mx) * 0.1 + 0.5; }
      var pad2 = (mx - mn) * 0.08;
      return [mn - pad2, mx + pad2];
    }
    var r0 = range(0), r1 = cfg.y1 ? range(1) : null;
    if (!r0) { host.innerHTML = '<div class="empty">该区间无可绘制数据</div>'; return null; }
    var c0 = cfg.y0 || {}, c1 = cfg.y1 || {};
    if (c0.min !== undefined) r0[0] = Math.min(r0[0], c0.min);
    if (c0.max !== undefined) r0[1] = Math.max(r0[1], c0.max);
    if (c0.zeroBar) r0 = [Math.min(0, r0[0]), r0[1]];

    var t0 = r0 ? ticks(r0[0], r0[1], 5) : [];
    var t1 = r1 ? ticks(r1[0], r1[1], 5) : [];

    function yScale(v, axis) {
      var r = axis === 1 ? r1 : r0;
      if (!r) return pad.t + ih / 2;
      return pad.t + ih - (v - r[0]) / (r[1] - r[0]) * ih;
    }
    function xc(i) { return n === 1 ? pad.l + iw / 2 : pad.l + iw * (i / (n - 1)); }
    var bandW = n ? iw / n : 0;

    // ---- 网格
    t0.forEach(function (v) {
      var y = yScale(v, 0);
      svg.appendChild(el('line', { x1: pad.l, x2: pad.l + iw, y1: y, y2: y, stroke: T.grid, 'stroke-width': 1 }));
      var tx = el('text', { x: pad.l - 8, y: y + 4, 'text-anchor': 'end', class: 'ax-label' });
      tx.textContent = fmt(v, c0.dec); tx.setAttribute('fill', T.text);
      svg.appendChild(tx);
    });
    if (r1) t1.forEach(function (v) {
      var y = yScale(v, 1);
      var tx = el('text', { x: pad.l + iw + 8, y: y + 4, class: 'ax-label' });
      tx.textContent = fmt(v, c1.dec); tx.setAttribute('fill', T.text);
      svg.appendChild(tx);
    });
    svg.appendChild(el('line', { x1: pad.l, x2: pad.l + iw, y1: pad.t + ih, y2: pad.t + ih, stroke: T.axis }));

    // ---- 月分区 / 税期 / 月末 高亮（日度季节性图，背景层）
    if (cfg.monthBands && cfg.monthBands.length) {
      cfg.monthBands.forEach(function (b, mi) {
        var x0 = xc(b.i0), x1 = xc(b.i1);
        svg.appendChild(el('rect', { x: x0, y: pad.t, width: Math.max(1, x1 - x0), height: ih, fill: (mi % 2 ? 'rgba(128,140,170,.05)' : 'rgba(128,140,170,.10)'), 'pointer-events': 'none' }));
      });
      (cfg.taxSpans || []).forEach(function (b) {
        var x0 = xc(b.i0), x1 = xc(b.i1);
        svg.appendChild(el('rect', { x: x0, y: pad.t, width: Math.max(1, x1 - x0), height: ih, fill: 'rgba(242,99,123,.16)', 'pointer-events': 'none' }));
      });
      (cfg.monthEndSpans || []).forEach(function (b) {
        var x0 = xc(b.i0), x1 = xc(b.i1);
        svg.appendChild(el('rect', { x: x0, y: pad.t, width: Math.max(1, x1 - x0), height: ih, fill: 'rgba(240,177,59,.20)', 'pointer-events': 'none' }));
      });
      if (cfg.selectedMonth !== null && cfg.selectedMonth !== undefined && cfg.monthBands[cfg.selectedMonth]) {
        var sb = cfg.monthBands[cfg.selectedMonth];
        svg.appendChild(el('rect', { x: xc(sb.i0), y: pad.t, width: Math.max(1, xc(sb.i1) - xc(sb.i0)), height: ih, fill: 'none', stroke: '#f2637b', 'stroke-width': 1.8, 'pointer-events': 'none' }));
      }
    }

    // ---- X 轴标签
    if (cfg.xTicks && cfg.xTicks.length) {
      // 自定义刻度位置（如日度季节性图的“1月1日/2月1日/...”）
      cfg.xTicks.forEach(function (tk) {
        var ti = Math.max(0, Math.min(n - 1, tk.i));
        var ttx = el('text', { x: xc(ti), y: pad.t + ih + 16, 'text-anchor': 'middle', class: 'ax-label' });
        ttx.textContent = tk.label; ttx.setAttribute('fill', T.text);
        svg.appendChild(ttx);
      });
    } else {
      var maxLab = Math.max(2, Math.floor(iw / 62));
      var stepL = Math.ceil(n / maxLab);
      for (var i = 0; i < n; i += stepL) {
        var lb = labels[i];
        if (lb === '' || lb === null || lb === undefined) continue;
        var tx2 = el('text', { x: xc(i), y: pad.t + ih + 16, 'text-anchor': 'middle', class: 'ax-label' });
        tx2.textContent = lb; tx2.setAttribute('fill', T.text);
        svg.appendChild(tx2);
      }
    }

    // ---- 事件竖线
    (cfg.markers || []).forEach(function (m) {
      var x = xc(Math.max(0, Math.min(n - 1, m.x)));
      svg.appendChild(el('line', {
        x1: x, x2: x, y1: pad.t, y2: pad.t + ih,
        stroke: m.color || '#f2637b', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: .55
      }));
      if (m.label) {
        var t = el('text', { x: x + 3, y: pad.t + 10, class: 'mk-label' });
        t.textContent = m.label; t.setAttribute('fill', m.color || '#f2637b');
        svg.appendChild(t);
      }
    });

    // ---- 柱（先画）
    var stacks = {};
    cfg.series.forEach(function (s, si) {
      if (s.hidden || s.type !== 'bar') return;
      var ax = s.axis || 0, col = s.color || PALETTE[si % PALETTE.length];
      var zero = yScale(Math.max(r0[0], Math.min(0, r0[1])), 0);
      for (var i = 0; i < n; i++) {
        var v = s.data[i];
        if (v === null || v === undefined || isNaN(v)) continue;
        var bw = Math.max(2, bandW * 0.62), base = yScale(v, ax);
        var yTop = cfg.stackBars ? base : Math.min(base, zero);
        var hh = Math.abs(base - zero);
        if (hh < 0.6) hh = 0.6;
        svg.appendChild(el('rect', {
          x: xc(i) - bw / 2, y: yTop, width: bw, height: hh,
          fill: col, opacity: .78, rx: 2
        }));
      }
      stacks[si] = 1;
    });

    // ---- 线
    var lineEls = [];
    cfg.series.forEach(function (s, si) {
      if (s.hidden || s.type === 'bar') return;
      var ax = s.axis || 0, col = s.color || PALETTE[si % PALETTE.length];
      var pts = [], seg = [];
      for (var i = 0; i < n; i++) {
        var v = s.data[i];
        if (v === null || v === undefined || isNaN(v)) { if (seg.length) { pts.push(seg); seg = []; } continue; }
        seg.push([xc(i), yScale(v, ax)]);
      }
      if (seg.length) pts.push(seg);
      pts.forEach(function (p) {
        if (p.length < 2 && pts.length > 1) return;
        var dstr = p.map(function (q, k) { return (k ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join(' ');
        svg.appendChild(el('path', {
          d: dstr, fill: 'none', stroke: col,
          'stroke-width': s.width || 1.9,
          'stroke-dasharray': s.dash || null,
          'stroke-linejoin': 'round', 'stroke-linecap': 'round'
        }));
      });
      lineEls.push(s);
    });

    // ---- 图例
    var legend = document.createElement('div');
    legend.className = 'chart-legend';
    if (cfg.showLegend !== false) {
      cfg.series.forEach(function (s, si) {
        var col = s.color || PALETTE[si % PALETTE.length];
        var it = document.createElement('span');
        it.className = 'lg-item' + (s.hidden ? ' off' : '');
        it.innerHTML = '<i style="background:' + col + '"></i>' + s.name;
        it.onclick = function () { s.hidden = !s.hidden; render(host, cfg); };
        legend.appendChild(it);
      });
    }

    // ---- 悬浮提示
    var tip = document.createElement('div'); tip.className = 'chart-tip'; tip.style.display = 'none';
    var cross = el('line', { y1: pad.t, y2: pad.t + ih, stroke: T.axis, 'stroke-dasharray': '2 3', opacity: 0 });
    svg.appendChild(cross);
    var overlay = el('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent' });
    svg.appendChild(overlay);
    overlay.addEventListener('mousemove', function (ev) {
      var rect = svg.getBoundingClientRect();
      var px = (ev.clientX - rect.left) / rect.width * W;
      var idx = Math.round((px - pad.l) / (iw / Math.max(1, n - 1)));
      idx = Math.max(0, Math.min(n - 1, idx));
      cross.setAttribute('x1', xc(idx)); cross.setAttribute('x2', xc(idx)); cross.setAttribute('opacity', 1);
      var rows = cfg.series.filter(function (s) { return !s.hidden; }).map(function (s, k) {
        var v = s.data[idx];
        var txt = (v === null || v === undefined || isNaN(v)) ? '-' : (cfg.toolFmt ? cfg.toolFmt(v, s) : fmt(v, s.dec));
        return '<div class="tr"><i style="background:' + (s.color || PALETTE[cfg.series.indexOf(s) % PALETTE.length]) + '"></i>' +
          '<span>' + s.name + '</span><b>' + txt + '</b></div>';
      }).join('');
      tip.innerHTML = '<div class="tt">' + labels[idx] + '</div>' + rows;
      tip.style.display = 'block';
      var hr = host.getBoundingClientRect();
      var lx = ev.clientX - hr.left + 14;
      if (lx + 190 > hr.width) lx = ev.clientX - hr.left - 190;
      tip.style.left = lx + 'px';
      tip.style.top = Math.max(6, ev.clientY - hr.top - 20) + 'px';
    });
    overlay.addEventListener('mouseleave', function () { tip.style.display = 'none'; cross.setAttribute('opacity', 0); });
    overlay.addEventListener('click', function (ev) {
      if (!cfg.onPick || !cfg.monthBands || !cfg.monthBands.length) return;
      var rect = svg.getBoundingClientRect();
      var px = (ev.clientX - rect.left) / rect.width * W;
      var idx = Math.round((px - pad.l) / (iw / Math.max(1, n - 1)));
      idx = Math.max(0, Math.min(n - 1, idx));
      var mon = 0;
      for (var mm = 0; mm < cfg.monthBands.length; mm++) { if (idx >= cfg.monthBands[mm].i0) mon = mm; }
      try { cfg.onPick(mon); } catch (e) { }
    });
    overlay.style.cursor = (cfg.onPick && cfg.monthBands) ? 'pointer' : 'default';

    // ---- 可点击圆点（交易笔记锚点等）：画在 overlay 之上，便于点击/悬浮
    if (cfg.dots && cfg.dots.length) {
      cfg.dots.forEach(function (d) {
        var xi = Math.max(0, Math.min(n - 1, d.x));
        var cx = xc(xi);
        var cy = (d.y === null || d.y === undefined || isNaN(d.y))
          ? pad.t + 9 : yScale(d.y, 0);
        cy = Math.max(pad.t + 6, Math.min(pad.t + ih - 5, cy));
        var c = el('circle', {
          cx: cx, cy: cy, r: d.r || 4.2, fill: d.color || '#f0b13b',
          stroke: T.bg === 'transparent' ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.85)',
          'stroke-width': 1.2, opacity: .96, style: 'cursor:pointer'
        });
        if (d.title) { var ttl = el('title'); ttl.textContent = d.title; c.appendChild(ttl); }
        c.addEventListener('mouseenter', function () {
          tip.innerHTML = '<div class="tt">' + (labels[xi] || '') + '</div>' +
            '<div class="tr"><span style="white-space:normal">' + (d.tip || d.title || '') + '</span></div>';
          tip.style.display = 'block';
          var hr2 = host.getBoundingClientRect();
          var lx2 = (cx / W) * hr2.width + 12;
          if (lx2 + 220 > hr2.width) lx2 = Math.max(4, lx2 - 230);
          tip.style.left = lx2 + 'px';
          tip.style.top = Math.max(4, (cy / H) * (hr2.height || H) - 14) + 'px';
        });
        c.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
        c.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (cfg.onDot) { try { cfg.onDot(d); } catch (e2) { } }
        });
        svg.appendChild(c);
      });
    }

    var wrap = document.createElement('div');
    wrap.className = 'chart-wrap';
    wrap.appendChild(svg);
    wrap.appendChild(tip);
    host.appendChild(wrap);
    if (cfg.showLegend !== false) host.appendChild(legend);
    return host;
  }

  /* ------------------------------------------------- 季节性图：每年一条线 */
  /**
   * data: {years:[2020..2026], byYear:{year:[v1..v12]}, avg:[12], cur:[12]}
   */
  function seasonal(host, cfg) {
    var years = cfg.years.slice().sort();
    var latest = years[years.length - 1];
    var series = [];
    years.forEach(function (y) {
      if (y === latest && !cfg.showLatest) return;
      var isCur = (y === latest);
      series.push({
        name: y + '年', data: cfg.byYear[y] || [], axis: 0,
        color: isCur ? '#f2637b' : (YEAR_COLORS[y] || null),
        width: isCur ? 2.6 : 1.5,
        hidden: cfg.onlyRecent ? (y < latest - 4) : false,
        dec: cfg.dec
      });
    });
    if (cfg.avg) series.push({ name: '5年均值', data: cfg.avg, axis: 0, color: '#8b93a7', dash: '5 4', width: 1.6, dec: cfg.dec });
    return render(host, {
      labels: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
      xKind: 'month', series: series,
      y0: { dec: cfg.dec }, height: cfg.height || 320, toolFmt: cfg.toolFmt
    });
  }

  /* ------------------------------------------------- 热力表：年 × 月 */
  function matrix(host, cfg) {
    var years = cfg.years.slice().sort();
    var months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    var vals = [];
    years.forEach(function (y) { (cfg.byYear[y] || []).forEach(function (v) { if (v !== null && !isNaN(v)) vals.push(v); }); });
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    var h = '<table class="mx"><thead><tr><th></th>' + months.map(function (m) { return '<th>' + m + '</th>'; }).join('') + '</tr></thead><tbody>';
    years.forEach(function (y, yi) {
      h += '<tr><th>' + y + '</th>';
      for (var m = 0; m < 12; m++) {
        var v = (cfg.byYear[y] || [])[m];
        if (v === null || v === undefined || isNaN(v)) { h += '<td class="na">-</td>'; continue; }
        var t = (mx - mn) ? (v - mn) / (mx - mn) : 0.5;
        h += '<td class="cell" style="' + heatStyle(t, cfg.invert) + '" title="' + y + '年' + months[m] + '：' + fmt(v, cfg.dec) + (cfg.unit || '') + '">' +
          '<span>' + fmt(v, cfg.dec) + '</span></td>';
      }
      h += '</tr>';
    });
    h += '</tbody></table>';
    host.innerHTML = h;
  }
  function heatStyle(t, invert) {
    var c1 = [38, 90, 168], c2 = [232, 92, 106];  // 蓝→红
    if (invert) { c1 = [232, 92, 106]; c2 = [38, 90, 168]; }
    var r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
    var g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
    var b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
    return 'background:rgba(' + r + ',' + g + ',' + b + ',' + (0.14 + 0.62 * t).toFixed(2) + ')';
  }

  global.Charts = { render: render, seasonal: seasonal, matrix: matrix, PALETTE: PALETTE, YEAR_COLORS: YEAR_COLORS, fmt: fmt };
})(window);
