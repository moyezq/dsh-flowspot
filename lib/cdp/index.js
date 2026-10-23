/**
 * dsh-flowspot: the long-lived CDP channel and everything the agent reads from it.
 *
 * One browser-level WebSocket carries flattened sessions for every page and
 * worker. The channel owns:
 *  - authorization state (pointer file, silent reconnect, one click after the
 *    browser itself is closed),
 *  - a bounded network-request index used to pair a proxied flow with the
 *    browser-side call that produced it,
 *  - the script index and source snippets behind a call chain,
 *  - parameter analysis (query/body values, static vs dynamic across calls).
 *
 * It never captures traffic itself: the proxy remains the source of flows, CDP
 * only explains where a flow came from.
 */

import { CdpClient, connectCdp } from './client.js'
import {
  cdpPointerFile,
  cdpProfileDir,
  clearCdpPointer,
  findBrowser,
  killTree,
  launchBrowser,
  processAlive,
  probeVersion,
  readCdpPointer,
  writeCdpPointer,
} from './launch.js'
import { CdpNetworkIndex } from './network.js'
import { flattenFrames, isNoiseFrame } from './initiator.js'
import { MINIFIED_LINE_CHARS, ScriptIndex, charOffsetOf, columnWindow, lineAt, lineWindow, occurrencesOf } from './scripts.js'
import { formatFragment } from './format.js'
import { SourceStore } from './sourceStore.js'
import { isBusinessRequest } from './sourceFilter.js'
import { analyseParams } from './params.js'
import { normalizeUrl } from '../flows.js'

const MAX_RECONNECT_DELAY = 30000

export class CdpChannel {
  /**
   * @param {{log?: object, getProxyPort?: Function, getBrowserPath?: Function, getDataDir?: Function}} [options]
   *   `getDataDir` 给源码落盘用（每次取，面板换数据目录后跟着走）。
   */
  constructor({ log = console, getProxyPort = () => null, getBrowserPath = () => '', getDataDir = () => '' } = {}) {
    this.log = log
    this.getProxyPort = getProxyPort
    this.getBrowserPath = getBrowserPath
    this.client = null
    this.sessions = new Map()
    this.targets = new Map()
    this.network = new CdpNetworkIndex()
    this.scripts = new ScriptIndex()
    // 源码正文只存磁盘这一份：抓取时按调用链涉及的脚本各取一次，预览/定位全读它。
    this.sources = new SourceStore({ resolveDir: getDataDir, log })
    /** 每个脚本试过几次（key 是 `<sessionId>:<scriptId>`）：失败允许再试一次，别一次失败就永久放弃。 */
    this.sourceAttempts = new Map()
    /** 取源码是串行队列：一次一条，别和正常请求抢通道。 */
    this.sourceQueue = Promise.resolve()
    this.pointer = readCdpPointer()
    this.enabled = Boolean(this.pointer && this.pointer.enabled)
    this.connecting = false
    this.connected = false
    this.browser = null
    this.port = this.pointer ? this.pointer.port : null
    this.pid = this.pointer ? this.pointer.pid : null
    this.external = this.pointer ? this.pointer.external : false
    this.profileDir = this.pointer && this.pointer.profileDir ? this.pointer.profileDir : cdpProfileDir()
    this.reconnectCount = 0
    this.lastError = null
    this.retryTimer = null
    this.retryAt = 0
    this.disposed = false
    /** 扩展桥：当前接管的标签页、待发命令与等待者。 */
    this.bridge = null
    this.bridgePaused = false
    this.bridgeSessionId = null
    this.bridgeCommands = []
    this.bridgeWaiters = []
    this.bridgeActionSeq = 0
    this.bridgeActionWaiters = new Map()
    this.extensionSeenAt = 0
  }

  /** Snapshot for `/status` and `webcap_status`; never touches the network. */
  status() {
    return {
      enabled: this.enabled,
      connected: this.connected,
      connecting: this.connecting,
      browser: this.browser,
      port: this.port,
      pid: this.pid,
      external: this.external,
      profileDir: this.profileDir,
      bridge: this.bridge,
      bridgePaused: this.bridgePaused,
      extension: {
        seenAt: this.extensionSeenAt || null,
        connected: Boolean(this.extensionSeenAt && Date.now() - this.extensionSeenAt < 45000),
      },
      pointerFile: cdpPointerFile(),
      targets: [...this.sessions.values()].map((session) => ({
        targetId: session.targetId,
        type: session.type,
        title: session.title,
        url: session.url,
      })),
      requests: this.network.size,
      scripts: this.scripts.size,
      sources: { scripts: this.sources.size, chars: this.sources.totalChars },
      reconnectCount: this.reconnectCount,
      lastError: this.lastError,
    }
  }

