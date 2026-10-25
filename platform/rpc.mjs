// 能力表与 RPC 分发：插件的每次能力调用 → 查能力表 → 查权限（需要时问手机）→ 记审计 → 交给实现方。
// 实现方（impl）：
//   relay  服务端自己做（数据库、推送、问题报告、共享存储、在手机上提问）
//   web    手机前端做（复制、打开链接、打开别的插件）：服务端查完权限回 { $delegate }，前端收到再执行
//   mac    Mac 端常驻服务 pane-host 做（经 deps.host，即服务端的 HostClient）：AI、Mac 剪贴板、在 Mac 上打开网址、只读文件。
//          能力表里有 run 的才接上了；其余 Mac 分组的（截屏、键鼠、子进程……）还是回「不支持」，错误里写明原因。
//          pane-host 不在线时回 EWTHOSTDOWN。流式能力（AI）的 ctx 带 chunk(片段) / callTool(名字, 参数) / signal
//   local  插件页里的运行时自己就能做（生命周期、平台信息、dbStorage 的同步读写），不经过服务端
//   none   这个平台上没有意义或还没计划（面板输入框、快捷键、付费……）
// support(name) 的结果和 whatevertools 的 Support 一致：native / emulated / partial / mock / none。
import crypto from 'node:crypto'
import { APIS, findApi } from '@whatevertools/core'

export const PLATFORM = 'pane-remote'
// 插件 API 版本：和系统版本分开，只在插件能用的接口变了才升（加接口升次版本，改 / 删接口升主版本）。
// 插件在 whatevertools.json 的 paneRemote.requires 里写范围（如 ">=0.2.0"），不满足的不加载、列进插件目录的问题里
export const PLUGIN_API = '0.6.0'

const unsupported = (method, why) => Object.assign(new Error(`[pane-remote] 不支持 ${method}${why ? `：${why}` : ''}`), { code: 'EWTUNSUPPORTED', method })
const bad = (msg) => Object.assign(new Error(msg), { code: 'EBADARG' })
const MAC_WHY = '要电脑上的 pane-host，这一项还没接上'
const hostDown = (why) => Object.assign(new Error(`电脑上的 pane-host 不在线${why ? `（${why}）` : ''}，稍后再试`), { code: 'EWTHOSTDOWN' })
// 插件私有目录（在 Mac 上）：pane-host 的 services/files.mjs 用同一个位置
export const PRIVATE_DIR = '~/.local/share/pane-remote/plugins-data'
const str = (v, n) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, n)

// Mac 端能力（fs / shell / 截屏 / 键鼠 / 子进程……）按分组标出来，等 pane-host
const MAC_GROUPS = new Set(['context', 'input', 'screen', 'media', 'ubrowser', 'device', 'account'])
const MAC_NAMES = /^(dialog\.|shell\.(openPath|trash|showInFolder|beep)$|paths\.|system\.fileIcon|clipboard\.(writeImage|writeFiles|readFiles)$|fs\.|process\.)/

