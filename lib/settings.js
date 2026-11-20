/**
 * @file lib/settings.js
 * @module ERD/settings
 * 设置读写（chrome.storage.local + 默认值合并 + 变更订阅）。
 *
 * 用法：
 *   import { getSettings, saveSettings, patchSettings, onSettingsChanged, applyTheme } from '../lib/settings.js';
 *   const s = await getSettings();
 *   await patchSettings({ theme: 'dark' });
 *   onSettingsChanged((next, prev) => { ... });
 */
import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';
import { mergeSettings } from './utils.js';

/** 读取全部设置（已合并默认值） */
export async function getSettings() {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return mergeSettings(DEFAULT_SETTINGS, raw?.[STORAGE_KEYS.SETTINGS] || {});
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 全量覆盖写入（会先与默认值合并，防止脏数据） */
export async function saveSettings(next) {
  const merged = mergeSettings(DEFAULT_SETTINGS, next || {});
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
  return merged;
}

/** 局部更新，返回合并后的完整设置 */
export async function patchSettings(patch) {
  const cur = await getSettings();
  return saveSettings({ ...cur, ...patch });
}

/** 重置为默认设置 */
export async function resetSettings() {
  return saveSettings({ ...DEFAULT_SETTINGS });
}

/**
 * 订阅设置变更。回调签名 (next, previous)。
 * @returns {() => void} 取消订阅
 */
export function onSettingsChanged(cb) {
  const handler = (changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEYS.SETTINGS]) return;
    const oldV = changes[STORAGE_KEYS.SETTINGS].oldValue || {};
    const newV = changes[STORAGE_KEYS.SETTINGS].newValue || {};
    cb(mergeSettings(DEFAULT_SETTINGS, newV), mergeSettings(DEFAULT_SETTINGS, oldV));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/**
 * 应用主题：system 时跟随 prefers-color-scheme。
 * 会在 <html> 上写 data-theme="dark|light"，供 theme.css 选择器使用。
 * @param {'system'|'light'|'dark'} theme
 * @returns {() => void} 取消订阅
 */
export function applyTheme(theme = 'system') {
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const resolve = () => {
    const t = theme === 'system' ? (mq.matches ? 'light' : 'dark') : theme;
    root.setAttribute('data-theme', t);
    return t;
  };
  resolve();
  const onMq = () => resolve();
  mq.addEventListener('change', onMq);
  return () => mq.removeEventListener('change', onMq);
}

/** UI 状态持久化（筛选条件、视图模式等，popup 重开时可恢复） */
export async function loadUiState() {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEYS.UI_STATE);
    return raw?.[STORAGE_KEYS.UI_STATE] || {};
  } catch {
    return {};
  }
}

export async function saveUiState(patch) {
  try {
    const cur = await loadUiState();
    await chrome.storage.local.set({ [STORAGE_KEYS.UI_STATE]: { ...cur, ...patch } });
  } catch {
    /* ignore */
  }
}

export { DEFAULT_SETTINGS };
