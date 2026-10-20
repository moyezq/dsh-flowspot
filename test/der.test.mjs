/**
 * DER encoding: the byte-level contract the certificate builder relies on.
 * Run with: node test/der.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as D from '../lib/der.js'

const hex = (buf) => Buffer.from(buf).toString('hex')

test('lengths use the short form below 128 and the long form above', () => {
  assert.equal(hex(D.encodeLength(0)), '00')
  assert.equal(hex(D.encodeLength(127)), '7f')
  assert.equal(hex(D.encodeLength(128)), '8180')
  assert.equal(hex(D.encodeLength(300)), '82012c')
})

test('integers are signed and minimal', () => {
  assert.equal(hex(D.integer(0)), '020100')
  assert.equal(hex(D.integer(127)), '02017f')
  // 128 has the high bit set, so DER prepends a zero byte.
  assert.equal(hex(D.integer(128)), '02020080')
  // Leading zeroes of a raw buffer are stripped.
  assert.equal(hex(D.integer(Buffer.from([0x00, 0x01]))), '020101')
  assert.equal(hex(D.integer(Buffer.from([0x00, 0x00]))), '020100')
})

test('OIDs encode first two arcs together', () => {
  assert.equal(hex(D.oid('2.5.4.3')), '06035504 03'.replace(/\s/g, ''))
  assert.equal(hex(D.oid('1.2.840.113549.1.1.11')), '06092a864886f70d01010b')
  assert.equal(hex(D.oid('1.3.6.1.5.5.7.3.1')), '06082b06010505070301')
})

test('UTCTime keeps the two digit year and Z suffix', () => {
  assert.equal(hex(D.time(new Date('2026-10-18T01:02:03Z'))), hex(Buffer.from('170d323631303138303130323033 5a'.replace(/\s/g, ''), 'hex')))
})

test('BIT STRING records unused trailing bits', () => {
  assert.equal(hex(D.bitString(Buffer.from([0x06]), 1)), '03020106')
  assert.equal(hex(D.bitString(Buffer.from([0xa0]), 5)), '030205a0')
})

test('SEQUENCE / SET wrap children and context tags keep their class', () => {
  assert.equal(hex(D.seq()), '3000')
  assert.equal(hex(D.seq(D.integer(2))), '3003020102')
  assert.equal(hex(D.context(0, D.integer(2))), 'a003020102')
  assert.equal(hex(D.context(2, Buffer.from('a.com', 'ascii'), false)), '8205612e636f6d')
})

test('BOOLEAN true and NULL', () => {
  assert.equal(hex(D.bool(true)), '0101ff')
  assert.equal(hex(D.bool(false)), '010100')
  assert.equal(hex(D.NULL), '0500')
})
