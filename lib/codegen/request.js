/**
 * dsh-flowspot: 所有代码生成器共用的请求模型。
 *
 * flow 存的是线上实际过的字节（头、体预览、耗时），不是脚本需要的东西：
 * 脚本要把查询参数从 URL 里拆出来、cookie 拆成键值对、请求体判断成
 * JSON / form / multipart / text / binary。这个模块只做这一次转换，
 * 六个生成器和原来的 cURL 导出因此看到的是同一个请求。
 *
 * 生成器依赖两条规则：
 *  - hop-by-hop 头（`content-length`、`host`、`connection` 等）直接丢掉，
 *    因为每个 HTTP 客户端都会自己重新算；
 *  - 头值在捕获时被打码、已经不是真正密钥的，保留占位符并加一条 note，
 *    免得生成的脚本把 `***redacted***` 当成能用的凭据。
 */

// 这些头描述的是「这一跳连接」，不是请求本身的语义：客户端会按自己要发的体
// 重算 content-length，按目标重新填 host。原样抄进脚本反而会发错，所以整组不进模型。
const HOP_BY_HOP = new Set([
  'content-length',
  'host',
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
])

/** 打开打码时 `lib/flows.js` 写进头里的占位符。 */
export const REDACTED = '***redacted***'

/** 头值本该是字符串，但 Node 会把重复的头保留成数组。 */
function headerValue(value) {
  if (Array.isArray(value)) return value.join(', ')
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 把 `cookie` 头拆成一个个键值对。值保持原样、不解码：生成的脚本应该发出
 * 捕获到的那些字节，而不是解一次码再猜回去。
 * @param {string} header 原始 `cookie` 头值
 * @returns {{name: string, value: string}[]}
 */
export function parseCookies(header) {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf('=')
      // 没有 `=` 的片段（少见）当成只有名字、值为空，而不是整段丢掉。
      if (at < 0) return { name: part, value: '' }
      return { name: part.slice(0, at).trim(), value: part.slice(at + 1).trim() }
    })
}

/**
 * 解析 `application/x-www-form-urlencoded` 文本。
 *
 * 重复键会报出来，而不是悄悄合并：`tag=a&tag=b` 这种体大部分字典表示不了，
 * 所以生成器只留最后一个值，并由 note 说明这件事。
 * @param {string} text 原始请求体
 * @returns {{pairs: {name: string, value: string}[], duplicates: number}}
 */
export function parseForm(text) {
  const params = new URLSearchParams(String(text || ''))
  const pairs = [...params.entries()].map(([name, value]) => ({ name, value }))
  const seen = new Set()
  let duplicates = 0
  for (const pair of pairs) {
    if (seen.has(pair.name)) duplicates++
    seen.add(pair.name)
  }
  return { pairs, duplicates }
}

/**
 * 取出请求体的 JSON 值；不是 JSON 就返回 `undefined`。
 *
 * 判定看两头：MIME 里带 `json`，或者修剪后以 `{` / `[` 开头。解析失败同样
 * 算「不是 JSON」——这样调用方会把它当普通 text 渲染，而不是让生成器崩掉。
 */
function jsonValueOf(text, mime) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return undefined
  const looksJson = mime.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')
  if (!looksJson) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * 把捕获到的请求体归成生成器要渲染的形状。
 *
 * 判定按顺序来：先试 JSON，再 form，再 multipart，最后落回 text。
 * 被截断的 JSON 解析不出来，会自然落到 text，脚本发出去的就是半截字符串。
 * @param {object|null} body `flow.reqBody`
 * @returns {{kind: string, text?: string, base64?: string, bytes?: number, mime?: string, value?: unknown, pairs?: object[], duplicates?: number}}
 */
