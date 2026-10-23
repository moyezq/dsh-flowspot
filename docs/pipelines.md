# dsh-flowspot 主流程实现细节

本文写「一次抓包」和「一次读取」在主流程里的判定、上限、字段落点与失败路径，按代码实际执行顺序排列。核心功能与模块清单见 `architecture.md`，为什么这样选见 `adr.md`，怎么跑见 `README.md`。

## 1. 一次 HTTPS 抓包

### 1.1 装配：`index.js` → `lib/runtime.js`

- `apply(ctx, config)` 只做三件事，且都在 `ctx.effect` 里注册：`ctx.inject(['webServer'])` 挂路由、`ctx.inject(['tools'])` 注册 10 个工具、以及一个卸载钩子在 `runtime.dispose()` 时停代理并恢复系统代理。**顶层 `inject` 只有 `slots`**（客户端），宿主侧服务全部走 nested inject 或 `ctx.get`，理由见 ADR-0008 与踩坑第 1 条。
- runtime 懒创建：第一次调用工具或路由时才 `createRuntime`，失败会记住 `runtimeError` 并在下次直接抛，不重复初始化。**一次挂载**只有一个 runtime，面板与 agent 共用同一份 flow 缓冲，不会有两个实例抢 8899；但热重载（启停插件、改 profile 的 `cordis.patch.yml`）会重新执行 `apply()` 并新建一个 runtime，旧实例由卸载钩子的 `dispose()` 释放。
- `dispose()` = `stop()`（先恢复系统代理再关监听）+ `store.close()`（关 JSONL 流）。卸载时若跳过 `stop()`，注册表里会留下指向死端口的系统代理。

### 1.2 监听与端口兜底：`MitmProxy.start()`

- 绑定 `127.0.0.1`，先试 `cfg.port`（默认 `8899`）。`EADDRINUSE` / `EACCES` / `EPERM` 时改绑 `0` 让系统分配，并把原因写进 `portNote`，`start()` 的 `warning` 与 `snapshot().portNote` 都带这一句（`EACCES` 在本机常见于 Hyper-V/WinNAT 的排除端口段 9198–9297，见踩坑第 2 条之前的端口事故）。
- 两个 `http.Server`：外层 `server` 收 CONNECT 与绝对 URL 形式的请求，内层 `inner` 只处理解密后的隧道请求。`inner` 不进监听，靠 `tlsSocket` 的 `'secure'` 事件 `emit('connection')` 挂载。

### 1.3 CONNECT 与解密：`_handleConnect()`

- `req.url` 形如 `host:port`，用最后一个 `:` 切分（IPv6 的 `[::1]:443` 去掉方括号），缺端口按 443。缺 host 直接回 `400`。
- 先回 `HTTP/1.1 200 Connection Established`，把 CONNECT 残留的 `head` `unshift` 回 socket，否则第一个请求会丢字节。
- `new tls.TLSSocket(clientSocket, { isServer: true, secureContext, SNICallback })`：初始上下文按 CONNECT 的 host 取，`SNICallback` 再按真实 SNI 取（同一隧道里可能换域名）。取不到证书时记 `lastError` 并销毁连接。
- `tlsSocket.__target = { host, port }` 是隧道内请求判定目标的唯一依据；`_handleRequest` 用 `req.socket.__target` 读它。

### 1.4 目标解析：`_resolveTarget()`

- 绝对 URL（`http://` 或 `https://` 开头，普通 HTTP 代理形式）→ 直接 `new URL` 取 scheme/host/port/path。
- 否则读 `req.socket.__target`（隧道）→ 固定 `https`，path 用 `req.url`。
- 两者都没有 → 回 `400`（说明缺少 CONNECT 隧道），**不建 flow**。

### 1.5 请求转发：`_handleRequest()`

- 建 flow 时 `startedAt` 用 `Date.now()`，`url` 由 `scheme://host+path` 拼，`host` 取 `req.headers.host` 去端口，`tunnel` 记录 CONNECT 目的地址。
- 头处理：`_forwardHeaders()` 丢掉 `HOP_BY_HOP`（`connection`、`proxy-*`、`keep-alive`、`te`、`trailer`、`transfer-encoding`、`upgrade`），再重写 `host`（443/80 不带端口）。**Upgrade 请求改走 `DROP_ON_UPGRADE`**：只丢代理相关与 `te/trailer`，保留 `connection`/`upgrade`，否则源站回 400 而不是 101（踩坑见 ADR-0007 与 WS 修复）。
- 上游选项：`http`/`https` 按 scheme 选，`servername` 仅在非 IP 时设（IP 会触发 SNI 校验失败），`ALPNProtocols: ['http/1.1']` 固定，`rejectUnauthorized` 跟 `cfg.upstreamRejectUnauthorized`。
- 连接池：`http.Agent` / `https.Agent` 的 `keepAlive` 默认 **false**、`maxSockets: 64`。不开 keep-alive 是为了消除「复用被源站关掉的空闲连接 → 下一个请求 `socket hang up`」这一类失败（ADR-0007），代价是每请求一次 TCP+TLS。
- 请求体：`req.pipe(tee).pipe(upstream)` 透传，同时把前 `maxBodyBytes`（默认 262144）字节缓存，`req 'end'` 时 `setRequestBody`，其内部再截到 65536。`tee` 与 `req` 都挂 `error` 处理器，否则客户端中途断开会让进程崩溃。
- 响应：收到上游响应头立刻 `res.writeHead()` + `flushHeaders()`，再把 body 通过 `PassThrough` 直接 `pipe(res)`——**不为下游攒整个响应**，所以 SSE/长轮询不会被缓冲卡住；缓存副本只到 `maxBodyBytes` 为止。
- 结束：`upRes 'end'` → `store.finish(flow, {status, headers, body})`；`res 'close'` 且 `!res.writableFinished` 记为 `phase: client`（客户端提前关）。

### 1.6 失败判定与错误分类

- 请求级失败（`upstream.on('error')`、构造请求抛错、超时）：`code = err.code`，`phase = clientAborted ? 'client' : 'upstream'`；超时是 `ETIMEDOUT`（`upstream.setTimeout(cfg.upstreamTimeoutMs ?? 30000)` 后 `destroy`）。
- 响应级失败（`upRes 'aborted'` / `'error'`）：`phase: 'body'`；WS 升级方向失败记 `upgrade`（见 `_handleUpgrade`）。
- **`phase: 'client'` 不算代理失败**：不写 `lastError`、不 `_noteError`，只把 `error/errorCode/errorPhase` 记进 flow。Chrome 的后台请求/预取会大量取消，如果算失败会把真正的上游故障挤掉。
- `_noteError` 聚合键 `method host path | code | phase`，最多 20 条，命中时 `count++`、刷新 `ts/message/flowId`（`flowId` 指向最近一次失败，供面板跳转）。`clearErrors()` 同时清 `recentErrors` 与 `lastError`，由 `webcap_clear` 调用。
- 失败时若还没发响应头，回 `502` 并把原因写进 body；已发过头就 `res.destroy()`（无法再改状态码）。

