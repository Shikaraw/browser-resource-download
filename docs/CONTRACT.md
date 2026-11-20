# 开发契约 (CONTRACT)

> 本文件是 `edge-resource-download` 各模块之间的**强制接口约定**。
> 任何人修改 `lib/` 中的常量 / 消息 / 设置字段，都必须同步更新本文件。
> 目录职责：
>
> | 目录 | 负责人 | 说明 |
> |---|---|---|
> | `lib/` | Lead | 常量、工具、设置、消息、主题（**已冻结，见下**） |
> | `background.js` | Lead | Service Worker：扫描调度、下载队列、通知、右键菜单 |
> | `content/scanner.js` | Lead | 注入式扫描器，**只在用户点击后才注入** |
> | `popup/` | popup-ui | 主面板 UI（HTML/CSS/JS） |
> | `options/` | options-ui | 设置页 UI（HTML/CSS/JS） |
> | `icons/` | icon-artist | 插件图标 16/32/48/128 PNG + logo.svg |
> | `docs/` | Lead | 说明文档 |

---

## 1. 运行环境

* Manifest V3（Edge / Chrome 116+）。
* popup 尺寸：**380 × 600**（`width:380px; min-height:600px; max-height:600px`）。
  浏览器会裁掉超出部分，因此 popup 内部必须**整页滚动**，不要出现横向滚动。
* 所有页面使用 ES Module：`<script type="module" src="./popup.js"></script>`。
* CSP 默认：**禁止内联 `<script>` 与 `onclick=""`**，所有事件用 `addEventListener`。
* 不使用任何 CDN / 外部字体 / 外部图片。图标一律用**内联 SVG**（可与 `theme.css` 变量配合）。
* 中文文案；用词统一：资源 = resource，扫描 = 扫描，下载 = 下载。

## 2. 公共库（lib/，已实现，直接 import，勿改动）

```js
import { MSG, KIND, KIND_LABEL, KIND_COLOR, KIND_FOLDER, DL_STATE, STORAGE_KEYS,
         DEFAULT_SETTINGS, SIZE_LIMIT_OPTIONS, CONCURRENCY_OPTIONS, CONFLICT_OPTIONS } from '../lib/constants.js';
import { formatBytes, formatDuration, sanitizeFilename, hostOf, errMsg, el, debounce } from '../lib/utils.js';
import { getSettings, patchSettings, saveSettings, resetSettings, onSettingsChanged,
         applyTheme, loadUiState, saveUiState } from '../lib/settings.js';
import { rpc, scanPage, cancelScan, downloadItems, cancelBatch, openOptions,
         highlightResource, copyText, fetchSettings, pushSettings, onPush,
         getActiveTab, isScannableUrl } from '../lib/messaging.js';
```

* `popup/popup.html` 与 `options/options.html` 都必须引入：
  ```html
  <link rel="stylesheet" href="../lib/theme.css">
  <link rel="stylesheet" href="./popup.css">   <!-- 或 ./options.css -->
  ```
* `theme.css` 已提供设计令牌与通用组件：`.btn` `.card` `.tag` `.badge` `.check`
  `.switch` `.segmented` `.chip` `.progress` `.skeleton` `.spinner` `.empty`
  `.toast-host` `.appbar` `.brand` `.field` `.input` `.select` `.panel` 等，**优先复用**，
  页面级 CSS 只写布局与少量特化样式。颜色必须用 CSS 变量（`--brand-1`、`--c-video`…）。

## 3. 数据模型

### 3.1 ResourceItem（扫描结果条目）

```js
{
  id: 'a1b2c3d4e5f6',   // 稳定去重 ID（由 url+kind 派生，scanner 生成）
  url: 'https://…',      // 绝对 URL，可为 http(s)/blob:/data:
  kind: 'video'|'image'|'audio'|'other',
  mime?: 'video/mp4',
  title?: '样例名称.mp4',  // 展示名（已解码）
  ext?: 'mp4',
  width?: 1280, height?: 720,
  duration?: 12.5,        // 秒
  size?: 10485760,        // 字节（可能缺失）
  poster?: 'https://…',   // 视频封面
  source?: 'img'|'video'|'audio'|'css'|'link'|'stream'|'meta'|'canvas'|'blob',
  isStream?: true,        // m3u8 / mpd 清单
  downloadable?: true     // false 表示需特殊处理（如 blob 未开启导出）
}
```

