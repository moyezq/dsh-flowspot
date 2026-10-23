/**
 * dsh-flowspot：本地证书颁发机构（CA）与逐 host 的叶子证书。
 *
 * 设计要点（都是生产级 MITM 代理必须做对的地方）：
 *
 *  - CA 只在第一次生成，存进插件数据目录，之后每次重启复用，用户因此只需安装一次。
 *  - 所有叶子证书共用同一对 RSA 密钥。每个 host 现生成一对要花 50-100 ms，在这里
 *    换不来任何东西；签一张新证书只要几毫秒。ProxyPin 也是这个取舍。
 *  - 每张叶子都带请求 host 的 SAN（Chrome 从 2017 年起就不看 CN 了）。目标是 IP 时
 *    用 iPAddress 形式的 SAN，而不是 dNSName。
 *  - issuer 直接使用 CA subject 的原始字节，绝不重新编码。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import * as D from './der.js'

const OID = {
  CN: '2.5.4.3',
  O: '2.5.4.10',
  C: '2.5.4.6',
  SHA256_WITH_RSA: '1.2.840.113549.1.1.11',
  RSA_ENCRYPTION: '1.2.840.113549.1.1.1',
  BASIC_CONSTRAINTS: '2.5.29.19',
  KEY_USAGE: '2.5.29.15',
  EXT_KEY_USAGE: '2.5.29.37',
  SUBJECT_ALT_NAME: '2.5.29.17',
  SUBJECT_KEY_ID: '2.5.29.14',
  AUTHORITY_KEY_ID: '2.5.29.35',
  SERVER_AUTH: '1.3.6.1.5.5.7.3.1',
}

// 叶子证书寿命跟公共信任证书的常见上限看齐；CA 十年，够长期使用。
const LEAF_VALIDITY_DAYS = 397
const CA_VALIDITY_DAYS = 3650
/** 叶子证书与 SecureContext 两个缓存的上限，都按 host 计数。 */
const LEAF_CONTEXT_CACHE = 512

export function pemFromDer(der, label = 'CERTIFICATE') {
  const body = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

export function derFromPem(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  return Buffer.from(body, 'base64')
}

function rsaAlgorithm() {
  return D.seq(D.oid(OID.RSA_ENCRYPTION), D.NULL)
}

function sha256WithRsa() {
  return D.seq(D.oid(OID.SHA256_WITH_RSA), D.NULL)
}

/** SubjectPublicKeyInfo：把 PKCS#1 的 RSAPublicKey 包成 X.509 要的形状。 */
function spkiFromRsaPublic(pkcs1Der) {
  return D.seq(rsaAlgorithm(), D.bitString(pkcs1Der, 0))
}

/** X.501 Name，含 C / O / CN；只编码一次，之后同时当 issuer 和 subject 用。 */
function nameDer(cn, org, country) {
  const rdns = []
  if (country) rdns.push(D.setOf(D.seq(D.oid(OID.C), D.printableString(country))))
  if (org) rdns.push(D.setOf(D.seq(D.oid(OID.O), D.utf8String(org))))
  rdns.push(D.setOf(D.seq(D.oid(OID.CN), D.utf8String(cn))))
  return D.seq(...rdns)
}

function extension(id, critical, valueDer) {
  const parts = [D.oid(id)]
  if (critical) parts.push(D.bool(true))
  parts.push(D.octetString(valueDer))
  return D.seq(...parts)
}

/** CA 的 subject 是固定的，所以重载时按同样方式重编码能得到完全相同的 DER。 */
function caSubjectDer() {
  return nameDer('dsh-flowspot Local CA', 'dsh-flowspot', 'CN')
}

function subjectKeyId(pkcs1Der) {
  return crypto.createHash('sha1').update(pkcs1Der).digest()
}

/** keyUsage 的位序：0 digitalSignature … 5 keyCertSign，6 cRLSign。 */
function keyUsageExtension(bits) {
  // 先找出最高的置位下标，再按 MSB-first 打包成字节。
  const set = bits.filter((i) => i >= 0 && i <= 6).sort()
  const highest = set.length ? set[set.length - 1] : 0
  const byteCount = Math.floor(highest / 8) + 1
  const out = Buffer.alloc(byteCount)
  for (const i of set) out[Math.floor(i / 8)] |= 0x80 >> (i % 8)
  const unused = byteCount * 8 - (highest + 1)
  return extension(OID.KEY_USAGE, true, D.bitString(out, unused))
}

function subjectAltNameExtension(host) {
  if (net.isIP(host)) {
    // IP 目标用 [7] iPAddress：内容就是裸的 4 或 16 字节地址，不带内层 TLV。
    const raw = net.isIPv4(host)
      ? Buffer.from(host.split('.').map(Number))
      : ipv6Bytes(host)
    return extension(OID.SUBJECT_ALT_NAME, false, D.seq(D.context(7, raw, false)))
  }
  // [2] dNSName 是 IMPLICIT IA5String：直接放 ASCII 字节，不能再套一层 TLV。
  return extension(OID.SUBJECT_ALT_NAME, false, D.seq(D.context(2, Buffer.from(host, 'ascii'), false)))
}

function ipv6Bytes(host) {
  // 把 :: 缩写展开成 16 字节。
  const [head, tail] = host.split('::')
  const left = head ? head.split(':').filter(Boolean) : []
  const right = tail !== undefined && tail ? tail.split(':').filter(Boolean) : []
  const fill = 8 - left.length - right.length
  const groups = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right]
  const out = Buffer.alloc(16)
  groups.slice(0, 8).forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2))
  return out
}

