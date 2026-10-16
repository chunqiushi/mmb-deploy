# -*- coding: utf-8 -*-
"""
取数桥接：依次尝试 Wind → 森浦 Qeubee → 本地缓存，把结果写入 data/live.json。
全部在本机完成，不向外部发送数据。

用法：
    python bridge.py            # 尝试实时取数并刷新 live.json
    python bridge.py --probe    # 只探测各数据源可用性
"""
import os, sys, json, io, time, datetime as dt, subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
CFG = os.path.join(ROOT, "config", "sources.json")

# 从项目根 .env 加载环境变量（纯标准库），与 server.py 保持一致，
# 便于在 CVM 上单独运行 bridge.py 时也能拿到森浦/Wind 凭据。
def _load_dotenv():
    p = os.path.join(ROOT, ".env")
    try:
        with io.open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass
_load_dotenv()
LIVE = os.path.join(DATA, "live.json")
TTL_HOURS = 18  # Agent/MCP 注入的缓存有效时长


def load_cfg():
    try:
        with io.open(CFG, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"wind": {"enabled": True}, "qeubee": {"enabled": True, "mode": "auto"}}


def load_live():
    try:
        with io.open(LIVE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"updated_at": "", "status": {}, "series": {}, "news": []}


# ------------------------------------------------------------------ Wind
WIND_MAP = {
    "DR001": "DR001.IBO", "DR007": "DR007.IBO",
    "R001": "R001.IBO", "R007": "R007.IBO", "R014": "R014.IBO",
    "FR007:1Y": "FR007S1Y.IR", "FR007:5Y": "FR007S5Y.IR",
}
WIND_EDB = {
    "MLF期末余额": "M5541528",
}


# ------------------------------------------------------------------ Wind Alice 云端 MCP（Node CLI，非 REST）
# Wind Alice 实为远端 MCP：本地 Node CLI（wind-mcp-skill）每次 call 通过
# https://mcp.wind.com.cn/vserver_*/mcp/ 用 WIND_API_KEY 取数。
# 云端自刷新只需：Node + wind-mcp-skill 目录 + WIND_API_KEY，无需桌面 WindPy。
WIND_ALICE_NODE = os.environ.get("WIND_ALICE_NODE", r"C:\mmb\node\node.exe")
WIND_ALICE_CLI = os.environ.get("WIND_ALICE_CLI", r"C:\mmb\wind-mcp-skill\scripts\cli.mjs")
WIND_ALICE_CWD = os.environ.get("WIND_ALICE_CWD", r"C:\mmb\wind-mcp-skill")
# 货币市场回购利率：Wind MCP 无任意 Wind 代码自由查询，用 analytics_data 自然语言取数
WIND_ALICE_NL = {
    "DR001": "DR001 银行间存款类机构质押式回购加权利率 近一年日度",
    "DR007": "DR007 银行间存款类机构质押式回购加权利率 近一年日度",
    "R001":  "R001 银行间质押式回购加权利率 近一年日度",
    "R007":  "R007 银行间质押式回购加权利率 近一年日度",
    "R014":  "R014 银行间质押式回购加权利率 近一年日度",
}


def _wind_alice_call(server_type, tool, params, timeout=180):
    """调用 wind-mcp-skill CLI（node cli.mjs call <st> <tool> <params>），
    返回解析后的 content[0].text（dict/list），失败返回 None。"""
    env = os.environ.copy()
    env["WIND_API_KEY"] = os.environ.get("WIND_API_KEY") or ""
    try:
        p = subprocess.run(
            [WIND_ALICE_NODE, WIND_ALICE_CLI, "call", server_type, tool,
             json.dumps(params, ensure_ascii=False)],
            cwd=WIND_ALICE_CWD, env=env, capture_output=True, timeout=timeout)
    except Exception as e:
        print("wind alice spawn fail:", e, file=sys.stderr); return None
    if p.returncode != 0:
        print("wind alice rc=%d %s" % (p.returncode, (p.stderr or b"").decode("utf-8", "replace")[:200]), file=sys.stderr)
        return None
    try:
        obj = json.loads(p.stdout.decode("utf-8", "replace"))
        text = obj["content"][0]["text"]
        return json.loads(text)
    except Exception as e:
        print("wind alice parse fail:", e, file=sys.stderr); return None


