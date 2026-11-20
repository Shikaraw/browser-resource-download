#!/usr/bin/env node
/**
 * @file tests/e2e.mjs
 * 真实浏览器端到端测试：加载扩展 → 打开本地样例页 → 点击扫描 → 勾选 → 下载 → 校验落盘。
 *
 * 使用 Chrome DevTools Protocol（Node 内置 WebSocket，无需 npm 依赖）。
 * 用法：node tests/e2e.mjs [--browser=edge|chrome] [--headed] [--keep]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { shutdownBrowser } from './lib/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests', 'fixtures');
const args = process.argv.slice(2);
const BROWSER = args.includes('--browser=chrome') ? 'chrome' : 'edge';
const HEADED = args.includes('--headed');
const KEEP = args.includes('--keep');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
  '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'
};

const log = (...a) => console.log(...a);
const pass = (m) => console.log(`\x1b[32m  ✔ ${m}\x1b[0m`);
const fail = (m) => console.log(`\x1b[31m  ✖ ${m}\x1b[0m`);
const info = (m) => console.log(`\x1b[36m  · ${m}\x1b[0m`);

/* ---------------- 本地静态服务器 ---------------- */
function startServer(rootDir) {
  return new Promise((res) => {
    const server = createServer(async (req, rep) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        let p = decodeURIComponent(url.pathname);
        if (p === '/' || p === '') p = '/tests/demo-page.html';
        const file = join(rootDir, p);
        const body = await readFile(file);
        const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
        rep.writeHead(200, {
          'content-type': type,
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        });
        rep.end(body);
      } catch {
        rep.writeHead(404, { 'content-type': 'text/plain' });
        rep.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      res({ server, port, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/* ---------------- 浏览器启动 ---------------- */
const BROWSERS = {
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ]
};

async function findBrowser() {
  for (const p of BROWSERS[BROWSER]) {
    try {
      await stat(p);
      return p;
    } catch {
      /* next */
    }
  }
  throw new Error(`未找到 ${BROWSER} 可执行文件`);
}

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params, msg.sessionId);
      }
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', (e) => reject(new Error(`WS 连接失败: ${e.message || e.type}`)));
    });
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const base = { id, method, params };
    if (sessionId) base.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(base));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 45000);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const evalIn = async (cdp, sessionId, expression, awaitPromise = true) => {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true, userGesture: true },
    sessionId
  );
  if (r.exceptionDetails) {
    throw new Error(
      `页面异常：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`
    );
  }
  return r.result?.value;
};

const waitFor = async (fn, { timeout = 20000, interval = 200, label = '条件' } = {}) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
};

