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
  return driver.stop().finally(() => rm(tmp, { recursive: true, force: true }));
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
  console.log(`scan ok: ${html.length} chars`);

  // --- execute JS ---------------------------------------------------------
  const initial = await driver.runScript(target, 'return document.getElementById("count").textContent');
  assert.equal(initial, '0');
  const afterClick = await driver.runScript(target,
    'document.getElementById("increment-btn").click(); return document.getElementById("count").textContent');
  assert.equal(afterClick, '1');

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
  console.log('monitor ok');

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
  await new Promise((resolve) => setTimeout(resolve, 300));
  await driver.syncTabs();
  assert.ok(driver.listTabs().length >= 2, 'second tab not registered');
  const second = await driver.resolveTarget({ tab_id: created.id });
  await driver.closeTab(second);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await driver.syncTabs();
  assert.equal(driver.listTabs().some((tab) => tab.tab_id === created.id), false, 'tab still listed after close');
  console.log('tabs ok');

  // --- navigate -----------------------------------------------------------
  await driver.navigate(target, `http://127.0.0.1:${PORT}/demo?navigated=1`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const navigated = await driver.runScript(target, 'return location.search');
  assert.equal(navigated, '?navigated=1');
  console.log('navigate ok');

  // --- CDP + screenshot ---------------------------------------------------
  const shot = await driver.cdp(target, 'Page.captureScreenshot', { format: 'png' });
  assert.ok(shot && typeof shot.data === 'string' && shot.data.length > 1000, 'screenshot returned no base64 data');
  await mkdir(path.join(tmp, 'shots'), { recursive: true });
  const shotPath = path.join(tmp, 'shots', 'page.png');
  await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
  const meta = await driver.cdp(target, 'Page.getLayoutMetrics');
  assert.ok(meta && meta.cssVisualViewport, 'CDP layout metrics missing');
  console.log('cdp ok');

  // --- chrome-extension:// pages -----------------------------------------
  await driver.newTab(`chrome-extension://${loaded.id}/popup.html`, true);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await driver.syncTabs();
  const extTab = driver.listTabs().find((tab) => tab.url.startsWith('chrome-extension://'));
  assert.ok(extTab, `extension page missing from tabs: ${JSON.stringify(driver.listTabs())}`);
  const extTarget = await driver.resolveTarget({ tab_id: extTab.tab_id });
  const extVersion = await driver.runScript(extTarget, 'return window.__DSH_BROWSER__ ? window.__DSH_BROWSER__.version : null');
  assert.equal(extVersion, 3);
  const extHtml = await driver.scan(extTarget, { maxChars: 4000 });
  assert.ok(/Cookies|浏览器服务|DSH/.test(extHtml), `unexpected extension page scan: ${extHtml.slice(0, 300)}`);
  const extShot = await driver.cdp(extTarget, 'Page.captureScreenshot', { format: 'png' });
  assert.ok(extShot?.data?.length > 1000, 'extension page screenshot failed');
  console.log(`extension page ok: ${extHtml.length} chars`);

  console.log('e2e chrome test passed');
} finally {
  await cleanup();
}
