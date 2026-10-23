/**
 * 实例锁的契约：同一份数据目录，一次只让一个 DSH 实例真正抓包。
 *
 * web 版和桌面端共用 `$DSH_HOME/dsh-flowspot`，两边同时抓包会互相改系统代理；
 * 这把锁就是「谁在写共享状态」的凭据。**没写任何真注册表、没起任何进程**：
 * 只读写一个 JSON 文件，用 pid 存活判断锁是不是陈旧的。
 *
 * 运行：node test/lock.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { InstanceLock } from '../lib/instanceLock.js'

const quiet = { warn() {}, event() {} }

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-lock-'))
}

/** 起一个短命子进程拿一个**活着**的 pid。 */
function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
  return child
}

test('a free directory can be locked and released', () => {
  const dir = tmpDir()
  try {
    const lock = new InstanceLock({ dir, log: quiet })
    const first = lock.acquire({ port: 8899 })
    assert.equal(first.ok, true)
    assert.equal(lock.held, true)
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8'))
    assert.equal(meta.pid, process.pid)
    assert.equal(meta.port, 8899)
    // 自己再拿一次不算冲突（比如先启动失败又重试）
    assert.equal(lock.acquire({ port: 8899 }).ok, true)
    assert.equal(lock.release(), true)
    assert.equal(fs.existsSync(path.join(dir, 'instance.lock')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock held by another live process is refused, with the holder reported', async () => {
  const dir = tmpDir()
  const child = liveChild()
  try {
    fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: child.pid, port: 8899, startedAt: new Date().toISOString() }))
    const lock = new InstanceLock({ dir, log: quiet })
    const result = lock.acquire({ port: 8899 })
    assert.equal(result.ok, false)
    assert.equal(result.holder.pid, child.pid)
    assert.equal(result.holder.alive, true)
    assert.match(InstanceLock.describe(result.holder), /另一个 DSH 实例/)
    // 破坏性操作也应当被同一个判据挡住
    const blocked = lock.blockedByOther()
    assert.equal(blocked.pid, child.pid)
    assert.equal(lock.held, false)
  } finally {
    child.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale lock (dead pid) is taken over instead of blocking forever', () => {
  const dir = tmpDir()
  try {
    // 999999 不会是一个活着的进程
    fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: 999999, port: 8899 }))
    const lock = new InstanceLock({ dir, log: quiet })
    const result = lock.acquire({ port: 8899 })
    assert.equal(result.ok, true)
    assert.equal(result.stale, true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8')).pid, process.pid)
    lock.release()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('release never deletes a lock owned by someone else', () => {
  const dir = tmpDir()
  try {
    const lock = new InstanceLock({ dir, log: quiet })
    lock.acquire({ port: 8899 })
    // 模拟「另一个实例接管了这把锁」
    fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: 999999, port: 8900 }))
    assert.equal(lock.release(), false)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8')).pid, 999999)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
