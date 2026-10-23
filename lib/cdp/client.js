/**
 * dsh-flowspot: one CDP connection over one WebSocket.
 *
 * The channel keeps a single browser-level socket and speaks flattened sessions
 * (`Target.setAutoAttach` with `flatten: true`): every page/worker gets a
 * `sessionId`, and commands/events carry it. That is one TCP connection for a
 * whole browser instead of one socket per tab, which is what "长连接通道" needs.
 *
 * Zero dependencies: Node ≥22 ships a global WebSocket. The transport is
 * injectable so contract tests can drive a fake socket without a browser.
 */

/**
 * Open a WebSocket and resolve once it is open.
 * @param {string} url `ws://127.0.0.1:<port>/devtools/browser/<id>`
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<WebSocket>}
 */
export function connectWebSocket(url, { timeoutMs = 8000 } = {}) {
  const WebSocketImpl = globalThis.WebSocket
  if (typeof WebSocketImpl !== 'function') {
    return Promise.reject(new Error('当前 Node 没有内置 WebSocket（需要 Node ≥22）'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = new WebSocketImpl(url)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        /* already closing */
      }
      reject(new Error(`连接 CDP 超时：${url}`))
    }, timeoutMs)
    socket.addEventListener('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(socket)
    }, { once: true })
    socket.addEventListener('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`连接 CDP 失败：${url}`))
    }, { once: true })
  })
}

/**
 * Adapt a WebSocket to the tiny transport surface the client needs. Tests pass
 * their own object with the same four methods.
 * @param {WebSocket} socket
 * @returns {{send: Function, close: Function, onMessage: Function, onClose: Function}}
 */
export function transportOf(socket) {
  return {
    send: (text) => socket.send(text),
    close: () => {
      try {
        socket.close()
      } catch {
        /* already closed */
      }
    },
    onMessage: (handler) => socket.addEventListener('message', (event) => {
      const data = event && event.data
      handler(typeof data === 'string' ? data : String(data))
    }),
    onClose: (handler) => socket.addEventListener('close', () => handler('closed')),
  }
}

/**
 * Minimal CDP client: id/pending matching plus event delivery.
 *
 * Every command has a timeout so a wedged browser cannot hang a tool call; a
 * timeout is reported as the command name, not a bare "timed out".
 */
export class CdpClient {
  /**
   * @param {object} transport `{send, close, onMessage, onClose}`
   * @param {{onEvent?: Function, onClose?: Function, log?: object, timeoutMs?: number}} [options]
   */
  constructor(transport, { onEvent = () => {}, onClose = () => {}, log = { warn() {} }, timeoutMs = 15000 } = {}) {
    this.transport = transport
    this.onEvent = onEvent
    this.onClose = onClose
    this.log = log
    this.timeoutMs = timeoutMs
    this.pending = new Map()
    this.nextId = 1
    this.closed = false
    transport.onMessage((text) => this._handleMessage(text))
    transport.onClose((reason) => this._handleClose(reason))
  }

  get connected() {
    return !this.closed
  }

  /**
   * Send one CDP command.
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId] flattened session
   * @param {{timeoutMs?: number}} [options] 单条命令的超时覆盖（大回包用，比如整份脚本源码）
   * @returns {Promise<any>} the command result
   */
  send(method, params = {}, sessionId, { timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'))
    const id = this.nextId++
    const message = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`CDP 命令超时：${method}`))
      }, budget)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
        method,
      })
      try {
        this.transport.send(JSON.stringify(message))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  /** 给非 WebSocket 传输用（扩展桥）：把一条回包/事件喂进来。 */
  receive(message) {
    this._handleMessage(JSON.stringify(message))
  }

  _handleMessage(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      this.log.warn?.('[dsh-flowspot] CDP 返回了无法解析的消息')
      return
    }
    if (message && typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || 'CDP 错误'}`))
      else pending.resolve(message.result)
      return
    }
    if (!message || typeof message.method !== 'string') return
    try {
      this.onEvent(message)
    } catch (err) {
      this.log.warn?.(`[dsh-flowspot] CDP 事件处理失败 ${message.method}: ${err.message}`)
    }
  }

  _handleClose(reason) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error('CDP 连接已关闭'))
    this.pending.clear()
    this.onClose(reason || 'closed')
  }

  close() {
    this._handleClose('closed-by-plugin')
    this.transport.close()
  }
}

/**
 * Open the browser-level CDP connection.
 * @param {string} url
 * @param {{onEvent?: Function, onClose?: Function, log?: object, timeoutMs?: number}} [options]
 * @returns {Promise<CdpClient>}
 */
export async function connectCdp(url, options = {}) {
  const socket = await connectWebSocket(url, { timeoutMs: options.timeoutMs })
  return new CdpClient(transportOf(socket), options)
}
