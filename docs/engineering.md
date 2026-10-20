# 工程踩坑

本仓业务流程里真实踩过的问题。一条一个事件。通用 skill 已规定的写法不在这里再记。

- [加了右侧栏入口之后，DSH 整个界面打不开？](#1-加了右侧栏入口之后dsh-整个界面打不开)
- [点「选择数据目录」只报「操作失败」，为什么？](#2-点选择数据目录只报操作失败为什么)
- [从整页切右侧栏报「没有会话」，右栏一开就盖住整窗？](#3-从整页切右侧栏报没有会话右栏一开就盖住整窗)
- [点「接口合并」之后请求列表变空？](#4-点接口合并之后请求列表变空)

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