def _extract_rows(inner):
    """从 analytics_data 返回中取 (dates, values)；兼容 data.data=[{columns,rows}] 结构。"""
    if not isinstance(inner, dict):
        return None, None
    d = inner.get("data")
    arr = d.get("data") if isinstance(d, dict) else (d if isinstance(d, list) else None)
    if isinstance(arr, list) and arr and isinstance(arr[0], dict):
        rows = arr[0].get("rows") or []
        dates = [str(r[0])[:10] for r in rows if r]
        vals = []
        for r in rows:
            v = r[1] if len(r) > 1 else None
            vals.append(float(v) if isinstance(v, (int, float)) else None)
        if dates and any(x is not None for x in vals):
            return dates, vals
    return None, None


def wind_alice_fetch(days=400):
    """Wind Alice 云端 MCP 取数（云端自刷新，无需桌面终端）。
    凭证：WIND_API_KEY（server.py 从 .env 注入 os.environ）。
    依赖：WIND_ALICE_NODE / WIND_ALICE_CLI 指向 CVM 上的 Node + wind-mcp-skill。
    以 funding_rates 输出 Wind 可取到的回购利率（按日期并集对齐）。
    IRS 不在 Wind MCP 覆盖范围，交由 Qeubee 实时提供。
    返回 (status, {series_key: {...}}) 与 wind_fetch 同构。"""
    if not (os.environ.get("WIND_API_KEY") or "").strip():
        return "off", {}
    if not (os.path.exists(WIND_ALICE_NODE) and os.path.exists(WIND_ALICE_CLI)):
        print("wind alice: node/cli 缺失 (%s / %s)" % (WIND_ALICE_NODE, WIND_ALICE_CLI), file=sys.stderr)
        return "off", {}
    per, alldates = {}, set()
    for key, q in WIND_ALICE_NL.items():
        inner = _wind_alice_call("analytics_data", "get_financial_data", {"question": q})
        dates, vals = _extract_rows(inner) if inner else (None, None)
        if dates:
            per[key] = {d: v for d, v in zip(dates, vals)}
            alldates.update(dates)
    if not per:
        return "off", {}
    dates_sorted = sorted(alldates)
    series = {k: [m.get(d) for d in dates_sorted] for k, m in per.items()}
    fr = {"dates": dates_sorted, "series": series, "unit": "%", "src": "WindAlice"}
    return "ok", {"funding_rates": fr}


def wind_fetch(days=400):
    """返回 (status, {series_key: {...}})"""
    try:
        from WindPy import w
    except Exception:
        return "off", {}
    try:
        r = w.start()
        if r.ErrorCode != 0:
            return "off", {}
    except Exception:
        return "off", {}
    end = dt.datetime.now()
    start = end - dt.timedelta(days=days)
    out = {}
    try:
        codes = [WIND_MAP[k] for k in WIND_MAP]
        names = list(WIND_MAP.keys())
        d = w.wsd(codes, "CLOSE", start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
        if d.ErrorCode == 0 and d.Data:
            dates = [t.strftime("%Y-%m-%d") for t in d.Times]
            ser = {}
            for i, nm in enumerate(names):
                vals = [float(x) if x is not None else None for x in d.Data[i]]
                if any(v is not None for v in vals):
                    ser[nm] = vals
            if ser:
                out["funding_rates"] = {"dates": dates, "series": ser, "unit": "%", "src": "Wind"}
                out["irs"] = {"dates": dates,
                              "series": {k: v for k, v in ser.items() if k.startswith("FR007")},
                              "unit": "%", "src": "Wind"}
    except Exception:
        pass
    return ("ok" if out else "warn"), out


# ------------------------------------------------------------------ 森浦 Qeubee（通过 MCP 流端点 JSON-RPC 取数，X-Access-Key 鉴权）
def _qeubee_mcp_query(base_url, key, api_name, start, end):
    """对 Qeubee MCP 流端点发 JSON-RPC，调用 queryData，返回解析后的数据列表。"""
    import urllib.request
    url = base_url if base_url.rstrip("/").endswith("/mcp/stream") else base_url.rstrip("/") + "/mcp/stream"
    rid = [0]

    def rpc(method, params=None, session=None):
        rid[0] += 1
        body = {"jsonrpc": "2.0", "id": rid[0], "method": method}
        if params is not None:
            body["params"] = params
        data = json.dumps(body).encode("utf-8")
        last = None
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, data=data, method="POST")
                req.add_header("X-Access-Key", key)
                req.add_header("Content-Type", "application/json")
                req.add_header("Accept", "application/json, text/event-stream")
                if session:
                    req.add_header("Mcp-Session-Id", session)
                with urllib.request.urlopen(req, timeout=12) as r:
                    return r.headers.get("Mcp-Session-Id"), r.read().decode("utf-8")
            except Exception as e:
                last = e
                time.sleep(1.5)
        raise last

    sid, _ = rpc("initialize", {"protocolVersion": "2024-11-05",
                                "capabilities": {},
                                "clientInfo": {"name": "mmb-workbench", "version": "1.0"}})
    try:
        rpc("notifications/initialized", session=sid)
    except Exception:
        pass
    _, raw = rpc("tools/call", {"name": "queryData",
                  "arguments": {"apiName": api_name,
                                "params": {"start_date": start, "end_date": end}}}, sid)
    for part in raw.split("event:"):
        if "data:" in part:
            d = part.split("data:", 1)[1].strip().split("\n")[0]
            try:
                obj = json.loads(d)
            except Exception:
                continue
            if isinstance(obj, dict) and "result" in obj:
                try:
                    return json.loads(obj["result"]["content"][0]["text"])
                except Exception:
                    return []
    return []


