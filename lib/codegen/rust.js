/**
 * dsh-flowspot: 一条 flow 的 Rust 脚本。
 *
 * 用 `reqwest::blocking` + `serde_json`；确切的依赖行会打印在文件头，
 * 免得读者对着 `reqwest` / `json!` 猜是哪个 crate 提供的能力。
 */

import { quoted, rustJsonLiteral, rustText, rustString } from './literal.js'

const METHOD_CALLS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

/**
 * @param {object} spec `request.js` 出来的请求模型
 * @returns {{code: string, notes: string[]}}
 */
export function renderRust(spec) {
  const body = spec.body
  const usesBase64 = body.kind === 'binary'
  const lines = []
  // Cargo.toml 的依赖直接写在头部注释里：复制脚本的人不用再查文档；
  // 只有二进制体才多一个 base64。
  lines.push('// 由 dsh-flowspot 从抓包记录生成。Cargo.toml：')
  lines.push('// reqwest = { version = "0.12", features = ["blocking", "json"] }')
  lines.push('// serde_json = "1"')
  if (usesBase64) lines.push('// base64 = "0.22"（二进制请求体需要）')
  for (const note of spec.notes) lines.push(`// 注意：${note}`)
  lines.push('')
  lines.push('use std::time::Duration;')
  lines.push('')
  lines.push('fn main() -> Result<(), Box<dyn std::error::Error>> {')
  lines.push('    let client = reqwest::blocking::Client::builder()')
  lines.push('        .timeout(Duration::from_secs(30))')
  lines.push('        .build()?;')
  lines.push('')

  if (body.kind === 'json') {
    // JSON 走 `json!` 宏；`Content-Type` 由 reqwest 的 `.json()` 一起补。
    lines.push(`    let body = serde_json::json!(${rustJsonLiteral(body.value, 4)});`)
  } else if (body.kind === 'binary') {
    // 解码失败用 `?` 直接返回错误，不做半截请求。
    lines.push('    use base64::Engine as _;')
    lines.push(`    let body = base64::engine::general_purpose::STANDARD.decode(${quoted(body.base64)})?;`)
  }
  if (body.kind !== 'none') lines.push('')

  // 标准方法有快捷函数；表外的方法（比如 PURGE）只能走 `Method::from_bytes`，
  // 方法名要当字节串传进去。
  const call = METHOD_CALLS.has(spec.method)
    ? `.${spec.method.toLowerCase()}(${quoted(spec.url)})`
    : `.request(reqwest::Method::from_bytes(b${rustString(spec.method)})?, ${quoted(spec.url)})`
  lines.push('    let response = client')
  lines.push(`        ${call}`)
  for (const header of spec.headers) lines.push(`        .header(${quoted(header.name)}, ${rustString(header.value)})`)
  if (spec.cookies.length) {
    // cookie 在模型里已拆成键值对，这里再拼回一条 `cookie` 头。
    const cookie = spec.cookies.map((item) => `${item.name}=${item.value}`).join('; ')
    lines.push(`        .header("cookie", ${rustString(cookie)})`)
  }

  // 体的落点按种类分：JSON 交给 `.json()`（顺带设 content-type），form 交给
  // `.form()`（由 reqwest 编码），二进制给原始字节，其余按文本发。
  if (body.kind === 'json') lines.push('        .json(&body)')
  else if (body.kind === 'form') {
    const pairs = body.pairs.map((pair) => `(${rustString(pair.name)}, ${rustString(pair.value)})`).join(', ')
    lines.push(`        .form(&[${pairs}])`)
  } else if (body.kind === 'binary') lines.push('        .body(body)')
  else if (body.kind !== 'none') lines.push(`        .body(${rustText(body.text)})`)

  lines.push('        .send()?;')
  lines.push('')
  lines.push('    println!("status: {}\\n{}", response.status(), response.text()?);')
  lines.push('    Ok(())')
  lines.push('}')
  return { code: `${lines.join('\n')}\n`, notes: [] }
}
