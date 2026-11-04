# Collections 批量下载 — 需求梳理与开发计划

> 状态：**已实现（v0.3.1）**，本文保留为设计记录与参数依据
> 目标版本：v0.3.1（extension / bridge 同步）
> 最后更新：2026-11-04
> 实验样本：<https://www.nexusmods.com/games/monsterhunterworld/collections/vmu2j4>（Worldly Improvements，5 个 mod）
> 实现位置：`extension/collection.js`、`extension/lib/collection-utils.js`、`extension/lib/queue-pacing.js`、
> `extension/lib/file-link.js`、`bridge/idm-history.js`、`bridge/server.js`；测试见 `tools/test-collection-utils.js` 等。

> **v0.3.1 变更（以本节为准）**
> 1. 删除“估算速度/传输时间”参数：下发节奏改成**固定间隔秒数**（默认 5s，2s 下限，隐藏标签页 ×3），网速与配置无关。
> 2. 新增**最大同时下载数**（默认 2，范围 1–5）：已下发但未落盘的文件数达到上限时，队列等待对账释放名额。
> 3. 重复项语义改为“**同名文件不重复下载**”：不生成 `(2)` 文件名；默认不勾选也不下发；
>    `ask` 模式可在开始前选择“跳过 / 覆盖下载”；行内“重下”是唯一的覆盖入口（先确认，再删旧文件重下）。
> 下文 §5.4 / §6.1 / §7 中与这三点冲突的旧描述已同步修改；如仍有残留，以本节为准。

---

## 0. 结论摘要

1. **Mod 列表可以可靠拿到，不需要爬 HTML。** Nexus 的公开 GraphQL v2（`https://api.nexusmods.com/v2/graphql`）提供 `collectionRevision(slug, revision, viewAdultContent)`，一次返回合集里全部 `modFiles`（modId / fileId / 文件名 uri / 版本 / 大小 / optional / 分类）。实测 2444 个 mod 的合集一次查询 2.7s / 830KB 返回完毕，无分页问题。
2. **下载直链仍然只能在页面里换。** 官方 REST v1 的 `download_link.json` 对非 Premium 直接 403（`You don't have permission to get download links from the API without visiting nexusmods.com`）；而服务端抓 HTML 会被 Cloudflare 拦（本次实测 `GET /games/monsterhunterworld/collections/vmu2j4` → **HTTP 403 "Just a moment..."**）。所以沿用现有架构：**在已登录、已过验证的页面上下文里 `POST GenerateDownloadUrl`**，再把直链交给桥接 → IDM。
   > **本机账号是免费账号**（已确认），所以连"Premium + API key 快路径"这个选项都不存在：页面换链是唯一路线，节奏/限速必须当作一等公民来做，见 §6.1。
3. **Cloudflare 不存在稳定的"绕过"手段，但可以做"不触发 + 自动恢复"。** 关键是把所有 Nexus 请求都放在页面内、串行、带抖动间隔；一旦识别到挑战就立刻暂停队列，用定时探针（不是整页刷新）检测会话恢复后自动续跑。这部分在 §6 详细设计。
4. **去重不能靠 URL。** 每次生成的 CDN 直链 `md5`/`expires` 都不同。可行且已验证的身份是：`gameId:modId:fileId`（我们自己记）、`uri` 文件名（Nexus 的原始压缩包名）、`h=` 查询参数（实测同一文件多次生成的链接 `h` 不变，疑似文件内容指纹）。IDM 侧的历史记录可从注册表 `HKCU\Software\DownloadManager\<id>` 和 `%APPDATA%\IDM\DwnlData\*\log_*.log` 读出（见 §5）。
5. **架构选择：队列引擎放在 content script。** 因为换链接必须在页面里、必须带页面 Cookie 与页面上下文，把队列放到 service worker 只会多一层 IPC 和 MV3 生命周期坑。代价是"下载期间不能关标签页"，用持久化 + 断点续跑解决。
6. **下发节奏是安全性的核心（参考 nexusmods-bypass 的做法）。** 不做"一次性全部下发"：换一个链接、交给 IDM、等它落盘（或超时）+ 额外 N 秒，再换下一个；429 全体共享冷却；Cloudflare 立刻停在那一条上不动。具体参数见 §6.1，取值直接对齐 bypass 的默认值（2s 硬下限 / 5s 额外等待 / 3.2MB/s 估算 / 30s→600s 冷却）。

---

## 1. 现状盘点

### 1.1 现有能力（v0.2.2）

```
Nexus 文件页点 Manual download
  → content.js 拦截点击、读 file_id
  → 页面内 GenerateDownloadUrl / /api/files/<uid>/download / 抓下载页
  → background.js → 桥接 127.0.0.1:38765
  → IDMan.exe /n /d <url> /p <dir> [/f <name>]
```

- 单文件、点击触发、无队列、无进度、无去重、目录固定为 `config.downloadDir`。
- `docs/DEVELOPMENT.md` §0 明确把 **Collections 批量队列**列为非目标 —— 本计划正式把它纳入范围。

### 1.2 可复用的现成资产

| 资产 | 位置 | 复用方式 |
|---|---|---|
| `GenerateDownloadUrl` 调用与解析 | `content.js: callGenerateDownloadUrl / resolveDownloadUrl` | 抽出"按 fileId 换直链"的纯函数，供合集复用 |
| `ab` 广告计时 cookie 处理 | `content.js: markAdTimerCookie` | 原样复用，批量下反而更重要 |
| 响应解析 / Cloudflare 识别 | `nexus-utils.js: parseDownloadUrlResponse / isCloudflareChallenge / describeResponseError` | 直接复用 |
| 文件名推断 | `nexus-utils.js: filenameFromName` | 合集场景改用 GraphQL 的 `uri`，更准 |
| 桥接与 IDM 命令行 | `bridge/server.js` | 扩展 `subdir`、磁盘/IDM 去重、目录探测 |
| toast（Shadow DOM）模式 | `content.js: buildToast` | 面板沿用同样的 Shadow DOM 隔离写法 |
| 单测基线 | `tools/test-nexus-utils.js`（17 项） | 新增合集相关纯函数单测 |

