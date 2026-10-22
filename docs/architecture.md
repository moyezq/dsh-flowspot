# dsh-flowspot 架构（目标态）

本文写三件事：核心功能是什么、核心模块有哪些、哪些不做。每个阶段落到哪些模块也在这里标一次。

## 核心功能

装一次 CA、点一次「开始抓包」之后，Windows 上所有走系统代理的程序（浏览器、Electron 桌面应用、PC 微信/小程序宿主、.NET/Qt 客户端）的 HTTPS 请求被本插件解密，记录成一条条 flow；agent 可以列举、按域名/状态/关键词筛选、逐条看请求头与报文体、导出 curl 或 HAR。

一句话：**Charles 的抓包闭环，搬到 DSH 里，由 agent 直接读。**

## 第一阶段成果

第一阶段（骨架 → 能抓 → 能筛 → 能看详情）已经跑通，可以当作确定结论陈述。每条都能在代码里指到落点，也能在面板上复现。

| 能力 | 现在成立的陈述 | 落点 |
|---|---|---|
| HTTPS 解密抓包 | 装好 CA 并开启抓包后，凡走 Windows 系统代理的程序发出的 HTTPS 请求都会被解密、转发并记录成一条 flow；上游只说 HTTP/1.1（ALPN 固定 `http/1.1`，让浏览器回落） | `lib/proxy.js`、`lib/x509.js`、`lib/sysproxy.js` |
| 任意域名即时签发 | 任意 SNI 域名第一次出现时就地签发叶子证书，共用同一对叶子密钥，不需要预先配置域名白名单 | `lib/x509.js` `leafFor()` |
| 系统代理接管与恢复 | 开始抓包把系统代理指向 `127.0.0.1:<port>` 并广播变更（已跑通）；停止或卸载时按开抓前备份的原值恢复（已实现，待真机验收） | `lib/sysproxy.js`、`sysproxy.ps1` |
| 端口兜底 | `8899` 被占用、或被 Windows 保留段拒绝绑定时自动改用系统分配的端口，并在状态与启动结果里写明原因 | `lib/proxy.js` `start()` |
| 按请求类型筛选 | 列表按 F12 的分类过滤：Fetch/XHR、文档、CSS、JS、图片、媒体、字体、WS、Wasm、清单、其他；分类信号取 `sec-fetch-dest`，缺失时回落响应 mime | `lib/flows.js` `resourceTypeOf()` |
| Fetch/XHR 方法二次筛选 | 选中 Fetch/XHR 后，再按请求方法（GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS）过滤，与关键词筛选叠加生效 | `client/client.js` 请求列表 |
| 关键词筛选 | 按 URL / host / 方法子串筛选，大小写不敏感 | `lib/flows.js` `list()` |
| 请求详情可读 | 单条 flow 能看到请求头、请求体、响应头、响应体；`gzip`/`deflate`/`br` 自动解压，超限截断，二进制转 base64；`authorization`/`cookie` 等默认打码 | `lib/flows.js` `describeBody()` |
| 失败可诊断 | 失败请求带错误码（如 `ECONNRESET`）、发生阶段（`upstream`/`body`/`client`/`upgrade`）和一句中文诊断；客户端主动取消不计为失败 | `lib/proxy.js`、`lib/tools.js` `ERROR_HINTS` |
| 接口合并 | 同「方法 + 完整 URL」的请求合成一行、`×N` 计数、`▸` 按时间顺序展开；计数覆盖整个内存缓冲（默认 1000 条），宿主侧旧版本时面板在本地合并 | `lib/flows.js` `listGroups()`、`client/client.js` `groupLocal()` |
| 两种呈现位置 | 同一块面板可停在整页或右侧栏，用 ⇄ 互切，同一时刻只有一处显示 | `client/client.js` `togglePlacement()` |
| agent 可直接读 | 9 个 `webcap_*` 工具：状态、启停、CA、列表（含 `since` 时间窗）、详情、报文体、体内搜索、导出（curl/HAR/JSON）、清空 | `lib/tools.js` |
| 运行埋点可上报 | 只记非请求事件（挂载 / 卸载、起停抓包含真实端口、系统代理启停、CA 装与卸、数据目录切换），一行一条 JSON、按天与大小滚动、最多 3 份、懒创建、不含报文，可安全附进 issue | `lib/logs.js`、`lib/runtime.js` |
| 数据有落点 | 一次抓包会话一个 JSONL 文件（只加载、或抓包没流量时不建文件）；CA、叶子密钥、系统代理备份都在数据目录；端口 / 系统代理 / CA / 数据目录一次在状态里说清 | `lib/flows.js`、`lib/runtime.js` |

契约测试覆盖不到、改动时要人工关注的行为，见 `docs/pipelines.md`「测试边界」。

