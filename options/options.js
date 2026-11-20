/**
 * @file options/options.js
 * @module ERD/options
 *
 * 设置页逻辑入口。只做三件事：
 *   1) 把 DEFAULT_SETTINGS 渲染成表单；
 *   2) 控件改动后 300ms 防抖 -> lib/settings.patchSettings()（绝不直接写 chrome.storage 里的设置）；
 *   3) 主题即时预览、hash 定位、导出 / 导入 / 清空历史 / 恢复默认、存储用量。
 *
 * 降级策略：在 file:// 或任何没有 chrome.* 的环境中，全部控件仍按 DEFAULT_SETTINGS
 * 渲染并可交互（内存态），所有扩展调用都被 try/catch 包裹，不会抛未捕获异常。
 */
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  SIZE_LIMIT_OPTIONS,
  CONCURRENCY_OPTIONS,
  CONFLICT_OPTIONS
} from '../lib/constants.js';
import { debounce, errMsg, formatBytes, mergeSettings } from '../lib/utils.js';
import {
  getSettings,
  patchSettings,
  saveSettings,
  resetSettings,
  onSettingsChanged,
  applyTheme
} from '../lib/settings.js';

/* ==========================================================================
   0. 运行环境探测 & 小工具
   ========================================================================== */

/** 是否运行在扩展环境（file:// 预览时为 false） */
const HAS_EXT = (() => {
  try {
    return typeof chrome !== 'undefined' && !!chrome && !!chrome.storage && !!chrome.storage.local;
  } catch {
    return false;
  }
})();

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const toInt = (v, fb) => {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fb;
};

/** 读取扩展版本（file:// 下回退常量） */
function manifestVersion() {
  try {
    return chrome.runtime.getManifest().version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/* ==========================================================================
   1. 提示条
   ========================================================================== */

function toast(text, type = 'ok', ms = 2600) {
  const host = $('toast-host');
  if (!host) return;
  while (host.children.length >= 3) host.firstElementChild?.remove();
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.type = type;
  node.textContent = text;
  host.append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 280);
  }, ms);
}

/* ==========================================================================
   2. 保存指示器
   ========================================================================== */

const saveUi = { timer: 0 };

function setIndicator(state, text) {
  const box = $('save-indicator');
  if (!box) return;
  const label = box.querySelector('.si-text');
  clearTimeout(saveUi.timer);
  if (state === 'saved') {
    box.dataset.state = 'visible';
    if (label) label.textContent = '已保存';
    saveUi.timer = setTimeout(() => {
      box.dataset.state = 'idle';
    }, 1500);
    return;
  }
  if (state === 'saving') {
    box.dataset.state = 'saving';
    if (label) label.textContent = '保存中…';
    return;
  }
  if (state === 'error') {
    box.dataset.state = 'error';
    if (label) label.textContent = text || '保存失败';
    saveUi.timer = setTimeout(() => {
      box.dataset.state = 'idle';
    }, 2800);
    return;
  }
  box.dataset.state = 'idle';
}

/* ==========================================================================
   3. 设置状态 + 自动保存（300ms 防抖）
   ========================================================================== */

/** 当前生效设置（渲染表单的依据） */
let current = { ...DEFAULT_SETTINGS };
/** 待写入的补丁 */
let pendingPatch = {};
/** 防止“自己保存触发 onSettingsChanged”导致表单被重渲染（打断输入） */
let selfSaveUntil = 0;
/** 主题监听器的解除函数（applyTheme 返回） */
let themeDispose = null;

