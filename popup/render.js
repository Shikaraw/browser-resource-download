/**
 * @file popup/render.js
 * @module ERD/popup/render
 *
 * popup 主面板的纯渲染层：
 *   - 内联 SVG 图标集（无外部资源、无字符串 innerHTML）
 *   - 资源卡片（grid / list 由父容器 data-view 控制）
 *   - 类型筛选 chips（带数量）
 *   - 空状态
 *
 * 本模块不访问 chrome.* / 存储 / 网络，只接收数据与回调，便于单独核对视觉。
 */

import { KIND, KIND_LABEL, DL_STATE } from '../lib/constants.js';
import { formatBytes, formatDuration, guessExt, basenameFromUrl, el } from '../lib/utils.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 下载状态 -> 中文徽标文案 */
export const DL_LABEL = {
  [DL_STATE.PENDING]: '排队中',
  [DL_STATE.DOWNLOADING]: '下载中',
  [DL_STATE.DONE]: '已完成',
  [DL_STATE.FAILED]: '失败',
  [DL_STATE.CANCELED]: '已取消',
  [DL_STATE.SKIPPED]: '已跳过'
};

/* ==========================================================================
   内联 SVG 图标
   ========================================================================== */

/**
 * 图标定义：parts = [tagName, attrs][]，画布 24×24，默认描边 currentColor。
 * @type {Record<string, {parts: Array<[string, Record<string, string|number>]>}>}
 */
const ICONS = {
  video: {
    parts: [
      ['rect', { x: 3.4, y: 5, width: 17.2, height: 14, rx: 3.4 }],
      ['path', { d: 'M10.4 9.1l4.6 2.9-4.6 2.9z', fill: 'currentColor', stroke: 'none' }]
    ]
  },
  image: {
    parts: [
      ['rect', { x: 3.4, y: 4.6, width: 17.2, height: 14.8, rx: 3.2 }],
      ['circle', { cx: 9, cy: 9.2, r: 1.5 }],
      ['path', { d: 'M4.2 16.2l4.6-4.4 3.2 2.9 2.6-2.2 4.8 4.5' }]
    ]
  },
  audio: {
    parts: [
      ['path', { d: 'M9.2 14.4V6.2a2.2 2.2 0 0 1 4.4 0v7.4' }],
      ['path', { d: 'M9.2 11a2.6 2.6 0 1 0 4.6 2.4' }],
      ['path', { d: 'M13.6 14.2a2.4 2.4 0 1 0 3.6-2.2v-2.4' }],
      ['path', { d: 'M17.2 7.4v2' }]
    ]
  },
  other: {
    parts: [
      ['path', { d: 'M13.6 3.4H7.4A2.4 2.4 0 0 0 5 5.8v12.4A2.4 2.4 0 0 0 7.4 20.6h9.2a2.4 2.4 0 0 0 2.4-2.4V8.6z' }],
      ['path', { d: 'M13.4 3.6v5h5' }],
      ['path', { d: 'M8.4 12.4h7.2' }],
      ['path', { d: 'M8.4 16.2h4.6' }]
    ]
  },
  download: {
    parts: [
      ['path', { d: 'M12 3.6v9.2' }],
      ['path', { d: 'M8.4 9.4l3.6 3.6 3.6-3.6' }],
      ['path', { d: 'M4.6 15.4v2.8a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-2.8' }]
    ]
  },
  external: {
    parts: [
      ['path', { d: 'M11.4 4.6H5.8a1.8 1.8 0 0 0-1.8 1.8v11.2a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8V11.4' }],
      ['path', { d: 'M14.2 4.4h5.4v5.4' }],
      ['path', { d: 'M19.2 4.8 12.8 11.2' }]
    ]
  },
  copy: {
    parts: [
      ['rect', { x: 8.6, y: 8.6, width: 11.2, height: 11.2, rx: 2.4 }],
      ['path', { d: 'M15.6 5.4H6.6a2 2 0 0 0-2 2v9' }]
    ]
  },
  locate: {
    parts: [
      ['circle', { cx: 12, cy: 12, r: 5.4 }],
      ['path', { d: 'M12 2.8v3.4M12 17.8v3.4M2.8 12h3.4M17.8 12h3.4' }]
    ]
  },
  alert: {
    parts: [
      ['path', { d: 'M12 3.6 20.9 19.5H3.1z' }],
      ['path', { d: 'M12 9.3v4.3' }],
      ['path', { d: 'M12 16.3v.6' }]
    ]
  },
  check: { parts: [['path', { d: 'M4.6 12.4 9.8 17.4 19.4 6.6' }]] },
  info: {
    parts: [
      ['circle', { cx: 12, cy: 12, r: 8.6 }],
      ['path', { d: 'M12 11.2v5' }],
      ['path', { d: 'M12 8v.4' }]
    ]
  },
  search: {
    parts: [
      ['circle', { cx: 10.8, cy: 10.8, r: 6.2 }],
      ['path', { d: 'M15.4 15.4 20.6 20.6' }]
    ]
  },
  refresh: {
    parts: [
      ['path', { d: 'M20.4 12a8.4 8.4 0 1 1-3-6.5' }],
      ['path', { d: 'M20.4 4.2v4.6h-4.6' }]
    ]
  },
  folder: {
    parts: [
      ['path', { d: 'M3.6 7.4A1.8 1.8 0 0 1 5.4 5.6h3.8l2 2.2h5.4a1.8 1.8 0 0 1 1.8 1.8v7.4a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8z' }]
    ]
  },
  sheet: {
    parts: [
      ['rect', { x: 4.4, y: 4.4, width: 15.2, height: 15.2, rx: 2.4 }],
      ['path', { d: 'M8 9.4h8' }],
      ['path', { d: 'M8 13h8' }],
      ['path', { d: 'M8 16.6h4.6' }]
    ]
  },
  x: { parts: [['path', { d: 'M6.4 6.4 17.6 17.6' }], ['path', { d: 'M17.6 6.4 6.4 17.6' }]] },
  play: { parts: [['path', { d: 'M8.4 5.4 18 12l-9.6 6.6z', fill: 'currentColor', stroke: 'none' }]] },
  dots: {
    parts: [
      ['circle', { cx: 6, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }],
      ['circle', { cx: 12, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }],
      ['circle', { cx: 18, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }]
    ]
  }
};

