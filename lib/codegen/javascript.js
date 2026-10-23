/**
 * dsh-flowspot: 一条 flow 的浏览器 JavaScript 脚本。
 *
 * 运行在目标站点自己的页面里（DevTools 控制台或 module 脚本）。这个环境有
 * 别的生成器没有的限制：cookie 归浏览器管，而且脚本不许设 `cookie`、
 * `user-agent`、`origin`、`referer` 和一堆 `sec-*` 头。这些头会被丢掉并留下
 * 一条 note，而不是产出一段会悄悄报错的代码。
 */

import { jsLiteral, quoted } from './literal.js'

/**
 * `fetch` 拒绝设置的头；按 Fetch 规范这些会被静默忽略（或者让请求直接失败），
 * 所以生成的脚本不能假装设置过它们。
 */
const FORBIDDEN_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
])

function isForbidden(name) {
  const lower = name.toLowerCase()
  // `sec-*` 和 `proxy-*` 是整组前缀，没法一条条列全，所以按前缀判。
  return FORBIDDEN_HEADERS.has(lower) || lower.startsWith('sec-') || lower.startsWith('proxy-')
}

/**
 * @param {object} spec `request.js` 出来的请求模型
 * @returns {{code: string, notes: string[]}}
 */
export function renderJavaScript(spec) {
  const notes = []
  const kept = []
  const dropped = []
  // 设不了的头逐个挑出来：note 里要告诉使用者少了哪些，剩下的才写进脚本。
  for (const header of spec.headers) {
    if (isForbidden(header.name)) dropped.push(header.name)
    else kept.push(header)
  }
  if (dropped.length) notes.push(`浏览器不允许脚本设置 ${dropped.join('、')}，已省略`)
  if (spec.cookies.length) notes.push('原请求带 cookie：脚本用 credentials: "include"，需要页面与接口同源或服务端允许凭据')

  const body = spec.body
  const lines = []
  lines.push('// 在目标站点的页面里运行（DevTools 控制台或 type="module" 脚本）；跨域请求需要服务端允许 CORS。')
  for (const note of spec.notes) lines.push(`// 注意：${note}`)
  for (const note of notes) lines.push(`// 注意：${note}`)
  lines.push('')
  lines.push(`const response = await fetch(${quoted(spec.url)}, {`)
  if (spec.method !== 'GET') lines.push(`  method: ${quoted(spec.method)},`)
  if (kept.length) {
    lines.push('  headers: {')
    const headerLines = kept.map((header) => `    ${quoted(header.name)}: ${quoted(header.value)}`)
    lines.push(headerLines.join(',\n'))
    lines.push('  },')
  }
  // cookie 不写进 headers（浏览器不允许），只声明「带上凭据」，让浏览器自己补。
  if (spec.cookies.length) lines.push('  credentials: "include",')
  // 体按种类换写法：JSON 用 JSON.stringify 包一层；form 用 URLSearchParams
  // （content-type 由浏览器设）；二进制从 base64 还原成字节。
  if (body.kind === 'json') lines.push(`  body: JSON.stringify(${jsLiteral(body.value, 2)}),`)
  else if (body.kind === 'form') {
    // 从对象构造 URLSearchParams，表示不了重复键，所以同名参数只留最后一个。
    const seen = new Map()
    for (const pair of body.pairs) seen.set(pair.name, pair.value)
    const pairs = [...seen.entries()].map(([name, value]) => [name, value])
    lines.push(`  body: new URLSearchParams(${jsLiteral(Object.fromEntries(pairs), 2)}),`)
  } else if (body.kind === 'binary') {
    lines.push(`  body: Uint8Array.from(atob(${quoted(body.base64)}), (c) => c.charCodeAt(0)),`)
  } else if (body.kind === 'text' || body.kind === 'multipart') {
    lines.push(`  body: ${quoted(body.text)},`)
  }
  lines.push('});')
  lines.push('')
  lines.push('const text = await response.text();')
  lines.push('console.log(response.status, text);')
  return { code: `${lines.join('\n')}\n`, notes }
}
