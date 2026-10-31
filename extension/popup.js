document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('refresh');
  btn.addEventListener('click', fetchCookies);
  showStatus();
  fetchCookies();
});

function isHttpUrl(url) {
  return /^https?:/i.test(url || '');
}

async function showStatus() {
  const el = document.getElementById('status');
  try {
    const resp = await chrome.runtime.sendMessage({ cmd: 'status' });
    const data = resp?.data || {};
    if (data.ws) {
      el.textContent = '● 已连接 DSH 浏览器服务（' + (data.server || '') + '）';
      el.style.color = '#6a9955';
    } else {
      el.textContent = '○ 未连接 DSH 浏览器服务（' + (data.server || '等待服务启动') + '），服务启动后会自动重连';
      el.style.color = '#d7ba7d';
    }
  } catch (e) {
    el.textContent = '状态未知：' + e.message;
    el.style.color = '#d7ba7d';
  }
}

async function fetchCookies() {
  const out = document.getElementById('out');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) { out.textContent = '没有活动标签页'; return; }
    if (!isHttpUrl(tab.url)) {
      out.textContent = '当前页面（' + tab.url + '）不是普通网页，浏览器不允许读取 cookies。\n切到 http(s) 网页后点“刷新”即可。';
      return;
    }
    const resp = await chrome.runtime.sendMessage({ cmd: 'cookies', url: tab.url });
    if (!resp?.ok) { out.textContent = '提示：' + (resp?.error || 'unknown'); return; }
    if (!resp.data.length) { out.textContent = '(no cookies)'; return; }
    // 展示带标记
    out.textContent = resp.data.map(c =>
      `${c.name}=${c.value}` + (c.httpOnly ? ' [H]' : '') + (c.secure ? ' [S]' : '') + (c.partitionKey ? ' [P]' : '')
    ).join('\n');
    // 自动复制 name=value; 格式到剪贴板
    const str = resp.data.map(c => `${c.name}=${c.value}`).join('; ');
    await navigator.clipboard.writeText(str);
  } catch (e) { out.textContent = '读取失败：' + e.message; }
}