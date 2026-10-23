/**
 * dsh-flowspot：runtime 组装层。
 *
 * 所有带状态的东西都放在这里，index.js、agent 工具和 HTTP 路由拿到的因此是同一个
 * 代理实例：插件是进程级单例，再建一份就会抢端口、抢注册表。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CdpChannel } from './cdp/index.js'
import { findBrowser } from './cdp/launch.js'
import { CertificateAuthority } from './x509.js'
import { CertStore } from './certstore.js'
import { FlowStore } from './flows.js'
import { InstanceLock } from './instanceLock.js'
import { clearCopyFrom, clearLocation, dshHome, readLocation, readPointer, writeLocation } from './location.js'
import { openDirectory, PluginLog, readLogEvents, revealInFolder } from './logs.js'
import { MitmProxy } from './proxy.js'
import { SystemProxy } from './sysproxy.js'
import { zipDirectory } from './zip.js'

/** 本包版本，只读一次；面板侧拿它比对自己是不是旧 build。 */
const HOST_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 宿主启动时刻，用来判断面板 bundle 是不是比宿主新。 */
const HOST_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString()

/** 随包附带的浏览器扩展目录（下载 zip 与打开文件夹都用它）。 */
const EXTENSION_DIR = fileURLToPath(new URL('../extension/', import.meta.url))

export const DEFAULTS = {
  /** 代理监听的本地回环端口；填 0 就让系统随便给一个空闲的。 */
  port: 8899,
  /** 数据目录；留空表示用 $DSH_HOME/dsh-flowspot。 */
  dataDir: '',
  /** 内存里保留多少条 flow（环形缓冲，超出丢最旧的）。 */
  maxFlows: 1000,
  /** 单个 body 最多抓多少字节，超出部分直接不记。 */
  maxBodyBytes: 262144,
  /** 抓包时给 Authorization / Cookie / Set-Cookie 打码。默认关：抓包只落在本机，代码视图反而需要真值才能跑。 */
  redact: false,
  /** 结束的 flow 是否追加写进数据目录下的 JSONL。 */
  persist: true,
  /** 连上游时是否校验服务端证书；关掉才能看穿自签名或过期证书。 */
  upstreamRejectUnauthorized: true,
  /** 连上游、等响应头的超时（毫秒）；超时就主动断开该请求。 */
  upstreamTimeoutMs: 30000,
  /** 是否复用上游连接；默认关，免得服务器空闲时关掉的套接字在下一次请求上变成 "socket hang up"。 */
  upstreamKeepAlive: false,
  /** 代理启动时是否顺手把 Windows 系统代理指向自己。 */
  setSystemProxyOnStart: true,
  /** 受控浏览器用哪个可执行文件；留空自动找 Chrome，再找 Edge。 */
  cdpBrowserPath: '',
}

