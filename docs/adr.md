# 架构决策（现行）

仍有效的「为什么这样选」。

## ADR-0001 · 2026-10-18 · 抓包引擎自研 Node MITM，不接 CDP、不桥接 ProxyPin

需求是 Charles 式体验：装好 CA、开系统代理，系统上一切认代理的程序自动进。CDP 只能看一个专门启动的浏览器实例，桥接 ProxyPin 则把解密能力放在另一个 App 里。为拿到「全系统 + 数据在本进程 + 不依赖第三方 App」，在插件内自己实现 MITM 代理。代价是证书体系与 h2 要自己扛。

补充（2026-10-23）：CDP 在阶段 6 作为**辅助通道**引入，只提供调用链、源码与参数来源，不接管抓包（见 `architecture.md`「阶段 6 · CDP 通道」）。抓包引擎仍是本条的 MITM 代理，ADR 的选择不变。

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

## ADR-0012 · 2026-10-22 · 运行日志自研 ndjson，且只记非请求事件

现象：抓包插件最容易丢的证据不是流量，是「为什么」——端口为什么退到随机口、停止时系统代理恢复失败没有、certutil 拒装 CA 的原因。这些事件原来只打进程 stdout，桌面应用与远程部署根本看不到，事后无从追溯。

备选：① 引 winston / pino 写文件——与 ADR-0003 的零依赖冲突，还多一个要跟宿主生命周期对齐的组件；② 把事件塞进 `flows/*.jsonl`——请求流水账被非请求事件污染，面板、agent 工具、导出三个读取方都得改；③ 自研一份独立的 ndjson 事件日志。选 ③。

规则（七条）：只收 warn/error 与显式 `event()`；不记头 / 体 / Cookie；一行一个 `{ts,level,event,detail}`；懒创建，第一次写才建 `logs/`（加载时先写一条 `mount`）；按天 + 2 MiB 轮转、最多留 3 份；`status.paths.log` 暴露路径；文件里不写 debug 级。

代价：多一个模块和一处目录；日志与内存里的 `recentErrors` 是两份真相。边界划在这里——日志只证明「发生过」，逐条原因仍看 flow 详情。

补充（2026-10-24）：日志新增只读入口——面板「设置 → 运行日志」一键用 `explorer.exe` 打开目录（不做面板内预览），agent 用 `webcap_logs` 读同一份文件。这只改变了「怎么看」，没有改变「记什么」：仍然只记非请求事件、不记报文。

## ADR-0013 · 2026-10-22 · 数据目录切换只记 pointer，目录与 CA 复制推迟到下次启动

现象：面板选目录后立刻 `mkdirSync` 并复制 CA / 叶子密钥，而真正生效要等重启。于是「选了又反悔」会留下一个没用上的空目录，外加一份 CA 私钥副本——用户完全可能把它选在同步盘或仓库里。

备选：① 保持立即复制，反悔时回删——「先做后撤」，还要记住复制过哪些文件才能安全删；② 选目录只校验并写 pointer，建目录与复制交给下次启动。

选 ②。pointer 增一个 `copyFrom` 字段；启动时 `adoptPendingCopy()` 建目录、复制四个文件、清掉该字段（一次性交接）；复制前目标已有 `ca.crt` 则视为 foreign，不复制。代价是多一次 pointer 读写和一个启动步骤，换到的是 `adoptDataDir()` 对磁盘零副作用——这正是收益所在。

## ADR-0014 · 2026-10-23 · 多语言脚本自研模板生成，不引 curlconverter

现象：需求要把一条 flow 转成 cURL / Python / Go / Rust / JavaScript / Node.js 脚本，且按钮顺序与显隐可配。curlconverter 是现成的参照，但它吃的是 curl 文本：我们手里已经是有结构的 flow，转成 curl 再解析等于先丢掉信息再猜回来。

备选：① 打包 curlconverter（几十个依赖，与「零运行时依赖」冲突，面板 bundle 又没有构建链）；② 每个语言各自从 flow 取值（请求模型重复六遍，改一处漏五处）；③ 一个 `RequestSpec` + 每语言一个只负责渲染的模板文件。

选 ③。规则：

