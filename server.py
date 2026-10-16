# -*- coding: utf-8 -*-
"""
本币货币债券工作台 —— 本地服务
只监听 127.0.0.1，不对外暴露；数据读写全部在本机 data/ 目录。
"""
import os, sys, json, io, re, socket, subprocess, threading, time, datetime as dt
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")
UPLOAD = os.path.join(ROOT, "uploads")

# 从项目根 .env 加载环境变量（纯标准库，不依赖 python-dotenv），
# 便于云端/Windows 部署注入森浦、Wind 等凭据，且不覆盖已存在的环境变量。
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
PORT = int(os.environ.get("MMB_PORT", "8765"))
# 云部署时设置 MMB_HOST=0.0.0.0 对外监听；本地默认仅 127.0.0.1（不对外暴露）。
HOST = os.environ.get("MMB_HOST", "127.0.0.1")

for d in (DATA, UPLOAD):
    os.makedirs(d, exist_ok=True)

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
}


class Server(ThreadingHTTPServer):
    """关闭 SO_REUSEADDR：Windows 下它会导致多个进程重复绑定同一端口，
    请求被随机分发到旧实例，页面就会白屏。"""
    allow_reuse_address = False
    daemon_threads = True


def port_alive(port, timeout=0.6):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


def read_json(path, default=None):
    try:
        with io.open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


# ------------------------------------------------------------------ 解释器解析
# 上传解析（extract.py）依赖 openpyxl，服务器自身的解释器未必装了它。
# 这里挑一个「能 import 指定模块」的解释器，必要时在隔离 venv 里补装。
VENV_DIR = os.path.join(os.path.expanduser("~"), ".workbuddy", "binaries",
                        "python", "envs", "default")
VENV_PY = os.path.join(VENV_DIR, "Scripts", "python.exe")
_PY_CACHE = {}


def _can_import(py, mod):
    try:
        r = subprocess.run([py, "-c", "import %s" % mod],
                           capture_output=True, timeout=90)
        return r.returncode == 0
    except Exception:
        return False


def _ensure_venv():
    """venv 不存在时用当前解释器创建（只做一次）。"""
    if os.path.exists(VENV_PY):
        return True
    try:
        subprocess.run([sys.executable, "-m", "venv", VENV_DIR],
                       capture_output=True, timeout=300)
    except Exception:
        return False
    return os.path.exists(VENV_PY)


def resolve_py(mods=()):
    """返回可运行指定脚本的解释器路径。mods 为所需模块名。"""
    key = tuple(mods)
    if key in _PY_CACHE:
        return _PY_CACHE[key]
    cands = [sys.executable]
    if os.path.exists(VENV_PY):
        cands.insert(0, VENV_PY)
    cands.append("python")
    for py in cands:
        try:
            if all(_can_import(py, m) for m in mods):
                _PY_CACHE[key] = py
                return py
        except Exception:
            continue
    # 都没有：在隔离 venv 里补装（不污染系统 Python）
    if mods and _ensure_venv():
        for m in mods:
            try:
                subprocess.run([VENV_PY, "-m", "pip", "install", "-q", m],
                               capture_output=True, timeout=300)
            except Exception:
                pass
        if all(_can_import(VENV_PY, m) for m in mods):
            _PY_CACHE[key] = VENV_PY
            return VENV_PY
    _PY_CACHE[key] = sys.executable
    return sys.executable