def _overlay_by_date(target, dates, fields):
    """把 fields={字段: 值列表} 按日期覆盖/追加进 target({dates,series,...})，保留其它字段。"""
    t_dates = list(target.get("dates", []))
    t_ser = target.setdefault("series", {})
    idx = {d: i for i, d in enumerate(t_dates)}
    for d in dates:
        if d not in idx:
            idx[d] = len(t_dates)
            t_dates.append(d)
            for f in t_ser.values():
                f.append(None)
    L = len(t_dates)
    for f, vals in fields.items():
        arr = t_ser.setdefault(f, [None] * L)
        if len(arr) < L:
            arr.extend([None] * (L - len(arr)))
        for i, d in enumerate(dates):
            arr[idx[d]] = vals[i]
    target["dates"] = t_dates
    for f in t_ser:
        if len(t_ser[f]) < L:
            t_ser[f].extend([None] * (L - len(t_ser[f])))
    return target


def qeubee_fetch(days=400):
    """Qeubee 通过 MCP 流端点 JSON-RPC 取数（X-Access-Key 鉴权）。
       凭证优先从环境变量注入：QUEUBEE_X_ACCESS_KEY（+ 可选 QUEUBEE_BASE_URL）。
       未配置时回退到 Agent/MCP 注入的近期缓存。"""
    cfg = load_cfg().get("qeubee", {})
    base = (os.environ.get("QUEUBEE_BASE_URL") or
            cfg.get("base_url") or
            "https://data-api.qeubee.cn/sumscope/common/mcp/stream").strip()
    key = (os.environ.get("QUEUBEE_X_ACCESS_KEY") or
           cfg.get("x_access_key") or "").strip()
    live = load_live()
    base_series = live.get("series", {}) or {}

    if not (cfg.get("enabled", True) and key):
        return _qeubee_check_cache(live)

    end = dt.datetime.now()
    start = end - dt.timedelta(days=days)
    sd, ed = start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")
    # 以基线全量序列为底，仅覆盖 Qeubee 能拉到的字段，避免丢失 OMO/存单等快照序列
    out = {k: {"dates": list(v.get("dates", [])),
               "series": {fk: list(fv) for fk, fv in v.get("series", {}).items()},
               "unit": v.get("unit"), "src": v.get("src")}
           for k, v in base_series.items()}
    try:
        dr = _qeubee_mcp_query(base, key, "mmrRateOverviewDr001Dr007", sd, ed)
        if dr:
            dates = [str(r.get("dt"))[:10] for r in dr]
            fr = dict(base_series.get("funding_rates",
                      {"dates": [], "series": {}, "unit": "%", "src": "森浦Qeubee"}))
            fr["src"] = "森浦Qeubee"
            _overlay_by_date(fr, dates, {
                "DR001": [r.get("dr001_wavg_rate") for r in dr],
                "DR007": [r.get("dr007_wavg_rate") for r in dr],
            })
            out["funding_rates"] = fr
        irs = _qeubee_mcp_query(base, key, "mmrIrsFr007Hist", sd, ed)
        if irs:
            dates = [str(r.get("stat_dt"))[:10] for r in irs]
            ir = dict(base_series.get("irs",
                      {"dates": [], "series": {}, "unit": "%", "src": "森浦Qeubee"}))
            ir["src"] = "森浦Qeubee"
            _overlay_by_date(ir, dates, {
                "FR007:1Y": [r.get("irs_wavg_price_fr007_1_yr") for r in irs],
            })
            out["irs"] = ir
        return ("ok" if out else "off"), out
    except Exception as e:
        print("qeubee mcp fail:", e, file=sys.stderr)
        return _qeubee_check_cache(live)


