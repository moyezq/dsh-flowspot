/**
 * dsh-flowspot：最小可用的 DER / ASN.1 编码器。
 *
 * Node 带 TLS 栈，却不带证书颁发机构，所以插件得自己拼 X.509 结构。这个模块只管
 * 字节层：会写 tag、长度和一张证书需要的那几种原始类型。做成零依赖，插件才能当
 * 普通目录装进去，不用 pnpm 再去解析第三方加密包。
 *
 * 只支持确定长度（definite length）、单字节 tag，以及 lib/x509.js 用到的那几种原始
 * 类型——这不是通用 ASN.1 库。
 */

// 证书里会用到的 ASN.1 标签值；单字节 tag 已经够用。
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

/**
 * 编码 DER 长度（只用确定长度形式）：小于 0x80 一个字节，更大的按需加长并置高位标记。
 * 长度算错一个字节，整张证书就解不开，所以这里先拒绝非法输入。
 */
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

/** 一个 tag-length-value 帧：DER 里所有结构都是这么套出来的。 */
export function tlv(tag, content) {
  const body = asBuffer(content)
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body])
}

/** SEQUENCE：把若干项按顺序拼起来（证书、算法标识、Name 都用它）。 */
export function seq(...items) {
  return tlv(TAG.SEQUENCE, Buffer.concat(items.map(asBuffer)))
}

/** SET OF：无名集合，RDN 里用它包一个属性。 */
export function setOf(...items) {
  return tlv(TAG.SET, Buffer.concat(items.map(asBuffer)))
}

/**
 * 用非负 Buffer、number 或 bigint 编 INTEGER。
 * 会去掉前导零，并且在高位为 1 时补一个符号字节，因为 DER 的 INTEGER 是有符号的。
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

/** BIT STRING：第一个字节显式写明末尾有几个没用到的 bit（keyUsage 靠它省位）。 */
export function bitString(buf, unused = 0) {
  if (unused < 0 || unused > 7) throw new RangeError(`bad unused bits: ${unused}`)
  return tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([unused]), asBuffer(buf)]))
}

/** OCTET STRING：装扩展值（扩展的 DER 会被当成一段不透明字节塞进去）。 */
export function octetString(buf) {
  return tlv(TAG.OCTET_STRING, asBuffer(buf))
}

/** OBJECT IDENTIFIER：点分十进制文本，按 base-128 分段编码。 */
export function oid(dotted) {
  const parts = String(dotted).split('.').map(Number)
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new TypeError(`bad OID: ${dotted}`)
  }
  // base-128 变长编码：每个字节低 7 位是数据，除最后一个字节外最高位都置 1，
  // 表示「后面还有」。
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

/** BOOLEAN：DER 要求真值编码成 0xff，不能随便写 0x01。 */
export function bool(value) {
  return tlv(TAG.BOOLEAN, Buffer.from([value ? 0xff : 0x00]))
}

/** DER 的 NULL 值（算法标识里当参数占位用）。 */
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

/** UTCTime（YYMMDDHHMMSSZ）；年份超出 1950..2049 改用 GeneralizedTime。 */
export function time(date) {
  const d = date instanceof Date ? date : new Date(date)
  // DER 要求时间用 UTC 表示，末尾固定带 Z，所以这里一律取 getUTC*。
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
 * 上下文相关 tag：构造型（`[n]` 包着子节点，如扩展的 `[3]`）或原始型（直接是一串
 * 字节，如 GeneralName 的 dNSName `[2]`）。
 */
export function context(num, content, constructed = true) {
  const tag = (constructed ? 0xa0 : 0x80) | num
  return tlv(tag, asBuffer(content))
}

export { TAG }
