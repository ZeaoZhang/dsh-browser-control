// Protocol-level test: real BrowserDriver + a fake extension WebSocket client.
// Verifies handshake, ext_ready tab registration, ack->result correlation,
// custom commands, scan/execute routing and tab resolution.
import assert from 'node:assert/strict';
import { BrowserDriver } from '../lib/driver.js';
import { TestWebSocket } from './helpers/ws-client.mjs';

const PORT = 18790;
const logs = [];
const logger = { info: (msg) => logs.push(msg), warn: (msg) => logs.push(msg) };

const driver = new BrowserDriver({ port: PORT, timeoutMs: 5000, logger });
await driver.start();

const ws = await TestWebSocket.connect(PORT);
let tabId = 101;
let injected = false;
const sentCode = [];
ws.handlers.message = (text) => {
  const message = JSON.parse(text);
  ws.send({ type: 'ack', id: message.id });
  const code = message.code;
  let parsed;
  try { parsed = JSON.parse(code); } catch { parsed = null; }
  if (parsed && parsed.cmd === 'tabs') {
    ws.send({ type: 'result', id: message.id, result: [{ id: 101, url: 'https://example.com/a', title: 'A', active: true, windowId: 1 }] });
    return;
  }
  if (parsed && parsed.cmd === 'cdp') {
    ws.send({ type: 'result', id: message.id, result: { value: 'cdp-ok' } });
    return;
  }
  sentCode.push(code);
  if (code.includes('function optHTML')) {
    injected = true;
    ws.send({ type: 'result', id: message.id, result: true });
  } else if (code.includes('__DSH_BROWSER__.scan')) {
    ws.send({ type: 'result', id: message.id, result: '<div id="page">fake scan</div>' });
  } else if (code.startsWith('(window.__DSH_BROWSER__ &&')) {
    ws.send({ type: 'result', id: message.id, result: injected ? true : '__DSH_NEED_INJECT__' });
  } else if (code === '1+1') {
    ws.send({ type: 'result', id: message.id, result: 2 });
  } else if (code.includes('startMonitor')) {
    ws.send({ type: 'result', id: message.id, result: { timeOrigin: 111, url: 'https://example.com/a' } });
  } else if (code.includes('finishMonitor')) {
    ws.send({ type: 'result', id: message.id, result: { transients: ['tick'], diff: { changed: 1, top_change: '<b>x</b>' }, timeOrigin: 111, url: 'https://example.com/a' } });
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

const target = await driver.resolveTarget({});
assert.equal(target.tab.id, 101);

const html = await driver.scan(target, { maxChars: 5000 });
assert.equal(html, '<div id="page">fake scan</div>');

const value = await driver.runScript(target, '1+1');
assert.equal(value, 2);

const cdp = await driver.cdp(target, 'Page.getLayoutMetrics');
assert.deepEqual(cdp, { value: 'cdp-ok' });

// Explicit tab ids and missing-tab errors.
const explicit = await driver.resolveTarget({ tab_id: '101' });
assert.equal(explicit.tab.id, 101);
await assert.rejects(() => driver.resolveTarget({ tab_id: 999 }), /找不到标签页/);

// Page guard + injection were requested (injection once, guard each call).
assert.ok(sentCode.some((code) => code.includes('window.__DSH_BROWSER__') && code.includes('optHTML') === false));
assert.ok(sentCode.some((code) => code.includes('function optHTML')), 'injection contains optHTML');
assert.ok(sentCode.filter((code) => code.includes('function optHTML')).length === 1, 'injection only once per page');

// HTTP probe endpoint the extension uses.
const health = await fetch(`http://127.0.0.1:${PORT}/`);
const body = await health.json();
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
