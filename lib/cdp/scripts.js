/**
 * dsh-flowspot: 浏览器里已加载脚本的**索引**（`Debugger.scriptParsed` 给的元数据）与
 * 源码窗口的几个纯函数。
 *
 * 源码正文不在这里：CDP 只推元数据，正文要单独要一次，拿到后落到
 * `sourceStore.js` 管理的磁盘目录，预览与定位全部读那份（不再向浏览器要第二份）。
 */

const MAX_SCRIPTS = 4000

/** Composite key: script ids are only unique inside one session. */
export function scriptKeyOf(sessionId, scriptId) {
  return `${sessionId}:${scriptId}`
}

/** 一行多长算压缩过的：压缩后的 bundle 常常整份只有一行，按行取窗口等于把几 MB 全给面板。 */
export const MINIFIED_LINE_CHARS = 1200

/**
 * Numbered window around one line.
 * @param {string} source whole script
 * @param {number} lineNumber 0-based
 * @param {number} [context] lines before and after
 * @returns {{code: string, startLine: number, endLine: number}|null}
 */
export function lineWindow(source, lineNumber, context = 8) {
  if (!source) return null
  const lines = String(source).split('\n')
  const line = Math.max(0, Math.min(lines.length - 1, Number(lineNumber) || 0))
  const start = Math.max(0, line - context)
  const end = Math.min(lines.length - 1, line + context)
  const code = lines
    .slice(start, end + 1)
    .map((text, index) => `${String(start + index + 1).padStart(6, ' ')}  ${text}`)
    .join('\n')
  return { code, startLine: start + 1, endLine: end + 1 }
}

/** 0-based 行/列 → 整份源码里的字符偏移，按列定位时用。 */
export function charOffsetOf(source, lineNumber, columnNumber) {
  const lines = String(source || '').split('\n')
  const line = Math.max(0, Math.min(lines.length - 1, Number(lineNumber) || 0))
  let offset = 0
  for (let index = 0; index < line; index += 1) offset += lines[index].length + 1
  return offset + Math.max(0, Math.min(lines[line].length, Number(columnNumber) || 0))
}

/**
 * 一个标识符在源码里出现的字符偏移，按标识符边界匹配（`fetchFeeds` 不会命中
 * `fetchFeedsMore`）。同名方法在一个 bundle 里常有几十处，调用链的帧只给了它自己的
 * 调用点位置，其余同名位置靠这个列表前后翻。
 * @param {string} source 整份脚本
 * @param {string} needle 方法名
 * @param {number} [limit] 上限，防止一个高频名字扫出过多位置
 * @returns {number[]} 0-based 字符偏移
 */
export function occurrencesOf(source, needle, limit = 2000) {
  const text = String(source || '')
  const name = String(needle || '')
  if (!name) return []
  const boundary = /[A-Za-z0-9_$]/
  const out = []
  let from = 0
  while (out.length < limit) {
    const at = text.indexOf(name, from)
    if (at < 0) break
    const before = at === 0 ? '' : text[at - 1]
    const after = text[at + name.length] || ''
    if (!boundary.test(before) && !boundary.test(after)) {
      out.push(at)
      from = at + name.length
    } else {
      from = at + 1
    }
  }
  return out
}

