// 插件工具 → agent 的 MCP（服务端侧）。和 uTools 一样：
//   - 描述文件（plugin.json）的 tools 声明工具名、说明和 JSON Schema；插件的 preload 里用 utools.registerTool(名字, 函数) 实现
//   - agent 调用时插件没在跑就起一个无界面的运行时（tool-runtime.mjs，沙盒子进程）跑 preload，再执行工具；闲 10 分钟退出
// agent 看到的名字是 plugin_<插件 id>_<工具名>（MCP 工具名只许字母数字 _ -，插件 id 里的其他字符换成 _，超长截到 64）。
// 权限：mcp（whatevertools 已有，默认询问）。第一次调用时用「在手机上问你」的卡片问（手机不在看就推送），
//   「始终允许」记住；「禁止」之后这个插件的工具不再出现在 agent 的列表里。每次调用记审计（方法名 mcp.<工具名>）。
// 调用方（mcp.mjs 带上来的 agent、pane、目录）放在工具函数的 ctx.caller 里，插件可以记下是谁写的。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isPaneId, terminalId } from '../lib/terminal-id.mjs'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tool-runtime.mjs')
const IDLE_MS = 10 * 60000
const CALL_MS = 5 * 60000
const BOOT_MS = 15000
const NAME = /^[a-zA-Z0-9_-]{1,64}$/
const str = (v, n) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, n)
const err = (msg, code) => Object.assign(new Error(msg), { code })

export const mcpName = (pluginId, tool) => `plugin_${pluginId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${tool}`.slice(0, 64)

/**
 * deps: { catalog, perms, audit, dbFor(m), rpc, asks, dbChanged(m, docs, from), version, platform, apiVersion, log }
 *   rpc：插件运行时里的平台调用（whatevertools.platform.*）照样经它查权限、记审计
 */
