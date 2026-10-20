/**
 * dsh-flowspot: HTTP routes for the settings panel.
 *
 * The panel talks to the plugin over these routes instead of folding session
 * events, and each route delegates to the same tool implementation the model
 * calls — one code path, so panel and agent can never disagree about a flow.
 */

import { createToolDefinitions } from './tools.js'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', JSON_HEADERS['content-type'])
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (buf) => {
      size += buf.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
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
 * Is this a browser request from another origin?
 *
 * The GUI server is same-origin for the panel, but a page on another site can
 * still POST a "simple" request here (no preflight) and trigger a side effect
 * such as clearing the capture buffer; the browser blocks it from reading the
 * response, not from causing it. POST routes therefore refuse anything the
 * browser marks as cross-site. Requests without those headers (curl, tests)
 * are allowed.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean} true when the request is clearly cross-origin
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
 * Read an optional host service without depending on `inject`.
 *
 * Cordis contexts are proxies: `ctx.directoryPicker` throws
 * `cannot get property "directoryPicker" without inject` when the service was
 * never injected, and an uncaught throw in a route surfaces to the panel as a
 * bare "操作失败" with no reason. `ctx.get(name)` is the inject-free accessor;
 * the property read stays as the fallback for plain (test) host objects.
 * @param {object} ctx host context
 * @param {string} name service name
 * @returns {object|undefined} the service when the deployment provides it
 */
function optionalService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(name)
      if (service) return service
    }
  } catch {
    /* not injected in this context scope */
  }
  try {
    return ctx[name] || undefined
  } catch {
    return undefined
  }
}

/**
 * Mount the routes; returns a disposer.
 * @param {object} ctx host context with webServer
 * @param {object} rt runtime
 */
export function mountRoutes(ctx, rt) {
  const tools = new Map(createToolDefinitions(rt).map((tool) => [tool.name, tool]))
  const disposers = []
  const exec = { signal: new AbortController().signal }

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
    send(res, 200, await call('webcap_status', {}))
  })

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
      // The host's directory-picker seam: native opens one OS chooser on the
      // host display, browse only serves listings for remote clients.
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
