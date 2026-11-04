# Nexus Downloader 开发文档

> 适用版本：**v0.2.2**（extension / bridge 同版本）
> 最后更新：2026-11-04
> 面向：维护者、二次开发、排查 Nexus 页面变化

---

## 0. 项目定位

把 Nexus Mods 文件页的一次「Manual download」变成 IDM 里的一个下载任务：

- 浏览器里点 **Manual download**；
- 扩展在页面内取到该文件的签名 CDN 直链；
- 通过本机 `127.0.0.1:38765` 桥接交给 IDM；
- 不打开下载页、不点 Slow download、不经过浏览器下载。

非目标（当前版本明确不做）：

- Collections 批量队列、断点续跑、限速；
- Vortex / `nxm://` 交接；
- Mod Organizer 2 的 `.meta` 文件；
- 用官方 Nexus API 替代页面内解析。

---

## 1. 架构

```
Chrome/Edge (MV3)
  content.js  ── 页面内拦截点击、读 file_id、取签名链接
       │ chrome.runtime.sendMessage
       ▼
  background.js ── 事件记录、GraphQL 查询、转发桥接
       │ fetch http://127.0.0.1:38765
       ▼
  bridge/server.js ── 校验 URL、拼 IDM 命令行
       │ spawn IDMan.exe /n /d ... /p ... [/f ...]
       ▼
  downloads/
```

组件职责：

| 组件 | 职责 | 生命周期 |
|---|---|---|
| `extension/content.js` | 点击拦截、DOM/页面数据解析、`GenerateDownloadUrl`、页面回退 | 每个 Nexus 页面 |
| `extension/lib/nexus-utils.js` | 纯函数：uid、JSON/HTML 解析、文件名、Generate body | 与 content 一起加载 |
| `extension/background.js` | 消息路由、GraphQL、事件存储、桥接调用 | MV3 service worker，可休眠 |
| `bridge/server.js` | 常驻 Node 进程，校验并启动 IDM | 独立进程，开机启动可选 |
| `native-host/` | 实验性 Native Messaging 实现 | 不参与当前主链路 |

---

## 2. 一次点击的完整时序

```
用户点击 Manual download
  │
  ├─ content.js: window capture 阶段拦截 click/auxclick
  │    preventDefault + stopImmediatePropagation
  │
  ├─ 找 file_id
  │    href / file-id / data-file-id / data-id
  │    file 或 main-file JSON 的 id / fileId / file_id / uid
  │    同一文件行的链接
  │    都没有 → background: modFiles(gameId, modId) 取 primary=1 / MAIN
  │
  ├─ 找直链（按顺序，见 §4.3）
  │    页面数据里的 nexus-cdn 链接
  │    /api/files/<uid>/download
  │    GenerateDownloadUrl
  │    手动下载页里的 mod-file-download download-url
  │    旧 widget
  │
  ├─ background: nd:clickDownload
  │
  ├─ bridge: POST /download
  │
  └─ IDM: IDMan.exe /n /d <url> /p <dir> [/f <filename>]
```

失败时 toast 会给出「打开下载页」，URL 带 `nd_auto=1`。该页面加载后 content.js 会自动再解析一次，成功后用
`history.replaceState` 去掉 `nd_auto`，避免刷新重复触发。

---

## 3. 代码地图

### 3.1 extension

