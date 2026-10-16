# -*- coding: utf-8 -*-
"""一键重装：把本币货币债券工作台部署到腾讯云 CVM (Windows Server)。
前置（见 README.md）：
  1) 在 CVM 上以管理员运行 setup_cvm.ps1  —— 开启 WinRM + 防火墙 5985。
  2) 本机：pip install -r requirements.txt
  3) 本机：复制 .env.example 为 .env，填好 CVM 凭据与两个 API Key。
运行：python deploy.py
设计要点（来自实战踩坑）：
  - 用 pywinrm 原始 NTLM 协议，不要求本机 TrustedHosts（无管理员也能连）。
  - 文件传输：gzip + base64 分片嵌入脚本（每片 <8KB），SHA256 校验 + 失败重试。
    因为该 WinRM 服务端 stdin 流不可靠、powershell -encodedcommand 有 ~32K 命令行上限。
  - 不以「计划任务」做自启（该环境 Register-ScheduledTask 必报 transaction no longer active），
    改用 CVM 内置 csc.exe 编译的 C# Windows 服务（MMB_Workbench，SYSTEM 开机自启+崩溃重启）。
"""
import os, sys, base64, gzip, hashlib, time

# ---------- 读取本地 .env（简单 KEY=VALUE，不依赖第三方库）----------
def load_env(path=".env"):
    cfg = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    return cfg

CFG = load_env()
IP = CFG.get("CVM_IP", "")
USER = CFG.get("CVM_USER", "")
PASS = CFG.get("CVM_PASS", "")
QKEY = CFG.get("QUEUBEE_X_ACCESS_KEY", "")
QURL = CFG.get("QUEUBEE_BASE_URL", "https://data-api.qeubee.cn/sumscope/common/mcp/stream")
WKEY = CFG.get("WIND_API_KEY", "")

if not (IP and USER and PASS and QKEY and WKEY):
    sys.exit("缺少必要配置：请复制 .env.example 为 .env 并填写 "
             "CVM_IP / CVM_USER / CVM_PASS / QUEUBEE_X_ACCESS_KEY / WIND_API_KEY")

import winrm
sess = winrm.Session(IP, auth=(USER, PASS), transport="ntlm", server_cert_validation="ignore")
sess.protocol.transport.max_envelope_size = 8 * 1024 * 1024
sess.protocol.read_timeout_sec = 600
sess.protocol.operation_timeout_sec = 600

HERE = os.path.dirname(os.path.abspath(__file__))
REMOTE = r"C:\mmb"
PY = r"C:\Program Files\Python313\python.exe"
NODE_VER = "v22.22.2"
NODE_URL = "https://nodejs.org/dist/%s/node-%s-win-x64.zip" % (NODE_VER, NODE_VER)
PIECE = 2_000


# ---------- WinRM 辅助 ----------
def run_ps(ps, ok=(0,)):
    r = sess.run_ps(ps)
    if r.status_code not in ok:
        print("!! rc=%d ERR:%s" % (r.status_code, r.std_err.decode("utf-8", "replace")[:400]))
    return r.status_code, r.std_out.decode("utf-8", "replace"), r.std_err.decode("utf-8", "replace")

def run_cmd(*a):
    r = sess.run_cmd(a[0], list(a[1:]))
    return r.status_code, r.std_out.decode("utf-8", "replace").strip(), r.std_err.decode("utf-8", "replace").strip()

def sha256_remote(rpath):
    r = sess.run_ps(
        "$b=[IO.File]::ReadAllBytes('%s');"
        "$h=[Security.Cryptography.SHA256]::Create().ComputeHash($b);"
        "$s=''; foreach($x in $h){ $s += $x.ToString('x2') };"
        "Write-Output $s" % rpath)
    return r.std_out.decode("utf-8", "replace").strip().replace(" ", "")

