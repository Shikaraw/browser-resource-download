/**
 * @file popup/popup.js
 * @module ERD/popup
 *
 * popup 主面板唯一逻辑入口。
 *
 * 状态机：body[data-state] = idle | scanning | results | downloading | error
 * 关键约束（见 docs/CONTRACT.md 第 4 节）：
 *   - 打开面板时停留在 idle，**只有点击 #btn-scan 才会调用 scanPage(tabId)**；
 *   - 下载统一走 downloadItems(items, {folder, organizeByType, conflictStrategy})；
 *   - 进度来自 onPush 的 scan/progress、download/progress、download/itemState；
 *   - 筛选 / 视图 / 排序用 loadUiState / saveUiState 持久化（受 rememberFilters 控制）；
 *   - 所有异步操作都有 loading 与失败反馈，不允许静默失败；
 *   - 非扩展环境（file:// 调试）下优雅降级，绝不抛未捕获异常。
 */

import {
  MSG,
  KIND,
  KIND_LABEL,
  DL_STATE,
  DEFAULT_SETTINGS,
  STORAGE_KEYS
} from '../lib/constants.js';
import { formatBytes, errMsg, debounce, el } from '../lib/utils.js';
import {
  getSettings,
  applyTheme,
  loadUiState,
  saveUiState,
  onSettingsChanged
} from '../lib/settings.js';
import {
  scanPage,
  cancelScan,
  downloadItems,
  cancelBatch,
  openOptions,
  highlightResource,
  copyText,
  onPush,
  getActiveTab,
  isScannableUrl
} from '../lib/messaging.js';
import {
  icon,
  normalizeItems,
  buildCounts,
  filterItems,
  sortItems,
  renderKindChips,
  createCard,
  setCardSelected,
  setCardDownloadState,
  renderEmptyState
} from './render.js';

/* ==========================================================================
   环境
   ========================================================================== */

/** 是否运行在真实扩展环境（chrome.runtime.id 只在扩展页存在） */
const HAS_EXT = Boolean(globalThis.chrome?.runtime?.id);