### 1.3 代码地图（改动会落在哪）

```
extension/
  manifest.json            ← 新增 host_permissions(api.nexusmods.com)、content_scripts 增加文件、版本号
  background.js            ← 新增 nd:collectionResolve / nd:idmHistory / nd:checkFiles / 下发记录
  content.js               ← 点击拦截里排除面板；抽出"按 fileId 换直链"
  lib/nexus-utils.js       ← 少量补充（合集路径解析、Cloudflare 判定增强）
  lib/collection-utils.js  ← 【新】纯函数：URL→slug、响应归一化、目录名清洗、去重键、IDM 记录匹配
  lib/queue-pacing.js      ← 【新】纯函数：等待时间、退避、Retry-After、共享冷却
  collection.js            ← 【新】面板 UI + 队列引擎（content script）
bridge/
  server.js                ← /download 支持 subdir + onExisting；新增 /check、/idmHistory、/openFolder?subdir
  idm-history.js           ← 【新】读 IDM 注册表 + DwnlData 日志
native-host/config.json    ← 新增 collectionRoot / collectionFolderSuffix / 节奏参数
tools/
  test-collection-utils.js ← 【新】纯函数单测
  test-idm-history.js      ← 【新】IDM 历史解析单测（用固定样本）
  print-collection.js      ← 【新】CLI：给定 slug 打印合集 mod 列表（回归用，不需要浏览器）
docs/
  COLLECTIONS.md           ← 本文
  DEVELOPMENT.md           ← 更新架构、接口、消息、测试矩阵
```

---

## 2. 需求拆解

| 编号 | 需求（你的原话 → 可验收描述） | 验收标准 |
|---|---|---|
| **R1** | 进入 collection 页面时识别有哪些 mods 可以下载 | 打开 `/games/<game>/collections/<slug>` 自动注入面板；列出全部 mod 的 mod 名 / 文件名 / 版本 / 大小 / optional；不可下载项要标出原因（已删除、被隐藏、外部来源） |
| **R2** | 用列表列出来 | 面板内表格，支持滚动、搜索/过滤（可选）、按状态看 |
| **R3** | 一次性下载全部 / 单独某几个 / 多选 | 每行 checkbox（未勾选=不要）；"全选 / 仅缺 / 反选"；"下载选中(n)" + "下载全部" |
| **R4** | 下载到本地目录 | 每个 mod 生成直链 → 交给 IDM；串行限速；失败可单条重试；整体可暂停/继续 |
| **R5** | 用户指定根目录，按 collection 名字建新文件夹 | 设置里填根目录；实际落到 `<根目录>\<collection 名>\<uri 文件名>`；不同合集互相隔离 |
| **R6** | 天然去重（目录）+ IDM 历史 + 扩展下发记录 | 三源都参与判定，重复项默认不勾选并标注来源 |
| **R7** | 遇到重复任务要用户确认 | 默认跳过；可切换"每次询问"；确认框只有 跳过 / 覆盖下载 / 取消；不生成 `(2)` |
| **R8** | 规避/应对 N 网人工验证 | 不触发（页面内、串行、抖动）+ 自动暂停 + 定时探针 + 自动恢复；**不做**任何绕过验证的技术 |

补充的非功能性要求（建议一并做）：

- **R9 可恢复**：刷新页面 / 关标签页后重开，队列状态还在，可"继续上次进度"。
- **R10 可观测**：每条有状态（待下载/解析中/已交给 IDM/已落盘/失败原因）；面板底部有日志与进度条。
- **R11 安全**：桥接只接受"根目录 + 单层子目录"，拒绝绝对路径与 `..`。

---

## 3. 实测验证结果（本次已跑通）

### 3.1 GraphQL v2：合集 mod 列表

```graphql
query CollectionRevision($slug: String!, $revision: Int!, $adult: Boolean, $domainName: String) {
  collection(slug: $slug, domainName: $domainName) {
    id slug name collectionStatus
    game { domainName id }
    latestPublishedRevision { revisionNumber modCount totalSize }
  }
  collectionRevision(slug: $slug, revision: $revision, viewAdultContent: $adult) {
    modCount totalSize downloadLink status
    modFiles {
      optional
      updatePolicy
      fileId
      file {
        fileId modId name version size sizeInBytes category uri detectedFileExtension
        mod { modId name author status adultContent }
      }
    }
  }
}
```

实测结果（`vmu2j4`，revision 2）：5 个 mod，全部 `file` 非空、`uri` 非空，例如：

```json
{"fileId":20215,"optional":false,"file":{"modId":3004,"name":"Clarity 1.7","version":"1.7",
 "uri":"Clarity 1.7-3004-1-7-1608607481.rar","category":"OLD_VERSION",
 "mod":{"name":"Clarity - More details for skills and items.","author":"Avatoxico"}}}
```

关键发现：

- **必须传 `viewAdultContent: true`**，否则只要合集里有一个成人内容 mod，整个 `collectionRevision` 返回 `ADULT_CONTENT_BLOCKED`（实测 `qdurkx`、`9zfscf` 都因此失败，加参数后正常）。
- `uri` 就是 Nexus 原始压缩包文件名（带 modId、版本、时间戳），**这是最可靠的文件名来源**，比现在 `name + detectedFileExtension` 强。
- 无分页：`modFiles` 一次性全量返回（2444 条 OK）。
- 大小：`size` 是 **KB**（实测 `Clarity 1.7` → `size: 138`、`sizeInBytes: "141761"`）；但 `sizeInBytes` 对归档文件可能是 `null`（5 个样本里有 2 个为 null），所以展示要 `sizeInBytes ?? size * 1024`。
- `file` 可为 `null`（外部来源 mod）；`file.category` 可能是 `REMOVED`（已删除）、`ARCHIVED`。`Mod.status` 是字符串（`published` / `hidden` / ...）。
- `downloadLink` 指向合集清单包（`/v2/collections/277/revisions/184543/download_link`），**不需要**——GraphQL 已给全量文件。
- 该 v2 API 官方标注 "Work in Progress"，需准备 §3.4 的降级路径。

