// Protocol-level test: real BrowserDriver + a fake extension WebSocket client.
// Verifies handshake, ext_ready tab registration, ack->result correlation,
// custom commands, scan/execute/act/wait routing and URL handling.
import assert from 'node:assert/strict';
import { BrowserDriver, resolveNavigateUrl } from '../lib/driver.js';
import { TestWebSocket } from './helpers/ws-client.mjs';

const PORT = 18790;
const logs = [];
const logger = { info: (msg) => logs.push(msg), warn: (msg) => logs.push(msg) };

// --- deterministic URL resolution (no browser needed) ---------------------
const rawWithQuery = 'https://example.com/knowledge/?status=reviewed&td_key=2026102000179';
assert.equal(resolveNavigateUrl(rawWithQuery, ''), rawWithQuery, 'absolute URL must not be re-encoded');
assert.equal(
  resolveNavigateUrl('/demo?rel=1&two=2', 'https://example.com/a'),
  'https://example.com/demo?rel=1&two=2',
  'relative URL resolves against the current page',
);
assert.equal(
  resolveNavigateUrl('?x=1&y=2', 'https://example.com/p'),
  'https://example.com/p?x=1&y=2',
  'bare query resolves against the current path',
);
assert.equal(resolveNavigateUrl('about:blank#ready', ''), 'about:blank#ready');
assert.throws(() => resolveNavigateUrl('about:config', ''), /RESTRICTED_PAGE/);
assert.throws(() => resolveNavigateUrl('javascript:alert(1)', ''), /UNSUPPORTED_SCHEME/);
assert.throws(() => resolveNavigateUrl('/relative', ''), /INVALID_URL/);

const driver = new BrowserDriver({ port: PORT, timeoutMs: 5000, logger });
await driver.start();

const ws = await TestWebSocket.connect(PORT);
const tabState = [{ id: 101, url: 'https://example.com/a', title: 'A', active: true, windowId: 1 }];
let injected = false;
const sentCode = [];
ws.handlers.message = (text) => {
  const message = JSON.parse(text);
  ws.send({ type: 'ack', id: message.id });
  const code = message.code;
  let parsed;
  try { parsed = JSON.parse(code); } catch { parsed = null; }

  if (parsed && parsed.cmd === 'tabs') {
    if (parsed.method === 'create') {
      const created = { id: 102, url: parsed.url, title: 'Created', active: false, windowId: 1 };
      tabState.push(created);
      ws.send({ type: 'result', id: message.id, result: created });
      return;
    }
    if (parsed.method === 'close') {
      const index = tabState.findIndex((tab) => tab.id === parsed.tabId || tab.id === message.tabId);
      if (index >= 0) tabState.splice(index, 1);
      ws.send({ type: 'result', id: message.id, result: true });
      return;
    }
    if (parsed.method === 'switch') {
      tabState.forEach((tab) => { tab.active = tab.id === parsed.tabId; });
      ws.send({ type: 'result', id: message.id, result: true });
      return;
    }
    ws.send({ type: 'result', id: message.id, result: tabState });
    return;
  }
  if (parsed && parsed.cmd === 'cdp') {
    if (parsed.method === 'Page.navigate') {
      tabState[0] = { ...tabState[0], url: parsed.params.url };
      ws.send({ type: 'result', id: message.id, result: { frameId: 'frame-1' } });
      return;
    }
    ws.send({ type: 'result', id: message.id, result: { value: 'cdp-ok' } });
    return;
  }

  sentCode.push(code);
  if (code.includes('function optHTML')) {
    injected = true;
    ws.send({ type: 'result', id: message.id, result: true });
  } else if (code.includes('__DSH_BROWSER__.scan')) {
    ws.send({ type: 'result', id: message.id, result: '<div id="page">fake scan</div>' });
  } else if (code.includes('__DSH_BROWSER__.act')) {
    ws.send({ type: 'result', id: message.id, result: { ok: true, action: 'click', target: 'button#go', settled: true, changed: 1, waited_ms: 4 } });
  } else if (code.includes('__DSH_BROWSER__.waitFor')) {
    ws.send({ type: 'result', id: message.id, result: { ok: true, for: 'selector', waited_ms: 5, matched_text: '好', url: tabState[0].url } });
  } else if (code.startsWith('(window.__DSH_BROWSER__ &&')) {
    ws.send({ type: 'result', id: message.id, result: injected ? true : '__DSH_NEED_INJECT__' });
  } else if (code === '1+1') {
    ws.send({ type: 'result', id: message.id, result: 2 });
  } else if (code.includes('startMonitor')) {
    ws.send({ type: 'result', id: message.id, result: { timeOrigin: 111, url: tabState[0].url } });
  } else if (code.includes('finishMonitor')) {
    ws.send({ type: 'result', id: message.id, result: {
      transients: ['tick'],
      diff: { changed: 1, added: 1, removed: 0, summary: '+1 -0', items: [{ change: '+', desc: 'b' }] },
      timeOrigin: 111,
      url: tabState[0].url,
    } });
  } else {
    ws.send({ type: 'result', id: message.id, result: true });
  }
};