/** 允许的排序键 */
const SORT_KEYS = ['default', 'size', 'dimension', 'name'];
/** 允许的视图 */
const VIEW_KEYS = ['grid', 'list'];
/** chips 可选的 kind */
const KIND_KEYS = [KIND.VIDEO, KIND.IMAGE, KIND.AUDIO, KIND.OTHER];
/** 大批量渲染分片大小 */
const RENDER_CHUNK = 80;
/** 扫描阶段 -> 进度百分比区间 */
const SCAN_PHASES = {
  collecting: { pct: 26, text: '正在收集页面元素…' },
  probing: { pct: 72, text: '正在探测资源大小…' },
  done: { pct: 100, text: '扫描完成' }
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 全部必需 DOM（契约 4.3） */
const ui = {
  body: document.body,
  btnScan: $('btn-scan'),
  btnCancelScan: $('btn-cancel-scan'),
  scanProgress: $('scan-progress'),
  resultsGrid: $('results-grid'),
  resultsScroll: $('results-scroll'),
  checkAll: $('check-all'),
  searchInput: $('search-input'),
  sortSelect: $('sort-select'),
  viewSeg: $('view-seg'),
  kindChips: $('kind-chips'),
  scanNotice: $('scan-notice'),
  actionbar: $('actionbar'),
  btnDownload: $('btn-download'),
  btnDownloadAll: $('btn-download-all'),
  btnSettings: $('btn-settings'),
  emptyState: $('empty-state'),
  toastHost: $('toast-host'),
  pageInfo: $('page-info'),
  selectedSummary: $('selected-summary'),
  filterCounts: $('filter-counts'),
  // 非契约必需但本页使用
  pageTile: $('page-tile'),
  pageHost: $('page-host'),
  pageTitle: $('page-title'),
  pageBadge: $('page-badge'),
  tabModeHint: $('tab-mode-hint'),
  tabModeHintText: $('tab-mode-hint-text'),
  appVer: $('app-ver'),
  btnRescan: $('btn-rescan'),
  scanPhase: $('scan-phase'),
  scanDetail: $('scan-detail'),
  scanFound: $('scan-found'),
  scanElapsed: $('scan-elapsed'),
  lastScanCard: $('last-scan-card'),
  lastScanTitle: $('last-scan-title'),
  lastScanSub: $('last-scan-sub'),
  errorTitle: $('error-title'),
  errorMsg: $('error-msg'),
  errorTip: $('error-tip'),
  btnRetry: $('btn-retry'),
  btnErrorSettings: $('btn-error-settings'),
  dlPanel: $('download-panel'),
  dlTitle: $('dl-title'),
  dlSub: $('dl-sub'),
  dlBar: $('dl-progress'),
  dlDone: $('dl-done'),
  dlDoneText: $('dl-done-text'),
  dlSpinner: $('dl-spinner'),
  btnCancelDownload: $('btn-cancel-download'),
  btnOpenDownloads: $('btn-open-downloads'),
  btnBackResults: $('btn-back-results'),
  btnClearSelection: $('btn-clear-selection')
};

/* ==========================================================================
   状态
   ========================================================================== */
const state = {
  /** @type {typeof DEFAULT_SETTINGS} */
  settings: { ...DEFAULT_SETTINGS },
  hasExt: HAS_EXT,
  mock: null,
  /** @type {{id?:number,url?:string,title?:string,favIconUrl?:string}|null} */
  tab: null,
  /** 是否使用了「最近访问网页」的兜底标签页 */
  tabFallback: false,
  /** 面板是否以标签页形式打开（活动目标是扩展自身页面） */
  tabOpenedAside: false,
  /** @type {{pageUrl?:string,pageTitle?:string,host?:string,elapsedMs?:number,timedOut?:boolean,warnings?:string[],counts?:any}|null} */
  scan: null,
  /** @type {any[]} 归一化后的全部资源 */
  items: [],
  /** @type {Map<string, any>} id -> item（仅勾选） */
  selected: new Map(),
  /** @type {any[]} 当前可见（筛选+排序后） */
  visible: [],
  filters: { kind: 'all', q: '' },
  sort: 'default',
  viewMode: 'grid',
  /** 扫描态 */
  scanning: false,
  scanToken: 0,
  scanProgress: { phase: 'idle', found: 0, pct: 0, text: '' },
  scanTimer: 0,
  scanStartedAt: 0,
  /** @type {Map<string, {state:string, error?:string}>} 下载单条状态 */
  dlStates: new Map(),
  /** @type {{batchId:string,total:number,done:number,failed:number,active:boolean,canceled:boolean}} */
  dl: { batchId: '', total: 0, done: 0, failed: 0, active: false, canceled: false },
  /** @type {any} 上次扫描摘要 */
  lastScan: null,
  /** @type {Map<string, HTMLElement>} 已渲染卡片 */
  cardEls: new Map(),
  renderToken: 0,
  busy: false,
  toastTimers: new Set(),
  mockTimers: new Set(),
  themeStop: null,
  settingsStop: null
};

/* ==========================================================================
   小工具
   ========================================================================== */

/** 轻提示（复用 theme.css 的 .toast） */
function toast(message, type = 'ok', ms = 2600) {
  if (!ui.toastHost || !message) return;
  const node = el('div', { class: 'toast', dataset: { type }, role: 'status' });
  const ico = icon(type === 'error' ? 'alert' : type === 'warn' ? 'info' : 'check', { size: 13 });
  node.append(ico, el('span', { text: String(message) }));
  ui.toastHost.append(node);
  // 最多同时 2 条，避免堆高挤占内容区
  while (ui.toastHost.children.length > 2) ui.toastHost.firstElementChild.remove();
  const timer = setTimeout(() => {
    state.toastTimers.delete(timer);
    node.classList.add('out');
    setTimeout(() => node.remove(), 240);
  }, Math.max(900, ms));
  state.toastTimers.add(timer);
}

/** 设置顶部右上角的忙碌态（禁用按钮 + 文案） */
function setBusy(on, label) {
  state.busy = !!on;
  if (ui.btnDownload) {
    ui.btnDownload.disabled = !!on || state.selected.size === 0;
    if (label) {
      ui.btnDownload.replaceChildren(document.createTextNode(label));
    } else if (!ui.btnDownload.firstChild || ui.btnDownload.textContent !== '下载选中') {
      ui.btnDownload.replaceChildren(document.createTextNode('下载选中'));
    }
  }
  updateSelectionUI();
}

/** 切换 body[data-state] */
function setState(next) {
  if (!ui.body) return;
  const prev = ui.body.dataset.state;
  ui.body.dataset.state = next;
  if (prev !== next) {
    // 结果态出现时把滚动位置重置到工具栏下方
    if (next === 'results' || next === 'scanning' || next === 'error' || next === 'idle') {
      ui.body.scrollTop = 0;
    }
  }
  if (ui.btnRescan) {
    ui.btnRescan.hidden = !(next === 'results' || (next === 'downloading' && false));
  }
  updatePageBadge(next);
}

function updatePageBadge(nextState) {
  if (!ui.pageBadge) return;
  if (!state.tab || (state.hasExt && !isScannableUrl(state.tab.url || ''))) {
    ui.pageBadge.textContent = '不支持';
    ui.pageBadge.dataset.kind = 'warn';
    return;
  }
  if (nextState === 'scanning') {
    ui.pageBadge.textContent = '扫描中';
    ui.pageBadge.dataset.kind = 'ok';
  } else if (nextState === 'downloading') {
    ui.pageBadge.textContent = '下载中';
    ui.pageBadge.dataset.kind = 'ok';
  } else {
    ui.pageBadge.textContent = '可扫描';
    ui.pageBadge.dataset.kind = 'ok';
  }
}

/** 统一错误兜底 */
function reportError(where, err) {
  const msg = errMsg(err);
  console.error(`[popup] ${where}`, err);
  toast(`${where}：${msg}`, 'error', 4200);
}

/* ==========================================================================
   主题 / 设置
   ========================================================================== */

function bindTheme(theme) {
  try {
    if (typeof state.themeStop === 'function') state.themeStop();
    state.themeStop = applyTheme(theme || 'system');
  } catch (err) {
    console.warn('[popup] applyTheme 失败', err);
  }
}

function watchSettings() {
  if (!state.hasExt) return;
  try {
    state.settingsStop = onSettingsChanged((next) => {
      const prevTheme = state.settings.theme;
      state.settings = next;
      if (next.theme !== prevTheme) bindTheme(next.theme);
      updateSelectionUI();
    });
  } catch (err) {
    console.warn('[popup] 订阅设置失败', err);
  }
}

/* ==========================================================================
   UI 状态持久化
   ========================================================================== */

const persistUiState = debounce(() => {
  if (!state.settings.rememberFilters) return;
  try {
    saveUiState({
      filters: { ...state.filters },
      viewMode: state.viewMode,
      sort: state.sort
    });
  } catch (err) {
    console.warn('[popup] 保存 UI 状态失败', err);
  }
}, 260);

async function restoreUiState() {
  let saved = {};
  if (state.settings.rememberFilters) {
    try {
      saved = (await loadUiState()) || {};
    } catch (err) {
      console.warn('[popup] 读取 UI 状态失败', err);
    }
  }
  // 视图模式：rememberFilters 关掉时回落到设置里的默认视图
  const view = VIEW_KEYS.includes(saved.viewMode) ? saved.viewMode : state.settings.viewMode;
  state.viewMode = VIEW_KEYS.includes(view) ? view : 'grid';

  const sort = SORT_KEYS.includes(saved.sort) ? saved.sort : 'default';
  state.sort = sort;

  const savedFilters = saved.filters && typeof saved.filters === 'object' ? saved.filters : {};
  const kind = savedFilters.kind === 'all' || KIND_KEYS.includes(savedFilters.kind)
    ? savedFilters.kind
    : 'all';
  const q = typeof savedFilters.q === 'string' ? savedFilters.q.slice(0, 120) : '';
  state.filters = { kind, q };

  if (ui.searchInput) ui.searchInput.value = q;
  if (ui.sortSelect) ui.sortSelect.value = sort;
  syncViewSegment();
}

function syncViewSegment() {
  if (!ui.viewSeg) return;
  for (const btn of ui.viewSeg.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', btn.dataset.view === state.viewMode ? 'true' : 'false');
  }
  if (ui.resultsGrid) ui.resultsGrid.dataset.view = state.viewMode;
}

/* ==========================================================================
   当前标签页 / 页面信息
   ========================================================================== */

async function resolveTab() {
  if (state.mock?.MOCK_TAB) {
    state.tab = { ...state.mock.MOCK_TAB };
    state.tabFallback = false;
    state.tabOpenedAside = false;
    return state.tab;
  }
  if (!state.hasExt) {
    state.tab = null;
    state.tabFallback = false;
    state.tabOpenedAside = false;
    return null;
  }

  try {
    const active = await getActiveTab();

    // 正常场景：活动标签页就是可扫描的网页
    if (isWebTab(active)) {
      state.tab = active;
      state.tabFallback = false;
      state.tabOpenedAside = false;
      return state.tab;
    }

    // 面板以「标签页」形式打开时，活动标签页 = 这个扩展页面自身，
    // 此时回退到「最近访问的普通网页」，避免一进来就误判为不可扫描。
    if (isOwnExtensionPage(active)) {
      const near = await findRecentWebTab(active?.id);
      state.tabOpenedAside = true;
      if (near) {
        state.tab = near;
        state.tabFallback = true;
        return state.tab;
      }
      state.tab = active || null;
      state.tabFallback = false;
      return state.tab;
    }

    // 浏览器内部页面（chrome:// 等）：不回退，如实提示不可扫描
    state.tab = active || null;
    state.tabFallback = false;
    state.tabOpenedAside = false;
    return state.tab;
  } catch (err) {
    console.warn('[popup] 获取标签页失败', err);
    if (!state.tab) state.tab = null;
    state.tabFallback = false;
    return state.tab;
  }
}

/** 是否为可扫描的普通网页标签页（http/https/file） */
function isWebTab(tab) {
  return !!tab && tab.id != null && /^(https?|file):/i.test(tab.url || '');
}

/** 是否为扩展自身页面（chrome-extension://<本扩展 id>/…） */
function isOwnExtensionPage(tab) {
  const url = tab?.url || '';
  if (!/^(chrome|edge|moz)-extension:/i.test(url)) return false;
  try {
    return new URL(url).hostname === chrome.runtime.id;
  } catch {
    return true;
  }
}

/**
 * 找到「最近访问的普通网页」标签页（面板以标签页打开时的兜底目标）。
 * 排除当前面板自身，按 lastAccessed 倒序，其次按窗口内顺序。
 * @param {number|undefined} excludeId
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function findRecentWebTab(excludeId) {
  try {
    const tabs = await chrome.tabs.query({});
    const cands = (tabs || []).filter((t) => t && t.id !== excludeId && isWebTab(t));
    if (!cands.length) return null;
    cands.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return cands[0];
  } catch (err) {
    console.warn('[popup] 枚举标签页失败', err);
    return null;
  }
}

function renderPageInfo() {
  const tab = state.tab;
  const scannable = tab ? (!state.hasExt || isScannableUrl(tab.url || '')) : false;

  if (ui.pageHost) {
    ui.pageHost.textContent = tab
      ? hostLabel(tab.url || '')
      : '无法读取当前标签页';
  }
  if (ui.pageTitle) {
    ui.pageTitle.textContent = tab?.title || (tab ? '（无标题）' : '请切换到普通网页后重试');
  }
  if (ui.pageTile) {
    ui.pageTile.replaceChildren();
    const favicon = typeof tab?.favIconUrl === 'string' ? tab.favIconUrl : '';
    if (favicon && /^(https?:|data:image\/|file:)/i.test(favicon)) {
      const img = el('img', { alt: '', 'aria-hidden': 'true', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => {
        ui.pageTile.replaceChildren(document.createTextNode(tileLetter(tab)));
      });
      img.src = favicon;
      ui.pageTile.append(img);
    } else {
      ui.pageTile.append(document.createTextNode(tileLetter(tab)));
    }
  }
  if (ui.pageBadge) {
    ui.pageBadge.textContent = scannable ? '可扫描' : '不支持';
    ui.pageBadge.dataset.kind = scannable ? 'ok' : 'warn';
  }
  // 扫描按钮永远可点：不可扫描时点击会给出明确原因，也允许切换标签页后重试
  if (ui.btnScan) ui.btnScan.disabled = false;

  // 以标签页形式打开时的轻提示
  if (ui.tabModeHint) {
    const show = state.tabFallback && scannable;
    ui.tabModeHint.hidden = !show;
    if (show) {
      ui.tabModeHintText.textContent =
        `当前面板以标签页打开，已自动关联最近访问的网页：${hostLabel(tab.url || '')}`;
    }
  }
}

/** 页面信息里的 host 文案（含 chrome:// 等特殊协议） */
function hostLabel(url) {
  if (!url) return '未知页面';
  try {
    const u = new URL(url);
    if (/^(chrome-extension|edge-extension|moz-extension):/.test(u.protocol)) {
      return '扩展页面';
    }
    if (u.protocol === 'chrome:' || u.protocol === 'edge:' || u.protocol === 'about:') {
      return '浏览器内部页面';
    }
    if (u.protocol === 'file:') return '本地文件';
    return u.hostname.replace(/^www\./, '') || u.protocol.replace(':', '');
  } catch {
    return '未知页面';
  }
}

/** favicon 占位字母 */
function tileLetter(tab) {
  const label = hostLabel(tab?.url || '');
  return (label || '·').trim().charAt(0).toUpperCase() || '·';
}

/* ==========================================================================
   上次扫描摘要（idle）
   ========================================================================== */

function relTime(ts) {
  if (!Number.isFinite(ts)) return '';
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

async function loadHistory() {
  if (!state.hasExt) return;
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
    const rec = pickHistoryRecord(raw?.[STORAGE_KEYS.HISTORY]);
    if (rec) {
      state.lastScan = {
        at: Number(rec.at || rec.time || rec.timestamp) || 0,
        total: Number(rec.total ?? rec.counts?.total ?? rec.itemCount) || 0,
        host: String(rec.host || ''),
        pageTitle: String(rec.pageTitle || rec.title || ''),
        fromHistory: true
      };
    }
  } catch (err) {
    console.warn('[popup] 读取扫描历史失败', err);
  }
  renderLastScan();
}

function pickHistoryRecord(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.find((r) => r && typeof r === 'object') || null;
  if (typeof raw !== 'object') return null;
  if (Array.isArray(raw.items)) return raw.items.find((r) => r && typeof r === 'object') || null;
  if (Array.isArray(raw.records)) return raw.records.find((r) => r && typeof r === 'object') || null;
  return raw;
}

function renderLastScan() {
  const rec = state.lastScan;
  if (!ui.lastScanCard) return;
  if (!rec || !(rec.total > 0)) {
    ui.lastScanCard.hidden = true;
    return;
  }
  ui.lastScanCard.hidden = false;
  const when = relTime(rec.at);
  if (ui.lastScanTitle) {
    ui.lastScanTitle.textContent = when ? `上次扫描 · ${when}` : '上次扫描';
  }
  if (ui.lastScanSub) {
    const bits = [];
    if (rec.total) bits.push(`${rec.total} 项资源`);
    if (rec.host) bits.push(rec.host);
    if (rec.pageTitle) bits.push(rec.pageTitle);
    ui.lastScanSub.textContent = bits.join(' · ') || '已保存的扫描记录';
    ui.lastScanSub.title = bits.join(' · ');
  }
}

/* ==========================================================================
   扫描
   ========================================================================== */

function getScannableInfo() {
  const tab = state.tab;
  if (!tab || tab.id == null) {
    return {
      ok: false,
      title: '无法获取当前标签页',
      msg: '没有找到可以扫描的网页标签页。',
      tip: '请先用浏览器打开一个普通网页（http / https / file），再回到本面板扫描。'
    };
  }
  const url = tab.url || '';

  if (!state.hasExt && !state.mock) {
    return {
      ok: false,
      title: '当前环境不支持扫描',
      msg: '这不是扩展运行环境（例如以 file:// 直接打开页面），chrome.* API 不可用。',
      tip: '请在 Edge / Chrome 的扩展面板中打开本页面。'
    };
  }

  // 扩展自身页面：面板以标签页形式打开、且找不到可关联的网页
  if (state.hasExt && isOwnExtensionPage(tab)) {
    return {
      ok: false,
      title: '本面板自身不能扫描',
      msg: '当前面板是以标签页形式打开的扩展页面，扩展页面里没有可下载的媒体资源。',
      tip: '请到一个普通网页里点击工具栏图标打开面板；直接在本标签页扫码会关联最近访问的网页。'
    };
  }

  // 浏览器内部页面：chrome:// 等
  if (state.hasExt && !isScannableUrl(url)) {
    const internal = /^(chrome|edge|about|devtools):/i.test(url);
    return {
      ok: false,
      title: internal ? '此页面无法扫描' : '此页面暂不支持扫描',
      msg: internal
        ? '浏览器内部页面（chrome://、edge://、扩展商店页等）出于安全限制不允许注入脚本。'
        : `当前页面协议不受支持（${protocolOf(url)}），无法注入扫描脚本。`,
      tip: '支持普通网页（http / https）与本地文件（file）页面。'
    };
  }

  return { ok: true };
}

/** 取 URL 协议名，用于错误文案 */
function protocolOf(url) {
  try {
    return new URL(url).protocol.replace(':', '') || '未知';
  } catch {
    return '未知';
  }
}

async function startScan() {
  if (state.scanning) return;
  // 每次扫描都重新解析目标标签页：用户在别的标签页操作后点扫描也能跟上
  await resolveTab();
  renderPageInfo();
  const info = getScannableInfo();
  if (!info.ok) {
    showError(info);
    return;
  }

  state.scanning = true;
  state.scanToken += 1;
  const token = state.scanToken;
  state.scanStartedAt = performance.now();
  state.scanProgress = { phase: 'collecting', found: 0, pct: 8, text: SCAN_PHASES.collecting.text };
  state.selected.clear();
  state.dlStates.clear();

  if (ui.scanProgress) {
    const bar = ui.scanProgress.querySelector('i');
    if (bar) bar.style.width = '8%';
    ui.scanProgress.setAttribute('aria-valuenow', '8');
  }
  if (ui.scanFound) ui.scanFound.textContent = '0';
  if (ui.scanPhase) ui.scanPhase.textContent = '正在扫描本页资源…';
  if (ui.scanDetail) ui.scanDetail.textContent = SCAN_PHASES.collecting.text;
  setState('scanning');
  startScanTimer();

  let res;
  try {
    res = state.mock
      ? await mockScan()
      : await scanPage(state.tab.id, { timeoutMs: state.settings.scanTimeoutMs });
  } catch (err) {
    res = { ok: false, error: errMsg(err) };
  }

  if (token !== state.scanToken) return; // 已被取消 / 被新一轮扫描取代
  state.scanning = false;
  stopScanTimer();

  if (!res || res.ok !== true) {
    showError({
      title: '扫描失败',
      msg: (res && res.error) || '后台没有返回扫描结果，请稍后重试。',
      tip: '若持续失败，可在设置中放大扫描超时或关闭 iframe 扫描。'
    });
    return;
  }

  applyScanResult(res.data);
  setState('results');
}

function startScanTimer() {
  stopScanTimer();
  state.scanTimer = setInterval(() => {
    if (ui.scanElapsed) {
      const sec = (performance.now() - state.scanStartedAt) / 1000;
      ui.scanElapsed.textContent = `${sec.toFixed(1)}s`;
    }
  }, 120);
}

function stopScanTimer() {
  if (state.scanTimer) {
    clearInterval(state.scanTimer);
    state.scanTimer = 0;
  }
}

function onScanProgress(payload) {
  if (!state.scanning) return;
  const phase = payload?.phase;
  const def = SCAN_PHASES[phase];
  if (!def && typeof payload?.found !== 'number') return;
  state.scanProgress.phase = phase || state.scanProgress.phase;
  if (typeof payload?.found === 'number') {
    state.scanProgress.found = Math.max(0, payload.found);
    if (ui.scanFound) ui.scanFound.textContent = String(state.scanProgress.found);
  }
  // 进度条：阶段基线 + 已发现数量的小幅推进，视觉上更“活”
  const base = def ? def.pct : state.scanProgress.pct;
  const pct = Math.min(97, Math.max(base, base + Math.min(12, state.scanProgress.found * 0.06)));
  state.scanProgress.pct = pct;
  state.scanProgress.text = payload?.label || def?.text || state.scanProgress.text;
  if (ui.scanDetail) ui.scanDetail.textContent = state.scanProgress.text;
  if (ui.scanProgress) {
    const bar = ui.scanProgress.querySelector('i');
    if (bar) bar.style.width = `${pct}%`;
    ui.scanProgress.setAttribute('aria-valuenow', String(Math.round(pct)));
  }
  if (phase === 'done') {
    if (ui.scanPhase) ui.scanPhase.textContent = '扫描即将完成…';
    if (ui.scanProgress) {
      const bar = ui.scanProgress.querySelector('i');
      if (bar) bar.style.width = '100%';
      ui.scanProgress.setAttribute('aria-valuenow', '100');
    }
  }
}

async function requestCancelScan() {
  if (!state.scanning) return;
  state.scanning = false;
  state.scanToken += 1; // 让在途的 scanPage 结果被丢弃
  stopScanTimer();
  if (ui.scanProgress) {
    const bar = ui.scanProgress.querySelector('i');
    if (bar) bar.style.width = '0%';
  }
  setState('idle');
  toast('已取消扫描', 'warn');
  if (state.hasExt && state.tab?.id != null) {
    try {
      const res = await cancelScan(state.tab.id);
      if (!res?.ok) toast(`取消请求未送达后台：${res?.error || '未知错误'}`, 'error', 3600);
    } catch (err) {
      reportError('取消扫描失败', err);
    }
  }
}

/** 应用扫描结果 */
function applyScanResult(data) {
  const result = data && typeof data === 'object' ? data : {};
  const items = normalizeItems(result.items);
  state.scan = {
    pageUrl: String(result.pageUrl || state.tab?.url || ''),
    pageTitle: String(result.pageTitle || state.tab?.title || ''),
    host: String(result.host || hostLabel(result.pageUrl || state.tab?.url || '')),
    elapsedMs: Number(result.elapsedMs) || 0,
    timedOut: result.timedOut === true,
    warnings: Array.isArray(result.warnings)
      ? result.warnings.filter((w) => typeof w === 'string' && w.trim()).slice(0, 4)
      : [],
    counts: buildCounts(items)
  };
  state.items = items;
  state.selected.clear();
  state.dlStates.clear();
  state.lastScan = {
    at: Date.now(),
    total: items.length,
    host: state.scan.host,
    pageTitle: state.scan.pageTitle
  };
  renderLastScan();

  if (state.scan.timedOut) {
    toast('扫描超时，已展示已收集到的结果', 'warn', 4000);
  }
  // 扫描警告属于「页面级信息」，用结果区顶部的可折叠提示条，不占用 toast
  renderScanNotice();

  if (items.length === 0) {
    toast('本页未发现可下载资源', 'warn', 3200);
  }

  // 扫描后自动全选（作用于当前筛选后的可见集合）
  refreshResults();
  if (state.settings.autoSelectAll) {
    selectAllVisible(true);
  }
}

/* ==========================================================================
   结果渲染
   ========================================================================== */

function visibleItems() {
  return sortItems(filterItems(state.items, state.filters), state.sort);
}

function refreshResults(opts = {}) {
  state.visible = visibleItems();
  const token = ++state.renderToken;
  state.cardEls = new Map();
  if (ui.resultsGrid) {
    ui.resultsGrid.replaceChildren();
    ui.resultsGrid.dataset.view = state.viewMode;
  }
  renderKindChips(ui.kindChips, buildCounts(state.items), state.filters.kind, pickKind);
  renderScanNotice();
  renderFilterCounts();
  appendChunk(state.visible, 0, token);
  renderEmptyStateForCurrent();
  updateSelectionUI();
  if (opts.keepScroll !== true) {
    // 保持在结果列表顶部（工具栏下方）
    const top = ui.resultsScroll?.offsetTop || 0;
    if (ui.body.scrollTop > top) ui.body.scrollTop = Math.max(0, top - 8);
  }
}

function appendChunk(items, start, token) {
  if (!ui.resultsGrid) return;
  if (token !== state.renderToken) return;
  const end = Math.min(start + RENDER_CHUNK, items.length);
  for (let i = start; i < end; i++) {
    const item = items[i];
    const card = createCard(item, { selected: state.selected, dlStates: state.dlStates });
    state.cardEls.set(item.id, card);
    ui.resultsGrid.append(card);
  }
  if (end < items.length) {
    requestAnimationFrame(() => appendChunk(items, end, token));
  }
}

function renderFilterCounts() {
  if (!ui.filterCounts) return;
  const total = state.items.length;
  const shown = state.visible.length;
  const filtered = state.filters.kind !== 'all' || state.filters.q.trim() !== '';
  ui.filterCounts.textContent = filtered
    ? `可见 ${shown} / 共 ${total}`
    : `共 ${total} 项`;
}

/** 结果区顶部的扫描提示条（警告 / 超时）：可折叠，不遮挡卡片 */
function renderScanNotice() {
  const host = ui.scanNotice;
  if (!host) return;
  const warnings = state.scan?.warnings || [];
  const timedOut = state.scan?.timedOut === true;
  if (!warnings.length && !timedOut) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }

  host.hidden = false;
  host.replaceChildren();
  host.dataset.tone = timedOut ? 'warn' : 'info';

  const main = el('div', { class: 'notice-main' });
  main.append(icon(timedOut ? 'info' : 'alert', { size: 13 }));

  const title = timedOut
    ? '扫描超时，以下为已收集到的资源'
    : `扫描有 ${warnings.length} 条提示`;
  main.append(el('span', { class: 'notice-title', text: title }));

  const toggle = el('button', {
    type: 'button',
    class: 'notice-toggle',
    'aria-expanded': 'false',
    'aria-label': '展开/折叠扫描提示',
    text: '详情'
  });
  main.append(el('div', { class: 'spacer' }), toggle);

  const details = el('ul', { class: 'notice-details', hidden: '' });
  for (const w of warnings) details.append(el('li', { text: w }));
  if (timedOut) details.append(el('li', { text: '可在设置中放大「扫描超时」或关闭 iframe / 背景图扫描以提速。' }));

  toggle.addEventListener('click', () => {
    const open = details.hidden;
    details.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.textContent = open ? '收起' : '详情';
    host.classList.toggle('is-open', open);
  });

  host.append(main, details);
}