def write_remote_file(rpath, data, tries=3):
    gz = gzip.compress(data, 9)
    b64 = base64.b64encode(gz).decode("ascii")
    step = (PIECE * 4 // 3) // 4 * 4
    pieces = [b64[i:i + step] for i in range(0, len(b64), step)]
    tmp = rpath + ".gz.tmp"
    local_sha = hashlib.sha256(data).hexdigest()
    for attempt in range(1, tries + 1):
        for idx, piece in enumerate(pieces):
            if idx == 0:
                ps = "$f='{0}'; $b=[Convert]::FromBase64String('{1}'); [IO.File]::WriteAllBytes($f,$b)".format(tmp, piece)
            else:
                ps = "$f='{0}'; $b=[Convert]::FromBase64String('{1}'); $fs=[IO.File]::Open($f,'Append');$fs.Write($b,0,$b.Length);$fs.Close()".format(tmp, piece)
            rc, _, err = run_ps(ps)
            if rc != 0:
                raise RuntimeError("piece %d rc=%d %s" % (idx, rc, err[:200]))
        gunzip = ("$in='{0}';$out='{1}';$fs=[IO.File]::OpenRead($in);"
                  "$gz=New-Object IO.Compression.GzipStream($fs,[IO.Compression.CompressionMode]::Decompress);"
                  "$buf=New-Object byte[] 65536;$ofs=[IO.File]::Create($out);"
                  "while(($r=$gz.Read($buf,0,$buf.Length))-gt 0){{$ofs.Write($buf,0,$r)}};"
                  "$ofs.Close();$gz.Close();$fs.Close();Remove-Item $in -Force").format(tmp, rpath)
        rc, _, err = run_ps(gunzip)
        if rc != 0:
            print("  gunzip rc=%d %s (attempt %d)" % (rc, err[:200], attempt)); continue
        if sha256_remote(rpath).lower() == local_sha:
            return len(pieces)
        print("  SHA mismatch (attempt %d), retry" % attempt)
    raise RuntimeError("write %s failed" % rpath)


print("== 0. 预检 CVM 环境 ==")
rc, out, _ = run_ps("if(Test-Path '%s'){'PY_OK'} else {'PY_MISSING: 请先在 CVM 安装 Python 3.13 并加入 PATH'}" % PY)
print("   ", out.strip())
if "PY_MISSING" in out:
    sys.exit("CVM 缺少 Python，请先安装后再运行。")

# ---------- 1. 收集并上传文件 ----------
files = [
    (os.path.join(HERE, "server.py"), r"C:\mmb\server.py"),
    (os.path.join(HERE, "bridge.py"), r"C:\mmb\bridge.py"),
    (os.path.join(HERE, "mmb_svc.cs"), r"C:\mmb\mmb_svc.cs"),
    (os.path.join(HERE, "wind-mcp-skill", "scripts", "cli.mjs"), r"C:\mmb\wind-mcp-skill\scripts\cli.mjs"),
]
for fn in os.listdir(os.path.join(HERE, "web")):
    files.append((os.path.join(HERE, "web", fn), r"C:\mmb\web\%s" % fn))
for fn in os.listdir(os.path.join(HERE, "data")):
    files.append((os.path.join(HERE, "data", fn), r"C:\mmb\data\%s" % fn))
for fn in os.listdir(os.path.join(HERE, "wind-mcp-skill", "references")):
    files.append((os.path.join(HERE, "wind-mcp-skill", "references", fn),
                  r"C:\mmb\wind-mcp-skill\references\%s" % fn))

print("[1] 建目录树")
dirs = sorted({os.path.dirname(r) for _, r in files})
run_ps("; ".join("New-Item -ItemType Directory -Force -Path '%s'" % d for d in dirs))

print("[2] 上传文件 (gzip+base64 分片, SHA 校验)")
ok = 0
for lpath, rpath in files:
    with open(lpath, "rb") as f:
        data = f.read()
    write_remote_file(rpath, data)
    ok += 1
    print("    %2d/%2d  %s" % (ok, len(files), os.path.basename(rpath)))

# ---------- 2. 写入远端 .env（注入密钥）----------
print("[3] 写远端 .env（注入 Qeubee / Wind 密钥）")
env_text = (
    "QUEUBEE_BASE_URL=%s\n"
    "QUEUBEE_X_ACCESS_KEY=%s\n"
    "WIND_API_KEY=%s\n"
    "WIND_ALICE_TOKEN=%s\n"
    "MMB_HOST=0.0.0.0\n"
    "MMB_PORT=8765\n"
    "MMB_REFRESH_MIN=30\n"
) % (QURL, QKEY, WKEY, WKEY)
env_b64 = base64.b64encode(env_text.encode("utf-8")).decode()
run_ps("$b=[Convert]::FromBase64String('%s');[IO.File]::WriteAllBytes('C:\\mmb\\.env',$b)" % env_b64)

# ---------- 3. 安装 Node（Wind MCP CLI 需要）----------
print("[4] 确保 Node 已安装 (C:\\mmb\\node\\node.exe)")
rc, out, _ = run_ps(
    "$ErrorActionPreference='Stop';"
    "if(Test-Path 'C:\\mmb\\node\\node.exe'){ Write-Output 'NODE_ALREADY'; & 'C:\\mmb\\node\\node.exe' --version; exit };"
    "$zip='C:\\mmb\\node_install.zip';"
    "Write-Output 'downloading node ...';"
    "Invoke-WebRequest -Uri '%s' -OutFile $zip -TimeoutSec 300;"
    "Expand-Archive -Path $zip -DestinationPath 'C:\\mmb' -Force; Remove-Item $zip -Force;"
    "if(Test-Path 'C:\\mmb\\node-%s-win-x64'){ Move-Item 'C:\\mmb\\node-%s-win-x64' 'C:\\mmb\\node' -Force };"
    "& 'C:\\mmb\\node\\node.exe' --version" % (NODE_URL, NODE_VER, NODE_VER))
print("   ", out.strip().replace("\n", " | "))

# ---------- 4. 编译并注册 C# Windows 服务 ----------
print("[5] 编译 mmb_svc.exe")
rc, out, err = run_ps(
    "$c=Get-ChildItem 'C:\\Windows\\Microsoft.NET\\Framework64','C:\\Windows\\Microsoft.NET\\Framework' "
    "-Recurse -Filter csc.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | "
    "Select-Object -First 1; if($c){$c.FullName} else {'NO_CSC'}")
csc = out.strip()
print("   csc:", csc)
rc, out, err = run_ps("& '%s' /target:exe /out:'C:\\mmb\\mmb_svc.exe' /r:System.ServiceProcess.dll 'C:\\mmb\\mmb_svc.cs' 2>&1 | Out-String" % csc)
print("   compile rc=%d %s" % (rc, out.strip().replace("\n", " | ")[:300]))
rc, out, _ = run_ps("if(Test-Path 'C:\\mmb\\mmb_svc.exe'){'EXE_OK '+(Get-Item 'C:\\mmb\\mmb_svc.exe').Length} else {'EXE_MISSING'}")
print("   ", out.strip())

print("[6] sc create / start 服务")
run_cmd("sc", "delete", "MMB_Workbench")
time.sleep(1)
rc, out, err = run_cmd("sc", "create", "MMB_Workbench", "binPath=", r"C:\mmb\mmb_svc.exe",
                       "DisplayName=", "MMB Workbench", "start=", "auto", "obj=", "LocalSystem")
print("   create rc=%d %s %s" % (rc, out.replace("\n", " | "), err.replace("\n", " | ")))
run_cmd("sc", "description", "MMB_Workbench", "本币货币债券工作台 HTTP 服务 (8765)，开机自启+崩溃重启")
time.sleep(1)
rc, out, err = run_cmd("sc", "start", "MMB_Workbench")
print("   start rc=%d %s %s" % (rc, out.replace("\n", " | "), err.replace("\n", " | ")))

# ---------- 5. 防火墙 ----------
print("[7] 放行 8765 入站")
run_ps("if (-not (Get-NetFirewallRule -DisplayName 'MMB_Workbench_8765' -ErrorAction SilentlyContinue)) {"
       "New-NetFirewallRule -DisplayName 'MMB_Workbench_8765' -Direction Inbound -Protocol TCP "
       "-LocalPort 8765 -Action Allow -ErrorAction SilentlyContinue }", ok=(0, 1))

# ---------- 6. 验证 ----------
print("[8] 等待 6s 探活 ...")
time.sleep(6)
rc, out, _ = run_cmd("sc", "query", "MMB_Workbench")
for ln in out.splitlines():
    if "STATE" in ln:
        print("   ", ln.strip())
rc, out, _ = run_ps(
    "$l=Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue; "
    "if($l){'8765 LISTEN pid='+$l.OwningProcess} else {'8765 NOT-LISTEN'}")
print("   ", out.strip())
rc, out, _ = run_ps(
    "try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:8765/api/status' -UseBasicParsing -TimeoutSec 10; "
    "'status '+$r.StatusCode+' '+$r.Content.Substring(0,[Math]::Min(160,$r.Content.Length)) } "
    "catch { 'API_ERR '+$_.Exception.Message }")
print("   ", out.strip().replace("\n", " "))

print("\n=== DEPLOY DONE ===")
print("下一步：在腾讯云 Lighthouse 控制台「防火墙」放行 TCP 8765 入站，")
print("然后浏览器访问  http://%s:8765/" % IP)
