// Page-side primitives for high-level actions and waits: target resolution,
// settle, React-compatible filling, key presses and network-idle tracking.
// Runs inside the page (plain script, no imports). All symbols are dsh-prefixed.

const DSH_UI_SELECTOR = '[data-dsh-ui="1"],#ljq-ind,#dsh-browser-badge';
const DSH_INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'label',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]',
  '[role="radio"]', '[role="menuitem"]', '[role="switch"]', '[role="option"]',
  '[onclick]', '[contenteditable=""]', '[contenteditable="true"]', '[tabindex]',
].join(',');

function dshIsPluginNode(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    if (el.closest && el.closest(DSH_UI_SELECTOR)) return true;
  } catch (e) { /* ignore */ }
  if (!el.children || !el.children.length) {
    const text = (el.textContent || '').trim();
    if (text.startsWith('ljq_driver:')) {
      try {
        const style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'absolute') return true;
      } catch (e) { return true; }
    }
  }
  return false;
}

function dshIsVisible(el) {
  if (!el || el.nodeType !== 1 || !el.isConnected) return false;
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const view = el.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) <= 0) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function dshIsInteractive(el) {
  if (!el || el.nodeType !== 1) return false;
  try { return el.matches(DSH_INTERACTIVE_SELECTOR); } catch (e) { return false; }
}

function dshDocuments() {
  const docs = [];
  const seen = new Set();
  const visit = (doc, depth) => {
    if (!doc || seen.has(doc) || depth > 4) return;
    seen.add(doc);
    docs.push(doc);
    let frames = [];
    try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e) { return; }
    for (const frame of frames) {
      try {
        if (frame.contentDocument) visit(frame.contentDocument, depth + 1);
      } catch (e) { /* cross-origin */ }
    }
  };
  visit(document, 0);
  return docs;
}

function dshRoots() {
  const roots = [];
  const seen = new Set();
  const visit = (root, depth) => {
    if (!root || seen.has(root) || depth > 5) return;
    seen.add(root);
    roots.push(root);
    let elements = [];
    try { elements = Array.from(root.querySelectorAll('*')); } catch (e) { return; }
    for (const el of elements) {
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
    }
  };
  for (const doc of dshDocuments()) {
    visit(doc, 0);
    if (doc.documentElement) visit(doc.documentElement, 0);
    if (doc.body) visit(doc.body, 0);
  }
  return roots;
}

function dshAllElements() {
  const out = [];
  const seen = new Set();
  for (const root of dshRoots()) {
    let elements = [];
    try { elements = Array.from(root.querySelectorAll('*')); } catch (e) { continue; }
    if (root.nodeType === 1) elements.unshift(root);
    for (const el of elements) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

function dshNormalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function dshUnquote(value) {
  const text = String(value == null ? '' : value).trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function dshAccessibleName(el) {
  if (!el || el.nodeType !== 1) return '';
  const label = el.getAttribute('aria-label');
  if (label) return dshNormalizeText(label);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => {
      try { return el.ownerDocument.getElementById(id)?.textContent || ''; } catch (e) { return ''; }
    }).join(' ');
    if (dshNormalizeText(text)) return dshNormalizeText(text);
  }
  for (const attr of ['alt', 'title', 'placeholder']) {
    const value = el.getAttribute(attr);
    if (value) return dshNormalizeText(value);
  }
  try {
    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels).map((item) => item.textContent || '').join(' ');
      if (dshNormalizeText(text)) return dshNormalizeText(text);
    }
  } catch (e) { /* ignore */ }
  if ('value' in el && typeof el.value === 'string' && el.value) return dshNormalizeText(el.value);
  return dshNormalizeText(el.innerText || el.textContent || '');
}

function dshImplicitRole(el) {
  const explicit = el.getAttribute && el.getAttribute('role');
  if (explicit) return explicit.split(/\s+/)[0].toLowerCase();
  const tag = el.tagName;
  if (tag === 'BUTTON') return 'button';
  if (tag === 'A' && el.hasAttribute('href')) return 'link';
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'SELECT') return 'combobox';
  if (tag === 'OPTION') return 'option';
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'range') return 'slider';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }
  if (tag === 'IMG' && el.hasAttribute('alt')) return 'img';
  if (tag === 'DIALOG') return 'dialog';
  if (tag === 'NAV') return 'navigation';
  if (tag === 'MAIN') return 'main';
  if (/^H[1-6]$/.test(tag)) return 'heading';
  if (tag === 'UL' || tag === 'OL') return 'list';
  if (tag === 'LI') return 'listitem';
  if (tag === 'TABLE') return 'table';
  return '';
}