function pickKind(kind) {
  const next = kind === 'all' || KIND_KEYS.includes(kind) ? kind : 'all';
  if (next === state.filters.kind) return;
  state.filters.kind = next;
  persistUiState();
  refreshResults({ keepScroll: true });
}

function renderEmptyStateForCurrent() {
  if (!ui.emptyState) return;
  const hasVisible = state.visible.length > 0;
  ui.emptyState.hidden = hasVisible;
  if (hasVisible) return;

  const scanned = !!state.scan;
  const filtered = state.filters.kind !== 'all' || state.filters.q.trim() !== '';

  if (!scanned) {
    renderEmptyState(ui.emptyState, {
      icon: 'search',
      title: '还没有扫描结果',
      desc: '点击「扫描本页资源」开始查找当前页面的可下载资源。',
      actions: [{ label: '扫描本页资源', primary: true, onClick: startScan }]
    });
    return;
  }

  if (filtered) {
    renderEmptyState(ui.emptyState, {
      icon: 'search',
      title: '没有匹配的资源',
      desc: describeFilters(),
      actions: [
        { label: '清除筛选', primary: true, onClick: clearFilters },
        { label: '重新扫描', onClick: startScan }
      ]
    });
    return;
  }

  renderEmptyState(ui.emptyState, {
    icon: state.scan?.timedOut ? 'info' : 'folder',
    title: state.scan?.timedOut ? '扫描超时，暂未发现资源' : '本页未发现可下载资源',
    desc: '可以尝试先滚动页面加载懒加载内容，或在设置中放宽扫描范围（最小图片尺寸 / 背景图 / 流媒体）。',
    warnings: state.scan?.warnings || [],
    actions: [
      { label: '重新扫描', primary: true, onClick: startScan },
      { label: '扫描设置', onClick: () => openOptionsPage('scan') }
    ]
  });
}

