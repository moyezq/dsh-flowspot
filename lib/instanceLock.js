/**
 * 实例锁：同一份数据目录，一次只让一个 DSH 实例真正抓包。
 *
 * web 版和桌面端共用 `$DSH_HOME/dsh-flowspot`（CA、`scripts/` 索引、flows、
 * `sysproxy.backup.json` 都是同一份）。两边同时点「开始抓包」会互相踩：后开的把
 * 系统代理改到自己端口、先停的又把代理恢复成旧值，最坏的结果是代理指向一个已经
 * 没人监听的端口，整台机器上不了网。
 *
 * 所以抓包前先拿锁：`<dataDir>/instance.lock` 里记 `{ pid, port, startedAt }`。
 * 锁是「谁在写共享状态」的凭据，不是访问控制——读列表、看历史不需要它。
 *
 * 三条规则：
 *  - 拿锁时若发现另一个**还活着**的进程持有 → 拒绝，并把持有者报给调用方；
 *  - 持有的进程已经退出（崩溃、被关）→ 视为陈旧锁，直接接管；
 *  - 释放时只删自己写的那把（比 pid），不会误删别人的。
 */

import fs from 'node:fs'
import path from 'node:path'

/** pid 还活着吗？`EPERM` 说明进程在、只是没权限发信号，也算活着。 */
function alive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

export class InstanceLock {
  /**
   * @param {{dir: string, log?: {warn?: Function, event?: Function}}} options
   *   `dir` 是数据目录（锁文件放它下面）
   */
  constructor({ dir, log }) {
    this.file = path.join(dir, 'instance.lock')
    this.log = log || {}
    this.held = false
    this.meta = null
  }

  /** 读锁文件；坏文件当没有。 */
  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * 当前锁的持有者，带上「活没活」「是不是我」。
   * @returns {{pid: number, port: number|null, startedAt?: string, alive: boolean, mine: boolean}|null}
   */
  peek() {
    const meta = this.read()
    if (!meta || !meta.pid) return null
    return {
      pid: meta.pid,
      port: meta.port ?? null,
      startedAt: meta.startedAt || null,
      alive: meta.pid === process.pid ? true : alive(meta.pid),
      mine: meta.pid === process.pid,
    }
  }

  /**
   * 拿锁。
   * @param {{port?: number|null}} [options]
   * @returns {{ok: boolean, holder?: object, stale?: boolean, error?: string}}
   */
  acquire({ port = null } = {}) {
    const existing = this.peek()
    if (existing && existing.alive && !existing.mine) {
      return { ok: false, holder: existing }
    }
    const stale = Boolean(existing && !existing.alive)
    this.meta = {
      pid: process.pid,
      port: port ?? null,
      startedAt: new Date().toISOString(),
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, `${JSON.stringify(this.meta, null, 2)}\n`, 'utf8')
    } catch (err) {
      return { ok: false, error: err.message }
    }
    this.held = true
    if (stale && existing) {
      this.log.event?.('info', 'instance-lock-stale', { stalePid: existing.pid })
    }
    this.log.event?.('info', 'instance-lock', { pid: process.pid, port: this.meta.port, stale })
    return { ok: true, holder: this.meta, stale }
  }

  /** 放锁：只删自己写的那把。 */
  release() {
    const existing = this.read()
    if (existing && existing.pid !== process.pid) return false
    this.held = false
    this.meta = null
    try {
      fs.unlinkSync(this.file)
      this.log.event?.('info', 'instance-lock-release', { pid: process.pid })
      return true
    } catch {
      return false
    }
  }

  /** 别的活实例正占着锁吗？破坏性操作（清空源码、重置数据目录）用它挡一下。 */
  blockedByOther() {
    const existing = this.peek()
    return existing && existing.alive && !existing.mine ? existing : null
  }

  /** 把「另一个实例在抓包」说成人话。 */
  static describe(holder) {
    if (!holder) return ''
    const where = holder.port ? `，端口 ${holder.port}` : ''
    return `另一个 DSH 实例（pid ${holder.pid}${where}）正在抓包；两个实例共用同一份数据目录，同时写会互相踩。`
  }
}