**`downloadable === false` 的语义**：该资源**不应进入 `downloadItems()`**。
UI 应禁用该卡的下载勾选并给出「需特殊处理」文案（例如 blob 媒体未开启实验导出）。

**`title` 兜底顺序**：`title` → `basenameFromUrl(url)` → `「视频/图片/音频/其他」+ '资源'`。
scanner 侧已保证 `title` 非空；UI 侧仍需兜底以防脏数据/旧缓存。

### 3.2 ScanResult（`scanPage()` resolve 的 `data`）

```js
{
  pageUrl, pageTitle, host,
  items: ResourceItem[],
  elapsedMs: 1234,
  timedOut: false,
  counts: { videos: 3, images: 8, audios: 1, others: 0, total: 12 },
  warnings: ['部分样式表因跨域无法读取']
}
```

> `scanPage(tabId)` 返回 `{ ok:true, data: ScanResult }` 或 `{ ok:false, error:'中文错误' }`。
> 未点按钮前**不会**发生任何扫描；popup 打开后应停留在 idle 态。

### 3.3 下载

```js
// 开始批量下载
const res = await downloadItems(items, {
  folder: 'EdgeResourceDownload',  // 相对下载目录子文件夹
  organizeByType: true,            // 自动 videos/ images/ audios/ others/
  conflictStrategy: 'uniquify' | 'overwrite' | 'prompt'
});
// res.data => { batchId: 'b_xxx', started: 12, failed: 0 }
```

### 3.4 后台推送（`onPush(cb)`）

| `msg.type` | `msg.payload` | 说明 |
|---|---|---|
| `scan/progress` | `{ phase:'collecting'\|'probing'\|'done', found:number, label?:string }` | 扫描阶段进度 |
| `download/progress` | `{ batchId, total, done, failed, succeeded, canceled?:boolean }` | 批量进度（节流 ≤10 次/秒） |
| `download/itemState` | `{ batchId, id, state: DL_STATE.*, error?:string, size?:number }` | 单条状态 |

**`done` / `failed` 语义（务必按此实现）**

* `done` = **已完成数，含失败**（succeeded + failed），用来算进度 `done / total` 与完成判定 `done >= total`；
* `failed` = `done` 中的失败子集；`succeeded` = `done - failed`。
* 前端显示「成功」请用 `done - failed`，**不要**把 `done` 直接当成功数。

> 历史坑：background 内部曾用 `batch.done`（仅成功）与 `batch.failed` 两个独立计数器，
> 对外直接透传 `done: batch.done`，与前端「done 含 failed」的假设冲突，
> 导致所有失败场景下「成功数」多算、进度提前到 100%。现已在
> `pushProgress()` 中统一为 `done = batch.done + batch.failed`。

`DL_STATE = { PENDING:'pending', DOWNLOADING:'downloading', DONE:'done',
               FAILED:'failed', CANCELED:'canceled', SKIPPED:'skipped' }`

## 4. popup 契约（popup-ui 负责）

### 4.1 文件

```
popup/popup.html
popup/popup.css
popup/popup.js          ← 唯一逻辑入口，可自行再拆 1-2 个模块文件（放在 popup/ 下）
```

### 4.2 必须实现的状态机

页面根节点 `<body data-state="idle|scanning|results|downloading|error">`，通过
`body.dataset.state` 切换，CSS 用 `body[data-state="…"]` 控制显隐。

1. **idle**：欢迎/说明 + 主按钮 `#btn-scan`「扫描本页资源」+ 当前页面信息
   （favicon/标题/host）。**强调隐私：点击后才会读取。** 底部显示上次扫描摘要（如有）。
2. **scanning**：`#scan-progress`（`.progress` 或扫描动效）+ 动态文案 + 「取消」按钮
   `#btn-cancel-scan`。SSE 式更新来自 `onPush` 的 `scan/progress`；同时 `scanPage()` 在
   promise 完成时切到 results。
