/**
 * dsh-flowspot: flow storage.
 *
 * A flow is one HTTP transaction: request line, headers, bounded body
 * previews, response status, timings and the TLS tunnel it arrived through.
 * Memory is a ring (oldest dropped first) and, when persistence is on, every
 * finished flow is appended to a JSONL file so a session can be re-read later.
 *
 * Two deliberate limits:
 *  - bodies are capped (config.maxBodyBytes) and marked truncated, never
 *    silently dropped;
 *  - sensitive headers are masked on capture unless config.redact is false.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

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
 * The filter groups the panel offers, in the order F12's network panel lists
 * them. `all` is the no-filter entry and is never a flow's own type.
 */
export const RESOURCE_TYPES = ['all', 'xhr', 'doc', 'css', 'js', 'img', 'media', 'font', 'ws', 'wasm', 'manifest', 'other']

/**
 * `sec-fetch-dest` → filter group. Chrome/Edge/Firefox send this on every
 * request, which is the same signal DevTools classifies by; without it (curl,
 * older clients) the response mime type is the fallback.
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

/** Mime → filter group, for clients that do not send `sec-fetch-dest`. */
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
 * One flow's filter group. WebSocket upgrades win over the mime fallback
 * because their handshake answers 101 and carries no meaningful body mime.
 * @param {object} flow stored flow
 * @returns {string} one of {@link RESOURCE_TYPES} except `all`
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
    // Truncated or malformed; fall back to the bytes we have.
  }
  return { data: buf, decoded: false }
}

/**
 * Build the body preview stored on a flow.
 * @param {Buffer} buf raw body bytes as they crossed the wire
 * @param {object} headers lower-cased header map
 * @param {number} maxBytes preview cap
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
  constructor({ maxFlows = 1000, maxBodyBytes = 262144, redact = true, persistDir = null, log } = {}) {
    this.maxFlows = Math.max(50, maxFlows)
    this.maxBodyBytes = Math.max(1024, maxBodyBytes)
    this.redact = redact !== false
    this.log = log || { warn() {} }
    this.flows = []
    this.byId = new Map()
    this.seq = 0
    this.dropped = 0
    // The ledger file belongs to one capture session, not to the mount:
    // start() begins a session, the first finished flow creates the file,
    // stop() closes it. A plugin that is loaded but never captures traffic
    // therefore leaves no empty file behind.
    this.persistDir = persistDir
    this.stream = null
    this.persistFile = null
  }

  /**
   * Open this capture session's JSONL file. No-op when persistence is off or a
   * file is already open, so calling it twice in one session is safe.
   * @returns {string|null} the file backing this session, or null
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
   * Start a new capture session: close the previous ledger and forget its name.
   * The next finished flow opens a fresh file, so a session that captures
   * nothing leaves no file at all.
   */
  beginSession() {
    this.close()
    this.persistFile = null
  }

  /** Start a flow; returns the mutable record so the proxy can fill it in. */
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
    while (this.flows.length > this.maxFlows) {
      const evicted = this.flows.shift()
      this.byId.delete(evicted.id)
      this.dropped++
    }
    return flow
  }

  /** Attach a request body preview. */
  setRequestBody(flow, buf) {
    if (!buf || !buf.length) return
    flow.reqBody = describeBody(buf, flow.reqHeaders, Math.min(this.maxBodyBytes, 65536))
  }

  /** Finish a flow: response head, body preview, timing, optional error. */
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
      // The code (ECONNRESET, CERT_HAS_EXPIRED, …) turns "socket hang up" into
      // something diagnosable; the phase says where it happened.
      flow.errorCode = errorCode || (error && error.code ? String(error.code) : null)
      flow.errorPhase = errorPhase || null
    }
    this._persist(flow)
  }

  _persist(flow) {
    if (!this.stream) {
      if (!this.persistDir) return
      // Defensive: a flow that finishes before start() opened the ledger still
      // reaches the disk instead of vanishing.
      this.open()
      if (!this.stream) return
    }
    try {
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

  /** Summaries, newest first. */
  list({ host, method, status, type, q, since, limit = 20 } = {}) {
    const needle = q ? String(q).toLowerCase() : null
    const wantType = type && type !== 'all' ? String(type) : null
    const out = []
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
   * Group repeated calls to one endpoint, newest group first.
   *
   * A polling interface (for example `POST /api/v2/collect` every second) would
   * otherwise push everything else out of the list. Key: method + exact URL, or
   * method + URL with polling/paging parameters folded away when `normalize` is
   * on. Members are the newest `maxItems` occurrences, newest first.
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
      // Iterating newest-first: the last write is the oldest occurrence.
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

  /** Search URL, headers or body text; returns hits with the matched snippet. */
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
      /** Whether finished flows are written to disk at all. */
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
      /* already closed */
    }
    this.stream = null
  }
}

/** Compact view used by list/search/tool output. */
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

/** curl that reproduces the request (bodies only when they were textual). */
export function curlOf(flow) {
  const parts = [`curl -X ${flow.method} '${flow.url}'`]
  for (const [key, value] of Object.entries(flow.reqHeaders || {})) {
    if (key === 'content-length' || key === 'host' || key === 'connection' || key === 'proxy-connection') continue
    const v = Array.isArray(value) ? value.join(', ') : String(value)
    parts.push(`  -H '${key}: ${v.replace(/'/g, `'\\''`)}'`)
  }
  if (flow.reqBody?.text) parts.push(`  --data-raw '${flow.reqBody.text.replace(/'/g, `'\\''`)}'`)
  else if (flow.reqBody?.base64) parts.push(`  # body was binary: ${flow.reqBody.bytes} bytes (${flow.reqBody.mime || 'unknown'})`)
  return parts.join(' \\\n')
}

/** HAR 1.2 entry for one flow. */
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
 * Query parameters that say "which poll / which page" rather than "which
 * endpoint": timestamps, nonces, cursors and paging. They change on every call,
 * so a polling API would otherwise split into one row per request.
 *
 * Deliberately narrow: an unknown parameter is part of the endpoint's identity
 * (`id`, `keyword`, `type`…), and folding it would merge unrelated resources.
 */
const VOLATILE_PARAMS = new Set([
  't', 'ts', 'timestamp', 'time', '_', '_t', 'nonce', 'rnd', 'random',
  'page', 'pagenum', 'pageno', 'pagesize', 'page_size', 'offset', 'limit',
  'cursor', 'since', 'seq', 'count',
])

/**
 * The endpoint a URL belongs to, with volatile parameters folded away and the
 * rest sorted so the same endpoint always produces the same string.
 * @param {string} url absolute request URL
 * @returns {string} normalized endpoint URL (the input when it cannot be parsed)
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
