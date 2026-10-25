// pane-remote 命令行的实现（入口是 bin/pane-remote，它负责挑 Node）
// 命令：安装、自检、开关模块、卸载。只用 Node 自带模块。
//
//   pane-remote init [--terminal wezterm|herdr] [--herdr-socket PATH] [--yes] [--port N] [--login 手机上的 Tailscale 登录名]   配置并启动（可以反复跑，已有的配置会保留）
//        [--skip-service]  不装后台服务（自己用别的方式跑 server/server.mjs）
//        [--skip-host]     不装 pane-host 的 LaunchAgent（不装也能用：第一次用到时会临时拉起一个，见 docs/host.md）
//        [--skip-serve]    不动 tailscale serve（自己配反向代理）
//   pane-remote doctor                    逐项自检，给出修复办法
//   pane-remote status | start | stop | restart | logs
//   pane-remote enable <模块> | disable <模块>   模块：preview（预览浏览器）、openUrl（网址转手机）、cursor（Cursor IDE）、screen（看屏幕，可加 --create-cert）、mac（这台电脑：性能、念一段话）、plugins（插件平台）
//   pane-remote uninstall [--purge]       停服务、还原 hook、撤掉 tailscale serve；--purge 连配置和数据一起删
//   pane-remote update [--check] [--yes] [--rollback]   从 git origin 安全地增量更新（见 lib/update.mjs）
//   pane-remote relay ...                 增强版：中转模式，见 docs/relay.md
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { lang, langSource, t, list } from './i18n.mjs'
import { gitSource, update } from './update.mjs'

const APP_DIR = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), '..')
const HOME = os.homedir()
const CONFIG_PATH = process.env.PANE_REMOTE_CONFIG || path.join(HOME, '.config/pane-remote/config.json')
const CONFIG_DIR = path.dirname(CONFIG_PATH)
const BRIDGE_ENV = path.join(CONFIG_DIR, 'bridge.env')
const LABEL = 'local.pane-remote.server'
const PLIST = path.join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`)
const LOG = path.join(HOME, 'Library/Logs/pane-remote.log')
const HOOK = path.join(APP_DIR, 'agent/pane-event')
// pane-host：电脑上的常驻服务（host/main.mjs，见 docs/host.md），服务端经 bridge 的 host 指令连它
const HOST_LABEL = 'local.pane-remote.host'
const HOST_PLIST = path.join(HOME, 'Library/LaunchAgents', `${HOST_LABEL}.plist`)
const HOST_DIR = process.env.PANE_HOST_DIR || path.join(HOME, '.cache/pane-remote-host')
const HOST_SOCK = path.join(HOST_DIR, 'host.sock')
const HOST_LOG = path.join(HOST_DIR, 'host.log')
const NODE = process.execPath
// 测试用：换成一个假的 launchctl，免得动到这台电脑上真的 LaunchAgent
const LAUNCHCTL = process.env.PANE_REMOTE_LAUNCHCTL || '/bin/launchctl'
const MODULES = {
  preview: t('预览浏览器（手机上看电脑这边的网页和文件，需要 Chrome）'),
  openUrl: t('网址转手机（电脑上打开链接时，人在用手机就转到手机预览）'),
  cursor: t('Cursor IDE 映射（会话、消息、待办、改动、内置浏览器；Cursor 要带调试端口启动）'),
  screen: t('看屏幕（只限 macOS：手机上看 / 操作电脑屏幕或单个窗口，走系统自带的屏幕共享）'),
  mac: t('这台电脑（只限 macOS：手机上看 CPU、内存和占用最多的进程，让电脑用自带的 say 念一段话）'),
  plugins: t('插件平台（手机上跑插件：悬浮按钮打开插件抽屉，插件放在 plugins/ 目录，见 docs/plugins.md）'),
}
const CURSOR_APP = '/Applications/Cursor.app'
// 看屏幕模块：鼠标助手 mousectl（agent/screen/install-mousectl.sh 装的 LaunchAgent）和它的 socket
const MOUSECTL_LABEL = 'local.pane-remote.mousectl'
const MOUSECTL_PLIST = path.join(HOME, 'Library/LaunchAgents', `${MOUSECTL_LABEL}.plist`)
const MOUSECTL_SOCK = path.join(HOME, '.cache/pane-remote/mouse.sock')
/** 本机有没有进程在监听这个 TCP 端口（看屏幕共享开没开）：只看监听表，不去连（连一下屏幕共享就要接一个连接、记一笔日志） */
function portListening(port) {
  const r = run('/usr/sbin/netstat', ['-anp', 'tcp'])
  return r.status === 0 && new RegExp(`[.:]${port}\\s.*LISTEN`).test(r.stdout || '')
}
/** 转码代理要的 sharp 能不能加载（install.sh 不装可选依赖，sharp 的预编译二进制在可选依赖里） */
function sharpOk() {
  return run(NODE, ['-e', "require('sharp')"], { cwd: APP_DIR }).status === 0
}
/** 按 lockfile 补装 sharp（install.sh 用 --omit=optional，sharp 的预编译二进制在可选依赖里）；返回装没装好 */
function installSharp() {
  say(c.dim('  ' + t('安装转码用的 sharp…')))
  const npm = path.join(path.dirname(NODE), 'npm')
  const r = run(exists(npm) ? npm : 'npm', ['install', '--omit=dev', '--no-save', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: APP_DIR, stdio: 'inherit', timeout: 300000, env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH || ''}` } })
  return r.status === 0 && sharpOk()
}
/** mousectl 的 socket 有没有在听 */
function mousectlUp() {
  return run(NODE, ['-e', `const c=require('net').connect(${JSON.stringify(MOUSECTL_SOCK)});c.on('connect',()=>process.exit(0));c.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500)`]).status === 0
}

