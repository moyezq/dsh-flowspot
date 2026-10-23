/**
 * dsh-flowspot: 给 agent 用的工具。
 *
 * 定义照宿主的工具形状来：`parameters` 是属性表，必填项写成字段级
 * `required: true`；`output.schema` 用宿主接受的那个受限 JSON Schema 子集。
 * 每个工具都回 JSON，这样面板和模型读到的是同一份事实。
 */

import { renderCode, LANGUAGE_IDS } from './codegen/index.js'
import { langsOf, readPrefs } from './codegen/prefs.js'
import { curlOf, harOf, summaryOf } from './flows.js'

// 所有工具共用的 output 契约：schema 只保证 `ok` 是布尔，其余字段靠
// additionalProperties 放行；每个工具再配一个 render，只把 value 里它关心的
// 那几个字段拼成给人/模型看的文本，不多读也不猜。
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

/**
 * 抓包里真会出现的错误码 → 一句人话解释。`webcap_status` / `webcap_detail`
 * 命中时才多打一行「诊断」，措辞只在这张表里维护一份。
 */
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

/** CDP 通道一行话：状态、浏览器、端口、索引大小。 */
function cdpLine(cdp) {
  if (!cdp) return 'CDP: 未启用'
  if (cdp.connected) {
    const browser = cdp.browser && cdp.browser.name ? cdp.browser.name : '浏览器'
    return `CDP: 已连接 ${browser} :${cdp.port}  目标 ${cdp.targets?.length ?? 0} 个  请求索引 ${cdp.requests ?? 0} 条  脚本 ${cdp.scripts ?? 0} 个`
  }
  if (cdp.connecting) return 'CDP: 连接中…'
  if (cdp.enabled) return `CDP: 未连接${cdp.lastError ? `（${cdp.lastError}）` : ''}${cdp.port ? `  端口 ${cdp.port}` : ''}`
  return 'CDP: 未启用（webcap_cdp launch 启动受控浏览器）'
}

/** 合并后的一组占一行：次数、状态分布、URL、最新时间。 */
function groupLine(g) {
  const statuses = Object.entries(g.statuses).map(([key, count]) => `${key}×${count}`).join(' ')
  const latest = new Date(g.latest.ts).toISOString().slice(11, 19)
  return `- [×${g.count}] ${String(g.method).padEnd(6)} ${statuses} ${g.url}  最新 ${latest}${g.errors ? `  失败 ${g.errors}` : ''}`
}