  /**
   * Silent reconnect when a pointer from a previous session exists. Called on a
   * status poll: the first poll after a DSH restart brings the channel back
   * without a prompt; a dead browser only produces a status line until the
   * operator clicks once.
   */
  async ensure() {
    if (this.disposed || !this.enabled || this.connected || this.connecting) return
    const pointer = this.pointer
    if (!pointer || !pointer.port) return
    if (Date.now() < this.retryAt) return
    if (!pointer.external && pointer.pid && !processAlive(pointer.pid)) {
      if (!String(this.lastError || '').includes('受控浏览器已关闭')) {
        this.log.event?.('warn', 'cdp-browser-closed', { pid: pointer.pid, port: pointer.port })
      }
      this.lastError = '受控浏览器已关闭，点「连接浏览器」重开'
      return
    }
    this.connecting = true
    try {
      await this._connectToPort(pointer.port)
      this.log.event?.('info', 'cdp-reconnect', { port: pointer.port })
    } catch (err) {
      this.lastError = err.message
      this.log.event?.('warn', 'cdp-reconnect-failed', {
        port: this.pointer ? this.pointer.port : null,
        error: err.message,
        attempt: this.reconnectCount + 1,
        pid: this.pointer ? this.pointer.pid : null,
      })
      this._scheduleReconnect()
    } finally {
      this.connecting = false
    }
  }

  /**
   * Launch the controlled browser (or reuse the one from the pointer).
   *
   * Capture must be running: the browser is started with `--proxy-server`
   * pointing at this plugin, which is what keeps flows and call chains in the
   * same browser.
   * @returns {Promise<object>} channel status
   */
  async launch() {
    if (this.connected) return this.status()
    if (this.connecting) throw new Error('CDP 正在连接，稍后再看状态')
    const proxyPort = this.getProxyPort()
    if (!proxyPort) throw new Error('先开始抓包：受控浏览器必须通过本插件代理，调用链才能和抓包记录对上')

    // A browser started by a previous run can be reused without a prompt, but
    // only if it still points at the proxy port capture is using now: the
    // --proxy-server flag cannot be changed on a running browser.
    if (this.pointer && this.pointer.port) {
      const pointer = this.pointer
      const staleProxy = !pointer.external && pointer.proxyPort && Number(pointer.proxyPort) !== Number(proxyPort)
      if (staleProxy) {
        if (pointer.pid) killTree(pointer.pid)
        this.pointer = null
        clearCdpPointer()
        this.pid = null
        this.port = null
      } else {
        try {
          await this._connectToPort(pointer.port)
          this.enabled = true
          this.pointer = { ...pointer, enabled: true }
          writeCdpPointer(this.pointer)
          return this.status()
        } catch {
          /* fall through to a fresh launch */
        }
      }
    }

    const exe = findBrowser(this.getBrowserPath())
    if (!exe) {
      this.log.event?.('warn', 'cdp-launch-failed', { error: 'no-browser', browserPath: this.getBrowserPath() || null })
      throw new Error('没有找到 Chrome / Edge；用配置 cdpBrowserPath 指定 chrome.exe 的完整路径')
    }

    const profileDir = cdpProfileDir()
    let launched
    try {
      launched = await launchBrowser({ exe, profileDir, proxyPort, log: this.log })
    } catch (err) {
      this.log.event?.('warn', 'cdp-launch-failed', {
        error: err.message,
        browserPath: exe.path,
        profileDir,
        proxyPort,
      })
      throw err
    }
    this.pointer = {
      enabled: true,
      port: launched.port,
      pid: launched.pid,
      external: false,
      browserPath: exe.path,
      profileDir,
      proxyPort,
      startedAt: new Date().toISOString(),
    }
    this.pid = launched.pid
    this.port = launched.port
    this.external = false
    this.profileDir = profileDir
    this.enabled = true
    writeCdpPointer(this.pointer)
    try {
      await this._connectToPort(launched.port, launched.version)
    } catch (err) {
      this.lastError = err.message
      this.log.event?.('warn', 'cdp-launch-failed', { stage: 'connect', port: launched.port, error: err.message })
      throw err
    }
    this.log.event?.('info', 'cdp-launch', {
      port: launched.port,
      pid: launched.pid,
      browser: (launched.version && launched.version.Browser) || '',
      profileDir,
      proxyPort,
      reused: Boolean(launched.reused),
    })
    return this.status()
  }

  /**
   * Attach to an already-running debugging endpoint (a browser the operator
   * started with their own flags).
   * @param {{port: number}} options
   */
  async attach({ port } = {}) {
    const value = Number(port)
    if (!Number.isInteger(value) || value <= 0) throw new Error('缺少可用的调试端口')
    if (this.connected) return this.status()
    await this._connectToPort(value)
    this.enabled = true
    this.external = true
    this.pid = null
    this.profileDir = ''
    this.pointer = {
      enabled: true,
      port: value,
      pid: null,
      external: true,
      browserPath: '',
      profileDir: '',
      startedAt: new Date().toISOString(),
    }
    writeCdpPointer(this.pointer)
    this.log.event?.('info', 'cdp-attach', { port: value })
    return this.status()
  }