async function loadSettings() {
  try {
    const s = await getSettings();
    return mergeSettings(DEFAULT_SETTINGS, s || {});
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 真正落盘（扩展环境走 patchSettings；预览环境仅内存合并） */
async function persistPatch(patch) {
  const merged = mergeSettings(DEFAULT_SETTINGS, { ...current, ...patch });
  if (!HAS_EXT) return merged;
  selfSaveUntil = Date.now() + 900;
  const next = await patchSettings(patch);
  return mergeSettings(DEFAULT_SETTINGS, next);
}

const flushSave = debounce(async () => {
  const patch = pendingPatch;
  pendingPatch = {};
  if (!Object.keys(patch).length) return;
  if (!HAS_EXT) {
    current = mergeSettings(DEFAULT_SETTINGS, { ...current, ...patch });
    syncDependents(current);
    setIndicator('saved');
    return;
  }
  setIndicator('saving');
  try {
    current = await persistPatch(patch);
    syncDependents(current);
    setIndicator('saved');
    refreshUsage();
  } catch (err) {
    setIndicator('error', '保存失败');
    toast(`保存失败：${errMsg(err)}`, 'error', 3400);
    renderForm(current);
  }
}, 300);

/** 排队一次自动保存 */
function queueSave(patch) {
  if (!patch || !Object.keys(patch).length) return;
  Object.assign(pendingPatch, patch);
  setIndicator('saving');
  flushSave();
}

/* ==========================================================================
   4. 表单渲染
   ========================================================================== */

const CHECKBOX_FIELDS = [
  'includeMediaTags',
  'includeBackgroundImages',
  'includeDataUrls',
  'includeStreams',
  'includeIframes',
  'includeBlobMedia',
  'organizeByType',
  'autoSelectAll',
  'notifyOnComplete',
  'enableContextMenu',
  'rememberFilters'
];

const THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '深色' };

/** 把设置写进控件（不会触发事件，因此不会引发保存） */
function renderForm(s) {
  for (const key of CHECKBOX_FIELDS) {
    const box = $(key);
    if (box) box.checked = Boolean(s[key]);
  }

  const minSize = $('minImageSize');
  if (minSize) minSize.value = String(s.minImageSize);

  const timeout = $('scanTimeoutMs');
  if (timeout) timeout.value = String(s.scanTimeoutMs);

  const folder = $('saveSubfolder');
  if (folder) {
    folder.value = s.saveSubfolder;
    folder.setAttribute('aria-invalid', 'false');
  }

  const conflict = $('conflictStrategy');
  if (conflict) conflict.value = String(s.conflictStrategy);

  const conc = $('concurrency');
  if (conc) conc.value = String(s.concurrency);

  const maxSize = $('maxFileSize');
  if (maxSize) maxSize.value = String(s.maxFileSize);

  $$('#theme-cards .theme-card').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.value === s.theme ? 'true' : 'false');
  });

  $$('#view-seg button').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.value === s.viewMode ? 'true' : 'false');
  });

  syncDependents(s);
}

/** 同步那些“由设置派生”的展示元素（徽标、刻度、预览） */
function syncDependents(s) {
  const sizeBadge = $('min-size-badge');
  if (sizeBadge) sizeBadge.textContent = `${s.minImageSize} px`;

  $$('#min-size-chips .chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(Number(chip.dataset.value) === s.minImageSize));
  });

  const timeoutOut = $('scan-timeout-out');
  if (timeoutOut) timeoutOut.textContent = `${Math.round(s.scanTimeoutMs / 1000)} 秒`;

  const themeTag = $('theme-current');
  if (themeTag) themeTag.textContent = THEME_LABEL[s.theme] || '跟随系统';

  const preview = $('folder-preview-text');
  if (preview) {
    const sub = String(s.saveSubfolder || '').trim();
    preview.textContent = sub ? `下载 / ${sub}` : '下载 / （根目录）';
  }

  // 只在“值确实不同”时回填，避免打断正在输入的光标 / 吃掉用户刚敲的空格
  const folder = $('saveSubfolder');
  if (folder && folder !== document.activeElement && folder.value !== String(s.saveSubfolder || '')) {
    folder.value = String(s.saveSubfolder || '');
  }
}

/* ==========================================================================
   5. 控件接线
   ========================================================================== */