const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined)
const c = { ok: (s) => `\x1b[32m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
const say = (...a) => console.log(...a)
const die = (msg) => { console.error(c.bad(`✗ ${msg}`)); process.exit(1) }
const exists = (p) => { try { fs.accessSync(p); return true } catch { return false } }
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', timeout: 20000, ...o })
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return d; throw new Error(t('{file} 不是合法的 JSON：{err}', { file: p, err: e.message })) } }
function writeFileSafe(p, content, mode = 0o600) {
  // 是软链接（比如 dotfiles 管理的 settings.json）就写到它指向的文件，不把链接换成普通文件
  try { p = fs.realpathSync(p) } catch {}
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content, { mode })
  fs.renameSync(tmp, p)
}
const tildify = (p) => (p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p)

// ---------- 找依赖 ----------
function which(name) {
  const r = run('/usr/bin/which', [name], { env: { PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` } })
  return r.status === 0 ? r.stdout.trim() : ''
}
const findWezterm = () => [which('wezterm'), '/opt/homebrew/bin/wezterm', '/usr/local/bin/wezterm', '/Applications/WezTerm.app/Contents/MacOS/wezterm'].find((p) => p && exists(p)) || ''
const findTailscale = () => [which('tailscale'), '/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find((p) => p && exists(p)) || ''
function findChrome() {
  const list = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
  return list.find(exists) || ''
}
function tailscaleInfo(ts) {
  if (!ts) return null
  const r = run(ts, ['status', '--json'])
  if (r.status !== 0) return { running: false }
  try {
    const d = JSON.parse(r.stdout)
    const self = d.Self || {}
    const user = d.User?.[self.UserID] || {}
    // 打了标签的设备（tagged）不属于任何人，LoginName 是 tagged-devices，不能当成手机那头的账号
    const tagged = !!self.Tags?.length || user.LoginName === 'tagged-devices'
    return { running: d.BackendState === 'Running', state: d.BackendState, host: (self.DNSName || '').replace(/\.$/, ''), login: tagged ? '' : user.LoginName || '', tagged, tailnet: d.CurrentTailnet?.Name || '' }
  } catch { return { running: false } }
}
function serveStatus(ts) {
  const r = run(ts, ['serve', 'status', '--json'])
  try { return JSON.parse(r.stdout || '{}') } catch { return {} }
}
/** 现在 tailscale serve 在哪个 https 端口把 / 转给了我们的端口；没有就 0 */
function servedPort(ts, port) {
  const web = serveStatus(ts).Web || {}
  for (const [hostPort, v] of Object.entries(web)) {
    const proxy = v?.Handlers?.['/']?.Proxy || ''
    if (proxy.replace(/\/$/, '') === `http://127.0.0.1:${port}`) return Number(hostPort.split(':').pop())
  }
  return 0
}
function httpsPortTaken(ts, httpsPort) {
  return Object.keys(serveStatus(ts).Web || {}).some((hp) => hp.endsWith(`:${httpsPort}`))
}

// Claude Code 的配置目录：~/.claude，以及用 CLAUDE_CONFIG_DIR 分开的 ~/.claude-xxx
function claudeProfiles() {
  return fs.readdirSync(HOME).filter((n) => /^\.claude(-[\w.-]+)?$/.test(n)).map((n) => path.join(HOME, n))
    .filter((d) => { try { return fs.statSync(d).isDirectory() && (exists(path.join(d, 'settings.json')) || exists(path.join(d, 'projects'))) } catch { return false } })
}
const wrapperFor = (dir) => (path.basename(dir) === '.claude' ? 'claude' : `CLAUDE_CONFIG_DIR="$HOME/${path.basename(dir)}" claude`)

// ---------- hook ----------
const CLAUDE_HOOKS = { Notification: 'notify', SessionStart: 'session', Stop: 'stop', StopFailure: 'failure', UserPromptSubmit: 'prompt' }
const CODEX_HOOKS = { PermissionRequest: 'permission', SessionStart: 'session', Stop: 'stop', UserPromptSubmit: 'prompt' }
const isOurs = (cmd) => typeof cmd === 'string' && cmd.includes('/agent/pane-event') && cmd.includes('pane-event')
// hook 命令会交给 shell 执行：路径用单引号包起来（里面的单引号按 '\'' 转义），$、反引号、双引号都不会被解释
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const hookCmd = (kind, agent) => `${shq(HOOK)} ${kind}${agent ? ` --agent ${agent}` : ''}`

function stripHooks(hooks) {
  let removed = 0
  for (const [ev, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) continue
    hooks[ev] = groups.map((g) => {
      const before = g.hooks?.length || 0
      const kept = (g.hooks || []).filter((h) => !isOurs(h.command))
      removed += before - kept.length
      return { ...g, hooks: kept }
    }).filter((g) => g.hooks.length)
    if (!hooks[ev].length) delete hooks[ev]
  }
  return removed
}
function backup(p) {
  if (!exists(p)) return ''
  const b = `${p}.pane-remote-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.copyFileSync(p, b)
  return b
}
/** 往一个 hook 配置文件里装上（或去掉）我们的 hook；不动别的 hook。dry = 只看会不会变，不写 */
function patchHooks(file, map, agent, install, dry = false) {
  const d = readJson(file, {})
  d.hooks = d.hooks || {}
  const removed = stripHooks(d.hooks)
  if (install) for (const [ev, kind] of Object.entries(map)) (d.hooks[ev] = d.hooks[ev] || []).push({ hooks: [{ type: 'command', command: hookCmd(kind, agent) }] })
  if (!install && !removed) return { changed: false }
  if (!Object.keys(d.hooks).length) delete d.hooks
  const next = JSON.stringify(d, null, 2) + '\n'
  if (exists(file) && fs.readFileSync(file, 'utf8') === next) return { changed: false } // 已经装好了，不重写、不再备份
  if (dry) return { changed: true }
  const b = backup(file)
  writeFileSafe(file, next, exists(file) ? fs.statSync(file).mode & 0o777 : 0o600)
  return { changed: true, backup: b }
}
/** 这个文件里有没有我们的 hook（哪怕只剩一部分） */
const hasOurHooks = (file) => Object.values(readJson(file, {}).hooks || {}).some((groups) => Array.isArray(groups) && groups.some((g) => (g.hooks || []).some((h) => isOurs(h.command))))
const hooksInstalled = (file, map) => {
  const d = readJson(file, {})
  return Object.keys(map).every((ev) => (d.hooks?.[ev] || []).some((g) => (g.hooks || []).some((h) => isOurs(h.command) && h.command.includes(HOOK))))
}

// ---------- launchd ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(NODE)}</string><string>${esc(path.join(APP_DIR, 'server/server.mjs'))}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PANE_REMOTE_CONFIG</key><string>${esc(CONFIG_PATH)}</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`
}
const uid = () => process.getuid()
const loaded = () => run(LAUNCHCTL, ['print', `gui/${uid()}/${LABEL}`]).status === 0
function startService() {
  writeFileSafe(PLIST, plist(), 0o644)
  if (loaded()) run(LAUNCHCTL, ['bootout', `gui/${uid()}/${LABEL}`])
  const r = run(LAUNCHCTL, ['bootstrap', `gui/${uid()}`, PLIST])
  if (r.status !== 0 && !loaded()) throw new Error(t('启动服务失败：{err}', { err: (r.stderr || r.stdout).trim() }))
}
function stopService() { if (loaded()) run(LAUNCHCTL, ['bootout', `gui/${uid()}/${LABEL}`]) }

// ---------- pane-host 的 LaunchAgent ----------
// KeepAlive 只在异常退出时重启：已经有一个 pane-host 在跑（比如连接器临时拉起的）时，新起的这个会正常退出，不会被反复拉起
function hostPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${HOST_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(NODE)}</string><string>${esc(path.join(APP_DIR, 'host/main.mjs'))}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PANE_REMOTE_CONFIG</key><string>${esc(CONFIG_PATH)}</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(HOST_LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(HOST_LOG)}</string>
</dict>
</plist>
`
}
const hostLoaded = () => run(LAUNCHCTL, ['print', `gui/${uid()}/${HOST_LABEL}`]).status === 0
/** 问一下 pane-host（经它的 unix socket 发 ping），返回 {pid, uptime, …}，不在就是 null */
function hostPing() {
  const code = `const c=require('net').connect(${JSON.stringify(HOST_SOCK)});let b='';c.on('connect',()=>c.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})+'\\n'));c.on('data',(d)=>{b+=d;const i=b.indexOf('\\n');if(i>=0){process.stdout.write(b.slice(0,i));process.exit(0)}});c.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000)`
  const r = run(NODE, ['-e', code])
  if (r.status !== 0) return null
  try { return JSON.parse(r.stdout).result || null } catch { return null }
}
function startHost() {
  fs.mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 })
  // 连接器临时拉起的 pane-host 还在跑：先按它报的 PID 结束，不然 launchd 起的那个看到 socket 被占会直接退出
  const p = !hostLoaded() && hostPing()
  if (p?.pid) try { process.kill(p.pid, 'SIGTERM') } catch {}
  writeFileSafe(HOST_PLIST, hostPlist(), 0o644)
  if (hostLoaded()) run(LAUNCHCTL, ['bootout', `gui/${uid()}/${HOST_LABEL}`])
  const r = run(LAUNCHCTL, ['bootstrap', `gui/${uid()}`, HOST_PLIST])
  if (r.status !== 0 && !hostLoaded()) throw new Error(t('启动 pane-host 失败：{err}', { err: (r.stderr || r.stdout).trim() }))
}
function stopHost() {
  if (hostLoaded()) run(LAUNCHCTL, ['bootout', `gui/${uid()}/${HOST_LABEL}`])
  // 没有 LaunchAgent 时可能有连接器临时拉起的：按它报的 PID 结束
  else { const p = hostPing(); if (p?.pid) try { process.kill(p.pid, 'SIGTERM') } catch {} }
}
/** 代码更新后让 pane-host 换成新版：LaunchAgent 管的就 kickstart，临时拉起的结束掉（下次用到时连接器会再拉起） */
function restartHost() {
  if (hostLoaded()) run(LAUNCHCTL, ['kickstart', '-k', `gui/${uid()}/${HOST_LABEL}`])
  else stopHost()
}
// 预览用的 Chrome 脱离服务单独跑（服务重启时标签页和登录状态都留着），平时由服务在没人用 20 分钟后关掉；
// 服务停了这个回收也就没了，所以 stop 时顺手关。下次用预览会自动再开
function stopPreview() {
  const r = run(path.join(APP_DIR, 'agent/bridge'), [], { env: { ...process.env, SSH_ORIGINAL_COMMAND: 'preview-stop', PANE_REMOTE_BRIDGE_ENV: BRIDGE_ENV } })
  if (r.stdout?.startsWith('stopped')) say(`${c.ok('✓')} ${t('关掉预览用的 Chrome')}`)
}
const restartService = () => { if (loaded()) run(LAUNCHCTL, ['kickstart', '-k', `gui/${uid()}/${LABEL}`]); else startService() }

// 用和 tailscale serve 一样的请求头直接问本机服务，确认它活着、鉴权配置对
// fetch 会忽略自定义的 Host 头，这里用 http.request 才能带上
function probe(cfg) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: cfg.port, path: '/api/config', timeout: 3000,
      headers: { 'tailscale-user-login': cfg.allowedLogins?.[0] || '', host: cfg.serveHosts?.[0] || 'localhost' } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', () => resolve(0))
    req.on('timeout', () => { req.destroy(); resolve(0) })
    req.end()
  })
}

const MUX_DEFAULT = path.join(HOME, '.local/share/wezterm/sock')
const isSocket = (p) => { try { return fs.statSync(p).isSocket() } catch { return false } }

// ---------- 配置 ----------
function bridgeEnvText(cfg) {
  const backend = cfg.terminalBackend || 'wezterm'
  if (!['wezterm', 'herdr'].includes(backend)) throw new Error('terminalBackend must be wezterm or herdr')
  const socket = cfg.paths?.herdrSocket || path.join(HOME, '.config/herdr/herdr.sock')
  if (backend === 'herdr' && !path.isAbsolute(socket)) throw new Error('paths.herdrSocket must be an absolute path')
  const lines = [`TERMINAL_BACKEND=${backend}`, `WEZTERM=${cfg.paths?.wezterm || ''}`, `NODE=${NODE}`]
  if (backend === 'herdr') lines.push(`HERDR_SOCKET=${socket}`)
  if (cfg.paths?.chrome) lines.push(`CHROME=${cfg.paths.chrome}`)
  if (cfg.paths?.muxSocket) lines.push(`MUX_SOCK=${cfg.paths.muxSocket}`)
  for (const l of lines) if (/[\n\r]/.test(l)) throw new Error(t('路径里不能有换行'))
  return lines.join('\n') + '\n'
}
function writeBridgeEnv(cfg) { writeFileSafe(BRIDGE_ENV, bridgeEnvText(cfg)); linkWithTools() }

// agent 工具（agent/plugin，见 docs/agent.md）：手机上新开 / 重启 agent 时，服务端在 pane 里敲的是这个固定路径
// （中转模式下服务端不知道仓库在 Mac 上哪），链接到仓库里的 with-tools。和 bridge.env 一样是电脑这边的设置
const WITH_TOOLS_LINK = path.join(HOME, '.local/share/pane-remote/with-tools')
const WITH_TOOLS_SRC = path.join(APP_DIR, 'agent/plugin/bin/with-tools')
const withToolsLinked = () => { try { return fs.readlinkSync(WITH_TOOLS_LINK) === WITH_TOOLS_SRC } catch { return false } }
function linkWithTools(dry = false) {
  if (withToolsLinked()) return false
  if (dry) return true
  fs.mkdirSync(path.dirname(WITH_TOOLS_LINK), { recursive: true })
  // 只替换我们自己的软链接（比如仓库搬了家），同名的普通文件不动
  try { if (fs.lstatSync(WITH_TOOLS_LINK).isSymbolicLink()) fs.unlinkSync(WITH_TOOLS_LINK); else return false } catch {}
  fs.symlinkSync(WITH_TOOLS_SRC, WITH_TOOLS_LINK)
  return true
}

async function ask(q, def = true) {
  if (flag('--yes') || !process.stdin.isTTY) return def
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const a = (await rl.question(`${q} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
  rl.close()
  return a ? a.startsWith('y') : def
}

