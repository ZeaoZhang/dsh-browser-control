// Shared by background.js (module service worker). Keep in sync with the
// plugin's `port` setting (see README → 配置).
export const WS_HOST = '127.0.0.1';
export const WS_PORT = 18865;
export const WS_URL = `ws://${WS_HOST}:${WS_PORT}`;
export const HTTP_PROBE = `http://${WS_HOST}:${WS_PORT}`;