function dshDescribeElement(el) {
  if (!el || el.nodeType !== 1) return '';
  const tag = el.tagName.toLowerCase();
  const ref = el.getAttribute && el.getAttribute('data-dsh-ref');
  const id = el.id ? '#' + el.id : '';
  let cls = '';
  try {
    const first = String(el.className || '').split(/\s+/).filter(Boolean)[0];
    if (first) cls = '.' + first;
  } catch (e) { /* ignore */ }
  const text = dshNormalizeText(el.innerText || el.textContent || '').slice(0, 60);
  return (ref ? ref + ' ' : '') + tag + id + cls + (text ? ' "' + text + '"' : '');
}

// Scan-time refs: every visible interactive element gets a stable "@eN" until
// it is removed or replaced by a re-render. Refs are intentionally not
// resolved through a saved selector: after a re-render a stale ref must fail
// loudly (REF_STALE) instead of clicking a different element.
function dshAnnotateRefs() {
  const api = window.__DSH_BROWSER__;
  if (!api) return 0;
  if (!(api.refs instanceof Map)) api.refs = new Map();
  if (!Number.isInteger(api.refNext) || api.refNext < 1) api.refNext = 1;
  const refs = api.refs;
  for (const [ref, el] of Array.from(refs.entries())) {
    if (!el || el.nodeType !== 1 || !el.isConnected) refs.delete(ref);
  }
  let count = 0;
  for (const el of dshAllElements()) {
    if (!el || el.nodeType !== 1) continue;
    if (dshIsPluginNode(el) || !dshIsInteractive(el) || !dshIsVisible(el)) continue;
    const existing = el.getAttribute('data-dsh-ref');
    if (existing && refs.get(existing) === el) { count++; continue; }
    if (existing) el.removeAttribute('data-dsh-ref');
    let ref;
    do { ref = '@e' + api.refNext++; } while (refs.has(ref));
    el.setAttribute('data-dsh-ref', ref);
    refs.set(ref, el);
    count++;
  }
  return count;
}