/** 能力表：方法名（whatevertools 原生 API 的点分名，或 platform.* / 内部的 db.push 之类） → 定义 */
export const CAPS = {
  // ---------- 插件运行时内部用 ----------
  'db.push': {
    impl: 'relay', perm: 'storage', support: 'emulated',
    run: ({ ctx, m, db, args, deps }) => {
      const applied = db.applyRemote(Array.isArray(args?.docs) ? args.docs.slice(0, 500) : [])
      if (applied.length) deps.dbChanged?.(m, applied, ctx.client) // 推给别的打开着这个插件的手机页面、插件的工具运行时
      return { applied: applied.length }
    },
  },
  // 插件页重新同步：回到前台、和服务端的连接断过之后拿一次全量（文档 + 墓碑），本地按 rev 合并
  'db.pull': { impl: 'relay', perm: 'storage', support: 'emulated', run: ({ db }) => ({ docs: allDocs(db) }) },
  'db.putAttachment': {
    impl: 'relay', perm: 'storage', support: 'emulated',
    run: async ({ db, args }) => db.postAttachment(str(args?.id, 500), Buffer.from(str(args?.data, 15 << 20), 'base64'), str(args?.type, 100)),
  },
  'db.getAttachment': {
    impl: 'relay', perm: 'storage', support: 'partial', note: '同步版只能读这次打开里已经读过的附件；用 db.promises.getAttachment',
    run: async ({ db, args }) => { const d = await db.getAttachment(str(args?.id, 500)); return d ? Buffer.from(d).toString('base64') : null },
  },
  // ---------- 通知 / 剪贴板 / 链接 ----------
  'system.notify': {
    impl: 'relay', perm: 'notification', support: 'emulated', note: '手机正开着 pane-remote 时是页内提示，否则推送到手机',
    run: async ({ ctx, m, args, deps }) => {
      const body = str(args?.body, 300)
      if (!body) throw bad('通知内容不能为空')
      if (ctx.visible?.()) return { $delegate: 'system.notify' }
      if (ctx.test) return { pushed: false, test: true }
      await deps.notify?.({ title: str(args?.title, 60) || m.name, body, tag: `plugin-${m.id}`, plugin: m.id })
      return { pushed: true }
    },
  },
  // 默认在手机上做；描述文件 paneRemote.mac.clipboard / paneRemote.mac.openExternal 为 true 时改在 Mac 上做（macOpt）
  'clipboard.writeText': {
    impl: 'web', perm: 'clipboard.write', support: 'emulated', note: '默认写手机的剪贴板；描述文件 paneRemote.mac.clipboard 为 true 时写电脑的',
    macOpt: 'clipboard', mac: ({ host, args }) => host.call('desktop.clipboard.writeText', { text: str(args?.text, 1 << 20) }),
  },
  'shell.openExternal': {
    impl: 'web', perm: 'shell.external', support: 'emulated', scope: (a) => str(a?.url, 2000), note: '默认在手机上打开；描述文件 paneRemote.mac.openExternal 为 true 时在电脑上打开。只认 http(s)',
    macOpt: 'openExternal', mac: ({ host, args }) => host.call('desktop.openUrl', { url: httpUrl(args?.url) }),
  },
  'launch.open': { impl: 'web', perm: 'redirect', support: 'partial', note: '打开别的插件（按插件 id 或功能指令），带上数据' },
  // ---------- pane-remote 专属 ----------
  'platform.incident.report': {
    impl: 'relay', perm: 'platform.incident', support: 'native',
    run: ({ ctx, m, args, deps }) => {
      const title = str(args?.title, 120).trim()
      if (!title) throw bad('写一句是什么问题')
      const inc = deps.recordIncident?.({ test: ctx.test || args?.test === true, source: 'plugin', component: `plugin:${m.id}`, kind: str(args?.kind, 40) || 'report', title, msg: title, detail: str(args?.detail, 6000), severity: ['high', 'normal', 'low'].includes(args?.severity) ? args.severity : 'normal', ctx: { plugin: m.id, version: m.version } })
      return { id: inc?.id || null }
    },
  },
  'platform.storage.get': { impl: 'relay', perm: 'platform.storage', support: 'native', scope: (a) => str(a?.group, 64), run: ({ shared, args }) => shared.get(args.group, str(args.key, 500)) },
  'platform.storage.set': { impl: 'relay', perm: 'platform.storage', support: 'native', scope: (a) => str(a?.group, 64), run: ({ shared, args }) => shared.set(args.group, str(args.key, 500), args.value) },
  'platform.storage.remove': { impl: 'relay', perm: 'platform.storage', support: 'native', scope: (a) => str(a?.group, 64), run: ({ shared, args }) => shared.remove(args.group, str(args.key, 500)) },
  'platform.storage.keys': { impl: 'relay', perm: 'platform.storage', support: 'native', scope: (a) => str(a?.group, 64), run: ({ shared, args }) => shared.keys(args.group) },
  'platform.agent.ask': { impl: 'relay', perm: 'platform.agent', support: 'native', run: ({ ctx, m, args, asks }) => asks.ask(ctx, m, args) },
  'platform.agent.notify': {
    impl: 'relay', perm: 'platform.agent', support: 'native', note: '和 notify_phone 一样限频：同一个插件 20 秒一条、全部每小时 20 条',
    run: async ({ ctx, m, args, deps, limiter }) => {
      const title = str(args?.title, 60), body = str(args?.body, 300)
      if (!title && !body) throw bad('通知内容不能为空')
      if (ctx.test) return { sent: false, reason: 'test' }
      if (!limiter(m.id)) return { sent: false, reason: 'rate-limited' }
      await deps.notify?.({ title: `${m.name} ${title}`.trim(), body, tag: `plugin-agent-${m.id}`, plugin: m.id })
      return { sent: true }
    },
  },
  // ---------- AI（本机的 Claude Code / Codex / cursor-agent，经 pane-host） ----------
  'ai.models': {
    impl: 'mac', perm: 'ai', support: 'emulated', note: '本机已登录的 Claude Code / Codex / cursor-agent 合成的模型列表（claude/<m>、codex/<m>、cursor/<m>），带 vision / efforts / tier',
    run: async ({ host, args }) => (await host.call('ai.models', { refresh: args?.refresh === true }, { timeout: 90000 })).models,
  },
  'ai.chat': {
    impl: 'mac', perm: 'ai', support: 'emulated', stream: true, note: '经电脑上的 agent CLI，流式、可取消；工具调用回到插件页（registerTool 注册的，或 window 上的同名函数）',
    run: ({ host, ctx, args }) => aiStream(host, ctx, { model: str(args?.model, 200) || undefined, messages: args?.messages, tools: args?.tools }, false),
  },
  'platform.ai.complete': {
    impl: 'mac', perm: 'ai', support: 'native', stream: true, note: 'ai.chat 的详细版：结构化输出（responseFormat）、推理等级、用量和耗时',
    run: ({ host, ctx, args }) => aiStream(host, ctx, {
      model: str(args?.model, 200) || undefined, messages: args?.messages, tools: args?.tools, responseFormat: args?.responseFormat,
      reasoning: args?.reasoning, timeoutMs: Math.min(600000, Number(args?.timeoutMs) || 300000),
    }, true),
  },
  // ---------- Mac 剪贴板 / 打开网址（不看描述文件，明确要 Mac 的） ----------
  'platform.mac.clipboard.readText': { impl: 'mac', perm: 'clipboard.read', support: 'native', run: ({ host }) => host.call('desktop.clipboard.readText') },
  'platform.mac.clipboard.writeText': { impl: 'mac', perm: 'clipboard.write', support: 'native', run: ({ host, args }) => host.call('desktop.clipboard.writeText', { text: str(args?.text, 1 << 20) }) },
  'platform.mac.openUrl': { impl: 'mac', perm: 'shell.external', scope: (a) => str(a?.url, 2000), support: 'native', run: ({ host, args }) => host.call('desktop.openUrl', { url: httpUrl(args?.url) }) },
  // ---------- 只读文件（Mac 上）：插件私有目录（fs.plugin，默认允许）+ 用户在插件设置里加的目录（fs.read，按目录问） ----------
  'platform.fs.roots': { impl: 'mac', perm: 'fs.plugin', support: 'native', run: async ({ host, m, fsDirs }) => host.call('fs.roots', { plugin: m.id, dirs: fsDirs }) },
  'platform.fs.list': { impl: 'mac', perm: fsPerm, support: 'native', run: ({ host, m, grant }) => host.call('fs.list', { plugin: m.id, root: grant.root, path: grant.path }) },
  'platform.fs.stat': { impl: 'mac', perm: fsPerm, support: 'native', run: ({ host, m, grant }) => host.call('fs.stat', { plugin: m.id, root: grant.root, path: grant.path }) },
  'platform.fs.read': {
    impl: 'mac', perm: fsPerm, support: 'native',
    run: ({ host, m, grant, args }) => host.call('fs.read', { plugin: m.id, root: grant.root, path: grant.path, encoding: args?.encoding === 'base64' ? 'base64' : 'utf8', maxBytes: Number(args?.maxBytes) || undefined }, { timeout: 30000 }),
  },
  // 插件工具经 MCP 暴露给 agent：用描述文件的 tools 声明 + preload 里 utools.registerTool 实现（tools.mjs），不在运行中注册
  'platform.agent.tools.register': { impl: 'none', support: 'none', why: '工具写在描述文件的 tools 里，在 preload 里用 utools.registerTool 实现（见 docs/plugins.md「插件工具」）' },
  // ---------- 定时任务（uTools 的 requestSchedule / getSchedules / removeSchedule；用 core 的 Scheduler，存服务端数据目录） ----------
  // 触发时在插件的工具运行时里跑 preload 注册的 onScheduleTrigger（手机不用开着插件）；没有 preload 的插件触发记失败
  'schedule.request': {
    impl: 'relay', perm: 'schedule', support: 'emulated', note: '触发时在插件的无界面运行时里调 preload 注册的 onScheduleTrigger；时间按服务端所在时区',
    run: ({ m, args, deps }) => {
      if (!m.preload) throw bad('定时任务要在 preload 里用 onScheduleTrigger 处理：这个插件没有 preload')
      const trigger = typeof args?.trigger === 'number' ? args.trigger : args?.trigger && typeof args.trigger === 'object' ? { cron: str(args.trigger.cron, 100), ...(Number.isFinite(args.trigger.startTime) ? { startTime: args.trigger.startTime } : {}), ...(Number.isFinite(args.trigger.endTime) ? { endTime: args.trigger.endTime } : {}) } : null
      if (deps.scheduler.list(m.id).length >= 20 && !deps.scheduler.list(m.id).some((t) => t.code === args?.code)) throw bad('每个插件最多 20 个定时任务')
      deps.scheduler.add(m.id, { code: str(args?.code, 64), label: str(args?.label, 100), trigger })
      return deps.scheduler.list(m.id)
    },
  },
  'schedule.list': { impl: 'relay', perm: 'schedule', support: 'emulated', run: ({ m, deps }) => deps.scheduler.list(m.id) },
  'schedule.remove': { impl: 'relay', perm: 'schedule', support: 'emulated', run: ({ m, args, deps }) => { deps.scheduler.remove(m.id, str(args?.code, 64)); return deps.scheduler.list(m.id) } },
  // ---------- agent 会话（服务端按 pane 认会话；会话 id 是 agent 自己的，比如 Claude Code 的 sessionId，pane 重启后也认得出） ----------
  'platform.sessions.list': {
    impl: 'relay', perm: 'platform.sessions', support: 'native', note: '在跑 agent 的 pane：{ pane, agent, session, cwd, title, status, startedAt }',
    run: ({ deps }) => sessionsOf(deps).list(),
  },
  // Claude Code 自带的任务列表（只读，经 pane-host 读 <配置目录>/tasks/<会话>）：每个在跑的会话一组
  'platform.sessions.tasks': {
    impl: 'relay', perm: 'platform.sessions', support: 'native', note: '在跑的 Claude Code 会话各自的 tasks（TaskCreate 写的）：[{ ...会话, tasks: [{ id, subject, description, activeForm, status, blocks, blockedBy }] }]',
    run: async ({ deps }) => {
      const list = await sessionsOf(deps).list()
      const items = list.filter((s) => s.session && s.configDir).map((s) => ({ session: s.session, configDir: s.configDir }))
      if (!items.length) return list.map((s) => ({ ...s, tasks: [] }))
      if (!deps.host?.connected) throw hostDown()
      const r = await deps.host.call('agents.tasks', { items }, { timeout: 15000 })
      return list.map((s) => ({ ...s, tasks: r?.[s.session]?.tasks || [], tasksAt: r?.[s.session]?.mtime || 0 }))
    },
  },
  'platform.sessions.send': {
    impl: 'relay', perm: 'platform.sessions', support: 'native', note: '往会话里输入一段文字并回车（多行按粘贴发）；按 session 找它现在在哪个 pane，找不到再看 pane',
    run: async ({ ctx, m, args, deps }) => {
      const text = str(args?.text, 8000).trim()
      if (!text) throw bad('要发的文字不能为空')
      const list = await sessionsOf(deps).list()
      const s = (args?.session && list.find((x) => x.session === args.session)) || (args?.pane != null && !args?.session ? list.find((x) => String(x.pane) === String(args.pane)) : null)
      if (!s) throw Object.assign(new Error(args?.session ? '这个会话现在没在任何 pane 里运行' : '没有这个 agent 会话'), { code: 'ENOSESSION' })
      if (ctx.test) return { pane: s.pane, agent: s.agent, session: s.session, test: true }
      await sessionsOf(deps).send(s.pane, text)
      return { pane: s.pane, agent: s.agent, session: s.session }
    },
  },
  'platform.sessions.note': {
    impl: 'relay', perm: 'platform.sessions', support: 'native', note: '给会话留言：它下次收到你的消息时（Claude Code 的提问 hook）或调 pane-remote 工具时一起看到，不打断它',
    run: ({ m, args, deps }) => {
      const session = str(args?.session, 80)
      const text = str(args?.text, 2000).trim()
      if (!/^[\w-]{8,80}$/.test(session) || !text) throw bad('要有会话 id 和留言内容')
      deps.sessionNotes.add(session, { plugin: m.id, name: m.name, text })
      return { queued: true }
    },
  },
}

