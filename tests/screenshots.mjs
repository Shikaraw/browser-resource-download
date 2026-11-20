#!/usr/bin/env node
/**
 * @file tests/screenshots.mjs
 * 通过真实扩展上下文给 popup / options 各状态截图（mock 模式）。
 * file:// 下 ES module 动态 import 会被 CORS 阻断，mock 必须跑在扩展页里。
 *
 * 用法：node tests/screenshots.mjs [--browser=chrome]
 * 输出：docs/screenshots/*.png
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdownBrowser } from './lib/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const BROWSER = process.argv.includes('--browser=chrome') ? 'chrome' : 'edge';

const EXE = {
  edge: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  chrome: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
}[BROWSER][0];

const SHOTS = [
  // popup：380x600
  ['popup-idle.png', 'popup/popup.html?mock=1', 380, 600],
  ['popup-scanning.png', 'popup/popup.html?mock=1&state=scanning', 380, 600],
  ['popup-results-grid.png', 'popup/popup.html?mock=1&state=results', 380, 600],
  ['popup-results-grid-selected.png', 'popup/popup.html?mock=1&state=results&selected=4', 380, 600],
  ['popup-results-list.png', 'popup/popup.html?mock=1&state=results&view=list', 380, 600],
  ['popup-downloading.png', 'popup/popup.html?mock=1&state=downloading', 380, 600],
  ['popup-error.png', 'popup/popup.html?mock=1&state=error', 380, 600],
  ['popup-results-light.png', 'popup/popup.html?mock=1&state=results&theme=light', 380, 600],
  // options：1280 宽
  ['options-dark.png', 'options/options.html', 1280, 1000],
  ['options-dark-full.png', 'options/options.html', 1280, 2600],
  ['options-light.png', 'options/options.html#appearance', 1280, 1000]
];

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', () => reject(new Error('ws fail')));
    });
  }
  send(method, params = {}, sessionId) {
    const i = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(i, { res, rej });
      this.ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.has(i)) {
          this.pending.delete(i);
          rej(new Error(`timeout ${method}`));
        }
      }, 40000);
    });
  }
}

const waitFor = async (fn, ms = 20000, label = '') => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`超时: ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), 'erd-shots-'));
  await mkdir(join(dir, 'Default'), { recursive: true });
  await writeFile(
    join(dir, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: join(dir, 'Downloads'), prompt_for_download: false } })
  );

  // cdp 在 try 块内创建，finally 需要它来优雅关闭浏览器
  let activeCdp = null;

  const proc = spawn(
    EXE,
    [
      `--user-data-dir=${dir}`,
      `--load-extension=${ROOT}`,
      `--disable-extensions-except=${ROOT}`,
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      '--disable-gpu',
      '--force-device-scale-factor=2',
      '--hide-scrollbars'
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );

  try {
    const { port } = await waitFor(async () => {
      try {
        const t = await readFile(join(dir, 'DevToolsActivePort'), 'utf8');
        return { port: Number(t.split('\n')[0]) };
      } catch {
        return null;
      }
    }, 25000, 'port');

    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const cdp = await CDP.connect(ver.webSocketDebuggerUrl);
    activeCdp = cdp;

    // 找本扩展 ID
    const extId = await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      for (const t of targetInfos.filter(
        (x) => x.type === 'service_worker' && x.url.includes('background.js')
      )) {
        try {
          const { sessionId } = await cdp.send('Target.attachToTarget', {
            targetId: t.targetId,
            flatten: true
          });
          await cdp.send('Runtime.enable', {}, sessionId);
          const r = await cdp.send(
            'Runtime.evaluate',
            { expression: 'chrome.runtime.getManifest().name', returnByValue: true },
            sessionId
          );
          await cdp.send('Target.detachFromTarget', { sessionId });
          if (r.result?.value === 'Edge Resource Downloader') return new URL(t.url).host;
        } catch {
          /* skip */
        }
      }
      return null;
    }, 30000, 'extId');
    console.log('扩展 ID:', extId);

    for (const [name, rel, w, h] of SHOTS) {
      const url = `chrome-extension://${extId}/${rel}`;
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: w, height: h, deviceScaleFactor: 2, mobile: false },
        sessionId
      );
      await cdp.send('Page.navigate', { url }, sessionId);
      await new Promise((r) => setTimeout(r, 1400));
      const shot = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true },
        sessionId
      );
      await writeFile(join(OUT, name), Buffer.from(shot.data, 'base64'));
      console.log('  ✔', name);
      await cdp.send('Target.closeTarget', { targetId });
    }
  } finally {
    // 优雅关闭浏览器，避免 DWM 幽灵窗口（详见 tests/lib/browser.mjs）
    await shutdownBrowser({ proc, cdp: activeCdp, label: '[shots]' });
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  }
};

main().catch((e) => {
  console.error('截图失败:', e.message);
  process.exit(1);
});
