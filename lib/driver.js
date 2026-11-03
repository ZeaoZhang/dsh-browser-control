// Connection/state manager for the TMWebDriver protocol.
// The Chrome extension is the WebSocket *client*: it connects to
// ws://127.0.0.1:<port>/, announces its tabs, and then executes JS/commands
// forwarded by this driver inside the page.

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { upgradeToWebSocket } from './ws.js';
import { PAGE_GUARD, injectSource } from './page/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEED_INJECT = '__DSH_NEED_INJECT__';
const CROSS_EXTENSION_RE = /different extension|Cannot access a chrome-extension:\/\//i;

function errorMessage(value) {
  return value && value.message ? value.message : String(value ?? '');
}

function extensionIdFromUrl(url) {
  const match = /^chrome-extension:\/\/([a-p]{32})(?:[/?#]|$)/i.exec(String(url || ''));
  return match ? match[1] : null;
}
const NO_CONNECTION_HELP =
  '没有已连接的 Chrome 扩展。请确认：1) Chrome 已安装并启用 dsh-browser-control 扩展；' +
  '2) 扩展版本与插件端口一致（默认 18865）；3) 插件日志中已出现 "extension connected"；' +
  '4) 如果页面是 chrome:// 或 Web Store 等受限页面，请切换到普通网页。';

function errorFrom(payload) {
  if (payload && typeof payload === 'object') {
    const err = new Error(payload.message || payload.name || '浏览器执行失败');
    err.detail = payload;
    return err;
  }
  return new Error(String(payload ?? '浏览器执行失败'));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NAV_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Resolve a user-supplied navigation target to the absolute URL handed to
 * Page.navigate. Absolute http(s)/file/chrome-extension URLs are returned
 * byte-for-byte (never re-encoded); relative URLs are resolved against the
 * current tab URL. Unsupported schemes fail with an actionable error code.
 */
export function resolveNavigateUrl(raw, baseUrl) {
  const input = String(raw == null ? '' : raw).trim();
  if (!input) throw new Error('[INVALID_URL] URL 不能为空');
  const lower = input.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    throw new Error(`[UNSUPPORTED_SCHEME] 不允许导航到 ${input.slice(0, 24)}…（仅支持 http(s)/file/chrome-extension/about:blank）`);
  }
  if (lower.startsWith('chrome://') || lower.startsWith('devtools://') || lower.startsWith('edge://') || lower.startsWith('about:')) {
    if (lower === 'about:blank' || /^about:blank[?#]/.test(lower)) return input;
    throw new Error(`[RESTRICTED_PAGE] Chrome 内部页面无法被扩展控制: ${input}`);
  }
  if (NAV_SCHEME_RE.test(input)) {
    try { new URL(input); } catch { throw new Error(`[INVALID_URL] 无法解析绝对 URL: ${input}`); }
    if (!/^(https?|file|chrome-extension):/i.test(input)) {
      throw new Error(`[UNSUPPORTED_SCHEME] 不支持 ${input.split(':')[0]}:// 协议（仅支持 http(s)/file/chrome-extension/about:blank）`);
    }
    return input;
  }
  if (!baseUrl || !NAV_SCHEME_RE.test(String(baseUrl))) {
    throw new Error(`[INVALID_URL] 相对 URL "${input}" 需要当前标签页有有效的 http(s) 地址；可先打开一个页面，或直接传入绝对 URL`);
  }
  try {
    return new URL(input, baseUrl).href;
  } catch {
    throw new Error(`[INVALID_URL] 无法基于 ${baseUrl} 解析相对 URL "${input}"`);
  }
}

export class BrowserDriver {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 18865;
    this.timeoutMs = options.timeoutMs || 30000;
    this.logger = options.logger || console;
    this.screenshotDir =
      options.screenshotDir || path.join(os.homedir(), '.dsh', 'browser-control', 'screenshots');
    this.server = null;
    this.connections = [];
    this.pending = new Map();
    this.current = null;
    this.startError = null;
    this.started = false;
    this.nextConnId = 1;
    this.heartbeat = null;
    // Tabs created by this driver (open / execute_js new tabs). Only these are
    // eligible for close_agent_tabs so user tabs cannot be closed by accident.
    this.agentTabs = new Set();
  }

  get listening() {
    return this.started && this.server?.listening === true;
  }

  get connected() {
    return this.connections.some((conn) => conn.ws && !conn.ws.closed);
  }

  // ---- lifecycle -----------------------------------------------------------

  async start() {
    if (this.started) return;
    const server = http.createServer((req, res) => this._onRequest(req, res));
    server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
    server.on('clientError', (_err, socket) => socket.destroy());
    this.server = server;

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        this.startError = error;
        this.started = false;
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });

    this.started = true;
    this.startError = null;
    this.heartbeat = setInterval(() => this._heartbeat(), 20000);
    this.heartbeat.unref?.();
    this.logger.info?.(`[dsh-browser-control] WebSocket server listening on ws://${this.host}:${this.port}`);
  }

  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('浏览器控制插件已停止'));
    }
    this.pending.clear();
    for (const conn of this.connections) {
      try { conn.ws?.close(1001, 'plugin stopped'); } catch { /* ignore */ }
    }
    this.connections = [];
    this.current = null;
    const server = this.server;
    this.server = null;
    this.started = false;
    if (!server) return;
    // close() waits for keep-alive sockets, so also force-close them; the
    // timeout guarantees shutdown never blocks plugin disposal.
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 1000);
      server.close(() => finish());
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
    });
  }

  // ---- HTTP endpoint (extension probes GET / before connecting) -----------

  _onRequest(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/' || url.pathname === '/health') {
      const body = JSON.stringify({
        ok: true,
        plugin: 'dsh-browser-control',
        sessions: this.connections.filter((conn) => conn.ws && !conn.ws.closed).length,
        tabs: this._entries().length,
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (url.pathname === '/demo') {
      this._serveDemo(res).catch(() => {
        res.writeHead(500);
        res.end('demo page unavailable');
      });
      return;
    }
    if (url.pathname === '/download') {
      this._serveDownload(res, url).catch(() => {
        res.writeHead(500);
        res.end('download fixture unavailable');
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh-browser-control: not found');
  }

  async _serveDemo(res) {
    const file = path.join(HERE, '..', 'assets', 'demo.html');
    const html = await readFile(file, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  // Fixture for browser_download: /download?name=report.txt&bytes=4096 answers
  // with an attachment so tests do not depend on an external file host.
  async _serveDownload(res, url) {
    const name = String(url.searchParams.get('name') || 'dsh-download.txt').replace(/[^\w.\-]+/g, '_') || 'download.txt';
    const bytes = Math.min(Math.max(Number(url.searchParams.get('bytes')) || 2048, 1), 5 * 1024 * 1024);
    const body = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 1) body[i] = 97 + (i % 26);
    res.writeHead(200, {
      'content-type': url.searchParams.get('type') || 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': String(bytes),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(body);
  }

  _onUpgrade(req, socket, head) {
    const conn = {
      id: `c${this.nextConnId++}`,
      ws: null,
      tabs: new Map(),
      ready: false,
      openedAt: Date.now(),
      lastActive: Date.now(),
      address: socket.remoteAddress,
    };
    const ws = upgradeToWebSocket(req, socket, head, {
      onMessage: (text) => this._onMessage(conn, text),
      onClose: () => this._onDisconnect(conn),
    });
    if (!ws) return;
    conn.ws = ws;
    this.connections.push(conn);
    this.logger.info?.(`[dsh-browser-control] extension connected from ${conn.address} (${conn.id})`);
  }

  _onDisconnect(conn) {
    if (!this.connections.includes(conn)) return;
    this.connections = this.connections.filter((item) => item !== conn);
    if (this.current?.conn === conn) this.current = null;
    for (const [id, pending] of this.pending) {
      if (pending.conn !== conn) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error('浏览器扩展连接已断开'));
    }
    this.logger.info?.(`[dsh-browser-control] extension disconnected (${conn.id})`);
  }

  _onMessage(conn, text) {
    conn.lastActive = Date.now();
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'ext_ready':
        this._setTabs(conn, msg.tabs, { ready: true });
        this.logger.info?.(`[dsh-browser-control] extension ready (${conn.id}), ${conn.tabs.size} tabs`);
        this.refreshTabs(conn).catch(() => {});
        return;
      case 'tabs_update':
        this._setTabs(conn, msg.tabs);
        return;
      case 'ping':
        conn.ws?.sendJson({ type: 'pong' });
        return;
      case 'pong':
        return;
      case 'ack':
        return;
      case 'newTabs':
        // Tabs opened by the extension itself (async window.open bridged from
        // the page, or the browser_act popup fallback) arrive outside any
        // pending request, so mark them here too.
        if (Array.isArray(msg.tabs)) {
          for (const tab of msg.tabs) {
            if (tab && typeof tab.id === 'number') this.agentTabs.add(tab.id);
          }
        }
        this._setTabs(conn, msg.tabs, { merge: true });
        return;
      case 'result': {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (Array.isArray(msg.newTabs) && msg.newTabs.length) {
          for (const tab of msg.newTabs) {
            if (tab && typeof tab.id === 'number') this.agentTabs.add(tab.id);
          }
          this._setTabs(conn, msg.newTabs, { merge: true });
        }
        pending.resolve(msg.result);
        return;
      }
      case 'error': {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (Array.isArray(msg.newTabs) && msg.newTabs.length) {
          for (const tab of msg.newTabs) {
            if (tab && typeof tab.id === 'number') this.agentTabs.add(tab.id);
          }
          this._setTabs(conn, msg.newTabs, { merge: true });
        }
        pending.reject(errorFrom(msg.error));
        return;
      }
      default:
        return;
    }
  }

  _setTabs(conn, tabs, options = {}) {
    if (!Array.isArray(tabs)) return;
    if (!options.merge) conn.tabs = new Map();
    for (const tab of tabs) {
      if (!tab || typeof tab.id !== 'number') continue;
      const previous = conn.tabs.get(tab.id) || {};
      const url = String(tab.url || tab.pendingUrl || previous.url || '');
      const title = String(tab.title || previous.title || '');
      conn.tabs.set(tab.id, {
        id: tab.id,
        url,
        title,
        active: options.merge ? (tab.active === true || previous.active === true) : tab.active === true,
        status: tab.status || previous.status || '',
        windowId: tab.windowId ?? previous.windowId,
      });
    }
    if (options.ready) conn.ready = true;
    if (this.current?.conn === conn && !conn.tabs.has(this.current.tab.id)) this.current = null;
    if (!this.current) {
      const active = [...conn.tabs.values()].find((tab) => tab.active);
      if (active) this.current = { conn, tab: active };
    }
    // Drop agent markers for tabs that no longer exist anywhere.
    for (const id of this.agentTabs) {
      const live = this.connections.some((item) => item.tabs && item.tabs.has(id));
      if (!live) this.agentTabs.delete(id);
    }
  }

  _heartbeat() {
    const now = Date.now();
    for (const conn of [...this.connections]) {
      const ws = conn.ws;
      if (!ws || ws.closed) continue;
      if (now - ws.lastSeen > 60000) {
        ws.close(1001, 'heartbeat timeout');
        continue;
      }
      ws.ping();
    }
  }

  // ---- tab discovery -------------------------------------------------------

  _entries() {
    const ordered = [...this.connections].sort((a, b) => b.lastActive - a.lastActive);
    const entries = [];
    for (const conn of ordered) {
      if (!conn.ws || conn.ws.closed) continue;
      for (const tab of conn.tabs.values()) entries.push({ conn, tab });
    }
    return entries;
  }

  listTabs() {
    const current = this.current;
    return this._entries().map(({ conn, tab }) => ({
      tab_id: tab.id,
      url: tab.url,
      title: tab.title,
      active: tab.active === true,
      current: current?.conn === conn && current?.tab.id === tab.id,
      browser: conn.id,
      agent: this.agentTabs.has(tab.id),
    }));
  }

  async syncTabs() {
    const conns = [...this.connections];
    await Promise.all(conns.map((conn) => this.refreshTabs(conn).catch(() => {})));
  }

  async refreshTabs(conn) {
    if (!conn.ws || conn.ws.closed) return;
    const data = await this._command(conn, { cmd: 'tabs' }, undefined, Math.min(this.timeoutMs, 10000));
    if (Array.isArray(data)) this._setTabs(conn, data);
  }

  async resolveTarget(args = {}) {
    if (args.tab_id !== undefined && args.tab_id !== null && args.tab_id !== '') {
      const wanted = args.tab_id;
      let entries = this._entries();
      let found = entries.find(({ tab }) => tab.id === wanted || String(tab.id) === String(wanted));
      if (!found) {
        await Promise.all(this.connections.map((conn) => this.refreshTabs(conn).catch(() => {})));
        entries = this._entries();
        found = entries.find(({ tab }) => tab.id === wanted || String(tab.id) === String(wanted));
      }
      if (!found) throw new Error(`找不到标签页 ${wanted}。先调用 browser_tabs 查看可用标签页。`);
      this.current = found;
      return found;
    }
    if (args.url) {
      const needle = String(args.url).toLowerCase();
      const found = this._entries().find(({ tab }) =>
        (tab.url || '').toLowerCase().includes(needle) || (tab.title || '').toLowerCase().includes(needle));
      if (!found) throw new Error(`没有匹配 "${args.url}" 的标签页。`);
      this.current = found;
      return found;
    }
    if (this.current) {
      const live = this._entries().find(({ conn, tab }) => conn === this.current.conn && tab.id === this.current.tab.id);
      if (live) return live;
    }
    await Promise.all(this.connections.map((conn) => this.refreshTabs(conn).catch(() => {})));
    const entries = this._entries();
    if (!entries.length) throw new Error(NO_CONNECTION_HELP);
    const active = entries.find(({ tab }) => tab.active);
    this.current = active || entries[0];
    return this.current;
  }

  // ---- low-level request ---------------------------------------------------

  _request(conn, payload, timeoutMs) {
    if (!conn?.ws || conn.ws.closed) throw new Error('浏览器扩展连接已断开');
    const timeout = timeoutMs || this.timeoutMs;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器执行超时（${timeout}ms）：页面可能正忙或已导航。`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, conn });
      try {
        conn.ws.sendJson({ id, ...payload });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async _exec(target, code, timeoutMs) {
    try {
      return await this._request(target.conn, { tabId: target.tab.id, code }, timeoutMs);
    } catch (error) {
      return await this._execViaExtensionBridge(target, code, timeoutMs, error);
    }
  }

  // chrome-extension:// pages of *other* extensions are blocked for both
  // chrome.scripting and chrome.debugger. If the target extension embeds the
  // DSH_BROWSER_BRIDGE handler it can evaluate on this tab on our behalf.
  async _execViaExtensionBridge(target, code, timeoutMs, originalError) {
    if (!CROSS_EXTENSION_RE.test(errorMessage(originalError))) throw originalError;
    const extensionId = extensionIdFromUrl(target.tab?.url);
    if (!extensionId) throw originalError;
    try {
      return await this._command(target.conn, { cmd: 'ext_eval', extensionId, code }, target.tab.id, timeoutMs);
    } catch (bridgeError) {
      throw new Error(`${errorMessage(originalError)}；跨扩展桥接失败：${errorMessage(bridgeError)}`);
    }
  }

  async _command(conn, command, tabId, timeoutMs) {
    const payload = { ...command };
    if (payload.tabId === undefined && tabId !== undefined) payload.tabId = tabId;
    return this._request(conn, { tabId, code: JSON.stringify(payload) }, timeoutMs);
  }

  async ensurePage(target) {
    const probe = await this._exec(target, PAGE_GUARD('true'));
    if (probe !== true) {
      await this._exec(target, injectSource());
    }
    return target;
  }

  // ---- page operations -----------------------------------------------------

  async scan(target, options = {}) {
    await this.ensurePage(target);
    const call = `window.__DSH_BROWSER__.scan(${JSON.stringify(options)})`;
    return this._exec(target, PAGE_GUARD(call));
  }

  async runScript(target, code) {
    await this.ensurePage(target);
    return this._exec(target, code);
  }

  async monitorStart(target) {
    await this.ensurePage(target);
    return this._exec(target, 'window.__DSH_BROWSER__.startMonitor()');
  }

  async monitorFinish(target) {
    try {
      return await this._exec(target, 'window.__DSH_BROWSER__.finishMonitor()');
    } catch {
      return { transients: [], diff: null, timeOrigin: null, url: null };
    }
  }

  async _cdpCommand(target, method, params = {}) {
    try {
      return await this._command(target.conn, { cmd: 'cdp', method, params }, target.tab.id);
    } catch (error) {
      if (!CROSS_EXTENSION_RE.test(errorMessage(error))) throw error;
      const extensionId = extensionIdFromUrl(target.tab?.url);
      if (!extensionId) throw error;
      return await this._command(target.conn, { cmd: 'ext_cdp', extensionId, method, params }, target.tab.id);
    }
  }

  async cdp(target, method, params = {}) {
    await this.ensurePage(target);
    return this._cdpCommand(target, method, params);
  }

  // ---- files ---------------------------------------------------------------

  /**
   * Attach real files to a page's <input type="file">. Page JS cannot assign
   * input.files, so we resolve + mark the element with the page runtime, then
   * set the list over CDP DOM.setFileInputFiles and report the FileList the
   * page's change handler sees.
   */
  async upload(target, spec = {}) {
    await this.ensurePage(target);
    const timeoutMs = Math.min(Math.max(Number(spec.timeoutMs) || 5000, 100), 28000);
    const mark = await this._exec(
      target,
      PAGE_GUARD(`window.__DSH_BROWSER__.uploadMark(${JSON.stringify({
        target: spec.target || '',
        index: Number(spec.index) || 0,
        timeoutMs,
      })})`),
      Math.min(this.timeoutMs, timeoutMs + 8000),
    );
    if (!mark || mark.ok !== true) {
      const error = new Error((mark && mark.error) || '无法定位上传用的 file input');
      error.code = (mark && mark.code) || 'UPLOAD_TARGET_NOT_FOUND';
      error.detail = mark;
      throw error;
    }
    const files = Array.isArray(spec.files) ? spec.files.map(String) : [];
    if (!files.length) throw new Error('没有提供要上传的文件路径');
    try {
      const batch = await this._command(
        target.conn,
        {
          cmd: 'batch',
          tabId: target.tab.id,
          commands: [
            {
              cmd: 'cdp',
              method: 'Runtime.evaluate',
              params: {
                expression: 'document.querySelector(\'input[type="file"][data-dsh-upload-mark]\')',
                objectGroup: 'dsh-upload',
              },
            },
            { cmd: 'cdp', method: 'DOM.setFileInputFiles', params: { files, objectId: '$0.result.objectId' } },
          ],
        },
        target.tab.id,
        Math.min(this.timeoutMs, 20000),
      );
      const evaluated = Array.isArray(batch) ? batch[0] : null;
      if (!Array.isArray(batch) || batch.length < 2) {
        throw new Error('DOM.setFileInputFiles 没有执行（file input 可能已被页面重新渲染）');
      }
      if (evaluated && evaluated.exceptionDetails) {
        throw new Error(evaluated.exceptionDetails.text || '页面中已找不到 file input（可能被重新渲染）');
      }
    } catch (error) {
      await this._exec(target, 'window.__DSH_BROWSER__ && window.__DSH_BROWSER__.uploadUnmark()').catch(() => {});
      throw error;
    }
    const settleMs = spec.settle === false ? 0 : Math.min(Math.max(Number(spec.settleMs) || 900, 100), 5000);
    const summary = await this._exec(
      target,
      PAGE_GUARD(`window.__DSH_BROWSER__.uploadFinish(${JSON.stringify({ settleMs })})`),
      Math.min(this.timeoutMs, settleMs + 9000),
    ).catch((error) => ({ state: null, settled: null, stateError: error.message }));
    return { mark, files, ...summary };
  }

  /**
   * Drive chrome.downloads in the extension: `method: 'start'` downloads a URL,
   * 'wait' waits for the next download started after `since`, 'list' returns
   * recent entries. The extension owns the default download directory.
   */
  async download(spec = {}) {
    const conn = this._entries()[0]?.conn || this.connections.find((item) => item.ws && !item.ws.closed);
    if (!conn) throw new Error(NO_CONNECTION_HELP);
    const timeoutMs = Math.min(Math.max(Number(spec.timeoutMs) || 20000, 1000), 120000);
    const command = { cmd: 'download', method: spec.method || 'wait', timeoutMs };
    if (spec.url) command.url = spec.url;
    if (spec.filename) command.filename = spec.filename;
    if (spec.since) command.since = Number(spec.since);
    if (spec.limit) command.limit = Number(spec.limit);
    const result = await this._command(conn, command, undefined, timeoutMs + 5000);
    if (result && result.ok === false) {
      const error = new Error(result.error || '下载命令失败');
      error.code = 'DOWNLOAD_FAILED';
      throw error;
    }
    return result;
  }

  async navigate(target, url) {
    const previousUrl = target.tab?.url || '';
    const resolved = resolveNavigateUrl(url, previousUrl);
    // Page.navigate works even when the old page is partly broken, so page
    // injection is best-effort here.
    await this.ensurePage(target).catch(() => {});
    const result = await this._cdpCommand(target, 'Page.navigate', { url: resolved });
    if (resolved !== previousUrl) {
      await this.waitForTabUrl(target, previousUrl, Math.min(this.timeoutMs, 6000)).catch(() => {});
    } else {
      await delay(250);
      await this.refreshTabs(target.conn).catch(() => {});
    }
    return { ...(result || {}), url: resolved };
  }

  async waitForTabUrl(target, previousUrl, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await delay(150);
      await this.refreshTabs(target.conn).catch(() => {});
      const live = this._entries().find(({ conn, tab }) => conn === target.conn && tab.id === target.tab.id);
      if (live && live.tab.url && live.tab.url !== previousUrl) {
        this.current = live;
        return live;
      }
    }
    return null;
  }

  /** Viewport rect of a target, for trusted (CDP) clicks. */
  async pageRect(target, spec) {
    await this.ensurePage(target);
    return this._exec(
      target,
      PAGE_GUARD(`window.__DSH_BROWSER__.rect(${JSON.stringify(spec)})`),
      Math.min(this.timeoutMs, 8000),
    );
  }

  async act(target, spec = {}) {
    await this.ensurePage(target);
    const timeoutMs = Math.min(
      Math.max(Number(spec.timeoutMs) || 5000, 100),
      Math.max(1000, this.timeoutMs - 5000),
    );
    const options = { ...spec, timeoutMs };
    const call = `window.__DSH_BROWSER__.act(${JSON.stringify(options)})`;
    return this._exec(target, PAGE_GUARD(call), Math.min(this.timeoutMs, timeoutMs + 8000));
  }

  async waitFor(target, spec = {}) {
    await this.ensurePage(target);
    const timeoutMs = Math.min(Math.max(Number(spec.timeoutMs) || 10000, 100), 28000);
    const options = { ...spec, timeoutMs };
    const call = `window.__DSH_BROWSER__.waitFor(${JSON.stringify(options)})`;
    return this._exec(target, PAGE_GUARD(call), Math.min(this.timeoutMs, timeoutMs + 8000));
  }

  async closeAgentTabs() {
    const closed = [];
    const skipped = [];
    for (const id of [...this.agentTabs]) {
      const entry = this._entries().find(({ tab }) => tab.id === id);
      if (!entry) {
        this.agentTabs.delete(id);
        continue;
      }
      if (entry.conn.tabs.size <= 1) {
        skipped.push(id);
        continue;
      }
      try {
        await this._command(entry.conn, { cmd: 'tabs', method: 'close' }, id);
        closed.push(id);
        this.agentTabs.delete(id);
      } catch {
        /* leave it marked so a later retry can try again */
      }
    }
    for (const conn of [...new Set(this.connections)]) {
      await this.refreshTabs(conn).catch(() => {});
    }
    return { closed, skipped };
  }

  health() {
    const live = this.connections.filter((conn) => conn.ws && !conn.ws.closed);
    const tabs = this.listTabs();
    const checks = [
      { name: 'server', ok: this.listening, detail: this.listening ? `ws://${this.host}:${this.port}` : (this.startError?.message || '未监听') },
      { name: 'extension', ok: this.connected, detail: this.connected ? `${live.length} 个连接` : '无扩展连接' },
      { name: 'tabs', ok: tabs.length > 0, detail: `${tabs.length} 个可控制标签页` },
    ];
    let hint = '';
    if (!this.listening) {
      hint = this.startError
        ? `WebSocket 服务启动失败: ${this.startError.message}（检查端口 ${this.port} 是否被占用）`
        : 'WebSocket 服务尚未启动。';
    } else if (!this.connected) {
      hint = NO_CONNECTION_HELP;
    } else if (!tabs.length) {
      hint = '扩展已连接，但没有可控制的标签页：请打开一个 http(s)/file 页面（chrome:// 等内部页面不可控制）。';
    }
    return {
      ok: this.listening && this.connected,
      server: { listening: this.listening, host: this.host, port: this.port, sessions: live.length },
      extension: {
        connected: this.connected,
        sessions: live.length,
        ready: live.some((conn) => conn.ready === true),
        agents: tabs.filter((tab) => tab.agent).length,
      },
      tabs: { total: tabs.length, agent: tabs.filter((tab) => tab.agent).length, active: tabs.filter((tab) => tab.active).length },
      checks,
      hint,
    };
  }

  async newTab(url, active = true, options = {}) {
    const conn = this._entries()[0]?.conn || this.connections[0];
    if (!conn) throw new Error(NO_CONNECTION_HELP);
    const data = await this._command(conn, {
      cmd: 'tabs',
      method: 'create',
      url,
      active,
      dedupe: options.dedupe === true,
    });
    const info = data && typeof data === 'object' ? data : {};
    if (info.deduped === true) {
      // The async window.open bridge already opened this destination; opening
      // it again would double the tab.
      await this.refreshTabs(conn).catch(() => {});
      return info;
    }
    if (typeof info.id === 'number') {
      this.agentTabs.add(info.id);
      const tabUrl = info.url || info.pendingUrl || url;
      this._setTabs(conn, [{
        id: info.id,
        url: tabUrl,
        title: info.title || '',
        active: info.active !== undefined ? info.active : active !== false,
        status: info.status || '',
        windowId: info.windowId,
      }], { merge: true });
      this.current = { conn, tab: conn.tabs.get(info.id) };
    }
    await this.refreshTabs(conn).catch(() => {});
    return info;
  }

  async closeTab(target) {
    const conn = target.conn;
    const data = await this._command(conn, { cmd: 'tabs', method: 'close' }, target.tab.id);
    this.agentTabs.delete(target.tab.id);
    await this.refreshTabs(conn).catch(() => {});
    return data;
  }

  async activateTab(target) {
    const data = await this._command(target.conn, { cmd: 'tabs', method: 'switch' }, target.tab.id);
    target.tab.active = true;
    this.current = target;
    return data;
  }

  async cookies(target) {
    return this._command(target.conn, { cmd: 'cookies' }, target.tab.id);
  }

  async waitForConnection(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connected) return true;
      await delay(150);
    }
    return this.connected;
  }
}

export { NO_CONNECTION_HELP, NEED_INJECT, delay };