### 1.7 证书：`lib/x509.js` + `lib/der.js`

- DER 原语在 `der.js`（`tlv/seq/setOf/integer/bitString/octetString/oid/bool/time/context`），不引第三方库（ADR-0003）。
- CA 首次启动生成：RSA-2048、`CA_VALIDITY_DAYS = 3650`、BasicConstraints CA=true、KeyUsage `[5,6]`（keyCertSign + cRLSign）、SubjectKeyId。落盘 `ca.crt` + `ca.key.pem`（私钥 0600）。
- `issuer` 字节必须与 CA subject 完全一致，所以每次 `init()` 都用 `caSubjectDer()` 重新编码同一个 subject，而不是从证书里反解（反解会因顺序/编码差异导致链校验失败）。
- 叶子证书：`LEAF_VALIDITY_DAYS = 397`，共享一对 `leaf.key.pem` / `leaf.pub.der`，BasicConstraints CA=false、KeyUsage `[0,2]`（digitalSignature + keyEncipherment）、EKU serverAuth、SAN（域名走 `dNSName`，IP 走 `iPAddress`，含 IPv6 字节化）、SKI/AKI。
- 缓存：`leafCache` 与 `contextCache` 各最多 `LEAF_CONTEXT_CACHE = 512`，超了删最早插入的一项；`contextFor(host)` 缓存的 `tls.SecureContext` 直接给 `TLSSocket`，避免每次握手重建。

### 1.8 flow 记录：`lib/flows.js`

- 环形缓冲：`maxFlows` 最小 50、默认 1000；超了 `shift()` 最早的并 `byId.delete`，`dropped` 计数。`id = f<seq>`，`seq` 单调递增，是 `since` 时间窗的锚点。
- 字段落点：`reqHeaders` 在 `begin()` 就按配置打码（默认关闭）；`respHeaders`/`mime` 在 `finish()`；`respBody` 由 `describeBody` 生成；`error/errorCode/errorPhase` 只在有错误时写。
- 脱敏集合 `SENSITIVE_HEADERS`：`authorization`、`cookie`、`set-cookie`、`proxy-authorization`、`x-api-key`、`x-auth-token`；仅在 `redact: true` 时命中写 `***redacted***`（默认关闭，ADR-0015）。键名统一转小写。
- `describeBody(buf, headers, maxBytes)`：按 `content-encoding` 用 `zlib` 同步解 `gzip`/`deflate`/`br`（失败就保留原字节并标 `encoding: null`），超过 `maxBytes` 截断并 `truncated: true`；文本判定 = mime 命中 `TEXTUAL` 正则，或字节里控制字符占比 < 2%（有 `\0` 直接判二进制）；文本进 `text`，否则 `base64`。`wireBytes` 记解压前长度，`bytes` 记解压后长度。
- 落盘：`persist` 为真时，`<数据目录>/flows/` 下的 `flows-<ISO时间戳>.jsonl` 由**本次抓包第一条完成的 flow** 触发 `FlowStore.open()` 创建；`MitmProxy.start()` 只调 `beginSession()` 关掉上一份，`stop()` 调 `close()`——一次抓包会话一个文件，只加载插件、或开了抓包但没流量，都不留文件。每完成一条 append 一行，写盘时 body 文本截到 32768，序列化异常只 `log.warn` 不影响抓包。
- 记录边界（改这些前先看 `docs/overview.md`「抓包记录里存了什么」）：头不做长度裁剪；响应体最多 262144 字节、请求体再压到 65536（`proxy.js` 收集 + `setRequestBody`）；`respBytes`/`bytes` 是**捕获到的长度**，达到上限后不再累加，不是真实全长。
- 落盘二次切：文本 `.slice(0, 32768)`（按 UTF-16 code unit 计，不是字节），`base64` 不切；这次切**不更新** `truncated`，所以 JSONL 里可能出现 `truncated: false` 但文本只有 32K 字符。
- 压缩体超上限：上限按压缩后的字节收集，半截 gzip/br 解压失败 → `encoding: null`、按 mime 当文本（乱码）或 base64，`truncated` 可能仍为 false——看到大响应乱码先查这一条。
- 中断：客户端在请求体发完前断开时 `reqBody` 可能为空；响应传到一半断开记半截体 + `errorPhase: body`，`truncated` 不一定为真。
- `summaryOf(flow)` 是列表/分组/工具的共用投影：`id/seq/time/method/status/type/host/port/path/url/mime/durationMs/respBytes/error/errorCode/errorPhase`。
- `resourceTypeOf(flow)` 判定顺序：`upgrade: websocket` 或 `status === 101` → `ws`；`sec-fetch-dest` 命中 `DEST_TYPES` → 对应类型（`empty` → `xhr`，`document`/`iframe`/… → `doc`，`style` → `css`，`script`/`worker` → `js`…）；`report`/`xslt` → `other`；否则 mime 兜底（`wasm` → `wasm`，`image/*` → `img`，`video|audio` → `media`，`font`/`woff` → `font`，`css` → `css`，`javascript|ecmascript` → `js`，`html|xhtml` → `doc`，`manifest` → `manifest`，其余 → `xhr`）。
- `list()` 过滤顺序：`since` → `host`（子串、大小写不敏感）→ `method`（大写比较）→ `status`（精确）→ `type` → `q`（在 `url host method` 里子串）；从新到旧遍历，满 `limit` 就停，默认 20、上限由调用方压到 200。
- `listGroups()`：`method + URL` 为键，`normalize` 为真时 URL 先过 `normalizeUrl()`（去掉 `VOLATILE_PARAMS` 并排序其余参数）；每组带 `count/statuses/errors/first/latest/items`（`items` 最多 `maxItems = 50`，超出置 `truncated`）。
- `search()`：`scope` ∈ `all|url|body`（`all` 同时搜 URL、请求/响应头与两侧报文体，命中项带 `where` 与 `snippet`）；`limit` 上限 100。
- 导出：`curlOf()` 委托 `lib/codegen` 的 cURL 渲染器（与代码视图同一份请求模型）；`harEntryOf()`/`harOf()` 生成 HAR 1.2（headers 转 `{name,value}` 数组、`content.mimeType/size/text`、`startedDateTime/time`）。

## 2. 一次读取（面板与 agent）

### 2.1 工具：`lib/tools.js`