  /**
   * 接管扩展桥送来的标签页：用一条虚拟 CDP 传输代替 WebSocket。
   * 扩展已经 enable 过 Network/Debugger，这里的 enable 会再发一次（幂等）。
   */
  async attachExtension({ tabId, title = '', url = '', paused = false } = {}) {
    const id = Number(tabId)
    if (!Number.isInteger(id) || id <= 0) throw new Error('缺少标签页 id')
    // 抓到的请求与已读源码是「历史」：重连、换标签页都不清，清空只由「清空」按钮负责。
    if (this.connected || this.bridge) this._resetBridgeState({ preserveData: true })
    this.sessions.clear()
    this.targets.clear()
    const sessionId = `ext:${id}`
    let client
    const transport = {
      send: (text) => {
        let message
        try {
          message = JSON.parse(text)
        } catch {
          return
        }
        if (String(message.method || '').startsWith('Target.')) {
          if (this.client === client) client.receive({ id: message.id, result: {} })
          return
        }
        this.bridgeCommands.push({ id: message.id, method: message.method, params: message.params || {} })
        this._flushBridgeWaiters()
      },
      close: () => {},
      onMessage: () => {},
      onClose: () => {},
    }
    client = new CdpClient(transport, {
      log: this.log,
      onEvent: (message) => this._onEvent({ ...message, sessionId }),
      onClose: () => {
        if (this.client === client) this._onClose('bridge-closed')
      },
    })
    this.client = client
    this.connected = true
    this.enabled = true
    this.external = true
    this.bridge = { tabId: id, title, url }
    this.bridgePaused = Boolean(paused)
    this.bridgeSessionId = sessionId
    this.browser = { name: 'Chrome（Flowspot Bridge）', protocolVersion: '' }
    this.port = null
    this.lastError = null
    this._attachSession({
      sessionId,
      targetInfo: { targetId: sessionId, type: 'page', title, url },
      waitingForDebugger: false,
    })
    this.log.event?.('info', 'bridge-attach', { tabId: id, title })
    return this.status()
  }

  /** 扩展送来的 CDP 事件（扩展侧已过滤到 Network/Debugger）。 */
  bridgeEvent(event) {
    if (!this.client || !event || typeof event.method !== 'string') return
    this.client.receive({ method: event.method, params: event.params || {}, sessionId: this.bridgeSessionId })
  }

  /** 扩展回包：chrome.debugger.sendCommand 的结果送回来。 */
  bridgeResult(payload = {}) {
    const { id, result, error } = payload
    // 兼容旧扩展：控制面动作可能直接把 tabs/status 放在顶层。
    const value = result === undefined
      ? payload.tabs !== undefined
        ? { tabs: payload.tabs }
        : payload.status !== undefined
          ? { status: payload.status }
          : {}
      : result
    const waiter = this.bridgeActionWaiters.get(id)
    if (waiter) {
      this.bridgeActionWaiters.delete(id)
      if (error) waiter.reject(new Error(String(error)))
      else waiter.resolve(value)
      return
    }
    if (!this.client) return
    if (error) this.client.receive({ id, error: { message: String(error) } })
    else this.client.receive({ id, result: value })
  }

  /** 扩展最近一次轮询/事件的时刻：面板用它判断「扩展已加载」。 */
  markExtensionSeen() {
    this.extensionSeenAt = Date.now()
  }

