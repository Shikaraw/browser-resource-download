/**
 * @file lib/messaging.js
 * @module ERD/messaging
 * popup / options 与 background 的唯一通信入口。
 * UI 层不要直接调用 chrome.downloads / chrome.scripting，一律走这里，便于测试与兜底。
 */
import { MSG, DEFAULT_SETTINGS } from './constants.js';
import { errMsg } from './utils.js';

/**
 * Promise 版 sendMessage，统一错误结构。
 * 返回 { ok:true, data } 或 { ok:false, error }。
 */
export function rpc(type, payload, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(
      () => done({ ok: false, error: `请求超时（${type}）` }),
      Math.max(1000, timeout)
    );
    try {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) return done({ ok: false, error: errMsg(lastError) });
        if (!res) return done({ ok: false, error: '后台无响应' });
        done(res);
      });
    } catch (e) {
      done({ ok: false, error: errMsg(e) });
    }
  });
}

/**
 * 扫描指定标签页资源。
 * @param {number} tabId
 * @param {{ timeoutMs?: number, settings?: object }} [opts]
 * @returns {Promise<{ok:true,data:ScanResult}|{ok:false,error:string}>}
 *
 * @typedef {Object} ScanResult
 * @property {string} pageUrl
 * @property {string} pageTitle
 * @property {string} host
 * @property {import('./constants.js').ResourceItem[]} items
 * @property {number} elapsedMs
 * @property {boolean} timedOut
 * @property {{ videos:number, images:number, audios:number, others:number, total:number }} counts
 * @property {string[]} warnings
 */
export function scanPage(tabId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SETTINGS.scanTimeoutMs + 8000;
  return rpc(MSG.SCAN_PAGE, { tabId, ...opts }, { timeout: timeoutMs });
}

/** 取消扫描 { tabId } */
export const cancelScan = (tabId) => rpc(MSG.SCAN_CANCEL, { tabId }, { timeout: 5000 });

/**
 * 批量下载。
 * @param {import('./constants.js').ResourceItem[]} items
 * @param {{ folder?: string, organizeByType?: boolean, conflictStrategy?: string }} [options]
 * @returns {Promise<{ok:true,data:{batchId:string,started:number,failed:number}}|{ok:false,error:string}>}
 */
export const downloadItems = (items, options = {}) =>
  rpc(MSG.DOWNLOAD_ITEMS, { items, options }, { timeout: 60000 });

/** 取消某个下载批次 */
export const cancelBatch = (batchId) => rpc(MSG.DOWNLOAD_CANCEL, { batchId }, { timeout: 5000 });

/** 打开选项页（可带 section 锚点，如 #downloads） */
export const openOptions = (section = '') => rpc(MSG.OPEN_OPTIONS, { section }, { timeout: 5000 });

/** 在页面中高亮预览元素（会滚动到该资源） */
export const highlightResource = (tabId, url) =>
  rpc(MSG.HIGHLIGHT_RESOURCE, { tabId, url }, { timeout: 8000 });

/** 复制文本（页面无剪贴板权限时由 offscreen 兜底） */
export const copyText = (text) => rpc(MSG.COPY_TEXT, { text }, { timeout: 5000 });

/** 读取设置 */
export const fetchSettings = () => rpc(MSG.GET_SETTINGS, {}, { timeout: 5000 });

/** 写入设置 */
export const pushSettings = (patch) => rpc(MSG.SET_SETTINGS, { patch }, { timeout: 5000 });

/**
 * 订阅后台推送（扫描进度 / 下载进度 / 单条状态）。
 * @param {(msg:{type:string,payload:any}) => void} cb
 * @returns {() => void} 取消订阅
 */
export function onPush(cb) {
  const handler = (msg) => {
    if (!msg || !msg.type) return;
    if (!msg.type.startsWith('scan/') && !msg.type.startsWith('download/')) return;
    cb(msg);
  };
  chrome.runtime.onMessage.addListener(handler);
  return () => chrome.runtime.onMessage.removeListener(handler);
}

/** 获取当前活动标签页（popup 中调用） */
export async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

/** 判断 URL 是否可扫描 */
export function isScannableUrl(url = '') {
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}
