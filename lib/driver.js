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
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh-browser-control: not found');
  }

  async _serveDemo(res) {
    const file = path.join(HERE, '..', 'assets', 'demo.html');
    const html = await readFile(file, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
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
        this._setTabs(conn, msg.tabs, { merge: true });
        return;
      case 'result': {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (Array.isArray(msg.newTabs) && msg.newTabs.length) this._setTabs(conn, msg.newTabs, { merge: true });
        pending.resolve(msg.result);
        return;
      }
      case 'error': {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (Array.isArray(msg.newTabs) && msg.newTabs.length) this._setTabs(conn, msg.newTabs, { merge: true });
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
      conn.tabs.set(tab.id, {
        id: tab.id,
        url: String(tab.url || previous.url || ''),
        title: String(tab.title || previous.title || ''),
        active: tab.active === true || previous.active === true,
        windowId: tab.windowId ?? previous.windowId,
      });
    }
    if (options.ready) conn.ready = true;
    if (this.current?.conn === conn && !conn.tabs.has(this.current.tab.id)) this.current = null;
    if (!this.current) {
      const active = [...conn.tabs.values()].find((tab) => tab.active);
      if (active) this.current = { conn, tab: active };
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

  async navigate(target, url) {
    await this.ensurePage(target);
    return this._cdpCommand(target, 'Page.navigate', { url });
  }

  async newTab(url, active = true) {
    const conn = this._entries()[0]?.conn || this.connections[0];
    if (!conn) throw new Error(NO_CONNECTION_HELP);
    const data = await this._command(conn, { cmd: 'tabs', method: 'create', url, active });
    await this.refreshTabs(conn).catch(() => {});
    return data;
  }

  async closeTab(target) {
    const conn = target.conn;
    const data = await this._command(conn, { cmd: 'tabs', method: 'close' }, target.tab.id);
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
