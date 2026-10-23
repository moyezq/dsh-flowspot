/**
 * dsh-flowspot: 一条 flow 的 Go 脚本。
 *
 * 只用标准库（`net/http`），所以 `go mod init` 之后不加依赖就能编译。
 * 请求体按捕获到的原始字节发出去；原来的 `content-type` 头保留着，
 * JSON / form / multipart 的语义才不会丢。
 */

import { goString, quoted } from './literal.js'

/**
 * @param {object} spec `request.js` 出来的请求模型
 * @returns {{code: string, notes: string[]}}
 */
export function renderGo(spec) {
  const body = spec.body
  // 体是一段字节就要 `bytes`；只有二进制体额外需要 base64 解码器。
  const usesBytes = ['json', 'text', 'form', 'multipart', 'binary'].includes(body.kind)
  const imports = []
  if (usesBytes) imports.push('"bytes"')
  if (body.kind === 'binary') imports.push('"encoding/base64"')
  imports.push('"fmt"', '"io"', '"net/http"', '"time"')

  const lines = []
  lines.push('package main')
  lines.push('')
  lines.push('import (')
  for (const item of imports) lines.push(`\t${item}`)
  lines.push(')')
  lines.push('')
  lines.push('func main() {')
  lines.push(`\turl := ${quoted(spec.url)}`)

  if (body.kind === 'json' || body.kind === 'text' || body.kind === 'form' || body.kind === 'multipart') {
    // 有预览文本的直接当字节发；文本里可能有多行 JSON，所以用 goString 的 raw string。
    lines.push(`\tbody := bytes.NewBufferString(${goString(body.text)})`)
  } else if (body.kind === 'binary') {
    // 二进制只能先 base64 解码；失败就 panic（这是脚本，不是库）。
    lines.push(`\tdecoded, err := base64.StdEncoding.DecodeString(${quoted(body.base64)})`)
    lines.push('\tif err != nil {')
    lines.push('\t\tpanic(err)')
    lines.push('\t}')
    lines.push('\tbody := bytes.NewBuffer(decoded)')
  }

  const bodyArg = body.kind === 'none' ? 'nil' : 'body'
  lines.push('')
  // 没有体就传 nil；请求构造失败直接 panic，别让脚本带着半个请求往下跑。
  lines.push(`\treq, err := http.NewRequest(${quoted(spec.method)}, url, ${bodyArg})`)
  lines.push('\tif err != nil {')
  lines.push('\t\tpanic(err)')
  lines.push('\t}')
  for (const header of spec.headers) {
    lines.push(`\treq.Header.Set(${quoted(header.name)}, ${quoted(header.value)})`)
  }
  if (spec.cookies.length) {
    // cookie 在模型里已拆成键值对，这里再拼回一条 `cookie` 头。
    const cookie = spec.cookies.map((item) => `${item.name}=${item.value}`).join('; ')
    lines.push(`\treq.Header.Set("cookie", ${quoted(cookie)})`)
  }

  lines.push('')
  // 固定 30 秒超时，和 Python 脚本保持一致。
  lines.push('\tclient := &http.Client{Timeout: 30 * time.Second}')
  lines.push('\tresp, err := client.Do(req)')
  lines.push('\tif err != nil {')
  lines.push('\t\tpanic(err)')
  lines.push('\t}')
  lines.push('\tdefer resp.Body.Close()')
  lines.push('')
  lines.push('\traw, err := io.ReadAll(resp.Body)')
  lines.push('\tif err != nil {')
  lines.push('\t\tpanic(err)')
  lines.push('\t}')
  lines.push('\tfmt.Println(resp.StatusCode, string(raw))')
  lines.push('}')

  const header = [
    '// 由 dsh-flowspot 从抓包记录生成；仅标准库。',
    ...spec.notes.map((note) => `// 注意：${note}`),
  ].join('\n')

  return { code: `${header}\n\n${lines.join('\n')}\n`, notes: [] }
}
