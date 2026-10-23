/**
 * dsh-flowspot: flow 的存储与查询。
 *
 * 一条 flow 是一次 HTTP 事务：请求行、头、有上限的体预览、响应状态、耗时，
 * 以及它进来时走的 TLS 隧道。内存里是环形缓冲（先淘汰最旧的）；打开落盘时，
 * 每条完成的 flow 追加进一份 JSONL 文件，整个抓包会话事后还能回读。
 *
 * 两处刻意的限制：
 *  - 体按 config.maxBodyBytes 截断并标 truncated，绝不静默丢掉；
 *  - 敏感头只在 config.redact 打开时才打码（默认关闭：抓的是本机流量，
 *    而生成的脚本要真实值才能跑）。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { renderCurl } from './codegen/curl.js'
import { requestSpecOf } from './codegen/request.js'

// 打码只管这几个头，而且只有 config.redact 打开时才生效（默认关闭）。理由：
// 抓的是本机自己的流量，主动打码反而让导出的脚本不能直接用。
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
])

const TEXTUAL = /^text\/|json|xml|javascript|x-www-form-urlencoded|graphql|event-stream|x-ndjson/i

export function mimeOf(headers) {
  if (!headers) return ''
  return String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase()
}

/**
 * 面板提供的筛选分组，顺序照搬 F12 网络面板。`all` 是「不筛选」那一项，
 * 永远不会是某条 flow 自己的类型。
 */
export const RESOURCE_TYPES = ['all', 'xhr', 'doc', 'css', 'js', 'img', 'media', 'font', 'ws', 'wasm', 'manifest', 'other']

/**
 * `sec-fetch-dest` → 筛选分组。Chrome/Edge/Firefox 每个请求都带这个头，也正是
 * DevTools 用来分类的信号；没有它时（curl、老客户端）就退回看响应的 mime。
 */
const DEST_TYPES = {
  empty: 'xhr',
  document: 'doc',
  iframe: 'doc',
  frame: 'doc',
  embed: 'doc',
  object: 'doc',
  style: 'css',
  script: 'js',
  worker: 'js',
  sharedworker: 'js',
  serviceworker: 'js',
  image: 'img',
  video: 'media',
  audio: 'media',
  track: 'media',
  font: 'font',
  manifest: 'manifest',
}

/** mime → 筛选分组，给不发 `sec-fetch-dest` 的客户端兜底。 */
function typeOfMime(mime) {
  if (!mime) return 'other'
  if (mime.includes('wasm')) return 'wasm'
  if (mime.startsWith('image/')) return 'img'
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'media'
  if (mime.startsWith('font/') || mime.includes('font-woff') || mime.includes('ms-fontobject')) return 'font'
  if (mime.includes('text/css')) return 'css'
  if (mime.includes('javascript') || mime.includes('ecmascript')) return 'js'
  if (mime.includes('text/html') || mime.includes('xhtml')) return 'doc'
  if (mime.includes('manifest')) return 'manifest'
  return 'xhr'
}

/**
 * 一条 flow 属于哪个筛选分组。WebSocket 升级排在 mime 兜底之前：握手回 101，
 * 那个响应头里没有有意义的体 mime。
 * @param {object} flow 已存储的 flow
 * @returns {string} {@link RESOURCE_TYPES} 之一，不会是 `all`
 */
export function resourceTypeOf(flow) {
  const headers = flow.reqHeaders || {}
  if (String(headers.upgrade || '').toLowerCase().includes('websocket') || flow.status === 101) return 'ws'
  const dest = String(headers['sec-fetch-dest'] || '').toLowerCase()
  if (dest && Object.hasOwn(DEST_TYPES, dest)) return DEST_TYPES[dest]
  if (dest === 'report' || dest === 'xslt') return 'other'
  return typeOfMime(String(flow.mime || '').toLowerCase())
}


function looksTextual(mime, buf) {
  if (TEXTUAL.test(mime)) return true
  if (!buf.length) return true
  let control = 0
  const sample = buf.subarray(0, Math.min(buf.length, 1024))
  for (const byte of sample) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) control++
  }
  return control / sample.length < 0.02
}

function decompress(buf, encoding) {
  if (!encoding) return { data: buf, decoded: false }
  try {
    if (encoding.includes('gzip')) return { data: zlib.gunzipSync(buf), decoded: true }
    if (encoding.includes('deflate')) return { data: zlib.inflateSync(buf), decoded: true }
    if (encoding.includes('br')) return { data: zlib.brotliDecompressSync(buf), decoded: true }
  } catch {
    // 数据被截断或编码坏了：退回手上的原始字节，解压失败不该影响抓包。
  }
  return { data: buf, decoded: false }
}

