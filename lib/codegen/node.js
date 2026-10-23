/**
 * dsh-flowspot: 一条 flow 的 Node.js 脚本。
 *
 * Node 内置的 `fetch`（Node ≥18）和浏览器版用同一个 options 形状，但没有
 * 禁止头清单——cookie、自定义 `user-agent` 都能发出去。存成 `.mjs` 之后，
 * 这里写的顶层 await 可以直接跑。
 */

import { jsLiteral, quoted } from './literal.js'

/**
 * @param {object} spec `request.js` 出来的请求模型
 * @returns {{code: string, notes: string[]}}
 */
export function renderNode(spec) {
  const body = spec.body
  const lines = []
  // 头部注释写清运行条件；下面的 note 逐条跟着脚本走。
  lines.push('// 保存为 request.mjs 后运行：node request.mjs（Node.js >= 18 内置 fetch）')
  for (const note of spec.notes) lines.push(`// 注意：${note}`)
  lines.push('')
  lines.push(`const response = await fetch(${quoted(spec.url)}, {`)
  if (spec.method !== 'GET') lines.push(`  method: ${quoted(spec.method)},`)
  // Node 没有禁止头清单，cookie 就和捕获时一样当普通头发；在这里合并进同一个
  // `headers` 对象，options 里才不会出现两处头。
  const headers = [...spec.headers]
  if (spec.cookies.length) {
    headers.push({ name: 'cookie', value: spec.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') })
  }
  if (headers.length) {
    lines.push('  headers: {')
    const headerLines = headers.map((header) => `    ${quoted(header.name)}: ${quoted(header.value)}`)
    lines.push(headerLines.join(',\n'))
    lines.push('  },')
  }
  // 体和浏览器版同构，区别在二进制用 `Buffer.from`（Node 才有），
  // 用到的 `URLSearchParams` 也是 Node 自带的。
  if (body.kind === 'json') lines.push(`  body: JSON.stringify(${jsLiteral(body.value, 2)}),`)
  else if (body.kind === 'form') {
    // 同名参数只留最后一个：从对象构造 URLSearchParams 表示不了重复键。
    const seen = new Map()
    for (const pair of body.pairs) seen.set(pair.name, pair.value)
    lines.push(`  body: new URLSearchParams(${jsLiteral(Object.fromEntries(seen), 2)}),`)
  } else if (body.kind === 'binary') lines.push(`  body: Buffer.from(${quoted(body.base64)}, "base64"),`)
  else if (body.kind === 'text' || body.kind === 'multipart') lines.push(`  body: ${quoted(body.text)},`)
  lines.push('});')
  lines.push('')
  lines.push('const text = await response.text();')
  lines.push('console.log(response.status, text);')
  return { code: `${lines.join('\n')}\n`, notes: [] }
}
