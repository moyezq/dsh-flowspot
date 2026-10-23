/**
 * Flowspot Bridge：接管当前标签页，把 chrome.debugger 的事件与命令转发给本机 DSH。
 *
 * HTTP 由 background 直接发（host_permissions 覆盖 127.0.0.1），不依赖 DSH 页面里
 * 的内容脚本；内容脚本只负责告诉这里 DSH 的 origin 并定时唤醒 service worker。
 * 这样即使面板没刷新、内容脚本没注入，扩展也能被宿主命令驱动（列标签页/接管/断开）。
 */

const DEFAULT_HOST = 'http://127.0.0.1:3080'

let hostBase = DEFAULT_HOST
let attached = null
let lastWebTab = null
let polling = false
let eventQueue = []
let eventTimer = null
/** 暂停时不转发事件，但调试器保持附着，切回来无需重新 attach。 */
let paused = false
/** 切换标签页时主动 detach 旧页，别把 onDetach 当成用户断开。 */
let switching = false
/** SW 重启后从 storage 恢复接管信息；事件处理不依赖它，但命令需要 tabId。 */
const ready = restoreAttached()

async function restoreAttached() {
  try {
    const saved = await chrome.storage.session.get(['attached', 'paused'])
    if (saved && saved.attached) attached = saved.attached
    paused = Boolean(saved && saved.paused)
  } catch {
    /* storage.session 不可用（很老的 Chrome）时退化为内存 */
  }
  try {
    const targets = await chrome.debugger.getTargets()
    const live = targets.find((target) => target.attached && target.tabId != null)
    if (live) {
      attached = attached || { tabId: live.tabId, title: live.title || '', url: live.url || '' }
    } else if (attached) {
      attached = null
    }
  } catch {
    /* 没有 debugger 权限/无目标 */
  }
}

async function saveAttached() {
  try {
    if (attached) await chrome.storage.session.set({ attached, paused })
    else await chrome.storage.session.set({ paused })
  } catch {
    /* 退化为内存 */
  }
}

async function currentTabId() {
  await ready
  if (attached) return attached.tabId
  try {
    const targets = await chrome.debugger.getTargets()
    const live = targets.find((target) => target.attached && target.tabId != null)
    return live ? live.tabId : null
  } catch {
    return null
  }
}

/**
 * 只排除 DSH 面板自己（127.0.0.1/localhost 且端口与宿主一致）。
 * 不能把所有 localhost 都排除：很多目标页面就是本地开发服务。
 */
function isPanelUrl(url) {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    const base = new URL(hostBase)
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    return loopback && parsed.port === base.port
  } catch {
    return false
  }
}

