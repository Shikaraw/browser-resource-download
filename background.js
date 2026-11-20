/**
 * @file background.js
 * @module ERD/background
 *
 * MV3 Service Worker。职责：
 *  1. 扫描调度 —— 只有 popup 显式请求（SCAN_PAGE）才会向页面注入扫描器；不主动采集。
 *  2. 下载队列 —— 并发控制、子目录整理、同名策略、进度回传、取消。
 *  3. 右键菜单 / 快捷键 / 通知 / 剪贴板 / 设置读写。
 */
import { MSG, DEFAULT_SETTINGS, KIND, KIND_FOLDER, DL_STATE, STORAGE_KEYS } from './lib/constants.js';
import { sanitizeFilename, hashId, errMsg, mergeSettings, guessExt } from './lib/utils.js';

/* ==========================================================================
   设置
   ========================================================================== */
async function readSettings() {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return mergeSettings(DEFAULT_SETTINGS, raw?.[STORAGE_KEYS.SETTINGS] || {});
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(patch) {
  const cur = await readSettings();
  const next = mergeSettings(DEFAULT_SETTINGS, { ...cur, ...(patch || {}) });
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

/* ==========================================================================
   工具
   ========================================================================== */
/** 向扩展内任意页面广播（popup / options）。无接收方时静默失败。 */
function broadcast(type, payload) {
  try {
    chrome.runtime.sendMessage({ type, payload }, () => void chrome.runtime.lastError);
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isScannableUrl(url = '') {
  if (!url) return false;
  if (/^(chrome|about|edge|devtools|view-source|chrome-extension|moz-extension|chrome-untrusted|data|blob|javascript):/i.test(url))
    return false;
  return /^(https?|file|ftp):\/\//i.test(url) || url.startsWith('http');
}

/** 简单节流：同一 key 在上次触发后 interval 内只执行最后一次 */
const throttleMap = new Map();
function throttle(key, interval, fn) {
  const st = throttleMap.get(key) || { last: 0, timer: 0 };
  throttleMap.set(key, st);
  const now = Date.now();
  if (now - st.last >= interval) {
    st.last = now;
    fn();
  } else {
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.last = Date.now();
      fn();
    }, interval - (now - st.last));
  }
}

/* ==========================================================================
   扫描调度
   ========================================================================== */
/** 进行中的扫描：tabId -> { aborted, partial: ResourceItem[], startedAt } */
const activeScans = new Map();

async function ensureScannerInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/scanner.js'],
    injectImmediately: true
  });
}

async function scanTab(tabId, { settings: override } = {}) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('找不到目标标签页');
  if (!isScannableUrl(tab.url || '')) {
    throw new Error('该页面不支持扫描（浏览器内部页面或受限协议）');
  }

  const settings = { ...(await readSettings()), ...(override || {}) };
  const state = { aborted: false, partial: [], startedAt: Date.now() };
  activeScans.set(tabId, state);

  broadcast(MSG.SCAN_PROGRESS, { phase: 'collecting', found: 0, label: 'inject' });

  try {
    await ensureScannerInjected(tabId);
  } catch (e) {
    activeScans.delete(tabId);
    throw new Error(`无法注入扫描脚本：${errMsg(e)}（请刷新页面后重试）`);
  }

  // 注入完成 → 触发扫描
  broadcast(MSG.SCAN_PROGRESS, { phase: 'collecting', found: 0, label: 'dom' });

  const timeoutMs = Math.max(3000, Number(settings.scanTimeoutMs) + 5000);
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const timer = setTimeout(async () => {
      // 超时：通知页面停止并返回已收集的部分结果
      state.aborted = true;
      try {
        await chrome.tabs.sendMessage(tabId, { type: MSG.CONTENT_ABORT });
      } catch {
        /* ignore */
      }
      const partial = state.partial || [];
      finish({
        ok: true,
        data: buildResult(tab, partial, {
          timedOut: true,
          warnings: ['扫描超时，已返回部分结果']
        })
      });
    }, timeoutMs);

    chrome.tabs
      .sendMessage(tabId, { type: MSG.CONTENT_SCAN, payload: { settings } }, (res) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          return finish({
            ok: false,
            error: `页面无响应：${chrome.runtime.lastError.message}（请刷新页面后重试）`
          });
        }
        if (!res) return finish({ ok: false, error: '扫描器未返回结果' });
        if (!res.ok) return finish({ ok: false, error: res.error || '扫描失败' });
        finish({ ok: true, data: res.data });
      });
  });

  activeScans.delete(tabId);
  if (result.ok) {
    broadcast(MSG.SCAN_PROGRESS, {
      phase: 'done',
      found: result.data.items.length,
      counts: result.data.counts
    });
    await rememberHistory(result.data);
  }
  return result;
}