function dshParseTarget(target) {
  const raw = String(target == null ? '' : target).trim();
  if (!raw) return { kind: 'none' };
  const directRef = /^@e(\d+)$/i.exec(raw);
  if (directRef) return { kind: 'ref', ref: '@e' + directRef[1] };
  if (/^ref=@?e\d+$/i.test(raw)) {
    const num = raw.slice(raw.indexOf('=') + 1).trim().replace(/^@?e/i, '');
    return { kind: 'ref', ref: '@e' + num };
  }
  if (raw.startsWith('css=')) return { kind: 'css', css: raw.slice(4) };
  if (raw.startsWith('text=')) return { kind: 'text', text: dshUnquote(raw.slice(5)) };
  if (raw.startsWith('role=')) {
    const body = raw.slice(5);
    const match = /^([a-zA-Z-]+)(?:\[name=(?:"([^"]*)"|'([^']*)'|([^\]]*))\])?$/.exec(body);
    if (match) {
      return { kind: 'role', role: match[1].toLowerCase(), name: dshUnquote(match[2] ?? match[3] ?? match[4] ?? '') };
    }
    return { kind: 'role', role: body.toLowerCase(), name: '' };
  }
  return { kind: 'css', css: raw };
}

function dshResolveTarget(target, index) {
  const spec = dshParseTarget(target);
  const wantedIndex = Math.max(0, Number(index) || 0);
  if (spec.kind === 'none') {
    return { ok: false, code: 'TARGET_REQUIRED', error: '缺少 target（可用 CSS、text=、role=、@eN）' };
  }
  if (spec.kind === 'ref') {
    const refs = window.__DSH_BROWSER__ && window.__DSH_BROWSER__.refs;
    const el = refs instanceof Map ? refs.get(spec.ref) : null;
    if (!el || el.nodeType !== 1 || !el.isConnected) {
      if (refs instanceof Map) refs.delete(spec.ref);
      return {
        ok: false,
        code: 'REF_STALE',
        error: `ref ${spec.ref} 已失效（元素已移除或页面已重新渲染），请重新 browser_scan`,
        hint: '重新扫描页面获取新的 @eN 编号；ref 只在当前 DOM 生命周期内有效。',
      };
    }
    if (dshIsPluginNode(el)) {
      return { ok: false, code: 'REF_STALE', error: `ref ${spec.ref} 指向插件自己的节点，已忽略` };
    }
    if (!dshIsVisible(el)) {
      return { ok: false, code: 'TARGET_HIDDEN', error: `ref ${spec.ref} 指向的元素当前不可见`, target: dshDescribeElement(el) };
    }
    return { ok: true, el, target: dshDescribeElement(el) };
  }
  if (spec.kind === 'css') {
    const found = [];
    for (const doc of dshDocuments()) {
      try {
        for (const el of Array.from(doc.querySelectorAll(spec.css))) {
          if (el && el.nodeType === 1 && !found.includes(el)) found.push(el);
        }
      } catch (e) {
        return { ok: false, code: 'TARGET_INVALID', error: `CSS 选择器无效: ${spec.css}（${e.message}）` };
      }
    }
    const visible = found.filter((el) => !dshIsPluginNode(el) && dshIsVisible(el));
    const pool = visible.length ? visible : found.filter((el) => !dshIsPluginNode(el));
    if (!pool.length) return { ok: false, code: 'TARGET_NOT_FOUND', error: `找不到元素: ${spec.css}` };
    if (!visible.length) return { ok: false, code: 'TARGET_HIDDEN', error: `元素存在但不可见: ${dshDescribeElement(pool[0])}` };
    const el = pool[wantedIndex];
    if (!el) return { ok: false, code: 'TARGET_NOT_FOUND', error: `选择器 ${spec.css} 只有 ${pool.length} 个可见匹配，index=${wantedIndex} 越界` };
    return { ok: true, el, target: dshDescribeElement(el) };
  }
  if (spec.kind === 'text') {
    const needle = dshNormalizeText(spec.text);
    if (!needle) return { ok: false, code: 'TARGET_INVALID', error: 'text= 不能为空' };
    const matches = [];
    for (const el of dshAllElements()) {
      if (el === document.documentElement || el === document.body) continue;
      if (dshIsPluginNode(el) || !dshIsVisible(el)) continue;
      const text = dshNormalizeText(el.innerText || el.textContent || '');
      if (text && (text === needle || text.includes(needle))) matches.push(el);
    }
    if (!matches.length) return { ok: false, code: 'TARGET_NOT_FOUND', error: `找不到文本: ${needle}` };
    const set = new Set(matches);
    const deepest = matches.filter((el) => !Array.from(el.children || []).some((child) => set.has(child)));
    const exact = deepest.filter((el) => dshNormalizeText(el.innerText || el.textContent || '') === needle);
    const pool = exact.length ? exact : deepest;
    const el = pool[wantedIndex];
    if (!el) return { ok: false, code: 'TARGET_NOT_FOUND', error: `文本 "${needle}" 只有 ${pool.length} 个匹配，index=${wantedIndex} 越界` };
    return { ok: true, el, target: dshDescribeElement(el) };
  }
  if (spec.kind === 'role') {
    const needle = dshNormalizeText(spec.name);
    const matches = [];
    for (const el of dshAllElements()) {
      if (dshIsPluginNode(el) || !dshIsVisible(el) || !dshIsInteractive(el)) continue;
      if (dshImplicitRole(el) !== spec.role) continue;
      if (!needle) { matches.push(el); continue; }
      const name = dshAccessibleName(el);
      if (name === needle || name.includes(needle)) matches.push(el);
    }
    if (!matches.length) {
      return { ok: false, code: 'TARGET_NOT_FOUND', error: `找不到 role=${spec.role}${needle ? `[name="${needle}"]` : ''}` };
    }
    const exact = matches.filter((el) => dshAccessibleName(el) === needle);
    const pool = exact.length ? exact : matches;
    const el = pool[wantedIndex];
    if (!el) return { ok: false, code: 'TARGET_NOT_FOUND', error: `只有 ${pool.length} 个 role=${spec.role} 匹配，index=${wantedIndex} 越界` };
    return { ok: true, el, target: dshDescribeElement(el) };
  }
  return { ok: false, code: 'TARGET_INVALID', error: `不支持的 target 类型: ${spec.kind}` };
}

function dshSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function dshResolveWithWait(target, timeoutMs, index) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let last = null;
  for (;;) {
    last = dshResolveTarget(target, index);
    if (last.ok) return last;
    if (last.code !== 'TARGET_NOT_FOUND' && last.code !== 'TARGET_HIDDEN') return last;
    if (Date.now() >= deadline) return last;
    await dshSleep(100);
  }
}

// ---- live control state ---------------------------------------------------
//
// A MutationObserver only sees attributes: checking a checkbox, changing
// <select>.value or a React-controlled input updates *properties*, which never
// touch content attributes (checked/selected are only the defaults). Snapshot
// the live control values around an action so the receipt can count those
// changes and report the value that actually took effect.

