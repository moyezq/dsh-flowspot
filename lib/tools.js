/**
 * dsh-flowspot: agent-facing tools.
 *
 * Definitions follow the host's tool shape: `parameters` is a property map with
 * field-level `required: true`, and `output.schema` is the restricted JSON
 * Schema subset the host accepts. Every tool answers JSON so the panel and the
 * model read the same facts.
 */

import { curlOf, harOf, summaryOf } from './flows.js'

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean', required: true },
      error: { type: 'string' },
    },
  },
}

function text(value) {
  return [{ type: 'text', text: value }]
}

function flag(value) {
  return value ? '是' : '否'
}

function flowLine(f) {
  const status = f.error ? 'ERR' : (f.status ?? '…')
  const time = new Date(f.ts).toISOString().slice(11, 19)
  const size = f.respBytes ? `${(f.respBytes / 1024).toFixed(1)}KB` : '—'
  const code = f.errorCode ? ` ${f.errorCode}` : ''
  const type = f.type ? ` [${f.type}]` : ''
  return `- ${f.id} ${time} ${String(f.method).padEnd(6)} ${status}${type} ${f.host}${f.path}  ${size}${f.error ? `  (${f.error}${code})` : ''}`
}

/** One-line explanation for the error codes a capture actually produces. */
const ERROR_HINTS = {
  ECONNRESET: '上游主动断开。旧版复用 keep-alive 连接时最常见（现在默认每次新建，见 ADR-0007）；仍出现时按 host 分两类看：对方要求 HTTP/2 或客户端凭证，还是这条域名本身在当前网络被中断（浏览器后台请求被网络中断也长这样，不代表代理坏了）。',
  ETIMEDOUT: '上游超时（默认 30s，可调 upstreamTimeoutMs）。',
  ENOTFOUND: 'DNS 解析失败：域名不存在或本机 DNS 被拦截。',
  EAI_AGAIN: 'DNS 暂时失败：临时网络问题，重试即可。',
  CERT_HAS_EXPIRED: '上游证书过期（我们不跳过校验）。',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '上游证书链不完整。',
  DEPTH_ZERO_SELF_SIGNED_CERT: '上游用了自签证书。',
  EPROTO: 'TLS 协议错误：多半是对端只接受 HTTP/2 或握手中断。',
  ECONNREFUSED: '上游拒绝连接：端口没开或被防火墙拦。',
}

function hintFor(code) {
  return code && ERROR_HINTS[code] ? ERROR_HINTS[code] : null
}

/** One line per merged endpoint group. */
function groupLine(g) {
  const statuses = Object.entries(g.statuses).map(([key, count]) => `${key}×${count}`).join(' ')
  const latest = new Date(g.latest.ts).toISOString().slice(11, 19)
  return `- [×${g.count}] ${String(g.method).padEnd(6)} ${statuses} ${g.url}  最新 ${latest}${g.errors ? `  失败 ${g.errors}` : ''}`
}

/**
 * @param {object} rt runtime from lib/runtime.js
 */
