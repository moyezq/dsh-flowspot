/**
 * Certificate chain: the property that matters is that Node's own TLS stack
 * (the same one Chrome's tooling agrees with) accepts our leaves when the CA is
 * trusted, and that a reloaded CA produces byte-identical issuers.
 * Run with: node test/x509.test.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import test from 'node:test'
import { CertificateAuthority, derFromPem } from '../lib/x509.js'

const quiet = { info() {}, warn() {} }

function freshCA() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwc-x509-'))
  return { dir, ca: new CertificateAuthority({ dir, log: quiet }).init() }
}

test('CA is generated once and reloads identically', () => {
  const { dir, ca } = freshCA()
  const first = ca.caThumbprint
  assert.ok(fs.existsSync(path.join(dir, 'ca.crt')))
  const again = new CertificateAuthority({ dir, log: quiet }).init()
  assert.equal(again.caThumbprint, first)
  assert.equal(
    derFromPem(again.caPem).toString('hex'),
    derFromPem(ca.caPem).toString('hex'),
  )
})

test('leaf verifies against the CA and matches the host', () => {
  const { ca } = freshCA()
  const leaf = ca.leafFor('example.com')
  const leafCert = new crypto.X509Certificate(leaf.pem)
  const caCert = new crypto.X509Certificate(ca.caPem)
  assert.equal(leafCert.checkHost('example.com'), 'example.com')
  assert.equal(leafCert.checkHost('other.example.com'), undefined)
  assert.equal(leafCert.verify(caCert.publicKey), true)
  assert.equal(leafCert.ca, false)
  assert.match(leafCert.subjectAltName, /DNS:example\.com/)
})

test('a leaf issued after a reload still verifies (issuer bytes stable)', () => {
  const { dir, ca } = freshCA()
  const reloaded = new CertificateAuthority({ dir, log: quiet }).init()
  const leaf = reloaded.leafFor('api.example.com')
  const leafCert = new crypto.X509Certificate(leaf.pem)
  assert.equal(leafCert.verify(new crypto.X509Certificate(ca.caPem).publicKey), true)
})

test('IP hosts get an iPAddress SAN', () => {
  const { ca } = freshCA()
  const cert = new crypto.X509Certificate(ca.leafFor('127.0.0.1').pem)
  assert.match(cert.subjectAltName, /IP Address:127\.0\.0\.1/)
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1')
})

test('real TLS handshake succeeds when the client trusts our CA', async () => {
  const { ca } = freshCA()
  const server = tls.createServer({
    SNICallback: (servername, cb) => cb(null, ca.contextFor(servername)),
    secureContext: ca.contextFor('localhost'),
  }, (socket) => socket.end('ok'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const result = await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: '127.0.0.1',
        port,
        servername: 'localhost',
        ca: ca.caPem,
        rejectUnauthorized: true,
      }, () => {
        resolve({ authorized: socket.authorized, error: socket.authorizationError })
        socket.end()
      })
      socket.on('error', reject)
    })
    assert.equal(result.authorized, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('an untrusted CA fails the client handshake (the CA gap users actually hit)', async () => {
  const { ca } = freshCA()
  const server = tls.createServer({ secureContext: ca.contextFor('localhost') }, (socket) => socket.end('ok'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const error = await new Promise((resolve) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: true }, () => {
        socket.destroy()
        resolve(null)
      })
      socket.on('error', (err) => resolve(err))
    })
    assert.ok(error, 'expected a self-signed certificate error')
    assert.match(String(error.code || error.message), /SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