/** 非法文件名字符（Windows / macOS 通用） */
const ILLEGAL_FOLDER_CHARS = /[/\\:*?"<>|]/;

let folderTimer = 0;

function wireCheckboxes() {
  for (const key of CHECKBOX_FIELDS) {
    const box = $(key);
    if (!box) continue;
    box.addEventListener('change', () => {
      queueSave({ [key]: box.checked });
    });
  }
}

function wireScanRange() {
  const minSize = $('minImageSize');
  if (minSize) {
    minSize.addEventListener('input', () => {
      const raw = minSize.value.trim();
      if (raw === '') return;
      const v = clamp(toInt(raw, DEFAULT_SETTINGS.minImageSize), 0, 4096);
      syncDependents({ ...current, minImageSize: v });
      queueSave({ minImageSize: v });
    });
    minSize.addEventListener('blur', () => {
      const v = clamp(toInt(minSize.value, DEFAULT_SETTINGS.minImageSize), 0, 4096);
      minSize.value = String(v);
    });
  }

  $$('#min-size-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const v = toInt(chip.dataset.value, DEFAULT_SETTINGS.minImageSize);
      if (minSize) minSize.value = String(v);
      syncDependents({ ...current, minImageSize: v });
      queueSave({ minImageSize: v });
    });
  });

  const timeout = $('scanTimeoutMs');
  if (timeout) {
    timeout.addEventListener('input', () => {
      const v = clamp(toInt(timeout.value, DEFAULT_SETTINGS.scanTimeoutMs), 3000, 30000);
      syncDependents({ ...current, scanTimeoutMs: v });
      queueSave({ scanTimeoutMs: v });
    });
  }
}

function wireDownloads() {
  const folder = $('saveSubfolder');
  const hint = $('save-subfolder-error');
  if (folder) {
    folder.addEventListener('input', () => {
      const raw = folder.value;
      const bad = ILLEGAL_FOLDER_CHARS.test(raw);
      folder.setAttribute('aria-invalid', bad ? 'true' : 'false');
      if (hint) hint.classList.toggle('hidden', !bad);
      if (bad) return; // 非法值不落盘，保持上次有效设置
      const next = raw.trim();
      syncDependents({ ...current, saveSubfolder: next });
      clearTimeout(folderTimer);
      folderTimer = setTimeout(() => queueSave({ saveSubfolder: next }), 40);
    });
    folder.addEventListener('blur', () => {
      clearTimeout(folderTimer);
      const raw = folder.value;
      if (ILLEGAL_FOLDER_CHARS.test(raw)) {
        folder.value = current.saveSubfolder;
        folder.setAttribute('aria-invalid', 'false');
        if (hint) hint.classList.add('hidden');
        toast('保存子目录包含非法字符，已还原', 'warn');
        return;
      }
      const next = raw.trim() || DEFAULT_SETTINGS.saveSubfolder;
      folder.value = next;
      syncDependents({ ...current, saveSubfolder: next });
      queueSave({ saveSubfolder: next });
    });
  }

  const conflict = $('conflictStrategy');
  if (conflict) {
    conflict.addEventListener('change', () => {
      const allowed = CONFLICT_OPTIONS.map((o) => o.value);
      if (!allowed.includes(conflict.value)) return;
      queueSave({ conflictStrategy: conflict.value });
    });
  }

  const conc = $('concurrency');
  if (conc) {
    conc.addEventListener('change', () => {
      const allowed = CONCURRENCY_OPTIONS.map((o) => o.value);
      const v = toInt(conc.value, DEFAULT_SETTINGS.concurrency);
      if (!allowed.includes(v)) return;
      queueSave({ concurrency: v });
    });
  }

  const maxSize = $('maxFileSize');
  if (maxSize) {
    maxSize.addEventListener('change', () => {
      const allowed = SIZE_LIMIT_OPTIONS.map((o) => o.value);
      const v = toInt(maxSize.value, DEFAULT_SETTINGS.maxFileSize);
      if (!allowed.includes(v)) return;
      queueSave({ maxFileSize: v });
    });
  }
}

