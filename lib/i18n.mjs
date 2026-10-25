// 命令行的中英文输出。只用 Node 自带模块。
//
// 语言优先级：
//   1. 命令行参数 --lang en|zh（也认 --lang=en），导入本文件时就从 process.argv 里去掉，不影响别的参数解析
//   2. 环境变量 PANE_REMOTE_LANG=en|zh
//   3. 配置文件（PANE_REMOTE_CONFIG 或 ~/.config/pane-remote/config.json）里的 "lang"
//   4. 自动：LC_ALL / LC_MESSAGES / LANG（第一个非空的）以 zh 开头就用中文；
//      否则在 macOS 上看 `defaults read -g AppleLanguages`，有任何一项以 zh 开头也用中文；都不是就用英文
//
// 用法：t('中文原文 {name}', { name })。中文原文就是 key，英文写在下面的 EN 里；查不到就原样输出中文。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const norm = (v) => {
  const s = String(v || '').trim().toLowerCase()
  if (s.startsWith('zh')) return 'zh'
  if (s.startsWith('en')) return 'en'
  return ''
}

// 从 argv 里摘掉 --lang（原地修改，这样后面 process.argv.slice(2) 拿到的就是干净的参数）
function takeFlag(argv) {
  let val = ''
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--lang') { val = argv[i + 1] || ''; argv.splice(i, 2); i-- }
    else if (a.startsWith('--lang=')) { val = a.slice(7); argv.splice(i, 1); i-- }
  }
  return val
}

function fromConfig() {
  const p = process.env.PANE_REMOTE_CONFIG || path.join(os.homedir(), '.config/pane-remote/config.json')
  try { return norm(JSON.parse(fs.readFileSync(p, 'utf8')).lang) } catch { return '' }
}

function auto() {
  const loc = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].find((v) => v)
  if (loc && loc.toLowerCase().startsWith('zh')) return 'zh'
  if (process.platform === 'darwin') {
    try {
      const r = spawnSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 1500 })
      // 输出形如 ( "en-CN", "zh-Hans-CN" )
      if (r.status === 0 && /^[\s(,]*"?zh/im.test(r.stdout || '')) return 'zh'
    } catch {}
  }
  return 'en'
}

function detect() {
  const raw = takeFlag(process.argv)
  const f = norm(raw)
  if (f) return [f, 'flag']
  if (raw) console.error(`! --lang ${raw}: use en or zh`)
  const e = norm(process.env.PANE_REMOTE_LANG)
  if (e) return [e, 'env']
  const c = fromConfig()
  if (c) return [c, 'config']
  return [auto(), 'auto']
}

/** 实际使用的语言 'zh' | 'en'；langSource：'flag' | 'env' | 'config' | 'auto' */
export const [lang, langSource] = detect()

export function t(zh, vars) {
  let s = lang === 'en' && Object.prototype.hasOwnProperty.call(EN, zh) ? EN[zh] : zh
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m))
  return s
}

/** 列表拼接：中文用顿号，英文用逗号 */
export const list = (arr) => arr.join(lang === 'en' ? ', ' : '、')

