/**
 * 手机通知 · 宿主半边装配测试
 *
 * 用假 ctx（只实现 on/effect 两个口）验证：
 *   · turn/end completed → 推「已完成」，正文取最近标题，详情取最近回答
 *   · turn/end aborted / interrupted → 推「已中断」
 *   · approval/asked → 推「请决策」
 *   · user-questions/request → 推「请决策」且必须透传 next()（不吞弹窗）
 *   · 子代理会话（origin='subagent' 或 parentSession 存在，双条件）不推
 *   · 无标题时回退最近用户消息，再回退「新会话」
 *   · enabled:false 或无推送地址时不注册任何监听
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

/** 假 ctx：捕获事件监听器。 */
function fakeCtx() {
  const listeners = new Map()
  return {
    listeners,
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {}
    },
  }
}

/** 走一遍会话事件监听器。 */
async function fire(ctx, session, event) {
  for (const fn of ctx.listeners.get('session/event') ?? []) await fn(session, event)
}

/** 走一遍提问瀑布监听器，返回其返回值。 */
async function fireQuestion(ctx, request) {
  let nextCalled = 0
  const next = async () => { nextCalled += 1; return { picked: 'answer' } }
  for (const fn of ctx.listeners.get('user-questions/request') ?? []) {
    const out = await fn(request, next)
    return { out, nextCalled }
  }
  return { out: undefined, nextCalled }
}

/** 收集到的推送。 */
function collector() {
  const pushes = []
  return {
    pushes,
    push: async (url, payload) => { pushes.push({ url, payload }); return { ok: true, msg: 'ok' } },
  }
}

const MAIN = { header: { id: 's-main', parentSession: undefined } }
const CHILD = { header: { id: 's-child', parentSession: 's-main' } }

function se(type, data) {
  return { type, data, seq: 1, time: Date.now() }
}

const ACTIVE_URL = { pushUrl: 'https://27376.push.ft07.com/send/k.send', enabled: true }