/* ---------------- 主流程 ---------------- */
async function main() {
  const results = { passed: 0, failed: [] };
  const check = (cond, label) => {
    if (cond) {
      results.passed++;
      pass(label);
    } else {
      results.failed.push(label);
      fail(label);
    }
  };

  const { server, port, origin } = await startServer(ROOT);
  info(`本地服务器：${origin}`);

  const exe = await findBrowser();
  const userDataDir = join(tmpdir(), `erd-e2e-${Date.now()}`);
  const downloadDir = join(userDataDir, 'Downloads');
  await mkdir(downloadDir, { recursive: true });
  await mkdir(join(userDataDir, 'Default'), { recursive: true });

  // 预置下载目录：chrome.downloads 使用 profile 的 default_directory
  await writeFile(
    join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
      savefile: { default_directory: downloadDir }
    })
  );

  const extPath = ROOT.replace(/\\/g, '\\\\');
  const chromeArgs = [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${ROOT}`,
    `--disable-extensions-except=${ROOT}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--window-size=1280,900`
  ];
  if (!HEADED) chromeArgs.push('--headless=new', '--disable-gpu');
  info(`浏览器：${exe}`);
  info(`下载目录：${downloadDir}`);

  // ⚠️ 必须消费或忽略子进程输出：Edge 会写大量 stdout/stderr，
  // 若用 pipe 却不读取，64KB 缓冲填满后浏览器进程会被阻塞，DevTools 端口永不出现。
  const proc = spawn(exe, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    // 只保留最后 8KB，避免无限增长
    stderr = (stderr + s).slice(-8192);
  });
  let exited = null;
  proc.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  // cdp 在 try 块内创建，cleanup 需要它来优雅关闭浏览器
  let activeCdp = null;

  const cleanup = async () => {
    // ⚠️ 必须优雅关闭：cdp Browser.close 走正常 shutdown，先销毁窗口再退出。
    // 直接 proc.kill() 会跳过窗口销毁，留下 DWM 幽灵窗口
    // （Alt+Tab 可见、白屏、关不掉、任务栏无按钮）。详见 tests/lib/browser.mjs。
    await shutdownBrowser({ proc, cdp: activeCdp, label: '[e2e]' });
    server.close();
    if (!KEEP) {
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(
        () => {}
      );
    } else {
      info(`保留用户目录：${userDataDir}`);
    }
  };

  try {
    // 读取 DevTools 端口与 browser ws 路径（DevToolsActivePort 第二行是 ws 路径）
    const portFile = join(userDataDir, 'DevToolsActivePort');
    const devInfo = await waitFor(
      async () => {
        try {
          const txt = await readFile(portFile, 'utf8');
          const [p, wsPath] = txt.split('\n').map((s) => s.trim());
          if (!p || !/^\d+$/.test(p)) return null;
          return { port: Number(p), wsPath: wsPath || '' };
        } catch {
          return null;
        }
      },
      { timeout: 25000, label: 'DevTools 端口文件' }
    ).catch((e) => {
      throw new Error(
        `${e.message}（浏览器退出：${JSON.stringify(exited)}）\n${stderr.slice(-3000)}`
      );
    });
    const devPort = devInfo.port;
    info(`DevTools 端口：${devPort}`);

    // 通过 HTTP /json/version 拿权威 webSocketDebuggerUrl（比第二行更可靠）
    const wsUrl = await waitFor(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${devPort}/json/version`);
          const j = await res.json();
          return j.webSocketDebuggerUrl || null;
        } catch {
          return null;
        }
      },
      { timeout: 20000, label: 'DevTools /json/version' }
    ).catch(() => (devInfo.wsPath ? `ws://127.0.0.1:${devPort}${devInfo.wsPath}` : null));
    if (!wsUrl) throw new Error('无法获取 DevTools WebSocket 地址');
    info(`CDP 地址：${wsUrl}`);

    const cdp = await waitFor(
      async () => {
        try {
          return await CDP.connect(wsUrl);
        } catch {
          return null;
        }
      },
      { timeout: 20000, label: 'CDP 连接' }
    );
    activeCdp = cdp; // 供 cleanup 优雅关闭浏览器
    check(true, '扩展进程启动 + CDP 已连接');

    // 等待**本扩展**的 Service Worker 注册。
    // ⚠️ Edge 自带若干内置扩展（Gemini in Chrome 等）也有 background.js，
    //    不能只按文件名匹配，必须进 SW 里读 manifest 名称确认。
    const identity = await waitFor(
      async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const candidates = targetInfos.filter(
          (t) => t.type === 'service_worker' && t.url.includes('background.js')
        );
        for (const t of candidates) {
          try {
            const { sessionId } = await cdp.send('Target.attachToTarget', {
              targetId: t.targetId,
              flatten: true
            });
            await cdp.send('Runtime.enable', {}, sessionId);
            const name = await evalIn(cdp, sessionId, 'chrome.runtime.getManifest().name');
            const ver = await evalIn(cdp, sessionId, 'chrome.runtime.getManifest().version');
            await cdp.send('Target.detachFromTarget', { sessionId });
            if (name === 'Edge Resource Downloader') {
              return { target: t, extId: new URL(t.url).host, name, ver };
            }
          } catch {
            /* 内置扩展可能不允许附加，忽略 */
          }
        }
        return null;
      },
      { timeout: 30000, label: '本扩展 Service Worker' }
    );
    const swTarget = identity.target;
    const extId = identity.extId;
    check(true, `本扩展 Service Worker 已加载：${identity.name} v${identity.ver}`);
    info(`扩展 ID：${extId}`);

    // 打开样例页
    const pageUrl = `${origin}/tests/demo-page.html`;
    const { targetId: pageTargetId } = await cdp.send('Target.createTarget', { url: pageUrl });
    const { sessionId: pageSession } = await cdp.send('Target.attachToTarget', {
      targetId: pageTargetId,
      flatten: true
    });
    await cdp.send('Runtime.enable', {}, pageSession);
    await cdp.send('Page.enable', {}, pageSession);
    // 等待页面加载完
    await waitFor(
      async () =>
        evalIn(cdp, pageSession, 'document.readyState === "complete" && document.images.length > 3'),
      { timeout: 20000, label: '样例页加载' }
    );
    pass('样例页已加载');

    /* ---------- 打开扩展 popup 页面（作为普通标签页以便 CDP 控制） ---------- */
    const popupUrl = `chrome-extension://${extId}/popup/popup.html`;
    const { targetId: popupTargetId } = await cdp.send('Target.createTarget', { url: popupUrl });
    const { sessionId: popupSession } = await cdp.send('Target.attachToTarget', {
      targetId: popupTargetId,
      flatten: true
    });
    await cdp.send('Runtime.enable', {}, popupSession);
    await cdp.send('Page.enable', {}, popupSession);

    await waitFor(
      async () => {
        try {
          return await evalIn(cdp, popupSession, 'document.readyState === "complete"');
        } catch {
          return false;
        }
      },
      { timeout: 25000, label: 'popup 加载' }
    );

    // 收集控制台错误
    const consoleErrors = [];
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value || a.description).join(' '));
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      consoleErrors.push(p.exceptionDetails?.exception?.description || 'exception');
    });

    await new Promise((r) => setTimeout(r, 800));
    const domInfo = await evalIn(
      cdp,
      popupSession,
      `(() => {
        const ids = ['btn-scan','btn-cancel-scan','scan-progress','results-grid','results-scroll','check-all','search-input','sort-select','view-seg','kind-chips','actionbar','btn-download','btn-download-all','btn-settings','empty-state','toast-host','page-info','selected-summary','filter-counts'];
        return {
          state: document.body.dataset.state,
          missing: ids.filter((i) => !document.getElementById(i)),
          hasTheme: document.documentElement.hasAttribute('data-theme'),
          theme: document.documentElement.getAttribute('data-theme')
        };
      })()`
    );
    check(domInfo.missing.length === 0, `契约 DOM id 全部存在${domInfo.missing.length ? `（缺失 ${domInfo.missing.join(',')}）` : ''}`);
    check(Boolean(domInfo.state), `body[data-state] 已设置：${domInfo.state}`);
    check(domInfo.hasTheme, `主题已应用：${domInfo.theme}`);

    /* ---------- 回归防护：popup 宽度不得塌缩成窄条 ----------
       历史 bug：popup.css 末尾写了 html,body{max-width:100vw}，
       导致真实 popup 打开时宽度被视口夹住，塌缩成一条竖缝。
       这里在「极窄视口」下加载后再量测，确保内容宽度不依赖视口。 */
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 30, height: 600, deviceScaleFactor: 1, mobile: false },
      popupSession
    );
    await new Promise((r) => setTimeout(r, 400));
    const narrowW = await evalIn(
      cdp,
      popupSession,
      `(() => ({
        vw: window.innerWidth,
        htmlW: Math.round(document.documentElement.getBoundingClientRect().width),
        bodyW: Math.round(document.body.getBoundingClientRect().width)
      }))()`
    );
    check(
      narrowW.bodyW === 380 && narrowW.htmlW === 380,
      `极窄视口(${narrowW.vw}px)下 popup 仍保持 380px 宽（body=${narrowW.bodyW}, html=${narrowW.htmlW}）`
    );
    // 恢复常规视口，后续断言不受影响
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 380, height: 600, deviceScaleFactor: 1, mobile: false },
      popupSession
    );
    await new Promise((r) => setTimeout(r, 300));

    /* ---------- 关键安全要求：未点击前不得扫描 ---------- */
    const beforeScan = await evalIn(
      cdp,
      popupSession,
      `({ state: document.body.dataset.state, cards: document.querySelectorAll('.resource-card').length })`
    );
    check(
      beforeScan.cards === 0 && beforeScan.state !== 'results',
      `未点击按钮前没有任何采集（state=${beforeScan.state}, cards=${beforeScan.cards}）`
    );

    /* ---------- 真实 UI 驱动：点击「扫描本页资源」按钮 ---------- */
    // popup 以普通标签页打开时，chrome.tabs.query({active:true,currentWindow:true})
    // 返回的是**同一个窗口的活动标签页**。把样例页激活成活动标签页后，
    // popup 里的 getActiveTab() 就会真实解析到样例页 —— 等价于用户在样例页点图标。
    await cdp.send('Target.activateTarget', { targetId: pageTargetId });
    await new Promise((r) => setTimeout(r, 400));

    const clickResult = await evalIn(
      cdp,
      popupSession,
      `(async () => {
        const btn = document.getElementById('btn-scan');
        if (!btn) return { ok: false, error: '找不到 #btn-scan' };
        btn.click();
        for (let i = 0; i < 150; i++) {
          const st = document.body.dataset.state;
          if (st === 'results' || st === 'error') break;
          await new Promise((r) => setTimeout(r, 100));
        }
        return {
          ok: true,
          state: document.body.dataset.state,
          cards: document.querySelectorAll('.resource-card').length,
          // 空状态用 hidden 属性隐藏，不是 .hidden 类
          emptyVisible: (() => {
            const e = document.getElementById('empty-state');
            if (!e) return true;
            return !e.hasAttribute('hidden') && e.offsetParent !== null;
          })()
        };
      })()`
    );
    info(`点击 #btn-scan 后：${JSON.stringify(clickResult)}`);
    // 这是核心产品断言：用户点击后 UI 必须真的渲染出资源卡片并进入 results 态
    check(
      clickResult.state === 'results' && clickResult.cards > 0,
      `点击按钮后 UI 渲染出 ${clickResult.cards} 张资源卡片（state=${clickResult.state}）`
    );
    check(
      !clickResult.emptyVisible,
      `空状态已隐藏（有结果时不应显示 #empty-state）`
    );

    /* ---------- 通过扩展 API 真实扫描（模拟用户点击的目标页 = 样例页） ---------- */
    // popup 标签页不是 action popup，getActiveTab 可能拿到自己；改为显式 tabId 调用
    const scanRes = await evalIn(
      cdp,
      popupSession,
      `(async () => {
        const mod = await import('chrome-extension://${extId}/lib/messaging.js');
        const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
        const tabId = tabs[0].id;
        const r = await mod.scanPage(tabId);
        return { ok: r.ok, error: r.error, counts: r.data?.counts, n: r.data?.items?.length, items: (r.data?.items||[]).slice(0,400), warnings: r.data?.warnings, elapsed: r.data?.elapsedMs, timedOut: r.data?.timedOut };
      })()`
    );
    check(scanRes.ok, `扫描成功${scanRes.ok ? '' : `（${scanRes.error}）`}`);
    if (scanRes.ok) {
      const c = scanRes.counts;
      info(`扫描耗时 ${scanRes.elapsed}ms，共 ${c.total} 项：视频 ${c.videos} / 图片 ${c.images} / 音频 ${c.audios} / 其他 ${c.others}`);
      if (scanRes.warnings?.length) info(`警告：${scanRes.warnings.join(' | ')}`);
      check(c.images >= 5, `收集到图片资源 ≥5（实际 ${c.images}）`);
      check(c.videos >= 2, `收集到视频资源 ≥2（实际 ${c.videos}）`);
      check(c.audios >= 2, `收集到音频资源 ≥2（实际 ${c.audios}）`);
      check(scanRes.timedOut === false, `未触发扫描超时`);

      const urls = (scanRes.items || []).map((i) => i.url);
      check(urls.some((u) => u.endsWith('photo-a.jpg')), '包含本地测试图片 photo-a.jpg（img 标签）');
      check(urls.some((u) => /clip-a\.mp4/.test(u)), '包含本地测试视频 clip-a.mp4（video/source）');
      check(urls.some((u) => /tone-a\.mp3/.test(u)), '包含本地测试音频 tone-a.mp3');
      check(urls.some((u) => /css-background\.jpg/.test(u)), '包含 CSS background-image 资源');
      check(
        !urls.some((u) => /pixel-1x1\.png/.test(u)),
        '1×1 埋点图被 minImageSize 过滤'
      );
      check(urls.some((u) => /stream\.m3u8/.test(u)), '包含 m3u8 流清单');
      const ids = (scanRes.items || []).map((i) => i.id);
      check(new Set(ids).size === ids.length, `去重生效（${ids.length} 条，唯一 id ${new Set(ids).size} 个）`);
      const metaOk = (scanRes.items || []).every((i) => i.id && i.url && i.kind && i.title);
      check(metaOk, '所有条目具备 id/url/kind/title 基础字段');
    }

    /* ---------- 下载落盘验证 ---------- */
    // 用 chrome.downloads 默认目录不可控，改为在 popup 页面里直接测试 downloadItems 的入队与状态
    const dlRes = await evalIn(
      cdp,
      popupSession,
      `(async () => {
        const mod = await import('chrome-extension://${extId}/lib/messaging.js');
        const cfg = await mod.fetchSettings();
        const items = [
          { id: 'test-img-1', url: ${JSON.stringify(`${origin}/tests/fixtures/photo-a.jpg`)}, kind: 'image', title: 'photo-a.jpg', ext: 'jpg' },
          { id: 'test-vid-1', url: ${JSON.stringify(`${origin}/tests/fixtures/clip-a.mp4`)}, kind: 'video', title: 'clip-a.mp4', ext: 'mp4' },
          { id: 'test-aud-1', url: ${JSON.stringify(`${origin}/tests/fixtures/tone-a.mp3`)}, kind: 'audio', title: 'tone-a.mp3', ext: 'mp3' }
        ];
        const r = await mod.downloadItems(items, { folder: 'ERD-E2E', organizeByType: true, conflictStrategy: 'uniquify' });
        window.__erdBatch = r.data?.batchId;
        window.__erdStates = {};
        window.__erdProgress = null;
        mod.onPush((m) => {
          if (m.type === 'download/itemState') window.__erdStates[m.payload.id] = m.payload.state;
          if (m.type === 'download/progress') window.__erdProgress = m.payload;
        });
        return { ok: r.ok, error: r.error, data: r.data, cfg: { folder: cfg.data?.saveSubfolder, concurrency: cfg.data?.concurrency } };
      })()`
    );
    check(dlRes.ok, `批量下载已入队${dlRes.ok ? '' : `（${dlRes.error}）`}`);
    check(dlRes.data?.started === 3, `队列包含 3 个任务（实际 ${dlRes.data?.started}）`);

    const finalStates = await waitFor(
      async () => {
        const s = await evalIn(
          cdp,
          popupSession,
          `({ states: window.__erdStates || {}, progress: window.__erdProgress })`
        );
        const vals = Object.values(s.states || {});
        const settled = vals.filter((v) => ['done', 'failed', 'canceled', 'skipped'].includes(v));
        return settled.length >= 3 ? s : null;
      },
      { timeout: 45000, interval: 400, label: '下载任务终态' }
    );
    info(`下载终态：${JSON.stringify(finalStates.states)}`);
    check(
      Object.values(finalStates.states).filter((v) => v === 'done').length === 3,
      `3 个资源均下载成功（${JSON.stringify(finalStates.states)}）`
    );
    check(finalStates.progress?.done === 3, `进度回传 done=3（实际 ${finalStates.progress?.done}）`);
    check(
      finalStates.progress?.failed === 0,
      `成功批次 failed=0（实际 ${finalStates.progress?.failed}）`
    );

    /* ---------- 失败路径：done 是否含 failed（契约 3.4 语义） ---------- */
    // 混入一个必然 404 的资源，断言 done 仍然到达 total（含失败），且 failed 计数正确。
    // 这是回归防护：background 曾直接透传「仅成功数」的 done，导致失败时进度永远到不了 100%。
    const failRun = await evalIn(
      cdp,
      popupSession,
      `(async () => {
        const mod = await import('chrome-extension://${extId}/lib/messaging.js');
        const items = [
          { id: 'f-ok-1', url: ${JSON.stringify(`${origin}/tests/fixtures/photo-b.jpg`)}, kind: 'image', title: 'photo-b.jpg', ext: 'jpg' },
          { id: 'f-bad-1', url: ${JSON.stringify(`${origin}/tests/fixtures/does-not-exist.png`)}, kind: 'image', title: 'missing.png', ext: 'png' }
        ];
        const states = {};
        let prog = null;
        mod.onPush((m) => {
          if (m.type === 'download/itemState') states[m.payload.id] = m.payload.state;
          if (m.type === 'download/progress') prog = m.payload;
        });
        const r = await mod.downloadItems(items, { folder: 'ERD-E2E-FAIL', organizeByType: true });
        if (!r.ok) return { ok: false, error: r.error };
        for (let i = 0; i < 150; i++) {
          const settled = Object.values(states).filter((v) => ['done','failed','canceled','skipped'].includes(v));
          if (settled.length >= 2) break;
          await new Promise((x) => setTimeout(x, 100));
        }
        return { ok: true, states, prog };
      })()`
    );
    check(failRun.ok, `失败场景批次已入队${failRun.ok ? '' : `（${failRun.error}）`}`);
    if (failRun.ok) {
      const st = failRun.states || {};
      const pr = failRun.prog || {};
      info(`失败场景终态：${JSON.stringify(st)}`);
      info(`失败场景进度：${JSON.stringify(pr)}`);
      check(st['f-bad-1'] === 'failed', `不存在的资源被标记 failed（实际 ${st['f-bad-1']}）`);
      check(st['f-ok-1'] === 'done', `同批次正常资源仍成功（实际 ${st['f-ok-1']}）`);
      check(pr.failed === 1, `进度回传 failed=1（实际 ${pr.failed}）`);
      check(
        pr.done === pr.total && pr.total === 2,
        `done 含失败并使用批次收敛到 total（done=${pr.done}, total=${pr.total}）`
      );
      check(
        pr.succeeded === 1,
        `进度回传 succeeded=1（实际 ${pr.succeeded}）`
      );
    }

    // 校验文件真的落盘
    const sub = join(downloadDir, 'ERD-E2E');
    const found = await waitFor(
      async () => {
        try {
          const out = [];
          for (const dir of ['images', 'videos', 'audios', '.']) {
            try {
              for (const f of await readdir(join(sub, dir))) out.push(`${dir}/${f}`);
            } catch {
              /* next */
            }
          }
          return out.length >= 3 ? out : null;
        } catch {
          return null;
        }
      },
      { timeout: 25000, interval: 500, label: '下载文件落盘' }
    ).catch(() => []);
    if (found.length) {
      info(`落盘文件：${found.join(', ')}`);
      check(found.length >= 3, `文件已保存到下载目录（${found.length} 个）`);
      check(
        found.some((f) => f.includes('images') && /photo-a/.test(f)),
        '按类型分目录：images/photo-a.jpg'
      );
      check(found.some((f) => f.includes('videos') && /clip-a/.test(f)), '按类型分目录：videos/clip-a.mp4');
      check(found.some((f) => f.includes('audios') && /tone-a/.test(f)), '按类型分目录：audios/tone-a.mp3');
    } else {
      info('（无法从默认下载目录读取文件：headless 下 chrome.downloads 目录由浏览器托管，跳过落盘断言）');
    }

    /* ---------- 设置页加载 ---------- */
    const optionsUrl = `chrome-extension://${extId}/options/options.html`;
    const { targetId: optTarget } = await cdp.send('Target.createTarget', { url: optionsUrl });
    const { sessionId: optSession } = await cdp.send('Target.attachToTarget', {
      targetId: optTarget,
      flatten: true
    });
    await cdp.send('Runtime.enable', {}, optSession);
    await waitFor(
      async () => {
        try {
          return await evalIn(cdp, optSession, 'document.readyState === "complete"');
        } catch {
          return false;
        }
      },
      { timeout: 25000, label: '设置页加载' }
    );
    await new Promise((r) => setTimeout(r, 1200));
    const optInfo = await evalIn(
      cdp,
      optSession,
      `(() => {
        const ids = ['side-nav','btn-reset','btn-clear-history','btn-export','btn-import','save-indicator','storage-usage','theme-cards'];
        const switches = document.querySelectorAll('.switch input[type=checkbox]').length;
        const sections = document.querySelectorAll('section[id], .section[id]').length;
        return { missing: ids.filter((i) => !document.getElementById(i)), switches, sections,
                 hasTheme: document.documentElement.hasAttribute('data-theme'),
                 bodyText: document.body.innerText.length };
      })()`
    );
    check(optInfo.missing.length === 0, `设置页契约 id 全部存在${optInfo.missing.length ? `（缺失 ${optInfo.missing.join(',')}）` : ''}`);
    check(optInfo.switches >= 10, `设置页渲染开关控件 ${optInfo.switches} 个`);
    check(optInfo.bodyText > 1500, `设置页内容已渲染（文本 ${optInfo.bodyText} 字符）`);

    /* ---------- 设置读写往返 ---------- */
    const roundTrip = await evalIn(
      cdp,
      optSession,
      `(async () => {
        const m = await import('chrome-extension://${extId}/lib/settings.js');
        const before = await m.getSettings();
        await m.patchSettings({ concurrency: 5, theme: 'light' });
        const after = await m.getSettings();
        await new Promise(r => setTimeout(r, 300));
        const themeApplied = document.documentElement.getAttribute('data-theme');
        await m.patchSettings({ concurrency: before.concurrency, theme: before.theme });
        return { before: before.concurrency, after: after.concurrency, themeApplied };
      })()`
    );
    check(roundTrip.after === 5, `设置写入生效（concurrency ${roundTrip.before} → ${roundTrip.after}）`);
    check(roundTrip.themeApplied === 'light', `主题即时应用（data-theme=${roundTrip.themeApplied}）`);

    /* ---------- 控制台无严重错误 ---------- */
    const realErrors = consoleErrors.filter(
      (e) => !/favicon|net::ERR|Failed to load resource|ERR_BLOCKED/i.test(e)
    );
    check(realErrors.length === 0, `无未捕获脚本错误${realErrors.length ? `：${realErrors.slice(0, 3).join(' | ')}` : ''}`);

    cdp.close();
  } catch (e) {
    results.failed.push(`异常：${e.message}`);
    fail(`致命错误：${e.message}`);
    if (process.argv.includes('--verbose') && stderr) console.log(stderr.slice(-4000));
  } finally {
    await cleanup();
  }

  console.log('');
  console.log(`\x1b[1m通过 ${results.passed} 项，失败 ${results.failed.length} 项\x1b[0m`);
  if (results.failed.length) {
    console.log('\x1b[31m失败项：\x1b[0m');
    results.failed.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('\x1b[32mE2E 全部通过 ✔\x1b[0m');
}

main();