export const EN = {
  // ---------- lib/cli.mjs：模块 ----------
  '预览浏览器（手机上看电脑这边的网页和文件，需要 Chrome）': 'Preview browser (view web pages and files from this Mac on your phone; needs Chrome)',
  '网址转手机（电脑上打开链接时，人在用手机就转到手机预览）': 'Open URLs on phone (links opened on the Mac go to the phone preview while you are using the phone)',
  'Cursor IDE 映射（会话、消息、待办、改动、内置浏览器；Cursor 要带调试端口启动）': 'Cursor IDE mirror (chats, messages, todos, changes, built-in browser; Cursor must run with a debugging port)',

  // ---------- 通用 ----------
  '{file} 不是合法的 JSON：{err}': '{file} is not valid JSON: {err}',
  '启动服务失败：{err}': 'Failed to start the service: {err}',
  '路径里不能有换行': 'Paths must not contain line breaks',

  // ---------- init ----------
  '目前只支持 macOS': 'Only macOS is supported for now',
  'Node 版本太旧（{v}），需要 20 以上；用 install.sh 会自动装好': 'Node is too old ({v}); version 20 or newer is required. install.sh sets it up automatically',
  '依赖没装：先在仓库目录跑 ./install.sh（或 npm ci --omit=dev）': 'Dependencies are missing: run ./install.sh in the repo directory first (or npm ci --omit=dev)',
  '前端没构建：仓库里缺 public/，重新拉一下代码': 'Frontend is not built: public/ is missing from the repo. Pull the code again',
  '1/5 检查依赖': '1/5 Checking dependencies',
  'WezTerm 没装': 'WezTerm is not installed',
  'Tailscale 没装': 'Tailscale is not installed',
  '没找到 Chrome：预览浏览器模块会先关掉（装了 Chrome 后 pane-remote enable preview）': 'Chrome not found: the preview browser module stays off for now (after installing Chrome, run pane-remote enable preview)',
  '没有 /usr/bin/python3（装 Xcode 命令行工具：xcode-select --install）': 'No /usr/bin/python3 (install the Xcode Command Line Tools: xcode-select --install)',
  '缺 {missing}：跑 ./install.sh 会用 Homebrew 装好，或者手动 brew install --cask {casks}': 'Missing {missing}: ./install.sh installs them with Homebrew, or run brew install --cask {casks} yourself',
  '缺 python3': 'python3 is missing',
  '未知': 'unknown',
  'Tailscale 没登录或没在运行（{state}）：打开 Tailscale 登录后再跑一次': 'Tailscale is not logged in or not running ({state}): open Tailscale, log in, then run this again',
  '拿不到这台电脑在 tailnet 里的主机名：在 Tailscale 管理后台打开 MagicDNS 和 HTTPS 证书': "Can't get this Mac's tailnet hostname: enable MagicDNS and HTTPS certificates in the Tailscale admin console",
  '这台电脑是标签设备（tagged），看不出是谁的：用 --login <你手机上 Tailscale 的登录名> 指定': "This Mac is a tagged device, so its owner can't be determined: pass --login <the Tailscale login on your phone>",
  '这台电脑是标签设备，请输入你手机上 Tailscale 的登录名：': 'This Mac is a tagged device. Enter the Tailscale login used on your phone: ',
  '登录名看着不对：{login}': "That login doesn't look right: {login}",
  'Tailscale 已登录  {host}；允许 {login} 访问': 'Tailscale is logged in  {host}; allowing access for {login}',
  '2/5 写配置': '2/5 Writing config',
  '只允许 {logins} 访问；要加别的账号就编辑 allowedLogins': 'Only {logins} can access it; edit allowedLogins to add other accounts',
  '3/5 装 hook（让手机知道 Claude / Codex 什么时候做完、什么时候在等你）': '3/5 Installing hooks (so the phone knows when Claude / Codex finish or are waiting for you)',
  '没找到 Claude Code 的配置目录（~/.claude*）；装好 Claude Code 后再跑一次 init': 'No Claude Code config directory found (~/.claude*); run init again after installing Claude Code',
  '（原文件备份：{file}）': ' (backup of the original: {file})',
  '发现 Codex：也给它装 hook 吗？（装完要在 Codex 里确认信任这些 hook 才生效）': 'Codex found: install hooks for it too? (You must trust these hooks in Codex before they take effect)',
  '（备份：{file}）': ' (backup: {file})',
  '已经开着的 Claude 会话要重开一次才会用上新 hook': 'Claude sessions that are already open need a restart to pick up the new hooks',
  '4/5 启动服务': '4/5 Starting the service',
  '跳过（--skip-service）：自己运行 {cmd}': 'Skipped (--skip-service): run it yourself with {cmd}',
  '连不上': 'unreachable',
  '服务现在没响应（{status}），启动后跑 pane-remote doctor 确认': 'The service is not responding right now ({status}); run pane-remote doctor once it is started',
  '服务没起来（{status}），看日志：{cmd}': 'The service did not come up ({status}). Check the log: {cmd}',
  '服务在 127.0.0.1:{port}': 'Service is running on 127.0.0.1:{port}',
  '（开机自动启动，日志 {log}）': ' (starts at login, log: {log})',
  '5/5 用 tailscale serve 发布到你的 tailnet': '5/5 Publishing to your tailnet with tailscale serve',
  '跳过（--skip-serve）：自己执行 {cmd}': 'Skipped (--skip-serve): run it yourself with {cmd}',
  '端口': 'port',
  'tailscale serve 的 443 和 8443 都被别的服务占了；手动选个端口：{cmd}': 'tailscale serve ports 443 and 8443 are both used by other services; pick a port manually: {cmd}',
  '443 已经被别的服务用了，改用 {port}': '443 is already used by another service; using {port} instead',
  'tailscale serve 失败：{err}\n  常见原因：tailnet 没开 HTTPS 证书（管理后台 DNS 页面打开 HTTPS Certificates）': 'tailscale serve failed: {err}\n  Common cause: HTTPS certificates are not enabled for the tailnet (turn on HTTPS Certificates on the DNS page of the admin console)',
  '装好了。手机上：': 'All set. On your phone:',
  '装 Tailscale（App Store 搜 Tailscale），登录 {login}': 'Install Tailscale (search the App Store for Tailscale) and log in as {login}',
  'Safari 打开 {url}': 'Open {url} in Safari',
  '分享 → 添加到主屏幕（推送通知只在主屏幕打开的网页里能用）': 'Share → Add to Home Screen (push notifications only work when opened from the Home Screen)',
  '有问题跑 pane-remote doctor。可选模块：pane-remote enable openUrl（网址转手机）': 'If something is wrong, run pane-remote doctor. Optional module: pane-remote enable openUrl (open URLs on phone)',

  // ---------- doctor ----------
  'pane-remote 自检': 'pane-remote self-check',
  '没有配置文件 {file}': 'No config file at {file}',
  '跑 pane-remote init': 'run pane-remote init',
  '配置 {file}（{mode} 模式）': 'Config {file} ({mode} mode)',
  'Node {v} 太旧': 'Node {v} is too old',
  '需要 20 以上': 'version 20 or newer is required',
  '依赖已装': 'Dependencies installed',
  '依赖没装': 'Dependencies are missing',
  '允许访问：{logins}': 'Allowed: {logins}',
  'allowedLogins 是空的，谁都进不来': 'allowedLogins is empty, so nobody can get in',
  '找不到 wezterm': 'wezterm not found',
  'brew install --cask wezterm，然后 pane-remote init': 'brew install --cask wezterm, then pane-remote init',
  'WezTerm 能连上，{n} 个 pane': 'WezTerm is reachable, {n} pane(s)',
  'WezTerm 返回的不是 pane 列表': 'WezTerm did not return a pane list',
  'WezTerm 连不上：{err}': "Can't reach WezTerm: {err}",
  '先打开 WezTerm 窗口（或配置持久化 mux，见 docs/advanced.md）': 'open a WezTerm window first (or set up a persistent mux, see docs/advanced.md)',
  '没有 /usr/bin/python3': 'No /usr/bin/python3',
  'Tailscale 没在运行或没登录': 'Tailscale is not running or not logged in',
  '打开 Tailscale 登录': 'open Tailscale and log in',
  'Tailscale：{who}  {host}': 'Tailscale: {who}  {host}',
  '标签设备': 'tagged device',
  '这台电脑的 tailnet 主机名 {host} 不在 serveHosts 里（换过名字？）': "This Mac's tailnet hostname {host} is not in serveHosts (was it renamed?)",
  'tailscale serve 没指向本服务': 'tailscale serve does not point to this service',
  '后台服务已加载（launchd）': 'Background service loaded (launchd)',
  '后台服务没加载': 'Background service is not loaded',
  '服务正常响应（127.0.0.1:{port}）': 'Service responds normally (127.0.0.1:{port})',
  '服务没响应（{status}）': 'Service is not responding ({status})',
  '看日志：{cmd}': 'check the log: {cmd}',
  'hook 已装：{file}': 'Hooks installed: {file}',
  'hook 没装全：{file}': 'Hooks incomplete: {file}',
  'hook 有在记录事件（最近 {min} 分钟前）': 'Hooks are recording events (last one {min} min ago)',
  '还没收到过 hook 事件': 'No hook events received yet',
  '在 WezTerm 里开一个新的 Claude 会话、发一句话试试': 'start a new Claude session in WezTerm and send a message',
  '预览浏览器：{path}': 'Preview browser: {path}',
  '预览模块开着但找不到 Chrome': "Preview module is on but Chrome can't be found",
  '装 Chrome 后跑 pane-remote init，或 pane-remote disable preview': 'install Chrome and run pane-remote init, or run pane-remote disable preview',
  'Cursor 模块开着但没装 Cursor': 'Cursor module is on but Cursor is not installed',
  // ---- 看屏幕模块 ----
  '看屏幕（只限 macOS：手机上看 / 操作电脑屏幕或单个窗口，走系统自带的屏幕共享）': 'Screen view (macOS only: view and control the screen or a single window from the phone, via built-in Screen Sharing)',
  '看屏幕模块只支持 macOS': 'The screen module only supports macOS',
  '看屏幕：sharp 能加载': 'Screen: sharp loads',
  '看屏幕：sharp 加载不了': "Screen: sharp can't be loaded",
  '看屏幕：屏幕共享已开（127.0.0.1:5900）': 'Screen: Screen Sharing is on (127.0.0.1:5900)',
  '看屏幕：屏幕共享没开': 'Screen: Screen Sharing is off',
  '系统设置 → 通用 → 共享 → 屏幕共享': 'System Settings → General → Sharing → Screen Sharing',
  '看屏幕：mousectl 在运行': 'Screen: mousectl is running',
  '看屏幕：mousectl 没在运行': 'Screen: mousectl is not running',
  '跑 pane-remote enable screen 重装；还不行看 {log}': 'Run pane-remote enable screen to reinstall; if that does not help, check {log}',
  '没有 swiftc：先装 Xcode 命令行工具（xcode-select --install）': 'swiftc not found: install the Xcode command line tools first (xcode-select --install)',
  '安装转码用的 sharp…': 'Installing sharp for transcoding…',
  'sharp 装不上：在 {dir} 里跑 npm install --omit=dev 看看报错': "sharp couldn't be installed: run npm install --omit=dev in {dir} to see the error",
  'mousectl 没装好（看上面的输出）': 'mousectl was not installed (see the output above)',
  'mousectl 已装成后台常驻（{label}）': 'mousectl installed as a background agent ({label})',
  '还要你在电脑上手动做几步：': 'A few manual steps on the computer:',
  '打开 系统设置 → 通用 → 共享 → 屏幕共享（「允许访问」只留你自己的账号）': 'Turn on System Settings → General → Sharing → Screen Sharing (allow access for your own account only)',
  '系统设置 → 隐私与安全性 → 辅助功能：打开 mousectl（点、拖、打字要用）': 'System Settings → Privacy & Security → Accessibility: turn on mousectl (needed for clicks, drags and typing)',
  '系统设置 → 隐私与安全性 → 屏幕与系统录音：打开 mousectl（按窗口看要用）': 'System Settings → Privacy & Security → Screen & System Audio Recording: turn on mousectl (needed for single-window view)',
  '可选：pane-remote enable screen --create-cert 建一张本机自签名证书给 mousectl 签名，以后更新重编时授权不会掉（建好后要再授权一次）': 'Optional: pane-remote enable screen --create-cert creates a local self-signed certificate to sign mousectl, so permissions survive rebuilds after updates (grant them once more afterwards)',
  '手机上点顶栏的屏幕图标，用电脑的用户名和密码登录（密码在手机上加密，服务端看不到）': 'On the phone, tap the screen icon in the top bar and sign in with your computer username and password (encrypted on the phone; the server never sees it)',
  '停掉并移除 mousectl': 'Stopped and removed mousectl',
  // ---- mac 模块 ----
  '这台电脑（只限 macOS：手机上看 CPU、内存和占用最多的进程，让电脑用自带的 say 念一段话）': 'This Mac (macOS only: CPU, memory and top processes on the phone, and have the Mac read text aloud with the built-in say)',
  'mac 模块只支持 macOS': 'The mac module only supports macOS',
  'mac 模块：缺系统命令 {list}': 'mac module: missing system commands {list}',
  '这些是 macOS 自带的，系统可能不完整': 'These ship with macOS; the system may be incomplete',
  'mac 模块：性能和念一段话要用的系统命令都在': 'mac module: the system commands for performance and speech are present',
  '手机上点顶栏的仪表盘图标：看 CPU、内存、占用最多的进程（只在面板开着时每 5 秒采一次）；「念出来」用电脑的扬声器念一段话': 'On the phone, tap the gauge icon in the top bar: CPU, memory and top processes (sampled every 5 s only while the panel is open); "Speak" reads text aloud on the Mac\'s speakers',
  '念的时候可以临时改音量，念完调回原来的音量': 'You can set a volume just for speaking; the previous volume is restored afterwards',
  '这台电脑': 'This Mac',
  'mac 模块': 'mac module',
  'Cursor 已带调试端口运行，可以接入': 'Cursor is running with the debugging port and can be attached',
  'Cursor 没有带调试端口运行': 'Cursor is not running with the debugging port',
  '在手机的 Cursor 页面点「启动 Cursor」或「重启并接入」': 'tap "Launch Cursor" or "Restart and attach" on the Cursor page on your phone',
  '网址转手机：{path}': 'Open URLs on phone: {path}',
  '网址转手机开着但没装好': 'Open URLs on phone is on but not set up correctly',
  '{n} 项有问题': '{n} problem(s) found',
  '全部正常': 'All good',

  // ---------- enable / disable ----------
  '没有这个模块：{name}。可选：{list}': 'No such module: {name}. Available: {list}',
  '先跑 pane-remote init': 'Run pane-remote init first',
  '没找到 Chrome：装 Google Chrome（brew install --cask google-chrome）': 'Chrome not found: install Google Chrome (brew install --cask google-chrome)',
  '没找到 Cursor（/Applications/Cursor.app）': 'Cursor not found (/Applications/Cursor.app)',
  'Cursor 要带调试端口（只监听本机 127.0.0.1:9333）启动才能接入：': 'Cursor must be started with a debugging port (listening only on 127.0.0.1:9333) to be attached:',
  'Cursor 没开时，手机上点「启动 Cursor」或新建会话会自动带端口启动': 'When Cursor is closed, tapping "Launch Cursor" or starting a new chat on the phone launches it with the port',
  'Cursor 已经用普通方式开着时，手机上会提示「重启并接入」，你确认后它会正常退出再重开（有没保存的内容 Cursor 会先问你）': 'When Cursor is already open normally, the phone offers "Restart and attach"; once you confirm, Cursor quits cleanly and reopens (it asks first about unsaved work)',
  '调试端口能完全控制 Cursor：只在只有你自己用的电脑上开': 'The debugging port gives full control of Cursor: only enable it on a Mac that only you use',
  '当前 Node（{v}）没有 node:sqlite，看不到完整历史消息，只有实时画面里的内容；换 Node 22.13 以上再跑 pane-remote init': 'This Node ({v}) has no node:sqlite, so full message history is unavailable, only what is on screen live; switch to Node 22.13+ and run pane-remote init again',
  'PATH 里没有排在 /usr/bin 前面的 ~/.local/bin 或 ~/bin：先在 ~/.zshrc 里加 {line}，开个新终端再试': 'PATH has no ~/.local/bin or ~/bin ahead of /usr/bin: add {line} to ~/.zshrc, then try again in a new terminal',
  '{path} 已经被别的东西占用了，不覆盖（自己处理掉再试）': '{path} is already taken by something else and will not be overwritten (remove it yourself and try again)',
  '想让 Claude 等程序打开网页时也转过来，在 ~/.zshrc 里加：{line}': 'To also redirect pages opened by programs such as Claude, add this to ~/.zshrc: {line}',
  '去掉了 {path}': 'Removed {path}',
  '{module}：已开启': '{module}: enabled',
  '{module}：已关闭': '{module}: disabled',

  // ---------- uninstall ----------
  '停掉并移除后台服务': 'Stopped and removed the background service',
  '撤掉 tailscale serve（https 端口 {port}）': 'Removed tailscale serve (https port {port})',
  '去掉 hook：{file}': 'Removed hooks: {file}',
  '关掉预览用的 Chrome': 'Closed the preview Chrome',
  '跳过 {path}（不像是 pane-remote 自己的目录）': "Skipped {path} (doesn't look like a pane-remote directory)",
  '删掉配置和数据（推送订阅、预览浏览器的登录状态都没了）': 'Deleted config and data (push subscriptions and preview browser logins are gone)',
  '配置和数据留着（{dir}），要一起删就加 --purge': 'Config and data are kept ({dir}); add --purge to delete them too',
  'hook 改动前的备份是 settings.json.pane-remote-backup-*，确认没问题可以删掉': 'Backups from before the hook changes are settings.json.pane-remote-backup-*; delete them once everything looks fine',

  // ---------- 入口 ----------
  '已启动': 'Started',
  '已停止': 'Stopped',
  '已重启': 'Restarted',
  '运行中': 'Running',
  '没在运行': 'Not running',
  '端口 {port}，响应 {status}': 'Port {port}, response {status}',
  '无': 'none',
  [`用法：pane-remote <命令> [--lang en|zh]
  init        配置并启动（可以反复跑；--skip-host 不装 pane-host 的 LaunchAgent）
  doctor      自检
  status | start | stop | restart | logs
  menubar     安装并打开 macOS 菜单栏应用
  terminal herdr|wezterm  切换终端来源（运行中会重启服务）
  enable <模块> | disable <模块>
{modules}
  uninstall [--purge]
  update [--check] [--yes] [--rollback]
              从 git 安全地更新（先预览，失败自动回滚）
  relay       增强版中转模式（docs/relay.md）`]: `Usage: pane-remote <command> [--lang en|zh]
  init        configure and start (safe to re-run; --skip-host skips the pane-host LaunchAgent)
  doctor      self-check
  status | start | stop | restart | logs
  menubar     install and open the macOS menu bar app
  terminal herdr|wezterm  switch terminal source (restarts a running service)
  enable <module> | disable <module>
{modules}
  uninstall [--purge]
  update [--check] [--yes] [--rollback]
              update safely from git (preview first, automatic rollback on failure)
  relay       relay mode for advanced setups (docs/relay.md)`,

  // ---------- pane-host、插件平台 ----------
  '插件平台（手机上跑插件：悬浮按钮打开插件抽屉，插件放在 plugins/ 目录，见 docs/plugins.md）': 'Plugin platform (run plugins on the phone: the floating button opens the plugin drawer; plugins live in plugins/, see docs/plugins.md)',
  '启动 pane-host 失败：{err}': 'Failed to start pane-host: {err}',
  '跳过 pane-host 的 LaunchAgent（--skip-host）：用到时会临时拉起一个': 'Skipping the pane-host LaunchAgent (--skip-host): one is started on demand when needed',
  'pane-host 在运行（开机自动启动，日志 {log}）': 'pane-host is running (starts at login, log {log})',
  'pane-host 没响应，看日志：{cmd}': 'pane-host is not responding, check the log: {cmd}',
  'pane-host 在运行（pid {pid}，{n} 秒）{how}': 'pane-host is running (pid {pid}, {n}s){how}',
  '，临时拉起的，没装 LaunchAgent': ', started on demand, no LaunchAgent installed',
  'pane-host 的 LaunchAgent 装了但没响应': 'The pane-host LaunchAgent is installed but not responding',
  'pane-host 没在运行（用到时会临时拉起；装成常驻：pane-remote init）': 'pane-host is not running (it is started on demand; to keep it resident: pane-remote init)',
  '插件平台：依赖已装': 'Plugin platform: dependencies installed',
  '插件平台：依赖没装': 'Plugin platform: dependencies missing',
  '停掉并移除 pane-host': 'Stopped and removed pane-host',
  '重启 pane-host': 'Restart pane-host',
  'pane-host 已重启（没装 LaunchAgent 的话，下次用到时自动拉起新版）': 'pane-host restarted (without the LaunchAgent, the new version starts on demand next time)',

  // ---------- update（lib/update.mjs）、refresh ----------
  '没有 git：装 Xcode 命令行工具（xcode-select --install）': 'git not found: install the Xcode command line tools (xcode-select --install)',
  '{dir} 不是 git clone 下来的仓库，没法用 update；重新按 README 用 git clone 安装': "{dir} is not a git clone, so update can't be used; reinstall with git clone as described in the README",
  '新提交（{n} 个）：': 'Incoming commits ({n}):',
  '要撤销的提交（{n} 个）：': 'Commits to undo ({n}):',
  '…还有 {n} 个': '… and {n} more',
  'npm 依赖': 'npm dependencies',
  '服务端': 'Server',
  '手机网页（构建好的）': 'Phone web UI (built)',
  '手机网页源码': 'Phone web UI source',
  '电脑端脚本': 'Mac-side scripts',
  '看屏幕模块': 'Screen module',
  '命令行': 'Command line',
  '中转模式': 'Relay mode',
  '安装脚本': 'Installer',
  '文档': 'Docs',
  '其他': 'Other',
  '改动的文件（{n} 个）：': 'Changed files ({n}):',
  '重装 npm 依赖（和 install.sh 一样的参数）': 'Reinstall npm dependencies (same flags as install.sh)',
  '重编并重装 mousectl（看屏幕模块）': 'Rebuild and reinstall mousectl (screen module)',
  '重新合并 Claude / Codex 的 hook（只动已经装过的）': 'Re-merge Claude / Codex hooks (only where already installed)',
  '重写 bridge.env': 'Rewrite bridge.env',
  '重启后台服务': 'Restart the background service',
  '要做的步骤：': 'Steps to run:',
  '（没有：只是更新文件）': '(none: files only)',
  '中转服务器也要更新（做完后会给出命令）': 'The relay server needs updating too (commands are printed at the end)',
  '不是在终端里运行：确认要更新就加 --yes': 'Not running in a terminal: add --yes to confirm the update',
  '已取消': 'Cancelled',
  '（旧版本）': ' (old version)',
  '（测试）模拟这一步失败': '(test) simulating a failure of this step',
  '看屏幕模块开着：检查 / 补装 sharp': 'Screen module is on: check / reinstall sharp',
  '钥匙串里没有「{id}」签名证书：安装脚本不会重编已有的 mousectl，新的 mousectl 代码还没生效。': 'No "{id}" signing certificate in the keychain: the installer won\'t rebuild the existing mousectl, so the new mousectl code is not active yet.',
  '要用上新代码：pane-remote enable screen --create-cert（建证书后重编；macOS 会再要一次辅助功能和屏幕录制授权，之后的更新不会再掉）': 'To use the new code: pane-remote enable screen --create-cert (creates the certificate and rebuilds; macOS will ask for Accessibility and Screen Recording permission once more, later updates keep it)',
  '这是中转服务器上的配置：自己重启服务（sudo systemctl restart pane-remote）': 'This is a relay server config: restart the service yourself (sudo systemctl restart pane-remote)',
  '后台服务没用 launchd 跑（--skip-service）：自己重启 server/server.mjs': 'The service is not run by launchd (--skip-service): restart server/server.mjs yourself',
  '服务重启后没响应（{status}）': 'The service did not respond after the restart ({status})',
  'doctor 退出码 {code}': 'doctor exit code {code}',
  '回滚到 {rev}…': 'Rolling back to {rev}…',
  '更新步骤改动了这些已跟踪文件，回滚会一起还原：{files}': 'The update steps changed these tracked files; the rollback restores them too: {files}',
  'git reset 失败：{err}': 'git reset failed: {err}',
  '代码已回到 {rev}': 'Code is back at {rev}',
  'bridge.env 已还原': 'bridge.env restored',
  '旧版本的这一步也失败了：{step}': 'This step also failed on the old version: {step}',
  '中转服务器也要更新（电脑和服务器的版本要一致）。在这台电脑的仓库目录里执行：': "The relay server needs updating too (the Mac and the server must run the same version). Run on this Mac, in the repo directory:",
  '中转模式的辅助命令改了：看一下 {cmd}，隧道参数或 authorized_keys 那一行变了的话，重跑 pane-remote relay tunnel <用户@服务器> / pane-remote relay authorized-key <公钥>': 'The relay helper changed: check {cmd}; if the tunnel arguments or the authorized_keys line changed, re-run pane-remote relay tunnel <user@server> / pane-remote relay authorized-key <pubkey>',
  'install.sh / Brewfile 改了，update 不会重跑它们：看一下 {cmd}，需要的话再跑一次 ./install.sh': "install.sh / Brewfile changed and update doesn't re-run them: check {cmd} and run ./install.sh again if needed",
  '没有可以回滚的更新记录': 'No update record to roll back',
  '上一次更新（{from} → {to}）已经回滚过了': 'The last update ({from} → {to}) was already rolled back',
  '现在的版本 {head} 不是上一次更新到的 {to}（之后又动过仓库），不自动回滚': 'The current version {head} is not {to} from the last update (the repo changed since), not rolling back automatically',
  '工作区有改动：': 'The working tree has changes:',
  '先处理掉这些改动（提交或还原）再回滚': 'Deal with these changes first (commit or revert), then roll back',
  '记录里的旧版本 {rev} 不在当前历史上，不自动回滚': 'The recorded old version {rev} is not in the current history, not rolling back automatically',
  '回滚上一次更新：{to} → {from}': 'Roll back the last update: {to} → {from}',
  '撤销这些提交？': 'Undo these commits?',
  '已回滚到 {rev}': 'Rolled back to {rev}',
  '已回滚代码，但有步骤失败（看上面的输出），跑 pane-remote doctor 看看': 'The code was rolled back but some steps failed (see the output above); run pane-remote doctor',
  '仓库不在任何分支上（detached HEAD），不自动更新': 'The repo is not on a branch (detached HEAD), not updating automatically',
  '只从 https 的 origin 更新：当前分支 {branch} 要跟踪 origin 上的分支，origin 要是不带账号密码的 https 地址（现在是 {url}）': 'Updates only come from an https origin: the current branch {branch} must track a branch on origin, and origin must be an https URL without credentials (currently {url})',
  '记下更新来源：{url}（{branch} 分支），以后只从这里更新': 'Recorded the update source: {url} (branch {branch}); updates will only come from here',
  'origin 和安装时记下的更新来源不一样，拒绝更新：\n  记下的：{a}\n  现在的：{b}\n确实是你自己改的，就把 {file} 里的 updateSource 改成新的地址和分支': 'origin differs from the update source recorded at install time, refusing to update:\n  recorded: {a}\n  current:  {b}\nIf you changed it on purpose, set updateSource in {file} to the new URL and branch',
  '拉取 {url} …': 'Fetching {url} …',
  '拉取失败：{err}': 'Fetch failed: {err}',
  '已经是最新（{rev}）': 'Already up to date ({rev})',
  '本地比上游多了提交，没有要拉的': 'Local has commits upstream does not; nothing to pull',
  '有更新：{from} → {to}': 'Update available: {from} → {to}',
  '本地历史和上游分叉了（本地有上游没有的提交），只能快进更新。自己处理好（比如 git log {up}..HEAD 看看）再试': 'Local history has diverged from upstream (local commits upstream does not have); only fast-forward updates are done. Sort it out yourself (e.g. look at git log {up}..HEAD) and try again',
  '工作区有改动，不覆盖：\n{files}\n先提交或还原再更新': 'The working tree has local changes, not overwriting them:\n{files}\nCommit or revert them, then update',
  '这些未跟踪的文件会被新版本里的同名文件覆盖：{files}；先挪走再更新': 'These untracked files would be overwritten by files of the same name in the new version: {files}; move them away first',
  '运行 pane-remote update 应用': 'Run pane-remote update to apply',
  '应用这次更新？': 'Apply this update?',
  '快进合并失败（没改动任何东西）：{err}': 'Fast-forward failed (nothing was changed): {err}',
  '代码已更新到 {rev}': 'Code updated to {rev}',
  '自检（pane-remote doctor）': 'Self-check (pane-remote doctor)',
  '（测试）模拟的新失败项': '(test) simulated new failure',
  '比更新前多了这些问题：': 'New problems compared with before the update:',
  '没有新问题': 'No new problems',
  '（更新前就有的 {n} 项问题还在）': ' ({n} problems from before the update remain)',
  '这一步失败了：{step}': 'This step failed: {step}',
  '更新后自检变差了': 'The self-check got worse after the update',
  '已自动回滚到 {rev}，一切照旧。上面的输出说明了原因': 'Rolled back to {rev} automatically; everything is as before. The output above explains why',
  '更新完成：{from} → {to}': 'Update done: {from} → {to}',
  '手机上顶栏会亮「更新」按钮，点一下刷新网页': 'On the phone, the top bar shows an "Update" button; tap it to reload the page',
  '有问题可以 pane-remote update --rollback 回到 {rev}': 'If something is wrong, pane-remote update --rollback goes back to {rev}',
  '有新版本（上次拉取时多了 {n} 个提交）': 'A new version is available ({n} new commits as of the last fetch)',
  '（预演，没写）': ' (dry run, not written)',
  '已更新': 'updated',
  '没变化': 'unchanged',
  'agent 工具：{path}': 'agent tools: {path}',
  'agent 工具没链接好，手机上新开 agent 时注入会失败': 'agent tools are not linked; loading them into agents started from the phone will fail',
  '{proc}（pid {pid}）的环境里有 {vars}：在里面开的 Claude 不写会话记录，手机上只能看终端': '{proc} (pid {pid}) has {vars} in its environment: Claude sessions started inside it save no transcript, so the phone shows only the terminal',
  '从 shell 配置（~/.zshrc 等）或 launchctl 环境里去掉 CLAUDE_CODE_SKIP_PROMPT_HISTORY，再 ⌘Q 退出 WezTerm、从程序坞重新打开': 'remove CLAUDE_CODE_SKIP_PROMPT_HISTORY from your shell profile (~/.zshrc etc.) or the launchctl environment, then quit WezTerm with ⌘Q and reopen it from the Dock',
  'WezTerm 是在某个 Claude 会话里启动的：⌘Q 退出 WezTerm，从程序坞或访达重新打开；或者在 pane 里先执行 unset CLAUDE_CODE_CHILD_SESSION': 'WezTerm was started from inside a Claude session: quit it with ⌘Q and reopen it from the Dock or Finder; or run unset CLAUDE_CODE_CHILD_SESSION in the pane first',
  'mux 是在某个 Claude 会话里启动的：在普通终端里先 unset CLAUDE_CODE_CHILD_SESSION，再重启 mux': 'the mux was started from inside a Claude session: run unset CLAUDE_CODE_CHILD_SESSION in a regular terminal, then restart the mux',
  '没有装过 hook 的配置文件，跳过': 'No config file has the hooks installed, skipping',
  '没有 bridge.env，跳过': 'No bridge.env, skipping',
  '用法：pane-remote refresh hooks|bridge-env [--dry-run]': 'Usage: pane-remote refresh hooks|bridge-env [--dry-run]',
  '用法：pane-remote relay server-update [用户@服务器] [--ssh-port 22]': 'Usage: pane-remote relay server-update [user@server] [--ssh-port 22]',
  '<用户>@<服务器>': '<user>@<server>',

  // ---------- relay/relay.mjs ----------
  '给公钥文件路径，比如 {example}': 'Give the public key file path, e.g. {example}',
  '不像是 SSH 公钥': "This doesn't look like an SSH public key",
  '安装路径里有双引号或换行，没法安全地写进 authorized_keys：{path}': "The install path contains a double quote or line break and can't be written safely into authorized_keys: {path}",
  '用法：pane-remote relay tunnel <用户@服务器>': 'Usage: pane-remote relay tunnel <user@server>',
  '没有隧道私钥 {key}：先 {cmd}，再把 .pub 加到服务器的 authorized_keys': 'No tunnel private key at {key}: run {cmd} first, then add the .pub to the server\'s authorized_keys',
  '加载隧道失败：{err}': 'Failed to load the tunnel: {err}',
  '反向隧道已装：服务器的 127.0.0.1:{port} → 这台电脑的 sshd（日志 {log}）': "Reverse tunnel installed: server's 127.0.0.1:{port} → this Mac's sshd (log: {log})",
  '电脑要打开「系统设置 → 通用 → 共享 → 远程登录」，sshd 才会监听': 'Turn on System Settings → General → Sharing → Remote Login on the Mac so sshd listens',
  '反向隧道已去掉': 'Reverse tunnel removed',
  '要 --mac-user（电脑上的用户名）': '--mac-user is required (your username on the Mac)',
  '要 --login（允许访问的 Tailscale 登录名）': '--login is required (the Tailscale login allowed to access)',
  '用户名不对': 'Invalid username',
  '<服务器用户名>': '<server-user>',
  [`增强版：中转模式的辅助命令（完整步骤见 docs/relay.md）

什么时候用：电脑本身跑不了 Tailscale，但有一台在你 tailnet 里、你一个人专用的服务器。
结构：手机 → 服务器上的 tailscale serve → 服务器上的 pane-remote 服务 → SSH 反向隧道 → 电脑上的 agent/bridge

  pane-remote relay authorized-key <公钥文件>     打印电脑 ~/.ssh/authorized_keys 里要加的那一行（只能执行 bridge）
  pane-remote relay tunnel <用户@服务器> [--ssh-port 22] [--remote-port 2222] [--key 私钥]
                                                 在电脑上装一个常驻的反向隧道（launchd），断了自动重连
  pane-remote relay tunnel-off                   去掉反向隧道
  pane-remote relay server-config --mac-user <电脑用户名> --login <Tailscale 登录名>
                                                 打印服务器上 ~/.config/pane-remote/config.json 的内容
  pane-remote relay systemd                      打印服务器上的 systemd 服务文件
  pane-remote relay server-update [用户@服务器] [--ssh-port 22]
                                                 打印把服务器更新到电脑这边版本的命令（默认用反向隧道连的服务器）

完整步骤：docs/relay.md`]: `Relay mode helper commands (full steps: docs/relay.md)

When to use: the Mac itself can't run Tailscale, but you have a server of your own in your tailnet.
Layout: phone → tailscale serve on the server → pane-remote service on the server → SSH reverse tunnel → agent/bridge on the Mac

  pane-remote relay authorized-key <pubkey-file>  print the line to add to ~/.ssh/authorized_keys on the Mac (can only run bridge)
  pane-remote relay tunnel <user@server> [--ssh-port 22] [--remote-port 2222] [--key private-key]
                                                 install a persistent reverse tunnel on the Mac (launchd) that reconnects automatically
  pane-remote relay tunnel-off                   remove the reverse tunnel
  pane-remote relay server-config --mac-user <mac-user> --login <tailscale-login>
                                                 print the content of ~/.config/pane-remote/config.json for the server
  pane-remote relay systemd                      print the systemd unit file for the server
  pane-remote relay server-update [user@server] [--ssh-port 22]
                                                 print the commands that bring the server to this Mac's version (defaults to the reverse tunnel's server)

Full steps: docs/relay.md`,
}
