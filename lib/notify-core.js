/**
 * 手机通知 · 纯函数层
 *
 * 职责：全角位宽度与截断、markdown 剥离、事件分类、通知载荷拼装、Server酱3 推送。
 * 不依赖任何宿主 API，可独立测试。
 *
 * 事件契约（均已对 2026-11 安装版源码核实）：
 *   · turn/end           { turn, reason: { kind: 'completed'|'aborted'|'interrupted'|… } }
 *   · approval/asked     { id, toolName, callId?, reason? }
 *   · user-questions/request（waterfall）{ questions: [{ id, question, … }], … }
 *   · session/title      { title, messageSeqs, source }
 *   · assistant/message  { turn, step, message: { content: ContentBlock[] }, … }
 */

/** Server酱3 接口返回 { code: number, message: string }，0 为成功（官方 SDK 契约）。 */
const OK_CODE = 0

/** 单次推送超时毫秒数。 */
export const PUSH_TIMEOUT_MS = 8000

// ── 全角位宽度 ───────────────────────────────────────────────────────────────

/** 是否按全角位计 1 的字符（中日韩、全角标点、省略号）；其余计 0.5。 */
export function isFullWidthChar(ch) {
  const code = ch.codePointAt(0)
  if (code === undefined) return false
  return (
    (code >= 0x1100 && code <= 0x115f) // 谚文字母
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) // 中日韩部首至 Yi 音节
    || (code >= 0xa960 && code <= 0xa97f) // 谚文字母扩展
    || (code >= 0xac00 && code <= 0xd7a3) // 谚文音节
    || (code >= 0xf900 && code <= 0xfaff) // 兼容表意
    || (code >= 0xfe10 && code <= 0xfe19) // 竖排形式
    || (code >= 0xfe30 && code <= 0xfe6f) // 兼容半角变体
    || (code >= 0xff00 && code <= 0xff60) // 全角形式
    || (code >= 0xffe0 && code <= 0xffe6) // 全角补充
    || (code >= 0x20000 && code <= 0x3fffd) // 扩展表意
    || code === 0x2026 // 省略号按全角位计
  )
}

/** 文本的显示位宽：全角计 1、半角计 0.5。 */
export function charSlots(text) {
  let slots = 0
  for (const ch of String(text)) slots += isFullWidthChar(ch) ? 1 : 0.5
  return slots
}

/**
 * 按显示位宽截断：超过 maxSlots 时保留能放下「…」（计 1 位）的最长前缀。
 * 例：15 个全角字、上限 14 → 前 13 字 + …（合计 14 位）。
 */
export function truncateSlots(text, maxSlots = 14) {
  const s = String(text ?? '')
  if (charSlots(s) <= maxSlots) return s
  let slots = 0
  let cut = -1
  let index = 0
  for (const ch of s) {
    const w = isFullWidthChar(ch) ? 1 : 0.5
    if (slots + w > maxSlots - 1) { // 要给省略号留 1 位
      cut = index
      break
    }
    slots += w
    index += ch.length // 用码元位置切，避免劈开代理对
  }
  return cut >= 0 ? s.slice(0, cut) + '…' : s
}

// ── markdown 剥离 ────────────────────────────────────────────────────────────

/**
 * 过滤 markdown 相关符号（用户 2026-11-14 定稿：删除全部星号，并扩到常见标记）：
 * 加粗/斜体星号、行内代码反引号、删除线波浪号、下划线斜体、
 * 行首标题井号、行首引用符；链接 [文字](地址) 保留文字；
 * 表格剔除 | --- | 分隔行、竖线改空格。
 * 连续空白压成一个空格，方便通知里截断阅读。
 */
export function stripMarkdown(text) {
  let s = String(text ?? '')
  // 表格：先按行处理——整行只由竖线/冒号/连字符/空格构成且含 --- 的分隔行剔除，其余行竖线改空格。
  s = s
    .split('\n')
    .filter((line) => !(/^[\s|:-]+$/.test(line) && /-{3,}/.test(line)))
    .map((line) => line.replace(/\|/g, ' '))
    .join('\n')
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接与图片保留文字
  s = s.replace(/[*`~_]/g, '') // 强调/代码/删除线/斜体标记字符
  s = s.replace(/^#{1,6}\s+/gm, '') // 行首标题
  s = s.replace(/^\s*>\s?/gm, '') // 行首引用
  s = s.replace(/\s+/g, ' ') // 任意空白（含换行、表格竖线留下的多空格）压成一个空格
  return s.trim()
}

// ── 事件分类 ─────────────────────────────────────────────────────────────────

/**
 * turn/end 的 reason 分类：completed → done；aborted / interrupted → interrupted；
 * 其余（error、max-tokens、blocked、forked 等）不通知，返回 null。
 */
export function classifyTurnEnd(reason) {
  const kind = reason?.kind
  if (kind === 'completed') return 'done'
  if (kind === 'aborted' || kind === 'interrupted') return 'interrupted'
  return null
}

// ── 载荷拼装 ─────────────────────────────────────────────────────────────────

const KIND_TITLE = Object.freeze({ done: '已完成', interrupted: '已中断', decision: '请决策' })

/** 详情行前缀：完成/中断是回答（答：），请决策是要用户拍板的问题（问：）。 */
const KIND_PREFIX = Object.freeze({ done: '答：', interrupted: '答：', decision: '问：' })

/**
 * 拼装 Server酱3 通知载荷。
 * 标题：【智能体】+ 事件词；正文 short：会话标题一行（16 全角位，用户 2026-11-26 定）
 * + 详情一行（前缀「答：」/「问：」，内容剥 markdown 后截 14 全角位、前缀不占预算；
 * 详情为空时只有标题一行）——Server酱³ 的通知栏只显示标题与 short，desp 只进 APP 内详情页，
 * 所以回答要进通知栏必须并入 short。
 * 详情 desp：与 short 详情行同文，供点开 APP 后查看。无标题回退「新会话」。
 */
export function buildNotification({ kind, sessionTitle, detail }) {
  const word = KIND_TITLE[kind] ?? '已完成'
  const title = String(sessionTitle ?? '').trim()
  const body = truncateSlots(stripMarkdown(detail), 14)
  const short = truncateSlots(title.length > 0 ? title : '新会话', 16)
  return {
    title: `【智能体】${word}`,
    short: body.length > 0 ? `${short}\n${KIND_PREFIX[kind] ?? '答：'}${body}` : short,
    desp: body,
  }
}

/** 从消息 content 块里取可见文本（跳过 reasoning / 工具等块）。 */
export function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

// ── 推送 ─────────────────────────────────────────────────────────────────────

/**
 * 推一条 Server酱3 消息。绝不抛出——任何异常都折成 { ok:false, msg }。
 * @param url      完整 send 端点（含 sendkey，来自插件配置）
 * @param payload  { title, desp, short? }
 * @param fetchImpl 注入的 fetch（默认全局），测试可替换
 */
export async function pushServerchan(url, payload, fetchImpl = globalThis.fetch) {
  if (!url) return { ok: false, msg: '未配置推送地址' }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: payload.title, desp: payload.desp, short: payload.short }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
    let body = null
    try { body = await res.json() } catch { body = null }
    if (body && typeof body === 'object' && 'code' in body) {
      return body.code === OK_CODE
        ? { ok: true, msg: `已推送（${payload.title}）` }
        : { ok: false, msg: `Server酱返回 ${body.code}：${body.message ?? ''}` }
    }
    return res.status >= 200 && res.status < 300
      ? { ok: true, msg: `已推送（${payload.title}）` }
      : { ok: false, msg: `HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, msg: String(error?.message || error) }
  }
}
