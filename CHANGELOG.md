# 变更记录

每个发布版一节，**最新在前**。一节只写「用的人能感知到的变化」：能做什么了、行为变了什么、升级要注意什么、已知限制。
实现细节进 `docs/`（架构 → `docs/architecture.md`、流程 → `docs/pipelines.md`、踩坑 → `docs/engineering.md`、为什么这么定 → `docs/adr.md`）。

版本号与 `package.json` 一致，tag 形如 `vX.Y.Z`；GitHub Release 的正文从对应的一节截取。

---

## v0.6.13 · 2026-10-24 · 上架 npm

首个发布到 npm 的版本。功能与 v0.6.12 相同，另含发布用的元数据与文档：

- `package.json` 去掉 `private`，补 `author` / `homepage` / `repository` / `bugs` / `publishConfig`，`files` 白名单带 `CHANGELOG.md`
- 新增 `CHANGELOG.md`：每版一节，Release 正文从它截取
- 安装方式多一行：`dsh plugin --profile web add dsh-flowspot`（`dsh` 把参数转给 profile 里的 pnpm，装完自动写进 `dsh.profile.bundles`）
- 打包核对：47 个文件 / 165 KB（解包 507 KB），`docs/` 与 `test/` 不进包

升级：重启 DSH 或桌面端即可；扩展仍是 0.2.9，不需要重装。

---

## v0.6.12 · 2026-10-23 · 桌面端可用

> 0.6.8 ~ 0.6.11 是同一阶段的中间修复（都没单独发布），合并进本节。

### 新增

- **DSH Desktop 支持**（ADR-0023）：桌面端装得上、系统抓包正常，**CDP 抓包也能接管标签页、看调用链与源码**。桌面端跑的是同一套 `dsh-web-app` + 同一个 node 宿主，差异只有两处——安装走桌面应用的插件页（`dsh plugin --profile desktop` 被宿主拒绝），以及扩展地址交接（桌面窗口的 origin 是 `dsh-app://`）。
- **扩展地址交接 + 宿主锁**：宿主用 `status.bridge.base` 把真实的 `http://127.0.0.1:<端口>` 交给面板，面板一键「在 Chrome 中打开」连接页 `/dsh-flowspot/bridge/hello`；扩展 manifest 带固定 `key` 与 `externally_connectable`，页面直接 `chrome.runtime.sendMessage(<id>, {kind:'set-host'})`，不依赖内容脚本。显式交接后锁 10 分钟，锁定期内忽略别的宿主页面的 `hello`。
- **实例锁**：`<数据目录>/instance.lock` 让同一份数据目录的抓包串行化。后开的实例会被拒绝并提示「另一个 DSH 实例（pid/端口）正在抓包」；清空 CDP 源码、重置与更换数据目录同样受保护。只读查看不受影响。
- **系统命令解析**：`certutil` / `powershell` / `reg` / `explorer` / `taskkill` 优先解析成 `%SystemRoot%\System32` 下的绝对路径——GUI 启动的进程 PATH 常被裁剪，Electron 尤其明显。
- **标签页发现兜底**：点扩展图标、SW 启动、连续两次 poll 失败时，遍历本机标签页里所有 `http://127.0.0.1:<port>` 的 origin 找宿主。

### 修复

- **桌面端 CDP 一直报「扩展没有响应」**。四层根因：① 桌面端没有内容脚本可跑，地址给不到扩展；② 扩展默认对着 `127.0.0.1:3080` 轮询；③ 同时开着 web 版面板时，那边每 10 秒一次的 `hello` 会把地址顶回去；④ 换宿主后要干等 20 秒长轮询才生效。对应修法：`bridge.base` + 连接页、`storage.local` 记住地址、`hostPinnedUntil` 锁、`pollSeq` 代次。
- **「在 Chrome 中打开」报 `The "file" argument must be of type string`**：`findBrowser()` 返回 `{path,name}` 对象，被直接丢给了 `spawn()`。
- **CDP 指针串台**：读回 `dsh-flowspot.cdp.json` 时校验进程是否存活，不再显示另一个实例留下的、早已关闭的受控浏览器。

