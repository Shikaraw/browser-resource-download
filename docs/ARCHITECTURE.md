# 架构说明

## 运行模型（MV3）

```
┌──────────────────────────────────────────────────────────────────────┐
│  popup/popup.html  (用户界面，380×600)                                │
│    ├─ 只在用户点击 #btn-scan 后才发 SCAN_PAGE                          │
│    └─ onPush() 订阅 scan/progress、download/* 推送                     │
└────────────────┬─────────────────────────────────────────────────────┘
                 │ chrome.runtime.sendMessage (lib/messaging.js)
                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│  background.js  (Service Worker，无 DOM)                              │
│    ├─ scanTab()      → chrome.scripting.executeScript 注入扫描器        │
│    ├─ startDownloadBatch() → chrome.downloads 并发队列                 │
│    ├─ 右键菜单 / 命令 / 通知 / 设置读写                                 │
│    └─ offscreen 剪贴板兜底                                            │
└────────────────┬─────────────────────────────────────────────────────┘
                 │ chrome.tabs.sendMessage
                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│  content/scanner.js  (注入到目标页面，仅点击后注入)                       │
│    └─ 9 个阶段收集资源 → 去重 → 返回 ScanResult                        │
└──────────────────────────────────────────────────────────────────────┘
```

**关键安全约束**：`manifest.json` **没有** `content_scripts` 字段。
页面加载时扩展不接触任何页面内容；扫描器只在 `SCAN_PAGE` 到达时注入。

## 扫描流水线

`content/scanner.js` 的 `runScan()` 按顺序执行 9 个阶段，每个阶段之间
`await setTimeout(0)` 让出主线程（避免长任务卡住用户页面）：

| # | 阶段 | 收集内容 |
|---|---|---|
| 1 | `scanMediaTags` | `<video>` / `<audio>` / `<source>` / `<img>`（含 `srcset` 最大候选）/ `<picture><source>` |
| 2 | `scanCssBackgrounds` | 计算样式中的 `background-image: url(…)`（上限 800 个） |
| 3 | `scanLinks` | `a[href]` 中的媒体直链与 `a[download]` |
| 4 | `scanMeta` | `og:image` / `og:video` / `og:audio` / `twitter:image` / JSON-LD `contentUrl` |
| 5 | `scanNetwork` | `performance.getEntriesByType('resource')` 里的媒体请求（含 m3u8 / mpd / ts） |
| 6 | `scanIframes` | 同源 iframe 的 `src`（默认关闭） |
| 7 | `scanBlobMedia` | `blob:` 媒体（默认关闭，实验性） |
| 8 | `highlight` | （按需）滚动定位并高亮页面中的某个资源 |
| 9 | `pageDownload` | （按需）页面内触发 blob 下载 |

### 去重与过滤

* **归一化键**：去掉 hash 后作为 `seen` Map 的 key；`data:`/`blob:` 取前 512 字符。
* **合并更完整元信息**：同一 URL 再次出现时补齐宽高、时长、封面、大小。
* **`blocked` 集合**：`minImageSize` 过滤掉的小图（如 1×1 埋点像素）会被拉黑，
  后续网络阶段**不得**再加回来 —— 这是一个真实踩过的 bug，有 E2E 覆盖。
* **稳定 ID**：`hashId(kind + '|' + url)`，FNV-1a 变体，12 字符 base36。
  同一资源在多次扫描中得到相同 id，便于 UI 复用状态。

### 超时与部分结果

`scanTimeoutMs` 到期后：background 向页面发 `CONTENT_ABORT`，
同时返回**已收集的部分结果**（`timedOut: true` + 警告），
而不是直接失败 —— 大页面上这比空手而归有用得多。
扫描器每个阶段都会把当前快照随 `content/partial` 上报，background 按 URL 合并。

## 下载队列

```js
startDownloadBatch(items, options)
  ├─ 过滤：非法协议 / downloadable === false / 超过 maxFileSize
  ├─ planFilenames()：sanitize + 按类型分目录 + 批内同名去重
  ├─ batch = { queue, concurrency, conflictStrategy, done, failed, ... }
  └─ runBatch(): N 个 worker 并发消费队列
       └─ downloadOne()
            ├─ blob: → 页面侧导出（content/pageDownload）
            └─ 其余 → chrome.downloads.download({ conflictAction })
                 └─ waitForDownload()：onChanged 事件 + 1.2s 轮询双保险
```

**为什么轮询**：MV3 Service Worker 可能休眠，`chrome.downloads.onChanged`
事件在休眠窗口内会丢失。事件 + 轮询组合保证终态一定收敛。

**进度节流**：`throttle(batchId, 100ms)`，避免 100 个文件时刷爆消息通道。

**文件名策略**：
1. 取 `title`，去掉 query/hash；
2. `sanitizeFilename()` 去掉 `< > : " / \ | ? *` 与控制字符，限长 120；
3. 补扩展名（`ext` → URL 推断 → `bin`）；
4. 批内同名加 ` (2)`、` (3)` 后缀；
5. 按 `organizeByType` 拼 `videos/` `images/` `audios/` `others/`。

## 消息协议