| 工具 | 关键参数 | 说明 |
|---|---|---|
| `webcap_status` | — | 代理快照、系统代理、CA 状态、`flows.stats()`、`paths`（含 `source` 与 `pending`）、`build` |
| `webcap_serve` | `action: start\|stop\|restart`、`port`、`setSystemProxy` | start 后回读系统代理确认；restart = 先 stop 再 start |
| `webcap_ca` | `action: status\|install\|uninstall` | 走 `certutil -addstore/-delstore`，返回 thumbprint 与路径 |
| `webcap_flows` | `type/host/method/status/q/since/limit/group/normalize` | `group: true` 时返回 `{grouped: true, groups}`，否则 `{flows}`；渲染分别走 `groupLine`/`flowLine` |
| `webcap_detail` | `id` | 去掉 body 文本/base64，附 `errorHint`（`ERROR_HINTS` 按 `errorCode`） |
| `webcap_body` | `id`、`side: request\|response`、`offset`、`limit`（默认 4096，上限 65536） | 按字符切片，返回 `text`/`base64` 与 `truncated` |
| `webcap_search` | `q`、`scope: all\|url\|body`、`limit` | URL / 头 / 报文体搜索，命中带 `where` 与片段 |
| `webcap_export` | `format: curl\|har\|json`、`id`、`limit` | curl 单条；har/json 按条数 |
| `webcap_code` | `id`、`lang: curl\|python\|go\|rust\|javascript\|node` | 省略 `lang` 返回语言清单与面板顺序；`id` + `lang` 返回脚本、notes |
| `webcap_cdp` | `action: status\|launch\|attach\|detach\|close\|requests`、`port`、`since`、`limit`、`host`、`matched` | 通道状态与启停；`requests` 拉浏览器侧请求索引（带 `flowId` 与发起处） |
| `webcap_chain` | `id`、`source`（默认 true） | 目标标签页、发起帧（同步段 + 异步段，按 `Continue async` 分段，带帧数/段数/壳数）、关键参数；`source` 附带最近 3 个业务帧的源码窗口 |
| `webcap_script` | `action: list\|get\|search`、`q`、`key`、`offset`、`limit` | 脚本元数据列表；`get` 读落盘的整段脚本（分页）；`search` 在**已落盘**的脚本里搜（不再走 `Debugger.searchInContent`） |
| `webcap_logs` | `limit`、`level: info\|warn\|error`、`event`、`since` | 运行事件最新在前；返回目录与条目，供 agent 排查「为什么」 |
| `webcap_clear` | `confirm: true` | 清 ring + 代理的失败摘要，返回 `cleared` 与 `errorsCleared` |

所有工具输出契约：`ok` 必填，失败时给 `error`；渲染器只消费这些字段。

### 2.2 路由：`lib/routes.js`

- 28 条 `exact` 路由挂在 `/dsh-flowspot/` 下：多数复用工具定义（`call(name, args)`），面板与 agent 因此读到同一份投影；`code-prefs` 直接读写宿主 pointer；`cdp/source` 直接调 `rt.cdp.sourceOf`；`bridge/*` 是扩展桥的收发口（background 直接带 `x-flowspot-bridge` 头调用，`bridge/command` 承载 tabs/attach/detach）；`extension/zip`、`extension/open` 分发随包扩展；`logs/open` 直接调 `rt.openLogsDir()`。
- `query(req)` 解析 URL 参数，`num()` 只接受整数；POST 走 `readBody`（JSON，坏 JSON 回 400）。
- `optionalService(ctx, name)` 先 `ctx.get(name)`，拿不到再读属性并 `catch`——宿主服务缺失时回落到「不支持」，不把异常抛进接口（踩坑第 2 条）。
- `data-dir`：`action: pick` 走 `ctx.directoryPicker` 的 native 选择器；`{dataDir}` 直接设；`{action: reset}` 清 pointer。抓包中调用返回 `ok: false` 与「先停止抓包」。
- `flows` 透传 `group`/`normalize`（`1`/`true` 都认）。
- POST 路由先过 `crossSite(req)`：浏览器声明 `sec-fetch-site != same-origin`，或 `Origin` 的主机与 `Host` 不一致时回 `403`。防的是「别的网站提交一个简单 POST 就能清空抓包」这类副作用（响应读不到，但动作已经发生）；没有这些头的 curl / 测试照常放行。

| 路径 | 方法 | 参数 |
|---|---|---|
| `/dsh-flowspot/status` | GET | — |
| `/dsh-flowspot/serve` | POST | `{"action":"start"\|"stop"\|"restart"}` |
| `/dsh-flowspot/ca` | POST | `{"action":"status"\|"install"\|"uninstall"}` |
| `/dsh-flowspot/data-dir` | POST | `{"action":"pick"}` / `{"dataDir":"..."}` / `{"action":"reset"}` |
| `/dsh-flowspot/flows` | GET | `type` / `host` / `method` / `status` / `q` / `since` / `limit`；`group=1`、`normalize=1` |
| `/dsh-flowspot/detail` | GET | `id` |
| `/dsh-flowspot/body` | GET | `id` / `side=request\|response` / `offset` / `limit` |
| `/dsh-flowspot/search` | GET | `q` / `scope=all\|url\|body` / `limit` |
| `/dsh-flowspot/export` | GET | `format=curl\|har\|json` / `id` / `limit` |
| `/dsh-flowspot/code` | GET | `id` / `lang`；`lang` 省略返回语言清单 |
| `/dsh-flowspot/code-prefs` | GET·POST | GET 读顺序与显隐；POST `{order, hidden}` 保存（跨站拒绝） |
| `/dsh-flowspot/cdp` | POST | `{"action":"status"\|"launch"\|"attach"\|"detach"\|"close"\|"requests"}` + `port`/`since`/`limit`/`host`/`matched` |
| `/dsh-flowspot/cdp/requests` | GET | `since` / `limit` / `host` / `matched=1\|0` |
| `/dsh-flowspot/cdp/chain` | GET | `id`；`source=0` 不带源码 |
| `/dsh-flowspot/cdp/request` | GET | `id`（CDP 请求 id）→ 头/POST 体/发起栈 |
| `/dsh-flowspot/cdp/source` | GET | `key`（`<sessionId>:<scriptId>`）或 `scriptId`+`sessionId`；`line`（0 基）/ `column`（1 基）/ `context` / `chars`；`needle`（方法名，用来数同名位置）/ `hit`（-1=调用点，0 起是第几处）；`store=1` 显式补落盘 |
| `/dsh-flowspot/cdp/code` | GET | `id`（CDP 请求 id）/ `lang` → 走 `webcap_code {cdp:true}`，与系统抓包同一个生成器 |
| `/dsh-flowspot/cdp/reveal` | POST | `{key?}` → 在资源管理器里选中该脚本；不带 key 打开源码目录（跨站拒绝） |
| `/dsh-flowspot/bridge/attach` | POST | `{tabId,title,url}` → 通道进入扩展模式 |
| `/dsh-flowspot/bridge/command` | POST | `{action:"tabs"\|"attach-last"\|"attach-tab"\|"detach",tabId?}` → agent/面板驱动扩展 |
| `/dsh-flowspot/bridge/events` | POST | `{events:[{method,params}]}`（一次最多 200 条）；请求体上限 4MB（带 POST 体的站点一批可到 MB 级） |
| `/dsh-flowspot/bridge/result` | POST | `{id,result,error}` 回填 chrome.debugger 命令；请求体上限 12MB（整份脚本源码走这条），超限回 413 而不是掐连接 |
| `/dsh-flowspot/bridge/poll` | GET | `wait`（毫秒，≤30s）→ 一条待发命令或 null |
| `/dsh-flowspot/bridge/hello` | GET | 返回一页 HTML（不是 JSON，也故意不查同源）：浏览器打开它，内容脚本就认领宿主地址。桌面端界面在 `dsh-app://` 里、跑不了内容脚本，靠这一页把 `http://127.0.0.1:<port>` 交给扩展 |
| `/dsh-flowspot/bridge/open-hello` | POST | `{base?}` → 宿主在 Chrome 里打开上面那一页（面板按钮走这条；跨站拒绝） |
| `/dsh-flowspot/bridge/detach` | POST | — |
| `/dsh-flowspot/extension/zip` | GET | 随包 `extension/` 的 zip |
| `/dsh-flowspot/extension/open` | POST | `explorer.exe` 打开扩展目录（跨站拒绝） |
| `/dsh-flowspot/logs/open` | POST | —（`explorer.exe` 打开 `logs/`，跨站拒绝） |
| `/dsh-flowspot/clear` | POST | `{"confirm":true}` |

