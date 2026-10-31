// Tool definitions exposed to DeepSeek Harness. Each tool maps 1:1 to a
// GenericAgent web capability (scan / execute / tabs / CDP / screenshot).

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { NO_CONNECTION_HELP, delay } from './driver.js';

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

function toJson(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorText(error) {
  if (!error) return '';
  const raw = error.detail?.message || error.message || String(error);
  if (/different extension|Cannot access a chrome-extension:\/\//i.test(raw)) {
    return `${raw}（Chrome 安全限制：跨扩展 chrome-extension:// 页面默认不可访问；本扩展页面可直接控制，其他扩展需要在其源码里实现 DSH_BROWSER_BRIDGE 桥接）`;
  }
  return raw;
}

function formatTabs(tabs) {
  return tabs.map((tab) => {
    const marker = tab.current ? '▶' : tab.active ? '* ' : '  ';
    return `${marker} tab_id=${tab.tab_id}  ${tab.title || '(无标题)'}\n      ${tab.url}`;
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
      '首次使用前需在 Chrome 中安装并启用 dsh-browser-control 扩展；无连接时返回提示。',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'open', 'close', 'activate', 'navigate'],
        description: '操作类型，默认 list。',
      },
      tab_id: TAB_ID_PARAM,
      url: { type: 'string', description: 'open/navigate 的目标网址。' },
      active: { type: 'boolean', description: 'open 时是否切到前台，默认 true。' },
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
        },
      },
      render(_args, value) {
        if (value.action === 'list') {
          const lines = [`Chrome 标签页：${value.count} 个${value.connected ? '' : '（扩展未连接）'}`];
          lines.push(...formatTabs(value.tabs));
          if (value.hint) lines.push('', value.hint);
          return [{ type: 'text', text: lines.join('\n') }];
        }
        const lines = [`操作: ${value.action}`];
        if (value.new_tab_json && value.new_tab_json !== 'null') lines.push(`新标签页: ${value.new_tab_json}`);
        lines.push(`当前标签页数: ${value.count}`);
        lines.push(...formatTabs(value.tabs));
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const action = args.action || 'list';
      if (action === 'list') {
        if (driver.listening) await driver.syncTabs();
        const tabs = driver.listTabs();
        return {
          action,
          connected: driver.connected,
          count: tabs.length,
          tabs,
          hint: driver.connected ? '' : (driver.startError ? `WebSocket 服务启动失败: ${driver.startError.message}` : NO_CONNECTION_HELP),
        };
      }
      if (!driver.connected) {
        throw new Error(driver.startError ? `WebSocket 服务启动失败: ${driver.startError.message}` : NO_CONNECTION_HELP);
      }
      if (action === 'open') {
        if (!args.url) throw new Error('open 需要提供 url');
        const created = await driver.newTab(args.url, args.active !== false);
        await driver.syncTabs();
        const tabs = driver.listTabs();
        return { action, connected: true, count: tabs.length, tabs, new_tab_json: toJson(created) };
      }
      const target = await driver.resolveTarget({ tab_id: coerceTabId(args.tab_id) });
      if (action === 'close') {
        if (target.conn.tabs.size <= 1) throw new Error('不能关闭浏览器最后一个标签页。');
        await driver.closeTab(target);
        await driver.syncTabs();
        const tabs = driver.listTabs();
        return { action, connected: true, count: tabs.length, tabs };
      }
      if (action === 'activate') {
        await driver.activateTab(target);
        await driver.syncTabs();
        const tabs = driver.listTabs();
        return { action, connected: true, count: tabs.length, tabs };
      }
      if (action === 'navigate') {
        if (!args.url) throw new Error('navigate 需要提供 url');
        await driver.navigate(target, args.url);
        await driver.syncTabs();
        const tabs = driver.listTabs();
        return { action, connected: true, count: tabs.length, tabs };
      }
      throw new Error(`未知操作: ${action}`);
    },
  }));

  // ── browser_scan ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'browser_scan',
    description:
      '扫描当前页面并返回经过压缩的 HTML（真实可见 DOM，保留可交互元素与表单值，已经过 token 优化与列表裁剪）。' +
      '这是浏览网页的主要观察手段；先用它了解页面结构，再决定执行什么 JS。' +
      'text_only=true 时返回纯文本。max_chars 控制返回字符上限（默认来自插件配置）。',
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
          `字符数: ${value.chars}`,
        ].join('\n');
        return [{ type: 'text', text: `${head}\n---\n${value.content}` }];
      },
    },
    async execute(args) {
      let target;
      try {
        target = await driver.resolveTarget({ tab_id: coerceTabId(args.tab_id) });
      } catch (error) {
        return { status: 'error', tab_id: 0, url: '', title: '', chars: 0, content: '', tabs: [], error: errorText(error) };
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
        return {
          status: 'success',
          tab_id: target.tab.id,
          url: target.tab.url,
          title: target.tab.title,
          chars: content.length,
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
      '在页面主世界执行 JavaScript，返回最后一行表达式的值（或用 return 显式返回），并回传操作后的 DOM 变化摘要。' +
      '可用 document 等标准 DOM API；点击/输入后建议等待或分步执行。' +
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
          diff: {
            type: 'object',
            additionalProperties: false,
            properties: {
              changed: { type: 'integer' },
              top_change: { type: 'string' },
            },
          },
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
          lines.push(`DOM 变化元素数: ${value.diff.changed}`);
          if (value.diff.top_change) lines.push('主要变化:', value.diff.top_change);
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

  // ── browser_cdp ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'browser_cdp',
    description:
      '通过 Chrome DevTools Protocol 在标签页执行任意 CDP 方法（如 Page.navigate、Input.dispatchMouseEvent、Runtime.evaluate、Network.enable 等）。' +
      '适合 CSP 严格页面、文件上传、精确点击等 browser_execute_js 做不到的操作。返回 JSON 字符串。',
    parameters: {
      tab_id: TAB_ID_PARAM,
      method: { type: 'string', description: 'CDP 方法名，例如 Page.navigate。' },
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
    description: '对当前标签页可见区域截图（PNG/JPEG），保存到本地文件并返回路径。需要扩展具备 debugger 权限。',
    parameters: {
      tab_id: TAB_ID_PARAM,
      format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png。' },
      quality: { type: 'integer', description: 'JPEG 质量 1-100，默认 80。' },
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
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.status !== 'success') return [{ type: 'text', text: `截图失败: ${value.error}` }];
        return [{ type: 'text', text: `截图已保存: ${value.path} (${value.format}, ${value.bytes} bytes)` }];
      },
    },
    async execute(args) {
      const target = await driver.resolveTarget({ tab_id: coerceTabId(args.tab_id) });
      const format = args.format === 'jpeg' ? 'jpeg' : 'png';
      const params = { format };
      if (format === 'jpeg') params.quality = Math.min(100, Math.max(1, args.quality || 80));
      try {
        const result = await driver.cdp(target, 'Page.captureScreenshot', params);
        if (!result || !result.data) throw new Error('CDP 未返回截图数据');
        const buffer = Buffer.from(result.data, 'base64');
        await mkdir(driver.screenshotDir, { recursive: true });
        const extension = format === 'jpeg' ? 'jpg' : 'png';
        const file = path.join(driver.screenshotDir, `browser-${Date.now()}-tab${target.tab.id}.${extension}`);
        await writeFile(file, buffer);
        return { status: 'success', tab_id: target.tab.id, format, path: file, bytes: buffer.length, error: '' };
      } catch (error) {
        return { status: 'error', tab_id: target.tab.id, format, path: '', bytes: 0, error: errorText(error) };
      }
    },
  }));

  logger.info?.('[dsh-browser-control] tools registered: browser_tabs, browser_scan, browser_execute_js, browser_cdp, browser_screenshot');
}
