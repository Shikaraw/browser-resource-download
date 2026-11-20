# 跨浏览器兼容性

> 结论先行：**本扩展的代码在 Edge 与 Google Chrome 上通用**，
> 差异集中在「分发」与「少量运行时行为」，不在业务逻辑。

## 1. 为什么通用

Edge 基于 Chromium，与 Chrome 共用同一套扩展运行时：

| 维度 | Edge ↔ Chrome | 说明 |
|---|---|---|
| 扩展打包格式 | ✅ 通用 | 同为 CRX3；解压目录同样可侧载 |
| Manifest V3 | ✅ 通用 | 同一份 `manifest.json` 两边都能加载 |
| Service Worker（`type: module`） | ✅ 通用 | |
| `chrome.*` API | ✅ 通用 | 本扩展用到 36 个，无私有 API |
| `_locales` / `default_locale` | ✅ 通用 | |
| popup / options / offscreen | ✅ 通用 | |
| CSP（禁内联脚本） | ✅ 通用 | |

本扩展**没有**使用任何 `ms-*`（Edge 私有）或 `browser.*`（Firefox 风格）调用，
因此不需要写浏览器分支即可跨两边运行。

## 2. 真正的差异

### 2.1 内部页协议（运行时差异）

| 用途 | Edge | Chrome |
|---|---|---|
| 扩展管理 | `edge://extensions` | `chrome://extensions` |
| 下载管理 | `edge://downloads` | `chrome://downloads` |
| 快捷键设置 | `edge://extensions/shortcuts` | `chrome://extensions/shortcuts` |

**坑**：硬编码 `chrome://downloads/` 在 Edge 上会打开**空白页**（不会报错，只是白屏），
用户会误以为功能坏了。代码必须按 UA 分支，并在打开后回查标签页 URL，
若仍是 `about:blank` 则自动关闭。

实现见 `popup/popup.js` 的 `openDownloads()` 与 `options/options.js` 的
`openShortcutsPage()`。

### 2.2 `chrome.action.openPopup()`（行为差异）

* Chrome：需 **127+**，且受「必须有用户手势/窗口处于活动状态」限制，
  后台或 headless 调用常直接抛错。
* Edge：限制相对宽松。

**坑**：早期代码 `try { openPopup() } catch {}` 把失败静默吞掉，
用户点了右键菜单毫无反应。现在失败时会发通知提示，并清除 `autoScan` 标记
（否则下次手动开面板会意外触发扫描，违反「点击前不采集」的承诺）。

### 2.3 剪贴板（两边相同，但容易误解）

offscreen 文档**永远没有焦点**，所以：

* `document.execCommand('copy')` → 失败
* `navigator.clipboard.writeText()` → `Document is not focused` 失败

**正确做法**：popup 在用户点击瞬间是有焦点的文档，应**优先在 popup 里直写剪贴板**，
offscreen 仅作兜底。见 `popup/popup.js` 的 `copyItemUrl()`。

### 2.4 自动化测试的 `--load-extension`

**Chrome 137+ 已移除该命令行开关**，传了会被静默忽略（扩展不加载，也不报错）。
因此：

* 本仓库 E2E 默认跑 **Edge**；
* `node tests/e2e.mjs --browser=chrome` 仅在旧版 Chrome（<137）或已恢复该特性的
  构建上有效；
* 验证 Chrome 兼容性请用**手动侧载**：`chrome://extensions` → 开发者模式 →
  加载已解压的扩展程序。

## 3. 分发差异

| | Edge 加载项商店 | Chrome 网上应用店 |
|---|---|---|
| 上架地址 | microsoftedge.microsoft.com/addons | chromewebstore.google.com |
| 审核 | 独立审核 | 独立审核 |
| 扩展 ID | 独立分配 | 独立分配 |
| 同一 zip 能否复用 | ✅ 可以，两边分别上传同一个 `dist/*.zip` | |

> 注意：侧载时的扩展 ID 由**目录路径**派生，换机器会变；
> 上架后的 ID 由商店分配，固定不变。若使用 `chrome.storage` 存数据，
> ID 变化会导致数据不可见，这是 Chromium 的既有行为。

## 4. 兼容性自检

`tests/check-structure.mjs` 第 10 组会静态校验：

* 代码里用到的每个需要授权的 `chrome.*` 命名空间，
  manifest 的 `permissions` 是否都已声明；
* 漏声明会让 API 变成 `undefined`，**功能静默失效**且不报错
  （本项目曾漏 `offscreen` 权限，导致剪贴板路径整条降级）。

`tabs` 除外：`tabs.create/remove/update/sendMessage/query` 都不需要 `tabs` 权限，
读取 `url` 等敏感字段靠 `activeTab` + `host_permissions` 已足够，故不强制声明。
