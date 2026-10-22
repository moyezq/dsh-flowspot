/**
 * Runtime configuration: the two knobs a user is expected to edit — the listen
 * port and the data directory — plus the defaults everything else relies on.
 * No proxy is started and no certificate is generated here.
 * Run with: node test/runtime.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { clearLocation, readLocation, readPointer, writeLocation } from '../lib/location.js'
import { DEFAULTS, adoptDataDir, adoptPendingCopy, dataDirSource, expandDataDir, normalizeConfig, resolveDataDir } from '../lib/runtime.js'

const HOME = path.join(os.tmpdir(), 'dshwc-home')

/** Run a case with DSH_HOME pinned, restoring the real value afterwards. */
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

test('defaults match the documented values', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.port, 8899)
  assert.equal(cfg.dataDir, '')
  assert.equal(cfg.maxFlows, 1000)
  assert.equal(cfg.maxBodyBytes, 262144)
  assert.equal(cfg.redact, true)
  assert.equal(cfg.persist, true)
  assert.equal(cfg.upstreamRejectUnauthorized, true)
  assert.equal(cfg.upstreamTimeoutMs, 30000)
  assert.equal(cfg.upstreamKeepAlive, false)
  assert.equal(cfg.setSystemProxyOnStart, true)
  assert.equal(DEFAULTS.port, 8899)
})

test('explicit values win, and booleans only turn off on false', () => {
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

  // "truthy but not false" keeps the feature on, so a string from YAML does
  // not silently disable capture.
  assert.equal(normalizeConfig({ redact: 'yes' }).redact, true)
  assert.equal(normalizeConfig({ setSystemProxyOnStart: 1 }).setSystemProxyOnStart, true)
})

test('an invalid port falls back to the default; 0 means ephemeral', () => {
  assert.equal(normalizeConfig({ port: -1 }).port, 8899)
  assert.equal(normalizeConfig({ port: 'abc' }).port, 8899)
  assert.equal(normalizeConfig({ port: 1.5 }).port, 8899)
  assert.equal(normalizeConfig({ port: 0 }).port, 0)
  assert.equal(normalizeConfig({ port: '8899' }).port, 8899)
})

test('a non-positive number falls back per field, not globally', () => {
  const cfg = normalizeConfig({ maxFlows: 0, maxBodyBytes: -5, upstreamTimeoutMs: 0 })
  assert.equal(cfg.maxFlows, 1000)
  assert.equal(cfg.maxBodyBytes, 262144)
  assert.equal(cfg.upstreamTimeoutMs, 30000)
})

test('an empty dataDir resolves to the default under DSH home', () => {
  withHome(() => {
    assert.equal(resolveDataDir(''), path.join(HOME, 'dsh-flowspot'))
    assert.equal(resolveDataDir('   '), path.join(HOME, 'dsh-flowspot'))
    assert.equal(resolveDataDir(undefined), path.join(HOME, 'dsh-flowspot'))
    assert.equal(resolveDataDir(null), path.join(HOME, 'dsh-flowspot'))
  })
})

test('an absolute dataDir is used as given', () => {
  withHome(() => {
    const absolute = path.join(HOME, 'elsewhere', 'capture')
    assert.equal(resolveDataDir(absolute), absolute)
  })
})

test('a relative dataDir resolves against DSH home, not the process cwd', () => {
  withHome(() => {
    assert.equal(resolveDataDir('cap-data'), path.join(HOME, 'cap-data'))
    assert.equal(resolveDataDir('  cap-data  '), path.join(HOME, 'cap-data'))
  })
})

test('a leading tilde resolves against the user home', () => {
  withHome(() => {
    assert.equal(resolveDataDir(`~${path.sep}capture`), path.join(os.homedir(), 'capture'))
  })
})

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
      // Nothing touched the disk: changing one's mind leaves no directory and
      // no private-key copy behind.
      assert.equal(fs.existsSync(target), false)
      assert.equal(readLocation(), target)
      assert.equal(readPointer().copyFrom, current)

      // The next start creates the directory and carries the CA over.
      const adopted = adoptPendingCopy(target)
      assert.equal(adopted.copied, true)
      assert.equal(adopted.from, current)
      assert.equal(fs.readFileSync(path.join(target, 'ca.crt'), 'utf8'), 'stub:ca.crt')
      // The handover is one-shot.
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
      // A foreign CA is nobody to hand over, and the next start leaves it alone.
      assert.equal(adoptPendingCopy(target).copied, false)
      assert.equal(fs.readFileSync(path.join(target, 'ca.crt'), 'utf8'), 'foreign')
    } finally {
      clearLocation()
      fs.rmSync(target, { recursive: true, force: true })
      fs.rmSync(current, { recursive: true, force: true })
    }
  })
})

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

test('expandDataDir exposes the raw expansion rules used by adoptDataDir', () => {
  withHome(() => {
    assert.equal(expandDataDir(''), path.join(HOME, 'dsh-flowspot'))
    assert.equal(expandDataDir('rel'), path.join(HOME, 'rel'))
  })
})