def _refresh_loop():
    """后台定时刷新 live.json（云端自刷新用）。间隔由 MMB_REFRESH_MIN 控制。"""
    try:
        interval = int(os.environ.get("MMB_REFRESH_MIN", "30")) * 60
    except Exception:
        interval = 1800
    if interval <= 0:
        return
    while True:
        time.sleep(interval)
        try:
            subprocess.run([sys.executable, os.path.join(ROOT, "bridge.py")],
                           cwd=ROOT, capture_output=True, timeout=200)
        except Exception:
            pass


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (dt.datetime.now().strftime("%H:%M:%S"), fmt % args))

    # -------------------------------------------------- utils
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        b = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    # -------------------------------------------------- GET
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/bundle":
            b = read_json(os.path.join(DATA, "bundle.json"))
            return self._send(200, b or {"error": "bundle.json 不存在，请先运行 extract.py"})
        if p == "/api/live":
            b = read_json(os.path.join(DATA, "live.json"), {"status": {}, "series": {}, "news": []})
            return self._send(200, b)
        if p == "/api/status":
            live = read_json(os.path.join(DATA, "live.json"), {}) or {}
            return self._send(200, {
                "bundle": os.path.exists(os.path.join(DATA, "bundle.json")),
                "live": live.get("updated_at", ""),
                "status": live.get("status", {}),
            })
        if p == "/api/notes":
            b = read_json(os.path.join(DATA, "notes.json"), {"notes": []})
            if isinstance(b, list):
                b = {"notes": b}
            return self._send(200, b)
        if p in ("/data/bundle.json", "/data/live.json", "/data/notes.json"):
            fp = os.path.join(DATA, os.path.basename(p))
            if os.path.exists(fp):
                with open(fp, "rb") as f:
                    return self._send(200, f.read(), "application/json; charset=utf-8")
            return self._send(404, {"error": "not found"})
        if p == "/":
            p = "/index.html"
        fp = os.path.join(WEB, p.lstrip("/"))
        if os.path.isfile(fp):
            ext = os.path.splitext(fp)[1].lower()
            with open(fp, "rb") as f:
                return self._send(200, f.read(), MIME.get(ext, "application/octet-stream"))
        return self._send(404, {"error": "not found"})

    # -------------------------------------------------- POST
    def do_POST(self):
        p = self.path.split("?")[0]
        if p == "/api/live/refresh":
            return self._refresh()
        if p == "/api/upload":
            return self._upload()
        if p == "/api/notes":
            return self._notes()
        return self._send(404, {"error": "not found"})

    def _refresh(self):
        try:
            py = resolve_py()
            r = subprocess.run([py, os.path.join(ROOT, "bridge.py")],
                               cwd=ROOT, capture_output=True, timeout=180)
            out = (r.stdout or b"").decode("utf-8", "ignore")
            err = (r.stderr or b"").decode("utf-8", "ignore")
            try:
                j = json.loads(out.strip().splitlines()[-1])
            except Exception:
                tail = (err.strip().splitlines() or [""])[-1] if err.strip() else ""
                j = {"ok": r.returncode == 0,
                     "msg": out.strip()[-400:] or tail or "桥接已执行"}
                if r.returncode != 0:
                    j["msg"] = "实时取数失败（返回码 %d）：%s" % (r.returncode, tail or "无输出")
            return self._send(200, j)
        except subprocess.TimeoutExpired:
            return self._send(200, {"ok": False, "msg": "实时取数超时（>180s），请检查 Wind / 森浦 客户端是否可用"})
        except Exception as e:
            return self._send(200, {"ok": False, "msg": "实时取数失败：%s" % e})

    def _notes(self):
        """交易笔记留档：GET 读取，POST 整体写回 data/notes.json"""
        fp = os.path.join(DATA, "notes.json")
        try:
            length = int(self.headers.get("Content-Length", 0))
        except Exception:
            length = 0
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return self._send(200, {"ok": False, "msg": "请求体不是合法 JSON"})
        notes = body.get("notes") if isinstance(body, dict) else body
        if not isinstance(notes, list):
            return self._send(200, {"ok": False, "msg": "缺少 notes 数组"})
        # 去重合并，避免覆盖其他端写入的笔记
        old = read_json(fp, {"notes": []})
        if isinstance(old, list):
            old = {"notes": old}
        merged, seen = [], {}
        for n in (old.get("notes") or []) + notes:
            if isinstance(n, dict) and n.get("id") and n["id"] not in seen:
                seen[n["id"]] = 1
                merged.append(n)
        merged.sort(key=lambda x: (x.get("date") or "", x.get("ts") or 0), reverse=True)
        try:
            with io.open(fp, "w", encoding="utf-8") as f:
                json.dump({"updated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                           "notes": merged}, f, ensure_ascii=False, indent=1)
        except Exception as e:
            return self._send(200, {"ok": False, "msg": "写入失败：%s" % e})
        return self._send(200, {"ok": True, "count": len(merged)})

    def _upload(self):
        try:
            ctype = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in ctype:
                return self._send(200, {"ok": False, "msg": "需要 multipart/form-data"})
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            m = re.search(rb"boundary=(?:\"?)([^\";]+)", ctype.encode())
            if not m:
                return self._send(200, {"ok": False, "msg": "缺少 boundary"})
            bnd = b"--" + m.group(1)
            parts = raw.split(bnd)
            saved = []
            for part in parts:
                if b"filename=" not in part:
                    continue
                hb, _, body = part.partition(b"\r\n\r\n")
                body = body.rstrip(b"\r\n-")
                fm = re.search(rb'filename="([^"]*)"', hb) or re.search(rb"filename=([^;\r\n]+)", hb)
                name = fm.group(1).decode("utf-8", "ignore") if fm else "upload.xlsx"
                name = os.path.basename(name.replace("\\", "/"))
                if not name.lower().endswith((".xlsx", ".xls")):
                    continue
                dest = os.path.join(UPLOAD, name)
                with open(dest, "wb") as f:
                    f.write(body)
                saved.append(dest)
            if not saved:
                return self._send(200, {"ok": False, "msg": "未找到 .xlsx 文件"})
            # 用上传的文件重新抽取（extract.py 需要 openpyxl，自动挑一个能跑的解释器）
            py = resolve_py(("openpyxl",))
            try:
                r = subprocess.run([py, os.path.join(ROOT, "extract.py"), "--uploads"] + saved,
                                   cwd=ROOT, capture_output=True, timeout=600)
            except subprocess.TimeoutExpired:
                return self._send(200, {"ok": False, "msg": "解析超时（>600s），底稿过大时可先用 Excel 精简"})
            out = (r.stdout or b"").decode("utf-8", "ignore")
            err = (r.stderr or b"").decode("utf-8", "ignore")
            if r.returncode != 0:
                tail = (err.strip().splitlines() or [""])[-1] if err.strip() else (out.strip()[-200:] or "无输出")
                return self._send(200, {"ok": False,
                                        "msg": "解析失败（%s）：%s" % (os.path.basename(py), tail)})
            msg = "已解析 %d 个文件并更新底稿" % len(saved)
            # 重抽会丢掉「实时源合并」的数据集，这里补跑合并脚本
            for sc in ("merge_pbc_ops.py", "merge_ncd_issue.py"):
                sp = os.path.join(ROOT, sc)
                if not os.path.exists(sp):
                    continue
                try:
                    subprocess.run([py, sp], cwd=ROOT, capture_output=True, timeout=300)
                except Exception:
                    pass
            last = (out.strip().splitlines() or [""])[-1]
            return self._send(200, {"ok": True, "msg": msg + (("；" + last) if last else "")})
        except Exception as e:
            return self._send(200, {"ok": False, "msg": "上传失败：%s" % e})


def main():
    print("=" * 62)
    print(" 本币货币债券工作台（本地服务）")
    print(" 数据目录：%s" % DATA)
    print(" 监听地址：%s:%d%s" % (HOST, PORT, "（仅本机）" if HOST == "127.0.0.1" else "（对外暴露，请注意安全组/防火墙）"))
    if HOST != "127.0.0.1":
        print(" 关闭此窗口即停止。")

    # 已有实例在跑就直接复用，绝不重复绑定（Windows 下会静默抢端口）
    if port_alive(PORT):
        url = "http://127.0.0.1:%d" % PORT
        print(" ! 端口 %d 已被占用，已有实例在运行，直接复用：%s" % (PORT, url))
        print("=" * 62)
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass
        return

    if not os.path.exists(os.path.join(DATA, "bundle.json")):
        print(" ! 未找到 bundle.json，正在从 Excel 底稿抽取…")
        subprocess.run([sys.executable, os.path.join(ROOT, "extract.py")], cwd=ROOT)
        if not os.path.exists(os.path.join(DATA, "bundle.json")):
            print(" ! 抽取失败：请确认 data/ 目录可写，且 extract.py 能读到桌面底稿")
            print("=" * 62)
            return

    srv = None
    port = PORT
    for attempt in range(12):
        try:
            srv = Server((HOST, port), Handler)
            break
        except OSError:
            port += 1
    if srv is None:
        print(" ! 无法绑定端口（%d~%d 都被占用）" % (PORT, port))
        print("=" * 62)
        return

    url = "http://127.0.0.1:%d" % port
    print(" 访问地址：%s" % url)
    print("=" * 62)
    try:
        import webbrowser
        webbrowser.open(url)
    except Exception:
        pass
    # 云端自刷新：对外监听时启动后台定时刷新线程（本地 127.0.0.1 不自动刷）
    if HOST != "127.0.0.1":
        threading.Thread(target=_refresh_loop, daemon=True).start()
        print(" 已启用后台定时刷新（间隔 %s 分钟）" % os.environ.get("MMB_REFRESH_MIN", "30"))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        try:
            srv.server_close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
