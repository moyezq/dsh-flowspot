/**
 * dsh-flowspot: runtime composition.
 *
 * Everything stateful lives here so index.js, the agent tools and the HTTP
 * routes all talk to the same proxy instance: the plugin is a process-wide
 * singleton and a second copy would fight over the port and the registry.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CertificateAuthority } from './x509.js'
import { CertStore } from './certstore.js'
import { FlowStore } from './flows.js'
import { clearCopyFrom, clearLocation, dshHome, readLocation, readPointer, writeLocation } from './location.js'
import { PluginLog } from './logs.js'
import { MitmProxy } from './proxy.js'
import { SystemProxy } from './sysproxy.js'

/** This package's version, read once so the panel can compare its own build. */
const HOST_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** When this host process loaded the plugin: the page can be newer than this. */
const HOST_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString()

export const DEFAULTS = {
  /** Loopback port for the proxy; 0 asks the OS for a free one. */
  port: 8899,
  /** Data directory; empty means $DSH_HOME/dsh-flowspot. */
  dataDir: '',
  /** Ring size of retained flows. */
  maxFlows: 1000,
  /** Per-body capture cap in bytes. */
  maxBodyBytes: 262144,
  /** Mask Authorization / Cookie / Set-Cookie on capture. */
  redact: true,
  /** Append finished flows to JSONL under the data directory. */
  persist: true,
  /** Validate origin certificates when talking upstream. */
  upstreamRejectUnauthorized: true,
  upstreamTimeoutMs: 30000,
  /** Reuse upstream connections; off by default so a stale socket cannot surface as "socket hang up". */
  upstreamKeepAlive: false,
  /** Point the Windows system proxy here when the proxy starts. */
  setSystemProxyOnStart: true,
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const num = (key) => {
    const value = Number(src[key])
    return Number.isFinite(value) && value > 0 ? value : DEFAULTS[key]
  }
  return {
    port: Number.isInteger(Number(src.port)) && Number(src.port) >= 0 ? Number(src.port) : DEFAULTS.port,
    dataDir: typeof src.dataDir === 'string' && src.dataDir.trim() ? src.dataDir.trim() : DEFAULTS.dataDir,
    maxFlows: num('maxFlows'),
    maxBodyBytes: num('maxBodyBytes'),
    redact: src.redact === undefined ? DEFAULTS.redact : src.redact !== false,
    persist: src.persist === undefined ? DEFAULTS.persist : src.persist !== false,
    upstreamRejectUnauthorized:
      src.upstreamRejectUnauthorized === undefined
        ? DEFAULTS.upstreamRejectUnauthorized
        : src.upstreamRejectUnauthorized !== false,
    upstreamTimeoutMs: num('upstreamTimeoutMs'),
    upstreamKeepAlive: src.upstreamKeepAlive === undefined ? DEFAULTS.upstreamKeepAlive : src.upstreamKeepAlive === true,
    setSystemProxyOnStart:
      src.setSystemProxyOnStart === undefined ? DEFAULTS.setSystemProxyOnStart : src.setSystemProxyOnStart !== false,
  }
}

/** Capture data directory: $DSH_HOME/dsh-flowspot (falls back to ~/.dsh). */
export function captureDataDir() {
  return path.join(dshHome(), 'dsh-flowspot')
}

/**
 * Expand a user-typed data directory into an absolute path, without applying
 * the panel-choice precedence.
 *
 * Rules: empty → the default under DSH home; `~`/`~/x` → the user home;
 * absolute → as given; anything else → relative to the DSH home (not to the
 * process cwd, which differs between the CLI and the desktop app).
 * @param {string} [value] configured or picked dataDir
 * @returns {string} absolute directory
 */
export function expandDataDir(value) {
  const home = dshHome()
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return path.join(home, 'dsh-flowspot')
  const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir())
  return path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded)
}

/**
 * Resolve the data directory this process should use.
 *
 * Precedence: the directory picked in the panel (pointer file) > the plugin
 * config `dataDir` > the default.
 * @param {string} [configured] `dataDir` from the plugin config
 * @returns {string} absolute directory
 */
export function resolveDataDir(configured) {
  return expandDataDir(readLocation() || configured || '')
}

/**
 * Where the effective data directory came from: `ui` (panel choice),
 * `config` (profile config) or `default`.
 * @param {string} [configured] `dataDir` from the plugin config
 * @returns {'ui'|'config'|'default'}
 */
export function dataDirSource(configured) {
  if (readLocation()) return 'ui'
  return typeof configured === 'string' && configured.trim() ? 'config' : 'default'
}

