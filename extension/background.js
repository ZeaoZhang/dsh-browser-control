// background.js - Cookie + CDP Bridge for dsh-browser-control
import { WS_URL, HTTP_PROBE } from './config.js';
chrome.runtime.onInstalled.addListener(() => {
  console.log('CDP Bridge installed');
  // Strip CSP headers to allow eval/inline scripts
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [9999],
    addRules: [{
      id: 9999, priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: [
        { header: 'content-security-policy', operation: 'remove' },
        { header: 'content-security-policy-report-only', operation: 'remove' }
      ]},
      condition: { urlFilter: '*', resourceTypes: ['main_frame', 'sub_frame'] }
    }]
  });
});

const EXT_BRIDGE_MESSAGE = 'DSH_BROWSER_BRIDGE';
const EXT_BRIDGE_TIMEOUT_MS = 25000;

function wsSend(payload) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  } catch (e) { /* socket went away between the check and the send */ }
}

// --- async window.open bridge ---------------------------------------------
// The page runtime posts blocked window.open() destinations that happen after
// an action returned (setTimeout/await chains). popup_bridge.js forwards them
// here; remember them briefly so the browser_act fallback does not open the
// same destination a second time.
const RECENT_POPUP_MS = 3000;
const recentPopups = new Map(); // href -> { at, tab }

function popupTabOf(href) {
  const hit = recentPopups.get(href);
  if (!hit) return null;
  if (Date.now() - hit.at > RECENT_POPUP_MS) {
    recentPopups.delete(href);
    return null;
  }
  return hit.tab;
}

function notePopup(href, tab) {
  if (!href || !tab) return;
  recentPopups.set(href, { at: Date.now(), tab });
  if (recentPopups.size > 20) {
    const now = Date.now();
    for (const [key, value] of recentPopups) {
      if (now - value.at > RECENT_POPUP_MS) recentPopups.delete(key);
    }
  }
}