/**
 * 造出全部工具定义。rt 是 lib/runtime.js 的运行时（存储、代理、证书、数据目录）。
 * @param {object} rt lib/runtime.js 的运行时
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
            cdpLine(value.cdp),
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
            // 按端点+错误码归并：同一个失败只占一行并带次数，
            // 这样后台噪声和真正的故障能分开看。
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
            // 面板会把它显示在原始错误码旁边：不认得 ECONNRESET 也能看懂这条
            // 失败是怎么回事；无错时为 null。
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
          // 二进制体以 base64 文本给出；offset/limit 数的是 base64 字符，
          // 这样分页切在哪都不会切坏一个字节。
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
          // har/json 的正文在 document 字段里，render 只报条数：整份 HAR 塞进
          // 对话既没用又贵，需要时由调用方自己取那个字段。
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
      name: 'webcap_code',
      description:
        '把一条请求转成可运行脚本：cURL / Python / Go / Rust / JavaScript / Node.js，纯本地模板生成，不联网也不执行。`cdp: true` 时 id 是 CDP 抓到的请求 id，生成结果与系统抓包的「代码」页一致。省略 lang 时只返回可用语言与面板里的按钮顺序；要和面板「代码」页看到的一模一样就用同一个 lang。',
      parameters: {
        id: { type: 'string', description: 'flow id，形如 f12（`cdp: true` 时是 CDP 请求 id）；只查语言清单时可以省略。' },
        lang: {
          type: 'string',
          enum: LANGUAGE_IDS,
          description: '目标语言；省略时返回语言清单与顺序。',
        },
        cdp: { type: 'boolean', description: '按 CDP 抓到的请求生成（id 传 CDP 请求 id），与系统抓包共用同一批生成器。' },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`生成失败：${value.error || '未知错误'}`)
          if (value.langs) {
            return text([
              '可用代码语言（面板顺序）：',
              ...value.langs.map((lang) => `- ${lang.id} ${lang.label}${lang.hidden ? '（面板里隐藏）' : ''}  ${lang.note}`),
            ].join('\n'))
          }
          const notes = value.notes?.length ? `\n\n注意：\n${value.notes.map((note) => `- ${note}`).join('\n')}` : ''
          return text(`${value.label} 脚本（${value.lang}）：\n\n${value.code}${notes}`)
        },
      },
      execute: async (args) => {
        // 不带 lang 就是「有哪些语言」这一问：它不需要 id，也不能要求先抓包。
        if (!args.lang) {
          const prefs = readPrefs()
          return { ok: true, langs: langsOf(prefs), order: prefs.order, hidden: prefs.hidden }
        }
        if (!args.id) return { ok: false, error: '缺少 id' }
        let flow
        if (args.cdp) {
          // CDP 抓到的请求没有 proxy flow，拼一个 flow 形状交给同一条生成链。
          try {
            flow = rt.cdp.codeFlowOf(String(args.id))
          } catch (err) {
            return { ok: false, error: err.message }
          }
        } else {
          flow = rt.store.get(String(args.id))
          if (!flow) return { ok: false, error: `找不到 flow ${args.id}` }
        }
        const rendered = renderCode(flow, String(args.lang))
        return {
          ok: true,
          id: flow.id,
          lang: rendered.id,
          label: rendered.label,
          note: rendered.note,
          code: rendered.code,
          notes: rendered.notes,
        }
      },
    },

    {
      name: 'webcap_cdp',
      description:
        'CDP 通道：status 看连接、扩展是否在线与目标；tabs 列浏览器里可接管的网页标签页；takeover 接管一个标签页（不传 tabId 用最近活动的网页）；detach 断开（浏览器不关）；requests 拉标签页请求索引（每条带配到的 flowId 与发起处）；request 按 id 看一条的请求头/POST 体/发起栈；clear 清空标签页请求索引（不碰系统抓包）；也支持 attach 连已有调试端口、launch/close 走旧的受控浏览器路径。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'tabs', 'takeover', 'attach', 'detach', 'pause', 'resume', 'close', 'requests', 'request', 'clear', 'launch'],
          description: 'status / tabs / takeover / attach / detach / pause / resume / close / requests / request / clear',
        },
        tabId: { type: 'integer', description: 'takeover 可选：tabs 返回的标签页 id；不传用最近活动的网页。' },
        id: { type: 'string', description: 'request 必填：requests 返回的 CDP 请求 id。' },
        port: { type: 'integer', description: 'attach 必填：已有调试端口，例如 9222。' },
        since: { type: 'integer', description: 'requests：只返回时间戳（毫秒）大于该值的请求。' },
        limit: { type: 'integer', description: 'requests 条数，默认 50，最大 200。' },
        host: { type: 'string', description: 'requests：URL 子串过滤。' },
        matched: { type: 'boolean', description: 'requests：true 只看已配到 flow 的请求，false 只看未配到的。' },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`CDP 操作失败：${value.error || '未知错误'}`)
          if (Array.isArray(value.tabs)) {
            if (!value.tabs.length) return text('没有可接管的网页标签页。')
            return text(value.tabs.map((tab) => `- ${tab.id}  ${tab.active ? '(当前) ' : ''}${tab.title || ''}  ${tab.url}`).join('\n'))
          }
          if (Array.isArray(value.requests)) {
            if (!value.requests.length) {
              return text('没有浏览器侧请求。确认 CDP 已连接，并在受控浏览器里操作过页面。')
            }
            return text(value.requests.map((item) => {
              const initiator = item.initiator ? `  发起于 ${item.initiator.url || '(inline)'}:${item.initiator.lineNumber ?? '?'}` : ''
              return `- ${item.method} ${item.status ?? '…'} ${item.url}${item.flowId ? `  → ${item.flowId}` : ''}${initiator}`
            }).join('\n'))
          }
          return text(cdpLine(value))
        },
      },
      execute: async (args) => {
        const action = String(args.action)
        try {
          if (action === 'status') {
            await rt.cdp.ensure()
            return { ok: true, ...rt.cdp.status() }
          }
          if (action === 'tabs') {
            const result = await rt.cdp.requestBridge('tabs')
            return { ok: true, tabs: (result && result.tabs) || [] }
          }
          if (action === 'takeover') {
            const params = args.tabId === undefined ? {} : { tabId: args.tabId }
            await rt.cdp.requestBridge(args.tabId === undefined ? 'attach-last' : 'attach-tab', params)
            return { ok: true, ...rt.cdp.status() }
          }
          if (action === 'request') return { ok: true, request: rt.cdp.requestDetail(args.id) }
          if (action === 'clear') {
      // 清空会连磁盘上的 scripts/ 一起删；另一个实例正在抓包时它可能正引用这些源码。
      const other = rt.instanceLock && rt.instanceLock.blockedByOther()
      if (other) {
        return { ok: false, error: `另一个 DSH 实例（pid ${other.pid}${other.port ? `，端口 ${other.port}` : ''}）正在抓包，先停它再清空` }
      }
      return { ok: true, ...rt.cdp.clearRequests() }
    }
          if (action === 'pause') return { ok: true, ...(await rt.cdp.pauseBridge()) }
          if (action === 'resume') return { ok: true, ...(await rt.cdp.resumeBridge()) }
          if (action === 'launch') return { ok: true, ...(await rt.cdp.launch()) }
          if (action === 'attach') return { ok: true, ...(await rt.cdp.attach({ port: args.port })) }
          if (action === 'detach') return { ok: true, ...(await rt.cdp.detach()) }
          if (action === 'close') return { ok: true, ...(await rt.cdp.closeBrowser()) }
          const requests = await rt.cdp.requests({
            since: args.since,
            limit: args.limit,
            host: args.host,
            matched: args.matched,
          })
          return { ok: true, requests }
        } catch (err) {
          return { ok: false, error: err.message }
        }
      },
    },

    {
      name: 'webcap_chain',
      description:
        '一条 flow 的浏览器侧来源：目标标签页、发起调用栈（同步段 + 异步段，函数名 + 文件:行:列）、关键参数（query/body，跨最近几次调用标静态/动态），默认还带最近 3 帧的源码片段。异步段之间用「Continue async（第 N 段）」分隔，业务方法名通常在异步段里。CDP 没连或这条请求不是受控浏览器发出的时 matched=false，但参数分析仍然返回。',
      parameters: {
        id: { type: 'string', required: true, description: 'flow id，形如 f12。' },
        source: { type: 'boolean', description: '是否附带源码片段，默认 true。' },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`读取失败：${value.error || '未知错误'}`)
          const lines = []
          if (value.matched) {
            const target = value.target
              ? `${value.target.title || value.target.url || value.target.targetId}（${value.target.type || 'target'}）`
              : '未知目标'
            lines.push(`目标: ${target}`)
            lines.push(`请求: ${value.request.method} ${value.request.url}${value.request.status ? `  ${value.request.status}` : ''}`)
            if (value.request.documentURL) lines.push(`页面: ${value.request.documentURL}`)
            lines.push('调用链:')
            const frames = (value.initiator && value.initiator.frames) || []
            const names = []
            for (const frame of frames) {
              if (!frame.noise && frame.functionName && frame.functionName !== '(anonymous)' && !names.includes(frame.functionName)) names.push(frame.functionName)
            }
            if (value.initiator && value.initiator.totalFrames) {
              const size = [`${value.initiator.totalFrames} 帧`]
              if (value.initiator.asyncLevels) size.push(`${value.initiator.asyncLevels} 段`)
              if (value.initiator.filteredFrames) size.push(`${value.initiator.filteredFrames} 个壳`)
              lines.push(`  规模: ${size.join(' · ')}`)
            }
            if (names.length) lines.push(`业务方法: ${names.join(' / ')}`)
            if (!frames.length) lines.push('  （浏览器没有给出调用栈，可能是预加载或浏览器内部请求）')
            let level = 0
            for (const [index, frame] of frames.slice(0, 40).entries()) {
              const asyncLevel = frame.asyncLevel || 0
              if (asyncLevel > level) lines.push(`  -- Continue async（第 ${asyncLevel} 段）--`)
              level = asyncLevel
              lines.push(`  ${index + 1}. ${frame.noise ? '[壳] ' : ''}${frame.functionName} @ ${frame.url || '(inline)'}:${frame.lineNumber ?? '?'}:${frame.columnNumber ?? '?'}`)
            }
          } else {
            lines.push('没有配到浏览器侧请求：CDP 未连接，或这条请求不是受控浏览器发出的。')
          }
          if (value.params && value.params.length) {
            lines.push('参数:')
            for (const param of value.params) {
              const tail = param.stability === 'dynamic'
                ? `（动态，最近 ${param.values.length} 个值：${param.values.join(' / ')}）`
                : `（静态，${param.samples} 次采样）`
              lines.push(`  - [${param.where}] ${param.name} = ${param.value}  ${tail}`)
            }
          }
          if (value.sources && value.sources.length) {
            lines.push('源码片段:')
            for (const source of value.sources) {
              lines.push(`  ${source.url || source.scriptKey}:${source.line}`)
              lines.push(source.code)
            }
          }
          return text(lines.join('\n'))
        },
      },
      execute: async (args) => {
        const flow = rt.store.get(String(args.id))
        if (!flow) return { ok: false, error: `找不到 flow ${args.id}` }
        try {
          const chain = await rt.cdp.chain(flow, { store: rt.store, withSource: args.source !== false })
          return { ok: true, ...chain }
        } catch (err) {
          return { ok: false, error: err.message }
        }
      },
    },

    {
      name: 'webcap_script',
      description:
        '浏览器的 Sources：list 列已加载脚本（元数据，可按 URL 过滤），get 读一个脚本的文本（分页），search 在**已落盘**的脚本里搜关键字。key 是 list/search 返回的复合脚本 key。源码在抓取时按调用链涉及的脚本落盘，get/search 只读本地，不再向浏览器要第二份。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'get', 'search'],
          description: 'list / get / search',
        },
        q: { type: 'string', description: 'list 的 URL 过滤词；search 的关键字。' },
        key: { type: 'string', description: 'get 需要的脚本 key。' },
        offset: { type: 'integer', description: 'get 的字符偏移，默认 0。' },
        limit: { type: 'integer', description: 'get 的字符数（默认 8000，最大 65536）；list/search 的条数。' },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`脚本操作失败：${value.error || '未知错误'}`)
          if (Array.isArray(value.scripts)) {
            if (!value.scripts.length) return text('还没有脚本索引：确认 CDP 已连接，并在受控浏览器里打开过页面。')
            return text(value.scripts.map((script) => `- ${script.key}  ${script.label}${script.isModule ? '  [module]' : ''}`).join('\n'))
          }
          if (Array.isArray(value.hits)) {
            if (!value.hits.length) return text('没有命中。')
            return text(value.hits.map((hit) => `- ${hit.label}:${hit.lineNumber}  ${String(hit.lineContent || '').trim().slice(0, 200)}`).join('\n'))
          }
          return text(`${value.label}（共 ${value.totalChars} 字符，从 ${value.offset} 起）：\n\n${value.text}`)
        },
      },
      execute: async (args) => {
        try {
          if (args.action === 'list') {
            return { ok: true, scripts: rt.cdp.scriptList({ q: args.q, limit: args.limit }) }
          }
          if (args.action === 'get') {
            return { ok: true, ...(await rt.cdp.scriptGet({ key: args.key, offset: args.offset, limit: args.limit })) }
          }
          return { ok: true, hits: await rt.cdp.scriptSearch({ q: args.q, limit: args.limit }) }
        } catch (err) {
          return { ok: false, error: err.message }
        }
      },
    },

    {
      name: 'webcap_logs',
      description:
        '读插件运行日志：只记非请求事件（端口兜底、系统代理、CA、数据目录、CDP 启动/连接/断开/重连/目标）。最新在前，可按级别、事件名、时间过滤。排查「抓不到 / 为什么退到随机端口 / 系统代理没恢复 / CDP 断了」先看它；日志目录也可以直接打开。',
      parameters: {
        limit: { type: 'integer', description: '条数，默认 50，最大 500。' },
        level: { type: 'string', enum: ['info', 'warn', 'error'], description: '只保留该级别。' },
        event: { type: 'string', description: '事件名子串，如 capture / cdp / system-proxy / ca。' },
        since: { type: 'integer', description: '只返回时间戳（毫秒）晚于该值的事件。' },
      },
      output: {
        ...OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return text(`读取日志失败：${value.error || '未知错误'}`)
          const lines = [`日志目录: ${value.dir}`, `最近 ${value.count} 条（最新在前）：`]
          for (const entry of value.entries || []) {
            let detail = entry.detail
            if (detail !== null && typeof detail === 'object') {
              try {
                detail = JSON.stringify(detail)
              } catch {
                detail = String(detail)
              }
            }
            const suffix = detail === null || detail === undefined ? '' : `  ${String(detail).slice(0, 300)}`
            lines.push(`- ${entry.ts} ${entry.level} ${entry.event}${suffix}`)
          }
          return text(lines.join('\n'))
        },
      },
      execute: async (args) => {
        try {
          const entries = rt.readLogs({
            limit: args.limit,
            level: args.level || '',
            event: args.event || '',
            since: args.since,
          })
          return { ok: true, dir: rt.logDir, count: entries.length, entries }
        } catch (err) {
          return { ok: false, error: err.message }
        }
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
        // 失败摘要在代理对象上、不在 flow 环形缓冲里，所以必须在这里一起清，
        // 否则「清空」之后摘要列表还指着一批已经不存在的 flow。
        let errorsCleared = false
        if (rt.proxy && typeof rt.proxy.clearErrors === 'function') {
          rt.proxy.clearErrors()
          errorsCleared = true
        }
        // 清空也是「非请求事件」：事后看到列表是空的，先确认是不是有人/agent 清过。
        rt.log?.event?.('info', 'flow-clear', { cleared: before, errorsCleared })
        return { ok: true, cleared: before, errorsCleared }
      },
    },
  ]
}

/**
 * 注册全部工具；返回卸载函数（宿主的 `tools.register` 自己会给一个）。
 * 宿主没提供 tools 服务时退化成空函数，插件仍然要能加载起来。
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
