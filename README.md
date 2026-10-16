# 本币货币债券工作台 · 云端部署仓库

把「货币债券工作台」完整部署到腾讯云 CVM（Windows）的可一键重装仓库。
重装系统后，按本文档 3 步即可让云端站点、实时数据（森浦 Qeubee + Wind Alice）全部恢复。

> 本仓库**不含任何密钥**：密码与 API Key 只在 `.env.example` 占位，请在你本机用 `.env` 填写（已被 `.gitignore` 忽略）。

---

## 一、云端架构（重装后长这样）

| 组件 | 说明 |
|------|------|
| `C:\mmb\server.py` | HTTP 服务，监听 `0.0.0.0:8765`，提供 `/`、`/assets/*`、`/api/bundle`、`/api/live`、`/api/status` |
| `C:\mmb\bridge.py` | 每 30 分钟自刷新：Qeubee 取回购/IRS，Wind Alice MCP 取回购利率，写入 `data/live.json` |
| `C:\mmb\mmb_svc.exe` | 由 `mmb_svc.cs` 编译的 **C# Windows 服务**（服务名 `MMB_Workbench`，SYSTEM 开机自启 + 崩溃重启） |
| `C:\mmb\node\node.exe` | Wind Alice MCP CLI（`wind-mcp-skill/cli.mjs`）运行依赖 |
| `C:\mmb\.env` | 注入的 Qeubee / Wind 密钥（部署时由本机 `.env` 写入） |

URL 布局与本机完全一致：`/`、`/api/bundle`、`/api/live`、`/api/status`。

---

## 二、前置（只需一次）

1. 腾讯云 Lighthouse 实例已是 **Windows**（Server 2012 R2 及以上均可），已设管理员密码。
2. 你**本机**已装 Python 3（用来跑 `deploy.py`）并能访问公网（装 `pywinrm`）。

---

## 三、重装后 3 步还原

### 第 1 步：CVM 端开启远程管理
登录云服务器控制台（VNC/RDP），**以管理员身份运行 PowerShell**，执行：
```powershell
# 直接把 setup_cvm.ps1 内容粘贴执行，或：
iex ((New-Object System.Net.WebClient).DownloadString('<本仓库 raw/setup_cvm.ps1 的地址>'))
```
脚本会：开启 WinRM、放行 5985 防火墙、检查 Python 3.13。
> 若提示缺 Python 3.13，先到 python.org 安装并勾选 "Add to PATH"。

### 第 2 步：本机准备
```bash
git clone <本仓库地址> mmb-cloud && cd mmb-cloud
pip install -r requirements.txt
cp .env.example .env          # 然后编辑 .env，填入 CVM_IP / CVM_USER / CVM_PASS 与两个 API Key
```

### 第 3 步：一键部署
```bash
python deploy.py
```
脚本自动完成：上传全部文件 → 写远端 `.env`（注入密钥）→ 安装 Node → 编译 C# 服务 → 注册并启动 `MMB_Workbench` → 放行 8765 → 探活验证。

### 第 4 步：放行公网端口
到**腾讯云 Lighthouse 控制台 → 防火墙**，新增规则：**TCP 8765 入站**。
然后浏览器访问 `http://<CVM_IP>:8765/`。

---

## 四、验证云端实时

- 站点：`http://<CVM_IP>:8765/` 返回页面（200）
- 状态：`/api/status` 返回 `{"wind":"ok","qeubee":"ok",...}`
- 数据：`/api/live` 中 `funding_rates.src == "WindAlice"`、`updated_at` 为最新时间

---

## 五、关键事实 / 踩坑记录（避免再走弯路）

1. **Wind Alice 不是 REST**，是「远端 MCP(`mcp.wind.com.cn`) + 本地 Node CLI(`wind-mcp-skill/cli.mjs`)」。`bridge.py` 用 `subprocess` 调 `node cli.mjs call ...`，不能用 REST URL 直连。
2. **不要用「计划任务」做自启**：该 WinRM/2012R2 环境下 `Register-ScheduledTask` 必报 `transaction no longer active`（连最小任务都失败）。已改用 C# Windows 服务 `MMB_Workbench` 托管，更稳。
3. **文件传输限制**：该 WinRM 服务端 stdin 流不可靠、`powershell -encodedcommand` 受 ~32K 命令行上限约束。故 `deploy.py` 用 gzip+base64 分片 + SHA256 校验上传。
4. **PyWinRM 约定**：本机 venv 装的是 pywinrm 0.5.0，模块名是 `winrm`（`import winrm`），不是 `pywinrm`。
5. **Wind MCP 覆盖**：回购利率(DR001/DR007/R001/R007/R014) Wind 可真·实时取；IRS(FR007 1Y/5Y) 不在其工具范围，继续由 **森浦 Qeubee** 实时提供。两者都真实实时。
6. **额度**：每次刷新约 5 次 Wind 调用，消耗 Wind Alice 额度；要省可减序列或拉长刷新周期（`.env` 的 `MMB_REFRESH_MIN`）。

---

## 六、文件清单

| 文件 | 作用 |
|------|------|
| `server.py` / `bridge.py` | 服务主程序 / 数据刷新桥接 |
| `web/` | 前端页面与静态资源 |
| `data/` | 预置底稿数据（`bundle.json` 等，非密钥） |
| `wind-mcp-skill/` | Wind Alice MCP CLI（cli.mjs + references，无需 node_modules） |
| `mmb_svc.cs` | C# Windows 服务源码（csc.exe 编译为 mmb_svc.exe） |
| `deploy.py` | 一键部署脚本（本机运行，读取 `.env`） |
| `setup_cvm.ps1` | CVM 端初始化（开启 WinRM + 防火墙） |
| `.env.example` | 配置模板 |
| `requirements.txt` | 本机依赖（pywinrm） |