- `lib/codegen/request.js` 是唯一请求模型：查参数与 URL 分开、cookie 拆成对、按 `content-type` 判 json/form/multipart/text/binary、丢掉 `content-length`/`host`/`connection` 等 hop-by-hop 头、把「截断 / 打码 / WebSocket 握手」写进 notes。
- 语言文件只做渲染；`curlOf()`（HAR 之外的旧导出）也改成走同一个模型，避免 curl 与代码视图两套逻辑漂移。
- Python 遵循本仓 `python-standard-coding` 的「一次请求」写法：`headers → cookies → body → url → requests.get/post → 落盘`，不写 `main`、不写 `if __name__`。浏览器 JavaScript 剔除 fetch 禁止设置的头（cookie、user-agent、origin、referer、`sec-*`），并在 notes 说明。
- 语言的顺序与显隐存 `$DSH_HOME/dsh-flowspot.codegen.json`（见 ADR-0016 的模式），不在面板 bundle 里硬编码。

代价：新增语言要自己写模板 + golden 测试（约 100–150 行 + 20 行断言）；冷门语言不做，未知 id 回落到 cURL，而不是假装支持。

## ADR-0015 · 2026-10-23 · 捕获默认不打码，打码改为显式开关

现象：原默认把 `authorization`/`cookie` 等写成 `***redacted***`。代码视图据此生成的脚本带着占位符，不能直接运行；而本插件全程只在本机读写，没有任何对外通信。

备选：① 维持默认打码，脚本里保留占位符（安全但不可运行）；② 只在内存保留明文、JSONL 仍打码（两套真相：面板与落盘不同，排查时最容易踩）；③ 默认不打码，保留 `redact: true` 作为显式开关。

选 ③，与需求方「插件数据都留在宿主机，不要打码」的取舍一致。

规则：`DEFAULTS.redact = false`，`normalizeConfig` 只有显式 `true` 才打开（不会被 YAML 里的字符串意外打开）；开着打码时生成器把 `***redacted***` 当占位并加 note；README「安全与隐私」写清「不向本机之外发送任何数据、数据目录与复制出的脚本不要外传」；运行日志仍然不记报文。代价：数据目录里的 JSONL 可能含明文凭据，换机器或提交仓库前要自己清理。

## ADR-0016 · 2026-10-23 · 代码语言偏好存宿主 pointer 文件，不进 profile 配置、也不只存浏览器

现象：代码语言的按钮顺序与显隐要可配，并且同一个面板会在整页与右栏、不同浏览器会话里打开。

备选：① 写 profile 的 `cordis.patch.yml`——改按钮顺序要重启 DSH，且按行覆盖会替换整行 config；② 面板 `localStorage`——零后端，但换浏览器/清缓存即丢，agent 也读不到用户排好的顺序；③ `$DSH_HOME/dsh-flowspot.codegen.json` 宿主 pointer，面板经 `/code-prefs` 读写。

选 ③：与数据目录 pointer 同一模式，保存即生效、跨浏览器一致，`webcap_code` 省略 `lang` 时能返回同一份顺序。代价：多一条路由和一个文件，面板不再只靠前端状态。

校验规则：未知 id 丢弃、缺失的按注册表顺序补齐、全隐藏时强制保留顺序里的第一个——一个什么都隐藏的偏好会让代码视图看起来坏掉，而不是「用户不要」。

## ADR-0017 · 2026-10-23 · CDP 用一条浏览器级连接 + flatten session，不按标签页各开一条

现象：调用链要覆盖受控浏览器里所有页面的请求；Chrome 的 `/json/list` 每个页面都有自己的 `webSocketDebuggerUrl`。

备选：① 每个页面开一条 WebSocket——标签页一多就是十几条长连接，页面开关要轮询发现，worker 的请求还会缺；② 连浏览器级 `/devtools/browser/<id>`，`Target.setAutoAttach` + `flatten: true` 把所有页面/worker 作为带 `sessionId` 的会话挂在同一条连接上；③ 用 CDP 的 HTTP 轮询接口——拿不到事件流，调用链无从谈起。

选 ②。规则：一条 `CdpClient` 管 id/pending 与事件分发；会话 attach 后按 `sessionId` 发 `Network.enable`、`Debugger.enable`，页面会话再开一次 `Target.setAutoAttach` 接 worker；任何会话断开只清该会话的索引。代价：`sessionId` 要跟着每一条事件/命令走，脚本 key 必须用「`sessionId:scriptId`」，不能只用 `scriptId`。

## ADR-0018 · 2026-10-23 · 受控浏览器由插件启动、必须是独立 profile，且启动前要求抓包在跑

现象：Chrome ≥136 对默认 user-data-dir 直接忽略 `--remote-debugging-port`；而调用链只有和抓包记录配得上才有用。授权又不能让用户每次点弹窗。