/** 字符偏移 → 0-based 行号。 */
export function lineAt(source, charOffset) {
  const text = String(source || '')
  const at = Math.max(0, Math.min(text.length, Number(charOffset) || 0))
  let line = 0
  for (let index = 0; index < at; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

/**
 * 按字符切一段，并给出高亮范围（相对这段文本）。
 *
 * 压缩文件里「第 1582690 列」才是调用点，行号没有意义；窗口给窄一点，
 * 高亮从调用点起一小段，够认出方法在干什么。
 * @param {string} source whole script
 * @param {number} charOffset 0-based 字符偏移（调用点）
 * @param {number} [chars] 窗口总宽（两侧各一半）
 * @param {{alignStatement?: boolean}} [options] `alignStatement` 默认 true：把窗口起点挪到
 *   最近的语句边界（`;` `{` `}`），结尾再扩到下一个 `}`——否则窗口很可能从字符串/正则
 *   中间切进来（例如 `ivate",e,a)}function …`），分词器会把后面整段当成字符串，展开就失效。
 */
export function columnWindow(source, charOffset, chars = 1200, { alignStatement = true } = {}) {
  const text = String(source || '')
  const at = Math.max(0, Math.min(text.length, Number(charOffset) || 0))
  const half = Math.max(80, Math.min(8000, Math.floor((Number(chars) || 1200) / 2)))
  let start = Math.max(0, at - half)
  let end = Math.min(text.length, at + half)
  if (alignStatement) {
    // 往前挪到**第一个**语句边界之后（`}` 优先，其次 `;`）。取第一个而不是最后一个：
    // 只要起点落在一个标记之后，分词器就不会从字符串/正则中间开始；宁可少一点上文。
    for (let index = start; index < at; index += 1) {
      const ch = text[index]
      if (ch === '}' || ch === ';') {
        start = index + 1
        break
      }
    }
    // 结尾补到下一个 `}`/`;`，让最后一个函数块闭合，块看起来才完整。
    for (let step = 0; step < 400 && end < text.length; step += 1) {
      const ch = text[end]
      end += 1
      if (ch === '}' || ch === ';') break
    }
  }
  const slice = text.slice(start, end)
  const highlightStart = Math.max(0, Math.min(slice.length, at - start))
  return {
    text: slice,
    start,
    end,
    totalChars: text.length,
    highlight: { start: highlightStart, end: Math.min(slice.length, highlightStart + 160) },
  }
}

export class ScriptIndex {
  /** @param {{maxScripts?: number}} [options] */
  constructor({ maxScripts = MAX_SCRIPTS } = {}) {
    this.maxScripts = maxScripts
    this.scripts = new Map()
  }

  get size() {
    return this.scripts.size
  }

  /** Record a `Debugger.scriptParsed` event. */
  noteParsed(sessionId, params) {
    const scriptId = String(params.scriptId)
    const key = scriptKeyOf(sessionId, scriptId)
    if (this.scripts.has(key)) {
      const existing = this.scripts.get(key)
      existing.endLine = Number.isInteger(params.endLine) ? params.endLine : existing.endLine
      existing.sourceMapURL = params.sourceMapURL || existing.sourceMapURL
      return existing
    }
    const meta = {
      key,
      sessionId,
      scriptId,
      url: String(params.url || ''),
      sourceMapURL: params.sourceMapURL || '',
      isModule: params.isModule === true,
      startLine: Number.isInteger(params.startLine) ? params.startLine : 0,
      endLine: Number.isInteger(params.endLine) ? params.endLine : 0,
    }
    this.scripts.set(key, meta)
    while (this.scripts.size > this.maxScripts) {
      const oldest = this.scripts.keys().next().value
      this.scripts.delete(oldest)
    }
    return meta
  }

  removeSession(sessionId) {
    for (const [key, meta] of this.scripts) {
      if (meta.sessionId !== sessionId) continue
      this.scripts.delete(key)
    }
  }

  clear() {
    this.scripts.clear()
  }

  /**
   * Script list, newest first, optionally filtered by URL.
   * @param {{q?: string, limit?: number}} [options]
   */
  list({ q, limit = 100 } = {}) {
    const needle = q ? String(q).toLowerCase() : null
    const max = Math.min(500, Math.max(1, Number(limit) || 100))
    const out = []
    const values = [...this.scripts.values()]
    for (let i = values.length - 1; i >= 0; i--) {
      const meta = values[i]
      if (needle && !meta.url.toLowerCase().includes(needle)) continue
      out.push({ ...meta, label: meta.url || `inline:${meta.scriptId}` })
      if (out.length >= max) break
    }
    return out
  }

  getMeta(key) {
    return this.scripts.get(String(key)) || null
  }
}