function status() {
  return {
    attached: Boolean(attached),
    paused,
    tab: attached ? { id: attached.tabId, title: attached.title, url: attached.url } : null,
    host: hostBase,
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function callHost(path, body) {
  try {
    const response = await fetch(hostBase + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-flowspot-bridge': '1' },
      body: JSON.stringify(body || {}),
    })
    return await response.json()
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/**
 * 回包失败时不能让宿主干等到命令超时：先原样重试一次，再退化成一条只有错误信息的
 * 小回包，宿主就能立刻失败并说清原因（大脚本以前会被对方的请求体上限掐断，
 * 表现成「CDP 命令超时：Debugger.getScriptSource」）。
 */
async function postResult(id, payload) {
  const first = await callHost('/dsh-flowspot/bridge/result', { id, ...payload })
  if (first && first.ok !== false) return first
  const reason = (first && first.error) || '回包失败'
  // 只在可能超限时才提「回包过大」：用字符数判断，别把整份源码再 stringify 一遍。
  const size = payload && payload.result && typeof payload.result.scriptSource === 'string' ? payload.result.scriptSource.length : 0
  const hint = size > 512 * 1024 ? `${reason}（回包过大，宿主可能拒收）` : reason
  await callHost('/dsh-flowspot/bridge/result', { id, error: hint })
  return { ok: false, error: hint }
}

function flushEvents() {
  eventTimer = null
  const events = eventQueue
  eventQueue = []
  if (!events.length) return
  callHost('/dsh-flowspot/bridge/events', { events }).then((result) => {
    // 整批被拒（太大/宿主重启）时别静默丢：至少留一条可查的痕迹。
    if (result && result.ok === false) console.warn('[flowspot] 事件批次被宿主拒收：', result.error, `count=${events.length}`)
  })
}

function queueEvent(event) {
  eventQueue.push(event)
  if (eventQueue.length >= 50) {
    if (eventTimer) clearTimeout(eventTimer)
    flushEvents()
    return
  }
  if (!eventTimer) eventTimer = setTimeout(flushEvents, 200)
}

async function tabInfo(tabId) {
  const tab = await chrome.tabs.get(tabId)
  return { tabId, title: tab.title || '', url: tab.url || '' }
}

async function attach(tabId) {
  await ready
  if (attached && attached.tabId === tabId) return status()
  const previous = attached
  // 先接上新标签页，再断旧的：中间没有“空窗”，onDetach 看到 source 不是当前
  // attached 会直接忽略，宿主不会收到一次假的 /bridge/detach。
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
  } catch (err) {
    // 某些 Chrome 版本不允许同时挂两个标签页：退化为先断旧页，期间屏蔽 onDetach。
    if (!previous) throw err
    switching = true
    try {
      await chrome.debugger.detach({ tabId: previous.tabId })
    } catch {
      /* 旧页已经关了 */
    }
    switching = false
    await chrome.debugger.attach({ tabId }, '1.3')
  }
  await chrome.debugger.sendCommand({ tabId }, 'Debugger.enable')
  // 没有异步栈时 fetch/XHR 的 initiator 通常只剩一层包装函数，调用链看起来
  // “只有文档请求有”。这些命令能开就开，旧 Chrome 不支持就逐条忽略。
  for (const [method, params] of [
    ['Debugger.setAsyncCallStackDepth', { maxDepth: 64 }],
    ['Network.setAttachDebugStack', { enabled: true }],
    ['Runtime.enable', {}],
  ]) {
    try {
      await chrome.debugger.sendCommand({ tabId }, method, params)
    } catch {
      /* 实验命令，不支持不影响主路径 */
    }
  }
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxPostDataSize: 65536 })
  attached = await tabInfo(tabId)
  paused = false
  await saveAttached()
  if (previous && previous.tabId !== tabId) {
    try {
      await chrome.debugger.detach({ tabId: previous.tabId })
    } catch {
      /* 旧标签页已经关了 */
    }
  }
  // 宿主据此建虚拟会话，之后事件才有地方落。
  await callHost('/dsh-flowspot/bridge/attach', {
    tabId: attached.tabId,
    title: attached.title,
    url: attached.url,
    paused,
  })
  return status()
}

async function detach() {
  await ready
  const tabId = attached ? attached.tabId : await currentTabId()
  attached = null
  paused = false
  await saveAttached()
  if (tabId != null) {
    try {
      await chrome.debugger.detach({ tabId })
    } catch {
      /* 标签页已经关了 */
    }
  }
  await callHost('/dsh-flowspot/bridge/detach', {})
  return status()
}

async function handleCommand(command) {
  if (!command || typeof command !== 'object') return
  try {
    if (command.action === 'tabs') {
      const tabs = await chrome.tabs.query({})
      const list = tabs
        .filter((tab) => tab.id != null && tab.url && !isPanelUrl(tab.url))
        .map((tab) => ({ id: tab.id, title: tab.title || '', url: tab.url, active: Boolean(tab.active), windowId: tab.windowId }))
      await postResult(command.id, { result: { tabs: list } })
      return
    }
    if (command.action === 'attach-last') {
      let tabId = lastWebTab
      if (!tabId) {
        // SW 重启后 lastWebTab 丢了：退化为当前窗口里第一个非 DSH 页面。
        const tabs = await chrome.tabs.query({})
        const candidate = tabs.find((tab) => tab.id != null && tab.url && !isPanelUrl(tab.url))
        tabId = candidate ? candidate.id : null
      }
      if (!tabId) throw new Error('没有可接管的网页标签页：先打开目标页面，或在目标页点扩展图标')
      await attach(tabId)
      await postResult(command.id, { result: { status: status() } })
      return
    }
    if (command.action === 'attach-tab') {
      await attach(Number(command.tabId))
      await postResult(command.id, { result: { status: status() } })
      return
    }
    if (command.action === 'pause' || command.action === 'resume') {
      paused = command.action === 'pause'
      await saveAttached()
      await postResult(command.id, { result: { status: status() } })
      return
    }
    if (command.action === 'detach') {
      await detach()
      await postResult(command.id, { result: { status: status() } })
      return
    }
    // 其余当成 CDP 命令（Network.enable / Debugger.getScriptSource / searchInContent…）。
    const tabId = await currentTabId()
    if (tabId == null) throw new Error('还没有接管标签页：先选择标签页或让 Agent 接管')
    const result = await chrome.debugger.sendCommand({ tabId }, command.method, command.params || {})
    await postResult(command.id, { result })
  } catch (err) {
    await postResult(command.id, { error: String((err && err.message) || err) })
  }
}