备选：① 复用日常浏览器（扩展桥）——登录态免迁移，但要写并分发 MV3 扩展，排在后面；② 插件启动一个独立 profile 的受控浏览器，首次让用户在里面登录一次，之后 pointer + 静默重连；③ 让用户自己用快捷方式带调试参数启动——多一份文档，且「哪个 Chrome 才受控」说不清。

选 ②，配合 ③ 的 `attach` 作为高级口子。规则：profile 固定 `$DSH_HOME/dsh-flowspot.cdp/profile`；启动参数带 `--proxy-server=http://127.0.0.1:<代理端口>` 与 `--proxy-bypass-list=<-loopback>`，所以**必须先开始抓包**（否则拒绝启动并说明原因）；从 `DevToolsActivePort` 读随机端口；pointer 记端口/PID，`ensure()` 在状态轮询时静默重连，浏览器被关掉时只报状态、等用户点一次。代价：受控浏览器是另一套登录态；它也需要装一次 CA（装的是用户级根证书，所以自动生效）。

**已被 ADR-0020 取代（2026-10-24）**：实测这条路开出来是空白新标签页、登录态不共享，用户点一次拿不到当前页面的数据；面板入口已撤下。

## ADR-0019 · 2026-10-23 · 调用链配对按「方法 + 完整 URL + 时间窗」FIFO，不做请求 id 对表

现象：代理和 CDP 是两套 id，浏览器发请求的时间总在代理收到之前（DNS/TLS 可到几百毫秒）；轮询接口的 URL 完全相同。

备选：① 只按 URL 取最近一条——轮询时会把第 3 次的调用链安到第 2 次上；② 要求两端都有 trace id——绝大部分站点没有，做不到；③ 按「方法 + 完整 URL」建队，时间窗内按到达顺序一对一配对。

选 ③：窗口取 `[flow.startedAt - 5000ms, +500ms]`，每个 flow 只取窗口里最早的未配对项；配对结果记在条目上，重复读取不会换人。代价：两端时间差超过窗口就配不上；索引只保留 2000 条，滚掉之后旧 flow 显示「未配到」。

## ADR-0020 · 2026-10-24 · 接管当前浏览器只能走配套扩展，不再新开独立 profile

现象：用户的目标是「我打开着目标页面，点一次就拿到这个页面的数据」。受控浏览器（ADR-0018）实测开出来是空白新标签页，登录态与日常浏览器不共享；而 Chrome ≥136 明确规定：远程调试开关对默认 user-data-dir 不生效。所以「用命令行把调试端口开在日常浏览器上」这条路已被浏览器封死。

备选：① 继续用独立 profile 的受控浏览器——页面上手就要重新登录，点一次拿不到当前页面，体验不成立；② 配套 MV3 扩展用 `chrome.debugger` 接管当前标签页——保留登录态、点一次扩展图标即接管，代价是用户要手动加载一次扩展、Chrome 顶部会提示「正在调试此浏览器」；③ 让用户自己用快捷方式带调试参数启动 Chrome——同样受 136 限制（默认 profile 无效），换成独立 profile 又回到 ①；④ 复制日常 profile 到新目录再启动——体积大、状态易损坏、等于绕过浏览器的安全取舍，不采用。

选 ②。规则：扩展只接管当前标签页（一次一个），`chrome.debugger` 的 `Network`/`Debugger` 事件与命令经「DSH 面板页 ↔ 扩展内容脚本 ↔ 宿主」这条桥转发；宿主侧现有的网络索引、配对、调用链、脚本索引全部复用，不因为通道换了而分叉。受控浏览器代码与 pointer 保留作手动 attach/调试的遗留物，但不再出现在面板主路径。代价：多一个要安装和分发的扩展；扩展的权限与「调试提示」必须向用户说清。

安装方式（2026-10-24 补充）：Chrome 不允许网页/插件通过 API 静默安装扩展（`chrome.webstore.install` 已移除，Windows 上非商店 CRX 会被拒，`--load-extension` 在新版 Chrome 也受限），所以做不到像 CA 那样点一下 `certutil` 就完成。能做到的最接近形态是「设置里提供 下载扩展 zip / 打开扩展目录 / 三步安装引导」，用户手动在 `chrome://extensions` 开发者模式下加载一次，之后常驻；真正的一键安装只有上架 Chrome Web Store（或企业策略下发）才成立，作为后续发布选项。0.6.0 已按这个形态实现：`/extension/zip` 下载、`/extension/open` 打开目录、面板「浏览器扩展」一节给步骤与接管按钮。