function dshControlType(el) {
  return String(el.type || '').toLowerCase();
}

function dshSnapshotFormState() {
  const state = new Map();
  for (const el of dshAllElements()) {
    if (!el || el.nodeType !== 1) continue;
    const tag = el.tagName;
    try {
      if (tag === 'INPUT') {
        const type = dshControlType(el);
        if (type === 'checkbox' || type === 'radio') state.set(el, 'checked:' + (el.checked ? '1' : '0'));
        else if (type === 'password') state.set(el, 'password:' + el.value.length + ':' + (el.value ? '1' : '0'));
        else if (type === 'file') state.set(el, 'files:' + (el.files ? el.files.length : 0));
        else state.set(el, 'value:' + el.value);
      } else if (tag === 'TEXTAREA') {
        state.set(el, 'value:' + el.value);
      } else if (tag === 'SELECT') {
        state.set(el, 'value:' + el.value + '|' + el.selectedIndex);
      } else if (el.isContentEditable) {
        state.set(el, 'text:' + String(el.textContent || ''));
      }
    } catch (e) { /* detached or exotic element */ }
  }
  return state;
}

// Human-readable live value of one control (never leaks password contents).
function dshControlValue(el) {
  if (!el || el.nodeType !== 1) return null;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = dshControlType(el);
    if (type === 'checkbox' || type === 'radio') return { checked: !!el.checked };
    if (type === 'password') return { filled: !!el.value, length: el.value.length };
    if (type === 'file') return { files: el.files ? el.files.length : 0 };
    return { value: el.value };
  }
  if (tag === 'TEXTAREA') return { value: el.value };
  if (tag === 'SELECT') {
    const option = el.selectedOptions && el.selectedOptions[0];
    return { value: el.value, label: option ? dshNormalizeText(option.text) : '' };
  }
  if (el.isContentEditable) return { text: String(el.textContent || '').slice(0, 200) };
  return null;
}

function dshDescribeState(el) {
  if (!el || el.nodeType !== 1) return null;
  const state = { target: dshDescribeElement(el) };
  const value = dshControlValue(el);
  if (value) Object.assign(state, value);
  for (const attr of ['aria-expanded', 'aria-checked', 'aria-selected', 'aria-pressed', 'aria-disabled']) {
    const val = el.getAttribute(attr);
    if (val !== null) state[attr.replace('aria-', '')] = val;
  }
  if (el.disabled) state.disabled = true;
  return state;
}

function dshDiffFormState(before) {
  const after = dshSnapshotFormState();
  const values = [];
  let changed = 0;
  for (const [el, next] of after) {
    const prev = before.get(el);
    if (prev === undefined || prev === next) continue;
    changed += 1;
    if (values.length < 8) {
      values.push({
        target: dshDescribeElement(el),
        before: prev.slice(prev.indexOf(':') + 1),
        after: next.slice(next.indexOf(':') + 1),
      });
    }
  }
  return { changed, values };
}

// Attach the observer *before* an action and call finish() afterwards. This
// matters for synchronous DOM updates (a click that rewrites textContent): if
// the observer starts after the click, the mutation is already gone.
function dshBeginSettle(options) {
  const opts = options || {};
  const quietMs = Math.max(20, Number(opts.quietMs) || 100);
  const timeoutMs = Math.max(quietMs, Number(opts.timeoutMs) || 800);
  const started = Date.now();
  let mutations = 0;
  // Snapshot live control values before the action: the DOM observer below can
  // never see property-only changes (checkbox.checked, select.value, ...).
  const stateBefore = dshSnapshotFormState();
  let quietTimer = null;
  let capTimer = null;
  let done = false;
  let timedOut = false;
  let resolveFn = null;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const observer = new MutationObserver((records) => {
    mutations += records.length;
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    }
  });
  const finish = () => {
    if (done) return promise;
    done = true;
    clearTimeout(quietTimer);
    clearTimeout(capTimer);
    try { observer.disconnect(); } catch (e) { /* ignore */ }
    let valueDiff = { changed: 0, values: [] };
    try { valueDiff = dshDiffFormState(stateBefore); } catch (e) { /* ignore */ }
    const result = {
      settled: !timedOut,
      mutations,
      propertyChanges: valueDiff.changed,
      values: valueDiff.values,
      waited_ms: Date.now() - started,
    };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      resolveFn(result);
    };
    // rAF makes sure layout/paint have caught up, but background tabs pause
    // rAF entirely; the timer guarantees the action never hangs on that.
    try { requestAnimationFrame(() => requestAnimationFrame(release)); } catch (e) { /* ignore */ }
    setTimeout(release, 120);
    return promise;
  };
  const cancel = () => {
    if (done) return;
    done = true;
    clearTimeout(quietTimer);
    clearTimeout(capTimer);
    try { observer.disconnect(); } catch (e) { /* ignore */ }
    resolveFn({ settled: false, mutations, propertyChanges: 0, values: [], waited_ms: Date.now() - started });
  };
  try {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'inert', 'aria-modal', 'data-state', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-pressed', 'value', 'checked', 'disabled'],
    });
  } catch (e) { /* ignore */ }
  return {
    promise,
    cancel,
    finish() {
      if (done) return promise;
      quietTimer = setTimeout(finish, quietMs);
      capTimer = setTimeout(() => { timedOut = true; finish(); }, timeoutMs);
      return promise;
    },
  };
}

