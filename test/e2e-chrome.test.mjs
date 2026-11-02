// End-to-end test on a real headless Chrome with the bundled extension.
// Usage: node test/e2e-chrome.test.mjs
// Requires Google Chrome (CHROME env var overrides the default macOS path).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserDriver } from '../lib/driver.js';
import { registerTools } from '../lib/tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 18793;
const logs = [];
const logger = { info: (msg) => { logs.push(msg); if (process.env.VERBOSE) console.log(msg); }, warn: (msg) => { logs.push(msg); console.warn(msg); } };

const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-browser-e2e-'));
const extDir = path.join(tmp, 'extension');
const profileDir = path.join(tmp, 'profile');
await cp(path.join(ROOT, 'extension'), extDir, { recursive: true });
await mkdir(profileDir, { recursive: true });
const configPath = path.join(extDir, 'config.js');
const configText = await readFile(configPath, 'utf8');
await writeFile(configPath, configText.replace(/WS_PORT = \d+/, `WS_PORT = ${PORT}`));

const driver = new BrowserDriver({ port: PORT, timeoutMs: 20000, logger, screenshotDir: path.join(tmp, 'shots') });
await driver.start();

// Chrome 137+ removed --load-extension from branded builds. The supported
// replacement is Extensions.loadUnpacked over --remote-debugging-pipe (fds 3/4).
const chrome = spawn(CHROME, [
  '--headless=new',
  `--user-data-dir=${profileDir}`,
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=1200,900',
  `http://127.0.0.1:${PORT}/demo`,
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (chunk) => { chromeErr += chunk.toString(); });

function pipeRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let end = buffer.indexOf('\0');
      while (end !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf('\0');
        let message;
        try { message = JSON.parse(raw); } catch { continue; }
        if (message.id !== id) continue;
        chrome.stdio[4].off('data', onData);
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
        return;
      }
    };
    const timer = setTimeout(() => {
      chrome.stdio[4].off('data', onData);
      reject(new Error(`${method} timed out`));
    }, 10000);
    chrome.stdio[4].on('data', onData);
    chrome.stdio[3].write(`${JSON.stringify({ id, method, params })}\0`);
  });
}

const loaded = await pipeRequest('Extensions.loadUnpacked', { path: extDir });
assert.ok(loaded && loaded.id, `Extensions.loadUnpacked failed: ${JSON.stringify(loaded)}`);

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch { /* ignore */ }
  return driver.stop().finally(() =>
    rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {}));
}