## ADR-0021 · 2026-10-22 · 调用链展开 `initiator.stack.parent`，匿名帧按空函数名判噪声

现象：同一条 homefeed，F12 的 Initiator 左侧有几十帧、能看到 `fetchFeeds` / `postApiSnsWebV1Homefeed` 这类方法名，插件详情只有 3 帧，且全来自风控 chunk（`async/9760.js`），业务方法 chips 永远为空。实测 `Network.requestWillBeSent` 的 `initiator.stack.callFrames` 只有 3 帧，其余 42 帧在 `stack.parent` 串起的 4~6 层里（合计 45 帧 / 7 段 / 22 个函数名），而插件只读过 `callFrames`。另一个独立缺陷：CDP 给匿名函数的是空字符串 `""`，噪声名单里写的却是字面量 `'(anonymous)'`，所以匿名帧永远不算噪声——`filteredFrames` 只命中 `_ace_*`，业务方法名被一排无名帧盖住。

备选：① 只显示同步段，让用户回 F12 看——那就不是「像 F12」，面板与 agent 都拿不到业务方法；② 用 `Debugger.getStackTrace(parentId)` 回查异步父栈——实测今天 XHR 的父栈全部内联在 `stack.parent` 里、`parentId` 为空，多一次往返没有收益，只留兜底；③ 递归展开内联的 `parent`（最多 8 层），每帧带 `asyncLevel`，展示按段插分隔，匿名按空名判噪声。

选 ③。两条实测结论一并记下：`Debugger.setAsyncCallStackDepth` 只决定尾部几层能不能采到（64 时 45 帧 / 7 段，0 时 41 帧 / 4 段，父栈本身仍在），它不是拿到方法名的前提，但扩展桥与受控浏览器两条通道都要开，避免行为分叉；`Network.setAttachDebugStack` 在这条链路上没测出差异。

## ADR-0022 · 2026-10-22 · 脚本源码在抓取时落盘，源码查看器只读本地

现象：调用链能定位到 `fetchFeeds @ index.a9f61821.js:1:1582690`，但点开看源码没有本地副本可用。核对 CDP 语义后确认两件事：① `Debugger.scriptParsed` 只推元数据，**不推 JS 正文**；② `Debugger.getScriptSource` 读的是渲染进程里 V8 已保留的脚本对象，**不是重新下载**（不产生新 HTTP 请求、不打 CDN、Network 面板不会多一条），但每次都要显式要一份。也就是说「本地有没有 JS」完全取决于插件自己有没有存过——实测数据目录里只有 CA、flows、logs，没有任何 `.js`。

备选：① 查看时按需拉（点一次、没缓存就 `getScriptSource` 一次）——把「调试通道」变成了「看源码的依赖」：断开、重启、脚本被卸载之后都看不了，大包还会每次翻页重读；② 页面加载时全量预存所有 `scriptParsed` 的源码——一次接管实测推出 62 个脚本，一条调用链就涉及 4~5 个、按调用点列号取下限合计 ≥4.4MB，全量要几十 MB 且绝大多数永远用不到，会拖慢通道；③ 抓取时按调用链落盘：一条**业务接口**请求带调用栈时，把它栈里涉及的脚本各取一次写进数据目录，`sourceOf` 之后只读磁盘。

选 ③。规则：落盘目录 `<dataDir>/scripts`，单脚本上限 4MB、总量 256MB（超限不落盘并把原因记进索引，面板据此解释「为什么看不了」，而不是偷偷再拉）；**触发面只给业务接口**——`type` 是 `XHR`/`Fetch`、URL 是 http(s)、host/path 不在埋点/APM/风控探针噪声表里（`sourceFilter.js`），内联脚本与 `data:`/`blob:` 跳过；实测旧规则（任何带调用栈的请求）会先落 `as/v2/fp/*.js`（风控指纹 396KB）、内联脚本（288KB）和 polyfill，而真正要看的业务大包被排在后面。同一脚本只取一次、失败最多两次、串行执行避免和正常请求抢通道；预览与定位（含「整份源码」分页、调用链 `withSource` 的片段、`webcap_script get/search`）全部读本地；生命周期跟「清空 CDP」绑定。代价：每站首次几十 MB 磁盘里的一小部分（4~10MB）+ 每脚本一次往返；断开或换标签页不再丢源码。