| 文件 | 关键函数 / 内容 | 说明 |
|---|---|---|
| `extension/content.js` | `handleDownloadClick` | 点击入口、分类、阻止默认行为 |
| | `fileIdFromNode` / `fileIdFromPath` / `fileIdFromRow` | 从属性、JSON、行链接取 file_id |
| | `readPayload` / `payloadFromNode` | 读 `file`、`main-file`、`download-url`、modal |
| | `resolveDownloadUrl` | 直链解析主流程 |
| | `callGenerateDownloadUrl` | POST `GenerateDownloadUrl` |
| | `fetchApiRoute` | 解析 `/api/files/<uid>/download` |
| | `fetchFilePageDownloadUrl` | 抓手动下载页 |
| | `maybeAutoStart` | `nd_auto=1` 自动重试 |
| | `show` / `describeClick` | toast 与诊断 |
| `extension/lib/nexus-utils.js` | `normalizeFileId` | uid → file_id |
| | `payloadFileId` / `selectPayloadForFile` | 从文件 JSON 取 id、按 file_id 选条目 |
| | `parseDownloadUrlResponse` | JSON / HTML / `data-download-url` |
| | `parseDownloadUrlFromPageHtml` | 整页 `download-url` / `file` JSON |
| | `buildGenerateBody` | `fid` + 数字 `game_id` |
| `extension/background.js` | `fetchModFiles` | GraphQL `modFiles(gameId, modId)` |
| | `resolvePrimaryFileInfo` | 主文件 + 文件名 |
| | `resolveFileName` | 按 fileId 反查文件名 |
| | `onMessage` | 扩展消息路由 |
| `extension/popup.*` | | 开关、状态、最近记录、复制诊断 |
| `extension/manifest.json` | | MV3 权限、content script、固定扩展 ID |

### 3.2 bridge / tools / native-host

| 文件 | 说明 |
|---|---|
| `bridge/server.js` | HTTP 桥接、配置加载、IDM 启动 |
| `bridge/start.ps1` | 已运行则直接返回，否则启动 Node |
| `bridge/install-autostart.ps1` | 开机启动快捷方式 |
| `tools/configure-idm.ps1` / `restore-idm.ps1` | 关闭/还原 IDM 的开始与完成弹窗 |
| `tools/test-bridge.js` | 不开浏览器测试桥接 |
| `tools/test-host.js` | 测试实验性 Native Host |
| `tools/test-nexus-utils.js` | 解析纯函数单测，当前 17 项 |
| `native-host/` | 实验性原生宿主；IDM 6.42 上由原生宿主链启动会忽略命令行，故默认走桥接 |

---

## 4. Nexus 页面与接口细节

### 4.1 下载控件

当前 Nexus 的 Web Components：

- `<mod-file-download file='{"id":…}' file-id game-id download-url>`
- `<mod-download-buttons main-file='{"id":…}' game-id>`（页面顶部的 Vortex / Manual 按钮）
- `<mod-download-modal file='{"uid":…,"downloadUrl":…,"vortexDownloadUrl":…}'>`
- 可能被 portal 到 `#next-shadow-root` 的 modal。

content.js 用 `event.composedPath()` 而不是 `event.target`，因为 `event.target` 会被 shadow DOM 重定向到 host。

### 4.2 file_id / uid

- 常规 file_id 是 32 位整数。
- Nexus 有时给 **uid**：`uid = gameId * 2^32 + fileId`。
  - 出现在 modal JSON 的 `uid`、`/api/files/<uid>/download`。
  - `normalizeFileId()` 会取 `uid % 2^32`，并限制在 32 位内。
- 支持字段：`id`、`fileId`、`file_id`、`fid`、`uid`。
- 支持属性：`file-id`、`data-file-id`、`data-fileid`、`data-fid`、`data-id`、`dataset.fileId`。

### 4.3 直链解析优先级

实现位于 `content.js` 的 `resolveDownloadUrl()`：

1. 点击 href 本身是 `/api/files/<uid>/download` → `fetchApiRoute`。
2. 页面 payload 里已有 `nexus-cdn.com` 直链 → 直接使用。
3. payload 里是 `/api/files/...` → `fetchApiRoute`。
4. payload 里是 `ModRequirementsPopUp` / `DownloadPopUp` → 页面内 fetch + 解析。
5. `GenerateDownloadUrl`：
   - body 只带 `fid` + 数字 `game_id`；
   - 成功后从 JSON `{url}`、HTML `data-download-url` / `dl_link` 取；
   - 第一次无结果时写 `ab=0|…` 广告计时 cookie，再重试一次。