function dshSettle(options) {
  return dshBeginSettle(options).finish();
}

function dshSetNativeValue(el, value) {
  const text = String(value == null ? '' : value);
  let proto = HTMLInputElement.prototype;
  if (el.tagName === 'TEXTAREA') proto = HTMLTextAreaElement.prototype;
  else if (el.tagName === 'SELECT') proto = HTMLSelectElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) descriptor.set.call(el, text);
  else el.value = text;
}

function dshDispatchInput(el, value) {
  try {
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: value == null ? null : String(value),
    }));
  } catch (e) {
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function dshParseKeyCombo(value) {
  const parts = String(value == null ? '' : value).split('+').filter((part) => part !== '');
  const keyPart = parts.length ? parts.pop() : '';
  const mods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') mods.ctrlKey = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') mods.metaKey = true;
    else if (lower === 'alt' || lower === 'option') mods.altKey = true;
    else if (lower === 'shift') mods.shiftKey = true;
  }
  let key = keyPart;
  if (/^space$/i.test(key)) key = ' ';
  if (/^esc$/i.test(key)) key = 'Escape';
  const codeMap = {
    Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space',
  };
  let code = codeMap[key] || '';
  if (!code && key.length === 1) {
    if (/[a-z]/i.test(key)) code = 'Key' + key.toUpperCase();
    else if (/[0-9]/.test(key)) code = 'Digit' + key;
    else code = key;
  }
  return { key, code: code || key, ...mods };
}