/** 每次换宿主都 +1：正在长轮询的那一轮醒来发现代次不对就退出，立刻改连新地址。 */
let pollSeq = 0
/** 连续失败次数：连着失败就顺手去标签页里找一遍宿主，别一直对着错端口。 */
let pollFails = 0

async function pollLoop() {
  if (polling) return
  polling = true
  const mine = ++pollSeq
  while (polling && mine === pollSeq) {
    try {
      const response = await fetch(`${hostBase}/dsh-flowspot/bridge/poll?wait=20000`, {
        headers: { 'x-flowspot-bridge': '1' },
      })
      if (!response.ok) throw new Error(`poll ${response.status}`)
      pollFails = 0
      const body = await response.json()
      if (body && body.command) await handleCommand(body.command)
    } catch {
      pollFails += 1
      // 连不上就试一次「从已打开的标签页里认宿主」：桌面端没有内容脚本，这一条是
      // 唯一不靠用户手打地址的自动路径。
      if (pollFails >= 2) await discoverHostFromTabs()
      await sleep(2000)
    }
  }
}

function startPolling() {
  pollLoop()
}

/** 换宿主时打断当前这一轮长轮询（它最多还要等 20 秒，不能干等）。 */
function restartPolling() {
  pollSeq += 1
  polling = false
  pollLoop()
}

/**
 * 从已打开的标签页里认宿主。
 *
 * 桌面端的界面在 `dsh-app://` 里，内容脚本没有落脚处，`hello` 永远不会来——
 * 但用户在 Chrome 里打开过「连接页」（或任何 127.0.0.1 的页面）时，那个标签页的
 * origin 就是宿主地址。逐个探 `/dsh-flowspot/status`，谁应答就是谁。
 * @returns {Promise<boolean>} 找到了没有
 */
async function discoverHostFromTabs() {
  try {
    const tabs = await chrome.tabs.query({})
    const origins = []
    for (const tab of tabs) {
      const url = String((tab && tab.url) || '')
      const match = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\//.exec(url)
      if (!match) continue
      const origin = `http://${match[1]}:${match[2]}`
      if (!origins.includes(origin)) origins.push(origin)
    }
    for (const origin of origins) {
      if (origin === hostBase) continue
      try {
        const response = await fetch(`${origin}/dsh-flowspot/status`, {
          headers: { 'x-flowspot-bridge': '1' },
          signal: AbortSignal.timeout(1500),
        })
        if (!response.ok) continue
        const body = await response.json()
        if (!body || body.ok !== true) continue
        rememberHost(origin)
        return true
      } catch {
        /* 这个标签页不是宿主，试下一个 */
      }
    }
  } catch {
    /* tabs 查不到（权限/窗口受限）就保持原样 */
  }
  return false
}

/**
 * 记住宿主地址。
 *
 * 桌面端的界面在 `dsh-app://` 里，内容脚本跑不了，扩展只能靠用户点面板里那一次
 * 「在 Chrome 中打开」把地址带进来；写进 `storage.local` 之后，SW 重启、浏览器重启
 * 都还能接着连，不用每次重来。
 */
function rememberHost(base) {
  if (!base || base === hostBase) return
  hostBase = base
  try {
    chrome.storage.local.set({ hostBase: base })
  } catch {
    /* 老 Chrome 或存储被禁用：内存里这份还能用 */
  }
  restartPolling()
}

function armAlarm() {
  // MV3 service worker 会休眠；每 30 秒拉起来一次，最长等一轮就能接命令。
  chrome.alarms.create('flowspot-poll', { periodInMinutes: 0.5 })
}

/** 把内容脚本补注入已打开的 DSH 页面（安装/启动/点图标时），不必刷新页面。 */
async function ensureContentScripts() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://127.0.0.1/*', 'http://localhost/*'] })
    for (const tab of tabs) {
      if (tab.id == null) continue
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
      } catch {
        /* chrome:// 或受限页面，跳过 */
      }
    }
  } catch {
    /* scripting 不可用也不影响 background 直接跑 */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  armAlarm()
  discoverHostFromTabs().finally(() => startPolling())
  ensureContentScripts()
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0]
    if (tab && tab.id != null && !isPanelUrl(tab.url)) lastWebTab = tab.id
  })
})

chrome.runtime.onStartup.addListener(() => {
  armAlarm()
  discoverHostFromTabs().finally(() => startPolling())
  ensureContentScripts()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'flowspot-poll') {
    startPolling()
    ensureContentScripts()
  }
})

