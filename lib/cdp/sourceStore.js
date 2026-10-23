/**
 * dsh-flowspot: 落盘的脚本源码。
 *
 * CDP 不会主动推 JS 正文：`Debugger.scriptParsed` 只给元数据（scriptId / URL / 行列范围），
 * 要正文必须发一次 `Debugger.getScriptSource`——它读的是渲染进程里 V8 已保留的脚本对象，
 * 不是重新下载，但**每次都要显式要一份**。所以「抓取时顺便存」只能这样做：在抓取阶段
 * 对**调用链涉及的那几个脚本**各要一次，写到 `<dataDir>/scripts`；之后源码查看器、定位、
 * 整份翻页全部读这里的文件，不再向浏览器要第二份。
 *
 * 边界由调用方定：单脚本上限（默认 4MB）与总量上限（默认 256MB）。超限不落盘，
 * 但把原因记进索引，面板才能解释「为什么这个脚本看不了」；清空跟「清空 CDP」一起做。
 */
import fs from 'node:fs'
import path from 'node:path'

export const MAX_SCRIPT_CHARS = 4 * 1024 * 1024
export const MAX_TOTAL_CHARS = 256 * 1024 * 1024
const INDEX_FILE = 'index.json'
const SUBDIR = 'scripts'

export class SourceStore {
  /**
   * @param {{resolveDir?: Function, log?: object, maxScriptChars?: number, maxTotalChars?: number}} [options]
   *   `resolveDir` 每次取数据目录（面板可以改目录，改了之后这里跟着换）。
   */
  constructor({ resolveDir = () => '', log = null, maxScriptChars = MAX_SCRIPT_CHARS, maxTotalChars = MAX_TOTAL_CHARS } = {}) {
    this.resolveDir = resolveDir
    this.log = log
    this.maxScriptChars = maxScriptChars
    this.maxTotalChars = maxTotalChars
    this.dir = ''
    this.loaded = false
    this.entries = new Map()
    this.reasons = new Map()
  }

  /** 目录一变（换了数据目录）就重新读索引。 */
  _ensure() {
    const dir = path.join(String(this.resolveDir() || ''), SUBDIR)
    if (this.loaded && dir === this.dir) return
    this.dir = dir
    this.loaded = true
    this.entries = new Map()
    this.reasons = new Map()
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'))
      for (const [key, meta] of Object.entries(raw.entries || {})) {
        if (meta && typeof meta.file === 'string') this.entries.set(key, meta)
      }
      for (const [key, meta] of Object.entries(raw.reasons || {})) {
        if (meta && typeof meta.reason === 'string') this.reasons.set(key, meta)
      }
    } catch {
      /* 第一次跑或索引坏了：当空表 */
    }
  }

  /** `ext:<tabId>:2199` 这种 key 不能直接当文件名。 */
  _fileOf(key) {
    return `${String(key).replace(/[^A-Za-z0-9._-]+/g, '_')}.js`
  }

  _save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const payload = { entries: Object.fromEntries(this.entries), reasons: Object.fromEntries(this.reasons) }
      fs.writeFileSync(path.join(this.dir, INDEX_FILE), `${JSON.stringify(payload)}\n`, 'utf8')
    } catch (err) {
      this.log?.warn?.(`[dsh-flowspot] 源码索引写入失败：${err.message}`)
    }
  }

  get size() {
    this._ensure()
    return this.entries.size
  }

  get totalChars() {
    this._ensure()
    let total = 0
    for (const meta of this.entries.values()) total += Number(meta.chars) || 0
    return total
  }

  /** 这个脚本是不是已经落过盘。 */
  has(key) {
    this._ensure()
    return this.entries.has(String(key))
  }

  /**
   * 存一份源码。
   * @returns {{stored: boolean, chars: number, reason?: string}}
   */
  put({ key, url = '', scriptId = '', sessionId = '', text }) {
    this._ensure()
    const value = String(text || '')
    const chars = value.length
    const id = String(key)
    if (!this.dir) return { stored: false, chars, reason: '还没有数据目录，源码没落盘' }
    if (chars > this.maxScriptChars) {
      const reason = `脚本 ${chars} 字符，超过单脚本上限 ${this.maxScriptChars}，没落盘`
      this.noteFailure({ key: id, url, chars, reason })
      return { stored: false, chars, reason }
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const file = this._fileOf(id)
      fs.writeFileSync(path.join(this.dir, file), value, 'utf8')
      this.entries.set(id, { url: String(url || ''), scriptId: String(scriptId || ''), sessionId: String(sessionId || ''), chars, at: Date.now(), file })
      this.reasons.delete(id)
      this._prune()
      this._save()
      return { stored: true, chars }
    } catch (err) {
      const reason = `写入失败：${err.message}`
      this.noteFailure({ key: id, url, chars, reason })
      return { stored: false, chars, reason }
    }
  }

  /** 记下「为什么没落盘」，重载索引后仍能解释。 */
  noteFailure({ key, url = '', chars = 0, reason }) {
    this._ensure()
    this.reasons.set(String(key), { url: String(url || ''), chars: Number(chars) || 0, reason: String(reason || ''), at: Date.now() })
    this._save()
  }

  /** 读落盘的源码；没有就 null（不碰浏览器）。 */
  get(key) {
    this._ensure()
    const id = String(key)
    const meta = this.entries.get(id)
    if (!meta) return null
    try {
      return fs.readFileSync(path.join(this.dir, meta.file), 'utf8')
    } catch {
      this.entries.delete(id)
      this._save()
      return null
    }
  }

  meta(key) {
    this._ensure()
    return this.entries.get(String(key)) || null
  }

  /** 这个脚本的绝对路径；没落盘就 null。给「打开所在文件夹」用。 */
  pathOf(key) {
    this._ensure()
    const meta = this.entries.get(String(key))
    if (!meta || !this.dir) return null
    return path.join(this.dir, meta.file)
  }

  /** 落盘目录本身（还没落过盘时也返回，交给调用方建目录）。 */
  get directory() {
    this._ensure()
    return this.dir
  }

  /** 没落盘的原因（超限 / 读不到 / 写入失败），没有就 null。 */
  reasonOf(key) {
    this._ensure()
    const meta = this.reasons.get(String(key))
    return meta ? meta.reason : null
  }

  /** 已落盘的脚本清单，供 agent 列表用。 */
  list({ limit = 200 } = {}) {
    this._ensure()
    const max = Math.min(1000, Math.max(1, Number(limit) || 200))
    return [...this.entries.entries()]
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, max)
      .map(([key, meta]) => ({ key, ...meta }))
  }

  /** 总量超限时按时间淘汰最旧的。 */
  _prune() {
    let total = this.totalChars
    if (total <= this.maxTotalChars) return
    const oldest = [...this.entries.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
    for (const [key, meta] of oldest) {
      if (total <= this.maxTotalChars) break
      total -= Number(meta.chars) || 0
      this.entries.delete(key)
      this.reasons.set(key, { url: meta.url, chars: meta.chars, reason: '源码总量超过上限，被淘汰', at: Date.now() })
      try {
        fs.unlinkSync(path.join(this.dir, meta.file))
      } catch {
        /* 文件已经不在了 */
      }
    }
  }

  /** 跟「清空 CDP」一起清：删文件、清索引。 */
  clear() {
    this._ensure()
    for (const meta of this.entries.values()) {
      try {
        fs.unlinkSync(path.join(this.dir, meta.file))
      } catch {
        /* 文件已经不在了 */
      }
    }
    this.entries = new Map()
    this.reasons = new Map()
    this._save()
  }
}