function describeFilters() {
  const bits = [];
  if (state.filters.kind !== 'all') bits.push(`${KIND_LABEL[state.filters.kind] || state.filters.kind}`);
  if (state.filters.q.trim()) bits.push(`“${state.filters.q.trim()}”`);
  return bits.length ? `当前筛选：${bits.join(' · ')}，试试放宽条件。` : '试试放宽筛选条件。';
}

function clearFilters() {
  state.filters = { kind: 'all', q: '' };
  if (ui.searchInput) ui.searchInput.value = '';
  persistUiState();
  refreshResults({ keepScroll: true });
}

/* ==========================================================================
   选择
   ========================================================================== */

function itemById(id) {
  if (state.selected.has(id)) return state.selected.get(id);
  return state.items.find((it) => it.id === id) || null;
}

function toggleSelection(id, force) {
  const item = itemById(id);
  if (!item) return;
  const next = typeof force === 'boolean' ? force : !state.selected.has(id);
  if (next) state.selected.set(id, item);
  else state.selected.delete(id);
  const card = state.cardEls.get(id);
  if (card) setCardSelected(card, next);
  updateSelectionUI();
}

function selectAllVisible(on) {
  if (!state.visible.length) {
    if (on) toast('当前筛选下没有可选择的资源', 'warn');
    return;
  }
  if (on) {
    for (const it of state.visible) state.selected.set(it.id, it);
  } else {
    for (const it of state.visible) state.selected.delete(it.id);
  }
  syncRenderedSelection();
  updateSelectionUI();
}