function dshPressKey(el, combo) {
  const parsed = dshParseKeyCombo(combo);
  const target = el || document.activeElement || document.body;
  try { target.focus && target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  const init = {
    key: parsed.key, code: parsed.code, bubbles: true, cancelable: true, composed: true,
    altKey: parsed.altKey, ctrlKey: parsed.ctrlKey, metaKey: parsed.metaKey, shiftKey: parsed.shiftKey,
  };
  const notCancelled = target.dispatchEvent(new KeyboardEvent('keydown', init));
  if (parsed.key.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  let submitted = false;
  // Synthetic keydown never triggers the browser's implicit form submission,
  // so do it explicitly for Enter in a text input.
  if (notCancelled && parsed.key === 'Enter' && el && el.tagName === 'INPUT' && el.form) {
    try {
      if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
      else el.form.submit();
      submitted = true;
    } catch (e) { /* ignore */ }
  }
  return { key: parsed.key, submitted };
}

async function dshAct(spec) {
  const options = spec || {};
  const action = String(options.action || '').toLowerCase();
  const timeoutMs = Number(options.timeoutMs) || 5000;
  const settleEnabled = options.settle !== false;
  let resolved = { ok: true, el: null, target: '' };
  if (options.target) {
    resolved = await dshResolveWithWait(options.target, timeoutMs, options.index);
    if (!resolved.ok) return resolved;
  }
  const el = resolved.el;
  const targetDesc = resolved.target || '';
  let tracker = null;
  const fail = (code, error) => {
    if (tracker) tracker.cancel();
    return { ok: false, code, error, target: targetDesc };
  };
  if (settleEnabled) {
    tracker = dshBeginSettle({ quietMs: options.quietMs || 100, timeoutMs: options.settleTimeoutMs || 800 });
  }
  const result = { ok: true, action, target: targetDesc, settled: null, changed: 0 };
  // Stale attempts recorded between actions are irrelevant; start from empty.
  if (Array.isArray(window.__dshPopups)) window.__dshPopups.length = 0;
  const popupMark = 0;
  const actionStartHref = location.href;

  try {
    if (action === 'click') {
      if (!el) return fail('TARGET_REQUIRED', 'click 需要 target');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return fail('TARGET_DISABLED', `元素不可点击（disabled）: ${dshDescribeElement(el)}`);
      }
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* ignore */ }
      try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      // A programmatic click carries no user gesture, so Chrome drops the popup
      // a target="_blank" link would normally open. Record the destination and
      // let the Node side open it explicitly with chrome.tabs.create.
      const link = el.closest ? el.closest('a[href]') : null;
      let popup = null;
      if (link) {
        const rawHref = link.getAttribute('href') || '';
        const linkTarget = (link.getAttribute('target') || '').toLowerCase();
        if (rawHref && rawHref !== '#' && linkTarget && !['_self', '_top', '_parent'].includes(linkTarget)) {
          try { popup = { href: link.href, target: link.getAttribute('target') }; } catch (e) { popup = null; }
        }
      }
      el.click();
      if (popup) result.popup = popup;
    } else if (action === 'fill') {
      if (!el) return fail('TARGET_REQUIRED', 'fill 需要 target');
      if (options.value === undefined) return fail('VALUE_REQUIRED', 'fill 需要 value');
      try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
      try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      if (el.isContentEditable) {
        el.textContent = String(options.value);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: String(options.value) }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.tagName === 'INPUT' && el.type === 'checkbox') {
          return fail('WRONG_ACTION', 'fill 不支持 checkbox，请用 check/uncheck 或 click');
        }
        dshSetNativeValue(el, options.value);
        dshDispatchInput(el, options.value);
      } else {
        return fail('TARGET_NOT_EDITABLE', `元素不可输入: ${dshDescribeElement(el)}`);
      }
      result.value = el.isContentEditable ? el.textContent : el.value;
    } else if (action === 'select') {
      if (!el) return fail('TARGET_REQUIRED', 'select 需要 target');
      if (el.tagName !== 'SELECT') return fail('TARGET_NOT_SELECT', `不是 <select>: ${dshDescribeElement(el)}`);
      let value = options.value;
      if ((value === undefined || value === null) && options.label !== undefined) {
        const option = Array.from(el.options).find((item) => dshNormalizeText(item.text) === dshNormalizeText(options.label));
        if (!option) return fail('OPTION_NOT_FOUND', `找不到选项 "${options.label}"`);
        value = option.value;
      }
      if (value === undefined || value === null) return fail('VALUE_REQUIRED', 'select 需要 value 或 label');
      const option = Array.from(el.options).find((item) => item.value === String(value));
      if (!option) return fail('OPTION_NOT_FOUND', `找不到选项值 "${value}"`);
      dshSetNativeValue(el, option.value);
      dshDispatchInput(el, option.value);
      result.value = el.value;
      result.label = option.text;
    } else if (action === 'press') {
      if (!options.key) return fail('VALUE_REQUIRED', 'press 需要 key（例如 Enter / Escape / Control+A）');
      result.press = dshPressKey(el, options.key);
    } else if (action === 'check' || action === 'uncheck') {
      if (!el) return fail('TARGET_REQUIRED', `${action} 需要 target`);
      if (!(el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio'))) {
        return fail('TARGET_NOT_CHECKABLE', `不是 checkbox/radio: ${dshDescribeElement(el)}`);
      }
      const want = action === 'check';
      if (el.checked !== want) el.click();
      result.checked = el.checked;
    } else if (action === 'scroll') {
      if (el) {
        try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: options.behavior || 'auto' }); } catch (e) { /* ignore */ }
      } else if (options.y !== undefined) {
        window.scrollTo({ left: Number(options.x ?? window.scrollX), top: Number(options.y), behavior: options.behavior || 'auto' });
      } else if (options.by_y !== undefined || options.by_x !== undefined) {
        window.scrollBy({ left: Number(options.by_x || 0), top: Number(options.by_y || 0), behavior: options.behavior || 'auto' });
      } else if (options.to === 'top') {
        window.scrollTo({ top: 0, behavior: options.behavior || 'auto' });
      } else if (options.to === 'bottom') {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: options.behavior || 'auto' });
      } else {
        return fail('TARGET_REQUIRED', 'scroll 需要 target、y、by_y 或 to=top/bottom');
      }
      result.scroll_y = window.scrollY;
    } else {
      return fail('UNKNOWN_ACTION', `未知 action: ${action}（支持 click/fill/select/press/check/uncheck/scroll）`);
    }
  } catch (e) {
    if (tracker) tracker.cancel();
    return { ok: false, code: 'ACTION_FAILED', error: e && e.message ? e.message : String(e), target: targetDesc };
  }

  if (tracker) {
    const settled = await tracker.finish();
    result.settled = settled.settled;
    result.domChanges = settled.mutations;
    result.propertyChanges = settled.propertyChanges || 0;
    result.changed = result.domChanges + result.propertyChanges;
    result.valueChanges = settled.values || [];
    result.waited_ms = settled.waited_ms;
  }
  // Popups the page tried to open during this action (window.open is blocked
  // without a user gesture). Consume them so the next action starts clean.
  // Some pages fall back to same-tab navigation when window.open() is blocked
  // (`const w = window.open(...); if (!w) location.href = url;`). That
  // navigation already landed on the popup target, so opening a second
  // background tab would duplicate the destination.
  const navChanged = location.href !== actionStartHref;
  const arrivedAt = (href) => {
    if (!navChanged || !href) return false;
    const here = location.href.split('#')[0];
    const dest = String(href).split('#')[0];
    return here === dest || here.startsWith(dest + '&') || here.startsWith(dest + '?');
  };
  if (Array.isArray(window.__dshPopups) && window.__dshPopups.length > popupMark) {
    const attempted = window.__dshPopups.slice(popupMark).filter((item) => item && item.href && !arrivedAt(item.href));
    window.__dshPopups.length = popupMark;
    if (attempted.length) result.popups = attempted.map((item) => ({ href: item.href, target: item.target || '_blank' }));
  }
  if (result.popup && arrivedAt(result.popup.href)) result.popup = null;
  // A checkbox / select / controlled input can change state with zero DOM
  // mutations, so always report the live state of the element that was acted
  // on. Without it "0 处变化" reads like the action failed even though
  // checked:false or value:"dev" did take effect.
  const stateEl = el || document.activeElement;
  const state = dshDescribeState(stateEl);
  // Only when there is real state to show: for a plain button click the target
  // descriptor alone would just repeat `target`.
  if (state && Object.keys(state).length > 1) result.state = state;
  return result;
}