/** 插件数据库的全部文档，含删除的墓碑（docs / tombstones 是 DocDb 的内部字段，没有对外的全量接口） */
export const allDocs = (db) => [...Object.values(db.docs), ...Object.entries(db.tombstones).map(([id, rev]) => ({ _id: id, _rev: rev, _deleted: true }))]

const sessionsOf = (deps) => { if (!deps.sessions) throw unsupported('platform.sessions', '这个服务端没有接上会话'); return deps.sessions }

function httpUrl(u) {
  const url = str(u, 2000)
  if (!/^https?:\/\/\S+$/i.test(url)) throw bad('只能打开 http(s) 网址')
  return url
}

/**
 * AI 流：pane-host 的 ai.complete。片段转给 ctx.chunk；agent 调工具时（流里的 tool-call 请求）经 ctx.callTool 问插件页，结果 reply 回去；
 * ctx.signal 取消（pane-host 杀掉子进程，这里以 code: 'aborted' 失败）
 */
async function aiStream(host, ctx, req, advanced) {
  if (!Array.isArray(req.messages) || !req.messages.length) throw bad('messages 要是非空数组')
  if (req.tools != null && !Array.isArray(req.tools)) throw bad('tools 要是数组')
  if (req.tools?.length && !ctx.callTool) throw bad('这次调用没法回调插件页的工具')
  for (const k of Object.keys(req)) if (req[k] === undefined) delete req[k]
  if (ctx.signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'aborted' })
  const s = host.stream('ai.complete', { req, advanced }, (c) => {
    if (c?.type === 'chunk') ctx.chunk?.(c.data)
    else if (c?.type === 'tool-call') {
      Promise.resolve().then(() => ctx.callTool(str(c.name, 64), c.args ?? {}))
        .then((value) => s.reply(c.rid, { ok: true, value: value === undefined ? null : value }), (e) => s.reply(c.rid, { ok: false, error: { message: str(e?.message || e, 2000) } }))
    }
  })
  const onAbort = () => s.cancel()
  ctx.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await s.done
  } catch (e) {
    if (e.code === -32800 || ctx.signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'aborted' })
    throw Object.assign(new Error(e.message), { code: typeof e.code === 'string' ? `EAI_${e.code.toUpperCase()}` : e.code === -32001 ? 'EWTHOSTDOWN' : 'EAI' })
  } finally { ctx.signal?.removeEventListener('abort', onAbort) }
}

