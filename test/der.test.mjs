/**
 * DER 编码：证书构建器依赖的字节级契约。下面的用例把每个原语钉到具体十六进制字节，
 * 因为构建器只是把这些字节拼起来，拼错一位整张证书就失效。
 * 运行：node test/der.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as D from '../lib/der.js'

const hex = (buf) => Buffer.from(buf).toString('hex')

// 长度前缀在 127/128 之间换格式：127 及以下一个字节写死，128 起要额外标出「后面跟几个长度字节」。
test('lengths use the short form below 128 and the long form above', () => {
  assert.equal(hex(D.encodeLength(0)), '00')
  assert.equal(hex(D.encodeLength(127)), '7f')
  assert.equal(hex(D.encodeLength(128)), '8180')
  assert.equal(hex(D.encodeLength(300)), '82012c')
})

test('integers are signed and minimal', () => {
  assert.equal(hex(D.integer(0)), '020100')
  assert.equal(hex(D.integer(127)), '02017f')
  // 128 的最高位是 1，DER 会补一个 0x00，否则解码方会把它当成负数。
  assert.equal(hex(D.integer(128)), '02020080')
  // 原始 buffer 的前导零会被去掉，保证同一个值只有一种编码。
  assert.equal(hex(D.integer(Buffer.from([0x00, 0x01]))), '020101')
  assert.equal(hex(D.integer(Buffer.from([0x00, 0x00]))), '020100')
})

// OID 的头两段先压成一个字节（40*第一段 + 第二段），后面的段才逐段 base-128 编码。
test('OIDs encode first two arcs together', () => {
  assert.equal(hex(D.oid('2.5.4.3')), '06035504 03'.replace(/\s/g, ''))
  assert.equal(hex(D.oid('1.2.840.113549.1.1.11')), '06092a864886f70d01010b')
  assert.equal(hex(D.oid('1.3.6.1.5.5.7.3.1')), '06082b06010505070301')
})

// 有效期用 UTCTime：两位年 + 秒级精度 + 必须带 Z，写错格式 OpenSSL 会直接解析失败。
test('UTCTime keeps the two digit year and Z suffix', () => {
  assert.equal(hex(D.time(new Date('2026-10-18T01:02:03Z'))), hex(Buffer.from('170d323631303138303130323033 5a'.replace(/\s/g, ''), 'hex')))
})

// BIT STRING 的首字节记的是「末尾有几个没派上用场的填充位」，签名和公钥都靠它对齐。
test('BIT STRING records unused trailing bits', () => {
  assert.equal(hex(D.bitString(Buffer.from([0x06]), 1)), '03020106')
  assert.equal(hex(D.bitString(Buffer.from([0xa0]), 5)), '030205a0')
})

// SEQUENCE 即使为空也得留 30 00 的头；context 标签要保住自己的 class 位，不能退化成普通 SEQUENCE。
test('SEQUENCE / SET wrap children and context tags keep their class', () => {
  assert.equal(hex(D.seq()), '3000')
  assert.equal(hex(D.seq(D.integer(2))), '3003020102')
  assert.equal(hex(D.context(0, D.integer(2))), 'a003020102')
  assert.equal(hex(D.context(2, Buffer.from('a.com', 'ascii'), false)), '8205612e636f6d')
})

// DER 的 TRUE 必须编成 0xff（不是 0x01），NULL 则是固定的 05 00。
test('BOOLEAN true and NULL', () => {
  assert.equal(hex(D.bool(true)), '0101ff')
  assert.equal(hex(D.bool(false)), '010100')
  assert.equal(hex(D.NULL), '0500')
})
