/**
 * 运行配置：用户真正会去改的两个旋钮——监听端口和数据目录——以及其它一切所依赖的默认值。
 * 这里不启动代理，也不生成证书。
 * 运行：node test/runtime.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { clearLocation, readLocation, readPointer, writeLocation } from '../lib/location.js'
import { DEFAULTS, adoptDataDir, adoptPendingCopy, dataDirSource, expandDataDir, normalizeConfig, resolveDataDir } from '../lib/runtime.js'

const HOME = path.join(os.tmpdir(), 'dshwc-home')

/** 把 DSH_HOME 钉住跑一个用例，跑完恢复原值（免得污染同进程里其它的用例）。 */
function withHome(run) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

// 默认值就是文档里写的那几个数，改它等于悄悄改变面板行为，所以逐项钉死。
test('defaults match the documented values', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.port, 8899)
  assert.equal(cfg.dataDir, '')
  assert.equal(cfg.maxFlows, 1000)
  assert.equal(cfg.maxBodyBytes, 262144)
  assert.equal(cfg.redact, false)
  assert.equal(cfg.persist, true)
  assert.equal(cfg.upstreamRejectUnauthorized, true)
  assert.equal(cfg.upstreamTimeoutMs, 30000)
  assert.equal(cfg.upstreamKeepAlive, false)
  assert.equal(cfg.setSystemProxyOnStart, true)
  assert.equal(cfg.cdpBrowserPath, '')
  assert.equal(DEFAULTS.port, 8899)
})

// 显式配置必须逐项生效，不能被默认值悄悄盖掉。
test('explicit values win, and redaction is opt-in', () => {
  const cfg = normalizeConfig({
    port: 9000,
    dataDir: 'E:\\CaptureData',
    maxFlows: 5,
    maxBodyBytes: 1024,
    redact: false,
    persist: false,
    upstreamRejectUnauthorized: false,
    upstreamTimeoutMs: 1000,
    upstreamKeepAlive: true,
    setSystemProxyOnStart: false,
    cdpBrowserPath: 'C:\\Tools\\chrome.exe',
  })
  assert.equal(cfg.port, 9000)
  assert.equal(cfg.dataDir, 'E:\\CaptureData')
  assert.equal(cfg.maxFlows, 5)
  assert.equal(cfg.maxBodyBytes, 1024)
  assert.equal(cfg.redact, false)
  assert.equal(cfg.persist, false)
  assert.equal(cfg.upstreamRejectUnauthorized, false)
  assert.equal(cfg.upstreamTimeoutMs, 1000)
  assert.equal(cfg.upstreamKeepAlive, true)
  assert.equal(cfg.setSystemProxyOnStart, false)
  assert.equal(cfg.cdpBrowserPath, 'C:\\Tools\\chrome.exe')

  // 打码默认关，只有显式传 true 才打开；其它值（包括手滑写成的字符串）
  // 都不能悄悄把抓到的头打码。
  assert.equal(normalizeConfig({ redact: 'yes' }).redact, false)
  assert.equal(normalizeConfig({ redact: true }).redact, true)
  // 其它布尔项保持「真值即可、只认 false 为关」的语义，YAML 里写个字符串
  // 也不会把抓包悄悄关掉。
  assert.equal(normalizeConfig({ setSystemProxyOnStart: 1 }).setSystemProxyOnStart, true)
})

// 非法端口退回默认；但 0 是合法值——它的意思是让系统随机分配一个空闲端口。
test('an invalid port falls back to the default; 0 means ephemeral', () => {
  assert.equal(normalizeConfig({ port: -1 }).port, 8899)
  assert.equal(normalizeConfig({ port: 'abc' }).port, 8899)
  assert.equal(normalizeConfig({ port: 1.5 }).port, 8899)
  assert.equal(normalizeConfig({ port: 0 }).port, 0)
  assert.equal(normalizeConfig({ port: '8899' }).port, 8899)
})

// 非正数按字段各自退回默认，而不是整体重置配置——一个字段写错不该拖累其它字段。
test('a non-positive number falls back per field, not globally', () => {
  const cfg = normalizeConfig({ maxFlows: 0, maxBodyBytes: -5, upstreamTimeoutMs: 0 })
  assert.equal(cfg.maxFlows, 1000)
  assert.equal(cfg.maxBodyBytes, 262144)
  assert.equal(cfg.upstreamTimeoutMs, 30000)
})

// 空串、空格、undefined、null 都算「没配」，落到 DSH home 下的默认数据目录。
test('an empty dataDir resolves to the default under DSH home', () => {
  withHome(() => {
    assert.equal(resolveDataDir(''), path.join(HOME, 'dsh-flowspot'))
    assert.equal(resolveDataDir('   '), path.join(HOME, 'dsh-flowspot'))
    assert.equal(resolveDataDir(undefined), path.join(HOME, 'dsh-flowspot'))
    assert.equal(resolveDataDir(null), path.join(HOME, 'dsh-flowspot'))
  })
})

// 绝对路径原样使用，不做任何拼接，也不做多余归一化。
test('an absolute dataDir is used as given', () => {
  withHome(() => {
    const absolute = path.join(HOME, 'elsewhere', 'capture')
    assert.equal(resolveDataDir(absolute), absolute)
  })
})

// 相对路径相对 DSH home，不是进程 cwd——否则从不同目录启动会写到两个地方。
test('a relative dataDir resolves against DSH home, not the process cwd', () => {
  withHome(() => {
    assert.equal(resolveDataDir('cap-data'), path.join(HOME, 'cap-data'))
    assert.equal(resolveDataDir('  cap-data  '), path.join(HOME, 'cap-data'))
  })
})

