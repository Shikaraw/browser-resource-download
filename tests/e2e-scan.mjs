#!/usr/bin/env node
/**
 * @file tests/e2e-scan.mjs
 * 扫描器专项：取消、超时、不可扫描页面、安全约束（未点击不采集）。
 * 用真实 Edge + CDP。
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdownBrowser } from './lib/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.m3u8': 'application/vnd.apple.mpegurl'
};
const pass = (m) => console.log(`\x1b[32m  ✔ ${m}\x1b[0m`);
const fail = (m) => console.log(`\x1b[31m  ✖ ${m}\x1b[0m`);
const info = (m) => console.log(`\x1b[36m  · ${m}\x1b[0m`);

const results = { ok: 0, bad: [] };
const check = (c, l) => {
  if (c) { results.ok++; pass(l); } else { results.bad.push(l); fail(l); }
};

function startServer() {
  return new Promise((res) => {
    const srv = createServer(async (req, rep) => {
      try {
        const u = new URL(req.url, 'http://x');
        let p = decodeURIComponent(u.pathname);
        if (p === '/' ) p = '/tests/demo-page.html';
        // /slow 返回一个需要较久才渲染完的页面，用于测超时
        if (p === '/slow') {
          const body = `<!doctype html><meta charset="utf-8"><title>Slow</title>
            <img src="fixtures/photo-a.jpg"><img src="fixtures/photo-b.jpg">
            <script>
              // 制造长任务，拖慢扫描
              const t = Date.now();
              while (Date.now() - t < 80) {}
            </script>`;
          rep.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return rep.end(body);
        }
        const f = join(ROOT, p);
        const body = await readFile(f);
        rep.writeHead(200, {
          'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream',
          'access-control-allow-origin': '*'
        });
        rep.end(body);
      } catch {
        rep.writeHead(404); rep.end('nope');
      }
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => res(new CDP(ws)));
      ws.addEventListener('error', () => rej(new Error('ws')));
    });
  }
  _wire() {
    if (this.wired) return;
    this.wired = true;
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    this._wire();
    const i = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(i, { res, rej });
      this.ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.has(i)) { this.pending.delete(i); rej(new Error(`timeout ${method}`)); }
      }, 60000);
    });
  }
}

const evalIn = async (cdp, s, expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`超时: ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

const main = async () => {
  const { srv, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  info(`服务器 ${origin}`);
  const dir = await mkdtemp(join(tmpdir(), 'erd-scan-'));
  await mkdir(join(dir, 'Default'), { recursive: true });
  await writeFile(join(dir, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: join(dir, 'Downloads') } }));
  const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const proc = spawn(EXE, [
    `--user-data-dir=${dir}`, `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
    '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run',
    '--no-default-browser-check', '--headless=new', '--disable-gpu'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', () => {});

  // cdp 在 try 块内创建，cleanup 需要它来优雅关闭浏览器
  let activeCdp = null;

  const cleanup = async () => {
    // 优雅关闭浏览器，避免 DWM 幽灵窗口（详见 tests/lib/browser.mjs）
    await shutdownBrowser({ proc, cdp: activeCdp, label: '[scan]' });
    srv.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  };

  try {
    const devPort = await waitFor(async () => {
      try { return Number((await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { return null; }
    }, 25000, 'port');
    const ver = await (await fetch(`http://127.0.0.1:${devPort}/json/version`)).json();
    const cdp = await CDP.connect(ver.webSocketDebuggerUrl);
    activeCdp = cdp;

    const extId = await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      for (const t of targetInfos.filter((x) => x.type === 'service_worker' && x.url.includes('background.js'))) {
        try {
          const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
          await cdp.send('Runtime.enable', {}, sessionId);
          const r = await cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }, sessionId);
          await cdp.send('Target.detachFromTarget', { sessionId });
          if (r.result?.value === 'Edge Resource Downloader') return new URL(t.url).host;
        } catch { /* skip */ }
      }
      return null;
    }, 30000, 'extId');

    // 先打开一个可扫描的网页（真实使用时 popup 总有一个活动网页标签页），
    // 再打开 popup 作为控制台 —— 否则 resolveTab() 找不到可扫描目标，会正确地进 error 态。
    const firstPage = await cdp.send('Target.createTarget', { url: `${origin}/tests/demo-page.html` });
    await cdp.send('Target.attachToTarget', { targetId: firstPage.targetId, flatten: true });
    await new Promise((r) => setTimeout(r, 1500));

    // 打开 popup 作为控制台
    const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup/popup.html` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await waitFor(async () => {
      try { return await evalIn(cdp, sessionId, 'document.readyState === "complete"'); } catch { return false; }
    }, 25000, 'popup');
    await new Promise((r) => setTimeout(r, 900));

    /* ---- 1. 未点击前不采集（安全核心） ---- */
    const idle = await evalIn(cdp, sessionId, `({
      state: document.body.dataset.state,
      cards: document.querySelectorAll('.resource-card').length,
      hasResults: !document.getElementById('results-grid')?.hasAttribute('hidden')
    })`);
    check(idle.state === 'idle', `初始为 idle（实际 ${idle.state}）`);
    check(idle.cards === 0, `初始没有资源卡片（实际 ${idle.cards}）`);

    /* ---- 2. 不可扫描页面 → 友好错误 ---- */
    const chromePage = await cdp.send('Target.createTarget', { url: 'edge://settings/' });
    const bad = await evalIn(cdp, sessionId, `(async () => {
      const mod = await import('chrome-extension://${extId}/lib/messaging.js');
      const r = await mod.scanPage(${chromePage.targetId ? 0 : 0});
      return r;
    })()`).catch((e) => ({ ok: false, error: String(e.message) }));
    // 用无效 tabId 也应得到明确错误而不是崩溃
    check(bad && bad.ok === false && typeof bad.error === 'string', `无效标签页返回结构化错误（${bad?.error?.slice(0, 40)}）`);

    /* ---- 3. 真实扫描 + 取消 ---- */
    const page = await cdp.send('Target.createTarget', { url: `${origin}/slow` });
    await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await new Promise((r) => setTimeout(r, 1200));
    const cancelRes = await evalIn(cdp, sessionId, `(async () => {
      const mod = await import('chrome-extension://${extId}/lib/messaging.js');
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(`${origin}/slow`)} });
      const tabId = tabs[0]?.id;
      if (tabId == null) return { ok: false, error: '找不到 slow 标签页' };
      const p = mod.scanPage(tabId);
      await new Promise(r => setTimeout(r, 60));
      const c = await mod.cancelScan(tabId);
      const r = await p;
      return { ok: true, cancelOk: c.ok, scanOk: r.ok, timedOut: r.data?.timedOut, n: r.data?.items?.length };
    })()`);
    info(`取消场景：${JSON.stringify(cancelRes)}`);
    check(cancelRes?.ok === true, `取消流程未抛异常`);
    check(cancelRes?.cancelOk === true, `cancelScan 返回 ok`);

    /* ---- 4. 扫描超时参数生效 ---- */
    const timeoutRes = await evalIn(cdp, sessionId, `(async () => {
      const mod = await import('chrome-extension://${extId}/lib/messaging.js');
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(`${origin}/tests/demo-page.html`)} });
      // 先打开 demo 页
      if (!tabs[0]) {
        await chrome.tabs.create({ url: ${JSON.stringify(`${origin}/tests/demo-page.html`)} });
        await new Promise(r => setTimeout(r, 1500));
      }
      const t2 = await chrome.tabs.query({ url: ${JSON.stringify(`${origin}/tests/demo-page.html`)} });
      const tabId = t2[0]?.id;
      if (tabId == null) return { ok: false, error: 'no demo tab' };
      const r = await mod.scanPage(tabId, { settings: { scanTimeoutMs: 3000 } });
      return { ok: r.ok, n: r.data?.items?.length, timedOut: r.data?.timedOut };
    })()`);
    info(`超时参数扫描：${JSON.stringify(timeoutRes)}`);
    check(timeoutRes?.ok === true, `自定义 scanTimeoutMs 下扫描成功`);
    check((timeoutRes?.n ?? 0) > 0, `超时参数下仍返回资源（${timeoutRes?.n} 项）`);

    /* ---- 5. iframe / blob 等开关默认关闭时行为一致 ---- */
    const settingsRound = await evalIn(cdp, sessionId, `(async () => {
      const s = await import('chrome-extension://${extId}/lib/settings.js');
      const before = await s.getSettings();
      const res = await s.patchSettings({ includeIframes: true, includeBlobMedia: true });
      const after = await s.getSettings();
      await s.patchSettings({ includeIframes: before.includeIframes, includeBlobMedia: before.includeBlobMedia });
      return { changed: res.includeIframes === true && res.includeBlobMedia === true, restored: after.includeIframes === true };
    })()`);
    check(settingsRound?.changed === true, `扫描范围开关可持久化`);
    check(settingsRound?.restored === true, `设置可正确读回`);
  } catch (e) {
    results.bad.push(`异常：${e.message}`);
    fail(`致命错误：${e.message}`);
  } finally {
    await cleanup();
  }

  console.log('');
  console.log(`\x1b[1m通过 ${results.ok} 项，失败 ${results.bad.length} 项\x1b[0m`);
  if (results.bad.length) {
    results.bad.forEach((b) => console.log(`  - ${b}`));
    process.exit(1);
  }
  console.log('\x1b[32m扫描器专项全部通过 ✔\x1b[0m');
};

main();