/** 把用户填的原始配置收成可用值：数值非法退回默认，布尔只认显式开关。 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  // 数值项统一兜底：非数字、NaN、Infinity 或 <= 0 都算没填，用默认值。
  const num = (key) => {
    const value = Number(src[key])
    return Number.isFinite(value) && value > 0 ? value : DEFAULTS[key]
  }
  return {
    // 端口是唯一允许 0 的数值（0 表示让系统分配），所以不走 num()。
    port: Number.isInteger(Number(src.port)) && Number(src.port) >= 0 ? Number(src.port) : DEFAULTS.port,
    dataDir: typeof src.dataDir === 'string' && src.dataDir.trim() ? src.dataDir.trim() : DEFAULTS.dataDir,
    maxFlows: num('maxFlows'),
    maxBodyBytes: num('maxBodyBytes'),
    // 默认关的开关只有显式写 true 才打开，填别的值（字符串、null）等于没填。
    redact: src.redact === undefined ? DEFAULTS.redact : src.redact === true,
    // 默认开的开关反过来：只有显式写 false 才关，别把 "false" 这种字符串当关闭。
    persist: src.persist === undefined ? DEFAULTS.persist : src.persist !== false,
    upstreamRejectUnauthorized:
      src.upstreamRejectUnauthorized === undefined
        ? DEFAULTS.upstreamRejectUnauthorized
        : src.upstreamRejectUnauthorized !== false,
    upstreamTimeoutMs: num('upstreamTimeoutMs'),
    upstreamKeepAlive: src.upstreamKeepAlive === undefined ? DEFAULTS.upstreamKeepAlive : src.upstreamKeepAlive === true,
    setSystemProxyOnStart:
      src.setSystemProxyOnStart === undefined ? DEFAULTS.setSystemProxyOnStart : src.setSystemProxyOnStart !== false,
    // 空字符串表示自动探测，原样保留用户填的路径。
    cdpBrowserPath: typeof src.cdpBrowserPath === 'string' ? src.cdpBrowserPath.trim() : DEFAULTS.cdpBrowserPath,
  }
}

/** 默认数据目录：$DSH_HOME/dsh-flowspot（$DSH_HOME 取不到时退回 ~/.dsh）。 */
export function captureDataDir() {
  return path.join(dshHome(), 'dsh-flowspot')
}

/**
 * 把用户手填的数据目录展开成绝对路径，但不参与「面板选择 > 配置 > 默认」的优先级判断。
 *
 * 规则：空 → DSH home 下的默认目录；`~`/`~/x` → 用户主目录；绝对路径 → 原样用；
 * 其余 → 相对 DSH home（不是相对进程 cwd，CLI 与桌面端的 cwd 并不一样）。
 * @param {string} [value] 配置里或面板选中的数据目录
 * @returns {string} 绝对路径的目录
 */
export function expandDataDir(value) {
  const home = dshHome()
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return path.join(home, 'dsh-flowspot')
  // 只展开开头那个 ~，路径中间的 ~ 当普通字符留着（Windows 路径里也可能出现）。
  const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir())
  return path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded)
}

/**
 * 解析本进程实际该用的数据目录。
 *
 * 优先级：面板里选中的目录（pointer 文件）> 插件配置的 `dataDir` > 默认目录。
 * @param {string} [configured] 插件配置里的 `dataDir`
 * @returns {string} 绝对路径的目录
 */
export function resolveDataDir(configured) {
  return expandDataDir(readLocation() || configured || '')
}

/**
 * 实际生效的数据目录来自哪里：`ui`（面板选择）、`config`（profile 配置）或 `default`。
 * @param {string} [configured] 插件配置里的 `dataDir`
 * @returns {'ui'|'config'|'default'}
 */
export function dataDirSource(configured) {
  if (readLocation()) return 'ui'
  return typeof configured === 'string' && configured.trim() ? 'config' : 'default'
}

/** 一个目录要能直接当数据目录用，至少得有这几个文件（CA 与叶子密钥）。 */
const DATA_FILES = ['ca.crt', 'ca.key.pem', 'leaf.key.pem', 'leaf.pub.der']

/** 这个目录里已经有 CA 了吗：只认 ca.crt 在不在。 */
const hasCa = (dir) => fs.existsSync(path.join(dir, 'ca.crt'))