// ---------- init ----------
async function init() {
  if (process.platform !== 'darwin') die(t('目前只支持 macOS'))
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) die(t('Node 版本太旧（{v}），需要 20 以上；用 install.sh 会自动装好', { v: process.versions.node }))
  if (!exists(path.join(APP_DIR, 'node_modules/ws'))) die(t('依赖没装：先在仓库目录跑 ./install.sh（或 npm ci --omit=dev）'))
  if (!exists(path.join(APP_DIR, 'public/index.html'))) die(t('前端没构建：仓库里缺 public/，重新拉一下代码'))

  const prev = readJson(CONFIG_PATH, {})
  const backend = opt('--terminal') || prev.terminalBackend || 'wezterm'
  if (!['wezterm', 'herdr'].includes(backend)) die('--terminal: wezterm | herdr')
  const herdrSocket = opt('--herdr-socket') || prev.paths?.herdrSocket || path.join(HOME, '.config/herdr/herdr.sock')
  if (backend === 'herdr' && (!path.isAbsolute(herdrSocket) || /[\r\n]/.test(herdrSocket))) die('--herdr-socket must be an absolute path without newlines')
  say(c.b('\n' + t('1/5 检查依赖')))
  const wezterm = findWezterm()
  const ts = findTailscale()
  const chrome = findChrome()
  const missing = []
  if (backend === 'herdr') say(`  ${c.ok('✓')} Herdr  ${c.dim(herdrSocket)}`)
  else say(wezterm ? `  ${c.ok('✓')} WezTerm  ${c.dim(wezterm)}` : `  ${c.bad('✗')} ${t('WezTerm 没装')}`), wezterm || missing.push('wezterm')
  say(ts ? `  ${c.ok('✓')} Tailscale ${c.dim(ts)}` : `  ${c.bad('✗')} ${t('Tailscale 没装')}`), ts || missing.push('tailscale-app')
  say(chrome ? `  ${c.ok('✓')} Chrome   ${c.dim(chrome)}` : `  ${c.warn('!')} ${t('没找到 Chrome：预览浏览器模块会先关掉（装了 Chrome 后 pane-remote enable preview）')}`)
  say(exists('/usr/bin/python3') ? `  ${c.ok('✓')} python3` : `  ${c.bad('✗')} ${t('没有 /usr/bin/python3（装 Xcode 命令行工具：xcode-select --install）')}`)
  if (missing.length) die(t('缺 {missing}：跑 ./install.sh 会用 Homebrew 装好，或者手动 brew install --cask {casks}', { missing: list(missing), casks: missing.join(' ') }))
  if (!exists('/usr/bin/python3')) die(t('缺 python3'))

  const tsi = tailscaleInfo(ts)
  if (!tsi?.running) die(t('Tailscale 没登录或没在运行（{state}）：打开 Tailscale 登录后再跑一次', { state: tsi?.state || t('未知') }))
  if (!tsi.host) die(t('拿不到这台电脑在 tailnet 里的主机名：在 Tailscale 管理后台打开 MagicDNS 和 HTTPS 证书'))
  // 允许访问的账号 = 手机上登录的 Tailscale 账号。默认就是这台电脑登录的账号（同一个人的手机和电脑）
  let login = opt('--login') || tsi.login
  if (!login) {
    if (flag('--yes') || !process.stdin.isTTY) die(t('这台电脑是标签设备（tagged），看不出是谁的：用 --login <你手机上 Tailscale 的登录名> 指定'))
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    login = (await rl.question('  ' + t('这台电脑是标签设备，请输入你手机上 Tailscale 的登录名：'))).trim()
    rl.close()
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(login) && !/^[\w.-]+@?[\w.-]*$/.test(login)) die(t('登录名看着不对：{login}', { login }))
  say(`  ${c.ok('✓')} ${t('Tailscale 已登录  {host}；允许 {login} 访问', { host: c.dim(tsi.host), login: c.b(login) })}`)

  say(c.b('\n' + t('2/5 写配置')))
  const profiles = claudeProfiles()
  const cfg = {
    ...prev,
    mode: 'local',
    terminalBackend: backend,
    port: Number(opt('--port')) || prev.port || 8787,
    allowedLogins: [...new Set([...(prev.allowedLogins || []).filter((l) => l !== 'tagged-devices'), login])],
    serveHosts: [...new Set([...(prev.serveHosts || []), tsi.host])],
    modules: { preview: !!chrome, openUrl: false, plugins: true, ...(prev.modules || {}) },
    presets: prev.presets || [
      ...(which('claude') || profiles.length ? [{ label: 'Claude Code', command: 'claude' }] : []),
      ...(which('codex') ? [{ label: 'Codex', command: 'codex' }] : []),
    ],
    claudeWrappers: { ...Object.fromEntries(profiles.map((d) => [path.basename(d), wrapperFor(d)])), ...(prev.claudeWrappers || {}) },
    // 配了 WezTerm 持久化（unix domain）就直接连 mux server，窗口关了也能用（docs/advanced.md）
    paths: { ...(prev.paths || {}), herdrSocket, wezterm, chrome: chrome || prev.paths?.chrome || '', muxSocket: prev.paths?.muxSocket || (isSocket(MUX_DEFAULT) ? MUX_DEFAULT : '') },
  }
  if (!chrome) cfg.modules.preview = false
  // 显式指定的语言（--lang / PANE_REMOTE_LANG）记下来；自动检测的不写，已有的 lang 由 ...prev 保留
  if (langSource === 'flag' || langSource === 'env') cfg.lang = lang
  // 记下更新来源（https 的 origin 和分支），pane-remote update 只认它，origin 被改掉就拒绝更新
  if (!cfg.updateSource) { const src = gitSource(APP_DIR); if (src) cfg.updateSource = src }
  writeFileSafe(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n')
  writeBridgeEnv(cfg)
  say(`  ${c.ok('✓')} ${tildify(CONFIG_PATH)}`)
  say(`    ${t('只允许 {logins} 访问；要加别的账号就编辑 allowedLogins', { logins: list(cfg.allowedLogins) })}`)

  say(c.b('\n' + t('3/5 装 hook（让手机知道 Claude / Codex 什么时候做完、什么时候在等你）')))
  if (!profiles.length) say(`  ${c.warn('!')} ${t('没找到 Claude Code 的配置目录（~/.claude*）；装好 Claude Code 后再跑一次 init')}`)
  for (const d of profiles) {
    const f = path.join(d, 'settings.json')
    const r = patchHooks(f, CLAUDE_HOOKS, '', true)
    say(`  ${c.ok('✓')} ${tildify(f)}${r.backup ? c.dim(t('（原文件备份：{file}）', { file: path.basename(r.backup) })) : ''}`)
  }
  const codexHooks = path.join(HOME, '.codex/hooks.json')
  if (exists(path.join(HOME, '.codex'))) {
    if (await ask('  ' + t('发现 Codex：也给它装 hook 吗？（装完要在 Codex 里确认信任这些 hook 才生效）'))) {
      const r = patchHooks(codexHooks, CODEX_HOOKS, 'codex', true)
      say(`  ${c.ok('✓')} ${tildify(codexHooks)}${r.backup ? c.dim(t('（备份：{file}）', { file: path.basename(r.backup) })) : ''}`)
    }
  }
  say(c.dim('  ' + t('已经开着的 Claude 会话要重开一次才会用上新 hook')))

  say(c.b('\n' + t('4/5 启动服务')))
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  if (flag('--skip-service')) say(c.dim('  ' + t('跳过（--skip-service）：自己运行 {cmd}', { cmd: `PANE_REMOTE_CONFIG=${tildify(CONFIG_PATH)} node server/server.mjs` })))
  else startService()
  let status = 0
  for (let i = 0; i < 20 && status !== 200; i++) { await new Promise((r) => setTimeout(r, 300)); status = await probe(cfg) }
  if (status !== 200 && flag('--skip-service')) say(`  ${c.warn('!')} ${t('服务现在没响应（{status}），启动后跑 pane-remote doctor 确认', { status: status || t('连不上') })}`)
  else if (status !== 200) die(t('服务没起来（{status}），看日志：{cmd}', { status: status || t('连不上'), cmd: `tail -50 ${tildify(LOG)}` }))
  if (status === 200) say(`  ${c.ok('✓')} ${t('服务在 127.0.0.1:{port}', { port: cfg.port })}${flag('--skip-service') ? '' : t('（开机自动启动，日志 {log}）', { log: tildify(LOG) })}`)
  if (flag('--skip-host')) say(c.dim('  ' + t('跳过 pane-host 的 LaunchAgent（--skip-host）：用到时会临时拉起一个')))
  else {
    startHost()
    let hp = null
    for (let i = 0; i < 10 && !hp; i++) { await new Promise((r) => setTimeout(r, 300)); hp = hostPing() }
    hp ? say(`  ${c.ok('✓')} ${t('pane-host 在运行（开机自动启动，日志 {log}）', { log: tildify(HOST_LOG) })}`) : say(`  ${c.warn('!')} ${t('pane-host 没响应，看日志：{cmd}', { cmd: `tail -50 ${tildify(HOST_LOG)}` })}`)
  }

  say(c.b('\n' + t('5/5 用 tailscale serve 发布到你的 tailnet')))
  let httpsPort = servedPort(ts, cfg.port)
  if (flag('--skip-serve')) {
    httpsPort = httpsPort || 443
    say(c.dim('  ' + t('跳过（--skip-serve）：自己执行 {cmd}', { cmd: `tailscale serve --bg --https=443 http://127.0.0.1:${cfg.port}` })))
  } else if (!httpsPort) {
    httpsPort = httpsPortTaken(ts, 443) ? 8443 : 443
    if (httpsPortTaken(ts, httpsPort)) die(t('tailscale serve 的 443 和 8443 都被别的服务占了；手动选个端口：{cmd}', { cmd: `tailscale serve --bg --https=<${t('端口')}> http://127.0.0.1:${cfg.port}` }))
    if (httpsPort !== 443) say(`  ${c.warn('!')} ${t('443 已经被别的服务用了，改用 {port}', { port: httpsPort })}`)
    const r = run(ts, ['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${cfg.port}`])
    if (r.status !== 0) die(t('tailscale serve 失败：{err}\n  常见原因：tailnet 没开 HTTPS 证书（管理后台 DNS 页面打开 HTTPS Certificates）', { err: (r.stderr || r.stdout).trim() }))
  }
  const url = `https://${tsi.host}${httpsPort === 443 ? '' : `:${httpsPort}`}/`
  say(`  ${c.ok('✓')} ${url}`)

  say(c.b('\n' + t('装好了。手机上：')))
  say(`  1. ${t('装 Tailscale（App Store 搜 Tailscale），登录 {login}', { login: c.b(login) })}`)
  say(`  2. ${t('Safari 打开 {url}', { url: c.b(url) })}`)
  say(`  3. ${t('分享 → 添加到主屏幕（推送通知只在主屏幕打开的网页里能用）')}`)
  const qr = which('qrencode')
  if (qr) spawnSync(qr, ['-t', 'ANSIUTF8', url], { stdio: 'inherit' })
  say(c.dim('\n' + t('有问题跑 pane-remote doctor。可选模块：pane-remote enable openUrl（网址转手机）')))
}

// ---------- doctor ----------
// WezTerm GUI / mux 进程的环境里是否带着让 Claude 不写会话记录的变量（ps eww 读得到自己用户的进程环境）
const CLAUDE_OFF_VARS = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY']
function claudeEnvInWezterm() {
  const found = []
  for (const proc of ['wezterm-gui', 'wezterm-mux-server']) {
    const pids = (run('/usr/bin/pgrep', ['-f', `(^|/)${proc}( |$)`]).stdout || '').split('\n').filter((x) => /^\d+$/.test(x))
    for (const pid of pids) {
      const cmd = run('/bin/ps', ['eww', '-o', 'command=', '-p', pid]).stdout || ''
      const vars = CLAUDE_OFF_VARS.filter((v) => new RegExp(`(^|\\s)${v}=`).test(cmd))
      if (vars.length) found.push({ proc, pid, vars })
    }
  }
  return found
}
async function doctor() {
  let bad = 0
  const fails = []
  // 给 pane-remote update 用：把失败项写进这个文件，更新前后对比
  const report = () => { if (process.env.PANE_REMOTE_DOCTOR_OUT) try { fs.writeFileSync(process.env.PANE_REMOTE_DOCTOR_OUT, JSON.stringify({ fails })) } catch {} }
  const ok = (m) => say(`  ${c.ok('✓')} ${m}`)
  const fail = (m, fix) => { bad++; fails.push(m); say(`  ${c.bad('✗')} ${m}${fix ? `\n      ${c.dim('→ ' + fix)}` : ''}`) }
  const warn = (m, fix) => say(`  ${c.warn('!')} ${m}${fix ? `\n      ${c.dim('→ ' + fix)}` : ''}`)
  say(c.b(t('pane-remote 自检')))
  const cfg = readJson(CONFIG_PATH, null)
  if (!cfg) { fail(t('没有配置文件 {file}', { file: tildify(CONFIG_PATH) }), t('跑 pane-remote init')); report(); return process.exit(1) }
  ok(t('配置 {file}（{mode} 模式）', { file: tildify(CONFIG_PATH), mode: cfg.mode }))
  Number(process.versions.node.split('.')[0]) >= 20 ? ok(`Node ${process.versions.node}`) : fail(t('Node {v} 太旧', { v: process.versions.node }), t('需要 20 以上'))
  exists(path.join(APP_DIR, 'node_modules/ws')) ? ok(t('依赖已装')) : fail(t('依赖没装'), `cd ${tildify(APP_DIR)} && npm ci --omit=dev`)
  cfg.allowedLogins?.length ? ok(t('允许访问：{logins}', { logins: list(cfg.allowedLogins) })) : fail(t('allowedLogins 是空的，谁都进不来'), t('跑 pane-remote init'))

  const backend = cfg.terminalBackend || 'wezterm'
  const name = backend === 'herdr' ? 'Herdr' : 'WezTerm'
  const wez = cfg.paths?.wezterm
  if (!['wezterm', 'herdr'].includes(backend)) fail('Unknown terminalBackend', 'Use wezterm or herdr')
  else if (backend === 'wezterm' && (!wez || !exists(wez))) fail(t('找不到 wezterm'), t('brew install --cask wezterm，然后 pane-remote init'))
  else {
    const env = { ...process.env, SSH_ORIGINAL_COMMAND: 'list', PANE_REMOTE_BRIDGE_ENV: BRIDGE_ENV }
    const r = run(path.join(APP_DIR, 'agent/bridge'), [], { env })
    if (r.status === 0) { try { ok(`${name}: ${JSON.parse(r.stdout).length} pane(s)`) } catch { fail(`${name}: invalid pane list`, r.stdout.slice(0, 200)) } }
    else fail(`${name}: ${(r.stderr || '').trim().split('\n').pop()}`, backend === 'herdr' ? 'Start the configured Herdr session; check paths.herdrSocket, then pane-remote refresh bridge-env' : t('先打开 WezTerm 窗口（或配置持久化 mux，见 docs/advanced.md）'))
  }
  // WezTerm 本身（或 mux）的环境里带着这两个变量，里面开的每个 Claude 都不写会话记录，手机上出不了对话视图
  for (const w of backend === 'wezterm' ? claudeEnvInWezterm() : []) {
    warn(t('{proc}（pid {pid}）的环境里有 {vars}：在里面开的 Claude 不写会话记录，手机上只能看终端', { proc: w.proc, pid: w.pid, vars: list(w.vars) }),
      w.vars.includes('CLAUDE_CODE_SKIP_PROMPT_HISTORY')
        ? t('从 shell 配置（~/.zshrc 等）或 launchctl 环境里去掉 CLAUDE_CODE_SKIP_PROMPT_HISTORY，再 ⌘Q 退出 WezTerm、从程序坞重新打开')
        : w.proc === 'wezterm-gui'
          ? t('WezTerm 是在某个 Claude 会话里启动的：⌘Q 退出 WezTerm，从程序坞或访达重新打开；或者在 pane 里先执行 unset CLAUDE_CODE_CHILD_SESSION')
          : t('mux 是在某个 Claude 会话里启动的：在普通终端里先 unset CLAUDE_CODE_CHILD_SESSION，再重启 mux'))
  }
  exists('/usr/bin/python3') ? ok('python3') : fail(t('没有 /usr/bin/python3'), 'xcode-select --install')
  if (exists(BRIDGE_ENV)) withToolsLinked() ? ok(t('agent 工具：{path}', { path: tildify(WITH_TOOLS_LINK) })) : warn(t('agent 工具没链接好，手机上新开 agent 时注入会失败'), 'pane-remote refresh bridge-env')

  if (cfg.mode === 'local') {
    const ts = findTailscale()
    const tsi = tailscaleInfo(ts)
    if (!tsi?.running) fail(t('Tailscale 没在运行或没登录'), t('打开 Tailscale 登录'))
    else {
      ok(t('Tailscale：{who}  {host}', { who: tsi.tagged ? t('标签设备') : tsi.login, host: c.dim(tsi.host) }))
      if (!cfg.serveHosts?.includes(tsi.host)) fail(t('这台电脑的 tailnet 主机名 {host} 不在 serveHosts 里（换过名字？）', { host: tsi.host }), t('跑 pane-remote init'))
      const p = servedPort(ts, cfg.port)
      p ? ok(`tailscale serve：https://${tsi.host}${p === 443 ? '' : ':' + p}/`) : fail(t('tailscale serve 没指向本服务'), t('跑 pane-remote init'))
    }
    loaded() ? ok(t('后台服务已加载（launchd）')) : fail(t('后台服务没加载'), 'pane-remote start')
    const st = await probe(cfg)
    st === 200 ? ok(t('服务正常响应（127.0.0.1:{port}）', { port: cfg.port })) : fail(t('服务没响应（{status}）', { status: st || t('连不上') }), t('看日志：{cmd}', { cmd: `tail -50 ${tildify(LOG)}` }))
  }

  const profiles = claudeProfiles()
  for (const d of profiles) {
    const f = path.join(d, 'settings.json')
    hooksInstalled(f, CLAUDE_HOOKS) ? ok(t('hook 已装：{file}', { file: tildify(f) })) : fail(t('hook 没装全：{file}', { file: tildify(f) }), t('跑 pane-remote init'))
  }
  // pane-host：不在线也能用（对话、事件走 bridge 老路），只是插件的 AI、电脑剪贴板、只读文件用不了
  if (cfg.paneHost !== false) {
    const hp = hostPing()
    if (hp) ok(t('pane-host 在运行（pid {pid}，{n} 秒）{how}', { pid: hp.pid, n: hp.uptime, how: hostLoaded() ? '' : t('，临时拉起的，没装 LaunchAgent') }))
    else if (hostLoaded()) warn(t('pane-host 的 LaunchAgent 装了但没响应'), t('看日志：{cmd}', { cmd: `tail -50 ${tildify(HOST_LOG)}` }))
    else warn(t('pane-host 没在运行（用到时会临时拉起；装成常驻：pane-remote init）'))
  }
  if (cfg.modules?.plugins !== false) {
    exists(path.join(APP_DIR, 'node_modules/@whatevertools/core')) ? ok(t('插件平台：依赖已装')) : fail(t('插件平台：依赖没装'), `cd ${tildify(APP_DIR)} && npm ci --omit=dev`)
  }
  const ev = path.join(HOME, '.local/state/pane-remote/events.jsonl')
  if (exists(ev)) ok(t('hook 有在记录事件（最近 {min} 分钟前）', { min: Math.round((Date.now() - fs.statSync(ev).mtimeMs) / 60000) }))
  else warn(t('还没收到过 hook 事件'), t('在 WezTerm 里开一个新的 Claude 会话、发一句话试试'))

  if (cfg.modules?.preview) {
    cfg.paths?.chrome && exists(cfg.paths.chrome) ? ok(t('预览浏览器：{path}', { path: tildify(cfg.paths.chrome) })) : fail(t('预览模块开着但找不到 Chrome'), t('装 Chrome 后跑 pane-remote init，或 pane-remote disable preview'))
  }
  if (cfg.modules?.cursor) {
    if (!exists(CURSOR_APP)) fail(t('Cursor 模块开着但没装 Cursor'), 'pane-remote disable cursor')
    else {
      let up = false
      try { up = (await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(1500) })).ok } catch {}
      up ? ok(t('Cursor 已带调试端口运行，可以接入')) : warn(t('Cursor 没有带调试端口运行'), t('在手机的 Cursor 页面点「启动 Cursor」或「重启并接入」'))
    }
  }
  if (cfg.modules?.screen) {
    if (process.platform !== 'darwin') fail(t('看屏幕模块只支持 macOS'), 'pane-remote disable screen')
    else {
      sharpOk() ? ok(t('看屏幕：sharp 能加载')) : fail(t('看屏幕：sharp 加载不了'), `cd ${tildify(APP_DIR)} && npm install --omit=dev --no-save`)
      portListening(5900) ? ok(t('看屏幕：屏幕共享已开（127.0.0.1:5900）')) : fail(t('看屏幕：屏幕共享没开'), t('系统设置 → 通用 → 共享 → 屏幕共享'))
      mousectlUp() ? ok(t('看屏幕：mousectl 在运行')) : fail(t('看屏幕：mousectl 没在运行'), t('跑 pane-remote enable screen 重装；还不行看 {log}', { log: '~/.cache/pane-remote/mousectl.log' }))
    }
  }
  if (cfg.modules?.mac) {
    if (process.platform !== 'darwin') fail(t('mac 模块只支持 macOS'), 'pane-remote disable mac')
    else {
      const miss = ['/usr/bin/top', '/usr/bin/say', '/usr/bin/osascript', '/usr/bin/memory_pressure'].filter((f) => !exists(f))
      miss.length ? fail(t('mac 模块：缺系统命令 {list}', { list: list(miss) }), t('这些是 macOS 自带的，系统可能不完整')) : ok(t('mac 模块：性能和念一段话要用的系统命令都在'))
    }
  }
  if (cfg.modules?.openUrl) {
    const link = openLinkPath()
    link && exists(link) ? ok(t('网址转手机：{path}', { path: tildify(link) })) : fail(t('网址转手机开着但没装好'), 'pane-remote enable openUrl')
  }
  // 有没有新版本：只看上次拉取（pane-remote update / git fetch）的结果，不联网
  const src = cfg.updateSource
  if (src?.branch && /^[\w./-]+$/.test(src.branch)) {
    const r = run('git', ['-C', APP_DIR, 'rev-list', '--count', `HEAD..refs/remotes/origin/${src.branch}`])
    const n = r.status === 0 ? Number(r.stdout.trim()) : 0
    if (n > 0) warn(t('有新版本（上次拉取时多了 {n} 个提交）', { n }), 'pane-remote update')
  }
  report()
  say(bad ? c.bad('\n' + t('{n} 项有问题', { n: bad })) : c.ok('\n' + t('全部正常')))
  process.exit(bad ? 1 : 0)
}

