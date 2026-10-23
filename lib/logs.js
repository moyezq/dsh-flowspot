/**
 * dsh-flowspot: 插件自己的运行埋点。
 *
 * 这里只该出现「不是请求」的事件：一条请求的结果已经在 flows 的 JSONL 里，
 * 把头或体抄进日志既撑大文件又扩散密钥。少了这个文件就说不清的，是「为什么
 * 会这样」——端口回退、系统代理没恢复、certutil 拒装 CA、数据目录换了地方。
 *
 * 形状：一行一个 JSON 对象（`ts` / `level` / `event` / `detail`），一天一个
 * 文件，按大小轮转，并且硬性只留最近几份。文件在第一条事件时才打开，所以
 * 加载了却一直没用的插件不会留下 `logs/` 目录。
 */

import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

/** 单个文件的上限（字节），以及轮转后保留几份。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_KEEP = 3

/** `plugin-2026-10-22-01.ndjson` —— 本模块只删这种名字的文件。 */
const FILE_RE = /^plugin-\d{4}-\d{2}-\d{2}-\d{2}\.ndjson$/

/**
 * 本模块拥有的日志文件，最旧的在前。
 * @param {string|null} dir `logs/` 目录
 * @returns {string[]} 绝对路径
 */
export function logFiles(dir) {
  if (!dir) return []
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => FILE_RE.test(name))
      .sort()
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/**
 * 读最近的日志事件，最新的一条在最前。
 *
 * 只读本模块自己的文件；一行一个 JSON，坏行跳过而不是让整次读取失败——日志
 * 正是坏掉时才有人读。`since` 用毫秒时间戳，`limit` 有硬上限，避免把两天的
 * 文件一次塞给面板。
 * @param {{dir?: string|null, limit?: number, level?: string, event?: string, since?: number}} [options]
 * @returns {{ts: string, level: string, event: string, detail: unknown}[]}
 */
export function readLogEvents({ dir = null, limit = 100, level = '', event = '', since = 0 } = {}) {
  if (!dir) return []
  const max = Math.min(500, Math.max(1, Number(limit) || 100))
  const files = logFiles(dir).reverse()
  const out = []
  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index].trim()
      if (!line) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (!entry || typeof entry !== 'object') continue
      if (level && entry.level !== level) continue
      if (event && !String(entry.event || '').includes(event)) continue
      if (since && Date.parse(entry.ts) <= Number(since)) continue
      out.push({
        ts: entry.ts || '',
        level: entry.level || '',
        event: entry.event || '',
        detail: entry.detail === undefined ? null : entry.detail,
      })
      if (out.length >= max) return out
    }
  }
  return out
}

/**
 * 在系统文件管理器里打开一个目录（Windows）。目录不存在时先建，这样第一次点
 * 「打开文件夹」也有反馈，而不是让资源管理器报错。
 * @param {string} dir
 * @returns {string} 打开的目录
 */
export function openDirectory(dir) {
  if (!dir) throw new Error('没有可打开的目录')
  fs.mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
  } else {
    throw new Error('打开目录只支持 Windows')
  }
  return dir
}

/** 兼容旧名字：日志目录只是 openDirectory 的一个用法。 */
export const openLogFolder = openDirectory

/**
 * 在系统文件管理器里**选中**一个文件（Windows 的 `explorer /select,`）。
 *
 * 文件不在时退回到打开它所在的目录：让用户至少能落到目录里，而不是弹一个
 * 资源管理器报错对话框。JS 源码想自己复制出来分析时走这条。
 * @param {string} file 绝对路径
 * @returns {string} 实际打开的目标（文件或目录）
 */
export function revealInFolder(file) {
  const target = String(file || '')
  if (!target) throw new Error('没有可打开的文件')
  if (process.platform !== 'win32') throw new Error('打开文件位置只支持 Windows')
  if (!fs.existsSync(target)) {
    const dir = path.dirname(target)
    if (dir && fs.existsSync(dir)) return openDirectory(dir)
    throw new Error(`文件不存在：${target}`)
  }
  const child = spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return target
}


export class PluginLog {
  /**
   * @param {{dir?: string|null, logger?: object, maxBytes?: number, keep?: number}} [options]
   *   `dir` 是 `logs/` 目录；不传时每次写入都是空操作。
   */
  constructor({ dir = null, logger = null, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
    this.dir = dir
    this.logger = logger || {}
    this.maxBytes = Math.max(64 * 1024, Number(maxBytes) || DEFAULT_MAX_BYTES)
    this.keep = Math.max(1, Number(keep) || DEFAULT_KEEP)
    this.stream = null
    this.file = null
    this.bytes = 0
    this.failed = false
  }

  /** 追加一条事件。永不抛错：日志坏了不能把抓包带崩（失败只报一次，见 _fail）。 */
  write(level, event, detail) {
    if (!this.dir) return
    let line
    try {
      line = `${JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        detail: detail === undefined ? null : detail,
      })}\n`
    } catch {
      return
    }
    try {
      if (!this.stream) this.open()
      if (!this.stream) return
      if (this.bytes + line.length > this.maxBytes) {
        this.close()
        this.open()
        if (!this.stream) return
      }
      this.stream.write(line)
      this.bytes += line.length
    } catch (err) {
      this._fail(err)
    }
  }

  /**
   * 打开当天的下一个序号文件，并顺手淘汰过旧的。
   * 用追加方式打开，重启后接着写同一份，而不是把已有事件截掉。
   * @returns {string|null} 当前正在写的文件
   */
  open() {
    if (!this.dir || this.stream) return this.file
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const day = new Date().toISOString().slice(0, 10)
      const seq = String(this._nextSeq(day)).padStart(2, '0')
      const file = path.join(this.dir, `plugin-${day}-${seq}.ndjson`)
      const stream = fs.createWriteStream(file, { flags: 'a' })
      stream.on('error', (err) => this._fail(err))
      this.stream = stream
      this.file = file
      // 已有文件按实际大小接着算，否则重启后要等攒满整个上限才会轮转。
      this.bytes = fs.existsSync(file) ? fs.statSync(file).size : 0
      this._prune()
    } catch (err) {
      this._fail(err)
    }
    return this.file
  }

  close() {
    try {
      this.stream?.end()
    } catch {
      /* 已经关过了 */
    }
    this.stream = null
  }

  /** 本模块自己拥有的文件，最旧的在前。 */
  files() {
    return logFiles(this.dir)
  }

  /** 当天已经用到过的最大的序号，重启后接着往下排，而不是从头覆盖。 */
  _nextSeq(day) {
    const prefix = `plugin-${day}-`
    let max = 0
    for (const file of this.files()) {
      const name = path.basename(file)
      if (!name.startsWith(prefix)) continue
      const seq = Number(name.slice(prefix.length, prefix.length + 2))
      if (Number.isInteger(seq) && seq > max) max = seq
    }
    return max + 1
  }

  /** 只留最新 keep 份：挡住 `logs/` 无限长大。 */
  _prune() {
    const owned = this.files()
    for (const file of owned.slice(0, Math.max(0, owned.length - this.keep))) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* 已经被别人先删掉了 */
      }
    }
  }

  /** 写失败只报一次：磁盘坏了不能变成日志风暴。 */
  _fail(err) {
    this.close()
    this.stream = null
    if (this.failed) return
    this.failed = true
    this.logger.warn?.(`[dsh-flowspot] 运行日志写入失败：${err.message}`)
  }
}