### 3.2 Cloudflare / 人工验证

| 方式 | 结果 |
|---|---|
| 服务端 `GET` 合集页 | **403 "Just a moment..."**（本次实测）→ 说明后台/Node 侧抓 HTML 不可行 |
| 服务端 `POST api.nexusmods.com/v2/graphql` | 200，不需要登录、不触发 CF（不同基础设施） |
| 浏览器页面内 `fetch` 同源接口（现有 v0.2 一键下载） | 正常，桥接日志里已有多次 `spawned` |

结论：**验证只能在页面上下文里"顺带"通过**，我们不尝试解 Turnstile，也不伪造 `cf_clearance`。策略见 §6。

### 3.3 官方 REST API 换直链（不可行，作为对照）

`GET api.nexusmods.com/v1/games/{game}/mods/{modId}/files/{fileId}/download_link.json`：

- 需要 `apikey`；非 Premium 账号返回 403 `"You don't have permission to get download links from the API without visting nexusmods.com - this is for premium users only."`（Vortex #14549 同样的现象）。
- 所以**批量换直链继续走页面内 `GenerateDownloadUrl`**；如果本机是 Premium，可以把 REST 路径作为可选加速通道（§8 P6）。

### 3.4 降级路径（GraphQL 变更时）

1. 页面里的 `#__NEXT_DATA__` / web component 数据（待验证，可能已含合集 mod 列表）；
2. 站点自用的 `https://api-router.nexusmods.com/graphql`（同源 Cookie，已有 host 权限）；
3. 合集清单包 `downloadLink` 解压出的 `collection.json`（含 `mods[].source.{modId,fileId}`）。

三者都失败才提示"该合集暂不支持"。

### 3.5 IDM 历史（可读性实测）

- `HKCU\Software\DownloadManager\<数字ID>`：每次下载一个子键，含 `Url0`、`Host`、`Path`、`FileName`（带查询串）、`FR_FNCD`（Content-Disposition 最终文件名）、`FileSize`、`Status`、`dateAdded`、`Referer`。**这是最结构化的来源**。
- `%APPDATA%\IDM\DwnlData\<slug>_<n>\log_<n>.log`：文本日志，含 `Url https://...` 行与 `Content-Disposition: attachment; filename="..."` 行；列表被清空后仍留在这里，作为兜底。
- `%APPDATA%\IDM\UrlHistory.txt`：只有 35 行，是"添加 URL"输入框历史，覆盖有限，只作辅助。
- 需要注意：`LocalPath` 记录的是 IDM 临时目录，**不是最终保存目录**（最终目录在加密值里），所以"是否已下载到某处"不能靠它判断，仍以磁盘 + 文件名/`h` 指纹为准。

---

## 4. 数据模型

### 4.1 合集项（从 GraphQL 归一化后）

```js
{
  key: '2531:3004:20215',      // gameId:modId:fileId —— 跨次运行稳定
  gameId: '2531',
  modId: '3004',
  fileId: '20215',
  modName: 'Clarity - More details for skills and items.',
  author: 'Avatoxico',
  fileName: 'Clarity 1.7',      // 仅供展示
  uri: 'Clarity 1.7-3004-1-7-1608607481.rar',  // 落盘名（经 Windows 清洗）
  version: '1.7',
  sizeBytes: 141761,            // sizeInBytes；为空时用 size * 1024
  category: 'OLD_VERSION',
  optional: false,
  updatePolicy: 'prefer',
  available: true,              // false 时带 unavailableReason
  url: 'https://www.nexusmods.com/monsterhunterworld/mods/3004?tab=files&file_id=20215'
}
```

### 4.2 队列作业（持久化到 `chrome.storage.local.collectionJobs`）

```js
{
  jobId: 'monsterhunterworld:vmu2j4:184543',
  collection: { gameDomain, slug, name, revision, modCount, totalSize, adultContent },
  dir: 'I:\\...\\Collections\\Worldly Improvements',
  createdAt, updatedAt,
  paused: false, pauseReason: null,   // 'user' | 'challenge' | 'rate-limit' | 'bridge-down'
  items: {
    '2531:3004:20215': {
      state: 'pending',  // pending|checking|duplicate|resolving|sent|done|failed|skipped|blocked
      attempts: 0,
      url: '', h: '', uuid: '',
      error: '', duplicateOf: '', dispatchedAt: 0, doneAt: 0
    }
  }
}
```

作业键含 revision：合集更新出 v3 后是**另一份作业**；目录是否复用同名目录待定（复用就靠去重跳过已有文件，不会覆盖）。

### 4.3 扩展下发台账（`chrome.storage.local.dispatchLedger`，长期保留）

```js
{ '2531:3004:20215': { dir, name, h, uuid, at, status: 'sent'|'verified' } }
```

这是"扩展自己下发过"的唯一权威记录，独立于 IDM 是否清理了列表。

---

## 5. 去重设计

### 5.1 身份与可信度

| 层级 | 判据 | 可信度 | 何时用 |
|---|---|---|---|
| L1 磁盘 | `<dir>\<sanitized uri>` 已存在 | **高** | 预检 + 下发前最后一道 |
| L2 台账 | `gameId:modId:fileId` 在 dispatchLedger 且 dir 相同 | **高** | 预检（"扩展下发过"） |
| L3 IDM 注册表 | `Url0`/`FR_FNCD` 的文件名或 `h`/UUID 与目标匹配 | 中 | 预检（"IDM 有过记录"） |
| L4 IDM 日志/UrlHistory | 同上，从 `DwnlData\*\log_*.log`、`UrlHistory.txt` 提取 | 低 | L3 缺项时兜底 |

### 5.2 匹配键（纯函数，可单测）

1. `uri` 文件名（lowercase，去掉 Windows 非法字符后比较）——覆盖"正常命名的 CDN 链接"；
2. URL 路径段是 UUID 时用 UUID + `h` 参数——覆盖 Nexus 给 UUID 链接的情况（此时 `FR_FNCD` 可能和 `uri` 不一致，文件名匹配会漏，但 `h` 能补上）；
3. 端口/主机不参与比较（`files.` / `supporter-files.` 会切换）。

