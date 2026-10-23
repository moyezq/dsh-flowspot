/**
 * dsh-flowspot: 一条 flow 的 Python（requests）脚本。
 *
 * 沿用仓库里「一次请求一个脚本」的写法：从头到尾平铺
 * （`headers` → `cookies` → `body` → `url` → 发请求 → 结果），没有 `main`、
 * 没有 `if __name__`，变量用小写，结果写进文件。要装的库写在头部注释里，
 * 不藏在别处——脚本自成一体，看完就能跑。
 *
 * 固定这一个形状，是为了每次复制出来的脚本都能一眼扫到底；不做「可复用函数」
 * 这类抽象，因为它的用途就是拿一条 flow 复现一次请求。
 */

import { pyLiteral, quoted } from './literal.js'

// requests 有同名快捷方法（requests.get 等）；表外的方法（比如 PURGE）退回
// requests.request("PURGE", url)。
const METHOD_CALLS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

/** 在模块顶层渲染一个 dict：`{` 换行、键缩进 4 格、`}` 单独一行。 */
function dictBlock(name, entries) {
  if (!entries.length) return ''
  const lines = entries.map(([key, value]) => `    ${quoted(key)}: ${value}`)
  return `${name} = {\n${lines.join(',\n')}\n}\n`
}

/**
 * @param {object} spec `request.js` 出来的请求模型
 * @returns {{code: string, notes: string[]}}
 */
export function renderPython(spec) {
  const body = spec.body
  const usesBase64 = body.kind === 'binary'
  // 只有二进制体才需要 base64；`pathlib` 用来写结果文件，`json` 用来序列化。
  const imports = []
  if (usesBase64) imports.push('import base64')
  imports.push('import json')
  imports.push('from pathlib import Path')

  const blocks = []
  // 块按脚本里出现的先后推：头 → cookie → 体 → url + 请求 → 结果，
  // 块之间用一个空行隔开。
  const headerEntries = spec.headers.map((header) => [header.name, header.value])
  const headersBlock = dictBlock('headers', headerEntries.map(([key, value]) => [key, quoted(value)]))
  if (headersBlock) blocks.push(headersBlock.trimEnd())
  if (spec.cookies.length) {
    blocks.push(dictBlock('cookies', spec.cookies.map((cookie) => [cookie.name, quoted(cookie.value)])).trimEnd())
  }

  if (body.kind === 'json') {
    blocks.push(`body = ${pyLiteral(body.value, 0)}`)
  } else if (body.kind === 'form') {
    // dict 表示不了重复键，所以同名参数只留最后一个（原请求的重复数在 note 里说明）。
    const seen = new Map()
    for (const pair of body.pairs) seen.set(pair.name, pair.value)
    const entries = [...seen.entries()].map(([key, value]) => [key, quoted(value)])
    blocks.push(dictBlock('body', entries).trimEnd())
  } else if (body.kind === 'text' || body.kind === 'multipart') {
    blocks.push(`body = ${quoted(body.text)}`)
  } else if (body.kind === 'binary') {
    blocks.push(`body = base64.b64decode(${quoted(body.base64)})`)
  }

  const known = METHOD_CALLS.has(spec.method)
  const call = known ? `requests.${spec.method.toLowerCase()}` : 'requests.request'
  const args = [known ? 'url' : `${quoted(spec.method)}, url`]
  if (headerEntries.length) args.push('headers=headers')
  if (spec.cookies.length) args.push('cookies=cookies')
  if (body.kind !== 'none') args.push(body.kind === 'json' ? 'json=body' : 'data=body')
  // 固定 30 秒超时：生成的脚本要能结束，不能挂在没有响应的接口上。
  args.push('timeout=30')

  // `url` 紧贴请求调用：脚本从上往下读，最关键的那一行不能和它的输入分开。
  blocks.push(`url = ${quoted(spec.url)}\nresponse = ${call}(${args.join(', ')})`)
  // 先试 JSON，解析失败就当纯文本存：坏 JSON 不该让脚本崩掉。
  blocks.push(
    [
      'try:',
      '    result = response.json()',
      'except ValueError:',
      '    result = response.text',
    ].join('\n'),
  )
  blocks.push(
    [
      'out = Path(__file__).resolve().parent / "response.json"',
      'out.write_text(',
      '    json.dumps({"status_code": response.status_code, "body": result}, ensure_ascii=False, indent=4),',
      '    encoding="utf-8",',
      ')',
      'print(response.status_code, "->", out)',
    ].join('\n'),
  )

  const header = [
    '# 由 dsh-flowspot 从抓包记录生成；需要 requests：pip install requests',
    ...spec.notes.map((note) => `# 注意：${note}`),
  ].join('\n')

  const code = `${header}\n${imports.join('\n')}\n\nimport requests\n\n${blocks.join('\n\n')}\n`
  return { code, notes: [] }
}