chrome.action.onClicked.addListener(async (tab) => {
  await ready
  // 桌面端（dsh-app://）没有内容脚本，点图标是用户能给出的最直接信号：
  // 先看当前标签页是不是宿主（用户刚从面板点开「连接页」时就是），再接管。
  const adopted = await discoverHostFromTabs()
  if (!adopted) startPolling()
  ensureContentScripts()
  // 刚认下新宿主时这一下只是「把地址交给扩展」，别把连接页当成要接管的页面。
  if (adopted || !tab || tab.id == null) return
  try {
    if (attached && attached.tabId === tab.id) await detach()
    else await attach(tab.id)
  } catch (err) {
    await callHost('/dsh-flowspot/bridge/result', { id: 'ui-error', error: String((err && err.message) || err) })
  }
})

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!isPanelUrl(tab.url)) lastWebTab = tabId
  } catch {
    /* 标签页刚关掉 */
  }
})

chrome.tabs.onUpdated.addListener((tabId, _info, tab) => {
  if (tab && tab.url && !isPanelUrl(tab.url)) lastWebTab = tabId
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (attached && attached.tabId === tabId) {
    attached = null
    saveAttached()
    callHost('/dsh-flowspot/bridge/detach', {})
  }
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  // 不依赖内存里的 attached：MV3 worker 重启后它可能是 null，但调试器还附着在
  // 标签页上；source.tabId 就是当前被调试的页面。
  if (source.tabId == null) return
  if (paused) return
  if (!method.startsWith('Network.') && !method.startsWith('Debugger.')) return
  queueEvent({ method, params })
})

chrome.debugger.onDetach.addListener(async (source) => {
  if (switching) return
  if (attached && source.tabId != null && source.tabId !== attached.tabId) return
  attached = null
  await saveAttached()
  await callHost('/dsh-flowspot/bridge/detach', {})
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.kind === 'hello') {
    const origin = String(message.origin || '')
    if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) rememberHost(origin)
    startPolling()
    sendResponse({ ok: true, status: status(), version: chrome.runtime.getManifest().version, hostBase })
    return true
  }
  if (message && message.kind === 'set-host') {
    // 没有内容脚本的场合（DSH Desktop 的界面在 dsh-app:// 里）用它手动指定宿主。
    const origin = String(message.base || '')
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      sendResponse({ ok: false, error: '地址要形如 http://127.0.0.1:<端口>' })
      return true
    }
    rememberHost(origin)
    startPolling()
    sendResponse({ ok: true, hostBase })
    return true
  }
  if (message && message.kind === 'bridge-command') {
    // 内容脚本在 DSH 页面里替宿主长轮询；它把命令送进来，顺便把 SW 唤醒。
    handleCommand(message.command)
    sendResponse({ ok: true, accepted: true })
    return true
  }
  sendResponse({ ok: false, error: 'unknown message' })
  return true
})

/**
 * 网页（宿主的「连接页」）直接给扩展发消息指定宿主地址。
 *
 * manifest 里带了固定 `key`（ID 不再取决于加载路径）+ `externally_connectable`，
 * 所以宿主那一页可以自己 `chrome.runtime.sendMessage(<id>, {kind:'set-host'})`。
 * 这条路径不依赖内容脚本——桌面端（dsh-app://）里内容脚本没有落脚处，只能靠它。
 *
 * 只认 `sender.origin`：页面说自己是哪个端口就是哪个，不接受它替别人指定地址。
 */
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || message.kind !== 'set-host') {
    sendResponse({ ok: false, error: 'unknown message' })
    return true
  }
  const senderUrl = String((sender && (sender.origin || sender.url)) || '')
  const match = /^(http:\/\/(?:127\.0\.0\.1|localhost):\d+)/.exec(senderUrl)
  if (!match) {
    sendResponse({ ok: false, error: '来源不是本机页面' })
    return true
  }
  rememberHost(match[1])
  startPolling()
  sendResponse({ ok: true, hostBase, version: chrome.runtime.getManifest().version })
  return true
})

// SW 每次被唤醒都重新开始轮询；ready 里恢复 attached，避免命令拿到空 tabId。
ready.then(async () => {
  // 先恢复上次记住的宿主地址：桌面端没有内容脚本，这里不读会把地址打回默认端口。
  try {
    const saved = await chrome.storage.local.get(['hostBase'])
    const savedBase = String((saved && saved.hostBase) || '')
    if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(savedBase)) hostBase = savedBase
  } catch {
    /* 读不到就用默认值 */
  }
  // SW 或 DSH 重启后，调试器可能还附着；把会话重新告诉宿主，别等用户再点一次。
  if (attached) {
    await callHost('/dsh-flowspot/bridge/attach', {
      tabId: attached.tabId,
      title: attached.title,
      url: attached.url,
      paused,
    }).catch(() => {})
  }
  startPolling()
})