/**
 * 创建内联 SVG 图标。
 * @param {string} name ICONS 中的键
 * @param {{size?:number, stroke?:number, class?:string}} [opts]
 * @returns {SVGElement}
 */
export function icon(name, opts = {}) {
  const def = ICONS[name] || ICONS.other;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(opts.stroke ?? 1.9));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon-svg');
  if (opts.class) svg.classList.add(opts.class);
  if (opts.size) {
    svg.style.width = `${opts.size}px`;
    svg.style.height = `${opts.size}px`;
  }
  for (const [tag, attrs] of def.parts) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
  }
  return svg;
}

/** 资源类型对应的占位图标名 */
export function kindIcon(kind) {
  if (kind === KIND.VIDEO) return 'video';
  if (kind === KIND.IMAGE) return 'image';
  if (kind === KIND.AUDIO) return 'audio';
  return 'other';
}

/* ==========================================================================
   数据整形
   ========================================================================== */

const KIND_ORDER = [KIND.VIDEO, KIND.IMAGE, KIND.AUDIO, KIND.OTHER];

/** 归一化数字字段：非法 / 负数 -> 0 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 安全字符串 */
function str(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * 把 ScanResult.items 归一化为 UI 可直接消费的数组：
 * 补全 id / title / ext，剔除无 url 的脏数据，按 id 去重。
 * @param {any[]} items
 * @returns {any[]}
 */
export function normalizeItems(items) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== 'object') continue;
    const url = str(raw.url);
    if (!url) continue;
    const kind = KIND_ORDER.includes(raw.kind) ? raw.kind : KIND.OTHER;
    const id = str(raw.id) || `${kind}:${url}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const ext = (str(raw.ext) || guessExt(url)).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
    let title = str(raw.title) || str(raw.name) || basenameFromUrl(url);
    if (!title) title = `${KIND_LABEL[kind]}资源`;
    // data: URL 的兜底名会很长，这里兜底截断，展示层再做 2 行截断
    if (title.length > 220) title = `${title.slice(0, 200)}…`;

    const size = typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0
      ? raw.size
      : null;

    out.push({
      id,
      url,
      kind,
      mime: str(raw.mime),
      title,
      ext,
      width: num(raw.width),
      height: num(raw.height),
      duration: num(raw.duration),
      size,
      poster: str(raw.poster),
      source: str(raw.source),
      isStream: raw.isStream === true,
      downloadable: raw.downloadable !== false
    });
  }
  return out;
}

/**
 * 统计各类型数量（用于 chips 徽标）。
 * @param {any[]} items
 * @returns {{all:number, video:number, image:number, audio:number, other:number}}
 */
export function buildCounts(items) {
  const counts = { all: 0, video: 0, image: 0, audio: 0, other: 0 };
  for (const it of items) {
    if (!it) continue;
    counts.all += 1;
    const k = KIND_ORDER.includes(it.kind) ? it.kind : KIND.OTHER;
    counts[k] += 1;
  }
  return counts;
}

/**
 * 筛选（类型 + 关键词）。只影响可见集合，不改动原始数据。
 * @param {any[]} items
 * @param {{kind?:string, q?:string}} filters
 * @returns {any[]}
 */
export function filterItems(items, filters = {}) {
  const kind = filters.kind || 'all';
  const needle = String(filters.q || '').trim().toLowerCase();
  return items.filter((it) => {
    if (kind !== 'all' && it.kind !== kind) return false;
    if (!needle) return true;
    const hay = `${it.title} ${it.url} ${it.ext} ${it.mime} ${KIND_LABEL[it.kind] || ''} ${it.source}`;
    return hay.toLowerCase().includes(needle);
  });
}

/** 卡片面积（用于「尺寸」排序），缺失返回 0 */
function areaOf(it) {
  return (it.width || 0) * (it.height || 0);
}

/**
 * 排序（返回新数组）。
 * @param {any[]} items
 * @param {'default'|'size'|'dimension'|'name'} sort
 */
export function sortItems(items, sort) {
  const arr = items.slice();
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  switch (sort) {
    case 'size':
      arr.sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
      break;
    case 'dimension':
      arr.sort((a, b) => areaOf(b) - areaOf(a));
      break;
    case 'name':
      arr.sort((a, b) => collator.compare(a.title, b.title));
      break;
    default:
      break;
  }
  return arr;
}

/* ==========================================================================
   筛选 chips
   ========================================================================== */

/** chips 定义顺序：全部 + 四类 */
const CHIP_DEFS = [
  { kind: 'all', label: '全部' },
  ...KIND_ORDER.map((k) => ({ kind: k, label: KIND_LABEL[k] }))
];

/**
 * 渲染类型筛选 chips（首次创建，之后只更新 aria-pressed 与数量）。
 * @param {HTMLElement} host #kind-chips
 * @param {{all:number, video:number, image:number, audio:number, other:number}} counts
 * @param {string} active 当前选中的 kind
 * @param {(kind:string)=>void} onPick
 */
export function renderKindChips(host, counts, active, onPick) {
  if (!host) return;
  if (!host.firstElementChild) {
    for (const def of CHIP_DEFS) {
      const chip = el('button', {
        type: 'button',
        class: 'chip',
        'data-kind': def.kind,
        'aria-pressed': def.kind === active ? 'true' : 'false',
        'aria-label': `筛选${def.label}资源`
      });
      if (def.kind !== 'all') chip.append(el('span', { class: 'dot', 'aria-hidden': 'true' }));
      chip.append(el('span', { class: 'chip-label', text: def.label }));
      chip.append(el('span', { class: 'badge', text: '0' }));
      chip.addEventListener('click', () => onPick(def.kind));
      host.append(chip);
    }
  }
  for (const chip of host.children) {
    const kind = chip.dataset.kind || 'all';
    chip.setAttribute('aria-pressed', kind === active ? 'true' : 'false');
    const badge = chip.querySelector('.badge');
    if (badge) badge.textContent = String(counts[kind] ?? 0);
  }
}

/* ==========================================================================
   资源卡片
   ========================================================================== */

/** 卡片无障碍标签 */
function cardAria(item) {
  const bits = [KIND_LABEL[item.kind] || '资源', item.title];
  if (item.width && item.height) bits.push(`${item.width}×${item.height}`);
  if (item.duration) bits.push(formatDuration(item.duration));
  if (item.size != null) bits.push(formatBytes(item.size));
  if (!item.downloadable) bits.push('需特殊处理');
  return bits.filter(Boolean).join('，');
}

/**
 * 缩略图：图片用 url，视频用 poster，其余用类型色占位。
 * 加载失败自动回退到占位，绝不显示破图。
 */
function buildThumb(item) {
  const thumb = el('div', { class: 'thumb' });
  const ph = el('span', { class: 'ph' });
  ph.append(icon(kindIcon(item.kind), { size: 22 }));
  const extText = (item.ext || (item.mime ? item.mime.split('/')[1] : '') || KIND_LABEL[item.kind])
    .toUpperCase()
    .slice(0, 6);
  ph.append(el('span', { class: 'ph-ext', text: extText }));

  // 缩略图候选：图片用自身 url，视频**只用 poster**（用 mp4 当 <img src> 必然 404，
  // 浏览器不会为 <img> 解码视频首帧）。其余类型一律走类型色占位。
  const src = item.kind === KIND.IMAGE ? item.url : item.kind === KIND.VIDEO ? item.poster : '';
  const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|ogv|3gp|m3u8|mpd)(?:[?#]|$)/i;
  // 只接受浏览器可直接渲染的图片协议；blob:/filesystem: 在 popup 内不可用
  const usable = /^(https?:|file:\/\/)/i.test(src) && !VIDEO_EXT.test(src)
    || /^data:image\//i.test(src);
  if (usable) {
    const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => {
      if ((img.naturalWidth || 0) > 1 && (img.naturalHeight || 0) > 1) {
        img.classList.add('is-loaded');
        ph.hidden = true;
      } else {
        img.remove();
      }
    });
    img.addEventListener('error', () => img.remove());
    img.src = src;
    thumb.append(img);
  }
  thumb.append(ph);

  const metas = [];
  const dur = formatDuration(item.duration);
  if (dur) metas.push({ text: dur, cls: '' });
  if (item.isStream) metas.push({ text: '流', cls: 'stream-flag' });
  if (metas.length) {
    const meta = el('div', { class: 'thumb-meta', 'aria-hidden': 'true' });
    for (const m of metas) {
      meta.append(el('span', { class: m.cls, text: m.text }));
    }
    thumb.append(meta);
  }
  return thumb;
}

/** 卡片操作按钮 */
function buildActs(item) {
  const acts = el('div', { class: 'card-acts' });
  const mk = (act, ico, label, disabled, hint) => {
    const b = el('button', {
      type: 'button',
      class: 'act',
      'data-act': act,
      'aria-label': label,
      title: disabled ? `${label}（${hint}）` : label
    });
    if (disabled) b.disabled = true;
    b.append(icon(ico, { size: 13 }));
    return b;
  };
  acts.append(
    mk('download', 'download', '下载此资源', !item.downloadable, '需特殊处理'),
    mk('preview', 'external', '在新标签页打开原资源', false),
    mk('copy', 'copy', '复制资源链接', false),
    mk('locate', 'locate', '在页面中定位此资源', false)
  );
  return acts;
}

/**
 * 创建一张资源卡片。
 * @param {any} item 归一化后的资源
 * @param {{selected?: Set<string>, dlStates?: Map<string,{state:string,error?:string}>}} [ctx]
 * @returns {HTMLElement}
 */
export function createCard(item, ctx = {}) {
  const selected = ctx.selected instanceof Set ? ctx.selected : new Set();
  const dlStates = ctx.dlStates instanceof Map ? ctx.dlStates : new Map();
  const isSel = selected.has(item.id);

  const card = el('article', {
    class: 'resource-card',
    dataset: {
      id: item.id,
      kind: item.kind,
      selected: isSel ? 'true' : 'false',
      undownloadable: item.downloadable ? 'false' : 'true'
    },
    tabindex: '0',
    role: 'listitem',
    'aria-label': cardAria(item)
  });

  // 勾选框
  const check = el('label', { class: 'check', title: '选择此资源' });
  const input = el('input', {
    type: 'checkbox',
    'data-id': item.id,
    'aria-label': `选择 ${item.title}`
  });
  input.checked = isSel;
  check.append(input, el('span', { class: 'box' }));
  card.append(check);

  // 缩略图
  card.append(buildThumb(item));

  // 下载状态徽标（有状态才显示）
  const dl = dlStates.get(item.id);
  if (dl && dl.state) card.append(buildStatusBadge(dl.state, dl.error));

  // 悬浮操作
  card.append(buildActs(item));

  // 文本区
  const body = el('div', { class: 'body' });
  const top = el('div', { class: 'row-top' });
  top.append(el('span', { class: 'tag', dataset: { kind: item.kind }, text: KIND_LABEL[item.kind] || '资源' }));
  if (item.size != null) {
    top.append(el('span', { class: 'card-size', text: formatBytes(item.size) }));
  } else if (item.isStream) {
    top.append(el('span', { class: 'card-size', text: '流媒体' }));
  }

  const subBits = [];
  if (item.width && item.height) subBits.push(`${item.width}×${item.height}`);
  if (item.duration) subBits.push(formatDuration(item.duration));
  if (item.ext) subBits.push(item.ext.toUpperCase());
  if (!item.downloadable) subBits.push('需特殊处理');

  body.append(top, el('div', { class: 'name clamp-2', text: item.title }));
  const sub = el('div', { class: 'sub' });
  subBits.forEach((bit, i) => {
    if (i > 0) sub.append(el('span', { class: 'sep', 'aria-hidden': 'true' }));
    sub.append(el('span', { class: 'bit', text: bit }));
  });
  if (subBits.length) body.append(sub);
  card.append(body);

  if (dl && dl.state === DL_STATE.DOWNLOADING) {
    card.append(el('div', { class: 'card-progress', 'aria-hidden': 'true' }, el('i')));
  }

  return card;
}

/** 构建下载状态徽标节点 */
function buildStatusBadge(state, error) {
  const badge = el('span', {
    class: 'st-badge',
    dataset: { state },
    title: error ? `${DL_LABEL[state] || state}：${error}` : (DL_LABEL[state] || state)
  });
  badge.append(el('span', { class: 'dot', 'aria-hidden': 'true' }));
  badge.append(el('span', { text: DL_LABEL[state] || String(state) }));
  return badge;
}

/**
 * 同步卡片勾选视觉状态（不触发事件）。
 * @param {HTMLElement} card
 * @param {boolean} on
 */
export function setCardSelected(card, on) {
  if (!card) return;
  card.dataset.selected = on ? 'true' : 'false';
  const input = card.querySelector('.check input');
  if (input && input.checked !== !!on) input.checked = !!on;
}

/**
 * 原地更新卡片的下载状态徽标。
 * @param {HTMLElement} card
 * @param {string} state DL_STATE.*
 * @param {string} [error]
 */
export function setCardDownloadState(card, state, error) {
  if (!card || !state) return;
  card.dataset.dlState = state;
  let badge = card.querySelector('.st-badge');
  if (!badge) {
    badge = buildStatusBadge(state, error);
    const acts = card.querySelector('.card-acts');
    if (acts) card.insertBefore(badge, acts);
    else card.append(badge);
  } else {
    badge.dataset.state = state;
    badge.title = error ? `${DL_LABEL[state] || state}：${error}` : (DL_LABEL[state] || state);
    const text = badge.lastElementChild;
    if (text) text.textContent = DL_LABEL[state] || String(state);
  }
  // 下载中显示流光进度
  let prog = card.querySelector('.card-progress');
  if (state === DL_STATE.DOWNLOADING) {
    if (!prog) card.append(el('div', { class: 'card-progress', 'aria-hidden': 'true' }, el('i')));
  } else if (prog) {
    prog.remove();
  }
}

/* ==========================================================================
   空状态
   ========================================================================== */

/**
 * 渲染空状态。
 * @param {HTMLElement} host #empty-state
 * @param {{
 *   icon?: string, title?: string, desc?: string,
 *   warnings?: string[],
 *   actions?: Array<{label:string, primary?:boolean, onClick:()=>void, id?:string}>
 * }} opts
 */
export function renderEmptyState(host, opts = {}) {
  if (!host) return;
  host.replaceChildren();
  const iconBox = el('div', { class: 'icon', 'aria-hidden': 'true' });
  iconBox.append(icon(opts.icon || 'search', { size: 24, stroke: 1.8 }));
  host.append(iconBox, el('h3', { text: opts.title || '没有找到资源' }));
  if (opts.desc) host.append(el('p', { text: opts.desc }));

  const actions = (opts.actions || []).filter((a) => a && a.label && typeof a.onClick === 'function');
  if (actions.length) {
    const row = el('div', { class: 'empty-acts' });
    for (const a of actions) {
      const btn = el('button', {
        type: 'button',
        class: a.primary ? 'btn primary' : 'btn',
        id: a.id || undefined
      });
      btn.append(el('span', { text: a.label }));
      btn.addEventListener('click', a.onClick);
      row.append(btn);
    }
    host.append(row);
  }

  const warnings = (opts.warnings || []).filter((w) => typeof w === 'string' && w.trim());
  if (warnings.length) {
    const note = el('div', { class: 'warn-note' });
    note.append(icon('alert', { size: 13 }));
    note.append(el('span', { text: warnings.slice(0, 2).join('；') }));
    host.append(note);
  }
}
