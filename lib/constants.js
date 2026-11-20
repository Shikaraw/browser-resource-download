/**
 * @file lib/constants.js
 * @module ERD/constants
 *
 * 全局共享常量 / 消息类型 / 默认设置。
 * popup、options、background、content/scanner 均通过 ES Module 引入：
 *   import { MSG, DEFAULT_SETTINGS } from '../lib/constants.js';
 *
 * ⚠️ 该文件不含任何依赖，必须保持纯净（可在 Service Worker / 页面 / 内容脚本中同时加载）。
 */

/** 扩展内部消息类型（chrome.runtime.sendMessage / onMessage） */
export const MSG = {
  // —— popup <-> background ——
  /** popup 请求扫描指定标签页 { tabId, frameId? } -> ScanResult */
  SCAN_PAGE: 'scan/page',
  /** 扫描进度推送 { phase, found, total? } */
  SCAN_PROGRESS: 'scan/progress',
  /** 取消进行中的扫描 { tabId } */
  SCAN_CANCEL: 'scan/cancel',
  /** popup 请求批量下载 { items: DownloadItem[], options } -> { started, failed } */
  DOWNLOAD_ITEMS: 'download/items',
  /** 批量下载整体进度 { done, total, failed } */
  DOWNLOAD_PROGRESS: 'download/progress',
  /** 单条下载状态变更 { itemId, state, error? } */
  DOWNLOAD_ITEM_STATE: 'download/itemState',
  /** 取消某一批任务 { batchId } */
  DOWNLOAD_CANCEL: 'download/cancel',
  /** 打开选项页 { section?: string } */
  OPEN_OPTIONS: 'ui/openOptions',
  /** 打开 popup 内嵌页面 */
  OPEN_POPUP_PAGE: 'ui/openPopupPage',
  /** 在页面中高亮预览某个资源 { url } */
  HIGHLIGHT_RESOURCE: 'page/highlight',
  /** 复制文本到剪贴板（offscreen 兜底） */
  COPY_TEXT: 'util/copyText',
  /** 读取 / 写入设置 */
  GET_SETTINGS: 'settings/get',
  SET_SETTINGS: 'settings/set',
  /** background -> content script（通过 tabs.sendMessage） */
  CONTENT_SCAN: 'content/scan',
  CONTENT_ABORT: 'content/abort',
  /** content script -> background 的增量上报 */
  CONTENT_PARTIAL: 'content/partial'
};

/** 资源大类 */
export const KIND = {
  VIDEO: 'video',
  IMAGE: 'image',
  AUDIO: 'audio',
  OTHER: 'other'
};

/** 资源大类的中文展示名 */
export const KIND_LABEL = {
  [KIND.VIDEO]: '视频',
  [KIND.IMAGE]: '图片',
  [KIND.AUDIO]: '音频',
  [KIND.OTHER]: '其他'
};

/** 资源大类对应的主题色（语义色，勿在别处硬编码） */
export const KIND_COLOR = {
  [KIND.VIDEO]: '#f472b6',
  [KIND.IMAGE]: '#38bdf8',
  [KIND.AUDIO]: '#a78bfa',
  [KIND.OTHER]: '#94a3b8'
};

/** 下载状态机 */
export const DL_STATE = {
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  DONE: 'done',
  FAILED: 'failed',
  CANCELED: 'canceled',
  SKIPPED: 'skipped'
};

/** 单文件大小上限档位（字节），供 settings 下拉框使用 */
export const SIZE_LIMIT_OPTIONS = [
  { value: 0, label: '不限制' },
  { value: 10 * 1024 * 1024, label: '10 MB' },
  { value: 50 * 1024 * 1024, label: '50 MB' },
  { value: 200 * 1024 * 1024, label: '200 MB' },
  { value: 1024 * 1024 * 1024, label: '1 GB' }
];

/** 并发下载档位 */
export const CONCURRENCY_OPTIONS = [
  { value: 1, label: '1（最稳）' },
  { value: 2, label: '2' },
  { value: 3, label: '3（推荐）' },
  { value: 5, label: '5' },
  { value: 8, label: '8（最快）' }
];

/** 文件名冲突策略 */
export const CONFLICT_OPTIONS = [
  { value: 'uniquify', label: '自动重命名（推荐）' },
  { value: 'overwrite', label: '覆盖同名文件' },
  { value: 'prompt', label: '每次询问' }
];

/**
 * 默认设置。所有字段都必须带默认值，options 页面据此渲染表单。
 * 修改此对象时请同步更新 docs/settings.md 中的说明表。
 */