> `h` 参数待 P0 再确认一次"同一 fileId 多次生成恒定"，确认后作为首选指纹；不确定就只用 1+2，宁可漏报也不要误报（误报会挡住用户的正常下载）。

### 5.3 判定结果

- `disk` —— 文件已在目标目录（带大小、mtime，供用户判断**要不要重下到新文件名**；我们不覆盖）
- `ledger` —— 扩展之前下发过
- `idm` —— IDM 有记录（可能还在队列里，也可能是旧的）
- `none` —— 全新

### 5.4 确认交互（R7）

**策略可配、默认跳过、绝不重复下载**：`collectionDuplicatePolicy` 默认 `skip`（发现同名文件直接跳过并写日志，不打扰），可切成 `ask`（每次弹确认框）。

`ask` 模式下开始下载前弹一次：

```
发现 3 个同名文件（默认不重复下载）
  Stracker's Loader      磁盘已存在（555 KB · 2026-11-03 18:24）
  Clarity 1.7            IDM 历史有记录（2026-11-02 21:10）
  Fatalis Patch          扩展下发过（已完成 · 2026-11-02 21:22）

[ 跳过这些（推荐） ]   [ 覆盖下载（先删旧文件） ]   [ 取消 ]
```

- **不会生成 `(2)` 文件名**：桥接 `/download` 的 `onExisting` 只有 `skip` / `replace`；`skip` 直接返回 `skipped:'disk'`。
- **唯一的覆盖入口**是行内“重下”：先 `confirm()` 说明会删除同名旧文件，用户同意后才发 `replace`；队列本身永远不带 `replace`。
- 重复项在列表里默认**不勾选**；`ask` 模式下即使勾选，也要在弹框里再确认一次才会覆盖。
- 下发前（换到直链之后）再查一次 L1/L3：命中就标记 `skipped` 并写日志，不弹第二个框。

---

## 6. 反人工验证（R8）—— 设计说明

**先明确边界**：Cloudflare Turnstile / 交互式挑战无法也不应被扩展"绕过"。我们做的是三件事：不触发、能识别、能自动恢复。

### 6.1 下发节奏（参考 nexusmods-bypass，只取行为不取代码）

免费账号下**节奏比并发重要**。bypass 插件的批量队列做法（`src/content/ndc.js` + `src/lib/shared.js`）值得照搬，但**不再按文件大小估算传输时间**（网速不可预测，估算只会给出错误结论）：

| 参数 | bypass 的默认 | 我们的取值 | 说明 |
|---|---|---|---|
| 两次下发之间的硬下限 | `MIN_HANDOFF_GAP_SECONDS = 2s` | **2s** | 任何情况下都不背靠背发请求 |
| 下发间隔 | `pauseBetweenDownload = 5s`（可配 0–600） | **5s**，可配 | 固定秒数，与文件大小无关 |
| 最大同时下载 | 无（交给 Vortex） | **2**，可配 1–5 | 已下发但未落盘数达到上限就等对账释放 |
| 落盘快速观察 | `pauseBetweenDownload` 估算 | **8s** | 没看到就交给 5s 一次的对账，不判失败 |
| 失败重试 | `retryDelayMs` = 1.5s 起指数到 30s + 等量抖动 | 同 | 多标签/重启不会锁步重试 |
| 限速冷却 | 30s 起、指数到 600s，最多 6 次，**跨标签共享** | 同 | 存 `chrome.storage.local.collectionRateLimit` |
| `Retry-After` | 优先且**不缩短** | 同 | 服务器说了算 |
| 看门狗 | 7s 轮询 | 同 | 检测挑战 / 掉登录 / 页面被接管 |
| 队列排序 | `smallestFirst = true` | 同（可关） | 小文件先完成，问题早暴露 |
| 大批量确认 | 超过阈值先弹"要排 N 个文件吗" | 同（>50 弹） | 防误点 |

下发模型：

```
每隔 N 秒下发一个文件（N 默认 5，隐藏标签页 ×3）
下发前若“已下发未落盘”数量 >= 并发上限，先等对账把名额腾出来
下发后只快速观察 8 秒，没落盘就交给 5 秒一次的批量对账，不判失败
```

这样既不会一口气把几百个链接全生成，也不再用“文件大小 / 猜测速度”来做判断；下载快慢完全交给 IDM 和网络。

其余不触发措施：

1. **所有 Nexus 请求都从页面发出**（content script），复用当前标签页的 Cookie（含 `cf_clearance`）与 UA、Referer。
2. **不并发、不预生成**：链接会过期（`expires`），预生成既浪费又会触发限速。
3. **不在隐藏标签页里全速跑**：`document.visibilityState === 'hidden'` 时把间隔放大到 3 倍（后台标签页定时器节流会造成"积压后突然连发"，反而最像机器人）。
4. **只在你明确点击"开始"后跑**，不在页面加载时自动刷。
5. **免费账号的 `ab` 广告计时**：`GenerateDownloadUrl` 返回空数组时按现有逻辑写 `ab` cookie 重试一次，仍失败才计一次失败（不叠加成狂暴重试）。

### 6.2 识别

一次响应出现以下任一情况即判为"被拦"：

- HTTP `403` 且响应头有 `cf-mitigated: challenge`；
- HTML 命中 `isCloudflareChallenge()`（现有函数）；
- 重定向到 `challenges.cloudflare.com`；
- 页面出现 `cf-turnstile` / "Just a moment" 且 `document.title` 变化（页面被整页挑战）；
- `GenerateDownloadUrl` 返回空且页面 cookie `cf_clearance` 消失（疑似过期）。

### 6.3 自动恢复（"定时刷新"的正确形态）

```
检测到挑战
  → 队列 paused，pauseReason='challenge'，停在这一条上（不跳过、不推进进度）
  → 横幅：「N 网要求验证。已在下方打开 mod 页面，请在那里完成验证；通过后会自动继续」
  → 自动打开一个用于验证的标签页（见下）
  → 定时探针（不是整页刷新）：
       每 5s 一次，失败则 5→10→20→30s 退避
       探针 = fetch(location.href, { method: 'HEAD', credentials: 'include' })
              命中 200 且非挑战页 → 认为会话恢复
  → 恢复后：等待一个随机 2–5s，从"暂停的那个 mod"继续（不重头）
  → 连续 3 次挑战 / 30 分钟未恢复 → 停止并提示手动下载剩余项
```