路由挂在 GUI 的同一个端口上（DSH web 默认 `3080`），试一下：

```powershell
curl.exe http://127.0.0.1:3080/dsh-flowspot/status
curl.exe "http://127.0.0.1:3080/dsh-flowspot/flows?type=xhr&limit=5"
```

### 2.3 面板：`client/client.js`

- 四个注册位：`sidebar.panellist`（`id: dsh-flowspot`、`order: 40`、label 抓包工具）+ `main`（同 key 的整页）+ nested `sidebarRightTabs.register`（`kind: flowspot`，带 `guide` 项「抓包工具」）+ `sidebar.right.pane.tab`（同 key 的正文）。整页与右栏共用同一个 `Panel` 组件，`docked` 只切布局。
- 轮询：`status` 与 `flows` 每 3000ms 各拉一次；筛选变化单独走 150ms 防抖，两者都读 `filtersRef`，避免轮询重置输入。列表固定 `limit=200`。
- 位置切换：`togglePlacement(docked)` —— docked → `layout.selectPanel(PANEL_ID)` 并 `close(tabId)`；page → 先 `layout.selectPanel(null)` 归还中栏，再按帧（最多 24 帧）重试 `sidebarRight.openTab`。右栏正文挂载时若中栏仍是本面板整页，主动 `selectPanel(null)`。
- 三块布局：菜单（状态四格、开始/停止、清空、CDP 通道行、设置、⇄）、请求列表（合并开关、`Default/Success/Error` 三档、筛选、失败/成功两块）、请求详情（调用链 + 错误卡片 + 四个可折叠小节）。失败行与成功行同用 `rowOf()`，只多一个 `dshwc-item-failed` 类（整行错误色）。
- 详情分两页：标题与 `方法 · URL · 状态 · 耗时 · 隧道` 之下是「请求 / 代码」分段控件。**「请求」页就是原来的四节，内容不删不减**，只在顶部多一个「调用链（CDP）」块；「代码」页是语言 chips + `<pre>` + 复制按钮 + notes（打码/截断/依赖说明），生成走 `/code`，切 flow 或切语言才拉一次。**CDP 详情用同一套两页**：请求页是请求头/POST 体/响应头/调用链，代码页调 `/cdp/code`，语言 chips 与生成器与系统抓包完全共用（`codePane()`）。
- 调用链：`openDetail` 并行拉 `/cdp/chain?id&source=0`；配到就显示目标标签页、页面 URL、发起帧（按钮）与参数（`静态 / 动态` chip）。帧列表按 `asyncLevel` 分段，段与段之间插一行 `Continue async（第 N 段）`；标题行给规模「N 帧 · M 段 · K 个壳」。每帧右侧有独立的复制按钮（复制方法名），chips 末尾有「复制全部」（一行一个）。
- 源码查看器：点帧调 `/cdp/source?key&line&column&chars&needle&hit`，弹窗（与「设置」共用遮罩）**只读抓取时落盘的那份**，且只给调用点附近的片段：压缩文件按列切 ±600 字符、再由 `format.js` 展开成带缩进的多行并把调用点标成 `<mark>`（等价于 F12 的 `{}`，但只作用于这一段），普通文件按行给 ±10 行。同名方法在一个文件里不唯一，宿主用 `occurrencesOf` 数出全部位置，面板默认给「这一帧自己的调用点」（`hit=-1`）并显示「同名 N 处」，用「上一处/下一处」传 `hit=0..N-1` 翻、可「回到调用点」。不提供「整份源码」页——要看整份或自己拷走分析，点「打开文件夹」（`POST /cdp/reveal {key}`）在资源管理器里选中那个 `.js`；调用链每一帧右侧也有这个按钮。没落盘时只显示原因（超 4MB 上限 / 抓取时脚本已卸载），不提供「临时再拉一份」的入口。头部给「复制方法名 / 复制位置 / 打开文件夹」，底栏给「复制这段」；剪贴板走 `navigator.clipboard`，失败退到临时 `textarea` + `execCommand`，结果用面板顶部消息行回显。未配到调用链只显示一句原因，不挡请求页。
- 语言偏好：面板挂载时拉 `/code-prefs`；「设置」第三节「代码语言」每行一个复选框 + `↑/↓`，改动立即 POST 保存（不引拖拽）；至少保留一种可见，隐藏最后一个时按钮置灰并回一句原因。
- 失败视图：`listRows('failed'|'ok'|'all')` 从同一份 `flows`/`groups` 里筛；整页时成功在上、失败在下（`flex: 0 0 20%`），`Default` 不带满、`Success`/`Error` 各占满；窄栏只渲染 `all` 一个滚动容器。
- 合并：请求带 `group=1`；响应没有 `grouped`（宿主侧旧）时用 `groupLocal()` 在客户端按同一规则合并，并在列表里标「本地合并」。
- 详情：选中后拉 `/detail`，再按需拉响应体（`limit=4000`）与请求体；`errorHint` 直接渲染在错误卡片里。
- 版本不一致：`status.build` 缺失即判宿主旧，顶部横幅 + 清空时先按时间戳本地隐藏旧失败条目（`errorsClearedAt`）。
- 样式只用 `--dsw-alias-*` token（label/bg/border/brand/state-*/settings-card-*），不写字面色值。

### 2.4 代码生成：`lib/codegen/*`

一次「把 flow 变成脚本」：