6. 缺数字 `game_id`：`game(domainName)` → 解析出数字后重试。
7. 抓手动下载页：`?tab=files&file_id=…`，从 `<mod-file-download download-url>` 取。
8. 自己拼 `/api/files/<gameId * 2^32 + fileId>/download`。
9. 旧 widget：`DownloadPopUp` / `ModRequirementsPopUp`。

所有 API 路由都会校验 uid 对应的 file_id 与当前点击的 file_id 一致（`fetchApiRoute(url, expectedFileId)`）。

### 4.4 GraphQL

端点：`https://api-router.nexusmods.com/graphql`

查游戏：

```graphql
query GameByDomain($domainName: String!) {
  game(domainName: $domainName) { id domainName }
}
```

查文件列表：

```graphql
query ModFiles($gameId: ID!, $modId: ID!) {
  modFiles(gameId: $gameId, modId: $modId) {
    fileId
    name
    uri
    category
    primary
    version
    detectedFileExtension
  }
}
```

`primary=1` 或 `category=MAIN` 的条目就是页面顶部 Manual download 对应的主文件。
`uri` 是 CDN 路径，不是文件名；文件名用 `name + detectedFileExtension` 推断。

### 4.5 GenerateDownloadUrl

- 端点：`/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl`
- 请求：`POST application/x-www-form-urlencoded`
  - `fid=<file_id>`
  - `game_id=<数字>`（正式参数）
  - 没有数字 `game_id` 时才带 `game_name=<domain>` 作为兼容提示
- 必须带当前登录 Cookie；脚本在页面内 fetch，因此自动带上。
- 可能返回 JSON、HTML 片段或空数组。
- 免费账号可能受广告计时/频率限制；`ab=0|…` 只作为第一次失败后的重试，不是默认行为。

### 4.6 `/api/files/<uid>/download`

- `uid = gameId * 2^32 + fileId`。
- 页面内 fetch，`redirect: 'follow'`：
  - 最终 URL 是 `nexus-cdn.com` → 直接交给 IDM；
  - 返回 HTML → 从 `download-url` / `file` JSON 再解析。
- 该路由可能要求登录态；不要把它的 URL 直接交给 IDM（IDM 没有浏览器 Cookie）。

### 4.7 免费账号、Cloudflare、频率

- `ab` cookie：页面自己会在倒计时里写；直接生成时没有倒计时，所以失败后补写一次再重试。
- Cloudflare 人机验证无法由扩展代替；失败时提示用户刷新页面完成验证。
- Nexus 对免费账号有下载间隔/频率限制；当前没有主动 pacing，按点击触发。

---

## 5. 扩展内部契约

### 5.1 设置

`chrome.storage.local.settings`：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `clickDownload` | `true` | 点 Manual download 直接下载 |
| `autoIntercept` | `true` | 兜底拦截浏览器发起的 Nexus 下载 |
| `devAllDownloads` | `false` | 开发用：拦截所有下载 |

### 5.2 消息

| 类型 | 方向 | 作用 |
|---|---|---|
| `nd:ping` | popup/content → background | 桥接 `/ping` |
| `nd:manual` | popup → background | 手动粘贴直链发送 |
| `nd:clickDownload` | content → background | 页面一键下载 |
| `nd:resolveGameId` | content → background | 域名 → 数字 game_id |
| `nd:resolvePrimaryFileId` | content → background | mod → 主文件 + 文件名 |
| `nd:resolveFileName` | content → background | fileId → 文件名 |
| `nd:log` | content → background | 页面失败/诊断事件 |
| `nd:openFolder` | popup → background | 打开下载目录 |
| `nd:getSettings` / `nd:setSettings` | popup → background | 读写设置 |
| `nd:getEvents` / `nd:clearEvents` | popup → background | 最近记录 |

`nd:clickDownload` 的 payload：

```js
{
  type: 'nd:clickDownload',
  url,          // 签名 CDN 直链
  filename,     // 可为空
  fileId,
  gameId,
  gameDomain,
  referrer
}
```

### 5.3 事件与诊断

