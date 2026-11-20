/**
 * @file popup/dev-mock.js
 * @module ERD/popup/devMock
 *
 * 仅用于本地视觉自测（file:// 打开 popup.html 时 chrome.* 不存在）。
 * 只有 URL 带 `?mock=1` 时才会被 popup.js 动态 import，扩展正常运行时**不会加载**。
 *
 * 例：popup.html?mock=1               → idle 态 + 真实 mock 数据
 *     popup.html?mock=1&state=results  → 直接看结果网格
 *     popup.html?mock=1&state=downloading → 看下载进度面板
 *     popup.html?mock=1&state=scanning → 看扫描动效
 *     popup.html?mock=1&state=error    → 看错误态
 *
 * 数据刻意混入边界情况：缺失 size / width / height / duration / poster、
 * blob: 不可下载、data: 内联图片、超长标题、重复 id 等。
 */

const px = (id, size = 640) =>
  `https://picsum.photos/seed/erd${id}/${size}/${Math.round(size * 0.62)}`;

/** 生成一条资源 */
function r(over) {
  return {
    id: `mock-${String(over.n).padStart(2, '0')}`,
    kind: 'other',
    source: 'img',
    downloadable: true,
    ...over
  };
}

export const MOCK_PAGE = {
  pageUrl: 'https://example.com/watch/erd-demo?from=mock',
  pageTitle: '示例站点 · 视频与图片合集 — 资源提取演示页',
  host: 'example.com'
};

export const MOCK_TAB = {
  id: 1,
  url: MOCK_PAGE.pageUrl,
  title: MOCK_PAGE.pageTitle,
  favIconUrl: ''
};

/** @type {any[]} */
export const MOCK_ITEMS = [
  // ---------- video（含 poster / 无 poster / 流媒体 / 缺 size）----------
  r({
    n: 1, kind: 'video', title: '开场动画_4K_主视觉.mp4', ext: 'mp4', mime: 'video/mp4',
    width: 3840, height: 2160, duration: 12.5, size: 48_234_189, poster: px(1, 640), source: 'video'
  }),
  r({
    n: 2, kind: 'video', title: '产品演示-完整版.mp4', ext: 'mp4', mime: 'video/mp4',
    width: 1920, height: 1080, duration: 184, size: 268_435_456, poster: px(2, 640), source: 'video'
  }),
  r({
    n: 3, kind: 'video', title: '教程片段 03.webm', ext: 'webm', mime: 'video/webm',
    width: 1280, height: 720, duration: 47.2, size: 12_582_912, source: 'video'
  }),
  r({
    n: 4, kind: 'video', title: 'hls_master_playlist.m3u8', ext: 'm3u8',
    mime: 'application/vnd.apple.mpegurl', isStream: true, source: 'stream',
    width: 1920, height: 1080, duration: 3600, poster: px(4, 400)
  }),
  r({
    n: 5, kind: 'video', title: '弹窗广告_15s.mp4', ext: 'mp4', mime: 'video/mp4',
    width: 640, height: 360, duration: 15, size: 3_145_728, poster: px(5, 480), source: 'video'
  }),
  r({
    n: 6, kind: 'video', title: '后台花絮-竖屏.mp4', ext: 'mp4',
    width: 1080, height: 1920, duration: 63, size: 96_468_992, poster: px(6, 480), source: 'meta'
  }),
  r({
    n: 7, kind: 'video', title: 'blob_capture_stream.mp4', ext: 'mp4', mime: 'video/mp4',
    url: 'blob:https://example.com/9f1c2a7b-4d5e-6f70-8192-a3b4c5d6e7f8',
    width: 1280, height: 720, duration: 8.4, size: 22_020_096, source: 'blob', downloadable: false
  }),

  // ---------- image（含 data url / 极小埋点图 / 超长名）----------
  r({
    n: 8, kind: 'image', title: 'hero-banner-2x.jpg', ext: 'jpg', mime: 'image/jpeg',
    width: 2560, height: 1440, size: 1_887_436, source: 'css'
  }),
  r({
    n: 9, kind: 'image', title: '产品截图_深色模式.png', ext: 'png', mime: 'image/png',
    width: 1440, height: 900, size: 892_331, source: 'img'
  }),
  r({
    n: 10, kind: 'image', title: 'avatar-占位头像.webp', ext: 'webp', mime: 'image/webp',
    width: 256, height: 256, size: 18_204, source: 'img'
  }),
  r({
    n: 11, kind: 'image', title: 'pixel_tracking_1x1.gif', ext: 'gif', mime: 'image/gif',
    width: 1, height: 1, size: 43, source: 'img'
  }),
  r({
    n: 12, kind: 'image', title: 'inline-base64-预览图.png', ext: 'png', mime: 'image/png',
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    width: 1, height: 1, source: 'img'
  }),
  r({
    n: 13, kind: 'image',
    title: '这是一张文件名非常非常长的营销活动主视觉图片_最终确认版_v3_2026Q4_不要删_副本.png',
    ext: 'png', mime: 'image/png', width: 1920, height: 1080, size: 4_718_592, source: 'meta'
  }),
  r({
    n: 14, kind: 'image', title: 'icon-sprite.svg', ext: 'svg', mime: 'image/svg+xml',
    width: 128, height: 128, size: 6_140, source: 'link'
  }),
  r({
    n: 15, kind: 'image', title: 'gallery_08.avif', ext: 'avif', mime: 'image/avif',
    width: 800, height: 600, size: 216_843, source: 'img'
  }),

  // ---------- audio ----------
  r({
    n: 16, kind: 'audio', title: '主题曲_无损音质.flac', ext: 'flac', mime: 'audio/flac',
    duration: 236.4, size: 68_157_440, source: 'audio'
  }),
  r({
    n: 17, kind: 'audio', title: '播客第 12 期 · 对话嘉宾.mp3', ext: 'mp3', mime: 'audio/mpeg',
    duration: 3728, size: 89_653_248, source: 'audio'
  }),
  r({
    n: 18, kind: 'audio', title: 'background-loop.ogg', ext: 'ogg', mime: 'audio/ogg',
    duration: 32.8, size: 524_288, source: 'css'
  }),
  r({
    n: 19, kind: 'audio', title: '提示音_ding.wav', ext: 'wav',
    duration: 1.4, source: 'audio'
  }),

  // ---------- other ----------
  r({
    n: 20, kind: 'other', title: '产品白皮书 2026.pdf', ext: 'pdf', mime: 'application/pdf',
    size: 8_388_608, source: 'link'
  }),
  r({
    n: 21, kind: 'other', title: '字幕_中文.srt', ext: 'srt', size: 42_118, source: 'link'
  }),
  r({
    n: 22, kind: 'other', title: 'model-viewer.glb', ext: 'glb', size: 14_680_064, source: 'link'
  }),
  r({
    n: 23, kind: 'other', title: 'archive_payload.zip', ext: 'zip',
    size: 251_658_240, source: 'link'
  }),
  r({
    n: 24, kind: 'other', url: 'https://cdn.example.com/assets/no-title-available',
    source: 'link'
  }),

  // ---------- 边界 / 异常 ----------
  r({
    n: 25, kind: 'image', title: 'broken-image-404.jpg', ext: 'jpg',
    url: 'https://cdn.example.com/definitely-missing-404.jpg', width: 1200, height: 800,
    size: 245_760, source: 'img'
  }),
  r({
    n: 26, kind: 'video', title: '视频封面缺失示例.mp4', ext: 'mp4', mime: 'video/mp4',
    width: 1920, height: 1080, duration: 92, size: 134_217_728, source: 'video'
  }),
  r({
    n: 27, kind: 'audio', title: '长音频_直播回放（无体积信息）.m4a', ext: 'm4a',
    duration: 7325, source: 'audio'
  }),
  r({
    n: 28, kind: 'other', title: 'font-subset.woff2', ext: 'woff2', size: 96_256, source: 'css'
  }),
  // 与 n=8 完全同 URL / kind —— 用于验证去重（应被 normalizeItems 折叠为一条）
  r({
    n: 29, kind: 'image', title: 'hero-banner-2x.jpg',
    url: 'https://cdn.example.com/media/hero-banner-2x.jpg', ext: 'jpg',
    mime: 'image/jpeg', width: 2560, height: 1440, size: 1_887_436, source: 'css'
  }),
  // 缺 url 的脏数据 —— 必须被丢弃
  { id: 'mock-dirty-1', kind: 'image', title: '没有 URL 的脏数据' },
  // kind 非法 —— 归一化为 other
  r({
    n: 30, kind: 'document', title: '未知类型资源.ipynb', ext: 'ipynb',
    size: 1_048_576, source: 'link'
  })
];

