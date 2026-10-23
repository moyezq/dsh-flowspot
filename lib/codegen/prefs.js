/**
 * dsh-flowspot: 面板提供哪些代码语言，以及按什么顺序。
 *
 * 这是面板偏好，不是抓包设置，所以放在 DSH home 下的一个小指针文件里
 * （和数据目录的选择同一个地方），而不是写进 profile 的 cordis patch：
 * 调一下按钮顺序不该要求重启 DSH；而且面板和 agent 工具都能直接读这个指针，
 * 不必在面板 bundle 里再存一份清单。
 */

import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from '../location.js'
import { LANGUAGE_IDS, languageOf } from './index.js'

/** 偏好文件的绝对路径：`$DSH_HOME/dsh-flowspot.codegen.json`。 */
export function codegenFile() {
  return path.join(dshHome(), 'dsh-flowspot.codegen.json')
}

/** 默认偏好：所有语言都显示，顺序就是注册表里的声明顺序。 */
export function defaultPrefs() {
  return { order: [...LANGUAGE_IDS], hidden: [] }
}

/**
 * 把磁盘上（或 POST 上来）的内容收敛成一份能用的偏好。
 *
 * 三条规则：未知 id 丢掉、缺的语言按注册表顺序补齐、至少留一个可见——
 * 全藏起来会让代码视图看起来像坏了。
 * @param {unknown} raw 存下来的或提交上来的偏好
 * @returns {{order: string[], hidden: string[]}}
 */
export function normalizePrefs(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const known = new Set(LANGUAGE_IDS)
  const order = []
  // 规则一：只认注册表里的 id，重复的保留第一次出现的位置（顺序是拖出来的）。
  for (const id of Array.isArray(source.order) ? source.order : []) {
    if (known.has(id) && !order.includes(id)) order.push(id)
  }
  // 规则二：存下来的顺序里缺的语言，按注册表顺序补到末尾。
  for (const id of LANGUAGE_IDS) {
    if (!order.includes(id)) order.push(id)
  }
  let hidden = [...new Set((Array.isArray(source.hidden) ? source.hidden : []).filter((id) => known.has(id)))]
  // 规则三：如果每个语言都被藏了，强制放开排在最前的那一个。
  if (order.every((id) => hidden.includes(id))) {
    hidden = hidden.filter((id) => id !== order[0])
  }
  return { order, hidden }
}

/** 读存下来的偏好；还没存过（或文件坏了）就用默认值。 */
export function readPrefs() {
  try {
    return normalizePrefs(JSON.parse(fs.readFileSync(codegenFile(), 'utf8')))
  } catch {
    return defaultPrefs()
  }
}

/**
 * 保存一份偏好；返回真正写进去的、归一化后的值。
 * @param {unknown} next `{order, hidden}`
 * @returns {{order: string[], hidden: string[]}}
 */
export function writePrefs(next) {
  // 先归一化再落盘：磁盘上的内容和返回值保持一致，调用方不用自己再收敛一次。
  const prefs = normalizePrefs(next)
  const file = codegenFile()
  // 目录可能还不存在，先建出来。
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    // 末尾补换行、键排两格缩进：这个文件是给人看和手改的。
    `${JSON.stringify({ ...prefs, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  return prefs
}

/**
 * 按使用者定的顺序给出语言列表，每项带上是否隐藏，供面板的 chips 和设置列表用。
 * @param {{order: string[], hidden: string[]}} prefs
 * @returns {{id: string, label: string, note: string, hidden: boolean}[]}
 */
export function langsOf(prefs) {
  return prefs.order.map((id) => {
    const language = languageOf(id)
    return { id: language.id, label: language.label, note: language.note, hidden: prefs.hidden.includes(id) }
  })
}

