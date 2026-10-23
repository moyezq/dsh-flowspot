/**
 * Windows 系统命令的解析。
 *
 * 本插件要调 `certutil.exe` / `powershell.exe` / `reg.exe` / `explorer.exe` /
 * `taskkill.exe`，这些都在 `%SystemRoot%\System32` 下。平时靠 PATH 找没问题，但
 * **由 GUI 启动的进程 PATH 经常被裁剪**——Electron 打包的 DSH Desktop 就是典型：
 * 拿不到 `certutil` 就表现为「CA 装不上、系统代理改不动」，用户看到的只是失败。
 *
 * 所以统一走这里：能拼出 System32 的绝对路径就用绝对路径，拼不出或文件不在再退回
 * 裸命令名（保持原来的行为，也让非 Windows 与测试里注入的假环境不受影响）。
 *
 * 只处理确定住在 System32 的几个命令；其它名字（比如我们自己拼的 exe 路径）原样返回。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 这些命令能安全地在 System32 下找到同名 exe。 */
const IN_SYSTEM32 = new Set(['certutil.exe', 'powershell.exe', 'taskkill.exe', 'explorer.exe', 'reg.exe', 'where.exe', 'cmd.exe'])

/**
 * 把系统命令名解析成可执行路径。
 * @param {string} name 命令名（`certutil.exe` 或 `certutil`）
 * @param {{platform?: string, systemRoot?: string, exists?: (p: string) => boolean}} [options]
 *   仅测试用：注入平台、SystemRoot 与文件探测；默认取当前进程的真实值。
 * @returns {string} 绝对路径，或原样的命令名（非 Windows / 不在白名单 / 文件不存在）
 */
export function systemBin(name, options = {}) {
  const bare = String(name || '').trim()
  if (!bare) throw new Error('没有命令名')
  const platform = options.platform || process.platform
  if (platform !== 'win32') return bare
  const file = bare.toLowerCase().endsWith('.exe') ? bare : `${bare}.exe`
  if (!IN_SYSTEM32.has(file.toLowerCase())) return bare
  const root = options.systemRoot || process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const exists = options.exists || fs.existsSync
  const absolute = path.join(root, 'System32', file)
  return exists(absolute) ? absolute : bare
}