1. **归一**：`requestSpecOf(flow)` 读 `flow.reqHeaders` / `flow.reqBody` / `flow.url`，产出 `{method, url, query, headers, cookies, body, notes}`。头处理：小写化、丢 `content-length`/`host`/`connection`/`keep-alive`/`transfer-encoding`/`te`/`trailer`/`upgrade`/`expect`；`cookie` 头拆成 `cookies` 对（值保持编码原样）；值里出现 `***redacted***` 时把该头当占位并加 note。
2. **体分类**：`text` 非空时按 mime 判 json（能 `JSON.parse`）→ form（`x-www-form-urlencoded`，重复键记入 note）→ multipart（原样字节 + boundary）→ text；`text` 为空而有 `base64` 时是 binary。`flow.reqBody.truncated` 直接进 note。
3. **渲染**：`renderCode(flow, langId)` 选语言并调模板，返回 `{id, label, note, code, notes}`；未知 id 回落到 cURL。每个语言文件只做字符串拼装，转义集中在 `literal.js`（`shellQuote` / `pyLiteral` / `jsLiteral` / `goString` / `rustString` / `rustText` / `rustJsonLiteral`）。
4. **面板/工具**：`/code?id&lang` → `webcap_code` → `renderCode`；`webcap_code` 省略 `lang` 时返回 `langsOf(readPrefs())`，与面板 chips 同一顺序。
5. **Python 约束**：`lib/codegen/python.js` 按 `python-standard-coding` 的「一次请求」：`import json / from pathlib import Path / import requests` 三段式（binary 才加 `import base64`），`headers → cookies → body → url` 顺序，`url` 紧贴 `requests.get/post`，`timeout=30`，`json=` 给字典、`data=` 给字符串/字节，结尾写 `response.json` 并打印状态码；不生成 `main` 或 `if __name__`。
6. **浏览器 JavaScript 约束**：`fetch` 不能设置 `cookie`、`user-agent`、`origin`、`referer`、`sec-*`、`content-length` 等；这些头在生成前剔除并列进 note。原请求带 cookie 时改成 `credentials: "include"` 并说明同源/CORS 前提。
7. **偏好**：`prefs.js` 读写 `$DSH_HOME/dsh-flowspot.codegen.json`；`normalizePrefs` 丢未知 id、按注册表补齐缺失项、全隐藏时保留顺序里的第一个。

### 2.5 CDP 通道：`lib/cdp/*` + `extension/`

> 现状：受控浏览器（独立 profile）已撤下面板入口（ADR-0020），但 `launch`/连接/索引代码仍在，供手动 attach 与调试用；主路径是扩展桥接管当前标签页，复用下面的索引与配对逻辑，只换传输层。

**扩展桥（0.6.0，主路径）**：

1. 设置 →「浏览器扩展」：`GET /extension/zip` 下载随包 zip，或 `POST /extension/open` 让宿主用资源管理器打开 `extension/`；用户在 `chrome://extensions` 开发者模式「加载已解压」一次。
2. 扩展 background 直接和宿主通信（`host_permissions` 覆盖 127.0.0.1，带 `x-flowspot-bridge` 头）；内容脚本只会在**确认当前页是 DSH**（`/dsh-flowspot/status` 返回 ok）后上报 origin，并替宿主长轮询命令。内容脚本活在页面里，不受 MV3 worker 休眠影响；它把命令通过 `runtime.sendMessage` 送进 background，从而唤醒 worker。
3. 接管路径：面板「连接浏览器」→ `/bridge/command {action:"attach-last"}`（等同点扩展图标）→ 再 `tabs` 列页面；或直接 `tabs`/`takeover`（agent）。background `chrome.debugger.attach` 该标签页，`Debugger.enable` 后 `Debugger.setAsyncCallStackDepth {maxDepth:64}`、`Network.setAttachDebugStack`、`Runtime.enable`（实验命令失败只打日志），再 `Network.enable {maxPostDataSize:65536}`，最后 `POST /bridge/attach`。`attached` 同时写 `storage.session`，SW 重启后从存储和 `chrome.debugger.getTargets()` 恢复，并把 attach 重新报给宿主。
4. 宿主 `CdpChannel.attachExtension()` 用一条虚拟传输建 `CdpClient`（`Target.*` 命令直接回空，其他命令进队列），按伪会话 `ext:<tabId>` 走 `_attachSession()`；网络索引、脚本索引、配对、调用链全部复用。
5. 事件：background 只转发 `Network.*` / `Debugger.*`，按 200ms/50 条批量 `POST /bridge/events` → `bridgeEvent()` 喂回客户端；不再用内存 `attached` 做门槛，SW 重启后 `source.tabId` 仍然能转发。
6. 命令：宿主把命令放队列；内容脚本/background 长轮询 `GET /bridge/poll` 取走，`chrome.debugger.sendCommand` 后 `POST /bridge/result` 回填。源码、跨脚本搜索、`Network.enable` 都走这条路。
7. 断开：点扩展图标/面板「断开」/agent `detach` → `chrome.debugger.detach` → `POST /bridge/detach`，宿主只清伪会话与通道状态（`_resetBridgeState({preserveData:true})`）；**网络索引与已读源码都留着**，面板的 CDP 列表继续显示断开前抓到的请求，并标一句「只有点清空才会清掉」。
8. 日志：`bridge-attach` / `bridge-detach` 进事件日志（只记 tabId/title）。
9. 地址交接（桌面端必需）：扩展默认对着 `127.0.0.1:3080` 轮询，只有内容脚本能把它改到真正的宿主端口；而 **DSH Desktop 的界面在 `dsh-app://` 里**，内容脚本根本没有落脚处，于是扩展一直对着旧端口，面板报「扩展没有响应」。解法是让浏览器打开一次 `/bridge/hello`：这一页由内容脚本认领（它先 `GET /dsh-flowspot/status` 确认是宿主），把 `location.origin` 报给 background，background 写进 `chrome.storage.local` 并开始轮询——之后 SW 重启、浏览器重启都记得。面板在桌面端会显示「扩展连接地址」，并给一个「在 Chrome 中打开」按钮走 `/bridge/open-hello`；同一个扩展同时只能连一个宿主（web 或桌面端，后连的覆盖前者）。不依赖内容脚本的兜底是**标签页发现**：点扩展图标、SW 启动、或连续两次 poll 失败时，`discoverHostFromTabs()` 会遍历已打开标签页里所有 `http://127.0.0.1:<port>` 的 origin，逐个 `GET /dsh-flowspot/status`，谁应答就 `rememberHost()` 并打断当前长轮询（`pollSeq` 代次）。所以桌面端的最小操作是：打开连接页 → 点一下扩展图标。

一次「启动 → 连接 → 拿调用链」（受控浏览器遗留路径）：

