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
import { clearLocation, dshHome, readLocation, writeLocation } from './location.js'
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

/**
 * Adopt a new data directory: create it, carry the certificate authority over
 * when the target has none (so the trusted root keeps working without a
 * reinstall), and remember the choice for the next start.
 *
 * The running proxy cannot move: its CA and flow file are already open, which
 * is why a change takes effect after a restart.
 * @param {string} currentDir directory this process is using
 * @param {string} target path the operator picked
 * @returns {{ok:true, dir:string, previous:string, caCopied:boolean, foreignCa:boolean, restartRequired:boolean}}
 */
export function adoptDataDir(currentDir, target) {
  const next = expandDataDir(target)
  if (next === currentDir) return { ok: true, dir: next, previous: currentDir, caCopied: false, foreignCa: false, restartRequired: false }

  let stat = null
  try {
    stat = fs.statSync(next)
  } catch {
    /* does not exist yet */
  }
  if (stat && !stat.isDirectory()) throw new Error(`目标不是目录：${next}`)
  fs.mkdirSync(next, { recursive: true })
  try {
    fs.accessSync(next, fs.constants.W_OK)
  } catch {
    throw new Error(`目标目录不可写：${next}`)
  }

  const hasCa = (dir) => fs.existsSync(path.join(dir, 'ca.crt'))
  const foreignCa = hasCa(next)
  let caCopied = false
  if (!foreignCa && hasCa(currentDir)) {
    for (const name of DATA_FILES) {
      const from = path.join(currentDir, name)
      const to = path.join(next, name)
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to)
    }
    caCopied = true
  }

  writeLocation(next)
  return { ok: true, dir: next, previous: currentDir, caCopied, foreignCa, restartRequired: true }
}

export function createRuntime(rawConfig, { log } = {}) {
  const cfg = normalizeConfig(rawConfig)
  const logger = log || { info() {}, warn() {} }
  const dir = resolveDataDir(cfg.dataDir)
  fs.mkdirSync(dir, { recursive: true })

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
      paths: { dir, ca: certs.caPath, source: dataDirSource(cfg.dataDir), pending },
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
    if (proxy.running) return { ok: false, error: '先停止抓包再改数据目录（当前抓包仍写入旧目录）' }
    try {
      return adoptDataDir(dir, target)
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  /** Forget the panel choice, back to config then default. */
  function resetDataDir() {
    if (proxy.running) return { ok: false, error: '先停止抓包再改数据目录（当前抓包仍写入旧目录）' }
    clearLocation()
    return { ok: true, reset: true, dir: expandDataDir(cfg.dataDir), restartRequired: true }
  }

  async function dispose() {
    try {
      await stop()
    } finally {
      store.close()
    }
  }

  return {
    cfg, dir, log: logger, certs, certstore, sysproxy, store, proxy,
    start, stop, status, dispose, changeDataDir, resetDataDir,
  }
}