export function createToolHost(deps) {
  const log = deps.log || console.log
  const runtimes = new Map() // 插件 id → { proc, key, ready, tools, pending, idle }

  /** 插件声明的工具（只认 preload 里能实现的：没有 preload 的插件声明了也不列） */
  function declared(m) {
    if (!m.tools || typeof m.tools !== 'object' || !m.preload) return []
    return Object.entries(m.tools).filter(([name, t]) => NAME.test(name) && t && typeof t === 'object' && t.inputSchema && typeof t.inputSchema === 'object').map(([name, t]) => ({ name, def: t }))
  }

  function list() {
    const out = []
    for (const m of deps.catalog.all()) {
      const tools = declared(m)
      if (!tools.length) continue
      if (deps.perms.blocked(m, 'mcp')) continue // 只有明确「禁止」的才不列；没答应的下次调用再问
      for (const { name, def } of tools) {
        out.push({
          name: mcpName(m.id, name),
          plugin: m.id,
          tool: name,
          description: `[pane-remote 插件「${m.name}」] ${str(def.description, 2000)}`,
          inputSchema: def.inputSchema,
          ...(def.outputSchema && typeof def.outputSchema === 'object' ? { outputSchema: def.outputSchema } : {}),
        })
      }
    }
    return out
  }

  /** 这次调用没有手机连接可以问权限：用「在手机上问你」的卡片（不在看就推送），5 分钟没回答算这次不允许 */
  // 工具里再要别的权限（推送、AI……）：同样用卡片问，问的是「插件要用 XX」
  const askPrompt = (m, caller, toolName) => async (req) => {
    const who = [caller?.agent, caller?.pane != null ? `#${caller.pane}` : '', caller?.cwd ? path.basename(String(caller.cwd)) : ''].filter(Boolean).join(' · ')
    const what = req.permission === 'mcp' ? '想把工具提供给 agent 使用' : `的工具要用「${req.info?.title || req.permission}」${req.scope ? `（${req.scope}）` : ''}${req.reason ? `：${req.reason}` : ''}`
    const r = await deps.asks.ask({ test: false }, m, {
      question: `「${m.name}」${what}${who ? `（这次是 ${who} 调用 ${toolName}）` : toolName ? `（这次调用 ${toolName}）` : ''}。允许吗？`,
      options: ['始终允许', '仅这次', '禁止'],
      confirm: true,
      timeout: 300,
      push: 'always',
    })
    if (!r.answered) return 'dismiss'
    return r.answer === '始终允许' ? 'always' : r.answer === '仅这次' ? 'once' : r.answer === '禁止' ? 'block' : 'dismiss'
  }

  async function call({ name, args, caller }) {
    const hit = list().find((t) => t.name === name)
    if (!hit) throw err(`没有这个插件工具：${name}`, 'ENOTOOL')
    const m = deps.catalog.get(hit.plugin)
    const t0 = Date.now()
    const audit = (result, error) => deps.audit.record({ plugin: m.id, method: `mcp.${hit.tool}`, result, impl: 'tools', ms: Date.now() - t0, ...(error ? { error } : {}) })
    const who = caller && typeof caller === 'object' ? { agent: str(caller.agent, 40) || null, pane: isPaneId(caller.pane) ? terminalId(caller.pane) : null, cwd: str(caller.cwd, 1000) || null, session: /^[\w-]{8,80}$/.test(String(caller.session || '')) ? String(caller.session) : null } : null
    try {
      await deps.perms.permit({ client: 'agent', test: false, visible: () => false, prompt: askPrompt(m, who, hit.tool) }, m, 'mcp')
    } catch (e) {
      audit('denied', e.message)
      // 没回答 / 以后再说：清掉「这次」的拒绝（工具运行时没有「关掉插件」这一步），下次调用再问；连续 3 次照样自动转为禁止
      if (!deps.perms.blocked(m, 'mcp')) deps.perms.endSession(m)
      throw Object.assign(new Error(deps.perms.blocked(m, 'mcp') ? `你禁止了插件「${m.name}」给 agent 提供工具（可以在插件顶栏的盾牌里改）` : `插件「${m.name}」的工具这次没有得到允许（手机上的询问没有回答），下次调用会再问`), { code: 'EWTPERM', permission: 'mcp' })
    }
    try {
      const rt = await runtime(m)
      if (!rt.tools.includes(hit.tool)) throw err(`插件「${m.name}」的 preload 没有注册工具 ${hit.tool}`, 'ENOTOOL')
      const value = await rt.run(hit.tool, args && typeof args === 'object' ? args : {}, who)
      audit('ok')
      return { value, plugin: m.id, tool: hit.tool }
    } catch (e) { audit('error', e.message); throw e }
  }

  // ---------- 运行时（子进程） ----------
  /** 插件文件变了（描述文件、preload）就换一个新的运行时 */
  function keyOf(m) {
    return [m.preload, ...['plugin.json', 'whatevertools.json', m.preload].map((f) => { try { return fs.statSync(path.join(m.dir, f)).mtimeMs } catch { return 0 } })].join(':')
  }
  async function runtime(m) {
    const key = keyOf(m)
    let rt = runtimes.get(m.id)
    if (rt && rt.key !== key) { rt.stop('plugin changed'); rt = null }
    if (!rt) { rt = start(m, key); runtimes.set(m.id, rt) }
    rt.touch()
    await rt.ready
    return rt
  }

  function start(m, key) {
    const file = path.resolve(m.dir, m.preload)
    if (!file.startsWith(path.resolve(m.dir) + path.sep)) throw err('preload 路径不对', 'EBADPLUGIN')
    const code = fs.readFileSync(file, 'utf8')
    const proc = fork(RUNTIME, [], {
      execArgv: ['--permission', `--allow-fs-read=${RUNTIME}`, '--max-old-space-size=128'],
      env: {}, // 不把服务端的环境变量（推送密钥之类）带进去
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    })
    const tag = `plugin ${m.id}:`
    const relay = (s) => { for (const line of String(s).split('\n')) if (line.trim()) log(`${tag} ${line.slice(0, 500)}`) }
    proc.stdout.on('data', relay)
    proc.stderr.on('data', relay)
    const pending = new Map() // id → { resolve, reject, timer }
    let seq = 0, idle = null, dead = false
    let markReady, failReady
    const rt = {
      key, proc, tools: [],
      ready: new Promise((res, rej) => { markReady = res; failReady = rej }),
      touch() { clearTimeout(idle); idle = setTimeout(() => { if (!pending.size) rt.stop('idle') ; else rt.touch() }, IDLE_MS); idle.unref?.() },
      stop(why) {
        if (dead) return
        dead = true
        clearTimeout(idle)
        if (runtimes.get(m.id) === rt) runtimes.delete(m.id)
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err(`插件运行时已停止（${why}）`, 'ETOOLDOWN')) }
        pending.clear()
        try { proc.kill() } catch {} // ignore: 已经退了
      },
      run(tool, args, caller) {
        return new Promise((resolve, reject) => {
          const id = ++seq
          const timer = setTimeout(() => { pending.delete(id); reject(err(`工具 ${tool} 超过 ${CALL_MS / 60000} 分钟没有返回`, 'ETIMEOUT')) }, CALL_MS)
          pending.set(id, { resolve, reject, timer })
          rt.caller = caller // 工具里调平台能力要问权限时，卡片上写是谁在调
          rt.tool = tool
          proc.send({ t: 'run', id, tool, args, caller, requestId: crypto.randomBytes(6).toString('hex') })
        })
      },
      db(docs) { if (!dead && docs.length) try { proc.send({ t: 'db', docs }) } catch {} }, // ignore: 正在退出
      trigger(code) {
        return new Promise((resolve, reject) => {
          const id = ++seq
          const timer = setTimeout(() => { pending.delete(id); reject(err(`定时任务 ${code} 超过 ${CALL_MS / 60000} 分钟没有完成`, 'ETIMEOUT')) }, CALL_MS)
          pending.set(id, { resolve, reject, timer })
          rt.caller = null
          rt.tool = `定时任务 ${code}`
          proc.send({ t: 'schedule', id, code })
        })
      },
    }
    const bootTimer = setTimeout(() => { failReady(err(`插件「${m.name}」的工具运行时 ${BOOT_MS / 1000} 秒没起来`, 'ETOOLDOWN')); rt.stop('boot timeout') }, BOOT_MS)
    const reply = (id, p) => { try { proc.send({ t: 'reply', id, ...p }) } catch {} } // ignore: 子进程已经退出
    proc.on('message', async (msg) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.t === 'hello') {
        const db = await deps.dbFor(m)
        const docs = [...Object.values(db.docs), ...Object.entries(db.tombstones).map(([id, rev]) => ({ _id: id, _rev: rev, _deleted: true }))]
        proc.send({ t: 'init', code, filename: `/plugins/${m.id}/${m.preload}`, boot: { plugin: { id: m.id, name: m.name, version: m.version, features: m.features }, platform: { name: deps.platform, version: deps.version, api: deps.apiVersion }, docs, schedules: deps.schedules?.(m.id) || [] } })
      } else if (msg.t === 'ready') {
        clearTimeout(bootTimer)
        if (msg.error) {
          deps.recordIncident?.({ source: 'plugin', component: `plugin:${m.id}`, kind: 'tools', msg: `工具运行时启动失败：${msg.error}`, detail: msg.stack || msg.error, ctx: { plugin: m.id, version: m.version } })
          failReady(err(`插件「${m.name}」的 preload 出错：${msg.error}`, 'ETOOLBOOT'))
          return rt.stop('boot error')
        }
        rt.tools = Array.isArray(msg.tools) ? msg.tools.map(String) : []
        log(`${tag} tool runtime up (pid ${proc.pid}, tools: ${rt.tools.join(', ') || '无'})`)
        markReady()
      } else if (msg.t === 'result') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        clearTimeout(p.timer)
        rt.touch()
        if (msg.ok) p.resolve(msg.value)
        else p.reject(Object.assign(err(str(msg.error?.message, 4000) || '工具出错', str(msg.error?.code, 40) || 'ETOOL'), { stack: msg.error?.stack }))
      } else if (msg.t === 'db.push') {
        try {
          const db = await deps.dbFor(m)
          const applied = db.applyRemote(Array.isArray(msg.docs) ? msg.docs.slice(0, 500) : [])
          if (applied.length) deps.dbChanged?.(m, applied, 'tools')
          reply(msg.id, { ok: true, value: { applied: applied.length } })
        } catch (e) { reply(msg.id, { ok: false, error: { message: e.message } }) }
      } else if (msg.t === 'call') {
        // 插件在工具里调平台能力（whatevertools.platform.*、showNotification）：照常查权限、记审计；要问权限时用手机上的卡片问
        const ctx = { client: 'agent', test: false, visible: () => false, prompt: askPrompt(m, rt.caller, rt.tool) }
        deps.rpc.call(ctx, m.id, str(msg.method, 100), msg.args).then((value) => reply(msg.id, { ok: true, value }), (e) => reply(msg.id, { ok: false, error: { message: e.message, code: e.code } }))
      } else if (msg.t === 'error') {
        deps.recordIncident?.({ source: 'plugin', component: `plugin:${m.id}`, kind: 'tools', msg: str(msg.msg, 300), detail: str(msg.stack || msg.msg, 6000), ctx: { plugin: m.id, version: m.version } })
      }
    })
    proc.on('exit', (code, signal) => {
      clearTimeout(bootTimer)
      if (!dead) { log(`${tag} tool runtime exited (${signal || code})`); failReady(err(`插件「${m.name}」的工具运行时退出了（${signal || code}）`, 'ETOOLDOWN')) }
      rt.stop('exit')
    })
    rt.ready.catch(() => {}) // ignore: 调用方 await 时会拿到错误
    return rt
  }

  /** 定时任务触发：在插件的工具运行时里调 onScheduleTrigger（回调出错 / 返回 rejected 算失败） */
  async function runSchedule(pluginId, code) {
    const m = deps.catalog.get(pluginId)
    if (!m) throw err(`插件不在了：${pluginId}`, 'ENOPLUGIN')
    if (!m.preload) throw err(`插件「${m.name}」没有 preload，收不到定时任务`, 'ENOTOOL')
    const t0 = Date.now()
    try {
      const rt = await runtime(m)
      await rt.trigger(code)
      deps.audit.record({ plugin: m.id, method: `schedule.${code}`, result: 'ok', impl: 'tools', ms: Date.now() - t0 })
    } catch (e) {
      deps.audit.record({ plugin: m.id, method: `schedule.${code}`, result: 'error', impl: 'tools', ms: Date.now() - t0, error: e.message })
      throw e
    }
  }

  return {
    list,
    call,
    runSchedule,
    /** 插件的数据在别处改了（手机上的插件页）：推给正在跑的运行时 */
    applyDb(pluginId, docs) { runtimes.get(pluginId)?.db(docs) },
    stopAll() { for (const rt of [...runtimes.values()]) rt.stop('shutdown') },
    running: () => [...runtimes.keys()],
  }
}