/**
 * 生成挂在 flow 上的体预览。
 * 顺序是「按 content-encoding 解压 → 按 maxBytes 截断 → 再判文本」：文本给
 * `text`、二进制给 `base64`（两者互斥），面板据此决定怎么展示。
 * @param {Buffer} buf 过线时的原始体字节
 * @param {object} headers 小写化的头映射
 * @param {number} maxBytes 预览上限
 */
export function describeBody(buf, headers, maxBytes) {
  const mime = mimeOf(headers)
  const encoding = String(headers['content-encoding'] || '').toLowerCase()
  const { data, decoded } = decompress(buf, encoding)
  const truncated = data.length > maxBytes
  const slice = truncated ? data.subarray(0, maxBytes) : data
  const textual = looksTextual(mime, slice)
  return {
    mime,
    encoding: decoded ? encoding : null,
    wireBytes: buf.length,
    bytes: data.length,
    truncated,
    text: textual ? slice.toString('utf8') : null,
    base64: textual ? null : slice.toString('base64'),
  }
}

function redactHeaders(headers, redact) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase()
    out[lower] = redact && SENSITIVE_HEADERS.has(lower) ? '***redacted***' : value
  }
  return out
}

export class FlowStore {
  constructor({ maxFlows = 1000, maxBodyBytes = 262144, redact = false, persistDir = null, log } = {}) {
    this.maxFlows = Math.max(50, maxFlows)
    this.maxBodyBytes = Math.max(1024, maxBodyBytes)
    this.redact = redact === true
    this.log = log || { warn() {} }
    this.flows = []
    this.byId = new Map()
    this.seq = 0
    this.dropped = 0
    // 这份流水文件属于一次抓包会话，而不是插件挂载：start() 开一场会话，
    // 第一条完成的 flow 才创建文件，stop() 关掉。所以「加载了但没抓流量」
    // 的插件不会留下空文件。
    this.persistDir = persistDir
    this.stream = null
    this.persistFile = null
  }

