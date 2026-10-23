/**
 * 代码生成：请求模型、六种语言的渲染器和语言偏好。这里钉的都是「改错了不会报错、
 * 只会悄悄生成坏脚本」的地方——哪些头该保留、body 怎么分类、每种语言模板长什么样。
 * 运行：node test/codegen.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { FlowStore } from '../lib/flows.js'
import { LANGUAGE_IDS, renderCode } from '../lib/codegen/index.js'
import { normalizePrefs } from '../lib/codegen/prefs.js'
import { requestSpecOf } from '../lib/codegen/request.js'

const quiet = { warn() {} }

/**
 * 造一条已经结束的 flow。`body: undefined` 表示根本没有请求体。
 * @param {{method?: string, url?: string, headers?: object, body?: string, mime?: string, storeOptions?: object}} [options]
 */
function makeFlow({ method = 'POST', url = 'https://api.example.com/v1/items?page=2&q=a', headers = {}, body, mime = 'application/json', storeOptions = {} } = {}) {
  const store = new FlowStore({ log: quiet, ...storeOptions })
  const parsed = new URL(url)
  const flow = store.begin({
    method,
    host: parsed.host,
    port: 443,
    path: `${parsed.pathname}${parsed.search}`,
    url,
    reqHeaders: { 'content-type': mime, ...headers },
  })
  if (body !== undefined) store.setRequestBody(flow, Buffer.from(body))
  store.finish(flow, { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.alloc(0) })
  return flow
}

// 请求模型是六种语言的共同输入：query、cookie、body 各归各位，hop-by-hop 头先剔掉。
test('the request model separates query, cookies and body, and drops hop-by-hop headers', () => {
  const flow = makeFlow({
    headers: {
      host: 'api.example.com',
      'content-length': '9',
      connection: 'keep-alive',
      cookie: 'sid=1; theme=dark',
      authorization: 'Bearer t',
      'x-trace': 'abc',
    },
    body: '{"a":1}',
  })
  const spec = requestSpecOf(flow)
  assert.equal(spec.method, 'POST')
  assert.deepEqual(spec.query, [{ name: 'page', value: '2' }, { name: 'q', value: 'a' }])
  assert.deepEqual(spec.cookies, [{ name: 'sid', value: '1' }, { name: 'theme', value: 'dark' }])
  assert.equal(spec.headers.some((header) => header.name === 'host'), false)
  assert.equal(spec.headers.some((header) => header.name === 'content-length'), false)
  assert.equal(spec.headers.some((header) => header.name === 'cookie'), false)
  assert.equal(spec.body.kind, 'json')
  assert.deepEqual(spec.body.value, { a: 1 })
  assert.equal(spec.notes.length, 0)
})