function buildTbs({ serial, issuer, subject, spki, notBefore, notAfter, extensions }) {
  return D.seq(
    D.context(0, D.integer(2)), // 版本 v3
    D.integer(serial),
    sha256WithRsa(),
    issuer,
    D.seq(D.time(notBefore), D.time(notAfter)),
    subject,
    spki,
    ...(extensions.length ? [D.context(3, D.seq(...extensions))] : []),
  )
}

function signCertificate({ tbs, caKey }) {
  const signature = crypto.sign('sha256', tbs, caKey)
  return D.seq(tbs, sha256WithRsa(), D.bitString(signature, 0))
}

function randomSerial() {
  const buf = crypto.randomBytes(16)
  buf[0] &= 0x7f // 清掉最高位，保证 DER INTEGER 是非负数
  if (buf[0] === 0) buf[0] = 1
  return buf
}

function newRsaPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'der' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  return { publicDer: publicKey, privatePem: privateKey }
}

export class CertificateAuthority {
  /**
   * @param {object} options
   * @param {string} options.dir 插件数据目录
   * @param {object} [options.log]
   */
  constructor({ dir, log }) {
    this.dir = dir
    this.log = log || { info() {}, warn() {} }
    this.caPem = null
    this.caDer = null
    this.caKeyPem = null
    this.caKey = null
    this.caSubject = null
    this.caKeyId = null
    this.caThumbprint = null
    this.leafKeyPem = null
    this.leafPublicDer = null
    this.leafCache = new Map()
    this.contextCache = new Map()
    this.ready = false
  }

  get caPath() {
    return path.join(this.dir, 'ca.crt')
  }

  get keyPath() {
    return path.join(this.dir, 'ca.key.pem')
  }

  /** 从磁盘加载 CA；第一次运行时现场生成一个。 */
  init() {
    fs.mkdirSync(this.dir, { recursive: true })
    if (fs.existsSync(this.keyPath) && fs.existsSync(this.caPath)) {
      this.caKeyPem = fs.readFileSync(this.keyPath, 'utf8')
      this.caPem = fs.readFileSync(this.caPath, 'utf8')
      this.caDer = derFromPem(this.caPem)
      this.caKey = crypto.createPrivateKey(this.caKeyPem)
      const cert = new crypto.X509Certificate(this.caDer)
      // 每张叶子的 issuer 必须与 CA subject 的字节完全一致；subject 在创建时就固定了，
      // 所以重编码的结果是确定的，重启后仍能对上。
      this.caSubject = caSubjectDer()
      this.caKeyId = subjectKeyId(cert.publicKey.export({ type: 'pkcs1', format: 'der' }))
      this.caThumbprint = crypto.createHash('sha1').update(this.caDer).digest('hex').toUpperCase()
      this.log.info(`[dsh-flowspot] CA 已加载 ${this.caPath}`)
    } else {
      this._createCA()
      this.log.info(`[dsh-flowspot] CA 已生成 ${this.caPath}`)
    }
    this._loadLeafKey()
    this.ready = true
    return this
  }

