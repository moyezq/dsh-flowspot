/**
 * dsh-flowspot: minimal DER / ASN.1 encoder.
 *
 * Node ships a TLS stack but no certificate authority, so the plugin builds
 * X.509 structures itself. This module is the byte layer only: it knows how to
 * frame tags, lengths and the handful of primitive types a certificate needs.
 * Keeping it dependency-free means the plugin can be installed as a plain
 * directory with no pnpm resolution of third-party crypto packages.
 *
 * Only definite lengths, single-byte tags and the primitives used by
 * lib/x509.js are supported — this is not a general ASN.1 library.
 */

const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
}

/** Encode a DER length (definite form only). */
export function encodeLength(n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`bad DER length: ${n}`)
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value)
}

/** One tag-length-value frame. */
export function tlv(tag, content) {
  const body = asBuffer(content)
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body])
}

/** SEQUENCE. */
export function seq(...items) {
  return tlv(TAG.SEQUENCE, Buffer.concat(items.map(asBuffer)))
}

/** SET OF. */
export function setOf(...items) {
  return tlv(TAG.SET, Buffer.concat(items.map(asBuffer)))
}

/**
 * INTEGER from a non-negative Buffer, number or bigint.
 * Leading zeroes are stripped and a sign byte is added when the high bit is set,
 * because DER integers are signed.
 */
export function integer(value) {
  let buf
  if (Buffer.isBuffer(value)) {
    buf = value
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    let v = BigInt(value)
    if (v < 0n) throw new RangeError('negative INTEGER is not used here')
    const bytes = []
    while (v > 0n) {
      bytes.unshift(Number(v & 0xffn))
      v >>= 8n
    }
    buf = Buffer.from(bytes.length ? bytes : [0])
  } else {
    throw new TypeError('integer() expects Buffer, number or bigint')
  }
  let start = 0
  while (start < buf.length - 1 && buf[start] === 0) start++
  buf = buf.subarray(start)
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf])
  return tlv(TAG.INTEGER, buf)
}

/** BIT STRING with an explicit count of unused trailing bits. */
export function bitString(buf, unused = 0) {
  if (unused < 0 || unused > 7) throw new RangeError(`bad unused bits: ${unused}`)
  return tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([unused]), asBuffer(buf)]))
}

/** OCTET STRING. */
export function octetString(buf) {
  return tlv(TAG.OCTET_STRING, asBuffer(buf))
}

/** OBJECT IDENTIFIER from dotted-decimal text. */
export function oid(dotted) {
  const parts = String(dotted).split('.').map(Number)
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new TypeError(`bad OID: ${dotted}`)
  }
  const base128 = (n) => {
    const out = [n & 0x7f]
    n = Math.floor(n / 128)
    while (n > 0) {
      out.unshift((n & 0x7f) | 0x80)
      n = Math.floor(n / 128)
    }
    return out
  }
  const bytes = [...base128(40 * parts[0] + parts[1])]
  for (let i = 2; i < parts.length; i++) bytes.push(...base128(parts[i]))
  return tlv(TAG.OID, Buffer.from(bytes))
}

/** BOOLEAN. */
export function bool(value) {
  return tlv(TAG.BOOLEAN, Buffer.from([value ? 0xff : 0x00]))
}

/** The DER NULL value. */
export const NULL = Buffer.from([TAG.NULL, 0x00])

export function utf8String(text) {
  return tlv(TAG.UTF8_STRING, Buffer.from(String(text), 'utf8'))
}

export function printableString(text) {
  return tlv(TAG.PRINTABLE_STRING, Buffer.from(String(text), 'ascii'))
}

export function ia5String(text) {
  return tlv(TAG.IA5_STRING, Buffer.from(String(text), 'ascii'))
}

/** UTCTime (YYMMDDHHMMSSZ); years outside 1950..2049 use GeneralizedTime. */
export function time(date) {
  const d = date instanceof Date ? date : new Date(date)
  const year = d.getUTCFullYear()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  if (year >= 1950 && year <= 2049) {
    const body = `${pad(year % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
      + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
    return tlv(TAG.UTC_TIME, Buffer.from(body, 'ascii'))
  }
  const body = `${pad(year, 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  return tlv(TAG.GENERALIZED_TIME, Buffer.from(body, 'ascii'))
}

/**
 * Context-specific tag, either constructed (`[n]` around children) or
 * primitive (a bare string of bytes, e.g. GeneralName dNSName `[2]`).
 */
export function context(num, content, constructed = true) {
  const tag = (constructed ? 0xa0 : 0x80) | num
  return tlv(tag, asBuffer(content))
}

export { TAG }