// 同一个 POST 在六种模板里都要带齐头、cookie 和 JSON 体；模板改坏最容易在这里露馅。
test('every language renders the same POST with headers, cookies and a JSON body', () => {
  const flow = makeFlow({
    headers: { accept: 'application/json', authorization: 'Bearer t', cookie: 'sid=1' },
    body: '{"page":2}',
  })

  const curl = renderCode(flow, 'curl')
  assert.match(curl.code, /^curl -X POST 'https:\/\/api\.example\.com\/v1\/items\?page=2&q=a'/)
  assert.match(curl.code, /-H 'authorization: Bearer t'/)
  assert.match(curl.code, /-b 'sid=1'/)
  assert.match(curl.code, /--data-raw '\{"page":2\}'/)

  const python = renderCode(flow, 'python')
  assert.match(python.code, /import json\nfrom pathlib import Path\n\nimport requests/)
  assert.match(python.code, /headers = \{\n    "content-type": "application\/json",\n    "accept": "application\/json",\n    "authorization": "Bearer t"\n\}/)
  assert.match(python.code, /cookies = \{\n    "sid": "1"\n\}/)
  assert.match(python.code, /body = \{\n    "page": 2\n\}/)
  assert.match(python.code, /url = "https:\/\/api\.example\.com\/v1\/items\?page=2&q=a"/)
  assert.match(python.code, /response = requests\.post\(url, headers=headers, cookies=cookies, json=body, timeout=30\)/)
  assert.match(python.code, /out = Path\(__file__\)\.resolve\(\)\.parent \/ "response\.json"/)
  assert.doesNotMatch(python.code, /def main|if __name__/)

  const go = renderCode(flow, 'go')
  assert.match(go.code, /package main/)
  assert.match(go.code, /http\.NewRequest\("POST", url, body\)/)
  assert.match(go.code, /req\.Header\.Set\("authorization", "Bearer t"\)/)
  assert.match(go.code, /bytes\.NewBufferString\(`\{"page":2\}`\)/)
  assert.match(go.code, /Timeout: 30 \* time\.Second/)

  const rust = renderCode(flow, 'rust')
  assert.match(rust.code, /reqwest::blocking::Client::builder\(\)/)
  assert.match(rust.code, /\.post\("https:\/\/api\.example\.com\/v1\/items\?page=2&q=a"\)/)
  assert.match(rust.code, /serde_json::json!\(\{/)
  assert.match(rust.code, /\.json\(&body\)/)

  const javascript = renderCode(flow, 'javascript')
  assert.match(javascript.code, /await fetch\("https:\/\/api\.example\.com\/v1\/items\?page=2&q=a", \{/)
  assert.match(javascript.code, /"authorization": "Bearer t"/)
  assert.match(javascript.code, /credentials: "include"/)
  assert.match(javascript.code, /body: JSON\.stringify\(\{/)

  const node = renderCode(flow, 'node')
  assert.match(node.code, /await fetch\(/)
  assert.match(node.code, /"cookie": "sid=1"/)
  assert.match(node.code, /body: JSON\.stringify\(\{/)
})

// 浏览器 fetch 有禁止头清单：user-agent、origin 这类由浏览器自己填，模板必须剔掉并写进 note。
test('browser JavaScript drops headers fetch refuses to set, and says so', () => {
  const flow = makeFlow({
    headers: {
      'user-agent': 'Mozilla/5.0',
      origin: 'https://app.example.com',
      referer: 'https://app.example.com/',
      'sec-fetch-dest': 'empty',
      authorization: 'Bearer t',
    },
    body: '{}',
  })
  const javascript = renderCode(flow, 'javascript')
  assert.doesNotMatch(javascript.code, /^ {4}"(user-agent|origin|referer|sec-fetch-dest)":/m)
  assert.match(javascript.code, /"authorization": "Bearer t"/)
  assert.ok(javascript.notes.some((note) => note.includes('浏览器不允许脚本设置')))

  // Node 没有「禁止头」清单，同样这些头在 Node 模板里会保留。
  const node = renderCode(flow, 'node')
  assert.match(node.code, /"user-agent": "Mozilla\/5.0"/)
  assert.match(node.code, /"origin": "https:\/\/app\.example\.com"/)
})

// 表单体要生成 data/form 字段而不是 json，否则服务端收到的是「一串 JSON 文本」而不是表单。
test('form bodies become data/form fields, not JSON', () => {
  const flow = makeFlow({
    mime: 'application/x-www-form-urlencoded',
    headers: {},
    body: 'a=1&b=two&b=three',
  })
  const python = renderCode(flow, 'python')
  assert.match(python.code, /body = \{\n    "a": "1",\n    "b": "three"\n\}/)
  assert.match(python.code, /data=body/)

  const rust = renderCode(flow, 'rust')
  assert.match(rust.code, /\.form\(&\[\("a", "1"\), \("b", "two"\), \("b", "three"\)\]\)/)

  const javascript = renderCode(flow, 'javascript')
  assert.match(javascript.code, /new URLSearchParams\(/)

  // 字典装不下重复的表单键（后一个会盖掉前一个），所以必须用 note 说明丢了什么。
  assert.ok(python.notes.some((note) => note.includes('重复键')))
})

// 二进制体先转 base64、再按语言解码，脚本才能原样重放上传请求。
test('binary request bodies are decoded per language', () => {
  const store = new FlowStore({ log: quiet })
  const flow = store.begin({
    method: 'POST',
    host: 'api.example.com',
    port: 443,
    path: '/upload',
    url: 'https://api.example.com/upload',
    reqHeaders: { 'content-type': 'application/octet-stream' },
  })
  store.setRequestBody(flow, Buffer.from([0x00, 0x01, 0xff]))
  store.finish(flow, { status: 204, headers: {}, body: Buffer.alloc(0) })

  assert.equal(requestSpecOf(flow).body.kind, 'binary')
  assert.match(renderCode(flow, 'python').code, /import base64/)
  assert.match(renderCode(flow, 'python').code, /base64\.b64decode\(/)
  assert.match(renderCode(flow, 'go').code, /base64\.StdEncoding\.DecodeString\(/)
  assert.match(renderCode(flow, 'rust').code, /general_purpose::STANDARD\.decode\(/)
  assert.match(renderCode(flow, 'node').code, /Buffer\.from\(.*, "base64"\)/)
  assert.match(renderCode(flow, 'curl').notes.join('\n'), /二进制请求体/)
})

// 截断和打码都得在 note 和生成代码的注释里说出来，否则用户会以为脚本原样可跑。
test('a truncated body and a redacted header are visible in notes and comments', () => {
  const truncated = makeFlow({ body: '{"x":"' + 'a'.repeat(4000) + '"}', storeOptions: { maxBodyBytes: 1024 } })
  const spec = requestSpecOf(truncated)
  // 被截断的 JSON 已经不是合法 JSON：只能当文本处理，并靠 note 告诉读者
  // 生成的脚本不可能完整。
  assert.equal(spec.body.kind, 'text')
  assert.ok(spec.notes.some((note) => note.includes('截断')))
  assert.match(renderCode(truncated, 'python').code, /# 注意：.*截断/)

  const redacted = makeFlow({ headers: { authorization: '***redacted***' }, body: '{}', storeOptions: { redact: true } })
  const redactedSpec = requestSpecOf(redacted)
  assert.ok(redactedSpec.notes.some((note) => note.includes('打码')))
  assert.match(renderCode(redacted, 'python').code, /\*\*\*redacted\*\*\*/)
})

// 没有请求体的 GET 不能凭空造出 body 参数（Go 里会传 nil 而不是空 buffer）。
test('GET without a body stays a plain GET in every language', () => {
  const flow = makeFlow({ method: 'GET', headers: { accept: 'application/json' } })
  assert.match(renderCode(flow, 'python').code, /response = requests\.get\(url, headers=headers, timeout=30\)/)
  assert.match(renderCode(flow, 'curl').code, /^curl 'https:/)
  assert.doesNotMatch(renderCode(flow, 'go').code, /bytes\.NewBufferString/)
  assert.match(renderCode(flow, 'go').code, /http\.NewRequest\("GET", url, nil\)/)
})

// 不认识的 lang 退回 cURL，面板不能空着。
test('an unknown language falls back to cURL', () => {
  const flow = makeFlow({ body: '{}' })
  const rendered = renderCode(flow, 'brainfuck')
  assert.equal(rendered.id, 'curl')
  assert.match(rendered.code, /^curl /)
})

// 偏好归一化：丢掉不认识的 id、补上缺的 id、并且至少留一个可见语言。
test('the language preference drops unknown ids, appends missing ones and keeps one visible', () => {
  const prefs = normalizePrefs({ order: ['python', 'nope', 'python', 'curl'], hidden: ['python', 'go'] })
  assert.deepEqual(prefs.order, ['python', 'curl', ...LANGUAGE_IDS.filter((id) => id !== 'python' && id !== 'curl')])
  assert.equal(prefs.hidden.includes('python'), true)
  assert.equal(prefs.hidden.includes('go'), true)
  assert.deepEqual(normalizePrefs({}).order, LANGUAGE_IDS)

  // 全隐藏就不可用了：顺序里的第一个语言必须强制保持可见。
  const allHidden = normalizePrefs({ order: ['node', 'curl'], hidden: LANGUAGE_IDS })
  assert.equal(allHidden.hidden.includes('node'), false)
  assert.equal(allHidden.hidden.includes('curl'), true)
})
