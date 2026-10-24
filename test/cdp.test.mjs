/**
 * CDP 通道的契约测试：不启动浏览器、不连真实 WebSocket。
 *
 * 覆盖四块能独立验证的核心：
 *  1. CdpClient 的 id/pending/事件/超时；
 *  2. 网络请求索引与「方法 + URL + 时间窗」的 FIFO 配对；
 *  3. 参数分析（静态/动态）与脚本窗口；
 *  4. 通道对一条 flow 拼出的调用链（手工塞入一条 CDP 请求）。
 *
 * 运行：node test/cdp.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CdpClient } from '../lib/cdp/client.js'
import { filterFrames, flattenFrames, isNoiseFrame, topFrame } from '../lib/cdp/initiator.js'
import { CdpChannel } from '../lib/cdp/index.js'
import {
  browserCandidates,
  buildLaunchArgs,
  processAlive,
  probeVersion,
  readDevToolsActivePort,
} from '../lib/cdp/launch.js'
import { CdpNetworkIndex } from '../lib/cdp/network.js'
import { analyseParams, flattenJson, pairsOf } from '../lib/cdp/params.js'
import { ScriptIndex, charOffsetOf, columnWindow, lineAt, lineWindow, occurrencesOf } from '../lib/cdp/scripts.js'
import { SourceStore } from '../lib/cdp/sourceStore.js'
import { isBusinessRequest } from '../lib/cdp/sourceFilter.js'
import { formatFragment } from '../lib/cdp/format.js'
import { FlowStore } from '../lib/flows.js'

const quiet = { warn() {}, info() {}, error() {}, event() {} }

/** 一个只记录、可手推消息的 WebSocket 替身。 */
function fakeTransport() {
  const listeners = { message: [], close: [] }
  const sent = []
  return {
    sent,
    send: (text) => sent.push(JSON.parse(text)),
    close: () => listeners.close.forEach((handler) => handler('closed')),
    onMessage: (handler) => listeners.message.push(handler),
    onClose: (handler) => listeners.close.push(handler),
    emit: (message) => listeners.message.forEach((handler) => handler(JSON.stringify(message))),
  }
}

test('CdpClient matches responses by id, rejects errors and dispatches events', async () => {
  const transport = fakeTransport()
  const events = []
  const client = new CdpClient(transport, { onEvent: (message) => events.push(message.method) })
  const pending = client.send('Network.enable', { maxPostDataSize: 1 }, 'session-1')
  assert.deepEqual(transport.sent[0], {
    id: 1,
    method: 'Network.enable',
    params: { maxPostDataSize: 1 },
    sessionId: 'session-1',
  })
  transport.emit({ id: 1, result: { ok: true } })
  assert.deepEqual(await pending, { ok: true })

  const failed = client.send('Debugger.enable')
  transport.emit({ id: 2, error: { message: 'not allowed' } })
  await assert.rejects(failed, /Debugger\.enable: not allowed/)

  transport.emit({ method: 'Network.requestWillBeSent', params: {}, sessionId: 'session-1' })
  assert.deepEqual(events, ['Network.requestWillBeSent'])
})

test('CdpClient times out a command and rejects pending calls when closed', async () => {
  const transport = fakeTransport()
  const client = new CdpClient(transport, { timeoutMs: 30 })
  await assert.rejects(client.send('Page.enable'), /CDP 命令超时：Page\.enable/)

  const pending = client.send('Page.enable')
  client.close()
  await assert.rejects(pending, /CDP 连接已关闭/)
  assert.equal(client.connected, false)
})

test('network entries pair with flows FIFO inside the time window, including polling', () => {
  const index = new CdpNetworkIndex()
  const base = Date.now()
  const add = (offset, url = 'https://api.example.com/v2/poll') => index.add({
    sessionId: 's1',
    targetId: 't1',
    params: {
      requestId: `r${offset}`,
      wallTime: (base + offset) / 1000,
      type: 'XHR',
      initiator: { type: 'script', stack: { callFrames: [{ functionName: 'poll', url: 'https://app/main.js', lineNumber: 3, scriptId: '1' }] } },
      request: { method: 'POST', url },
    },
  })

  add(-2000)
  add(-1000)
  add(0)

  const first = { id: 'f1', method: 'POST', url: 'https://api.example.com/v2/poll', startedAt: base - 1900, ts: base - 1900 }
  const second = { id: 'f2', method: 'POST', url: 'https://api.example.com/v2/poll', startedAt: base - 900, ts: base - 900 }
  assert.equal(index.match(first).matchedFlowId, 'f1')
  assert.equal(index.match(second).matchedFlowId, 'f2')
  // Re-reading the same flow returns the same entry; it must not consume the
  // next poll entry that belongs to a later flow.
  assert.equal(index.match(first).matchedFlowId, 'f1')
  // Already paired entries cannot be borrowed by a later flow.
  assert.equal(index.match({ id: 'f3', method: 'POST', url: 'https://api.example.com/v2/poll', startedAt: base - 1900, ts: base - 1900 }), null)

  // Outside the window: five seconds before is the oldest accepted edge.
  const stale = index.add({ sessionId: 's1', targetId: 't1', params: { requestId: 'old', wallTime: (base - 6000) / 1000, request: { method: 'GET', url: 'https://api.example.com/old' } } })
  assert.equal(stale.at, base - 6000)
  assert.equal(index.match({ id: 'f9', method: 'GET', url: 'https://api.example.com/old', startedAt: base, ts: base }), null)
})

