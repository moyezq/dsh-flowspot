/**
 * dsh-flowspot: 各代码生成器共用的字面量助手。
 *
 * 每个助手只回答一个问题：这个字符串/值要长成什么样，复制出去的脚本才能
 * 在目标语言里编译通过？它们和渲染器分开，是因为转义出问题的时候，生成器
 * 会安安静静产出坏代码——渲染器保持好读，转义逻辑单独测。
 */

/**
 * Bash/curl 的单引号参数：里面出现的 `'` 要写成 `'\''`。
 *
 * 单引号里 bash 不做任何解释，所以除了 `'` 没有别的要转义，`$` 和反引号都
 * 不会被展开。写法是「收尾 → 转义 → 再开引号」，拼回去还是同一个参数。
 */
export function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`
}

/**
 * JavaScript、Python 和 JSON 都认的双引号字符串。
 *
 * 这三种语法在常规字符上一致，所以共用一份；Rust 不适用，见 `rustString`。
 * @param {string} value 原始文本
 * @returns {string} 带引号的字面量
 */
export function quoted(value) {
  return JSON.stringify(String(value ?? ''))
}

/** 除第一行外，每行前面补 `spaces` 个空格。 */
export function indentLines(text, spaces) {
  if (!spaces) return text
  const pad = ' '.repeat(spaces)
  return String(text)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${pad}${line}`))
    .join('\n')
}

/** 是不是普通对象（不是数组，也不是 null）？ */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把解析好的 JSON 值写成 Python 字面量。
 *
 * JSON 的 `true/false/null` 在 Python 里不是名字，所以整块重新渲染，而不是
 * 套上引号；dict 的键保持捕获时的顺序。`indent` 是当前缩进（空格数），
 * 嵌套一层加 4，这样贴进脚本后层级看得清。
 * @param {unknown} value 解析后的 JSON
 * @param {number} [indent] 当前缩进空格数
 * @returns {string} 该值的 Python 源码
 */
export function pyLiteral(value, indent = 0) {
  const pad = ' '.repeat(indent)
  const inner = ' '.repeat(indent + 4)
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  if (typeof value === 'string') return quoted(value)
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    const items = value.map((item) => `${inner}${pyLiteral(item, indent + 4)}`)
    return `[\n${items.join(',\n')}\n${pad}]`
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    if (!entries.length) return '{}'
    const items = entries.map(([key, item]) => `${inner}${quoted(key)}: ${pyLiteral(item, indent + 4)}`)
    return `{\n${items.join(',\n')}\n${pad}}`
  }
  return quoted(String(value))
}

/**
 * 把解析好的 JSON 值写成 JavaScript 字面量。
 *
 * JSON 本身就是合法的 JavaScript，重新渲染只为了控制它在 `fetch` options
 * 对象里的缩进。`indent` 是当前缩进（空格数），嵌套一层加 2。
 * @param {unknown} value 解析后的 JSON
 * @param {number} [indent] 当前缩进空格数
 * @returns {string} 该值的 JavaScript 源码
 */
export function jsLiteral(value, indent = 0) {
  const pad = ' '.repeat(indent)
  const inner = ' '.repeat(indent + 2)
  if (value === null || value === undefined) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  if (typeof value === 'string') return quoted(value)
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    const items = value.map((item) => `${inner}${jsLiteral(item, indent + 2)}`)
    return `[\n${items.join(',\n')}\n${pad}]`
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    if (!entries.length) return '{}'
    const items = entries.map(([key, item]) => `${inner}${quoted(key)}: ${jsLiteral(item, indent + 2)}`)
    return `{\n${items.join(',\n')}\n${pad}}`
  }
  return quoted(String(value))
}

/**
 * 文本的 Go 表达式：能放反引号就放反引号，否则退回带引号的字符串。
 *
 * 反引号 raw string 里不用转义、能直接放多行，所以优先用它；但 Go 的 raw
 * string 表示不了反引号本身，含反引号或 `\r` 的文本只能退回带 `\n`、`\"`
 * 的引号串。
 * @param {string} value 原始文本
 * @returns {string} Go 表达式
 */
export function goString(value) {
  const text = String(value ?? '')
  if (!text.includes('`') && !text.includes('\r')) return `\`${text}\``
  return quoted(text)
}

/**
 * Rust 字符串字面量。没有复用 `JSON.stringify`，因为 JSON 的 `\uXXXX` 转义
 * 在 Rust 里不合法（Rust 要 `\u{...}`），只能自己按码位重新写控制字符。
 * @param {string} value 原始文本
 * @returns {string} Rust 表达式
 */
export function rustString(value) {
  let out = '"'
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0)
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    // 控制字符（含 DEL）没有可读的转义写法，按码位写成 `\u{..}`。
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`
    else out += ch
  }
  return `${out}"`
}

/**
 * 文本的 Rust 表达式：`r#"…"#` 不会有歧义时用 raw string，否则退回普通引号串。
 * raw string 让多行 JSON 保持可读，不用把整串塞满 `\n`。
 * @param {string} value 原始文本
 * @returns {string} Rust 表达式
 */
export function rustText(value) {
  const text = String(value ?? '')
  if (!text.includes('"#') && !text.includes('\r')) return `r#"${text}"#`
  return rustString(text)
}

/**
 * 把解析好的 JSON 值写成 Rust 源码，作为 `serde_json::json!` 的参数。
 * 该宏接受 JSON 的 `true/false/null` 写法，所以这里不用换名字。
 * @param {unknown} value 解析后的 JSON
 * @param {number} [indent] 当前缩进空格数
 * @returns {string} Rust 源码
 */
export function rustJsonLiteral(value, indent = 0) {
  const pad = ' '.repeat(indent)
  const inner = ' '.repeat(indent + 4)
  if (value === null || value === undefined) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  if (typeof value === 'string') return rustString(value)
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    const items = value.map((item) => `${inner}${rustJsonLiteral(item, indent + 4)}`)
    return `[\n${items.join(',\n')}\n${pad}]`
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    if (!entries.length) return '{}'
    const items = entries.map(([key, item]) => `${inner}${rustString(key)}: ${rustJsonLiteral(item, indent + 4)}`)
    return `{\n${items.join(',\n')}\n${pad}}`
  }
  return rustString(String(value))
}