/** 找到 `dir` 最近一个已经存在的上级目录：盘符/卷根本不存在时，这一步就该失败，而不是等重启。 */
function existingAncestor(dir) {
  let probe = dir
  for (;;) {
    try {
      if (fs.statSync(probe).isDirectory()) return probe
    } catch {
      /* 往上继续找 */
    }
    const parent = path.dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
}

/**
 * 只记下「面板选了哪个目录」，不创建也不复制任何东西：正在跑的进程还占着旧 CA 和
 * 旧 flow 文件，搬家留给下次启动（`adoptPendingCopy`）。所以操作员中途改主意时，
 * 不会留下一个空目录，也不会多出一份 CA 私钥副本。
 * @param {string} currentDir 本进程正在用的目录
 * @param {string} target 操作员选中的路径
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
    /* 还不存在，下次启动会创建 */
  }
  if (stat && !stat.isDirectory()) throw new Error(`目标不是目录：${next}`)

  // 在最近一个存在的目录上试写：不可写的盘现在就被拒，别等重启时才炸。
  // 目标目录自己还不存在时只能拿上级目录探，因为这时还没有可写的目标。
  const probe = stat ? next : existingAncestor(next)
  if (!probe) throw new Error(`目标路径不可用：${next}`)
  try {
    fs.accessSync(probe, fs.constants.W_OK)
  } catch {
    throw new Error(`目标目录不可写：${next}`)
  }

  const foreignCa = hasCa(next)
  // 只有「目标目录没有自己的 CA」且「当前目录有 CA 可给」时才交接；目标里已有别人的
  // CA 就说明这目录有主了，不碰它。
  // 注意 caCopied 恒为 false：真正复制发生在下次启动，这里只是告诉面板「还没复制」。
  const copyOnStart = !foreignCa && hasCa(currentDir)
  writeLocation(next, { copyFrom: copyOnStart ? currentDir : null })
  return { ok: true, dir: next, previous: currentDir, caCopied: false, copyOnStart, foreignCa, restartRequired: true }
}

/**
 * 把 `adoptDataDir` 记下的搬家做完：创建目录并把 CA 带过去，让已经装进信任库的
 * 根证书继续可用，不用重装。只在启动时、加载 CA 之前跑这一趟。
 * @param {string} dir 本进程解析出来的目录
 * @returns {{copied: boolean, from: string|null}}
 */
export function adoptPendingCopy(dir) {
  const pointer = readPointer()
  if (!pointer || !pointer.copyFrom) return { copied: false, from: null }
  const from = pointer.copyFrom
  let copied = false
  try {
    // 三重条件都是保护：目标不是自己、目标还没有 CA、来源确实有 CA 可交。
    if (from !== dir && !hasCa(dir) && hasCa(from)) {
      fs.mkdirSync(dir, { recursive: true })
      for (const name of DATA_FILES) {
        const source = path.join(from, name)
        const target = path.join(dir, name)
        // 目标里已有的同名文件不覆盖，免得冲掉半路生成的新密钥。
        if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target)
      }
      copied = true
    }
  } finally {
    // 一次性交接：`copyFrom` 留着不清，以后每换一个目录都会再复制一遍私钥，
    // 包括操作员事后又放弃的那个目录。
    clearCopyFrom()
  }
  return { copied, from }
}

