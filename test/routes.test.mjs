/**
 * HTTP 路由：面板侧的契约。每条路由都必须转调模型调用的那份工具实现、
 * 一律回 JSON、拒绝错误的方法，并在插件卸载时消失。
 * 运行：node test/routes.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { FlowStore } from '../lib/flows.js'
import { mountRoutes } from '../lib/routes.js'

const SUBTLE = { warn() {} }

const ROUTES = [
  '/dsh-flowspot/body',
  '/dsh-flowspot/bridge/attach',
  '/dsh-flowspot/bridge/command',
  '/dsh-flowspot/bridge/detach',
  '/dsh-flowspot/bridge/events',
  '/dsh-flowspot/bridge/poll',
  '/dsh-flowspot/bridge/result',
  '/dsh-flowspot/ca',
  '/dsh-flowspot/cdp',
  '/dsh-flowspot/cdp/chain',
  '/dsh-flowspot/cdp/code',
  '/dsh-flowspot/cdp/request',
  '/dsh-flowspot/cdp/requests',
  '/dsh-flowspot/cdp/reveal',
  '/dsh-flowspot/cdp/source',
  '/dsh-flowspot/clear',
  '/dsh-flowspot/code',
  '/dsh-flowspot/code-prefs',
  '/dsh-flowspot/data-dir',
  '/dsh-flowspot/detail',
  '/dsh-flowspot/export',
  '/dsh-flowspot/extension/open',
  '/dsh-flowspot/extension/zip',
  '/dsh-flowspot/flows',
  '/dsh-flowspot/logs/open',
  '/dsh-flowspot/search',
  '/dsh-flowspot/serve',
  '/dsh-flowspot/status',
]

/** 一个假的宿主上下文：webServer 只把注册进来的路由记下来，不真的监听端口。 */
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

