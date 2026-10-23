# 工程踩坑

本仓业务流程里真实踩过的问题。一条一个事件。通用 skill 已规定的写法不在这里再记。

- [加了右侧栏入口之后，DSH 整个界面打不开？](#1-加了右侧栏入口之后dsh-整个界面打不开)
- [点「选择数据目录」只报「操作失败」，为什么？](#2-点选择数据目录只报操作失败为什么)
- [从整页切右侧栏报「没有会话」，右栏一开就盖住整窗？](#3-从整页切右侧栏报没有会话右栏一开就盖住整窗)
- [点「接口合并」之后请求列表变空？](#4-点接口合并之后请求列表变空)
- [失败列表点不动、「清空」清不掉它？](#5-失败列表点不动清空清不掉它)
- [F12 里有一整列方法名，插件的调用链只有 3 帧？](#6-f12-里有一整列方法名插件的调用链只有-3-帧)
- [脚本怎么滚都抓不到首页的 homefeed？](#7-脚本怎么滚都抓不到首页的-homefeed)
- [点调用链的帧，提示「找不到脚本 / js 文件不存在」？](#8-点调用链的帧提示找不到脚本-js-文件不存在)
- [落盘大脚本时报「CDP 命令超时：Debugger.getScriptSource」？](#9-落盘大脚本时报cdp-命令超时debuggergetscriptsource)

---

## 1. 加了右侧栏入口之后，DSH 整个界面打不开？

### 出了什么问题

`dsh web` 停在 boot 页，报：

```
web boot: 1 entry did not activate
dsh-flowspot: failed
```

宿主进程还在，浏览器界面进不去。

### 当时的情况

最新一轮在 `client/client.js` 给面板加了右侧栏：`apply` 里直接读 `ctx.sidebarRightTabs` 再 `register`，整页按钮读 `ctx.sidebarRight.openTab`。顶层 `inject` 仍只有 `['slots']`。profile 用 `link:` 指向本仓，改完重启即加载这份 client。

### 为什么会这样

Cordis 的 context 是代理：`ctx.sidebarRightTabs` 不是「没有就 undefined」，未注入就抛 `cannot get property "sidebarRightTabs" without inject`。`ctx.effect` 里一抛，这条 client fiber 进 FAILED。web boot 对任一入口 FAILED 都拒绝挂应用，所以整页打不开。`if (!registry)` 写了也执行不到，因为取值本身已经抛了。

### 试过哪些办法

对照能正常加载的插件：`dsh-capture` 只 inject `slots`、不碰右侧栏服务；BrowserSkill 顶层只 inject `slots`，右侧栏用 `ctx.inject(['sidebarRight', 'sidebarRightTabs'], …)` 挂 nested fiber。没把 `sidebarRightTabs` 加进顶层 inject（加进去会变成「服务缺失则本插件一直 pending」，同样挡 boot）。也没撤掉右侧栏功能。

### 最后怎么解决

顶层 `inject` 仍只有 `slots`。右侧栏类型改成 `ctx.inject(['sidebarRightTabs'], …)` 再 `register`；「在右侧打开」改成 `ctx.get('sidebarRight')`。nested fiber 等服务，父入口照常 ACTIVE。落点：`client/client.js`；约束见 ADR-0008。

---

## 2. 点「选择数据目录」只报「操作失败」，为什么？

### 出了什么问题

面板里点「选择数据目录」，界面只回一句「操作失败」，不弹系统文件夹框，也没有任何原因。

### 当时的情况

按钮 POST `/dsh-flowspot/data-dir {action:'pick'}`；宿主是本机 `dsh web`，面板在本地 Chromium 里。抓包可能正开着。

### 为什么会这样

两个原因叠在一起，前一个把后一个的原因盖住了：

1. `lib/routes.js` 里直接读 `ctx.directoryPicker`。宿主插件顶层只 `inject(['slots'])`，而 Cordis 的 context 是代理：未注入的服务属性**读一次就抛** `cannot get property "directoryPicker" without inject`。抛出点在 `try` 之外，路由因此没产出 JSON，客户端 `api()` 解析失败后落到兜底文案「操作失败」——真正的失败原因在这一步就丢了。
2. 抓包运行中 `rt.changeDataDir()` 本来会返回 `ok:false`（活跃的 CA 与 flow 文件不能换目录），这条信息是对的，但按钮没置灰，用户先撞上的是第 1 条。

### 试过哪些办法

先分清「服务没挂载」还是「读服务就抛」：`test/routes.test.mjs` 的 `fakeHost()` 直接赋值 `ctx.directoryPicker = {...}` 能过，说明路由逻辑没错，差异在真实 Cordis context 的取值语义。ADR-0008 已经踩过同一个坑（`ctx.sidebarRightTabs`），直接复用那条结论。

### 最后怎么解决

`lib/routes.js` 加 `optionalService(ctx, name)`：先 `ctx.get(name)`（不依赖 inject 的取值方式），拿不到再退回直接读属性并 `catch`；`picker.capability()` 也包了 `try`。服务缺失、或后端是 `browse`（弹不出系统对话框）时，错误文案直接说清原因并指路 profile 的 `dataDir`。面板侧：抓包运行时两个换目录按钮置灰并注明原因，把「正确但会被盖住的失败」提前成不可点状态。落点：`lib/routes.js`、`client/client.js`。

**通用结论**：宿主服务一律用 `ctx.get(name)` 取，别用 `ctx.name` —— 顶层 inject 只有 `slots` 是刻意的（ADR-0008），任何新增服务读取都要走 `get`。

---

## 3. 从整页切右侧栏报「没有会话」，右栏一开就盖住整窗？

### 出了什么问题

- 面板在整页时点 ⇄ 想停靠到右栏，只回一句「右侧栏不可用：先打开一个会话…」，界面不动。
- 无论从右栏还是整页打开，请求列表都盖住整个窗口，看不到中间的会话。

### 当时的情况

⇄ 的 page→right 分支先 `right.openTab(kind)`、成功之后再 `layout.selectPanel(null)` 把中栏还给会话；请求列表用 `position:absolute; inset:0` 的抽屉盖在面板上。

### 为什么会这样

宿主右栏是**会话作用域**：`ctx.sidebarRight` 的命令作用在「屏幕上的会话」。本插件的整页是 root 级 `main` keyed 入口，它把中栏从 Conversation 换成自己，屏幕上就没有会话了，`openTab` 必抛——这正是我们 catch 之后回显「没有会话」的那次失败。顺序反了：先把中栏还给会话、等下一次提交挂上会话表面，再 `openTab` 才成立。另一边，请求列表是自己写的覆盖式抽屉（`inset:0`），盖住的与其说是窗口，不如说是整块面板。

### 试过哪些办法

先把 `selectPanel(null)` 挪到 `openTab` 之前，仍旧抛——store 更新后要等一帧才挂上会话表面；改成按帧重试（最多 24 帧）后成功。抽屉改成面板内两栏后，窄栏里左右排会被挤扁，于是停靠态改成上下堆叠。

### 最后怎么解决

`togglePlacement` 变 async：page→right 先 `layout.selectPanel(null)`，再用 `openRightTabWhenReady` 按帧重试 `openTab`；右栏正文挂载时若中栏还是本插件整页，主动把中栏还给会话。宿主自己的展示模式（push / fullscreen）不接管：`tabInfo.sidebar.fullscreen` 里混着「手动模式」和「<768px 的响应式」，照着反转会把窄窗下的全屏翻成手动全屏，所以全屏只管交给宿主的 ⛶ 控件。请求列表从绝对定位抽屉改成面板右侧常驻栏（`.dshwc-main`），状态与开关留在左侧 `.dshwc-side`。落点：`client/client.js`。

**通用结论**：右栏是会话作用域的；任何占用中栏的全局面板都会让右栏命令失效，跨两者切换必须先归还中栏并等一帧。

---

## 4. 点「接口合并」之后请求列表变空？

### 出了什么问题

点了列表工具栏的「接口合并」，整个请求列表变空（既没有合并行，也没有原来的平铺行），只有左侧还在。

### 当时的情况

面板改成了 `mergeOn ? groups : flows` 的渲染。安装新版之后刷新了浏览器页面（client bundle 重新加载），但宿主进程没重启。

### 为什么会这样

client bundle 是页面加载时从包目录取的，**宿主侧代码是进程启动时 import 的**。页面刷新只换了前半边：新面板发 `?group=1`，旧的 `webcap_flows` 不认识这个参数，返回的还是 `{ok, count, flows}`（没有 `grouped` 字段）。客户端这时已经把渲染切到了 `groups`，而 `groups` 只会由 `grouped: true` 的响应填充，于是一直是空数组——看起来就是「列表空了」，真正的失败原因（宿主代码旧）被这个空列表盖住了。

### 试过哪些办法

先怀疑分组实现本身：`listGroups` 的过滤、key、`items` 都有测试；把一个假 host（`fakeHost`）挂真路由也能出组。差异只在「响应没有 `grouped`」这一种情况——说明问题不在分组算法，而在新旧半边的协议不一致。

### 最后怎么解决

三道防线：① 客户端拿到响应后先 `setFlows(list)`，**只有 `grouped: true` 才用服务端分组**；② 响应没有 `grouped` 而合并是开的，就用 `groupLocal()` 在客户端合并（同一套 volatile 参数表），并在标题旁标「本地合并，只统计当前拉取的 200 条」；③ 渲染条件改成 `mergeOn && groups.length > 0`，空组集不会再把平铺列表挡掉。落点：`client/client.js`。

另加一条可见性：`status` 新增 `build`（版本 + 宿主启动时间）。旧宿主没有这个字段，面板据此在顶部显示「宿主侧还是旧版本」，把「为什么这个功能不完整」从猜测变成提示。落点：`lib/runtime.js`、`client/client.js`。

**通用结论**：插件的前端 bundle 与宿主代码是两个生命周期，页面刷新 ≠ 进程重启。跨这两半的协议要能表达「对面不认识这个参数」，客户端必须有降级路径，而且降级时要说出来。

---

## 5. 失败列表点不动、「清空」清不掉它？

### 出了什么问题

左侧「上游失败」卡片里的条目点了没反应；点「清空」之后请求列表空了，但这张失败卡片还在。

### 当时的情况

失败摘要由代理进程维护（`MitmProxy.recentErrors`，按 方法+路径+code+phase 聚合），面板从 `status.proxy.recentErrors` 读；「清空」只调了 `rt.store.clear()`。

### 为什么会这样

两件事本就是一个根因：失败摘要是**代理状态**，不是 flow 状态。它既没带对应 flow 的 id（所以点不开），也不受 `store.clear()` 影响（所以清不掉）。

### 试过哪些办法

没绕路：给聚合项补上 `flowId`（命中时更新成最新那次），给代理加 `clearErrors()`，`webcap_clear` 在清 ring 的同时清它。

### 最后怎么解决

`_noteError` 写入 / 更新 `flowId`；`MitmProxy.clearErrors()` 同时清 `lastError`；`webcap_clear` 返回 `errorsCleared`。面板侧：条目加 `dshwc-err-click`，点击 `openDetail(flowId)`，对应 flow 已被挤出缓冲时提示重抓。

旧宿主（只有面板是新的）下这两件事都做不到，所以面板再兜一层：点「清空」时记下时间戳，隐藏早于该时间的失败条目（清空之后新发生的失败照常出现）；`webcap_clear` 没返回 `errorsCleared` 时提示「服务端摘要要重启 DSH 才会清」。落点：`client/client.js`。

---

## 6. F12 里有一整列方法名，插件的调用链只有 3 帧？

### 出了什么问题

详情里的「调用链」只有三帧，全是 `(anonymous)` 和 `_ace_b30`，业务方法 chips 永远是空的；F12 的 Initiator 里同一条请求却有几十行，左侧能看到 `fetchFeeds`、`postApiSnsWebV1Homefeed` 这些名字。

### 当时的情况

扩展桥接管小红书的首页标签页，CDP 列表里 `homefeed` 抓得到、头与 POST 体也对。用一条浏览器级 CDP 连接复抓同一条请求、把 `Network.requestWillBeSent` 的 `initiator` 整个落盘，才看清结构：`stack.callFrames` 只有 3 帧，其余 42 帧在 `stack.parent` 串起的 4~6 层里（合计 45 帧 / 7 段 / 22 个函数名）。

### 为什么会这样

两处独立的读取缺陷叠在一起。① `initiator.stack.callFrames` 只是**同步段**，浏览器把「谁调起了这段」放在 `parent` 链里，而插件只读过 `callFrames`。② 噪声名单按 `functionName` 比对，CDP 给匿名函数的是空字符串 `""`，名单里写的却是字面量 `'(anonymous)'`——匿名帧永远不算噪声，`filteredFrames` 只命中 `_ace_*`，于是列表「发起于」与 chips 都被一排无名帧占住。

### 试过哪些办法

先怀疑扩展桥丢数据：从宿主 `/dsh-flowspot/cdp/request` 拉插件自己采的那条，`totalFrames=3`，三帧与浏览器直连抓到的前 3 帧逐字节一致——不是传输丢，是没往下读。又试 `Debugger.setAsyncCallStackDepth`：64 时 45 帧 / 7 段，0 时 41 帧 / 4 段，父栈本身仍在，说明它只决定尾部几层、不是拿到方法名的前提；`Network.setAttachDebugStack` 开与关在这条链路上没测出差异。

### 最后怎么解决

`lib/cdp/initiator.js` 加 `flattenFrames(stack)`：先 `callFrames`，再沿 `stack.parent` 逐层续上（上限 8 层），每帧带 `asyncLevel` / `anonymous`，匿名帧按空名判噪声；`network.js` 与 `index.js` 改读展平帧（一并返回 `totalFrames` / `syncFrames` / `asyncLevels`），列表「发起于」取第一个业务帧，面板按段插 `Continue async` 分隔；受控浏览器路径的 `_attachSession()` 补 `Debugger.setAsyncCallStackDepth(64)` 与扩展桥对齐。`parentId` 形式今天用不到，兜底未实现（见 `docs/architecture.md` 阶段 6 的边界）。

---

## 7. 脚本怎么滚都抓不到首页的 homefeed？

### 出了什么问题

`Page.reload` 之后连发 20 次 `window.scrollBy(0, 2200)`，CDP 里一条 `/api/sns/web/v1/homefeed` 都没有，`window.scrollY` 恒为 0。

### 当时的情况

小红书首页已改成服务端直出首屏（`__INITIAL_STATE__.feed.feeds` 里已有 35 条），滚动容器不是 `window`；`document.documentElement.scrollHeight` 只有 850px，按「`overflow-y` 是 auto/scroll 且可滚距离大于 600」扫全页也挑不出任何滚动容器。

### 为什么会这样

首屏数据来自 HTML，`homefeed` 只在「加载更多」时发，而加载更多由内层虚拟列表的滚动触发。`Runtime.evaluate` 里合成的 `scrollBy` / `WheelEvent` 是 `isTrusted: false` 的脚本事件，这类滚动实现不认，页面根本没动。

### 试过哪些办法

找滚动容器再设 `scrollTop`、往 `document.elementFromPoint` 上派发 `WheelEvent`、`window.scrollTo`——都没动。旧脚本（`Spyder/xhs` 那份）当年能用 `window.scrollBy`，是因为当时首页还是窗口滚动；页面改版了，不是脚本坏了。

### 最后怎么解决

走 CDP 的**可信输入**：`Page.bringToFront` 之后发 `Input.synthesizeScrollGesture {x: 宽/2, y: 高/2, yDistance: -1500, speed: 3000, gestureSourceType: "mouse"}`，一轮就触发了 `homefeed`；`Input.dispatchMouseEvent {type:"mouseWheel"}` 作退路。探针脚本放 `scripts/`（不入库），结论落在这条。

---

## 8. 点调用链的帧，提示「找不到脚本 / js 文件不存在」？

### 出了什么问题

调用链已经能显示 44 帧了，但点任意一帧，弹窗里只有一句「找不到脚本 ext:<tabId>:2199」。

### 当时的情况

扩展桥的接法是 `chrome.debugger.attach` → `Debugger.enable` → 再 `POST /bridge/attach` 让宿主建虚拟会话。`Debugger.enable` 会把当时**已解析**的脚本一次性以 `Debugger.scriptParsed` 推出来，而那条推送发生在宿主还没有 `CdpClient` 的时候，`bridgeEvent()` 里 `if (!this.client) return` 直接丢了。

### 为什么会这样

源码读取被写成了「必须先有脚本索引条目」：`sourceOf()` 先 `scripts.getMeta(key)`，拿不到就抛错；`_sourceOf(meta)` 也依赖 meta 里的 `scriptId` + `sessionId`。但 `Debugger.getScriptSource` 只认 `scriptId`，而调用链的每一帧本来就带着 `scriptId`（`scriptKey` 就是 `<sessionId>:<scriptId>`）——索引只是缓存和 URL 的来源，不该是前置条件。

### 试过哪些办法

想过在 attach 之后再补一次 `Debugger.enable` 重放事件，但那是扩展侧的时序问题，补了也只在扩展路径成立；受控浏览器路径、DSH 重启后的重连都各有各的时序。另一个方向是把 `scriptParsed` 缓存起来等 client 就绪再灌进去，改动面更大且只修一条路径。第三版先做成「点一帧、没缓存就 `getScriptSource` 一次」——能用，但被指出方向不对：抓包工具不该在**查看时**才去调试通道要源码，否则断开、重启、脚本卸载之后都看不了，几 MB 的包还会每次翻页重读。

### 最后怎么解决

把源码变成**抓取时落盘**：`Debugger.scriptParsed` 只给元数据（scriptId/URL/行列范围），JS 正文浏览器从不主动推；所以在 `Network.requestWillBeSent` 收到带调用栈的条目时，`_queueSourcePersist()` 把栈里涉及的每个 `scriptId` 各取一次 `Debugger.getScriptSource`（读渲染进程里 V8 已保留的脚本对象，**不是重新下载**——不产生新 HTTP 请求、不打 CDN），写到 `<dataDir>/scripts/` 并在 `index.json` 记 URL/字符数/时间；单脚本 4MB、总量 256MB，超限写进 `reasons` 而不是悄悄丢。`sourceOf()` 之后只读磁盘，`Debugger.getScriptSource` 全仓只剩 `_readSourceText()` 一处调用；`webcap_script get/search` 与 `withSource` 片段同样读落盘那份，「清空 CDP」连磁盘一起清。压缩过的 bundle 整份只有一行，按行取窗口等于把 MB 级内容丢给面板，所以查看器按目标行长度切模式——超过 `MINIFIED_LINE_CHARS` 用 `columnWindow` 按列切，再用 `format.js` 展开成带缩进的多行并标出调用点（等价于 F12 的 `{}`，只作用于这一段；面板不提供「整份源码」），否则 `lineWindow` 给行上下文。落点：`lib/cdp/index.js`、`lib/cdp/scripts.js`、`lib/cdp/format.js`、`lib/cdp/sourceStore.js`、`lib/routes.js`、`client/client.js`（ADR-0022）。

> 后续踩坑见下一条：落盘刚上线时大脚本一直报「CDP 命令超时」，根因在扩展桥的请求体上限。

---

## 9. 落盘大脚本时报「CDP 命令超时：Debugger.getScriptSource」？

### 出了什么问题

源码落盘上线后，小红书的 `index.a9f61821.js`（1.6MB）和大包一律失败，落盘记录里写着「抓取时没读到这个脚本：CDP 命令超时：Debugger.getScriptSource」；同一条调用链里的小脚本（几十 KB）却能存下来。

更糟的是优先级倒挂——落盘成功的恰好是不需要的那些：

```none
落成功  396KB  as/v2/fp/c4a1….js          风控指纹脚本，跟业务接口无关
落成功  361KB  async/9760.adcdb880.js     签名/风控 chunk
落成功  288KB  （url 为空）                内联脚本
落成功  212KB  library-polyfill.26cdc0cc.js
落失败  ≥1.0MB vendor-dynamic.6e584070.js  ★ 接口定义层
落失败  ≥1.6MB index.a9f61821.js           ★ 业务代码
```

### 当时的情况

```none
body=  800,042 B  status=200  {"ok":true}
body=1,200,042 B  status=0    连接被断开
body=3,000,042 B  status=0    连接被断开
```

宿主侧 `readBody()` 对所有 JSON 接口都按 **1MB** 掐断，而 `Debugger.getScriptSource` 的回包就是整份脚本，经 `/bridge/result` 原样 POST 回来。扩展那边 `postResult()` 拿到失败后**什么都没做**（`callHost` 把异常吞成 `{ok:false}`，返回值没人看），于是宿主侧 `CdpClient.send()` 一直等不到那个 id 的回包，15 秒后抛「CDP 命令超时」。

### 为什么会这样

三处默认值各自都合理，叠在一起就成死局：面板接口的 1MB 上限（防滥用）、CDP 命令 15 秒超时（防卡死）、扩展回包失败静默（当时认为 fetch 失败已在 `callHost` 里兜住了）。真正的问题是**没有人把「大回包」当成一条独立的传输路径来对待**：它既不是面板请求，也不该按普通命令的时限。

### 试过哪些办法

先量了一遍上限（上面的三条请求），确认不是浏览器、不是 `chrome.debugger` 大小限制；再看扩展日志——`sendCommand` 早就回来了，卡的是回传。也想过让扩展直接写文件，但 MV3 service worker 没有这个能力；想过按行/按字符分段取源码，CDP 没有分段接口。

### 最后怎么解决

按「大回包」单独定参数：`readBody(req, {limit})` 默认 1MB，`/bridge/result` 用 `MAX_BRIDGE_RESULT_BYTES = 12MB`（4MB 脚本 + JSON 转义留够余量）；超限改成**回 413 再断开**，不再直接 `req.destroy()`，让扩展能读到明确的失败；扩展 `postResult()` 失败时先原样重试一次，再退化发一条只有 `error` 的小回包，宿主立刻按真实原因失败而不是等超时；`getScriptSource` 走 `send(..., {timeoutMs: 60000})`，其余命令仍是 15 秒。同时把「为谁落盘」收紧成业务接口（`sourceFilter.js`：XHR/Fetch + 非埋点/APM/风控探针，内联脚本跳过），不再给 `as/v2/fp`、内联与埋点请求各存一份。回归用例：`test/routes.test.mjs` 里往 `/bridge/result` 打 5MB 回包必须 200；`test/cdp.test.mjs` 里业务接口判定有正反两组样例。落点：`lib/routes.js`、`lib/cdp/client.js`、`lib/cdp/index.js`、`lib/cdp/sourceFilter.js`、`extension/background.js`。
## 10. 桌面端能用系统抓包，CDP 却报「扩展没有响应」

**症状**：DSH Desktop（Electron）里，装插件、系统抓包都正常；点「连接浏览器」只回一句
`扩展没有响应：确认扩展已加载，且 Chrome 没有把它停用`。同一个扩展在 web 版（`dsh plugin … web`）下一切正常。

**怎么查**：先分清「扩展没跑」和「扩展连错了地方」——
- 扩展装上后，background 的默认地址是 `http://127.0.0.1:3080`；
- 桌面端宿主的真实端口是随机的（实测 `127.0.0.1:19387`），且能用 `Invoke-WebRequest /dsh-flowspot/status` 匿名访问；
- `hostBase` 只有一个来源：内容脚本 `hello` 消息里的 `location.origin`；而内容脚本的注入条件是页面 URL 匹配 `http://127.0.0.1/*`。

**根因**：桌面端渲染进程的参数里有 `--standard-schemes=dsh-app --secure-schemes=dsh-app`，界面跑在 `dsh-app://` 下。浏览器的内容脚本不会在 Electron 里运行，也不会匹配自定义协议——所以 `hello` 永远不来，扩展一直对着 3080（往往是另一个 web 实例）轮询，桌面端这边自然一个轮询都收不到。

**修法**（0.6.8）：把地址交接做成一条显式路径，而不是依赖「碰巧有个 DSH 页面在浏览器里」——
1. `status.bridge.base` 由宿主 `webServer.host/port` 算出（面板在 `dsh-app://` 里拿不到真实 origin）；
2. 新增 `GET /bridge/hello`：返回一页 HTML，被浏览器打开时内容脚本照常认领、把 origin 报给 background；
3. 新增 `POST /bridge/open-hello`：宿主用 `findBrowser()` 在 Chrome 里打开那一页（面板按钮触发）；
4. 扩展把地址写进 `chrome.storage.local`，SW 启动时先读回——否则 MV3 一休眠又退回 3080。

**教训**：「扩展没响应」在跨宿主形态下先问「它连的是谁」，而不是「它是不是被停用了」。默认端口这种隐式约定，在桌面端（自定义协议、随机端口）一定失效。
