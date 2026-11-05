# Nexus Downloader 开发文档

> 适用版本：**v0.3.2**（extension / bridge 同版本）
> 最后更新：2026-11-05
> 面向：维护者、二次开发、排查 Nexus 页面变化
> 文档分工：README 负责安装、联调、排错、卸载；本文负责架构、接口、实现细节、测试与发布。

---

## 0. 项目定位

把 Nexus Mods 的下载变成 IDM 里的下载任务：

- 文件页点 **Manual download**：扩展在页面内取到该文件的签名 CDN 直链，交给 IDM；
- 合集页（v0.3）：面板列出合集里全部 mod，多选后**限速**换链接、按并发上限下发、按集合名建子目录、三源去重。

非目标（当前版本明确不做）：

- Vortex / `nxm://` 交接；
- Mod Organizer 2 的 `.meta` 文件；
- 用官方 API 替代页面内解析（REST v1 换直链仅限 Premium，本机是免费账号）；
- 自动解压 / 按 mod 建子目录；
- 任何形式的 Cloudflare 绕过。

---

## 1. 架构

```
Chrome/Edge (MV3)
  content.js  ── 文件页：点击拦截、读 file_id、取签名链接
  collection.js ── 合集页：浮层面板 + 队列（限速换链接、并发上限、验证恢复）
        │ chrome.runtime.sendMessage
        ▼
  background.js ── 事件记录、GraphQL、去重检查、台账、转发桥接
        │ fetch http://127.0.0.1:38765
        ▼
  bridge/server.js ── 校验 URL/子目录、同名跳过（显式重下才覆盖）、拼 IDM 命令行
  bridge/idm-history.js ── 只读解析 IDM 注册表 + DwnlData 日志
        │ spawn IDMan.exe /n /d ... /p ... [/f ...]
        ▼
  downloads/  或  collectionRoot/<合集名 [slug]>/
```

组件职责：

