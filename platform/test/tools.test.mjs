// 插件工具 → MCP（tools.mjs + tool-runtime.mjs）：列表、mcp 权限经手机询问、沙盒子进程跑 preload、数据双向同步
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createPlatform } from '../index.mjs'
import { mcpName } from '../tools.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr-tools-'))
const made = []
function makePlatform(pluginsDir = path.join(REPO, 'plugins')) {
  const dataDir = tmp()
  const pushed = [], incidents = []
  const pf = createPlatform({ dataDir, pluginsDir, WebSocketServer, notify: async (p) => { pushed.push(p); return { sent: 1 } }, recordIncident: (r) => { incidents.push(r); return { id: 'abcdefabcdef' } }, log: () => {} })
  made.push(pf)
  return { pf, pushed, incidents, dataDir }
}
after(() => { for (const pf of made) pf.flush() })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/** 等手机上出现权限卡片并回答 */
async function answerNextAsk(pf, answer) {
  for (let i = 0; i < 100; i++) { const [a] = pf._asks.list(); if (a) { if (answer != null) pf.answerAsk(a.id, answer); return a } await wait(20) }
  throw new Error('没有等到询问')
}
const caller = { agent: 'claude', pane: 3, cwd: '/work/app', session: 'sess-aaaa-1111' }

test('列表：只列描述文件里声明、有 preload 的工具，名字带插件前缀', () => {
  const { pf } = makePlatform()
  const tools = pf.agentTools.list().filter((t) => t.plugin === 'todo')
  assert.deepEqual(tools.map((t) => t.name).sort(), ['plugin_todo_add', 'plugin_todo_comment', 'plugin_todo_done', 'plugin_todo_get', 'plugin_todo_list', 'plugin_todo_remove', 'plugin_todo_start', 'plugin_todo_update'])
  assert.match(tools[0].description, /^\[pane-remote 插件「待办」\]/)
  assert.equal(tools.find((t) => t.tool === 'add').inputSchema.required[0], 'title')
  assert.equal(pf.agentTools.list().some((t) => t.plugin === 'hello'), false, 'hello 没有声明工具')
  assert.equal(mcpName('a.b-c', 'x'), 'plugin_a_b-c_x')
})

test('调用：第一次在手机上问 mcp 权限，始终允许后不再问；调用方记进待办；数据落盘', async () => {
  const { pf, pushed, dataDir } = makePlatform()
  const p = pf.agentTools.call({ name: 'plugin_todo_add', args: { title: '回头补测试', priority: 'high', tags: ['test'] }, caller })
  const a = await answerNextAsk(pf, '始终允许')
  assert.match(a.question, /待办.*claude · #3 · app.*add/)
  assert.equal(pushed.length, 1, '手机没在看：推送')
  const r = await p
  assert.equal(r.value.added.title, '回头补测试')
  assert.deepEqual(r.value.added.source, { by: 'agent', agent: 'claude', pane: 3, cwd: '/work/app', session: 'sess-aaaa-1111' })
  assert.equal(r.value.added.project, '/work/app')
  const l = await pf.agentTools.call({ name: 'plugin_todo_list', args: { project: 'current' }, caller })
  assert.equal(pf._asks.list().length, 0, '记住了，不再问')
  assert.equal(l.value.total, 1)
  const d = await pf.agentTools.call({ name: 'plugin_todo_done', args: { id: r.value.added.id, note: '补好了' }, caller })
  assert.equal(d.value.updated.status, 'done')
  assert.equal((await pf.agentTools.call({ name: 'plugin_todo_list', args: {}, caller })).value.total, 0)
  pf.flush()
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'plugins/db/todo/db.json'), 'utf8'))
  const doc = Object.values(saved.docs).find((x) => x.title === '回头补测试')
  assert.equal(doc.status, 'done')
  assert.match(doc.note, /补好了/)
  assert.ok(pf._audit.list('todo').some((x) => x.method === 'mcp.add' && x.result === 'ok'))
})