| 方向 | type | 说明 |
|---|---|---|
| popup → bg | `scan/page` | 请求扫描 `{ tabId }` |
| popup → bg | `scan/cancel` | 取消扫描 |
| popup → bg | `download/items` | 批量下载 |
| popup → bg | `download/cancel` | 取消批次 |
| popup → bg | `settings/get` / `settings/set` | 设置读写 |
| popup → bg | `ui/openOptions` | 打开设置页（复用已有标签） |
| popup → bg | `page/highlight` | 页面内定位资源 |
| popup → bg | `util/copyText` | 剪贴板（offscreen 兜底） |
| bg → popup | `scan/progress` | `{ phase, found, label }` |
| bg → popup | `download/progress` | `{ batchId, total, done, failed }` |
| bg → popup | `download/itemState` | `{ batchId, id, state, error }` |
| bg → content | `content/scan` / `content/abort` | 触发 / 中止扫描 |
| content → bg | `content/partial` | 阶段快照（含已收集项） |

所有 popup 侧调用都经 `lib/messaging.js` 的 `rpc()`，统一返回
`{ ok: true, data }` 或 `{ ok: false, error }`，带超时兜底。UI 层**不直接**
调用 `chrome.downloads` / `chrome.scripting`，便于测试与替换。

## 设计系统

`lib/theme.css` 是唯一样式令牌来源：

* **品牌**：`--brand-1 #6366f1` → `--brand-2 #22d3ee`（indigo→cyan 135°）
* **类型色**：`--c-video #f472b6` / `--c-image #38bdf8` / `--c-audio #a78bfa` / `--c-other #94a3b8`
* **主题**：`:root[data-theme="light"]` 覆盖整套表面色；`system` 由 `applyTheme()` 解析
  `prefers-color-scheme` 后写入 `<html data-theme>`。
* **组件类**：`.btn` `.card` `.tag` `.badge` `.check` `.switch` `.segmented`
  `.chip` `.progress` `.skeleton` `.empty` `.toast` `.appbar` `.brand` `.field` `.input` `.select`

组件按 BEM 式扁平类名，页面级 CSS 只写布局，不重复定义组件外观。

### popup 尺寸禁忌（重要）

扩展 popup 的宽度**由浏览器按文档内容尺寸测量后决定**，因此内容宽度绝不能反过来依赖视口：

```css
/* ✗ 曾经的线上 bug：popup 塌缩成一条竖缝 */
html, body { max-width: 100vw; }
```

形成死循环的过程：popup 初始视口很窄 → `max-width: 100vw` 把 `body` 夹窄 →
浏览器测得内容很窄 → popup 锁定成窄缝。用户看到的就是「UI 只有一个窄条，图标竖排」。

正确做法是**固定像素宽度**，并用 `min-width` 而非 `max-width` 兜底溢出：

```css
html, body { width: 380px; }              /* 固定，不随视口变化 */
html, body { min-width: 380px; }          /* 被嵌进更窄环境时也只裁剪、不压扁 */
```

`tests/check-structure.mjs` 第 9 组会静态扫描 `popup/popup.css` 与 `options/options.css`，
禁止在 `html` / `body` / `:root` 上用 `vw` / `vh` 约束宽度（`options.css` 的
`min-height: 100vh` 属正常整页布局，不在禁止之列）。

## 跨浏览器

本扩展是标准 MV3，`chrome.*` API 在 Edge 与 Chrome 上通用，未使用任何私有 API。
差异只在**分发**（商店独立）与**少量运行时行为**（内部页协议、`openPopup` 限制、
`--load-extension` 在新版 Chrome 被移除）。详见 `docs/CROSS-BROWSER.md`。

`tests/check-structure.mjs` 第 10 组会校验「代码用到的 `chrome.*` API」与
「manifest 声明的权限」是否一致——漏声明会让 API 变成 `undefined` 而非报错，
功能会**静默失效**（本项目曾漏 `offscreen` 权限，导致剪贴板整条路径降级）。

## 测试

| 脚本 | 作用 |
|---|---|
| `node tests/check-structure.mjs` | 静态巡检：文件、manifest、`_locales`、import 解析、必需 DOM id、内联脚本、图标尺寸/RGBA、popup 宽度禁忌 |
| `node tests/e2e.mjs` | 真实 Edge 加载扩展：CDP 驱动，扫描 → 断言资源 → 下载 → **校验落盘** |
| `node tests/e2e-scan.mjs` | 扫描器专项：最小尺寸过滤、去重、拦截网络复现 |
| `node tests/screenshots.mjs` | 在扩展上下文批量截 mock 各状态图到 `docs/screenshots/` |
| `node tests/package.mjs` | 打包到 `dist/`（白名单 + 排除 dev/test 资产） |

E2E 的几个坑（已在代码注释中标明）：

1. `DevToolsActivePort` 的**第二行**才是 browser WebSocket 路径；
2. 子进程 `stdio: 'pipe'` 必须消费输出，否则 64KB 缓冲填满会**阻塞浏览器启动**；
3. Edge 自带多个内置扩展也有 `background.js`，必须读 `getManifest().name` 认领本扩展；
4. `default_locale` 没有 `_locales/` 会让浏览器**拒绝加载整个扩展**；
5. 下载目录通过预置 `Default/Preferences` 的 `download.default_directory` 指定；
6. **关闭浏览器必须优雅退出**：一律走 `tests/lib/browser.mjs` 的 `shutdownBrowser()`
   （CDP `Browser.close` → 等待退出 → 兜底 kill）。直接 `proc.kill()` 会跳过 Chromium
   的窗口销毁流程，在桌面上留下**DWM 幽灵窗口**——Alt+Tab 看得见、白屏、点不进去、
   任务栏无按钮，且因为宿主进程已死，Win32 枚举不到也杀不掉，只能重启 DWM 或注销。