| 组件 | 职责 | 生命周期 |
|---|---|---|
| `extension/content.js` | 文件页点击拦截、DOM/页面数据解析、页面回退 | 每个 Nexus 页面 |
| `extension/collection.js` | 合集页面板、选择、队列、节奏、限速冷却、验证恢复、断点续跑 | 每个合集页面 |
| `extension/lib/nexus-utils.js` | 纯函数：uid、JSON/HTML 解析、文件名、Generate body | 与 content 一起加载 |
| `extension/lib/collection-utils.js` | 纯函数：合集路径、GraphQL 归一化、Windows 命名、去重身份 | content / SW / bridge 共用 |
| `extension/lib/queue-pacing.js` | 纯函数：等待、退避、`Retry-After`、冷却 | content 加载 |
| `extension/lib/challenge-utils.js` | 纯函数：验证标签页状态、自动等待/置前、预热门槛 | content / SW / 测试共用 |
| `extension/lib/file-link.js` | 按 fileId 换直链（一键与合集共用） | content 加载 |
| `extension/background.js` | 消息路由、GraphQL、合集去重、台账、桥接调用 | MV3 service worker，可休眠 |
| `bridge/server.js` | 常驻 Node 进程，校验并启动 IDM | 独立进程，开机启动可选 |
| `bridge/idm-history.js` | 读 IDM 历史（注册表 / 日志 / URL 历史） | 被桥接按需调用，60s 缓存 |
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
| | `resolveDownloadUrl` | 直链解析主流程（底层调用 `lib/file-link.js`） |
| | `maybeAutoStart` | `nd_auto=1` 自动重试 |
| | `show` / `describeClick` | toast 与诊断 |
| `extension/lib/file-link.js` | `resolveByFileId` | 只按 fileId 换直链：Generate → ab 重试 → 文件页 → API 路由 → 旧 widget |
| | `classify` / `retryAfterSeconds` | HTTP/挑战/限速/登录分类 |
| `extension/lib/collection-utils.js` | `parseCollectionPath` | `/games/<game>/collections/<slug>[/revisions/<n>]` |
| | `normalizeCollectionRevision` | GraphQL → 面板行（可用性、大小、uri、去重键） |
| | `sanitizeSegment` / `sanitizeFilename` | 桥接与扩展共用的 Windows 命名规则 |
| | `collectionFolderName` | `<合集名> [<slug>]` |
| | `matchIdmRecord` / `extractCdnIdentity` | IDM 历史匹配（原始文件名 / UUID / `h`） |
| `extension/lib/queue-pacing.js` | `computeGapMs` | 固定下发间隔（默认 5s，2s 下限），隐藏标签页 ×3；不做大小/速度估算 |
| | `normalizeConcurrent` / `diskWaitMs` | 并发上限归一化（1–5）；下发后 8s 快速落盘观察 |
| | `retryDelayMs` / `nextCooldown` | 1.5s→30s 等量抖动；30s→600s 共享冷却 |
| `extension/lib/challenge-utils.js` | `tabState` | 标签页快照 + DOM 探针 → clear / challenge / loading / error / gone；超过 12s 标 `escalate` |
| | `shouldWarmUp` / `pollDelayMs` | ≥5 个文件才预热；加载中 700ms、其余 1s 轮询 |
| `extension/collection.js` | `loadCollection` / `runPreflight` | 拉列表、三源去重、恢复作业 |
| | `startQueue` / `processItem` | 队列主循环、单条下发、落盘确认 |
| | `handleChallenge` | 挑战：后台标签页 → 自动等待/置前 → 真实请求重试；不再用 HEAD 探针 |
| | `warmUpSession` | 批次开始前加载一次文件页（≥5 项，最多 8s） |
| `extension/lib/nexus-utils.js` | `normalizeFileId` | uid → file_id |
| | `payloadFileId` / `selectPayloadForFile` | 从文件 JSON 取 id、按 file_id 选条目 |
| | `parseDownloadUrlResponse` | JSON / HTML / `data-download-url` |
| | `parseDownloadUrlFromPageHtml` | 整页 `download-url` / `file` JSON |
| | `buildGenerateBody` | `fid` + 数字 `game_id` |
| `extension/background.js` | `fetchModFiles` | GraphQL `modFiles(gameId, modId)` |
| | `fetchCollectionRevision` | GraphQL v2 合集 + 10 分钟缓存 |
| | `collectionCheck` | 磁盘 + IDM 历史 + 台账三源去重 |
| | `collectionSend` / `recordDispatch` | 下发并写台账 |
| | `onMessage` | 扩展消息路由 |
| `extension/popup.*` | | 开关、状态（含合集根目录）、最近记录、复制诊断 |
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

> **为什么默认不用 Native Messaging**：`native-host/` 已实现并通过 Chrome/Edge 的握手与 ping 测试，
> 但在本机 IDM 6.42b63 上，由 Chrome 原生宿主进程链启动的 `IDMan.exe` 会**静默忽略命令行参数**；
> 同样的参数从普通 Node 进程调用则正常。因此扩展默认走 `127.0.0.1:38765` 的本地桥接，
> 原生宿主代码保留作参考/调试，不参与安装主流程。

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
- 免费账号有下载间隔/频率限制。v0.2 按点击触发、没有 pacing；v0.3 的合集队列**主动限速**（见 §4.8）。

### 4.8 合集（Collections）

列表来自公开 GraphQL v2，**不需要登录、不经过 Cloudflare**：

```
POST https://api.nexusmods.com/v2/graphql
query CollectionRevision($slug, $domainName, $revision, $adult)
  collection(slug, domainName) { id slug name game{domainName id} latestPublishedRevision{revisionNumber} }
  collectionRevision(slug, domainName, revision, viewAdultContent: $adult) {
    revisionNumber status adultContent modCount totalSize
    modFiles { optional updatePolicy fileId
      file { fileId modId name version size sizeInBytes uri category mod{name author status adultContent} } }
  }
```