// ~ 开头展开到用户主目录，方便手写配置。
test('a leading tilde resolves against the user home', () => {
  withHome(() => {
    assert.equal(resolveDataDir(`~${path.sep}capture`), path.join(os.homedir(), 'capture'))
  })
})

// 优先级是「面板选择 > 配置 dataDir > 默认」；清掉面板选择后要能回落到配置。
test('the panel choice beats the config, and clearing it falls back', () => {
  withHome(() => {
    writeLocation('E:\\Picked\\cap')
    try {
      assert.equal(resolveDataDir(''), 'E:\\Picked\\cap')
      assert.equal(resolveDataDir('F:\\FromConfig'), 'E:\\Picked\\cap')
      assert.equal(dataDirSource('F:\\FromConfig'), 'ui')
    } finally {
      clearLocation()
    }
    assert.equal(readLocation(), null)
    assert.equal(resolveDataDir('F:\\FromConfig'), 'F:\\FromConfig')
    assert.equal(dataDirSource('F:\\FromConfig'), 'config')
    assert.equal(dataDirSource(''), 'default')
  })
})

// adoptDataDir 只登记选择，真正的 CA 复制推迟到下次启动：这样用户改主意时不留垃圾。
test('adoptDataDir only records the choice; the CA is handed over at the next start', () => {
  withHome(() => {
    const current = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwc-cur-'))
    const target = path.join(os.tmpdir(), `dshwc-new-${Date.now()}`)
    try {
      for (const name of ['ca.crt', 'ca.key.pem', 'leaf.key.pem', 'leaf.pub.der']) {
        fs.writeFileSync(path.join(current, name), `stub:${name}`)
      }
      const result = adoptDataDir(current, target)
      assert.equal(result.ok, true)
      assert.equal(result.caCopied, false)
      assert.equal(result.copyOnStart, true)
      assert.equal(result.foreignCa, false)
      assert.equal(result.restartRequired, true)
      assert.equal(result.dir, target)
      // 这一步不碰磁盘：用户改主意时，既不会多出一个目录，也不会留下私钥副本。
      assert.equal(fs.existsSync(target), false)
      assert.equal(readLocation(), target)
      assert.equal(readPointer().copyFrom, current)

      // 下次启动才真正建目录、把 CA 搬过去。
      const adopted = adoptPendingCopy(target)
      assert.equal(adopted.copied, true)
      assert.equal(adopted.from, current)
      assert.equal(fs.readFileSync(path.join(target, 'ca.crt'), 'utf8'), 'stub:ca.crt')
      // 交接只做一次，做完就把 copyFrom 清掉。
      assert.equal(readPointer().copyFrom, null)
      assert.equal(adoptPendingCopy(target).copied, false)

      assert.equal(resolveDataDir(''), target)
      assert.equal(dataDirSource(''), 'ui')
    } finally {
      clearLocation()
      fs.rmSync(target, { recursive: true, force: true })
      fs.rmSync(current, { recursive: true, force: true })
    }
  })
})

// 目标目录里已有 CA（用户之前用过）时不能覆盖，否则等于把别人的信任根换掉。
test('adoptDataDir leaves an existing foreign CA alone', () => {
  withHome(() => {
    const current = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwc-cur-'))
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwc-target-'))
    try {
      fs.writeFileSync(path.join(current, 'ca.crt'), 'old')
      fs.writeFileSync(path.join(target, 'ca.crt'), 'foreign')
      const result = adoptDataDir(current, target)
      assert.equal(result.caCopied, false)
      assert.equal(result.copyOnStart, false)
      assert.equal(result.foreignCa, true)
      assert.equal(fs.readFileSync(path.join(target, 'ca.crt'), 'utf8'), 'foreign')
      // 目标目录里已经有一张别人的 CA：没有东西可交接，下次启动也不能覆盖它。
      assert.equal(adoptPendingCopy(target).copied, false)
      assert.equal(fs.readFileSync(path.join(target, 'ca.crt'), 'utf8'), 'foreign')
    } finally {
      clearLocation()
      fs.rmSync(target, { recursive: true, force: true })
      fs.rmSync(current, { recursive: true, force: true })
    }
  })
})

// 目标是个文件不是目录时必须报错，而且不能把这个选择记下来。
test('adoptDataDir rejects a path that is a file', () => {
  withHome(() => {
    const current = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwc-cur-'))
    const file = path.join(os.tmpdir(), `dshwc-file-${Date.now()}`)
    try {
      fs.writeFileSync(file, 'not a directory')
      assert.throws(() => adoptDataDir(current, file), /目标不是目录/)
      assert.equal(readLocation(), null)
    } finally {
      fs.rmSync(file, { force: true })
      fs.rmSync(current, { recursive: true, force: true })
    }
  })
})

// 选中的就是当前目录等于没改：不写记录、也不要求重启。
test('the same directory is a no-op, not a restart request', () => {
  withHome(() => {
    const current = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwc-cur-'))
    try {
      const result = adoptDataDir(current, current)
      assert.equal(result.ok, true)
      assert.equal(result.restartRequired, false)
      assert.equal(readLocation(), null)
    } finally {
      fs.rmSync(current, { recursive: true, force: true })
    }
  })
})

// 对外暴露的展开规则，就是 adoptDataDir 内部用的那一套，不能有两份实现。
test('expandDataDir exposes the raw expansion rules used by adoptDataDir', () => {
  withHome(() => {
    assert.equal(expandDataDir(''), path.join(HOME, 'dsh-flowspot'))
    assert.equal(expandDataDir('rel'), path.join(HOME, 'rel'))
  })
})
