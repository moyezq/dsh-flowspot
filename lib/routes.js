/**
 * dsh-flowspot: 设置面板用的 HTTP 路由。
 *
 * 面板不靠折叠会话事件来还原状态，而是走这些路由问插件；每条路由都去调模型
 * 用的同一个工具实现（`call('webcap_x')`）——一份代码路径，面板和 agent 对
 * 同一条 flow 的说法就不可能不一致。
 */

import { codegenFile, langsOf, readPrefs, writePrefs } from './codegen/prefs.js'
import { createToolDefinitions } from './tools.js'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
/**
 * 扩展桥回包的上限：整份脚本源码要原样穿过这条 HTTP。
 * 单脚本落盘上限是 4MB，JSON 转义会略微膨胀，这里留到 12MB。
 */
const MAX_BRIDGE_RESULT_BYTES = 12 * 1024 * 1024
/** 事件批量：一次最多 50 条，带 POST 体的站点单条可到 64KB，留 4MB。 */
const MAX_BRIDGE_EVENTS_BYTES = 4 * 1024 * 1024

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', JSON_HEADERS['content-type'])
  res.end(JSON.stringify(body))
}

/** 只有「扩展连接页」需要返回 HTML。 */
function sendHtml(res, status, html) {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(html)
}

/**
 * 扩展连接页：在浏览器里打开一次，内容脚本就会把宿主地址记下来。
 *
 * 页面自己不做桥接——它只负责两件事：`/dsh-flowspot/status` 通不通（告诉用户
 * 这个地址是对的），以及把「可以关掉这一页了」说清楚。
 */