/** 文件能力的权限：路径（或明确的 root）落在哪个根目录 → 私有目录用 fs.plugin（默认允许），用户加的目录用 fs.read（按目录问） */
async function fsPerm({ m, args, fsDirs, home }) {
  const raw = str(args?.path, 4000)
  const root = args?.root == null ? null : str(args.root, 1000)
  if (root === 'private') return { perm: 'fs.plugin', root: 'private', path: raw }
  if (root != null) {
    if (!fsDirs.includes(root)) throw Object.assign(new Error(`目录 ${root} 不在这个插件的允许列表里（在插件的权限设置里加）`), { code: 'EWTPERM', permission: 'fs.read' })
    return { perm: 'fs.read', scope: root, root, path: raw }
  }
  if (!raw.startsWith('/') && !raw.startsWith('~')) {
    if (raw.split('/').includes('..')) throw bad('相对路径不能有 ..')
    return { perm: 'fs.plugin', root: 'private', path: raw }
  }
  // 绝对路径：统一成 ~/… 再按前缀找根目录（Mac 上还会按真实路径再核对一遍）
  const h = await home()
  let p = raw.startsWith('~/') || raw === '~' ? raw : h && (raw === h || raw.startsWith(h + '/')) ? '~' + raw.slice(h.length) : raw
  p = normPath(p)
  const inside = (dir) => { const d = normPath(dir); return p === d || p.startsWith(d.endsWith('/') ? d : d + '/') }
  if (inside(`${PRIVATE_DIR}/${m.id}`)) return { perm: 'fs.plugin', root: 'private', path: p }
  const hit = fsDirs.filter(inside).sort((a, b) => b.length - a.length)[0]
  if (!hit) throw Object.assign(new Error('这个路径不在插件私有目录或允许的目录里（在插件的权限设置里加）'), { code: 'EWTPERM', permission: 'fs.read' })
  return { perm: 'fs.read', scope: hit, root: hit, path: p }
}

