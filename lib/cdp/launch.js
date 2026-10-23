/**
 * dsh-flowspot: launch (or reconnect to) the browser this plugin is allowed to
 * debug.
 *
 * Chrome 136 and later ignore `--remote-debugging-port` when the default
 * user-data directory is used, so the channel always owns a separate profile
 * under DSH home. That profile is what makes the authorization one-time: the
 * operator logs in once, and later launches/restarts reuse the same cookies.
 *
 * The pointer file remembers which port/process the channel last used, so a DSH
 * restart can silently reattach instead of asking the operator again.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { systemBin } from '../sysbin.js'
import { dshHome } from '../location.js'

/** Pointer file under DSH home (not the data directory: it survives a data-dir switch). */
export function cdpPointerFile() {
  return path.join(dshHome(), 'dsh-flowspot.cdp.json')
}

/** Where the controlled browser keeps its profile. */
export function cdpProfileDir() {
  return path.join(dshHome(), 'dsh-flowspot.cdp', 'profile')
}

/** The pointer written by the last successful launch/attach, or null. */
export function readCdpPointer() {
  try {
    const raw = JSON.parse(fs.readFileSync(cdpPointerFile(), 'utf8'))
    const port = Number(raw && raw.port)
    if (!Number.isInteger(port) || port <= 0) return null
    return {
      enabled: raw.enabled !== false,
      port,
      pid: Number.isInteger(Number(raw.pid)) ? Number(raw.pid) : null,
      external: raw.external === true,
      browserPath: typeof raw.browserPath === 'string' ? raw.browserPath : '',
      profileDir: typeof raw.profileDir === 'string' ? raw.profileDir : cdpProfileDir(),
      // The port the browser was launched against: a running browser cannot be
      // re-pointed at a different proxy, so launch compares it before reusing.
      proxyPort: Number.isInteger(Number(raw.proxyPort)) ? Number(raw.proxyPort) : null,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    }
  } catch {
    return null
  }
}

export function writeCdpPointer(pointer) {
  const file = cdpPointerFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
}

export function clearCdpPointer() {
  try {
    fs.unlinkSync(cdpPointerFile())
  } catch {
    /* already gone */
  }
}

/**
 * Browser executables to try, in order. An explicit path (config or env) wins,
 * then Chrome (per-user install first), then Edge.
 * @param {string} [explicit] operator-provided browser path
 * @param {object} [env] environment-like object
 * @returns {string[]} candidate paths
 */
export function browserCandidates(explicit = '', env = process.env) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (env.DSH_FLOWSPOT_BROWSER) candidates.push(env.DSH_FLOWSPOT_BROWSER)
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  candidates.push(
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  )
  return candidates
}

/**
 * First existing browser executable.
 * @param {string} [explicit]
 * @returns {{path: string, name: string}|null}
 */
export function findBrowser(explicit = '') {
  for (const candidate of browserCandidates(explicit)) {
    try {
      if (candidate && fs.existsSync(candidate)) return { path: candidate, name: path.basename(candidate) }
    } catch {
      /* unreadable candidate, try the next one */
    }
  }
  return null
}

/**
 * Launch flags for a browser this plugin may debug. `--proxy-server` is not
 * optional: the flow and its call chain must come from the same browser.
 * @param {{profileDir: string, proxyPort: number}} options
 * @returns {string[]}
 */
export function buildLaunchArgs({ profileDir, proxyPort }) {
  return [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    // "<-loopback>" disables the implicit bypass, so localhost apps are captured too.
    '--proxy-bypass-list=<-loopback>',
  ]
}

/**
 * Read `<profile>/DevToolsActivePort`: first line is the port, second the
 * browser websocket path. Chrome writes it once per process that owns the
 * profile.
 * @param {string} profileDir
 * @returns {{port: number, wsPath: string}|null}
 */
export function readDevToolsActivePort(profileDir) {
  try {
    const [portLine, wsPath] = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
    const port = Number(portLine)
    if (!Number.isInteger(port) || port <= 0) return null
    return { port, wsPath: wsPath || '' }
  } catch {
    return null
  }
}

/**
 * GET /json/version from a debugging endpoint.
 * @param {number} port
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{Browser?: string, 'Protocol-Version'?: string, webSocketDebuggerUrl: string}>}
 */
export function probeVersion(port, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          if (!parsed || typeof parsed.webSocketDebuggerUrl !== 'string') {
            reject(new Error(`CDP 端口 ${port} 没有返回调试地址`))
            return
          }
          resolve(parsed)
        } catch {
          reject(new Error(`CDP 端口 ${port} 返回的不是 JSON`))
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error(`CDP 端口 ${port} 探活超时`)))
    request.on('error', reject)
  })
}

/** Does this PID still exist? */
export function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Kill the browser and everything it spawned (Windows process tree). */
export function killTree(pid) {
  if (!pid) return
  try {
    const child = spawn(systemBin('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch {
    /* the browser is already gone */
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Launch the controlled browser and wait until it publishes its debugging port.
 *
 * A second launch against a profile already served by a running browser only
 * opens a tab in that browser and exits without writing a new port file, so an
 * existing endpoint is probed first and reused when alive.
 * @param {{exe: {path: string}, profileDir: string, proxyPort: number, timeoutMs?: number, log?: object}} options
 * @returns {Promise<{pid: number|null, port: number, version: object, reused: boolean}>}
 */
export async function launchBrowser({ exe, profileDir, proxyPort, timeoutMs = 15000, log = console }) {
  fs.mkdirSync(profileDir, { recursive: true })

  const existing = readDevToolsActivePort(profileDir)
  if (existing) {
    const version = await probeVersion(existing.port).catch(() => null)
    if (version) return { pid: null, port: existing.port, version, reused: true }
    // Stale file: remove it before launching so the wait below only sees the new port.
    try {
      fs.unlinkSync(path.join(profileDir, 'DevToolsActivePort'))
    } catch {
      /* lost the race with Chrome, harmless */
    }
  }

  const child = spawn(exe.path, buildLaunchArgs({ profileDir, proxyPort }), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  const deadline = Date.now() + timeoutMs
  let port = null
  while (Date.now() < deadline) {
    const active = readDevToolsActivePort(profileDir)
    if (active) {
      port = active.port
      break
    }
    if (child.exitCode !== null) break
    await delay(150)
  }

  if (!port) {
    killTree(child.pid)
    log.warn?.('[dsh-flowspot] 受控浏览器没有写出 DevToolsActivePort')
    throw new Error('受控浏览器没有写出调试端口：profile 可能被另一个 Chrome 占用，或浏览器启动失败。把它关掉后重试')
  }

  const version = await probeVersion(port).catch((err) => {
    killTree(child.pid)
    throw err
  })
  return { pid: child.pid, port, version, reused: false }
}