function bridgeHelloPage(base) {
  const origin = String(base || '')
  const shown = origin || '（宿主还没起来）'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Flowspot 扩展连接</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e8ee;font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;padding:32px 36px;border:1px solid #262b36;border-radius:14px;background:#151922}
h1{margin:0 0 12px;font-size:19px}
code{font-family:ui-monospace,Consolas,monospace;background:#202632;padding:2px 6px;border-radius:5px;font-size:13px}
p{margin:8px 0;color:#aab2c0}
.ok{color:#6ee7a8}.bad{color:#ff9f9f}
</style></head><body><main>
<h1>Flowspot 扩展连接</h1>
<p>宿主地址：<code>${shown}</code></p>
<p id="state">正在确认这个地址……</p>
<p>确认成功后，扩展就会记住这个地址，这一页可以直接关掉；之后在面板里点「连接浏览器」即可。</p>
</main>
<script>
fetch('/dsh-flowspot/status').then(function (r) { return r.ok ? r.json() : null }).then(function (body) {
  var el = document.getElementById('state')
  if (body && body.ok) {
    el.className = 'ok'
    el.textContent = '已确认：这是 Flowspot 宿主。扩展会自动连上，可以关掉这一页。'
  } else {
    el.className = 'bad'
    el.textContent = '这个地址没有响应 Flowspot：确认面板正在运行，或换一个地址。'
  }
}).catch(function () {
  var el = document.getElementById('state')
  el.className = 'bad'
  el.textContent = '连不上这个地址：确认宿主在运行，且端口没变。'
})
</script></body></html>`
}

/**
 * 读 JSON 请求体。
 *
 * 默认上限 1MB 够面板与 agent 用；但扩展桥回包要装整份脚本源码
 * （`Debugger.getScriptSource` 一条就 1~4MB），所以桥接回包单独放宽，
 * 超限时回 413 而不是直接把连接掐掉——掐掉会让宿主一直等到命令超时。
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit?: number}} [options]
 */
function readBody(req, { limit = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const tooBig = () => Object.assign(new Error(`请求体过大（上限 ${limit} 字节）`), { statusCode: 413 })
    let size = 0
    let over = false
    const chunks = []
    req.on('data', (buf) => {
      size += buf.length
      if (size > limit) {
        over = true
        chunks.length = 0
        // 继续读到 end 好让调用方回一个明确的 413；再大一倍就直接断开止损。
        if (size > limit * 2) {
          req.destroy()
          reject(tooBig())
        }
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (over) {
        reject(tooBig())
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function query(req) {
  try {
    return Object.fromEntries(new URL(req.url, 'http://127.0.0.1').searchParams.entries())
  } catch {
    return {}
  }
}

function num(value) {
  if (value === undefined || value === '' || value === null) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 这是不是从别的源发来的浏览器请求？
 *
 * 面板和 GUI 服务器同源，但另一个网站上的页面照样能往本机 POST 一个「简单
 * 请求」（不触发预检）并造成副作用，比如清空捕获缓冲——浏览器只拦它读响应，
 * 不拦它发出去。所以 POST 路由一律拒绝浏览器标成跨站的请求；没有这些头的
 * 请求（curl、测试）照常放行。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean} 明确是跨源请求时为 true
 */
function crossSite(req) {
  const headers = req.headers || {}
  const site = String(headers['sec-fetch-site'] || '').toLowerCase()
  if (site && site !== 'same-origin') return true
  const origin = headers.origin
  if (!origin) return false
  try {
    return new URL(origin).host !== String(headers.host || '')
  } catch {
    return true
  }
}

/**
 * 扩展桥请求的放行条件：带 `x-flowspot-bridge: 1`（扩展 background，靠 host
 * permission 发；网页要带自定义头会先触发 preflight，而这里不回 CORS 头），
 * 或者本来就是面板的同源请求。其余跨站请求一律拒绝。
 */
function bridgeAllowed(req) {
  if (String((req.headers || {})['x-flowspot-bridge'] || '') === '1') return true
  return !crossSite(req)
}

/**
 * 读一个可选的宿主服务，但不依赖 `inject`。
 *
 * Cordis 的 ctx 是代理：服务没 inject 过时 `ctx.directoryPicker` 会直接抛
 * `cannot get property "directoryPicker" without inject`，而路由里没接住的
 * throw 到面板上就只剩一句没头没尾的「操作失败」。`ctx.get(name)` 是不需要
 * inject 的取值口；属性读取留作兜底，给测试里那种普通对象用。
 * @param {object} ctx 宿主上下文
 * @param {string} name 服务名
 * @returns {object|undefined} 这个部署提供了才返回
 */
function optionalService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(name)
      if (service) return service
    }
  } catch {
    /* 这个上下文里没有注入这个服务 */
  }
  try {
    return ctx[name] || undefined
  } catch {
    return undefined
  }
}

/**
 * 挂上全部路由；返回卸载函数。
 *
 * 这里把工具定义再建一遍：面板和 agent 共用的是同一份 `execute`，不是两套
 * 实现，所以从哪边点，结果和报错都一样。
 * @param {object} ctx 带 webServer 的宿主上下文
 * @param {object} rt 运行时
 */
export function mountRoutes(ctx, rt) {
  const tools = new Map(createToolDefinitions(rt).map((tool) => [tool.name, tool]))
  const disposers = []
  const exec = { signal: new AbortController().signal }

  /**
   * 扩展要连的宿主 HTTP 源。
   *
   * 浏览器的内容脚本只能报出「它所在页面的 origin」，而桌面端的界面在
   * `dsh-app://` 里——这个源扩展根本连不到。真实的 `http://127.0.0.1:<port>`
   * 只有宿主的 webServer 知道，所以由面板显示、由「连接页」交给扩展。
   */
  const bridgeBase = () => {
    const server = optionalService(ctx, 'webServer')
    const port = server && server.port
    if (!port) return ''
    let host = String((server && server.host) || '127.0.0.1')
    if (host === '0.0.0.0' || host === '::' || host === '::0') host = '127.0.0.1'
    const shown = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    return `http://${shown}:${port}`
  }

  // 路由到工具的唯一通道：工具抛出来的异常在这里兜成 {ok:false,error}，
  // 否则一个路由 500 掉，面板只看到空响应、拿不到原因。
  const call = async (name, args) => {
    const tool = tools.get(name)
    if (!tool) return { ok: false, error: `工具未注册: ${name}` }
    try {
      return await tool.execute(args || {}, exec)
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  const route = (path, handler) => {
    const dispose = ctx.webServer.register({ kind: 'exact', path, handler })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  route('/dsh-flowspot/status', async (_req, res) => {
    const body = await call('webcap_status', {})
    // 面板据此显示「扩展连接地址」：桌面端界面在 dsh-app:// 里，只有这里知道真实端口。
    body.bridge = { base: bridgeBase() }
    send(res, 200, body)
  })

  // 约定：有副作用的动作用 POST 并过一遍 crossSite，只读查询用 GET 不查；
  // 下面每条带副作用的都先判方法、再拒跨站，最后才读 body。
  route('/dsh-flowspot/serve', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (crossSite(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      const body = await readBody(req)
      send(res, 200, await call('webcap_serve', body))
    } catch (err) {
      send(res, 400, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/ca', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (crossSite(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      const body = await readBody(req)
      send(res, 200, await call('webcap_ca', body))
    } catch (err) {
      send(res, 400, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/flows', async (req, res) => {
    const q = query(req)
    send(res, 200, await call('webcap_flows', {
      host: q.host || undefined,
      method: q.method || undefined,
      status: num(q.status),
      type: q.type || undefined,
      q: q.q || undefined,
      since: num(q.since),
      limit: num(q.limit),
      group: q.group === '1' || q.group === 'true',
      normalize: q.normalize === '1' || q.normalize === 'true',
    }))
  })

  route('/dsh-flowspot/detail', async (req, res) => {
    const q = query(req)
    if (!q.id) return send(res, 400, { ok: false, error: '缺少 id' })
    send(res, 200, await call('webcap_detail', { id: q.id }))
  })

  route('/dsh-flowspot/body', async (req, res) => {
    const q = query(req)
    if (!q.id) return send(res, 400, { ok: false, error: '缺少 id' })
    send(res, 200, await call('webcap_body', {
      id: q.id,
      side: q.side === 'request' ? 'request' : 'response',
      offset: num(q.offset),
      limit: num(q.limit),
    }))
  })

  route('/dsh-flowspot/search', async (req, res) => {
    const q = query(req)
    if (!q.q) return send(res, 400, { ok: false, error: '缺少 q' })
    send(res, 200, await call('webcap_search', { q: q.q, scope: q.scope, limit: num(q.limit) }))
  })

  route('/dsh-flowspot/export', async (req, res) => {
    const q = query(req)
    const format = q.format === 'har' ? 'har' : q.format === 'json' ? 'json' : 'curl'
    send(res, 200, await call('webcap_export', { format, id: q.id || undefined, limit: num(q.limit) }))
  })

  route('/dsh-flowspot/code', async (req, res) => {
    const q = query(req)
    send(res, 200, await call('webcap_code', { id: q.id || undefined, lang: q.lang || undefined }))
  })

  route('/dsh-flowspot/code-prefs', async (req, res) => {
    if (req.method === 'POST') {
      if (crossSite(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
      try {
        const body = await readBody(req)
        const prefs = writePrefs(body)
        return send(res, 200, { ok: true, ...prefs, langs: langsOf(prefs), file: codegenFile() })
      } catch (err) {
        return send(res, 400, { ok: false, error: err.message })
      }
    }
    const prefs = readPrefs()
    send(res, 200, { ok: true, ...prefs, langs: langsOf(prefs), file: codegenFile() })
  })

  // CDP 通道：面板按钮与 agent 工具走同一个 webcap_cdp 实现。
  route('/dsh-flowspot/cdp', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (crossSite(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      const body = await readBody(req)
      send(res, 200, await call('webcap_cdp', {
        action: body.action,
        port: num(body.port),
        since: num(body.since),
        limit: num(body.limit),
        host: body.host,
        matched: typeof body.matched === 'boolean' ? body.matched : undefined,
      }))
    } catch (err) {
      send(res, 400, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/cdp/requests', async (req, res) => {
    const q = query(req)
    send(res, 200, await call('webcap_cdp', {
      action: 'requests',
      since: num(q.since),
      limit: num(q.limit),
      host: q.host || undefined,
      matched: q.matched === '1' ? true : q.matched === '0' ? false : undefined,
    }))
  })

  route('/dsh-flowspot/cdp/request', async (req, res) => {
    const q = query(req)
    if (!q.id) return send(res, 400, { ok: false, error: '缺少 id' })
    send(res, 200, await call('webcap_cdp', { action: 'request', id: q.id }))
  })

  route('/dsh-flowspot/cdp/chain', async (req, res) => {
    const q = query(req)
    if (!q.id) return send(res, 400, { ok: false, error: '缺少 id' })
    send(res, 200, await call('webcap_chain', { id: q.id, source: q.source !== '0' }))
  })

  // 源码查看器：只读抓取时落盘的那份，给调用点附近的片段（压缩文件展开成多行）。
  // `store=1` 是显式补落盘（漏取、或上限调大后重试），正常路径用不到。
  route('/dsh-flowspot/cdp/source', async (req, res) => {
    const q = query(req)
    if (!q.key && !q.scriptId) return send(res, 400, { ok: false, error: '缺少 key 或 scriptId' })
    const target = {
      key: q.key || '',
      scriptId: q.scriptId || '',
      sessionId: q.sessionId || '',
      url: q.url || '',
    }
    try {
      if (q.store === '1') await rt.cdp.persistScript(target)
      const snippet = await rt.cdp.sourceOf({
        ...target,
        line: num(q.line) ?? 0,
        column: num(q.column) ?? 0,
        context: num(q.context) ?? 8,
        chars: num(q.chars) ?? 1200,
        needle: q.needle || '',
        hitIndex: num(q.hit) ?? -1,
      })
      send(res, 200, { ok: true, ...snippet })
    } catch (err) {
      // 没落盘就说清原因（超限 / 抓取时没读到）；面板不提供「临时再拉一次」的入口。
      send(res, 200, { ok: false, error: err.message })
    }
  })

  // CDP 请求也能转脚本：和系统抓包共用 `webcap_code`，只是 id 换成 CDP 请求 id。
  route('/dsh-flowspot/cdp/code', async (req, res) => {
    const q = query(req)
    send(res, 200, await call('webcap_code', { id: q.id || undefined, lang: q.lang || undefined, cdp: true }))
  })

  // 在资源管理器里选中某个落盘的脚本；不带 key 就打开整个 scripts 目录。
  route('/dsh-flowspot/cdp/reveal', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (crossSite(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      const body = await readBody(req)
      send(res, 200, rt.revealSources(body.key || ''))
    } catch (err) {
      send(res, 400, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/logs/open', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (crossSite(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      send(res, 200, rt.openLogsDir())
    } catch (err) {
      send(res, 200, { ok: false, error: err.message })
    }
  })

  // 扩展桥：background 直接和这里通信（x-flowspot-bridge 头），面板同源也能调。
  //
  // 「连接页」是最特殊的一条：它要被**浏览器**打开（不是面板），所以返回 HTML 而不是
  // JSON，也故意不做同源判断——桌面端界面在 dsh-app:// 里，扩展拿不到那个 origin，
  // 只能靠这一页把真实的 http://127.0.0.1:<port> 交给内容脚本。
  route('/dsh-flowspot/bridge/hello', async (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'GET only' })
    sendHtml(res, 200, bridgeHelloPage(bridgeBase()))
  })

  // 在浏览器里打开上面那一页（桌面端面板点按钮时走这条）。
  route('/dsh-flowspot/bridge/open-hello', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (crossSite(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      const body = await readBody(req)
      send(res, 200, rt.openBridgeHello(body.base || bridgeBase()))
    } catch (err) {
      send(res, 400, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/bridge/attach', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (!bridgeAllowed(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      const body = await readBody(req)
      send(res, 200, { ok: true, ...(await rt.cdp.attachExtension({ tabId: body.tabId, title: body.title, url: body.url, paused: body.paused === true })) })
    } catch (err) {
      send(res, 200, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/bridge/events', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (!bridgeAllowed(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      rt.cdp.markExtensionSeen()
      // 一批最多 50 条事件，带 POST 体的站点单条可到 64KB，1MB 上限会把整批丢掉。
      const body = await readBody(req, { limit: MAX_BRIDGE_EVENTS_BYTES })
      const events = Array.isArray(body.events) ? body.events.slice(0, 200) : []
      for (const event of events) rt.cdp.bridgeEvent(event)
      send(res, 200, { ok: true, count: events.length })
    } catch (err) {
      send(res, err.statusCode || 400, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/bridge/command', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (!bridgeAllowed(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      const body = await readBody(req)
      const params = body.tabId === undefined ? {} : { tabId: Number(body.tabId) }
      const result = await rt.cdp.requestBridge(String(body.action || ''), params, num(body.wait) ?? 15000)
      send(res, 200, { ok: true, result })
    } catch (err) {
      send(res, 200, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/bridge/result', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (!bridgeAllowed(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      // 一条 `Debugger.getScriptSource` 的回包就是整份脚本（实测 1.6MB 级），
      // 用面板那套 1MB 上限会把它掐断，宿主只能等到 CDP 命令超时。
      const body = await readBody(req, { limit: MAX_BRIDGE_RESULT_BYTES })
      rt.cdp.bridgeResult(body)
      send(res, 200, { ok: true })
    } catch (err) {
      send(res, err.statusCode || 400, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/bridge/poll', async (req, res) => {
    const q = query(req)
    try {
      rt.cdp.markExtensionSeen()
      const command = await rt.cdp.waitBridgeCommand(num(q.wait) ?? 20000)
      send(res, 200, { ok: true, command })
    } catch (err) {
      send(res, 200, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/bridge/detach', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (!bridgeAllowed(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      send(res, 200, { ok: true, ...(await rt.cdp.detachBridge()) })
    } catch (err) {
      send(res, 200, { ok: false, error: err.message })
    }
  })

  // 扩展分发：本机直接打开目录；远程/无界面部署下载 zip。
  route('/dsh-flowspot/extension/zip', async (_req, res) => {
    const result = rt.extensionZip()
    if (!result.ok) return send(res, 200, { ok: false, error: result.error })
    res.statusCode = 200
    res.setHeader('content-type', 'application/zip')
    res.setHeader('content-disposition', `attachment; filename="${result.filename}"`)
    res.setHeader('content-length', String(result.buffer.length))
    res.end(result.buffer)
  })

  route('/dsh-flowspot/extension/open', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (crossSite(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      send(res, 200, rt.openExtensionDir())
    } catch (err) {
      send(res, 200, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/clear', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (crossSite(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    try {
      const body = await readBody(req)
      send(res, 200, await call('webcap_clear', { confirm: body.confirm === true }))
    } catch (err) {
      send(res, 400, { ok: false, error: err.message })
    }
  })

  route('/dsh-flowspot/data-dir', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (crossSite(req)) return send(res, 403, { ok: false, error: '拒绝跨站请求' })
    let body
    try {
      body = await readBody(req)
    } catch (err) {
      return send(res, 400, { ok: false, error: err.message })
    }
    const action = body.action === 'pick' ? 'pick' : body.action === 'reset' ? 'reset' : 'set'
    if (action === 'pick') {
      // 宿主暴露的目录选择口：native 才会在宿主显示器上弹一个系统对话框，
      // browse 只给远程/无头客户端列目录，这里根本弹不出东西，所以直接劝退。
      const picker = optionalService(ctx, 'directoryPicker')
      if (!picker || typeof picker.capability !== 'function') {
        return send(res, 200, { ok: false, error: '当前部署没有目录选择服务（directoryPicker 未挂载）；请在 profile 配置里写 dataDir' })
      }
      let capability
      try {
        capability = picker.capability()
      } catch (err) {
        return send(res, 200, { ok: false, error: `目录选择服务不可用：${err.message}` })
      }
      if (!capability || capability.kind !== 'native') {
        return send(res, 200, {
          ok: false,
          error: `当前是浏览型目录选择（kind=${capability?.kind ?? 'unknown'}，远程/无头会话）：这里弹不出系统对话框，请在 profile 配置里写 dataDir`,
        })
      }
      const controller = new AbortController()
      const abort = () => controller.abort()
      res.on('close', abort)
      try {
        const picked = await capability.pick(controller.signal)
        res.off('close', abort)
        if (!picked) return send(res, 200, { ok: true, cancelled: true })
        // 原样透传：抓包进行中 changeDataDir() 会回 ok:false（先停抓包再改），
        // 面板据此提示，这条路由不必再判断一次。
        return send(res, 200, rt.changeDataDir(picked))
      } catch (err) {
        res.off('close', abort)
        return send(res, 200, { ok: false, error: err.message })
      }
    }
    if (action === 'reset') return send(res, 200, rt.resetDataDir())
    if (!body.dataDir) return send(res, 400, { ok: false, error: '缺少 dataDir' })
    send(res, 200, rt.changeDataDir(String(body.dataDir)))
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }
}