1. **启动**（`launch.js`，受控浏览器遗留路径）：`webcap_cdp launch` 先要求代理在跑（`getProxyPort()` 有值），否则直接拒绝——浏览器必须带 `--proxy-server` 指向本插件。可执行文件顺序：配置 `cdpBrowserPath` > `DSH_FLOWSPOT_BROWSER` > 用户级 Chrome > Program Files Chrome > Edge。profile 固定 `$DSH_HOME/dsh-flowspot.cdp/profile`。已有 `DevToolsActivePort` 且端口探活成功就复用（同一 profile 再启动一个 chrome.exe 只会转交给已运行实例并立刻退出）；否则删掉陈旧文件，`spawn` 带 `--remote-debugging-port=0` 等参数，每 150ms 读一次端口文件（上限 15s），再探 `/json/version`，最后写 pointer（端口/PID/是否外部）。
2. **连接**（`client.js` + `index.js`）：取 `/json/version` 的 `webSocketDebuggerUrl`（浏览器级），一条 WebSocket；`Target.setDiscoverTargets` + `Target.setAutoAttach {flatten:true}`。`Target.attachedToTarget` 时建会话：`Runtime.runIfWaitingForDebugger`（若挂起）、`Network.enable {maxPostDataSize:65536}`、`Debugger.enable` 后再发 `Debugger.setAsyncCallStackDepth {maxDepth:64}`（与扩展桥对齐，否则异步段尾部几层采不到），页面会话再补一次 `Target.setAutoAttach` 把 worker 接进来。
3. **喂索引**：`Network.requestWillBeSent` → `network.add()`（`wallTime` 优先换算毫秒，环形 2000 条，超了淘汰最旧并同步清 `byKey` / `byRequest`）；`initiator` 整个对象原样存下来——同步段与 `stack.parent` 都在里面，展平放到读取时做；**带调用栈的条目顺手排队落盘源码**（`_queueSourcePersist`：栈里每个 `scriptId` 各取一次 `getScriptSource` 写进 `<dataDir>/scripts`，同一脚本只做一次、串行执行）；`Network.responseReceived` 补状态码与 mime；`Debugger.scriptParsed` → `scripts.noteParsed()`（只存元数据）；`Target.detachedFromTarget` 清该会话的请求与脚本元数据，落盘的源码不动。
4. **配对**：`CdpNetworkIndex.match(flow)` 按「方法 + 完整 URL」取队，时间窗 `[startedAt-5000, startedAt+500]`，取窗口内「展平后帧数最多」的未配对项并写 `matchedFlowId`（同 URL 轮询按到达顺序，帧数相同不换人）。
5. **调用链**：`chain(flow, {store, withSource})` → 配对条目 → `initiator.js` 的 `flattenFrames(stack)`：先 `callFrames`，再沿 `stack.parent` 逐层续上，最多 8 层，每帧带 `asyncLevel` 与 `anonymous`；`index.js` 把它映射成展示帧（行列都 +1 给人看，带 `scriptKey`、`noise`、`asyncLevel`）。返回 `totalFrames`（展平后总数）、`syncFrames`（`asyncLevel === 0` 的帧数）、`asyncLevels`（段数）、`filteredFrames`（噪声帧数）。没有帧但有 `initiator.url` 时补一条单帧。`withSource` 时取展平后前 3 个业务帧，按行取 ±8 行——源码来自抓取时落盘的那份（见第 6 条），不在这里向浏览器要。
6. **脚本与源码**：`scripts.list()` 只给元数据（上限 4000，URL 过滤）。源码走 `sourceStore`，触发条件由 `sourceFilter.js` 的 `isBusinessRequest()` 决定——**只有业务接口**（`type` 是 `XHR`/`Fetch`、URL 是 http(s)、host/path 不在埋点/APM/风控探针噪声表里）才落盘；内联脚本（`url` 为空）与 `data:`/`blob:` 一律跳过，因为没法命名也没法在查看器里指出是哪个文件。命中后抓取时 `_queueSourcePersist()` 把这条请求调用链涉及的脚本各取一次（`Debugger.getScriptSource` 读渲染进程里 V8 的脚本对象，不是重新下载），写 `<dataDir>/scripts/<session>-<scriptId>.js` 并在 `index.json` 记 URL/字符数/时间；单脚本 4MB、总量 256MB，超限写进 `reasons` 而不是悄悄丢。这条命令的回包是整份脚本，经扩展桥要过一次 HTTP POST，所以两处单独放宽：宿主 `/bridge/result` 请求体上限 12MB，`getScriptSource` 单条命令超时 60 秒（默认 15 秒）。同一脚本最多试两次（第一次失败可能是通道抖动），两次都失败就只记原因、不再打扰浏览器。之后 `sourceOf()` / `scriptGet()` / `scriptSearch()` 只读磁盘，`Debugger.getScriptSource` 全仓只有 `_readSourceText()` 一处调用；`scriptSearch` 也不再走 `Debugger.searchInContent`。源码查看器按目标行长度选模式：超过 `MINIFIED_LINE_CHARS`（1200）按列切窗口（`columnWindow`，起点对齐到最近的 `;`/`}` 之后、结尾补到下一个 `}`，避免从字符串中间切进来），交给 `format.js` 的 `formatFragment()` 展开成带缩进的多行并给出标记所在行与列；`formatFragment` 区分**代码块 `{`** 与**对象字面量/参数默认值 `{`**（`e={}` 不展开）、`for(;;)` 里的 `;` 不换行、`}else` 不断行、字符串/注释/正则里不切行；否则按行取上下文（`lineWindow`）。面板只提供片段，「整份源码」不提供（agent 要整段走 `scriptGet`）。「清空 CDP」会调 `sources.clear()` 连磁盘一起清。
7. **重连**：`CdpClient` 的 onClose 只对「当前这条连接」生效（旧 socket 关闭不能把新连接的状态翻掉）→ 清会话/目标、保留请求索引 → pointer 里有端口且（外部附加或 PID 还活着）时按 2s→30s 退避重连；`ensure()` 由状态轮询和工具调用触发，`retryAt` 防抖；PID 已死只报「受控浏览器已关闭」。`dispose()` 只断连接，不杀浏览器。
8. **日志**：`cdp-launch` / `cdp-attach` / `cdp-detach` / `cdp-close` / `cdp-reconnect` / `cdp-disconnect` 进事件日志，只记端口/PID/浏览器版本，不记源码与报文。


## 3. Windows 集成

### 3.1 系统代理：`lib/sysproxy.js` + `sysproxy.ps1`

