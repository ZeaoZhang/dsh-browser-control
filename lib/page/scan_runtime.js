// In-page scan pipeline, ported from GenericAgent's simphtml.get_html /
// execute_js_rich. Runs inside the browser, so no Node APIs are available.
// Every symbol is prefixed with dsh* to avoid clashing with page globals.

function dshDirectText(el) {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) text += node.textContent.trim();
  }
  return text;
}

function dshSignature(el) {
  const attrs = [];
  for (const attr of Array.from(el.attributes)) {
    if (attr.name === 'data-track-id' || attr.name.startsWith('data-dsh-')) continue;
    attrs.push(attr.name + '=' + attr.value);
  }
  attrs.sort();
  return el.tagName + ':' + attrs.join('&') + ':' + dshDirectText(el);
}

function dshCollectElements(root) {
  const out = [root];
  if (!root || !root.querySelectorAll) return out;
  for (const el of Array.from(root.querySelectorAll('*'))) out.push(el);
  return out;
}

function dshBuildSigs(root) {
  const map = new Map();
  for (const el of dshCollectElements(root)) {
    const sig = dshSignature(el);
    map.set(sig, (map.get(sig) || 0) + 1);
  }
  return map;
}

const DSH_ATTR_ALLOW = new Set([
  'id', 'class', 'name', 'src', 'href', 'alt', 'value', 'type', 'placeholder',
  'disabled', 'checked', 'selected', 'readonly', 'required', 'multiple', 'role',
  'aria-label', 'aria-expanded', 'aria-hidden', 'contenteditable', 'title', 'for',
  'action', 'method', 'target', 'colspan', 'rowspan',
  'aria-checked', 'aria-selected', 'aria-pressed', 'aria-disabled', 'data-selected',
  'data-autofilled', 'data-dsh-ref',
]);

// javascript:/data:/vbscript: hrefs can run code if the value is ever handed
// back to the page; everything else (http(s), mailto:, relative, #, ?) is a
// plain destination and is kept verbatim for the agent.
function dshSafeHref(value) {
  const href = String(value == null ? '' : value).trim();
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (!match) return true;
  const scheme = match[1].toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel';
}

function dshOptimizeHtml(root) {
  for (const svg of Array.from(root.querySelectorAll('svg'))) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    for (const name of Array.from(svg.getAttributeNames())) svg.removeAttribute(name);
  }
  for (const tag of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (!tag.getAttributeNames) continue;
    tag.removeAttribute('style');
    if (tag.getAttribute('data-dsh-ui') === '1') { tag.remove(); continue; }
    const src = tag.getAttribute('src');
    if (src !== null) {
      if (src.startsWith('data:')) tag.setAttribute('src', '__img__');
      else if (src.length > 30) tag.setAttribute('src', '__url__');
    }
    const href = tag.getAttribute('href');
    if (href !== null) {
      // Mask only active-content schemes; a real http(s)/relative link is the
      // one thing an agent needs from a scan, so "__link__" must not hide it.
      if (!dshSafeHref(href)) tag.setAttribute('href', '__link__');
      else if (href.length > 400) tag.setAttribute('href', href.slice(0, 380) + ' …');
    }
    const action = tag.getAttribute('action');
    if (action !== null && action.length > 30) tag.setAttribute('action', '__url__');
    for (const key of ['value', 'title', 'alt']) {
      const val = tag.getAttribute(key);
      if (val !== null && val.length > 100) tag.setAttribute(key, val.slice(0, 50) + ' ...');
    }
    for (const name of Array.from(tag.getAttributeNames())) {
      if (DSH_ATTR_ALLOW.has(name)) continue;
      if (name.startsWith('data-v')) { tag.removeAttribute(name); continue; }
      const val = tag.getAttribute(name);
      // Long data-* values carry little signal; short ones (state flags) are kept.
      if (val !== null && val.length > 20) tag.setAttribute(name, '__data__');
    }
  }
}

function dshRenameIframes(root) {
  const placeholders = Array.from(root.querySelectorAll('div[data-tag="iframe"]'));
  for (const div of placeholders) {
    const iframe = document.createElement('iframe');
    for (const attr of Array.from(div.attributes)) iframe.setAttribute(attr.name, attr.value);
    iframe.removeAttribute('data-tag');
    while (div.firstChild) iframe.appendChild(div.firstChild);
    if (div.parentNode) div.parentNode.replaceChild(iframe, div);
  }
}