function syncRenderedSelection() {
  for (const [id, card] of state.cardEls) {
    setCardSelected(card, state.selected.has(id));
  }
}

function clearSelection(silent) {
  if (!state.selected.size) return;
  state.selected.clear();
  syncRenderedSelection();
  updateSelectionUI();
  if (!silent) toast('已清空选择', 'ok', 1500);
}

function updateSelectionUI() {
  const count = state.selected.size;
  const total = state.items.length;
  let bytes = 0;
  let unknown = 0;
  for (const it of state.selected.values()) {
    if (typeof it.size === 'number' && it.size >= 0) bytes += it.size;
    else unknown += 1;
  }

  if (ui.selectedSummary) {
    ui.selectedSummary.replaceChildren();
    // 两行结构：第一行「已选 N / 共 M」，第二行合计大小，避免窄栏里挤成三行
    const line = el('span', { class: 'sum-line' });
    line.append(document.createTextNode('已选 '));
    line.append(el('b', { text: String(count) }));
    line.append(document.createTextNode(` / ${total}`));
    ui.selectedSummary.append(line);

    if (count > 0) {
      const sizeText = bytes > 0
        ? `合计 ${formatBytes(bytes)}${unknown ? '+' : ''}`
        : '合计大小未知';
      ui.selectedSummary.append(el('span', { class: 'sum-size', text: sizeText }));
    }
    ui.selectedSummary.title = count > 0
      ? `已选 ${count} 项，合计 ${bytes > 0 ? formatBytes(bytes) : '未知'}`
      : '尚未选择资源';
  }

  if (ui.btnDownload) {
    ui.btnDownload.disabled = state.busy || count === 0;
    ui.btnDownload.setAttribute(
      'aria-label',
      count ? `下载选中的 ${count} 个资源` : '下载选中（请先勾选资源）'
    );
  }
  if (ui.btnDownloadAll) {
    const n = state.visible.length;
    ui.btnDownloadAll.disabled = state.busy || n === 0;
    ui.btnDownloadAll.title = n ? `下载当前筛选下的 ${n} 个资源` : '没有可下载的资源';
    ui.btnDownloadAll.setAttribute('aria-label', n ? `下载全部 ${n} 个资源` : '下载全部');
  }
  if (ui.btnClearSelection) ui.btnClearSelection.disabled = count === 0;

  // 全选框：仅针对当前可见集合
  if (ui.checkAll) {
    const visible = state.visible;
    let hit = 0;
    for (const it of visible) if (state.selected.has(it.id)) hit += 1;
    ui.checkAll.checked = visible.length > 0 && hit === visible.length;
    ui.checkAll.indeterminate = hit > 0 && hit < visible.length;
    ui.checkAll.disabled = visible.length === 0;
  }
}

/* ==========================================================================
   单项操作：预览 / 复制 / 定位
   ========================================================================== */

async function handleCardAction(act, id) {
  const item = itemById(id);
  if (!item || !act) return;
  switch (act) {
    case 'preview':
      openExternal(item);
      break;
    case 'copy':
      await copyItemUrl(item);
      break;
    case 'locate':
      await locateItem(item);
      break;
    case 'download':
      await startDownload([item], 'single');
      break;
    default:
      break;
  }
}

function openExternal(item) {
  const url = item.url;
  if (!url) return;
  try {
    if (state.hasExt && chrome?.tabs?.create) {
      chrome.tabs.create({ url }, () => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) toast(`无法打开：${errMsg(lastError)}`, 'error');
      });
      return;
    }
  } catch (err) {
    console.warn('[popup] tabs.create 失败', err);
  }
  try {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) toast('弹窗被拦截，请复制链接后手动打开', 'warn', 3600);
  } catch (err) {
    toast(`无法打开资源：${errMsg(err)}`, 'error');
  }
}

async function copyItemUrl(item) {
  const url = item.url;
  if (!url) return;
  let done = false;

  // 主路径：popup 在用户点击的瞬间是**有焦点**的文档，
  // navigator.clipboard.writeText() 可以直接成功。
  // 曾经的顺序是先转后台 offscreen 文档，但 offscreen 文档永远没有焦点，
  // execCommand('copy') 与 writeText() 都会失败（"Document is not focused"），
  // 于是每次都白跑一趟再降级回来。现在把它颠倒过来。
  try {
    await navigator.clipboard.writeText(url);
    done = true;
  } catch (err) {
    console.warn('[popup] 直接写剪贴板失败，回退到后台 offscreen', err);
  }

  // 兜底：极少数浏览器策略下 popup 剪贴板不可用，再交给后台 offscreen 文档
  if (!done && state.hasExt) {
    try {
      const res = await copyText(url);
      done = !!res?.ok;
      if (!done) console.warn('[popup] 后台复制失败', res?.error);
    } catch (err) {
      console.warn('[popup] copyText 失败', err);
    }
  }

  if (done) toast('链接已复制', 'ok', 1800);
  else toast('复制失败，请手动复制链接', 'error', 3600);
}

async function locateItem(item) {
  if (!state.hasExt || state.tab?.id == null) {
    toast('定位功能仅在扩展环境可用', 'warn');
    return;
  }
  const card = state.cardEls.get(item.id);
  try {
    const res = await highlightResource(state.tab.id, item.url);
    if (res?.ok) toast('已在页面中定位该资源', 'ok', 2000);
    else toast(`定位失败：${res?.error || '无法与该页面通信'}`, 'error', 3600);
  } catch (err) {
    reportError('定位失败', err);
  }
  if (card) card.focus({ preventScroll: true });
}

/* ==========================================================================
   下载
   ========================================================================== */

function downloadOptions() {
  const s = state.settings;
  return {
    folder: s.saveSubfolder,
    organizeByType: s.organizeByType,
    conflictStrategy: s.conflictStrategy
  };
}