## 技术栈

| 层 | 选择 | 说明 |
|---|---|---|
| 宿主 | DeepSeek Harness / cordis | 插件以 `apply(ctx, config)` 形态加载；用 `ctx.inject(['webServer','tools'])` 取服务，`ctx.effect` 管注册与卸载 |
| 运行时 | Node.js ≥ 22，ESM | 与宿主同进程；**零构建**，loader 直接 import `index.js` |
| 语言 | JavaScript + JSDoc 类型注释 | 不用 TypeScript，理由见 ADR-0006 |
| 辅助脚本 | PowerShell（`lib/sysproxy.ps1`） | 只有一件事：P/Invoke `InternetSetOption` 广播代理变更 |
| 网络与加密 | `node:net` / `node:tls` / `node:http` / `node:https` / `node:crypto` / `node:zlib` / `node:stream` | MITM、签名、解压、流式转发全部走标准库 |
| 证书 | 自写 DER/X.509（`lib/der.js`、`lib/x509.js`） | 不引入 node-forge，理由见 ADR-0003 |
| Windows 集成 | `reg.exe`、`powershell.exe`（Add-Type P/Invoke）、`certutil.exe` | 系统代理、变更广播、CA 信任，全部用户级免提权 |
| 前端 | 浏览器内手写 bundle（`window.__ModuleLoader__` + 宿主 React 表） | 无打包器；样式只用 `--dsw-alias-*` token |
| 测试 | `node:test` + `node:assert` | 零依赖；含真实 TLS 握手验证证书链 |
| 分发 | `package.json` 的 `dsh.bundle.patch` + `dsh.client`，经 `plugin_manager install_bundle` 装进 profile | — |

**不引入**：node-forge、http-mitm-proxy、typescript、tsdown/vite、任何 npm 运行时依赖。

参考案例（源码不在本仓，只作选型对照）：

- **ProxyPin**（开源，<https://github.com/wanghongenpin/proxypin>）：Flutter/Dart + pointycastle（自实现 X.509/PKCS12）+ 自研 HTTP/2（含 HPACK/Huffman）+ flutter_js（脚本）+ desktop_multi_window / tray_manager + Kotlin VpnService（用户态 TCP/IP 栈）+ Swift NetworkExtension + MCP over HTTP（9127）。
- **dsh-capture**（同生态的抓包插件，仅作对照）：Node ESM + cordis 插件 + 零依赖 pcap/pcapng 解析（含 TCP 重组）+ Npcap/dumpcap 与 pktmon 双后端 + PowerShell 提权助手 + 手写 React client bundle + node:test 契约测试。

选型理由两句：

- **为什么不用 Python**：插件必须与宿主同进程加载，Python 只能做子进程；代理热路径要跨进程 IPC，生命周期和崩溃恢复都得自己管。Node 的 `net/tls` 已经够直接。
- **为什么不用 TypeScript**：见 ADR-0006 —— 零构建换来「装进 profile 只多了几个文件」；类型信息用 JSDoc 表达，日后要检查加一个 `jsconfig.json` + `tsc --noEmit` 即可，不改代码。

## 暂时不做 / 明确不做

**明确不做**（与目标冲突，不是排期问题）：

- 手机（iOS/Android）抓包 —— 用 ProxyPin 的 MCP，插件不碰。配套的配置型 bundle 在 `proxypin-mcp/`（两个文件，把 `@deepseek-ai/dsh-mcp-client` 指向 `http://127.0.0.1:9127/mcp`，装法与主插件独立）。
- VPN / 驱动型强制代理、Npcap/pktmon 嗅探 —— 抓包软件的另一条技术路线，本仓不重复。
- 证书 pinning 绕过 —— 任何 MITM 代理都做不到，不承诺。
- 规则改写以外的流量操控（断点、发包重放）留到有真实需求再说，不进目标态。

**暂时不做**（目标态该有，但排在后面）：

- HTTP/2：v1 的 ALPN 只宣告 `http/1.1`，让 Chrome 自动回落；h2 用 `node:http2` 后补。
- WebSocket 帧级解析：v1 只记录握手（101 + 头），不解析帧。
- macOS / Linux：系统代理与 CA 装法是三套独立逻辑，v1 只做 Windows。
- Firefox：它用自己的证书库，v1 只提示手动导入，不自动装。
- HTTP/3(QUIC)：浏览器配置代理后会禁用 QUIC，不专门处理。

## 核心模块