### 行为变化

- 扩展 ID 固定为 **`labahanibojjkgcacfdmeafjgdlidpcb`**（由 manifest 的 `key` 决定），升级要重载一次扩展；ID 不对说明加载的是旧副本。
- `engines` 从 `>=22` 放宽到 `>=20`，声明 `dsh.compatibility.dshReleases`。
- `status` 新增 `bridge` / `instance` / `electron` 三个字段：扩展连接地址、实例锁状态、宿主形态。
- 面板在「面板 origin 与宿主 http 源不一致」时（桌面端必然如此）显示扩展连接地址与按钮。

### 升级

1. 重启 DSH / 桌面端（宿主代码在进程启动时加载）。
2. 重载扩展：`chrome://extensions` → Flowspot Bridge → 刷新；版本 **0.2.9**、ID 为上面那串。
3. 桌面端首次用 CDP：面板 → **CDP 抓包** → **在 Chrome 中打开** → 页面显示「扩展已记住这个地址」→ 关掉 → **连接浏览器**。
4. 从更早的开发快照升上来：先点一次「清空 CDP」再重抓。

### 已知限制

- 抓包是串行的（两个实例共用一个数据目录）；要完全隔离用「设置 → 数据目录」显式分开。
- 扩展同一时间只连一个宿主，最后一次显式交接说了算（锁 10 分钟）。
- 桌面端端口每次启动会变，扩展记得上次那个，变了再点一次连接页。
- 系统抓包没有调用链、CDP 抓包没有响应体（刻意的不对称）。
- 只支持 Windows；只抓走系统代理的程序；只做 HTTP/1.1；WebSocket 只记录握手。

---

## v0.6.7 · 2026-10-23 · 首个发布版

此前没有发布过任何版本，所以这一节按「现在能做什么」写。

### 系统抓包（走 Windows 系统代理）

- 一键接管系统代理，按域名自动签发证书；浏览器、Electron 应用、桌面客户端的 HTTPS 请求都能解密记录。
- 请求列表按 F12 分类筛选、成功/失败分档、同「方法 + URL」合并 ×N。
- 详情：请求头/体、响应头/体、失败原因卡片；导出 curl / HAR / JSON。
- 详情「代码」页：一键生成 cURL / Python / Go / Rust / JavaScript / Node.js，按钮顺序与显隐可配；打码默认关闭（生成的脚本要真实值才能跑）。

### CDP 抓包（接管当前标签页，保留登录态）

- 随包 MV3 扩展用 `chrome.debugger` 接管当前标签页；列出/选择/重新选择/断开。
- 只记录这个页面的请求；与系统抓包互斥切换，两边数据各自保留。
- 调用链：同步段 + `stack.parent` 异步段展平，按「Continue async」分段，帧数与顺序等价于 F12 的 Initiator（小红书 homefeed 实测 45 帧 / 7 段）。
- 业务方法 chips、每帧复制方法名、只看业务帧。
- 源码：抓取时只对业务接口（XHR/Fetch，排除埋点/APM/风控探针/内联脚本）把调用链涉及的脚本落盘（单脚本 4MB、总量 256MB）；查看器只读本地、按 `{}` 展开、同名方法上一处/下一处、一键在资源管理器里选中那个 `.js`。
- 断开 CDP 或重启后列表与已落盘源码都还在；只有「清空 CDP」才清（连磁盘一起）。
- CDP 抓到的接口同样能转 6 种语言脚本，与系统抓包共用同一批生成器。

### 给 agent 的 14 个工具

`webcap_status` / `serve` / `ca` / `flows` / `detail` / `body` / `search` / `export` / `code` / `cdp` / `chain` / `script` / `logs` / `clear`。面板与 agent 走同一份实现。

### 已知限制

- 系统抓包没有调用链（JS 栈只在浏览器内部），CDP 抓包没有响应体（响应体来自代理）。
- 只支持 Windows；只抓走系统代理的程序；只做 HTTP/1.1；WebSocket 只记录握手。
- CDP 需要扩展：Chrome ≥136 不允许对默认 profile 开调试端口，只能靠随包扩展接管；需要手动加载一次。
