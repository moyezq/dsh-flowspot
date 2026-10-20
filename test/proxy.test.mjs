/**
 * Proxy error bookkeeping: the panel's error card and `webcap_status` read
 * `recentErrors`, so repeat failures must merge, distinct ones must stay apart,
 * and the list must stay bounded. No socket is opened here.
 * Run with: node test/proxy.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { MitmProxy } from '../lib/proxy.js'

/** A proxy with no server, no certs and no store: only the error ledger is used. */
function proxy() {
  return new MitmProxy({ certs: null, store: null, config: {}, log: { warn() {} } })
}

const autofill = {
  method: 'GET',
  host: 'background.example.com',
  path: '/v1/pages/abc',
  url: 'https://background.example.com/v1/pages/abc',
}

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
  // The newest failure is the one an operator can act on; it is last, so the
  // panel can slice from the end without sorting.
  assert.equal(p.recentErrors.at(-1).host, 'api.example.com')

  for (let i = 0; i < 40; i++) {
    p._noteError(
      { method: 'GET', host: `h${i}.example.com`, path: '/', url: `https://h${i}.example.com/` },
      { code: null, phase: 'upstream', message: 'boom' },
    )
  }
  assert.equal(p.recentErrors.length, 20)
})

test('snapshot hands out copies, so a reader cannot mutate the ledger', () => {
  const p = proxy()
  p._noteError(autofill, { code: 'ECONNRESET', phase: 'upstream', message: 'socket hang up（ECONNRESET）' })
  const snap = p.snapshot()
  assert.equal(snap.recentErrors.length, 1)
  snap.recentErrors[0].count = 99
  assert.equal(p.recentErrors[0].count, 1)
})

test('a fresh proxy reports an empty list, never undefined', () => {
  const snap = proxy().snapshot()
  assert.deepEqual(snap.recentErrors, [])
  assert.equal(snap.lastError, null)
})
