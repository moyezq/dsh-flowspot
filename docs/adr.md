# 架构决策（现行）

仍有效的「为什么这样选」。

## ADR-0001 · 2026-10-18 · 抓包引擎自研 Node MITM，不接 CDP、不桥接 ProxyPin

需求是 Charles 式体验：装好 CA、开系统代理，系统上一切认代理的程序自动进。CDP 只能看一个专门启动的浏览器实例，桥接 ProxyPin 则把解密能力放在另一个 App 里。为拿到「全系统 + 数据在本进程 + 不依赖第三方 App」，在插件内自己实现 MITM 代理。代价是证书体系与 h2 要自己扛。

## ADR-0002 · 2026-10-18 · v1 只做 Windows 用户级系统代理

Windows 上写 `HKCU\...\Internet Settings` 并广播 `InternetSetOption` 即可，不需要管理员；macOS 的 `networksetup` 与 Linux 的 `gsettings` 是三套独立逻辑，v1 不做。手机另走 ProxyPin MCP，因此不做 VPN 型强制代理，也不引入 Npcap/pktmon。

## ADR-0003 · 2026-10-18 · 证书签发零依赖：手写 DER/X.509 + certutil/PowerShell

`file:` 方式装进 profile 时第三方依赖的解析不可靠，且抓包插件最不该在证书链上踩依赖升级。因此自己写 DER 编码与 X.509 组装（`lib/der.js`、`lib/x509.js`），CA 安装用系统自带 `certutil`、查询用 PowerShell 读 `Cert:\CurrentUser\Root`（`certutil -store` 输出随系统语言变化，不能解析）。取舍：多写约 300 行编码代码，换安装零依赖、行为可审计。

## ADR-0004 · 2026-10-18 · v1 只跑 HTTP/1.1，ALPN 不宣告 h2

内层解析器只认 HTTP/1.1。如果向客户端宣告 h2，就会出现「协商成 h2 却按 1.1 解」的错误。因此 secureContext 不设 ALPN，Chrome 自动回落 http/1.1，抓包结果完整、只是协议版本显示为 1.1。h2 留到用 `node:http2` 单独实现，不手写 HPACK。

## ADR-0005 · 2026-10-18 · flow 用内存环形 + JSONL，而不是以 HAR 为唯一格式

内存保留最近 `maxFlows`（默认 1000）条供 agent 即时查询；完成即追加一行 JSONL 到会话文件，便于事后重读与排障。HAR 只作为导出格式（`webcap_export format=har`），不作为落盘格式，因为 HAR 是一次性快照、不适合边抓边写。

## ADR-0006 · 2026-10-18 · 纯 JavaScript + JSDoc，不引入 TypeScript 构建链

宿主加载的是包里的入口文件，插件必须能被 `install_bundle` 之后直接 import。引入 TypeScript 就要带上 tsdown/vite 构建产物，多一个「产物与源码不同步」的失败面。类型信息用 JSDoc 注释表达，需要检查时加 `jsconfig.json` + `tsc --noEmit --checkJs` 即可，不改变运行时与分发形态。代价是少编译期检查，用 `node:test` 的契约测试补。

## ADR-0007 · 2026-10-18 · 上游连接默认不复用（keep-alive off），并固定 ALPN=http/1.1

现象：真机抓到 `POST android.clients.google.com/c2dm/register3 — socket hang up`。`socket hang up` 是 Node 在「连接被对端关掉且没收到响应」时给出的消息，`errorCode` 为 `ECONNRESET`；一个抓包代理如果复用了上游的空闲连接，而对方在空闲期间已经把它关掉，那么下一条请求就会撞上这个错误——这与请求本身无关，却会被记成该请求失败，排障时极具误导性。

备选：① 保持复用，出错重试一次（会隐藏真实失败、POST 不能重试）；② 复用 + 心跳保活（增加复杂度和无谓流量）；③ 每次新建上游连接。选 ③：抓包是排障场景，单条请求多一次 TCP+TLS 握手的代价可以忽略，换来「错误一定是这条请求自己的」。配置项 `upstreamKeepAlive: true` 可退回复用。

同时把上游 ALPN 固定为 `http/1.1`：本插件只解析 HTTP/1.1，若让服务端协商成 h2，就会在解析层制造另一类假错误。

顺带定了错误模型：每条失败除消息外记录 `errorCode`（`ECONNRESET` 等）与 `errorPhase`（`upstream` / `body` / `client` / `upgrade`），`webcap_status` 与 `webcap_detail` 据此给出诊断句，而不是只丢一句 `socket hang up`。

## ADR-0008 · 2026-10-18 · 右侧栏服务用 nested inject，不进顶层 inject

web 任一 client 入口 FAILED 会挡住整个 GUI。`sidebarRightTabs` / `sidebarRight` 是壳服务，不是本插件激活的前提。顶层 `inject` 写上它们、或直接读 `ctx.sidebarRightTabs`，Cordis 抛 `cannot get property without inject`，boot 停在 `dsh-flowspot: failed`。因此顶层只 inject `slots`；右侧栏类型用 `ctx.inject(['sidebarRightTabs'], …)` 挂 nested fiber；「在右侧打开」用 `ctx.get('sidebarRight')`。

