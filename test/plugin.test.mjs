// Plugin-wiring test: parses Config, applies the plugin to a mock Cordis
// context, checks the seven tools register and that a no-extension call
// produces a schema-valid result instead of throwing.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { Config, apply, inject, name } from '../lib/index.js';
import { registerTools } from '../lib/tools.js';

assert.equal(name, 'browser-control');
assert.deepEqual(inject, ['tools']);

const parsed = Config({});
assert.equal(parsed.port, 18865);
assert.equal(parsed.host, '127.0.0.1');
assert.equal(parsed.timeoutMs, 30000);
assert.equal(parsed.monitor, true);

const registered = new Map();
const disposers = [];
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: {
    register(definition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  },
  effect(factory, label) {
    assert.ok(label, 'effect label expected');
    disposers.push(factory());
  },
};

await apply(ctx, Config({ port: 18797 }));

const expected = [
  'browser_tabs',
  'browser_scan',
  'browser_execute_js',
  'browser_act',
  'browser_wait',
  'browser_cdp',
  'browser_screenshot',
];
for (const toolName of expected) assert.ok(registered.has(toolName), `missing tool ${toolName}`);

// browser_tabs list works without an extension and returns a valid shape.
const list = await registered.get('browser_tabs').execute({ action: 'list' }, { signal: new AbortController().signal });
assert.equal(list.action, 'list');
assert.equal(list.connected, false);
assert.equal(list.count, 0);
assert.ok(Array.isArray(list.tabs));
assert.ok(typeof list.hint === 'string' && list.hint.length > 0);

// browser_scan without a connection reports the install hint instead of throwing.
const scan = await registered.get('browser_scan').execute({}, { signal: new AbortController().signal });
assert.equal(scan.status, 'error');
assert.match(scan.error, /扩展/);

// Success-path schema validation: a fake connected driver feeds every tool a
// representative value so dsh-tools validates each output schema end to end.
const shotDir = path.join(os.tmpdir(), 'dsh-browser-control-test-shots');
const fakeTab = { id: 7, url: 'http://example.test/', title: 'Example', active: true };
const fakeConn = { id: 'c1', tabs: new Map([[7, fakeTab]]) };
const fakeDriver = {
  listening: true,
  connected: true,
  startError: null,
  screenshotDir: shotDir,
  listTabs: () => [{ tab_id: 7, url: fakeTab.url, title: fakeTab.title, active: true, current: true, browser: 'c1', agent: true }],
  resolveTarget: async (args) => {
    if (args.tab_id !== undefined) assert.equal(typeof args.tab_id, 'number', 'tab_id should be coerced to a number');
    return { conn: fakeConn, tab: fakeTab };
  },
  scan: async () => '<div id="ok">hello</div>',
  runScript: async () => ({ answer: 42 }),
  monitorStart: async () => ({ timeOrigin: 1, url: fakeTab.url }),
  monitorFinish: async () => ({
    timeOrigin: 1,
    url: fakeTab.url,
    transients: ['已保存'],
    diff: { changed: 2, added: 1, removed: 1, summary: '+1 -1', items: [{ change: '+', desc: 'div#ok' }] },
  }),
  refreshTabs: async () => {},
  syncTabs: async () => {},
  cdp: async (_target, method) =>
    method === 'Page.captureScreenshot'
      ? { data: Buffer.from('fake-png').toString('base64') }
      : { value: 'ok' },
  newTab: async () => ({ id: 9, url: 'http://new.test/', title: 'New' }),
  closeTab: async () => {},
  activateTab: async () => {},
  navigate: async (_target, url) => ({ url }),
  closeAgentTabs: async () => ({ closed: [9], skipped: [] }),
  act: async () => ({ ok: true, action: 'click', target: 'button#go', settled: true, changed: 1, waited_ms: 8 }),
  waitFor: async () => ({ ok: true, for: 'selector', waited_ms: 9, matched_text: '加载完成', url: fakeTab.url }),
  health: () => ({
    ok: true,
    server: { listening: true, host: '127.0.0.1', port: 18797, sessions: 1 },
    extension: { connected: true, sessions: 1, ready: true, agents: 1 },
    tabs: { total: 1, agent: 1, active: 1 },
    checks: [
      { name: 'WebSocket 服务', ok: true, detail: '127.0.0.1:18797' },
      { name: 'Chrome 扩展', ok: true, detail: '已连接' },
    ],
    hint: '',
  }),
};
const successful = new Map();
registerTools(
  { tools: { register(definition) { successful.set(definition.name, definition); return () => {}; } } },
  fakeDriver,
  { defaultMaxScanChars: 5000, monitor: true },
  { info: () => {} },
);
const exec = (tool, args) => successful.get(tool).execute(args, { signal: new AbortController().signal });

const scanOk = await exec('browser_scan', {});
assert.equal(scanOk.status, 'success');
assert.equal(scanOk.chars, '<div id="ok">hello</div>'.length);
assert.match(successful.get('browser_scan').output.render({}, scanOk)[0].text, /hello/);

// Models often echo a tab id back as a string; the schema accepts both.
const scanStringId = await exec('browser_scan', { tab_id: '7' });
assert.equal(scanStringId.status, 'success');
assert.equal(scanStringId.tab_id, 7);
const scanBadId = await exec('browser_scan', { tab_id: 'abc' });
assert.equal(scanBadId.status, 'error');
assert.match(scanBadId.error, /正整数/);

const jsOk = await exec('browser_execute_js', { code: 'return 42' });
assert.equal(jsOk.status, 'success');
assert.equal(jsOk.js_return_json, '{"answer":42}');
assert.deepEqual(jsOk.transients, ['已保存']);
assert.equal(jsOk.diff.changed, 2);
assert.equal(jsOk.diff.summary, '+1 -1');
assert.match(successful.get('browser_execute_js').output.render({}, jsOk)[0].text, /已保存/);

const actOk = await exec('browser_act', { action: 'click', target: '#go' });
assert.equal(actOk.status, 'success');
assert.equal(actOk.action, 'click');
assert.equal(actOk.changed, 1);
assert.equal(actOk.settled, true);
assert.match(successful.get('browser_act').output.render({}, actOk)[0].text, /button#go/);

const waitOk = await exec('browser_wait', { for: 'selector', selector: '#result' });
assert.equal(waitOk.status, 'ok');
assert.equal(waitOk.matched_text, '加载完成');
assert.match(successful.get('browser_wait').output.render({}, waitOk)[0].text, /等待成功/);

const healthOk = await exec('browser_tabs', { action: 'health' });
assert.equal(healthOk.action, 'health');
assert.match(healthOk.health_json, /"listening":true/);
assert.match(successful.get('browser_tabs').output.render({}, healthOk)[0].text, /扩展已连接/);

const closed = await exec('browser_tabs', { action: 'close_agent_tabs' });
assert.deepEqual(closed.closed, [9]);
assert.match(successful.get('browser_tabs').output.render({}, closed)[0].text, /已关闭 agent/);

const cdpOk = await exec('browser_cdp', { method: 'Runtime.evaluate' });
assert.equal(cdpOk.status, 'success');
assert.equal(cdpOk.result_json, '{"value":"ok"}');

const shot = await exec('browser_screenshot', {});
assert.equal(shot.status, 'success');
assert.ok(shot.bytes > 0);
await rm(shotDir, { recursive: true, force: true });

const opened = await exec('browser_tabs', { action: 'open', url: 'http://new.test/' });
assert.equal(opened.action, 'open');
assert.match(opened.new_tab_json, /new\.test/);

for (const dispose of disposers.reverse()) await dispose?.();
console.log('plugin test passed');
