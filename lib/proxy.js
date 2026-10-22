/**
 * dsh-flowspot: the in-plugin MITM proxy.
 *
 * Shape of a request:
 *
 *   client --CONNECT--> this.server --(200)--> TLS terminate with a per-host
 *   certificate --> inner http.Server parses the plaintext request --> https
 *   request to the origin --> response piped back untouched.
 *
 * Deliberate constraints for v0.1:
 *  - HTTP/1.1 only. No ALPN protocol is advertised, so Chromium falls back to
 *    HTTP/1.1 instead of negotiating h2 we cannot parse.
 *  - Bodies are captured through a tee (a PassThrough piped to the real
 *    destination), so capture never changes delivery or ordering. Streaming
 *    responses (SSE) therefore still flush immediately.
 *  - Headers are forwarded minus hop-by-hop fields; `transfer-encoding` is
 *    dropped because Node already dechunked the message and will re-chunk it.
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { PassThrough } from 'node:stream'

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
 * Headers that must survive an Upgrade replay. `connection` and `upgrade` are
 * hop-by-hop for a normal request, but they ARE the handshake: dropping them
 * makes the origin answer 400 instead of 101, so a WebSocket never opens.
 */
const DROP_ON_UPGRADE = new Set([
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
])

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
     * Distinct upstream failures, newest last: `{key, host, method, path, code,
     * phase, message, count, ts}`. The panel needs more than the last string —
     * "why is autofill failing" and "why is MY api failing" are different
     * questions, and one slot cannot answer both.
     */
    this.recentErrors = []
    /** Set when the preferred port could not be bound and an ephemeral one is used. */
    this.portNote = null
  }

  get running() {
    return Boolean(this.server && this.server.listening)
  }

  _makeAgents() {
    // Keep-alive is off by default: a debugging proxy talks to dozens of origins,
    // and a pooled socket the server closed while idle surfaces as "socket hang
    // up" (ECONNRESET) on the NEXT request through that origin. A fresh
    // connection per request removes that failure mode entirely; the cost is one
    // extra TCP+TLS handshake per request, which is acceptable while debugging.
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
      // EADDRINUSE: another process owns the port.
      // EACCES / EPERM on Windows is usually a Hyper-V/WinNAT reserved range
      // (`netsh interface ipv4 show excludedportrange protocol=tcp`), not a
      // firewall: the OS refuses the bind outright. Both are recoverable by
      // asking the OS for an ephemeral port, so capture still works.
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
    // A new capture session: close the previous ledger. The file itself is
    // created by the first finished flow, so an empty capture leaves nothing.
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
      /* already closed */
    }
    this.inner = null
    for (const socket of this.sockets) {
      try {
        socket.destroy()
      } catch {
        /* ignore */
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
      /* ignore */
    }
    this.httpAgent = null
    this.httpsAgent = null
    this.port = null
    this.portNote = null
    this.startedAt = null
    // Close this session's ledger; the next start() opens a new file.
    this.store.close?.()
  }

  /** CONNECT: answer 200, terminate TLS with a leaf for the requested host. */
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
      SNICallback: (servername, cb) => {
        try {
          cb(null, this.certs.contextFor(servername))
        } catch (err) {
          cb(err)
        }
      },
    })
    tlsSocket.__target = { host, port }
    this._track(tlsSocket)
    tlsSocket.on('error', (err) => {
      this.lastError = `TLS 握手失败 ${host}:${port} — ${err.code || err.message}`
      try {
        tlsSocket.destroy()
      } catch {
        /* ignore */
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
      // We only speak HTTP/1.1 upstream; pin ALPN so a server never answers h2
      // (which we cannot parse) even if it prefers it.
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
    /** Set when the error is the client's doing, not the origin's. */
    let clientAborted = false
    const finishWithError = (err) => {
      if (flow.finishedAt) return
      const code = err && err.code ? String(err.code) : null
      const detail = code ? `${err.message}（${code}）` : String(err.message || err)
      const phase = clientAborted ? 'client' : 'upstream'
      // A client cancellation is not a proxy failure: Chrome drops background
      // requests (autofill, prefetch) constantly, and letting those overwrite
      // `lastError` hides the failure the operator actually cares about.
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
        res.writeHead(upRes.statusCode, outHeaders)
        try {
          res.flushHeaders()
        } catch {
          /* older Node */
        }
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
    // A client socket that dies mid-upload raises 'error' on the request; left
    // unhandled it is an uncaught exception that would take the whole process
    // (and the GUI's backend) down. Same for the pass-through tees below.
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

  /** WebSocket / any Upgrade: passthrough tunnel, handshake recorded as a flow. */
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

    // The 101 head can arrive split across chunks; buffer only until the header
    // terminator shows up, then stop parsing. Bytes are still forwarded one
    // chunk at a time, so no traffic is delayed by this.
    let headParsed = false
    let headBuf = Buffer.alloc(0)
    upstream.on('data', (buf) => {
      if (!headParsed) {
        headBuf = Buffer.concat([headBuf, buf])
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
    const close = (err) => {
      try {
        upstream.destroy()
        socket.destroy()
      } catch {
        /* ignore */
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
   * Remember one upstream failure, merged by method+host+path+code+phase so a
   * retry loop does not flood the list while two different failures stay
   * distinguishable.
   * @param {object} flow the flow that failed
   * @param {{code: string|null, phase: string, message: string}} info failure facts
   */
  _noteError(flow, { code, phase, message }) {
    const key = `${flow.method} ${flow.host}${flow.path}|${code || ''}|${phase}`
    const now = Date.now()
    const hit = this.recentErrors.find((item) => item.key === key)
    if (hit) {
      hit.count++
      hit.ts = now
      hit.message = message
      // Keep the newest failure reachable: the panel opens this id's detail.
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
    while (this.recentErrors.length > 20) this.recentErrors.shift()
  }

  /**
   * Drop the remembered failures. `clear` wipes the flow ring too, so the error
   * list must not survive it — otherwise the panel shows failures whose flows no
   * longer exist.
   */
  clearErrors() {
    this.recentErrors = []
    this.lastError = null
  }
}

/** Split an HTTP head buffer into status code + headers, or null when incomplete. */
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
