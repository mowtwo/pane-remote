#!/usr/bin/env node
import { isPaneId, terminalId } from '../lib/terminal-id.mjs'
// pane-host：电脑上的常驻服务（pane-remote init 装成 LaunchAgent，见 docs/host.md；不在时 connect.mjs 会就地拉起一个）。
// 监听 ~/.cache/pane-remote-host/host.sock（目录 0700、socket 0600），每个连接说 protocol.mjs 里的协议。
// 服务端经 bridge 的 `host` 指令（ssh → connect.mjs → 这里）只占一条长连接，代替每次 `ssh … agent/bridge <命令>`。
// 和平台绑定的事都经 Host 接口（hosts/），这里只管协议、主题和生命周期。
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { RUN_DIR, SOCK } from './paths.mjs'
import { lineReader, encode, ERR, VERSION, Feed } from './protocol.mjs'
import { pathToFileURL } from 'node:url'
import { EventsFeed } from './services/events.mjs'
import { TranscriptFeed } from './services/transcript.mjs'
import { createAiService } from './services/ai.mjs'
import { createFilesService } from './services/files.mjs'
import { createAgentTasksService } from './services/agent-tasks.mjs'
import { readHostEnv, HOST_ENV_FILE } from './config.mjs'
import { HOME } from './paths.mjs'

// PANE_HOST_IMPL：换一个 Host 实现（测试用假的；以后 Linux 用 hosts/linux）
// 本机的网卡地址和主机名：中转拿来认出「访问者就是被遥控的这台电脑」（这台电脑上打开遥控页面没有意义，提示用别的设备）
const selfIds = () => ({ addrs: Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal).map((a) => a.address), hostnames: [os.hostname()] })
const host = (await import(process.env.PANE_HOST_IMPL ? pathToFileURL(process.env.PANE_HOST_IMPL).href : './hosts/macos/index.mjs')).createHost()
const started = Date.now()
const log = (...a) => console.log(new Date().toISOString(), ...a)
// connect.mjs 就地拉起的（不是 launchd 管的）：10 分钟没有连接就自己退出，不留孤儿
const AUTOSTARTED = process.env.PANE_HOST_AUTOSTARTED === '1'
const IDLE_EXIT_MS = Number(process.env.PANE_HOST_IDLE_EXIT_MS || 600000)
// launchd 的环境没有代理变量：从 host-env 读出来交给 AI 子进程（只打印变量名）
const hostEnv = readHostEnv()
if (hostEnv.keys.length) log(`host-env: ${hostEnv.keys.join(', ')} (${HOST_ENV_FILE})`)
if (hostEnv.warn) log(hostEnv.warn)
const ai = createAiService({ env: hostEnv.env })
const files = createFilesService()
const agentTasks = createAgentTasksService()

// ---------- 主题 ----------
// 同一个主题所有连接共用一份（一个 pane 的会话记录只盯一次），最后一个订阅者走后 30 秒关掉
const feeds = new Map() // topic → { feed, refs, closeTimer }
let eventsFeed = null
// 插件工具列表变了（服务端说的，或者反向通道连上 / 断开）：agent 的 MCP 订阅这个主题，收到就重新拉列表、通知 agent
const toolsFeed = new Feed({ ring: 4 })
async function openFeed(topic) {
  let f = feeds.get(topic)
  if (f) { clearTimeout(f.closeTimer); f.refs++; await f.ready; return f.feed }
  let feed, ready
  if (topic === 'events') {
    feed = eventsFeed ??= new EventsFeed(host.events.log)
    ready = Promise.resolve()
  } else if (topic === 'plugins.tools') {
    feed = toolsFeed
    ready = Promise.resolve()
  } else {
    const m = /^transcript:(\d{1,6}|w[0-9A-HJKMNP-TV-Z]{1,13}:p[0-9A-HJKMNP-TV-Z]{1,13}):(\d{1,3})$/.exec(topic)
    if (!m) throw Object.assign(new Error(`unknown topic ${topic}`), { code: ERR.PARAMS })
    feed = new TranscriptFeed(host, terminalId(m[1]), Math.min(200, Number(m[2]) || 60))
    ready = feed.start()
  }
  f = { feed, refs: 1, closeTimer: null, ready }
  feeds.set(topic, f)
  try { await ready } catch (e) { feeds.delete(topic); feed.close?.(); throw e }
  return feed
}
function releaseFeed(topic) {
  const f = feeds.get(topic)
  if (!f || --f.refs > 0) return
  f.closeTimer = setTimeout(() => {
    if (f.refs > 0) return
    feeds.delete(topic)
    f.feed.close?.()
  }, topic === 'events' ? 0 : 30000)
}

// ---------- 反向通道 ----------
// 服务端连上后开一条 relay.serve 流挂着；本机程序（agent 的 MCP，mac/agent/plugin/mcp.mjs）经 plugins.tools.* 请服务端办事，
// 这里用流里的 ctx.request 转过去。多个服务端连着时用最后连上的那个
const relayLinks = []
function relayRequest(data, timeout) {
  const link = relayLinks.at(-1)
  if (!link) return Promise.reject(Object.assign(new Error('pane-remote 服务端没连上这台电脑的 pane-host'), { code: ERR.DOWN }))
  let timer
  return Promise.race([
    link.request(data),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('服务端没有回应'), { code: ERR.DOWN })), timeout) }),
  ]).finally(() => clearTimeout(timer))
}

