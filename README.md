# Nexus Downloader

把 Nexus Mods 的下载交给 Internet Download Manager（IDM）。

本项目由三部分组成：

| 组件 | 作用 | 运行位置 |
|---|---|---|
| Chrome / Edge 扩展 | 在 Nexus 页面内拦截下载、换取签名 CDN 直链、提供合集下载面板 | 浏览器 |
| 本地 Node 桥接 | 校验链接与目标目录，调用 IDM 命令行 | 本机 `127.0.0.1:38765` |
| Internet Download Manager | 真正下载文件 | 本机 |

```
Chrome/Edge 扩展  ──HTTP──▶  本地 Node 桥接  ──命令行──▶  IDM  ──▶  下载目录
（页面内换直链）              127.0.0.1:38765           IDMan.exe
```

三者都跑在本机，不需要自建服务器、数据库或 API Key。桥接只监听回环地址。

> 当前版本 **v0.3.1**，面向 Windows。单文件一键下载和合集批量下载都可用，Nexus 免费账号即可。

## 功能

- **文件页一键下载**：在 Mod 的 Files 页点 **Manual download**，扩展在页面内换直链后直接交给 IDM，不打开新标签页、不弹浏览器下载框。
- **合集批量下载**：打开合集页，右下角面板列出全部 mod；可多选、限速下发、按合集建目录、自动去重、断点续跑。
- **兜底接管**：浏览器自己发起的 Nexus 下载也会被取消并转交 IDM（可在扩展弹窗关闭）。
- **手动发送**：在扩展弹窗粘贴 Nexus/CDN 直链直接交给 IDM，便于排查。
- **不绕过人机验证**：遇到 Cloudflare 会暂停并提示你完成验证，不会假装成功。

## 前置条件

| 依赖 | 版本要求 | 用途 |
|---|---|---|
| Windows | Windows 10 / 11（实测 Windows 11） | 桥接、IDM 和 PowerShell 脚本的运行环境 |
| Chrome 或 Edge | Chromium 109+（实测 Edge 157 / Chrome 156） | 加载 MV3 扩展 |
| Node.js | 18+（实测 24.9.0） | 运行本地桥接和测试脚本 |
| Internet Download Manager | 6.x（实测 6.42b63） | 实际下载 |
| PowerShell | 5.1+（Windows 自带） | 启动桥接、配置 IDM |
| Nexus Mods 账号 | 免费账号即可 | 页面内换直链需要登录态；扩展不保存账号密码 |

`native-host/` 是可选的实验性 Native Messaging 宿主，**主流程不需要安装**，也不需要 Nexus API Key。按下面的三步安装 IDM、桥接和扩展即可。

## 安装

按组件安装，每一步都能单独验证。以下命令都在仓库根目录执行。

### 1. 安装并配置 IDM

1. 安装 IDM，确认 `IDMan.exe` 的位置。默认是：
   `C:\Program Files (x86)\Internet Download Manager\IDMan.exe`
2. 先启动一次 IDM，让它写好注册表设置。
3. 推荐关闭 IDM 的“开始下载 / 下载完成”弹窗。否则桥接虽然把任务交给了 IDM，IDM 会停在弹窗等你确认，看起来像“没开始下载”。

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\configure-idm.ps1
```

脚本会先把原值备份到 `tools/idm-settings-backup.json`，再关闭两个确认弹窗并让命令行任务立即开始。需要还原时运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\restore-idm.ps1
```

**独立验证**：确认 `IDMan.exe` 存在。

```powershell
Test-Path 'C:\Program Files (x86)\Internet Download Manager\IDMan.exe'
```

返回 `True` 即可。返回 `False` 说明路径不对，请按实际安装位置修改下一步的 `idmPath`。

### 2. 启动本地桥接

桥接是一个普通 Node 进程，默认监听 `http://127.0.0.1:38765`。

1. 创建配置：

```powershell
Copy-Item .\native-host\config.example.json .\native-host\config.json
```