- `chrome.storage.local.events`：最多 20 条，弹出「最近记录」。
- 失败时 content 会：
  - `console.warn('[NexusDownloader] …', diagnostic)`；
  - 写 `chrome.storage.local.lastDiagnostic`；
  - 弹窗「复制诊断」可复制按钮 outerHTML、祖先属性、候选 file_id。
- `lastDiagnostic` 不包含账号密码/Cookie，但包含页面 DOM 片段；发到公开 issue 前先检查。

### 5.4 权限

| 权限 | 用途 |
|---|---|
| `downloads` | 兜底取消浏览器下载 |
| `storage` | 设置、事件、诊断 |
| `clipboardWrite` | 复制诊断 |
| `https://*.nexusmods.com/*` | 页面脚本、GraphQL 同源请求 |
| `https://api-router.nexusmods.com/*` | 后台 GraphQL |
| `https://*.nexus-cdn.com/*` | CDN 链接校验 |
| `http://127.0.0.1:38765/*` | 本地桥接 |

---

### 5.5 运行时注意

- content script 以 `document_start` 注入，并在 `window` 的 capture 阶段注册监听，尽量抢在页面自己的 click handler 之前。
- 只注入顶层 frame（manifest 未设 `all_frames`）；Nexus 的下载控件目前都在顶层文档。
- `stopImmediatePropagation` 在 isolated world 中通常能阻止页面监听器，但如果站点也改成更早的 `window` capture 监听，仍可能出现竞态；届时优先检查页面是否先注册。
- service worker 会休眠：只有 `chrome.storage.local` 里的设置/事件是持久的，`recent` 去重 Map 只存在内存中。
- 同一个按钮用 `WeakSet` 做进行中标记，避免连点触发两次解析。
- 扩展「重新加载」不会向已打开标签页重新注入 content script，必须刷新页面。
- 最近记录最多 20 条，失败诊断只保留最后一次（`lastDiagnostic`）。

## 6. 本地桥接契约

### 6.1 HTTP API

| 方法 | 路径 | Body | 返回 |
|---|---|---|---|
| `GET` | `/ping` | — | `{ ok, bridge, idmPath, idmExists, downloadDir, … }` |
| `POST` | `/download` | `{ url, filename?, referrer?, source? }` | `{ ok, id, filename, dir, command }` |
| `POST` | `/openFolder` | `{}` | `{ ok, dir }` |

CORS：`*`；支持 `Access-Control-Allow-Private-Network: true`；OPTIONS 返回 204。

### 6.2 配置

`native-host/config.json`（本机文件，`.gitignore` 忽略）：

```json
{
  "idmPath": "C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe",
  "downloadDir": "…\\downloads",
  "allowedHosts": ["nexusmods.com", "nexus-cdn.com"],
  "allowAnyHost": false,
  "silent": true,
  "dryRun": false
}
```

- `allowedHosts` 匹配域名及其子域名。
- `NEXUS_BRIDGE_ALLOW_ANY=1` 可临时放开任意域名。
- `NEXUS_BRIDGE_PORT` 可改端口（扩展写死 38765，一般不改）。
- `NEXUS_BRIDGE_DEBUG=1` 把日志同时写到 stderr。
- 改配置后必须重启桥接进程。

### 6.3 IDM 命令行

```
IDMan.exe /n /d <url> /p <downloadDir> [/f <filename>]
```

- `/n`：静默启动（`silent: true`）。
- `/f` 只在有可信文件名时添加；没有文件名时让 IDM 按 `Content-Disposition` 命名。
- IDM 的「开始下载 / 下载完成」弹窗不由 `/n` 控制，需要 `tools/configure-idm.ps1`。

### 6.4 安全边界

- 桥接只监听 `127.0.0.1`，无鉴权。
- 任何本机页面理论上都可以 POST 到该端口；`allowedHosts` 是唯一限制。
- 不要把端口暴露到局域网/公网，也不要在桥接里加入任意命令执行。
- 签名 CDN 链接有时效，桥接只负责转交，不持久化 URL。