/** 一个假 runtime：没有真代理、真证书存储、真注册表，只按顺序记录被调用了哪些动作。 */
function fakeRuntime() {
  const store = new FlowStore({ log: SUBTLE })
  const calls = []
  const rt = {
    store,
    calls,
    logDir: 'C:\\fake\\dsh-flowspot\\logs',
    readLogs: (options) => {
      calls.push(`logs:${options.limit || ''}:${options.level || ''}:${options.event || ''}`)
      return [
        { ts: '2026-10-24T10:00:01.000Z', level: 'info', event: 'capture-start', detail: { port: 8899 } },
        { ts: '2026-10-24T10:00:02.000Z', level: 'warn', event: 'cdp-disconnect', detail: { reason: 'closed' } },
      ]
    },
    openLogsDir: () => {
      calls.push('log-open')
      return { ok: true, dir: 'C:\\fake\\dsh-flowspot\\logs' }
    },
    revealSources: (key) => {
      calls.push(`reveal:${key || ''}`)
      return { ok: true, dir: 'C:\\fake\\dsh-flowspot\\scripts', missing: Boolean(key) }
    },
    // 失败汇总挂在 proxy 上而不是 store 上，所以 clear 也得顺手把它重置。
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
      cdp: { enabled: false, connected: false, targets: [], requests: 0, scripts: 0 },
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
    extensionZip: () => ({ ok: true, buffer: Buffer.from('PK\u0003\u0004zip'), filename: 'bridge.zip' }),
    openExtensionDir: () => {
      calls.push('extension-open')
      return { ok: true, dir: 'C:\\fake\\extension' }
    },
    // CDP 通道替身：路由只验证转调与契约，不连浏览器。
    cdp: {
      status: () => ({ enabled: false, connected: false, targets: [], requests: 0, scripts: 0 }),
      ensure: async () => {},
      launch: async () => {
        calls.push('cdp-launch')
        return { enabled: true, connected: true, port: 9222, targets: [], requests: 0, scripts: 0 }
      },
      attach: async ({ port }) => {
        calls.push(`cdp-attach:${port}`)
        return { enabled: true, connected: true, port }
      },
      detach: async () => {
        calls.push('cdp-detach')
        return { enabled: false, connected: false }
      },
      closeBrowser: async () => {
        calls.push('cdp-close')
        return { enabled: false, connected: false }
      },
      attachExtension: async ({ tabId, title }) => {
        calls.push(`bridge-attach:${tabId}`)
        return { connected: true, bridge: { tabId, title } }
      },
      detachBridge: async () => {
        calls.push('bridge-detach')
        return { connected: false, bridge: null }
      },
      bridgeEvent: (event) => calls.push(`bridge-event:${event.method}`),
      bridgeResult: (result) => calls.push(`bridge-result:${result.id}`),
      waitBridgeCommand: async () => null,
      markExtensionSeen: () => calls.push('extension-seen'),
      codeFlowOf: (id) => {
        calls.push(`cdp-code-flow:${id}`)
        return {
          id,
          method: 'GET',
          url: 'https://api.example.com/v1/items?page=2',
          scheme: 'https',
          host: 'api.example.com',
          port: 443,
          path: '/v1/items?page=2',
          reqHeaders: { accept: 'application/json' },
          reqBody: null,
          status: 200,
        }
      },
      requestDetail: (id) => {
        calls.push(`cdp-request:${id}`)
        return { id, method: 'POST', url: 'https://api.example.com/sign', requestHeaders: { accept: '*/*' }, postData: 'a=1' }
      },
      clearRequests: () => {
        calls.push('cdp-clear')
        return { enabled: true, connected: true, requests: 0 }
      },
      requestBridge: async (action, params) => {
        calls.push(`bridge-command:${action}:${params.tabId || ''}`)
        if (action === 'tabs') return { tabs: [{ id: 7, title: 'Demo', url: 'https://app.example.com' }] }
        return { status: { attached: true } }
      },
      requests: async (options) => {
        calls.push(`cdp-requests:${options.limit || ''}`)
        return [{ id: 'x1', method: 'GET', url: 'https://api.example.com/x', status: 200, flowId: 'f1' }]
      },
      chain: async (flow, options) => {
        calls.push(`cdp-chain:${flow.id}:${options.withSource}`)
        return {
          matched: true,
          request: { method: flow.method, url: flow.url, status: 200, documentURL: 'https://app.example.com/order' },
          target: { targetId: 't1', type: 'page', title: 'Demo' },
          initiator: { type: 'script', frames: [{ functionName: 'sign', url: 'https://app/main.js', lineNumber: 10 }] },
          params: [],
        }
      },
      scriptList: () => [{ key: 's1:1', label: 'https://app/main.js', url: 'https://app/main.js' }],
      scriptGet: async ({ key }) => ({ key, label: 'https://app/main.js', totalChars: 3, offset: 0, text: 'abc' }),
      scriptSearch: async () => [{ key: 's1:1', label: 'https://app/main.js', lineNumber: 3, lineContent: 'sign()' }],
      sourceOf: async ({ key, line }) => ({ key, label: 'https://app/main.js', line: line + 1, code: '1: abc' }),
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
 * 按浏览器的方式调用一条路由：请求体用可读流喂进去，响应对象负责记录状态码、
 * 响应头和 JSON 内容。
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
    // data-dir 路由会监听 'close' 事件来中止还没选完的目录选择，所以这里得提供 on/off。
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

// 二十六条路由、路径精确匹配、dispose 后一条不剩：旧版本残留的路由不该继续响应。
test('mounts the twenty-eight panel routes as exact paths and removes them on dispose', () => {
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

// /status 一次把代理、CA、系统代理和 flow 汇总都带回来，面板打开时只需一个请求。
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

// 面板（走路由）和工具读的是同一个 store：两边数字对不上就说明契约破了。
test('status and flows read the same store, so panel and tools cannot disagree', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store)

  const status = await call(routes, '/dsh-flowspot/status')
  const flows = await call(routes, '/dsh-flowspot/flows', { query: '?limit=10' })
  assert.equal(status.json.flows.total, flows.json.count)
})

// 会改状态的路由只认 POST：浏览器里一个 GET 就能触发就太危险了。
test('mutating routes refuse GET with 405', async () => {
  const { ctx, routes } = fakeHost()
  const { rt } = fakeRuntime()
  mountRoutes(ctx, rt)

  for (const path of [
    '/dsh-flowspot/serve',
    '/dsh-flowspot/ca',
    '/dsh-flowspot/clear',
    '/dsh-flowspot/data-dir',
    '/dsh-flowspot/cdp',
    '/dsh-flowspot/logs/open',
    '/dsh-flowspot/bridge/attach',
    '/dsh-flowspot/bridge/command',
    '/dsh-flowspot/bridge/events',
    '/dsh-flowspot/bridge/result',
    '/dsh-flowspot/bridge/detach',
    '/dsh-flowspot/cdp/reveal',
    '/dsh-flowspot/extension/open',
  ]) {
    const { status, json } = await call(routes, path)
    assert.equal(status, 405, `${path} must reject GET`)
    assert.equal(json.ok, false)
  }
})

// start 之后要立刻读回系统代理状态，面板才能显示「已接管」。
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

// 每个筛选参数都必须真的转给 store；漏掉一个，面板上的筛选就会静默失效。
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

  // 资源类型也会透传；text/html 归到「文档」（doc）那一组。
  seed(store, { host: 'site.example.com', path: '/page', mime: 'text/html', body: '<html></html>' })
  const byType = await call(routes, '/dsh-flowspot/flows', { query: '?type=doc&limit=10' })
  assert.equal(byType.json.count, 1)
  assert.equal(byType.json.flows[0].path, '/page')
  assert.equal(byType.json.flows[0].type, 'doc')

  // 数字参数是垃圾时退化成「不筛选」，而不是变成一个 NaN 条件把结果全滤掉。
  const garbage = await call(routes, '/dsh-flowspot/flows', { query: '?limit=abc&status=xyz' })
  assert.equal(garbage.json.ok, true)
  assert.equal(garbage.json.count, 4)
})

// 详情只带元信息，body 一律不内联：大 body 走 /body 分页取，免得一次回几百 KB。
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
  // 把响应体换成不是合法文本的字节，专门走 base64 分支。
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

// 导出要覆盖 curl、HAR、JSON 三种格式，每种回的内容都得能被下游直接拿去用。
test('export renders curl, HAR and JSON documents', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store, { path: '/a' })
  seed(store, { path: '/b' })

  const curl = await call(routes, '/dsh-flowspot/export', { query: '?format=curl&id=f1' })
  assert.equal(curl.json.ok, true)
  assert.match(curl.json.curl, /^curl 'https:\/\/api\.example\.com\/a'/)

  const har = await call(routes, '/dsh-flowspot/export', { query: '?format=har&limit=2' })
  assert.equal(har.json.ok, true)
  assert.equal(har.json.document.log.version, '1.2')
  assert.equal(har.json.document.log.entries.length, 2)

  const json = await call(routes, '/dsh-flowspot/export', { query: '?format=json&limit=2' })
  assert.equal(json.json.format, 'json')
  assert.equal(json.json.count, 2)

  // 未知格式退回 curl，而不是报错。
  const fallback = await call(routes, '/dsh-flowspot/export', { query: '?format=wat&id=f2' })
  assert.equal(fallback.json.format, 'curl')

  const unknown = await call(routes, '/dsh-flowspot/export', { query: '?format=curl&id=f99' })
  assert.equal(unknown.json.ok, false)
})