如果已经有 `config.json`，跳过这一步，直接编辑现有文件。

2. 编辑 `native-host/config.json`，至少把 `downloadDir` 和 `collectionRoot` 改成你自己的实际目录（不要保留 `YourName`）：

```json
{
  "idmPath": "C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe",
  "downloadDir": "C:\\Users\\YourName\\Downloads\\Nexus",
  "collectionRoot": "C:\\Users\\YourName\\Downloads\\Nexus\\Collections",
  "allowedHosts": ["nexusmods.com", "nexus-cdn.com"]
}
```

- `idmPath`：`IDMan.exe` 的实际路径。
- `downloadDir`：单文件下载目录。
- `collectionRoot`：合集目录的根；建议显式填写，避免和单文件目录混在一起。
- `allowedHosts`：允许交给 IDM 的域名，保持默认即可。

> `config.json` 是本机文件，已被 `.gitignore` 忽略，不会提交。修改后必须重启桥接才会生效。

3. 启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\bridge\start.ps1
```

4. **独立验证**：

```powershell
node .\tools\test-bridge.js ping
```

正常输出类似：

```json
{
  "ok": true,
  "bridge": "0.3.1",
  "idmPath": "C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe",
  "idmExists": true,
  "downloadDir": "C:\\Users\\YourName\\Downloads\\Nexus",
  "collectionRoot": "C:\\Users\\YourName\\Downloads\\Nexus\\Collections",
  "allowAnyHost": false,
  "dryRun": false,
  "silent": true
}
```

看到 `"ok": true` 和 `"idmExists": true`，说明桥接进程和 IDM 路径都没问题。

**可选：开机自动启动**

```powershell
powershell -ExecutionPolicy Bypass -File .\bridge\install-autostart.ps1
```

它会在 Windows 启动目录创建 `Nexus Downloader Bridge.lnk`，然后立即启动桥接。移动仓库目录后需要重新运行。

> 如果端口上已经有一个旧版本桥接，`start.ps1` 会提示。用 `.\bridge\start.ps1 -Restart` 结束旧进程并重启。

### 3. 加载浏览器扩展

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 打开右上角 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择仓库里的 `extension/` 目录。
4. 确认扩展 ID 是 `hmbgeaflhfjfabnbllcbnicelnbamooh`（`manifest.json` 里的 `key` 固定了它）。
5. 建议把扩展固定到工具栏，方便看状态。

**独立验证**：点扩展图标，弹窗顶部应显示：

- 本地桥接：**已连接**
- IDM：**已找到**
- 保存到 / 合集根目录：显示你在 `config.json` 里配置的路径

如果显示“未连接”，先回到第 2 步确认桥接在运行，再点弹窗底部的“刷新状态”。

> 重新加载扩展后，已经打开的 Nexus 页面不会自动注入新脚本，需要刷新页面。桥接代码改动后要重启桥接，扩展“重新加载”不会重启它。

## 联调：确认三层真的接上了

这一节是从“装好了”到“能下载”的关键，建议按顺序走一遍。

### 连接关系

```
Chrome/Edge 扩展  ──HTTP──▶  本地 Node 桥接  ──命令行──▶  IDM
   页面内换直链              127.0.0.1:38765          IDMan.exe /n /d ... /p ...
```

- **桥接必须先启动**，扩展才能连接。扩展不会自己拉起桥接。
- 扩展里的桥接地址是**固定写死**的 `http://127.0.0.1:38765`。**没有“填写服务器地址”的设置项**，也不需要在弹窗里填 `http://localhost:3000` 之类的地址。
- **没有首次配对 / 授权流程**：桥接只监听回环地址、无鉴权，扩展直接连。也正因如此，不要把 38765 端口暴露到局域网或公网。
- 换直链发生在 Nexus 页面内，使用你当前浏览器的登录 Cookie；扩展不保存 Nexus 账号密码。
- 一般不建议改端口；如果改了 `NEXUS_BRIDGE_PORT`，扩展也要同步修改并重新加载，否则连不上。

