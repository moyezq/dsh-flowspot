/**
 * 把压缩过的一小段 JS 展开成多行，供源码查看器显示。
 *
 * 为什么不用现成的：本仓零依赖（ADR-0006 的同一取舍），而 DevTools 的 `{}` 是完整
 * 解析器，代价不合算。这里的输入只有一段 ±600 字符的窗口，目标很朴素——让
 * `f(){a();if(b){c()}}` 这种一行变成几行、缩进对得上，读到调用点就行。
 *
 * 做四件事：字符串/注释/正则里不切行；代码块 `{` 后换行并缩进、`}` 回退；
 * `;` 换行（`for(;;)` 括号里的不算）；`e={}` 这种**对象/参数默认值不展开**。
 * 不做空格美化，所以压缩代码看起来仍然是压缩的，只是不再一行到底。
 */

const REGEX_PREFIX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>'])
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await'])

/** 这些词后面的 `{` 是代码块。 */
const BLOCK_KEYWORDS = new Set(['else', 'try', 'finally', 'do', 'catch'])

/** 上一个有意义的位置是否允许后面跟正则字面量。 */
function regexAllowed(prevChar, prevWord) {
  if (!prevChar) return true
  if (REGEX_PREFIX.has(prevChar)) return true
  return REGEX_KEYWORDS.has(prevWord)
}

/**
 * 这个 `{` 是代码块还是对象字面量 / 参数默认值？
 *
 * 压缩代码里 `e={}`、`c({a:1})` 太常见，一律按块展开会把
 * `function f(e={}){...}` 切成 `f(e={` / `}){`，比不排版更难读。
 * 判据只看前面的记号：`)` `;` `{` `}` `=>`、`else/try/do/catch/finally`、`class 名字{`
 * 算块，其余（`=` `(` `,` `:` `[` 等）算内联。
 */
function opensBlock(prevChar, prevWord, prevPrevWord) {
  if (!prevChar) return true
  if (prevChar === ')' || prevChar === ';' || prevChar === '{' || prevChar === '}') return true
  if (prevChar === '>') return true
  if (BLOCK_KEYWORDS.has(prevWord)) return true
  if (prevPrevWord === 'class' || prevPrevWord === 'extends') return true
  return false
}

/** `}` 后面这些记号说明它属于表达式/do-while，不该断行。 */
const JOIN_AFTER_BRACE = new Set(['else', 'catch', 'finally', 'while', ')', ',', ';', ']', '}', '.', ':'])

/** 看 `at` 之后的下一个记号（跳过空白），用来决定 `}` 后是否换行。 */
function nextTokenAfter(src, at) {
  let index = at
  while (index < src.length && (src[index] === ' ' || src[index] === '\t' || src[index] === '\n' || src[index] === '\r')) index += 1
  if (index >= src.length) return ''
  const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(index, index + 16))
  return word ? word[0] : src[index]
}

/**
 * 展开一段代码。
 * @param {string} text 片段原文（可以是从表达式中间开始的）
 * @param {{target?: number, maxLines?: number, maxMarkChars?: number}} [options]
 *   `target` 是片段内要标记的起始偏移（相对 `text`），`maxMarkChars` 是标记长度上限。
 * @returns {{lines: {indent: number, text: string}[], mark: {line: number, start: number, end: number}|null, truncated: boolean}}
 */
