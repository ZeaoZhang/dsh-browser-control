# dsh-browser-control

把 [GenericAgent](https://github.com/lsdefine/GenericAgent) 的浏览器控制能力（`TMWebDriver` + `simphtml` + `tmwd_cdp_bridge` 扩展）抽取为 **DeepSeek Harness** 的独立插件：一个无第三方依赖的本地 WebSocket 服务 + 一个 Chrome MV3 扩展 + 九个 DSH 工具。

- **无 Python 依赖**：WS 服务用 Node `node:http` 手写 RFC 6455，不需要 `ws` 包；HTML 优化/列表裁剪/变化监控逻辑整体移植到浏览器端 JS。
- **协议兼容**：沿用 GenericAgent 的 `ext_ready` / `tabs_update` / `ack` / `result` / `error` 消息格式，可直接使用原版 `tmwd_cdp_bridge` 扩展；仓库内附带改进版扩展。
- **Token 友好**：扫描只返回可见 DOM，自动裁剪重复列表、压缩属性、截断超长文本。
- **可观察**：执行 JS 时监控短暂提示文本与 DOM 变化，返回差异摘要。
- **CDP 兜底**：CSP 严格页面、文件上传、精确坐标点击等场景可走 `chrome.debugger`。

## 架构

```
DSH 会话 / 模型
   │  browser_tabs / browser_scan / browser_execute_js / browser_act / browser_upload / browser_download / browser_wait / browser_cdp / browser_screenshot
   ▼
lib/index.js  ── 注册工具 ──▶ lib/tools.js
   │                              │
   ▼                              ▼
lib/driver.js  ◀──────  WebSocket 127.0.0.1:18865  ──────▶  Chrome 扩展
   │  同一端口提供 HTTP：GET /（扩展探活）、GET /demo（自检页）      background.js
   ▼                                                              │ chrome.scripting / chrome.debugger
页面内注入 window.__DSH_BROWSER__ { scan, startMonitor, finishMonitor, act, waitFor, settle } ◀┘
```

- `lib/ws.js`：RFC 6455 服务端实现（握手、掩码、分片、ping/pong、close）。
- `lib/driver.js`：连接管理、标签页注册、请求/响应关联、页面注入、`scan` / `runScript` / `monitorStart` / `monitorFinish` / `act` / `waitFor` / `cdp` / 标签页操作；导航前解析相对 URL，绝对 URL 原样透传。
- `lib/page/`：`opt_html.js` 与 `find_main_list.js` 从 GenericAgent 原样提取（`tools/import-from-genericagent.mjs`）；`scan_runtime.js` 是在浏览器里运行的优化、裁剪、截断、diff 实现；`actions.js` 提供 ref 编号、高层交互、等待与 DOM 稳定检测。
- `lib/tools.js`：九个 DSH 工具定义（`defineTool`）。
- `extension/`：MV3 扩展。`config.js` 里的 `WS_PORT` 必须与插件配置一致；`popup_bridge.js` 负责把页面里延迟触发的 `window.open` 转发给后台。
- `assets/demo.html`：`/demo` 自检页（计数器、表单、弹窗、异步按钮、上传/下载、延迟 `window.open`、30 条长列表），用于快速验证 scan/act/wait/execute/upload/download/screenshot。另提供 `/download?name=&bytes=` 下载 fixture。

## 目录

```
dsh-browser-control/
├── lib/
│   ├── index.js          # 插件入口：Config + apply
│   ├── driver.js         # WS/HTTP 服务 + 浏览器会话
│   ├── tools.js          # 9 个工具
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
5. 本版本扩展新增了 `downloads` 权限与 `popup_bridge.js` content script；从旧版本升级后需要在 `chrome://extensions` 里点一次“重新加载”，否则异步窗口兜底和下载工具不可用。

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
{ "action": "list", "scope": "agent" }
{ "action": "open", "url": "https://example.com", "active": true }
{ "action": "navigate", "tab_id": 123, "url": "https://example.com/login" }
{ "action": "navigate", "tab_id": 123, "url": "/knowledge/?status=reviewed&td_key=2026102000179" }
{ "action": "close", "tab_id": 123 }
{ "action": "close_agent_tabs" }
{ "action": "health" }
```

- `navigate` 的绝对 URL 原样透传，`&` 不会被二次编码；相对 URL 以当前页为基准解析，也支持 `?a=1&b=2`。
- `open` 会等到标签页 `status=complete` 再返回，`new_tab_json` 里有可用的 `url`/`title`。
- `scope` 只影响 `list`；由本插件打开的标签页会标记 `agent: true`，`close_agent_tabs` 只关这些（浏览器至少保留一个标签页）。
- `health` 返回服务/扩展/标签页的自检结果与修复提示。

> 导航会销毁页面上下文，必须作为独立调用；脚本里不要 `location.href = ...` 之后继续执行。


#### 跨扩展页面（合作式桥接）

Chrome 不允许扩展 A 控制扩展 B 的 `chrome-extension://` 页面（`chrome.scripting` 和 `chrome.debugger` 都会被拒绝）。如果目标扩展是你自己的源码，可以在它里面加一个约 40 行的桥接：用目标扩展自己的 `chrome.debugger` 去执行我们发来的代码。

以 OpenTeam 为例（源码 `/Users/zhangzeao/workspace/openteam`）：

1. `public/manifest.json` 的 `permissions` 里加 `"debugger"`；
2. `src/background/index.ts` 里注册 `chrome.runtime.onMessageExternal`，校验 `sender.id` 后 `chrome.debugger.attach({ tabId })` + `Runtime.evaluate`；
3. 重新构建并重新加载 OpenTeam。

桥接协议（消息体）：

```json
{ "type": "DSH_BROWSER_BRIDGE", "tabId": 123, "expression": "document.title" }
{ "type": "DSH_BROWSER_BRIDGE", "tabId": 123, "method": "Page.captureScreenshot", "params": { "format": "png" } }
```

插件检测到目标 tab 属于 `chrome-extension://` 且不是自己时，会在普通通道失败后自动调用 `ext_eval` / `ext_cdp` 走桥接；目标扩展没有实现桥接时会返回上面那条友好错误。桥接里请把 `DSH_BROWSER_EXTENSION_ID` 固定为本插件的扩展 ID（当前 `ldcmjcmnjgdfiifmbjbjegncfdgpnlbp`）。

### 扩展页面（`chrome-extension://`）

`browser_tabs` 现在也会列出 `chrome-extension://` 页面（包括本扩展自己的 `popup.html`）。Chrome 禁止用 `chrome.scripting` 向扩展页面注入脚本，插件检测到后会自动退回 `chrome.debugger` + CDP `Runtime.evaluate`，因此 `browser_scan` / `browser_execute_js` / `browser_screenshot` / `browser_cdp` 在扩展页面上同样可用。`chrome://`、`devtools://` 等浏览器内部页仍然不支持；另外 Chrome 禁止扩展访问**其他扩展**的 `chrome-extension://` 页面（报错 `Cannot access a chrome-extension:// URL of different extension`），因此可操控的扩展页面仅限本插件自己的 `popup.html` 等页面。

```json
{ "action": "open", "url": "chrome-extension://<扩展ID>/popup.html" }
```

### `browser_scan`

返回经过 token 优化的可见 HTML。`text_only=true` 返回纯文本；`cut_list=true`（默认）裁剪大列表，HTML 与 `text_only` 两种模式都生效；`instruction` 可指定希望保留的列表项关键词；`max_chars` 覆盖默认上限（硬上限，两种模式都生效：HTML 按文档顺序保留整节点、只在文本字符边界截断；`text_only` 优先切在行边界，避免出现 `[INPUT #subscri` 这种半截 token；尾部丢弃的内容以 `[TRUNCATED N chars]` 标出实际字符数，上限极小时退化为 `…`）。

HTML 模式下，可见的可交互元素会带 `data-dsh-ref="@eN"`（如 `@e12`），可直接用于 `browser_act` 的 `target`；同一元素在重新扫描时会复用原 ref，元素被移除/重渲染后旧 ref 失效。`text_only` 模式不产生 ref。

链接与资源地址：`href` 保留真实目标（`http(s)`/`mailto:`/`tel:`/相对路径/锚点都会原样返回，超过 400 字符的才被截断为 `…`），只有 `javascript:`/`data:`/`vbscript:` 这类可执行 scheme 会被替换成 `__link__` 以免被误用；`src`/`action` 等地址同理按长度压缩为 `__url__`。因此 scan 结果里的链接可以直接读、直接交给 `browser_tabs open`。

输入框会输出当前 `value`（password 只标记 `data-filled`），checkbox/radio 输出 `checked`，select 输出 `data-selected`，并保留 `disabled`、`aria-expanded` 等状态；插件自己的右下角角标（`#dsh-browser-badge`）会被过滤。

```json
{ "text_only": true, "max_chars": 12000 }
{ "cut_list": true, "instruction": "订单 2024" }
```

### `browser_execute_js`

在页面主世界执行 JS，返回最后一行表达式的值（或显式 `return`），并附带短暂文本、紧凑 DOM diff、新标签页信息。`diff` 形如 `{changed, added, removed, summary: "+2 -1 ~1", items: [...]}`：`~n` 是控件属性值（checkbox `checked`、select `value`、受控输入框）的变化数并计入 `changed`，`items` 里对应条目以 `~` 开头（如 `~ input#subscribe-checkbox true → false`）；最多列 8 条，不再回传整段 HTML。

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

### `browser_act`

高层交互：`click` / `fill` / `select` / `press` / `check` / `uncheck` / `scroll`。`target` 支持 scan 返回的 ref（`@e12` 或 `ref=e12`）、CSS（默认）、`text=可见文本`、`role=button[name="保存"]`；动作后会等 DOM 安静（settle，默认静默 100ms、最长 800ms）再返回 `changed`。

```json
{ "action": "click", "target": "@e12" }
{ "action": "click", "target": "button#submit-btn" }
{ "action": "fill", "target": "#name-input", "value": "张三" }
{ "action": "fill", "target": "text=搜索", "value": "订单 2024" }
{ "action": "select", "target": "#role-select", "value": "qa" }
{ "action": "press", "target": "#search", "key": "Enter" }
{ "action": "press", "key": "Escape" }
{ "action": "check", "target": "#subscribe-checkbox" }
{ "action": "scroll", "target": "text=加载更多" }
{ "action": "scroll", "by_y": 600 }
```

- `@eN` 来自最近一次 `browser_scan`；页面跳转、列表重渲染或元素被移除后可能失效，此时会返回 `REF_STALE`，重新 scan 取新 ref 即可。
- `fill` 用原生 `value` setter + `input`/`change` 事件，兼容 React/Vue 受控输入；成功后返回 `result_json` 里的当前值。
- `press` 支持 `Control/Meta/Alt/Shift+键`；在输入框里按 `Enter` 会额外触发所在表单的 `requestSubmit()`。
- click 若触发导航，工具会检测 URL 变化并按成功返回；动作后仍建议用 `browser_wait` 明确等待目标状态。
- `target="_blank"` / 命名窗口的链接，以及页面脚本里的 `window.open()`：合成点击没有用户手势，浏览器会把新窗口当弹窗拦截。页面会回报被拦下的目标（链接点击走 `popup` 字段，`window.open` 走 `popups` 数组），工具在没等到新标签页时用 `chrome.tabs.create` 在后台打开（去重、最多 3 个）并写入 `new_tabs`，回执 `hint` 说明是兜底打开的；需要新标签页前台显示时传 `active` 或在之后用 `browser_tabs activate`。
- **异步 `window.open`**（`点击 → 请求完成 → 打开新窗口`、`setTimeout`、`await` 之后）：补丁常驻在页面里，动作返回后才发生的 `window.open` 会经 `popup_bridge.js` 转发给后台，由扩展用 `chrome.tabs.create` 打开，并通过 `newTabs` 消息登记到 driver。这类 tab 不需要再调用一次 `browser_act`；想在同一动作里等到它，传 `await_popup_ms`（如 `3000`），工具会轮询标签页并把结果写进 `new_tabs` / `hint`。页面里 `window.open()` 的返回值仍然是 `null`（单页脚本的 `if (!w) fallback` 逻辑照常成立）；如果页面同时做了同标签回退，补丁会跳过重复开 tab。
- `changed` = DOM mutation 数 + 属性值变化数（`dom_changes` / `property_changes` 分开回传）。`check`/`uncheck`、`select`、受控输入框只改 `checked`/`value` 等 property，不产生 mutation，以前会误报“0 处变化”。
- 回执还带 `state_json`（目标元素当前生效状态，如 `{"checked":false}`、`{"value":"qa","label":"测试"}`）和 `value_changes_json`（本次动作前后状态差异），属性值没变时不会列。
- `changed` 会统计 `<dialog open>`、`inert`、`aria-modal`、`data-state` 等弹窗/portal 常见属性变化，弹窗已打开不会再误报“0 处变化”。
- 默认 settle 上限 800ms；持续重渲染的页面可用 `settle_timeout_ms` 调整。站点若忽略 `isTrusted=false` 的 JS 点击，退回 `browser_cdp` 的 `Input.dispatchMouseEvent`。

### `browser_upload`

给页面的 `<input type="file">` 写入本机文件。页面 JS 无法伪造 `input.files`，这里通过 CDP `DOM.setFileInputFiles` 写入真实文件，页面会收到正常的 `input`/`change` 事件。`target` 与 `browser_act` 相同（CSS / `text=` / `role=` / `@eN`），`files` 是绝对路径数组（多选 input 可传多个）。

```json
{ "target": "#file-input", "files": ["/tmp/report.pdf"] }
{ "target": "@e12", "files": ["/tmp/a.png", "/tmp/b.png"], "settle": true }
```

- 返回实际 `input.files`（`files_json`）、`count`、`multiple`/`accept`，以及写入后 settle 期间的 DOM 变化；`hint` 会说明页面是否响应了 `change`。
- 文件不存在、不可读、目标不是 file input（`NOT_FILE_INPUT`）都会返回明确的错误；被 React 重新渲染掉的组件可用 `browser_wait` 先等 loading 结束，或用更稳定的 CSS 定位。
- 很多上传组件把真实 input 隐藏起来：先 `browser_scan` 找到 `<input type="file">`，再按 CSS 或 `@eN` 定位；写入后继续 `browser_act` 点击“提交”即可。当前只支持主文档里的 file input（iframe 内的上传控件会被标记但 CDP 找不到节点，会报错而不是静默失败）。

### `browser_download`

通过 `chrome.downloads` 下载文件或等待页面自己触发的下载，返回绝对保存路径、字节数、状态与目录。

```json
{ "action": "url", "url": "https://example.com/report.pdf" }
{ "action": "url", "url": "https://example.com/report.pdf", "filename": "reports/q3.pdf" }
{ "action": "click", "target": "#download-link" }
{ "action": "wait", "since": 1762000000000 }
{ "action": "list", "limit": 5 }
```

- `action=url` 由扩展直接发起下载（`saveAs:false`、同名文件 `uniquify`），`filename` 相对默认下载目录；返回时通常已 `complete`。
- `action=click` 用真实的 CDP 鼠标事件点击目标（不是 `element.click()`），因此页面在 click handler 里动态创建 `<a download>` 再 `click()` 的常见“导出/下载按钮”也能触发；随后按点击时间等待新下载。Chrome 会拒绝无用户手势的脚本下载，这也是这里不直接走 `browser_act` 的原因。超时返回 `[DOWNLOAD_NOT_STARTED]`，可改用 `url` 直接下载资源地址。
- `action=wait` 用于页面 JS 自己触发的下载（`since` 是 epoch 毫秒）；`action=list` 查看最近下载记录与下载目录。
- 下载目录由 Chrome 的默认设置决定（headless 测试会把它指到临时目录）；被中断的下载返回 `state=interrupted` 并视为错误。

### `browser_wait`

等待页面达到指定状态，避免用连续 `browser_scan` 轮询。`for` 支持 `selector` / `text` / `url` / `load_state` / `network_idle` / `stable`。

```json
{ "for": "selector", "selector": "#result", "timeout_ms": 8000 }
{ "for": "text", "text": "保存成功", "selector": "#toast" }
{ "for": "url", "url": "/knowledge", "match": "includes" }
{ "for": "load_state", "state": "networkidle" }
{ "for": "stable", "idle_ms": 300 }
```

- `selector` 默认要求元素可见；支持 CSS、`text=`、`role=` 与 scan 的 `@eN`；`text` 可加 `selector` 限定容器；`url` 的 `match` 支持 `includes`/`equals`/`regex`。
- `network_idle` 基于注入的 fetch/XHR 计数器；`idle_ms` 默认 500ms。
- 超时返回 `status: "timeout"`（不是工具错误），带 `waited_ms` 与提示；可据此决定继续或重试。

### `browser_cdp`

在标签页执行任意 CDP 方法，返回 JSON 字符串。扩展会临时 `chrome.debugger.attach`，用完自动 detach。

```json
{ "method": "Page.navigate", "params": { "url": "https://example.com" } }
{ "method": "Runtime.evaluate", "params": { "expression": "document.title", "returnByValue": true } }
{ "method": "Page.captureScreenshot", "params": { "format": "png" } }
{ "method": "Input.dispatchMouseEvent", "params": { "type": "mousePressed", "x": 120, "y": 80, "button": "left", "clickCount": 1 } }
```

### `browser_screenshot`

`Page.captureScreenshot` 后写入 `screenshotDir`，返回文件路径、字节数与尺寸。`format` 支持 `png`/`jpeg`，`quality` 仅 JPEG 生效；`full_page=true` 时通过 `Page.getLayoutMetrics` + clip 截取整页。截图前会临时隐藏插件自己的右下角角标，截完恢复。整页高度超过 16000px（或总像素超过 6400 万）会直接返回 `[SCREENSHOT_TOO_LARGE]`，不会让 CDP 生成超大图或卡住；此时改用 `full_page=false` 分段截图。

```json
{ "format": "jpeg", "quality": 80 }
{ "full_page": true }
```

## 与 GenericAgent 的差异

- 去掉了 Python 端 `TMWebDriver` 的 HTTP 轮询远程模式（18766），只保留本地 WebSocket。
- `simphtml.py` 的 BeautifulSoup 后处理改为浏览器端 DOM 操作；列表检测 `findMainList` 与可见 DOM 提取 `optHTML` 直接复用原 JS。
- 保留了原版协议的向后兼容：原 `tmwd_cdp_bridge` 扩展可以直接连接本服务（没有 `active` 字段时按首个标签页回退）。
- 仓库内扩展相对原版：`config.js` 抽离端口、`ext_ready`/`tabs_update` 带 `active`/`windowId`、`tabs` 命令新增 `close`/`navigate`、修复“同一行既有操作又有 `return`”时自动加 `return` 导致返回值丢失的问题。
- 新增 `browser_screenshot` 与 `/demo` 自检页。
- 新增 `browser_act` 与 `browser_wait`：高层交互、DOM settle、等待 selector/text/url/load_state/network_idle/stable。
- `navigate` 支持相对 URL 且绝对 URL 原样透传；`open` 等待加载完成再返回 url/title；`agent` 标签页标记与 `close_agent_tabs`；`health` 自检。
- `browser_scan` 输出输入框当前值/checked/selected/disabled 并过滤插件角标；HTML 模式给可交互元素分配稳定 `data-dsh-ref="@eN"`，`browser_act` 可直接引用；`text_only` 也会应用 `cut_list`；execute_js 的 DOM diff 改为紧凑摘要。
- `browser_screenshot` 支持 `full_page`，截图时隐藏插件角标；整页超长（>16000px 或 >6400 万像素）返回 `[SCREENSHOT_TOO_LARGE]`；`browser_act` 的 settle 默认 100ms 静默/800ms 上限，可按需调整，且 mutation 计数覆盖 `open`/`inert`/`aria-modal`/`data-state` 等弹窗属性。
- `max_chars` 截断改为按文档顺序保留整节点、只在文本字符边界切分，修复小上限时返回空标签骨架和 `[TRUNCATED 0k chars]` 的回归；`text_only` 同样遵守 `max_chars` 并优先在行边界截断。
- `browser_act` / execute_js diff 把 checkbox `checked`、select `value`、受控输入框等 property 变化计入 `changed`，回执附带当前状态与生效的值变更。
- `browser_act` 点击 `target="_blank"` 链接时，因弹窗拦截不会打开新窗口；改为页面回报链接目标、工具用 `chrome.tabs.create` 后台打开并写入 `new_tabs`。
- `browser_act` 兼容页面脚本里的 `window.open()` 兜底：页面注入轻量包装器记录被弹窗拦截的地址（`popups`），工具同样用 `chrome.tabs.create` 后台打开并在 `hint` 中说明。
- `window.open` 补丁常驻并覆盖异步调用：动作返回后（`setTimeout`/`await` 链）的 `window.open` 经 `popup_bridge.js` 转发给后台打开，配 `await_popup_ms` 可在动作回执里直接看到新标签页；`browser_upload`（CDP `DOM.setFileInputFiles`）与 `browser_download`（`chrome.downloads`，含点击触发/等待/列表）补齐文件上传下载。
- `browser_scan` 不再把所有超过 30 字符的 `href` 替换成 `__link__`，只屏蔽 `javascript:`/`data:`/`vbscript:` 等可执行 scheme，链接目标对 agent 可读。

## 测试

```bash
# 1) 插件装配：Config、九个工具注册、无扩展时的提示
node test/plugin.test.mjs

# 2) 协议：真实 WS 服务 + 模拟扩展（握手、ack/result、注入、scan、CDP、相对 URL、agent tab）
node test/protocol.test.mjs

# 3) 真机端到端：headless Chrome + 本扩展，扫描/ref/act/wait/监控/标签页/导航/CDP 截图/上传下载/异步 window.open
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
- 扩展申请了 `debugger`、`downloads`、`<all_urls>`、`declarativeNetRequest`（移除页面 CSP）等宽权限，能让模型在页面里执行任意 JS/CDP、读写下载目录。请只在自己信任的会话中使用。
- `popup_bridge.js` 只转发形如 `{source:'dsh-browser-control', type:'dsh_popup'}` 的页面消息，且只接受 http(s)/file/chrome-extension 地址、每页每秒最多 6 次；被控制的页面自身理论上也能伪造该消息，但结果最多是多开一个后台标签页，不会执行脚本或回传数据。
- 本机其他进程/页面若连接 18865 并发送 `ext_ready`，会注册为“标签页”，但只能收到发往它自己的脚本；真正的扩展仍是唯一能操作 Chrome 的客户端。
- 扩展会为所有页面移除 CSP 响应头，以规避 `unsafe-eval` 限制；这是为了 `browser_execute_js` 的可用性，属于有意为之。

## 常见问题

**扩展页面不在标签页列表里 / 无法扫描？**
请确认扩展已更新到 v3.0+ 并在 `chrome://extensions` 里“重新加载”；旧版会过滤掉 `chrome-extension://` 页面。扩展页面的脚本执行走 CDP 兜底，首次调用可能比普通网页慢一点。

**扩展未连接？**
`curl http://127.0.0.1:18865/` 应返回 `{"ok":true,...}`；在 `chrome://extensions` 里重新加载扩展，并查看 Service Worker 控制台是否有 WS 错误。

**报错 `Cannot read properties of null (reading '0')`？**
这是旧版扩展弹窗在 `chrome://` 等非 http(s) 页面读取 cookies 时的空指针（`url.match(...)[0]`），已在当前版本修复为友好提示。`extension/` 下文件有更新时，必须在 `chrome://extensions` 里点扩展的“重新加载”才会生效；如果 DSH 工具卡片里仍出现该错误，请提供当时的 tab_id、工具名和截图。

**端口被占用（EADDRINUSE）？**
GenericAgent 默认占用 18765/18766，本插件默认 18865，通常不会冲突；若 18865 被占用，修改插件 `port` 并同步扩展 `config.js` 的 `WS_PORT`，然后重新加载扩展。

**扫描结果为空/缺元素？**
`browser_scan` 只保留可见元素；折叠、`display:none`、被遮挡的内容不会出现。可临时用 `browser_execute_js` 读取 `outerHTML` 或改用 `browser_cdp`。

**点击没反应？**
先用 `browser_act` 的 `click`（带 settle）重试；若站点忽略 `isTrusted=false` 的事件，改用 `browser_cdp` 的 `Input.dispatchMouseEvent`（坐标用 `getBoundingClientRect`）。

**monitor 没抓到提示？**
提示文本存在时间若短于 450ms 可能漏掉；后台标签页也会被节流。可把页面切到前台或直接在脚本里 `return` 等待后的结果。

## 致谢与来源

- 浏览器端 `opt_html.js`、`find_main_list.js` 直接提取自 [GenericAgent](https://github.com/lsdefine/GenericAgent) 的 `simphtml.py`；`extension/` 派生自其 `tmwd_cdp_bridge` 扩展（MIT License, Copyright (c) 2025 lsdefine）。
- 本仓库在此基础上做了 Node 化、协议精简、扫描/截断修复与工具封装。

## License

MIT（保留上游 MIT 版权声明，见 [LICENSE](LICENSE)）
