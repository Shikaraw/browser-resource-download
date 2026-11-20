# 设置项说明

> 所有设置持久化在 `chrome.storage.local` 的 `erd.settings` 键下，
> 默认值定义于 [lib/constants.js](../lib/constants.js) 的 `DEFAULT_SETTINGS`。
> 设置页 **自动保存**（300ms 防抖），无需手动提交。

## 扫描范围

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `minImageSize` | number | `48` | 小于该边长的 `<img>` 会被忽略，用于过滤 1×1 埋点像素与装饰性图标。设为 `0` 不过滤。 |
| `includeMediaTags` | boolean | `true` | 扫描 `<video>` `<audio>` `<source>` `<picture>` 标签。 |
| `includeBackgroundImages` | boolean | `true` | 解析计算样式中的 `background-image: url(…)`。页面元素多时较慢。 |
| `includeDataUrls` | boolean | `false` | 收集 `data:` 内联资源。体积可能极大，默认关闭。 |
| `includeStreams` | boolean | `true` | 识别 `.m3u8`（HLS）/ `.mpd`（DASH）流清单。 |
| `includeBlobMedia` | boolean | `false` | 实验性：导出 `blob:` / MSE 媒体。部分站点会失败或得到空文件。 |
| `includeIframes` | boolean | `false` | 同时列出同源 iframe 的 `src`。增加耗时。 |
| `scanTimeoutMs` | number | `15000` | 扫描超时（3000–30000ms）。超时后返回已收集的部分结果。 |

## 下载行为

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `saveSubfolder` | string | `"EdgeResourceDownload"` | 相对浏览器默认下载目录的子文件夹。不能包含 `/ \ : * ? " < > \|`。 |
| `organizeByType` | boolean | `true` | 自动分子目录 `videos/` `images/` `audios/` `others/`。 |
| `conflictStrategy` | enum | `"uniquify"` | `uniquify` 自动重命名 · `overwrite` 覆盖 · `prompt` 每次询问。 |
| `concurrency` | number | `3` | 同时进行的下载数，1–8。数值越高越容易触发站点限流。 |
| `maxFileSize` | number | `209715200` | 单文件字节上限，`0` 表示不限制。超限资源会被跳过。 |
| `autoSelectAll` | boolean | `false` | 扫描完成后自动勾选全部资源。 |

## 外观

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `theme` | enum | `"system"` | `system` 跟随系统 · `light` · `dark`。写入 `<html data-theme>`。 |
| `viewMode` | enum | `"grid"` | popup 默认视图：`grid` 网格 · `list` 列表。 |

## 通知与快捷键

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `notifyOnComplete` | boolean | `true` | 一批下载结束后发系统通知。 |
| `enableContextMenu` | boolean | `true` | 页面右键菜单加入「扫描本页的资源…」。 |
| `rememberFilters` | boolean | `true` | 关闭 popup 后记住筛选 / 排序 / 视图。 |

快捷键 `Alt+Shift+R` 为浏览器级绑定（`commands._execute_action`），
用户可在 `edge://extensions/shortcuts` 中改名。

## 数据与隐私

| 键 | 类型 | 说明 |
|---|---|---|
| `erd.history` | Array | 最近 5 次扫描摘要（host / 标题 / 数量 / 时间），不保存资源 URL。 |
| `erd.uiState` | Object | 上次的筛选、排序、视图模式。 |

「清空扫描历史」删除 `erd.history`；「恢复默认设置」重置 `erd.settings`。
设置可导出为 JSON 备份、再导入恢复（导入值会经 `mergeSettings` 类型校验，
非法字段被忽略）。