export function formatFragment(text, { target = -1, maxLines = 240, maxMarkChars = 160 } = {}) {
  const src = String(text ?? '')
  const lines = []
  let cur = ''
  let indent = 0
  let truncated = false
  let markLine = -1
  let markStart = -1

  const pushLine = () => {
    if (!cur) return
    if (markStart >= 0 && markLine === -1) markLine = lines.length
    lines.push({ indent, text: cur })
    cur = ''
    if (lines.length >= maxLines) truncated = true
  }

  const noteInput = (at) => {
    if (target < 0 || markStart >= 0) return
    if (at === target) {
      markLine = lines.length
      markStart = cur.length
    }
  }

  let state = 'code' // code | single | double | template | line-comment | block-comment | regex
  let escaped = false
  let prevChar = ''
  let prevWord = ''
  let prevPrevWord = ''
  /** 每个 `{` 是不是代码块，`}` 靠它决定回退缩进还是原样内联。 */
  const braces = []
  /** 圆括号深度：`for(var i=0;i<n;i++)` 里的 `;` 不能换行。 */
  let parens = 0

  /** 遇到非字母记号就把当前单词收尾，`else{` 才不会被拼成 `belse`。 */
  const flushWord = () => {
    if (!prevWord) return
    prevPrevWord = prevWord
    prevWord = ''
  }

  for (let at = 0; at < src.length && !truncated; at += 1) {
    const ch = src[at]
    const next = src[at + 1]

    if (state === 'single' || state === 'double' || state === 'template') {
      noteInput(at)
      cur += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) state = 'code'
      continue
    }
    if (state === 'line-comment') {
      noteInput(at)
      if (ch === '\n') {
        state = 'code'
        pushLine()
        continue
      }
      cur += ch
      continue
    }
    if (state === 'block-comment') {
      noteInput(at)
      cur += ch
      if (ch === '*' && next === '/') {
        cur += next
        at += 1
        state = 'code'
      }
      continue
    }
    if (state === 'regex') {
      noteInput(at)
      cur += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '/') state = 'code'
      else if (ch === '\n') state = 'code'
      continue
    }

    // 代码态
    noteInput(at)
    if (ch === "'") { state = 'single'; cur += ch; prevChar = ch; continue }
    if (ch === '"') { state = 'double'; cur += ch; prevChar = ch; continue }
    if (ch === '`') { state = 'template'; cur += ch; prevChar = ch; continue }
    if (ch === '/' && next === '/') { state = 'line-comment'; cur += ch; continue }
    if (ch === '/' && next === '*') { state = 'block-comment'; cur += ch; continue }
    if (ch === '/' && regexAllowed(prevChar, prevWord)) { state = 'regex'; cur += ch; prevChar = ch; continue }
    if (ch === '\n' || ch === '\r') { prevChar = ''; continue }
    if (ch === ' ' || ch === '\t') {
      if (cur && !cur.endsWith(' ')) cur += ' '
      continue
    }
    if (ch === '(') {
      parens += 1
      cur += ch
      prevChar = ch
      flushWord()
      continue
    }
    if (ch === ')') {
      parens = Math.max(0, parens - 1)
      cur += ch
      prevChar = ch
      flushWord()
      continue
    }
    if (ch === '{') {
      if (opensBlock(prevChar, prevWord, prevPrevWord)) {
        // 块：先按当前缩进收行，再进入下一层（含 `{` 的那行属于外层）。
        cur += ch
        pushLine()
        indent += 1
        braces.push(true)
      } else {
        // 对象字面量 / 参数默认值：内联，不改缩进。
        cur += ch
        braces.push(false)
      }
      prevChar = ch
      flushWord()
      continue
    }
    if (ch === '}') {
      const wasBlock = braces.length ? braces.pop() : true
      if (wasBlock) {
        if (cur.trim()) pushLine()
        indent = Math.max(0, indent - 1)
      }
      cur += ch
      prevChar = ch
      flushWord()
      // `}function` / `}var` 这种是两条语句，断行；`}else` / `})` / `},` / 对象结尾不断。
      if (wasBlock && !JOIN_AFTER_BRACE.has(nextTokenAfter(src, at + 1))) pushLine()
      continue
    }
    if (ch === ';') {
      cur += ch
      if (parens === 0) pushLine()
      prevChar = ch
      flushWord()
      continue
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      if (/[A-Za-z_$]/.test(ch)) prevWord = `${prevWord}${ch}`
      else flushWord()
      cur += ch
      prevChar = ch
      continue
    }
    flushWord()
    cur += ch
    prevChar = ch
  }
  if (cur.trim()) pushLine()

  const mark = markStart >= 0 && markLine >= 0 && markLine < lines.length
    ? {
      line: markLine,
      start: Math.min(markStart, lines[markLine].text.length),
      end: Math.min(lines[markLine].text.length, markStart + maxMarkChars),
    }
    : null
  return { lines, mark, truncated }
}