---

## 7. 与 `nexusmods-bypass` 的对比

参考项目：<https://github.com/thomasthanos/nexusmods-bypass>

许可证注意：

- 该项目是 source-available；`src/content/nnw.js` 为 **GPL-3.0-or-later**（基于 Nexus No Wait ++）。
- 本项目是 MIT。只参考行为与接口，**不要直接复制它的代码/选择器/正则** 到本仓库，除非先处理许可证兼容。

### 7.1 已对齐的能力

| 能力 | 本项目 | 说明 |
|---|---|---|
| 单文件 Manual download 自动化 | ✅ | 页面内拦截，不打开新标签页 |
| 文件 JSON / `file-id` / `data-id` | ✅ | `mod-file-download`、`mod-download-buttons`、modal |
| `uid = gameId*2^32+fileId` | ✅ | `normalizeFileId` |
| 页面顶部无 file_id 的 Manual | ✅ | GraphQL `modFiles` 主文件 |
| `GenerateDownloadUrl` + 数字 game_id | ✅ | 失败时 `ab` cookie 重试 |
| `/api/files/<uid>/download` | ✅ | 跟随重定向 + 文件身份校验 |
| `mod-file-download download-url` | ✅ | 直链或 API 路由 |
| 手动下载页回退 | ✅ | 抓 `?tab=files&file_id=` |
| requirements widget | ✅ | `ModRequirementsPopUp` / `DownloadPopUp` |
| Cloudflare 检测 | ✅ | 提示用户，不假装成功 |
| 点击诊断 | ✅ | toast + 复制诊断 + console |
| 多语言按钮文案 | ✅ | 中/英/日/韩等主要文案 |

### 7.2 仍有差距

| 能力 | bypass | 本项目 | 影响 |
|---|---|---|---|
| Collections 批量队列 | ✅ | ❌ | 不做；本项目是单文件 → IDM |
| 队列限速 / 断点 / 历史 | ✅ | ❌ | 不做 |
| Vortex / `nxm://` 交接 | ✅ | ❌ | 不做；目标是 IDM |
| 大文件 Standard / Resumable chooser | ✅ | ❌ | >500MB 且生成失败时可能停在 chooser |
| Requirements gate 主动跳过 | ✅ | 部分 | 只读 widget / 拦 modal 按钮 |
| Page shield / 广告拦截导致按钮失效 | ✅ | ❌ | 广告拦截插件可能让页面按钮不可用 |
| 官方 Nexus API | ✅ | ❌ | 当前只用 GraphQL + 页面 |
| 类型化错误 / 重试 / 报告 | 强 | 基础 | 失败提示和诊断较简单 |
| 免费账号 pacing | ✅ | ❌ | 连续点击可能触发 Nexus 限制 |
| 13 语言 UI / 隐藏广告位 | ✅ | ❌ | 非功能优先 |
| MO2 `.meta` | ✅ | ❌ | 不做 |
| 严格 CDN 内容校验 | 部分 | 部分 | 我们校验 API 路由 uid，不校验 CDN 内容 |

### 7.3 建议的下一步

按收益/风险排序：

1. **大文件 chooser**：`>500MB` 时识别 Standard/Resumable，至少不要卡在页面上。
2. **Requirements gate**：如果 widget 读取失败，自动点 modal 的下载按钮（注意别误点 Close）。
3. **错误分类与重试**：区分 Cloudflare / 未登录 / 频率限制 / 空响应，给出不同提示和退避。
4. **Page shield（可选）**：只有确认广告拦截会导致按钮失效时再加，避免过度注入。
5. **免费账号 pacing（可选）**：连续下载时加最小间隔，降低触发限制的概率。

---

## 8. 开发工作流

无构建步骤，纯 JS：

1. `chrome://extensions` → 开发者模式 → 加载 `extension/`。
2. 修改代码后点扩展卡片「重新加载」。
3. **刷新已打开的 Nexus 页面**（content script 只在新加载页面注入）。
4. 桥接代码修改后需要重启 `node bridge/server.js`（扩展重载不会重启它）。