function dshApplyCutlist(root, lists, instruction) {
  const fakeNodes = [];
  for (const entry of lists) {
    if (!entry || !entry.selector) continue;
    let items;
    try { items = Array.from(root.querySelectorAll(entry.selector)); } catch { continue; }
    if (items.length < 5) continue;

    let total = 0;
    for (const item of items) total += item.outerHTML.length;
    const avg = total / items.length;
    if (avg < 200 || (avg < 700 && total < 2500)) continue;

    let keep = [];
    if (instruction) {
      const needle = String(instruction).replace(/\s+/g, ' ').trim();
      keep = items.filter((item) => {
        const hay = (item.innerText || item.textContent || '').replace(/\s+/g, ' ').trim();
        return hay.includes(needle);
      }).slice(0, 6);
    }
    if (!keep.length) keep = items.slice(0, 3);
    const keepSet = new Set(keep);
    const removed = items.filter((item) => !keepSet.has(item));
    if (!removed.length) continue;

    const samples = removed.slice(0, 5)
      .map((item) => (item.innerText || item.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40))
      .filter(Boolean);
    let hint = '[FAKE ELEMENT] ' + removed.length + ' more items hidden, selector: "' + entry.selector + '"';
    if (samples.length) hint += ' Hidden items: "' + samples.join(' | ') + '"';
    const hintEl = root.ownerDocument.createElement('div');
    hintEl.textContent = hint;
    hintEl.setAttribute('data-dsh-fake', '1');
    if (keep.length) {
      const anchor = keep[keep.length - 1];
      if (anchor.parentNode) anchor.parentNode.insertBefore(hintEl, anchor.nextSibling);
    } else {
      root.appendChild(hintEl);
    }
    fakeNodes.push(hintEl);
    for (const item of removed) if (item.parentNode) item.remove();
  }
  return fakeNodes;
}

// ---- truncation -----------------------------------------------------------
//
// Older versions sliced raw `innerHTML` at a character offset. That inevitably
// lands mid-tag / mid-attribute, so the parser repaired the fragment by dropping
// whatever it could not parse — with a small budget it emptied every element and
// returned `<h2></h2>` skeletons while the text was gone. Truncation now copies
// whole nodes in document order and only ever cuts text at a character
// boundary: the result always parses back cleanly and the leading content (the
// part in document order) is preserved instead of being blanked out.

const DSH_TRUNC_SKIP = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'COLGROUP', 'COL', 'PARAM', 'SOURCE', 'META', 'LINK',
]);

// Escapes exactly like innerHTML serialization does, so lengths can be budgeted
// before the DOM is touched (avoiding O(n^2) innerHTML measurements).
function dshEscapeText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u00a0/g, '&nbsp;');
}

function dshShellLength(el) {
  try { return el.cloneNode(false).outerHTML.length; } catch (e) { return 0; }
}

function dshCopyWithin(dst, src, state) {
  for (const node of Array.from(src.childNodes)) {
    if (state.stopped) return;
    if (node.nodeType === 3) {
      const raw = node.nodeValue || '';
      if (!raw) continue;
      const escaped = dshEscapeText(raw);
      if (state.used + escaped.length <= state.budget) {
        dst.appendChild(node.cloneNode(false));
        state.used += escaped.length;
        continue;
      }
      const room = Math.max(state.budget - state.used, 0);
      let keep = Math.min(raw.length, room);
      while (keep > 0 && dshEscapeText(raw.slice(0, keep)).length > room) keep -= 1;
      if (keep > 0) {
        dst.appendChild(dst.ownerDocument.createTextNode(raw.slice(0, keep)));
        state.used += dshEscapeText(raw.slice(0, keep)).length;
      }
      state.stopped = true;
      return;
    }
    if (node.nodeType !== 1) continue;
    if (DSH_TRUNC_SKIP.has(node.tagName)) continue;
    const shell = dshShellLength(node);
    if (state.used + shell > state.budget) { state.stopped = true; return; }
    const copy = node.cloneNode(false);
    dst.appendChild(copy);
    state.used += shell;
    dshCopyWithin(copy, node, state);
  }
}

// Defensive only: exact accounting normally fits already. Custom-element
// serialization can add a few characters; drop trailing text (a character at a
// time) and then trailing elements until the budget holds. Never slices markup.
function dshShrinkToFit(container, budget) {
  const doc = container.ownerDocument;
  let guard = 0;
  while (container.innerHTML.length > budget && guard++ < 5000) {
    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let lastText = null;
    let node = walker.nextNode();
    while (node) { if (node.nodeValue) lastText = node; node = walker.nextNode(); }
    if (lastText) {
      const over = container.innerHTML.length - budget;
      const keep = Math.max(lastText.nodeValue.length - over - 1, 0);
      if (keep > 0) lastText.nodeValue = lastText.nodeValue.slice(0, keep);
      else if (lastText.parentNode) lastText.parentNode.removeChild(lastText);
      continue;
    }
    const elements = Array.from(container.querySelectorAll('*'));
    if (!elements.length) break;
    elements[elements.length - 1].remove();
  }
}

