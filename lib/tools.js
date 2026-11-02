// Tool definitions exposed to DeepSeek Harness. Five original tools plus two
// focused additions: browser_act (high-level interactions) and browser_wait
// (explicit waits). Everything else stays out on purpose.

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { NO_CONNECTION_HELP, delay, resolveNavigateUrl } from './driver.js';

const TAB_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tab_id: { type: 'integer' },
    url: { type: 'string' },
    title: { type: 'string' },
    active: { type: 'boolean' },
    current: { type: 'boolean' },
    browser: { type: 'string' },
    agent: { type: 'boolean' },
  },
};

// tab_id is shown to models as a bare number, but they often pass it back as a
// string (the browser tab id can exceed 2^31). Accept both, and normalise before
// handing it to the driver, which compares ids as numbers.
const TAB_ID_PARAM = {
  description: '目标标签页 id（整数或数字字符串，例如 1619641860），默认当前标签页。',
  oneOf: [{ type: 'integer' }, { type: 'string' }],
};

function coerceTabId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`tab_id 必须是正整数（收到 ${JSON.stringify(value)}），可先用 browser_tabs 查看可用标签页。`);
  }
  return n;
}

const NEW_TAB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tab_id: { type: 'integer' },
    url: { type: 'string' },
    title: { type: 'string' },
  },
};

const DIFF_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    change: { type: 'string' },
    desc: { type: 'string' },
  },
};

const DIFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    changed: { type: 'integer' },
    added: { type: 'integer' },
    removed: { type: 'integer' },
    summary: { type: 'string' },
    items: { type: 'array', items: DIFF_ITEM_SCHEMA },
  },
};