固定扩展 ID：`manifest.json` 的 `key` 决定 ID；改 key 需要重新注册 Native Host 的 `allowed_origins`。

---

## 9. 测试

### 9.1 自动检查

```powershell
node tools\test-nexus-utils.js
node --check extension\content.js
node --check extension\background.js
node --check extension\lib\nexus-utils.js
node --check extension\popup.js
node --check bridge\server.js
```

当前解析单测：**17 项**（uid、file_id、JSON/HTML、页面 HTML、API 路由、文件名、多文件选择、Generate body）。

### 9.2 手动回归矩阵

| 场景 | 预期 |
|---|---|
| Files 页主文件 Manual download | toast「已交给 IDM」，不新开标签 |
| 页面顶部主文件按钮（无 file_id） | GraphQL 主文件，toast 标「（主文件）」 |
| ARCHIVED 文件行 | 下载该行对应文件，不串到主文件 |
| 下载页点 Slow download | 同样被拦截，不跳浏览器下载 |
| Vortex / Mod manager 按钮 | 完全放行 |
| Ctrl/Cmd/Shift + 点击 | 放行，保留浏览器新标签行为 |
| 桥接未启动 | toast 提示启动桥接 |
| 未登录 / Cloudflare | toast 提示，不产生错误文件 |
| 文件名未知 | IDM 用 Content-Disposition；旧桥接可能给 UUID |
| IDM 开始/完成弹窗 | 运行 `configure-idm.ps1` 后无弹窗 |

---

## 10. 排错

| 现象 | 先查 |
|---|---|
| 「没有找到 file_id」 | 扩展是否重载、页面是否刷新；弹窗「复制诊断」 |
| 「本地桥接未启动」 | `node tools\test-bridge.js ping`；`bridge\start.ps1` |
| 「发送失败」 | `native-host/config.json` 的 `idmPath` / `downloadDir` |
| 「Nexus 没有返回下载链接」 | 登录态、Cloudflare、免费账号限制；toast 的「打开下载页」 |
| 下载成 UUID 文件名 | 旧桥接进程仍强传 `/f`；重启桥接或让页面提供文件名 |
| IDM 没开始 | IDM 弹窗设置、IDM Integration Module 是否抢下载 |
| 页面按钮无反应 | 广告拦截/页面脚本报错；看 F12 Console |

日志位置：

- 桥接：`bridge/bridge.log`（JSON lines，只记到桥接的请求）
- 扩展弹窗：最近记录 / 复制诊断
- Nexus 页面：F12 Console 搜 `[NexusDownloader]`
- Service Worker：`chrome://extensions` → 检查视图
- Native Host：`native-host/logs/host.log`

---

## 11. 发布检查清单

- [ ] `manifest.json` 版本、`bridge/server.js` 的 `VERSION`、popup 显示版本一致。
- [ ] `node tools\test-nexus-utils.js` 全过。
- [ ] 所有 JS `node --check` 通过。
- [ ] 重新加载扩展 + 刷新 Nexus 页面。
- [ ] 主文件 / ARCHIVED / 顶部按钮 / 下载页按钮 四条路径手测。
- [ ] 确认普通点击不新开标签，Ctrl+点击仍然新开。
- [ ] 确认 toast 文件名合理，IDM 落到 `downloads/`。
- [ ] 桥接日志有 `spawned`，没有 `request-error`。
- [ ] README / 本文档 / CHANGELOG（如有）同步。
- [ ] commit + push。

---

## 12. 许可证与参考

- 本项目：MIT，见 `LICENSE`。
- 参考实现：[thomasthanos/nexusmods-bypass](https://github.com/thomasthanos/nexusmods-bypass)。
  - 其 `src/content/nnw.js` 为 GPL-3.0-or-later，基于 Nexus No Wait ++。
  - 本项目的解析/回退逻辑是按行为重写的，没有直接复制其源码；后续贡献请保持同样原则。