3. **results**：
   * 顶部工具栏：类型筛选 chips（全部/视频/图片/音频/其他，带数量 badge）、搜索框、排序
     （大小 / 尺寸 / 名称）、视图切换（grid/list）、全选 checkbox `#check-all`。
   * 资源网格容器 `#results-grid`，**必须**为每个资源渲染 `article.resource-card`，
     带 `data-id`、`data-kind`、内含 `.check input[type=checkbox]`（`data-id` 同步）。
     卡片需展示：缩略图（图片/视频封面，`src` 直接使用资源 url 或 poster，加载失败要有
     占位回退）、类型 tag、文件名/标题（2 行截断）、尺寸或时长、大小。
     卡片右下角悬浮按钮：预览（在新标签打开原资源）、复制链接、高亮定位（调用
     `highlightResource(tabId, url)`）。
   * 滚动容器 `#results-scroll`（虚拟滚动非必须，但 >300 条时不要卡死：用
     `requestAnimationFrame` 分批插入或 `content-visibility:auto`）。
   * 底部粘性操作栏 `#actionbar`：左侧「已选 N / 共 M（合计大小）」，右侧 `#btn-download`
     「下载选中」+ 次级按钮「下载全部」`#btn-download-all`。
   * 空结果用 `.empty` 组件。
4. **downloading**：整体进度条 + `N/M`、每卡状态徽标（排队/下载中/完成/失败/跳过）、
   `#btn-cancel-download`。全部结束后显示完成摘要（成功/失败数、打开下载目录或
   下载管理页的按钮）。
   * 「下载管理页」必须按 UA 选择协议：Edge 上是 `edge://downloads/`，
     其他 Chromium 是 `chrome://downloads/`。**不能硬编码 `chrome://`**——
     在 Edge 上会打开**空白页**，用户会误以为功能坏了。
   * 打开后需回查该标签页 `url`，若仍是 `about:blank` 则自动关闭并提示，
     避免在用户窗口里留下空白页。
5. **error**：`chrome://` / `edge://` 等不可扫描页面、注入失败的友好提示 + 「重试」。

### 4.3 必须存在的 DOM id（自动化巡检会检查）

`#btn-scan` `#btn-cancel-scan` `#scan-progress` `#results-grid` `#results-scroll`
`#check-all` `#search-input` `#sort-select` `#view-seg` `#kind-chips` `#actionbar`
`#btn-download` `#btn-download-all` `#btn-settings` `#empty-state` `#toast-host`
`#page-info` `#selected-summary` `#filter-counts`

**已实现的辅助 id（popup/ 内，按实现为准）**

| 分组 | id |
|---|---|
| 状态容器 | `#stage` `#view-idle` `#view-scanning` `#view-results` `#view-error` |
| 顶栏/页面信息 | `#app-ver` `#btn-rescan` `#page-tile` `#page-host` `#page-title` `#page-badge` `#tab-mode-hint` `#tab-mode-hint-text` |
| 扫描态 | `#scan-phase` `#scan-detail` `#scan-found` `#scan-elapsed` `#scan-notice` |
| 上次摘要 | `#last-scan-card` `#last-scan-title` `#last-scan-sub` |
| 下载面板 | `#download-panel` `#dl-spinner` `#dl-title` `#dl-sub` `#dl-progress` `#dl-done` `#dl-done-text` `#btn-open-downloads` `#btn-back-results` `#btn-cancel-download` |
| 其它 | `#btn-clear-selection` `#error-title` `#error-msg` `#error-tip` `#btn-retry` `#btn-error-settings` |

**`#toast-host` 定位语义（必须遵守）**

toast **不得覆盖 `#results-grid` 内容区**。实现上把它作为**文档流内元素**
（插在顶部栏与 `#page-info` 之间）或仅用底部吸顶且留出 actionbar 高度。
页面级警告（如跨域样式表读取失败、扫描超时）**不要**用 toast——用
`#scan-notice` 这种可折叠的行内横幅。

> 历史坑：`#toast-host` 原本 `position:fixed; bottom:14px`，结果页会正好压住第二行卡片的
> 标题与尺寸信息。改为文档流内元素后，结构上不可能再遮挡内容（已用 CDP 量测重叠面积 = 0px²）。

### 4.3.1 `#empty-state` 的隐藏方式

用 **`hidden` 属性**隐藏（`<div id="empty-state" class="empty" hidden>`），
不是 `.hidden` 类。自动化断言请读 `el.hasAttribute('hidden')`。

### 4.4 交互要求