要点（都实测过）：

- **必须传 `viewAdultContent: true`**：合集里只要有一个成人内容 mod，不传就整体返回
  `ADULT_CONTENT_BLOCKED`（`qdurkx`、`9zfscf` 都这样）。
- `revision` 可省略，省略时返回当前发布版；显式指定时用 `latestPublishedRevision.revisionNumber`。
- `modFiles` 一次全量返回、无分页：2444 个 mod 的合集一次 2.7s / 830KB。
- `file` 可能为 `null`（外部来源）；`file.category` 可能是 `REMOVED`；`mod.status` 非
  `published`/`archived` 时视为不可下载。
- `uri` 是 Nexus 原始压缩包名（`Clarity 1.7-3004-1-7-1608607481.rar`），**落盘名用它**。
- `size` 单位是 KB，`sizeInBytes` 对归档文件可能为 `null`，展示要回退 `size * 1024`。
- 站点自己的 `api-router.nexusmods.com/graphql` 是另一套（带 Cookie），当前不用；页面 HTML 抓取会被 Cloudflare 403，不可用。

换直链仍然逐 fileId 走 §4.3 的页面内流程（`lib/file-link.js`），因为 REST v1
`download_link.json` 对免费账号直接 403。

合集队列策略（`collection.js` + `lib/queue-pacing.js`）：

| 参数 | 默认 | 说明 |
|---|---|---|
| 下发间隔 | 5s（0–600） | 固定间隔，不再按文件大小估算；0 时仍受 2s 下限约束 |
| 间隔下限 | 2000ms | 跳过/失败也等 |
| 最大同时下载 | 2（1–5） | 已下发但未落盘的文件数上限；到上限就等对账释放名额 |
| 下发后快速观察 | 8s | 只看一眼是否已落盘，没看到就交给对账 |
| 重试 | 3 次，1.5s→30s 等量抖动 | 单个文件 |
| 限速冷却 | 30s→600s，最多 6 次，跨标签共享 | `Retry-After` 优先 |
| 隐藏标签页 | 间隔 ×3 | 防后台节流后连发 |
| 小文件优先 | 开 | |
| 批次确认 | >50 个文件 | |

遇到挑战：队列停在该文件（不跳过、不推进），由 service worker 用 `chrome.tabs.create({active:false})`
在后台打开该 mod 的文件页；合集页每 0.7–1s 轮询标签页状态 + DOM 探针，标签页干净后关闭它并直接重试
真实请求（不再用 HEAD 探针）。12 秒还没过就自动切到前台，用户点一次勾选框后自动关闭并继续；
30 分钟未恢复 / 标签页被关闭 / 加载失败才停止。实现细节见 `lib/challenge-utils.js`。

**完成判定（磁盘是唯一真相）**：IDM 没有可用的状态接口，而且它可能在自己的队列里排几十秒才把文件
移到目标目录。所以完成状态不看 IDM 日志/注册表，而是：

1. 下发后先快速轮询 `/check` 最多 8 秒（小文件通常这时已经落盘）；
2. 没落盘就记 `sent` + `sentAt` + 实际文件名，**不判失败**；
3. 面板每 5 秒把所有 `sent` 项的名字合并成**一次** `/check`，出现即转 `done`；页面重新打开时也先同步一次，
   所以“上次显示未完成、其实已经下完”会被自动纠正；
4. 超过 2 小时仍未出现才转 `failed`（可重试），避免 IDM 长队列被误判。

IDM 历史（注册表 / 日志）只用于**去重**（“这个文件以前下过吗，可能在别的目录”），每次预检读一次、缓存 60 秒，
不参与完成状态判定。

### 4.9 去重