async function handleOpenPopup(msg, sender) {
  try {
    const href = String(msg.href || '');
    if (!/^(https?|file|chrome-extension):/i.test(href)) {
      return { ok: false, error: '拒绝打开不支持的地址: ' + href };
    }
    const existing = popupTabOf(href);
    if (existing) return { ok: true, data: { ...existing, deduped: true } };
    const tab = await chrome.tabs.create({
      url: href,
      active: false,
      openerTabId: sender.tab?.id,
    });
    const ready = await waitForTabReady(tab.id, 5000);
    const data = ready || {
      id: tab.id,
      url: tab.pendingUrl || tab.url || href,
      title: tab.title || '',
      status: tab.status,
      windowId: tab.windowId,
      active: !!tab.active,
    };
    notePopup(href, data);
    // The page-side call that triggered this has usually already returned, so
    // no in-flight action/result can carry the tab: tell the driver now.
    wsSend({ type: 'newTabs', tabs: [data] });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- downloads -------------------------------------------------------------
function downloadSummary(item) {
  if (!item) return null;
  return {
    id: item.id,
    url: item.url || item.finalUrl || '',
    final_url: item.finalUrl || '',
    filename: item.filename || '',
    bytes: Number(item.bytesReceived) || Number(item.fileSize) || 0,
    file_size: Number(item.fileSize) || 0,
    state: item.state || '',
    mime: item.mime || '',
    error: item.error || '',
    exists: item.exists !== false,
    by_extension: item.byExtensionId === chrome.runtime.id,
    start_time: item.startTime || '',
    end_time: item.endTime || '',
  };
}

async function latestDownloads(since) {
  const startedAfter = new Date(Math.max(0, since - 1500)).toISOString();
  let items = [];
  try {
    items = await chrome.downloads.search({ startedAfter, orderBy: ['-startTime'], limit: 10 });
  } catch (e) { /* fall through */ }
  if (!items || !items.length) {
    try { items = await chrome.downloads.search({ orderBy: ['-id'], limit: 5 }); } catch (e) { items = []; }
  }
  return items || [];
}

async function waitForDownload(since, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const items = await latestDownloads(since);
    // A fresh candidate must have started at/after `since` (the click or the
    // download() call). A tiny negative bias absorbs clock granularity only, so
    // a previous, still-visible download is never mistaken for the new one.
    const fresh = items.filter((item) => !item.startTime || Date.parse(item.startTime) >= since - 100);
    if (fresh.length) {
      last = fresh[0];
      if (last.state && last.state !== 'in_progress') return downloadSummary(last);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return last ? downloadSummary(last) : null;
}

async function downloadsDir() {
  try {
    const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
    const file = items && items[0] && items[0].filename;
    if (!file) return null;
    const match = String(file).match(/^(.*)[/\\][^/\\]*$/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

async function handleDownload(msg) {
  try {
    const method = msg.method || 'list';
    const timeoutMs = Math.min(Math.max(Number(msg.timeoutMs) || 20000, 1000), 120000);
    if (method === 'list') {
      const items = await chrome.downloads.search({
        orderBy: ['-startTime'],
        limit: Math.min(Math.max(Number(msg.limit) || 10, 1), 50),
      });
      return { ok: true, data: { downloads: (items || []).map(downloadSummary), dir: await downloadsDir() } };
    }
    if (method === 'start') {
      const url = String(msg.url || '');
      if (!/^(https?|file|blob|data):/i.test(url)) {
        return { ok: false, error: 'browser_download 只支持 http(s)/file/blob/data 下载地址: ' + url };
      }
      const since = Date.now();
      const id = await chrome.downloads.download({
        url,
        filename: msg.filename ? String(msg.filename) : undefined,
        saveAs: false,
        conflictAction: 'uniquify',
      });
      const download = await waitForDownload(since, timeoutMs);
      if (!download) return { ok: false, error: '下载任务已创建（id=' + id + '），但 ' + timeoutMs + 'ms 内没有出现在下载列表中' };
      return { ok: true, data: { id, download, dir: await downloadsDir() } };
    }
    if (method === 'wait') {
      const since = Number(msg.since) || Date.now() - 60000;
      const download = await waitForDownload(since, timeoutMs);
      if (!download) return { ok: false, error: '未检测到新的下载任务（窗口 ' + timeoutMs + 'ms）' };
      return { ok: true, data: { download, dir: await downloadsDir() } };
    }
    if (method === 'dir') return { ok: true, data: { dir: await downloadsDir() } };
    return { ok: false, error: 'Unknown download method: ' + method };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sendMessageToExtension(extensionId, payload, timeoutMs = EXT_BRIDGE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: '通过目标扩展执行超时（' + Math.round(timeoutMs / 1000) + 's）' });
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage(extensionId, payload, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          finish({ ok: false, error: lastError.message || '目标扩展无响应' });
          return;
        }
        finish(response || { ok: false, error: '目标扩展没有返回响应' });
      });
    } catch (e) {
      finish({ ok: false, error: e.message });
    }
  });
}

// Runtime.evaluate has no async-function auto-return, so normalise the code the
// same way the direct chrome.scripting path does: async body for statements or
// explicit returns, expression wrapper for a single value.
function buildBridgeExpression(code) {
  const src = String(code == null ? '' : code).trim();
  if (/(^|[\n;])\s*return\b/.test(src) || src.includes(';')) {
    return '(async () => {\n' + src + '\n})()';
  }
  return '(async () => (' + src + '))()';
}

// Cross-extension chrome-extension:// pages cannot be scripted or debugged by
// this extension. If the target extension embeds the DSH_BROWSER_BRIDGE handler
// (it evaluates on this tab with its own chrome.debugger), route through it.
async function handleExtBridge(msg) {
  const extensionId = String(msg.extensionId || '');
  if (!/^[a-p]{32}$/.test(extensionId)) return { ok: false, error: '无效的 extensionId' };
  if (extensionId === chrome.runtime.id) return { ok: false, error: '不能桥接到自身扩展' };
  const payload = msg.cmd === 'ext_eval'
    ? { type: EXT_BRIDGE_MESSAGE, tabId: msg.tabId, expression: buildBridgeExpression(msg.code) }
    : { type: EXT_BRIDGE_MESSAGE, tabId: msg.tabId, method: msg.method, params: msg.params || {} };
  const response = await sendMessageToExtension(extensionId, payload, msg.timeoutMs);
  if (!response || response.ok !== true) {
    return { ok: false, error: (response && response.error) || '目标扩展未实现 DSH_BROWSER_BRIDGE 桥接' };
  }
  if (msg.cmd === 'ext_eval') {
    const cdp = response.result || {};
    if (cdp.exceptionDetails) {
      const detail = cdp.exceptionDetails;
      const text = (detail.exception && (detail.exception.description || detail.exception.value)) || detail.text || '目标页面 JS 异常';
      return { ok: false, error: String(text) };
    }
    return { ok: true, data: cdp.result ? cdp.result.value : undefined };
  }
  return { ok: true, data: response.result };
}

async function handleExtMessage(msg, sender) {
  if (msg.cmd === 'status') {
    return { ok: true, data: { state: status, ws: !!(ws && ws.readyState === WebSocket.OPEN), server: HTTP_PROBE } };
  }
  if (msg.cmd === 'cookies') return await handleCookies(msg, sender);
  if (msg.cmd === 'open_popup') return await handleOpenPopup(msg, sender);
  if (msg.cmd === 'download') return await handleDownload(msg);
  if (msg.cmd === 'ext_eval' || msg.cmd === 'ext_cdp') return await handleExtBridge(msg);
  if (msg.cmd === 'cdp') return await handleCDP(msg, sender);
  if (msg.cmd === 'batch') return await handleBatch(msg, sender);
  if (msg.cmd === 'tabs') {
    try {
      if (msg.method === 'create') {
        if (msg.dedupe) {
          const existing = popupTabOf(String(msg.url || ''));
          if (existing) return { ok: true, data: { ...existing, deduped: true } };
        }
        const tab = await chrome.tabs.create({
          url: msg.url,
          active: msg.active !== undefined ? msg.active : false,
          index: msg.index,
          windowId: msg.windowId,
          openerTabId: msg.openerTabId
        });
        // chrome.tabs.create returns before the URL/title are populated; wait
        // briefly so callers get a usable url/title instead of an empty string.
        const ready = await waitForTabReady(tab.id, 5000);
        const data = ready || { id: tab.id, url: tab.pendingUrl || tab.url || msg.url, title: tab.title || '', status: tab.status, windowId: tab.windowId, active: tab.active };
        if (msg.dedupe) notePopup(String(msg.url || ''), data);
        return { ok: true, data };
      }
      if (msg.method === 'switch') {
        const tab = await chrome.tabs.update(msg.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      }
      if (msg.method === 'close') {
        await chrome.tabs.remove(msg.tabId);
        return { ok: true };
      }
      if (msg.method === 'navigate') {
        const tab = await chrome.tabs.update(msg.tabId, { url: msg.url });
        return { ok: true, data: { id: tab.id, url: tab.url, title: tab.title } };
      } else {
        const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
        const data = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
        return { ok: true, data };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (msg.cmd === 'management') {
    try {
      if (msg.method === 'list') {
        const all = await chrome.management.getAll();
        return { ok: true, data: all.map(e => ({ id: e.id, name: e.name, enabled: e.enabled, type: e.type, version: e.version })) };
      }
      if (msg.method === 'reload') {
        chrome.alarms.create('tmwd-self-reload', { when: Date.now() + 200 });
        return { ok: true };
      }
      if (msg.method === 'disable') {
        await chrome.management.setEnabled(msg.extId, false);
        return { ok: true };
      }
      if (msg.method === 'enable') {
        await chrome.management.setEnabled(msg.extId, true);
        return { ok: true };
      }
      return { ok: false, error: 'Unknown method: ' + msg.method };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (msg.cmd === 'contentSettings') {
    try {
      const type = msg.type || 'automaticDownloads';
      const setting = msg.setting || 'allow';
      const pattern = msg.pattern || '<all_urls>';
      await chrome.contentSettings[type].set({
        primaryPattern: pattern,
        setting: setting
      });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, error: 'Unknown cmd: ' + msg.cmd };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleExtMessage(msg, sender).then(sendResponse);
  return true;
});

async function handleCookies(msg, sender) {
  try {
    let url = msg.url || sender.tab?.url;
    if (!url && msg.tabId) {
      const tab = await chrome.tabs.get(msg.tabId);
      url = tab.url;
    }
    if (!url || !/^https?:/i.test(url)) {
      return { ok: false, error: '当前标签页不是 http(s) 页面（chrome:// 等无法读取 cookies）' };
    }
    const origin = (url.match(/^https?:\/\/[^\/]+/) || [url])[0];
    const all = await chrome.cookies.getAll({ url });
    const part = await chrome.cookies.getAll({ url, partitionKey: { topLevelSite: origin } }).catch(() => []);
    const merged = [...all];
    for (const c of part) {
      if (!merged.some(x => x.name === c.name && x.domain === c.domain)) merged.push(c);
    }
    return { ok: true, data: merged };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleBatch(msg, sender) {
  const R = [];
  let attached = null;
  const resolve$N = (params) => JSON.parse(JSON.stringify(params || {}).replace(/"\$(\d+)\.([^"]+)"/g,
    (_, i, path) => { let v = R[+i]; for (const k of path.split('.')) v = v[k]; return JSON.stringify(v); }));
  try {
    for (const c of msg.commands) {
      if (c.tabId === undefined && msg.tabId !== undefined) c.tabId = msg.tabId;
      if (c.cmd === 'cookies') {
        R.push(await handleCookies(c, sender));
      } else if (c.cmd === 'tabs') {
        const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
        R.push({ ok: true, data: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) });
      } else if (c.cmd === 'cdp') {
        const tabId = c.tabId || msg.tabId || sender.tab?.id;
        if (attached !== tabId) {
          if (attached) { await chrome.debugger.detach({ tabId: attached }); attached = null; }
          await chrome.debugger.attach({ tabId }, '1.3');
          attached = tabId;
        }
        R.push(await chrome.debugger.sendCommand({ tabId }, c.method, resolve$N(c.params)));
      } else {
        R.push({ ok: false, error: 'unknown cmd: ' + c.cmd });
      }
    }
    if (attached) await chrome.debugger.detach({ tabId: attached });
    return { ok: true, results: R };
  } catch (e) {
    if (attached) try { await chrome.debugger.detach({ tabId: attached }); } catch (_) {}
    return { ok: false, error: e.message, results: R };
  }
}

async function handleCDP(msg, sender) {
  const tabId = msg.tabId || sender.tab?.id;
  if (!tabId) return { ok: false, error: 'no tabId' };
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    const result = await chrome.debugger.sendCommand({ tabId }, msg.method, msg.params || {});
    await chrome.debugger.detach({ tabId });
    return { ok: true, data: result };
  } catch (e) {
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    return { ok: false, error: e.message };
  }
}
async function waitForTabReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await chrome.tabs.get(tabId);
      if (last && last.status === 'complete' && last.url) {
        return { id: last.id, url: last.url, title: last.title || '', status: last.status, windowId: last.windowId, active: last.active };
      }
    } catch (e) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!last) return null;
  return { id: last.id, url: last.url || last.pendingUrl || '', title: last.title || '', status: last.status, windowId: last.windowId, active: last.active };
}

// http(s)/file/extension pages are controllable (extension pages go through
// the chrome.debugger CDP fallback because chrome.scripting refuses them).
// chrome:// and other internal browser pages stay out of the tab list.
const isScriptable = url => !!url && /^(https?|file|chrome-extension):/i.test(url);

// --- Shared page/CDP script builder core ---
function buildExecScript(code, errorHandler) {
  return `(async () => {
    function smartProcessResult(result) {
      if (result === null || result === undefined || typeof result !== 'object') return result;
      try { if (result.window === result && result.document) return '[Window: ' + (result.location?.href || 'about:blank') + ']'; } catch(_){}
      if (typeof jQuery !== 'undefined' && result instanceof jQuery) {
        const elements = []; for (let i = 0; i < result.length; i++) { if (result[i] && result[i].nodeType === 1) elements.push(result[i].outerHTML); } return elements;
      }
      if (result instanceof NodeList || result instanceof HTMLCollection) {
        const elements = []; for (let i = 0; i < result.length; i++) { if (result[i] && result[i].nodeType === 1) elements.push(result[i].outerHTML); } return elements;
      }
      if (result.nodeType === 1) return result.outerHTML;
      if (!Array.isArray(result) && typeof result === 'object' && 'length' in result && typeof result.length === 'number') {
        const firstElement = result[0];
        if (firstElement && firstElement.nodeType === 1) {
          const elements = []; const length = Math.min(result.length, 100);
          for (let i = 0; i < length; i++) { const elem = result[i]; if (elem && elem.nodeType === 1) elements.push(elem.outerHTML); } return elements;
        }
      }
      try { return JSON.parse(JSON.stringify(result, function(key, value) { if (typeof value === 'object' && value !== null) { if (value.nodeType === 1) return value.outerHTML; if (value === window || value === document) return '[Object]'; try { if (value.window === value && value.document) return '[Window]'; } catch(_){} } return value; })); } catch (e) { return '[无法序列化: ' + e.message + ']'; }
    }
    try {
      const jsCode = ${JSON.stringify(code)}.trim();
      const lines = jsCode.split(/\\r?\\n/).filter(l => l.trim());
      const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : '';
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      let r;
      function _air(c) { const ls = c.split(/\\r?\\n/); let i = ls.length - 1; while (i >= 0 && !ls[i].trim()) i--; if (i < 0) return c; const t = ls[i].trim(); if (/^(return |return;|return$|let |const |var |if |if\\(|for |for\\(|while |while\\(|switch|try |throw |class |function |async |import |export |\\/\\/|})/.test(t)) return c; ls[i] = ls[i].match(/^(\\s*)/)[1] + 'return ' + t; return ls.join('\\n'); }
      // A top-level return can follow other statements on the same line
      // (el.click(); return x), so detect it anywhere a statement may start
      // instead of only on the last line. AsyncFunction accepts the raw code.
      const hasTopLevelReturn = /(^|[\\n;])\\s*return\\b/.test(jsCode);
      if (lastLine.startsWith('return') || hasTopLevelReturn) {
        r = await (new AsyncFunction(jsCode))();
      } else {
        try { r = eval(jsCode); if (r instanceof Promise) r = await r; } catch (e) {
          if (e instanceof SyntaxError && (/return/i.test(e.message) || /await/i.test(e.message))) { r = await (new AsyncFunction(_air(jsCode)))(); } else throw e;
        }
      }
      return { ok: true, data: smartProcessResult(r) };
    } catch (e) {
      ${errorHandler}
    }
  })()`;
}

function buildPageScript(code) {
  return buildExecScript(code, `
      const errMsg = e.message || String(e);
      return { ok: false, error: { name: e.name || 'Error', message: errMsg, stack: e.stack || '' },
        csp: errMsg.includes('Refused to evaluate') || errMsg.includes('unsafe-eval') || errMsg.includes('Content Security Policy') };
  `);
}

function buildCdpScript(code) {
  return buildExecScript(code, `
      return { ok: false, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' } };
  `);
}

// --- WebSocket Client for TMWebDriver ---
let ws = null;
let status = 'connected';
function setStatus(s){if(s===status)return;status=s;chrome.tabs.query({}).then(T=>T.forEach(t=>chrome.tabs.sendMessage(t.id,{type:'tmwd_status',data:s}).catch(()=>{})));}

function scheduleProbe() {
  // Use chrome.alarms to survive MV3 service worker suspension
  chrome.alarms.create('tmwd-ws-probe', { delayInMinutes: 0.083 }); // ~5s
}

function scheduleKeepalive() {
  // Keep SW alive while WS is connected (~25s, under 30s SW timeout)
  chrome.alarms.create('tmwd-ws-keepalive', { delayInMinutes: 0.4 }); // ~24s
}

async function isServerAlive() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    await fetch(HTTP_PROBE, { signal: ctrl.signal });
    return true; // Got HTTP response → port is listening
  } catch (e) {
    return false; // Network error (connection refused) or timeout → server not alive
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'tmwd-self-reload') {
    chrome.runtime.reload();
    return;
  }
  if (alarm.name === 'tmwd-ws-keepalive') {
    // Keepalive: ping to keep SW alive + detect dead connections
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send('{"type":"ping"}'); } catch (_) {}
      scheduleKeepalive();
    } else {
      // Connection lost, switch to probe mode
      ws = null;
      scheduleProbe();
    }
  }
  if (alarm.name === 'tmwd-ws-probe') {
    if (ws && ws.readyState <= 1) return; // Already connected/connecting
    if (await isServerAlive()) {
      console.log('[TMWD-WS] Server detected, connecting...');
      connectWS();
    } else {
      setStatus('disconnected');
      scheduleProbe(); // Server not up, keep probing
    }
  }
});

