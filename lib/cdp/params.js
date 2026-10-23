/**
 * dsh-flowspot: key parameters of a request, and whether they look static.
 *
 * Before any breakpoint, the cheap win is a table: the captured request's query
 * and body parameters, compared with the last few calls to the same endpoint.
 * A value that never changes is a static candidate; one that does is dynamic
 * and is where the analysis should start. This uses the same request model as
 * the code generators, so "params" means the same thing everywhere.
 */

import { requestSpecOf } from '../codegen/request.js'

/** String form used for comparison and display. */
function display(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Flatten a JSON body into dotted names, two levels deep.
 * @param {unknown} value
 * @param {string} [prefix]
 * @param {number} [depth]
 * @returns {[string, unknown][]}
 */
export function flattenJson(value, prefix = '', depth = 0) {
  if (value === null || typeof value !== 'object') return prefix ? [[prefix, value]] : []
  if (depth >= 2) return [[prefix || 'body', value]]
  if (Array.isArray(value)) {
    const out = []
    for (let index = 0; index < value.length; index++) {
      out.push(...flattenJson(value[index], `${prefix}[${index}]`, depth + 1))
    }
    return out.length ? out : [[prefix || 'body', value]]
  }
  const out = []
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key
    out.push(...flattenJson(item, name, depth + 1))
  }
  return out
}

/**
 * Parameters of one request, in capture order (query first, then body).
 * @param {object} flow stored flow
 * @returns {{name: string, where: 'query'|'body', value: string}[]}
 */
export function pairsOf(flow) {
  const spec = requestSpecOf(flow)
  const out = []
  for (const pair of spec.query) out.push({ name: pair.name, where: 'query', value: pair.value })
  if (spec.body.kind === 'json') {
    for (const [name, value] of flattenJson(spec.body.value)) out.push({ name, where: 'body', value: display(value) })
  } else if (spec.body.kind === 'form') {
    for (const pair of spec.body.pairs) out.push({ name: pair.name, where: 'body', value: pair.value })
  }
  return out
}

/**
 * Compare one flow's parameters with previous calls to the same endpoint.
 *
 * One occurrence counts as static by definition and says so via `samples`, so a
 * reader does not mistake "no evidence yet" for "proven constant".
 * @param {object} flow current flow
 * @param {object[]} siblings other flows of the same method + normalized URL
 * @returns {{name: string, where: string, value: string, stability: 'static'|'dynamic', samples: number, values: string[]}[]}
 */
export function analyseParams(flow, siblings = []) {
  const current = pairsOf(flow)
  const history = new Map()
  for (const sibling of siblings) {
    if (sibling === flow || sibling.id === flow.id) continue
    for (const pair of pairsOf(sibling)) {
      const key = `${pair.where}\u0000${pair.name}`
      if (!history.has(key)) history.set(key, [])
      history.get(key).push(pair.value)
    }
  }
  return current.map((pair) => {
    const key = `${pair.where}\u0000${pair.name}`
    const past = history.get(key) || []
    const values = [...new Set([pair.value, ...past])]
    return {
      name: pair.name,
      where: pair.where,
      value: pair.value,
      stability: values.length <= 1 ? 'static' : 'dynamic',
      samples: past.length + 1,
      values: values.slice(0, 4),
    }
  })
}