  /**
   * 打开本次抓包会话的 JSONL 文件。未开启落盘、或文件已经打开时什么都不做，
   * 所以一次会话里重复调用是安全的。
   * @returns {string|null} 本次会话正在写的文件；没有则为 null
   */
  open() {
    if (!this.persistDir || this.stream) return this.persistFile
    try {
      fs.mkdirSync(this.persistDir, { recursive: true })
      const file = path.join(this.persistDir, `flows-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
      const stream = fs.createWriteStream(file, { flags: 'a' })
      stream.on('error', (err) => this.log.warn(`[dsh-flowspot] flow 落盘失败 ${err.message}`))
      this.stream = stream
      this.persistFile = file
    } catch (err) {
      this.log.warn(`[dsh-flowspot] 无法创建落盘目录 ${err.message}`)
    }
    return this.persistFile
  }

  /**
   * 开一场新的抓包会话：关掉上一份流水并忘掉它的文件名。下一条完成的 flow
   * 才会打开新文件，所以没抓到东西的会话一个文件都不留。
   */
  beginSession() {
    this.close()
    this.persistFile = null
  }

  /**
   * 开一条 flow；返回可变记录，代理随后往里填响应和错误。
   * 此刻只定下 id/seq/时间与请求侧字段，响应侧一律先占 null。
   */
  begin(fields) {
    const seq = ++this.seq
    const flow = {
      id: `f${seq}`,
      seq,
      ts: Date.now(),
      startedAt: fields.startedAt ?? Date.now(),
      finishedAt: null,
      durationMs: null,
      tunnel: fields.tunnel || null,
      scheme: fields.scheme || 'https',
      method: fields.method || 'GET',
      host: fields.host || '',
      port: fields.port || 443,
      path: fields.path || '/',
      url: fields.url || '',
      httpVersion: fields.httpVersion || 'HTTP/1.1',
      reqHeaders: redactHeaders(fields.reqHeaders, this.redact),
      reqBody: null,
      respHeaders: null,
      status: null,
      respBody: null,
      mime: '',
      respBytes: 0,
      error: null,
      errorCode: null,
      errorPhase: null,
      client: fields.client || null,
    }
    this.flows.push(flow)
    this.byId.set(flow.id, flow)
    // 环形缓冲：超上限就从最旧的开始淘汰，byId 同步删掉，避免 get() 捞到一条
    // 已经不在列表里的 flow；dropped 只增不减，用来解释列表里「少了几条」。
    while (this.flows.length > this.maxFlows) {
      const evicted = this.flows.shift()
      this.byId.delete(evicted.id)
      this.dropped++
    }
    return flow
  }

  /** 挂上请求体的预览。请求体一般很小，这里再单独压一个 64KB 上限。 */
  setRequestBody(flow, buf) {
    if (!buf || !buf.length) return
    flow.reqBody = describeBody(buf, flow.reqHeaders, Math.min(this.maxBodyBytes, 65536))
  }

  /**
   * 结束一条 flow：落响应头、体预览、耗时，以及可选的错误。
   * finishedAt/durationMs 只在这里写，一条 flow 只该在拿到响应头或确定失败时
   * 调一次；写完后立刻落盘（见 _persist）。
   */
  finish(flow, { status, headers, body, error, errorCode, errorPhase, durationMs } = {}) {
    flow.finishedAt = Date.now()
    flow.durationMs = durationMs ?? flow.finishedAt - flow.startedAt
    if (headers) {
      flow.respHeaders = redactHeaders(headers, this.redact)
      flow.mime = mimeOf(flow.respHeaders)
    }
    if (typeof status === 'number') flow.status = status
    if (body && body.length) {
      flow.respBody = describeBody(body, flow.respHeaders || {}, this.maxBodyBytes)
      flow.respBytes = body.length
    }
    if (error) {
      flow.error = String(error.message || error)
      // 错误码（ECONNRESET、CERT_HAS_EXPIRED……）能把「socket hang up」变成
      // 能查的东西；phase 说明失败发生在哪一段（见 CONTEXT 的错误阶段）。
      flow.errorCode = errorCode || (error && error.code ? String(error.code) : null)
      flow.errorPhase = errorPhase || null
    }
    this._persist(flow)
  }

  _persist(flow) {
    if (!this.stream) {
      if (!this.persistDir) return
      // 兜底：某条 flow 在 start() 打开流水之前就结束了，也照样落盘而不是消失。
      this.open()
      if (!this.stream) return
    }
    try {
      // 落盘时把文本预览再砍到 32KB（base64 不砍）：流水是给人事后回读的，
      // 全量文本会把一次长时间抓包的文件撑到几百 MB。
      const line = JSON.stringify({
        ...flow,
        reqBody: flow.reqBody ? { ...flow.reqBody, text: flow.reqBody.text?.slice(0, 32768) ?? null } : null,
        respBody: flow.respBody ? { ...flow.respBody, text: flow.respBody.text?.slice(0, 32768) ?? null } : null,
      })
      this.stream.write(`${line}\n`)
    } catch (err) {
      this.log.warn(`[dsh-flowspot] flow 序列化失败 ${err.message}`)
    }
  }

  get(id) {
    return this.byId.get(String(id)) || null
  }

  /** 请求列表用的摘要，新的在前。 */
  list({ host, method, status, type, q, since, limit = 20 } = {}) {
    const needle = q ? String(q).toLowerCase() : null
    const wantType = type && type !== 'all' ? String(type) : null
    const out = []
    // 从新往旧扫，凑够 limit 就停，所以代价只跟命中条数有关；since 先挡一道
    // 时间窗，后面才逐项比对 host/方法/状态/类型/关键词。
    for (let i = this.flows.length - 1; i >= 0; i--) {
      const f = this.flows[i]
      if (since && f.seq <= Number(since)) continue
      if (host && !String(f.host).toLowerCase().includes(String(host).toLowerCase())) continue
      if (method && String(f.method).toUpperCase() !== String(method).toUpperCase()) continue
      if (status && Number(f.status) !== Number(status)) continue
      if (wantType && resourceTypeOf(f) !== wantType) continue
      if (needle && !(`${f.url} ${f.host} ${f.method}`.toLowerCase().includes(needle))) continue
      out.push(summaryOf(f))
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * 把同一个端点的重复调用合成一组，新的组在前。
   *
   * 否则一个轮询接口（比如每秒一次的 `POST /api/v2/collect`）会把别的请求全
   * 挤出列表。分组键是「方法 + 完整 URL」；`normalize` 打开时，键里的轮询/
   * 分页参数先被折叠掉。组内成员是最近 `maxItems` 次，新的在前。
   */
  listGroups({ host, method, status, type, q, since, limit = 20, maxItems = 50, normalize = false } = {}) {
    const needle = q ? String(q).toLowerCase() : null
    const wantType = type && type !== 'all' ? String(type) : null
    const groups = new Map()
    for (let i = this.flows.length - 1; i >= 0; i--) {
      const f = this.flows[i]
      if (since && f.seq <= Number(since)) continue
      if (host && !String(f.host).toLowerCase().includes(String(host).toLowerCase())) continue
      if (method && String(f.method).toUpperCase() !== String(method).toUpperCase()) continue
      if (status && Number(f.status) !== Number(status)) continue
      if (wantType && resourceTypeOf(f) !== wantType) continue
      if (needle && !(`${f.url} ${f.host} ${f.method}`.toLowerCase().includes(needle))) continue

      const shown = normalize ? normalizeUrl(f.url) : f.url
      const key = `${String(f.method).toUpperCase()} ${shown}`
      const row = summaryOf(f)
      let group = groups.get(key)
      if (!group) {
        group = {
          key,
          method: row.method,
          url: shown,
          host: row.host,
          path: row.path,
          type: row.type,
          count: 0,
          first: null,
          latest: row,
          items: [],
          statuses: {},
          errors: 0,
        }
        groups.set(key, group)
      }
      group.count++
      // 因为是新的在前遍历，最后一次写进去的才是这组里最旧的那次。
      group.first = row
      if (row.error) group.errors++
      const statusKey = row.error ? 'ERR' : String(row.status ?? 'pending')
      group.statuses[statusKey] = (group.statuses[statusKey] || 0) + 1
      if (group.items.length < maxItems) group.items.push(row)
    }
    const out = [...groups.values()]
    for (const group of out) group.truncated = group.count > group.items.length
    return out.slice(0, limit)
  }

  /**
   * 在 URL、头或体文本里检索，返回命中项和匹配到的片段。
   * scope 决定搜哪几块：`url` 只搜 URL，`body` 只搜请求/响应体，`all`（默认）
   * 三块都搜；片段只从体里截，给面板显示上下文。
   */
  search({ q, scope = 'all', limit = 20 } = {}) {
    const needle = String(q || '').toLowerCase()
    if (!needle) return []
    const hits = []
    for (let i = this.flows.length - 1; i >= 0; i--) {
      const f = this.flows[i]
      const where = []
      let snippet = null
      if (scope !== 'body' && f.url.toLowerCase().includes(needle)) where.push('url')
      if (scope !== 'url') {
        const headerText = Object.entries({ ...f.reqHeaders, ...(f.respHeaders || {}) })
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(',') : v}`)
          .join('\n')
          .toLowerCase()
        if (headerText.includes(needle)) where.push('header')
        for (const side of ['reqBody', 'respBody']) {
          const body = f[side]
          if (body?.text && body.text.toLowerCase().includes(needle)) {
            where.push(side === 'reqBody' ? 'request-body' : 'response-body')
            const at = body.text.toLowerCase().indexOf(needle)
            snippet = snippet || body.text.slice(Math.max(0, at - 80), at + 160)
          }
        }
      }
      if (where.length) {
        hits.push({ ...summaryOf(f), where, snippet })
        if (hits.length >= limit) break
      }
    }
    return hits
  }

  /** 运行概况：总数、被淘汰条数、Top10 host 与状态分布、落盘情况。 */
  stats() {
    const byHost = new Map()
    const byStatus = new Map()
    for (const f of this.flows) {
      byHost.set(f.host, (byHost.get(f.host) || 0) + 1)
      const key = f.error ? 'error' : String(f.status || 'pending')
      byStatus.set(key, (byStatus.get(key) || 0) + 1)
    }
    const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    return {
      total: this.flows.length,
      dropped: this.dropped,
      hosts: top(byHost).map(([host, count]) => ({ host, count })),
      statuses: top(byStatus).map(([status, count]) => ({ status, count })),
      /** 是否开启了落盘（只看配置，不看文件是否已经建出来）。 */
      persist: Boolean(this.persistDir),
      persistFile: this.persistFile || null,
    }
  }

  clear() {
    this.flows = []
    this.byId.clear()
    this.dropped = 0
  }

  close() {
    try {
      this.stream?.end()
    } catch {
      /* 已经关过了 */
    }
    this.stream = null
  }
}