// code 路由有两副面孔：带 id + lang 时生成脚本，不带 lang 时只列出可选语言。
test('code renders a script and lists the languages in preference order', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store, { path: '/v1/items' })

  const python = await call(routes, '/dsh-flowspot/code', { query: '?id=f1&lang=python' })
  assert.equal(python.json.ok, true)
  assert.equal(python.json.lang, 'python')
  assert.match(python.json.code, /response = requests\.get\(url/)
  assert.ok(Array.isArray(python.json.notes))

  // 不带 lang 是「我能选哪些语言」的查询，因此不能要求传 id。
  const list = await call(routes, '/dsh-flowspot/code')
  assert.equal(list.json.ok, true)
  assert.equal(list.json.langs.length, 6)
  assert.equal(list.json.langs[0].id, 'curl')

  const unknown = await call(routes, '/dsh-flowspot/code', { query: '?id=f99&lang=python' })
  assert.equal(unknown.json.ok, false)
})

// CDP 抓到的请求也要能转脚本：走同一条 webcap_code，只是 id 换成 CDP 请求 id。
test('cdp code renders a script for a request captured from the tab', async () => {
  const { ctx, routes } = fakeHost()
  const { rt } = fakeRuntime()
  mountRoutes(ctx, rt)
  // fake runtime 里 codeFlowOf 返回与 seed 同样的 flow 形状。
  const python = await call(routes, '/dsh-flowspot/cdp/code', { query: `?id=${encodeURIComponent('ext:9:r1')}&lang=python` })
  assert.equal(python.json.ok, true)
  assert.equal(python.json.lang, 'python')
  assert.match(python.json.code, /requests\./)
})