function buildResult(tab, items, { timedOut = false, warnings = [] } = {}) {
  const counts = { videos: 0, images: 0, audios: 0, others: 0, total: items.length };
  for (const it of items) {
    if (it.kind === KIND.VIDEO) counts.videos++;
    else if (it.kind === KIND.IMAGE) counts.images++;
    else if (it.kind === KIND.AUDIO) counts.audios++;
    else counts.others++;
  }
  return {
    pageUrl: tab.url,
    pageTitle: tab.title,
    host: (() => {
      try {
        return new URL(tab.url).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })(),
    favicon: tab.favIconUrl || '',
    items,
    elapsedMs: 0,
    timedOut,
    counts,
    warnings
  };
}

/** 最近 5 次扫描摘要（popup idle 态展示） */
async function rememberHistory(result) {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
    const list = Array.isArray(raw?.[STORAGE_KEYS.HISTORY]) ? raw[STORAGE_KEYS.HISTORY] : [];
    list.unshift({
      host: result.host,
      title: result.pageTitle,
      url: result.pageUrl,
      counts: result.counts,
      at: Date.now()
    });
    await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: list.slice(0, 5) });
  } catch {
    /* ignore */
  }
}

/* ==========================================================================
   下载队列
   ========================================================================== */
/** batchId -> Batch */
const batches = new Map();
/** chrome downloadId -> { batchId, itemId } */
const downloadIndex = new Map();