function wireAppearance() {
  $$('#theme-cards .theme-card').forEach((card) => {
    card.addEventListener('click', () => {
      const value = card.dataset.value;
      if (!THEME_LABEL[value]) return;
      current = { ...current, theme: value };
      $$('#theme-cards .theme-card').forEach((btn) => {
        btn.setAttribute('aria-pressed', btn.dataset.value === value ? 'true' : 'false');
      });
      previewTheme(value);
      queueSave({ theme: value });
    });
  });

  $$('#view-seg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.value;
      if (value !== 'grid' && value !== 'list') return;
      current = { ...current, viewMode: value };
      $$('#view-seg button').forEach((b) => {
        b.setAttribute('aria-pressed', b.dataset.value === value ? 'true' : 'false');
      });
      queueSave({ viewMode: value });
    });
  });
}

/** 主题即时预览（applyTheme 会订阅系统主题变化，切换前先解绑旧的） */
function previewTheme(theme) {
  try {
    if (typeof themeDispose === 'function') themeDispose();
    themeDispose = applyTheme(theme);
  } catch {
    // file:// 等无样式环境：静默降级
  }
  const tag = $('theme-current');
  if (tag) tag.textContent = THEME_LABEL[theme] || '跟随系统';
}

/* ==========================================================================
   6. 存储用量 / 历史
   ========================================================================== */