| 模块 | 落点 | 职责 | 状态 |
|---|---|---|---|
| 插件入口 | `index.js` | 懒建 runtime、挂路由、注册工具、卸载时恢复系统代理 | 已真机验证（加载、路由与工具注册） |
| 运行时装配 | `lib/runtime.js` | 配置归一化（含端口与数据目录）、start/stop/status/dispose；`status` 带 `build`（版本 + 宿主启动时间），面板据此识别「宿主侧旧版本」 | 已真机验证（启停与状态读取） |
| MITM 内核 | `lib/proxy.js` | CONNECT → 200 → TLS 终止（按 SNI 发证）→ 内层 HTTP/1.1 → 上游转发；WS 透传；SSE 不缓冲；上游连接默认不复用、ALPN 固定 `http/1.1`（ADR-0007）；失败记 `errorCode`/`errorPhase`；客户端取消（`errorPhase: client`）不算失败，上游失败按 端点+code+phase 聚合成 `recentErrors`（最多 20 类，每类带最新 `flowId`），`clearErrors()` 与 flow 清空同步 | 已真机验证（HTTPS 抓取） |
| 证书机构 | `lib/x509.js` | 生成/加载本地 CA，按域名签叶子（共享 RSA keypair、SAN、iPAddress、重载后 issuer 字节稳定） | 已真机验证（抓取时按 SNI 签发） |
| DER 编码 | `lib/der.js` | ASN.1 编码原语，零依赖签发的基础 | 已实现 |
| 系统代理控制 | `lib/sysproxy.js` + `lib/sysproxy.ps1` | 写 `HKCU\...\Internet Settings`、备份原值、调用 `InternetSetOption` 广播 | 已实现（抓包期间生效；停止时按备份恢复） |
| CA 信任管理 | `lib/certstore.js` | `certutil -addstore/-delstore` + PowerShell 按 thumbprint 查询（避开本地化输出） | 已真机验证（安装后 HTTPS 可解密） |
| flow 存储 | `lib/flows.js` | 环形缓冲 + JSONL 落盘、头脱敏、gzip/br 解压、curl/HAR 生成；每条 flow 归入 F12 式资源类型（`sec-fetch-dest` 优先、mime 兜底、upgrade 即 WS，ADR-0009），按类型筛选；`listGroups()` 按「方法 + URL」聚合重复调用（ADR-0010），可选折叠分页/时间戳（`VOLATILE_PARAMS` + `normalizeUrl`） | 已真机验证（分类/方法筛选、详情读取） |
| 数据目录记忆 | `lib/location.js` | 面板选择的目录写进 `$DSH_HOME/dsh-flowspot.location.json`；启动时优先级高于配置 | 已实现 |
| agent 工具 | `lib/tools.js` | 9 个 `webcap_*` 工具，统一 JSON 输出；`webcap_flows` 支持 `group` / `normalize`（合并视图），`webcap_detail` 附带 `errorHint`；`webcap_clear` 同时清 flow 与代理的失败摘要（`errorsCleared`） | 已实现 |
| HTTP 路由 | `lib/routes.js` | `/dsh-flowspot/*` 供面板使用，复用同一批工具实现；`data-dir` 走宿主 `ctx.directoryPicker` 的原生选择器（服务用 `ctx.get` 取，未注入时不抛进接口）；`flows` 透传 `group` / `normalize` | 已真机验证（面板读取全走这批路由） |
| 面板与入口 | `client/client.js` | 两处入口共用一块面板：左侧栏一级入口 `sidebar.panellist` + 主面板 `main`（整页）；右侧栏 tab 类型经 nested inject 等 `sidebarRightTabs`（kind `flowspot`，`+` 引导页入口，不进顶层 inject，ADR-0008）+ `sidebar.right.pane.tab` 正文（窄栏布局）。标题右侧 **⇄** 按钮在整页与右栏之间互切：page→right 先 `layout.selectPanel(null)` 归还中栏、再按帧重试 `openTab`（右栏是会话作用域，见踩坑第 3 条）；右栏正文挂载时若中栏仍是本插件整页则主动归还。宿主展示模式（push/fullscreen）不由插件接管（<768px 时全屏由视口决定）。面板本身三块并列、每块自带 `dshwc-panel-head` 标题栏：**菜单**（`.dshwc-side`：状态四格 + 开始/停止 + 清空 + 设置 + ⇄）、**请求列表**（标题栏带「合并」开关，下面是失败/成功比例、筛选与列表）、**请求详情**（标题栏固定，正文是错误卡片与可折叠各块）；窄栏（`.dshwc-rightpane`）里三块改成上下堆叠。请求列表**不再是覆盖式抽屉**。筛选按 F12 分类（类型 + Fetch/XHR 下方法二级 + 关键词）。**合并开关放在请求列表标题栏**（它改的是列表内容），行四列（方法/路径/×N/▸），最近状态与类型在第二行，URL 占满宽度；展开按时间顺序列每次调用。**失败请求并入请求列表且与成功行同格式**（ADR-0011）：都按「方法/状态/路径 + 第二行时间·大小·类型·错误码」渲染，失败行整体着错误色、点击同样打开详情；整页时列表内上下两块、成功在上失败在下（`成功 N 条` / `失败 N 条`）、默认 8:2（失败最多 20%）、三档 `Default / Success / Error`；窄栏不分窗，失败请求按时间并入同一个列表只显红色。聚合的 `recentErrors` 只留在 agent 侧。失败原因在详情顶部的错误卡片里（消息、错误码、阶段、诊断）。「设置」是面板内自绘的遮罩 + 居中卡片，两节：证书（状态 + 安装/卸载）、数据目录（路径 + 选择/恢复默认，抓包运行中置灰）。详情按块折叠（请求头/请求体/响应头/响应体，状态跨请求保留），失败条目可点开对应详情（旧宿主无 `flowId` 时按 host+path 回查最近一次失败）；合并视图以服务端 `grouped` 为准，宿主侧不认识该参数时降级为客户端 `groupLocal()` 并标注「本地合并」；空组集不遮挡平铺列表；旧宿主不返回 `build` 时顶部显示版本不一致横幅 | 已实现（整页三块、分类/方法筛选、右栏入口） |
| 运行埋点 | `lib/logs.js` | 事件日志：一行一条 `{ts,level,event,detail}`、按天 + 2 MiB 轮转、保留 3 份、懒创建；只收 warn/error 与显式 `event()`，不记报文 | 已实现 |
| 文案 | `locale/{zh,en}.json` | 插件管理器里的标题与描述 | 已写 |
| 契约测试 | `test/*.mjs` | DER 编码、证书链与真 TLS 握手、flow 存储（含类型分类）、路由契约（含跨站 POST 拒绝）、配置归一化（端口/数据目录）、上游失败聚合 | 已实现（6 个文件 / 73 条） |