async function handleWsExec(data) {
  const tabId = data.tabId;
  console.log('[TMWD-WS] Exec request', data.id, 'on tab', tabId);
  ws.send(JSON.stringify({ type: 'ack', id: data.id }));
  if (!tabId) {
    ws.send(JSON.stringify({ type: 'error', id: data.id, error: 'No tabId provided' }));
    return;
  }
  // Use onCreated listener to reliably capture new tabs (avoids race condition with query-diff)
  const newTabIds = new Set();
  const onCreated = (tab) => { newTabIds.add(tab.id); };
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    let res;
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (s) => await eval(s),
        args: [buildPageScript(data.code)]
      });
      res = Array.isArray(result) ? result[0]?.result : undefined;
      if (res === null || res === undefined) {
        console.log('[TMWD-WS] executeScript returned null/undefined, treating as CSP issue');
        res = { ok: false, error: { name: 'Error', message: 'executeScript returned null (possible CSP or context issue)', stack: '' }, csp: true };
      }
    } catch (e) {
      console.log('[TMWD-WS] scripting.executeScript failed:', e.message);
      res = { ok: false, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' }, csp: true };
    }
    // CDP fallback for CSP-restricted pages
    if (res && !res.ok && res.csp) {
      console.log('[TMWD-WS] CDP fallback for tab', tabId);
      const wrappedCode = buildCdpScript(data.code);
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        const cdpRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: wrappedCode, awaitPromise: true, returnByValue: true
        });
        await chrome.debugger.detach({ tabId });
        if (cdpRes.exceptionDetails) {
          const desc = cdpRes.exceptionDetails.exception?.description || 'CDP Error';
          res = { ok: false, error: { name: 'Error', message: desc, stack: desc } };
        } else {
          res = cdpRes.result.value;
        }
      } catch (cdpErr) {
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        res = { ok: false, error: { name: 'Error', message: 'CDP fallback failed: ' + cdpErr.message, stack: '' } };
      }
    }
    // Grace period for async tab creation (e.g. link click with target=_blank)
    if (newTabIds.size === 0) await new Promise(r => setTimeout(r, 200));
    chrome.tabs.onCreated.removeListener(onCreated);
    // Get full info for captured new tabs
    const newTabs = [];
    for (const id of newTabIds) {
      try { const t = await chrome.tabs.get(id); newTabs.push({id: t.id, url: t.url, title: t.title}); } catch (_) {}
    }
    if (res?.ok) {
      ws.send(JSON.stringify({ type: 'result', id: data.id, result: res.data, newTabs }));
    } else {
      console.log(res);
      ws.send(JSON.stringify({ type: 'error', id: data.id, error: res?.error || 'Unknown error', newTabs }));
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', id: data.id, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' } }));
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}

