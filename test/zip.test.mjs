/**
 * 零依赖 zip：只验证随包扩展能被打出一个结构可用的 ZIP（本地头、中央目录、结束记录）。
 * 运行：node test/zip.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { zipDirectory } from '../lib/zip.js'

test('zips a directory into a readable store-only archive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flowspot-zip-'))
  try {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"name":"x"}', 'utf8')
    fs.writeFileSync(path.join(dir, 'sub', 'content.js'), 'console.log(1)\n', 'utf8')

    const zip = zipDirectory(dir)
    assert.equal(zip.readUInt32LE(0), 0x04034b50)
    // 结束记录在最后 22 字节，两个条目。
    const end = zip.subarray(zip.length - 22)
    assert.equal(end.readUInt32LE(0), 0x06054b50)
    assert.equal(end.readUInt16LE(10), 2)
    // 文件名以 UTF-8 明文出现在本地头里。
    assert.ok(zip.includes(Buffer.from('manifest.json')))
    assert.ok(zip.includes(Buffer.from('sub/content.js')))
    // 中央目录签名出现两次（一个条目一次）。
    let count = 0
    for (let index = 0; index < zip.length - 4; index++) {
      if (zip.readUInt32LE(index) === 0x02014b50) count++
    }
    assert.equal(count, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing directory throws instead of building an empty zip', () => {
  assert.throws(() => zipDirectory(path.join(os.tmpdir(), 'dsh-flowspot-no-such-dir')))
})
