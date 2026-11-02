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
    if (href !== null && href.length > 30) tag.setAttribute('href', '__link__');
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

function dshCutElement(el, keep) {
  const snapshot = el.outerHTML;
  const over = snapshot.length - keep;
  if (over <= 0) return;
  const fakeNodes = Array.from(el.querySelectorAll('[data-dsh-fake="1"]'));
  for (const node of fakeNodes) if (node.parentNode) node.parentNode.removeChild(node);

  const inner = el.innerHTML;
  const overhead = el.outerHTML.length - inner.length;
  const marker = ' [TRUNCATED ' + Math.floor(over / 1000) + 'k chars]';
  const keepChars = Math.max(keep - overhead - marker.length, 0);
  const staging = document.createElement(el.tagName.toLowerCase());
  staging.innerHTML = inner.slice(0, keepChars);
  while (el.firstChild) el.removeChild(el.firstChild);
  while (staging.firstChild) el.appendChild(staging.firstChild);
  if (keepChars > 0) el.appendChild(document.createTextNode(marker));
  for (const node of fakeNodes) el.appendChild(node);
}

function dshSmartTruncate(root, budget, depth) {
  if (depth === undefined) depth = 0;
  if (root.outerHTML.length <= budget) return;
  const kids = Array.from(root.children).filter((node) => node.getAttribute('data-dsh-fake') !== '1');
  if (!kids.length) return;

  let kidsTotal = 0;
  for (const kid of kids) kidsTotal += kid.outerHTML.length;
  const selfLength = root.outerHTML.length - kidsTotal;
  const remaining = Math.max(budget - selfLength, 0);

  if (kids.length === 1) { dshSmartTruncate(kids[0], remaining, depth + 1); return; }
  const over = kidsTotal - remaining;
  if (over <= 0) return;

  const ranked = kids.map((kid, index) => ({ index, size: kid.outerHTML.length }))
    .sort((a, b) => b.size - a.size);
  let tops = ranked.slice(0, 3);
  let topTotal = tops.reduce((sum, entry) => sum + entry.size, 0);
  if (topTotal < over) {
    let removed = 0;
    let removedCount = 0;
    while (kids.length && removed < over) {
      const kid = kids.pop();
      removed += kid.outerHTML.length;
      if (kid.parentNode) kid.remove();
      removedCount += 1;
    }
    if (removedCount > 0) {
      root.appendChild(document.createTextNode(' [TRUNCATED ' + removedCount + ' nodes]'));
    }
    return;
  }

  const largest = ranked[0].size;
  const filtered = tops.filter((entry) => entry.size >= largest * 0.1);
  const filteredTotal = filtered.reduce((sum, entry) => sum + entry.size, 0);
  if (filteredTotal >= over) { tops = filtered; topTotal = filteredTotal; }

  const actions = tops.map((entry) => {
    const share = Math.floor((over * entry.size) / topTotal);
    return { child: kids[entry.index], newKeep: entry.size - share };
  });
  for (const action of actions) {
    if (action.newKeep <= 0) {
      if (action.child.parentNode) action.child.remove();
    } else if (action.newKeep > 8000) {
      dshSmartTruncate(action.child, action.newKeep, depth + 1);
    } else {
      dshCutElement(action.child, action.newKeep);
    }
  }
}

function dshTrimToBudget(root, budget) {
  if (root.innerHTML.length <= budget) return;
  const marker = ' [TRUNCATED]';
  // Reserve room for the marker so the caller can detect truncation.
  const target = Math.max(budget - marker.length, 64);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue && node.nodeValue.trim()) nodes.push(node);
  }
  // Trim ordinary text first, protected hint text only if nothing else is left.
  const fakeParent = (n) => {
    for (let el = n.parentElement; el; el = el.parentElement) {
      if (el.getAttribute('data-dsh-fake') === '1') return true;
    }
    return false;
  };
  const ordered = nodes.filter((n) => !fakeParent(n)).concat(nodes.filter((n) => fakeParent(n)));
  for (const textNode of ordered) {
    if (root.innerHTML.length <= target) break;
    const excess = root.innerHTML.length - target;
    const keep = Math.max(textNode.nodeValue.length - excess - 8, 0);
    textNode.nodeValue = keep > 0 ? textNode.nodeValue.slice(0, keep) + '…' : '';
  }
  // Markup overhead can still exceed the budget after every text node is gone.
  // Drop trailing element subtrees (hint nodes last).
  let guard = 0;
  while (root.innerHTML.length > target && guard++ < 400) {
    const elements = root.querySelectorAll('*');
    if (!elements.length) break;
    const last = elements[elements.length - 1];
    if (last.getAttribute('data-dsh-fake') === '1') break;
    last.remove();
  }
  if (root.innerHTML.length > target) {
    root.innerHTML = root.innerHTML.slice(0, target) + '…';
  }
  root.appendChild(document.createTextNode(marker));
  if (root.innerHTML.length > budget) {
    root.innerHTML = root.innerHTML.slice(0, budget);
  }
}
function dshScanPage(options) {
  const opts = options || {};
  const textOnly = !!opts.textOnly;
  const lists = opts.cutList ? findMainList(document.body) : [];
  // Refs are only meaningful in HTML output; annotate before cloning so the
  // data-dsh-ref attributes survive into scan content.
  if (!textOnly) dshAnnotateRefs();
  const raw = optHTML(textOnly, textOnly ? { lists, instruction: opts.instruction || '' } : null);
  if (textOnly) return raw;

  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const root = doc.body;
  dshOptimizeHtml(root);
  dshRenameIframes(root);
  if (lists.length) dshApplyCutlist(root, lists, opts.instruction || '');
  dshOptimizeHtml(root);
  if (opts.maxChars && root.innerHTML.length > opts.maxChars) {
    dshSmartTruncate(root, opts.maxChars);
    dshTrimToBudget(root, opts.maxChars);
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
  window.__dshMonitor = { sigs: dshBuildSigs(document.body), startedAt: Date.now(), timeOrigin: performance.timeOrigin };
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
    result.diff = {
      changed: added.length + removed.length,
      added: added.length,
      removed: removed.length,
      summary: `+${added.length} -${removed.length}`,
      items,
    };
  }
  return result;
}