* `#btn-settings` → `openOptions()`（打开设置页）。
* 勾选状态用 `Map<id, item>` 维护；筛选/搜索只影响可见集合；**全选**作用于“当前筛选后的可见集合”。
* 下载前把 `items`（仅勾选）传给 `downloadItems`，`folder/organizeByType/conflictStrategy`
  从 `getSettings()` 取。
* 记住 UI 状态：`loadUiState()/saveUiState({ filters, viewMode, sort })`，
  受 `settings.rememberFilters` 控制。
* 键盘：`Ctrl+A` 全选可见，`Esc` 清空选择，`Enter` 触发下载（仅当有选中）。
* `applyTheme(settings.theme)` 在加载时调用，并订阅主题变化。
* 所有异步操作必须有 loading / 失败反馈，不允许静默失败。
* 无障碍：按钮有 `aria-label`，chips 用 `aria-pressed`，卡片可用 `Tab` 聚焦。

## 5. options 契约（options-ui 负责）

### 5.1 文件

```
options/options.html
options/options.css
options/options.js
```

### 5.2 布局

左侧固定导航（`#side-nav`，宽度 210px）+ 右侧内容区（最大 820px，居中）。
导航项：`扫描范围` `下载行为` `外观` `通知与快捷键` `数据与隐私` `关于`。
支持 URL hash 定位：`options.html#downloads` 打开即滚动/切到对应分节（`openOptions('downloads')`）。
窄屏 (<720px) 时导航变顶部横向。

### 5.3 必须覆盖的设置项（字段名 = `DEFAULT_SETTINGS` 的键）

**扫描范围**
| 设置 | 控件 | 说明文案要点 |
|---|---|---|
| `minImageSize` | 数字输入 + 预设 chips（16/48/128/256） | 过滤小图标/埋点图 |
| `includeMediaTags` | switch | `<video>/<audio>/<source>` |
| `includeBackgroundImages` | switch | CSS background-image（可能较慢） |
| `includeDataUrls` | switch | base64 内联资源（体积大） |
| `includeStreams` | switch | m3u8/mpd 流清单 |
| `includeBlobMedia` | switch（风险提示） | 实验性：导出 blob: 视频 |
| `includeIframes` | switch | 增加耗时 |
| `scanTimeoutMs` | range 3–30s | 扫描超时 |

**下载行为**
| `saveSubfolder` | 文本输入 | 校验：不能含 `/ \ : * ? " < > |` |
| `organizeByType` | switch | images/ videos/ audios/ others/ |
| `conflictStrategy` | select（`CONFLICT_OPTIONS`） | 同名文件策略 |
| `concurrency` | select（`CONCURRENCY_OPTIONS`）或 range | 并发数 |
| `maxFileSize` | select（`SIZE_LIMIT_OPTIONS`） | 单文件上限 |
| `autoSelectAll` | switch | 扫描后自动全选 |

**外观**
| `theme` | 三选一卡片（跟随系统/浅色/深色），需即时预览 | 写 `data-theme` |
| `viewMode` | segmented（网格/列表） | popup 默认视图 |

**通知与快捷键**
| `notifyOnComplete` | switch | 系统通知 |
| `enableContextMenu` | switch | 右键菜单「扫描本页资源」 |
| 快捷键展示 | 只读卡片 | `Alt+Shift+R` 打开面板 + 「前往 edge://extensions/shortcuts」按钮 |
| `rememberFilters` | switch | 记住筛选 |

**数据与隐私**
* 隐私声明卡片：**扩展不收集、不上传任何数据**；扫描仅在用户点击时发生。
* 存储用量展示（`chrome.storage.local.getBytesInUse`），「清空扫描历史」`#btn-clear-history`、
  「恢复默认设置」`#btn-reset`（二次确认，用页面内对话框而非 `confirm()` 也可）。
* 导出 / 导入设置 JSON（`#btn-export` `#btn-import` + hidden file input）。

**关于**
* 版本、构建信息、功能列表、`manifest` 链接、开源许可说明。

### 5.4 行为

* **自动保存**（改动后 300ms 防抖 `patchSettings`），保存成功在页脚短暂提示「已保存」；
  无需“保存按钮”。
