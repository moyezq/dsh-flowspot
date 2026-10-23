/**
 * dsh-flowspot：CA 的信任库操作（Windows，当前用户）。
 *
 * 装进 `Cert:\CurrentUser\Root` 不需要提权，而且 Chrome、Edge 和基于 WinINet 的客户端
 * 读的就是这里。安装/删除交给 certutil；查询交给 PowerShell，因为 `certutil -store`
 * 的输出是本地化的，在非英文 Windows 上一解析就错。
 */

import { execFile } from 'node:child_process'
import { systemBin } from './sysbin.js'

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} 失败: ${(stderr || err.message).trim()}`))
      else resolve(String(stdout))
    })
  })
}

export class CertStore {
  constructor({ caPath, thumbprint, log }) {
    this.caPath = caPath
    this.thumbprint = String(thumbprint || '').toUpperCase()
    this.log = log || { warn() {} }
  }

  get supported() {
    return process.platform === 'win32'
  }

  /**
   * 取一份干净的大写 thumbprint。它后面会被拼进 PowerShell 脚本字符串，所以先做
   * 白名单校验，只放行十六进制字符，避免注入。
   */
  _thumb() {
    if (!/^[0-9A-F]+$/.test(this.thumbprint)) throw new Error(`thumbprint 非法: ${this.thumbprint}`)
    return this.thumbprint
  }

  /** 我们的 CA 在不在当前用户的 Root 存储里？ */
  async status() {
    if (!this.supported) return { supported: false, installed: false, thumbprint: this.thumbprint }
    try {
      // 只数数量，不读 certutil 的本地化文本，非英文 Windows 上也能用。
      const script = `(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '${this._thumb()}' } | Measure-Object).Count`
      const out = await run(systemBin('powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script])
      const count = Number(String(out).trim())
      return { supported: true, installed: count > 0, count, thumbprint: this.thumbprint, path: this.caPath }
    } catch (err) {
      this.log.warn(`[dsh-flowspot] 查询证书存储失败：${err.message}`)
      return { supported: true, installed: false, error: err.message, thumbprint: this.thumbprint, path: this.caPath }
    }
  }

  /** 给当前用户信任这个 CA（不需要提权）。 */
  async install() {
    if (!this.supported) throw new Error('CA 自动安装目前只支持 Windows')
    let out
    try {
      out = await run(systemBin('certutil.exe'), ['-addstore', '-user', 'Root', this.caPath])
    } catch (err) {
      this.log.event?.('warn', 'ca-install-failed', { thumbprint: this.thumbprint, error: err.message })
      throw err
    }
    // certutil 返回 0 不代表一定装上了，装完再查一遍才算数。
    const status = await this.status()
    if (!status.installed) {
      this.log.event?.('warn', 'ca-install-failed', {
        thumbprint: this.thumbprint,
        error: 'not-in-store',
        output: String(out || '').trim().slice(0, 500),
      })
      throw new Error(`certutil 已执行但证书未出现在 Root 存储：${out.trim()}`)
    }
    this.log.event?.('info', 'ca-install', { thumbprint: this.thumbprint, installed: status.installed })
    return { ok: true, output: out.trim(), status }
  }

  /** 从当前用户的 Root 存储里删掉这个 CA。 */
  async uninstall() {
    if (!this.supported) throw new Error('CA 自动卸载目前只支持 Windows')
    let out
    try {
      out = await run(systemBin('certutil.exe'), ['-delstore', '-user', 'Root', this._thumb()])
    } catch (err) {
      this.log.event?.('warn', 'ca-uninstall-failed', { thumbprint: this.thumbprint, error: err.message })
      throw err
    }
    const status = await this.status()
    this.log.event?.('info', 'ca-uninstall', { thumbprint: this.thumbprint, installed: status.installed })
    return { ok: !status.installed, output: out.trim(), status }
  }
}
