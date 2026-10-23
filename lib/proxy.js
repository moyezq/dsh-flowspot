/**
 * dsh-flowspot：插件内的 MITM 代理。
 *
 * 一条请求的走向：
 *
 *   客户端 --CONNECT--> this.server --(200)--> 用目标 host 的证书接管 TLS
 *   --> 内层 http.Server 解析出明文请求 --> 以 https 发往源站 --> 响应原样回灌。
 *
 * v0.1 有意保留的限制：
 *  - 只做 HTTP/1.1。不宣告任何 ALPN 协议，Chromium 因此退回 HTTP/1.1，而不是协商出
 *    我们解析不了的 h2。
 *  - body 靠 tee 抓（一个 PassThrough 往真正的目的地分流），所以抓包不改变送达内容
 *    与顺序，SSE 这类流式响应照样立刻刷出。
 *  - 转发时去掉逐跳头；`transfer-encoding` 也丢掉，因为 Node 已经解过 chunk，往外写
 *    时会重新分块。
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { PassThrough } from 'node:stream'

// 逐跳头只对这一段连接有意义，转发给上游或下游都会让对方误判，所以一律不发。
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * 重放 Upgrade 时必须留下的头。`connection` 和 `upgrade` 在普通请求里算逐跳头，
 * 但它们本身就是升级握手：丢掉它们源站会回 400 而不是 101，WebSocket 永远开不起来。
 */
const DROP_ON_UPGRADE = new Set([
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
])

// CONNECT 的 authority 形如 host:port，IPv6 会写成 [::1]:443，方括号要剥掉。
function splitHostPort(authority) {
  const text = String(authority || '')
  const at = text.lastIndexOf(':')
  if (at === -1) return [text, '']
  const host = text.slice(0, at)
  const port = text.slice(at + 1)
  return [host.replace(/^\[|\]$/g, ''), port]
}

export class MitmProxy {
  constructor({ certs, store, config, log }) {
    this.certs = certs
    this.store = store
    this.cfg = config
    this.log = log || { warn() {} }
    this.server = null
    this.inner = null
    this.port = null
    this.startedAt = null
    this.sockets = new Set()
    this.connections = 0
    this.tunnels = 0
    this.httpAgent = null
    this.httpsAgent = null
    this.lastError = null
    /**
     * 去重后的上游失败，最新的在末尾：`{key, host, method, path, code, phase,
     * message, count, ts}`。面板只有最后一条字符串不够用——「自动填充为什么失败」
     * 和「我的接口为什么失败」是两个问题，一个槽位答不了。
     */
    this.recentErrors = []
    /** 首选端口绑不上、退到临时端口时写在这里，供面板提示。 */
    this.portNote = null
  }

  get running() {
    return Boolean(this.server && this.server.listening)
  }

  _makeAgents() {
    // 默认不开 keep-alive：调试代理要连几十个源站，池子里被服务器空闲关闭的套接字
    // 会让这个源站的下一次请求直接吃 "socket hang up"（ECONNRESET）。每个请求新建
    // 连接就彻底消掉这种失败；代价是每次多一次 TCP+TLS 握手，调试时值得。
    const keepAlive = this.cfg.upstreamKeepAlive === true
    this.httpAgent = new http.Agent({ keepAlive, maxSockets: 64 })
    this.httpsAgent = new https.Agent({
      keepAlive,
      maxSockets: 64,
      rejectUnauthorized: this.cfg.upstreamRejectUnauthorized !== false,
    })
  }

  _track(socket, kind = 'client') {
    this.sockets.add(socket)
    const drop = () => this.sockets.delete(socket)
    socket.once('close', drop)
    socket.once('error', drop)
    return socket
  }