### 三层自检

| 检查项 | 操作 | 正常表现 |
|---|---|---|
| 桥接进程 | `node .\tools\test-bridge.js ping` | `"ok": true`、`"idmExists": true` |
| 扩展 → 桥接 | 点扩展图标 | “已连接”“IDM 已找到” |
| 扩展 → Nexus | 登录 Nexus，打开任意 Mod 的 Files 页 | 扩展图标可用，页面正常显示 |
| 端到端 | 点一次 **Manual download** | toast 显示“已交给 IDM”，`bridge\bridge.log` 出现 `spawned`，文件落到 `downloadDir` |

### 最小验证路径（单文件）

1. 启动桥接：`.\bridge\start.ps1`。
2. 加载或刷新扩展，点图标确认“已连接”。
3. 浏览器登录 Nexus Mods。
4. 打开一个 Mod 的 **Files** 页。
5. 点某个文件行的 **Manual download**。
6. 预期：
   - 不打开新标签页，不弹浏览器下载确认；
   - 页面右下角出现“已交给 IDM：文件名”；
   - 扩展弹窗的“最近记录”多一条；
   - 桥接日志出现新的 `spawned` 记录。

查看桥接日志：

```powershell
Get-Content .\bridge\bridge.log -Tail 5
```

应包含类似这一行（文件名和目录以你的实际值为准）：

```json
{"event":"spawned","filename":"Some Mod-1234-1-0.zip","dir":"C:\\Users\\YourName\\Downloads\\Nexus"}
```

然后确认 IDM 里有任务，文件最终出现在 `downloadDir`。

### 最小验证路径（合集）

1. 打开任意合集页：`https://www.nexusmods.com/games/<game>/collections/<slug>`。
2. 右下角应出现合集面板，列出全部 mod。
3. 先勾选 1–2 个**小文件**，点“下载选中”。
4. 面板日志应出现“已下发，等待落盘”“已落盘”之类的记录；文件出现在 `collectionRoot\<合集名 [slug]>\`。
5. 等文件落盘后点“刷新列表”：该项应标记为“磁盘已存在”并默认不勾选；它不会被自动重下。
   要真的覆盖，点该行右侧的“重下”（会先确认，再删除同名旧文件重新下载）。

合集是按固定间隔下发、限制同时在途数量的，不要一上来全选几百个来试。先用小样本确认链路，再跑大批量。

## 日常使用

### 文件页

登录 Nexus 后打开任意 Mod 的 **Files** 页，点文件行的 **Manual download**。扩展会当场完成换链接并交给 IDM，页面右下角出现 toast。

- **Slow download / Fast download** 也会被拦截，不会跳到浏览器的下载页。
- **Vortex / Mod manager** 按钮和 `nxm://` 链接完全放行。
- 按住 **Ctrl / Cmd / Shift / Alt** 点击时放行，保留浏览器“新标签打开”的行为。
- 如果直链解析失败，toast 会提供“打开下载页”兜底；该页面会自动再试一次，不需要手点 Slow download。

### 合集页

打开 `https://www.nexusmods.com/games/<game>/collections/<slug>`，右下角会出现面板：

- **选择**：单个勾选、全选 / 全不选 / 反选 / 仅缺。
- **下发节奏**：默认每 5 秒下发一个链接，同时最多 2 个文件处于下载中（面板可调，并发 1–5）。
  不按文件大小估算速度——网速快慢只影响下载本身，不影响配置。
- **去重**：磁盘已有、扩展下发过、IDM 历史有记录都算重复；默认**不勾选、也不下载**重复项。
- **同名文件默认不重复下载**：不会生成 `… (2).zip`。需要覆盖时，在重复项对话框里选“覆盖下载”，
  或在该行点“重下”；两者都会先确认，再删除同名旧文件重新下发。
