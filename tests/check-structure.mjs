#!/usr/bin/env node
/**
 * @file tests/check-structure.mjs
 * 结构 / 契约静态巡检。用法：node tests/check-structure.mjs
 * 退出码 0 = 全通过；1 = 有错误。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const oks = [];

const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const ok = (m) => oks.push(m);

const read = (p) => readFile(join(ROOT, p), 'utf8');
const exists = async (p) => {
  try {
    await stat(join(ROOT, p));
    return true;
  } catch {
    return false;
  }
};

/* ---------------- 1. 必需文件 ---------------- */
const REQUIRED = [
  'manifest.json',
  'background.js',
  'lib/constants.js',
  'lib/utils.js',
  'lib/settings.js',
  'lib/messaging.js',
  'lib/theme.css',
  'content/scanner.js',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'options/options.html',
  'options/options.css',
  'options/options.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'icons/logo.svg',
  'offscreen/offscreen.html',
  'offscreen/offscreen.js',
  'README.md'
];
for (const f of REQUIRED) {
  if (await exists(f)) ok(`文件存在 ${f}`);
  else err(`缺少文件：${f}`);
}

/* ---------------- 2. manifest 校验 ---------------- */
let manifest = null;
try {
  manifest = JSON.parse(await read('manifest.json'));
  ok('manifest.json 可解析');
} catch (e) {
  err(`manifest.json 解析失败：${e.message}`);
}

if (manifest) {
  if (manifest.manifest_version !== 3) err('manifest_version 必须为 3');
  if (!manifest.background?.service_worker) err('缺少 background.service_worker');
  if (manifest.background?.service_worker && manifest.background.service_worker.startsWith('/'))
    err('service_worker 路径不能以 / 开头');
  if (!manifest.action?.default_popup) err('缺少 action.default_popup');
  if (!manifest.options_ui?.page) err('缺少 options_ui.page');
  // 扫描器不能被 content_scripts 自动注入（必须用户点击后才注入）
  if (Array.isArray(manifest.content_scripts) && manifest.content_scripts.length)
    err('不允许声明 content_scripts 自动注入：扫描只应在用户点击后通过 executeScript 注入');
  const need = ['activeTab', 'scripting', 'storage', 'downloads'];
  for (const p of need) if (!manifest.permissions?.includes(p)) err(`缺少权限：${p}`);
  if (!manifest.host_permissions?.length) warn('host_permissions 为空，可能无法注入扫描器');
  for (const [k, v] of Object.entries(manifest.icons || {})) {
    if (!(await exists(v))) err(`manifest.icons["${k}"] 指向不存在的文件 ${v}`);
  }
  if (manifest.action?.default_popup) {
    if (!(await exists(manifest.action.default_popup))) err(`action.default_popup 不存在`);
  }
  if (manifest.options_ui?.page && !(await exists(manifest.options_ui.page)))
    err(`options_ui.page 不存在`);

  // default_locale 必须配套 _locales/<locale>/messages.json，否则浏览器拒绝加载整个扩展
  if (manifest.default_locale) {
    const locFile = `_locales/${manifest.default_locale}/messages.json`;
    if (!(await exists(locFile))) {
      err(
        `default_locale="${manifest.default_locale}" 但缺少 ${locFile}：` +
          `浏览器会直接拒绝加载扩展（Default locale was specified, but _locales subtree is missing）`
      );
    } else {
      try {
        const msgs = JSON.parse(await read(locFile));
        if (!Object.keys(msgs).length) err(`${locFile} 为空`);
        for (const [k, v] of Object.entries(msgs)) {
          if (typeof v?.message !== 'string' || !v.message) err(`${locFile}: "${k}" 缺少 message`);
        }
        ok('_locales 默认语言文件校验通过');
      } catch (e) {
        err(`${locFile} 解析失败：${e.message}`);
      }
    }
  }

  ok('manifest 关键字段校验通过');
}

/* ---------------- 3. 所有 JS 语法 + 相对 import 可解析 ---------------- */
async function walk(dir, out = []) {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true });
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'tests'].includes(e.name)) continue;
      await walk(rel, out);
    } else out.push(rel);
  }
  return out;
}

const allFiles = await walk('');
const jsFiles = allFiles.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));