// 给部分条目补上真实可加载的图片 URL，方便检查缩略图渲染
// （file:// 下也能加载 https 图片；失败则回退占位，正好验证回退逻辑）
const IMG_URLS = {
  8: px(101, 640),
  9: px(102, 640),
  10: px(103, 320),
  13: px(104, 640),
  15: px(105, 640),
  25: px(106, 480)
};
for (const it of MOCK_ITEMS) {
  const n = Number(String(it.id).split('-').pop());
  if (IMG_URLS[n] && it.kind === 'image') it.url = IMG_URLS[n];
}
// 视频用 picsum 做封面（真实 POSTER 语义）
for (const it of MOCK_ITEMS) {
  if (it.kind === 'video' && !it.poster && it.downloadable !== false && it.ext !== 'm3u8') {
    const n = Number(String(it.id).split('-').pop());
    it.poster = px(200 + n, 480);
  }
}
// 其余条目统一给一个可用的占位 URL（避免 normalizeItems 丢弃）
for (const it of MOCK_ITEMS) {
  if (!it.url) it.url = `https://cdn.example.com/files/${it.id}.${it.ext || 'bin'}`;
}

/** 统计 */
function counts(items) {
  const c = { videos: 0, images: 0, audios: 0, others: 0, total: items.length };
  for (const it of items) {
    if (it.kind === 'video') c.videos += 1;
    else if (it.kind === 'image') c.images += 1;
    else if (it.kind === 'audio') c.audios += 1;
    else c.others += 1;
  }
  return c;
}

/** 与 background 返回结构完全一致的 ScanResult */
export const MOCK_SCAN_RESULT = {
  pageUrl: MOCK_PAGE.pageUrl,
  pageTitle: MOCK_PAGE.pageTitle,
  host: MOCK_PAGE.host,
  items: MOCK_ITEMS,
  elapsedMs: 1843,
  timedOut: false,
  counts: counts(MOCK_ITEMS),
  warnings: ['部分样式表因跨域无法读取，已跳过 2 个背景图']
};

/** 极端场景（供人工验证空状态 / 超时） */
export const MOCK_SCAN_EMPTY = {
  ...MOCK_SCAN_RESULT,
  items: [],
  counts: { videos: 0, images: 0, audios: 0, others: 0, total: 0 },
  timedOut: false,
  warnings: []
};

export const MOCK_SCAN_TIMEOUT = {
  ...MOCK_SCAN_RESULT,
  items: MOCK_ITEMS.slice(0, 3),
  counts: counts(MOCK_ITEMS.slice(0, 3)),
  timedOut: true,
  warnings: ['扫描超过 15s，结果可能不完整']
};

export { MOCK_ITEMS as items, MOCK_ITEMS as default };