身份：`gameId:modId:fileId`（台账）、`uri` 文件名、CDN URL 里的 UUID / `h=` 参数
（同一文件多次生成的链接 `h` 不变）。四层判定：

1. **磁盘**：`<合集目录>/<sanitize(uri)>` 存在（桥接 `/check`）；
2. **台账**：`chrome.storage.local.dispatchLedger` 里同一 key 且目录相同；
3. **IDM 注册表**：`HKCU\Software\DownloadManager\<id>` 的 `Url0` / `FR_FNCD`；
4. **IDM 日志**：`%APPDATA%\IDM\DwnlData\<user>\<slug>_<n>\*.log` 的 `Url` 与 `Content-Disposition`。

默认策略 `skip`（重复项不勾选、不下发），可切 `ask`（开始前弹框，可选“跳过”或“覆盖下载”）。
桥接只接受 `onExisting: skip | replace`：`skip` 直接返回 `skipped:'disk'`，**不会生成 `(2)` 文件名**；
`replace` 只在用户明确确认后发送（重复项对话框的“覆盖下载”，或行内“重下”），桥接先删同名旧文件再让 IDM 下载。

### 4.10 一键下载的实现细节

`content.js` 在 `window` 的捕获阶段监听 `click` / `auxclick`，用 `event.composedPath()` 而不是
`event.target`（后者会被 shadow DOM 重定向到 host）。只拦截 Nexus 的下载按钮：

- 按按钮文案匹配 `Manual download`、`Slow download`、`Fast download` 等（`classifyDownloadLabel`）；
- 放行 Vortex / Mod manager（`action-vortex`、`action-nmm`）、`nxm://`、`?nmm=1`；
- 带 Ctrl / Cmd / Shift / Alt 的点击放行，保留浏览器“新标签打开”的行为；
- 扩展自己的 toast / 合集面板内的点击不处理。

命中后：

1. 立刻 `preventDefault()` + `stopImmediatePropagation()`，站点不会再打开下载页；
2. 从按钮所在或同级的 `<mod-file-download file="…" download-url="…">`、
   `<mod-download-buttons main-file="…">`、`mod-download-modal`、`#next-shadow-root`
   读取文件 JSON，也读 `file-id` / `data-file-id` / `data-id`；
3. `uid` 先按 `uid % 2^32` 还原成真正的 `file_id`（见 §4.2）；
4. 直链按 §4.3 的优先级解析；页面数据里已有 `nexus-cdn.com` 链接就直接用；
5. 页面顶部只有 mod 信息、没有 `file_id` 的 Manual download：后台用
   `modFiles(gameId, modId)` 查主文件（`primary=1` / `category=MAIN`），并在 toast 里标“（主文件）”；
6. 文件名优先用文件 JSON 的 `fileName` / `file_name` / `uri` 等字段；没有时用 GraphQL 的
   `name + detectedFileExtension`；再取不到就不强传 `/f`，让 IDM 按 `Content-Disposition` 命名；
7. 直链和文件名经 `nd:clickDownload` 交给 background → 桥接 → IDM。

解析失败时 toast 给出“打开下载页”，URL 带 `nd_auto=1`；该页面加载后 content.js 会自动再试一次，
成功后用 `history.replaceState` 去掉 `nd_auto`，避免刷新重复触发。