/** ~/a/../b → ~/b；不许越过开头 */
export function normPath(p) {
  const tilde = p.startsWith('~')
  const parts = []
  for (const seg of (tilde ? p.slice(1) : p).split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { if (!parts.length) throw bad('路径越界'); parts.pop() } else parts.push(seg)
  }
  return (tilde ? '~/' : '/') + parts.join('/')
}

/** 用户在插件设置里加的目录：只认绝对路径或 ~/…，去掉 ..、末尾斜杠；家目录本身和根目录不行 */
export function cleanDir(d) {
  const s = str(d, 1000).trim()
  if (!s.startsWith('/') && !s.startsWith('~/')) throw bad('目录要写绝对路径或 ~/ 开头')
  const n = normPath(s)
  if (n === '/' || n === '~/') throw bad('不能把整个家目录或根目录给插件')
  return n
}

// 运行时自己做的（不经过服务端），列出来只为 support 表完整
const LOCAL = {
  'lifecycle.onEnter': 'emulated', 'lifecycle.onLeave': 'emulated', 'lifecycle.onReady': 'emulated', 'lifecycle.exit': 'emulated',
  'window.type': 'emulated', 'system.appName': 'emulated', 'system.appVersion': 'emulated', 'system.isDev': 'emulated',
  'system.isMac': 'emulated', 'system.isWindows': 'emulated', 'system.isLinux': 'emulated', 'system.isDark': 'emulated', 'system.onThemeChange': 'emulated',
  'db.put': 'emulated', 'db.get': 'emulated', 'db.remove': 'emulated', 'db.bulk': 'emulated', 'db.all': 'emulated', 'db.getAttachmentType': 'emulated', 'db.onPull': 'emulated',
  'kv.set': 'emulated', 'kv.get': 'emulated', 'kv.remove': 'emulated', 'features.list': 'emulated', 'panel.setHeight': 'mock',
  'schedule.onTrigger': 'emulated', // 只在插件的 preload 里收到（定时任务在工具运行时里触发）
  'tools.register': 'emulated', // ai.chat 的工具调用；描述文件 tools 里声明了的，还经 MCP 给 agent 用（tools.mjs）
}

