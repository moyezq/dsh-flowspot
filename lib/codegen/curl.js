/**
 * dsh-flowspot: 一条 flow 的 cURL 命令。
 *
 * 形状和 DevTools 的「Copy as cURL (bash)」一致，所以能原样粘进终端。
 * GET 的查询串留在 URL 里；头按捕获顺序排；原请求声明过我们能解的编码时，
 * 补一个 `--compressed`。
 */

import { shellQuote } from './literal.js'

/**
 * @param {object} spec `request.js` 出来的请求模型
 * @returns {{code: string, notes: string[]}}
 */
export function renderCurl(spec) {
  const notes = []
  const command = []
  // 首行：GET 省掉 `-X`，其他方法显式写出来，和浏览器复制出来的样子一致。
  command.push(spec.method === 'GET' ? `curl ${shellQuote(spec.url)}` : `curl -X ${spec.method} ${shellQuote(spec.url)}`)

  for (const header of spec.headers) command.push(`  -H ${shellQuote(`${header.name}: ${header.value}`)}`)
  if (spec.cookies.length) {
    // cookie 在请求模型里已经拆成键值对，这里拼回 curl 的 `-b 'a=1; b=2'`。
    command.push(`  -b ${shellQuote(spec.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '))}`)
  }

  const body = spec.body
  // 请求体按种类选开关：text/json/form 可以内联成 `--data-raw`；multipart 的
  // 原文里带 boundary，必须按字节给，用 `--data-binary`，否则 curl 会改写换行。
  if (body.kind === 'json' || body.kind === 'text' || body.kind === 'form') {
    command.push(`  --data-raw ${shellQuote(body.text)}`)
  } else if (body.kind === 'multipart') {
    command.push(`  --data-binary ${shellQuote(body.text)}`)
  } else if (body.kind === 'binary') {
    notes.push(`二进制请求体没有内联：把 base64 解成 body.bin，追加 --data-binary @body.bin（${body.bytes ?? 0} 字节）`)
  }

  // 原请求要过压缩才加：否则 curl 会多塞一个请求头，抓到的东西反而对不上。
  if (spec.headers.some((header) => header.name === 'accept-encoding')) command.push('  --compressed')

  // 复制出去的命令已经离开了面板，所以这些注意事项要跟着命令走：
  // 每条 note 变成一行 `# 注意：…`，顶在命令上面。
  const header = spec.notes.map((note) => `# 注意：${note}`).join('\n')
  return { code: `${header ? `${header}\n` : ''}${command.join(' \\\n')}\n`, notes }
}
