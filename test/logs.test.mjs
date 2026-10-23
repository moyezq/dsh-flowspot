/**
 * 运行日志的读取契约：最新在前、级别/事件/时间过滤、坏行跳过、只认本模块的文件。
 * 运行：node test/logs.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { logFiles, readLogEvents } from '../lib/logs.js'

const T0 = Date.parse('2026-10-24T10:00:00.000Z')

function line(offsetMs, level, event, detail = null) {
  return `${JSON.stringify({ ts: new Date(T0 + offsetMs).toISOString(), level, event, detail })}\n`
}

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-logs-'))
  fs.writeFileSync(path.join(dir, 'plugin-2026-10-24-01.ndjson'), [
    line(0, 'info', 'mount', { dir: 'C:\\x' }),
    line(1000, 'warn', 'capture-start-failed', { error: 'EACCES' }),
    line(2000, 'info', 'capture-start', { port: 8899 }),
  ].join(''), 'utf8')
  fs.writeFileSync(path.join(dir, 'plugin-2026-10-24-02.ndjson'), [
    line(3000, 'info', 'cdp-connect', { browser: 'Chrome/155' }),
    line(4000, 'error', 'cdp-disconnect', { reason: 'closed', sessions: 2 }),
    // 写到一半的坏行必须被跳过，而不是让整次读取失败。
    '{"ts": "2026-10-24T10:00:05.000Z", "level":',
  ].join(''), 'utf8')
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored', 'utf8')
  return dir
}

test('reads the newest events first across rotating files', () => {
  const dir = makeDir()
  try {
    assert.deepEqual(logFiles(dir).map((file) => path.basename(file)), [
      'plugin-2026-10-24-01.ndjson',
      'plugin-2026-10-24-02.ndjson',
    ])
    const entries = readLogEvents({ dir, limit: 10 })
    assert.deepEqual(entries.map((entry) => entry.event), [
      'cdp-disconnect',
      'cdp-connect',
      'capture-start',
      'capture-start-failed',
      'mount',
    ])
    assert.equal(entries[0].level, 'error')
    assert.equal(entries[0].detail.sessions, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('filters by level, event substring, since and limit', () => {
  const dir = makeDir()
  try {
    assert.deepEqual(readLogEvents({ dir, level: 'warn' }).map((entry) => entry.event), ['capture-start-failed'])
    assert.deepEqual(readLogEvents({ dir, event: 'cdp-' }).map((entry) => entry.event), ['cdp-disconnect', 'cdp-connect'])
    assert.deepEqual(readLogEvents({ dir, since: T0 + 2500 }).map((entry) => entry.event), ['cdp-disconnect', 'cdp-connect'])
    assert.equal(readLogEvents({ dir, limit: 2 }).length, 2)
    assert.equal(readLogEvents({ dir, limit: 5000 }).length, 5)
    assert.deepEqual(readLogEvents({ dir: null }), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a directory without owned files reads as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-logs-'))
  try {
    fs.writeFileSync(path.join(dir, 'other.ndjson'), line(0, 'info', 'x'), 'utf8')
    assert.deepEqual(logFiles(dir), [])
    assert.deepEqual(readLogEvents({ dir }), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