function dshParseRegex(text) {
  const raw = String(text == null ? '' : text);
  const match = /^\/(.*)\/([a-z]*)$/.exec(raw);
  if (match) {
    try { return new RegExp(match[1], match[2]); } catch (e) { return null; }
  }
  return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function dshWaitCheck(options) {
  const kind = String(options.for || options.kind || '').toLowerCase();
  const url = location.href;
  const idleMs = Math.max(0, Number(options.idleMs) || 500);
  const net = window.__dshNet || { pending: 0, lastChange: Date.now() };
  if (kind === 'selector') {
    const resolved = dshResolveTarget(options.selector || options.target, 0);
    if (!resolved.ok) return { ok: false, reason: resolved.error || '元素未出现' };
    if (options.visible === true && !dshIsVisible(resolved.el)) return { ok: false, reason: '元素存在但不可见' };
    return { ok: true, matched_text: dshNormalizeText(resolved.el.innerText || resolved.el.textContent || '').slice(0, 120) };
  }
  if (kind === 'text') {
    const needle = dshNormalizeText(options.text);
    if (!needle) return { ok: false, reason: 'text 不能为空' };
    let root = document.body;
    if (options.selector) {
      const resolved = dshResolveTarget(options.selector, 0);
      if (!resolved.ok) return { ok: false, reason: resolved.error };
      root = resolved.el;
    }
    const hay = dshNormalizeText(root?.innerText || root?.textContent || '');
    if (hay.includes(needle)) return { ok: true, matched_text: needle };
    return { ok: false, reason: `文本 "${needle}" 尚未出现` };
  }
  if (kind === 'url') {
    const needle = String(options.url || options.value || '');
    const match = String(options.match || 'includes');
    let ok = false;
    if (match === 'regex') {
      const re = dshParseRegex(needle);
      ok = !!re && re.test(url);
    } else if (match === 'equals') {
      ok = url === needle;
    } else {
      ok = url.includes(needle);
    }
    return ok ? { ok: true, matched_text: url } : { ok: false, reason: `URL 尚未匹配 ${needle}（当前 ${url}）` };
  }
  if (kind === 'load_state' || kind === 'network_idle') {
    const state = String(options.state || (kind === 'network_idle' ? 'networkidle' : 'load'));
    if (state === 'networkidle' || kind === 'network_idle') {
      const quietFor = Date.now() - Number(net.lastChange || 0);
      if (net.pending === 0 && quietFor >= idleMs && document.readyState === 'complete') {
        return { ok: true, matched_text: 'networkidle' };
      }
      return { ok: false, reason: `pending=${net.pending}, quiet=${Math.round(quietFor)}ms, ready=${document.readyState}` };
    }
    if (state === 'domcontentloaded') {
      return document.readyState !== 'loading'
        ? { ok: true, matched_text: document.readyState }
        : { ok: false, reason: 'document.readyState=loading' };
    }
    return document.readyState === 'complete'
      ? { ok: true, matched_text: 'complete' }
      : { ok: false, reason: `document.readyState=${document.readyState}` };
  }
  if (kind === 'stable') {
    const quietFor = Date.now() - Number(window.__dshMutatedAt || 0);
    return quietFor >= idleMs
      ? { ok: true, matched_text: 'stable' }
      : { ok: false, reason: `DOM 仍在变化（${Math.round(quietFor)}ms 前）` };
  }
  return { ok: false, reason: `未知等待类型: ${kind}` };
}

async function dshWaitFor(options) {
  const opts = options || {};
  const started = performance.now();
  const timeoutMs = Math.max(100, Math.min(Number(opts.timeoutMs) || 10000, 28000));
  const pollMs = Math.max(30, Math.min(Number(opts.pollMs) || 100, 1000));
  const deadline = started + timeoutMs;
  let last = null;
  for (;;) {
    last = dshWaitCheck(opts);
    if (last.ok) {
      return {
        ok: true,
        for: String(opts.for || opts.kind || ''),
        waited_ms: Math.round(performance.now() - started),
        url: location.href,
        matched_text: last.matched_text || '',
      };
    }
    if (performance.now() >= deadline) break;
    await dshSleep(Math.min(pollMs, Math.max(0, deadline - performance.now())));
  }
  return {
    ok: false,
    code: 'WAIT_TIMEOUT',
    for: String(opts.for || opts.kind || ''),
    waited_ms: Math.round(performance.now() - started),
    url: location.href,
    error: last ? last.reason : '等待超时',
    hint: '可增大 timeout_ms；若页面仍在导航，先等 load_state 或 network_idle；也可用 browser_scan 检查页面状态。',
  };
}

/**
 * window.open() from page code is blocked by the same popup blocker as an
 * untrusted anchor click: Chrome returns null and opens nothing. Record the
 * destination so browser_act can open it through chrome.tabs.create.
 *
 * Kept separate from the net hooks because those install once per page, while
 * a re-injected runtime must still be able to tap window.open.
 */
function dshInstallPopupTap() {
  if (window.__dshOpenPatched) return;
  window.__dshOpenPatched = true;
  const popups = Array.isArray(window.__dshPopups) ? window.__dshPopups : [];
  window.__dshPopups = popups;
  const origOpen = window.open;
  if (typeof origOpen !== 'function') return;
  window.open = function (url, target, features) {
    const opened = origOpen.apply(window, arguments);
    if (!opened && url) {
      const name = String(target || '').toLowerCase();
      if (!['_self', '_top', '_parent'].includes(name)) {
        let href = String(url);
        try { href = new URL(String(url), location.href).href; } catch (e) { /* keep raw */ }
        if (popups.length < 20) popups.push({ href, target: target ? String(target) : '_blank' });
      }
    }
    return opened;
  };
}

/**
 * Track in-flight fetch/XHR requests so network_idle waits are meaningful.
 * Only a counter and timestamps are kept — no request bodies or headers.
 */
function dshInstallNetHooks() {
  dshInstallPopupTap();
  if (window.__dshHooksInstalled) return;
  window.__dshHooksInstalled = true;
  const state = { pending: 0, lastChange: Date.now() };
  window.__dshNet = state;
  window.__dshMutatedAt = Date.now();
  const mark = () => { state.lastChange = Date.now(); };

  try {
    const observer = new MutationObserver(() => { window.__dshMutatedAt = Date.now(); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch (e) { /* ignore */ }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      state.pending += 1;
      mark();
      return origFetch.apply(this, args).finally(() => {
        state.pending = Math.max(0, state.pending - 1);
        mark();
      });
    };
  }

  const xhrProto = window.XMLHttpRequest && XMLHttpRequest.prototype;
  if (xhrProto && xhrProto.send && !xhrProto.__dshPatched) {
    xhrProto.__dshPatched = true;
    const origSend = xhrProto.send;
    xhrProto.send = function (...args) {
      state.pending += 1;
      mark();
      this.addEventListener('loadend', () => {
        state.pending = Math.max(0, state.pending - 1);
        mark();
      });
      return origSend.apply(this, args);
    };
  }
}