**验证放到新标签页里做**（bypass 同款思路）：挑战时自动 `window.open(<该 mod 的 mod 页>, '_blank')`——注意**不带 `file_id`**，避免我自己的 `nd_auto=1`/点击拦截在那边又触发一次下载。`cf_clearance` 是域级 Cookie（同 profile 的所有标签页共享），在另一个标签页过关后，合集页的请求通常就会一起恢复；合集页继续跑探针，检测到 200 就自动续跑。这样即使 Cloudflare 整页接管了验证标签页，合集页的面板也不会被销毁。设置里可以关掉"自动打开验证页"（`openCheckPage`）。

**关于整页刷新**：整页刷新会销毁 content script 与面板，所以默认**不刷新**。如果确实需要刷新（页面被 CF 整页接管，脚本已失效），做法是：

1. 队列状态已持久化；
2. 面板在 `sessionStorage` 里打标记 `nd_resume_job`；
3. 刷新后 content script 检测到标记 + 未完成作业 → 重新渲染面板，显示"已恢复上次进度"，并把"继续"按钮高亮，**不自动开跑**（避免在验证还没过时又触发）。

另外可选的"保活"：长队列每 10 分钟做一次同源轻量请求（`HEAD /games/<game>/collections/<slug>`），既保 `cf_clearance` 热度，也顺便确认登录态；不做高频轮询。

### 6.4 其他被拦原因的分类（给用户不同提示）

| 现象 | 判定 | 提示 / 动作 |
|---|---|---|
| `cf-mitigated` / Just a moment | Cloudflare | 停在该条 + 打开验证页 + 探针 + 自动续跑 |
| 登录页 / 401 | 未登录 | 暂停，提示登录 |
| 429 / "too many requests" | 频率 | 全体共享冷却（30s→600s，最多 6 次），`Retry-After` 优先，冷却结束继续 |
| 502/503/504、520–524（无挑战标记） | 源站抖动 | 同一文件等 30s→300s 重试，最多 6 次，不当作文件被删 |
| 空数组 `[]` | 免费账号广告计时 | 写 `ab` cookie 后重试一次（现有逻辑） |
| 403 + "moderation" | 审核中 | 该条失败并说明，继续下一条 |
| 文件页 404 / file 为 REMOVED | 文件不存在 | 标记不可下载，跳过（这才是唯一允许"跳过并继续"的情况） |

### 6.5 落盘同步（实测修正）

首版实现只在下发后等 `min(pause*3, 180s)`（小文件 15 秒），超时就记 `sent` 并且**再也不复查**。
实测 `vmu2j4` 的 5 个文件：IDM 实际在 spawn 后 4s / 17s / 7s / 26s / 43s 才把文件放进目标目录
（IDM 自己排队），于是 3 个被永久标成"已下发未完成"，磁盘上其实全都在。

修正后的判定模型：

1. 下发后快速轮询 `/check` ≤8 秒（命中即 `done`）；
2. 否则记 `sent` + `sentAt` + 实际文件名，**不判失败**；
3. 面板每 5 秒把所有 `sent`/`waiting` 的名字**合并成一次** `/check`（几百个也只发一次请求），
   文件出现即 `done`；页面重开、切回前台、手动点"同步状态"都会立刻同步一次；
4. 超过 2 小时仍未出现 → `failed`（可重试），避免 IDM 长队列被误判为失败。

**IDM 日志/注册表不参与完成判定**，只用于去重（"这个文件以前下过吗"）。原因是 IDM 没有状态 API，
而磁盘上的文件是否存在才是我们真正关心的、且 IDM 只有在下载完成后才会把文件放到目标目录，
所以 `exists && size > 0` 是可靠的完成信号；读 IDM 内部记录既慢、又受编码/版本/清空列表影响。

---

## 7. 目录与命名（R5，已确认）

- 桥接配置：`"collectionRoot": "I:\\Program Files (x86)\\Code\\NexusDownloader\\downloads\\Collections"`（默认值；未配置时回退到 `downloadDir`）。
- 目标目录：`<collectionRoot>\<合集名> [<slug>]`，例如
  `I:\Program Files (x86)\Code\NexusDownloader\downloads\Collections\Worldly Improvements [vmu2j4]`。
- **子目录固定带 slug**（`collectionFolderSuffix` 默认 `true`），不同游戏的同名合集不会撞目录；slug 是 Nexus 的稳定短码，比合集名可靠。
- 文件名一律用 GraphQL 的 `uri`；桥接 `sanitizeFilename()` 已覆盖 `<>:"/\|?*`、保留名、长度 180，两端共用同一套规则（见 §9 的共享模块）。
- 目录由桥接创建（`fs.mkdirSync(recursive)`），扩展只传 `subdir`，**不传绝对路径**，避免扩展被滥用成任意目录写入器。
- **同名文件已存在时**：不下载、不重命名（不会出现 `(2)`）；行内“重下”是唯一覆盖入口，确认后删旧文件重下（§5.4）。
- 可选：在合集目录里写一份 `collection.json` 侧车（合集名、slug、revision、每个 mod 的 `gameId/modId/fileId/uri`、下载时间），便于以后核对/重下；体积小、无副作用。
- 打开目录：`POST /openFolder { subdir }`。

---

## 8. 工作分解（WBS）

> 难度/工作量是相对值（S ≈ 半天内，M ≈ 1 天，L ≈ 2 天+）。

### P0 · 可行性验证（先做，避免白写 UI）