// 「打开源码所在文件夹」：面板发 key 就选中那个文件，不带 key 就开目录。
test('cdp reveal opens the script location', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, calls } = fakeRuntime()
  mountRoutes(ctx, rt)

  const one = await call(routes, '/dsh-flowspot/cdp/reveal', { method: 'POST', body: { key: 'ext:9:5' } })
  assert.equal(one.json.ok, true)
  assert.ok(calls.includes('reveal:ext:9:5'))

  const dir = await call(routes, '/dsh-flowspot/cdp/reveal', { method: 'POST', body: {} })
  assert.equal(dir.json.ok, true)
  assert.ok(calls.includes('reveal:'))
})

// code-prefs 的契约：记住顺序与显隐；带 sec-fetch-site: cross-site 的 POST 一律 403。
test('code-prefs stores order and visibility, and refuses cross-site POST', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-prefs-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = fakeHost()
    const { rt } = fakeRuntime()
    mountRoutes(ctx, rt)

    const saved = await call(routes, '/dsh-flowspot/code-prefs', {
      method: 'POST',
      body: { order: ['node', 'curl', 'python', 'go', 'rust', 'javascript'], hidden: ['rust'] },
    })
    assert.equal(saved.json.ok, true)
    assert.equal(saved.json.langs[0].id, 'node')
    assert.equal(saved.json.langs.find((lang) => lang.id === 'rust').hidden, true)

    const read = await call(routes, '/dsh-flowspot/code-prefs')
    assert.equal(read.json.ok, true)
    assert.equal(read.json.order[0], 'node')

    const crossSite = await call(routes, '/dsh-flowspot/code-prefs', {
      method: 'POST',
      body: { order: ['curl'], hidden: [] },
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(crossSite.status, 403)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// CDP 的四个入口只验证「转调到通道」与契约；通道本身在 test/cdp.test.mjs。
test('cdp: launch, requests, chain and source go through the channel', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, store, calls } = fakeRuntime()
  mountRoutes(ctx, rt)
  seed(store)

  const launched = await call(routes, '/dsh-flowspot/cdp', { method: 'POST', body: { action: 'launch' } })
  assert.equal(launched.json.ok, true)
  assert.equal(launched.json.connected, true)
  assert.ok(calls.includes('cdp-launch'))

  const requests = await call(routes, '/dsh-flowspot/cdp/requests', { query: '?limit=5' })
  assert.equal(requests.json.ok, true)
  assert.equal(requests.json.requests[0].flowId, 'f1')

  const request = await call(routes, '/dsh-flowspot/cdp/request', { query: '?id=c1' })
  assert.equal(request.json.ok, true)
  assert.equal(request.json.request.method, 'POST')
  assert.ok(calls.includes('cdp-request:c1'))

  const cleared = await call(routes, '/dsh-flowspot/cdp', { method: 'POST', body: { action: 'clear' } })
  assert.equal(cleared.json.ok, true)
  assert.ok(calls.includes('cdp-clear'))

  const chain = await call(routes, '/dsh-flowspot/cdp/chain', { query: '?id=f1&source=0' })
  assert.equal(chain.json.ok, true)
  assert.equal(chain.json.matched, true)
  assert.ok(calls.includes('cdp-chain:f1:false'))

  const source = await call(routes, '/dsh-flowspot/cdp/source', { query: '?key=s1%3A1&line=2' })
  assert.equal(source.json.ok, true)
  assert.equal(source.json.line, 3)
  assert.equal(source.json.code, '1: abc')
})

test('cdp: cross-site POST is refused and missing ids answer 400', async () => {
  const { ctx, routes } = fakeHost()
  const { rt } = fakeRuntime()
  mountRoutes(ctx, rt)

  const crossSite = await call(routes, '/dsh-flowspot/cdp', {
    method: 'POST',
    body: { action: 'launch' },
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)

  const missingId = await call(routes, '/dsh-flowspot/cdp/chain')
  assert.equal(missingId.status, 400)

  const missingKey = await call(routes, '/dsh-flowspot/cdp/source')
  assert.equal(missingKey.status, 400)
})

// 日志只保留「打开文件夹」这一条面板入口；读取仍走 agent 的 webcap_logs。
test('logs: opens the folder and refuses cross-site POST', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, calls } = fakeRuntime()
  mountRoutes(ctx, rt)

  const opened = await call(routes, '/dsh-flowspot/logs/open', { method: 'POST' })
  assert.equal(opened.json.ok, true)
  assert.equal(opened.json.dir, 'C:\\fake\\dsh-flowspot\\logs')
  assert.ok(calls.includes('log-open'))

  const crossSite = await call(routes, '/dsh-flowspot/logs/open', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)
})