// ---------- 方法 ----------
// call：async (params, ctx) => 结果；stream：async (params, ctx) => 结果，中途用 ctx.chunk(x) 推，ctx.signal 取消，
// ctx.request(x) 向对端要一个结果（流里发 {id, chunk: {...x, rid}}，对端回通知 reply {id, rid, ok, value | error}；AI 的工具调用用它）
const calls = {
  ping: async () => ({ pong: true, t: Date.now(), version: VERSION, pid: process.pid, uptime: Math.round((Date.now() - started) / 1000), platform: host.platform, home: HOME, feeds: [...feeds.keys()], caps: ['ai', 'fs', ...(host.desktop ? ['desktop'] : [])], ...selfIds() }),
  'terminals.list': () => host.terminals.list(),
  'terminals.text': ({ pane, lines, escapes }) => host.terminals.text(paneId(pane), { lines: Math.min(5000, Number(lines) || 200), escapes: !!escapes }),
  // 一次性取对话（没订阅时服务端的 /api/transcript 也能走这里，省掉 ssh 每次拉起 bash / python 的开销）
  'transcript.get': async ({ pane, n }) => {
    const s = await host.agents.session(paneId(pane))
    return { session: s, messages: await host.agents.messages(s, Math.min(200, Number(n) || 60)) }
  },
  // 桌面：插件选了用 Mac 的剪贴板 / 在 Mac 上打开网址（权限服务端查过）
  'desktop.clipboard.readText': () => desktop().clipboard.readText(),
  'desktop.clipboard.writeText': ({ text }) => desktop().clipboard.writeText(String(text ?? '').slice(0, 1 << 20)),
  'desktop.openUrl': ({ url }) => {
    if (!/^https?:\/\/[^\s]+$/i.test(String(url || ''))) throw Object.assign(new Error('只能打开 http(s) 网址'), { code: ERR.PARAMS })
    return desktop().openUrl(String(url))
  },
  // 插件工具（给 agent 的 MCP）：服务端那边查权限（可能要在手机上问你）、起插件的工具运行时
  'plugins.tools.list': () => relayRequest({ op: 'plugins.tools.list' }, 15000),
  // 给 agent 会话的留言（插件 platform.sessions.note 留的）：会话的 hook / MCP 来取，取走就删
  'sessions.notes.take': ({ session }) => relayRequest({ op: 'sessions.notes.take', session: String(session || '').slice(0, 80) }, 5000),
  'plugins.tools.changed': ({ sig } = {}) => { toolsFeed.publish({ sig: String(sig ?? '').slice(0, 100) }); return true },
  'plugins.tools.call': ({ name, args, caller }) => relayRequest({ op: 'plugins.tools.call', name: String(name || '').slice(0, 64), args: args && typeof args === 'object' ? args : {}, caller: caller && typeof caller === 'object' ? caller : null }, 6 * 60000),
  ...ai.calls,
  ...files.calls,
  ...agentTasks.calls,
}
function desktop() {
  if (!host.desktop) throw Object.assign(new Error(`这台电脑（${host.platform}）的 Host 没有实现 desktop`), { code: ERR.METHOD })
  return host.desktop
}
const streams = {
  // 画面：本机轮询，有变化才推一帧（和 bridge watch 一样的节奏：刚变过每 0.1 秒，闲下来放慢到 0.5 秒）
  'terminals.watch': async ({ pane, lines }, ctx) => {
    const id = paneId(pane), n = Math.min(5000, Number(lines) || 200)
    let prev = null, idle = 0
    while (!ctx.signal.aborted) {
      const cur = await host.terminals.text(id, { lines: n, escapes: true })
      if (cur !== prev) { ctx.chunk({ text: cur }); prev = cur; idle = 0 } else idle++
      await sleep(idle < 20 ? 100 : idle < 60 ? 250 : 500, ctx.signal)
    }
    return null
  },
  // 服务端挂着的反向通道（见上面 relayRequest）：一直挂到服务端断开
  'relay.serve': async (params, ctx) => {
    relayLinks.push(ctx)
    log(`relay.serve: 服务端已连上反向通道（${relayLinks.length} 条）`)
    toolsFeed.publish({ sig: 'relay-up' })
    try { await new Promise((r) => ctx.signal.addEventListener('abort', r, { once: true })) } finally { relayLinks.splice(relayLinks.indexOf(ctx), 1); toolsFeed.publish({ sig: 'relay-down' }) }
    return null
  },
  ...ai.streams,
}
function paneId(p) {
  if (!isPaneId(p)) throw Object.assign(new Error('bad pane id'), { code: ERR.PARAMS })
  return terminalId(p)
}
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })

// ---------- 连接 ----------
let conns = 0
let idleTimer = null
function onConnection(sock) {
  conns++
  clearTimeout(idleTimer)
  const subs = new Map() // topic → listener
  const running = new Map() // stream id → AbortController
  const waiting = new Map() // `${流 id}:${rid}` → { resolve, reject }（流里发出去、等对端回的请求）
  let rids = 0
  let open = true
  const send = (m) => { if (open) sock.write(encode(m)) }
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const fail = (id, e) => send({ jsonrpc: '2.0', id, error: { code: e.code || ERR.INTERNAL, message: String(e.message || e) } })
  lineReader(sock, async (m) => {
    const { id, method, params = {} } = m
    try {
      if (method === 'cancel') return running.get(params.id)?.abort()
      if (method === 'reply') {
        const w = waiting.get(`${params.id}:${params.rid}`)
        if (!w) return
        waiting.delete(`${params.id}:${params.rid}`)
        return params.ok ? w.resolve(params.value) : w.reject(Object.assign(new Error(String(params.error?.message || params.error || 'error')), { code: params.error?.code }))
      }
      if (method === 'sub') {
        const topic = String(params.topic || '')
        if (subs.has(topic)) return reply(id, { topic, seq: feeds.get(topic)?.feed.seq, already: true })
        const feed = await openFeed(topic)
        if (!open) return releaseFeed(topic)
        const listener = (e) => send({ ...e, topic })
        subs.set(topic, listener)
        const seq = feed.attach(listener, params.since ?? null)
        return reply(id, { topic, seq })
      }
      if (method === 'unsub') {
        const topic = String(params.topic || '')
        const l = subs.get(topic)
        if (l) { subs.delete(topic); feeds.get(topic)?.feed.detach(l); releaseFeed(topic) }
        return reply(id, true)
      }
      if (m.stream && Object.hasOwn(streams, method)) {
        const ac = new AbortController()
        running.set(id, ac)
        try {
          const request = (data) => new Promise((resolve, reject) => {
            if (ac.signal.aborted) return reject(Object.assign(new Error('cancelled'), { code: ERR.CANCELLED }))
            const rid = ++rids, key = `${id}:${rid}`
            waiting.set(key, { resolve, reject })
            ac.signal.addEventListener('abort', () => { if (waiting.delete(key)) reject(Object.assign(new Error('cancelled'), { code: ERR.CANCELLED })) }, { once: true })
            send({ id, chunk: { ...data, rid } })
          })
          const result = await streams[method](params, { signal: ac.signal, chunk: (c) => send({ id, chunk: c }), request })
          if (ac.signal.aborted) return fail(id, { code: ERR.CANCELLED, message: 'cancelled' })
          return reply(id, result)
        } catch (e) {
          // 取消引起的异常（比如 AI 的 code: 'aborted'）一律按 CANCELLED 回，调用方只认这一种
          return fail(id, ac.signal.aborted ? { code: ERR.CANCELLED, message: 'cancelled' } : e)
        } finally { running.delete(id) }
      }
      if (!Object.hasOwn(calls, method)) throw Object.assign(new Error(`no such method ${method}`), { code: ERR.METHOD })
      reply(id, await calls[method](params, {}))
    } catch (e) {
      if (id != null) fail(id, e)
    }
  }, (e) => send({ jsonrpc: '2.0', id: null, error: { code: ERR.PARSE, message: e.message } }))
  const cleanup = () => {
    if (!open) return
    open = false
    conns--
    for (const ac of running.values()) ac.abort()
    for (const [topic, l] of subs) { feeds.get(topic)?.feed.detach(l); releaseFeed(topic) }
    subs.clear()
    if (AUTOSTARTED && !conns) idleTimer = setTimeout(() => { log('idle, exiting'); shutdown() }, IDLE_EXIT_MS)
  }
  sock.on('close', cleanup)
  sock.on('error', cleanup)
}

// ---------- 启动 ----------
fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
fs.chmodSync(RUN_DIR, 0o700)
const server = net.createServer(onConnection)
function listen() {
  server.listen(SOCK, () => {
    fs.chmodSync(SOCK, 0o600)
    log(`pane-host ${process.pid} listening on ${SOCK}${AUTOSTARTED ? ' (autostarted)' : ''}`)
    if (AUTOSTARTED) idleTimer = setTimeout(() => { if (!conns) shutdown() }, IDLE_EXIT_MS)
  })
}
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') { log(`listen: ${e.message}`); process.exit(1) }
  // socket 文件在：有活的 pane-host 就让它（正常退出，launchd 不会再拉），死的就删掉重来
  const probe = net.connect(SOCK)
  probe.on('connect', () => { probe.end(); log('another pane-host is running, exiting'); process.exit(0) })
  probe.on('error', () => { try { fs.unlinkSync(SOCK) } catch {} listen() }) // ignore: 删不掉的话 listen 会再报错
})
listen()

function shutdown() {
  server.close()
  try { ai.close() } catch {} // ignore: 退出前杀备用进程，失败也要接着退
  try { fs.unlinkSync(SOCK) } catch {} // ignore: 退出前清理，文件已经不在也无所谓
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('uncaughtException', (e) => log('uncaughtException', e))
process.on('unhandledRejection', (e) => log('unhandledRejection', e))