| # | 任务 | 产出 | 量 |
|---|---|---|---|
| P0-1 | 在真实合集页控制台/临时脚本里验证：**从合集页** `POST GenerateDownloadUrl`（只带 `fid` + `game_id`）能否拿到直链 | 结论 + 截图/日志 | S |
| P0-2 | 验证 `h` 参数是否对同一 fileId 稳定（连续生成 3 次同一文件） | 结论（决定去重首选键） | S |
| P0-3 | 验证合集页 `#__NEXT_DATA__` 是否已含 mod 列表（可选，只影响降级路径） | 结论 | S |
| P0-4 | **免费账号节奏标定**：连续用不同 fileId 换链接，实测 2s / 5s / 10s 三档间隔下何时出现 429、`ab` 空响应或挑战；记录恢复所需时间 | 一张"安全间隔"结论表，作为默认参数 | M |

**P0 不通过时的退路**：`GenerateDownloadUrl` 若要求"必须在该 mod 的文件页"，则退化为"每个 mod 用隐藏 iframe/新标签页打开文件页再换链接"，慢但可行；或改用 `/api/files/<uid>/download` 路由（现有代码已有）。

### P1 · 数据层（GraphQL + 纯函数）

| # | 任务 | 文件 | 量 |
|---|---|---|---|
| P1-1 | `collectionPathInfo(pathname)` → `{gameDomain, slug, revision?}`；兼容 `/games/<game>/collections/<slug>[/revisions/<n>]`、`/<game>/collections/<slug>` | `lib/collection-utils.js` | S |
| P1-2 | `normalizeCollectionRevision(json)` → 4.1 的项数组；处理 `file=null`、`REMOVED`、`status!=published`、`optional`、`sizeInBytes`、成人内容 | 同上 | M |
| P1-3 | `collectionFolderName(name, slug, opts)` 目录名清洗（与桥接同规则） | 同上 | S |
| P1-4 | `dedupeKey` / `matchIdmRecord(item, records)` / `extractCdnIdentity(url)` | 同上 | M |
| P1-5 | background：`fetchCollection(gameDomain, slug, revision?)`，带 `viewAdultContent:true`、超时、错误分类、结果缓存（同 slug+revision 30 分钟内不重复拉） | `background.js` | M |
| P1-6 | 单测：路径解析 8 例、归一化 6 例（含空 file / REMOVED / optional）、目录清洗 6 例、去重匹配 8 例 | `tools/test-collection-utils.js` | M |

### P2 · 桥接层

