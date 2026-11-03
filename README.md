# Nexus Downloader (MVP)

把 Nexus Mods 的下载请求交给 Internet Download Manager（IDM）的小工具。

当前版本是一个**可运行的最小闭环**：

```
Nexus 文件页 / 浏览器下载
        │
        ▼
Chrome/Edge 扩展（Content Script + Service Worker）
        │  捕获 chrome.downloads.onCreated
        ▼
本地桥接（Node，127.0.0.1:38765）
        │  校验 URL、清洗文件名
        ▼
IDM（IDMan.exe /n /d ... /p ... /f ...）
        │
        ▼
downloads/ 目录
```

> 为什么 MVP 用本地桥接而不是 Native Messaging？
> `native-host/` 里的原生消息宿主已经实现并通过了 Chrome/Edge 的握手与 ping 测试，
> 但在本机的 IDM 6.42b63 上，**由 Chrome 原生宿主进程链启动的 IDM 会静默忽略命令行**
> （同样的参数从普通 Node 进程调用则正常）。为了让 MVP 能稳定下载，扩展默认走
> `127.0.0.1` 的本地桥接；原生宿主代码保留在 `native-host/`，方便后续替换或调试。

## 已验证环境

- Windows 11
- Node.js 24.9.0
- IDM 6.42b63（`C:\Program Files (x86)\Internet Download Manager\IDMan.exe`）
- Edge 157 / Chrome 156（扩展手动“加载已解压的扩展程序”）

实测链路：Edge 扩展 → 本地桥接 → IDM，成功下载测试文件；
Nexus 真实下载需要你本机浏览器已登录 Nexus，扩展会截获最终 CDN 链接。

## 目录

```
extension/                 Chrome/Edge MV3 扩展
  background.js            捕获下载、取消浏览器下载、发送到桥接
  content.js               Nexus 页面右下角 toast
  popup.html/js/css        状态、手动发送、最近记录
  manifest.json            固定扩展 ID（key）

bridge/
  server.js                本地 HTTP 桥接（唯一需要常驻的进程）
  start.ps1                启动桥接（已在运行则直接返回）
  install-autostart.ps1    创建开机启动快捷方式并启动

native-host/               可选 / 实验性的 Native Messaging 宿主
  host.js                  协议实现、URL 校验、IDM 命令行
  launcher/NexusHost.cs    原生消息宿主的 exe 启动器
  install.ps1              编译并注册 Chrome/Edge 原生宿主

tools/
  configure-idm.ps1        关闭 IDM 的开始/完成确认弹窗（可回滚）
  restore-idm.ps1          还原 IDM 原始设置
  test-bridge.js           不开浏览器，直接测试桥接
  test-host.js             直接测试原生宿主协议
  gen-extension-key.js     生成固定扩展 ID 的 key
  make-icons.py            生成图标

downloads/                 IDM 下载落盘目录
```

## 快速开始

### 1. 关闭 IDM 的确认弹窗（推荐，可回滚）

IDM 6.42 的 `/n` 不会覆盖“开始下载确认 / 下载完成提示”。不关掉的话，每次下载都会停在
IDM 弹窗等你点确认。

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\configure-idm.ps1
```

脚本会先备份原始值到 `tools/idm-settings-backup.json`，然后设置：

| 值 | 新值 | 作用 |
| --- | --- | --- |
| `StartDlgShowing` | `0` | 不显示“开始下载”对话框 |
| `ComplDlgShowing` | `0` | 不显示“下载完成”提示 |
| `startImmediately` | `1` | 立即开始 |

还原：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\restore-idm.ps1
```

### 2. 启动本地桥接（并设置开机启动）

```powershell
powershell -ExecutionPolicy Bypass -File .\bridge\install-autostart.ps1
```

只启动、不设置开机启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\bridge\start.ps1
```

确认桥接正常：

```powershell
node tools\test-bridge.js ping
```

应返回 `"ok": true`、`idmExists: true` 和下载目录。

### 3. 加载扩展

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 打开右上角“开发者模式”
3. 点“加载已解压的扩展程序”，选择本仓库的 `extension/` 目录
4. 确认扩展 ID 为 `hmbgeaflhfjfabnbllcbnicelnbamooh`（`manifest.json` 里的 `key` 固定了它）

> 如果之前加载过旧版本，改完代码后点扩展卡片上的“重新加载”。

### 4. 在 Nexus 下载一个 Mod

1. 浏览器里登录 Nexus Mods
2. 打开任意 Mod 的 **Files** 页
3. 点某个文件的 **Download / Slow download**
4. 浏览器开始下载后，扩展会：
   - 取消 Chrome/Edge 自己的下载
   - 把最终 CDN 链接发给桥接
   - 由 IDM 下载到 `downloads/`
5. Nexus 页面右下角出现“已交给 IDM：xxx”的 toast；扩展弹窗里也能看到记录

如果 IDM 的浏览器扩展（IDM Integration Module）抢先接管了下载，本扩展可能收不到
`chrome.downloads.onCreated`。两种处理方式：

- 在 `chrome://extensions` 里暂时关闭 **IDM Integration Module**；或
- 在 IDM 的“选项 → 文件类型/站点”里把 Nexus 加入不接管的例外。