function newBatchId() {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 为一批资源生成互不冲突的文件名 */
function planFilenames(items, settings, options) {
  const folder = sanitizeFilename(options.folder ?? settings.saveSubfolder ?? 'EdgeResourceDownload', 'EdgeResourceDownload');
  const byType = options.organizeByType ?? settings.organizeByType;
  const used = new Map();

  return items.map((it) => {
    let name = it.title || '';
    name = name.split(/[?#]/)[0];
    if (!/\./.test(name) || name.length < 3) {
      const ext = it.ext || guessExt(it.url) || 'bin';
      name = `${name || it.kind}-${it.id}.${ext}`;
    }
    name = sanitizeFilename(name, `${it.kind}-${it.id}`);
    if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += `.${it.ext || guessExt(it.url) || 'bin'}`;

    const dir = byType ? `${folder}/${KIND_FOLDER[it.kind] || 'others'}` : folder;
    const key = `${dir}/${name}`.toLowerCase();
    const n = used.get(key) || 0;
    used.set(key, n + 1);
    if (n > 0) {
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)} (${n + 1})${name.slice(dot)}` : `${name} (${n + 1})`;
    }
    return `${dir}/${name}`;
  });
}

async function startDownloadBatch(items, options = {}) {
  const settings = await readSettings();
  const list = (items || []).filter((it) => it && it.url);
  if (!list.length) return { ok: false, error: '没有可下载的资源' };

  // 过滤掉非法/不可下载的
  const filtered = list.filter((it) => {
    if (!it.url) return false;
    if (/^(javascript|chrome|edge|about):/i.test(it.url)) return false;
    if (it.downloadable === false) return false;
    if (Number(settings.maxFileSize) > 0 && Number(it.size) > 0 && it.size > settings.maxFileSize) return false;
    return true;
  });

  if (!filtered.length) return { ok: false, error: '所选资源不可下载或超出大小限制' };

  const filenames = planFilenames(filtered, settings, options);
  const batchId = newBatchId();
  const batch = {
    id: batchId,
    tabId: options.tabId,
    total: filtered.length,
    done: 0,
    failed: 0,
    skipped: 0,
    canceled: false,
    startedAt: Date.now(),
    queue: filtered.map((it, i) => ({ ...it, filename: filenames[i], state: DL_STATE.PENDING })),
    active: 0,
    concurrency: Math.max(1, Math.min(8, Number(options.concurrency ?? settings.concurrency) || 3)),
    conflictStrategy: options.conflictStrategy || settings.conflictStrategy || 'uniquify',
    finished: 0
  };
  batches.set(batchId, batch);

  runBatch(batch).catch((e) => {
    batch.canceled = true;
    console.warn('[ERD] batch failed', e);
  });

  return { ok: true, data: { batchId, started: filtered.length, failed: 0 } };
}

/**
 * 推送批量进度。
 *
 * ⚠️ 契约语义（docs/CONTRACT.md 3.4）：`done` = **已完成数，含失败**；
 * `failed` = 其中失败的子集。因此前端应算 `成功 = done - failed`。
 * 这里在源头统一：`finished` 是内部终点计数（成功+失败），`done` 对外等于它。
 */
function pushProgress(batch) {
  throttle(`prog:${batch.id}`, 100, () => {
    const finished = batch.done + batch.failed;
    broadcast(MSG.DOWNLOAD_PROGRESS, {
      batchId: batch.id,
      total: batch.total,
      done: finished, // 含失败
      failed: batch.failed,
      succeeded: batch.done,
      skipped: batch.skipped,
      canceled: batch.canceled
    });
  });
}

function pushItemState(batch, item, state, extra = {}) {
  item.state = state;
  broadcast(MSG.DOWNLOAD_ITEM_STATE, {
    batchId: batch.id,
    id: item.id,
    state,
    filename: item.filename,
    ...extra
  });
}

async function runBatch(batch) {
  let cursor = 0;

  const next = () => {
    while (cursor < batch.queue.length) {
      const it = batch.queue[cursor++];
      if (it.state === DL_STATE.CANCELED || it.state === DL_STATE.SKIPPED) continue;
      return it;
    }
    return null;
  };

  const worker = async () => {
    for (;;) {
      if (batch.canceled) break;
      const item = next();
      if (!item) break;
      await downloadOne(batch, item);
      batch.finished++;
    }
  };

  const runners = Array.from({ length: Math.min(batch.concurrency, batch.queue.length) }, () =>
    worker()
  );
  await Promise.all(runners);

  // 未处理的排队项标记为取消
  for (const it of batch.queue) {
    if (it.state === DL_STATE.PENDING) pushItemState(batch, it, DL_STATE.CANCELED);
  }

  pushProgress(batch);
  const settings = await readSettings();
  if (settings.notifyOnComplete && !batch.canceled && typeof chrome.notifications !== 'undefined') {
    notifyBatchDone(batch);
  }
  setTimeout(() => batches.delete(batch.id), 5 * 60 * 1000);
}

async function downloadOne(batch, item) {
  if (batch.canceled) {
    pushItemState(batch, item, DL_STATE.CANCELED);
    return;
  }
  pushItemState(batch, item, DL_STATE.DOWNLOADING);

  // blob: 只能在其所属页面下载，路由到页面侧兜底
  if (/^blob:/i.test(item.url)) {
    const ok = await downloadViaPage(batch, item);
    if (ok) {
      batch.done++;
      pushItemState(batch, item, DL_STATE.DONE);
    } else {
      batch.failed++;
      pushItemState(batch, item, DL_STATE.FAILED, { error: 'blob 资源需在页面中导出（可在设置中开启“实验性 blob 导出”）' });
    }
    pushProgress(batch);
    return;
  }

  try {
    const downloadId = await chrome.downloads.download({
      url: item.url,
      filename: item.filename,
      conflictAction: batch.conflictStrategy === 'overwrite' ? 'overwrite' : batch.conflictStrategy === 'prompt' ? 'prompt' : 'uniquify',
      saveAs: false
    });
    downloadIndex.set(downloadId, { batchId: batch.id, itemId: item.id });

    // 某些资源（如 m3u8 清单）浏览器无法直接落盘，靠 onChanged 回调判定
    await waitForDownload(downloadId, batch, item);
  } catch (e) {
    batch.failed++;
    pushItemState(batch, item, DL_STATE.FAILED, { error: errMsg(e) });
    pushProgress(batch);
  }
}

/**
 * 等待单个 chrome.downloads 任务结束。
 * 事件 + 轮询双保险：Service Worker 休眠可能丢事件，轮询保证最终一致。
 */
function waitForDownload(downloadId, batch, item) {
  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = 0;

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(listener);
      clearInterval(pollTimer);
      downloadIndex.delete(downloadId);

      if (ok) {
        batch.done++;
        pushItemState(batch, item, DL_STATE.DONE);
      } else if (batch.canceled) {
        pushItemState(batch, item, DL_STATE.CANCELED);
      } else {
        batch.failed++;
        pushItemState(batch, item, DL_STATE.FAILED, { error });
      }
      pushProgress(batch);
      resolve(ok);
    };

    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') finish(true);
      else if (delta.state.current === 'interrupted') finish(false, delta.error?.current || '下载中断');
    };
    chrome.downloads.onChanged.addListener(listener);

    const check = async () => {
      if (settled) return;
      try {
        const [d] = await chrome.downloads.search({ id: downloadId });
        if (!d) return finish(false, '下载任务不存在');
        if (d.state === 'complete') finish(true);
        else if (d.state === 'interrupted') finish(false, d.error || '下载中断');
      } catch {
        /* 继续轮询 */
      }
    };
    void check();
    pollTimer = setInterval(check, 1200);

    setTimeout(() => finish(false, '下载超时'), 10 * 60 * 1000);
  });
}

/** 通过页面自身触发 blob 下载 */
async function downloadViaPage(batch, item) {
  if (!batch.tabId) return false;
  try {
    const res = await chrome.tabs.sendMessage(batch.tabId, {
      type: 'content/pageDownload',
      payload: { url: item.url, filename: item.filename.split('/').pop() }
    });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

async function cancelBatch(batchId) {
  const batch = batches.get(batchId);
  if (!batch) return { ok: false, error: '任务不存在或已结束' };
  batch.canceled = true;
  for (const [downloadId, ref] of downloadIndex.entries()) {
    if (ref.batchId !== batchId) continue;
    try {
      await chrome.downloads.cancel(downloadId);
    } catch {
      /* ignore */
    }
  }
  pushProgress(batch);
  return { ok: true };
}

function notifyBatchDone(batch) {
  try {
    chrome.notifications.create(`erd-batch-${batch.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: batch.failed ? '部分资源下载完成' : '资源下载完成',
      message: `成功 ${batch.done} 个${batch.failed ? `，失败 ${batch.failed} 个` : ''}`,
      priority: 0
    });
  } catch {
    /* ignore */
  }
}

/* ==========================================================================
   右键菜单 / 快捷键
   ========================================================================== */
async function syncContextMenu() {
  const settings = await readSettings();
  try {
    await chrome.contextMenus.removeAll();
    if (!settings.enableContextMenu) return;
    chrome.contextMenus.create({
      id: 'erd-scan-page',
      title: '扫描本页的资源…',
      contexts: ['page', 'image', 'video', 'audio', 'link']
    });
  } catch {
    /* ignore */
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'erd-scan-page' || !tab?.id) return;
  // 打开 popup 并自动扫描：设置一次性标记，popup 读取后自动触发
  await chrome.storage.session.set({ 'erd.autoScan': { tabId: tab.id, at: Date.now() } }).catch(() => {});
  try {
    await chrome.action.openPopup();
  } catch (err) {
    // openPopup() 在部分环境（无窗口、被策略禁用、或窗口未激活）会失败。
    // 之前这里静默吞掉，用户点了右键菜单毫无反应；改为给出可见反馈，
    // 并清除自动扫描标记，避免下次手动开 popup 时意外触发扫描
    // （那会违反「用户点击前不采集」的承诺）。
    await chrome.storage.session.remove('erd.autoScan').catch(() => {});
    console.warn('[erd] openPopup 失败，改为通知提示用户手动打开', err);
    try {
      chrome.notifications.create('erd-open-popup-failed', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '请手动打开插件面板',
        message: '当前窗口不支持自动弹出面板，请点击工具栏上的「资源下载器」图标开始扫描。',
        priority: 0
      });
    } catch {
      /* 通知不可用时忽略 */
    }
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await syncContextMenu();
  if (details.reason === 'install') {
    try {
      chrome.notifications.create('erd-welcome', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '资源下载器已安装',
        message: '点击工具栏图标，再点「扫描本页资源」即可查看可下载内容。',
        priority: 0
      });
    } catch {
      /* ignore */
    }
  }
});
chrome.runtime.onStartup.addListener(syncContextMenu);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.SETTINGS]) syncContextMenu();
});