export function createToolDefinitions(rt) {
  return [
    {
      name: 'webcap_status',
      description:
        '抓包插件总状态：代理是否运行、端口、CA 是否已装进 Windows 当前用户受信任根、系统代理是否指向本机、已捕获多少 flow、最近几条。开始抓包前先调用一次；"抓不到东西"时也先用它判断是代理没起、CA 没装，还是系统代理没生效。',
      parameters: {},
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`状态读取失败：${value.error || '未知错误'}`)
          const p = value.proxy || {}
          const sp = value.systemProxy || {}
          const ca = value.ca || {}
          const lines = [
            `代理: ${p.running ? `运行中 127.0.0.1:${p.port}` : '未运行'}${p.lastError ? ` | 最近错误: ${p.lastError}` : ''}`,
            `CA: ${ca.installed ? '已安装（当前用户根）' : '未安装'}  文件: ${ca.path || '—'}`,
            `系统代理: ${sp.enabled ? `开启 ${sp.server || ''}` : '关闭'}${sp.supported === false ? '（本平台不支持自动设置）' : ''}`,
            `已捕获: ${value.flows?.total ?? 0} 条${value.flows?.dropped ? `（已丢弃 ${value.flows.dropped} 条）` : ''}  落盘: ${value.flows?.persistFile || (value.flows?.persist ? '本次还没有落盘' : '未开启')}`,
            `连接/隧道: ${p.connections ?? 0}/${p.tunnels ?? 0}`,
            `数据目录: ${value.paths?.dir || '—'}${value.paths?.source === 'ui' ? '（面板选择）' : value.paths?.source === 'config' ? '（配置）' : '（默认）'}`,
            `运行日志: ${value.paths?.log || '—'}`,
          ]
          if (p.portNote) lines.push(`端口说明: ${p.portNote}`)
          if (value.paths?.pending) lines.push(`待生效目录: ${value.paths.pending}（重启 DSH 后启用）`)
          if (value.recent?.length) {
            lines.push('最近失败/未完成:', ...value.recent.map(flowLine))
            const seen = new Set()
            for (const item of value.recent) {
              const hint = hintFor(item.errorCode)
              if (hint && !seen.has(item.errorCode)) {
                seen.add(item.errorCode)
                lines.push(`诊断 ${item.errorCode}: ${hint}`)
              }
            }
          }
          const errors = p.recentErrors || []
          if (errors.length) {
            // Aggregated by endpoint+code: one line per distinct failure, with
            // the repeat count, so background noise is separable from a real one.
            lines.push('上游失败汇总:')
            for (const item of errors.slice(-8)) {
              lines.push(`  - ${item.method} ${item.host}${item.path} ×${item.count}  ${item.message} @${item.phase}`)
            }
            const seen2 = new Set()
            for (const item of errors) {
              const hint = hintFor(item.code)
              if (hint && !seen2.has(item.code)) {
                seen2.add(item.code)
                lines.push(`诊断 ${item.code}: ${hint}`)
              }
            }
          }
          return text(lines.join('\n'))
        },
      },
      execute: async () => {
        const status = await rt.status()
        const recent = rt.store.flows.filter((f) => f.error).slice(-5).map(summaryOf)
        return { ok: true, ...status, recent }
      },
    },

    {
      name: 'webcap_serve',
      description:
        '启停本地 MITM 代理。start 会在 127.0.0.1 上监听（默认 8899；端口被占用或被 Windows 保留时自动换随机端口，并在返回里说明），并把 Windows 系统代理指向它；stop 会恢复原来的系统代理设置。开始抓包 = start，抓完 = stop。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['start', 'stop', 'restart'],
          description: 'start 启动并设置系统代理；stop 停止并恢复系统代理；restart 先停后启。',
        },
        port: { type: 'integer', description: 'start 时使用的端口；省略用配置值（8899），0 表示随机端口。' },
        setSystemProxy: {
          type: 'boolean',
          description: 'start 时是否把系统代理指到本插件；默认 true。只想抓本插件内部流量时设 false。',
        },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`启动/停止失败：${value.error || '未知错误'}`)
          const lines = [`action=${value.action}`, value.port ? `端口: ${value.port}` : '代理: 已停止']
          if (value.warning) lines.push(`注意: ${value.warning}`)
          if (value.systemProxy) lines.push(`系统代理: ${value.systemProxy.enabled ? `开启 ${value.systemProxy.server}` : '关闭'}`)
          return text(lines.join('\n'))
        },
      },
      execute: async (args) => {
        const action = String(args.action)
        try {
          if (action === 'stop') {
            const result = await rt.stop()
            return { ok: true, action, ...result }
          }
          if (action === 'restart') {
            await rt.stop()
          }
          const result = await rt.start({
            port: args.port === undefined ? undefined : Number(args.port),
            systemProxy: args.setSystemProxy !== false,
          })
          const systemProxy = await rt.sysproxy.read().catch(() => null)
          return { ok: true, action, ...result, systemProxy }
        } catch (err) {
          return { ok: false, error: err.message, action }
        }
      },
    },

    {
      name: 'webcap_ca',
      description:
        '管理本插件的根证书：status 报告是否已装进 Windows 当前用户「受信任的根证书颁发机构」；install 用 certutil 装（用户级，不需要管理员）；uninstall 卸载。CA 没装时 HTTPS 页面会直接报证书错误。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'install', 'uninstall'],
          description: 'status / install / uninstall',
        },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`证书操作失败：${value.error || '未知错误'}`)
          const ca = value.ca || {}
          const lines = [`CA 已安装: ${flag(ca.installed)}`]
          if (ca.path) lines.push(`文件: ${ca.path}`)
          if (ca.thumbprint) lines.push(`SHA-1: ${ca.thumbprint}`)
          if (value.output) lines.push(`certutil: ${value.output}`)
          lines.push('提示: 安装后重启浏览器；Firefox 用自己的证书库，需要单独导入同一个 ca.crt。')
          return text(lines.join('\n'))
        },
      },
      execute: async (args) => {
        const action = String(args.action)
        try {
          if (action === 'install') {
            const result = await rt.certstore.install()
            return { ok: true, action, output: result.output, ca: result.status }
          }
          if (action === 'uninstall') {
            const result = await rt.certstore.uninstall()
            return { ok: true, action, output: result.output, ca: result.status }
          }
          const ca = await rt.certstore.status()
          return { ok: true, action, ca }
        } catch (err) {
          return { ok: false, error: err.message, action }
        }
      },
    },

    {
      name: 'webcap_flows',
      description:
        '列出已捕获的请求（新→旧）。可按资源类型、host 片段、方法、状态码、URL 关键词筛选。先用它看眼下有什么；要请求头/响应头/耗时用 webcap_detail，要看报文体用 webcap_body。',
      parameters: {
        type: {
          type: 'string',
          enum: ['all', 'xhr', 'doc', 'css', 'js', 'img', 'media', 'font', 'ws', 'wasm', 'manifest', 'other'],
          description: '资源类型，对应 F12 的 Fetch/XHR、文档、CSS、JS、图片、媒体、字体、WS、Wasm、Manifest、其他；all 或省略为不筛选。',
        },
        host: { type: 'string', description: 'host 片段，如 api.example.com；大小写不敏感。' },
        method: { type: 'string', description: 'HTTP 方法，如 GET / POST。' },
        status: { type: 'integer', description: '精确状态码，如 401。' },
        q: { type: 'string', description: 'URL 关键词（不是体内检索）。' },
        since: { type: 'integer', description: '只返回 seq 大于该值的 flow（配合“我刚点了一下”的时间窗）。' },
        limit: { type: 'integer', description: '返回条数，默认 20，最大 200。' },
        group: { type: 'boolean', description: '按「方法 + URL」合并重复请求：轮询接口只占一行并带次数，默认 false。' },
        normalize: { type: 'boolean', description: '合并时忽略分页/时间戳/nonce 等易变查询参数，默认 false（只合并完全相同的 URL）。' },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`读取失败：${value.error || '未知错误'}`)
          if (value.grouped) {
            if (!value.groups?.length) return text('没有匹配的请求。确认代理在跑、系统代理已开启，并复现一次操作。')
            return text(value.groups.map(groupLine).join('\n'))
          }
          if (!value.flows?.length) return text('没有匹配的请求。确认代理在跑、系统代理已开启，并复现一次操作。')
          return text(value.flows.map(flowLine).join('\n'))
        },
      },
      execute: async (args) => {
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 20))
        const scope = {
          host: args.host,
          method: args.method,
          status: args.status,
          type: args.type,
          q: args.q,
          since: args.since,
        }
        if (args.group === true) {
          const groups = rt.store.listGroups({
            ...scope,
            limit,
            normalize: args.normalize === true,
          })
          return { ok: true, grouped: true, normalized: args.normalize === true, count: groups.length, groups }
        }
        const flows = rt.store.list({ ...scope, limit })
        return { ok: true, count: flows.length, flows }
      },
    },

    {
      name: 'webcap_detail',
      description:
        '取一条 flow 的完整元数据：请求行、请求头、响应头、状态码、耗时、报文体大小与截断标记（不含正文）。需要正文用 webcap_body。',
      parameters: {
        id: { type: 'string', required: true, description: 'flow id，形如 f12。' },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`读取失败：${value.error || '未知错误'}`)
          const f = value.flow
          const headers = (map) => Object.entries(map || {})
            .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('\n')
          const body = (b) => (b ? `  ${b.mime || 'unknown'}  ${b.bytes} 字节${b.truncated ? '（已截断）' : ''}${b.encoding ? ` [${b.encoding} 已解压]` : ''}` : '  —')
          const errorLine = f.error
            ? `错误: ${f.error}${f.errorCode ? `（${f.errorCode}）` : ''}${f.errorPhase ? ` @${f.errorPhase}` : ''}`
            : null
          const hint = f.error ? hintFor(f.errorCode) : null
          return text([
            `${f.method} ${f.url}`,
            `状态: ${f.status ?? '未完成'}${errorLine ? `  ${errorLine}` : ''}  耗时: ${f.durationMs ?? '—'}ms`,
            ...(hint ? [`诊断: ${hint}`] : []),
            `隧道: ${f.tunnel ? `${f.tunnel.host}:${f.tunnel.port}` : '无（明文 HTTP）'}`,
            '',
            '请求头:',
            headers(f.reqHeaders) || '  —',
            '请求体:',
            body(f.reqBody),
            '响应头:',
            headers(f.respHeaders) || '  —',
            '响应体:',
            body(f.respBody),
          ].join('\n'))
        },
      },
      execute: async (args) => {
        const flow = rt.store.get(args.id)
        if (!flow) return { ok: false, error: `找不到 flow ${args.id}` }
        const { reqBody, respBody, ...rest } = flow
        return {
          ok: true,
          flow: {
            ...rest,
            // The panel renders this next to the raw code so a failed row is
            // readable without knowing what ECONNRESET means.
            errorHint: flow.error ? hintFor(flow.errorCode) : null,
            reqBody: reqBody ? { ...reqBody, text: undefined, base64: undefined } : null,
            respBody: respBody ? { ...respBody, text: undefined, base64: undefined } : null,
          },
        }
      },
    },

    {
      name: 'webcap_body',
      description:
        '分页读取某条 flow 的报文体（文本按字符切；二进制给 base64 并把 text 置空）。gzip/br/deflate 会自动解压后再给，响应头里的 content-encoding 保持原样。',
      parameters: {
        id: { type: 'string', required: true, description: 'flow id。' },
        side: { type: 'string', enum: ['request', 'response'], description: '取哪一侧，默认 response。' },
        offset: { type: 'integer', description: '字符偏移，默认 0。' },
        limit: { type: 'integer', description: '返回字符数，默认 4096，最大 65536。' },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`读取失败：${value.error || '未知错误'}`)
          if (!value.body) return text(`${value.side} 侧没有捕获到报文体。`)
          const head = `[${value.side}] ${value.mime || 'unknown'} ${value.totalChars} 字符${value.truncated ? '（捕获时已截断）' : ''}`
          return text(`${head}\n\n${value.text ?? `(base64) ${value.base64 ?? ''}`}`)
        },
      },
      execute: async (args) => {
        const flow = rt.store.get(args.id)
        if (!flow) return { ok: false, error: `找不到 flow ${args.id}` }
        const side = args.side === 'request' ? 'request' : 'response'
        const body = side === 'request' ? flow.reqBody : flow.respBody
        if (!body) return { ok: true, side, body: null, text: '', totalChars: 0 }
        const offset = Math.max(0, Number(args.offset) || 0)
        const limit = Math.min(65536, Math.max(1, Number(args.limit) || 4096))
        if (body.text != null) {
          return {
            ok: true,
            side,
            mime: body.mime,
            truncated: body.truncated,
            totalChars: body.text.length,
            offset,
            text: body.text.slice(offset, offset + limit),
          }
        }
        return {
          ok: true,
          side,
          mime: body.mime,
          truncated: body.truncated,
          totalChars: body.base64?.length ?? 0,
          offset,
          text: null,
          // Binary bodies are exposed as base64 text; offset/limit count base64
          // characters so paging stays lossless.
          base64: (body.base64 || '').slice(offset, offset + limit),
        }
      },
    },

    {
      name: 'webcap_search',
      description:
        '在已捕获的 flow 里检索：URL、请求/响应头、请求/响应报文体。回答"哪个请求带了这个字段/这个 token/这个错误码"。默认 scope=all。',
      parameters: {
        q: { type: 'string', required: true, description: '关键词，大小写不敏感。' },
        scope: {
          type: 'string',
          enum: ['all', 'url', 'body'],
          description: 'all=URL+头+体；url=只搜 URL；body=只搜报文体。',
        },
        limit: { type: 'integer', description: '命中上限，默认 20，最大 100。' },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`检索失败：${value.error || '未知错误'}`)
          if (!value.hits?.length) return text(`没有命中 "${value.q}"。`)
          const lines = [`命中 ${value.hits.length} 条：`]
          for (const hit of value.hits) {
            lines.push(flowLine(hit), `    位置: ${hit.where.join(', ')}`)
            if (hit.snippet) lines.push(`    片段: ${hit.snippet.replace(/\s+/g, ' ').slice(0, 200)}`)
          }
          return text(lines.join('\n'))
        },
      },
      execute: async (args) => {
        const q = String(args.q || '').trim()
        if (!q) return { ok: false, error: 'q 不能为空' }
        const hits = rt.store.search({
          q,
          scope: args.scope || 'all',
          limit: Math.min(100, Math.max(1, Number(args.limit) || 20)),
        })
        return { ok: true, q, count: hits.length, hits }
      },
    },

    {
      name: 'webcap_export',
      description:
        '导出：format=curl 给单条请求的 curl 命令（省略 id 时导出最近 limit 条）；format=har 给 HAR 1.2 文档；format=json 给 flow 摘要数组。产物直接返回，不写磁盘。',
      parameters: {
        format: { type: 'string', required: true, enum: ['curl', 'har', 'json'], description: 'curl / har / json' },
        id: { type: 'string', description: '只导出这一条（curl 必填；省略则导出最近 limit 条）。' },
        limit: { type: 'integer', description: '导出条数，默认 20，最大 500。' },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`导出失败：${value.error || '未知错误'}`)
          if (value.format === 'curl') return text(value.curl || '没有可导出的请求。')
          return text(`已生成 ${value.format.toUpperCase()}，包含 ${value.count} 条 flow（内容见返回的 document 字段）。`)
        },
      },
      execute: async (args) => {
        const format = String(args.format)
        const limit = Math.min(500, Math.max(1, Number(args.limit) || 20))
        if (format === 'curl') {
          if (args.id) {
            const flow = rt.store.get(args.id)
            if (!flow) return { ok: false, error: `找不到 flow ${args.id}` }
            return { ok: true, format, curl: curlOf(flow), count: 1 }
          }
          const flows = rt.store.list({ limit }).map((s) => rt.store.get(s.id))
          return { ok: true, format, curl: flows.map((f) => `# ${f.method} ${f.url}\n${curlOf(f)}`).join('\n\n'), count: flows.length }
        }
        const flows = rt.store.list({ limit }).map((s) => rt.store.get(s.id))
        if (format === 'har') {
          return { ok: true, format, count: flows.length, document: harOf(flows) }
        }
        return { ok: true, format: 'json', count: flows.length, document: flows.map(summaryOf) }
      },
    },

    {
      name: 'webcap_clear',
      description: '清空已捕获的 flow 与失败摘要（保留 CA 与代理设置）。需要 confirm=true，属于破坏性操作。',
      parameters: {
        confirm: { type: 'boolean', required: true, description: '必须显式传 true。' },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => text(value.ok ? `已清空捕获缓冲${value.errorsCleared ? '与失败摘要' : ''}。` : `清空失败：${value.error}`),
      },
      execute: async (args) => {
        if (args.confirm !== true) return { ok: false, error: '需要 confirm=true' }
        const before = rt.store.flows.length
        rt.store.clear()
        // The failure summary lives on the proxy, not in the flow ring, so it has
        // to be dropped here or "清空" would leave a list pointing at no flows.
        let errorsCleared = false
        if (rt.proxy && typeof rt.proxy.clearErrors === 'function') {
          rt.proxy.clearErrors()
          errorsCleared = true
        }
        return { ok: true, cleared: before, errorsCleared }
      },
    },
  ]
}

/**
 * Register every tool; returns the disposer (host `tools.register` returns one).
 */
export function registerTools(ctx, rt) {
  const disposers = []
  const tools = ctx.tools
  if (!tools || typeof tools.register !== 'function') return () => {}
  for (const definition of createToolDefinitions(rt)) {
    const dispose = tools.register(definition)
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }
}