## 阶段与模块落点

**阶段 1 · 骨架能装**（已完成）：`package.json`、`cordis.patch.yml`、`index.js`、`locale/`、`client/client.js` 最小面板。目标是 `install_bundle` 后侧栏出现「抓包工具」入口，点开是一个空面板。

**阶段 2 · 能抓到一条**（已完成，真机验证：HTTPS 请求能解密并出现在列表里）：`lib/der.js` → `lib/x509.js` → `lib/proxy.js` → `lib/sysproxy.js` → `lib/certstore.js` → `lib/flows.js` → `lib/tools.js`。目标是 Chrome 访问任意 https 站点后，`webcap_flows` 有一条、`webcap_body` 能读到 JSON。

**阶段 3 · 定位好用**（进行中）：`lib/routes.js` 完整面板、时间窗筛选、host 过滤、HAR 导出、失败自检（端口/代理/CA 三处一次说清）。目标是「点一下按钮 → 给 agent 一个时间窗 → 拿到接口清单」。已落地并可用的部分见「第一阶段成果」；导出与时间窗已实现，端口/代理/CA 三处自检仍在计划里。

**阶段 4 · 可选增强**（未开始）：`node:http2` 补 h2、WebSocket 帧解析、规则改写、macOS/Linux。仅在前三阶段稳定后考虑。

## 运行与数据落点

- 代理监听：`127.0.0.1:<port>`，端口默认 `8899`；端口被占用（`EADDRINUSE`）或 Windows 保留区拒绝绑定（`EACCES`/`EPERM`，常见于 Hyper-V/WinNAT 的 `netsh ... show excludedportrange` 范围）时自动换随机端口，并在状态与启动结果里报告真实端口和原因。
- 数据目录：默认 `$DSH_HOME/dsh-flowspot`（即 `%USERPROFILE%\.dsh\dsh-flowspot`）。优先级：面板「选择数据目录」写下的 pointer 文件（`$DSH_HOME/dsh-flowspot.location.json`）> 配置项 `dataDir` > 默认；三种写法都接受（绝对路径、`~/...`、相对 DSH home）。切换只写 pointer（不建目录、不复制），下次启动时 `adoptPendingCopy()` 建目录并把 CA 复制过去（目标已有 CA 则不覆盖），所以「选了又反悔」不留空目录；抓包运行中拒绝切换。
  - `ca.crt` / `ca.key.pem`：本地根证书与私钥（首次启动生成，装一次即可）
  - `leaf.key.pem` / `leaf.pub.der`：所有域名共用的叶子密钥
  - `flows/flows-<时间戳>.jsonl`：一次抓包会话一个追加文件（第一条 flow 落盘时创建，`stop()` 关）
  - `logs/plugin-<日期>-<NN>.ndjson`：运行事件日志（懒创建，最多 3 份）
  - `sysproxy.backup.json`：开代理前的系统代理原值，关闭/卸载时据此恢复
