/**
 * HTTP routes: the panel's contract. Every route must delegate to the same tool
 * implementation the model calls, answer JSON, refuse the wrong method, and
 * disappear when the plugin unloads.
 * Run with: node test/routes.test.mjs
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { FlowStore } from '../lib/flows.js'
import { mountRoutes } from '../lib/routes.js'

const SUBTLE = { warn() {} }

const ROUTES = [
  '/dsh-flowspot/body',
  '/dsh-flowspot/ca',
  '/dsh-flowspot/clear',
  '/dsh-flowspot/data-dir',
  '/dsh-flowspot/detail',
  '/dsh-flowspot/export',
  '/dsh-flowspot/flows',
  '/dsh-flowspot/search',
  '/dsh-flowspot/serve',
  '/dsh-flowspot/status',
]

/** A host context whose webServer only records routes. */
function fakeHost() {
  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  return { ctx, routes }
}

/** A runtime with no real proxy, CA store or registry access. */
function fakeRuntime() {
  const store = new FlowStore({ log: SUBTLE })
  const calls = []
  const rt = {
    store,
    calls,
    // The failure summary lives on the proxy; `clear` must reset it too.
    proxy: {
      clearErrors: () => {
        calls.push('clear-errors')
      },
    },
    status: async () => ({
      proxy: { running: false, port: null, connections: 0, tunnels: 0, lastError: null },
      systemProxy: { supported: true, enabled: false, server: null },
      ca: { supported: true, installed: false, path: 'C:\\fake\\ca.crt', thumbprint: 'abc' },
      flows: store.stats(),
      paths: { dir: 'C:\\fake\\dsh-flowspot' },
      platform: 'win32',
    }),
    start: async () => {
      calls.push('start')
      return { running: true, port: 8899 }
    },
    stop: async () => {
      calls.push('stop')
      return { running: false }
    },
    certstore: {
      status: async () => ({ supported: true, installed: false }),
      install: async () => {
        calls.push('ca-install')
        return { output: 'CertUtil: -addstore command completed successfully.', status: { installed: true } }
      },
      uninstall: async () => {
        calls.push('ca-uninstall')
        return { output: 'CertUtil: -delstore command completed successfully.', status: { installed: false } }
      },
    },
    sysproxy: {
      read: async () => {
        calls.push('sysproxy-read')
        return { supported: true, enabled: true, server: '127.0.0.1:8899' }
      },
    },
    changeDataDir: (target) => {
      calls.push(`data-dir:${target}`)
      return { ok: true, dir: target, previous: 'C:\\fake\\dsh-flowspot', caCopied: false, foreignCa: false, restartRequired: true }
    },
    resetDataDir: () => {
      calls.push('data-dir:reset')
      return { ok: true, reset: true, dir: 'C:\\fake\\dsh-flowspot', restartRequired: true }
    },
  }
  return { rt, store, calls }
}

function seed(store, { host = 'api.example.com', method = 'GET', path = '/v1/user', status = 200, body = '{"ok":true}', mime = 'application/json', url } = {}) {
  const flow = store.begin({
    method,
    host,
    port: 443,
    path,
    url: url || `https://${host}${path}`,
    reqHeaders: { accept: 'application/json' },
  })
  store.finish(flow, { status, headers: { 'content-type': mime }, body: Buffer.from(body) })
  return flow
}

/**
 * Call one route the way the browser would: a request stream for the body, a
 * response object that records status, headers and the JSON payload.
 */
