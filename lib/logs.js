/**
 * dsh-flowspot: the plugin's own run log (埋点).
 *
 * Only events that are NOT requests belong here: a request's outcome is already
 * in the flows JSONL, and copying headers or bodies into a log would both bloat
 * the file and spread secrets. What is missing without this file is the "why" —
 * a port fallback, a system proxy that failed to restore, a CA install certutil
 * rejected, a data directory that moved.
 *
 * Shape: one JSON object per line (`ts` / `level` / `event` / `detail`), one
 * file per day, a size-capped rotation, and a hard cap on how many files
 * survive. The file is opened on the first event, so a plugin that is loaded
 * but never used leaves no `logs/` directory behind.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Per-file ceiling (bytes) and how many files survive rotation. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_KEEP = 3

/** `plugin-2026-10-22-01.ndjson` — the only names this module ever deletes. */
const FILE_RE = /^plugin-\d{4}-\d{2}-\d{2}-\d{2}\.ndjson$/

export class PluginLog {
  /**
   * @param {{dir?: string|null, logger?: object, maxBytes?: number, keep?: number}} [options]
   *   `dir` is the `logs/` directory; without it every write is a no-op.
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

  /** Append one event. Never throws: logging must not be able to break capture. */
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
   * Open today's file with the next sequence number and prune older ones.
   * @returns {string|null} the file being written
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
      /* already closed */
    }
    this.stream = null
  }

  /** Owned files, oldest first. */
  files() {
    if (!this.dir) return []
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => FILE_RE.test(name))
        .sort()
        .map((name) => path.join(this.dir, name))
    } catch {
      return []
    }
  }

  /** Highest sequence already used today, so a restart continues the series. */
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

  /** Keep the newest `keep` files: the cap that stops `logs/` from growing forever. */
  _prune() {
    const owned = this.files()
    for (const file of owned.slice(0, Math.max(0, owned.length - this.keep))) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* someone else removed it first */
      }
    }
  }

  /** Report a write failure once: a broken disk must not become a log storm. */
  _fail(err) {
    this.close()
    this.stream = null
    if (this.failed) return
    this.failed = true
    this.logger.warn?.(`[dsh-flowspot] 运行日志写入失败：${err.message}`)
  }
}
