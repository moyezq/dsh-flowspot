/**
 * dsh-flowspot：零依赖 ZIP 打包（store，不压缩）。
 *
 * 只为「把随包的浏览器扩展给用户下载」这一件事：文件都是小文本，压缩收益不高，
 * store 模式几十行就能写完，也不用引第三方库。ZIP 结构按 PKZIP APPNOTE：
 * 本地头 + 数据、中央目录、结束记录；文件名走 UTF-8 标志位。
 */

import fs from 'node:fs'
import path from 'node:path'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  return { dosDate, dosTime }
}

function walk(dir, prefix, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === '.DS_Store') continue
    const absolute = path.join(dir, name)
    const relative = prefix ? `${prefix}/${name}` : name
    const stat = fs.statSync(absolute)
    if (stat.isDirectory()) walk(absolute, relative, out)
    else if (stat.isFile()) out.push({ name: relative, absolute })
  }
}

/**
 * 把一个目录打成 ZIP。
 * @param {string} dir
 * @returns {Buffer} zip 字节；目录不存在时抛错
 */
export function zipDirectory(dir) {
  const files = []
  walk(dir, '', files)
  const { dosDate, dosTime } = dosDateTime(new Date())
  const localChunks = []
  const centralEntries = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8')
    const data = fs.readFileSync(file.absolute)
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    localChunks.push(local, name, data)
    centralEntries.push({ name, crc, size: data.length, offset })
    offset += local.length + name.length + data.length
  }

  const centralChunks = []
  let centralSize = 0
  for (const entry of centralEntries) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(dosTime, 12)
    header.writeUInt16LE(dosDate, 14)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(entry.size, 20)
    header.writeUInt32LE(entry.size, 24)
    header.writeUInt16LE(entry.name.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(entry.offset, 42)
    centralChunks.push(header, entry.name)
    centralSize += header.length + entry.name.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(centralEntries.length, 8)
  end.writeUInt16LE(centralEntries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, ...centralChunks, end])
}