- **断点续跑**：进度存在浏览器本地；刷新页面或第二天再打开会提示恢复，已完成项不重下。
- **同步状态**：交给 IDM 后，面板每 5 秒批量检查目标目录，文件出现就标完成；也可以手动点“同步状态”。
- **设置**：面板右上角 ⚙ 可调下发间隔、最大同时下载数、重复策略、是否自动打开验证页。
- **限速 / 验证**：遇到 429 会全体冷却；遇到人机验证会停在那一条，打开 mod 页让你完成验证，通过后自动续跑。

合集下载期间请保留这个标签页（不要关闭），切到后台也可以（后台会放慢节奏）。免费账号 + 限速换链接：100 个 mod 大约 8–10 分钟下发完，实际完成时间看网速和 IDM 队列。

### 扩展弹窗

- 查看桥接 / IDM / 下载目录状态。
- 开关“启用接管”“点 Manual download 直接下载”“自动拦截 Nexus 下载”。
- 手动粘贴直链发送到 IDM（默认只接受 `nexusmods.com` / `nexus-cdn.com`，可在 `config.json` 的 `allowedHosts` 修改）。
- 查看最近记录；解析失败时点“复制诊断”获取页面诊断信息。

## 配置

配置文件是 `native-host/config.json`，从 `native-host/config.example.json` 复制而来，已被 `.gitignore` 忽略。

| 键 | 默认值 | 说明 |
|---|---|---|
| `idmPath` | `C:\Program Files (x86)\Internet Download Manager\IDMan.exe` | IDM 可执行文件 |
| `downloadDir` | 仓库下的 `downloads\` | 单文件下载目录 |
| `collectionRoot` | 仓库下的 `downloads\Collections` | 合集根目录；建议显式配置 |
| `allowedHosts` | `["nexusmods.com", "nexus-cdn.com"]` | 允许交给 IDM 的域名（含子域名） |
| `allowAnyHost` | `false` | 允许任意 http(s) 域名，仅测试用 |
| `silent` | `true` | 给 IDM 加 `/n`，不弹主窗口 |
| `dryRun` | `false` | 只写日志，不真正启动 IDM |

修改配置后重启桥接：先结束端口上的桥接进程（命令见下文“卸载 / 清理”第 2 步），再运行 `.\bridge\start.ps1`。`start.ps1 -Restart` 只用于把旧版本换成新版本，同一版本不会强制重启。完整的配置项、环境变量和桥接接口见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第 6 节。

## 常见故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 扩展弹窗显示“本地桥接：未连接” | 桥接没启动、端口被占、Node 不在 PATH | 运行 `.\bridge\start.ps1`；`node .\tools\test-bridge.js ping`；检查 38765 端口 |
| 弹窗显示“IDM：未找到” | `config.json` 里的 `idmPath` 不对 | 改成 `IDMan.exe` 的实际路径，重启桥接 |
| toast 说“已交给 IDM”，但文件不出现 | IDM 在等确认弹窗；IDM 队列慢；IDM 扩展抢了下载 | 运行 `tools\configure-idm.ps1`；在 IDM 队列里查看；暂时关闭 IDM Integration Module |
| toast 说“没有找到 file_id” | 页面结构变了，或扩展重载后没刷新页面 | 刷新 Nexus 页面；点弹窗“复制诊断”；见开发文档第 4 节 |
| toast 说“Nexus 没有返回下载链接” | 未登录、Cloudflare 验证、免费账号限速 | 登录 Nexus；完成页面验证；等一会儿再点 |
| 下载文件名是 UUID 或没有扩展名 | 旧桥接仍在强传 `/f`，或 CDN 链接本身没有文件名 | `.\bridge\start.ps1 -Restart` 重启桥接，让 IDM 按服务器返回的文件名命名 |
| 合集面板提示“桥接版本过旧” | 旧 `node bridge\server.js` 还在运行 | `.\bridge\start.ps1 -Restart`，然后刷新合集页 |
| 合集停在“限速冷却” | Nexus 返回 429 | 等冷却结束；在面板设置里把“下发间隔”调大、降低“最大同时下载数” |
| 合集停在“需要验证” | Cloudflare 人机验证 | 在自动打开的 mod 页完成验证；通过后会自动继续，30 分钟未通过会停 |
| 页面按钮点了没反应 | 扩展被禁用、广告拦截插件或页面脚本报错 | 确认扩展已启用；对 Nexus 暂停广告拦截；按 F12 看 Console |
| 启动桥接报端口占用 | 38765 被其他进程占用 | 用 `Get-NetTCPConnection -LocalPort 38765 -State Listen` 查 `OwningProcess`，结束该进程后再启动（完整命令见“卸载 / 清理”） |
| 合集列表读不到 | Nexus 合集接口字段变化或网络错误 | 运行 `node .\tools\print-collection.js <game> <slug>` 定位；见开发文档第 4.8 节 |

### 日志位置

| 位置 | 内容 |
|---|---|
| `bridge\bridge.log` | 桥接收到的请求（JSON lines）。只有真正发到桥接的请求才会写这里 |
| 扩展弹窗 → 最近记录 / 复制诊断 | 点击结果、失败原因、页面 DOM 诊断 |
| 合集面板 → 日志 | 换链接、下发、落盘、限速、验证，最近 200 条 |
| Nexus 页面 F12 Console | 搜 `[NexusDownloader]`，可看页面内解析失败详情 |
| 扩展 Service Worker | `chrome://extensions` → 扩展卡片 →“检查视图” |
| `native-host\logs\host.log` | 仅在使用实验性 Native Host 时产生 |

