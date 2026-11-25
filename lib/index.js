/**
 * 手机通知（宿主半边）
 *
 * 在本智能体回答完成、被中断、弹窗需做决策时，经 Server酱3 推送到手机。
 * 只做观察者：读事件、发推送，绝不拦截、改写或阻断任何宿主行为。
 *
 * 监听（事件契约对安装版源码核实，见 lib/notify-core.js 头注）：
 *   · session/event          会话事件流：turn/end / approval/asked / 标题与消息跟踪
 *   · user-questions/request 提问弹窗瀑布：观察后必须原样透传 next()
 *
 * 只推主会话（origin==='subagent' 或 parentSession 存在的都按子代理会话处理，
 * 不推——权威判定字段是 origin，仅凭 parentSession 会漏掉后台复盘这类
 * 「无父会话号的子代理」），避免后台代理跑批时把手机响个不停。
 */

import {
  classifyTurnEnd,
  buildNotification,
  textOfMessage,
  pushServerchan,
  truncateSlots,
  stripMarkdown,
} from './notify-core.js'

/** 插件配置默认值（可在插件行的 config: 里覆盖）。 */
export const DEFAULTS = {
  /** Server酱3 完整 send 端点（含 sendkey）。 */
  pushUrl: '',
  /** 总开关。 */
  enabled: true,
}

function resolveConfig(config) {
  const raw = config || {}
  return {
    pushUrl: typeof raw.pushUrl === 'string' ? raw.pushUrl.trim() : DEFAULTS.pushUrl,
    enabled: raw.enabled !== false,
  }
}

/** 提取会话事件的数据体（事件信封 { type, seq, time, data }）。 */
function dataOf(event) {
  return event?.data ?? {}
}

/**
 * 插件装配入口。
 * @param ctx     Cordis 上下文（宿主组装挂载点）
 * @param config  插件行 config
 * @param pushImpl 注入的推送函数（测试可替换；默认 pushServerchan 绑定首个参数前的形态）
 * @returns 清理函数
 */
export function apply(ctx, config, pushImpl) {
  const cfg = resolveConfig(config)
  const push = pushImpl ?? ((url, payload) => pushServerchan(url, payload))
  // 没开启或没配地址：一个监听都不注册，保持零影响。
  if (!cfg.enabled || !cfg.pushUrl) return undefined

  /** 每个会话跟踪：最新标题 / 最近用户消息文本 / 最近回答文本。 */
  const state = new Map()
  const stateOf = (id) => {
    let s = state.get(id)
    if (s === undefined) {
      s = { title: '', userText: '', answerText: '' }
      state.set(id, s)
    }
    return s
  }
  /** 跟踪值只服务通知兜底：剥 markdown、存前截断，避免长回答常驻内存。 */
  const STORED_MAX = 60
  const storeText = (text) => truncateSlots(stripMarkdown(text), STORED_MAX)

  /**
   * 从会话日志回放补齐跟踪状态。
   * 归属原因：标题等一次性事件可能发生在插件激活/热重载之前，进程内状态永远收不到，
   * 会话日志才是事实源——推送前发现缺失就读一次日志自愈（重载、重启后第一次推送触发）。
   * snapshotEvents 是 Session 公开读口（官方对仓库内部新代码停用，是给持续订阅场景留的纪律；
   * 第三方插件按需读一次日志没有别的公开替代，投影机制是为持续订阅设计的，过重）。
   */
  const replayFromLog = (session, s) => {
    const snapshot = session.snapshotEvents?.()
    if (!Array.isArray(snapshot)) return
    for (const e of snapshot) {
      const d = e?.data ?? {}
      if (e?.type === 'session/title') {
        if (typeof d.title === 'string' && d.title.trim().length > 0) s.title = d.title
      } else if (e?.type === 'user/message') {
        const t = storeText(textOfMessage(d))
        if (t.length > 0) s.userText = t
      } else if (e?.type === 'assistant/message') {
        const t = storeText(textOfMessage(d.message ?? d))
        if (t.length > 0) s.answerText = t
      }
    }
  }

  /** 发一条（后台执行，失败只留日志，绝不打断宿主事件流）。 */
  const notify = (kind, session, detail) => {
    let s
    if (session?.header?.id !== undefined) {
      s = stateOf(session.header.id)
      if (s.replayed !== true) {
        s.replayed = true // 回放是一次性自愈：做过标记，之后靠活事件增量更新
        try {
          replayFromLog(session, s)
        } catch (error) {
          ctx.logger?.warn?.(`手机通知日志回放异常：${String(error?.message || error)}`)
        }
      }
    }
    const payload = buildNotification({
      kind,
      sessionTitle: s?.title || s?.userText || '',
      detail: detail ?? s?.answerText ?? '',
    })
    Promise.resolve(push(cfg.pushUrl, payload)).then((r) => {
      if (r && r.ok === false) ctx.logger?.warn?.(`手机通知推送失败：${r.msg}`)
    }).catch((error) => {
      ctx.logger?.warn?.(`手机通知推送异常：${String(error?.message || error)}`)
    })
  }

  const offSession = ctx.on('session/event', (session, event) => {
    try {
      // 子代理会话不打扰。判定双条件：origin==='subagent' 是 DSH 权威字段（后台复盘
      // 这类孩子只有它），parentSession 存在同样按孩子处理（宁可少推，不误推）。
      if (session?.header?.origin === 'subagent' || session?.header?.parentSession !== undefined) return
      const s = stateOf(session.header.id)
      switch (event?.type) {
        case 'session/title':
          s.title = String(dataOf(event).title ?? s.title)
          return
        case 'user/message': {
          const text = storeText(textOfMessage(dataOf(event)))
          if (text.length > 0) s.userText = text
          return
        }
        case 'assistant/message':
          s.answerText = storeText(textOfMessage(dataOf(event).message ?? dataOf(event)))
          return
        case 'turn/end': {
          const kind = classifyTurnEnd(dataOf(event).reason)
          if (kind !== null) notify(kind, session)
          return
        }
        case 'approval/asked': {
          const d = dataOf(event)
          const reason = typeof d.reason === 'string' && d.reason.trim().length > 0 ? `：${d.reason.trim()}` : ''
          notify('decision', session, `${d.toolName ?? '工具'}${reason}`)
          return
        }
        default:
          return
      }
    } catch (error) {
      ctx.logger?.warn?.(`手机通知事件处理异常：${String(error?.message || error)}`)
    }
  })

  const offQuestions = ctx.on('user-questions/request', (request, next) => {
    try {
      const question = request?.questions?.[0]?.question
      const text = typeof question === 'string' && question.trim().length > 0 ? question.trim() : '有弹窗等待处理'
      // 弹窗请求带发出它的 agent；Agent.id 即会话 id，借它找到跟踪的标题当正文。
      const sessionId = request?.agent?.id
      notify('decision', sessionId === undefined ? null : { header: { id: sessionId } }, text)
    } catch (error) {
      ctx.logger?.warn?.(`手机通知弹窗处理异常：${String(error?.message || error)}`)
    }
    return next() // 观察者必须透传，否则会吞掉弹窗
  })

  // 会话销毁时清掉跟踪状态，防止长期运行的宿主随会话数积累内存。
  const offDisposed = ctx.on('session/disposed', (session) => {
    try {
      if (session?.header?.id !== undefined) state.delete(session.header.id)
    } catch (error) {
      ctx.logger?.warn?.(`手机通知销毁清理异常：${String(error?.message || error)}`)
    }
  })

  return () => {
    offSession?.()
    offQuestions?.()
    offDisposed?.()
  }
}

export const __internal = { resolveConfig }