文件名的一个常见坑：Nexus 很多 CDN 链接以 UUID 结尾而不是文件名；如果桥接强行 `/f` 一个 UUID，
落盘文件会没有扩展名。因此 v0.2 起桥接只在有可信文件名时才加 `/f`（见 §6.3）。

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
| `collectionPauseSeconds` | `5` | 合集：两次下发之间的间隔秒数（0–600，实际不低于 2s） |
| `collectionMaxConcurrent` | `2` | 合集：最多同时有几个文件已下发未落盘（1–5） |
| `collectionDuplicatePolicy` | `'skip'` | 合集：重复项 `skip` / `ask` |
| `collectionUseIdmHistory` | `true` | 合集：把 IDM 历史算作重复 |
| `collectionSmallestFirst` | `true` | 合集：小文件先下 |
| `collectionOpenCheckPage` | `true` | 合集：遇到验证时自动开后台标签页并等待通过；关掉则只提示 |
| `collectionWarmup` | `true` | 合集：≥5 个文件时，开始前预热一次文件页（最多 8s） |
| `collectionFolderSuffix` | `true` | 合集：目录名带 `[slug]` |

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
| `nd:openConfig` | popup → background | 打开 `native-host/config.json` |
| `nd:getSettings` / `nd:setSettings` | popup → background | 读写设置 |
| `nd:getEvents` / `nd:clearEvents` | popup → background | 最近记录 |
| `nd:collectionResolve` | collection → background | `{gameDomain, slug, revision?, force?}` → 归一化列表（GraphQL v2） |
| `nd:collectionCheck` | collection → background | `{subdir, items, useIdmHistory}` → 每项去重结论 |
| `nd:collectionSend` | collection → background | 下发一条到桥接，并写台账 |
| `nd:collectionPoll` | collection → background | `{subdir, names}` → 磁盘落盘状态 |
| `nd:collectionJobGet` / `nd:collectionJobSet` / `nd:collectionJobClear` | collection → background | 作业持久化（`chrome.storage.local.collectionJobs`） |
| `nd:collectionOpenFolder` | collection/popup → background | 打开合集目录 |
| `nd:checkTabOpen` / `nd:checkTabGet` / `nd:checkTabNavigate` | collection → background | 打开 / 读取 / 重新加载后台验证标签页（`chrome.tabs.*`） |
| `nd:checkTabProbe` | collection → background → 验证页 | 让验证页的内容脚本返回 `{challenge, turnstile, readyState}` |
| `nd:checkTabFocus` / `nd:checkTabClose` | collection → background | 把验证页切到前台 / 关闭 |
| `nd:challengeProbe` | background → content | 内容脚本内部消息，返回 DOM 探针结果 |

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
| `https://api-router.nexusmods.com/*` | 后台 GraphQL（games / modFiles） |
| `https://api.nexusmods.com/*` | 后台 GraphQL v2（合集列表） |
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
| `GET` | `/ping` | — | `{ ok, bridge, idmPath, idmExists, downloadDir, collectionRoot, configPath, … }`；每次调用重新读取 `config.json` |
| `POST` | `/download` | `{ url, filename?, referrer?, source?, subdir?, onExisting?: 'skip'\|'replace' }` | `{ ok, id, filename, dir, skipped?:'disk', command }` |
| `POST` | `/check` | `{ subdir?, names: [] }` | `{ ok, dir, exists, files: { name: { exists, size, mtimeMs } } }` |
| `POST` | `/idmHistory` | `{ force? }` | `{ ok, records: [], counts, error }` |
| `POST` | `/openFolder` | `{ subdir? }` | `{ ok, dir }` |
| `POST` | `/openConfig` | — | `{ ok, path }`；用记事本打开 `native-host/config.json` |

`subdir` 只接受 `collectionRoot` 下的相对路径（1–3 段、无盘符/UNC/`..`，且每段必须等于
`sanitizeSegment()` 的结果），最终 `path.resolve` 必须仍在 root 之下。
`onExisting` 默认 `skip`（同名文件直接返回，不下载、不重命名）；`replace` 会先删同名旧文件再下载，
只在用户明确确认后发送（重复项对话框的“覆盖下载”，或行内“重下”）。**桥接没有生成 `(2)` 文件名的代码路径。**

CORS：`*`；支持 `Access-Control-Allow-Private-Network: true`；OPTIONS 返回 204。

### 6.2 配置

`native-host/config.json`（本机文件，`.gitignore` 忽略）：