test('network index records redirects as separate entries and filters lists', () => {
  const index = new CdpNetworkIndex()
  const base = Date.now()
  const request = (requestId, url, redirectResponse) => index.add({
    sessionId: 's1',
    targetId: 't1',
    params: {
      requestId,
      wallTime: base / 1000,
      type: 'Document',
      redirectResponse,
      request: { method: 'GET', url },
    },
  })
  request('r1', 'https://a.example.com/start')
  request('r1', 'https://a.example.com/next', { status: 302 })
  index.noteResponse({ sessionId: 's1', params: { requestId: 'r1', response: { status: 200, mimeType: 'text/html' } } })

  assert.equal(index.size, 2)
  const list = index.requests({ limit: 10 })
  assert.equal(list.length, 2)
  assert.equal(list[0].url, 'https://a.example.com/next')
  assert.equal(list[0].status, 200)
  assert.equal(index.requests({ host: 'start', limit: 10 }).length, 1)
  assert.equal(index.requests({ matched: true, limit: 10 }).length, 0)
})

test('matching prefers the same URL entry that actually carries a stack', () => {
  const index = new CdpNetworkIndex()
  const base = Date.now()
  index.add({
    sessionId: 's1',
    targetId: 't1',
    params: { requestId: 'empty', wallTime: base / 1000, type: 'XHR', request: { method: 'GET', url: 'https://api.example.com/feed' } },
  })
  index.add({
    sessionId: 's1',
    targetId: 't1',
    params: {
      requestId: 'rich',
      wallTime: (base + 100) / 1000,
      type: 'XHR',
      request: { method: 'GET', url: 'https://api.example.com/feed' },
      initiator: { type: 'script', stack: { callFrames: [{ functionName: 'loadFeed', url: 'https://app/main.js', lineNumber: 10 }] } },
    },
  })
  const matched = index.match({ id: 'f1', method: 'GET', url: 'https://api.example.com/feed', startedAt: base + 50, ts: base + 50 })
  assert.equal(matched.requestId, 'rich')
  assert.equal(matched.matchedFlowId, 'f1')
})