  /**
   * 让扩展做一件控制面动作（tabs / attach-last / attach-tab / detach），
   * 走同一条命令队列，结果从 /bridge/result 回来。
   */
  requestBridge(action, params = {}, timeoutMs = 15000) {
    const id = `a${++this.bridgeActionSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bridgeActionWaiters.delete(id)
        reject(new Error('扩展没有响应：确认扩展已加载，且 Chrome 没有把它停用'))
      }, Math.max(1000, Math.min(30000, timeoutMs)))
      timer.unref?.()
      this.bridgeActionWaiters.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      this.bridgeCommands.push({ id, action, ...params })
      this._flushBridgeWaiters()
    })
  }

  /** 长轮询取一条待发命令；没有命令时最多等 timeoutMs，返回 null。 */
  waitBridgeCommand(timeoutMs = 20000) {
    if (this.bridgeCommands.length) return Promise.resolve(this.bridgeCommands.shift())
    return new Promise((resolve) => {
      const waiter = { resolve: null, timer: null }
      waiter.resolve = (command) => {
        clearTimeout(waiter.timer)
        resolve(command)
      }
      const wait = Math.max(1000, Math.min(30000, Number(timeoutMs) || 20000))
      waiter.timer = setTimeout(() => {
        const index = this.bridgeWaiters.indexOf(waiter)
        if (index >= 0) this.bridgeWaiters.splice(index, 1)
        resolve(null)
      }, wait)
      waiter.timer.unref?.()
      this.bridgeWaiters.push(waiter)
    })
  }

  _flushBridgeWaiters() {
    while (this.bridgeCommands.length && this.bridgeWaiters.length) {
      const waiter = this.bridgeWaiters.shift()
      waiter.resolve(this.bridgeCommands.shift())
    }
  }

  /**
   * 丢掉当前扩展会话，但**不** reject 挂着的控制面动作：切换标签页时，宿主会在
   * attach-tab 命令还没回包前先收到新的 /bridge/attach，这时把 waiter 拒掉就会
   * 让面板看到「扩展桥已断开」。
   */
  _resetBridgeState({ preserveData = false } = {}) {
    this._closeClient()
    this.bridge = null
    this.bridgePaused = false
    this.bridgeSessionId = null
    this.bridgeCommands = []
    for (const waiter of this.bridgeWaiters) waiter.resolve(null)
    this.bridgeWaiters = []
    this.sessions.clear()
    this.targets.clear()
    if (!preserveData) {
      this.network.clear()
      this.scripts.clear()
    }
    this.enabled = false
    this.port = null
    this.external = false
  }

  /** 暂停接收事件：调试器保持附着，数据不丢，切回来直接继续。 */
  async pauseBridge() {
    if (!this.bridge) return this.status()
    await this.requestBridge('pause')
    this.bridgePaused = true
    this.log.event?.('info', 'bridge-pause', { tabId: this.bridge.tabId })
    return this.status()
  }

  /** 恢复接收事件。 */
  async resumeBridge() {
    if (!this.bridge) return this.status()
    await this.requestBridge('resume')
    this.bridgePaused = false
    this.log.event?.('info', 'bridge-resume', { tabId: this.bridge.tabId })
    return this.status()
  }

  /**
   * 断开扩展桥；扩展本身不关。
   *
   * 抓到的请求与已读源码**不丢**：断开只是通道没了，历史数据仍然可看可查，
   * 真正清空只由面板/agent 的「清空」负责。
   */
  async detachBridge() {
    this._resetBridgeState({ preserveData: true })
    for (const waiter of this.bridgeActionWaiters.values()) waiter.resolve({})
    this.bridgeActionWaiters.clear()
    this.log.event?.('info', 'bridge-detach')
    return this.status()
  }

  /** Disconnect the channel; the browser keeps running. */
  async detach() {
    if (this.bridge) return this.detachBridge()
    this.enabled = false
    this._closeClient()
    this.sessions.clear()
    this.targets.clear()
    // Keep the pointer (enabled:false) so a later launch knows which port and
    // proxy the running browser was started with. Reconnects stop because
    // `ensure()` checks `enabled`.
    if (this.pointer) {
      this.pointer = { ...this.pointer, enabled: false }
      writeCdpPointer(this.pointer)
    }
    this.log.event?.('info', 'cdp-detach')
    return this.status()
  }

  /** Disconnect and, when this plugin launched it, close the browser. */
  async closeBrowser() {
    const pid = this.pid
    const external = this.external
    await this.detach()
    this.network.clear()
    this.scripts.clear()
    if (!external && pid) killTree(pid)
    clearCdpPointer()
    this.pointer = null
    this.pid = null
    this.port = null
    this.external = false
    this.log.event?.('info', 'cdp-close', { pid, external })
    return this.status()
  }

  /**
   * Newest-first browser requests, with the flow they were paired to.
   * @param {{since?: number, host?: string, matched?: boolean, limit?: number}} [options]
   */
  async requests(options = {}) {
    return this.network.requests(options)
  }

  /**
   * 一条请求的展示帧：同步段 + 异步段摊平，行列 +1 给人看。
   *
   * `totalFrames` 是摊平后的总数（等于 F12 Initiator 的行数），`syncFrames` 是其中
   * `asyncLevel === 0` 的部分——只读同步段是本插件曾经「只有 3 帧」的原因。
   * @param {object} entry network index entry
   */
  _framesOf(entry) {
    return flattenFrames(entry.initiator && entry.initiator.stack).map((frame) => ({
      functionName: frame.functionName || '(anonymous)',
      url: frame.url || '',
      lineNumber: Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : null,
      columnNumber: Number.isInteger(frame.columnNumber) ? frame.columnNumber + 1 : null,
      scriptId: frame.scriptId ? String(frame.scriptId) : null,
      scriptKey: frame.scriptId ? `${entry.sessionId}:${frame.scriptId}` : null,
      sessionId: entry.sessionId,
      asyncLevel: frame.asyncLevel,
      anonymous: frame.anonymous,
      noise: isNoiseFrame(frame),
    }))
  }

  /** One browser-side request in full: headers/postData/发起栈，不依赖代理。 */
  requestDetail(id) {
    const entry = this.network.get(String(id || ''))
    if (!entry) throw new Error('这条 CDP 请求已滚出索引（最多保留 2000 条）')
    const frames = this._framesOf(entry)
    const target = this.targets.get(entry.targetId) || null
    return {
      id: entry.id,
      at: entry.at,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      mime: entry.mime,
      type: entry.resourceType,
      documentURL: entry.documentURL,
      fromCache: entry.fromCache,
      finished: entry.finished,
      requestHeaders: entry.requestHeaders,
      postData: entry.postData,
      responseHeaders: entry.responseHeaders,
      matchedFlowId: entry.matchedFlowId || null,
      target: target ? { targetId: target.targetId, type: target.type, title: target.title, url: target.url } : null,
      initiator: {
        type: (entry.initiator && entry.initiator.type) || '',
        totalFrames: frames.length,
        syncFrames: frames.filter((frame) => frame.asyncLevel === 0).length,
        asyncLevels: frames.length ? Math.max(...frames.map((frame) => frame.asyncLevel)) + 1 : 0,
        filteredFrames: frames.filter((frame) => frame.noise).length,
        frames,
      },
    }
  }

  /** 清空 CDP 模式自己的列表，不碰系统抓包的 flow；落盘的源码一起清（用户约定的生命周期）。 */
  clearRequests() {
    this.network.clear()
    this.sources.clear()
    this.sourceAttempts.clear()
    return this.status()
  }

  /**
   * 把一条 CDP 请求拼成 flow 的形状，交给代码生成器（面板「代码」页与 `webcap_code` 共用）。
   *
   * CDP 只有请求头与 POST 体（响应体不在索引里），所以生成的是「发出去的请求」，
   * 与系统抓包那条路径生成的脚本语义一致。
   * @param {string} id CDP 请求 id
   */
  codeFlowOf(id) {
    const entry = this.network.get(String(id || ''))
    if (!entry) throw new Error('这条 CDP 请求已滚出索引（最多保留 2000 条）')
    let parsed = null
    try {
      parsed = new URL(entry.url)
    } catch {
      parsed = null
    }
    const headers = entry.requestHeaders || {}
    const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')
    return {
      id: entry.id,
      method: entry.method,
      url: entry.url,
      scheme: parsed ? parsed.protocol.replace(':', '') : 'https',
      host: parsed ? parsed.hostname : '',
      port: parsed ? Number(parsed.port || (parsed.protocol === 'http:' ? 80 : 443)) : 443,
      path: parsed ? `${parsed.pathname}${parsed.search}` : entry.url,
      reqHeaders: headers,
      reqBody: entry.postData
        ? { mime: contentType ? String(contentType[1]).toLowerCase() : '', text: entry.postData }
        : null,
      status: entry.status,
    }
  }

  /**
   * The call chain + key parameters for one flow.
   * @param {object} flow stored flow
   * @param {{store?: object, withSource?: boolean}} [options]
   */
  async chain(flow, { store = null, withSource = false } = {}) {
    const entry = this.network.match(flow)
    const siblings = store
      ? store.flows
        .filter((item) => item !== flow && item.method === flow.method && normalizeUrl(item.url) === normalizeUrl(flow.url))
        .slice(-5)
      : []
    const params = analyseParams(flow, siblings)
    if (!entry) return { matched: false, params }

    const frames = this._framesOf(entry)
    // 有些 XHR/fetch 只给 initiator.url、没有 callFrames；至少别显示成“无发起处”。
    if (!frames.length && entry.initiator && entry.initiator.url) {
      frames.push({
        functionName: entry.initiator.type || '(anonymous)',
        url: entry.initiator.url,
        lineNumber: Number.isInteger(entry.initiator.lineNumber) ? entry.initiator.lineNumber + 1 : null,
        columnNumber: Number.isInteger(entry.initiator.columnNumber) ? entry.initiator.columnNumber + 1 : null,
        scriptId: null,
        scriptKey: null,
        sessionId: entry.sessionId,
        asyncLevel: 0,
        anonymous: false,
        noise: false,
      })
    }
    const target = this.targets.get(entry.targetId) || null
    const result = {
      matched: true,
      request: {
        id: entry.id,
        at: entry.at,
        method: entry.method,
        url: entry.url,
        resourceType: entry.resourceType,
        documentURL: entry.documentURL,
        status: entry.status,
        mime: entry.mime,
      },
      target: target
        ? { targetId: target.targetId, type: target.type, title: target.title, url: target.url }
        : null,
      initiator: {
        type: (entry.initiator && entry.initiator.type) || '',
        totalFrames: frames.length,
        syncFrames: frames.filter((frame) => frame.asyncLevel === 0).length,
        asyncLevels: frames.length ? Math.max(...frames.map((frame) => frame.asyncLevel)) + 1 : 0,
        filteredFrames: frames.filter((frame) => frame.noise).length,
        frames,
      },
      params,
    }
    if (withSource) {
      result.sources = []
      for (const frame of frames.filter((item) => !item.noise).slice(0, 3)) {
        if (!frame.scriptKey || frame.lineNumber === null) continue
        try {
          const snippet = await this._snippet(frame.scriptKey, frame.lineNumber - 1, 8)
          if (snippet) result.sources.push({ scriptKey: frame.scriptKey, url: frame.url, line: frame.lineNumber, code: snippet.code })
        } catch {
          /* the script was evicted or the page navigated away */
        }
      }
    }
    return result
  }

  /** Script list for the Sources view（元数据；正文看 `sourceOf` / `scriptGet`）。 */
  scriptList({ q, limit } = {}) {
    return this.scripts.list({ q, limit })
  }

  /** One script's text, paginated by characters（读落盘那份，不碰浏览器）。 */
  async scriptGet({ key, offset = 0, limit = 8000 } = {}) {
    const ids = this._idsOfScript({ key })
    const source = this.sources.get(ids.key)
    if (source === null) {
      throw new Error(this.sources.reasonOf(ids.key) || `这个脚本还没落盘：${ids.url || ids.key}`)
    }
    const from = Math.max(0, Number(offset) || 0)
    const size = Math.min(65536, Math.max(1, Number(limit) || 8000))
    return {
      key: ids.key,
      url: ids.url,
      label: ids.url || `inline:${ids.scriptId}`,
      totalChars: source.length,
      offset: from,
      text: source.slice(from, from + size),
    }
  }

  /** 在**已落盘**的脚本里搜；不再用 `Debugger.searchInContent` 去浏览器里扫。 */
  async scriptSearch({ q, limit = 50 } = {}) {
    const needle = String(q || '').trim()
    if (!needle) throw new Error('q 不能为空')
    const max = Math.min(100, Math.max(1, Number(limit) || 50))
    const hits = []
    for (const meta of this.sources.list({ limit: 200 })) {
      if (hits.length >= max) break
      const source = this.sources.get(meta.key)
      if (!source) continue
      const lines = source.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const at = lines[index].indexOf(needle)
        if (at < 0) continue
        hits.push({
          key: meta.key,
          url: meta.url,
          label: meta.url || `inline:${meta.scriptId}`,
          lineNumber: index + 1,
          columnNumber: at + 1,
          lineContent: lines[index].slice(Math.max(0, at - 60), at + needle.length + 60),
        })
        break
      }
      if (hits.length >= max) break
    }
    return hits
  }
  /**
   * 源码查看器的数据：调用点片段。
   *
   * **只读磁盘上那份**：源码在抓取时按调用链涉及的脚本各取一次、落盘（`sourceStore`），
   * 这里不再向浏览器要第二份——断开、重启、换标签页之后照样能看。整份源码不在这里给：
   * 面板只看调用点附近，「翻整份」没有意义（agent 要看整份走 `scriptGet`）。
   *
   * 压缩过的 bundle 整份只有一行，按行取窗口等于把几 MB 全给面板，所以先看目标行
   * 多长：超过 `MINIFIED_LINE_CHARS` 就按**列**切窗口并展开成多行，否则按行取上下文。
   *
   * 同名方法在一个文件里不唯一：默认给「这一帧自己的调用点」，同时把整份文件里
   * `needle` 的所有位置数出来（`hits`），面板据此「上一处 / 下一处」翻。
   * @param {{key?: string, scriptId?: string, sessionId?: string, url?: string, line?: number,
   *   column?: number, context?: number, chars?: number, needle?: string, hitIndex?: number}} [options]
   */
  async sourceOf({ key = '', scriptId = '', sessionId = '', url = '', line = 0, column = 0, context = 8, chars = 1200, needle = '', hitIndex = -1 } = {}) {
    const ids = this._idsOfScript({ key, scriptId, sessionId })
    let source = this.sources.get(ids.key)
    if (source === null && this.sourceAttempts.has(ids.key)) {
      // 刚好在落盘队列里（点得比落盘快）：等这一轮队列走完再看一次，省得让用户重点。
      await this.sourceQueue
      source = this.sources.get(ids.key)
    }
    if (source === null) {
      const reason = this.sources.reasonOf(ids.key)
      throw new Error(
        reason
          || `这个脚本还没落盘${ids.url ? `：${ids.url}` : ''}；抓取时没取到（脚本在抓取前就已卸载），不再向浏览器拉取`,
      )
    }
    const totalChars = source.length
    const lines = source.split('\n')
    const label = url || ids.url || (this.scripts.getMeta(ids.key) || {}).url || ''
    const head = {
      key: ids.key,
      scriptId: ids.scriptId,
      url: label,
      totalChars,
      totalLines: lines.length,
      stored: true,
    }
    const callLine = Math.max(0, Math.min(lines.length - 1, Number(line) || 0))
    const callOffset = charOffsetOf(source, callLine, Math.max(0, (Number(column) || 1) - 1))
    const name = String(needle || '').trim()
    const positions = name ? occurrencesOf(source, name) : []
    const asked = Number(hitIndex)
    const index = Number.isInteger(asked) && asked >= 0 && asked < positions.length ? asked : -1
    // -1 表示「这一帧的调用点」（默认）；>=0 是同名方法的第 index 处。
    const target = index >= 0 ? positions[index] : callOffset
    const targetLine = index >= 0 ? lineAt(source, target) : callLine
    const targetColumn = target - charOffsetOf(source, targetLine, 0) + 1
    // 从调用点翻同名位置时先给「调用点之后最近的那处」，而不是文件里的第一处。
    const hasAfter = positions.some((position) => position > callOffset)
    const hasBefore = positions.some((position) => position < callOffset)
    const next = hasAfter ? positions.findIndex((position) => position > callOffset) : 0
    const lastBefore = positions.reduce((found, position, at) => (position < callOffset ? at : found), -1)
    const prev = hasBefore ? lastBefore : positions.length - 1
    const hits = { needle: name, total: positions.length, index, next, prev }
    if ((lines[targetLine] || '').length > MINIFIED_LINE_CHARS) {
      const window = columnWindow(source, target, chars)
      // 压缩代码一行到底没法读：展开成带缩进的多行，标记落在调用点/同名位置上。
      const formatted = formatFragment(window.text, {
        target: window.highlight.start,
        maxMarkChars: index >= 0 ? Math.max(1, name.length) : 160,
      })
      return {
        ...head,
        mode: 'column',
        line: targetLine + 1,
        column: Math.max(1, targetColumn),
        charOffset: target,
        start: window.start,
        end: window.end,
        lines: formatted.lines,
        mark: formatted.mark,
        truncated: formatted.truncated,
        hits,
      }
    }
    const window = lineWindow(source, targetLine, Math.min(40, Math.max(1, Number(context) || 8)))
    return {
      ...head,
      mode: 'line',
      line: targetLine + 1,
      charOffset: target,
      startLine: window ? window.startLine : 1,
      endLine: window ? window.endLine : 1,
      highlightLine: targetLine + 1,
      text: window ? window.code : '',
      hits,
    }
  }

  /**
   * 从 key（`<sessionId>:<scriptId>`）或显式参数还原脚本身份。
   * 调用链里的帧一直带 `scriptKey`，所以离线也能算出 scriptId。
   */
  _idsOfScript({ key = '', scriptId = '', sessionId = '' } = {}) {
    const rawKey = String(key || '')
    let sid = scriptId ? String(scriptId) : ''
    let session = sessionId ? String(sessionId) : ''
    if (rawKey) {
      const cut = rawKey.lastIndexOf(':')
      if (!sid && cut >= 0) sid = rawKey.slice(cut + 1)
      if (!session && cut > 0) session = rawKey.slice(0, cut)
    }
    if (!sid) throw new Error('这一帧没有 scriptId（内联脚本或预加载请求），拿不到源码')
    const meta = this.scripts.getMeta(rawKey)
    return {
      key: rawKey || `${session}:${sid}`,
      sessionId: session || (meta ? meta.sessionId : ''),
      scriptId: sid,
      url: meta ? meta.url : '',
    }
  }

  dispose() {
    this.disposed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this._closeClient()
  }

  async _connectToPort(port, version = null) {
    const info = version || (await probeVersion(port))
    if (!info || !info.webSocketDebuggerUrl) throw new Error(`CDP 端口 ${port} 没有返回浏览器调试地址`)
    this._closeClient()
    let client
    client = await connectCdp(info.webSocketDebuggerUrl, {
      log: this.log,
      onEvent: (message) => this._onEvent(message),
      // Only the live connection may flip the channel state: a replaced socket
      // can emit its close after the new one is already attached.
      onClose: (reason) => {
        if (this.client === client) this._onClose(reason)
      },
    })
    this.client = client
    this.connected = true
    this.browser = {
      name: info.Browser || '',
      protocolVersion: info['Protocol-Version'] || '',
    }
    this.port = port
    this.reconnectCount = 0
    this.retryAt = 0
    this.lastError = null
    try {
      await client.send('Target.setDiscoverTargets', { discover: true })
      await client.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
    } catch (err) {
      this._closeClient()
      throw err
    }
    this.log.event?.('info', 'cdp-connect', {
      port,
      browser: this.browser.name,
      protocolVersion: this.browser.protocolVersion,
      external: Boolean(this.pointer && this.pointer.external),
    })
  }

  _closeClient() {
    const client = this.client
    this.client = null
    this.connected = false
    if (client) client.close()
  }

  _onClose(reason) {
    const sessions = this.sessions.size
    const requests = this.network.size
    this.connected = false
    this.client = null
    this.sessions.clear()
    this.targets.clear()
    this.log.event?.('warn', 'cdp-disconnect', {
      reason: String(reason || ''),
      port: this.port,
      sessions,
      requests,
    })
    if (!this.enabled) return
    this.lastError = `CDP 连接断开（${reason}），自动重连中`
    this._scheduleReconnect()
  }

  _scheduleReconnect() {
    if (this.retryTimer) return
    const pointer = this.pointer
    if (!pointer || !pointer.port) return
    if (!pointer.external && pointer.pid && !processAlive(pointer.pid)) {
      if (!String(this.lastError || '').includes('受控浏览器已关闭')) {
        this.log.event?.('warn', 'cdp-browser-closed', { pid: pointer.pid, port: pointer.port })
      }
      this.lastError = '受控浏览器已关闭，点「连接浏览器」重开'
      return
    }
    this.reconnectCount += 1
    const delay = Math.min(MAX_RECONNECT_DELAY, 2000 * 2 ** Math.min(4, this.reconnectCount - 1))
    this.retryAt = Date.now() + delay
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.ensure().catch(() => {})
    }, delay)
    this.retryTimer.unref?.()
  }

  _onEvent(message) {
    const { method, params, sessionId } = message
    switch (method) {
      case 'Target.attachedToTarget':
        this._attachSession(params)
        return
      case 'Target.detachedFromTarget':
        this._detachSession(params.sessionId)
        return
      case 'Target.targetInfoChanged':
        this._noteTarget(params.targetInfo)
        return
      case 'Target.targetDestroyed':
        if (params && params.targetId) this.targets.delete(params.targetId)
        return
      case 'Network.requestWillBeSent':
        if (sessionId) {
          const entry = this.network.add({ sessionId, targetId: this._targetIdOfSession(sessionId), params })
          // 抓到的这条请求带调用栈时，把栈里涉及的脚本顺手落盘（每个脚本只取一次）。
          this._queueSourcePersist(entry)
        }
        return
      case 'Network.responseReceived':
        if (sessionId) this.network.noteResponse({ sessionId, params })
        return
      case 'Network.loadingFinished':
        if (sessionId) this.network.noteFinished({ sessionId, params })
        return
      case 'Debugger.scriptParsed':
        if (sessionId) this.scripts.noteParsed(sessionId, params)
        return
      default:
    }
  }

  _attachSession(params) {
    if (!params || !params.sessionId) return
    const targetInfo = params.targetInfo || {}
    this.sessions.set(params.sessionId, {
      sessionId: params.sessionId,
      targetId: targetInfo.targetId || '',
      type: targetInfo.type || '',
      title: targetInfo.title || '',
      url: targetInfo.url || '',
      attachedAt: Date.now(),
    })
    if (targetInfo.targetId) this.targets.set(targetInfo.targetId, targetInfo)
    // 页面级目标记一条，worker/tab 会话不记：排查时够看出「连上了几个页面」，
    // 又不会因为每个 worker 都写一行把日志撑大。
    if (targetInfo.type === 'page' || targetInfo.type === 'webview') {
      this.log.event?.('info', 'cdp-target', { type: targetInfo.type, targetId: targetInfo.targetId || '' })
    }
    const client = this.client
    if (!client) return
    if (params.waitingForDebugger) {
      client.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {})
    }
    client.send('Network.enable', { maxPostDataSize: 65536 }, params.sessionId).catch((err) => {
      this.log.warn?.(`[dsh-flowspot] Network.enable 失败：${err.message}`)
    })
    client.send('Debugger.enable', {}, params.sessionId).catch((err) => {
      this.log.warn?.(`[dsh-flowspot] Debugger.enable 失败：${err.message}`)
    })
    // 扩展桥那条通道由 background 开这一段；这里不补的话，换回受控浏览器时
    // 异步段会短一截（实测 4 段 vs 7 段），两条路径行为就分叉了。
    client.send('Debugger.setAsyncCallStackDepth', { maxDepth: 64 }, params.sessionId).catch(() => {})
    // Workers are children of the page session; without this their requests
    // would be missing from the call-chain index.
    client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }, params.sessionId).catch(() => {})
  }

  _detachSession(sessionId) {
    if (!sessionId) return
    this.sessions.delete(sessionId)
    this.network.clearSession(sessionId)
    this.scripts.removeSession(sessionId)
  }

  _noteTarget(targetInfo) {
    if (!targetInfo || !targetInfo.targetId) return
    this.targets.set(targetInfo.targetId, targetInfo)
    for (const session of this.sessions.values()) {
      if (session.targetId !== targetInfo.targetId) continue
      session.type = targetInfo.type || session.type
      session.title = targetInfo.title || session.title
      session.url = targetInfo.url || session.url
    }
  }

  _targetIdOfSession(sessionId) {
    const session = this.sessions.get(sessionId)
    return session ? session.targetId : ''
  }

  /**
   * 抓取时的源码落盘：把一条业务接口调用链涉及的脚本各取一次，写到数据目录。
   *
   * 这是**唯一**向浏览器要源码的地方（`Debugger.getScriptSource`，读渲染进程里 V8 的
   * 脚本对象，不是重新下载）；只有业务接口（XHR/Fetch，排除埋点/风控探针，见
   * `sourceFilter.js`）才做，同一脚本只做一次，串行执行，免得和正常请求抢通道。
   */
  _queueSourcePersist(entry) {
    if (!entry) return
    // 埋点、APM、风控探针、页面文档都不落盘：磁盘和通道留给业务接口。
    if (!isBusinessRequest({ resourceType: entry.resourceType, url: entry.url })) return
    const jobs = []
    for (const frame of flattenFrames(entry.initiator && entry.initiator.stack)) {
      // 内联脚本（url 为空）不落：没有名字，查看器里也说不清是哪个文件。
      if (!frame.scriptId || !frame.url) continue
      const key = `${entry.sessionId}:${frame.scriptId}`
      if (this.sources.has(key)) continue
      const tried = this.sourceAttempts.get(key) || 0
      // 同一脚本最多试两次：第一次失败可能是通道抖动，第二次还不行就记原因不再打扰。
      if (tried >= 2) continue
      this.sourceAttempts.set(key, tried + 1)
      jobs.push({ key, scriptId: String(frame.scriptId), sessionId: entry.sessionId, url: frame.url || '' })
    }
    if (!jobs.length) return
    this.sourceQueue = this.sourceQueue.then(() => this._persistJobs(jobs)).catch(() => {})
  }

  async _persistJobs(jobs) {
    for (const job of jobs) {
      try {
        const text = await this._readSourceText(job)
        if (!text) continue
        const result = this.sources.put({ ...job, text })
        if (!result.stored) {
          this.log.event?.('warn', 'cdp-source-skip', { url: job.url, chars: result.chars, reason: result.reason })
        }
      } catch (err) {
        this.sources.noteFailure({ key: job.key, url: job.url, reason: `抓取时没读到这个脚本：${err.message}` })
      }
    }
  }

  /**
   * 从渲染进程要一份源码；这是全仓唯一发 `getScriptSource` 的地方。
   *
   * 回包就是整份脚本（实测 1~4MB），经扩展桥还要过一次 HTTP POST；默认 15 秒的
   * 命令超时对大回包太紧，这里单独放宽到 60 秒。
   */
  async _readSourceText({ scriptId, sessionId }) {
    if (!this.client) throw new Error('CDP 未连接')
    const result = await this.client.send(
      'Debugger.getScriptSource',
      { scriptId: String(scriptId) },
      sessionId || undefined,
      { timeoutMs: 60000 },
    )
    return String((result && result.scriptSource) || '')
  }

  /**
   * 显式补落盘一个脚本（面板「落盘这个脚本」按钮用）。
   * 正常路径用不到：抓取时已经存过；这里只救「漏取」与「上限调大后重试」。
   */
  async persistScript({ key = '', scriptId = '', sessionId = '', url = '' } = {}) {
    const ids = this._idsOfScript({ key, scriptId, sessionId })
    const existing = this.sources.meta(ids.key)
    if (existing) return { ok: true, stored: true, chars: existing.chars }
    const text = await this._readSourceText({ scriptId: ids.scriptId, sessionId: ids.sessionId })
    const result = this.sources.put({ key: ids.key, url: url || ids.url, scriptId: ids.scriptId, sessionId: ids.sessionId, text })
    return { ok: result.stored, ...result }
  }

  /** 调用链附带的源码片段（`withSource`），同样只读落盘那份。 */
  async _snippet(key, line, context) {
    const source = this.sources.get(key)
    if (source === null) return null
    return lineWindow(source, line, context)
  }

  /** 某个脚本的落盘绝对路径（给「打开所在文件夹」）；没落盘返回 null。 */
  sourcePathOf(key) {
    return this.sources.pathOf(String(key || ''))
  }

  /** 源码落盘目录本身（还没落过盘也返回路径，调用方负责建目录）。 */
  sourcesDir() {
    return this.sources.directory
  }
}

export default CdpChannel