## 卸载 / 清理

1. 在 `chrome://extensions` 或 `edge://extensions` 移除扩展。
2. 停止桥接。用端口找到进程并结束：

```powershell
$conn = Get-NetTCPConnection -LocalPort 38765 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force }
```

3. 删除开机启动快捷方式：
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Nexus Downloader Bridge.lnk`
4. 如果运行过 `configure-idm.ps1`，还原 IDM 设置：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\restore-idm.ps1
```

5. 如果注册过实验性 Native Host：

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\uninstall.ps1
```

6. 按需删除数据：`downloads\`（已下载文件）、`bridge\bridge.log`、`native-host\logs\`、`native-host\config.json`、`tools\idm-settings-backup.json`。

## 项目结构

```
extension/        Chrome/Edge MV3 扩展（页面拦截、合集面板、弹窗）
bridge/           本地 Node 桥接（HTTP API、调用 IDM）
native-host/      实验性 Native Messaging 宿主，主流程不用
tools/            IDM 配置、桥接测试、纯函数单测、合集列表打印
downloads/        默认下载目录
docs/             开发文档
```

## 开发文档

维护、二次开发、排查 Nexus 页面变化，请看：

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)：架构、数据流、消息/桥接契约、Nexus 页面与接口细节、测试矩阵、发布清单。
- [docs/COLLECTIONS.md](docs/COLLECTIONS.md)：合集批量下载的需求、GraphQL 设计、去重策略、限速与风险记录。

## 使用边界

- 不绕过 Cloudflare 或人机验证，也不代替你登录 Nexus。
- 不接管 Vortex / `nxm://` 交接，不生成 Mod Organizer 2 的 `.meta`。
- 不自动解压，也不按 mod 自动建子目录。
- **不会重复下载同名文件**：目标目录已有同名文件时直接跳过，不生成 `(2)`、`(3)`。
  只有你在重复项对话框里选“覆盖下载”，或在该行点“重下”并确认后，才会删除同名旧文件再重新下载。
- 桥接无鉴权，只监听 `127.0.0.1`，不要暴露到局域网或公网。

## License

本项目采用 MIT License，详见 [LICENSE](LICENSE)。

> 项目由 DeepSeek Harness 生成并迭代（MVP v1 → v0.3.1）。