def _qeubee_check_cache(live):
    ts = live.get("updated_at", "")
    try:
        t = dt.datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
        if (dt.datetime.now() - t).total_seconds() < TTL_HOURS * 3600:
            return "ok", {}
    except Exception:
        pass
    return "off", {}


# ------------------------------------------------------------------ 主流程
def main():
    probe = "--probe" in sys.argv
    cfg = load_cfg()
    status, series = {}, {}

    # 先 Qeubee（覆盖 DR001/DR007/IRS），再 Wind（覆盖 funding_rates 全量回购利率）：
    # 后执行的 Wind 用其真·实时值覆盖 funding_rates，避免 Qeubee 的基线回写冲掉 Wind 新值。
    if cfg.get("qeubee", {}).get("enabled", True):
        s, d = qeubee_fetch()
        status["qeubee"] = s
        series.update(d)
    else:
        status["qeubee"] = "off"

    if cfg.get("wind", {}).get("enabled", True):
        status_w, d = "off", {}
        # 云端优先用 Wind Alice 云端 MCP（env 注入 WIND_API_KEY）；否则回退桌面 WindPy
        if (os.environ.get("WIND_API_KEY") or os.environ.get("WIND_ALICE_URL")
                or load_cfg().get("wind", {}).get("alice", {}).get("url")):
            sw, dw = wind_alice_fetch()
            if dw:
                status_w, d = sw, dw
        if not d:
            sw, dw = wind_fetch()
            if dw:
                status_w, d = sw, dw
        status["wind"] = status_w
        series.update(d)
    else:
        status["wind"] = "off"

    live = load_live()
    old = live.get("series", {}) or {}
    if not series:  # 本次没取到，保留上一次的实时值
        series = old
    news = live.get("news", []) or []

    # 若缓存里已有 Wind 取到的序列，即使本次探测不到 WindPy，也保留 wind=ok，
    # 避免把已有的实时 Wind 数据误标成「未连接」
    def _has_src(d, tag):
        for k, v in (d or {}).items():
            if isinstance(v, dict) and tag in (v.get("src") or ""):
                return True
        return False
    if _has_src(series, "Wind") or _has_src(old, "Wind"):
        if status.get("wind") == "off":
            status["wind"] = "ok"
    if _has_src(series, "森浦") or _has_src(old, "森浦") or _has_src(old, "Qeubee"):
        if status.get("qeubee") == "off":
            status["qeubee"] = "ok"

    out = {
        "updated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "status": status,
        "series": series,
        "news": news,
        "note": "由 bridge.py 生成；Wind 需本机终端授权，Qeubee 需配置网关或由 Agent 注入",
    }
    os.makedirs(DATA, exist_ok=True)
    if not probe:
        with io.open(LIVE, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        # 同步滚动「今日 ±5 日」日历窗口
        cal = os.path.join(ROOT, "update_calendar.py")
        if os.path.exists(cal):
            try:
                subprocess.run([sys.executable, cal], cwd=ROOT, capture_output=True, timeout=60)
            except Exception as e:
                print("calendar sync fail:", e, file=sys.stderr)

    n = sum(len(v.get("series", {})) for v in series.values())
    msg = "Wind=%s / 森浦=%s；实时序列 %d 条" % (status.get("wind"), status.get("qeubee"), n)
    if status.get("wind") == "off" and status.get("qeubee") == "off":
        msg += "（两端均不可用，页面继续使用 Excel 底稿值，可用上传更新）"
    print(json.dumps({"ok": True, "msg": msg, "status": status}, ensure_ascii=False))


if __name__ == "__main__":
    main()