function dshTruncateHtml(root, budget) {
  const original = root.innerHTML;
  if (!Number.isFinite(budget) || budget < 4) { root.innerHTML = ''; return; }
  if (original.length <= budget) return;
  const doc = root.ownerDocument;
  // Worst case marker is ' [TRUNCATED 1234567 chars]'; reserve it up front so
  // the marker itself never makes the result overflow.
  const reserve = 32;
  const staging = doc.createElement('div');
  const state = { used: 0, budget: Math.max(budget - reserve, 0), stopped: false };
  dshCopyWithin(staging, root, state);
  let body = staging.innerHTML;
  let markerText = '';
  if (state.stopped) {
    const dropped = Math.max(original.length - body.length, 1);
    markerText = ' [TRUNCATED ' + dropped + ' chars]';
    if (markerText.length + 8 > budget) markerText = '…';
    const room = Math.max(budget - markerText.length, 0);
    if (body.length > room) {
      dshShrinkToFit(staging, room);
      body = staging.innerHTML;
    }
  } else if (body.length > budget) {
    dshShrinkToFit(staging, budget);
    body = staging.innerHTML;
  }
  root.innerHTML = body;
  if (!markerText) return;
  const marker = doc.createTextNode(markerText);
  root.appendChild(marker);
  if (root.innerHTML.length > budget) {
    marker.remove();
    dshShrinkToFit(root, Math.max(budget - markerText.length, 0));
    root.appendChild(doc.createTextNode(markerText));
  }
}

function dshNormalizePlainText(text) {
  return String(text == null ? '' : text)
    .replace(/\u00a0/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/^ +/gm, '')
    .replace(/(\n\s*){3,}/g, '\n\n')
    .trim();
}

function dshClampText(text, maxChars) {
  const raw = String(text == null ? '' : text);
  const budget = Math.max(Number(maxChars) || 0, 0);
  if (!budget || raw.length <= budget) return raw;
  // Plain text is line/entry oriented; slicing at an arbitrary character used to
  // leave cut-off tokens like "[INPUT #subscri". Prefer the last line break (or
  // keep the mid-text cut when backing off would waste most of the budget).
  const fit = (length) => {
    const size = Math.max(Number(length) || 0, 0);
    let cut = raw.slice(0, size);
    if (size < raw.length) {
      const nl = cut.lastIndexOf('\n');
      if (nl >= cut.length * 0.6) cut = cut.slice(0, nl);
    }
    return cut.replace(/\s+$/, '');
  };
  let cut = fit(budget - 1);
  let marker = ' [TRUNCATED ' + Math.max(raw.length - cut.length, 1) + ' chars]';
  if (marker.length + 1 > budget) {
    marker = '…';
    cut = fit(budget - marker.length);
  } else if (cut.length + marker.length > budget) {
    cut = fit(budget - marker.length);
    marker = ' [TRUNCATED ' + Math.max(raw.length - cut.length, 1) + ' chars]';
  }
  if (cut.length + marker.length > budget) {
    cut = cut.slice(0, Math.max(budget - marker.length, 0)).replace(/\s+$/, '');
  }
  return cut + marker;
}
function dshScanPage(options) {
  const opts = options || {};
  const textOnly = !!opts.textOnly;
  const lists = opts.cutList ? findMainList(document.body) : [];
  // Refs are only meaningful in HTML output; annotate before cloning so the
  // data-dsh-ref attributes survive into scan content.
  if (!textOnly) dshAnnotateRefs();
  const raw = optHTML(textOnly, textOnly ? { lists, instruction: opts.instruction || '' } : null);
  if (textOnly) {
    // text_only used to return here, so max_chars was silently ignored. Apply
    // it to the (whitespace-normalised) plain text so both modes obey the cap.
    const text = dshNormalizePlainText(raw);
    return opts.maxChars ? dshClampText(text, opts.maxChars) : text;
  }

  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const root = doc.body;
  dshOptimizeHtml(root);
  dshRenameIframes(root);
  if (lists.length) dshApplyCutlist(root, lists, opts.instruction || '');
  dshOptimizeHtml(root);
  if (opts.maxChars && root.innerHTML.length > opts.maxChars) {
    dshTruncateHtml(root, opts.maxChars);
    for (const hint of root.querySelectorAll('[data-dsh-fake="1"]')) hint.removeAttribute('data-dsh-fake');
  }
  return root.innerHTML;
}

// ---- execution monitor (ported from execute_js_rich) ----------------------