/** 这个平台对某个 API 的支持程度和实现方（按 whatevertools 的规格名或 uTools 旧名查） */
export function support(name) {
  const spec = findApi(name)
  const n = spec?.name || name
  const cap = CAPS[n]
  if (cap) return { name: n, support: cap.support, impl: cap.impl, note: cap.note || cap.why }
  if (LOCAL[n]) return { name: n, support: LOCAL[n], impl: 'local' }
  if (!spec && !n.startsWith('platform.')) return null
  if (spec && (MAC_GROUPS.has(spec.group) || MAC_NAMES.test(n))) return { name: n, support: 'none', impl: 'mac', note: MAC_WHY }
  return { name: n, support: 'none', impl: 'none' }
}

/** 整张表：whatevertools 规格里的每一项 + platform.* */
export function supportTable() {
  const rows = APIS.map((a) => ({ ...support(a.name), legacy: a.legacy, group: a.group, permission: a.permission }))
  for (const n of Object.keys(CAPS)) if (n.startsWith('platform.')) rows.push({ ...support(n), group: 'platform', permission: CAPS[n].perm })
  return rows
}

/** 给运行时的精简版：{ 名字: support }、uTools 旧名 → 原生名、不支持的原因 */
export function runtimeTable() {
  const support = {}, legacy = {}, why = {}
  for (const r of supportTable()) {
    support[r.name] = r.support
    if (r.legacy) legacy[r.legacy] = r.name
    if (r.support === 'none' && r.note) why[r.name] = r.note
  }
  return { support, legacy, why }
}