async function call(routes, path, { method = 'GET', query = '', body, headers } = {}) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} was not registered`)
  const payload = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(payload)
  req.method = method
  req.url = path + query
  req.headers = headers || {}
  const res = {
    statusCode: 0,
    headers: {},
    text: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(chunk = '') {
      this.text += chunk
    },
    // The data-dir route subscribes to 'close' to abort a pending chooser.
    on() {
      return this
    },
    off() {
      return this
    },
  }
  await route.handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.text)
  } catch {
    json = null
  }
  return { status: res.statusCode, headers: res.headers, json, text: res.text }
}

test('mounts the ten panel routes as exact paths and removes them on dispose', () => {
  const { ctx, routes } = fakeHost()
  const { rt } = fakeRuntime()
  const dispose = mountRoutes(ctx, rt)

  assert.deepEqual([...routes.keys()].sort(), [...ROUTES].sort())
  for (const route of routes.values()) {
    assert.equal(route.kind, 'exact')
    assert.ok(route.path.startsWith('/dsh-flowspot/'))
    assert.equal(typeof route.handler, 'function')
  }
  dispose()
  assert.equal(routes.size, 0)
})

test('status answers JSON with proxy, CA, system-proxy and flow state', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store)
  seed(store, { path: '/v1/orders' })

  const { status, headers, json } = await call(routes, '/dsh-flowspot/status')
  assert.equal(status, 200)
  assert.match(headers['content-type'], /application\/json/)
  assert.equal(json.ok, true)
  assert.equal(json.proxy.running, false)
  assert.equal(json.ca.installed, false)
  assert.equal(json.systemProxy.enabled, false)
  assert.equal(json.flows.total, 2)
  assert.equal(json.paths.dir, 'C:\\fake\\dsh-flowspot')
})

test('status and flows read the same store, so panel and tools cannot disagree', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store)

  const status = await call(routes, '/dsh-flowspot/status')
  const flows = await call(routes, '/dsh-flowspot/flows', { query: '?limit=10' })
  assert.equal(status.json.flows.total, flows.json.count)
})

test('mutating routes refuse GET with 405', async () => {
  const { ctx, routes } = fakeHost()
  const { rt } = fakeRuntime()
  mountRoutes(ctx, rt)

  for (const path of ['/dsh-flowspot/serve', '/dsh-flowspot/ca', '/dsh-flowspot/clear', '/dsh-flowspot/data-dir']) {
    const { status, json } = await call(routes, path)
    assert.equal(status, 405, `${path} must reject GET`)
    assert.equal(json.ok, false)
  }
})

test('serve starts and stops the proxy and reports the system proxy', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, calls } = fakeRuntime()
  mountRoutes(ctx, rt)

  const started = await call(routes, '/dsh-flowspot/serve', { method: 'POST', body: { action: 'start' } })
  assert.equal(started.status, 200)
  assert.equal(started.json.ok, true)
  assert.equal(started.json.port, 8899)
  assert.equal(started.json.systemProxy.enabled, true)
  assert.deepEqual(calls, ['start', 'sysproxy-read'])

  const stopped = await call(routes, '/dsh-flowspot/serve', { method: 'POST', body: { action: 'stop' } })
  assert.equal(stopped.json.ok, true)
  assert.equal(stopped.json.running, false)
  assert.deepEqual(calls, ['start', 'sysproxy-read', 'stop'])
})

test('ca install, uninstall and status each answer the current trust state', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, calls } = fakeRuntime()
  mountRoutes(ctx, rt)

  const installed = await call(routes, '/dsh-flowspot/ca', { method: 'POST', body: { action: 'install' } })
  assert.equal(installed.json.ok, true)
  assert.equal(installed.json.ca.installed, true)
  assert.match(installed.json.output, /addstore/)

  const removed = await call(routes, '/dsh-flowspot/ca', { method: 'POST', body: { action: 'uninstall' } })
  assert.equal(removed.json.ca.installed, false)

  const status = await call(routes, '/dsh-flowspot/ca', { method: 'POST', body: { action: 'status' } })
  assert.equal(status.json.ok, true)
  assert.equal(status.json.ca.installed, false)
  assert.deepEqual(calls, ['ca-install', 'ca-uninstall'])
})

test('flows forwards every filter and answers newest first', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store, { path: '/a' })
  seed(store, { host: 'other.example.com', method: 'POST', path: '/b', status: 401 })
  seed(store, { path: '/c' })

  const all = await call(routes, '/dsh-flowspot/flows', { query: '?limit=10' })
  assert.equal(all.json.count, 3)
  assert.deepEqual(all.json.flows.map((f) => f.id), ['f3', 'f2', 'f1'])

  const byHost = await call(routes, '/dsh-flowspot/flows', { query: '?host=other&limit=10' })
  assert.equal(byHost.json.count, 1)
  assert.equal(byHost.json.flows[0].method, 'POST')

  const byMethod = await call(routes, '/dsh-flowspot/flows', { query: '?method=POST&limit=10' })
  assert.equal(byMethod.json.count, 1)

  const byStatus = await call(routes, '/dsh-flowspot/flows', { query: '?status=401&limit=10' })
  assert.equal(byStatus.json.count, 1)

  const byQuery = await call(routes, '/dsh-flowspot/flows', { query: '?q=%2Fc&limit=10' })
  assert.equal(byQuery.json.count, 1)

  const bySince = await call(routes, '/dsh-flowspot/flows', { query: '?since=2&limit=10' })
  assert.deepEqual(bySince.json.flows.map((f) => f.id), ['f3'])

  // Resource type is forwarded too; text/html classifies as 文档 (doc).
  seed(store, { host: 'site.example.com', path: '/page', mime: 'text/html', body: '<html></html>' })
  const byType = await call(routes, '/dsh-flowspot/flows', { query: '?type=doc&limit=10' })
  assert.equal(byType.json.count, 1)
  assert.equal(byType.json.flows[0].path, '/page')
  assert.equal(byType.json.flows[0].type, 'doc')

  // Garbage numbers fall back to "no filter" instead of becoming NaN filters.
  const garbage = await call(routes, '/dsh-flowspot/flows', { query: '?limit=abc&status=xyz' })
  assert.equal(garbage.json.ok, true)
  assert.equal(garbage.json.count, 4)
})

test('detail requires an id, reports unknown ids and never inlines bodies', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store)

  const missing = await call(routes, '/dsh-flowspot/detail')
  assert.equal(missing.status, 400)
  assert.equal(missing.json.ok, false)

  const unknown = await call(routes, '/dsh-flowspot/detail', { query: '?id=f99' })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.json.ok, false)
  assert.match(unknown.json.error, /f99/)

  const found = await call(routes, '/dsh-flowspot/detail', { query: '?id=f1' })
  assert.equal(found.json.ok, true)
  assert.equal(found.json.flow.method, 'GET')
  assert.equal(found.json.flow.status, 200)
  assert.equal(found.json.flow.reqBody?.text, undefined)
  assert.equal(found.json.flow.respBody.text, undefined)
  assert.equal(found.json.flow.respBody.bytes, 11)
})

test('body reads either side and pages text and base64 losslessly', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  const flow = seed(store, { body: 'abcdefghij' })
  store.setRequestBody(flow, Buffer.from('request-payload'))
  const binary = seed(store, { path: '/blob', body: 'ignored', mime: 'application/octet-stream' })
  // Replace the response body with bytes that are not valid text.
  binary.respBody = { mime: 'application/octet-stream', encoding: null, wireBytes: 3, bytes: 3, truncated: false, text: null, base64: Buffer.from([0, 1, 255]).toString('base64') }

  const defaultSide = await call(routes, '/dsh-flowspot/body', { query: '?id=f1&offset=2&limit=3' })
  assert.equal(defaultSide.json.ok, true)
  assert.equal(defaultSide.json.side, 'response')
  assert.equal(defaultSide.json.text, 'cde')
  assert.equal(defaultSide.json.totalChars, 10)

  const request = await call(routes, '/dsh-flowspot/body', { query: '?id=f1&side=request&limit=100' })
  assert.equal(request.json.side, 'request')
  assert.equal(request.json.text, 'request-payload')

  const base64 = await call(routes, '/dsh-flowspot/body', { query: '?id=f2&limit=3' })
  assert.equal(base64.json.text, null)
  assert.equal(base64.json.base64.length, 3)

  const missingId = await call(routes, '/dsh-flowspot/body')
  assert.equal(missingId.status, 400)
})

test('search requires q and returns hits with their location', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store, { body: '{"access_token":"abc"}' })

  const missing = await call(routes, '/dsh-flowspot/search')
  assert.equal(missing.status, 400)

  const hit = await call(routes, '/dsh-flowspot/search', { query: '?q=access_token' })
  assert.equal(hit.json.ok, true)
  assert.equal(hit.json.count, 1)
  assert.ok(hit.json.hits[0].where.includes('response-body'))

  const none = await call(routes, '/dsh-flowspot/search', { query: '?q=zzz-not-there' })
  assert.equal(none.json.count, 0)
})

test('export renders curl, HAR and JSON documents', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store, { path: '/a' })
  seed(store, { path: '/b' })

  const curl = await call(routes, '/dsh-flowspot/export', { query: '?format=curl&id=f1' })
  assert.equal(curl.json.ok, true)
  assert.match(curl.json.curl, /^curl -X GET 'https:\/\/api\.example\.com\/a'/)

  const har = await call(routes, '/dsh-flowspot/export', { query: '?format=har&limit=2' })
  assert.equal(har.json.ok, true)
  assert.equal(har.json.document.log.version, '1.2')
  assert.equal(har.json.document.log.entries.length, 2)

  const json = await call(routes, '/dsh-flowspot/export', { query: '?format=json&limit=2' })
  assert.equal(json.json.format, 'json')
  assert.equal(json.json.count, 2)

  // An unknown format falls back to curl rather than failing.
  const fallback = await call(routes, '/dsh-flowspot/export', { query: '?format=wat&id=f2' })
  assert.equal(fallback.json.format, 'curl')

  const unknown = await call(routes, '/dsh-flowspot/export', { query: '?format=curl&id=f99' })
  assert.equal(unknown.json.ok, false)
})

test('clear is destructive only with confirm=true', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store, calls } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store)
  seed(store)

  const refused = await call(routes, '/dsh-flowspot/clear', { method: 'POST', body: { confirm: false } })
  assert.equal(refused.json.ok, false)
  assert.equal(store.flows.length, 2)
  assert.deepEqual(calls, [])

  const cleared = await call(routes, '/dsh-flowspot/clear', { method: 'POST', body: { confirm: true } })
  assert.equal(cleared.json.ok, true)
  assert.equal(cleared.json.cleared, 2)
  assert.equal(cleared.json.errorsCleared, true)
  assert.equal(store.flows.length, 0)
  // The upstream failure summary is proxy state, not flow state: clearing the
  // list must clear it too, or the panel keeps failures that no longer exist.
  assert.deepEqual(calls, ['clear-errors'])
})

test('a malformed JSON body answers 400 instead of crashing the route', async () => {
  const { ctx, routes } = fakeHost()
  const { rt } = fakeRuntime()
  mountRoutes(ctx, rt)

  const { status, json } = await call(routes, '/dsh-flowspot/serve', { method: 'POST', body: '{not json' })
  assert.equal(status, 400)
  assert.equal(json.ok, false)
  assert.match(json.error, /JSON/)
})

test('a request body above 1 MiB is rejected', async () => {
  const { ctx, routes } = fakeHost()
  const { rt } = fakeRuntime()
  mountRoutes(ctx, rt)

  const { status, json } = await call(routes, '/dsh-flowspot/serve', {
    method: 'POST',
    body: Buffer.alloc(1024 * 1024 + 16, 0x20),
  })
  assert.equal(status, 400)
  assert.equal(json.ok, false)
})

test('a tool that throws becomes an ok:false payload, not a dropped connection', async () => {
  const { ctx, routes } = fakeHost()
  const { rt } = fakeRuntime()
  rt.start = async () => {
    throw new Error('EADDRINUSE')
  }
  mountRoutes(ctx, rt)

  const { status, json } = await call(routes, '/dsh-flowspot/serve', { method: 'POST', body: { action: 'start' } })
  // webcap_serve catches its own errors and reports them as ok:false.
  assert.equal(status, 200)
  assert.equal(json.ok, false)
  assert.match(json.error, /EADDRINUSE/)
})

test('data-dir: pick opens the native chooser and applies the result', async () => {
  const { ctx, routes } = fakeHost()
  ctx.directoryPicker = { capability: () => ({ kind: 'native', pick: async () => 'E:\\Picked' }) }
  const { rt, calls } = fakeRuntime()
  mountRoutes(ctx, rt)

  const { status, json } = await call(routes, '/dsh-flowspot/data-dir', { method: 'POST', body: { action: 'pick' } })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.dir, 'E:\\Picked')
  assert.equal(json.restartRequired, true)
  assert.deepEqual(calls, ['data-dir:E:\\Picked'])
})

test('data-dir: a cancelled chooser changes nothing', async () => {
  const { ctx, routes } = fakeHost()
  ctx.directoryPicker = { capability: () => ({ kind: 'native', pick: async () => null }) }
  const { rt, calls } = fakeRuntime()
  mountRoutes(ctx, rt)

  const { json } = await call(routes, '/dsh-flowspot/data-dir', { method: 'POST', body: { action: 'pick' } })
  assert.equal(json.ok, true)
  assert.equal(json.cancelled, true)
  assert.deepEqual(calls, [])
})

test('data-dir: a missing or browse-only picker explains the fallback', async () => {
  const first = fakeHost()
  const runtimeA = fakeRuntime()
  mountRoutes(first.ctx, runtimeA.rt)
  const missing = await call(first.routes, '/dsh-flowspot/data-dir', { method: 'POST', body: { action: 'pick' } })
  assert.equal(missing.json.ok, false)
  assert.match(missing.json.error, /目录选择服务/)

  const second = fakeHost()
  second.ctx.directoryPicker = { capability: () => ({ kind: 'browse' }) }
  const runtimeB = fakeRuntime()
  mountRoutes(second.ctx, runtimeB.rt)
  const browse = await call(second.routes, '/dsh-flowspot/data-dir', { method: 'POST', body: { action: 'pick' } })
  assert.equal(browse.json.ok, false)
  assert.match(browse.json.error, /浏览型/)
})

test('data-dir: an explicit path and a reset both go through the runtime', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, calls } = fakeRuntime()
  mountRoutes(ctx, rt)

  const set = await call(routes, '/dsh-flowspot/data-dir', { method: 'POST', body: { dataDir: 'E:\\CaptureData' } })
  assert.equal(set.json.ok, true)
  assert.equal(set.json.dir, 'E:\\CaptureData')

  const reset = await call(routes, '/dsh-flowspot/data-dir', { method: 'POST', body: { action: 'reset' } })
  assert.equal(reset.json.reset, true)
  assert.deepEqual(calls, ['data-dir:E:\\CaptureData', 'data-dir:reset'])

  const missing = await call(routes, '/dsh-flowspot/data-dir', { method: 'POST', body: {} })
  assert.equal(missing.status, 400)
  assert.match(missing.json.error, /dataDir/)
})

test('flows forwards group/normalize and answers grouped payloads', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  for (const t of ['1', '2', '3']) {
    seed(store, { path: '/poll', url: `https://a.example.com/poll?_t=${t}` })
  }
  seed(store, { path: '/other' })

  const flat = await call(routes, '/dsh-flowspot/flows', { query: '?limit=10' })
  assert.equal(flat.json.count, 4)
  assert.equal(flat.json.grouped, undefined)

  // Exact-URL grouping keeps the three _t variants apart.
  const grouped = await call(routes, '/dsh-flowspot/flows', { query: '?group=1&limit=10' })
  assert.equal(grouped.json.grouped, true)
  assert.equal(grouped.json.count, 4)

  // Normalized grouping folds the volatile parameter away.
  const normalized = await call(routes, '/dsh-flowspot/flows', { query: '?group=1&normalize=1&limit=10' })
  assert.equal(normalized.json.count, 2)
  const poll = normalized.json.groups.find((g) => g.path === '/poll')
  assert.equal(poll.count, 3)
  assert.equal(poll.url, 'https://a.example.com/poll')
})

