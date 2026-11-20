/**
 * @file content/scanner.js
 * @module ERD/content/scanner
 *
 * 页面内资源扫描器。⚠️ 只有在用户点击「扫描本页资源」后，background 才会通过
 * chrome.scripting.executeScript 注入本文件；manifest 中声明了 content_scripts，
 * 但该脚本**不在加载时执行任何扫描**，只注册消息监听器（惰性）。
 *
 * 职责：
 *  1. 收集 DOM 中的 <img>/<video>/<audio>/<source>/<link>/CSS background 等资源
 *  2. 收集 performance 网络请求中的媒体资源（含 m3u8/mpd/ts/fMP4）
 *  3. 收集 meta 标签中的 og:image / og:video 等
 *  4. 可选：扫描 iframe、blob 媒体（MediaSource 包装）
 *  5. 去重、推断类型/尺寸/时长，分片上报进度
 *  6. 支持 HEAD 探测文件大小（可选，受设置控制）
 */

(() => {
  'use strict';

  const ERD = (globalThis.__ERD_SCANNER__ ||= {});
  if (ERD.injected) return; // 防止重复注入
  ERD.injected = true;

  // ---------- 内联常量（内容脚本不能用 ES import，故复制最小集合） ----------
  const KIND = { VIDEO: 'video', IMAGE: 'image', AUDIO: 'audio', OTHER: 'other' };
  const EXT_KIND = {
    mp4: 'video', m4v: 'video', webm: 'video', mkv: 'video', mov: 'video', avi: 'video',
    flv: 'video', ts: 'video', ogv: 'video', '3gp': 'video', m3u8: 'video', mpd: 'video',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image',
    bmp: 'image', svg: 'image', ico: 'image',
    mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio',
    opus: 'audio', wma: 'audio', amr: 'audio',
    srt: 'other', vtt: 'other', ass: 'other', pdf: 'other', zip: 'other', rar: 'other',
    '7z': 'other', txt: 'other'
  };
  const M3U8_RE = /\.m3u8(?:[?#]|$)/i;
  const MPD_RE = /\.mpd(?:[?#]|$)/i;
  const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mkv|mov|avi|flv|ogv|ts)(?:[?#]|$)/i;
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)(?:[?#]|$)/i;
  const AUDIO_EXT_RE = /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma|amr)(?:[?#]|$)/i;
  const SKIP_RE = /^(about|chrome|chrome-extension|edge|moz-extension|devtools|view-source):/i;

  // ---------- 运行期状态 ----------
  let aborted = false;
  const seen = new Map(); // normalizedKey -> item
  /**
   * 被过滤掉的 URL（如小于 minImageSize 的埋点图）。
   * 后续阶段（CSS / 链接 / 网络请求）必须尊重它，
   * 否则 performance 网络阶段会把 DOM 阶段刚过滤的小图又加回来。
   */
  const blocked = new Set();
  let settings = {
    minImageSize: 48,
    includeDataUrls: false,
    includeBackgroundImages: true,
    includeStreams: true,
    includeMediaTags: true,
    includeBlobMedia: false,
    includeIframes: false,
    scanTimeoutMs: 15000
  };

  // ---------- 工具 ----------
  const hashId = (str) => {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (Math.imul(h2 ^ c, 0x85ebca6b) + i) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36)).slice(0, 12);
  };

  const abs = (raw) => {
    if (!raw) return '';
    try {
      const trimmed = String(raw).trim();
      if (!trimmed || trimmed === '#' || /^javascript:/i.test(trimmed)) return '';
      if (/^(data|blob|filesystem):/i.test(trimmed)) return trimmed;
      if (trimmed.startsWith('//')) return location.protocol + trimmed;
      return new URL(trimmed, document.baseURI).href;
    } catch {
      return '';
    }
  };

  const extOf = (url) => {
    const m = /\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(url || '');
    return m ? m[1].toLowerCase() : '';
  };

  const kindOf = (url, mimeHint) => {
    if (mimeHint) {
      if (/^video\//i.test(mimeHint)) return KIND.VIDEO;
      if (/^image\//i.test(mimeHint)) return KIND.IMAGE;
      if (/^audio\//i.test(mimeHint)) return KIND.AUDIO;
    }
    const e = extOf(url);
    if (e && EXT_KIND[e]) return EXT_KIND[e];
    if (M3U8_RE.test(url) || MPD_RE.test(url)) return KIND.VIDEO;
    if (VIDEO_EXT_RE.test(url)) return KIND.VIDEO;
    if (IMAGE_EXT_RE.test(url)) return KIND.IMAGE;
    if (AUDIO_EXT_RE.test(url)) return KIND.AUDIO;
    if (/^(blob):/i.test(url)) return KIND.VIDEO;
    return '';
  };

  const baseName = (url) => {
    try {
      const u = new URL(url);
      const raw = u.pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(raw);
    } catch {
      return '';
    }
  };

  const normalizeKey = (url) => {
    if (/^(data|blob):/i.test(url)) return url.slice(0, 512);
    try {
      const u = new URL(url);
      u.hash = '';
      return u.href;
    } catch {
      return url;
    }
  };

  const push = (item) => {
    if (!item?.url) return;
    if (aborted) return;
    const key = normalizeKey(item.url);
    if (!key) return;
    if (blocked.has(key)) return; // 已被前序阶段判定为应过滤
    const existing = seen.get(key);
    if (existing) {
      // 合并更完整的元信息
      if (!existing.width && item.width) existing.width = item.width;
      if (!existing.height && item.height) existing.height = item.height;
      if (!existing.duration && item.duration) existing.duration = item.duration;
      if (!existing.poster && item.poster) existing.poster = item.poster;
      if (!existing.title && item.title) existing.title = item.title;
      if (!existing.size && item.size) existing.size = item.size;
      if (!existing.mime && item.mime) existing.mime = item.mime;
      return;
    }
    const kind = item.kind || kindOf(item.url, item.mime) || KIND.OTHER;
    const ext = extOf(item.url) || undefined;
    let title = item.title || baseName(item.url) || '';
    if (!title) title = `${kind}-${hashId(item.url)}.${ext || 'bin'}`;
    const record = {
      id: hashId(`${kind}|${key}`),
      url: item.url,
      kind,
      mime: item.mime,
      title,
      ext,
      width: item.width,
      height: item.height,
      duration: item.duration,
      size: item.size,
      poster: item.poster,
      source: item.source || 'dom',
      isStream: item.isStream || M3U8_RE.test(item.url) || MPD_RE.test(item.url) || undefined,
      downloadable: item.downloadable !== false
    };
    seen.set(key, record);
  };

  // ---------- 1. DOM 媒体标签 ----------
  function scanMediaTags() {
    if (!settings.includeMediaTags) return;
    const min = Number(settings.minImageSize) || 0;

    // <video>
    for (const v of document.querySelectorAll('video')) {
      const srcs = [];
      const direct = abs(v.currentSrc || v.src);
      if (direct) srcs.push(direct);
      for (const s of v.querySelectorAll('source[src]')) {
        const u = abs(s.src);
        if (u) srcs.push(u);
      }
      const poster = abs(v.getAttribute('poster') || '');
      const metaW = v.videoWidth || v.getAttribute('width') | 0;
      const metaH = v.videoHeight || v.getAttribute('height') | 0;
      const label = (v.getAttribute('title') || v.getAttribute('aria-label') || '').trim();
      for (const url of srcs) {
        if (/^(data|blob):/i.test(url) && !settings.includeDataUrls && !settings.includeBlobMedia) continue;
        if (!/^(data|blob):/i.test(url) && !isHttpLike(url)) continue;
        if (M3U8_RE.test(url) && !settings.includeStreams) continue;
        push({
          url,
          kind: KIND.VIDEO,
          title: label || undefined,
          poster: poster || undefined,
          width: metaW || undefined,
          height: metaH || undefined,
          duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : undefined,
          source: 'video',
          downloadable: !/^blob:/i.test(url) || settings.includeBlobMedia
        });
      }
    }

    // <audio>
    for (const a of document.querySelectorAll('audio')) {
      const srcs = [abs(a.currentSrc || a.src)].filter(Boolean);
      for (const s of a.querySelectorAll('source[src]')) {
        const u = abs(s.src);
        if (u) srcs.push(u);
      }
      for (const url of srcs) {
        if (/^(data|blob):/i.test(url) && !settings.includeDataUrls) continue;
        if (!isHttpLike(url)) continue;
        push({
          url,
          kind: KIND.AUDIO,
          title: (a.getAttribute('title') || '').trim() || undefined,
          duration: Number.isFinite(a.duration) && a.duration > 0 ? a.duration : undefined,
          source: 'audio'
        });
      }
    }

    // <img>
    for (const img of document.images) {
      const cands = [];
      const cur = abs(img.currentSrc || img.src);
      if (cur) cands.push(cur);
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        // 取 srcset 中最大的候选
        const parts = srcset
          .split(',')
          .map((s) => s.trim().split(/\s+/))
          .filter((p) => p[0]);
        if (parts.length) {
          const largest = parts[parts.length - 1][0];
          const u = abs(largest);
          if (u) cands.push(u);
        }
      }
      const w = img.naturalWidth || Number(img.getAttribute('width')) || 0;
      const h = img.naturalHeight || Number(img.getAttribute('height')) || 0;
      if (min > 0 && w > 0 && h > 0 && w < min && h < min) {
        // 拉黑：后续 CSS / 链接 / 网络阶段不得再把这张小图加回来
        for (const url of cands) {
          const k = normalizeKey(url);
          if (k) blocked.add(k);
        }
        continue; // 过滤小图/埋点
      }
      for (const url of cands) {
        if (/^(data|blob):/i.test(url) && !settings.includeDataUrls) continue;
        if (!isHttpLike(url)) continue;
        push({
          url,
          kind: KIND.IMAGE,
          title: (img.alt || '').trim() || undefined,
          width: w || undefined,
          height: h || undefined,
          source: 'img'
        });
      }
    }

    // <picture><source srcset>
    for (const s of document.querySelectorAll('picture source[srcset]')) {
      const srcset = s.getAttribute('srcset') || '';
      const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
      const u = abs(first);
      if (u && isHttpLike(u)) push({ url: u, kind: KIND.IMAGE, source: 'img' });
    }
  }

  // ---------- 2. CSS 背景图 ----------
  function scanCssBackgrounds() {
    if (!settings.includeBackgroundImages) return;
    const urls = new Set();
    const collect = (value) => {
      if (!value || value === 'none') return;
      const re = /url\((['"]?)([^'")]+)\1\)/g;
      let m;
      while ((m = re.exec(value))) {
        const u = abs(m[2]);
        if (u && isHttpLike(u)) urls.add(u);
      }
    };
    for (const node of document.querySelectorAll('body, body *')) {
      const cs = getComputedStyle(node);
      if (!cs) continue;
      collect(cs.backgroundImage);
      if (cs.content && /url\(/.test(cs.content)) collect(cs.content);
      if (urls.size > 800) break; // 安全上限
    }
    for (const u of urls) push({ url: u, kind: KIND.IMAGE, source: 'css' });
  }

  // ---------- 3. 链接 / a[download] ----------
  function scanLinks() {
    for (const a of document.querySelectorAll('a[href]')) {
      const u = abs(a.href);
      if (!u || !isHttpLike(u)) continue;
      const kind = kindOf(u, '');
      if (!kind || kind === KIND.OTHER) {
        // 只收 a[download] 明确的（其它交给流/网络阶段）
        if (a.hasAttribute('download')) {
          if (!settings.includeStreams && (M3U8_RE.test(u) || MPD_RE.test(u))) continue;
          push({ url: u, kind: kind || KIND.OTHER, title: (a.getAttribute('download') || '').trim() || undefined, source: 'link' });
        }
        continue;
      }
      if (M3U8_RE.test(u) && !settings.includeStreams) continue;
      push({ url: u, kind, title: (a.getAttribute('download') || '').trim() || undefined, source: 'link' });
    }
  }

  // ---------- 4. meta / JSON-LD ----------
  function scanMeta() {
    const metaMap = [
      ['meta[property="og:image"]', KIND.IMAGE, 'content'],
      ['meta[property="og:image:secure_url"]', KIND.IMAGE, 'content'],
      ['meta[property="og:video"]', KIND.VIDEO, 'content'],
      ['meta[property="og:video:url"]', KIND.VIDEO, 'content'],
      ['meta[property="og:audio"]', KIND.AUDIO, 'content'],
      ['meta[name="twitter:image"]', KIND.IMAGE, 'content'],
      ['meta[itemprop="image"]', KIND.IMAGE, 'content'],
      ['link[rel="image_src"]', KIND.IMAGE, 'href'],
      ['link[rel="icon"]', KIND.IMAGE, 'href']
    ];
    for (const [sel, kind, attr] of metaMap) {
      for (const node of document.querySelectorAll(sel)) {
        const raw = node.getAttribute(attr);
        const u = abs(raw);
        if (!u || !isHttpLike(u)) continue;
        push({ url: u, kind, source: 'meta' });
      }
    }
    // JSON-LD 中的 contentUrl / thumbnailUrl
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const text = s.textContent || '';
      if (!/contentUrl|thumbnailUrl|embedUrl/.test(text)) continue;
      const re = /"(?:contentUrl|thumbnailUrl)"\s*:\s*"([^"]+)"/g;
      let m;
      while ((m = re.exec(text))) {
        const u = abs(m[1].replace(/\\\//g, '/'));
        if (!u || !isHttpLike(u)) continue;
        push({ url: u, kind: kindOf(u, '') || KIND.IMAGE, source: 'meta' });
      }
    }
  }

  // ---------- 5. 网络请求（performance / resource timing） ----------
  function scanNetwork() {
    const entries = performance.getEntriesByType?.('resource') || [];
    for (const e of entries) {
      const url = abs(e.name);
      if (!url || !isHttpLike(url)) continue;
      const isStream = M3U8_RE.test(url) || MPD_RE.test(url);
      if (isStream && !settings.includeStreams) continue;
      const kind = kindOf(url, e.initiatorType === 'link' ? '' : '');
      if (!kind) continue;
      // 过滤明显不是资源的（.ts 分片只在流清单中保留一个）
      push({
        url,
        kind,
        source: isStream ? 'stream' : 'network',
        isStream: isStream || undefined,
        size: e.transferSize > 0 ? e.transferSize : undefined
      });
    }
  }

  // ---------- 6. iframe（可选，同源） ----------
  function scanIframes() {
    if (!settings.includeIframes) return;
    const warnings = [];
    for (const f of document.querySelectorAll('iframe[src]')) {
      const u = abs(f.src);
      if (!u || !isHttpLike(u)) continue;
      push({ url: u, kind: KIND.OTHER, title: 'iframe 页面', source: 'link' });
    }
    if (warnings.length) ERD.warnings.push(...warnings);
  }

  // ---------- 7. blob 媒体（可选） ----------
  function scanBlobMedia() {
    if (!settings.includeBlobMedia) return;
    // MediaSource 包装：捕获已挂载的 blob URL
    const hookTag = '[data-erd-blob]';
    for (const node of document.querySelectorAll(hookTag)) {
      const url = node.getAttribute(hookTag);
      if (!url) continue;
      push({ url, kind: KIND.VIDEO, source: 'blob', downloadable: true });
    }
    for (const v of document.querySelectorAll('video[src^="blob:"]')) {
      push({ url: v.src, kind: KIND.VIDEO, source: 'blob', title: 'blob 视频.mp4', downloadable: true });
    }
  }

  const isHttpLike = (u) => /^https?:\/\//i.test(u) || /^blob:/i.test(u) || /^data:/i.test(u);

  // ---------- 尺寸/时长补齐（对 <img> 之外资源做轻量探测） ----------
  async function probeSizes(items, maxProbes = 24) {
    const targets = items
      .filter((it) => !it.size && !it.isStream && it.kind !== KIND.OTHER && it.downloadable !== false)
      .filter((it) => /^https?:/i.test(it.url))
      .slice(0, maxProbes);
    await Promise.all(
      targets.map(async (it) => {
        try {
          const res = await fetch(it.url, { method: 'HEAD', credentials: 'omit', cache: 'force-cache' });
          if (!res.ok) return;
          const len = Number(res.headers.get('content-length'));
          if (Number.isFinite(len) && len > 0) it.size = len;
          const ct = res.headers.get('content-type');
          if (ct && !it.mime) it.mime = ct.split(';')[0].trim();
        } catch {
          /* CORS 或网络失败忽略 */
        }
      })
    );
  }

  // ---------- 上报 ----------
  // 每次都带上快照，这样即使扫描超时被中断，background 也能拿到已收集的部分结果。
  function snapshot() {
    return Array.from(seen.values());
  }

  function report(phase, extra = {}) {
    try {
      chrome.runtime.sendMessage({
        type: 'content/partial',
        payload: {
          phase,
          found: seen.size,
          items: snapshot().slice(0, 2000),
          ...extra
        }
      });
    } catch {
      /* 页面卸载等 */
    }
  }

  // ---------- 主流程 ----------
  async function runScan(options = {}) {
    aborted = false;
    seen.clear();
    blocked.clear();
    ERD.warnings = [];
    settings = { ...settings, ...(options.settings || {}) };

    const started = performance.now();
    const deadline = Date.now() + (Number(settings.scanTimeoutMs) || 15000);

    const steps = [
      ['media', scanMediaTags],
      ['css', scanCssBackgrounds],
      ['links', scanLinks],
      ['meta', scanMeta],
      ['network', scanNetwork],
      ['iframe', scanIframes],
      ['blob', scanBlobMedia]
    ];

    for (const [name, fn] of steps) {
      if (aborted) break;
      if (Date.now() > deadline) {
        ERD.warnings.push('扫描超时，部分资源可能未收集');
        break;
      }
      try {
        fn();
      } catch (err) {
        ERD.warnings.push(`阶段 ${name} 失败：${String(err?.message || err)}`);
      }
      report('collecting', { label: name });
      // 让出主线程，避免长任务卡住页面
      await new Promise((r) => setTimeout(r, 0));
    }

    if (!aborted) {
      const items = Array.from(seen.values());
      try {
        await probeSizes(items);
      } catch {
        /* 忽略 */
      }
    }

    const items = Array.from(seen.values());
    const counts = { videos: 0, images: 0, audios: 0, others: 0, total: items.length };
    for (const it of items) {
      if (it.kind === KIND.VIDEO) counts.videos++;
      else if (it.kind === KIND.IMAGE) counts.images++;
      else if (it.kind === KIND.AUDIO) counts.audios++;
      else counts.others++;
    }

    return {
      pageUrl: location.href,
      pageTitle: document.title || '',
      host: location.hostname.replace(/^www\./, ''),
      favicon: (() => {
        try {
          const l = document.querySelector('link[rel~="icon"]');
          return l ? abs(l.href) : `${location.origin}/favicon.ico`;
        } catch {
          return '';
        }
      })(),
      items,
      elapsedMs: Math.round(performance.now() - started),
      timedOut: Date.now() > deadline,
      counts,
      warnings: ERD.warnings
    };
  }

  // ---------- 8. 页面内高亮定位 ----------
  function highlight(url) {
    const norm = (u) => {
      try {
        const x = new URL(u);
        x.hash = '';
        return x.href;
      } catch {
        return u;
      }
    };
    const target = norm(url);
    const candidates = [
      ...document.querySelectorAll('img[src], video[src], audio[src], source[src], a[href]')
    ];
    let match = null;
    for (const node of candidates) {
      const raw = node.getAttribute('src') || node.getAttribute('href') || '';
      const a = abs(raw);
      if (!a) continue;
      if (norm(a) === target || node.currentSrc === url) {
        match = node;
        break;
      }
    }
    if (!match) {
      // 退化：按 <img> 的 currentSrc 再比一次
      for (const img of document.images) {
        if (img.currentSrc && norm(img.currentSrc) === target) {
          match = img;
          break;
        }
      }
    }
    if (!match) return false;

    const prevOutline = match.style.outline;
    const prevOffset = match.style.outlineOffset;
    match.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    match.style.outline = '3px solid #22d3ee';
    match.style.outlineOffset = '3px';
    setTimeout(() => {
      match.style.outline = prevOutline;
      match.style.outlineOffset = prevOffset;
    }, 2200);
    return true;
  }

  // ---------- 9. 页面侧 blob 下载 ----------
  async function pageDownload({ url, filename }) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      const href = URL.createObjectURL(blob);
      a.href = href;
      a.download = filename || 'resource';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30000);
      return true;
    } catch (e) {
      console.warn('[ERD] pageDownload failed', e);
      return false;
    }
  }

  // ---------- 消息入口 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'content/scan') {
      runScan(msg.payload || {})
        .then((result) => sendResponse({ ok: true, data: result }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // 异步响应
    }
    if (msg?.type === 'content/abort') {
      aborted = true;
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'content/highlight') {
      const found = highlight(msg.payload?.url || '');
      sendResponse(found ? { ok: true } : { ok: false, error: '未在页面中找到该资源' });
      return false;
    }
    if (msg?.type === 'content/pageDownload') {
      pageDownload(msg.payload || {})
        .then((ok) => sendResponse(ok ? { ok: true } : { ok: false, error: '页面导出失败' }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    return false;
  });

  ERD.runScan = runScan;
  ERD.abort = () => {
    aborted = true;
  };
})();
