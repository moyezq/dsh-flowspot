/**
 * dsh-flowspot: 把面板选中的数据目录记在哪。
 *
 * 面板的「选择数据目录」按钮改不了 profile 里的 cordis patch（那是宿主的事），
 * 所以选择落在一个小 pointer 文件里，放在 DSH home 下。运行时启动时读它，
 * 也正因为如此，换目录要重启才生效：CA 和 flow 文件都是启动时打开一次的。
 *
 * pointer 里还带一个 `copyFrom`——新 CA 创建时要继承哪个目录的证书机构。
 * 面板自己不能复制（当前进程还占着旧目录），而提前复制会在「选了又反悔」时
 * 留下一份私钥副本。交接只做一次：下次启动复制完就把这个字段清掉。
 *
 * 优先级：面板选择（本文件）> 插件配置 `dataDir` > 默认 `$DSH_HOME/dsh-flowspot`。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** DSH home，与宿主自己的算法保持一致。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** pointer 文件的绝对路径。 */
export function locationFile() {
  return path.join(dshHome(), 'dsh-flowspot.location.json')
}

/**
 * 读整个 pointer：选中的目录，加上可能还挂着的 CA 交接。
 * 文件缺失、坏掉、或没写 dataDir，都算「没选过」，一律回 null。
 * @returns {{dataDir: string, copyFrom: string|null}|null}
 */
export function readPointer() {
  try {
    const raw = JSON.parse(fs.readFileSync(locationFile(), 'utf8'))
    const dataDir = raw && typeof raw.dataDir === 'string' ? raw.dataDir.trim() : ''
    if (!dataDir) return null
    const copyFrom = raw && typeof raw.copyFrom === 'string' && raw.copyFrom.trim() ? raw.copyFrom.trim() : null
    return { dataDir, copyFrom }
  } catch {
    return null
  }
}

/**
 * 面板选中的目录；没存过就是 null（调用方接着退回配置和默认值）。
 * @returns {string|null}
 */
export function readLocation() {
  return readPointer()?.dataDir ?? null
}

/**
 * 记住选中的目录。存进去的就是用户给的原样，`~` 和相对路径留到真正解析目录
 * 的那一步再展开，面板因此不必自己拼绝对路径。
 * @param {string} dataDir 绝对路径，或用户手输的路径
 * @param {{copyFrom?: string|null}} [options] 下次启动要从哪个目录继承 CA
 */
export function writeLocation(dataDir, { copyFrom = null } = {}) {
  const file = locationFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // `updatedAt` 只给人排查时看，读的地方一个字都不用。
  fs.writeFileSync(
    file,
    `${JSON.stringify({ dataDir, copyFrom: copyFrom || null, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
}

/** 抹掉还挂着的 CA 交接，但保留选中的目录（交接已经做完了）。 */
export function clearCopyFrom() {
  const pointer = readPointer()
  if (!pointer || !pointer.copyFrom) return
  writeLocation(pointer.dataDir, { copyFrom: null })
}

/** 删掉存下的选择，退回「先看配置、再看默认目录」。 */
export function clearLocation() {
  try {
    fs.unlinkSync(locationFile())
  } catch {
    /* 本来就不在 */
  }
}