/* ==========================================================================
   剪贴板（offscreen 文档）
   ========================================================================== */
let offscreenCreating = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  const has = await chrome.runtime.getContexts
    ? (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0
    : false;
  if (has) return true;
  if (offscreenCreating) {
    await offscreenCreating;
    return true;
  }
  offscreenCreating = chrome.offscreen
    .createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: '复制资源链接到剪贴板'
    })
    .catch(() => null)
    .finally(() => {
      offscreenCreating = null;
    });
  await offscreenCreating;
  return true;
}

async function copyTextInOffscreen(text) {
  const ok = await ensureOffscreen().catch(() => false);
  if (!ok) return { ok: false, error: '剪贴板不可用' };
  try {
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
    return res?.ok ? { ok: true } : { ok: false, error: res?.error || '复制失败' };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/* ==========================================================================
   消息路由
   ========================================================================== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { type, payload } = msg || {};
  if (!type) return false;

  // —— 内容脚本上报 ——
  if (type === MSG.CONTENT_PARTIAL) {
    const tabId = sender?.tab?.id;
    if (tabId == null) return false;
    const st = activeScans.get(tabId);
    if (st && Array.isArray(payload?.items) && payload.items.length) {
      // 部分结果按 url 去重合并
      const map = new Map(st.partial.map((i) => [i.url, i]));
      for (const it of payload.items) map.set(it.url, it);
      st.partial = Array.from(map.values());
    }
    if (st) {
      broadcast(MSG.SCAN_PROGRESS, {
        phase: payload?.phase === 'done' ? 'done' : 'collecting',
        found: payload?.found ?? st.partial.length,
        label: payload?.label
      });
    }
    return false;
  }

  // —— 忽略给 offscreen 的消息 ——
  if (msg.target === 'offscreen') return false;

  (async () => {
    try {
      switch (type) {
        case MSG.SCAN_PAGE: {
          const tabId = payload?.tabId ?? sender?.tab?.id;
          if (tabId == null) return sendResponse({ ok: false, error: '缺少标签页 ID' });
          const result = await scanTab(tabId, { settings: payload?.settings });
          return sendResponse(result);
        }
        case MSG.SCAN_CANCEL: {
          const tabId = payload?.tabId;
          const st = activeScans.get(tabId);
          if (st) st.aborted = true;
          if (tabId != null) {
            try {
              await chrome.tabs.sendMessage(tabId, { type: MSG.CONTENT_ABORT });
            } catch {
              /* ignore */
            }
          }
          return sendResponse({ ok: true });
        }
        case MSG.DOWNLOAD_ITEMS: {
          const res = await startDownloadBatch(payload?.items, { ...payload?.options, tabId: payload?.tabId ?? sender?.tab?.id });
          return sendResponse(res);
        }
        case MSG.DOWNLOAD_CANCEL: {
          const res = await cancelBatch(payload?.batchId);
          return sendResponse(res);
        }
        case MSG.OPEN_OPTIONS: {
          const url = chrome.runtime.getURL(`options/options.html${payload?.section ? `#${payload.section}` : ''}`);
          const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('options/options.html*') });
          if (tabs.length) {
            await chrome.tabs.update(tabs[0].id, { active: true, url });
            try {
              await chrome.windows.update(tabs[0].windowId, { focused: true });
            } catch {
              /* ignore */
            }
          } else {
            await chrome.tabs.create({ url });
          }
          return sendResponse({ ok: true });
        }
        case MSG.HIGHLIGHT_RESOURCE: {
          const tabId = payload?.tabId ?? sender?.tab?.id;
          if (tabId == null) return sendResponse({ ok: false, error: '缺少标签页 ID' });
          try {
            const res = await chrome.tabs.sendMessage(tabId, {
              type: 'content/highlight',
              payload: { url: payload?.url }
            });
            return sendResponse(res?.ok ? { ok: true } : { ok: false, error: res?.error || '未在页面中找到该资源' });
          } catch {
            return sendResponse({ ok: false, error: '页面未响应，请刷新后重试' });
          }
        }
        case MSG.COPY_TEXT: {
          const res = await copyTextInOffscreen(String(payload?.text ?? ''));
          return sendResponse(res);
        }
        case MSG.GET_SETTINGS: {
          return sendResponse({ ok: true, data: await readSettings() });
        }
        case MSG.SET_SETTINGS: {
          return sendResponse({ ok: true, data: await writeSettings(payload?.patch) });
        }
        default:
          return sendResponse({ ok: false, error: `未知消息类型：${type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: errMsg(e) });
    }
  })();

  return true; // 异步响应
});

/* ==========================================================================
   启动
   ========================================================================== */
chrome.runtime.onInstalled.addListener(() => {
  void hashId; // keep tree-shaker from dropping helper import used by content naming
});
syncContextMenu().catch(() => {});