* 导入的 JSON 要经 `mergeSettings` 校验（非法字段忽略），并提示导入结果。
* 主题切换需立即调用 `applyTheme`，同时通知 popup（storage 变更会自动同步）。
* 顶部/侧栏显示版本号（`chrome.runtime.getManifest().version`）。
* 必须存在的 id：`#side-nav` `#btn-reset` `#btn-clear-history` `#btn-export` `#btn-import`
  `#save-indicator` `#storage-usage` `#theme-cards`。

### 5.5 分节 id 与 hash 定位（实现约定）

六个分节 `<section class="section" id="…" data-section>`：
`scan` `downloads` `appearance` `notifications` `privacy` `about`。

**hash 别名**（大小写不敏感，`openOptions(x)` 可用任一）：
`scan scanning range ranges` · `download downloads saving` · `appearance theme themes view` ·
`notification notifications shortcut shortcuts hotkey` · `privacy data storage` · `about info`。
未知 hash 静默忽略并保留当前高亮，不抛错。

**滚动/高亮机制**：分节定位统一用 `html { scroll-padding-top }`；
`.section` **不要**再加 `scroll-margin-top`（两者叠加会把目标推到阅读线下方，
表现为「点击导航后高亮留在上一节」）。高亮以几何计算为主（阅读线
`clamp(150px, 34vh, 220px)`，取最后一个越过阅读线的分节），IntersectionObserver 仅作触发源，
并在导航点击后 700ms 内锁定被点击项。

### 5.6 两条实现约定

1. **`#save-indicator` 有三个状态** `data-state="idle|saving|visible|error"`，
   文案写在子节点 `.si-text`（「已保存」/「保存中…」/「保存失败」）。
2. **`saveSubfolder` 非法字符不落盘**：含 `/ \ : * ? " < > |` 时只标
   `aria-invalid="true"` 并显示 `#save-subfolder-error`，**保留上次有效值**，
   失焦还原并 toast；不做「静默存进去再报错」。

**主题「跟随系统」**：必须经 `applyTheme('system')` 解析成实际 `dark`/`light` 再写入
`<html data-theme>`。切勿直接写 `data-theme="system"`（CSS 无匹配规则，页面会失去主题）。
`#theme-current` 徽标显示**用户选择**（「跟随系统」），`data-theme` 是**解析结果**，两者故意不同。

### 5.7 新增 id（实现为准）

`#app-version` `#foot-version` `#about-version` `#about-version-num` `#link-manifest`
`#btn-shortcuts` `#btn-refresh-usage` `#storage-bar` `#storage-quota` `#history-count`
`#storage-limit` `#storage-mode-tag` `#theme-current` `#view-seg` `#min-size-chips`
`#min-size-badge` `#scan-timeout-out` `#folder-preview` `#folder-preview-text`
`#save-subfolder-error` `#confirm-dialog`（+`#confirm-title/body/ok/cancel`）
`#import-file` `#toast-host`。
每个设置控件的 `<input>` 复用字段名作 id（如 `#minImageSize` `#saveSubfolder`）。

## 6. 图标契约（icon-artist 负责）

输出到 `icons/`：

* `icon16.png` `icon32.png` `icon48.png` `icon128.png`（PNG-32，透明背景，圆角方形容器）
* `logo.svg`（矢量源文件，≤4KB，无外部引用）
* `icon-mono.svg`（单色版本，用于 popup 品牌区，`currentColor` 描边）

视觉要求：与 `theme.css` 品牌渐变一致（indigo `#6366f1` → cyan `#22d3ee`），
主题为「下载箭头 + 媒体资源」组合，16px 下仍可辨识（细节要少）。
128px 版可带更丰富细节，但四个尺寸必须来自**同一矢量源**。

## 7. 验收（Lead 会用脚本检查）

1. `node tests/check-structure.mjs`：文件存在、manifest 键值、所有 `import` 解析、
   必须存在的 DOM id 出现在对应 HTML、无内联脚本、无 `eval`、CSS 变量未被硬编码破坏。
2. `node tests/check-icons.mjs`：四个 PNG 尺寸正确、透明通道存在。
3. 用 Edge `--load-extension` 实测：打开示例页 → 点扫描 → 勾选 → 下载成功（文件落盘）。

> 提交前请在本地跑一遍 `node --check <file>` 或浏览器实际加载验证。