/** 共享存储组：所有声明了同一个组的插件共用一份键值（存服务端数据目录，一个组一个 JSON 文件） */
export function createShared(io) {
  const groups = new Map()
  const load = (g) => { if (!groups.has(g)) groups.set(g, io.read(g) || {}); return groups.get(g) }
  const check = (m, g) => { if (!m.storageGroups?.includes(g)) throw bad(`插件没有在 whatevertools.json 的 paneRemote.storage 里声明存储组「${g}」`) }
  return {
    bind: (m) => ({
      get: (g, k) => { check(m, g); const v = load(g)[k]; return v === undefined ? null : v },
      set: (g, k, v) => {
        check(m, g)
        const s = JSON.stringify(v ?? null)
        if (s.length > 256 << 10) throw bad('值太大（单个最多 256KB）')
        const data = load(g)
        data[k] = JSON.parse(s)
        if (Object.keys(data).length > 2000) throw bad('这个存储组的键太多了（最多 2000 个）')
        io.write(g, data)
        return true
      },
      remove: (g, k) => { check(m, g); const data = load(g); const had = k in data; delete data[k]; if (had) io.write(g, data); return had },
      keys: (g) => { check(m, g); return Object.keys(load(g)) },
    }),
  }
}

/** 在手机上问插件的问题（复用 agent ask_phone 的那套：手机上弹卡片、不在看就推送、/api/agent/answer 也能答） */
export function createAsks({ notify, broadcast, hasVisibleClient }) {
  const list = new Map() // id → { id, plugin, pluginName, question, options, confirm, expires, resolve, timer }
  const publicList = () => [...list.values()].map(({ id, plugin, pluginName, question, options, confirm, expires, test }) => ({ id, plugin, pluginName, question, options, confirm, expires, test }))
  const changed = () => broadcast?.({ t: 'asks', list: publicList() })
  function finish(id, result) {
    const a = list.get(id)
    if (!a) return false
    clearTimeout(a.timer)
    list.delete(id)
    a.resolve(result)
    changed()
    return true
  }
  return {
    list: publicList,
    ask(ctx, m, args) {
      const question = str(args?.question, 500).trim()
      const options = (Array.isArray(args?.options) ? args.options : []).filter((o) => typeof o === 'string' && o.trim()).map((o) => o.slice(0, 40)).slice(0, 6)
      if (!question || !options.length) throw bad('要有问题和至少一个选项')
      const timeout = Math.max(30, Math.min(1800, Number(args?.timeout) || 600))
      const id = crypto.randomBytes(12).toString('hex')
      return new Promise((resolve) => {
        const a = { id, plugin: m.id, pluginName: m.name, question, options, confirm: !!args?.confirm, expires: Date.now() / 1000 + timeout, resolve, test: !!ctx.test }
        a.timer = setTimeout(() => finish(id, { answered: false, reason: 'timeout' }), timeout * 1000)
        list.set(id, a)
        changed()
        // push: 'always'（agent 在等的权限询问）：手机看着也推——iOS 切到后台的页面常常连接没断、还被当成「在看」
        if (!ctx.test && (args?.push === 'always' || !hasVisibleClient?.())) notify?.({ title: `${m.name} 问你`, body: question.slice(0, 200), tag: `ask-${id}`, plugin: m.id })
      })
    },
    /** 回答：answer 是选项之一，或者（非确认类问题）text 是自由回答 */
    answer(id, answer, text = '') {
      const a = list.get(id)
      if (!a) return false
      const t = typeof text === 'string' ? text.trim().slice(0, 1000) : ''
      if (!a.options.includes(answer) && !(t && !a.confirm)) throw bad('bad answer')
      return finish(id, { answered: true, answer: a.options.includes(answer) ? answer : '', text: t })
    },
    cancel: (id) => finish(id, { answered: false, reason: 'cancelled' }),
    has: (id) => list.has(id),
  }
}

/** 同一个插件 20 秒一条、全部每小时 20 条（和 agent 的 notify_phone 一样） */
export function createLimiter(perPluginMs = 20000, hourly = 20) {
  const byPlugin = new Map()
  let recent = []
  return (id, now = Date.now()) => {
    recent = recent.filter((t) => now - t < 3600000)
    if ((byPlugin.has(id) && now - byPlugin.get(id) < perPluginMs) || recent.length >= hourly) return false
    byPlugin.set(id, now)
    recent.push(now)
    return true
  }
}

