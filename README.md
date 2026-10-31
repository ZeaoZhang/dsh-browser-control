# dsh-browser-control

把 [GenericAgent](https://github.com/lsdefine/GenericAgent) 的浏览器控制能力（`TMWebDriver` + `simphtml` + `tmwd_cdp_bridge` 扩展）抽取为 **DeepSeek Harness** 的独立插件：一个无第三方依赖的本地 WebSocket 服务 + 一个 Chrome MV3 扩展 + 五个 DSH 工具。

- **无 Python 依赖**：WS 服务用 Node `node:http` 手写 RFC 6455，不需要 `ws` 包；HTML 优化/列表裁剪/变化监控逻辑整体移植到浏览器端 JS。
- **协议兼容**：沿用 GenericAgent 的 `ext_ready` / `tabs_update` / `ack` / `result` / `error` 消息格式，可直接使用原版 `tmwd_cdp_bridge` 扩展；仓库内附带改进版扩展。
- **Token 友好**：扫描只返回可见 DOM，自动裁剪重复列表、压缩属性、截断超长文本。
- **可观察**：执行 JS 时监控短暂提示文本与 DOM 变化，返回差异摘要。
- **CDP 兜底**：CSP 严格页面、文件上传、精确坐标点击等场景可走 `chrome.debugger`。

## 架构

```
DSH 会话 / 模型
   │  browser_tabs / browser_scan / browser_execute_js / browser_cdp / browser_screenshot
   ▼
lib/index.js  ── 注册工具 ──▶ lib/tools.js
   │                              │
   ▼                              ▼
lib/driver.js  ◀──────  WebSocket 127.0.0.1:18865  ──────▶  Chrome 扩展
   │  同一端口提供 HTTP：GET /（扩展探活）、GET /demo（自检页）      background.js
   ▼                                                              │ chrome.scripting / chrome.debugger
页面内注入 window.__DSH_BROWSER__ { scan, startMonitor, finishMonitor } ◀┘
```

- `lib/ws.js`：RFC 6455 服务端实现（握手、掩码、分片、ping/pong、close）。
- `lib/driver.js`：连接管理、标签页注册、请求/响应关联、页面注入、`scan` / `runScript` / `monitorStart` / `monitorFinish` / `cdp` / 标签页操作。
- `lib/page/`：`opt_html.js` 与 `find_main_list.js` 从 GenericAgent 原样提取（`tools/import-from-genericagent.mjs`）；`scan_runtime.js` 是在浏览器里运行的优化、裁剪、截断、diff 实现。
- `lib/tools.js`：五个 DSH 工具定义（`defineTool`）。
- `extension/`：MV3 扩展。`config.js` 里的 `WS_PORT` 必须与插件配置一致。
- `assets/demo.html`：`/demo` 自检页（计数器、表单、弹窗、30 条长列表），用于快速验证 scan/execute/screenshot。

## 目录

```
dsh-browser-control/
├── lib/
│   ├── index.js          # 插件入口：Config + apply
│   ├── driver.js         # WS/HTTP 服务 + 浏览器会话
│   ├── tools.js          # 5 个工具
│   ├── ws.js             # 无依赖 WebSocket 服务端
│   └── page/             # 注入浏览器的扫描运行时
├── extension/            # Chrome MV3 扩展（加载这个目录）
├── assets/demo.html      # /demo 自检页
├── test/                 # plugin / protocol / e2e 测试
├── tools/                # 从 GenericAgent 提取 JS 的脚本
├── cordis.patch.yml      # bundle 安装时插入插件行
└── package.json
```

## 安装

### 1. 加载 Chrome 扩展

1. 打开 `chrome://extensions`，开启右上角“开发者模式”。
2. “加载已解压的扩展程序”，选择本目录下的 **`extension/`**（不是仓库根目录）。
3. 打开任意 `http(s)` 页面，右下角出现 `ljq_driver` 状态角标即表示扩展已运行。
4. 若扩展图标弹窗显示未连接，确认插件服务已启动，并且 `extension/config.js` 的 `WS_PORT` 与插件 `port` 一致。

### 2. 安装 DSH 插件（本地开发 / 热挂载）

与 `@linxin666/dsh-ssh` 相同的做法：profile 的 `node_modules` 软链 + `cordis.patch.yml` 插入一行。

```bash
PLUGIN=$HOME/workspace/dsh/dsh-browser-control
PROFILE=~/.dsh/profiles/desktop

ln -sfn "$PLUGIN" "$PROFILE/node_modules/dsh-browser-control"
```

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: browser-control
      name: dsh-browser-control
      config:
        port: 18865
        host: 127.0.0.1
        timeoutMs: 30000
        defaultMaxScanChars: 35000
        monitor: true
```

重启 DSH（或等 HMR 重新加载）后，新会话即可看到 `browser_*` 工具。注意：**不要同时**把本包加入 `dsh.profile.bundles`，否则 bundle 层与 profile 层会插入同一个 `browser-control` 行而冲突。二选一。

### 3. 作为 bundle 安装（发布后）

`package.json` 已声明 `dsh.bundle.patch: cordis.patch.yml`。发布到 npm（或使用本地 `link:` 依赖）后，在插件管理器中安装 `dsh-browser-control`，再把该 bundle 加入 `dsh.profile.bundles` 即可，无需手写 profile 补丁。

### 4. GenericAgent 共存

GenericAgent 的 `TMWebDriver` 默认监听 **18765**（HTTP 在 18766），本插件默认使用 **18865**，两者互不冲突、可以同时运行。若 18865 也被其它程序占用，改本插件 `port` 并同步修改 `extension/config.js` 的 `WS_PORT`，然后重新加载扩展。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `18865` | WebSocket/HTTP 端口，必须与扩展 `config.js` 的 `WS_PORT` 相同 |
| `host` | `127.0.0.1` | 监听地址；仅本机使用，不要暴露到公网 |
| `timeoutMs` | `30000` | 单次扩展往返超时 |
| `defaultMaxScanChars` | `35000` | `browser_scan` 默认字符上限 |
| `monitor` | `true` | `browser_execute_js` 默认监控短暂文本/DOM 变化 |
| `screenshotDir` | 空 | 截图目录；空 = `~/.dsh/browser-control/screenshots` |

修改配置后需要重启插件（端口变更还要重载扩展）。

## 工具

### `browser_tabs`

列出/打开/关闭/激活/导航标签页。无 `tab_id`、`url` 时指向最近使用的标签页。

```json
{ "action": "list" }
{ "action": "open", "url": "https://example.com", "active": true }
{ "action": "navigate", "tab_id": 123, "url": "https://example.com/login" }
{ "action": "close", "tab_id": 123 }
```

> 导航会销毁页面上下文，必须作为独立调用；脚本里不要 `location.href = ...` 之后继续执行。

### 扩展页面（`chrome-extension://`）

`browser_tabs` 现在也会列出 `chrome-extension://` 页面（包括本扩展自己的 `popup.html`）。Chrome 禁止用 `chrome.scripting` 向扩展页面注入脚本，插件检测到后会自动退回 `chrome.debugger` + CDP `Runtime.evaluate`，因此 `browser_scan` / `browser_execute_js` / `browser_screenshot` / `browser_cdp` 在扩展页面上同样可用。`chrome://`、`devtools://` 等浏览器内部页仍然不支持。

```json
{ "action": "open", "url": "chrome-extension://<扩展ID>/popup.html" }
```

### `browser_scan`

返回经过 token 优化的可见 HTML。`text_only=true` 返回纯文本；`cut_list=true`（默认）裁剪大列表；`instruction` 可指定希望保留的列表项关键词；`max_chars` 覆盖默认上限（硬上限：超长时先删减列表/子元素，再压缩文本，保证返回内容不超过约 `max_chars` 字符，并带 `[TRUNCATED]`/`…` 标记）。

```json
{ "text_only": true, "max_chars": 12000 }
{ "cut_list": true, "instruction": "订单 2024" }
```

### `browser_execute_js`

在页面主世界执行 JS，返回最后一行表达式的值（或显式 `return`），并附带短暂文本、DOM diff、新标签页信息。

```js
// 点击并读取结果
document.querySelector('#submit').click();
return document.querySelector('#result').textContent;

// 等待异步结果
return await fetch('/api/items').then((r) => r.json());

// 填写受控输入框（推荐触发 input 事件）
const input = document.querySelector('#name');
input.value = '张三';
input.dispatchEvent(new Event('input', { bubbles: true }));
return input.value;
```

注意：

- `await` 需要显式 `return`；
- 敏感操作（文件上传、`isTrusted` 事件、坐标点击）优先 `browser_cdp`；
- 导航请用 `browser_tabs` 的 `navigate`；
- 后台标签页会被 Chrome 节流，计时器与监控可能延迟，尽量让目标页在前台。

### `browser_cdp`

在标签页执行任意 CDP 方法，返回 JSON 字符串。扩展会临时 `chrome.debugger.attach`，用完自动 detach。

```json
{ "method": "Page.navigate", "params": { "url": "https://example.com" } }
{ "method": "Runtime.evaluate", "params": { "expression": "document.title", "returnByValue": true } }
{ "method": "Page.captureScreenshot", "params": { "format": "png" } }
{ "method": "Input.dispatchMouseEvent", "params": { "type": "mousePressed", "x": 120, "y": 80, "button": "left", "clickCount": 1 } }
```

### `browser_screenshot`

`Page.captureScreenshot` 后写入 `screenshotDir`，返回文件路径与字节数。`format` 支持 `png`/`jpeg`，`quality` 仅 JPEG 生效。

```json
{ "format": "jpeg", "quality": 80 }
```

## 与 GenericAgent 的差异

- 去掉了 Python 端 `TMWebDriver` 的 HTTP 轮询远程模式（18766），只保留本地 WebSocket。
- `simphtml.py` 的 BeautifulSoup 后处理改为浏览器端 DOM 操作；列表检测 `findMainList` 与可见 DOM 提取 `optHTML` 直接复用原 JS。
- 保留了原版协议的向后兼容：原 `tmwd_cdp_bridge` 扩展可以直接连接本服务（没有 `active` 字段时按首个标签页回退）。
- 仓库内扩展相对原版：`config.js` 抽离端口、`ext_ready`/`tabs_update` 带 `active`/`windowId`、`tabs` 命令新增 `close`/`navigate`、修复“同一行既有操作又有 `return`”时自动加 `return` 导致返回值丢失的问题。
- 新增 `browser_screenshot` 与 `/demo` 自检页。

## 测试

```bash
# 1) 插件装配：Config、五个工具注册、无扩展时的提示
node test/plugin.test.mjs

# 2) 协议：真实 WS 服务 + 模拟扩展（握手、ack/result、注入、scan、CDP）
node test/protocol.test.mjs

# 3) 真机端到端：headless Chrome + 本扩展，扫描/点击/await/监控/标签页/导航/CDP 截图
node test/e2e-chrome.test.mjs
```

`plugin.test.mjs` 需要能解析 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`。在 DSH profile 内运行时由 loader 提供；独立 Node 运行可临时：

```bash
mkdir -p node_modules/@deepseek-ai
ln -sfn "$PROFILE/node_modules/@deepseek-ai/schemastery" node_modules/@deepseek-ai/schemastery
ln -sfn "$HOME/workspace/dsh/dsh-remote/node_modules/@deepseek-ai/dsh-tools" node_modules/@deepseek-ai/dsh-tools
```

端到端测试说明：Chrome 137+ 官方版移除了 `--load-extension`，测试改用官方支持的 `--remote-debugging-pipe` + `Extensions.loadUnpacked` 加载未打包扩展；Chrome 138+ 需要同时加 `--enable-unsafe-extension-debugging`。可用 `CHROME=/path/to/Chrome` 覆盖浏览器路径。

## 安全说明

- 服务只监听 `127.0.0.1`；仍建议不要在有敏感账号的日常浏览器里使用，最好用独立 Chrome profile。
- 扩展申请了 `debugger`、`<all_urls>`、`declarativeNetRequest`（移除页面 CSP）等宽权限，能让模型在页面里执行任意 JS/CDP。请只在自己信任的会话中使用。
- 本机其他进程/页面若连接 18865 并发送 `ext_ready`，会注册为“标签页”，但只能收到发往它自己的脚本；真正的扩展仍是唯一能操作 Chrome 的客户端。
- 扩展会为所有页面移除 CSP 响应头，以规避 `unsafe-eval` 限制；这是为了 `browser_execute_js` 的可用性，属于有意为之。

## 常见问题

**扩展页面不在标签页列表里 / 无法扫描？**
请确认扩展已更新到 v2.3+ 并在 `chrome://extensions` 里“重新加载”；旧版会过滤掉 `chrome-extension://` 页面。扩展页面的脚本执行走 CDP 兜底，首次调用可能比普通网页慢一点。

**扩展未连接？**
`curl http://127.0.0.1:18865/` 应返回 `{"ok":true,...}`；在 `chrome://extensions` 里重新加载扩展，并查看 Service Worker 控制台是否有 WS 错误。

**报错 `Cannot read properties of null (reading '0')`？**
这是旧版扩展弹窗在 `chrome://` 等非 http(s) 页面读取 cookies 时的空指针（`url.match(...)[0]`），已在当前版本修复为友好提示。`extension/` 下文件有更新时，必须在 `chrome://extensions` 里点扩展的“重新加载”才会生效；如果 DSH 工具卡片里仍出现该错误，请提供当时的 tab_id、工具名和截图。

**端口被占用（EADDRINUSE）？**
GenericAgent 默认占用 18765/18766，本插件默认 18865，通常不会冲突；若 18865 被占用，修改插件 `port` 并同步扩展 `config.js` 的 `WS_PORT`，然后重新加载扩展。

**扫描结果为空/缺元素？**
`browser_scan` 只保留可见元素；折叠、`display:none`、被遮挡的内容不会出现。可临时用 `browser_execute_js` 读取 `outerHTML` 或改用 `browser_cdp`。

**点击没反应？**
JS `click()` 产生的事件 `isTrusted=false`，部分站点会忽略；改用 `browser_cdp` 的 `Input.dispatchMouseEvent`（坐标用 `getBoundingClientRect`）。

**monitor 没抓到提示？**
提示文本存在时间若短于 450ms 可能漏掉；后台标签页也会被节流。可把页面切到前台或直接在脚本里 `return` 等待后的结果。

## 致谢与来源

- 浏览器端 `opt_html.js`、`find_main_list.js` 直接提取自 [GenericAgent](https://github.com/lsdefine/GenericAgent) 的 `simphtml.py`；`extension/` 派生自其 `tmwd_cdp_bridge` 扩展（MIT License, Copyright (c) 2025 lsdefine）。
- 本仓库在此基础上做了 Node 化、协议精简、扫描/截断修复与工具封装。

## License

MIT（保留上游 MIT 版权声明，见 [LICENSE](LICENSE)）
