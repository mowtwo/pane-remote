// Host 的 macOS 实现：终端走 wezterm cli（和 agent/bridge 一样，配了持久化 mux 就优先连它），
// agent 会话直接用仓库里的 agent/pane-transcript（不重写解析，spawn 它）
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { HOME, REPO, STATE } from '../../paths.mjs'

// wezterm 和持久化 mux 的位置：和 agent/bridge 读同一份 bridge.env（pane-remote init 写的）；没有就按常见位置找
function bridgeEnv() {
  const file = process.env.PANE_REMOTE_BRIDGE_ENV || path.join(path.dirname(process.env.PANE_REMOTE_CONFIG || path.join(HOME, '.config/pane-remote/config.json')), 'bridge.env')
  const env = {}
  try { for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const i = line.indexOf('='); if (i > 0) env[line.slice(0, i)] = line.slice(i + 1) } } catch {} // ignore: 没有就用默认位置
  return env
}
const BENV = bridgeEnv()
const WEZTERM = [BENV.WEZTERM, '/opt/homebrew/bin/wezterm', '/usr/local/bin/wezterm', '/Applications/WezTerm.app/Contents/MacOS/wezterm'].find((f) => f && fs.existsSync(f)) || 'wezterm'
// 只在配置了持久化 mux 时才连它（和 bridge 一样）
const MUX_SOCK = BENV.MUX_SOCK || ''
const HERDR = BENV.TERMINAL_BACKEND === 'herdr'
const BRIDGE = path.join(REPO, 'agent/bridge')
const TRANSCRIPT = process.env.PANE_HOST_TRANSCRIPT || path.join(REPO, 'agent/pane-transcript')

function run(file, args, { env, timeout = 10000, maxBuffer = 16 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: env || process.env, timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').pop()))
      else resolve(stdout)
    })
  })
}

// 连 mux 还是 GUI：mux 在就连 mux，不在退回 GUI，30 秒重判一次；两边都 --no-auto-start，绝不顺手拉起空 server（它会抢走 mux 的 socket 路径）
let cliMode = { at: 0, env: null, args: null }
async function cli(args, opts) {
  if (Date.now() - cliMode.at > 30000) {
    const muxEnv = { ...process.env, WEZTERM_UNIX_SOCKET: MUX_SOCK }
    let mux = false
    if (MUX_SOCK && fs.existsSync(MUX_SOCK)) mux = await run(WEZTERM, ['cli', '--no-auto-start', 'list'], { env: muxEnv, timeout: 5000 }).then(() => true, () => false)
    const env = { ...process.env }
    delete env.WEZTERM_UNIX_SOCKET
    cliMode = mux ? { at: Date.now(), env: muxEnv, args: ['cli', '--no-auto-start'] } : { at: Date.now(), env, args: ['cli', '--no-auto-start'] }
  }
  return run(WEZTERM, [...cliMode.args, ...args], { ...opts, env: cliMode.env })
}

const tilde = (d) => (d.startsWith(HOME + '/') || d === HOME ? '~' + d.slice(HOME.length) : d)

/** @returns {import('../interface.mjs').Host} */
export function createHost() {
  return {
    platform: 'macos',
    terminals: {
      async list() {
        const raw = JSON.parse(HERDR
          ? await run(BRIDGE, [], { env: { ...process.env, SSH_ORIGINAL_COMMAND: 'list' } })
          : await cli(['list', '--format', 'json']))
        return raw.map((p) => {
          const dir = decodeURIComponent((p.cwd || '').replace(/^file:\/\/[^/]*/, ''))
          return {
            pane: p.pane_id, terminalAgent: p.terminal_agent || null, backend: p.backend || 'wezterm', capabilities: p.capabilities || {}, tab: p.tab_id, window: p.window_id, workspace: p.workspace, title: p.title, tabTitle: p.tab_title,
            cwd: tilde(dir), dir, cols: p.size?.cols, rows: p.size?.rows, active: p.is_active,
            cursor: { x: p.cursor_x, y: p.cursor_y, visible: p.cursor_visibility === 'Visible' },
          }
        })
      },
      text(pane, { lines = 200, escapes = false } = {}) {
        if (HERDR) {
          if (!/^w[0-9A-HJKMNP-TV-Z]{1,13}:p[0-9A-HJKMNP-TV-Z]{1,13}$/.test(String(pane)) || !Number.isInteger(lines) || lines < 0 || lines > 99999) throw new Error('bad terminal parameters')
          return run(BRIDGE, [], { env: { ...process.env, SSH_ORIGINAL_COMMAND: `${escapes ? 'ansi' : 'text'} ${pane} ${lines}` }, timeout: 5000 })
        }
        return cli(['get-text', '--pane-id', String(pane), '--start-line', String(-lines), ...(escapes ? ['--escapes'] : [])], { timeout: 5000 })
      },
    },
    agents: {
      async session(pane) {
        return JSON.parse((await run(TRANSCRIPT, ['session', String(pane)])) || '{}')
      },
      async messages(s, n) {
        if (!s?.transcript) return []
        return JSON.parse((await run(TRANSCRIPT, ['messages-file', s.agent || 'claude', s.transcript, String(n)], { timeout: 20000 })) || '[]')
      },
      watchFiles(s) {
        if (!s?.transcript) return []
        return s.agent === 'cursor-agent' ? [s.transcript, s.transcript + '-wal'] : [s.transcript]
      },
    },
    // 剪贴板、打开网址：插件选了「用 Mac 的」时由平台调（platform/rpc.mjs）。pbpaste / pbcopy 要 UTF-8 的 locale，不然中文变问号
    desktop: {
      clipboard: {
        readText: () => run('/usr/bin/pbpaste', [], { env: { ...process.env, LANG: 'en_US.UTF-8' }, timeout: 5000 }),
        writeText: (text) => new Promise((resolve, reject) => {
          const p = spawn('/usr/bin/pbcopy', [], { env: { ...process.env, LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'ignore', 'pipe'] })
          let err = ''
          p.stderr.on('data', (d) => { err += d })
          p.on('error', reject)
          p.on('close', (code) => (code === 0 ? resolve(true) : reject(new Error(err.trim() || `pbcopy exit ${code}`))))
          p.stdin.end(String(text))
        }),
      },
      // 直接用 /usr/bin/open：~/.local/bin/open 会在「你在用手机」时把网址转回手机（pane-open），这里要的就是在电脑上打开
      openUrl: async (url) => { await run('/usr/bin/open', [url], { timeout: 10000 }); return true },
    },
    events: { log: path.join(STATE, 'events.jsonl') },
  }
}