test('Herdr caller identity survives permission prompts, runtime and stored plugin data', async () => {
  const { pf } = makePlatform()
  const nativeCaller = { ...caller, pane: 'wA:pB' }
  const pending = pf.agentTools.call({ name: 'plugin_todo_add', args: { title: 'Native pane task' }, caller: nativeCaller })
  assert.match((await answerNextAsk(pf, '始终允许')).question, /#wA:pB/)
  assert.equal((await pending).value.added.source.pane, 'wA:pB')
  const invalid = await pf.agentTools.call({ name: 'plugin_todo_add', args: { title: 'Invalid pane task' }, caller: { ...caller, pane: 'wA:pB;bad' } })
  assert.equal(invalid.value.added.source.pane, null)
  pf.flush()
})

test('权限：禁止后这个插件的工具从列表里消失，调用被拒', async () => {
  const { pf } = makePlatform()
  const p = pf.agentTools.call({ name: 'plugin_todo_list', args: {}, caller })
  await answerNextAsk(pf, '禁止')
  await assert.rejects(p, (e) => e.code === 'EWTPERM')
  assert.equal(pf.agentTools.list().some((t) => t.plugin === 'todo'), false)
  await assert.rejects(pf.agentTools.call({ name: 'plugin_todo_list', args: {}, caller }), (e) => e.code === 'ENOTOOL')
})

test('权限：没回答不算禁止，工具还在列表里，下次调用再问；连续 3 次没答才转为禁止', async () => {
  const { pf } = makePlatform()
  const m = pf._catalog.get('todo')
  for (let i = 1; i <= 3; i++) {
    const p = pf.agentTools.call({ name: 'plugin_todo_list', args: {}, caller })
    const a = await answerNextAsk(pf, null)
    pf._asks.cancel(a.id)
    await assert.rejects(p, (e) => e.code === 'EWTPERM')
    assert.equal(pf.agentTools.list().some((t) => t.plugin === 'todo'), i < 3, `第 ${i} 次没答`)
  }
  assert.equal(pf._perms.blocked(m, 'mcp'), true)
})

test('同步：手机插件页写的，工具运行时马上看得到；工具写的推给连着的手机', async () => {
  const { pf } = makePlatform()
  pf._perms.set(pf._catalog.get('todo'), 'mcp', 'grant')
  await pf.agentTools.call({ name: 'plugin_todo_list', args: {}, caller }) // 先把运行时起来
  const sent = []
  // 假装一个手机连接（平台对每个 client 排队发送）
  const ctx = { client: 'phone1', test: false, visible: () => true, prompt: async () => 'once' }
  await pf._rpc.call(ctx, 'todo', 'db.push', { docs: [{ _id: 'todo/x1', _rev: '1-a', title: '手机上记的', status: 'open', priority: 'normal', tags: [], created: 1, updated: 1 }] })
  await wait(50)
  const l = await pf.agentTools.call({ name: 'plugin_todo_list', args: { project: 'all' }, caller })
  assert.ok(l.value.items.some((i) => i.title === '手机上记的'))
  const pull = await pf._rpc.call(ctx, 'todo', 'db.pull', {})
  assert.ok(pull.docs.some((d) => d._id === 'todo/x1'))
  void sent
})

test('沙盒：preload 读不了文件、拿不到 require 和服务端的环境变量；出错报成问题', async () => {
  const dir = tmp()
  const pd = path.join(dir, 'evil')
  fs.mkdirSync(pd)
  fs.writeFileSync(path.join(pd, 'plugin.json'), JSON.stringify({ pluginName: 'Evil', main: 'index.html', logo: 'l.svg', preload: 'preload.js', features: [{ code: 'e', cmds: ['e'] }], tools: { probe: { description: 'p', inputSchema: { type: 'object' } }, boom: { description: 'b', inputSchema: { type: 'object' } } } }))
  fs.writeFileSync(path.join(pd, 'index.html'), '<p>x</p>')
  fs.writeFileSync(path.join(pd, 'preload.js'), `
    utools.registerTool('probe', async () => {
      const out = {}
      try { require('fs') } catch (e) { out.require = e.code }
      try { const p = this.constructor.constructor('return process')(); out.env = Object.keys(p.env)
        try { p.getBuiltinModule('fs').readFileSync('/etc/hosts'); out.fs = 'READ' } catch (e) { out.fs = e.code }
        try { p.getBuiltinModule('child_process').execSync('id'); out.cp = 'RAN' } catch (e) { out.cp = e.code }
      } catch (e) { out.escape = e.message }
      return out
    })
    utools.registerTool('boom', () => { throw new Error('故意的') })
  `)
  const { pf } = makePlatform(dir)
  pf._perms.set(pf._catalog.get('evil'), 'mcp', 'grant')
  const r = (await pf.agentTools.call({ name: 'plugin_evil_probe', args: {}, caller })).value
  assert.equal(r.require, 'EWTUNSUPPORTED')
  if (r.env !== undefined) { // vm 逃逸出去也只是这个受限的子进程
    assert.deepEqual(r.env.filter((k) => !k.startsWith('NODE_CHANNEL_') && k !== '__CF_USER_TEXT_ENCODING'), [], '只有 Node 自己的 IPC 变量')
    assert.equal(r.fs, 'ERR_ACCESS_DENIED')
    assert.equal(r.cp, 'ERR_ACCESS_DENIED')
  }
  await assert.rejects(pf.agentTools.call({ name: 'plugin_evil_boom', args: {}, caller }), /故意的/)
})

test('platform.sessions：列出、按会话 id 找到 pane 发送、留言取一次就没了；要权限', async () => {
  const sent = []
  const sessions = {
    list: async () => [{ pane: 7, agent: 'claude', session: 'sess-bbbb-2222', cwd: '/w/app', title: 't', status: 'idle', startedAt: 1 }],
    send: async (pane, text) => { sent.push([pane, text]) },
  }
  const dataDir = tmp()
  const pf = createPlatform({ dataDir, pluginsDir: path.join(REPO, 'plugins'), WebSocketServer, notify: async () => ({}), recordIncident: () => ({}), sessions, log: () => {} })
  made.push(pf)
  const asked = []
  const ctx = { client: 'p1', test: false, visible: () => true, prompt: async (r) => { asked.push(r.permission); return 'always' } }
  assert.equal((await pf._rpc.call(ctx, 'todo', 'platform.sessions.list', {}))[0].pane, 7)
  assert.deepEqual(asked, ['platform.sessions'])
  const r = await pf._rpc.call(ctx, 'todo', 'platform.sessions.send', { session: 'sess-bbbb-2222', text: '[待办 x] 去做' })
  assert.deepEqual([r.pane, sent[0]], [7, [7, '[待办 x] 去做']])
  await assert.rejects(pf._rpc.call(ctx, 'todo', 'platform.sessions.send', { session: 'sess-gone-0000', text: 'x' }), (e) => e.code === 'ENOSESSION')
  await pf._rpc.call(ctx, 'todo', 'platform.sessions.note', { session: 'sess-bbbb-2222', text: '用户把 x 勾掉了' })
  const notes = pf.takeSessionNotes('sess-bbbb-2222')
  assert.deepEqual(notes.map((n) => [n.plugin, n.name, n.text]), [['todo', '待办', '用户把 x 勾掉了']])
  assert.deepEqual(pf.takeSessionNotes('sess-bbbb-2222'), [], '取走就没了')
  pf.flush()
  assert.ok(fs.existsSync(path.join(dataDir, 'plugins/session-notes.json')), '留言存盘（服务端重启不丢）')
})

test('定时任务：request 存下来，触发时在工具运行时里调 onScheduleTrigger；待办过期提醒推送，全局关掉 / 单条静音都生效', async () => {
  const { pf, pushed, dataDir } = makePlatform()
  const m = pf._catalog.get('todo')
  for (const p of ['schedule', 'notification', 'storage']) pf._perms.set(m, p, 'grant')
  const ctx = { client: 'p1', test: false, visible: () => false, prompt: async () => 'dismiss' }
  const list = await pf._rpc.call(ctx, 'todo', 'schedule.request', { code: 'overdue-reminder', label: '待办过期提醒', trigger: { cron: '0 9 * * *' } })
  assert.deepEqual(list.map((t) => [t.code, t.trigger.cron]), [['overdue-reminder', '0 9 * * *']])
  await assert.rejects(pf._rpc.call(ctx, 'todo', 'schedule.request', { code: 'x', label: 'x', trigger: { cron: 'bad' } }), /cron/)
  // 一条过期、一条今天截止、一条静音的、一条没截止
  const d = new Date(); const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const doc = (id, extra) => ({ _id: `todo/${id}`, _rev: '1-a', title: id, status: 'open', priority: 'normal', tags: [], created: 1, updated: 1, ...extra })
  await pf._rpc.call(ctx, 'todo', 'db.push', { docs: [doc('late', { due: '2000-01-01' }), doc('today', { due: today }), doc('muted', { due: '2000-01-01', remind_muted: true }), doc('nodue')] })
  await pf._scheduler.fire('todo', 'overdue-reminder')
  assert.equal(pushed.length, 1)
  assert.match(pushed[0].title, /1 条过期，1 条今天截止/)
  assert.match(pushed[0].body, /late；today/)
  assert.doesNotMatch(pushed[0].body, /muted/)
  assert.equal(pf._scheduler.list('todo')[0].successCount, 1)
  // 全局关掉（dbStorage remind.off）：不推送，任务照样算成功
  await pf._rpc.call(ctx, 'todo', 'db.push', { docs: [{ _id: '\u0000storage/remind.off', _rev: '1-z', value: true }] })
  await new Promise((r) => setTimeout(r, 50))
  await pf._scheduler.fire('todo', 'overdue-reminder')
  assert.equal(pushed.length, 1)
  assert.equal(pf._scheduler.list('todo')[0].successCount, 2)
  // 删除；存盘（重启后还在）
  await pf._rpc.call(ctx, 'todo', 'schedule.remove', { code: 'overdue-reminder' })
  assert.equal(pf._scheduler.list('todo').length, 0)
  await pf._rpc.call(ctx, 'todo', 'schedule.request', { code: 'again', label: 'a', trigger: { cron: '*/5 * * * *' } })
  pf.flush()
  assert.match(fs.readFileSync(path.join(dataDir, 'plugins/schedules.json'), 'utf8'), /again/)
  await assert.rejects(pf._rpc.call(ctx, 'hello', 'schedule.request', { code: 'h', label: 'h', trigger: { cron: '* * * * *' } }), (e) => e.code === 'EWTPERM' || /preload/.test(e.message))
})
