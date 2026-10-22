/**
 * dsh-flowspot: CA trust-store operations (Windows, current user).
 *
 * Installing into `Cert:\CurrentUser\Root` needs no elevation and is what
 * Chrome, Edge and WinINet-based clients read. certutil does the mutation;
 * PowerShell does the query because `certutil -store` output is localized and
 * parsing it breaks on non-English Windows.
 */

import { execFile } from 'node:child_process'

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

  _thumb() {
    if (!/^[0-9A-F]+$/.test(this.thumbprint)) throw new Error(`thumbprint 非法: ${this.thumbprint}`)
    return this.thumbprint
  }

  /** Is our CA present in the current user's Root store? */
  async status() {
    if (!this.supported) return { supported: false, installed: false, thumbprint: this.thumbprint }
    try {
      const script = `(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '${this._thumb()}' } | Measure-Object).Count`
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
      const count = Number(String(out).trim())
      return { supported: true, installed: count > 0, count, thumbprint: this.thumbprint, path: this.caPath }
    } catch (err) {
      this.log.warn(`[dsh-flowspot] 查询证书存储失败：${err.message}`)
      return { supported: true, installed: false, error: err.message, thumbprint: this.thumbprint, path: this.caPath }
    }
  }

  /** Trust the CA for the current user (no elevation). */
  async install() {
    if (!this.supported) throw new Error('CA 自动安装目前只支持 Windows')
    const out = await run('certutil.exe', ['-addstore', '-user', 'Root', this.caPath])
    const status = await this.status()
    if (!status.installed) {
      throw new Error(`certutil 已执行但证书未出现在 Root 存储：${out.trim()}`)
    }
    this.log.event?.('info', 'ca-install', { thumbprint: this.thumbprint, installed: status.installed })
    return { ok: true, output: out.trim(), status }
  }

  /** Remove the CA from the current user's Root store. */
  async uninstall() {
    if (!this.supported) throw new Error('CA 自动卸载目前只支持 Windows')
    const out = await run('certutil.exe', ['-delstore', '-user', 'Root', this._thumb()])
    const status = await this.status()
    this.log.event?.('info', 'ca-uninstall', { thumbprint: this.thumbprint, installed: status.installed })
    return { ok: !status.installed, output: out.trim(), status }
  }
}