/** 精简视图：请求列表、检索结果和工具返回都用这一份。 */
export function summaryOf(f) {
  return {
    id: f.id,
    seq: f.seq,
    time: new Date(f.ts).toISOString(),
    method: f.method,
    status: f.status,
    type: resourceTypeOf(f),
    host: f.host,
    port: f.port,
    path: f.path,
    url: f.url,
    mime: f.mime,
    durationMs: f.durationMs,
    respBytes: f.respBytes,
    error: f.error,
    errorCode: f.errorCode || null,
    errorPhase: f.errorPhase || null,
  }
}

/**
 * 能复现这条请求的 curl。
 *
 * 直接委托给面板和 `webcap_code` 用的同一个生成器：哪些头留下、体怎么渲染由
 * `lib/codegen/request.js` 的请求模型决定，所以这里导出的结果不可能和代码
 * 视图对不上。
 */
export function curlOf(flow) {
  return renderCurl(requestSpecOf(flow)).code.trimEnd()
}

/**
 * 单条 flow 的 HAR 1.2 entry。HAR 是给外部工具读的格式：头要展成数组、
 * query 从 URL 里拆、体按文本或 base64 二选一，`headersSize` 一律 -1（我们
 * 没记原始长度）；末尾的 `_dshCapture` 是本插件自己的扩展字段。
 */