test('回答完成：推已完成，正文=会话标题，详情=最近回答剥markdown', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  const events = [
    se('session/title', { title: '查询Server酱通知格式', messageSeqs: [], source: { kind: 'user' } }),
    se('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '**回答**完毕，请查收。' }] } }),
    se('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  for (const e of events) await fire(ctx, MAIN, e)
  assert.equal(c.pushes.length, 1)
  assert.equal(c.pushes[0].payload.title, '【智能体】已完成')
  assert.equal(c.pushes[0].payload.short, '查询Server酱通知格式\n答：回答完毕，请查收。')
  assert.equal(c.pushes[0].payload.desp, '回答完毕，请查收。')
  assert.equal(c.pushes[0].url, 'https://27376.push.ft07.com/send/k.send')
})

test('用户中断：推已中断', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  await fire(ctx, MAIN, se('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '写了一半' }] } }))
  await fire(ctx, MAIN, se('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
  assert.equal(c.pushes.length, 1)
  assert.equal(c.pushes[0].payload.title, '【智能体】已中断')
  assert.equal(c.pushes[0].payload.desp, '写了一半')
})

test('弹窗提问：推请决策，详情取第一个问题，并透传 next()', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  await fire(ctx, MAIN, se('session/title', { title: '需要拍板的会话', messageSeqs: [], source: { kind: 'user' } }))
  const { out, nextCalled } = await fireQuestion(ctx, {
    questions: [{ id: 'q1', question: '方案甲还是方案乙？' }],
    agent: { id: 's-main' },
  })
  assert.equal(nextCalled, 1, '必须调用 next() 透传弹窗')
  assert.deepEqual(out, { picked: 'answer' }, '必须原样返回 next() 的结果')
  assert.equal(c.pushes.length, 1)
  assert.equal(c.pushes[0].payload.title, '【智能体】请决策')
  assert.equal(c.pushes[0].payload.short, '需要拍板的会话\n问：方案甲还是方案乙？')
  assert.equal(c.pushes[0].payload.desp, '方案甲还是方案乙？')
})

test('审批弹窗：推请决策，详情取工具名与理由', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  await fire(ctx, MAIN, se('session/title', { title: '装依赖的会话', messageSeqs: [], source: { kind: 'user' } }))
  await fire(ctx, MAIN, se('approval/asked', { id: 'a1', toolName: 'bash', reason: '需要安装依赖' }))
  assert.equal(c.pushes.length, 1)
  assert.equal(c.pushes[0].payload.title, '【智能体】请决策')
  assert.equal(c.pushes[0].payload.short, '装依赖的会话\n问：bash：需要安装依赖')
})

test('子代理会话完成不推送', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  await fire(ctx, CHILD, se('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(c.pushes.length, 0)
})

test('后台子代理（origin=subagent，无父会话号）完成也不推送', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  const bg = { header: { id: 's-bg-review', parentSession: undefined, origin: 'subagent' } }
  await fire(ctx, bg, se('session/title', { title: '你是后台复盘 agent：分析一段', messageSeqs: [], source: { kind: 'fallback' } }))
  await fire(ctx, bg, se('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '{"action":"nothing"}' }] } }))
  await fire(ctx, bg, se('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(c.pushes.length, 0)
})

test('无标题时回退最近用户消息，再回退「新会话」', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  await fire(ctx, MAIN, se('user/message', { role: 'user', content: [{ type: 'text', text: '帮我查一下这个' }] }))
  await fire(ctx, MAIN, se('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(c.pushes[0].payload.short, '帮我查一下这个')

  const ctx2 = fakeCtx()
  const c2 = collector()
  apply(ctx2, ACTIVE_URL, c2.push)
  await fire(ctx2, MAIN, se('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(c2.pushes[0].payload.short, '新会话')
})

test('中断但没有任何可见回答时详情为空', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  await fire(ctx, MAIN, se('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
  assert.equal(c.pushes.length, 1)
  assert.equal(c.pushes[0].payload.desp, '')
})

test('enabled:false 不注册监听、不推送', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, { ...ACTIVE_URL, enabled: false }, c.push)
  await fire(ctx, MAIN, se('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(c.pushes.length, 0)
  assert.equal(ctx.listeners.size, 0)
})

test('无推送地址不注册监听', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, { ...ACTIVE_URL, pushUrl: '' }, c.push)
  assert.equal(ctx.listeners.size, 0)
  assert.equal(c.pushes.length, 0)
})

test('assistant 消息取 text 块拼接，跳过 reasoning 块', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  await fire(ctx, MAIN, se('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [
    { type: 'reasoning', text: '内心戏' },
    { type: 'text', text: '结论在这' },
  ] } }))
  await fire(ctx, MAIN, se('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(c.pushes[0].payload.desp, '结论在这')
})

test('弹窗监听器内部推送抛异常，仍透传 next() 不吞弹窗', async () => {
  const ctx = fakeCtx()
  const boomPush = async () => { throw new Error('boom') }
  apply(ctx, ACTIVE_URL, boomPush)
  const { out, nextCalled } = await fireQuestion(ctx, { questions: [{ id: 'q1', question: '要继续吗？' }] })
  assert.equal(nextCalled, 1, '推送炸了也必须透传')
  assert.deepEqual(out, { picked: 'answer' })
})

test('会话事件里推送抛异常，不外泄且能继续处理后续事件', async () => {
  const ctx = fakeCtx()
  const c = collector()
  let broken = true
  const flakyPush = async (url, payload) => {
    if (broken) throw new Error('boom')
    c.pushes.push({ url, payload })
    return { ok: true, msg: 'ok' }
  }
  apply(ctx, ACTIVE_URL, flakyPush)
  await assert.doesNotReject(() => fire(ctx, MAIN, se('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })))
  broken = false
  await fire(ctx, MAIN, se('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '恢复了' }] } }))
  await fire(ctx, MAIN, se('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  assert.equal(c.pushes.length, 1, '异常后监听器仍继续工作')
  assert.equal(c.pushes[0].payload.title, '【智能体】已完成')
})

test('两个主会话状态互不污染', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  const A = { header: { id: 's-a', parentSession: undefined } }
  const B = { header: { id: 's-b', parentSession: undefined } }
  await fire(ctx, A, se('session/title', { title: '会话甲', messageSeqs: [], source: { kind: 'user' } }))
  await fire(ctx, A, se('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '甲的回答' }] } }))
  await fire(ctx, B, se('session/title', { title: '会话乙', messageSeqs: [], source: { kind: 'user' } }))
  await fire(ctx, B, se('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await fire(ctx, A, se('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(c.pushes.length, 2)
  assert.equal(c.pushes[0].payload.short, '会话乙')
  assert.equal(c.pushes[0].payload.desp, '') // 乙没有回答，不借甲的
  assert.equal(c.pushes[1].payload.short, '会话甲\n答：甲的回答')
  assert.equal(c.pushes[1].payload.desp, '甲的回答')
})

test('会话销毁后状态清理，不产生跨会话残留', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  await fire(ctx, MAIN, se('session/title', { title: '将销毁', messageSeqs: [], source: { kind: 'user' } }))
  for (const fn of ctx.listeners.get('session/disposed') ?? []) await fn(MAIN)
  await fire(ctx, MAIN, se('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(c.pushes.length, 1)
  assert.equal(c.pushes[0].payload.short, '新会话') // 状态已清，走兜底
})

/** 带日志快照的假会话：模拟「标题/提问早于插件激活」的历史会话。 */
function logSession(id, events) {
  let reads = 0
  return {
    header: { id, parentSession: undefined },
    snapshotEvents() { reads += 1; return events },
    get reads() { return reads },
  }
}

test('状态缺失时从会话日志回放标题与回答（重载/激活前历史自愈）', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  // 历史事件：标题与提问发生在插件激活之前
  const S = logSession('s-old', [
    se('session/title', { title: '历史会话标题', messageSeqs: [], source: { kind: 'llm' } }),
    se('user/message', { role: 'user', content: [{ type: 'text', text: '历史提问' }] }),
    se('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '**历史**回答' }] } }),
  ])
  await fire(ctx, S, se('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  assert.equal(c.pushes.length, 1)
  assert.equal(c.pushes[0].payload.short, '历史会话标题\n答：历史回答')
  assert.equal(c.pushes[0].payload.desp, '历史回答')
})

test('回放一次后写回状态，后续推送不再重复读日志', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  const S = logSession('s-once', [
    se('session/title', { title: '只读一次', messageSeqs: [], source: { kind: 'llm' } }),
  ])
  await fire(ctx, S, se('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await fire(ctx, S, se('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  assert.equal(S.reads, 1, '日志只回放一次')
  assert.equal(c.pushes.length, 2)
  assert.equal(c.pushes[1].payload.short, '只读一次')
})

test('审批弹窗同样从日志回放标题', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  const S = logSession('s-appr', [
    se('session/title', { title: '审批会话', messageSeqs: [], source: { kind: 'llm' } }),
  ])
  await fire(ctx, S, se('approval/asked', { id: 'a1', toolName: 'bash', reason: '装依赖' }))
  assert.equal(c.pushes[0].payload.short, '审批会话\n问：bash：装依赖')
})

test('会话对象没有日志读口时照常兜底，不炸', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  await fire(ctx, MAIN, se('turn/end', { turn: 1, reason: { kind: 'completed' } })) // MAIN 无 snapshotEvents
  assert.equal(c.pushes.length, 1)
  assert.equal(c.pushes[0].payload.short, '新会话')
})

test('回退正文里的 markdown 符号也被过滤', async () => {
  const ctx = fakeCtx()
  const c = collector()
  apply(ctx, ACTIVE_URL, c.push)
  await fire(ctx, MAIN, se('user/message', { role: 'user', content: [{ type: 'text', text: '**问**：这是什么' }] }))
  await fire(ctx, MAIN, se('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(c.pushes[0].payload.short, '问：这是什么')
})