function bodyOf(body) {
  if (!body) return { kind: 'none' }
  const mime = String(body.mime || '').toLowerCase()
  if (body.text != null) {
    // 顺序即优先级：JSON 最具体先试，不是 JSON 才按 MIME 分流。
    const value = jsonValueOf(body.text, mime)
    if (value !== undefined) return { kind: 'json', text: body.text, value, mime }
    if (mime.includes('x-www-form-urlencoded')) {
      const form = parseForm(body.text)
      return { kind: 'form', text: body.text, pairs: form.pairs, duplicates: form.duplicates, mime }
    }
    if (mime.includes('multipart/form-data')) return { kind: 'multipart', text: body.text, mime }
    return { kind: 'text', text: body.text, mime }
  }
  if (body.base64) return { kind: 'binary', base64: body.base64, bytes: body.bytes, mime }
  return { kind: 'none' }
}

/**
 * 组装生成器要渲染的请求模型。
 * @param {object} flow 存下来的 flow
 * @returns {object} 供 `lib/codegen/*.js` 各渲染器使用的 spec
 */
export function requestSpecOf(flow) {
  const rawHeaders = flow.reqHeaders || {}
  const notes = []
  const headers = []
  let cookieHeader = null
  let redacted = false

  for (const [name, value] of Object.entries(rawHeaders)) {
    const lower = name.toLowerCase()
    const text = headerValue(value)
    if (lower === 'cookie') {
      cookieHeader = text
      continue
    }
    if (HOP_BY_HOP.has(lower)) continue
    if (text.includes(REDACTED)) redacted = true
    headers.push({ name: lower, value: text })
  }

  let cookies = []
  if (cookieHeader) {
    if (cookieHeader.includes(REDACTED)) {
      // cookie 被打码时拆不成真键值对，于是保留成一条普通头：让脚本看起来
      // 「少了东西」，而不是假装 cookie 已经拆干净了。
      headers.push({ name: 'cookie', value: cookieHeader })
      redacted = true
    } else {
      cookies = parseCookies(cookieHeader)
    }
  }

  // 这些 note 会以 `# 注意：` 的形式顶在生成脚本的头部，所以每条都要写清
  // 后果（跑不起来 / 内容不全），而不是只说「有变化」。
  if (redacted) notes.push(`请求头里有值在捕获时被打码（${REDACTED}），替换成真实值后才能运行`)

  const body = bodyOf(flow.reqBody)
  if (flow.reqBody?.truncated) {
    notes.push(`请求体在捕获时被截断（只保留了前 ${String(flow.reqBody.text || flow.reqBody.base64 || '').length} 个字符），生成脚本里的 body 不完整`)
  }
  if (body.kind === 'multipart') notes.push('multipart 请求体按原样带上（含 boundary），不改写表单字段')
  if (body.kind === 'form' && body.duplicates) notes.push(`表单里有重复键，脚本只保留同名参数的最后一个（原请求有 ${body.duplicates} 处重复）`)
  if (body.kind === 'binary') notes.push(`请求体是二进制（${body.bytes ?? 0} 字节），脚本里用 base64 还原`)

  // 两种判法：握手请求带 `upgrade: websocket`，或者响应已经是 101。
  const isWebSocket =
    String(rawHeaders.upgrade || '').toLowerCase().includes('websocket') || flow.status === 101
  if (isWebSocket) notes.push('这是 WebSocket 握手（101）：生成的脚本只发一次普通 HTTP 请求，不会建立长连接')

  let query = []
  try {
    query = [...new URL(flow.url).searchParams.entries()].map(([name, value]) => ({ name, value }))
  } catch {
    /* URL 畸形也照样原样渲染，不让代码视图整页失败 */
  }

  return {
    id: flow.id,
    method: String(flow.method || 'GET').toUpperCase(),
    url: String(flow.url || ''),
    scheme: flow.scheme || 'https',
    host: flow.host || '',
    port: flow.port || 443,
    path: flow.path || '/',
    query,
    headers,
    cookies,
    body,
    notes,
    isWebSocket,
  }
}
