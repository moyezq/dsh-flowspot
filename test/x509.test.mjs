/**
 * 证书链：真正要保证的只有两件事——CA 受信任时，Node 自己的 TLS 栈
 * （Chrome 工具链认可的那一套）能接受我们签的叶子证书；以及重新加载后的 CA
 * 仍签出一模一样的 issuer 字节。
 * 运行：node test/x509.test.mjs
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

// CA 只在首次运行时生成一次；如果重启后换了一张 CA，用户已信任的旧 CA 就和新叶子对不上了。
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

// 叶子证书只认签发时的那一个域名：换个子域必须验不过，否则等于替任意站点签名。
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

// 重载 CA 后再签叶子，issuer 字节必须一模一样，否则浏览器看到的是「链断了」。
test('a leaf issued after a reload still verifies (issuer bytes stable)', () => {
  const { dir, ca } = freshCA()
  const reloaded = new CertificateAuthority({ dir, log: quiet }).init()
  const leaf = reloaded.leafFor('api.example.com')
  const leafCert = new crypto.X509Certificate(leaf.pem)
  assert.equal(leafCert.verify(new crypto.X509Certificate(ca.caPem).publicKey), true)
})

// 直接用 IP 访问时，浏览器只认 iPAddress 类型的 SAN，写进 DNS SAN 会被拒。
test('IP hosts get an iPAddress SAN', () => {
  const { ca } = freshCA()
  const cert = new crypto.X509Certificate(ca.leafFor('127.0.0.1').pem)
  assert.match(cert.subjectAltName, /IP Address:127\.0\.0\.1/)
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1')
})

// 这里真的起一个 TLS 服务端做握手：前面几条只检查证书字段，而真正决定浏览器信不信的，
// 是 Node 自己那套（和 Chrome 工具链一致）的校验流程。
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

// 用户实际最常撞的坑：CA 没装进系统存储时，配置看着都对，唯独握手被拒。
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
    // 新版 Node/OpenSSL 对不受信任的叶子回的是 TLS alert，而不是 CERT_* 错误码；
    // 两种都说明握手被拒，所以这里只要求命中其中一种。
    assert.match(String(error.code || error.message), /SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|HANDSHAKE_FAILURE/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
