// 子进程环境：去掉父 agent 会话注入的变量（在 Claude Code 里跑测试时会带进来），补全 PATH，
// 合上 triage-env 里的长期令牌（钥匙串读不到时用；pane-agent triage-token 写，权限 600）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME = os.homedir()
export const STATE = process.env.PANE_REMOTE_STATE || path.join(HOME, '.local/state/pane-remote')
export const TRIAGE_ENV = path.join(HOME, '.config/pane-remote/triage-env')
const TOKEN_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CURSOR_API_KEY']
const DROP = /^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|WEZTERM_PANE$|HERDR_|PANE_REMOTE_INCIDENT$|PANE_REMOTE_AGENT$|CODEX_THREAD_ID$|CURSOR_AGENT$|CURSOR_INVOKED_AS$)/

export function triageTokens(file = TRIAGE_ENV) {
  const out = {}
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const i = line.indexOf('=')
      const k = line.slice(0, i).trim()
      const v = line.slice(i + 1).trim()
      if (i > 0 && TOKEN_KEYS.includes(k) && v) out[k] = v
    }
  } catch {}
  return out
}

// opts.claudeConfigDir：Claude Code 的配置目录。不给就沿用环境里的 CLAUDE_CONFIG_DIR（host-env 里可以写），都没有就是 Claude Code 自己的默认 ~/.claude
export function agentEnv(opts = {}) {
  const env = {}
  for (const [k, v] of Object.entries(opts.baseEnv || process.env)) if (!DROP.test(k)) env[k] = v
  const extra = [path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  env.PATH = [...new Set([...extra, ...String(env.PATH || '').split(':').filter(Boolean)])].join(':')
  if (opts.claudeConfigDir) env.CLAUDE_CONFIG_DIR = opts.claudeConfigDir
  env.NO_COLOR = '1'
  return { ...env, ...triageTokens(opts.triageEnvFile), ...(opts.env || {}) }
}

// 跑一个短命令拿输出（登录状态、模型列表）；超时按 PID 杀
export function run(cmd, args, { env, timeout = 20000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let p
    try { p = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return resolve({ code: -1, out: '', err: String(e.message || e) }) }
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, timeout)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e.message || e) }) })
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }) })
  })
}

export function which(cmd, env) {
  for (const dir of String(env.PATH || '').split(':')) {
    const f = path.join(dir, cmd)
    try { fs.accessSync(f, fs.constants.X_OK); return f } catch {}
  }
  return null
}