- 键 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`；`enable(port)` 先备份（仅当备份文件不存在）再写 `ProxyEnable=1`、`ProxyServer=127.0.0.1:<port>`、`ProxyOverride=<local>;127.0.0.1;localhost;*.local`。
- 写完必须广播：`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File sysproxy.ps1 -Notify`，脚本里 P/Invoke `InternetSetOption` 发 `INTERNET_OPTION_SETTINGS_CHANGED`/`REFRESH`；广播失败只 warn（设置仍写入，部分程序下次启动才生效）。
- `disable()` 有备份就还原三项并删备份，没有就把 `ProxyEnable` 置 0。备份文件 `sysproxy.backup.json` 在数据目录，异常退出后下次 `stop()` 仍能恢复。

### 3.2 CA 信任：`lib/certstore.js`

- `install()` = `certutil -addstore -user Root <ca.crt>`（用户级，免管理员），装完回读 `status()`，`installed` 仍为假就抛错并带 certutil 输出。
- `uninstall()` = `certutil -delstore -user Root <thumbprint>`。
- `status()` 用 PowerShell `Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq '<SHA-1>' }` 计数——避免解析 `certutil` 的中文本地化输出；thumbprint 先过 `^[0-9A-F]+$` 校验，防止拼进脚本注入。

### 3.3 运行埋点：`lib/logs.js`

抓包插件最容易丢的证据不是流量，是「为什么」：端口为什么退到随机口、停止时系统代理恢复失败没有、上次装 CA 被 certutil 拒的原因。这些都不是请求，进不了 flow 流水账，所以单独一份事件日志。

- 文件：`<数据目录>/logs/plugin-<YYYY-MM-DD>-<NN>.ndjson`，一行一个 `{ts, level, event, detail}`。
- 上限：单文件超过 2 MiB 就切下一份（`-NN` 递增），最多保留 3 份，更旧的删掉。
- 七条规则：
  1. **只记非请求事件**：请求成败已经在 `flows/*.jsonl` 里，重复记只会膨胀；日志只补「非请求」的判定与状态变化。
  2. **不记报文**：头、体、Cookie 一律不进日志（JSONL 里已有脱敏版本）。
  3. **一行一个 JSON**：`ts / level / event / detail` 四字段，`event` 名固定，便于按事件过滤。
  4. **懒创建**：第一次真的要写才建 `logs/`；插件加载时先写一条 `mount`，所以文件一出现就有内容，不会留下 0 字节日志。
  5. **有上限**：2 MiB × 3 份，按日命名、超限删最旧；写入失败只 warn 一次，不让日志坏了变成日志风暴。
  6. **可安全贴进 issue**：不含敏感信息，是开源项目收 bug 报告的第一手材料。
  7. **路径可见**：`status.paths.log` 暴露目录，面板与 `webcap_status` 各一行说清「日志在哪」。
- 记录的事件：`mount` / `unmount` / `capture-start`（requestedPort、真实端口、系统代理、portNote、warning）/ `capture-start-failed`（错误码）/ `port-fallback`（请求端口 → 实际端口与原因）/ `capture-stop` / `system-proxy`（enable、disable，含是否绕过备份恢复、广播是否成功）/ `ca-install` / `ca-uninstall` / `ca-install-failed` / `ca-uninstall-failed`（带 certutil 输出片段）/ `data-dir`（change、reset，含拒绝原因）/ `cdp-launch`（端口、PID、浏览器、profile、代理端口、是否复用）/ `cdp-launch-failed`（找不到浏览器 / 启动失败 / 连不上，带阶段）/ `cdp-connect`（端口、浏览器、协议版本）/ `cdp-target`（只记页面级目标，不记 URL/标题）/ `cdp-attach` / `cdp-detach` / `cdp-close` / `cdp-browser-closed`（PID、端口）/ `cdp-reconnect` / `cdp-reconnect-failed`（端口、错误、第几次）/ `cdp-disconnect`（原因、会话数、索引条数）/ `flow-clear`（清了多少条、是否连失败摘要一起清）/ `log-open`，外加各模块 `log.warn` / `log.error` 的自动落盘。
- 读取：`readLogEvents({dir, limit, level, event, since})` 从最新文件往前读，最新事件在前；坏行跳过（日志正是坏掉时才有人读），`limit` 硬顶 500。面板只保留 `POST /dsh-flowspot/logs/open`（`explorer.exe` 打开目录）；agent 用 `webcap_logs` 读，可按 `level` / `event` 子串 / `since` 过滤。面板不再做日志预览。
- 不做：不引 winston / pino（零依赖是 ADR-0003 的同一条理由）；不做请求级日志；文件里不写 `debug` 级。

## 4. 配置与数据目录

- `DEFAULTS`：`port 8899`、`dataDir ''`、`maxFlows 1000`、`maxBodyBytes 262144`、`redact false`、`persist true`、`upstreamRejectUnauthorized true`、`upstreamTimeoutMs 30000`、`upstreamKeepAlive false`、`setSystemProxyOnStart true`、`cdpBrowserPath ''`。
- `normalizeConfig()`：数值项必须为正数否则回落默认；布尔项用 `!== false` / `=== true` 的显式比较；`port` 允许 0（随机）。
- 数据目录优先级：面板 pointer 文件 `$DSH_HOME/dsh-flowspot.location.json` > 配置 `dataDir` > `$DSH_HOME/dsh-flowspot`。`expandDataDir()` 接受绝对路径、`~`/`~/x`、其它相对路径按 DSH home 解析（不是进程 cwd）。
- `adoptDataDir()`：只**校验 + 记 pointer**，不建目录、不复制。目标已存在则须是目录且可写；不存在则校验最近一层已存在的父目录。指针里同时写 `copyFrom`——只在新目录没有 `ca.crt`、而当前目录有时才写；目标已有别家 CA 则 `foreignCa: true` 且不交。返回 `copyOnStart` 与 `restartRequired: true`。抓包运行中 `changeDataDir()` / `resetDataDir()` 直接拒绝。
- `adoptPendingCopy(dir)`：启动时、加载 CA 之前跑一次，建目录并把 `ca.crt` / `ca.key.pem` / `leaf.key.pem` / `leaf.pub.der` 复制过去（目标已有 CA 或来源没有就跳过），随后清掉指针里的 `copyFrom`——交一次就结束。所以「选了又反悔」既不留空目录，也不留 CA 私钥副本。
- `status().paths.pending` 表示「已经选了、但本进程还没切过去」的目录，面板据此显示「重启后生效」。
- 目录里每样东西在什么操作下产生（改这块前要知道）：
  - `ca.crt` / `ca.key.pem` / `leaf.key.pem` / `leaf.pub.der`：**插件加载时** `createRuntime()` 就生成（`index.js` 的两个 `ctx.effect` 加载时即调 `getRuntime()`，不是点「开始抓包」才建），已存在则复用。
  - `flows/flows-<时间戳>.jsonl`：**一次抓包会话一个**。`start()` 只开新会话（`beginSession()` 关掉上一份），文件由本次抓包第一条完成的 flow 创建，`stop()` 关闭——所以只加载插件、或开了抓包却没有流量，都不留空文件。`persist: false` 时整个 `flows/` 都不建。
  - `logs/plugin-<日期>-<NN>.ndjson`：运行事件日志，第一次写事件才建（加载时即写一条 `mount`），最多 3 份（见 §3.3）。
  - `sysproxy.backup.json`：第一次「开始抓包」且此前没有备份时写，`stop()` / 卸载时删除；它是异常退出后能恢复系统代理的唯一凭据。
  - `$DSH_HOME/dsh-flowspot.location.json`：面板「设置 → 选择数据目录」成功时写、恢复默认时删。它在 DSH home，不在数据目录里，所以换目录后旧目录里不会有它。
  - `$DSH_HOME/dsh-flowspot.codegen.json`：代码语言的顺序与显隐（ADR-0016）。
  - `$DSH_HOME/dsh-flowspot.cdp.json`：CDP 通道 pointer（端口、PID、是否外部附加、浏览器路径），`launch` / `attach` 成功时写，`detach` / `close` 时删。
  - `$DSH_HOME/dsh-flowspot.cdp/profile/`：受控浏览器的独立 profile（`DevToolsActivePort` 也在这里）；`closeBrowser` 不删它，登录态下次还在。

### 改配置

除了数据目录（面板里的「设置」选），其余字段写进 profile 的 `cordis.patch.yml`（`%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`），按行 id 覆盖：

```yaml
- id: dsh-flowspot
  config:
    port: 8899
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `port` | `8899` | 代理端口，`0` 表示随机；避开 `netsh interface ipv4 show excludedportrange protocol=tcp` 列出的范围 |
| `dataDir` | 空（用默认目录） | 只在无界面 / 远程部署时用；面板里选过的目录优先于它 |
| `maxFlows` | `1000` | 内存里保留多少条 flow |
| `maxBodyBytes` | `262144` | 单个报文体预览上限（字节） |
| `redact` | `false` | 是否打码敏感请求头；只有显式 `true` 打开（ADR-0015），开着时代码视图里是占位符 |
| `persist` | `true` | 是否把完成的 flow 追加到 JSONL |
| `upstreamKeepAlive` | `false` | 复用上游连接；默认关（ADR-0007），批量压测类场景可打开 |
| `upstreamTimeoutMs` | `30000` | 上游请求超时 |
| `setSystemProxyOnStart` | `true` | `start` 时是否把系统代理指向本插件 |
| `cdpBrowserPath` | 空（自动找） | 受控浏览器用哪个 `chrome.exe` / `msedge.exe`；空则按用户级 Chrome → Program Files Chrome → Edge 顺序找 |

按 id 覆盖会**替换整行的 config**（不是深合并）：以后再加字段时，要把仍想保留的字段一起写上。

## 5. 测试边界

- `test/zip.test.mjs`（2）：目录打成 store-only ZIP（本地头/中央目录/结束记录/UTF-8 文件名），目录不存在时抛错。
- `test/logs.test.mjs`（3）：跨轮转文件最新在前、级别/事件/时间/条数过滤、坏行跳过、只认 `plugin-*.ndjson`。
- `test/cdp.test.mjs`（28）：`CdpClient` 的 id/事件/超时/关闭（含单条命令的超时覆盖）、网络索引的 FIFO 配对与重定向、参数静态/动态与 JSON 展平、脚本窗口与列偏移、同名方法位置扫描（标识符边界）与行号换算、压缩片段展开（缩进/字符串与正则不切行/标记行/对象默认值不当块/`for(;;)` 不换行/else 块）、窗口对齐到语句边界（从字符串中间切进来也能结构化）、启动参数/`DevToolsActivePort`/`/json/version` 探活、通道手工拼出一条调用链、桥接回包（`result` 包装与旧版顶层 `tabs`）、调用链适配器/框架帧过滤、异步段展平（`parent` 链、层数上限、成环不死循环、匿名帧判噪声、`topFrame` 取业务帧）、请求详情与 `chain()` 的异步帧与段数、CDP 请求拼成 flow 形状供代码生成、抓取时脚本落盘（每个脚本一次、重复事件不重取、失败只重试一次）、源码查看器只读落盘那份（不碰 CDP、默认调用点、同名翻页与越界回退、落盘路径）、按行窗口、超 4MB 跳过并记原因、源码索引重载与清空、断开桥后请求仍在、同 URL 优先配对带栈条目、暂停后保留 CDP 数据。
- `test/codegen.test.mjs`（9）：请求模型（头过滤/cookie/体分类）、6 语言模板、浏览器禁止头、表单与重复键、二进制体、截断与打码提示、GET 无体、未知语言回落、语言偏好归一。
- `test/der.test.mjs`（7）：长度编码边界、`integer` 正负、`oid`、`time`、`bitString` 等原语。
- `test/x509.test.mjs`（6）：CA 生成/加载、叶子链、SAN/IP、真 `tls` 握手、未受信 CA 被拒（新 Node 报 `HANDSHAKE_FAILURE` 也算通过）。
- `test/flows.test.mjs`（21）：环形淘汰、过滤、类型分类、`describeBody` 解压/截断/base64、打码开关、JSONL、curl/HAR、`listGroups` 与 `normalizeUrl`。
- `test/routes.test.mjs`（32）：30 条路由的请求/响应契约、坏 JSON、`group/normalize` 透传、`errorHint`、`code`/`code-prefs`、CDP 六条路由（含 `cdp/code` 转脚本与 `cdp/reveal` 打开位置）、扩展桥的连接页与 `bridge.base`、5MB 脚本回包不被掐断、日志一条、桥接五条与扩展两条、`clear` 清 `recentErrors`、跨站 POST 被拒。
- `test/runtime.test.mjs`（14）：`normalizeConfig`（含 `cdpBrowserPath`）、数据目录优先级与 `expandDataDir`、`adoptDataDir` 的复制与拒绝。
- `test/proxy.test.mjs`（3）：`parseHead` 跨块解析、`_noteError` 聚合与上限。
- `test/sysbin.test.mjs`（2）：系统命令优先解析成 `%SystemRoot%\System32` 下的绝对路径（带不带 `.exe` 都认、支持自定义 SystemRoot），文件不在 / 非 Windows / 不在白名单时退回原样，空命令名直接报错。
- 全部零依赖；单个文件直接 `node test/<file>.mjs`（`node --test test/` 会为每个文件起子进程，在受限沙箱里可能 `spawn EPERM`）。真实 TLS 用例依赖本机 Node ≥ 22 的 `crypto`；CDP 用例不启动浏览器，真实 Chrome 的行为要人工验收。

契约测试覆盖不到、改这些行为时要人工关注：

- 右栏入口（`sidebarRightTabs` 的 nested inject、`openTab` 的按帧重试）与 ⇄ 的两个方向；
- 「设置」弹窗里装/卸 CA、选择数据目录、代码语言顺序与 CDP 通道按钮（`ctx.get('directoryPicker')`、抓包运行中置灰、至少保留一种语言）；
- 整页 `Default / Success / Error` 三档、失败行并入列表、详情顶部的错误卡片；
- 详情「请求 / 代码」两页切换与代码复制（旧宿主没有 `/code` 时面板只显示失败原因，不白屏）；
- 受控浏览器的真实启动/退出/复用（Chrome ≥136 的 profile 限制、`DevToolsActivePort`、第二次启动只开标签页）、DSH 重启后的静默重连、浏览器被关掉后的一次点击；
- 设置里「打开日志文件夹」（资源管理器窗口在前台、空目录也能打开）、`webcap_logs` 的过滤与条数；
- 调用链配对在真实轮询接口上的顺序、点帧读到的源码片段、`webcap_script search` 在已落盘脚本里的命中；
- 调用链的异步段：真实页面上一条 XHR 的展平帧数应等于 F12 Initiator 的行数（小红书 homefeed 实测 45 帧 / 7 段，同步段只有 3 帧），业务方法 chips 里应出现该站的业务函数名，切「只看业务帧」后匿名帧也要消失；
- 源码查看器与历史保留：抓一条带调用栈的请求后 `<数据目录>/scripts/` 下应出现对应脚本（一条 homefeed 实测 4~5 个）与 `index.json`；在压缩过的 bundle 上点一帧，弹窗应把调用点片段**展开成多行并高亮**（`e={}` 之类参数默认值不被切开）；「上一处/下一处」能翻同名方法、「打开文件夹」能在资源管理器里选中那个 `.js`；断开 CDP 后 CDP 列表与源码都还在（点「清空 CDP」才连磁盘一起清）；超过 4MB 的脚本要点出「超上限、没落盘」而不是卡住；
- 新旧宿主半边的降级：缺 `grouped` 走 `groupLocal()`、缺 `build` 显示版本横幅、`webcap_clear` 清 `recentErrors`；
- 异常退出后的系统代理恢复（靠 `sysproxy.backup.json` 在下次 `stop()` 兜底）；
- WS 握手转发（101 与头跨块解析）。