try {
  const connected = await driver.waitForConnection(25000);
  assert.equal(connected, true, `extension did not connect\nchrome stderr:\n${chromeErr.slice(-4000)}`);

  await driver.syncTabs();
  const tabs = driver.listTabs();
  assert.ok(tabs.some((tab) => tab.url.includes('/demo')), `demo tab missing: ${JSON.stringify(tabs)}`);

  const target = await driver.resolveTarget({ url: '/demo' });
  assert.equal(target.tab.id, tabs.find((tab) => tab.url.includes('/demo')).tab_id);

  // --- scan ---------------------------------------------------------------
  const html = await driver.scan(target, { maxChars: 12000, cutList: true });
  assert.ok(html.includes('自检页面') || html.includes('DSH Browser Control'), 'scan misses page heading');
  assert.ok(html.includes('increment-btn') || html.includes('点击 +1'), 'scan misses interactive button');
  assert.ok(html.includes('[FAKE ELEMENT]'), 'large list was not cut down');
  assert.ok(html.includes('value="李雷"'), 'scan should expose the current input value');
  assert.ok(html.includes('默认备注'), 'scan should expose textarea content');
  assert.ok(html.includes('checked'), 'scan should expose checkbox checked state');
  assert.ok(!html.includes('ljq_driver'), 'plugin status badge leaked into scan');
  const refOf = (markup, id) => {
    const tag = markup.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0] || '';
    return tag.match(/data-dsh-ref="(@e\d+)"/)?.[1] || '';
  };
  const incrementRef = refOf(html, 'increment-btn');
  assert.ok(incrementRef, 'interactive button has no data-dsh-ref');
  const resetRef = refOf(html, 'reset-btn');
  assert.ok(resetRef, 'reset button has no ref');
  const rescan = await driver.scan(target, { maxChars: 12000, cutList: true });
  assert.equal(refOf(rescan, 'increment-btn'), incrementRef, 'ref changed for the same element across scans');
  assert.ok((rescan.match(/data-dsh-ref=/g) || []).length >= 5, 'too few refs assigned');
  console.log(`scan ok: ${html.length} chars (refs ${incrementRef})`);

  // text_only used to return before the cut-list pass, so cut_list was a no-op.
  const text = await driver.scan(target, { textOnly: true, cutList: true, maxChars: 12000 });
  assert.ok(text.includes('[FAKE ELEMENT]'), 'text_only scan ignored cut_list');
  assert.ok(text.includes('任务列表'), 'text_only scan missed the list heading');
  assert.ok(!text.includes('第 30 条'), 'cut_list did not hide the tail of the large list');
  console.log(`text scan ok: ${text.length} chars`);

  // --- high-level actions + waits -----------------------------------------
  const fill = await driver.act(target, { action: 'fill', target: '#name-input', value: '韩梅梅' });
  assert.equal(fill.ok, true, `fill failed: ${JSON.stringify(fill)}`);
  assert.equal(fill.value, '韩梅梅');
  const select = await driver.act(target, { action: 'select', target: '#role-select', value: 'qa' });
  assert.equal(select.ok, true, `select failed: ${JSON.stringify(select)}`);
  assert.equal(select.value, 'qa');
  const noteFill = await driver.act(target, { action: 'fill', target: '#note-input', value: '已备注' });
  assert.equal(noteFill.ok, true, `textarea fill failed: ${JSON.stringify(noteFill)}`);
  assert.equal(noteFill.value, '已备注');
  const submitted = await driver.act(target, { action: 'click', target: '#submit-btn' });
  assert.equal(submitted.ok, true, `click failed: ${JSON.stringify(submitted)}`);
  const formWait = await driver.waitFor(target, { for: 'text', text: '已提交：韩梅梅 / qa', timeoutMs: 3000 });
  assert.equal(formWait.ok, true, `form text wait failed: ${JSON.stringify(formWait)}`);

  const resetByRef = await driver.act(target, { action: 'click', target: `ref=${resetRef.replace('@', '')}` });
  assert.equal(resetByRef.ok, true, `ref= click failed: ${JSON.stringify(resetByRef)}`);
  const clickIncrement = await driver.act(target, { action: 'click', target: incrementRef });
  assert.equal(clickIncrement.ok, true, `increment click failed: ${JSON.stringify(clickIncrement)}`);
  assert.ok(clickIncrement.changed >= 1, 'click did not report DOM changes');
  assert.ok(clickIncrement.waited_ms <= 1000, `settle took too long: ${clickIncrement.waited_ms}ms`);
  assert.equal(await driver.runScript(target, 'return document.getElementById("count").textContent'), '1');

  const asyncClick = await driver.act(target, { action: 'click', target: '#async-btn' });
  assert.equal(asyncClick.ok, true, `async click failed: ${JSON.stringify(asyncClick)}`);
  const asyncWait = await driver.waitFor(target, { for: 'text', text: '加载完成', timeoutMs: 4000 });
  assert.equal(asyncWait.ok, true, `async text wait failed: ${JSON.stringify(asyncWait)}`);

  const missingWait = await driver.waitFor(target, { for: 'selector', selector: '#not-there', timeoutMs: 300 });
  assert.equal(missingWait.ok, false);
  assert.equal(missingWait.code, 'WAIT_TIMEOUT');
  console.log(`act/wait ok (click settle ${clickIncrement.waited_ms}ms)`);

  // --- execute JS ---------------------------------------------------------
  const initial = await driver.runScript(target, 'return document.getElementById("count").textContent');
  assert.equal(initial, '1');
  const afterClick = await driver.runScript(target,
    'document.getElementById("increment-btn").click(); return document.getElementById("count").textContent');
  assert.equal(afterClick, '2');

  const asyncValue = await driver.runScript(target,
    'return await new Promise((resolve) => setTimeout(() => resolve("awaited"), 50))');
  assert.equal(asyncValue, 'awaited');
  console.log('execute ok');

  // --- monitor ------------------------------------------------------------
  await driver.monitorStart(target);
  await driver.runScript(target, 'document.getElementById("async-btn").click();');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const monitor = await driver.monitorFinish(target);
  assert.ok(JSON.stringify(monitor.transients).includes('加载'), `monitor missed transient text: ${JSON.stringify(monitor)}`);
  assert.ok(monitor.diff && monitor.diff.changed >= 1, 'monitor diff empty');
  assert.equal(typeof monitor.diff.summary, 'string');
  assert.ok(Array.isArray(monitor.diff.items));
  assert.equal('top_change' in monitor.diff, false, 'monitor should return a compact diff, not raw HTML');
  console.log('monitor ok');

  // A ref is bound to the element instance: removing it must fail loudly, not
  // silently resolve a different element. Done after monitor because the
  // monitor case still clicks #async-btn.
  const asyncRef = refOf(html, 'async-btn');
  assert.ok(asyncRef, 'async button has no ref');
  await driver.runScript(target, 'document.getElementById("async-btn").remove()');
  const stale = await driver.act(target, { action: 'click', target: asyncRef });
  assert.equal(stale.ok, false, `stale ref unexpectedly worked: ${JSON.stringify(stale)}`);
  assert.equal(stale.code, 'REF_STALE');
  console.log('ref ok');

  // --- max_chars hard cap -------------------------------------------------
  await driver.runScript(target, `
    document.body.innerHTML = '<div id="big">' + Array.from({ length: 80 }, (_, i) =>
      '<section class="row"><h3>row ' + i + '</h3><p>' + '填充文本 '.repeat(60) + '</p></section>').join('') + '</div>';
    return true;
  `);
  const capped = await driver.scan(target, { maxChars: 3000, cutList: false });
  assert.ok(capped.length <= 3000, `max_chars not enforced: ${capped.length}`);
  assert.ok(capped.includes('TRUNCATED') || capped.includes('…'), 'no truncation marker');
  console.log(`max_chars ok: ${capped.length} chars`);

  // --- tabs ---------------------------------------------------------------
  const created = await driver.newTab(`http://127.0.0.1:${PORT}/demo?second=1`, true);
  assert.ok(created && created.id, 'tab create returned no id');
  assert.ok(String(created.url || '').includes('second=1'), `tab create returned no url: ${JSON.stringify(created)}`);
  assert.ok(String(created.title || '').length > 0, `tab create returned no title: ${JSON.stringify(created)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await driver.syncTabs();
  assert.ok(driver.listTabs().length >= 2, 'second tab not registered');
  assert.equal(driver.listTabs().find((tab) => tab.tab_id === created.id)?.agent, true, 'new tab not marked agent-owned');
  const second = await driver.resolveTarget({ tab_id: created.id });
  await driver.closeTab(second);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await driver.syncTabs();
  assert.equal(driver.listTabs().some((tab) => tab.tab_id === created.id), false, 'tab still listed after close');

  const health = driver.health();
  assert.equal(health.ok, true);
  assert.equal(health.extension.connected, true);
  assert.ok(health.tabs.total >= 1);
  console.log('tabs ok');

  // --- navigate -----------------------------------------------------------
  // Relative URLs are resolved, and the query string must arrive byte-for-byte
  // (the original bug encoded "&" as "%26").
  const rawUrl = `http://127.0.0.1:${PORT}/demo?status=reviewed&td_key=2026102000179`;
  const navigated = await driver.navigate(target, rawUrl);
  assert.equal(navigated.url, rawUrl);
  assert.equal(await driver.runScript(target, 'return location.search'), '?status=reviewed&td_key=2026102000179');

  const relative = await driver.navigate(target, '/demo?rel=1&two=2');
  assert.equal(relative.url, `http://127.0.0.1:${PORT}/demo?rel=1&two=2`);
  assert.equal(await driver.runScript(target, 'return location.search'), '?rel=1&two=2');
  console.log('navigate ok');

  // --- CDP + screenshot ---------------------------------------------------
  const shot = await driver.cdp(target, 'Page.captureScreenshot', { format: 'png' });
  assert.ok(shot && typeof shot.data === 'string' && shot.data.length > 1000, 'screenshot returned no base64 data');
  await mkdir(path.join(tmp, 'shots'), { recursive: true });
  const shotPath = path.join(tmp, 'shots', 'page.png');
  await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
  const meta = await driver.cdp(target, 'Page.getLayoutMetrics');
  assert.ok(meta && meta.cssVisualViewport, 'CDP layout metrics missing');

  // Tool-level screenshot: full page + plugin badge hidden/restored.
  const tools = new Map();
  registerTools(
    { tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } } },
    driver,
    { defaultMaxScanChars: 12000, monitor: true },
    { info: () => {} },
  );
  const fullShot = await tools.get('browser_screenshot').execute(
    { tab_id: target.tab.id, full_page: true },
    { signal: new AbortController().signal },
  );
  assert.equal(fullShot.status, 'success', `full-page screenshot failed: ${fullShot.error}`);
  assert.equal(fullShot.full_page, true);
  assert.ok(fullShot.width > 0 && fullShot.height > 500, `bad full-page size: ${fullShot.width}x${fullShot.height}`);
  const png = await readFile(fullShot.path);
  assert.equal(png.readUInt32BE(16), fullShot.width, 'full-page PNG width mismatch');
  assert.equal(png.readUInt32BE(20), fullShot.height, 'full-page PNG height mismatch');
  const badgeState = await driver.runScript(target, `(() => ({
    pending: document.querySelectorAll('[data-dsh-prev-visibility]').length,
    hidden: [...document.querySelectorAll('[data-dsh-ui="1"],#dsh-browser-badge')].filter((el) => el.style.visibility === 'hidden').length,
  }))()`);
  assert.equal(badgeState.pending, 0, 'badge visibility marker was not cleaned up');
  assert.equal(badgeState.hidden, 0, 'badge stayed hidden after screenshot');
  console.log('screenshot ok');
  console.log('cdp ok');

  // --- chrome-extension:// pages -----------------------------------------
  await driver.newTab(`chrome-extension://${loaded.id}/popup.html`, true);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await driver.syncTabs();
  const extTab = driver.listTabs().find((tab) => tab.url.startsWith('chrome-extension://'));
  assert.ok(extTab, `extension page missing from tabs: ${JSON.stringify(driver.listTabs())}`);
  const extTarget = await driver.resolveTarget({ tab_id: extTab.tab_id });
  const extVersion = await driver.runScript(extTarget, 'return window.__DSH_BROWSER__ ? window.__DSH_BROWSER__.version : null');
  assert.equal(extVersion, 6);
  const extHtml = await driver.scan(extTarget, { maxChars: 4000 });
  assert.ok(/Cookies|浏览器服务|DSH/.test(extHtml), `unexpected extension page scan: ${extHtml.slice(0, 300)}`);
  const extShot = await driver.cdp(extTarget, 'Page.captureScreenshot', { format: 'png' });
  assert.ok(extShot?.data?.length > 1000, 'extension page screenshot failed');
  console.log(`extension page ok: ${extHtml.length} chars`);

  console.log('e2e chrome test passed');
} finally {
  await cleanup();
}
