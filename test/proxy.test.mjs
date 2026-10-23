/**
 * 代理错误账本：面板的错误卡片和 `webcap_status` 都读 `recentErrors`，
 * 所以重复失败必须合并、不同失败必须分开、列表必须有上限。这里不打开任何 socket。
 * 运行：node test/proxy.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { MitmProxy } from '../lib/proxy.js'

/** 一个没有服务端、没有证书、没有 store 的代理：这些用例只用它的错误账本。 */
function proxy() {
  return new MitmProxy({ certs: null, store: null, config: {}, log: { warn() {} } })
}

const autofill = {
  method: 'GET',
  host: 'background.example.com',
  path: '/v1/pages/abc',
  url: 'https://background.example.com/v1/pages/abc',
}

// 同一个请求重复失败只占一行并累加 count；不同请求各占一行；总数封顶 20 条。
test('repeat failures merge, distinct ones stay apart, and the list stays bounded', () => {
  const p = proxy()
  const info = { code: 'ECONNRESET', phase: 'upstream', message: 'socket hang up（ECONNRESET）' }
  p._noteError(autofill, info)
  p._noteError(autofill, info)
  assert.equal(p.recentErrors.length, 1)
  assert.equal(p.recentErrors[0].count, 2)

  const api = { method: 'POST', host: 'api.example.com', path: '/v1/x', url: 'https://api.example.com/v1/x' }
  p._noteError(api, { code: 'ETIMEDOUT', phase: 'upstream', message: '上游超时（ETIMEDOUT）' })
  assert.equal(p.recentErrors.length, 2)
  // 最新的失败才有人能处理；它排在最后，面板从尾部切片即可，不用排序。
  assert.equal(p.recentErrors.at(-1).host, 'api.example.com')

  // 再灌 40 条各不相同的失败，验证上限确实是 20（只保留最近的），不会无限长。
  for (let i = 0; i < 40; i++) {
    p._noteError(
      { method: 'GET', host: `h${i}.example.com`, path: '/', url: `https://h${i}.example.com/` },
      { code: null, phase: 'upstream', message: 'boom' },
    )
  }
  assert.equal(p.recentErrors.length, 20)
})

// 快照必须给副本：读方改动快照不能反过来污染代理内部的那份账本。
test('snapshot hands out copies, so a reader cannot mutate the ledger', () => {
  const p = proxy()
  p._noteError(autofill, { code: 'ECONNRESET', phase: 'upstream', message: 'socket hang up（ECONNRESET）' })
  const snap = p.snapshot()
  assert.equal(snap.recentErrors.length, 1)
  snap.recentErrors[0].count = 99
  assert.equal(p.recentErrors[0].count, 1)
})

// 新代理报空数组而不是 undefined，面板取 length、做 map 都不用写特殊分支。
test('a fresh proxy reports an empty list, never undefined', () => {
  const snap = proxy().snapshot()
  assert.deepEqual(snap.recentErrors, [])
  assert.equal(snap.lastError, null)
})