function toJson(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Deterministic failures get a stable code plus a one-line fix hint, so the
// model does not have to guess whether the extension, the page, or the input
// is at fault.
const ERROR_RULES = [
  [/没有已连接的 Chrome 扩展|not connected|WebSocket 服务启动失败|浏览器扩展连接已断开/i, 'BROWSER_NOT_CONNECTED', NO_CONNECTION_HELP],
  [/Cannot access a chrome-extension|different extension/i, 'CROSS_EXTENSION_BLOCKED', 'Chrome 默认禁止跨扩展控制；仅本扩展自己的页面可直接控制，其他扩展需要 DSH_BROWSER_BRIDGE 桥接。'],
  [/Cannot navigate to invalid URL|ERR_INVALID_URL|\[INVALID_URL\]/i, 'INVALID_URL', '相对 URL 需要当前标签页有有效地址；优先传入完整绝对 URL。'],
  [/\[UNSUPPORTED_SCHEME\]/i, 'UNSUPPORTED_SCHEME', '仅支持 http(s)/file/chrome-extension/about:blank；javascript:/data: 等协议不允许导航。'],
  [/Refused to evaluate|unsafe-eval|Content Security Policy|\[CSP_BLOCKED\]/i, 'CSP_BLOCKED', '页面 CSP 阻止了 eval；可改用 browser_cdp 的 Runtime.evaluate，或直接操作 DOM 元素。'],
  [/chrome:\/\/|devtools:\/\/|RESTRICTED_PAGE/i, 'RESTRICTED_PAGE', 'chrome://、devtools:// 等内部页面无法被扩展控制，请切换到普通网页。'],
  [/Another debugger is already attached|Cannot attach|DevTools/i, 'DEBUGGER_BUSY', '关闭该标签页的 DevTools 或其它调试器后重试。'],
  [/找不到标签页|No tab with id|TAB_NOT_FOUND/i, 'TAB_NOT_FOUND', '先调用 browser_tabs 查看当前可用 tab_id。'],
  [/超时|timed out|\[TIMEOUT\]/i, 'TIMEOUT', '确认页面没有卡死或正在导航；必要时增大 timeout_ms。'],
];

function errorText(error) {
  if (!error) return '';
  let raw = error.detail?.message || error.message || String(error);
  if (/different extension|Cannot access a chrome-extension:\/\//i.test(raw)) {
    raw += '（Chrome 安全限制：跨扩展 chrome-extension:// 页面默认不可访问；本扩展页面可直接控制，其他扩展需要在其源码里实现 DSH_BROWSER_BRIDGE 桥接）';
  }
  const rule = ERROR_RULES.find(([re]) => re.test(raw));
  if (!rule) return raw;
  const [re, code, hint] = rule;
  if (new RegExp(`\\[${code}\\]`).test(raw)) return raw;
  return `[${code}] ${raw}\n提示: ${hint}`;
}

function codedError(code, message, hint) {
  return hint ? `[${code}] ${message}\n提示: ${hint}` : `[${code}] ${message}`;
}

function formatTabs(tabs) {
  return tabs.map((tab) => {
    const marker = tab.current ? '▶' : tab.active ? '* ' : '  ';
    const tag = tab.agent ? ' [agent]' : '';
    return `${marker} tab_id=${tab.tab_id}${tag}  ${tab.title || '(无标题)'}\n      ${tab.url}`;
  });
}

function normalizeNewTabs(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((tab) => tab && typeof (tab.id ?? tab.tab_id) === 'number')
    .map((tab) => ({
      tab_id: tab.id ?? tab.tab_id,
      url: String(tab.url || ''),
      title: String(tab.title || ''),
    }));
}

export function registerTools(ctx, driver, config, logger) {
  // ── browser_tabs ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description:
      '列出/打开/关闭/激活/导航 Chrome 标签页。不传 tab_id 与 url 时操作最近使用的标签页。' +
      'agent 创建的标签页会带 agent=true，可用 scope 只查看它们，或用 close_agent_tabs 一次关闭。' +
      'action=health 检查服务、扩展与标签页状态。首次使用前需在 Chrome 中安装并启用扩展。',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'open', 'close', 'close_agent_tabs', 'activate', 'navigate', 'health'],
        description: '操作类型，默认 list。',
      },
      tab_id: TAB_ID_PARAM,
      url: { type: 'string', description: 'open/navigate 的目标网址；navigate 支持相对 URL。' },
      active: { type: 'boolean', description: 'open 时是否切到前台，默认 true。' },
      scope: { type: 'string', enum: ['all', 'agent'], description: 'list 时只看全部或仅 agent 创建的标签页，默认 all。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          connected: { type: 'boolean' },
          count: { type: 'integer' },
          tabs: { type: 'array', items: TAB_ITEM_SCHEMA },
          hint: { type: 'string' },
          new_tab_json: { type: 'string' },
          closed: { type: 'array', items: { type: 'integer' } },
          skipped: { type: 'array', items: { type: 'integer' } },
          health_json: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.action === 'health') {
          const lines = [`健康检查: ${value.connected ? '扩展已连接' : '扩展未连接'}`];
          try {
            const health = JSON.parse(value.health_json);
            for (const check of health.checks || []) lines.push(`${check.ok ? '✔' : '✘'} ${check.name}: ${check.detail}`);
          } catch { /* ignore */ }
          if (value.hint) lines.push('', value.hint);
          return [{ type: 'text', text: lines.join('\n') }];
        }
        if (value.action === 'list') {
          const lines = [`Chrome 标签页：${value.count} 个${value.connected ? '' : '（扩展未连接）'}`];
          lines.push(...formatTabs(value.tabs));
          if (value.hint) lines.push('', value.hint);
          return [{ type: 'text', text: lines.join('\n') }];
        }
        const lines = [`操作: ${value.action}`];
        if (value.new_tab_json && value.new_tab_json !== 'null') lines.push(`新标签页: ${value.new_tab_json}`);
        if (value.closed.length) lines.push(`已关闭 agent 标签页: ${value.closed.join(', ')}`);
        if (value.skipped.length) lines.push(`跳过（浏览器最后一个标签页）: ${value.skipped.join(', ')}`);
        lines.push(`当前标签页数: ${value.count}`);
        lines.push(...formatTabs(value.tabs));
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const action = args.action || 'list';
      if (action === 'list') {
        if (driver.listening) await driver.syncTabs();
        const scope = args.scope === 'agent' ? 'agent' : 'all';
        const all = driver.listTabs();
        const tabs = scope === 'agent' ? all.filter((tab) => tab.agent) : all;
        return {
          action,
          connected: driver.connected,
          count: tabs.length,
          tabs,
          hint: driver.connected ? '' : (driver.startError ? `WebSocket 服务启动失败: ${driver.startError.message}` : NO_CONNECTION_HELP),
          new_tab_json: 'null',
          closed: [],
          skipped: [],
          health_json: '',
        };
      }
      if (action === 'health') {
        const health = driver.health();
        return {
          action,
          connected: health.extension.connected,
          count: health.tabs.total,
          tabs: driver.listTabs(),
          hint: health.hint,
          new_tab_json: 'null',
          closed: [],
          skipped: [],
          health_json: toJson(health),
        };
      }
      if (!driver.connected) {
        throw new Error(driver.startError ? `WebSocket 服务启动失败: ${driver.startError.message}` : NO_CONNECTION_HELP);
      }
      if (action === 'open') {
        if (!args.url) throw new Error('open 需要提供 url');
        const url = resolveNavigateUrl(args.url, '');
        const created = await driver.newTab(url, args.active !== false);
        await driver.syncTabs();
        const tabs = driver.listTabs();
        return {
          action, connected: true, count: tabs.length, tabs,
          new_tab_json: toJson(created), closed: [], skipped: [], health_json: '',
        };
      }
      if (action === 'close_agent_tabs') {
        const result = await driver.closeAgentTabs();
        const tabs = driver.listTabs();
        return {
          action, connected: true, count: tabs.length, tabs,
          new_tab_json: 'null', closed: result.closed, skipped: result.skipped, health_json: '',
        };
      }
      const target = await driver.resolveTarget({ tab_id: coerceTabId(args.tab_id) });
      if (action === 'close') {
        if (target.conn.tabs.size <= 1) throw new Error('不能关闭浏览器最后一个标签页。');
        await driver.closeTab(target);
        await driver.syncTabs();
        const tabs = driver.listTabs();
        return { action, connected: true, count: tabs.length, tabs, new_tab_json: 'null', closed: [], skipped: [], health_json: '' };
      }
      if (action === 'activate') {
        await driver.activateTab(target);
        await driver.syncTabs();
        const tabs = driver.listTabs();
        return { action, connected: true, count: tabs.length, tabs, new_tab_json: 'null', closed: [], skipped: [], health_json: '' };
      }
      if (action === 'navigate') {
        if (!args.url) throw new Error('navigate 需要提供 url');
        await driver.navigate(target, args.url);
        await driver.syncTabs();
        const tabs = driver.listTabs();
        return { action, connected: true, count: tabs.length, tabs, new_tab_json: 'null', closed: [], skipped: [], health_json: '' };
      }
      throw new Error(`未知操作: ${action}`);
    },
  }));

  // ── browser_scan ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'browser_scan',
    description:
      '扫描当前页面并返回经过压缩的 HTML（真实可见 DOM，保留可交互元素与表单当前值/checked/disabled/展开态，已经过 token 优化与列表裁剪）。' +
      '可交互元素带 data-dsh-ref="@eN"，后续 browser_act 可直接用该 ref 定位。' +
      '这是浏览网页的主要观察手段；先用它了解页面结构，再决定动作。text_only=true 时返回纯文本（不含 ref）。' +
      'max_chars 控制返回字符上限（默认来自插件配置）。插件自身的状态角标会被过滤。',
    parameters: {
      tab_id: TAB_ID_PARAM,
      max_chars: { type: 'integer', description: '返回内容最大字符数。' },
      text_only: { type: 'boolean', description: '只返回页面文本（更省 token）。' },
      cut_list: { type: 'boolean', description: '是否裁剪大型重复列表（默认 true）。' },
      instruction: { type: 'string', description: '希望保留的列表项关键词；用于列表裁剪时优先保留匹配项。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          tab_id: { type: 'integer' },
          url: { type: 'string' },
          title: { type: 'string' },
          chars: { type: 'integer' },
          refs: { type: 'integer' },
          content: { type: 'string' },
          tabs: { type: 'array', items: TAB_ITEM_SCHEMA },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.status !== 'success') {
          return [{ type: 'text', text: `扫描失败: ${value.error || '未知错误'}` }];
        }
        const head = [
          `标签页 tab_id=${value.tab_id}  ${value.title || '(无标题)'}`,
          value.url,
          `字符数: ${value.chars}${value.refs ? ` / refs: ${value.refs}` : ''}`,
        ].join('\n');
        return [{ type: 'text', text: `${head}\n---\n${value.content}` }];
      },
    },
    async execute(args) {
      let target;
      try {
        target = await driver.resolveTarget({ tab_id: coerceTabId(args.tab_id) });
      } catch (error) {
        return { status: 'error', tab_id: 0, url: '', title: '', chars: 0, refs: 0, content: '', tabs: [], error: errorText(error) };
      }
      const options = {
        maxChars: args.max_chars || config.defaultMaxScanChars,
        textOnly: args.text_only === true,
        cutList: args.cut_list !== false,
        instruction: args.instruction || '',
      };
      try {
        let content = String(await driver.scan(target, options));
        if (options.textOnly) {
          content = content
            .replace(/ {2,}/g, ' ')
            .replace(/^ +/gm, '')
            .replace(/(\n\s*){3,}/g, '\n\n')
            .trim();
        }
        await driver.refreshTabs(target.conn).catch(() => {});
        const refs = options.textOnly ? 0 : (content.match(/data-dsh-ref="/g) || []).length;
        return {
          status: 'success',
          tab_id: target.tab.id,
          url: target.tab.url,
          title: target.tab.title,
          chars: content.length,
          refs,
          content,
          tabs: driver.listTabs(),
        };
      } catch (error) {
        return {
          status: 'error',
          tab_id: target.tab.id,
          url: target.tab.url,
          title: target.tab.title,
          chars: 0,
          refs: 0,
          content: '',
          tabs: driver.listTabs(),
          error: errorText(error),
        };
      }
    },
  }));

  // ── browser_execute_js ──────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'browser_execute_js',
    description:
      '在页面主世界执行 JavaScript，返回最后一行表达式的值（或用 return 显式返回），并回传精简的 DOM 变化摘要。' +
      '可用 document 等标准 DOM API；简单的点击/输入优先用 browser_act，等待用 browser_wait。' +
      '脚本中可以使用 await，但需要写 return（例如：return await fetch("/api").then(r=>r.json())）。' +
      '不要用本工具做整页导航，导航请用 browser_tabs 的 navigate 操作。',
    parameters: {
      tab_id: TAB_ID_PARAM,
      code: { type: 'string', description: '要执行的 JavaScript。' },
      monitor: { type: 'boolean', description: '是否监控短暂文本/DOM 变化，默认来自插件配置。' },
      timeout_ms: { type: 'integer', description: '本次执行超时时间（毫秒）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          tab_id: { type: 'integer' },
          url: { type: 'string' },
          reloaded: { type: 'boolean' },
          elapsed_ms: { type: 'integer' },
          js_return_json: { type: 'string' },
          error: { type: 'string' },
          new_tabs: { type: 'array', items: NEW_TAB_SCHEMA },
          transients: { type: 'array', items: { type: 'string' } },
          diff: DIFF_SCHEMA,
          suggestion: { type: 'string' },
        },
      },
      render(_args, value) {
        const lines = [
          `状态: ${value.status}`,
          `标签页: tab_id=${value.tab_id}  ${value.url}`,
        ];
        if (value.reloaded) lines.push('页面已重新加载/导航');
        if (value.js_return_json !== 'null' && value.js_return_json !== 'undefined') {
          lines.push('返回值 (JSON):', value.js_return_json);
        }
        if (value.error) lines.push(`错误: ${value.error}`);
        if (value.transients.length) lines.push('短暂文本变化:', JSON.stringify(value.transients));
        if (value.diff) {
          lines.push(`DOM 变化: ${value.diff.summary}（共 ${value.diff.changed} 处）`);
          for (const item of value.diff.items.slice(0, 8)) lines.push(`  ${item.change} ${item.desc}`);
        }
        if (value.new_tabs.length) lines.push('新标签页:', JSON.stringify(value.new_tabs));
        if (value.suggestion) lines.push(`建议: ${value.suggestion}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      if (!args.code || !String(args.code).trim()) throw new Error('code 不能为空');
      const target = await driver.resolveTarget({ tab_id: coerceTabId(args.tab_id) });
      const monitor = args.monitor === undefined ? config.monitor : args.monitor;
      const before = driver.listTabs().filter((tab) => tab.browser === target.conn.id);
      const started = Date.now();

      let startInfo = null;
      if (monitor) {
        try { startInfo = await driver.monitorStart(target); } catch { /* monitoring is best effort */ }
      }
      let jsReturn;
      let error = '';
      try {
        jsReturn = await driver.runScript(target, String(args.code));
      } catch (caught) {
        error = errorText(caught);
      }
      if (monitor) await delay(1000);
      const monitorResult = monitor
        ? await driver.monitorFinish(target)
        : { transients: [], diff: null, timeOrigin: null, url: null };

      await driver.refreshTabs(target.conn).catch(() => {});
      const after = driver.listTabs().filter((tab) => tab.browser === target.conn.id);
      const beforeIds = new Set(before.map((tab) => tab.tab_id));
      const newTabs = after
        .filter((tab) => !beforeIds.has(tab.tab_id))
        .map((tab) => ({ tab_id: tab.tab_id, url: tab.url, title: tab.title }));

      const reloaded = Boolean(
        startInfo?.timeOrigin && monitorResult?.timeOrigin && startInfo.timeOrigin !== monitorResult.timeOrigin,
      );

      let suggestion = '';
      if (error && /Refused to evaluate|unsafe-eval|Content Security Policy/i.test(error)) {
        suggestion = '页面 CSP 阻止了 eval，可改用 browser_cdp 执行 Runtime.evaluate，或换用 DOM 按钮/链接操作。';
      } else if (error && /超时/.test(error)) {
        suggestion = '页面可能忙碌或导航中；可拆分为更小的脚本或稍后重试。';
      } else if (error && /not connected|断开|没有已连接/i.test(error)) {
        suggestion = NO_CONNECTION_HELP;
      }

      return {
        status: error ? 'error' : 'success',
        tab_id: target.tab.id,
        url: monitorResult?.url || target.tab.url || '',
        reloaded,
        elapsed_ms: Date.now() - started,
        js_return_json: error ? 'null' : toJson(jsReturn),
        error,
        new_tabs: newTabs,
        transients: Array.isArray(monitorResult?.transients) ? monitorResult.transients : [],
        ...(monitorResult?.diff ? { diff: monitorResult.diff } : {}),
        suggestion,
      };
    },
  }));

  // ── browser_act ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'browser_act',
    description:
      '执行高层交互：click / fill / select / press / check / uncheck / scroll。' +
      'target 支持 CSS、text=按钮文字、role=button[name="保存"]；index 选择第 N 个匹配。' +
      'fill 使用框架兼容的 native setter + input/change 事件，可直接用于 React/Vue 受控输入。' +
      '动作结束后默认等待 DOM 稳定（settle）。',
    parameters: {
      tab_id: TAB_ID_PARAM,
      action: {
        type: 'string',
        enum: ['click', 'fill', 'select', 'press', 'check', 'uncheck', 'scroll'],
        description: '要执行的动作。',
        required: true,
      },
      target: { type: 'string', description: '目标元素：scan 返回的 ref（@e12 或 ref=e12）、CSS 选择器、text=文本 或 role=button[name="保存"]。scroll 时可省略。' },
      value: { type: 'string', description: 'fill 的文本，或 select 的选项 value。' },
      label: { type: 'string', description: 'select 时按选项文本选择（与 value 二选一）。' },
      key: { type: 'string', description: 'press 的按键，例如 Enter、Escape、Control+A。' },
      index: { type: 'integer', description: '多个匹配时选第几个，从 0 开始，默认 0。' },
      timeout_ms: { type: 'integer', description: '等待元素出现的时间，默认 5000ms。' },
      settle: { type: 'boolean', description: '动作后是否等待 DOM 稳定，默认 true。' },
      settle_timeout_ms: { type: 'integer', description: 'settle 最长等待毫秒数，默认 800；持续重渲染的页面可调大。' },
      y: { type: 'integer', description: 'scroll：绝对 Y 坐标。' },
      by_y: { type: 'integer', description: 'scroll：相对当前 Y 偏移。' },
      x: { type: 'integer', description: 'scroll：绝对 X 坐标。' },
      by_x: { type: 'integer', description: 'scroll：相对当前 X 偏移。' },
      to: { type: 'string', enum: ['top', 'bottom'], description: 'scroll：滚到顶部或底部。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          action: { type: 'string' },
          tab_id: { type: 'integer' },
          url: { type: 'string' },
          title: { type: 'string' },
          target: { type: 'string' },
          changed: { type: 'integer' },
          settled: { type: 'boolean' },
          elapsed_ms: { type: 'integer' },
          result_json: { type: 'string' },
          new_tabs: { type: 'array', items: NEW_TAB_SCHEMA },
          error: { type: 'string' },
          hint: { type: 'string' },
        },
      },
      render(_args, value) {
        const lines = [
          `状态: ${value.status}`,
          `动作: ${value.action}${value.target ? ` → ${value.target}` : ''}`,
          `标签页: tab_id=${value.tab_id}  ${value.url}`,
        ];
        if (value.settled) lines.push(`DOM 已稳定（${value.changed} 处变化，${value.elapsed_ms}ms）`);
        if (value.error) lines.push(`错误: ${value.error}`);
        if (value.hint) lines.push(`提示: ${value.hint}`);
        if (value.new_tabs.length) lines.push('新标签页:', JSON.stringify(value.new_tabs));
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const target = await driver.resolveTarget({ tab_id: coerceTabId(args.tab_id) });
      const before = driver.listTabs().filter((tab) => tab.browser === target.conn.id);
      const started = Date.now();
      const spec = {
        action: args.action,
        target: args.target || '',
        value: args.value,
        label: args.label,
        key: args.key,
        index: args.index || 0,
        timeoutMs: args.timeout_ms || 5000,
        settle: args.settle !== false,
        settleTimeoutMs: args.settle_timeout_ms,
        y: args.y,
        by_y: args.by_y,
        x: args.x,
        by_x: args.by_x,
        to: args.to,
      };
      let result = null;
      let error = '';
      let hint = '';
      let navigationError = false;
      try {
        result = await driver.act(target, spec);
        if (result && result.ok === false) {
          error = codedError(result.code || 'ACTION_FAILED', result.error || '动作失败',
            result.hint || (result.code === 'TARGET_NOT_FOUND' ? '先用 browser_scan 查看页面；可改用 text= 或 role= 定位。' : ''));
        }
      } catch (caught) {
        // A navigation destroys the page context mid-command, so this path is
        // the common signal that a click navigated. Wait for the tab URL only
        // here instead of adding a fixed delay to every action.
        error = errorText(caught);
        navigationError = true;
      }
      if (navigationError) {
        const moved = await driver.waitForTabUrl(target, target.tab.url || '', 2000).catch(() => null);
        if (moved) {
          error = '';
          hint = `动作触发了导航，已跳到 ${moved.tab.url}`;
          result = { ok: true, navigated: true };
        } else {
          hint = '动作没有返回结果，可能触发了导航；若页面已跳转，属预期行为。';
        }
      }
      await driver.refreshTabs(target.conn).catch(() => {});
      const after = driver.listTabs().filter((tab) => tab.browser === target.conn.id);
      const beforeIds = new Set(before.map((tab) => tab.tab_id));
      const newTabs = after
        .filter((tab) => !beforeIds.has(tab.tab_id))
        .map((tab) => ({ tab_id: tab.tab_id, url: tab.url, title: tab.title }));
      const live = after.find((tab) => tab.tab_id === target.tab.id) || target.tab;
      const navigated = Boolean(live && live.url && target.tab.url && live.url !== target.tab.url);
      if (navigated && !error) {
        hint = hint || `动作触发了导航，已跳到 ${live.url}`;
      }
      return {
        status: error ? 'error' : 'success',
        action: args.action,
        tab_id: target.tab.id,
        url: live?.url || target.tab.url || '',
        title: live?.title || target.tab.title || '',
        target: result?.target || '',
        changed: Number(result?.changed) || 0,
        settled: Boolean(result?.settled) && !error,
        elapsed_ms: Date.now() - started,
        result_json: toJson(result),
        new_tabs: newTabs,
        error,
        hint,
      };
    },
  }));

  // ── browser_wait ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'browser_wait',
    description:
      '显式等待页面状态：selector 等待元素出现/可见，text 等待文本出现，url 等待 URL 变化，' +
      'load_state 等待 load/domcontentloaded/networkidle，network_idle 等待请求静默，stable 等待 DOM 停止变化。' +
      '超时返回 status=timeout 而不是抛错；动作后建议接一次等待，避免异步渲染未完成。',
    parameters: {
      tab_id: TAB_ID_PARAM,
      for: {
        type: 'string',
        enum: ['selector', 'text', 'url', 'load_state', 'network_idle', 'stable'],
        description: '等待类型。',
        required: true,
      },
      selector: { type: 'string', description: 'selector 类型的目标（支持 CSS/text=/role=/@eN）；text 类型时可作为容器范围。' },
      text: { type: 'string', description: 'text 类型要等待的文本。' },
      url: { type: 'string', description: 'url 类型要匹配的 URL（或正则 /.../flags）。' },
      match: { type: 'string', enum: ['includes', 'equals', 'regex'], description: 'url 匹配方式，默认 includes。' },
      state: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'load_state 的目标状态，默认 load。' },
      visible: { type: 'boolean', description: 'selector 是否要求可见，默认 true。' },
      timeout_ms: { type: 'integer', description: '超时毫秒数，默认 10000。' },
      idle_ms: { type: 'integer', description: 'network_idle/stable 的静默窗口，默认 500ms。' },
      poll_ms: { type: 'integer', description: '轮询间隔，默认 100ms。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          for: { type: 'string' },
          tab_id: { type: 'integer' },
          url: { type: 'string' },
          waited_ms: { type: 'integer' },
          matched_text: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.status === 'ok') {
          const lines = [`等待成功: ${value.for}（${value.waited_ms}ms）`, `标签页: ${value.url}`];
          if (value.matched_text) lines.push(`匹配: ${value.matched_text}`);
          return [{ type: 'text', text: lines.join('\n') }];
        }
        const lines = [`等待${value.status === 'timeout' ? '超时' : '失败'}: ${value.for}（${value.waited_ms}ms）`];
        if (value.error) lines.push(`原因: ${value.error}`);
        if (value.hint) lines.push(`提示: ${value.hint}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const target = await driver.resolveTarget({ tab_id: coerceTabId(args.tab_id) });
      const kind = args.for;
      if (!kind) throw new Error('for 不能为空');
      if (kind === 'selector' && !args.selector) throw new Error('for=selector 需要提供 selector');
      if (kind === 'text' && !args.text) throw new Error('for=text 需要提供 text');
      if (kind === 'url' && !args.url) throw new Error('for=url 需要提供 url');
      const spec = {
        for: kind,
        selector: args.selector || '',
        text: args.text || '',
        url: args.url || '',
        match: args.match || 'includes',
        state: args.state || 'load',
        visible: args.visible !== false,
        timeoutMs: args.timeout_ms || 10000,
        idleMs: args.idle_ms || 500,
        pollMs: args.poll_ms || 100,
      };
      try {
        const result = await driver.waitFor(target, spec);
        await driver.refreshTabs(target.conn).catch(() => {});
        return {
          status: result?.ok ? 'ok' : 'timeout',
          for: result?.for || kind,
          tab_id: target.tab.id,
          url: result?.url || target.tab.url || '',
          waited_ms: Number(result?.waited_ms) || 0,
          matched_text: String(result?.matched_text || ''),
          error: result?.ok ? '' : String(result?.error || result?.reason || '等待超时'),
          hint: result?.ok ? '' : (result?.hint || '可增大 timeout_ms；先确认页面没有在导航。'),
        };
      } catch (error) {
        return {
          status: 'error',
          for: kind,
          tab_id: target.tab.id,
          url: target.tab.url || '',
          waited_ms: 0,
          matched_text: '',
          error: errorText(error),
          hint: '',
        };
      }
    },
  }));

  // ── browser_cdp ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'browser_cdp',
    description:
      '通过 Chrome DevTools Protocol 在标签页执行任意 CDP 方法（如 Page.navigate、Input.dispatchMouseEvent、Runtime.evaluate、Network.enable 等）。' +
      '适合 CSP 严格页面、文件上传、精确点击等 browser_execute_js 做不到的操作。返回 JSON 字符串。',
    parameters: {
      tab_id: TAB_ID_PARAM,
      method: { type: 'string', description: 'CDP 方法名，例如 Page.navigate。', required: true },
      params: { type: 'object', additionalProperties: true, description: 'CDP 方法参数对象。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          tab_id: { type: 'integer' },
          result_json: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.status !== 'success') return [{ type: 'text', text: `CDP 执行失败: ${value.error}` }];
        return [{ type: 'text', text: `CDP 结果 (tab ${value.tab_id}):\n${value.result_json}` }];
      },
    },
    async execute(args) {
      if (!args.method) throw new Error('method 不能为空');
      const target = await driver.resolveTarget({ tab_id: coerceTabId(args.tab_id) });
      try {
        const result = await driver.cdp(target, args.method, args.params || {});
        return { status: 'success', tab_id: target.tab.id, result_json: toJson(result), error: '' };
      } catch (error) {
        return { status: 'error', tab_id: target.tab.id, result_json: 'null', error: errorText(error) };
      }
    },
  }));

  // ── browser_screenshot ──────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: '对当前标签页截图（PNG/JPEG），默认可见区域；full_page=true 时截整页。保存到本地文件并返回路径。需要扩展具备 debugger 权限。',
    parameters: {
      tab_id: TAB_ID_PARAM,
      format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png。' },
      quality: { type: 'integer', description: 'JPEG 质量 1-100，默认 80。' },
      full_page: { type: 'boolean', description: '截取整页（含视口外内容），默认 false。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          tab_id: { type: 'integer' },
          format: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          full_page: { type: 'boolean' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.status !== 'success') return [{ type: 'text', text: `截图失败: ${value.error}` }];
        const size = value.width ? `, ${value.width}x${value.height}` : '';
        return [{ type: 'text', text: `截图已保存: ${value.path} (${value.format}${size}, ${value.bytes} bytes)` }];
      },
    },
    async execute(args) {
      const target = await driver.resolveTarget({ tab_id: coerceTabId(args.tab_id) });
      const format = args.format === 'jpeg' ? 'jpeg' : 'png';
      const params = { format };
      if (format === 'jpeg') params.quality = Math.min(100, Math.max(1, args.quality || 80));
      const fullPage = args.full_page === true;
      let hidden = false;
      let width = 0;
      let height = 0;
      // The injected status badge is plugin UI, not page content. Hide it for
      // the shot and restore it afterwards, even when capture fails.
      const hideScript = `return (() => {
        const nodes = document.querySelectorAll('[data-dsh-ui="1"],#ljq-ind,#dsh-browser-badge');
        nodes.forEach((el) => {
          el.setAttribute('data-dsh-prev-visibility', el.style.visibility || '');
          el.style.visibility = 'hidden';
        });
        return nodes.length;
      })()`;
      const restoreScript = `return (() => {
        document.querySelectorAll('[data-dsh-prev-visibility]').forEach((el) => {
          el.style.visibility = el.getAttribute('data-dsh-prev-visibility') || '';
          el.removeAttribute('data-dsh-prev-visibility');
        });
        return true;
      })()`;
      try {
        try {
          hidden = Boolean(await driver.runScript(target, hideScript));
        } catch {
          // Badge hiding is best-effort; never fail the screenshot over it.
        }
        if (fullPage) {
          const metrics = await driver.cdp(target, 'Page.getLayoutMetrics', {});
          const size = metrics && (metrics.cssContentSize || metrics.contentSize);
          if (!size || !(size.width > 0) || !(size.height > 0)) throw new Error('无法获取页面尺寸');
          width = Math.ceil(size.width);
          height = Math.ceil(size.height);
          params.clip = { x: 0, y: 0, width, height, scale: 1 };
          params.captureBeyondViewport = true;
        }
        const result = await driver.cdp(target, 'Page.captureScreenshot', params);
        if (!result || !result.data) throw new Error('CDP 未返回截图数据');
        const buffer = Buffer.from(result.data, 'base64');
        await mkdir(driver.screenshotDir, { recursive: true });
        const extension = format === 'jpeg' ? 'jpg' : 'png';
        const file = path.join(driver.screenshotDir, `browser-${Date.now()}-tab${target.tab.id}.${extension}`);
        await writeFile(file, buffer);
        return { status: 'success', tab_id: target.tab.id, format, path: file, bytes: buffer.length, full_page: fullPage, width, height, error: '' };
      } catch (error) {
        return { status: 'error', tab_id: target.tab.id, format, path: '', bytes: 0, full_page: fullPage, width, height, error: errorText(error) };
      } finally {
        if (hidden) {
          try {
            await driver.runScript(target, restoreScript);
          } catch {
            // Page may have navigated while capturing.
          }
        }
      }
    },
  }));

  logger.info?.('[dsh-browser-control] tools registered: browser_tabs, browser_scan, browser_execute_js, browser_act, browser_wait, browser_cdp, browser_screenshot');
}