export const DEFAULT_SETTINGS = {
  /** 扫描到的最小资源尺寸（像素，用于过滤 1x1 埋点图 / 图标） */
  minImageSize: 48,
  /** 扫描是否包含 base64/data: 内联资源 */
  includeDataUrls: false,
  /** 扫描是否包含 CSS background-image */
  includeBackgroundImages: true,
  /** 扫描 HLS(m3u8) / DASH 等流媒体清单 */
  includeStreams: true,
  /** 扫描 <video>/<audio>/<source> 标签 */
  includeMediaTags: true,
  /** 扫描页面已下载的 blob:/ 与 MSE 媒体（实验性） */
  includeBlobMedia: false,
  /** 是否扫描 iframe 内资源（会增加耗时） */
  includeIframes: false,
  /** 文件名冲突策略：uniquify | overwrite | prompt */
  conflictStrategy: 'uniquify',
  /** 并发下载数 1-8 */
  concurrency: 3,
  /** 单文件大小上限（字节），0 = 不限制 */
  maxFileSize: 200 * 1024 * 1024,
  /** 自动按类型分子文件夹：videos / images / audios / others */
  organizeByType: true,
  /** 下载保存子目录（相对浏览器下载目录） */
  saveSubfolder: 'EdgeResourceDownload',
  /** 扫描完成后自动全选 */
  autoSelectAll: false,
  /** 下载完成弹出系统通知 */
  notifyOnComplete: true,
  /** 记住上次勾选的类型筛选（popup 关闭后保留 UI 状态） */
  rememberFilters: true,
  /** popup 中资源卡片视图：grid | list */
  viewMode: 'grid',
  /** 主题：system | light | dark */
  theme: 'system',
  /** 是否在页面右键菜单中提供「扫描本页资源」 */
  enableContextMenu: true,
  /** 扫描超时（毫秒），超时后返回已收集结果 */
  scanTimeoutMs: 15000
};

/** storage 键名 */
export const STORAGE_KEYS = {
  SETTINGS: 'erd.settings',
  HISTORY: 'erd.history',
  UI_STATE: 'erd.uiState'
};

/** 资源类型 -> 保存子目录名 */
export const KIND_FOLDER = {
  [KIND.VIDEO]: 'videos',
  [KIND.IMAGE]: 'images',
  [KIND.AUDIO]: 'audios',
  [KIND.OTHER]: 'others'
};

/** 常见可下载扩展名 -> 资源大类（供 scanner 兜底判定） */
export const EXT_KIND = {
  mp4: KIND.VIDEO, m4v: KIND.VIDEO, webm: KIND.VIDEO, mkv: KIND.VIDEO, mov: KIND.VIDEO,
  avi: KIND.VIDEO, flv: KIND.VIDEO, ts: KIND.VIDEO, ogv: KIND.VIDEO, '3gp': KIND.VIDEO,
  m3u8: KIND.VIDEO, mpd: KIND.VIDEO,
  png: KIND.IMAGE, jpg: KIND.IMAGE, jpeg: KIND.IMAGE, gif: KIND.IMAGE, webp: KIND.IMAGE,
  avif: KIND.IMAGE, bmp: KIND.IMAGE, svg: KIND.IMAGE, ico: KIND.IMAGE,
  mp3: KIND.AUDIO, m4a: KIND.AUDIO, aac: KIND.AUDIO, wav: KIND.AUDIO, flac: KIND.AUDIO,
  ogg: KIND.AUDIO, opus: KIND.AUDIO, wma: KIND.AUDIO, amr: KIND.AUDIO,
  srt: KIND.OTHER, vtt: KIND.OTHER, ass: KIND.OTHER,
  pdf: KIND.OTHER, zip: KIND.OTHER, rar: KIND.OTHER, '7z': KIND.OTHER, txt: KIND.OTHER
};

/** MIME 前缀 -> 资源大类 */
export const MIME_KIND = [
  [/^video\//i, KIND.VIDEO],
  [/^image\//i, KIND.IMAGE],
  [/^audio\//i, KIND.AUDIO]
];

/**
 * 生成一条资源记录的标准结果（scanner 与 background 均复用）。
 * @typedef {Object} ResourceItem
 * @property {string} id          稳定去重 id（由 url + kind 派生）
 * @property {string} url         绝对 URL（http/https/blob/data）
 * @property {string} kind        KIND.*
 * @property {string} [mime]      MIME 类型（未知则省略）
 * @property {string} [title]     展示名称 / 文件名
 * @property {string} [ext]       扩展名（不带点）
 * @property {number} [width]     宽（图片/视频）
 * @property {number} [height]    高
 * @property {number} [duration]  时长秒（音视频）
 * @property {number} [size]      字节数（HEAD 探测可得）
 * @property {string} [poster]    视频封面 URL
 * @property {string} [source]    来源：img / video / audio / css / link / stream / blob ...
 * @property {boolean} [isStream] 是否为 m3u8/mpd 流清单
 */

export { };