function dshStartMonitor() {
  if (window._tm && window._tm.id) clearInterval(window._tm.id);
  const extractText = () => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent && parent.tagName !== 'SCRIPT' && parent.tagName !== 'STYLE') {
        const text = node.textContent.trim();
        if (text.length > 10 && text.indexOf('_') === -1) {
          out.push(text.slice(0, 20));
          if (out.length >= 100) break;
        }
      }
      node = walker.nextNode();
    }
    return out;
  };
  window._tm = { extract: extractText, init: new Set(extractText()), all: new Set(), id: 0 };
  window._tm.id = setInterval(() => {
    for (const text of window._tm.extract()) window._tm.all.add(text);
  }, 450);
  window.__dshMonitor = {
    sigs: dshBuildSigs(document.body),
    // Form properties are invisible to the signature above, so snapshot them
    // too and diff at finish (uncheck / select / controlled input changes).
    state: dshSnapshotFormState(),
    startedAt: Date.now(),
    timeOrigin: performance.timeOrigin,
  };
  return { timeOrigin: performance.timeOrigin, url: location.href };
}

function dshDiffDescribe(el) {
  if (!el || el.nodeType !== 1) return '';
  const tag = el.tagName.toLowerCase();
  const id = el.id ? '#' + el.id : '';
  let cls = '';
  try {
    const first = String(el.className || '').split(/\s+/).filter(Boolean)[0];
    if (first) cls = '.' + first;
  } catch (e) { /* ignore */ }
  const text = dshDirectText(el) || '';
  return tag + id + cls + (text ? ' "' + text.slice(0, 60) + '"' : '');
}

function dshDiffDescribeSignature(sig) {
  const text = String(sig || '');
  const first = text.indexOf(':');
  const last = text.lastIndexOf(':');
  if (first < 0) return text;
  const tag = text.slice(0, first);
  const direct = last > first ? text.slice(last + 1) : '';
  return tag + (direct ? ' "' + direct.slice(0, 60) + '"' : '');
}

function dshFinishMonitor() {
  const result = { transients: [], diff: null, timeOrigin: null, url: null };
  if (window.__dshMonitor) {
    result.timeOrigin = window.__dshMonitor.timeOrigin;
    result.url = location.href;
  }
  if (window._tm) {
    clearInterval(window._tm.id);
    const finalTexts = new Set(window._tm.extract());
    const newly = Array.from(window._tm.all).filter((text) => !window._tm.init.has(text));
    const kept = newly.length < 8 ? newly : newly.filter((text) => !finalTexts.has(text));
    result.transients = Array.from(new Set(kept));
    delete window._tm;
  }
  if (window.__dshMonitor) {
    const before = new Map(window.__dshMonitor.sigs);
    const stateBefore = window.__dshMonitor.state || new Map();
    delete window.__dshMonitor;
    const afterMap = new Map();
    for (const el of dshCollectElements(document.body)) {
      const sig = dshSignature(el);
      if (!afterMap.has(sig)) afterMap.set(sig, []);
      afterMap.get(sig).push(el);
    }
    const added = [];
    for (const [sig, els] of afterMap) {
      const extra = els.length - (before.get(sig) || 0);
      if (extra > 0) added.push(...els.slice(0, extra));
    }
    const removed = [];
    for (const [sig, count] of before) {
      const extra = count - (afterMap.get(sig) || []).length;
      for (let i = 0; i < extra; i += 1) removed.push(sig);
    }
    // Only report the outermost newly added subtrees; their descendants would
    // just repeat the same change and blow up the summary.
    const addedSet = new Set(added);
    const boundaries = added.filter((el) => !el.parentElement || !addedSet.has(el.parentElement));
    const items = [];
    for (const el of boundaries.slice(0, 8)) items.push({ change: '+', desc: dshDiffDescribe(el) });
    for (const sig of removed.slice(0, 8)) items.push({ change: '-', desc: dshDiffDescribeSignature(sig) });
    let valueDiff = { changed: 0, values: [] };
    try { valueDiff = dshDiffFormState(stateBefore); } catch (e) { /* ignore */ }
    for (const entry of valueDiff.values) {
      items.push({ change: '~', desc: entry.target + ' ' + entry.before + ' → ' + entry.after });
    }
    // Property-only changes are folded into the counters that older tool
    // builds already declare (`changed` / `summary` / `~` items): shipping a new
    // top-level field here would make an older, still-running host reject the
    // whole execute_js payload (additionalProperties: false).
    const summary = `+${added.length} -${removed.length}` + (valueDiff.changed ? ` ~${valueDiff.changed}` : '');
    result.diff = {
      changed: added.length + removed.length + valueDiff.changed,
      added: added.length,
      removed: removed.length,
      summary,
      items,
    };
  }
  return result;
}
