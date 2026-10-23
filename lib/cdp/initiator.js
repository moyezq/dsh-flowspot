/**
 * 调用链帧的处理：摊平同步段与异步段，标记适配器/框架壳，取列表用的「发起于」帧。
 *
 * 浏览器只在 `initiator.stack.callFrames` 里放**同步段**——XHR 常常只有 3 帧（send 那一层），
 * 真正的业务方法在 `stack.parent` 串起来的**异步段**里。不展开 parent 就只能看到每站都一样
 * 的壳，面板的「业务方法」chips 永远是空的（见 `docs/engineering.md` 第 6 条）。
 *
 * 噪声名单来自之前做 CDP 抓包时的 capture_initiator 脚本：先搜业务函数名，
 * 不去看 xhrAdapter / dispatchRequest / asyncGeneratorStep 这些每站都一样的壳。
 * 过滤只影响展示与 agent 默认输出；原始帧数会随结果一起返回，方便判断是否全被滤掉。
 */

const SKIP_FUNCS = new Set([
  '(anonymous)',
  'step',
  '_next',
  'asyncGeneratorStep',
  'fulfilled',
  'wrap',
  'callWithErrorHandling',
  'callWithAsyncErrorHandling',
  'invokeFunc',
  'leadingEdge',
  'debounced',
  'dispatchXhrRequest',
  'xhrAdapter',
  'xhrByBridgeAdapter',
  'dispatchRequest',
  'request',
  'processSend',
  // 常见框架/运行时外壳；不在这份名单里的业务函数不会被误删。
  'commitHookEffectListMount',
  'flushPassiveEffects',
  'invokeGuardedCallbackDev',
  'invokeGuardedCallback',
  'callCallback',
  'batchedUpdates',
  'unstable_runWithPriority',
  'flushSync',
])

const NOISE_URL = [
  /^chrome-extension:\/\//i,
  /^chrome:\/\//i,
  /^devtools:\/\//i,
  /^extensions::/i,
]

/** 异步段最多展开几层：XHR 实测 5~7 段，再深基本是浏览器的异常链。 */
const MAX_ASYNC_DEPTH = 8

/** @param {{functionName?: string, url?: string}} frame */
export function isNoiseFrame(frame) {
  const name = String((frame && frame.functionName) || '')
  // CDP 给匿名函数的是空字符串，不是字面量 '(anonymous)'；两者都要算壳，否则
  // 「只看业务帧」会留下一排无名帧，业务方法名被盖住。
  if (!name || SKIP_FUNCS.has(name) || name.startsWith('_ace_')) return true
  const url = String((frame && frame.url) || '')
  if (NOISE_URL.some((pattern) => pattern.test(url))) return true
  return false
}

/**
 * 摊平 `Runtime.StackTrace`：先同步段 `callFrames`，再沿 `parent` 逐层续上。
 *
 * `parentId` 形式（要 `Debugger.getStackTrace` 回查）今天 XHR 不用，这里不处理；
 * 真遇上时补一个按 id 取父栈的分支即可。
 * @param {object|null} stack `initiator.stack`
 * @param {number} [maxDepth] 异步段上限
 * @returns {Array<object>} 原始帧 + `asyncLevel`（0 是同步段）与 `anonymous`
 */
export function flattenFrames(stack, maxDepth = MAX_ASYNC_DEPTH) {
  const frames = []
  const seen = new Set()
  let node = stack
  let level = 0
  while (node && level <= maxDepth && !seen.has(node)) {
    seen.add(node)
    for (const frame of Array.isArray(node.callFrames) ? node.callFrames : []) {
      frames.push({ ...frame, asyncLevel: level, anonymous: !String(frame.functionName || '') })
    }
    node = node.parent
    level += 1
  }
  return frames
}

/**
 * 过滤一帧列表；全部是壳时返回空数组（调用方可以据此提示“已过滤 N 帧”）。
 * @param {Array<object>} frames
 */
export function filterFrames(frames) {
  if (!Array.isArray(frames)) return []
  return frames.filter((frame) => !isNoiseFrame(frame))
}

/** 第一个业务帧，用于一句话摘要（列表的「发起于」）。 */
export function topFrame(frames) {
  const kept = filterFrames(frames)
  return kept.length ? kept[0] : null
}
