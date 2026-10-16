# 本币货币债券工作台 —— CVM 端一次性初始化脚本
# 用法：在云服务器（重装后的 Windows）上「以管理员身份运行 PowerShell」，粘贴执行本文件。
# 作用：开启 WinRM（供你本机的 deploy.py 通过 pywinrm 连接）+ 放行 5985 防火墙。
# 注意：deploy.py 用的是 NTLM 原始协议，不需要在本机配置 TrustedHosts。

$ErrorActionPreference = 'Stop'

Write-Output "== 1. 开启 WinRM =="
Enable-PSRemoting -Force | Out-Null
# 允许 HTTP(5985) 上的 NTLM 连接（pywinrm transport=ntlm）
Set-Item -Path WSMan:\localhost\Service\Auth\Basic -Value $false -ErrorAction SilentlyContinue
Set-Item -Path WSMan:\localhost\Service\AllowUnencrypted -Value $true -ErrorAction SilentlyContinue

Write-Output "== 2. 防火墙放行 5985 (WinRM) =="
New-NetFirewallRule -DisplayName 'WinRM-HTTP-5985' -Direction Inbound -Protocol TCP -LocalPort 5985 -Action Allow -ErrorAction SilentlyContinue

Write-Output "== 3. 检查 Python 3.13 =="
if (-not (Test-Path 'C:\Program Files\Python313\python.exe')) {
    Write-Warning "未检测到 C:\Program Files\Python313\python.exe。请先安装 Python 3.13 并勾选 Add to PATH，再运行 deploy.py。"
} else {
    & 'C:\Program Files\Python313\python.exe' --version
}

Write-Output ""
Write-Output "WinRM 已就绪（端口 5985）。现在回到你本机："
Write-Output "  1) pip install -r requirements.txt"
Write-Output "  2) 复制 .env.example 为 .env 并填写 CVM_IP/CVM_USER/CVM_PASS + 两个 API Key"
Write-Output "  3) python deploy.py"
