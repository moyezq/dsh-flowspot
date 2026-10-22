/**
 * dsh-flowspot: Windows system proxy control.
 *
 * Two steps are required and both are cheap:
 *   1. write HKCU\...\Internet Settings (ProxyEnable / ProxyServer /
 *      ProxyOverride) — user hive, no elevation;
 *   2. broadcast the change through InternetSetOption, otherwise processes
 *      that are already running keep their cached settings.
 *
 * The previous values are backed up before the first change so disabling the
 * proxy restores what the user had, not a guessed default.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const BYPASS = '<local>;127.0.0.1;localhost;*.local'
const PS_SCRIPT = new URL('./sysproxy.ps1', import.meta.url)

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} 失败: ${stderr || err.message}`))
      else resolve(String(stdout))
    })
  })
}

async function queryValue(name) {
  try {
    const out = await run('reg.exe', ['query', KEY, '/v', name])
    const line = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().startsWith(name.toLowerCase()))
    if (!line) return null
    const cells = line.trim().split(/\s{2,}/)
    return cells.length >= 3 ? cells.slice(2).join('  ') : null
  } catch {
    return null
  }
}

async function setValue(name, type, value) {
  await run('reg.exe', ['add', KEY, '/v', name, '/t', type, '/d', String(value), '/f'])
}

export class SystemProxy {
  constructor({ dir, log, powershell = 'powershell.exe' }) {
    this.dir = dir
    this.log = log || { warn() {} }
    this.powershell = powershell
    this.backupPath = path.join(dir, 'sysproxy.backup.json')
  }

  get supported() {
    return process.platform === 'win32'
  }

  async read() {
    if (!this.supported) return { supported: false, enabled: false, server: null, override: null }
    const enabled = await queryValue('ProxyEnable')
    const server = await queryValue('ProxyServer')
    const override = await queryValue('ProxyOverride')
    return {
      supported: true,
      enabled: enabled === '0x1' || enabled === '1',
      server,
      override,
    }
  }

  /** Point the machine at 127.0.0.1:port, remembering the previous values. */
  async enable(port) {
    if (!this.supported) throw new Error('系统代理自动化目前只支持 Windows')
    if (!fs.existsSync(this.backupPath)) {
      const current = await this.read()
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.backupPath, JSON.stringify({
        savedAt: new Date().toISOString(),
        enabled: current.enabled,
        server: current.server,
        override: current.override,
      }, null, 2), 'utf8')
    }
    await setValue('ProxyEnable', 'REG_DWORD', 1)
    await setValue('ProxyServer', 'REG_SZ', `127.0.0.1:${port}`)
    await setValue('ProxyOverride', 'REG_SZ', BYPASS)
    await this.notify()
    const on = await this.read()
    this.log.event?.('info', 'system-proxy', { action: 'enable', port, server: on.server })
    return on
  }

  /** Restore the backed-up values (or turn the proxy off when none exist). */
  async disable() {
    if (!this.supported) return { supported: false, enabled: false }
    let backup = null
    try {
      if (fs.existsSync(this.backupPath)) backup = JSON.parse(fs.readFileSync(this.backupPath, 'utf8'))
    } catch {
      backup = null
    }
    if (backup && backup.server) {
      await setValue('ProxyServer', 'REG_SZ', backup.server)
      await setValue('ProxyOverride', 'REG_SZ', backup.override ?? BYPASS)
      await setValue('ProxyEnable', 'REG_DWORD', backup.enabled ? 1 : 0)
    } else {
      await setValue('ProxyEnable', 'REG_DWORD', 0)
    }
    try {
      fs.unlinkSync(this.backupPath)
    } catch {
      /* nothing to remove */
    }
    await this.notify()
    const off = await this.read()
    this.log.event?.('info', 'system-proxy', { action: 'disable', restored: Boolean(backup), server: off.server })
    return off
  }

  /** Broadcast the registry change so running processes re-read it. */
  async notify() {
    if (!this.supported) return null
    try {
      const out = await run(this.powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', this.psScriptPath(),
        '-Notify',
      ])
      return out.trim()
    } catch (err) {
      this.log.warn(`[dsh-flowspot] InternetSetOption 广播失败：${err.message}`)
      return null
    }
  }

  psScriptPath() {
    return fileURLToPath(PS_SCRIPT)
  }
}

export const systemProxyBypass = BYPASS
