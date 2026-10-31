import z from '@deepseek-ai/schemastery';
import { BrowserDriver } from './driver.js';
import { registerTools } from './tools.js';

export const name = 'browser-control';

// `tools` must be ready before apply() runs; systemPrompt is optional.
export const inject = ['tools'];

export const Config = z.object({
  /** WebSocket/HTTP port. Must match WS_PORT in extension/config.js. */
  port: z.number().step(1).min(1).max(65535).default(18865),
  /** Bind address. Keep 127.0.0.1 unless the browser runs on another machine. */
  host: z.string().default('127.0.0.1'),
  /** Per-command timeout for extension round-trips. */
  timeoutMs: z.number().step(1).min(1000).max(300000).default(30000),
  /** Default character budget for browser_scan. */
  defaultMaxScanChars: z.number().step(1).min(1000).max(500000).default(35000),
  /** Monitor transient text/DOM changes around browser_execute_js by default. */
  monitor: z.boolean().default(true),
  /** Screenshot directory; empty = ~/.dsh/browser-control/screenshots. */
  screenshotDir: z.string().default(''),
});

function makeLogger(ctx) {
  const logger = ctx.logger;
  return {
    info: (...args) => {
      if (logger?.info) logger.info(...args);
      else console.info(...args);
    },
    warn: (...args) => {
      if (logger?.warn) logger.warn(...args);
      else console.warn(...args);
    },
  };
}

export async function apply(ctx, config) {
  const logger = makeLogger(ctx);
  const resolved = {
    port: config.port,
    host: config.host,
    timeoutMs: config.timeoutMs,
    monitor: config.monitor,
    defaultMaxScanChars: config.defaultMaxScanChars,
    screenshotDir: config.screenshotDir || '',
  };

  const driver = new BrowserDriver({
    host: resolved.host,
    port: resolved.port,
    timeoutMs: resolved.timeoutMs,
    screenshotDir: resolved.screenshotDir || undefined,
    logger,
  });

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void driver.stop();
    }, 'dsh-browser-control.stop');
  }

  driver.start().catch((error) => {
    const hint = error?.code === 'EADDRINUSE'
      ? `端口 ${resolved.port} 已被占用。请换一个 port 并同步修改 extension/config.js 中的 WS_PORT` +
        '（GenericAgent 的 TMWebDriver 默认占用 18765/18766）。'
      : error?.message || String(error);
    logger.warn(`[dsh-browser-control] WebSocket server failed to start: ${hint}`);
  });

  registerTools(ctx, driver, resolved, logger);
}
