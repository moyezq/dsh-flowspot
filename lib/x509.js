/**
 * dsh-flowspot: local certificate authority and per-host leaf certificates.
 *
 * Design notes (mirrors what a production MITM proxy has to get right):
 *
 *  - The CA is generated once, stored under the plugin data directory, and
 *    reused across restarts so the user installs it exactly once.
 *  - Leaf certificates share ONE RSA key pair. Generating a key per host costs
 *    50-100 ms and buys nothing here; signing a fresh certificate is a few
 *    milliseconds. This is the same trade-off ProxyPin makes.
 *  - Every leaf carries a SAN for the requested host (Chrome ignores CN since
 *    2017). IP hosts get an iPAddress SAN instead of a dNSName one.
 *  - issuer is the CA subject encoded byte-for-byte, never re-encoded.
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

const LEAF_VALIDITY_DAYS = 397
const CA_VALIDITY_DAYS = 3650
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

/** SubjectPublicKeyInfo from a PKCS#1 RSAPublicKey DER. */
function spkiFromRsaPublic(pkcs1Der) {
  return D.seq(rsaAlgorithm(), D.bitString(pkcs1Der, 0))
}

/** X.501 Name with C / O / CN, encoded once and reused as issuer and subject. */
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

/** The CA subject is fixed, so its DER can be rebuilt identically on reload. */
function caSubjectDer() {
  return nameDer('dsh-flowspot Local CA', 'dsh-flowspot', 'CN')
}

function subjectKeyId(pkcs1Der) {
  return crypto.createHash('sha1').update(pkcs1Der).digest()
}

/** keyUsage bits: index 0 digitalSignature … 5 keyCertSign, 6 cRLSign. */
function keyUsageExtension(bits) {
  // Collect the highest set index, then pack MSB-first.
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
    const raw = net.isIPv4(host)
      ? Buffer.from(host.split('.').map(Number))
      : ipv6Bytes(host)
    return extension(OID.SUBJECT_ALT_NAME, false, D.seq(D.context(7, raw, false)))
  }
  // [2] dNSName is an IMPLICIT IA5String: the raw ASCII bytes, no inner TLV.
  return extension(OID.SUBJECT_ALT_NAME, false, D.seq(D.context(2, Buffer.from(host, 'ascii'), false)))
}

function ipv6Bytes(host) {
  // Expand :: notation into 16 bytes.
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
    D.context(0, D.integer(2)), // version v3
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
  buf[0] &= 0x7f // keep the DER integer positive
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
   * @param {string} options.dir plugin data directory
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

  /** Load the CA from disk, generating it on first run. */
  init() {
    fs.mkdirSync(this.dir, { recursive: true })
    if (fs.existsSync(this.keyPath) && fs.existsSync(this.caPath)) {
      this.caKeyPem = fs.readFileSync(this.keyPath, 'utf8')
      this.caPem = fs.readFileSync(this.caPath, 'utf8')
      this.caDer = derFromPem(this.caPem)
      this.caKey = crypto.createPrivateKey(this.caKeyPem)
      const cert = new crypto.X509Certificate(this.caDer)
      // The issuer field of every leaf must equal the CA subject bytes; the
      // subject is fixed at creation time, so re-encoding it is deterministic.
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

  /** Issue (or reuse) a leaf certificate for one host name. */
  leafFor(host) {
    const cached = this.leafCache.get(host)
    const now = Date.now()
    if (cached && cached.expiresAt > now) return cached
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
        keyUsageExtension([0, 2]),
        extension(OID.EXT_KEY_USAGE, false, D.seq(D.oid(OID.SERVER_AUTH))),
        subjectAltNameExtension(host),
        extension(OID.SUBJECT_KEY_ID, false, D.octetString(subjectKeyId(this.leafPublicDer))),
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
    if (this.leafCache.size >= LEAF_CONTEXT_CACHE) {
      this.leafCache.delete(this.leafCache.keys().next().value)
      this.contextCache.delete(this.contextCache.keys().next().value)
    }
    this.leafCache.set(host, leaf)
    return leaf
  }

  /** SecureContext for a host; reused because createSecureContext is not free. */
  contextFor(host) {
    const cached = this.contextCache.get(host)
    if (cached) return cached
    const leaf = this.leafFor(host)
    const ctx = tls.createSecureContext({ key: leaf.keyPem, cert: leaf.pem })
    this.contextCache.set(host, ctx)
    return ctx
  }

  /** Certificate facts for status reporting. */
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
