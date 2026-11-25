/**
 * 手机通知 · 纯函数测试（严格 TDD：先红后绿）
 *
 * 覆盖：全角位宽度、14 全角位截断、markdown 剥离、事件分类、
 *       通知载荷拼装、Server酱3 推送请求形状与响应判定。
 * 用 node 内置 test 运行：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  charSlots,
  truncateSlots,
  stripMarkdown,
  classifyTurnEnd,
  buildNotification,
  pushServerchan,
} from '../lib/notify-core.js'

// ── 宽度 ─────────────────────────────────────────────────────────────────────

test('charSlots：全角汉字计 1', () => {
  assert.equal(charSlots('问'), 1)
  assert.equal(charSlots('手机通知'), 4)
})

test('charSlots：半角字母数字空格计 0.5', () => {
  assert.equal(charSlots('a'), 0.5)
  assert.equal(charSlots('ab12'), 2)
  assert.equal(charSlots(' '), 0.5)
})

test('charSlots：省略号计 1', () => {
  assert.equal(charSlots('…'), 1)
})

// ── 截断 ─────────────────────────────────────────────────────────────────────

test('truncateSlots：不超过 14 全角位原样返回', () => {
  assert.equal(truncateSlots('你好世界', 14), '你好世界')
  assert.equal(truncateSlots('一二三四五六七八九十甲乙丙丁', 14), '一二三四五六七八九十甲乙丙丁')
})

test('truncateSlots：全角超出时保留 13 位再加省略号', () => {
  const fifteen = '一二三四五六七八九十甲乙丙丁戊'
  const out = truncateSlots(fifteen, 14)
  // 13 个全角字 + …（1 位）= 14 位，正好
  assert.equal(out, '一二三四五六七八九十甲乙丙…')
  assert.ok(charSlots(out) <= 14)
})

test('truncateSlots：半角两个算一位，14 位整不截断', () => {
  assert.equal(truncateSlots('abcdefghij', 14), 'abcdefghij') // 10 半角 = 5 位
  const nine = 'abcdefghijklmnopqr' // 18 半角 = 9 位
  assert.equal(truncateSlots(nine, 14), nine)
})

test('truncateSlots：混排按位凑满，不超 14', () => {
  // 'abcdefg' 3.5 位 + '中文' 2 位 = 5.5 位，远小于 14，不截
  const s = 'abcdefg中文'
  assert.equal(truncateSlots(s, 14), s)
  // 25 个半角 a = 12.5 位，再加一个汉字 = 13.5 位，不截
  const m = 'a'.repeat(25) + '汉'
  assert.equal(truncateSlots(m, 14), m)
  // 28 个半角 a = 14 位，整好，不截
  const e = 'a'.repeat(28)
  assert.equal(truncateSlots(e, 14), e)
  // 29 个半角 a = 14.5 位，超：前缀最多 13 位 = 26 个 a，加 …
  assert.equal(truncateSlots('a'.repeat(29), 14), 'a'.repeat(26) + '…')
})

test('truncateSlots：空串安全', () => {
  assert.equal(truncateSlots('', 14), '')
})

// ── markdown 剥离 ────────────────────────────────────────────────────────────

test('stripMarkdown：删除加粗与斜体星号', () => {
  assert.equal(stripMarkdown('**加粗文字**'), '加粗文字')
  assert.equal(stripMarkdown('*斜体文字*'), '斜体文字')
  assert.equal(stripMarkdown('a*b*c'), 'abc')
})

test('stripMarkdown：删除行内代码与删除线、下划线标记', () => {
  assert.equal(stripMarkdown('这是`代码`片段'), '这是代码片段')
  assert.equal(stripMarkdown('~~删除线~~'), '删除线')
  assert.equal(stripMarkdown('_下划线_'), '下划线')
})

test('stripMarkdown：行首标题井号与引用符', () => {
  assert.equal(stripMarkdown('## 标题行'), '标题行')
  assert.equal(stripMarkdown('# 标题行'), '标题行')
  assert.equal(stripMarkdown('> 引用内容'), '引用内容')
})

test('stripMarkdown：链接保留文字', () => {
  assert.equal(stripMarkdown('看[这个链接](https://example.com)就好'), '看这个链接就好')
})

test('stripMarkdown：普通文本原样保留', () => {
  assert.equal(stripMarkdown('普通中文，含标点。123'), '普通中文，含标点。123')
})

test('stripMarkdown：连续换行压成单行空白，便于截断', () => {
  const out = stripMarkdown('第一段\n\n第二段')
  assert.equal(out, '第一段 第二段')
})

test('stripMarkdown：表格剔分隔行、竖线改空格', () => {
  const t = '| 方案 | 优点 |\n| --- | --- |\n| 甲 | 快 |'
  assert.equal(stripMarkdown(t), '方案 优点 甲 快')
})

// ── 事件分类 ─────────────────────────────────────────────────────────────────

test('classifyTurnEnd：completed 归为已完成', () => {
  assert.equal(classifyTurnEnd({ kind: 'completed' }), 'done')
})

test('classifyTurnEnd：aborted 与 interrupted 归为已中断', () => {
  assert.equal(classifyTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }), 'interrupted')
  assert.equal(classifyTurnEnd({ kind: 'interrupted' }), 'interrupted')
})

test('classifyTurnEnd：error、max-tokens、blocked 等不通知', () => {
  assert.equal(classifyTurnEnd({ kind: 'error', error: {} }), null)
  assert.equal(classifyTurnEnd({ kind: 'max-tokens' }), null)
  assert.equal(classifyTurnEnd({ kind: 'blocked' }), null)
  assert.equal(classifyTurnEnd({ kind: 'forked' }), null)
  assert.equal(classifyTurnEnd(undefined), null)
})

// ── 载荷拼装 ─────────────────────────────────────────────────────────────────

test('buildNotification：已完成，标题正文详情三件齐', () => {
  const n = buildNotification({ kind: 'done', sessionTitle: '查询Server酱通知格式', detail: '**回答**完毕' })
  assert.equal(n.title, '【智能体】已完成')
  assert.equal(n.short, '查询Server酱通知格式\n答：回答完毕')
  assert.equal(n.desp, '回答完毕')
})

test('buildNotification：已中断与请决策', () => {
  assert.equal(buildNotification({ kind: 'interrupted', sessionTitle: '长任务', detail: 'x' }).title, '【智能体】已中断')
  assert.equal(buildNotification({ kind: 'decision', sessionTitle: '长任务', detail: '选择哪个？' }).title, '【智能体】请决策')
})

test('buildNotification：请决策的详情行用「问：」前缀', () => {
  const n = buildNotification({ kind: 'decision', sessionTitle: '长任务', detail: '方案甲还是方案乙？' })
  assert.equal(n.title, '【智能体】请决策')
  assert.equal(n.short, '长任务\n问：方案甲还是方案乙？')
})

test('buildNotification：详情为空时正文只有会话标题一行', () => {
  const n = buildNotification({ kind: 'interrupted', sessionTitle: '长任务', detail: '' })
  assert.equal(n.short, '长任务')
})

test('buildNotification：会话标题行 16 全角位，超出截断加省略号', () => {
  const seventeen = '一二三四五六七八九十甲乙丙丁戊己庚'
  const n = buildNotification({ kind: 'done', sessionTitle: seventeen, detail: '短' })
  assert.equal(n.short, '一二三四五六七八九十甲乙丙丁戊…\n答：短')
})

test('buildNotification：会话标题 16 位整不截断，半角折算', () => {
  const sixteen = '一二三四五六七八九十甲乙丙丁戊己'
  assert.equal(buildNotification({ kind: 'done', sessionTitle: sixteen, detail: '' }).short, sixteen)
  // 24 个半角 a = 12 位 + 4 个全角字 = 16 位整，不截
  const mixed = 'a'.repeat(24) + '甲乙丙丁'
  assert.equal(buildNotification({ kind: 'done', sessionTitle: mixed, detail: '' }).short, mixed)
})

test('buildNotification：回答行内容超 14 全角位截断、前缀不占预算、先剥markdown', () => {
  const n = buildNotification({ kind: 'done', sessionTitle: 't', detail: '一二三四五六七八九十甲乙丙丁**戊**' })
  assert.equal(n.short, 't\n答：一二三四五六七八九十甲乙丙…')
  assert.equal(n.desp, '一二三四五六七八九十甲乙丙…')
})

test('buildNotification：无标题回退新会话', () => {
  const n = buildNotification({ kind: 'done', sessionTitle: '', detail: 'd' })
  assert.equal(n.short, '新会话\n答：d')
})

// ── 推送 ─────────────────────────────────────────────────────────────────────

test('pushServerchan：POST JSON 含 title/desp/short，code 0 判成功', async () => {
  const calls = []
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts })
    return { status: 200, json: async () => ({ code: 0, message: 'ok' }) }
  }
  const r = await pushServerchan('https://27376.push.ft07.com/send/k.send', { title: 'T', desp: 'D', short: 'S' }, fakeFetch)
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://27376.push.ft07.com/send/k.send')
  assert.equal(calls[0].opts.method, 'POST')
  const body = JSON.parse(calls[0].opts.body)
  assert.deepEqual(body, { title: 'T', desp: 'D', short: 'S' })
  assert.equal(calls[0].opts.headers['content-type'], 'application/json')
})

test('pushServerchan：code 非 0 判失败并带回 message', async () => {
  const fakeFetch = async () => ({ status: 200, json: async () => ({ code: 40010, message: '额度用尽' }) })
  const r = await pushServerchan('https://x/send/k.send', { title: 'T', desp: 'D' }, fakeFetch)
  assert.equal(r.ok, false)
  assert.match(r.msg, /额度用尽/)
})

test('pushServerchan：网络异常不抛出，返回 ok:false', async () => {
  const fakeFetch = async () => { throw new Error('ECONNREFUSED') }
  const r = await pushServerchan('https://x/send/k.send', { title: 'T', desp: 'D' }, fakeFetch)
  assert.equal(r.ok, false)
  assert.match(r.msg, /ECONNREFUSED/)
})

test('pushServerchan：非 JSON 响应按 HTTP 状态判定', async () => {
  const fakeFetch = async () => ({ status: 200, json: async () => { throw new Error('not json') } })
  const r = await pushServerchan('https://x/send/k.send', { title: 'T', desp: 'D' }, fakeFetch)
  assert.equal(r.ok, true)
})