test('bridge: attach, events, result, poll and detach go through the channel', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, calls } = fakeRuntime()
  mountRoutes(ctx, rt)

  const attached = await call(routes, '/dsh-flowspot/bridge/attach', {
    method: 'POST',
    body: { tabId: 11, title: 'Demo', url: 'https://app.example.com' },
  })
  assert.equal(attached.json.ok, true)
  assert.equal(attached.json.bridge.tabId, 11)
  assert.ok(calls.includes('bridge-attach:11'))

  const events = await call(routes, '/dsh-flowspot/bridge/events', {
    method: 'POST',
    body: { events: [{ method: 'Network.requestWillBeSent', params: {} }, { method: 'Debugger.scriptParsed', params: {} }] },
  })
  assert.equal(events.json.ok, true)
  assert.equal(events.json.count, 2)
  assert.ok(calls.includes('bridge-event:Network.requestWillBeSent'))

  const result = await call(routes, '/dsh-flowspot/bridge/result', {
    method: 'POST',
    body: { id: 3, result: {} },
  })
  assert.equal(result.json.ok, true)
  assert.ok(calls.includes('bridge-result:3'))

  const poll = await call(routes, '/dsh-flowspot/bridge/poll')
  assert.equal(poll.json.ok, true)
  assert.equal(poll.json.command, null)

  // 整份脚本源码的回包就是这个量级（单脚本上限 4MB，实测小红书 1.6~3.2MB）：
  // 桥接回包必须放得下，不能再被面板那套 1MB 上限掐掉——掐掉时宿主只会看到「CDP 命令超时」。
  const bigScript = 'x'.repeat(5 * 1024 * 1024)
  const bigResult = await call(routes, '/dsh-flowspot/bridge/result', {
    method: 'POST',
    body: { id: 11, result: { scriptSource: bigScript } },
  })
  assert.equal(bigResult.status, 200)
  assert.equal(bigResult.json.ok, true)
  assert.ok(calls.includes('bridge-result:11'))

  const tabs = await call(routes, '/dsh-flowspot/bridge/command', { method: 'POST', body: { action: 'tabs' } })
  assert.equal(tabs.json.ok, true)
  assert.equal(tabs.json.result.tabs[0].id, 7)
  assert.ok(calls.includes('bridge-command:tabs:'))

  const detached = await call(routes, '/dsh-flowspot/bridge/detach', { method: 'POST' })
  assert.equal(detached.json.ok, true)
  assert.ok(calls.includes('bridge-detach'))
})