for (const f of jsFiles) {
  const src = await read(f);
  // 基本反模式
  if (/\beval\s*\(/.test(src)) err(`${f}: 使用了 eval`);
  if (/new\s+Function\s*\(/.test(src)) err(`${f}: 使用了 new Function`);
  if (/document\.write\s*\(/.test(src)) err(`${f}: 使用了 document.write`);
  if (/\binnerHTML\s*=/.test(src) && !/^\s*\/\/|\*/.test(src))
    warn(`${f}: 使用了 innerHTML 赋值，注意 XSS（资源 URL 来自页面）`);

  // 相对 import 解析
  const importRe = /(?:import|export)\s[^'"]*from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = importRe.exec(src))) {
    const spec = m[1] || m[2];
    if (!spec || !spec.startsWith('.')) continue;
    const target = join(dirname(join(ROOT, f)), spec);
    try {
      await stat(target);
    } catch {
      err(`${f}: import 无法解析 -> ${spec}`);
    }
  }
}
ok(`已检查 ${jsFiles.length} 个 JS 文件的 import 与反模式`);

/* ---------------- 4. HTML 校验：无内联脚本 / 必需 id / 引入 theme.css ---------------- */
const REQUIRED_IDS = {
  'popup/popup.html': [
    'btn-scan', 'btn-cancel-scan', 'scan-progress', 'results-grid', 'results-scroll',
    'check-all', 'search-input', 'sort-select', 'view-seg', 'kind-chips', 'actionbar',
    'btn-download', 'btn-download-all', 'btn-settings', 'empty-state', 'toast-host',
    'page-info', 'selected-summary', 'filter-counts'
  ],
  'options/options.html': [
    'side-nav', 'btn-reset', 'btn-clear-history', 'btn-export', 'btn-import',
    'save-indicator', 'storage-usage', 'theme-cards'
  ]
};

function attrIds(html) {
  const ids = new Set();
  const re = /\bid\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  return ids;
}

for (const [file, ids] of Object.entries(REQUIRED_IDS)) {
  if (!(await exists(file))) continue;
  const html = await read(file);
  const present = attrIds(html);
  // popup 允许在 JS 中动态创建，故此处仅当 HTML 完全没出现时检查 JS 兜底
  const jsFile = file.replace(/\.html$/, '.js');
  const jsSrc = (await exists(jsFile)) ? await read(jsFile) : '';
  for (const id of ids) {
    if (present.has(id)) continue;
    if (jsSrc.includes(`"${id}"`) || jsSrc.includes(`'${id}'`)) {
      warn(`${file}: #${id} 未在 HTML 中，但出现在 JS（动态创建）`);
      continue;
    }
    err(`${file}: 缺少必需 id #${id}`);
  }
  if (!/lib\/theme\.css/.test(html)) err(`${file}: 未引入 ../lib/theme.css`);
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html))
    err(`${file}: 存在内联 <script> 代码块`);
  if (/\son[a-z]+\s*=/.test(html)) err(`${file}: 存在内联事件属性 on*=`); 
  if (/https?:\/\/[^"']*\.(css|js)/.test(html)) err(`${file}: 引用了外部 CSS/JS`);
  if (!/<script[^>]+type=["']module["']/.test(html)) warn(`${file}: 入口脚本建议使用 type="module"`);
}

/* ---------------- 5. 契约常量一致性 ---------------- */
const constants = await read('lib/constants.js');
const settingsKeys = new Set();
{
  const m = /export const DEFAULT_SETTINGS\s*=\s*\{([\s\S]*?)\n\};/.exec(constants);
  if (!m) err('lib/constants.js: 找不到 DEFAULT_SETTINGS');
  else {
    const re = /^\s{2}([A-Za-z0-9_]+)\s*:/gm;
    let x;
    while ((x = re.exec(m[1]))) settingsKeys.add(x[1]);
  }
}

if (await exists('options/options.js')) {
  const src = await read('options/options.js');
  const missing = [...settingsKeys].filter((k) => !src.includes(k) && !src.includes(`[${k}]`));
  if (missing.length) err(`options/options.js 未覆盖设置项：${missing.join(', ')}`);
  else ok(`options 覆盖全部 ${settingsKeys.size} 个设置项`);
  if (/chrome\.storage\.local\.set/.test(src) && !/UI_STATE|erd\./.test(src))
    warn('options.js 直接调用 chrome.storage.local.set（设置应走 patchSettings）');
}

/* ---------------- 6. popup 尺寸契约 ---------------- */
if (await exists('popup/popup.css')) {
  const css = await read('popup/popup.css');
  if (!/380px/.test(css)) warn('popup.css 未声明 380px 宽度');
}

/* ---------------- 7. 颜色硬编码抽查（UI 文件中不应出现大量十六进制色） ---------------- */
for (const f of ['popup/popup.css', 'options/options.css']) {
  if (!(await exists(f))) continue;
  const css = await read(f);
  const hexes = css.match(/#[0-9a-fA-F]{6}\b/g) || [];
  const brandExempt = /--brand|--c-|theme\.css/;
  if (hexes.length > 14) warn(`${f}: 硬编码颜色较多（${hexes.length} 处），建议使用主题变量`);
  void brandExempt;
}

/* ---------------- 7. 图标尺寸与通道 ---------------- */
{
  // 用 zlib 手动解析 PNG 头（无需依赖）
  const pngSize = async (file) => {
    const buf = await readFile(join(ROOT, file));
    if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      bitDepth: buf[24],
      colorType: buf[25] // 6 = RGBA
    };
  };
  for (const n of [16, 32, 48, 128]) {
    const f = `icons/icon${n}.png`;
    if (!(await exists(f))) continue;
    const info = await pngSize(f);
    if (!info) {
      err(`${f}: 不是合法 PNG`);
      continue;
    }
    if (info.width !== n || info.height !== n) err(`${f}: 尺寸 ${info.width}x${info.height}，期望 ${n}x${n}`);
    if (info.colorType !== 6) err(`${f}: 颜色类型 ${info.colorType}，期望 6 (RGBA) 以保留透明背景`);
  }
  ok('图标尺寸与 alpha 通道校验');
}

/* ---------------- 8. 主题解析：data-theme 只能是 dark|light ---------------- */
if (await exists('options/options.js')) {
  const src = await read('options/options.js');
  // 常见错误：直接把 'system' 写进 data-theme，导致 CSS 无匹配规则
  if (/setAttribute\(\s*['"]data-theme['"]\s*,\s*['"]system['"]/.test(src))
    err('options/options.js: 把 "system" 直接写入 data-theme（应经 applyTheme 解析为 dark/light）');
  if (/dataset\.theme\s*=\s*['"]system['"]/.test(src))
    err('options/options.js: 把 "system" 直接写入 dataset.theme（应经 applyTheme 解析）');
  if (/(?:theme\s*=|data-theme)[^\n]*['"]system['"]/.test(src) && !/applyTheme/.test(src))
    warn('options/options.js: 处理 theme 但未使用 applyTheme()');
  else ok('主题切换经 applyTheme() 解析 system');
}

/* ---------------- 9. popup 不得用视口相对尺寸约束自身宽度 ---------------- */
{
  // 回归防护：曾经在 popup.css 末尾写了 `html, body { max-width: 100vw }`，
  // 导致 popup 在真实打开时塌缩成一条竖缝（内容宽度依赖视口 → 死循环）。
  // 扩展 popup 的宽度由浏览器测量文档内容决定，绝不能反过来依赖视口。
  const files = ['popup/popup.css', 'options/options.css'];
  let bad = 0;
  for (const f of files) {
    if (!(await exists(f))) continue;
    const css = await read(f);
    // 去掉注释后再扫描，避免误报本意说明性注释
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleRe = /(?:^|\n)\s*([^{}@\/]+?)\s*\{([^{}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(stripped))) {
      const sel = m[1].trim();
      // 只关心直接作用于根容器（html / body / :root）的规则
      if (!/(?:^|,)\s*(?:html|body|:root)\s*(?:,|$)/.test(sel)) continue;
      const decls = m[2];
      // 视口相关的宽度约束（popup 场景下会形成循环依赖）
      const vwDecl = decls.match(/(?:^|;)\s*(?:max-width|min-width|width)\s*:\s*[^;]*\b100?v[wh]\b/);
      if (vwDecl) {
        err(`${f}: ${sel} 用视口单位约束宽度（${vwDecl[0].trim().replace(/^;/, '')}），会让 popup 塌缩成窄条`);
        bad++;
      }
    }
  }
  if (!bad) ok('popup/options 根容器未用视口单位约束宽度');
}

/* ---------------- 10. 用到的 chrome.* API 必须有对应权限声明 ---------------- */
{
  // 回归防护：曾经 background.js 调了 chrome.offscreen.createDocument()，
  // 但 manifest 没声明 "offscreen" 权限 → chrome.offscreen 是 undefined，
  // 整条剪贴板路径静默降级。这类「API 用到但权限没声明」的错必须静态拦住。
  const manifest = JSON.parse(await read('manifest.json'));
  const perms = new Set([...(manifest.permissions || []), ...(manifest.optional_permissions || [])]);
  // API 命名空间 → 需要声明的权限（仅列 chrome 要求显式声明的）
  const NEEDS_PERM = {
    offscreen: 'offscreen',
    downloads: 'downloads',
    contextMenus: 'contextMenus',
    notifications: 'notifications',
    scripting: 'scripting',
    storage: 'storage',
    cookies: 'cookies',
    webRequest: 'webRequest',
    alarms: 'alarms',
    idle: 'idle',
    identity: 'identity',
    bookmarks: 'bookmarks',
    history: 'history',
    management: 'management',
    sessions: 'sessions',
    topSites: 'topSites'
  };
  // tabs 是特例：tabs.create/remove/update/sendMessage/query 都**不需要** tabs 权限；
  // 只有读取 url/title/favIconUrl 等敏感字段才需要，而本扩展用
  // activeTab + host_permissions(<all_urls>) 已满足，故不列入强制检查。
  const FREE = new Set(['runtime', 'i18n', 'extension', 'windows', 'action', 'browserAction', 'tabs']);

  const files = [
    'background.js',
    'popup/popup.js',
    'options/options.js',
    'content/scanner.js',
    'lib/messaging.js',
    'lib/settings.js',
    'offscreen/offscreen.js'
  ];
  const missing = new Map();
  for (const f of files) {
    if (!(await exists(f))) continue;
    const src = await read(f);
    // 去注释，避免注释里提到 API 名造成误报
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const m of code.matchAll(/\bchrome\.([a-zA-Z]+)\b/g)) {
      const ns = m[1];
      if (FREE.has(ns) || !NEEDS_PERM[ns]) continue;
      const need = NEEDS_PERM[ns];
      if (perms.has(need)) continue;
      if (!missing.has(need)) missing.set(need, new Set());
      missing.get(need).add(f);
    }
  }
  if (missing.size) {
    for (const [perm, where] of missing) {
      const ns = Object.keys(NEEDS_PERM).find((k) => NEEDS_PERM[k] === perm);
      err(
        `manifest.json 缺少 "${perm}" 权限，但 ${[...where].join(', ')} 调用了 chrome.${ns}.*` +
          '（该 API 运行时会变成 undefined，功能静默失效）'
      );
    }
  } else {
    ok('chrome.* API 与 manifest 权限声明一致');
  }
}

/* ---------------- 报告 ---------------- */const B = (s) => `\x1b[1m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const YEL = (s) => `\x1b[33m${s}\x1b[0m`;
const GRN = (s) => `\x1b[32m${s}\x1b[0m`;

console.log(B('\n=== edge-resource-download 结构巡检 ===\n'));
if (warnings.length) {
  console.log(YEL(`— 警告 ${warnings.length} 条 —`));
  warnings.forEach((w) => console.log(YEL(`  ⚠ ${w}`)));
  console.log('');
}
if (errors.length) {
  console.log(RED(`— 错误 ${errors.length} 条 —`));
  errors.forEach((e) => console.log(RED(`  ✖ ${e}`)));
  console.log('');
}
console.log(GRN(`通过项 ${oks.length} 条`));
if (process.argv.includes('--verbose')) oks.forEach((o) => console.log(`  ✓ ${o}`));
console.log('');

if (errors.length) {
  console.log(RED(`巡检失败：${errors.length} 个错误\n`));
  process.exit(1);
}
console.log(GRN('巡检通过 ✔\n'));
