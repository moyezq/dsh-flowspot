/**
 * dsh-flowspot: 代码语言注册表，一种语言一行。
 *
 * 面板、agent 工具和原来的 cURL 导出都从这张表渲染，所以六个目标不会各自跑偏：
 * 加一个文件、加一行，两边就同时支持。这里的顺序是按钮的默认顺序；
 * 使用者自己调的顺序和显隐存在 `prefs.js`。
 */

import { renderCurl } from './curl.js'
import { renderGo } from './go.js'
import { renderJavaScript } from './javascript.js'
import { renderNode } from './node.js'
import { renderPython } from './python.js'
import { requestSpecOf } from './request.js'
import { renderRust } from './rust.js'

/**
 * 每个条目就是一种「代码语言」。`label` 和 `note` 会直接显示在代码视图里，
 * 属于产品文案，不跟源码注释一起翻译。
 */
export const LANGUAGES = [
  {
    id: 'curl',
    label: 'cURL',
    note: '与浏览器「Copy as cURL」同形，可直接在终端运行',
    render: renderCurl,
  },
  {
    id: 'python',
    label: 'Python',
    note: 'requests：pip install requests',
    render: renderPython,
  },
  {
    id: 'go',
    label: 'Go',
    note: '仅标准库 net/http',
    render: renderGo,
  },
  {
    id: 'rust',
    label: 'Rust',
    note: 'Cargo 依赖 reqwest + serde_json',
    render: renderRust,
  },
  {
    id: 'javascript',
    label: 'JavaScript',
    note: '浏览器 fetch：跨域需 CORS，cookie 由浏览器携带',
    render: renderJavaScript,
  },
  {
    id: 'node',
    label: 'Node.js',
    note: 'Node ≥18 内置 fetch，保存为 .mjs 后运行',
    render: renderNode,
  },
]

export const LANGUAGE_IDS = LANGUAGES.map((language) => language.id)

/** 取已知的语言；id 缺失或未知时回落到第一个（cURL），代码视图不会因此空白。 */
export function languageOf(id) {
  return LANGUAGES.find((language) => language.id === id) || LANGUAGES[0]
}

/**
 * 把一条 flow 渲染成一种语言的脚本。
 * @param {object} flow 存下来的 flow
 * @param {string} langId 代码语言 id（未知 id 回落到 cURL）
 * @returns {{id: string, label: string, note: string, code: string, notes: string[]}}
 */
export function renderCode(flow, langId) {
  const language = languageOf(langId)
  const spec = requestSpecOf(flow)
  const rendered = language.render(spec)
  // 两处 note 摊平成一个数组：spec 的 note 来自请求模型（打码、截断、重复键），
  // 渲染器自己的 note 是这门语言的取舍（丢头、补凭据）。它们最终都会变成
  // 生成脚本头部的一行 `# 注意：`，调用方只需照单全收。
  return {
    id: language.id,
    label: language.label,
    note: language.note,
    code: rendered.code,
    notes: [...spec.notes, ...(rendered.notes || [])],
  }
}

export { requestSpecOf }