ws.send({
  type: 'ext_ready',
  tabs: [
    { id: 101, url: 'https://example.com/a', title: 'A', active: true, windowId: 1 },
  ],
});
await new Promise((resolve) => setTimeout(resolve, 150));

assert.equal(driver.connected, true, 'extension considered connected');
assert.equal(driver.listening, true, 'server listening');

const tabs = driver.listTabs();
assert.equal(tabs.length, 1);
assert.equal(tabs[0].tab_id, 101);
assert.equal(tabs[0].active, true);
assert.equal(tabs[0].agent, false);

const target = await driver.resolveTarget({});
assert.equal(target.tab.id, 101);

const html = await driver.scan(target, { maxChars: 5000 });
assert.equal(html, '<div id="page">fake scan</div>');

const value = await driver.runScript(target, '1+1');
assert.equal(value, 2);

const actResult = await driver.act(target, { action: 'click', target: '#go' });
assert.equal(actResult.ok, true);
assert.equal(actResult.target, 'button#go');

const waitResult = await driver.waitFor(target, { for: 'selector', selector: '#go', timeoutMs: 500 });
assert.equal(waitResult.ok, true);
assert.equal(waitResult.matched_text, '好');

// Absolute navigation keeps the query string byte-for-byte.
const absolute = await driver.navigate(target, rawWithQuery);
assert.equal(absolute.url, rawWithQuery);
assert.equal(driver.listTabs()[0].url, rawWithQuery, 'tab url should carry the raw query string');

// Relative navigation uses the current tab URL as the base.
const relative = await driver.navigate(target, '/demo?rel=1&two=2');
assert.equal(relative.url, 'https://example.com/demo?rel=1&two=2');
assert.equal(driver.listTabs()[0].url, relative.url);

const cdp = await driver.cdp(target, 'Page.getLayoutMetrics');
assert.deepEqual(cdp, { value: 'cdp-ok' });

// Explicit tab ids and missing-tab errors.
const explicit = await driver.resolveTarget({ tab_id: '101' });
assert.equal(explicit.tab.id, 101);
await assert.rejects(() => driver.resolveTarget({ tab_id: 999 }), /找不到标签页/);

// New tabs are marked as agent-owned, included in the list, and closed in bulk.
const created = await driver.newTab('https://example.com/new?x=1&y=2', false);
assert.equal(created.id, 102);
const createdTab = driver.listTabs().find((tab) => tab.tab_id === 102);
assert.ok(createdTab, 'created tab should be listed immediately');
assert.equal(createdTab.agent, true, 'created tab should be marked as agent-owned');

const health = driver.health();
assert.equal(health.ok, true);
assert.equal(health.extension.connected, true);
assert.equal(health.tabs.agent, 1);
assert.equal(health.extension.agents, 1);

const closed = await driver.closeAgentTabs();
assert.deepEqual(closed.closed, [102]);
assert.equal(driver.listTabs().some((tab) => tab.tab_id === 102), false);

// Page guard + injection were requested (injection once, guard each call).
assert.ok(sentCode.some((code) => code.includes('window.__DSH_BROWSER__') && code.includes('optHTML') === false));
assert.ok(sentCode.some((code) => code.includes('function optHTML')), 'injection contains optHTML');
assert.ok(sentCode.filter((code) => code.includes('function optHTML')).length === 1, 'injection only once per page');

// HTTP probe endpoint the extension uses.
const probe = await fetch(`http://127.0.0.1:${PORT}/`);
const body = await probe.json();
assert.equal(body.ok, true);
assert.equal(body.tabs, 1);

ws.close();
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(driver.connected, false, 'disconnect observed');
assert.equal(driver.listTabs().length, 0, 'disconnected tabs removed');
const afterClose = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.json());
assert.equal(afterClose.sessions, 0, 'session count drops after disconnect');
assert.equal(afterClose.tabs, 0, 'tab count drops after disconnect');

await driver.stop();
console.log('protocol test passed');