function bytesInUse() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.getBytesInUse(null, (bytes) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(errMsg(err)));
        else resolve(bytes);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function readHistory() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(STORAGE_KEYS.HISTORY, (raw) => {
        const err = chrome.runtime.lastError;
        if (err) return resolve(null);
        resolve(raw ? raw[STORAGE_KEYS.HISTORY] : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function countHistory(history) {
  if (!history) return 0;
  if (Array.isArray(history)) return history.length;
  if (typeof history === 'object') return Object.keys(history).length;
  return 0;
}

function usageLimit() {
  try {
    return chrome.storage.local.QUOTA_BYTES || 10 * 1024 * 1024;
  } catch {
    return 10 * 1024 * 1024;
  }
}

let usageBusy = false;

async function refreshUsage() {
  const valueEl = $('storage-usage');
  const quotaEl = $('storage-quota');
  const bar = $('storage-bar');
  const countEl = $('history-count');
  const limitEl = $('storage-limit');
  const limit = usageLimit();

  if (limitEl) limitEl.textContent = formatBytes(limit);
  if (quotaEl) quotaEl.textContent = `/ ${formatBytes(limit)}`;

  if (!HAS_EXT) {
    if (valueEl) valueEl.textContent = '不可用';
    if (bar) bar.style.width = '0%';
    if (countEl) countEl.textContent = '—';
    return;
  }
  if (usageBusy) return;
  usageBusy = true;
  try {
    const [bytes, history] = await Promise.all([bytesInUse(), readHistory()]);
    const safeBytes = Number.isFinite(bytes) ? bytes : 0;
    if (valueEl) valueEl.textContent = formatBytes(safeBytes);
    if (bar) bar.style.width = `${Math.max(1.2, Math.min(100, (safeBytes / limit) * 100))}%`;
    if (countEl) countEl.textContent = String(countHistory(history));
  } catch (err) {
    if (valueEl) valueEl.textContent = '读取失败';
    if (countEl) countEl.textContent = '—';
    toast(`读取存储用量失败：${errMsg(err)}`, 'warn');
  } finally {
    usageBusy = false;
  }
}

/* ==========================================================================
   7. 页内确认对话框
   ========================================================================== */

let dialogClose = null;

function openDialog({ title, body, okText = '确认', danger = true }) {
  const host = $('confirm-dialog');
  if (!host) return Promise.resolve(false);
  const titleEl = $('confirm-title');
  const bodyEl = $('confirm-body');
  const okBtn = $('confirm-ok');
  const cancelBtn = $('confirm-cancel');
  if (titleEl) titleEl.textContent = title;
  if (bodyEl) bodyEl.textContent = body;
  if (okBtn) {
    okBtn.textContent = okText;
    okBtn.className = danger ? 'btn danger' : 'btn primary';
  }
  const previousFocus = document.activeElement;
  host.classList.remove('hidden');
  host.classList.add('fade-in');
  okBtn?.focus();

  return new Promise((resolve) => {
    const finish = (value) => {
      host.classList.add('hidden');
      host.classList.remove('fade-in');
      okBtn?.removeEventListener('click', onOk);
      cancelBtn?.removeEventListener('click', onCancel);
      host.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      dialogClose = null;
      try {
        if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => {
      if (e.target === host) finish(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    };
    dialogClose = finish;
    okBtn?.addEventListener('click', onOk);
    cancelBtn?.addEventListener('click', onCancel);
    host.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

/* ==========================================================================
   8. 导出 / 导入 / 清空 / 恢复默认
   ========================================================================== */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function exportSettings() {
  try {
    const payload = {
      app: 'Edge Resource Downloader',
      kind: 'settings',
      version: manifestVersion(),
      exportedAt: new Date().toISOString(),
      settings: current
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `erd-settings-${stamp()}.json`;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('已导出设置 JSON', 'ok');
  } catch (err) {
    toast(`导出失败：${errMsg(err)}`, 'error');
  }
}

function pickSettingsObject(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)) {
    return parsed.settings;
  }
  return parsed;
}

async function importSettings(file) {
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    toast(`导入失败：不是有效的 JSON（${errMsg(err)}）`, 'error', 3600);
    return;
  }
  const raw = pickSettingsObject(parsed);
  if (!raw) {
    toast('导入失败：文件内容不是设置对象', 'error', 3600);
    return;
  }

  const merged = mergeSettings(DEFAULT_SETTINGS, raw);
  const known = Object.keys(raw).filter((k) => Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k));
  const unknown = Object.keys(raw).filter((k) => !Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k));
  const typeRejected = known.filter((k) => merged[k] !== raw[k]);

  try {
    if (HAS_EXT) {
      selfSaveUntil = Date.now() + 900;
      current = mergeSettings(DEFAULT_SETTINGS, await saveSettings(merged));
    } else {
      current = merged;
    }
    renderForm(current);
    previewTheme(current.theme);
    setIndicator('saved');
    refreshUsage();
    const applied = known.length - typeRejected.length;
    const ignored = unknown.length + typeRejected.length;
    toast(
      `导入完成：应用 ${applied} 项${ignored > 0 ? `，忽略 ${ignored} 项无效字段` : ''}`,
      ignored > 0 ? 'warn' : 'ok',
      3600
    );
  } catch (err) {
    toast(`导入失败：${errMsg(err)}`, 'error', 3600);
  }
}

async function clearHistory() {
  const ok = await openDialog({
    title: '清空扫描历史？',
    body: '本机保存的扫描摘要记录将被删除，你的设置与下载文件不受影响。',
    okText: '清空历史'
  });
  if (!ok) return;
  try {
    if (HAS_EXT) {
      try {
        await chrome.storage.local.remove(STORAGE_KEYS.HISTORY);
      } catch (err) {
        throw new Error(errMsg(err));
      }
    }
    const count = $('history-count');
    if (count) count.textContent = '0';
    toast('扫描历史已清空', 'ok');
    refreshUsage();
  } catch (err) {
    toast(`清空失败：${errMsg(err)}`, 'error', 3200);
  }
}

async function resetAll() {
  const ok = await openDialog({
    title: '恢复默认设置？',
    body: '扫描范围、下载行为、外观等全部设置将重置为初始值，此操作不可撤销。',
    okText: '恢复默认'
  });
  if (!ok) return;
  try {
    if (HAS_EXT) {
      selfSaveUntil = Date.now() + 900;
      current = mergeSettings(DEFAULT_SETTINGS, await resetSettings());
    } else {
      current = { ...DEFAULT_SETTINGS };
    }
    renderForm(current);
    previewTheme(current.theme);
    setIndicator('saved');
    refreshUsage();
    toast('已恢复默认设置', 'ok');
  } catch (err) {
    toast(`恢复失败：${errMsg(err)}`, 'error', 3200);
  }
}

/* ==========================================================================
   9. 快捷键页
   ========================================================================== */

async function openShortcutsPage() {
  const url = /Edg\//.test(navigator.userAgent)
    ? 'edge://extensions/shortcuts'
    : 'chrome://extensions/shortcuts';
  try {
    if (HAS_EXT && chrome.tabs && typeof chrome.tabs.create === 'function') {
      await chrome.tabs.create({ url });
      return;
    }
  } catch {
    /* 部分内核禁止扩展打开 chrome:// 页，走复制兜底 */
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(`已复制快捷键设置地址：${url}`, 'ok', 3600);
  } catch {
    toast(`请在地址栏打开 ${url} 自定义快捷键`, 'warn', 4200);
  }
}

/* ==========================================================================
   10. 导航（hash 定位 + IntersectionObserver 联动）
   ========================================================================== */

const SECTION_ALIASES = {
  scan: 'scan',
  scanning: 'scan',
  range: 'scan',
  ranges: 'scan',
  download: 'downloads',
  downloads: 'downloads',
  saving: 'downloads',
  appearance: 'appearance',
  theme: 'appearance',
  themes: 'appearance',
  view: 'appearance',
  notification: 'notifications',
  notifications: 'notifications',
  shortcut: 'notifications',
  shortcuts: 'notifications',
  hotkey: 'notifications',
  privacy: 'privacy',
  data: 'privacy',
  storage: 'privacy',
  about: 'about',
  info: 'about'
};

function normalizeSection(raw) {
  const key = String(raw || '').replace(/^#/, '').trim().toLowerCase();
  return SECTION_ALIASES[key] || (document.getElementById(key)?.hasAttribute('data-section') ? key : '');
}

function navLinks() {
  return $$('#side-nav .nav-item');
}

function setActiveNav(sectionId) {
  for (const link of navLinks()) {
    const on = link.dataset.target === sectionId;
    if (on) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
}

function scrollToSection(sectionId, { focus = false } = {}) {
  const target = document.getElementById(sectionId);
  if (!target) return false;
  setActiveNav(sectionId);
  try {
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch {
    target.scrollIntoView();
  }
  if (focus) {
    try {
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }
  return true;
}

function wireNav() {
  for (const link of navLinks()) {
    link.addEventListener('click', () => {
      const id = link.dataset.target;
      if (!id) return;
      setActiveNav(id);
    });
  }

  window.addEventListener('hashchange', () => {
    const id = normalizeSection(location.hash);
    if (id) scrollToSection(id);
  });

  const sections = $$('[data-section]');
  if (!sections.length) return;

  let lockTimer = 0;

  /**
   * 以“阅读线”为唯一真相源计算当前分节：
   * 取最后一个 top 已越过阅读线的分节；窗口贴近底部时锁定最后一节。
   * 阅读线必须大于 scroll-padding-top（桌面 84px / 窄屏 120px），否则点击导航后
   * 目标分节停在留白处、仍被判为“未到”，高亮会错误地留在上一节。
   */
  const computeActive = () => {
    const readingLine = Math.min(220, Math.max(150, window.innerHeight * 0.34));
    const docEl = document.documentElement;
    // 仅当页面确实还能继续滚动时才用“到底部”特判；否则窗口比内容高时
    // 会把高亮永久钉在最后一节（本页内容较长，但窄屏放大时仍可能发生）。
    const scrollable = docEl.scrollHeight - window.innerHeight > 8;
    const atBottom = scrollable && window.innerHeight + window.scrollY >= docEl.scrollHeight - 24;
    if (atBottom) return sections[sections.length - 1].id;
    let activeId = sections[0].id;
    for (const s of sections) {
      if (s.getBoundingClientRect().top - readingLine <= 0) activeId = s.id;
    }
    return activeId;
  };

  /**
   * 同步计算并落高亮。只有 6 个分节，getBoundingClientRect 的开销远小于把逻辑
   * 丢进 requestAnimationFrame 的风险（后台标签页 / headless 会节流 rAF）。
   */
  const updateActive = () => {
    if (lockTimer) return; // 程序化滚动进行中：由点击者决定高亮
    setActiveNav(computeActive());
  };

  // 滚动是主信号
  window.addEventListener('scroll', updateActive, { passive: true });
  window.addEventListener('resize', updateActive);

  // IntersectionObserver 作为额外触发源（分节进出视口时立刻重算）
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver(() => updateActive(), {
      rootMargin: '-12% 0px -20% 0px',
      threshold: [0, 0.02, 0.5, 1]
    });
    sections.forEach((s) => io.observe(s));
  }

  // 导航点击后，平滑滚动期间先锁定目标分节，结束后交还给几何计算
  for (const link of navLinks()) {
    link.addEventListener('click', () => {
      clearTimeout(lockTimer);
      lockTimer = setTimeout(() => {
        lockTimer = 0;
        setActiveNav(computeActive());
      }, 700);
    });
  }

  // 首屏先对齐一次（DOM 已就绪，布局可读）
  requestAnimationFrame(updateActive);
  setTimeout(updateActive, 60);
}

function goToInitialSection() {
  const id = normalizeSection(location.hash);
  const fallback = location.hash ? '' : 'scan';
  const target = id || fallback;
  if (!target) return;
  setActiveNav(target);
  if (location.hash) {
    // 首屏定位必须是瞬时的：html { scroll-behavior: smooth } 会覆盖 scrollIntoView 的
    // behavior:'auto'，导致设置页打开时“从顶部一路滑下去”，所以临时关闭平滑滚动。
    const jumpTo = () => {
      const node = document.getElementById(target);
      if (!node) return;
      const root = document.documentElement;
      const prev = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      try {
        node.scrollIntoView({ block: 'start', behavior: 'auto' });
      } catch {
        node.scrollIntoView();
      }
      requestAnimationFrame(() => {
        root.style.scrollBehavior = prev || '';
      });
    };
    jumpTo();
  }
}

/* ==========================================================================
   11. 启动
   ========================================================================== */

function wireActions() {
  $('btn-export')?.addEventListener('click', exportSettings);
  $('btn-reset')?.addEventListener('click', () => {
    resetAll();
  });
  $('btn-clear-history')?.addEventListener('click', () => {
    clearHistory();
  });
  $('btn-shortcuts')?.addEventListener('click', () => {
    openShortcutsPage();
  });
  $('btn-refresh-usage')?.addEventListener('click', () => {
    refreshUsage();
  });

  const importBtn = $('btn-import');
  const fileInput = $('import-file');
  if (importBtn && fileInput) {
    importBtn.addEventListener('click', () => {
      fileInput.value = '';
      fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        await importSettings(file);
      } finally {
        fileInput.value = '';
      }
    });
  }
}

function bootVersions() {
  const version = manifestVersion();
  for (const id of ['app-version', 'about-version-num', 'foot-version']) {
    const node = $(id);
    if (node) node.textContent = version;
  }
  const aboutTag = $('about-version');
  if (aboutTag) aboutTag.textContent = `v${version}`;
}

function bootPreviewMode() {
  if (HAS_EXT) return;
  const hint = document.querySelector('.nav-hint');
  if (hint) {
    hint.textContent = '预览模式 · 设置不会写入扩展';
    hint.classList.add('muted');
  }
  const modeTag = $('storage-mode-tag');
  if (modeTag) modeTag.textContent = '预览模式（无扩展权限）';
}

function subscribeExternalChanges() {
  if (!HAS_EXT) return;
  try {
    onSettingsChanged((next) => {
      if (Date.now() < selfSaveUntil) return;
      current = mergeSettings(DEFAULT_SETTINGS, next);
      renderForm(current);
      previewTheme(current.theme);
      refreshUsage();
    });
  } catch {
    /* ignore */
  }
}

async function boot() {
  wireCheckboxes();
  wireScanRange();
  wireDownloads();
  wireAppearance();
  wireActions();
  wireNav();
  bootVersions();
  bootPreviewMode();

  current = await loadSettings();
  renderForm(current);
  previewTheme(current.theme);
  subscribeExternalChanges();
  goToInitialSection();
  refreshUsage();
}

boot().catch((err) => {
  // 任何初始化异常都必须在页面上可见，且不抛到控制台作为未捕获错误
  toast(`设置页初始化失败：${errMsg(err)}`, 'error', 5000);
  try {
    renderForm({ ...DEFAULT_SETTINGS });
  } catch {
    /* ignore */
  }
});