  _createCA() {
    const { publicDer, privatePem } = newRsaPair()
    const subject = caSubjectDer()
    const now = new Date()
    const notBefore = new Date(now.getTime() - 24 * 3600 * 1000)
    const notAfter = new Date(now.getTime() + CA_VALIDITY_DAYS * 24 * 3600 * 1000)
    const keyId = subjectKeyId(publicDer)
    const tbs = buildTbs({
      serial: randomSerial(),
      issuer: subject,
      subject,
      spki: spkiFromRsaPublic(publicDer),
      notBefore,
      notAfter,
      extensions: [
        extension(OID.BASIC_CONSTRAINTS, true, D.seq(D.bool(true))),
        keyUsageExtension([5, 6]),
        extension(OID.SUBJECT_KEY_ID, false, D.octetString(keyId)),
      ],
    })
    const der = signCertificate({ tbs, caKey: crypto.createPrivateKey(privatePem) })
    fs.writeFileSync(this.keyPath, privatePem, { mode: 0o600 })
    fs.writeFileSync(this.caPath, pemFromDer(der), 'utf8')
    this.caKeyPem = privatePem
    this.caPem = String(fs.readFileSync(this.caPath, 'utf8'))
    this.caDer = der
    this.caKey = crypto.createPrivateKey(privatePem)
    this.caSubject = subject
    this.caKeyId = keyId
    this.caThumbprint = crypto.createHash('sha1').update(der).digest('hex').toUpperCase()
  }

  _loadLeafKey() {
    const keyPath = path.join(this.dir, 'leaf.key.pem')
    const derPath = path.join(this.dir, 'leaf.pub.der')
    if (fs.existsSync(keyPath) && fs.existsSync(derPath)) {
      this.leafKeyPem = fs.readFileSync(keyPath, 'utf8')
      this.leafPublicDer = fs.readFileSync(derPath)
    } else {
      const { publicDer, privatePem } = newRsaPair()
      fs.writeFileSync(keyPath, privatePem, { mode: 0o600 })
      fs.writeFileSync(derPath, publicDer)
      this.leafKeyPem = privatePem
      this.leafPublicDer = publicDer
    }
  }

  /** 为某个 host 签一张叶子证书，已签过的直接复用缓存。 */
  leafFor(host) {
    const cached = this.leafCache.get(host)
    const now = Date.now()
    if (cached && cached.expiresAt > now) return cached
    // notBefore 往前挪一天，防本机与客户端时钟有偏差导致证书「还没生效」。
    const nowDate = new Date(now - 24 * 3600 * 1000)
    const notAfter = new Date(now + LEAF_VALIDITY_DAYS * 24 * 3600 * 1000)
    const subject = nameDer(host, 'dsh-flowspot', 'CN')
    const tbs = buildTbs({
      serial: randomSerial(),
      issuer: this.caSubject,
      subject,
      spki: spkiFromRsaPublic(this.leafPublicDer),
      notBefore: nowDate,
      notAfter,
      extensions: [
        extension(OID.BASIC_CONSTRAINTS, true, D.seq()),
        // digitalSignature + keyEncipherment：TLS 服务端证书的常规组合。
        keyUsageExtension([0, 2]),
        // 只许 serverAuth，避免这张叶子被当成客户端证书或代码签名证书使用。
        extension(OID.EXT_KEY_USAGE, false, D.seq(D.oid(OID.SERVER_AUTH))),
        subjectAltNameExtension(host),
        extension(OID.SUBJECT_KEY_ID, false, D.octetString(subjectKeyId(this.leafPublicDer))),
        // 指向 CA 的 keyId，部分客户端靠它把叶子链到根证书上。
        extension(
          OID.AUTHORITY_KEY_ID,
          false,
          D.seq(D.context(0, this.caKeyId, false)),
        ),
      ],
    })
    const der = signCertificate({ tbs, caKey: this.caKey })
    const leaf = {
      host,
      der,
      pem: pemFromDer(der),
      keyPem: this.leafKeyPem,
      expiresAt: notAfter.getTime(),
    }
    // 上限到了就淘汰最早插入的那个 host，两张缓存一起删，保持 key 集合一致，
    // 否则 contextCache 会单独长胖。
    if (this.leafCache.size >= LEAF_CONTEXT_CACHE) {
      this.leafCache.delete(this.leafCache.keys().next().value)
      this.contextCache.delete(this.contextCache.keys().next().value)
    }
    this.leafCache.set(host, leaf)
    return leaf
  }

  /** 某个 host 的 SecureContext；createSecureContext 不便宜，所以缓存复用。 */
  contextFor(host) {
    const cached = this.contextCache.get(host)
    if (cached) return cached
    const leaf = this.leafFor(host)
    const ctx = tls.createSecureContext({ key: leaf.keyPem, cert: leaf.pem })
    this.contextCache.set(host, ctx)
    return ctx
  }

  /** 供状态接口展示的证书信息。 */
  describe() {
    if (!this.caDer) return null
    const cert = new crypto.X509Certificate(this.caDer)
    return {
      path: this.caPath,
      subject: cert.subject.replace(/\n/g, ', '),
      issuer: cert.issuer.replace(/\n/g, ', '),
      sha1: this.caThumbprint,
      validTo: cert.validTo,
    }
  }
}