  async start(preferredPort) {
    if (this.running) return this.port
    this.portNote = null
    this._makeAgents()
    this.inner = http.createServer((req, res) => this._handleRequest(req, res))
    this.inner.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head))
    this.inner.on('clientError', (_err, socket) => socket.destroy())

    this.server = http.createServer((req, res) => this._handleRequest(req, res))
    this.server.on('connect', (req, socket, head) => this._handleConnect(req, socket, head))
    this.server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head))
    this.server.on('connection', (socket) => {
      this.connections++
      this._track(socket)
    })
    this.server.on('clientError', (_err, socket) => socket.destroy())

    const wanted = Number(preferredPort ?? this.cfg.port ?? 8899)
    try {
      await this._listen(wanted)
    } catch (err) {
      // EADDRINUSE：端口被别的进程占了。
      // Windows 上 EACCES / EPERM 通常是 Hyper-V/WinNAT 把这段端口保留了
      // （`netsh interface ipv4 show excludedportrange protocol=tcp`），不是防火墙：
      // 系统直接拒绝绑定。这两种情况都能靠「要一个临时端口」救回来，抓包继续可用。
      const recoverable = err && (err.code === 'EADDRINUSE' || err.code === 'EACCES' || err.code === 'EPERM')
      if (!recoverable) throw err
      const reason = err.code === 'EADDRINUSE' ? '已被其他进程占用' : '被系统保留或无权限绑定'
      this.log.warn(`[dsh-flowspot] 端口 ${wanted} ${reason}（${err.code}），改用随机端口`)
      await this._listen(0)
      const actual = this.server.address().port
      this.portNote = `${wanted} ${reason}（${err.code}），已改用随机端口 ${actual}。`
        + '要固定端口就在插件配置里改 port，避开 `netsh interface ipv4 show excludedportrange protocol=tcp` 列出的范围。'
    }
    this.port = this.server.address().port
    this.startedAt = Date.now()
    // 新的抓包会话：先把上一份账本关掉。文件由第一条完成的 flow 创建，所以一次空
    // 抓包不会留下任何文件。
    this.store.beginSession?.()
    return this.port
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const server = this.server
      const onError = (err) => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  }

  async stop() {
    const server = this.server
    this.server = null
    try {
      this.inner?.close()
    } catch {
      /* 已经关了 */
    }
    this.inner = null
    for (const socket of this.sockets) {
      try {
        socket.destroy()
      } catch {
        /* 忽略 */
      }
    }
    this.sockets.clear()
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()))
    }
    try {
      this.httpAgent?.destroy()
      this.httpsAgent?.destroy()
    } catch {
      /* 忽略 */
    }
    this.httpAgent = null
    this.httpsAgent = null
    this.port = null
    this.portNote = null
    this.startedAt = null
    // 关掉本会话的账本；下次 start() 会开一个新文件。
    this.store.close?.()
  }

  /**
   * CONNECT：先回 200 告诉客户端隧道通了，再用该 host 的叶子证书接管 TLS。
   * 外层 server 只负责这一段；解密后的请求交给内层 server 解析。
   */
  _handleConnect(req, clientSocket, head) {
    const [host, portText] = splitHostPort(req.url)
    const port = Number(portText || 443)
    if (!host) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    this.tunnels++
    this._track(clientSocket)
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: dsh-flowspot\r\n\r\n')
    // CONNECT 有时会把 TLS ClientHello 和请求头一起送来，多出来的字节要退回流里，
    // 不然握手数据就丢了。
    if (head && head.length) clientSocket.unshift(head)

    let context
    try {
      context = this.certs.contextFor(host)
    } catch (err) {
      this.lastError = `证书签发失败 ${host}: ${err.message}`
      this.log.warn(`[dsh-flowspot] ${this.lastError}`)
      clientSocket.destroy()
      return
    }

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext: context,
      // 客户端真正要求的主机名可能和 CONNECT 里的不一样（TLS 层的 SNI 才算数），
      // 所以握手时按 SNI 再发一张证书。
      SNICallback: (servername, cb) => {
        try {
          cb(null, this.certs.contextFor(servername))
        } catch (err) {
          cb(err)
        }
      },
    })
    // 把隧道目标挂在 socket 上：内层解析出的请求没有 Host 绝对地址，只能从这里取。
    tlsSocket.__target = { host, port }
    this._track(tlsSocket)
    tlsSocket.on('error', (err) => {
      this.lastError = `TLS 握手失败 ${host}:${port} — ${err.code || err.message}`
      try {
        tlsSocket.destroy()
      } catch {
        /* 忽略 */
      }
    })
    tlsSocket.once('secure', () => {
      try {
        this.inner.emit('connection', tlsSocket)
      } catch (err) {
        this.lastError = `内层 HTTP 解析挂载失败 ${host}: ${err.message}`
        tlsSocket.destroy()
      }
    })
  }

  /**
   * 算这条请求该发去哪里。两种形态：绝对 URL（明文 HTTP 直接发给代理）和隧道里的
   * 相对路径（目标只能从 socket 上的 __target 取）。两个都不成立就返回 null。
   */
  _resolveTarget(req) {
    if (/^https?:\/\//i.test(req.url)) {
      try {
        const parsed = new URL(req.url)
        const scheme = parsed.protocol.slice(0, -1)
        return {
          scheme,
          host: parsed.hostname,
          port: Number(parsed.port || (scheme === 'https' ? 443 : 80)),
          path: `${parsed.pathname || '/'}${parsed.search || ''}`,
        }
      } catch {
        return null
      }
    }
    // 隧道里没有绝对 URL，目标来自 CONNECT 时挂在 socket 上的 __target；
    // 能进到这里就说明客户端已经在 TLS 里说话，所以一律按 https 处理。
    const tunnel = req.socket && req.socket.__target
    if (!tunnel) return null
    return { scheme: 'https', host: tunnel.host, port: tunnel.port, path: req.url || '/' }
  }

  _forwardHeaders(headers, target, { upgrade = false } = {}) {
    const skip = upgrade ? DROP_ON_UPGRADE : HOP_BY_HOP
    const out = {}
    for (const [key, value] of Object.entries(headers || {})) {
      const lower = key.toLowerCase()
      if (skip.has(lower)) continue
      out[lower] = value
    }
    // host 要按真实目标重写：默认端口（443/80）不带端口，和浏览器写法一致。
    out.host = `${target.host}${target.port === 443 || target.port === 80 ? '' : `:${target.port}`}`
    return out
  }

  _handleRequest(req, res) {
    const started = Date.now()
    const target = this._resolveTarget(req)
    if (!target) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-flowspot: 无法确定目标地址（缺少 CONNECT 隧道）')
      return
    }
    const hostHeader = String(req.headers.host || target.host).replace(/:\d+$/, '')
    const url = `${target.scheme}://${hostHeader}${target.path}`
    const flow = this.store.begin({
      startedAt: started,
      method: req.method,
      scheme: target.scheme,
      host: target.host,
      port: target.port,
      path: target.path,
      url,
      httpVersion: req.httpVersion,
      reqHeaders: req.headers,
      tunnel: req.socket && req.socket.__target ? { host: req.socket.__target.host, port: req.socket.__target.port } : null,
    })

    const isHttps = target.scheme === 'https'
    const mod = isHttps ? https : http
    const options = {
      host: target.host,
      port: target.port,
      method: req.method,
      path: target.path,
      headers: this._forwardHeaders(req.headers, target),
      agent: isHttps ? this.httpsAgent : this.httpAgent,
    }
    if (isHttps) {
      options.servername = net.isIP(target.host) ? undefined : target.host
      options.rejectUnauthorized = this.cfg.upstreamRejectUnauthorized !== false
      // 上游只讲 HTTP/1.1：把 ALPN 钉死，源站再喜欢 h2 也不会真回 h2（我们解析不了）。
      options.ALPNProtocols = ['http/1.1']
    }

    const requestChunks = []
    let requestBytes = 0
    req.on('data', (buf) => {
      if (requestBytes < this.cfg.maxBodyBytes) {
        requestChunks.push(buf)
        requestBytes += buf.length
      }
    })

    const headersSent = () => res.headersSent
    /** 标记这次失败是客户端自己造成的，不是源站的问题。 */
    let clientAborted = false
    const finishWithError = (err) => {
      if (flow.finishedAt) return
      const code = err && err.code ? String(err.code) : null
      const detail = code ? `${err.message}（${code}）` : String(err.message || err)
      const phase = clientAborted ? 'client' : 'upstream'
      // 客户端取消不算代理失败：Chrome 一直在断开后台请求（自动填充、预取），让它们
      // 覆盖 lastError 会把操作员真正在意的失败盖掉。
      if (phase === 'upstream') {
        this.lastError = `${flow.method} ${flow.host}${flow.path} — ${detail}`
        this._noteError(flow, { code, phase, message: detail })
      }
      this.store.finish(flow, {
        error: err,
        errorCode: code,
        errorPhase: phase,
        durationMs: Date.now() - started,
        status: flow.status,
      })
      if (!headersSent()) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`dsh-flowspot: 上游请求失败：${detail}`)
      } else {
        res.destroy()
      }
    }

    let upstream
    try {
      upstream = mod.request(options, (upRes) => {
        const responseChunks = []
        let responseBytes = 0
        upRes.on('data', (buf) => {
          if (responseBytes < this.cfg.maxBodyBytes) {
            responseChunks.push(buf)
            responseBytes += buf.length
          }
        })
        const outHeaders = {}
        for (const [key, value] of Object.entries(upRes.headers || {})) {
          if (HOP_BY_HOP.has(key.toLowerCase())) continue
          outHeaders[key] = value
        }
        flow.status = upRes.statusCode
        // 响应头立刻写回客户端，再去接 body：等 body 收完才回头会破坏 SSE 和长轮询。
        res.writeHead(upRes.statusCode, outHeaders)
        try {
          res.flushHeaders()
        } catch {
          /* 老版本 Node 没有 flushHeaders */
        }
        // 用 tee 抓 body：一份流给客户端，同时留一份在 responseChunks 里做预览，
        // 抓包本身不改变送达时序。
        const tee = new PassThrough()
        tee.on('error', () => {})
        upRes.pipe(tee)
        tee.pipe(res)
        const done = (err, phase = 'body') => {
          if (flow.finishedAt) return
          const body = Buffer.concat(responseChunks).subarray(0, this.cfg.maxBodyBytes)
          this.store.finish(flow, {
            status: upRes.statusCode,
            headers: upRes.headers,
            body,
            error: err,
            errorCode: err && err.code ? String(err.code) : null,
            errorPhase: err ? phase : null,
            durationMs: Date.now() - started,
          })
        }
        upRes.on('end', () => done(null))
        upRes.on('aborted', () => done(new Error('上游响应中断'), 'body'))
        upRes.on('error', (err) => done(err, 'body'))
        res.on('close', () => {
          if (!res.writableFinished) done(new Error('客户端提前关闭'), 'client')
        })
      })
    } catch (err) {
      finishWithError(err)
      return
    }

    upstream.on('error', finishWithError)
    upstream.setTimeout(this.cfg.upstreamTimeoutMs ?? 30000, () => {
      const err = new Error('上游超时')
      err.code = 'ETIMEDOUT'
      upstream.destroy(err)
    })
    req.on('aborted', () => {
      clientAborted = true
      upstream.destroy(new Error('客户端中断'))
    })
    // 客户端在上传途中挂掉时，请求对象上会抛 'error'；不接住就是未捕获异常，
    // 会把整个进程（连带 GUI 的后端）带走。下面两个 tee 也是同理。
    req.on('error', (err) => {
      clientAborted = true
      upstream.destroy(err)
    })
    req.on('end', () => {
      if (!requestChunks.length) return
      const body = Buffer.concat(requestChunks).subarray(0, this.cfg.maxBodyBytes)
      this.store.setRequestBody(flow, body)
    })
    const tee = new PassThrough()
    tee.on('error', () => {})
    req.pipe(tee)
    tee.pipe(upstream)
  }

  /**
   * WebSocket / 任意 Upgrade：做一条透明隧道，握手本身记成一条 flow。
   * 这里不走 http 模块的请求路径——升级之后两端都在裸 socket 上收发，只能手动搬字节。
   */
  _handleUpgrade(req, socket, head) {
    const target = this._resolveTarget(req)
    if (!target) {
      socket.destroy()
      return
    }
    const started = Date.now()
    const hostHeader = String(req.headers.host || target.host).replace(/:\d+$/, '')
    const flow = this.store.begin({
      startedAt: started,
      method: req.method,
      scheme: target.scheme,
      host: target.host,
      port: target.port,
      path: target.path,
      url: `${target.scheme}://${hostHeader}${target.path}`,
      httpVersion: req.httpVersion,
      reqHeaders: req.headers,
      tunnel: req.socket && req.socket.__target ? { host: req.socket.__target.host, port: req.socket.__target.port } : null,
    })

    const isHttps = target.scheme === 'https'
    const connectOptions = { host: target.host, port: target.port }
    if (isHttps) {
      connectOptions.servername = net.isIP(target.host) ? undefined : target.host
      connectOptions.rejectUnauthorized = this.cfg.upstreamRejectUnauthorized !== false
      connectOptions.ALPNProtocols = ['http/1.1']
    }
    const upstream = isHttps ? tls.connect(connectOptions) : net.connect(connectOptions)
    this._track(upstream, 'upstream')

    const lines = [`${req.method} ${target.path} HTTP/1.1`]
    for (const [key, value] of Object.entries(this._forwardHeaders(req.headers, target, { upgrade: true }))) {
      const v = Array.isArray(value) ? value.join(', ') : value
      lines.push(`${key}: ${v}`)
    }
    lines.push('', '')
    upstream.write(lines.join('\r\n'))
    if (head && head.length) upstream.write(head)

    // 101 的响应头可能被拆成多个 chunk 到；只缓冲到出现头部结束符为止，之后不再解析。
    // 字节仍然是一块一块往下转的，所以这段缓冲不会拖慢任何流量。
    let headParsed = false
    let headBuf = Buffer.alloc(0)
    upstream.on('data', (buf) => {
      if (!headParsed) {
        headBuf = Buffer.concat([headBuf, buf])
        // 攒到 64 KiB 还没见到头部结束符，就认为对端说的不是 HTTP 头，放弃解析，
        // 免得缓冲区无限增长。
        if (headBuf.length > 65536) {
          headParsed = true
        } else {
          const parsed = parseHead(headBuf)
          if (parsed) {
            headParsed = true
            this.store.finish(flow, {
              status: parsed.status,
              headers: parsed.headers,
              durationMs: Date.now() - started,
            })
          }
        }
      }
      // 写不进去就暂停另一端（背压），数据留在内核缓冲里，不堆进内存。
      if (!socket.write(buf)) {
        upstream.pause()
        socket.once('drain', () => upstream.resume())
      }
    })
    socket.on('data', (buf) => {
      if (!upstream.write(buf)) {
        socket.pause()
        upstream.once('drain', () => socket.resume())
      }
    })
    // 任一端断开都要收尾；已经 finish 过的 flow 不会被再写一次。
    const close = (err) => {
      try {
        upstream.destroy()
        socket.destroy()
      } catch {
        /* 忽略 */
      }
      if (!flow.finishedAt) {
        this.store.finish(flow, {
          status: flow.status,
          error: err || null,
          errorCode: err && err.code ? String(err.code) : null,
          errorPhase: err ? 'upgrade' : null,
          durationMs: Date.now() - started,
        })
      }
    }
    upstream.on('error', (err) => close(err))
    socket.on('error', (err) => close(err))
    upstream.on('close', () => close(null))
    socket.on('close', () => close(null))
  }

  snapshot() {
    return {
      running: this.running,
      port: this.port,
      portNote: this.portNote,
      startedAt: this.startedAt,
      connections: this.connections,
      tunnels: this.tunnels,
      openSockets: this.sockets.size,
      lastError: this.lastError,
      recentErrors: this.recentErrors.map((item) => ({ ...item })),
    }
  }

  /**
   * 记住一次上游失败，按 method+host+path+code+phase 合并：重试循环不会刷屏，两种
   * 不同的失败也仍然分得开。
   * @param {object} flow 失败的那条 flow
   * @param {{code: string|null, phase: string, message: string}} info 失败事实
   */
  _noteError(flow, { code, phase, message }) {
    // key 不包含 message 与时间：同一处失败只要阶段和错误码相同就归成一条，靠 count 累计。
    const key = `${flow.method} ${flow.host}${flow.path}|${code || ''}|${phase}`
    const now = Date.now()
    const hit = this.recentErrors.find((item) => item.key === key)
    if (hit) {
      hit.count++
      hit.ts = now
      hit.message = message
      // 让最新的那条失败仍可点开：面板要按这个 id 打开请求详情。
      hit.flowId = flow.id
      return
    }
    this.recentErrors.push({
      key,
      ts: now,
      method: flow.method,
      host: flow.host,
      path: flow.path,
      url: flow.url,
      code: code || null,
      phase,
      message,
      count: 1,
      flowId: flow.id,
    })
    // 只留最近 20 条不同的失败，超出丢最旧的，防止长期运行时无限增长。
    while (this.recentErrors.length > 20) this.recentErrors.shift()
  }

  /**
   * 清空记住的失败。因为清空 flow 环时也会清掉错误列表，这两者必须一起清：否则
   * 面板会显示一批 flow 已经不存在的失败。
   */
  clearErrors() {
    this.recentErrors = []
    this.lastError = null
  }
}

/**
 * 把一段 HTTP 头缓冲拆成状态码与头对象；头部还不完整时返回 null，调用方好接着攒。
 * 用 latin1 解码是为了逐字节还原，头里出现非 ASCII 也不会被 UTF-8 解坏。
 */
export function parseHead(buf) {
  const text = buf.toString('latin1')
  const end = text.indexOf('\r\n\r\n')
  if (end === -1) return null
  const lines = text.slice(0, end).split('\r\n')
  const statusLine = lines.shift() || ''
  const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine)
  const headers = {}
  for (const line of lines) {
    const at = line.indexOf(':')
    if (at === -1) continue
    const name = line.slice(0, at).trim().toLowerCase()
    const value = line.slice(at + 1).trim()
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value
  }
  return { status: match ? Number(match[1]) : null, headers }
}