## ADR-0009 · 2026-10-18 · 面板资源类型由 `sec-fetch-dest` 推断，mime 兜底

面板要做 F12 那样的 Fetch/XHR、文档、CSS、JS、图片… 分类，但本插件看不到 CDP 的 `Network.requestWillBeSent.resourceType`：流量是系统代理上截的，任何程序都可能进来。

备选：① 只按响应 `content-type` 分类 —— XHR 与文档都是 `text/html`/`application/json`，分不出 Fetch/XHR；② 让用户手填 host 通配映射 —— 变成要维护的配置；③ 用请求头 `sec-fetch-dest`（Chrome/Edge/Firefox 每条请求都发，正是 DevTools 分类所用的信号），缺失时回落到 mime。选 ③。

规则：`sec-fetch-dest: empty` → Fetch/XHR；`document`/`iframe` → 文档；`script`/`worker` → JS；`style` → CSS；`image` → 图片；`video`/`audio` → 媒体；`font` → 字体；`manifest` → 清单。`Upgrade: websocket` 或 101 优先判 WS。没有该头时按 mime 兜底，都判不出（例如请求还在飞、没有响应）归「其他」。分类只在读取时计算（`resourceTypeOf`），不改存储格式，因此旧 JSONL 也能筛。

## ADR-0010 · 2026-10-19 · 请求合并按「方法 + 完整 URL」，折叠分页/时间戳是可选项

现象：轮询接口（`POST https://api.example.com/v2/poll` 每秒一次）把列表刷满，其它接口被挤出去；需求是「同一个接口只占一行，能展开看每一次」。

备选：① 客户端按 URL 聚合 —— 只能看到当前拉取的 200 条，计数不准；② 服务端按 URL 聚合 —— 计数来自整个环形缓冲；③ 连 `id`/`keyword` 这类参数也折叠 —— 会把不同资源合成一个接口，读错数据。选 ②，并且默认不折叠任何查询参数。

规则：`FlowStore.listGroups()` 以「方法 + 完整 URL」为 key，方法不同不算同一接口（`GET` 与 `POST` 同路径是两个）。计数覆盖整个内存缓冲，成员返回最近 N 次（`maxItems`，超出标 `truncated`）。折叠易变参数只作为**接口 / agent 参数**存在（`normalize=1` / `webcap_flows{normalize:true}`）；面板 0.2.0 起不再提供「忽略分页」开关——两个按钮并排时没人能说清第二个是做什么的，而默认的「完全相同 URL」已经覆盖轮询场景。白名单写在 `flows.js` 的 `VOLATILE_PARAMS`，宁可少折叠也不合并不同资源。

代价：分组计数以 `maxFlows`（默认 1000 条）为界，不读 JSONL 历史；要更长时间窗就调大 `maxFlows`。

## ADR-0011 · 2026-10-19 · 证书与数据目录进「设置」弹窗；失败请求并入请求列表

现象：菜单面板里同时堆着运行态（状态格、开始/停止）、低频设置（安装/卸载 CA、选择数据目录、恢复默认、目录路径）和「上游失败」摘要，面板越用越挤；失败摘要还占着菜单的一整块，和请求列表是两块互不相干的区域。

备选：① 留在菜单里加折叠——设置项与运行态仍混在一起；② 挂到 DSH 的通用设置页——插件没有往宿主设置页注册自己分区的入口；③ 面板内自带「设置」弹窗（遮罩 + 居中卡片）——与通用设置/模型设置同一层级，代价是弹窗要自己画。选 ③。

规则：菜单只留运行态与高频动作（开始/停止、清空），右上角放「设置」与 ⇄；「设置」两节——证书（状态 + 安装/卸载）、数据目录（路径 + 选择/恢复默认，抓包运行中置灰）。失败请求从菜单移到**请求列表**，并且**与成功请求用同一种行**（方法 / 状态 / 路径 + 第二行时间·大小·类型·错误码），只把整行着错误色；点击同样是打开第三块的详情，失败原因在详情顶部的错误卡片里。最大化时列表内上下两块，**成功在上、失败在下**（各带 `成功 N 条` / `失败 N 条` 小标题），默认 8:2（失败最多 20%），三档切换 `Default / Success / Error`；右侧窄栏不做窗口分隔，失败请求按时间顺序并进同一个列表、只显示为红色。判据：失败是列表的一种视图而不是运行设置；逐条列表才能点进详情看原因，而窄栏的宽度禁不起再分窗。

聚合视图（「上游失败 N 类」的 `recentErrors`）不再进面板，保留在 agent 侧（`webcap_status`），供不想逐条看的调用方使用。

代价：`8:2` 等比例不持久化，刷新回到默认；面板不再直接展示「同一接口失败了几次」的聚合计数。