export function createRuntime(rawConfig, { log } = {}) {
  const cfg = normalizeConfig(rawConfig)
  const terminal = log || { debug() {}, info() {}, warn() {}, error() {} }
  const dir = resolveDataDir(cfg.dataDir)
  // 面板记下的换目录在这里落地：此时 CA 还没加载，新目录也只有这一刻才可能被创建。
  const adopted = adoptPendingCopy(dir)
  fs.mkdirSync(dir, { recursive: true })

  // 一个 logger 后面两个出口：终端留现场视图，文件留「为什么」——否则这些原因会跟着
  // 进程一起消失。只有 warn/error 和显式 `event()` 写进文件；请求级的事实已经在
  // flows JSONL 里，不在这里再存一份。
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
  // 实例锁：同一份数据目录只让一个 DSH 实例真正抓包（web 版和桌面端共用数据目录）。
  const instanceLock = new InstanceLock({ dir, log: logger })
  const sysproxy = new SystemProxy({ dir, log: logger })
  const store = new FlowStore({
    maxFlows: cfg.maxFlows,
    maxBodyBytes: cfg.maxBodyBytes,
    redact: cfg.redact,
    persistDir: cfg.persist ? path.join(dir, 'flows') : null,
    log: logger,
  })
  const proxy = new MitmProxy({ certs, store, config: cfg, log: logger })
  // CDP 是一条旁路：只解释「这条 flow 是谁发的」，不参与抓包。浏览器只在调用
  // launch 时才启动，加载插件本身不产生任何进程。
  const cdp = new CdpChannel({
    log: logger,
    getProxyPort: () => (proxy.running ? proxy.port : null),
    getBrowserPath: () => cfg.cdpBrowserPath,
    // 源码落盘用：跟着数据目录走（面板换目录后新会话用新目录）
    getDataDir: () => dir,
  })

  async function start({ port, systemProxy = cfg.setSystemProxyOnStart } = {}) {
    // 已经在抓包就直接返回：重复点「开始抓包」不会把监听重开一遍。
    if (proxy.running) return { running: true, port: proxy.port, already: true, warning: proxy.portNote }
    const requestedPort = port === undefined ? cfg.port : port
    // 先拿实例锁：同目录下另一个活实例正在抓包时，两边都会改系统代理，先停的那个
    // 会把代理恢复成旧值，最坏变成指向死端口。
    const lock = instanceLock.acquire({ port: requestedPort })
    if (!lock.ok) {
      const message = lock.error || InstanceLock.describe(lock.holder)
      logger.event('warn', 'capture-refused', { reason: 'instance-lock', holder: lock.holder || null, error: lock.error || null })
      throw new Error(message)
    }
    try {
      const actual = await proxy.start(requestedPort)
      // 端口退让值得单独记一条：系统代理此刻指向一个随机端口，用户问「怎么不是
      // 8899」的答案就在这里，光看 capture-start 的 warning 字符串不好筛。
      if (proxy.portNote) {
        logger.event('info', 'port-fallback', { requestedPort, actual, note: proxy.portNote })
      }
      // 端口退让值得报出来：系统代理此刻指向一个随机端口，用户问「怎么不是 8899」的
      // 答案就在这里。
      let warning = proxy.portNote || null
      if (systemProxy) {
        try {
          await sysproxy.enable(actual)
        } catch (err) {
          // 系统代理设置失败不算启动失败：代理已经能用了，只是流量未必会经过它。
          const message = `代理已启动，但系统代理设置失败：${err.message}`
          warning = warning ? `${warning}；${message}` : message
          logger.warn(`[dsh-flowspot] ${message}`)
        }
      }
      logger.event('info', 'capture-start', {
        requestedPort,
        port: actual,
        systemProxy: Boolean(systemProxy),
        portNote: proxy.portNote || null,
        warning,
      })
      return { running: true, port: actual, warning }
    } catch (err) {
      // 没起来就把锁放掉，别让一次失败把另一个实例挡在门外。
      if (!proxy.running) instanceLock.release()
      logger.event('warn', 'capture-start-failed', {
        requestedPort,
        systemProxy: Boolean(systemProxy),
        error: err.message,
        code: err.code || null,
      })
      throw err
    }
  }

  async function stop() {
    let warning = null
    // 先恢复系统代理再关监听：反过来会有一小段时间，系统代理指着一个已经关掉的端口。
    if (proxy.running) {
      try {
        await sysproxy.disable()
      } catch (err) {
        warning = `系统代理恢复失败：${err.message}`
        logger.warn(`[dsh-flowspot] ${warning}`)
      }
    }
    await proxy.stop()
    instanceLock.release()
    logger.event('info', 'capture-stop', { warning })
    return { running: false, warning }
  }

  /** 面板预览与 webcap_logs 共用的入口：只读本模块自己的日志文件。 */
  function readLogs(options = {}) {
    return readLogEvents({ dir: path.join(dir, 'logs'), ...options })
  }

  /** 在资源管理器里打开 logs/；路径同时返回给面板显示。 */
  function openLogsDir() {
    try {
      const target = path.join(dir, 'logs')
      openDirectory(target)
      logger.event('info', 'log-open', { dir: target })
      return { ok: true, dir: target }
    } catch (err) {
      logger.warn(`[dsh-flowspot] 打开日志目录失败：${err.message}`)
      return { ok: false, error: err.message }
    }
  }

  async function status() {
    // 两件事任一失败都不该让整个状态接口挂掉，各自降级成 error 字段。
    const [ca, systemProxy] = await Promise.all([
      certstore.status().catch((err) => ({ supported: false, installed: false, error: err.message })),
      sysproxy.read().catch((err) => ({ supported: false, error: err.message })),
    ])
    // 面板的选择要到下次启动才生效，所以报成 pending，别假装运行中的目录已经搬过去了。
    const picked = readLocation()
    const pending = picked && expandDataDir(picked) !== dir ? expandDataDir(picked) : null
    // 上次留下的 CDP pointer 就在这次状态读取时静默重连；不 await，状态先按快照返回，
    // 下一次轮询就能看到 connected 变化。
    cdp.ensure().catch(() => {})
    return {
      proxy: proxy.snapshot(),
      systemProxy,
      ca,
      flows: store.stats(),
      paths: { dir, ca: certs.caPath, log: path.join(dir, 'logs'), source: dataDirSource(cfg.dataDir), pending, copyFrom: readPointer()?.copyFrom || null },
      platform: process.platform,
      // 桌面端（Electron）与 CLI 的差别只在安装入口与 PATH，出问题时靠这一行分辨。
      electron: process.versions.electron || null,
      // 实例锁：谁在抓包、有没有另一个活实例占着同一份数据目录（面板据此提示只读）。
      instance: {
        pid: process.pid,
        heldByMe: instanceLock.held,
        holder: instanceLock.peek(),
        blocked: Boolean(instanceLock.blockedByOther()),
      },
      // CDP 通道快照：面板菜单据此显示「未连接 / 已连接 / 需重连」，agent 读同一份。
      cdp: cdp.status(),
      // 面板每次刷新页面都是新的，这段宿主代码却只在进程重启后才变。把宿主 build 报
      // 出去，面板才能说「你看的是旧宿主」，而不是默默出问题。
      build: { version: HOST_VERSION, startedAt: HOST_STARTED_AT },
    }
  }

  /**
   * 换数据目录。抓包进行中一律拒绝：正在用的 CA 和 flow 文件不可能在开启的抓包会话
   * 底下搬走。
   * @param {string} target 操作员选中的路径
   */
  function changeDataDir(target) {
    if (proxy.running) {
      const blocked = { ok: false, error: '先停止抓包再改数据目录（当前抓包仍写入旧目录）' }
      logger.event('info', 'data-dir', { action: 'change', target, ...blocked })
      return blocked
    }
    // 换目录会改 pointer，另一个活实例下次启动就跟着换了；先让它停下来。
    const otherInstance = instanceLock.blockedByOther()
    if (otherInstance) {
      const blocked = { ok: false, error: InstanceLock.describe(otherInstance) }
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

  /** 忘掉面板的选择，退回配置里的 `dataDir`，再退回默认目录。 */
  function resetDataDir() {
    if (proxy.running) {
      const blocked = { ok: false, error: '先停止抓包再改数据目录（当前抓包仍写入旧目录）' }
      logger.event('info', 'data-dir', { action: 'reset', ...blocked })
      return blocked
    }
    // 另一个活实例还在用同一个目录时不动它：重置会让那边的 CA / 源码索引一起没了。
    const otherInstance = instanceLock.blockedByOther()
    if (otherInstance) {
      const blocked = { ok: false, error: InstanceLock.describe(otherInstance) }
      logger.event('info', 'data-dir', { action: 'reset', ...blocked })
      return blocked
    }
    clearLocation()
    const result = { ok: true, reset: true, dir: expandDataDir(cfg.dataDir), restartRequired: true }
    logger.event('info', 'data-dir', { action: 'reset', ...result })
    return result
  }

  async function dispose() {
    // 顺序要紧：先 stop 把系统代理恢复回去，再兜底关掉 flow 文件与运行日志。
    // stop 里可能已经关过一次 flow 文件，close 是幂等的，不会报错。
    try {
      await stop()
    } finally {
      // 卸载时把锁放开：否则下次启动要等持有者 pid 消失才认。
      instanceLock.release()
      // CDP 只关连接，不杀浏览器：下次启动还能按 pointer 静默接回来。
      cdp.dispose()
      store.close()
      logger.event('info', 'unmount', { pid: process.pid })
      events.close()
    }
  }

  /** 把随包扩展打成一个 zip，供远程/非本机部署下载。 */
  function extensionZip() {
    try {
      return { ok: true, buffer: zipDirectory(EXTENSION_DIR), filename: 'dsh-flowspot-bridge.zip' }
    } catch (err) {
      return { ok: false, error: `打包扩展失败：${err.message}` }
    }
  }

  /** 本机部署最简单：直接在资源管理器里打开随包扩展目录。 */
  function openExtensionDir() {
    try {
      openDirectory(EXTENSION_DIR)
      return { ok: true, dir: EXTENSION_DIR }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  /**
   * 在资源管理器里打开源码：给了 key 就选中那个 `.js`，没给（或没落盘）就打开
   * `<数据目录>/scripts`。用户想自己拷走 JS 分析时走这条，比在面板里复制全文省事。
   */
  function revealSources(key = '') {
    try {
      const file = key ? cdp.sourcePathOf(String(key)) : null
      if (file && fs.existsSync(file)) {
        revealInFolder(file)
        logger.event('info', 'source-reveal', { file })
        return { ok: true, file }
      }
      const dir = cdp.sourcesDir()
      openDirectory(dir)
      logger.event('info', 'source-reveal', { dir, missing: Boolean(key) })
      return { ok: true, dir, missing: Boolean(key) }
    } catch (err) {
      logger.warn(`[dsh-flowspot] 打开源码位置失败：${err.message}`)
      return { ok: false, error: err.message }
    }
  }

  /**
   * 在浏览器里打开「扩展连接页」。
   *
   * 桌面端（DSH Desktop）的界面跑在 `dsh-app://` 里，浏览器扩展拿不到这个 origin，
   * 内容脚本也就永远不会把宿主地址告诉它——扩展会一直对着默认端口轮询，面板这边
   * 看到的就是「扩展没有响应」。这一页让内容脚本认领宿主地址，扩展记住之后就不再
   * 依赖这一页（地址写进 `chrome.storage.local`）。
   * @param {string} base 宿主 HTTP 源，例如 `http://127.0.0.1:19387`
   */
  function openBridgeHello(base = '') {
    const origin = String(base || '').replace(/\/+$/, '')
    if (!origin) return { ok: false, error: '宿主还没起来：先刷新面板再来' }
    const url = `${origin}/dsh-flowspot/bridge/hello`
    try {
      const found = findBrowser()
      const browser = (found && found.path) || ''
      if (!browser) return { ok: false, error: '没找到 Chrome；手动在浏览器里打开下面的地址也一样', url }
      const child = spawn(browser, [url], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      logger.event('info', 'bridge-hello-open', { url, browser })
      return { ok: true, url, browser }
    } catch (err) {
      logger.warn(`[dsh-flowspot] 打开扩展连接页失败：${err.message}`)
      return { ok: false, error: err.message, url }
    }
  }

  return {
    cfg, dir, log: logger, logDir: path.join(dir, 'logs'), extensionDir: EXTENSION_DIR,
    certs, certstore, sysproxy, store, proxy, cdp,
    start, stop, status, dispose, changeDataDir, resetDataDir, readLogs, openLogsDir,
    instanceLock,
    extensionZip, openExtensionDir, revealSources, openBridgeHello,
  }
}