export function harEntryOf(f) {
  const headers = (map) => Object.entries(map || {}).map(([name, value]) => ({
    name,
    value: Array.isArray(value) ? value.join(', ') : String(value),
  }))
  return {
    startedDateTime: new Date(f.startedAt).toISOString(),
    time: f.durationMs ?? 0,
    request: {
      method: f.method,
      url: f.url,
      httpVersion: f.httpVersion,
      headers: headers(f.reqHeaders),
      queryString: queryOf(f.url),
      cookies: [],
      headersSize: -1,
      bodySize: f.reqBody?.wireBytes ?? 0,
      ...(f.reqBody?.text ? { postData: { mimeType: f.reqBody.mime || 'text/plain', text: f.reqBody.text } } : {}),
    },
    response: {
      status: f.status ?? 0,
      statusText: '',
      httpVersion: f.httpVersion,
      headers: headers(f.respHeaders),
      cookies: [],
      content: {
        size: f.respBytes || 0,
        mimeType: f.mime || '',
        ...(f.respBody?.text ? { text: f.respBody.text } : {}),
        ...(f.respBody?.base64 ? { text: f.respBody.base64, encoding: 'base64' } : {}),
      },
      redirectURL: (f.respHeaders?.location || ''),
      headersSize: -1,
      bodySize: f.respBytes || 0,
    },
    cache: {},
    timings: { send: 0, wait: f.durationMs ?? 0, receive: 0 },
    _dshCapture: { id: f.id, tunnel: f.tunnel },
  }
}

function queryOf(url) {
  try {
    const u = new URL(url)
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

export function harOf(flows) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'dsh-flowspot', version: '0.1.0' },
      entries: flows.map(harEntryOf),
    },
  }
}

/**
 * 说的是「第几次轮询 / 第几页」而不是「哪个端点」的查询参数：时间戳、随机数、
 * 游标和分页。它们每次调用都变，不折叠的话一个轮询接口会裂成一行一条。
 *
 * 白名单刻意窄：不认识的参数算端点身份的一部分（`id`、`keyword`、`type`……），
 * 一折叠就会把互不相干的资源并成一条。
 */
const VOLATILE_PARAMS = new Set([
  't', 'ts', 'timestamp', 'time', '_', '_t', 'nonce', 'rnd', 'random',
  'page', 'pagenum', 'pageno', 'pagesize', 'page_size', 'offset', 'limit',
  'cursor', 'since', 'seq', 'count',
])

/**
 * 一条 URL 所属的端点：折叠掉易变参数，其余参数排序，保证同一个端点永远
 * 得到同一个字符串。
 * @param {string} url 绝对请求 URL
 * @returns {string} 归一后的端点 URL（解析失败时原样返回）
 */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url)
    const base = `${parsed.origin}${parsed.pathname}`
    if (!parsed.search) return base
    const kept = [...parsed.searchParams.entries()]
      .filter(([key]) => !VOLATILE_PARAMS.has(key.toLowerCase()))
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    if (!kept.length) return base
    const search = new URLSearchParams()
    for (const [key, value] of kept) search.append(key, value)
    return `${base}?${search.toString()}`
  } catch {
    return url
  }
}