```json
{
  "idmPath": "C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe",
  "downloadDir": "…\\downloads",
  "collectionRoot": "…\\downloads\\Collections",
  "allowedHosts": ["nexusmods.com", "nexus-cdn.com"],
  "allowAnyHost": false,
  "silent": true,
  "dryRun": false
}
```

- `allowedHosts` 匹配域名及其子域名。
- `collectionRoot` 缺省为仓库下的 `downloads/Collections`（注意：不是由 `downloadDir` 推导）；建议显式配置。
- `NEXUS_BRIDGE_ALLOW_ANY=1` 可临时放开任意域名。
- `NEXUS_BRIDGE_PORT` 可改端口（扩展写死 38765，一般不改）。改端口要同时改 `extension/background.js` 的 `BRIDGE_URL` 和 `extension/manifest.json` 的 `host_permissions`，并重新加载扩展。
- `NEXUS_BRIDGE_DRY_RUN=1` / `NEXUS_BRIDGE_COLLECTION_ROOT=…` 仅测试用。
- `NEXUS_BRIDGE_DEBUG=1` 把日志同时写到 stderr。
- 改配置后打开扩展弹窗点“刷新状态”即可重新读取；桥接版本较旧时先运行 `.\bridge\start.ps1 -Restart`。

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

### 6.5 IDM 弹窗设置（`tools/configure-idm.ps1`）

IDM 6.42 的 `/n` 只能让主窗口静默，**不会**覆盖“开始下载确认 / 下载完成提示”。不关掉的话，
桥接日志里已经有 `spawned`，但 IDM 会停在弹窗等用户点确认，表现为“交给 IDM 了但文件不出现”。

`tools/configure-idm.ps1` 会先备份原值到 `tools/idm-settings-backup.json`，再写：

| HKCU `Software\DownloadManager` | 新值 | 作用 |
|---|---|---|
| `StartDlgShowing` | `0` | 不显示“开始下载”对话框 |
| `ComplDlgShowing` | `0` | 不显示“下载完成”提示 |
| `startImmediately` | `1` | 命令行任务立即开始 |

运行后，如果 IDM 在脚本默认路径，它会重启 IDM 让设置生效。`tools/restore-idm.ps1` 按备份还原；两个脚本都只改当前用户，不需要管理员权限。

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
| Collections 批量队列 | ✅ | ✅（v0.3） | 限速换链接 + 并发上限；不做 Vortex 交接 |
| 队列限速 / 断点 / 历史 | ✅ | 部分 | 合集有限速、断点续跑、IDM 历史去重；没有独立的下载历史面板 |
| Vortex / `nxm://` 交接 | ✅ | ❌ | 不做；目标是 IDM |
| 大文件 Standard / Resumable chooser | ✅ | ❌ | >500MB 且生成失败时可能停在 chooser |
| Requirements gate 主动跳过 | ✅ | 部分 | 只读 widget / 拦 modal 按钮 |
| Page shield / 广告拦截导致按钮失效 | ✅ | ❌ | 广告拦截插件可能让页面按钮不可用 |
| 官方 Nexus API | ✅ | ❌ | 当前只用 GraphQL + 页面 |
| 类型化错误 / 重试 / 报告 | 强 | 基础 | 失败提示和诊断较简单 |
| 免费账号 pacing | ✅ | 部分 | 合集主动限速；单文件仍按点击触发，连续点击可能触发限制 |
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