| # | 任务 | 文件 | 量 |
|---|---|---|---|
| P2-1 | `/download` 支持 `subdir` 与 `onExisting: 'skip'\|'replace'`（默认 skip）；`replace` 只删同名旧文件，不生成 `(2)`；解析为 `path.resolve(root, subdir)` 并校验**必须仍在 root 之下**；返回 `dir`、`filename` | `bridge/server.js` | M |
| P2-2 | `/check`：`{subdir, names[]}` → `{dir, files:{name:{exists,size,mtimeMs}}}` | 同上 | S |
| P2-3 | `/idmHistory`：解析注册表 + `DwnlData` 日志 + `UrlHistory.txt`，返回 `{records:[{url,host,path,fileName,finalName,size,status,dateAdded}]}`，60s 缓存 | `bridge/idm-history.js` | M |
| P2-4 | `/openFolder` 支持 `subdir`；`/ping` 返回 `collectionRoot` | `bridge/server.js` | S |
| P2-5 | 下发前磁盘再检查（命中即 `{ok:true, skipped:'disk'}`），杜绝竞态 | 同上 | S |
| P2-6 | 配置项：`collectionRoot`、`collectionFolderSuffix`（默认 true）、`collectionPauseSeconds`、`collectionAssumedSpeedMBps`、`writeCollectionManifest` | `native-host/config.example.json` | S |
| P2-7 | 单测：subdir 穿越（`..`、`C:\`、`\\?\`、保留名）、`onExisting` 语义、IDM 记录解析（用真实样本脱敏） | `tools/test-idm-history.js` / `tools/test-bridge.js` | M |

### P3 · 面板 UI（R1–R3）

| # | 任务 | 量 |
|---|---|---|
| P3-1 | Shadow DOM 面板骨架：标题（合集名/版本/mod 数/总大小）、目录行、"改目录"入口、关闭/折叠 | S |
| P3-2 | 列表：checkbox、mod 名、文件名（截断+title）、版本、大小、状态徽标、行内操作 | M |
| P3-3 | 选择器：全选 / 全不选 / 反选 / 仅缺（未下载的）/ 仅非 optional | S |
| P3-4 | 底部：进度条（已下发/已落盘/失败）、日志区（最近 50 条）、开始/暂停/继续/重试失败 | S |
| P3-5 | 重复项确认对话框（§5.4：跳过 / 覆盖下载 / 取消）+ 行内“重下”（确认后覆盖） | M |
| P3-6 | 空/异常态：桥接未启动、未登录、合集为空、全部不可下载、revision 被撤回 | S |
| P3-7 | 与 v0.2 点击拦截共存：面板内点击不被 `handleDownloadClick` 吞掉 | S |
| P3-8 | 节奏设置：下发间隔秒数（0–600）、最大同时下载（1–5）、小文件优先、重复策略（跳过/每次问）、自动打开验证页 | S |

### P4 · 队列引擎（R4/R6/R9/R10）

| # | 任务 | 量 |
|---|---|---|
| P4-1 | 抽出 `resolveByFileId(fileId, gameId, gameDomain)`（把现有 `resolveDownloadUrl` 里"纯 fileId 换链接"的部分拆成可复用函数，保留原有 DOM 回退路径不变） | M |
| P4-2 | **节奏引擎**（§6.1）：固定间隔 `gapMs`；按下发未落盘数限制并发；隐藏标签页 ×3；小文件优先 | M |
| P4-3 | 限速/退避：共享冷却（30s→600s，6 次）、`Retry-After`、等量抖动重试（1.5s→30s）、源站 5xx 等待 30s→300s | M |
| P4-4 | 会话守卫：挑战检测 → 停在该条 → 打开验证页 → 探针 → 自动恢复（§6.3） | L |
| P4-5 | 持久化/恢复：作业 + 冷却写 `chrome.storage.local`；页面重开恢复面板；"继续"按钮 | M |
| P4-6 | 落盘确认：下发后快速轮询 `/check` ≤8s；没落盘记 `sent`，由**每 5s 一次的批量同步**（一次请求查全部 pending）转 `done`；页面重开也先同步；2 小时仍未出现才 `failed`（见 §6.5） | S |
| P4-7 | 台账写入（§4.3）+ 台账驱动的预检 | S |
| P4-8 | 失败分类与汇总（Cloudflare/未登录/429/5xx/文件不存在/桥接断开） | M |

### P5 · 打磨与交付

| # | 任务 | 量 |
|---|---|---|
| P5-1 | 设置项接入 popup：根目录（只读展示 + 提示在 config.json 改）、节奏滑块、重复策略、验证页开关 | S |
| P5-2 | popup 增加"当前合集任务"摘要（可选） | S |
| P5-3 | README / DEVELOPMENT.md / CHANGELOG 更新；版本 0.2.2 → 0.3.0（manifest + bridge + popup） | S |
| P5-4 | 全量 `node --check` + 单测 + 手动回归矩阵（§10） | M |
| P5-5 | 用 `vmu2j4`（5 个，免费账号）跑一遍真实下载，记录实际间隔与是否触发限速 | M |

### P6 · 可选增强（后续）

- "后台标签页继续"：`chrome.tabs.create({url, active:false})` 打开合集页跑队列，用户可以去干别的。
- 仅下载"缺失/过期"的增量同步（对比磁盘 + 台账，合集更新后只补差）。
- 按 mod 建子文件夹 / 自动解压（需求未提，不建议现在做）。
- ~~Premium + API key 快速通道~~：本机是免费账号，**不可用**，从计划里去掉。

**合计（P0–P5）**：约 10–13 个工作日（比上一版多 1 天，主要是节奏引擎与免费账号标定），其中 P4-4 会话守卫、P4-2/P4-3 节奏与退避、P3-2 列表是主要工作量。

---

## 9. 接口契约变更

### 9.1 桥接 HTTP（新增/变更）

| 方法 | 路径 | Body | 返回 |
|---|---|---|---|
| POST | `/download` | `{url, filename?, referrer?, source?, subdir?, onExisting?: 'skip'\|'replace'}` | `{ok, id, filename, dir, skipped?:'disk', command?}` |
| POST | `/check` | `{subdir, names:[...]}` | `{ok, dir, files:{name:{exists,size,mtimeMs}}}` |
| POST | `/idmHistory` | `{}` | `{ok, records:[...], scannedAt}` |
| POST | `/openFolder` | `{subdir?}` | `{ok, dir}` |
| GET | `/ping` | — | 增加 `collectionRoot`、`idmHistoryCount` |

安全：`subdir` 必须是**单段**或少量段、无 `..`、无盘符、无 UNC、非绝对路径；最终 `path.resolve(collectionRoot, subdir)` 必须 `startsWith(collectionRoot + sep)`。`onExisting` 默认 `skip`，桥接**没有覆盖分支**。

### 9.2 扩展消息

| 类型 | 方向 | 作用 |
|---|---|---|
| `nd:collectionResolve` | content → background | `{gameDomain, slug, revision?}` → 归一化 mod 列表 |
| `nd:collectionCheck` | content → background → bridge | `{subdir, items}` → 每项去重结论（含 IDM 记录比对） |
| `nd:collectionSend` | content → background | `{url, filename, subdir, key}` → bridge `/download` |
| `nd:collectionPoll` | content → background → bridge | `{subdir, names}` → 落盘状态 |
| `nd:collectionJobGet/Set` | content → background | 作业持久化 |
| `nd:ledgerGet/Set` | content → background | 台账读写 |
| `nd:openCollectionFolder` | content/popup → background | 打开合集目录 |

### 9.3 共享纯函数

- 新增 `extension/lib/collection-utils.js`（UMD，和 `nexus-utils.js` 同风格）；
- 新增 `extension/lib/queue-pacing.js`：`computeGapMs(opts)`、`normalizeConcurrent(v)`、`retryDelayMs(attempt)`、`parseRetryAfterSeconds()`、`nextCooldown(strike, header)` —— 纯函数，便于单测节奏策略；
- 桥接 `require('../extension/lib/collection-utils.js')` 复用 `sanitizeSegment()`，**保证扩展预检与桥接实际落盘用同一套清洗规则**（否则"预检说没有、实际写成了另一个名字"）。

---

## 10. 测试计划

### 10.1 自动

```powershell
node tools\test-nexus-utils.js        # 17 项（保持）
node tools\test-collection-utils.js   # 新增，目标 30+ 项
node tools\test-idm-history.js        # 新增，解析样本
node tools\test-bridge.js ping
node tools\print-collection.js monsterhunterworld vmu2j4   # 无需浏览器，打印列表
node --check extension\collection.js
node --check extension\background.js
node --check extension\content.js
node --check bridge\server.js
node --check bridge\idm-history.js
```

`print-collection.js` 只依赖公开 GraphQL，非常适合做"schema 变了"的回归哨兵。

### 10.2 手动回归矩阵（在 `vmu2j4` 上）

| 场景 | 预期 |
|---|---|
| 打开合集页 | 面板自动出现，5 个 mod，大小/版本正确 |
| 单选 1 个下载 | 1 个 IDM 任务，落到 `<root>\Worldly Improvements [vmu2j4]\<uri>` |
| 全选下载 | 5 个任务**串行**下发（每条等上一次落盘 + 额外 5s，任何两条间隔 ≥2s），全部落盘 |
| 再点一次"下载全部" | 5 个全部标"磁盘已存在"；默认策略下 0 个任务、日志写明跳过 |
| 切成"每次询问"后再点 | 弹框：跳过 / 覆盖下载 / 取消；选“覆盖下载”会先删同名旧文件，再重新下发，不产生 `(2)` |
| 删掉其中一个文件后重下 | 只有那 1 个需要下载 |
| 清空 IDM 列表后 | 台账 + 磁盘仍然生效，不重复下载 |
| 中途暂停 / 继续 | 不重复下发已完成项；暂停期间不发任何请求 |
| 刷新页面后重开 | 面板提示"已恢复上次进度"，已完成项状态保留 |
| 桥接未启动 | 面板提示先启动桥接，不产生半截状态 |
| 断网/超时 | 该条失败，可单条重试，不影响其他 |
| 模拟 429（DevTools 改响应头 `Retry-After: 60`） | 全体进入冷却，面板显示倒计时，冷却结束自动继续 |
| 模拟挑战（DevTools 改 fetch 返回挑战页） | 停在该条 + 横幅 + 打开验证页 + 探针恢复后自动续跑 |
| 大合集（如 1976 个） | 列表可渲染（虚拟滚动或分页），预检总耗时可控 |
| 面板内点击 / 拖选 | 不被 v0.2 的 click 拦截吞掉 |
| Ctrl+点击面板外链接 | 仍按浏览器默认行为 |

### 10.3 性能/容量

- 2444 项的列表渲染需要虚拟滚动或"分批渲染 + 搜索"，否则 Shadow DOM 卡顿；
- 作业对象写 `chrome.storage.local` 前先精简（只存状态与必要字段，不存整份 GraphQL 响应）；
- IDM 历史解析结果 60s 缓存，避免每条都 `reg query /s`（该命令可能上百毫秒）。

---

## 11. 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| 1 | 批中出现 Cloudflare 挑战 | 中 | 高 | §6.3 停在该条 + 验证页 + 探针 + 续跑；不假装成功 |
| 2 | **免费账号频率限制**（429 / 广告计时 / 挑战） | **高** | 高 | §6.1 节奏引擎（≥2s、等落盘、5s 额外等待）；共享冷却；逐条重试；面板可调慢 |
| 3 | 从合集页换直链被拒（必须先访问文件页） | 中 | 高 | P0-1 先验证；退路：隐藏 iframe/新标签页逐 mod 换链接 |
| 4 | GraphQL v2 是 WIP，字段变更 | 中 | 中 | 查询只取必要字段；`print-collection.js` 回归；三级降级（§3.4） |
| 5 | 成人内容合集被整包 block | 高 | 低 | 固定传 `viewAdultContent: true` |
| 6 | IDM 历史解析格式变动 | 中 | 低 | 只做"附加提示"，永不阻塞；解析失败就退化为 L1+L2 |
| 7 | 文件名与 `uri` 不一致（Content-Disposition） | 低 | 中 | 始终传 `/f <uri>` 强制命名；去重用 `h` 兜底 |
| 8 | 超大合集（1976 个 / 60GB） | 中 | 中 | 先展示总量与体积并二次确认；"仅非 optional"；分页渲染 |
| 9 | 标签页关闭导致队列中断 | 高 | 中 | 持久化 + 恢复；面板顶部常驻提醒；P6 后台标签页 |
| 10 | 桥接被本机其他页面滥用写文件 | 低 | 高 | 只允许 root 下单层 subdir；保持 `127.0.0.1`；不新增任意命令执行 |
| 11 | 覆盖掉用户已有文件 | 低 | **高** | 同名文件默认不下载、不重命名；`replace` 只能由行内“重下”+确认触发 |
| 12 | 面板与站点样式/事件冲突 | 中 | 中 | Shadow DOM + `all: initial`；只挂一个根节点；不改站点 DOM |
| 13 | 节奏调得过快导致连续触发风控 | 中 | 高 | 默认值保守（bypass 同款）；P0-4 实测标定；冷却后自动降速（间隔 ×1.5 并写日志） |

---

## 12. 已确认的决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 根目录 | `I:\Program Files (x86)\Code\NexusDownloader\downloads\Collections`（桥接启动时自动创建） |
| 2 | 子目录命名 | **带 slug**：`Worldly Improvements [vmu2j4]` |
| 3 | 重复项 | 默认**跳过**（不下载同名文件，不生成 `(2)`）；可切“每次询问”；覆盖只能由行内“重下”+确认触发 |
| 4 | UI 形态 | 页面内**浮动面板**（Shadow DOM，和现有 toast 同一套隔离方式） |
| 5 | 账号 | **免费账号** → 无 API 快路径，只走页面换链；节奏按 §6.1 保守取值 |
| 6 | 下发方式 | 固定间隔（默认 5s）+ 最大并发（默认 2），参考 nexusmods-bypass 的节奏；不按文件大小估算 |

仍待确认（不影响开工）：

1. 面板默认位置：右下角浮层（和现有 toast 会重叠区域）/ 左侧停靠？
2. 合集更新出新 revision 时：新目录（默认）还是沿用同名目录（靠去重跳过已有文件）？

---

## 13. 参考

- Nexus Mods GraphQL API v2 文档：<https://graphql.nexusmods.com/>
- Vortex 的 collections 查询定义（`modFiles { file { modId fileId ... } }`）：<https://github.com/Nexus-Mods/Vortex/blob/master/src/renderer/src/extensions/nexus_integration/util/graphQueries.ts>
- NexusMods.App Collections 概述：<https://github.com/Nexus-Mods/NexusMods.App/blob/master/docs/developers/misc/CollectionsOverview.md>
- REST v1 换直链仅限 Premium（现象记录）：<https://github.com/Nexus-Mods/Vortex/issues/14549>
- **节奏与队列行为参考**：<https://github.com/thomasthanos/nexusmods-bypass>
  - 重点看 `src/content/ndc.js`（队列循环、`pauseBetweenDownload` / `downloadSpeed` / `waitOutRateLimit` / `delayWithPause`）、`src/lib/shared.js`（`MIN_HANDOFF_GAP_SECONDS`、`MAX_PAUSE_SECONDS`、`RATE_LIMIT_*`、`retryDelayMs`、`queueItemGapMs`）、`src/content/errors.js`（错误分类与 blocking 判定）。
  - 该仓库是 source-available，其中 `src/content/nnw.js` 为 **GPL-3.0-or-later**。本项目是 MIT，**只参考行为与参数取值，不复制其代码/选择器/正则/文案**（与 `docs/DEVELOPMENT.md` §7 的原则一致）。
- IDM 命令行参数：<https://secure.internetdownloadmanager.com/support/comand_line.html>
- 现有开发文档：`docs/DEVELOPMENT.md`