### 手动发送

弹窗里可以直接粘贴一个直链（例如 Nexus 的 `cf-files.nexusmods.com/cdn/...` 链接），
填写可选文件名，点“发送”。适合排查问题或下载其它直链。
默认只允许 `nexusmods.com` / `nexus-cdn.com`，可在 `native-host/config.json` 修改。

## 配置

桥接和原生宿主共用 `native-host/config.json`（仓库里只提交 `config.example.json`，本机 `config.json` 被 `.gitignore` 忽略；`install.ps1` / 手动复制示例即可生成）：

```json
{
  "idmPath": "C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe",
  "downloadDir": "I:\\Program Files (x86)\\Code\\NexusDownloader\\downloads",
  "allowedHosts": ["nexusmods.com", "nexus-cdn.com"],
  "allowAnyHost": false,
  "silent": true,
  "dryRun": false
}
```

- `downloadDir`：IDM 保存目录
- `allowedHosts`：允许交给 IDM 的域名（含子域名）
- `allowAnyHost`：`true` 时允许任意 http(s) 域名（仅测试用）
- `dryRun`：只记录命令，不真正启动 IDM
- `silent`：给 IDM 加 `/n`

改完配置后重启桥接（结束 `node bridge/server.js`，再运行 `bridge/start.ps1`）。

## 测试

不开浏览器，直接测桥接：

```powershell
# 先确保桥接在运行
node tools\test-bridge.js ping

# 测试任意公网文件（需要桥接以 NEXUS_BRIDGE_ALLOW_ANY=1 启动，或把域名加入 allowedHosts）
node tools\test-bridge.js download "https://www.example.com/" example.html
```

测试原生宿主（可选，不经过扩展）：

```powershell
node tools\test-host.js ping
node tools\test-host.js download "https://www.example.com/" example.html --exe
```

## 已知限制 / 注意点

1. **IDM 弹窗**：不运行 `configure-idm.ps1` 时，IDM 可能在“开始下载”或“下载完成”处等待确认，
   表现为扩展日志显示“已交给 IDM”但文件迟迟不出现。
2. **原生宿主链路**：本机 IDM 6.42 对 Chrome 原生宿主启动的命令行有兼容性问题，
   因此扩展默认走桥接；`native-host/` 仅作参考实现保留。
3. **Nexus 登录**：扩展只截获浏览器已经生成的最终 CDN 链接，不保存账号密码；
   免费账号需要先在浏览器里完成等待/点击流程。签名 CDN 链接通常不需要 Cookie。
4. **重复链接**：IDM 默认可能跳过相同 URL 的重复下载；Nexus 每次生成的链接通常唯一。
5. **本地桥接无鉴权**：只监听 `127.0.0.1`，适合个人本机使用；不要暴露到局域网/公网。
6. **扩展 ID 变更**：如果重新生成 `manifest.json` 的 `key`，需要同步更新原生宿主的
   `allowed_origins`（重新运行 `native-host/install.ps1`；桥接方式不受影响）。

## 卸载 / 还原

1. 在 `chrome://extensions` / `edge://extensions` 移除扩展
2. 删除开机启动快捷方式：
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Nexus Downloader Bridge.lnk`
3. 还原 IDM 设置：`powershell -ExecutionPolicy Bypass -File .\tools\restore-idm.ps1`
4. 如果注册过原生宿主：`powershell -ExecutionPolicy Bypass -File .\native-host\uninstall.ps1`
5. 删除 `downloads/`、`bridge/bridge.log`、`native-host/logs/` 即可

## 日志

- 桥接：`bridge/bridge.log`（JSON lines）
- 原生宿主：`native-host/logs/host.log`
- 扩展：弹窗里的“最近记录”（存在 `chrome.storage.local`，最多 20 条）