开发环境：Windows 10/11、Node.js 18+（实测 24.9.0）、Chromium 109+、IDM 6.x（实测 6.42b63）、
PowerShell 5.1。完整的组件安装与联调步骤见 [README](../README.md)；本节只列开发循环。

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
node tools\test-collection-utils.js
node tools\test-queue-pacing.js
node tools\test-challenge-utils.js
node tools\test-idm-history.js
node tools\print-collection.js monsterhunterworld vmu2j4
node --check extension\content.js
node --check extension\collection.js
node --check extension\background.js
node --check extension\lib\nexus-utils.js
node --check extension\lib\collection-utils.js
node --check extension\lib\queue-pacing.js
node --check extension\lib\challenge-utils.js
node --check extension\lib\file-link.js
node --check extension\popup.js
node --check bridge\server.js
node --check bridge\idm-history.js
```

当前单测：`test-nexus-utils` 17 项、`test-collection-utils` 22 项、`test-queue-pacing` 11 项、
`test-challenge-utils` 10 项、`test-idm-history` 8 项。`print-collection.js` 只依赖公开 GraphQL，是"schema 变了"的哨兵。

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
| 合集页打开面板 | 列出全部 mod，大小/版本正确，不可下载项标注原因 |
| 合集单选 / 全选 | 按间隔下发（≥2s），待落盘数不超过并发上限 |
| 合集重复项 | 默认不勾选、也不下发；不生成 `(2)` 文件；点行内“重下”确认后才覆盖 |
| 合集并发 | 把并发设为 1 / 3 分别验证：待落盘数量不超过设置 |
| 合集刷新页面 | 提示恢复进度，已完成项不重下 |
| 合集遇到 429 | 全体冷却倒计时，结束后自动继续 |
| 合集遇到验证 | 后台打开验证页；非交互式自动过、自动关、重试同一条；交互式 12s 后切到前台，点一次后自动续跑 |
| 手动关闭验证页 | 队列停止并提示，不会无限等待 |

---

## 10. 排错

| 现象 | 先查 |
|---|---|
| 「没有找到 file_id」 | 扩展是否重载、页面是否刷新；弹窗「复制诊断」 |
| 「本地桥接未启动」 | `node tools\test-bridge.js ping`；`bridge\start.ps1` |
| 「发送失败」 | `native-host/config.json` 的 `idmPath` / `downloadDir` |
| 「Nexus 没有返回下载链接」 | 登录态、Cloudflare、免费账号限制；toast 的「打开下载页」 |
| 下载成 UUID 文件名 | 旧桥接进程仍强传 `/f`；重启桥接或让页面提供文件名 |
| 合集面板提示「桥接版本过旧」 | 结束旧的 `node bridge/server.js`，重新 `bridge\start.ps1`，刷新页面 |
| 合集列表读不到 | `node tools\print-collection.js <game> <slug>`；成人内容要传 `viewAdultContent` |
| 合集项显示不可下载 | `file` 为空（外部来源）或 `category=REMOVED`；Nexus 上确实没了 |
| 合集停在「限速冷却」 | 429；等冷却结束，或把面板里的“下发间隔”调大、降低“最大同时下载数” |
| 合集要求人机验证 | 后台验证页会自动打开；12 秒后仍没通过会切到前台，点一次勾选框即可；30 分钟未通过会停 |
| IDM 没开始 | IDM 弹窗设置、IDM Integration Module 是否抢下载 |
| 页面按钮无反应 | 广告拦截/页面脚本报错；看 F12 Console |

日志位置：

- 桥接：`bridge/bridge.log`（JSON lines，只记到桥接的请求）；合集事件 `skip-existing`、`spawned.subdir`
- 扩展弹窗：最近记录 / 复制诊断
- 合集面板：日志（最近 200 条）
- Nexus 页面：F12 Console 搜 `[NexusDownloader]`
- Service Worker：`chrome://extensions` → 检查视图
- Native Host：`native-host/logs/host.log`

---

## 11. 发布检查清单