async function startDownload(items, reason = 'batch') {
  if (state.busy || state.dl.active) return;
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) {
    toast('请先勾选要下载的资源', 'warn');
    return;
  }

  // 初始化单条状态：全部排队中
  state.dlStates = new Map();
  for (const it of list) state.dlStates.set(it.id, { state: DL_STATE.PENDING });
  state.dl = {
    batchId: '',
    total: list.length,
    done: 0,
    failed: 0,
    active: true,
    canceled: false
  };
  applyAllCardStates();
  renderDownloadPanel(true);
  setState('downloading');
  setBusy(true, '正在创建任务…');

  let res;
  try {
    res = state.mock
      ? await mockStartDownload(list)
      : await downloadItems(list, downloadOptions());
  } catch (err) {
    res = { ok: false, error: errMsg(err) };
  }
  setBusy(false);

  if (!res || res.ok !== true) {
    state.dl.active = false;
    state.dlStates.clear();
    applyAllCardStates();
    setState('results');
    toast(`下载任务创建失败：${res?.error || '未知错误'}`, 'error', 4600);
    return;
  }

  const data = res.data || {};
  state.dl.batchId = String(data.batchId || '');
  if (typeof data.started === 'number' && data.started > 0) state.dl.total = data.started;
  if (typeof data.failed === 'number' && data.failed > 0) {
    state.dl.failed = data.failed;
    toast(`有 ${data.failed} 个资源未能加入下载队列`, 'warn', 4200);
  }
  renderDownloadPanel(true);

  // 后台若没有推送进度（例如全部瞬时失败），兜底结束
  if (state.dl.total === 0) finishDownload(false);
  if (reason === 'batch') toast(`已开始下载 ${list.length} 个资源`, 'ok', 2200);
}

/** 批量重绘已渲染卡片的下载徽标 */
function applyAllCardStates() {
  for (const [id, card] of state.cardEls) {
    const st = state.dlStates.get(id);
    if (st) setCardDownloadState(card, st.state, st.error);
    else {
      const badge = card.querySelector('.st-badge');
      if (badge) badge.remove();
      const prog = card.querySelector('.card-progress');
      if (prog) prog.remove();
      delete card.dataset.dlState;
    }
  }
}

function applyItemState(payload) {
  const id = payload?.id;
  const nextState = payload?.state;
  if (!id || !nextState) return;
  if (!state.dlStates.has(id) && !state.selected.has(id)) {
    // 非本批次的资源，忽略
    return;
  }
  // 批次已结束后，迟到的「下载中/排队」不应把徽标改回去（终态仍可刷新）
  const isTerminal = nextState !== DL_STATE.PENDING && nextState !== DL_STATE.DOWNLOADING;
  if (!state.dl.active && !isTerminal) return;

  state.dlStates.set(id, { state: nextState, error: payload?.error || '' });
  const card = state.cardEls.get(id);
  if (card) setCardDownloadState(card, nextState, payload?.error);
}

function onDownloadProgress(payload) {
  if (!state.dl.active) return;
  if (payload?.batchId && state.dl.batchId && payload.batchId !== state.dl.batchId) return;

  if (typeof payload?.total === 'number' && payload.total > 0) state.dl.total = payload.total;
  // 契约语义：done = 已完成数（含失败），failed = 其中失败数
  if (typeof payload?.done === 'number') state.dl.done = Math.max(0, payload.done);
  if (typeof payload?.failed === 'number') {
    state.dl.failed = Math.max(0, Math.min(payload.failed, state.dl.done || payload.failed));
  }
  if (payload?.canceled) state.dl.canceled = true;

  renderDownloadPanel();
  if (isDownloadFinished()) finishDownload(true);
}

/** done 已包含 failed，故完成条件只看 done（取消时以 done 或 total 判定） */
function isDownloadFinished() {
  const { total, done } = state.dl;
  if (total <= 0) return false;
  return done >= total;
}

function renderDownloadPanel(initial) {
  const { total, done, failed, canceled } = state.dl;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const success = Math.max(0, done - failed);
  const remain = Math.max(0, total - done);

  if (ui.dlTitle) {
    ui.dlTitle.textContent = canceled
      ? `已取消 · ${done}/${total || done}`
      : `正在下载 ${Math.min(done, total)} / ${total || '—'}`;
  }
  if (ui.dlSub) {
    ui.dlSub.textContent = canceled
      ? `已取消，完成 ${done} 项${failed ? ` · 失败 ${failed}` : ''}`
      : `成功 ${success} · 失败 ${failed} · 剩余 ${remain}`;
  }
  if (ui.dlBar) {
    const bar = ui.dlBar.querySelector('i');
    if (bar) bar.style.width = `${pct}%`;
    ui.dlBar.setAttribute('aria-valuenow', String(pct));
  }

  if (initial) {
    if (ui.dlPanel) ui.dlPanel.classList.remove('is-done');
    if (ui.dlDone) ui.dlDone.hidden = true;
    if (ui.dlSpinner) ui.dlSpinner.hidden = false;
  }
}

function finishDownload(fromProgress) {
  if (!state.dl.active && fromProgress) return;
  const wasActive = state.dl.active;
  state.dl.active = false;
  state.busy = false;
  if (ui.dlPanel) ui.dlPanel.classList.add('is-done');
  if (ui.dlSpinner) ui.dlSpinner.hidden = true;

  const done = state.dl.done;
  const failed = state.dl.failed;
  const canceled = state.dl.canceled;
  const success = Math.max(0, done - failed);

  // 剩余处于排队/下载中的条目，标记为跳过或取消
  for (const [id, st] of state.dlStates) {
    if (st.state === DL_STATE.PENDING || st.state === DL_STATE.DOWNLOADING) {
      const next = canceled ? DL_STATE.CANCELED : DL_STATE.SKIPPED;
      state.dlStates.set(id, { state: next });
      const card = state.cardEls.get(id);
      if (card) setCardDownloadState(card, next);
    }
  }

  if (ui.dlDone) ui.dlDone.hidden = false;
  if (ui.dlDoneText) {
    ui.dlDoneText.replaceChildren();
    if (canceled) {
      ui.dlDoneText.append(document.createTextNode('已取消下载 · '));
    }
    ui.dlDoneText.append(document.createTextNode('成功 '));
    ui.dlDoneText.append(el('b', { text: String(success) }));
    ui.dlDoneText.append(document.createTextNode(' · 失败 '));
    ui.dlDoneText.append(el('b', { class: failed ? 'is-fail' : '', text: String(failed) }));
  }

  if (wasActive) {
    if (canceled) toast(`下载已取消，完成 ${done} 项`, 'warn', 3400);
    else if (failed > 0) toast(`下载结束：成功 ${success} 项，失败 ${failed} 项`, 'warn', 4200);
    else toast(`下载完成，共 ${success} 项`, 'ok', 3000);
    if (!canceled && failed === 0 && state.settings.notifyOnComplete) {
      // 系统通知由后台负责，这里只做面板提示
    }
  }
}

async function requestCancelDownload() {
  if (!state.dl.active) return;
  const batchId = state.dl.batchId;
  state.dl.canceled = true;
  if (ui.btnCancelDownload) ui.btnCancelDownload.disabled = true;
  try {
    if (state.mock) {
      mockCancelDownload();
      toast('已取消下载', 'warn', 2200);
    } else {
      const res = await cancelBatch(batchId);
      if (res?.ok) toast('已请求取消下载', 'warn', 2200);
      else toast(`取消失败：${res?.error || '未知错误'}`, 'error', 3600);
    }
  } catch (err) {
    reportError('取消下载失败', err);
  } finally {
    if (ui.btnCancelDownload) ui.btnCancelDownload.disabled = false;
  }
  // 若后台不再推送进度，给一个兜底结束
  setTimeout(() => {
    if (state.dl.active) finishDownload(true);
  }, 1400);
}

/** 打开下载目录 */
async function openDownloadsPage() {
  if (state.hasExt) {
    try {
      if (chrome.downloads?.showDefaultFolder) {
        chrome.downloads.showDefaultFolder();
        toast('已打开下载目录', 'ok', 1800);
        return;
      }
    } catch (err) {
      console.warn('[popup] showDefaultFolder 失败', err);
    }
    // Edge/Chromium 内核相同，内部页协议名不同：Edge 上是 edge://，
    // 硬编码 chrome:// 在 Edge 上会打开空白页（用户会以为「打不开」）。
    // 按 UA 中的 Edg/ 判断，兜底两者都试。
    const isEdge = /\bEdg\//.test(navigator.userAgent);
    const internalUrls = isEdge ? ['edge://downloads/', 'chrome://downloads/'] : ['chrome://downloads/'];
    for (const url of internalUrls) {
      try {
        const tab = await chrome.tabs.create({ url });
        // 转发型内部页可能仍然空白，稍后校验一次
        if (tab?.id != null) {
          setTimeout(async () => {
            try {
              const t = await chrome.tabs.get(tab.id);
              if (t && /^(about:blank)?$/.test(t.url || '')) {
                await chrome.tabs.remove(tab.id).catch(() => {});
                toast('当前浏览器不接受该内部页，请在下载面板查看', 'warn', 3000);
              }
            } catch {
              /* 标签页可能已被用户关闭 */
            }
          }, 900);
        }
        return;
      } catch (err) {
        console.warn('[popup] 打开下载管理页失败', url, err);
      }
    }
  }
  toast('请手动在浏览器中打开「下载」页查看', 'warn', 3600);
}

