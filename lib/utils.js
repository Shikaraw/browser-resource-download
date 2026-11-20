/**
 * @file lib/utils.js
 * @module ERD/utils
 * 共享工具函数（无第三方依赖，纯函数）。
 */

/** 人类可读的字节数 */
export function formatBytes(bytes, digits) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  if (bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  const d = digits ?? (i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0);
  return `${v.toFixed(d).replace(/\.0+$/, '')} ${units[i]}`;
}

/** 秒 -> 00:00 / 1:02:03 */
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 从 URL 中猜测扩展名（不含点），失败返回 '' */
export function guessExt(url = '') {
  if (!url) return '';
  try {
    const u = new URL(url, 'https://example.com');
    const m = /\.([a-z0-9]{1,5})$/i.exec(u.pathname || '');
    if (m) return m[1].toLowerCase();
    const q = u.searchParams.get('format') || u.searchParams.get('ext');
    if (q && /^[a-z0-9]{1,5}$/i.test(q)) return q.toLowerCase();
    return '';
  } catch {
    const m = /\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(url);
    return m ? m[1].toLowerCase() : '';
  }
}

/** 取 URL 的最后一个路径段作为文件名（已解码） */
export function basenameFromUrl(url = '') {
  try {
    const u = new URL(url, 'https://example.com');
    const raw = u.pathname.split('/').filter(Boolean).pop() || '';
    return safeDecode(raw);
  } catch {
    return '';
  }
}

export function safeDecode(s = '') {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 去掉文件名中的非法字符，保留拓展名 */
export function sanitizeFilename(name, fallback = 'resource') {
  let base = (name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (!base) base = fallback;
  if (base.length > 120) {
    const dot = base.lastIndexOf('.');
    if (dot > 0 && base.length - dot <= 6) {
      base = base.slice(0, 100) + base.slice(dot);
    } else {
      base = base.slice(0, 120);
    }
  }
  return base;
}

/** 生成短 id（确定性，便于去重） */
export function hashId(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ c, 0x85ebca6b) + i) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 12);
}

/** URL 规范化：去掉 hash、追踪参数，方便去重 */
export function normalizeUrl(url) {
  if (!url) return '';
  if (/^(data|blob|filesystem):/i.test(url)) return url;
  try {
    const u = new URL(url, location?.href || 'https://example.com');
    u.hash = '';
    const drop = [];
    u.searchParams.forEach((_v, k) => {
      if (/^(utm_|spm|from|share_|vd_source|si|feature)/i.test(k)) drop.push(k);
    });
    drop.forEach((k) => u.searchParams.delete(k));
    return u.href;
  } catch {
    return url;
  }
}

/** 判断 blob/data 等特殊协议 */
export const isSpecialUrl = (url = '') => /^(data|blob|filesystem):/i.test(url);

/** 简单并发映射，带 abort 支持 */
export async function mapLimit(items, limit, worker, signal) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return;
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: String(err?.message || err) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** 防抖 */
export function debounce(fn, wait = 200) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** 深合并设置（只保留 DEFAULT 中存在的键，并做类型校验） */
export function mergeSettings(defaults, patch = {}) {
  const out = { ...defaults };
  for (const k of Object.keys(defaults)) {
    if (patch[k] === undefined) continue;
    const dv = defaults[k];
    const pv = patch[k];
    if (typeof dv === 'number' && typeof pv === 'number' && Number.isFinite(pv)) out[k] = pv;
    else if (typeof dv === 'boolean' && typeof pv === 'boolean') out[k] = pv;
    else if (typeof dv === 'string' && typeof pv === 'string') out[k] = pv;
  }
  return out;
}

/** hostname 友好显示 */
export function hostOf(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 统一错误信息 */
export function errMsg(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return err.message || err.error || String(err);
}

/** 给元素加 class 的短助手（UI 用） */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}