- [ ] `manifest.json` 版本、`bridge/server.js` 的 `VERSION`、popup 显示版本一致。
- [ ] `node tools\test-nexus-utils.js` 全过。
- [ ] `node tools\test-collection-utils.js`、`test-queue-pacing.js`、`test-challenge-utils.js`、`test-idm-history.js` 全过。
- [ ] 所有 JS `node --check` 通过。
- [ ] 重新加载扩展 + 刷新 Nexus 页面（文件页和合集页各一次）。
- [ ] 主文件 / ARCHIVED / 顶部按钮 / 下载页按钮 四条路径手测。
- [ ] 合集页：5 个 mod 的样本合集跑一遍，确认目录名带 `[slug]`、重复项被跳过、不覆盖。
- [ ] 确认普通点击不新开标签，Ctrl+点击仍然新开。
- [ ] 确认 toast 文件名合理，IDM 落到 `downloads/`。
- [ ] 桥接日志有 `spawned`，没有 `request-error`。
- [ ] README / 本文档 / CHANGELOG（如有）同步。
- [ ] commit + push。

---

## 12. 已知限制（实现层面）

| # | 限制 | 影响 / 处理 |
|---|---|---|
| 1 | IDM 没有可用的状态查询接口 | 完成判定以磁盘文件为准（§4.8）；`sent` 超过 2 小时仍未出现才判失败 |
| 2 | IDM 可能跳过相同 URL 的重复下载 | Nexus 每次生成的链接通常唯一；重复项优先靠扩展的三源去重 |
| 3 | 桥接无鉴权，只监听 `127.0.0.1` | 任何本机页面理论上都能 POST；`allowedHosts` 是唯一限制，不要暴露端口 |
| 4 | 扩展 ID 由 `manifest.json` 的 `key` 固定 | 改 key 后必须重跑 `native-host/install.ps1` 更新 `allowed_origins`；桥接方式不受影响 |
| 5 | content script 只注入顶层 frame，`document_start` | Nexus 下载控件目前都在顶层；若站点改到 iframe，需要加 `all_frames` 并重新验证 |
| 6 | 交互式 Cloudflare Turnstile 无法自动点 | 后台标签页会自动打开并在 12s 后切到前台；managed challenge 可全自动，交互式仍需用户点一次 |
| 6 | 扩展“重新加载”不会向已打开页面重新注入脚本 | 必须刷新 Nexus 页面 |
| 7 | MV3 service worker 会休眠 | `recent` 去重 Map 只存在内存；持久状态必须写 `chrome.storage.local` |
| 8 | 合集队列在 content script 里 | 关闭合集标签页会停止队列；重开会恢复进度，点“继续”继续 |
| 9 | Nexus 免费账号有下载间隔/频率限制 | 合集已主动限速；单文件连续点击仍可能触发 429，等一会儿再试 |
| 10 | Cloudflare 验证无法由扩展代替 | 合集停在该条并打开 mod 页；单文件提示刷新页面完成验证 |
| 11 | 合集列表依赖 `api.nexusmods.com/v2/graphql`（官方标注 WIP） | 字段变化会读不到列表；`node tools/print-collection.js <game> <slug>` 可快速定位 |
| 12 | 合集面板只出现在 `/games/<game>/collections/<slug>` | 文件页仍走一键下载逻辑 |
| 13 | 合集下载受免费账号 + 间隔下发限制 | 每 5s 一个链接（可调），并发默认 2；100 个 mod 约 8–10 分钟下发完，实际完成看网速 |
| 14 | 原生宿主在 IDM 6.42 上不可靠 | 由原生宿主链启动的 IDM 会忽略命令行；默认走桥接 |
| 15 | 部分 Nexus CDN 链接以 UUID 结尾 | 无文件名时不传 `/f`，让 IDM 按 `Content-Disposition` 命名；旧桥接可能落成无扩展名文件 |

---

## 13. 许可证与参考

- 本项目：MIT，见 `LICENSE`。
- 参考实现：[thomasthanos/nexusmods-bypass](https://github.com/thomasthanos/nexusmods-bypass)。
  - 其 `src/content/nnw.js` 为 GPL-3.0-or-later，基于 Nexus No Wait ++。
  - 本项目的解析/回退逻辑是按行为重写的，没有直接复制其源码；后续贡献请保持同样原则。
