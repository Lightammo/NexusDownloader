# Nexus Downloader (MVP)

把 Nexus Mods 的下载请求交给 Internet Download Manager（IDM）的小工具。

> 本项目由 DeepSeek Harness 生成（MVP v1；v0.2 增加“点 Manual download 直接下载”；v0.3 增加“合集批量下载”）。

当前版本是一个**可运行的最小闭环**：

```
Nexus 文件页点 Manual download
        │  扩展在页面内截获（不打开新标签页）
        ▼
Content Script（读取 file_id / 页面文件数据）
        │  在已登录的页面里请求 Nexus 的 GenerateDownloadUrl
        ▼
Service Worker → 本地桥接（Node，127.0.0.1:38765）
        │  校验 URL、清洗文件名
        ▼
IDM（IDMan.exe /n /d ... /p ... /f ...）
        │
        ▼
downloads/ 目录
```

浏览器自己发起的 Nexus 下载仍会被兜底捕获：

```
chrome.downloads.onCreated → 取消浏览器下载 → 本地桥接 → IDM
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
  background.js            转发下载、解析 game_id、记录事件、合集 GraphQL / 去重 / 台账
  content.js               点击拦截、页面内解析 CDN 直链、右下角 toast
  collection.js            【v0.3】合集页面板：列表、多选、队列、节奏、限速、验证恢复
  lib/nexus-utils.js       纯函数：file_id / 文件 JSON / 下载响应解析
  lib/collection-utils.js  【v0.3】纯函数：合集路径 / 归一化 / 命名 / 去重身份
  lib/queue-pacing.js      【v0.3】纯函数：下发等待、退避、Retry-After、共享冷却
  lib/file-link.js         【v0.3】按 fileId 换直链（一键下载与合集共用）
  popup.html/js/css        状态、开关、手动发送、最近记录
  manifest.json            固定扩展 ID（key）

bridge/
  server.js                本地 HTTP 桥接（唯一需要常驻的进程）
  idm-history.js           【v0.3】只读解析 IDM 注册表 + DwnlData 日志
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
  test-nexus-utils.js      页面解析纯函数的单元测试
  gen-extension-key.js     生成固定扩展 ID 的 key
  make-icons.py            生成图标

downloads/                 IDM 下载落盘目录

docs/
  DEVELOPMENT.md           开发文档：架构、接口、与 bypass 对比、排错
```

## 开发文档

维护、二次开发或排查 Nexus 页面变化，请看 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)：