/**
 * 分发器。deps: { catalog, perms, audit, dbFor(m), shared, asks, notify, recordIncident, host?, home?(), fsDirs? }
 *   host：服务端的 HostClient（connected / call / stream）；home()：电脑上的家目录；fsDirs.get(id)：用户给插件加的目录
 * call(ctx, pluginId, method, args)：ctx = { client, test, visible(), prompt(req) }，流式调用另带 chunk(x) / callTool(name, args) / signal
 */
export function createRpc(deps) {
  const limiter = createLimiter()
  const autoSeen = new Map() // 插件自动上报的异常：每个插件每分钟最多 30 条
  async function call(ctx, pluginId, method, args) {
    const m = deps.catalog.get(pluginId)
    if (!m) throw Object.assign(new Error(`没有这个插件：${pluginId}`), { code: 'ENOPLUGIN' })
    const t0 = Date.now()
    const audit = (result, impl, error) => deps.audit.record({ plugin: m.id, method, result, impl, ms: Date.now() - t0, ...(error ? { error } : {}), ...(ctx.test ? { test: true } : {}) })
    // 插件页里未捕获的异常、console.error：平台自己报的，不走权限
    if (method === 'platform.incident.auto') return autoIncident(ctx, m, args)
    const cap = Object.hasOwn(CAPS, method) ? CAPS[method] : null
    if (!cap || cap.impl === 'none' || (cap.impl === 'mac' && !cap.run)) {
      const s = support(method)
      const why = cap?.why || (s?.impl === 'mac' ? MAC_WHY : s?.impl === 'local' ? '这个在插件页里直接用，不经过服务端' : s ? '这个平台上没有' : '没有这个 API')
      audit('unsupported', s?.impl || 'none')
      throw unsupported(method, why)
    }
    // 描述文件选了用 Mac 的（剪贴板、打开网址）：同一个能力改由 pane-host 做
    const onMac = cap.impl === 'mac' || (cap.macOpt && m.mac?.[cap.macOpt] === true)
    const impl = onMac ? 'mac' : cap.impl
    const fsDirs = deps.fsDirs?.get(m.id) || []
    let grant
    try {
      grant = typeof cap.perm === 'function' ? await cap.perm({ m, args: args ?? {}, fsDirs, home: deps.home || (async () => '') }) : cap.perm ? { perm: cap.perm, scope: cap.scope?.(args) } : null
      if (grant) await deps.perms.permit(ctx, m, grant.perm, grant.scope)
    } catch (e) {
      audit('denied', impl, e.message)
      throw e
    }
    if (impl === 'web') { audit('delegated', 'web'); return { $delegate: method } }
    const host = deps.host
    if (impl === 'mac' && !host?.connected) {
      audit('error', 'mac', 'pane-host offline')
      throw hostDown(host?.lastError)
    }
    try {
      const run = onMac && cap.impl !== 'mac' ? cap.mac : cap.run
      const value = await run({ ctx, m, args: args ?? {}, deps, host, grant, fsDirs, db: cap.perm === 'storage' ? await deps.dbFor(m) : null, shared: deps.shared.bind(m), asks: deps.asks, limiter })
      audit(value?.$delegate ? 'delegated' : 'ok', value?.$delegate ? 'web' : impl)
      return value
    } catch (e) {
      audit(e.code === 'aborted' ? 'cancelled' : 'error', impl, e.message)
      if (e.code === -32001) throw hostDown()
      throw e
    }
  }
  function autoIncident(ctx, m, args) {
    const now = Date.now()
    const seen = (autoSeen.get(m.id) || []).filter((t) => now - t < 60000)
    if (seen.length >= 30) return { dropped: true }
    autoSeen.set(m.id, [...seen, now])
    const kind = ['error', 'rejection', 'console'].includes(args?.kind) ? args.kind : 'error'
    const msg = str(args?.msg, 2000)
    if (!msg) return { dropped: true }
    const inc = deps.recordIncident?.({ test: !!ctx.test, source: 'plugin', component: `plugin:${m.id}`, kind, msg: msg.split('\n')[0], detail: str(args?.detail || msg, 6000), severity: kind === 'console' ? 'low' : 'normal', ctx: { plugin: m.id, version: m.version } })
    return { id: inc?.id || null }
  }
  return { call }
}