test('extension: zip downloads and the folder can be opened', async () => {
  const { ctx, routes } = fakeHost()
  const { rt, calls } = fakeRuntime()
  mountRoutes(ctx, rt)

  const zip = await call(routes, '/dsh-flowspot/extension/zip')
  assert.equal(zip.status, 200)
  assert.match(zip.headers['content-type'], /application\/zip/)
  assert.match(zip.headers['content-disposition'], /bridge\.zip/)
  assert.equal(zip.text.startsWith('PK'), true)

  const opened = await call(routes, '/dsh-flowspot/extension/open', { method: 'POST' })
  assert.equal(opened.json.ok, true)
  assert.equal(opened.json.dir, 'C:\\fake\\extension')
  assert.ok(calls.includes('extension-open'))

  const crossSite = await call(routes, '/dsh-flowspot/extension/open', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)
})

// clear 是破坏性操作：不带 confirm=true 时什么都不能动，连 proxy 的失败汇总也不能碰。
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
  // 上游失败汇总是 proxy 状态、不是 flow 状态：清空列表时必须一并清掉，
  // 否则面板会一直挂着已经不存在的失败。
  assert.deepEqual(calls, ['clear-errors'])
})

// 请求体不是合法 JSON 时回 400，不能让一个解析异常把整条路由打崩。
test('a malformed JSON body answers 400 instead of crashing the route', async () => {
  const { ctx, routes } = fakeHost()
  const { rt } = fakeRuntime()
  mountRoutes(ctx, rt)

  const { status, json } = await call(routes, '/dsh-flowspot/serve', { method: 'POST', body: '{not json' })
  assert.equal(status, 400)
  assert.equal(json.ok, false)
  assert.match(json.error, /JSON/)
})

// 1 MiB 以上的请求体直接拒绝：面板自己不会发这么大的，这是给外部调用设的闸。
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

// 工具抛错要变成 ok:false 的 JSON，而不是一条断开的连接：面板才能把原因显示出来。
test('a tool that throws becomes an ok:false payload, not a dropped connection', async () => {
  const { ctx, routes } = fakeHost()
  const { rt } = fakeRuntime()
  rt.start = async () => {
    throw new Error('EADDRINUSE')
  }
  mountRoutes(ctx, rt)

  const { status, json } = await call(routes, '/dsh-flowspot/serve', { method: 'POST', body: { action: 'start' } })
  // webcap_serve 自己会兜住异常并回成 ok:false，不会把连接弄断。
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

  // 按完整 URL 合并时，三个 _t 变体仍是三行。
  const grouped = await call(routes, '/dsh-flowspot/flows', { query: '?group=1&limit=10' })
  assert.equal(grouped.json.grouped, true)
  assert.equal(grouped.json.count, 4)

  // 开启 normalize 后，易变的那个参数被忽略，三行并成一行。
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

// 改状态的路由要挡掉跨站请求：别的网页不能借用户浏览器悄悄清空抓包数据。
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

  // 面板（同源）和 curl（没有浏览器头）都必须照常放行。
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
