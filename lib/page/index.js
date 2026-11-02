// Builds the self-contained page runtime that is injected into the controlled
// tab. The browser-side sources are plain scripts (no imports) so they can be
// concatenated and evaluated inside the page.
//
// While debugging, edit lib/page/*.js and restart the plugin — no build step.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGE_VERSION = 5;
export const NEED_INJECT = '__DSH_NEED_INJECT__';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readPage(name) {
  return readFileSync(path.join(HERE, name), 'utf8');
}

export function pageBundle() {
  return [
    readPage('opt_html.js'),
    readPage('find_main_list.js'),
    readPage('scan_runtime.js'),
    readPage('actions.js'),
  ].join('\n');
}

/** Expression that evaluates to the injected API or the NEED_INJECT sentinel. */
export function PAGE_GUARD(expression) {
  return `(window.__DSH_BROWSER__ && window.__DSH_BROWSER__.version === ${PAGE_VERSION}) ? (${expression}) : ${JSON.stringify(NEED_INJECT)}`;
}

export function injectSource() {
  return `(function () {
${pageBundle()}
window.__DSH_BROWSER__ = {
  version: ${PAGE_VERSION},
  scan: dshScanPage,
  startMonitor: dshStartMonitor,
  finishMonitor: dshFinishMonitor,
  act: dshAct,
  waitFor: dshWaitFor,
  settle: dshSettle,
};
dshInstallNetHooks();
return true;
})()`;
}
