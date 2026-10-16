# =============================================================================
# 本币货币债券工作台 —— CVM 本地一键部署（从 GitHub 拉取）
# 用法：在云端 Windows 服务器（RDP / 腾讯云控制台 VNC）上「以管理员身份」运行 PowerShell，
#       粘贴执行本文件即可。无需本机、无需 WinRM。
# 前置：CVM 已安装 Python 3.13（默认路径 C:\Program Files\Python313\python.exe，
#       安装时勾选 Add to PATH）。若没有，脚本会提示并停止。
# 说明：GitHub 私有库通过 Bearer token 下载（token 只走请求头，不进 URL / 不落盘）。
# =============================================================================
$ErrorActionPreference = 'Continue'

$MMB      = 'C:\mmb'
$GH_REPO  = 'chunqiushi/mmb-deploy'
$NODE_VER = 'v22.22.2'
$NODE_URL = "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip"
$PY       = 'C:\Program Files\Python313\python.exe'

Write-Output "== 0. 输入配置 =="
$token = Read-Host -Prompt "GitHub token (ghp_... 满权限，用后请尽快 revoke 轮换)"
$qkey  = Read-Host -Prompt "Qeubee X-Access-Key (ak-qb-...)"
$wkey  = Read-Host -Prompt "Wind Alice API Key (ak_vA...)"

# 1. 下载仓库 zip（Bearer 头鉴权）
Write-Output "== 1. 从 GitHub 下载仓库 =="
$zip = "$env:TEMP\mmb-deploy.zip"
$url = "https://github.com/$GH_REPO/archive/refs/heads/main.zip"
try {
    Invoke-WebRequest -Headers @{Authorization="Bearer $token"} -Uri $url -OutFile $zip -TimeoutSec 300
    Write-Output "    下载完成: $((Get-Item $zip).Length) 字节"
} catch {
    Write-Error "下载失败: $_  —— 可能 CVM 访问 GitHub 受限。可改用：(a) 本机 WinRM 推送；(b) 腾讯云 COS 中转。"
    exit 1
}

# 2. 解压到 C:\mmb（处理 GitHub 顶层文件夹 mmb-deploy-main）
Write-Output "== 2. 解压到 $MMB =="
New-Item -ItemType Directory -Force -Path $MMB | Out-Null
$tmp = "$env:TEMP\mmb-deploy-extract"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$src = Get-ChildItem $tmp -Directory | Select-Object -First 1
Get-ChildItem $src.FullName | ForEach-Object { Move-Item $_.FullName $MMB -Force }
Remove-Item $tmp -Recurse -Force
Remove-Item $zip -Force
Write-Output "    文件就位: $((Get-ChildItem $MMB -Recurse -File).Count) 个文件"

# 3. 检查 Python 3.13
Write-Output "== 3. 检查 Python 3.13 =="
if (-not (Test-Path $PY)) {
    Write-Warning "未检测到 $PY 。请先到 python.org 安装 Python 3.13 并勾选 Add to PATH，再重跑本脚本。"
    exit 1
}
& $PY --version

# 4. 安装 Node（Wind MCP CLI 依赖）
Write-Output "== 4. 安装 Node =="
if (Test-Path "$MMB\node\node.exe") {
    Write-Output "    Node 已存在，跳过"
} else {
    $nz = "$env:TEMP\node.zip"
    Invoke-WebRequest -Uri $NODE_URL -OutFile $nz -TimeoutSec 300
    Expand-Archive -Path $nz -DestinationPath $MMB -Force
    Remove-Item $nz -Force
    if (Test-Path "$MMB\node-$NODE_VER-win-x64") { Move-Item "$MMB\node-$NODE_VER-win-x64" "$MMB\node" -Force }
    & "$MMB\node\node.exe" --version
}

# 5. 写 .env（注入密钥，不含 CVM 密码）
Write-Output "== 5. 写 .env =="
$envText = @"
QUEUBEE_BASE_URL=https://data-api.qeubee.cn/sumscope/common/mcp/stream
QUEUBEE_X_ACCESS_KEY=$qkey
WIND_API_KEY=$wkey
WIND_ALICE_TOKEN=$wkey
MMB_HOST=0.0.0.0
MMB_PORT=8765
MMB_REFRESH_MIN=30
"@
Set-Content -Path "$MMB\.env" -Value $envText -Encoding UTF8

# 6. 编译 mmb_svc.exe（C# Windows 服务宿主）
Write-Output "== 6. 编译 mmb_svc.exe =="
$csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64','C:\Windows\Microsoft.NET\Framework' `
        -Recurse -Filter csc.exe -ErrorAction SilentlyContinue `
        | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $csc) { Write-Error "找不到 csc.exe（需 .NET Framework）"; exit 1 }
& $csc.FullName /target:exe /out:"$MMB\mmb_svc.exe" /r:System.ServiceProcess.dll "$MMB\mmb_svc.cs" 2>&1 | Out-String
if (-not (Test-Path "$MMB\mmb_svc.exe")) { Write-Error "编译失败"; exit 1 }

# 7. 注册并启动 Windows 服务
Write-Output "== 7. 注册服务 MMB_Workbench =="
sc.exe delete MMB_Workbench 2>$null
Start-Sleep -Seconds 1
sc.exe create MMB_Workbench binPath= "$MMB\mmb_svc.exe" DisplayName= "MMB Workbench" start= auto obj= LocalSystem
sc.exe description MMB_Workbench "本币货币债券工作台 HTTP 服务 (8765)，开机自启+崩溃重启" 2>$null
Start-Sleep -Seconds 1
sc.exe start MMB_Workbench

# 8. 防火墙放行 8765
Write-Output "== 8. 放行 8765 入站 =="
if (-not (Get-NetFirewallRule -DisplayName 'MMB_Workbench_8765' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'MMB_Workbench_8765' -Direction Inbound -Protocol TCP `
        -LocalPort 8765 -Action Allow -ErrorAction SilentlyContinue
}

# 9. 探活
Start-Sleep -Seconds 6
try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/api/status' -UseBasicParsing -TimeoutSec 10
    Write-Output "    status $($r.StatusCode): $($r.Content.Substring(0,[Math]::Min(160,$r.Content.Length)))"
} catch { Write-Warning "API 探活失败: $_ （服务可能仍在启动，稍后访问 http://127.0.0.1:8765/ 确认）" }

Write-Output ""
Write-Output "=== DEPLOY DONE ==="
Write-Output "下一步：腾讯云 Lighthouse 控制台「防火墙」放行 TCP 8765 入站，"
Write-Output "然后浏览器访问 http://<你的CVM公网IP>:8765/"