test('params flatten a JSON body and mark values static or dynamic across calls', () => {
  const store = new FlowStore({ log: quiet })
  const make = (body, query = '?page=2') => {
    const flow = store.begin({
      method: 'POST',
      host: 'api.example.com',
      port: 443,
      path: `/v1/items${query}`,
      url: `https://api.example.com/v1/items${query}`,
      reqHeaders: { 'content-type': 'application/json' },
    })
    store.setRequestBody(flow, Buffer.from(body))
    store.finish(flow, { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') })
    return flow
  }
  const first = make('{"user":{"id":7},"ts":1}')
  const second = make('{"user":{"id":7},"ts":2}')

  const spec = pairsOf(first)
  assert.deepEqual(spec.map((pair) => pair.name), ['page', 'user.id', 'ts'])
  assert.deepEqual(flattenJson({ a: { b: 1 }, list: [1] }), [['a.b', 1], ['list[0]', 1]])

  const params = analyseParams(first, [second])
  const byName = Object.fromEntries(params.map((param) => [param.name, param]))
  assert.equal(byName.page.stability, 'static')
  assert.equal(byName['user.id'].stability, 'static')
  assert.equal(byName.ts.stability, 'dynamic')
  assert.deepEqual(byName.ts.values, ['1', '2'])
  assert.equal(byName.ts.samples, 2)
})

test('script windows are numbered and the column helper locates a call point', () => {
  const source = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')
  const window = lineWindow(source, 9, 2)
  assert.equal(window.startLine, 8)
  assert.equal(window.endLine, 12)
  assert.match(window.code, /^\s+9 {2}line 9/m)
  assert.match(window.code, /^\s+12 {2}line 12/m)

  // 行/列 → 字符偏移：第 3 行第 5 列（0 基）是前面两行加换行 + 4。
  assert.equal(charOffsetOf('aaaa\nbbbb\ncccc', 2, 0), 10)
  assert.equal(charOffsetOf('aaaa\nbbbb\ncccc', 1, 2), 7)
  const narrow = columnWindow('0123456789', 5, 400)
  assert.equal(narrow.text, '0123456789')
  assert.deepEqual(narrow.highlight, { start: 5, end: 10 })
  // 索引只留元数据，不再缓存源码。
  const index = new ScriptIndex()
  index.noteParsed('s1', { scriptId: '1', url: 'https://app/a.js' })
  assert.equal(index.list({ q: 'a.js' }).length, 1)
  assert.equal(index.getMeta('s1:1').url, 'https://app/a.js')
})

test('launch helpers build a debugging profile and parse DevToolsActivePort', () => {
  const args = buildLaunchArgs({ profileDir: 'C:\\p', proxyPort: 8899 })
  assert.ok(args.includes('--remote-debugging-port=0'))
  assert.ok(args.includes('--user-data-dir=C:\\p'))
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:8899'))
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>'))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-cdp-'))
  try {
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '51234\n/devtools/browser/abc\n', 'utf8')
    assert.deepEqual(readDevToolsActivePort(dir), { port: 51234, wsPath: '/devtools/browser/abc' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  const candidates = browserCandidates('C:\\custom\\chrome.exe', {
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  })
  assert.equal(candidates[0], 'C:\\custom\\chrome.exe')
  assert.ok(candidates.some((item) => item.endsWith('chrome.exe')))
  assert.ok(candidates.some((item) => item.endsWith('msedge.exe')))
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(99999999), false)
})

test('probeVersion reads /json/version from a debugging endpoint', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/json/version')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ Browser: 'Chrome/155.0', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/x' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const version = await probeVersion(server.address().port)
    assert.equal(version.Browser, 'Chrome/155.0')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a channel assembles the call chain for a flow from a recorded CDP request', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const store = new FlowStore({ log: quiet })
    const flow = store.begin({
      method: 'POST',
      host: 'api.example.com',
      port: 443,
      path: '/v1/items?page=2',
      url: 'https://api.example.com/v1/items?page=2',
      reqHeaders: { 'content-type': 'application/json' },
      startedAt: Date.now(),
    })
    store.setRequestBody(flow, Buffer.from('{"sign":"abc","fixed":1}'))
    store.finish(flow, { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') })

    const sibling = store.begin({
      method: 'POST',
      host: 'api.example.com',
      port: 443,
      path: '/v1/items?page=2',
      url: 'https://api.example.com/v1/items?page=2',
      reqHeaders: { 'content-type': 'application/json' },
      startedAt: Date.now() - 100,
    })
    store.setRequestBody(sibling, Buffer.from('{"sign":"def","fixed":1}'))
    store.finish(sibling, { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') })

    const channel = new CdpChannel({ log: quiet, getProxyPort: () => 8899 })
    channel.sessions.set('s1', { sessionId: 's1', targetId: 't1', type: 'page', title: 'Demo', url: 'https://app.example.com' })
    channel.targets.set('t1', { targetId: 't1', type: 'page', title: 'Demo', url: 'https://app.example.com' })
    channel.network.add({
      sessionId: 's1',
      targetId: 't1',
      params: {
        requestId: 'r1',
        wallTime: flow.startedAt / 1000,
        type: 'XHR',
        documentURL: 'https://app.example.com/order',
        initiator: {
          type: 'script',
          stack: {
            callFrames: [
              { functionName: 'signRequest', url: 'https://app.example.com/main.js', lineNumber: 99, columnNumber: 3, scriptId: '7' },
              { functionName: 'submit', url: 'https://app.example.com/main.js', lineNumber: 120, columnNumber: 1, scriptId: '7' },
            ],
          },
        },
        request: { method: 'POST', url: flow.url },
      },
    })

    const chain = await channel.chain(flow, { store, withSource: false })
    assert.equal(chain.matched, true)
    assert.equal(chain.target.title, 'Demo')
    assert.equal(chain.request.documentURL, 'https://app.example.com/order')
    assert.equal(chain.initiator.frames[0].functionName, 'signRequest')
    assert.equal(chain.initiator.frames[0].lineNumber, 100)
    assert.equal(chain.initiator.frames[0].scriptKey, 's1:7')

    const byName = Object.fromEntries(chain.params.map((param) => [param.name, param]))
    assert.equal(byName.sign.stability, 'dynamic')
    assert.equal(byName.fixed.stability, 'static')

    // A flow that never reached the browser still gets its parameter analysis.
    const lonely = store.begin({ method: 'GET', host: 'other.example.com', port: 443, path: '/x', url: 'https://other.example.com/x', reqHeaders: {} })
    store.finish(lonely, { status: 200, headers: {}, body: Buffer.alloc(0) })
    const unmatched = await channel.chain(lonely, { store })
    assert.equal(unmatched.matched, false)
    assert.ok(Array.isArray(unmatched.params))

    channel.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('bridge control actions resolve tabs from result envelope and legacy top-level', async () => {
  const channel = new CdpChannel({ log: quiet })

  const wrapped = channel.requestBridge('tabs', {}, 5000)
  const first = await channel.waitBridgeCommand(100)
  assert.equal(first.action, 'tabs')
  channel.bridgeResult({ id: first.id, result: { tabs: [{ id: 1 }] } })
  assert.deepEqual(await wrapped, { tabs: [{ id: 1 }] })

  const legacy = channel.requestBridge('tabs', {}, 5000)
  const second = await channel.waitBridgeCommand(100)
  channel.bridgeResult({ id: second.id, tabs: [{ id: 2 }] })
  assert.deepEqual(await legacy, { tabs: [{ id: 2 }] })

  channel.dispose()
})

test('filters adapter/framework frames out of the call chain', () => {
  const frames = [
    { functionName: 'xhrAdapter', url: 'https://app.example.com/vendor.js', lineNumber: 10 },
    { functionName: '(anonymous)', url: 'https://app.example.com/app.js', lineNumber: 20 },
    { functionName: 'signRequest', url: 'https://app.example.com/app.js', lineNumber: 30 },
    { functionName: 'submitOrder', url: 'https://app.example.com/order.js', lineNumber: 40 },
    { functionName: 'step', url: 'https://app.example.com/polyfill.js', lineNumber: 50 },
    { functionName: 'internal', url: 'chrome-extension://abc/x.js', lineNumber: 60 },
  ]
  assert.equal(isNoiseFrame(frames[0]), true)
  assert.equal(isNoiseFrame(frames[5]), true)
  assert.deepEqual(filterFrames(frames).map((frame) => frame.functionName), ['signRequest', 'submitOrder'])
})

test('flattening the initiator follows async parents and marks each section', () => {
  const stack = {
    callFrames: [
      { functionName: '', url: 'https://app.example.com/async/9760.js', lineNumber: 0, columnNumber: 5279 },
      { functionName: '_ace_b30', url: 'https://app.example.com/async/9760.js', lineNumber: 0, columnNumber: 1606 },
    ],
    parent: {
      callFrames: [
        { functionName: 'xhrAdapter', url: 'https://app.example.com/vendor.js', lineNumber: 10 },
        { functionName: 'fetchFeeds', url: 'https://app.example.com/index.js', lineNumber: 20 },
      ],
      parent: { callFrames: [{ functionName: 'onListEnd', url: 'https://app.example.com/index.js', lineNumber: 30 }] },
    },
  }
  const frames = flattenFrames(stack)
  assert.deepEqual(frames.map((frame) => frame.functionName), ['', '_ace_b30', 'xhrAdapter', 'fetchFeeds', 'onListEnd'])
  assert.deepEqual(frames.map((frame) => frame.asyncLevel), [0, 0, 1, 1, 2])
  assert.deepEqual(frames.map((frame) => frame.anonymous), [true, false, false, false, false])
  // CDP 给匿名函数的是空串：它和字面量 '(anonymous)' 都要算壳，别再挡住业务帧。
  assert.equal(isNoiseFrame(frames[0]), true)
  assert.equal(isNoiseFrame({ functionName: '(anonymous)' }), true)
  // 列表的「发起于」取第一个业务帧，而不是一排匿名帧里的第一个。
  assert.equal(topFrame(frames).functionName, 'fetchFeeds')
  // 层数上限：只留同步段 + 第一段。
  assert.equal(flattenFrames(stack, 1).length, 4)
  // parent 成环时不能死循环。
  const cyclic = { callFrames: [{ functionName: 'loop' }] }
  cyclic.parent = cyclic
  assert.equal(flattenFrames(cyclic).length, 1)
})

test('a CDP request detail exposes async frames and their section count', async () => {
  const channel = new CdpChannel({ log: quiet })
  channel.sessions.set('ext:9', { sessionId: 'ext:9', targetId: 'ext:9', type: 'page', title: 'Demo', url: 'https://app.example.com/explore' })
  const entry = channel.network.add({
    sessionId: 'ext:9',
    targetId: 'ext:9',
    params: {
      requestId: 'r9',
      wallTime: Date.now() / 1000,
      type: 'XHR',
      documentURL: 'https://app.example.com/explore',
      request: { method: 'POST', url: 'https://api.example.com/v1/homefeed' },
      initiator: {
        type: 'script',
        stack: {
          callFrames: [{ functionName: '', url: 'https://app.example.com/async/9760.js', lineNumber: 0, columnNumber: 5279, scriptId: '2' }],
          parent: {
            callFrames: [
              { functionName: 'dispatchRequest', url: 'https://app.example.com/vendor.js', lineNumber: 40, columnNumber: 1, scriptId: '3' },
              { functionName: 'fetchFeeds', url: 'https://app.example.com/index.js', lineNumber: 118, columnNumber: 7, scriptId: '3' },
            ],
          },
        },
      },
    },
  })
  const detail = channel.requestDetail(entry.id)
  assert.equal(detail.initiator.type, 'script')
  assert.equal(detail.initiator.totalFrames, 3)
  assert.equal(detail.initiator.syncFrames, 1)
  assert.equal(detail.initiator.asyncLevels, 2)
  assert.equal(detail.initiator.filteredFrames, 2)
  assert.deepEqual(detail.initiator.frames.map((frame) => frame.asyncLevel), [0, 1, 1])
  assert.equal(detail.initiator.frames[0].anonymous, true)
  assert.equal(detail.initiator.frames[0].lineNumber, 1)
  assert.equal(detail.initiator.frames[2].functionName, 'fetchFeeds')
  assert.equal(detail.initiator.frames[2].scriptKey, 'ext:9:3')
  assert.equal(detail.initiator.frames[2].noise, false)

  // 同一条走 chain()（agent 路径）：帧一样，配对仍然成立。
  const flow = { id: 'f9', method: 'POST', url: 'https://api.example.com/v1/homefeed', reqHeaders: {}, postData: null, startedAt: entry.at, ts: entry.at }
  const chain = await channel.chain(flow, { withSource: false })
  assert.equal(chain.matched, true)
  assert.equal(chain.initiator.totalFrames, 3)
  assert.equal(chain.initiator.frames.filter((frame) => !frame.noise).length, 1)
  assert.equal(chain.initiator.frames.filter((frame) => !frame.noise)[0].functionName, 'fetchFeeds')

  channel.dispose()
})

test('minified snippets are expanded into indented lines', () => {
  const src = 'function a(){var n="}";if(/\\}/.test(n))return 1;return {x:1}}'
  const out = formatFragment(src, { target: src.indexOf('return 1') })
  assert.equal(out.truncated, false)
  assert.equal(out.lines[0].text, 'function a(){')
  assert.equal(out.lines[0].indent, 0)
  // 缩进按 `{`/`}` 走；字符串里的 `}` 与正则里的 `}` 都不切行。
  assert.ok(out.lines.some((line) => line.indent >= 1 && line.text.includes('var n="}"')))
  assert.ok(out.lines.some((line) => line.text.includes('if(/\\}/.test(n))')))
  assert.ok(out.mark && out.mark.line >= 0 && out.mark.line < out.lines.length)
  // 上一层之后的新语句回到外层缩进。
  assert.ok(out.lines.some((line) => line.text.trim() === '}'))
  // 对象字面量 / 参数默认值不能被当成代码块展开（`e={}` 曾被切成 `e={` / `}){`）。
  const objects = formatFragment('function postApi(e,a={}){return a.summary="x",c.post("/api/sns/web/v1/homefeed",e,a)}').lines
  assert.equal(objects[0].text, 'function postApi(e,a={}){')
  assert.ok(!objects.some((line) => line.text.endsWith('e={')))
  // `for(;;)` 里的 `;` 不换行。
  assert.equal(formatFragment('for(var i=0;i<n;i++){f(i)}').lines[0].text, 'for(var i=0;i<n;i++){')
  // else / catch 仍然按块展开。
  const control = formatFragment('if(a){b()}else{c()}').lines.map((line) => line.text)
  assert.deepEqual(control.slice(0, 5), ['if(a){', 'b()', '}else{', 'c()', '}'])
})

test('a window that starts inside a string is moved to a statement boundary', () => {
  const tail = 'function getApi(e={}){return e.summary="退登",c.get("/api/a",e)}function postApi(e,a={}){return a.summary="【web】- homefeed",c.post("/api/sns/web/v1/homefeed",e,a)}'
  const source = `${'x'.repeat(900)}"activate",e,a)}${tail}${'y'.repeat(900)}`
  const at = source.indexOf('postApi')
  const win = columnWindow(source, at, 1200)
  // 起点挪到 `)}` 之后：不会从字符串中间切进来，分词器也就不会把后面整段当字符串。
  assert.ok(win.text.startsWith('function '))
  assert.equal(win.highlight.start, at - win.start)
  const out = formatFragment(win.text, { target: win.highlight.start })
  const text = out.lines.map((line) => `${'  '.repeat(line.indent)}${line.text}`).join('\n')
  assert.match(text, /function getApi\(e=\{\}\)\{/)
  assert.match(text, /\n  return e\.summary/)
  assert.match(text, /\nfunction postApi\(e,a=\{\}\)\{/)
  assert.match(text, /homefeed/)
})

test('a CDP request becomes a flow-shaped input for the code generators', () => {
  const channel = new CdpChannel({ log: quiet })
  const entry = channel.network.add({
    sessionId: 'ext:9',
    targetId: 'ext:9',
    params: {
      requestId: 'r3',
      wallTime: Date.now() / 1000,
      type: 'XHR',
      request: {
        method: 'POST',
        url: 'https://api.example.com/api/sns/web/v1/homefeed?x=1',
        headers: { 'Content-Type': 'application/json;charset=UTF-8', Cookie: 'a=1', 'X-S': 'sig' },
        postData: '{"num":20}',
      },
    },
  })
  const flow = channel.codeFlowOf(entry.id)
  assert.equal(flow.method, 'POST')
  assert.equal(flow.host, 'api.example.com')
  assert.equal(flow.path, '/api/sns/web/v1/homefeed?x=1')
  assert.equal(flow.port, 443)
  assert.match(flow.reqBody.mime, /json/)
  assert.equal(flow.reqBody.text, '{"num":20}')
  assert.equal(flow.reqHeaders.Cookie, 'a=1')
  assert.throws(() => channel.codeFlowOf('nope'), /已滚出索引/)
  channel.dispose()
})

test('occurrences and line lookup drive same-name navigation', () => {
  const source = 'var a=fetchFeeds();fetchFeedsMore();function fetchFeeds(){fetchFeeds()}'
  const positions = occurrencesOf(source, 'fetchFeeds')
  // 只命中完整标识符：fetchFeedsMore 不算。
  assert.equal(positions.length, 3)
  assert.equal(source.slice(positions[0], positions[0] + 10), 'fetchFeeds')
  assert.equal(lineAt('aaa\nbbb\nccc', 5), 1)
  assert.equal(lineAt(source, positions[2]), 0)
})

test('the source viewer shows the call site first and can walk same-name hits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-src-'))
  try {
    const channel = new CdpChannel({ log: quiet, getDataDir: () => dir })
    const fill = 'x=1;'.repeat(400)
    // 压缩文件形态（单行大于 MINIFIED_LINE_CHARS）：同名 3 处，调用点在第一处。
    const source = `${fill}fetchFeeds();${fill}fetchFeeds();${fill}fetchFeeds();${fill}`
    channel.sources.put({ key: 'ext:9:5', url: 'https://app/index.js', scriptId: '5', sessionId: 'ext:9', text: source })
    const callColumn = source.indexOf('fetchFeeds();') + 1 // 1-based 列

    const callSite = await channel.sourceOf({ key: 'ext:9:5', line: 0, column: callColumn, needle: 'fetchFeeds' })
    assert.equal(callSite.hits.total, 3)
    assert.equal(callSite.hits.index, -1)
    assert.equal(callSite.charOffset, callColumn - 1)
    // 调用点在第一处上：往后翻先到第二处，往前翻回到第三处（就近原则）。
    assert.equal(callSite.hits.next, 1)
    assert.equal(callSite.hits.prev, 2)

    const first = await channel.sourceOf({ key: 'ext:9:5', line: 0, column: callColumn, needle: 'fetchFeeds', hitIndex: 0 })
    assert.equal(first.hits.index, 0)
    assert.equal(first.charOffset, callColumn - 1)
    const third = await channel.sourceOf({ key: 'ext:9:5', line: 0, column: callColumn, needle: 'fetchFeeds', hitIndex: 2 })
    assert.equal(third.hits.index, 2)
    assert.ok(third.charOffset > first.charOffset)
    // 越界的 hit 退回调用点，而不是报错。
    const outOfRange = await channel.sourceOf({ key: 'ext:9:5', line: 0, column: callColumn, needle: 'fetchFeeds', hitIndex: 99 })
    assert.equal(outOfRange.hits.index, -1)
    // 没有同名命中时不进入翻页模式。
    const none = await channel.sourceOf({ key: 'ext:9:5', line: 0, column: 4, needle: 'noSuchName' })
    assert.equal(none.hits.total, 0)
    assert.equal(none.hits.index, -1)
    // 落盘路径能被「打开所在文件夹」拿到。
    assert.match(channel.sourcePathOf('ext:9:5'), /ext_9_5\.js$/)
    assert.ok(channel.sourcesDir().endsWith('scripts'))
    assert.equal(channel.sourcePathOf('ext:9:404'), null)
    channel.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the source viewer reads only the on-disk store, never the browser', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-src-'))
  try {
    const channel = new CdpChannel({ log: quiet, getDataDir: () => dir })
    const calls = []
    channel.client = {
      send: async (method, params) => {
        calls.push({ method, params })
        throw new Error('不该向浏览器要源码')
      },
      close: () => {},
    }
    const source = `${'a'.repeat(2000)}function fetchFeeds(){return 1}fetchFeeds()${'b'.repeat(2000)}`
    channel.sources.put({ key: 'ext:9:42', url: 'https://app/main.js', scriptId: '42', sessionId: 'ext:9', text: source })
    const snippet = await channel.sourceOf({ key: 'ext:9:42', line: 0, column: 2001, chars: 400 })
    assert.equal(snippet.mode, 'column')
    assert.equal(snippet.totalChars, source.length)
    // 整份源码不再提供：片段给的是展开成多行的片段 + 标记位置。
    assert.equal(snippet.charOffset, 2000)
    assert.ok(Array.isArray(snippet.lines) && snippet.lines.length > 1)
    assert.ok(snippet.mark && snippet.mark.line >= 0 && snippet.mark.line < snippet.lines.length)
    assert.ok(snippet.lines.some((line) => line.text.includes('fetchFeeds')))
    // 没落盘的脚本只报原因，一次也不碰 CDP。
    await assert.rejects(() => channel.sourceOf({ key: 'ext:9:77', line: 0 }), /还没落盘/)
    assert.equal(calls.length, 0)
    channel.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('source falls back to a numbered line window for normal scripts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-src-'))
  try {
    const channel = new CdpChannel({ log: quiet, getDataDir: () => dir })
    const lines = Array.from({ length: 20 }, (_, index) => `const v${index} = ${index};`)
    channel.sources.put({ key: 's1:7', url: 'https://app/main.js', text: lines.join('\n') })
    const window = await channel.sourceOf({ key: 's1:7', line: 9, context: 1 })
    assert.equal(window.mode, 'line')
    assert.equal(window.highlightLine, 10)
    assert.equal(window.startLine, 9)
    assert.equal(window.endLine, 11)
    assert.ok(window.text.includes('const v9 = 9;'))
    channel.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('capturing a request persists the scripts behind its call stack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-src-'))
  try {
    const channel = new CdpChannel({ log: quiet, getDataDir: () => dir })
    const text = 'function fetchFeeds(){return 1}\n'.repeat(20)
    const calls = []
    channel.client = {
      send: async (method, params) => {
        calls.push({ method, params })
        return { scriptSource: text }
      },
      close: () => {},
    }
    const entry = channel.network.add({
      sessionId: 'ext:9',
      targetId: 'ext:9',
      params: {
        requestId: 'r1',
        wallTime: Date.now() / 1000,
        type: 'XHR',
        request: { method: 'POST', url: 'https://api.example.com/v1/homefeed' },
        initiator: {
          type: 'script',
          stack: {
            callFrames: [{ functionName: '', url: 'https://app/async/9760.js', lineNumber: 0, columnNumber: 10, scriptId: '2' }],
            parent: { callFrames: [{ functionName: 'fetchFeeds', url: 'https://app/index.js', lineNumber: 5, columnNumber: 1, scriptId: '3' }] },
          },
        },
      },
    })
    channel._queueSourcePersist(entry)
    await channel.sourceQueue
    assert.equal(calls.length, 2)
    assert.equal(channel.sources.size, 2)
    // 业务帧的源码能按落盘那份定位（不再问浏览器）。
    const detail = channel.requestDetail(entry.id)
    const frame = detail.initiator.frames.find((item) => !item.noise)
    const window = await channel.sourceOf({ key: frame.scriptKey, line: 4, context: 1 })
    assert.equal(window.mode, 'line')
    assert.ok(window.text.includes('fetchFeeds'))
    // 同一条请求再触发一次不会再取第二遍。
    channel._queueSourcePersist(entry)
    await channel.sourceQueue
    assert.equal(calls.length, 2)
    channel.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('only business API requests trigger source persistence', () => {
  const yes = [
    { resourceType: 'XHR', url: 'https://api.example.com/api/sns/web/v1/homefeed' },
    { resourceType: 'Fetch', url: 'https://api.example.com/v1/items?page=2' },
    { resourceType: 'Fetch', url: 'https://app.example.com/graphql' },
  ]
  const no = [
    { resourceType: 'Document', url: 'https://app.example.com/explore' },
    { resourceType: 'Script', url: 'https://cdn.example.com/formula-static/js/index.a9f61821.js' },
    { resourceType: 'Image', url: 'https://img.example.com/a.jpg' },
    // 埋点 / APM / 风控探针
    { resourceType: 'XHR', url: 'https://t2.example.com/api/v2/collect' },
    { resourceType: 'XHR', url: 'https://apm-fe.example.com/api/data' },
    { resourceType: 'POST', url: 'https://as.example.com/api/sec/v1/scripting' },
    { resourceType: 'XHR', url: 'https://api.example.com/api/redcaptcha/v2/getconfig' },
    // 不是 http(s)：内联脚本与 blob
    { resourceType: 'XHR', url: '' },
    { resourceType: 'XHR', url: 'data:application/json,{}' },
  ]
  for (const item of yes) assert.equal(isBusinessRequest(item), true, item.url)
  for (const item of no) assert.equal(isBusinessRequest(item), false, `${item.resourceType} ${item.url}`)
})

test('a failed script fetch is retried once and then left alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-src-'))
  try {
    const channel = new CdpChannel({ log: quiet, getDataDir: () => dir })
    let calls = 0
    channel.client = {
      send: async () => {
        calls += 1
        throw new Error('通道抖动')
      },
      close: () => {},
    }
    const entry = channel.network.add({
      sessionId: 'ext:9',
      targetId: 'ext:9',
      params: {
        requestId: 'r2',
        wallTime: Date.now() / 1000,
        type: 'XHR',
        request: { method: 'GET', url: 'https://api.example.com/feed' },
        initiator: { type: 'script', stack: { callFrames: [{ functionName: 'fetchFeeds', url: 'https://app/index.js', lineNumber: 1, columnNumber: 2, scriptId: '9' }] } },
      },
    })
    channel._queueSourcePersist(entry)
    await channel.sourceQueue
    assert.equal(calls, 1)
    channel._queueSourcePersist(entry)
    await channel.sourceQueue
    assert.equal(calls, 2)
    // 第三次不再打扰浏览器，原因留着给面板看。
    channel._queueSourcePersist(entry)
    await channel.sourceQueue
    assert.equal(calls, 2)
    assert.match(channel.sources.reasonOf('ext:9:9'), /抓取时没读到/)
    channel.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('oversize scripts are skipped with a reason instead of being retried', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-src-'))
  try {
    const channel = new CdpChannel({ log: quiet, getDataDir: () => dir })
    const result = channel.sources.put({ key: 'ext:9:5', url: 'https://app/big.js', text: 'x'.repeat(4 * 1024 * 1024 + 1) })
    assert.equal(result.stored, false)
    assert.match(result.reason, /超过单脚本上限/)
    assert.equal(channel.sources.get('ext:9:5'), null)
    await assert.rejects(() => channel.sourceOf({ key: 'ext:9:5', line: 0 }), /超过单脚本上限/)
    channel.clearRequests()
    assert.equal(channel.sources.size, 0)
    channel.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the source store survives a reload and clears with the request list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-src-'))
  try {
    const first = new SourceStore({ resolveDir: () => dir })
    assert.equal(first.put({ key: 'ext:9:1', url: 'https://app/a.js', text: 'abcdef' }).stored, true)
    // 新实例从 index.json 恢复（DSH 重启后的样子）。
    const second = new SourceStore({ resolveDir: () => dir })
    assert.equal(second.get('ext:9:1'), 'abcdef')
    assert.equal(second.totalChars, 6)
    assert.equal(second.list()[0].url, 'https://app/a.js')
    second.clear()
    assert.equal(new SourceStore({ resolveDir: () => dir }).get('ext:9:1'), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('disconnecting the bridge keeps captured requests until the user clears', async () => {
  const channel = new CdpChannel({ log: quiet })
  channel.bridge = { tabId: 9, title: 'Demo', url: 'https://app.example.com' }
  channel.bridgeSessionId = 'ext:9'
  channel.network.add({
    sessionId: 'ext:9',
    targetId: 'ext:9',
    params: { requestId: 'r1', wallTime: Date.now() / 1000, type: 'XHR', request: { method: 'GET', url: 'https://api.example.com/feed' } },
  })
  await channel.detachBridge()
  assert.equal(channel.bridge, null)
  assert.equal(channel.network.size, 1)
  channel.clearRequests()
  assert.equal(channel.network.size, 0)
  channel.dispose()
})

test('pausing the bridge keeps already collected CDP requests', async () => {
  const channel = new CdpChannel({ log: quiet })
  channel.bridge = { tabId: 9, title: 'Demo', url: 'https://app.example.com' }
  channel.network.add({
    sessionId: 'ext:9',
    targetId: 'ext:9',
    params: { requestId: 'r1', wallTime: Date.now() / 1000, type: 'XHR', request: { method: 'GET', url: 'https://api.example.com/feed' } },
  })

  const pending = channel.pauseBridge()
  const command = await channel.waitBridgeCommand(100)
  assert.equal(command.action, 'pause')
  channel.bridgeResult({ id: command.id, result: { status: { paused: true } } })
  const status = await pending
  assert.equal(status.bridgePaused, true)
  assert.equal(channel.network.size, 1)

  channel.dispose()
})