test('detail carries an error hint so a failed flow explains itself', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)

  const flow = store.begin({ method: 'POST', host: 'api.example.com', path: '/x', url: 'https://api.example.com/x' })
  const err = new Error('socket hang up')
  err.code = 'ECONNRESET'
  store.finish(flow, { error: err, errorCode: 'ECONNRESET', errorPhase: 'client' })

  const { json } = await call(routes, '/dsh-flowspot/detail', { query: '?id=f1' })
  assert.equal(json.ok, true)
  assert.equal(json.flow.error, 'socket hang up')
  assert.equal(json.flow.errorCode, 'ECONNRESET')
  assert.equal(json.flow.errorPhase, 'client')
  assert.match(json.flow.errorHint, /上游主动断开/)
})

test('state-changing routes refuse cross-site browser requests', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store)

  const blocked = await call(routes, '/dsh-flowspot/clear', {
    method: 'POST',
    body: { confirm: true },
    headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:3080' },
  })
  assert.equal(blocked.status, 403)
  assert.equal(store.flows.length, 1)

  const foreignOrigin = await call(routes, '/dsh-flowspot/clear', {
    method: 'POST',
    body: { confirm: true },
    headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' },
  })
  assert.equal(foreignOrigin.status, 403)
  assert.equal(store.flows.length, 1)

  // The panel (same origin) and curl (no browser headers) still work.
  const panel = await call(routes, '/dsh-flowspot/clear', {
    method: 'POST',
    body: { confirm: true },
    headers: { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
  })
  assert.equal(panel.status, 200)
  assert.equal(store.flows.length, 0)

  const curl = await call(routes, '/dsh-flowspot/clear', { method: 'POST', body: { confirm: false } })
  assert.equal(curl.status, 200)
  assert.equal(curl.json.ok, false)
})
