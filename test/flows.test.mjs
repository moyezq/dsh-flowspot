/**
 * Flow store: the contract every reader depends on — ring eviction, filtering,
 * body previews (decompress / truncate / base64), redaction, JSONL append,
 * curl and HAR rendering.
 * Run with: node test/flows.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import { FlowStore, curlOf, describeBody, harEntryOf, harOf, normalizeUrl, resourceTypeOf, summaryOf } from '../lib/flows.js'

const quiet = { warn() {} }

function store(options = {}) {
  return new FlowStore({ log: quiet, ...options })
}

function seed(s, fields = {}) {
  const flow = s.begin({
    method: 'GET',
    host: 'api.example.com',
    port: 443,
    path: '/v1/user',
    url: 'https://api.example.com/v1/user',
    httpVersion: 'HTTP/1.1',
    reqHeaders: { accept: 'application/json' },
    ...fields,
  })
  return flow
}

function finishJson(s, flow, text = '{"name":"ada"}') {
  s.finish(flow, {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(text),
  })
  return flow
}

test('begin assigns sequential ids and masks sensitive request headers', () => {
  const s = store()
  const flow = s.begin({
    method: 'POST',
    host: 'api.example.com',
    path: '/login',
    url: 'https://api.example.com/login',
    reqHeaders: {
      Authorization: 'Bearer secret',
      Cookie: 'sid=1',
      'X-API-Key': 'k',
      Accept: 'application/json',
    },
  })
  assert.equal(flow.id, 'f1')
  assert.equal(flow.seq, 1)
  // Header names are lower-cased so filtering and rendering never miss a case.
  assert.equal(flow.reqHeaders.authorization, '***redacted***')
  assert.equal(flow.reqHeaders.cookie, '***redacted***')
  assert.equal(flow.reqHeaders['x-api-key'], '***redacted***')
  assert.equal(flow.reqHeaders.accept, 'application/json')
})

test('redact=false keeps credentials intact for local debugging', () => {
  const s = store({ redact: false })
  const flow = seed(s, { reqHeaders: { authorization: 'Bearer secret' } })
  s.finish(flow, { status: 200, headers: {}, body: Buffer.alloc(0) })
  assert.equal(flow.reqHeaders.authorization, 'Bearer secret')
})

test('the ring drops the oldest flow and counts every drop', () => {
  // maxFlows is clamped to a floor of 50, so 55 flows leave 50 and drop 5.
  const s = store({ maxFlows: 50 })
  for (let i = 0; i < 55; i++) {
    finishJson(s, seed(s, { path: `/n/${i}`, url: `https://api.example.com/n/${i}` }))
  }
  assert.equal(s.flows.length, 50)
  assert.equal(s.dropped, 5)
  assert.equal(s.get('f1'), null)
  assert.equal(s.get('f55').id, 'f55')
  assert.equal(s.list({ limit: 1 })[0].id, 'f55')
})

test('list filters by host, method, status, url keyword and seq window, newest first', () => {
  const s = store()
  const a = seed(s, { method: 'GET', host: 'a.example.com', url: 'https://a.example.com/x' })
  finishJson(s, a)
  const b = seed(s, { method: 'POST', host: 'b.example.com', url: 'https://b.example.com/login' })
  s.finish(b, { status: 401, headers: { 'content-type': 'text/plain' }, body: Buffer.from('denied') })
  const c = seed(s, { method: 'GET', host: 'a.example.com', url: 'https://a.example.com/orders' })
  finishJson(s, c)

  assert.deepEqual(s.list({ limit: 10 }).map((f) => f.id), ['f3', 'f2', 'f1'])
  assert.deepEqual(s.list({ host: 'A.EXAMPLE', limit: 10 }).map((f) => f.id), ['f3', 'f1'])
  assert.deepEqual(s.list({ method: 'post', limit: 10 }).map((f) => f.id), ['f2'])
  assert.deepEqual(s.list({ status: 401, limit: 10 }).map((f) => f.id), ['f2'])
  assert.deepEqual(s.list({ q: 'orders', limit: 10 }).map((f) => f.id), ['f3'])
  // since is exclusive: everything newer than f1.
  assert.deepEqual(s.list({ since: 1, limit: 10 }).map((f) => f.id), ['f3', 'f2'])
  assert.equal(s.list({ limit: 10 })[0].url, 'https://a.example.com/orders')
})

test('the panel type filter classifies like F12: sec-fetch-dest first, mime as fallback', () => {
  const s = store()
  // Browser request: Chrome's own hint decides the group.
  finishJson(s, seed(s, { reqHeaders: { 'sec-fetch-dest': 'script' } }), 'console.log(1)')
  // No hint (curl, older clients): the response mime decides.
  s.finish(seed(s, { path: '/logo.png', url: 'https://a.example.com/logo.png', reqHeaders: {} }), {
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: Buffer.from('png'),
  })
  // WebSocket handshake wins over any mime guess.
  finishJson(s, seed(s, { reqHeaders: { upgrade: 'websocket', connection: 'Upgrade' } }))

  assert.equal(resourceTypeOf(s.get('f1')), 'js')
  assert.equal(resourceTypeOf(s.get('f2')), 'img')
  assert.equal(resourceTypeOf(s.get('f3')), 'ws')
  // A request with neither a hint nor a response yet cannot be classified.
  assert.equal(resourceTypeOf({ method: 'GET', reqHeaders: {}, mime: '' }), 'other')

  assert.deepEqual(s.list({ type: 'img', limit: 10 }).map((f) => f.id), ['f2'])
  assert.deepEqual(s.list({ type: 'ws', limit: 10 }).map((f) => f.id), ['f3'])
  assert.deepEqual(s.list({ type: 'all', limit: 10 }).map((f) => f.id), ['f3', 'f2', 'f1'])
  // Unknown group names never silently match everything.
  assert.deepEqual(s.list({ type: 'nope', limit: 10 }), [])
})

test('search reports where the match was and keeps a snippet', () => {
  const s = store()
  const flow = seed(s, {
    method: 'POST',
    host: 'auth.example.com',
    path: '/token',
    url: 'https://auth.example.com/token',
    reqHeaders: { 'x-trace-id': 'trace-42' },
  })
  s.finish(flow, {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"access_token":"abc123","expires_in":3600}'),
  })

  const bodyHit = s.search({ q: 'ABC123', scope: 'body' })
  assert.equal(bodyHit.length, 1)
  assert.deepEqual(bodyHit[0].where, ['response-body'])
  assert.match(bodyHit[0].snippet, /abc123/)

  const headerHit = s.search({ q: 'trace-42', scope: 'all' })
  assert.deepEqual(headerHit[0].where, ['header'])

  // scope=url must not look at headers or bodies.
  assert.equal(s.search({ q: 'trace-42', scope: 'url' }).length, 0)
  assert.equal(s.search({ q: 'https://auth.example.com', scope: 'body' }).length, 0)
})

test('describeBody decompresses gzip, deflate and brotli before previewing', () => {
  const text = '{"ok":true}'
  const gzip = describeBody(zlib.gzipSync(Buffer.from(text)), { 'content-type': 'application/json', 'content-encoding': 'gzip' }, 4096)
  assert.equal(gzip.text, text)
  assert.equal(gzip.encoding, 'gzip')
  assert.equal(gzip.bytes, text.length)

  const deflate = describeBody(zlib.deflateSync(Buffer.from(text)), { 'content-type': 'application/json', 'content-encoding': 'deflate' }, 4096)
  assert.equal(deflate.text, text)
  assert.equal(deflate.encoding, 'deflate')

  const brotli = describeBody(zlib.brotliCompressSync(Buffer.from(text)), { 'content-type': 'application/json', 'content-encoding': 'br' }, 4096)
  assert.equal(brotli.text, text)
  assert.equal(brotli.encoding, 'br')
})

test('describeBody truncates to the cap and keeps binary as base64', () => {
  const truncated = describeBody(Buffer.from('abcdefghij'), { 'content-type': 'text/plain' }, 4)
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.text, 'abcd')
  assert.equal(truncated.bytes, 10)

  const binary = describeBody(Buffer.from([0x00, 0x01, 0xff]), { 'content-type': 'application/octet-stream' }, 4096)
  assert.equal(binary.text, null)
  assert.equal(binary.base64, Buffer.from([0x00, 0x01, 0xff]).toString('base64'))

  // A body without a content-type is sniffed: NUL bytes mean binary.
  assert.equal(describeBody(Buffer.from([0x00, 0x41]), {}, 4096).text, null)
  assert.equal(describeBody(Buffer.from('plain text'), {}, 4096).text, 'plain text')
})

test('request bodies are capped at 64 KiB even when maxBodyBytes is larger', () => {
  const s = store({ maxBodyBytes: 10 * 1024 * 1024 })
  const flow = seed(s, { reqHeaders: { 'content-type': 'text/plain' } })
  s.setRequestBody(flow, Buffer.from('x'.repeat(100000)))
  assert.equal(flow.reqBody.truncated, true)
  assert.equal(flow.reqBody.text.length, 65536)
  assert.equal(flow.reqBody.bytes, 100000)
})

test('finish records status, mime, size, error and appends one JSONL line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwc-flows-'))
  const s = store({ persistDir: dir })
  const flow = seed(s)
  s.finish(flow, {
    status: 201,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('y'.repeat(40000)),
  })
  assert.equal(flow.status, 201)
  assert.equal(flow.mime, 'application/json')
  assert.equal(flow.respBytes, 40000)
  assert.ok(flow.durationMs >= 0)

  const stream = s.stream
  s.close()
  await new Promise((resolve) => stream.once('finish', resolve))

  const lines = fs.readFileSync(s.persistFile, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.id, 'f1')
  assert.equal(parsed.status, 201)
  // On-disk previews are shorter than memory: 32 KiB per side.
  assert.equal(parsed.respBody.text.length, 32768)

  const failed = seed(s)
  s.finish(failed, { status: 0, error: new Error('ECONNRESET') })
  assert.equal(failed.error, 'ECONNRESET')
})

test('curlOf reproduces headers and body, skips hop-by-hop headers and escapes quotes', () => {
  const s = store()
  const flow = seed(s, {
    method: 'POST',
    url: 'https://api.example.com/v1/items?page=2',
    reqHeaders: {
      accept: 'application/json',
      'content-length': '9',
      host: 'api.example.com',
      connection: 'keep-alive',
      'x-note': "it's fine",
    },
  })
  s.setRequestBody(flow, Buffer.from('{"a":1}'))
  s.finish(flow, { status: 200, headers: {}, body: Buffer.alloc(0) })

  const cmd = curlOf(flow)
  assert.match(cmd, /^curl -X POST 'https:\/\/api\.example\.com\/v1\/items\?page=2'/)
  assert.match(cmd, /-H 'accept: application\/json'/)
  assert.match(cmd, /-H 'x-note: it'\\''s fine'/)
  assert.match(cmd, /--data-raw '\{"a":1\}'/)
  assert.doesNotMatch(cmd, /content-length/i)
  assert.doesNotMatch(cmd, /-H 'host:/i)
  assert.doesNotMatch(cmd, /proxy-connection/i)
})

test('harOf emits HAR 1.2 entries, base64 for binary and no postData for binary requests', () => {
  const s = store()
  const textual = seed(s, { url: 'https://api.example.com/a?b=1&b=2' })
  s.finish(textual, { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') })
  const binaryReq = seed(s, {
    method: 'POST',
    url: 'https://api.example.com/upload',
    reqHeaders: { 'content-type': 'application/octet-stream' },
  })
  s.setRequestBody(binaryReq, Buffer.from([0x00, 0x01, 0x02]))
  s.finish(binaryReq, { status: 204, headers: {}, body: Buffer.alloc(0) })

  const har = harOf([textual, binaryReq])
  assert.equal(har.log.version, '1.2')
  assert.equal(har.log.creator.name, 'dsh-flowspot')
  assert.equal(har.log.entries.length, 2)

  const first = har.log.entries[0]
  assert.equal(first.request.method, 'GET')
  assert.deepEqual(first.request.queryString, [{ name: 'b', value: '1' }, { name: 'b', value: '2' }])
  assert.equal(first.response.status, 200)
  assert.equal(first.response.content.text, '{"ok":true}')
  assert.equal(first.response.content.encoding, undefined)

  const second = har.log.entries[1]
  assert.equal(second.request.postData, undefined, 'binary requests carry no postData')
  assert.equal(second.response.status, 204)
})

test('binary responses round-trip through HAR as base64', () => {
  const s = store()
  const flow = seed(s)
  // `looksTextual` keys on NUL/control bytes, and a bare 4-byte PNG magic is
  // ASCII enough to pass as text — so the sample carries a NUL on purpose.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a])
  s.finish(flow, { status: 200, headers: { 'content-type': 'image/png' }, body: bytes })
  const entry = harEntryOf(flow)
  assert.equal(entry.response.content.encoding, 'base64')
  assert.equal(entry.response.content.text, bytes.toString('base64'))
})

test('stats summarizes the top hosts and statuses', () => {
  const s = store()
  for (let i = 0; i < 3; i++) finishJson(s, seed(s, { host: 'a.example.com' }))
  const failed = seed(s, { host: 'b.example.com' })
  s.finish(failed, { status: 500, headers: {}, body: Buffer.alloc(0), error: new Error('boom') })

  const stats = s.stats()
  assert.equal(stats.total, 4)
  assert.equal(stats.dropped, 0)
  assert.deepEqual(stats.hosts[0], { host: 'a.example.com', count: 3 })
  assert.equal(stats.statuses.find((x) => x.status === 'error').count, 1)
  assert.equal(stats.persistFile, null)
})

test('summaryOf exposes the fields every reader renders', () => {
  const s = store()
  const flow = finishJson(s, seed(s))
  const summary = summaryOf(flow)
  assert.deepEqual(Object.keys(summary).sort(), [
    'durationMs', 'error', 'errorCode', 'errorPhase', 'host', 'id', 'method', 'mime', 'path', 'port', 'respBytes', 'seq', 'status', 'time', 'type', 'url',
  ])
  assert.match(summary.time, /^\d{4}-\d{2}-\d{2}T/)
})

test('an error keeps its code and phase so "socket hang up" becomes diagnosable', () => {
  const s = store()
  const failed = seed(s)
  const err = new Error('socket hang up')
  err.code = 'ECONNRESET'
  s.finish(failed, { error: err, errorCode: 'ECONNRESET', errorPhase: 'upstream' })
  assert.equal(failed.error, 'socket hang up')
  assert.equal(failed.errorCode, 'ECONNRESET')
  assert.equal(failed.errorPhase, 'upstream')
  assert.equal(summaryOf(failed).errorCode, 'ECONNRESET')

  // Without an explicit code the error's own `code` is used, and a plain string
  // error keeps both fields null.
  const fromError = seed(s)
  const reset = new Error('read ECONNRESET')
  reset.code = 'ECONNRESET'
  s.finish(fromError, { error: reset })
  assert.equal(fromError.errorCode, 'ECONNRESET')
  assert.equal(fromError.errorPhase, null)

  const plain = seed(s)
  s.finish(plain, { error: new Error('客户端提前关闭'), errorPhase: 'client' })
  assert.equal(plain.errorCode, null)
  assert.equal(plain.errorPhase, 'client')
})

test('clear empties the ring and the store stays usable afterwards', () => {
  const s = store()
  finishJson(s, seed(s))
  s.clear()
  assert.equal(s.flows.length, 0)
  assert.equal(s.get('f1'), null)
  assert.equal(s.stats().total, 0)
  const next = finishJson(s, seed(s))
  assert.equal(next.seq, 2)
  s.close()
})

test('grouping folds a polling endpoint into one row with its occurrences', () => {
  const s = store()
  for (let i = 0; i < 3; i++) {
    const flow = seed(s, { method: 'POST', host: 'api.example.com', path: '/v2/poll', url: 'https://api.example.com/v2/poll' })
    s.finish(flow, { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') })
  }
  const failed = seed(s, { path: '/api/other', url: 'https://api.example.com/api/other' })
  const err = new Error('boom')
  err.code = 'ECONNRESET'
  s.finish(failed, { status: 500, headers: {}, body: Buffer.alloc(0), error: err })

  const groups = s.listGroups({ limit: 10 })
  assert.equal(groups.length, 2)

  const poll = groups.find((g) => g.path === '/api/v2/collect')
  assert.equal(poll.count, 3)
  assert.equal(poll.items.length, 3)
  // Newest first, like the flat list, with the oldest kept as `first`.
  assert.deepEqual(poll.items.map((item) => item.id), ['f3', 'f2', 'f1'])
  assert.equal(poll.latest.id, 'f3')
  assert.equal(poll.first.id, 'f1')
  assert.equal(poll.statuses['200'], 3)
  assert.equal(poll.errors, 0)
  assert.equal(poll.truncated, false)

  const failure = groups.find((g) => g.path === '/api/other')
  assert.equal(failure.count, 1)
  assert.equal(failure.errors, 1)
  assert.equal(failure.statuses.ERR, 1)
})

test('grouping keeps filters and caps the member list', () => {
  const s = store()
  for (let i = 0; i < 5; i++) finishJson(s, seed(s, { url: 'https://a.example.com/poll' }))

  const limited = s.listGroups({ limit: 10, maxItems: 2 })
  assert.equal(limited.length, 1)
  assert.equal(limited[0].count, 5)
  assert.equal(limited[0].items.length, 2)
  assert.equal(limited[0].truncated, true)

  assert.equal(s.listGroups({ method: 'POST' }).length, 0)
  assert.equal(s.listGroups({ host: 'nope.example' }).length, 0)
})

test('normalizeUrl folds polling parameters and keeps identifying ones', () => {
  assert.equal(normalizeUrl('https://a.example.com/x?_t=123'), 'https://a.example.com/x')
  assert.equal(normalizeUrl('https://a.example.com/x?page=2&pageSize=20'), 'https://a.example.com/x')
  assert.equal(normalizeUrl('https://a.example.com/x?id=7&_t=1'), 'https://a.example.com/x?id=7')
  // Surviving parameters are sorted so their order cannot split a group.
  assert.equal(normalizeUrl('https://a.example.com/x?b=2&a=1'), 'https://a.example.com/x?a=1&b=2')
  // An unparseable URL is returned unchanged.
  assert.equal(normalizeUrl('not a url'), 'not a url')
})

test('normalized grouping merges URLs that differ only by volatile parameters', () => {
  const s = store()
  for (const t of ['1', '2', '3']) {
    const flow = seed(s, { url: `https://a.example.com/poll?_t=${t}` })
    finishJson(s, flow)
  }
  assert.equal(s.listGroups({ normalize: false }).length, 3)
  const merged = s.listGroups({ normalize: true })
  assert.equal(merged.length, 1)
  assert.equal(merged[0].count, 3)
  assert.equal(merged[0].url, 'https://a.example.com/poll')
})
