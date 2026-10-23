/**
 * dsh-flowspot：Windows 系统代理控制。
 *
 * 必须做两步，两步都不贵：
 *   1. 写 HKCU\...\Internet Settings 下的三个值（ProxyEnable / ProxyServer /
 *      ProxyOverride）——用户配置单元，不用提权；
 *   2. 用 InternetSetOption 广播这次变更，否则已经在跑的进程会一直用缓存里的旧设置。
 *
 * 第一次改动之前先备份原值，这样停止抓包时恢复的是用户原本的设置，而不是猜一个默认值。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
// 本机与局域网地址不走代理，否则访问 localhost 也会被绕进抓包隧道。
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

// 读一个注册表值。reg.exe 的输出格式是「名称 类型 值」，列之间两个以上空格对齐，
// 所以按 2+ 空格切列，值本身里的单个空格才不会把值切碎。
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
    // 备份放在数据目录里：进程重启或换会话后，恢复系统代理时还能读到用户原来的值。
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

  /**
   * 把系统代理指向 127.0.0.1:port，并先把原值记下来。
   * 备份文件放在数据目录里，所以换目录/重启后恢复仍然有据可依；已经存在就不覆盖，
   * 免得把用户真正的原始设置换成「上一次抓包时的代理」。
   */
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
    // 写完必须广播：只改注册表的话，已经开着的浏览器和后台进程仍走直连。
    const broadcast = await this.notify()
    const on = await this.read()
    this.log.event?.('info', 'system-proxy', {
      action: 'enable',
      port,
      server: on.server,
      broadcast: broadcast !== null,
    })
    return on
  }

  /** 恢复备份里的值；没有备份就干脆把代理关掉。 */
  async disable() {
    if (!this.supported) return { supported: false, enabled: false }
    let backup = null
    try {
      if (fs.existsSync(this.backupPath)) backup = JSON.parse(fs.readFileSync(this.backupPath, 'utf8'))
    } catch {
      backup = null
    }
    // 备份里连 server 都没记下来，说明用户原本就没配代理，关掉才是原来的状态。
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
      /* 没有要删的文件 */
    }
    const broadcast = await this.notify()
    const off = await this.read()
    this.log.event?.('info', 'system-proxy', {
      action: 'disable',
      restored: Boolean(backup),
      server: off.server,
      broadcast: broadcast !== null,
    })
    return off
  }

  /** 广播这次注册表变更，让正在运行的进程重新读一遍设置。 */
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

  /** 定位同目录下的 sysproxy.ps1；import.meta.url 是 file:// URL，得先转成路径。 */
  psScriptPath() {
    return fileURLToPath(PS_SCRIPT)
  }
}

export const systemProxyBypass = BYPASS