- 完整数据流、代码地图、消息/桥接契约
- Nexus 文件组件、`file_id` / `uid`、`GenerateDownloadUrl`、`/api/files` 的细节
- 与 [nexusmods-bypass](https://github.com/thomasthanos/nexusmods-bypass) 的能力对比和差距
- 测试矩阵、日志位置、发布检查清单

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
> 重新加载扩展后，已经打开的 Nexus 页面不会自动注入新脚本，需要刷新一次页面。
> v0.3 改了桥接接口（`/check`、`/idmHistory`、`subdir`），升级时记得**重启桥接**，
> 否则合集面板会提示“桥接版本过旧”。
> v0.2 的桥接在拿不到文件名时不再强传 `/f`；如果本机还跑着旧桥接进程，重启一次
> （结束旧的 `node bridge/server.js`，再运行 `bridge\start.ps1`）才会生效。

### 4. 在 Nexus 下载一个 Mod

1. 浏览器里登录 Nexus Mods
2. 打开任意 Mod 的 **Files** 页
3. 直接点某个文件行的 **Manual download**
4. 扩展会当场完成下面这些事，**不打开新标签页、不弹下载确认**：
   - 读取该文件的 `file_id` 和页面上的文件数据
   - 在当前已登录的页面里向 Nexus 请求签名 CDN 直链
   - 把直链发给本地桥接，由 IDM 下载到 `downloads/`
5. Nexus 页面右下角出现“已交给 IDM：xxx”的 toast；扩展弹窗里也能看到记录

如果某个页面结构让直链解析失败，toast 里会出现“打开下载页”。只有这种失败兜底
才会打开一个新页面；该页面带有 `nd_auto=1`，会再自动尝试一次，不需要手点
Slow download。

> v0.2 新增开关“点 Manual download 直接下载”，默认开启，可在扩展弹窗里关闭。
> 关闭后恢复旧行为：浏览器开始下载，再由扩展取消并转交 IDM。

如果 IDM 的浏览器扩展（IDM Integration Module）抢先接管了下载，本扩展可能收不到
`chrome.downloads.onCreated`。两种处理方式：

- 在 `chrome://extensions` 里暂时关闭 **IDM Integration Module**；或
- 在 IDM 的“选项 → 文件类型/站点”里把 Nexus 加入不接管的例外。

### 手动发送

弹窗里可以直接粘贴一个直链（例如 Nexus 的 `cf-files.nexusmods.com/cdn/...` 链接），
填写可选文件名，点“发送”。适合排查问题或下载其它直链。
默认只允许 `nexusmods.com` / `nexus-cdn.com`，可在 `native-host/config.json` 修改。

## 一键下载是怎么实现的

`content.js` 在 `window` 的捕获阶段监听 `click` / `auxclick`，只拦截“Manual download /
Slow download / Fast download”这类按钮（Vortex、Mod manager、`nxm://` 一律放行）：

1. 立刻 `preventDefault` + `stopImmediatePropagation`，站点不会再打开下载页。
2. 从按钮所在或同级的 `<mod-file-download file="…" download-url="…">`、
   `<mod-download-buttons main-file="…">`、`mod-download-modal`、`#next-shadow-root`
   里读文件 JSON，也读 `file-id` / `data-file-id` / `data-id`；Nexus 的
   `uid = gameId * 2^32 + fileId` 会先还原成真正的 file_id。
3. 页面数据里已有 `nexus-cdn.com` 直链就直接用；如果 `download-url` 是
   `/api/files/<uid>/download`，在页面内 fetch 并跟随重定向，取最终 CDN 地址。
4. 否则在页面内 `POST /Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl`
   （`fid` + 数字 `game_id`），带上当前登录 Cookie；第一次返回空时写一次
   `ab=0|…` 广告计时 cookie 再重试。缺数字 `game_id` 时先用 GraphQL 按游戏域名查。
5. 生成失败时抓 `?tab=files&file_id=…` 页面，从 `<mod-file-download download-url>`
   取签名直链；再不行才试旧的 `DownloadPopUp` / `ModRequirementsPopUp` widget。
6. 页面顶部那种只有 mod 信息、没有 `file_id` 的 Manual download，后台用
   `modFiles(gameId, modId)` 查主文件（`primary=1` / `category=MAIN`），并用
   `name + detectedFileExtension` 推断文件名。
7. 直链和文件名交给 Service Worker → 本地桥接 → IDM。

文件名优先用文件 JSON 里的 `fileName` / `file_name` / `uri`；没有时用 GraphQL 的
`name + detectedFileExtension`（例如 `Fatalis Adaptive 0.7.4.zip`）。再取不到时桥接
不再强行传 `/f`，让 IDM 按服务器的 `Content-Disposition` 命名（Nexus 很多 CDN 链接
是 UUID，硬取名会得到没有扩展名的文件）。

相关纯函数测试：

```powershell
node tools\test-nexus-utils.js
```

## 合集批量下载（v0.3）

打开任意合集页面（例如
<https://www.nexusmods.com/games/monsterhunterworld/collections/vmu2j4>），
右下角会出现面板，列出合集里全部 mod：mod 名、原始压缩包名、版本、大小、是否可选。

- **选择**：单个勾选、全选 / 全不选 / 反选 / 仅缺；没勾的不会下载。
- **下载**：`下载选中` 会**逐个**换链接 → 交给 IDM → 等文件出现在目标目录 → 再按节奏等几秒，然后才处理下一个。
  不会把几百个链接一口气生成出来。
- **目录**：`<collectionRoot>\<合集名> [<slug>]\<uri 文件名>`，例如
  `downloads\Collections\Worldly Improvements [vmu2j4]\Clarity 1.7-3004-1-7-1608607481.rar`。
- **去重**：磁盘已有文件 / 扩展下发过 / IDM 历史有记录，三者都算重复。默认**不勾选**重复项；
  在面板设置里可以改成“每次询问”。
- **绝不覆盖**：桥接的 `onExisting` 只有 `skip` 和 `rename` 两种语义，没有覆盖分支；
  勾选重复项表示“再下一份”，会落成 `… (2).zip`，旧文件保持不动。
- **免费账号节奏**：默认每次下发后额外等 5 秒，并按 `大小 / 3.2MB/s` 估算传输时间，单次最多等 180 秒；
  实际还会先等前一个文件落盘。可以在面板设置里调慢（额外等待 0–600 秒）。
- **限速 / 人机验证**：遇到 429 会全体进入冷却（`Retry-After` 优先，30 秒起、最多 10 分钟）；
  遇到 Cloudflare 会停在那一条上，打开该 mod 的页面让你完成验证，通过后自动续跑，
  不会跳过去假装成功。
- **断点续跑**：进度写在 `chrome.storage.local`；刷新页面或第二天再打开，会提示“已恢复上次进度”，
  已完成 / 已下发的项不会重下。下载期间请把这个标签页留着（可以在后台）。

> 合集列表来自 Nexus 的公开 GraphQL v2（`api.nexusmods.com/v2/graphql`），不需要登录也不经过 Cloudflare；
> 真正换直链仍然在页面内完成，用的是你当前登录态的 Cookie。


## 配置

桥接和原生宿主共用 `native-host/config.json`（仓库里只提交 `config.example.json`，本机 `config.json` 被 `.gitignore` 忽略；`install.ps1` / 手动复制示例即可生成）：

```json
{
  "idmPath": "C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe",
  "downloadDir": "C:\\Users\\YourName\\Downloads",
  "collectionRoot": "C:\\Users\\YourName\\Downloads\\Collections",
  "allowedHosts": ["nexusmods.com", "nexus-cdn.com"],
  "allowAnyHost": false,
  "silent": true,
  "dryRun": false
}
```

- `downloadDir`：单文件下载的保存目录
- `collectionRoot`：合集根目录；不配时默认 `<downloadDir>\\Collections`。合集子目录由扩展按 `合集名 [slug]` 生成，桥接只接受 root 下的相对子目录
- `allowedHosts`：允许交给 IDM 的域名（含子域名）
- `allowAnyHost`：`true` 时允许任意 http(s) 域名（仅测试用）
- `dryRun`：只记录命令，不真正启动 IDM
- `silent`：给 IDM 加 `/n`

改完配置后重启桥接（结束 `node bridge/server.js`，再运行 `bridge/start.ps1`）。

> **v0.3 升级注意**：合集接口（`/check`、`/idmHistory`、`subdir`）是桥接新增的。
> 旧桥接（0.1.x/0.2.x）仍在运行时，面板会提示“桥接版本过旧”，需要结束旧进程再重新启动一次。

## 测试

页面解析纯函数（不需要浏览器、不需要桥接）：

```powershell
node tools\test-nexus-utils.js
node tools\test-collection-utils.js   # 合集路径/命名/归一化/去重身份
node tools\test-queue-pacing.js       # 下发节奏、退避、冷却
node tools\test-idm-history.js        # IDM 注册表/日志解析
```

打印一个合集的 mod 列表（验证接口是否变化，不需要浏览器）：

```powershell
node tools\print-collection.js monsterhunterworld vmu2j4
```

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
3. **Nexus 登录**：一键下载复用当前页面的登录 Cookie 去请求直链，扩展本身不保存账号密码。
   未登录时 Nexus 会拒绝生成链接，toast 会提示失败。
4. **免费账号限制**：Nexus 对免费账号仍有下载间隔/频率限制。扩展会按点击触发，
   但 Nexus 返回“需要等待”这类错误时会原样显示在 toast 里；此时等一会儿再点即可。
5. **Cloudflare 验证**：如果 Nexus 对请求弹出人机验证，扩展无法代替你完成，toast 会提示。
   在浏览器里刷新页面并完成验证后再点一次即可。
6. **页面结构变化**：Nexus 前端更新后按钮文案或文件 JSON 字段可能变化。解析失败时
   toast 会给出“打开下载页”兜底；`node tools\test-nexus-utils.js` 可验证基础解析逻辑。
7. **重复链接**：IDM 默认可能跳过相同 URL 的重复下载；Nexus 每次生成的链接通常唯一。
8. **本地桥接无鉴权**：只监听 `127.0.0.1`，适合个人本机使用；不要暴露到局域网/公网。
9. **扩展 ID 变更**：如果重新生成 `manifest.json` 的 `key`，需要同步更新原生宿主的
   `allowed_origins`（重新运行 `native-host/install.ps1`；桥接方式不受影响）。
10. **合集下载慢是正常的**：免费账号 + 逐个换链接，每个文件大约 `大小/3.2MB/s + 5s`，
    100 个中等 mod 大概 1 小时，上千个的合集要按天算。面板支持暂停和断点续跑，不要一次全选硬跑。
11. **合集列表依赖 `api.nexusmods.com/v2/graphql`**：官方标注还是 WIP。字段变了会读不到列表，
    用 `node tools\print-collection.js <game> <slug>` 可以快速确认是接口问题还是页面问题。
12. **合集面板只出现在合集页**：`/games/<game>/collections/<slug>`；文件页仍是一键下载那套。
13. **下载期间别关标签页**：队列在 content script 里，关掉就停；重新打开会恢复进度，
    点“继续”接着跑。切到后台标签页会自动把节奏放慢到 3 倍，避免积压后突然连发。

## 卸载 / 还原

1. 在 `chrome://extensions` / `edge://extensions` 移除扩展
2. 删除开机启动快捷方式：
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Nexus Downloader Bridge.lnk`
3. 还原 IDM 设置：`powershell -ExecutionPolicy Bypass -File .\tools\restore-idm.ps1`
4. 如果注册过原生宿主：`powershell -ExecutionPolicy Bypass -File .\native-host\uninstall.ps1`
5. 删除 `downloads/`、`bridge/bridge.log`、`native-host/logs/` 即可

## 日志

- 桥接：`bridge/bridge.log`（JSON lines）。只有真正发到桥接的请求才会写这里；
  “没有找到 file_id / 解析失败”发生在页面内，不会出现在桥接日志里。
  合集相关事件：`skip-existing`（同名文件，拒绝覆盖）、`spawned` 里的 `subdir`。
- 扩展弹窗：**最近记录**。解析失败也会记一条；点 **复制诊断** 可复制最近一次
  点击的 DOM 诊断（按钮 HTML、祖先节点属性、解析到的 file_id 来源）。诊断同时存在
  `chrome.storage.local.lastDiagnostic`。
- 合集面板：点“日志”展开，记录每一轮换链接/下发/落盘/限速/验证；最近 200 条。
- Nexus 页面 DevTools Console（F12）：失败时会打印
  `[NexusDownloader] 没有找到 file_id，点击诊断：` 及完整对象。
- Service Worker 日志：`chrome://extensions` → Nexus Downloader → 点“Service Worker”
  旁边的“检查视图”，可看后台的 GraphQL / 桥接错误。
- 原生宿主：`native-host/logs/host.log`

## License

本项目采用 MIT License，详见 [LICENSE](LICENSE)。