function backToResults() {
  if (state.dl.active) return;
  setState('results');
  if (ui.dlPanel) ui.dlPanel.classList.remove('is-done');
  // 保留状态徽标，便于核对结果；开始下一次下载时会被重置
  updateSelectionUI();
}

/* ==========================================================================
   error
   ========================================================================== */

function showError({ title, msg, tip }) {
  stopScanTimer();
  state.scanning = false;
  if (ui.errorTitle) ui.errorTitle.textContent = title || '出错了';
  if (ui.errorMsg) ui.errorMsg.textContent = msg || '未知错误';
  if (ui.errorTip) ui.errorTip.textContent = tip || '';
  setState('error');
}

async function retryFromError() {
  if (ui.btnRetry) ui.btnRetry.disabled = true;
  try {
    await resolveTab();
    renderPageInfo();
    const info = getScannableInfo();
    if (!info.ok) {
      showError(info);
      toast(info.msg, 'warn', 3600);
      return;
    }
    await startScan();
  } catch (err) {
    reportError('重试失败', err);
  } finally {
    if (ui.btnRetry) ui.btnRetry.disabled = false;
  }
}

async function openOptionsPage(section = '') {
  try {
    if (!state.hasExt) {
      toast('设置页仅在扩展环境可用', 'warn');
      return;
    }
    const res = await openOptions(section);
    if (!res?.ok) toast(`无法打开设置页：${res?.error || '未知错误'}`, 'error', 3600);
  } catch (err) {
    reportError('打开设置页失败', err);
  }
}

/* ==========================================================================
   事件绑定
   ========================================================================== */

function bindEvents() {
  ui.btnScan?.addEventListener('click', () => void startScan());
  ui.btnCancelScan?.addEventListener('click', () => void requestCancelScan());
  ui.btnSettings?.addEventListener('click', () => void openOptionsPage());
  ui.btnRescan?.addEventListener('click', () => void startScan());
  ui.btnRetry?.addEventListener('click', () => void retryFromError());
  ui.btnErrorSettings?.addEventListener('click', () => void openOptionsPage('scan'));

  ui.btnDownload?.addEventListener('click', () => {
    void startDownload(selectedInVisibleOrder(), 'batch');
  });
  ui.btnDownloadAll?.addEventListener('click', () => {
    void startDownload(state.visible, 'batch');
  });
  ui.btnClearSelection?.addEventListener('click', () => clearSelection());
  ui.btnCancelDownload?.addEventListener('click', () => void requestCancelDownload());
  ui.btnOpenDownloads?.addEventListener('click', () => void openDownloadsPage());
  ui.btnBackResults?.addEventListener('click', backToResults);

  ui.checkAll?.addEventListener('change', () => {
    selectAllVisible(!!ui.checkAll.checked);
  });

  // 照应全选框可点击文案
  document.querySelector('.check-all-label')?.addEventListener('click', () => {
    if (!ui.checkAll) return;
    ui.checkAll.click();
  });

  const onSearch = debounce(() => {
    if (!ui.searchInput) return;
    state.filters.q = ui.searchInput.value.trim().slice(0, 120);
    persistUiState();
    refreshResults({ keepScroll: true });
  }, 160);
  ui.searchInput?.addEventListener('input', onSearch);

  ui.sortSelect?.addEventListener('change', () => {
    const next = ui.sortSelect.value;
    state.sort = SORT_KEYS.includes(next) ? next : 'default';
    persistUiState();
    refreshResults({ keepScroll: true });
  });

  ui.viewSeg?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    const next = btn.dataset.view;
    if (!VIEW_KEYS.includes(next) || next === state.viewMode) return;
    state.viewMode = next;
    syncViewSegment();
    persistUiState();
  });

  // 结果网格：勾选 / 卡片操作 / 点击卡片切换选中
  ui.resultsGrid?.addEventListener('change', (e) => {
    const input = e.target.closest('input[type="checkbox"][data-id]');
    if (!input) return;
    toggleSelection(input.dataset.id, input.checked);
  });

  ui.resultsGrid?.addEventListener('click', (e) => {
    const actBtn = e.target.closest('.act');
    if (actBtn) {
      const card = actBtn.closest('.resource-card');
      if (card && !actBtn.disabled) void handleCardAction(actBtn.dataset.act, card.dataset.id);
      return;
    }
    if (e.target.closest('.check, input, button, a, label')) return;
    const card = e.target.closest('.resource-card');
    if (!card) return;
    toggleSelection(card.dataset.id);
  });

  // 卡片键盘：空格切换勾选
  ui.resultsGrid?.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'Spacebar') return;
    const card = e.target.closest('.resource-card');
    if (!card || e.target !== card) return;
    e.preventDefault();
    toggleSelection(card.dataset.id);
  });

  document.addEventListener('keydown', onGlobalKeydown);

  // 全局兜底：任何未捕获错误都给用户反馈，不静默失败
  window.addEventListener('error', (e) => {
    if (!e?.message) return;
    console.error('[popup] 未捕获错误', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[popup] 未处理的 Promise 拒绝', e.reason);
    toast(`操作失败：${errMsg(e.reason)}`, 'error', 4200);
  });
}

function selectedInVisibleOrder() {
  const picked = [];
  for (const it of state.visible) {
    if (state.selected.has(it.id)) picked.push(it);
  }
  // 兜底：筛选外仍被勾选的资源也一并下载（例如改筛选前勾选的）
  if (picked.length !== state.selected.size) {
    for (const it of state.selected.values()) {
      if (!picked.includes(it)) picked.push(it);
    }
  }
  return picked;
}

function onGlobalKeydown(e) {
  if (e.defaultPrevented) return;
  if (e.key === 'Escape') {
    if (state.scanning) {
      e.preventDefault();
      void requestCancelScan();
      return;
    }
    if (state.dl.active) {
      e.preventDefault();
      void requestCancelDownload();
      return;
    }
    if (state.filters.q) {
      e.preventDefault();
      clearFilters();
      return;
    }
    if (state.selected.size) {
      e.preventDefault();
      clearSelection(true);
      toast('已清空选择', 'ok', 1500);
    }
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'a') {
    if (ui.body?.dataset.state !== 'results') return;
    e.preventDefault();
    selectAllVisible(true);
    return;
  }

  if (e.key === 'Enter' && !e.isComposing && !e.altKey && !mod && !e.shiftKey) {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.target?.closest?.('button, a, [contenteditable="true"]')) return;
    if (ui.body?.dataset.state !== 'results') return;
    if (!state.selected.size) {
      toast('请先勾选要下载的资源', 'warn', 2000);
      return;
    }
    e.preventDefault();
    void startDownload(selectedInVisibleOrder(), 'batch');
  }
}

/* ==========================================================================
   dev-mock：非扩展环境下的数据与模拟
   ========================================================================== */

async function maybeLoadMock() {
  try {
    const params = new URLSearchParams(location.search);
    if (!params.has('mock')) return null;
    const mod = await import('./dev-mock.js');
    return mod || null;
  } catch (err) {
    console.warn('[popup] dev-mock 加载失败', err);
    return null;
  }
}

function clearMockTimers() {
  for (const t of state.mockTimers) clearTimeout(t);
  state.mockTimers.clear();
}

function mockLater(fn) {
  const t = setTimeout(() => {
    state.mockTimers.delete(t);
    fn();
  }, 0);
  state.mockTimers.add(t);
}