// ---------- 模块 ----------
const OPEN_TARGET = path.join(APP_DIR, 'agent/open')
/** 这个路径是不是指向我们自己的 agent/open 的软链接（完整比较解析后的路径） */
function isOurOpenLink(link) {
  try { return fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(OPEN_TARGET) } catch { return false }
}
// 网址转手机：把 agent/open 链接成 PATH 里排在 /usr/bin 前面的 open
function openLinkPath() {
  const dirs = (process.env.PATH || '').split(':')
  const usr = dirs.indexOf('/usr/bin')
  const cand = [path.join(HOME, '.local/bin'), path.join(HOME, 'bin')].find((d) => dirs.indexOf(d) >= 0 && (usr < 0 || dirs.indexOf(d) < usr))
  return cand ? path.join(cand, 'open') : ''
}
async function setModule(name, on) {
  if (!MODULES[name]) die(t('没有这个模块：{name}。可选：{list}', { name, list: list(Object.keys(MODULES)) }))
  const cfg = readJson(CONFIG_PATH, null) || die(t('先跑 pane-remote init'))
  if (name === 'preview' && on) {
    const chrome = findChrome()
    if (!chrome) die(t('没找到 Chrome：装 Google Chrome（brew install --cask google-chrome）'))
    cfg.paths = { ...cfg.paths, chrome }
    writeBridgeEnv(cfg)
  }
  if (name === 'cursor' && on) {
    if (!exists(CURSOR_APP)) die(t('没找到 Cursor（/Applications/Cursor.app）'))
    say(c.dim('  ' + t('Cursor 要带调试端口（只监听本机 127.0.0.1:9333）启动才能接入：')))
    say(c.dim('  · ' + t('Cursor 没开时，手机上点「启动 Cursor」或新建会话会自动带端口启动')))
    say(c.dim('  · ' + t('Cursor 已经用普通方式开着时，手机上会提示「重启并接入」，你确认后它会正常退出再重开（有没保存的内容 Cursor 会先问你）')))
    say(c.dim('  · ' + t('调试端口能完全控制 Cursor：只在只有你自己用的电脑上开')))
    let sqlite = false
    try { await import('node:sqlite'); sqlite = true } catch {}
    if (!sqlite) say(`  ${c.warn('!')} ${t('当前 Node（{v}）没有 node:sqlite，看不到完整历史消息，只有实时画面里的内容；换 Node 22.13 以上再跑 pane-remote init', { v: process.version })}`)
  }
  if (name === 'screen' && on) {
    if (process.platform !== 'darwin') die(t('看屏幕模块只支持 macOS'))
    if (!which('swiftc')) die(t('没有 swiftc：先装 Xcode 命令行工具（xcode-select --install）'))
    if (!sharpOk() && !installSharp()) die(t('sharp 装不上：在 {dir} 里跑 npm install --omit=dev 看看报错', { dir: tildify(APP_DIR) }))
    const args = flag('--create-cert') ? ['--create-cert'] : []
    const r = run('/bin/bash', [path.join(APP_DIR, 'agent/screen/install-mousectl.sh'), ...args], { stdio: 'inherit', timeout: 300000 })
    if (r.status !== 0) die(t('mousectl 没装好（看上面的输出）'))
    say(`  ${c.ok('✓')} ${t('mousectl 已装成后台常驻（{label}）', { label: MOUSECTL_LABEL })}`)
    say(c.dim('  ' + t('还要你在电脑上手动做几步：')))
    say(c.dim('  1. ' + t('打开 系统设置 → 通用 → 共享 → 屏幕共享（「允许访问」只留你自己的账号）')))
    say(c.dim('  2. ' + t('系统设置 → 隐私与安全性 → 辅助功能：打开 mousectl（点、拖、打字要用）')))
    say(c.dim('  3. ' + t('系统设置 → 隐私与安全性 → 屏幕与系统录音：打开 mousectl（按窗口看要用）')))
    if (!args.length) say(c.dim('  ' + t('可选：pane-remote enable screen --create-cert 建一张本机自签名证书给 mousectl 签名，以后更新重编时授权不会掉（建好后要再授权一次）')))
    say(c.dim('  ' + t('手机上点顶栏的屏幕图标，用电脑的用户名和密码登录（密码在手机上加密，服务端看不到）')))
  }
  if (name === 'mac' && on) {
    if (process.platform !== 'darwin') die(t('mac 模块只支持 macOS'))
    say(c.dim('  ' + t('手机上点顶栏的仪表盘图标：看 CPU、内存、占用最多的进程（只在面板开着时每 5 秒采一次）；「念出来」用电脑的扬声器念一段话')))
    say(c.dim('  ' + t('念的时候可以临时改音量，念完调回原来的音量')))
  }
  if (name === 'screen' && !on && exists(MOUSECTL_PLIST)) {
    run(LAUNCHCTL, ['bootout', `gui/${uid()}/${MOUSECTL_LABEL}`])
    try { fs.unlinkSync(MOUSECTL_PLIST) } catch {}
    say(`  ${c.ok('✓')} ${t('停掉并移除 mousectl')}`)
  }
  if (name === 'openUrl') {
    const link = openLinkPath()
    if (on) {
      if (!link) die(t('PATH 里没有排在 /usr/bin 前面的 ~/.local/bin 或 ~/bin：先在 ~/.zshrc 里加 {line}，开个新终端再试', { line: 'export PATH="$HOME/.local/bin:$PATH"' }))
      let taken = false
      try { fs.lstatSync(link); taken = true } catch {}
      if (taken && !isOurOpenLink(link)) die(t('{path} 已经被别的东西占用了，不覆盖（自己处理掉再试）', { path: tildify(link) }))
      fs.mkdirSync(path.dirname(link), { recursive: true })
      try { fs.unlinkSync(link) } catch {}
      fs.symlinkSync(OPEN_TARGET, link)
      say(`  ${c.ok('✓')} ${tildify(link)} → agent/open`)
      say(c.dim('  ' + t('想让 Claude 等程序打开网页时也转过来，在 ~/.zshrc 里加：{line}', { line: 'export BROWSER="' + path.join(APP_DIR, 'agent/pane-open') + '"' })))
    } else if (link && isOurOpenLink(link)) {
      fs.unlinkSync(link)
      say(`  ${c.ok('✓')} ${t('去掉了 {path}', { path: tildify(link) })}`)
    }
  }
  cfg.modules = { ...cfg.modules, [name]: on }
  writeFileSafe(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n')
  if (loaded()) restartService()
  say(`${c.ok('✓')} ${on ? t('{module}：已开启', { module: MODULES[name] }) : t('{module}：已关闭', { module: MODULES[name] })}`)
}

// ---------- refresh（pane-remote update 内部用：用当前这一版的代码重做 hook / bridge.env）----------
function refresh(what) {
  const dry = flag('--dry-run')
  const mark = dry ? c.dim(t('（预演，没写）')) : ''
  if (what === 'hooks') {
    // 只动已经装过我们 hook 的文件：用户自己去掉的不加回来
    const files = [...claudeProfiles().map((d) => [path.join(d, 'settings.json'), CLAUDE_HOOKS, '']), [path.join(HOME, '.codex/hooks.json'), CODEX_HOOKS, 'codex']]
    let n = 0
    for (const [f, map, agent] of files) {
      if (!exists(f) || !hasOurHooks(f)) continue
      n++
      const r = patchHooks(f, map, agent, true, dry)
      say(`  ${c.ok('✓')} ${tildify(f)}  ${r.changed ? t('已更新') + mark : c.dim(t('没变化'))}${r.backup ? c.dim(t('（原文件备份：{file}）', { file: path.basename(r.backup) })) : ''}`)
    }
    if (!n) say(c.dim('  ' + t('没有装过 hook 的配置文件，跳过')))
    return
  }
  if (what === 'bridge-env') {
    const cfg = readJson(CONFIG_PATH, null)
    if (!cfg || (cfg.terminalBackend !== 'herdr' && !cfg.paths?.wezterm)) { say(c.dim('  ' + t('没有 bridge.env，跳过'))); return }
    const next = bridgeEnvText(cfg)
    const same = exists(BRIDGE_ENV) && fs.readFileSync(BRIDGE_ENV, 'utf8') === next
    if (!same && !dry) writeBridgeEnv(cfg)
    say(`  ${c.ok('✓')} ${tildify(BRIDGE_ENV)}  ${same ? c.dim(t('没变化')) : t('已更新') + mark}`)
    if (linkWithTools(dry)) say(`  ${c.ok('✓')} ${tildify(WITH_TOOLS_LINK)}  ${t('已更新') + mark}`)
    return
  }
  die(t('用法：pane-remote refresh hooks|bridge-env [--dry-run]'))
}

// ---------- uninstall ----------
async function uninstall() {
  const cfg = readJson(CONFIG_PATH, {})
  stopService()
  try { fs.unlinkSync(PLIST) } catch {}
  say(`${c.ok('✓')} ${t('停掉并移除后台服务')}`)
  stopHost()
  if (exists(HOST_PLIST)) { try { fs.unlinkSync(HOST_PLIST) } catch {} }
  say(`${c.ok('✓')} ${t('停掉并移除 pane-host')}`)
  const ts = findTailscale()
  if (ts && cfg.port) {
    const p = servedPort(ts, cfg.port)
    if (p) { run(ts, ['serve', `--https=${p}`, 'off']); say(`${c.ok('✓')} ${t('撤掉 tailscale serve（https 端口 {port}）', { port: p })}`) }
  }
  for (const d of claudeProfiles()) {
    const f = path.join(d, 'settings.json')
    if (exists(f) && patchHooks(f, CLAUDE_HOOKS, '', false).changed) say(`${c.ok('✓')} ${t('去掉 hook：{file}', { file: tildify(f) })}`)
  }
  const codex = path.join(HOME, '.codex/hooks.json')
  if (exists(codex) && patchHooks(codex, CODEX_HOOKS, 'codex', false).changed) say(`${c.ok('✓')} ${t('去掉 hook：{file}', { file: tildify(codex) })}`)
  const link = openLinkPath()
  if (link && isOurOpenLink(link)) { fs.unlinkSync(link); say(`${c.ok('✓')} ${t('去掉了 {path}', { path: tildify(link) })}`) }
  if (withToolsLinked()) { fs.unlinkSync(WITH_TOOLS_LINK); say(`${c.ok('✓')} ${t('去掉了 {path}', { path: tildify(WITH_TOOLS_LINK) })}`) }
  if (exists(MOUSECTL_PLIST)) {
    run(LAUNCHCTL, ['bootout', `gui/${uid()}/${MOUSECTL_LABEL}`])
    try { fs.unlinkSync(MOUSECTL_PLIST) } catch {}
    say(`${c.ok('✓')} ${t('停掉并移除 mousectl')}`)
  }
  stopPreview()
  if (flag('--purge')) {
    // 只删名字是 pane-remote、在家目录里面的目录：配置被改坏（比如 dataDir 写成 ~）也不会误删别的东西
    const expand = (p) => String(p || '').replace(/^~(?=\/|$)/, HOME)
    for (const p of [CONFIG_DIR, expand(cfg.dataDir) || path.join(HOME, '.local/share/pane-remote'), path.join(HOME, '.local/state/pane-remote'), HOST_DIR]) {
      const abs = path.resolve(p)
      if (!['pane-remote', 'pane-remote-host'].includes(path.basename(abs)) || !abs.startsWith(HOME + '/') || abs.split('/').length < HOME.split('/').length + 2) { say(c.warn('  ' + t('跳过 {path}（不像是 pane-remote 自己的目录）', { path: abs }))); continue }
      fs.rmSync(abs, { recursive: true, force: true })
    }
    say(`${c.ok('✓')} ${t('删掉配置和数据（推送订阅、预览浏览器的登录状态都没了）')}`)
  } else say(c.dim(t('配置和数据留着（{dir}），要一起删就加 --purge', { dir: tildify(CONFIG_DIR) })))
  say(c.dim(t('hook 改动前的备份是 settings.json.pane-remote-backup-*，确认没问题可以删掉')))
}

// ---------- 入口 ----------
const cmd = args[0]
try {
  switch (cmd) {
    case 'init': await init(); break
    case 'doctor': await doctor(); break
    case 'start': startService(); if (exists(HOST_PLIST)) startHost(); say(c.ok('✓ ' + t('已启动'))); break
    // 没有 PLIST = 这台电脑不跑服务（中转模式，init --skip-service）：Chrome 归中转服务器管，不碰
    case 'stop': stopService(); stopHost(); say(c.ok('✓ ' + t('已停止'))); if (exists(PLIST)) stopPreview(); break
    case 'restart': restartService(); restartHost(); say(c.ok('✓ ' + t('已重启'))); break
    case 'status': { const cfg = readJson(CONFIG_PATH, null); say(loaded() ? c.ok(t('运行中')) : c.warn(t('没在运行'))); if (cfg) say(t('端口 {port}，响应 {status}', { port: cfg.port, status: (await probe(cfg)) || t('无') })); break }
    case 'logs': spawnSync('/usr/bin/tail', ['-n', '100', '-f', LOG], { stdio: 'inherit' }); break
    case 'enable': await setModule(args[1], true); break
    case 'disable': await setModule(args[1], false); break
    case 'uninstall': await uninstall(); break
    case 'update': await update({ APP_DIR, CONFIG_PATH, BRIDGE_ENV, NODE, t, lang, c, say, readJson, writeFileSafe, flag, tildify, loaded, restartService, restartHost, probe, sharpOk, installSharp }); break
    case 'refresh': refresh(args[1]); break
    case 'relay': {
      const sub = path.join(APP_DIR, 'relay/relay.mjs')
      const r = spawnSync(NODE, [sub, ...args.slice(1)], { stdio: 'inherit', env: { ...process.env, PANE_REMOTE_LANG: lang } })
      process.exit(r.status ?? 1)
    }
    default:
      say(t(`用法：pane-remote <命令> [--lang en|zh]
  init        配置并启动（可以反复跑；--skip-host 不装 pane-host 的 LaunchAgent）
  doctor      自检
  status | start | stop | restart | logs
  enable <模块> | disable <模块>
{modules}
  uninstall [--purge]
  update [--check] [--yes] [--rollback]
              从 git 安全地更新（先预览，失败自动回滚）
  relay       增强版中转模式（docs/relay.md）`, { modules: Object.entries(MODULES).map(([k, v]) => `      ${k.padEnd(9)}${v}`).join('\n') }))
      process.exit(cmd ? 1 : 0)
  }
} catch (e) { die(e.message) }
