/**
 * @file offscreen/offscreen.js
 * 仅接收来自 background 的剪贴板写入请求。
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type !== 'copy') {
    sendResponse({ ok: false, error: '未知请求' });
    return false;
  }
  (async () => {
    try {
      const text = String(msg.text ?? '');
      // 首选 execCommand('copy')：offscreen 文档**永远没有焦点**，
      // navigator.clipboard.writeText() 在这种文档里必然抛
      // "Document is not focused"，所以它只能作为最后兜底，不能当主路径。
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.width = '1px';
      ta.style.height = '1px';
      ta.style.padding = '0';
      ta.style.border = 'none';
      ta.style.outline = 'none';
      ta.style.boxShadow = 'none';
      ta.style.background = 'transparent';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      // 用 focus + select 而不是只用 select，提高 execCommand 成功率
      ta.focus({ preventScroll: true });
      ta.select();
      ta.setSelectionRange(0, text.length);
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      if (ok) return sendResponse({ ok: true });

      // 兜底：绝大多数情况下这里会因文档无焦点而失败，
      // 保留是为了在极少数有焦点的场景（如 offscreen 文档被激活）仍能工作。
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return sendResponse({ ok: true });
        } catch (e) {
          return sendResponse({
            ok: false,
            error: `剪贴板写入被拒绝（${String(e?.message || e)}）`
          });
        }
      }
      sendResponse({ ok: false, error: '当前环境不支持剪贴板写入' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