function connectWS() {
  if (ws && ws.readyState <= 1) return; // CONNECTING or OPEN
  ws = null;
  console.log('[TMWD-WS] Connecting to', WS_URL);
  try {
    ws = new WebSocket(WS_URL);
    setStatus('connecting');
  } catch (e) {
    console.error('[TMWD-WS] Constructor error:', e);
    ws = null;
    scheduleProbe();
    return;
  }
  ws.onopen = async () => {
    console.log('[TMWD-WS] Connected!');
    setStatus('connected');
    scheduleKeepalive(); // Keep SW alive while connected
    const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
    ws.send(JSON.stringify({
      type: 'ext_ready',
      tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
    }));
    console.log('[TMWD-WS] Sent ext_ready with', tabs.length, 'tabs');
  };
  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.id && data.code) {
        let code = data.code;
        // If code is a JSON string representing an object, parse it
        if (typeof code === 'string') {
          try { const p = JSON.parse(code); if (p && typeof p === 'object') code = p; } catch (_) {}
        }
        if (typeof code === 'object' && code !== null && code.cmd) {
          // Custom protocol message → route to handleExtMessage
          if (code.tabId === undefined && data.tabId !== undefined) code.tabId = data.tabId;
          const res = await handleExtMessage(code, {});
          ws.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error }));
        } else if (typeof code === 'string') {
          // Plain JS code
          await handleWsExec(data);
        } else if (typeof code === 'object' && code !== null) {
          // Object without cmd → legacy extension message
          const msg = code.tabId === undefined && data.tabId !== undefined ? { ...code, tabId: data.tabId } : code;
          const res = await handleExtMessage(msg, {});
          ws.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error }));
        }
      }
    } catch (e) {
      console.error('[TMWD-WS] message parse error', e);
    }
  };
  ws.onclose = () => {
    console.log('[TMWD-WS] Disconnected');
    setStatus('connecting');
    ws = null;
    scheduleProbe();
  };
  ws.onerror = (e) => {
    console.error('[TMWD-WS] Error:', e);
    // onclose will fire after this, which triggers reconnect
  };
}

// Initial connect + wake-up hooks
connectWS();
chrome.runtime.onStartup.addListener(() => connectWS());
chrome.runtime.onInstalled.addListener(() => connectWS());

// Sync tab list on changes
async function sendTabsUpdate() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
  ws.send(JSON.stringify({
    type: 'tabs_update',
    tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
  }));
}
chrome.tabs.onUpdated.addListener((_, changeInfo) => {
  if (changeInfo.status === 'complete') sendTabsUpdate();
});
chrome.tabs.onRemoved.addListener(() => sendTabsUpdate());
chrome.tabs.onCreated.addListener(() => sendTabsUpdate());
