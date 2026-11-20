/**
 * @file tests/lib/browser.mjs
 * @module ERD/test/browser
 *
 * 测试用浏览器进程的生命周期管理。
 *
 * ⚠️ 血泪教训：**绝对不要用 `proc.kill()` 直接强杀浏览器进程**。
 * `SIGTERM`/`TerminateProcess` 会跳过 Chromium 的窗口销毁流程，
 * 留下大量 **DWM 幽灵窗口**：Alt+Tab 里看得见、白屏、点不进去、
 * 没有任务栏按钮、`EnumWindows` 也枚举不到（因为进程已死）。
 * 用户视角就是「一堆关不掉的资源下载器窗口」。
 *
 * 正确顺序：
 *   1) CDP `Browser.close`（优雅退出，走正常 shutdown）
 *   2) 等待进程 exit（默认 5s）
 *   3) 仍存活才 kill
 */

/**
 * 优雅关闭一个由 CDP 控制的浏览器进程。
 * @param {object} opts
 * @param {import('node:child_process').ChildProcess} opts.proc  子进程
 * @param {{send:(m:string,p?:object)=>Promise<any>}} [opts.cdp]  CDP 客户端（有则优先用 Browser.close）
 * @param {number} [opts.timeout]  等待退出毫秒数
 * @param {string} [opts.label]    日志前缀
 * @returns {Promise<boolean>} 是否在超时前正常退出
 */
export async function shutdownBrowser({ proc, cdp, timeout = 6000, label = '[test]' }) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return true;

  let exited = false;
  const onExit = () => {
    exited = true;
  };
  proc.once('exit', onExit);

  // 1) 优雅退出
  if (cdp) {
    try {
      await cdp.send('Browser.close', {});
    } catch {
      /* 有些目标不支持，继续 */
    }
  }

  // 2) 等它自己退
  const waited = await waitExit(proc, timeout);
  if (waited) return true;

  // 3) 兜底：先温和后强杀
  try {
    proc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  if (await waitExit(proc, 2500)) return true;

  try {
    proc.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  const ok = await waitExit(proc, 2500);
  if (!ok) console.warn(`${label} 进程 ${proc.pid} 未能退出，可能残留窗口`);
  return ok;
}

const waitExit = (proc, ms) => {
  if (proc.exitCode !== null || proc.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.removeListener('exit', onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(t);
      resolve(true);
    };
    proc.once('exit', onExit);
  });
};
