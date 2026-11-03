// End-to-end test on a real headless Chrome with the bundled extension.
// Usage: node test/e2e-chrome.test.mjs
// Requires Google Chrome (CHROME env var overrides the default macOS path).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserDriver, delay } from '../lib/driver.js';
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
const downloadsDir = path.join(tmp, 'downloads');
await mkdir(downloadsDir, { recursive: true });
// chrome.downloads saves into the profile's download directory; point it at
// the temp dir so tests can verify the bytes on disk and clean up afterwards.
await mkdir(path.join(profileDir, 'Default'), { recursive: true });
await writeFile(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true },
}));
const realDownloadsDir = await realpath(downloadsDir);
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
  let tabs = driver.listTabs();
  // The extension may announce itself before chrome.tabs reports the startup
  // URL; give the initial tab a moment to appear instead of racing it.
  for (let i = 0; i < 50 && !tabs.some((tab) => tab.url.includes('/demo')); i += 1) {
    await delay(200);
    await driver.syncTabs();
    tabs = driver.listTabs();
  }
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
  // Safe destinations must survive the scan; only active-content schemes are
  // masked, otherwise an agent cannot tell where a link points.
  assert.match(html, /href="[^"]*ref=related-doc/, 'scan masked a safe link href');
  assert.ok(html.includes('href="__link__"'), 'javascript: href was not masked');
  assert.ok(!/href="javascript:/.test(html), 'javascript: href leaked into scan');
  console.log(`scan ok: ${html.length} chars (refs ${incrementRef})`);

  // text_only used to return before the cut-list pass, so cut_list was a no-op.
  const text = await driver.scan(target, { textOnly: true, cutList: true, maxChars: 12000 });
  assert.ok(text.includes('[FAKE ELEMENT]'), 'text_only scan ignored cut_list');
  assert.ok(text.includes('任务列表'), 'text_only scan missed the list heading');
  assert.ok(!text.includes('第 30 条'), 'cut_list did not hide the tail of the large list');
  // text_only used to ignore max_chars entirely (300 -> 900+ chars).
  const textCapped = await driver.scan(target, { textOnly: true, cutList: true, maxChars: 300 });
  assert.ok(textCapped.length <= 300, `text_only max_chars not enforced: ${textCapped.length}`);
  assert.ok(textCapped.includes('TRUNCATED') || textCapped.includes('…'), 'text_only cap has no marker');
  console.log(`text scan ok: ${text.length} chars (capped ${textCapped.length})`);

  // --- high-level actions + waits -----------------------------------------
  const fill = await driver.act(target, { action: 'fill', target: '#name-input', value: '韩梅梅' });
  assert.equal(fill.ok, true, `fill failed: ${JSON.stringify(fill)}`);
  assert.equal(fill.value, '韩梅梅');
  // Escape changes no DOM at all; the receipt must still show the live field
  // state instead of leaving the caller to guess whether it worked.
  const escape = await driver.act(target, { action: 'press', target: '#name-input', key: 'Escape' });
  assert.equal(escape.ok, true, `press failed: ${JSON.stringify(escape)}`);
  assert.ok(escape.state && escape.state.value === '韩梅梅', `press receipt missed the field state: ${JSON.stringify(escape)}`);
  const select = await driver.act(target, { action: 'select', target: '#role-select', value: 'qa' });
  assert.equal(select.ok, true, `select failed: ${JSON.stringify(select)}`);
  assert.equal(select.value, 'qa');
  // <select>.value is a property: no DOM mutation, but the action did change
  // the page and the receipt must say so.
  assert.ok(select.changed >= 1, `select reported no change: ${JSON.stringify(select)}`);
  assert.ok(select.propertyChanges >= 1, `select property change not counted: ${JSON.stringify(select)}`);
  assert.ok(select.state && select.state.value === 'qa', 'select receipt missed the effective value');
  const uncheck = await driver.act(target, { action: 'uncheck', target: '#subscribe-checkbox' });
  assert.equal(uncheck.ok, true, `uncheck failed: ${JSON.stringify(uncheck)}`);
  assert.ok(uncheck.state && uncheck.state.checked === false, 'uncheck receipt missed checked:false');
  assert.ok(uncheck.changed >= 1, `uncheck reported no change: ${JSON.stringify(uncheck)}`);
  const recheck = await driver.act(target, { action: 'check', target: '#subscribe-checkbox' });
  assert.equal(recheck.ok, true, `check failed: ${JSON.stringify(recheck)}`);
  assert.ok(recheck.state && recheck.state.checked === true, 'check receipt missed checked:true');
  assert.ok(recheck.changed >= 1, `check reported no change: ${JSON.stringify(recheck)}`);
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
  // Property flips raise no MutationObserver record; execute_js is often used
  // to drive controlled inputs, so the monitor diff must still surface them.
  await driver.monitorStart(target);
  const flipped = await driver.runScript(target,
    'const box = document.getElementById("subscribe-checkbox"); box.checked = false; return box.checked');
  assert.equal(flipped, false);
  const flipDiff = await driver.monitorFinish(target);
  assert.ok(flipDiff.diff && flipDiff.diff.changed >= 1, `monitor missed property change: ${JSON.stringify(flipDiff)}`);
  assert.ok(flipDiff.diff.summary.includes('~1'), `monitor summary missed the property count: ${flipDiff.diff.summary}`);
  assert.ok(flipDiff.diff.items.some((item) => item.change === '~'), 'monitor did not describe the property change');
  await driver.monitorStart(target);
  await driver.runScript(target, 'document.getElementById("subscribe-checkbox").checked = true;');
  const restoreDiff = await driver.monitorFinish(target);
  assert.ok(restoreDiff.diff && restoreDiff.diff.changed >= 1 && restoreDiff.diff.summary.includes('~1'),
    `monitor missed the restored property: ${JSON.stringify(restoreDiff.diff)}`);
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
  assert.ok(capped.includes('row 0') && capped.includes('填充文本'), `max_chars blanked the content: ${capped.slice(0, 200)}`);
  // Small budgets used to slice mid-tag, so every element came back empty
  // (<h3></h3>, <p></p>) with "[TRUNCATED 0k chars]". The tail must be dropped,
  // not the content.
  const tiny = await driver.scan(target, { maxChars: 1200, cutList: false });
  assert.ok(tiny.length <= 1200, `small max_chars not enforced: ${tiny.length}`);
  assert.ok(tiny.includes('row 0') && tiny.includes('填充文本'), `small max_chars returned a skeleton: ${tiny.slice(0, 300)}`);
  assert.ok(!/<(h3|p|section)[^>]*><\/\1>/.test(tiny), `small max_chars emptied elements: ${tiny.slice(0, 300)}`);
  // Sweep budgets so the cut lands inside every container shape. A container
  // whose content does not fit must be dropped whole, not emitted empty.
  await driver.runScript(target, `document.body.innerHTML = Array.from({ length: 120 }, (_, i) =>
    '<div class="row"><h3>item ' + i + '</h3><p>' + '文案 '.repeat(20) + '</p><span class="tag">tag ' + i + '</span></div>').join('');
    return 1;`);
  for (let budget = 480; budget <= 1200; budget += 37) {
    const out = await driver.scan(target, { maxChars: budget, cutList: false });
    assert.ok(out.length <= budget, `sweep ${budget}: length ${out.length} exceeds budget`);
    const empties = out.match(/<(div|h3|p|span)([^>]*)><\/\1>/g) || [];
    assert.equal(empties.length, 0, `sweep ${budget}: empty containers ${empties.slice(0, 3)}`);
  }
  console.log('truncation sweep ok');
  console.log(`max_chars ok: ${capped.length} chars (tiny ${tiny.length})`);

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

  // A <dialog>.showModal() only flips the `open` attribute. The settle observer
  // must count that, otherwise the action receipt says "0 changes" even though
  // the modal clearly opened.
  const dialogOpen = await driver.act(target, { action: 'click', target: '#open-dialog-btn' });
  assert.equal(dialogOpen.ok, true, `dialog click failed: ${JSON.stringify(dialogOpen)}`);
  assert.ok(dialogOpen.changed >= 1, `dialog open reported ${dialogOpen.changed} DOM changes`);
  assert.equal(await driver.runScript(target, 'return document.getElementById("confirm-dialog").open'), true);
  await driver.runScript(target, 'document.getElementById("confirm-dialog").close()');
  console.log('dialog settle ok');

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

  // A 17k-pixel-tall page must fail fast with a clear code rather than making
  // CDP allocate an oversized capture.
  await driver.runScript(target, `document.body.innerHTML = '<div id="tall" style="height:17000px"></div>'; return document.body.scrollHeight`);
  const tooLong = await tools.get('browser_screenshot').execute(
    { tab_id: target.tab.id, full_page: true },
    { signal: new AbortController().signal },
  );
  assert.equal(tooLong.status, 'error', `tall page screenshot unexpectedly succeeded: ${JSON.stringify(tooLong)}`);
  assert.match(tooLong.error, /SCREENSHOT_TOO_LARGE/);
  console.log('long page guard ok');

  // --- links: safe hrefs, javascript: masking, target=_blank clicks -------
  await driver.runScript(target, `document.body.innerHTML = [
    '<a id="blank-link" href="/demo?ref=related-doc&from=blank-link" target="_blank">新窗口</a>',
    '<a id="script-link" href="javascript:void(0)">脚本链接</a>'
  ].join(''); return document.body.innerHTML.length`);
  const linkScan = await tools.get('browser_scan').execute(
    { tab_id: target.tab.id, max_chars: 4000 },
    { signal: new AbortController().signal },
  );
  assert.equal(linkScan.status, 'success', linkScan.error);
  assert.match(linkScan.content, /href="[^"]*ref=related-doc/, 'safe href was masked in scan');
  assert.ok(linkScan.content.includes('href="__link__"'), 'javascript: href was not masked');
  const tabIdsBefore = new Set(driver.listTabs().map((tab) => tab.tab_id));
  const blankClick = await tools.get('browser_act').execute(
    { tab_id: target.tab.id, action: 'click', target: '#blank-link' },
    { signal: new AbortController().signal },
  );
  assert.equal(blankClick.status, 'success', `target=_blank click failed: ${JSON.stringify(blankClick)}`);
  assert.equal(blankClick.new_tabs.length, 1,
    `target=_blank click opened ${blankClick.new_tabs.length} tabs: ${JSON.stringify(blankClick.new_tabs)}`);
  assert.match(blankClick.new_tabs[0].url, /from=blank-link/);
  assert.match(blankClick.hint, /新标签页/);
  const openedId = blankClick.new_tabs[0].tab_id;
  assert.ok(!tabIdsBefore.has(openedId), 'new_tabs contained a pre-existing tab');
  // The action ran on the original page, so the default target must not follow
  // the background tab it opened.
  assert.equal(driver.current?.tab?.id, target.tab.id, 'current tab moved to the background popup');
  await driver.closeTab({ conn: target.conn, tab: { id: openedId } }).catch(() => {});
  console.log(`link ok: opened tab ${openedId} (${blankClick.new_tabs[0].url})`);

  // window.open() is blocked by the same popup blocker; the page tap reports it
  // and the tool opens it instead of silently doing nothing.
  await driver.runScript(target, `(() => {
    document.body.innerHTML = '<button id="blank-js-btn" type="button">JS 新窗口</button>';
    document.getElementById('blank-js-btn').addEventListener('click', () => {
      window.open('/demo?ref=js-open&from=window-open', '_blank');
    });
    return 1;
  })()`);
  const jsClick = await tools.get('browser_act').execute(
    { tab_id: target.tab.id, action: 'click', target: '#blank-js-btn' },
    { signal: new AbortController().signal },
  );
  assert.equal(jsClick.status, 'success', `window.open click failed: ${JSON.stringify(jsClick)}`);
  assert.equal(jsClick.new_tabs.length, 1,
    `window.open click opened ${jsClick.new_tabs.length} tabs: ${JSON.stringify(jsClick.new_tabs)}`);
  assert.match(jsClick.new_tabs[0].url, /from=window-open/);
  assert.match(jsClick.hint, /window\.open\(\)/);
  await driver.closeTab({ conn: target.conn, tab: { id: jsClick.new_tabs[0].tab_id } }).catch(() => {});
  console.log(`window.open ok: opened tab ${jsClick.new_tabs[0].tab_id} (${jsClick.new_tabs[0].url})`);

  // window.open blocked + page falls back to navigating the same tab: the popup
  // fallback must not open a duplicate background tab for the same URL.
  await driver.runScript(target, `(() => {
    document.body.innerHTML = '<button id="fallback-btn" type="button">回退同标签</button>';
    document.getElementById('fallback-btn').addEventListener('click', () => {
      const opened = window.open('/demo?ref=blocked-popup', '_blank');
      if (!opened) history.replaceState(null, '', '/demo?ref=blocked-popup&from=same-tab');
    });
    return 1;
  })()`);
  const fallbackClick = await tools.get('browser_act').execute(
    { tab_id: target.tab.id, action: 'click', target: '#fallback-btn' },
    { signal: new AbortController().signal },
  );
  assert.equal(fallbackClick.status, 'success', `same-tab fallback click failed: ${JSON.stringify(fallbackClick)}`);
  assert.equal(fallbackClick.new_tabs.length, 0,
    `same-tab fallback duplicated the popup: ${JSON.stringify(fallbackClick.new_tabs)}`);
  await driver.runScript(target, `history.replaceState(null, '', '/demo?restored=1')`);
  console.log('same-tab fallback ok');
  console.log('screenshot ok');
  console.log('cdp ok');

  // --- async window.open: click → setTimeout → window.open ---------------
  // The tap must stay resident: by the time setTimeout fires, browser_act has
  // already returned, so only the page→extension bridge can open the tab.
  await driver.runScript(target, `(() => {
    document.body.innerHTML = '<button id="async-open-btn" type="button">异步新窗口</button><p id="async-open-status">未触发</p>';
    window.__asyncOpenCalled = 0;
    window.__asyncOpenDone = 0;
    window.__asyncOpenResult = 'unset';
    document.getElementById('async-open-btn').addEventListener('click', () => {
      window.__asyncOpenCalled += 1;
      setTimeout(() => {
        window.__asyncOpenDone += 1;
        window.__asyncOpenResult = window.open('/demo?ref=async-open&from=setTimeout-window-open', '_blank') ? 'proxy' : 'null';
      }, 300);
    });
    return 1;
  })()`);
  await driver.syncTabs();
  const asyncPopupClick = await tools.get('browser_act').execute(
    { tab_id: target.tab.id, action: 'click', target: '#async-open-btn', await_popup_ms: 3000 },
    { signal: new AbortController().signal },
  );
  assert.equal(asyncPopupClick.status, 'success', `async window.open click failed: ${JSON.stringify(asyncPopupClick)}`);
  assert.equal(asyncPopupClick.new_tabs.length, 1,
    `async window.open opened ${asyncPopupClick.new_tabs.length} tabs: ${JSON.stringify(asyncPopupClick.new_tabs)}`);
  assert.match(asyncPopupClick.new_tabs[0].url, /from=setTimeout-window-open/);
  assert.match(asyncPopupClick.hint, /异步|新标签页/);
  const asyncFlags = await driver.runScript(target, `return {
    called: window.__asyncOpenCalled,
    done: window.__asyncOpenDone,
    result: window.__asyncOpenResult,
  }`);
  assert.equal(asyncFlags.called, 1, 'click handler did not run');
  assert.equal(asyncFlags.done, 1, 'setTimeout callback did not reach window.open');
  assert.equal(asyncFlags.result, 'null', 'window.open should still return null in the page');
  await driver.syncTabs();
  assert.equal(
    driver.listTabs().filter((tab) => tab.url.includes('from=setTimeout-window-open')).length,
    1,
    `async popup was opened more than once: ${JSON.stringify(driver.listTabs())}`,
  );
  await driver.closeTab({ conn: target.conn, tab: { id: asyncPopupClick.new_tabs[0].tab_id } }).catch(() => {});
  console.log(`async window.open ok: ${asyncPopupClick.new_tabs[0].tab_id}`);

  // A popup fired by plain page code (no browser_act at all) must also land:
  // that is what proves the patch is resident rather than action-scoped.
  await driver.runScript(target, `window.open('/demo?ref=resident-bridge&from=plain-script', '_blank'); return 1`);
  let residentTab = null;
  for (let i = 0; i < 20 && !residentTab; i += 1) {
    await delay(150);
    await driver.syncTabs();
    residentTab = driver.listTabs().find((tab) => tab.url.includes('from=plain-script'));
  }
  assert.ok(residentTab, `resident window.open patch did not open a tab: ${JSON.stringify(driver.listTabs())}`);
  await driver.closeTab({ conn: target.conn, tab: { id: residentTab.tab_id } }).catch(() => {});
  console.log(`resident window.open ok: ${residentTab.tab_id}`);

  // --- upload -------------------------------------------------------------
  await driver.runScript(target, `(() => {
    document.body.innerHTML = '<input id="file-input" type="file" multiple accept=".txt,.json"><p id="file-status">未选择文件</p>';
    document.getElementById('file-input').addEventListener('change', (event) => {
      const files = Array.from(event.target.files || []);
      document.getElementById('file-status').textContent = '已选择 ' + files.map((file) => file.name + ':' + file.size).join(', ');
    });
    return 1;
  })()`);
  const uploadContent = 'hello from browser_upload\n';
  const uploadFile = path.join(tmp, 'upload-fixture.txt');
  await writeFile(uploadFile, uploadContent);
  const uploaded = await tools.get('browser_upload').execute(
    { tab_id: target.tab.id, target: '#file-input', files: [uploadFile] },
    { signal: new AbortController().signal },
  );
  assert.equal(uploaded.status, 'success', `upload failed: ${JSON.stringify(uploaded)}`);
  assert.equal(uploaded.count, 1, `upload reported ${uploaded.count} files`);
  assert.equal(uploaded.files[0], 'upload-fixture.txt');
  assert.equal(uploaded.changed, true, 'change event did not run after upload');
  const uploadState = await driver.runScript(target, `const input = document.getElementById('file-input');
return {
  name: input.files[0] && input.files[0].name,
  size: input.files[0] && input.files[0].size,
  status: document.getElementById('file-status').textContent,
  marked: input.hasAttribute('data-dsh-upload-mark'),
};`);
  assert.equal(uploadState.name, 'upload-fixture.txt');
  assert.equal(uploadState.size, Buffer.byteLength(uploadContent));
  assert.match(uploadState.status, /upload-fixture\.txt:/);
  assert.equal(uploadState.marked, false, 'upload mark leaked into the page');
  const badUpload = await tools.get('browser_upload').execute(
    { tab_id: target.tab.id, target: '#file-status', files: [uploadFile] },
    { signal: new AbortController().signal },
  );
  assert.equal(badUpload.status, 'error', `non-file target upload unexpectedly succeeded: ${JSON.stringify(badUpload)}`);
  assert.match(badUpload.error, /不是 <input type="file">/);
  console.log(`upload ok: ${uploaded.files_json}`);

  // --- download -----------------------------------------------------------
  const downloadUrl = `http://127.0.0.1:${PORT}/download?name=agent-download.txt&bytes=777`;
  const dl = await tools.get('browser_download').execute(
    { tab_id: target.tab.id, action: 'url', url: downloadUrl, timeout_ms: 15000 },
    { signal: new AbortController().signal },
  );
  assert.equal(dl.status, 'success', `download url failed: ${JSON.stringify(dl)}`);
  assert.equal(dl.bytes, 777, `download reported ${dl.bytes} bytes`);
  assert.equal(dl.state, 'complete');
  assert.ok(dl.filename.endsWith('agent-download.txt'), `unexpected filename: ${dl.filename}`);
  const dlDir = path.dirname(dl.filename);
  assert.ok(dlDir === downloadsDir || dlDir === realDownloadsDir, `download went to ${dlDir}`);
  assert.equal((await readFile(dl.filename)).length, 777);

  // Page-triggered download: click an anchor, then wait for the task.
  await driver.runScript(target, `(() => {
    document.body.innerHTML = '<a id="download-link" href="/download?name=clicked.txt&bytes=321" download="clicked.txt">下载</a>';
    return 1;
  })()`);
  const dlClick = await tools.get('browser_download').execute(
    { tab_id: target.tab.id, action: 'click', target: '#download-link', timeout_ms: 15000 },
    { signal: new AbortController().signal },
  );
  assert.equal(dlClick.status, 'success', `download click failed: ${JSON.stringify(dlClick)}`);
  assert.equal(dlClick.bytes, 321);
  assert.match(dlClick.filename, /clicked\.txt$/);
  assert.equal((await readFile(dlClick.filename)).length, 321);

  const dlList = await tools.get('browser_download').execute(
    { tab_id: target.tab.id, action: 'list', limit: 5 },
    { signal: new AbortController().signal },
  );
  assert.equal(dlList.status, 'success', `download list failed: ${JSON.stringify(dlList)}`);
  assert.match(dlList.downloads_json, /clicked\.txt/);
  console.log(`download ok: ${dl.filename}, ${dlClick.filename}`);

  // --- demo page's own upload/download/async controls ---------------------
  // Everything above used elements injected by the test; this pass drives the
  // fixture page exactly like a user would (README tells people to open /demo).
  await driver.navigate(target, `http://127.0.0.1:${PORT}/demo`);
  const uploadSecond = path.join(tmp, 'upload-second.json');
  await writeFile(uploadSecond, '{"ok":true}');
  const demoUpload = await tools.get('browser_upload').execute(
    { tab_id: target.tab.id, target: '#file-input', files: [uploadFile, uploadSecond] },
    { signal: new AbortController().signal },
  );
  assert.equal(demoUpload.status, 'success', `demo upload failed: ${JSON.stringify(demoUpload)}`);
  assert.equal(demoUpload.accept, '.txt,.json,.png');
  assert.equal(demoUpload.multiple, true);
  assert.equal(demoUpload.count, 2, `multi-file upload reported ${demoUpload.count} files`);
  assert.deepEqual(demoUpload.files, ['upload-fixture.txt', 'upload-second.json']);
  const demoUploadStatus = await driver.runScript(target,
    `return document.getElementById('file-status').textContent`);
  assert.match(demoUploadStatus, /已选择: upload-fixture\.txt \(26B, text\/plain\), upload-second\.json \(11B, application\/json\)/);

  const demoAsync = await tools.get('browser_act').execute(
    { tab_id: target.tab.id, action: 'click', target: '#async-open-btn', await_popup_ms: 3000 },
    { signal: new AbortController().signal },
  );
  assert.equal(demoAsync.status, 'success', `demo async popup click failed: ${JSON.stringify(demoAsync)}`);
  assert.equal(demoAsync.new_tabs.length, 1,
    `demo async popup opened ${demoAsync.new_tabs.length} tabs: ${JSON.stringify(demoAsync.new_tabs)}`);
  assert.match(demoAsync.new_tabs[0].url, /from=setTimeout-window-open/);
  const demoAsyncState = await driver.runScript(target, `return {
    called: window.__asyncOpenCalled,
    done: window.__asyncOpenDone,
    status: document.getElementById('async-open-status').textContent,
  }`);
  assert.equal(demoAsyncState.called, 1);
  assert.equal(demoAsyncState.done, 1);
  assert.match(demoAsyncState.status, /返回 null/);
  await driver.closeTab({ conn: target.conn, tab: { id: demoAsync.new_tabs[0].tab_id } }).catch(() => {});
  const demoDl = await tools.get('browser_download').execute(
    { tab_id: target.tab.id, action: 'click', target: '#download-btn', timeout_ms: 15000 },
    { signal: new AbortController().signal },
  );
  assert.equal(demoDl.status, 'success', `demo download failed: ${JSON.stringify(demoDl)}`);
  assert.equal(demoDl.bytes, 3072);
  assert.match(demoDl.filename, /js-download\.txt$/);
  assert.equal((await readFile(demoDl.filename)).length, 3072);

  console.log(`demo page ok: upload/download/async (${demoDl.filename})`);

  // --- chrome-extension:// pages -----------------------------------------
  await driver.newTab(`chrome-extension://${loaded.id}/popup.html`, true);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await driver.syncTabs();
  const extTab = driver.listTabs().find((tab) => tab.url.startsWith('chrome-extension://'));
  assert.ok(extTab, `extension page missing from tabs: ${JSON.stringify(driver.listTabs())}`);
  const extTarget = await driver.resolveTarget({ tab_id: extTab.tab_id });
  const extVersion = await driver.runScript(extTarget, 'return window.__DSH_BROWSER__ ? window.__DSH_BROWSER__.version : null');
  assert.equal(extVersion, 13);
  const extHtml = await driver.scan(extTarget, { maxChars: 4000 });
  assert.ok(/Cookies|浏览器服务|DSH/.test(extHtml), `unexpected extension page scan: ${extHtml.slice(0, 300)}`);
  const extShot = await driver.cdp(extTarget, 'Page.captureScreenshot', { format: 'png' });
  assert.ok(extShot?.data?.length > 1000, 'extension page screenshot failed');
  console.log(`extension page ok: ${extHtml.length} chars`);

  console.log('e2e chrome test passed');
} finally {
  await cleanup();
}