/** 模拟扫描：通过 emit 走与真实推送完全一致的代码路径 */
async function mockScan() {
  const result = state.mock?.MOCK_SCAN_RESULT;
  if (!result) throw new Error('mock 数据缺失');
  const steps = [
    { phase: 'collecting', found: 0, label: '正在收集页面元素…' },
    { phase: 'collecting', found: 4, label: '正在收集页面元素…' },
    { phase: 'probing', found: 9, label: '正在探测资源大小…' },
    { phase: 'probing', found: 15, label: '正在探测资源大小…' },
    { phase: 'done', found: result.items?.length || 0, label: '扫描完成' }
  ];
  for (const step of steps) {
    await sleep(230);
    emit({ type: MSG.SCAN_PROGRESS, payload: step });
  }
  await sleep(260);
  return { ok: true, data: result };
}

function emit(msg) {
  handlePush(msg);
}

/** 模拟批量下载：推送 itemState / progress（done 含 failed，遵循契约语义） */
async function mockStartDownload(items) {
  const batchId = `b_mock_${Date.now().toString(36)}`;
  state.dl.batchId = batchId;
  state.dl.total = items.length;
  let done = 0;
  let failed = 0;
  const failIdx = items.length > 3 ? 2 : -1;

  const step = (i, canceled) => {
    if (state.dl.batchId !== batchId || !state.dl.active) return;
    if (i >= items.length || canceled) {
      emit({
        type: MSG.DOWNLOAD_PROGRESS,
        payload: { batchId, total: items.length, done, failed, canceled: !!canceled }
      });
      return;
    }
    const item = items[i];
    emit({
      type: MSG.DOWNLOAD_ITEM_STATE,
      payload: { batchId, id: item.id, state: DL_STATE.DOWNLOADING }
    });
    mockLater(() => {
      if (state.dl.batchId !== batchId || !state.dl.active) return;
      const isFail = i === failIdx;
      const willCancel = state.dl.canceled;
      if (!willCancel) {
        if (isFail) failed += 1;
        done += 1;
      }
      emit({
        type: MSG.DOWNLOAD_ITEM_STATE,
        payload: isFail
          ? { batchId, id: item.id, state: DL_STATE.FAILED, error: '模拟的网络错误' }
          : { batchId, id: item.id, state: DL_STATE.DONE, size: item.size || 0 }
      });
      emit({
        type: MSG.DOWNLOAD_PROGRESS,
        payload: { batchId, total: items.length, done, failed, canceled: willCancel }
      });
      step(i + 1, willCancel);
    });
  };

  mockLater(() => step(0, false));
  return { ok: true, data: { batchId, started: items.length, failed: 0 } };
}

function mockCancelDownload() {
  clearMockTimers();
  const batchId = state.dl.batchId;
  emit({
    type: MSG.DOWNLOAD_PROGRESS,
    payload: {
      batchId,
      total: state.dl.total,
      done: state.dl.done,
      failed: state.dl.failed,
      canceled: true
    }
  });
}

/** 截图预设：?mock=1&state=results|downloading|scanning|error */
async function applyMockPreset() {
  const params = new URLSearchParams(location.search);
  const preset = params.get('state');
  if (!preset) return;
  const mock = state.mock;
  if (!mock) return;

  if (preset === 'scanning') {
    state.scanning = true;
    state.scanStartedAt = performance.now() - 1240;
    setState('scanning');
    onScanProgress({ phase: 'probing', found: 9, label: '正在探测资源大小…' });
    if (ui.scanElapsed) ui.scanElapsed.textContent = '1.2s';
    return;
  }
  if (preset === 'error') {
    showError({
      title: '此页面无法扫描',
      msg: '浏览器内部页面（chrome://、edge://、扩展页等）不允许注入脚本。',
      tip: '支持普通网页（http / https）与本地文件（file）。'
    });
    return;
  }

  applyScanResult(mock.MOCK_SCAN_RESULT);
  setState('results');

  // 视觉自测附加参数：&view=list / &selected=1..n / &theme=light
  const themeParam = params.get('theme');
  if (themeParam === 'light' || themeParam === 'dark') bindTheme(themeParam);

  const viewParam = params.get('view');
  if (VIEW_KEYS.includes(viewParam)) {
    state.viewMode = viewParam;
    syncViewSegment();
  }

  const selParam = Number(params.get('selected'));
  if (Number.isFinite(selParam) && selParam > 0) {
    for (const it of state.visible.slice(0, Math.min(selParam, state.visible.length))) {
      state.selected.set(it.id, it);
    }
    syncRenderedSelection();
    updateSelectionUI();
  }

  if (preset === 'downloading') {
    // 构造稳定的“下载中”画面：4 完成 / 1 失败 / 2 下载中 / 其余排队
    state.dlStates.clear();
    const items = state.visible.slice(0, 9);
    items.forEach((it, i) => {
      let st = DL_STATE.PENDING;
      if (i < 4) st = DL_STATE.DONE;
      else if (i === 4) st = DL_STATE.FAILED;
      else if (i < 7) st = DL_STATE.DOWNLOADING;
      state.dlStates.set(it.id, { state: st, error: i === 4 ? '模拟的网络错误' : '' });
    });
    state.dl = { batchId: 'b_mock_preview', total: 9, done: 5, failed: 1, active: true, canceled: false };
    applyAllCardStates();
    renderDownloadPanel(true);
    setState('downloading');
  }
}

/* ==========================================================================
   启动
   ========================================================================== */

async function init() {
  if (!ui.btnScan) console.error('[popup] 关键 DOM 缺失：请检查 popup.html');
  try {
    // 1. 加载 mock（仅 ?mock=1）
    state.mock = await maybeLoadMock();

    // 2. 设置 + 主题（尽早应用，避免闪白）
    state.settings = await getSettings();
    bindTheme(state.settings.theme);
    watchSettings();

    // 3. UI 状态（受 rememberFilters 控制）
    await restoreUiState();

    // 4. 当前标签页与页面信息
    await resolveTab();
    renderPageInfo();

    // 5. 版本号
    try {
      if (ui.appVer && state.hasExt) {
        ui.appVer.textContent = `v${chrome.runtime.getManifest().version}`;
      }
    } catch (err) {
      console.warn('[popup] 读取版本号失败', err);
    }

    // 6. 绑定事件 + 订阅推送
    bindEvents();
    if (state.hasExt) {
      try {
        onPush(handlePush);
      } catch (err) {
        console.warn('[popup] 订阅后台推送失败', err);
      }
      await loadHistory();
    }

    // 7. 初始状态：未点击前绝不扫描；只有真的判定不可扫描才进 error
    setState('idle');
    const info = getScannableInfo();
    if (!info.ok) {
      // 延后一拍再切 error，保证 body[data-state] 初始渲染稳定为 idle
      await sleep(0);
      if (getScannableInfo().ok) return;
      showError(info);
    }

    // 8. mock 截图预设
    if (state.mock) await applyMockPreset();
  } catch (err) {
    console.error('[popup] 初始化失败', err);
    toast(`初始化失败：${errMsg(err)}`, 'error', 5000);
    setState('idle');
  }
}

/* 后台推送分发 */
function handlePush(msg) {
  if (!msg || !msg.type) return;
  const { type, payload } = msg;
  try {
    if (type === MSG.SCAN_PROGRESS) onScanProgress(payload);
    else if (type === MSG.DOWNLOAD_PROGRESS) onDownloadProgress(payload);
    else if (type === MSG.DOWNLOAD_ITEM_STATE) applyItemState(payload);
  } catch (err) {
    reportError('处理后台推送失败', err);
  }
}

/** 页面卸载时清理定时器与订阅（避免 popup 反复打开累积监听） */
function dispose() {
  stopScanTimer();
  clearMockTimers();
  for (const t of state.toastTimers) clearTimeout(t);
  state.toastTimers.clear();
  if (state.themeStop) {
    try { state.themeStop(); } catch { /* ignore */ }
    state.themeStop = null;
  }
  if (state.settingsStop) {
    try { state.settingsStop(); } catch { /* ignore */ }
    state.settingsStop = null;
  }
}

window.addEventListener('pagehide', dispose, { once: true });

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
} else {
  void init();
}