/** Files that make a directory a working capture data directory. */
const DATA_FILES = ['ca.crt', 'ca.key.pem', 'leaf.key.pem', 'leaf.pub.der']

/** Does this directory already hold a certificate authority? */
const hasCa = (dir) => fs.existsSync(path.join(dir, 'ca.crt'))

/** Nearest existing ancestor of `dir`, so a path on a missing volume fails now. */
function existingAncestor(dir) {
  let probe = dir
  for (;;) {
    try {
      if (fs.statSync(probe).isDirectory()) return probe
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
}

/**
 * Record the panel's choice. Nothing is created or copied yet: the running
 * process still holds the old CA and flow file open, so the move belongs to the
 * next start (`adoptPendingCopy`). A choice the operator changes their mind
 * about therefore leaves no empty directory and no copy of the CA private key.
 * @param {string} currentDir directory this process is using
 * @param {string} target path the operator picked
 * @returns {{ok:true, dir:string, previous:string, caCopied:false, copyOnStart:boolean, foreignCa:boolean, restartRequired:boolean}}
 */
export function adoptDataDir(currentDir, target) {
  const next = expandDataDir(target)
  if (next === currentDir) {
    return { ok: true, dir: next, previous: currentDir, caCopied: false, copyOnStart: false, foreignCa: false, restartRequired: false }
  }

  let stat = null
  try {
    stat = fs.statSync(next)
  } catch {
    /* does not exist yet; the next start creates it */
  }
  if (stat && !stat.isDirectory()) throw new Error(`目标不是目录：${next}`)

  // Check writability on the nearest ancestor that exists, so an unwritable
  // drive is refused now instead of at restart time.
  const probe = stat ? next : existingAncestor(next)
  if (!probe) throw new Error(`目标路径不可用：${next}`)
  try {
    fs.accessSync(probe, fs.constants.W_OK)
  } catch {
    throw new Error(`目标目录不可写：${next}`)
  }

  const foreignCa = hasCa(next)
  // Hand the CA over only when the target has none of its own and the current
  // directory has one to give; a foreign CA means "this directory has an owner".
  const copyOnStart = !foreignCa && hasCa(currentDir)
  writeLocation(next, { copyFrom: copyOnStart ? currentDir : null })
  return { ok: true, dir: next, previous: currentDir, caCopied: false, copyOnStart, foreignCa, restartRequired: true }
}

/**
 * Complete a switch recorded by `adoptDataDir`: create the directory and carry
 * the certificate authority over, so the already-trusted root keeps working
 * without a reinstall. Runs once, before the CA is loaded.
 * @param {string} dir directory this process resolved to
 * @returns {{copied: boolean, from: string|null}}
 */
export function adoptPendingCopy(dir) {
  const pointer = readPointer()
  if (!pointer || !pointer.copyFrom) return { copied: false, from: null }
  const from = pointer.copyFrom
  let copied = false
  try {
    if (from !== dir && !hasCa(dir) && hasCa(from)) {
      fs.mkdirSync(dir, { recursive: true })
      for (const name of DATA_FILES) {
        const source = path.join(from, name)
        const target = path.join(dir, name)
        if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target)
      }
      copied = true
    }
  } finally {
    // One-shot handover: leaving `copyFrom` behind would copy the private key
    // into every future directory, including one the operator abandons again.
    clearCopyFrom()
  }
  return { copied, from }
}

export function createRuntime(rawConfig, { log } = {}) {
  const cfg = normalizeConfig(rawConfig)
  const terminal = log || { debug() {}, info() {}, warn() {}, error() {} }
  const dir = resolveDataDir(cfg.dataDir)
  // A directory switch recorded by the panel lands here, before the CA is
  // loaded: this is the first moment the new directory may be created.
  const adopted = adoptPendingCopy(dir)
  fs.mkdirSync(dir, { recursive: true })

  // Two sinks behind one object: the terminal keeps the live view, the file
  // keeps the "why" that would otherwise die with the process. Only warn/error
  // and explicit `event()` calls reach the file — request-level facts already
  // live in the flows JSONL and must not be duplicated here.
  const events = new PluginLog({ dir: path.join(dir, 'logs'), logger: terminal })
  const logger = {
    debug: (...args) => terminal.debug?.(...args),
    info: (...args) => terminal.info?.(...args),
    warn: (...args) => {
      terminal.warn?.(...args)
      events.write('warn', 'warn', args.map(String).join(' '))
    },
    error: (...args) => {
      terminal.error?.(...args)
      events.write('error', 'error', args.map(String).join(' '))
    },
    event: (level, event, detail) => events.write(level, event, detail),
    logFile: () => events.file,
  }
  logger.event('info', 'mount', { dir, version: HOST_VERSION, pid: process.pid })
  if (adopted.from) logger.event('info', 'data-dir', { action: 'adopt', dir, copyFrom: adopted.from, copied: adopted.copied })

  const certs = new CertificateAuthority({ dir, log: logger }).init()
  const certstore = new CertStore({ caPath: certs.caPath, thumbprint: certs.caThumbprint, log: logger })
  const sysproxy = new SystemProxy({ dir, log: logger })
  const store = new FlowStore({
    maxFlows: cfg.maxFlows,
    maxBodyBytes: cfg.maxBodyBytes,
    redact: cfg.redact,
    persistDir: cfg.persist ? path.join(dir, 'flows') : null,
    log: logger,
  })
  const proxy = new MitmProxy({ certs, store, config: cfg, log: logger })

  async function start({ port, systemProxy = cfg.setSystemProxyOnStart } = {}) {
    if (proxy.running) return { running: true, port: proxy.port, already: true, warning: proxy.portNote }
    const actual = await proxy.start(port ?? cfg.port)
    // A port fallback is worth reporting: the system proxy now points at a
    // random port, and the user's "why is it not 8899" question is answered here.
    let warning = proxy.portNote || null
    if (systemProxy) {
      try {
        await sysproxy.enable(actual)
      } catch (err) {
        const message = `代理已启动，但系统代理设置失败：${err.message}`
        warning = warning ? `${warning}；${message}` : message
        logger.warn(`[dsh-flowspot] ${message}`)
      }
    }
    logger.event('info', 'capture-start', { port: actual, systemProxy: Boolean(systemProxy), warning })
    return { running: true, port: actual, warning }
  }

  async function stop() {
    let warning = null
    if (proxy.running) {
      try {
        await sysproxy.disable()
      } catch (err) {
        warning = `系统代理恢复失败：${err.message}`
        logger.warn(`[dsh-flowspot] ${warning}`)
      }
    }
    await proxy.stop()
    logger.event('info', 'capture-stop', { warning })
    return { running: false, warning }
  }

  async function status() {
    const [ca, systemProxy] = await Promise.all([
      certstore.status().catch((err) => ({ supported: false, installed: false, error: err.message })),
      sysproxy.read().catch((err) => ({ supported: false, error: err.message })),
    ])
    // A panel choice only takes effect on the next start, so report it as
    // "pending" instead of pretending the live directory already moved.
    const picked = readLocation()
    const pending = picked && expandDataDir(picked) !== dir ? expandDataDir(picked) : null
    return {
      proxy: proxy.snapshot(),
      systemProxy,
      ca,
      flows: store.stats(),
      paths: { dir, ca: certs.caPath, log: path.join(dir, 'logs'), source: dataDirSource(cfg.dataDir), pending, copyFrom: readPointer()?.copyFrom || null },
      platform: process.platform,
      // The panel is served fresh on every page load while this code only changes
      // when the process restarts. Reporting the host build lets the panel say
      // "you are looking at an older host" instead of failing silently.
      build: { version: HOST_VERSION, startedAt: HOST_STARTED_AT },
    }
  }

  /**
   * Change the data directory. Refused while the proxy runs: the live CA and
   * flow file cannot move under an open capture.
   * @param {string} target path the operator picked
   */
  function changeDataDir(target) {
    if (proxy.running) {
      const blocked = { ok: false, error: '先停止抓包再改数据目录（当前抓包仍写入旧目录）' }
      logger.event('info', 'data-dir', { action: 'change', target, ...blocked })
      return blocked
    }
    try {
      const result = adoptDataDir(dir, target)
      logger.event('info', 'data-dir', { action: 'change', ...result })
      return result
    } catch (err) {
      const failed = { ok: false, error: err.message }
      logger.event('warn', 'data-dir', { action: 'change', target, ...failed })
      return failed
    }
  }

  /** Forget the panel choice, back to config then default. */
  function resetDataDir() {
    if (proxy.running) {
      const blocked = { ok: false, error: '先停止抓包再改数据目录（当前抓包仍写入旧目录）' }
      logger.event('info', 'data-dir', { action: 'reset', ...blocked })
      return blocked
    }
    clearLocation()
    const result = { ok: true, reset: true, dir: expandDataDir(cfg.dataDir), restartRequired: true }
    logger.event('info', 'data-dir', { action: 'reset', ...result })
    return result
  }

  async function dispose() {
    try {
      await stop()
    } finally {
      store.close()
      logger.event('info', 'unmount', { pid: process.pid })
      events.close()
    }
  }

  return {
    cfg, dir, log: logger, certs, certstore, sysproxy, store, proxy,
    start, stop, status, dispose, changeDataDir, resetDataDir,
  }
}
