# pane-remote

中文 | [English](README.en.md)

用手机查看和操作电脑上 WezTerm 或 Herdr 里的终端，Claude Code / Codex 会话有专门的对话视图、推送提醒和会话管理。
不经过任何第三方服务器：手机和电脑之间走你自己的 Tailscale 网络，只有你的账号能打开。

## 终端后端和 agent

**WezTerm 和 Herdr 是同一层级的终端后端，每个 pane-remote 实例选择一个，默认 WezTerm。** Codex、Claude Code 等 agent 运行在它们提供的 pane 中。

| 终端后端 | 列表层级 | 接入 |
|---|---|---|
| WezTerm（默认） | 窗口 → 标签页 → pane | `pane-remote init --terminal wezterm` |
| Herdr | 工作区 → 标签页 → pane → 其中运行的 agent | `pane-remote init --terminal herdr`，见 [接入说明与限制](docs/herdr.md) |

列表只包含所选后端管理的 pane；其他终端里的 Codex、Codex 桌面应用的会话不会自动并入。Cursor IDE 是独立的可选模块。Herdr 列表显示 agent 类型和已注册的名称，工作区可以折叠，内部编号保留在操作详情中。

打开网页时，链接指定的会话优先，其次恢复当前浏览器上次查看的会话；找不到时再选终端当前聚焦的 pane 或列表第一项。实时画面按查看的 pane 连接，但状态提醒仍会扫描所选后端全部 pane；折叠工作区只改变显示，当前还不能按工作区限制后台监控范围。

## 能做什么

**基础版**（装完就有）

- **一个会话列表**：所选终端的 pane 和（开了 Cursor 模块时）Cursor 的会话合在一起，状态统一标出（等你操作 / 做完了 / 运行中 / 有新内容）；地址就是界面状态（`#/s/p12`、`#/plugin/preview`），推送、待办都直接跳到那个地址，手机的返回手势能用
- 有 agent 会话的 pane 默认打开对话视图，「原始画面」一键切回终端；每个 pane 各自记住
- **模型和思考等级**：会话栏的模型芯片一键切换 Claude Code / Codex / cursor-agent 的模型和思考等级（只在 agent 空闲时做，见 [docs/agent.md](docs/agent.md#模型和思考等级)）
- 所选终端后端中 pane 的实时画面，手机上直接打字、按键（键盘栏、方向摇杆、Ctrl / Shift / Option）、滑动滚动、轻点
- **电脑版**：在另一台电脑的浏览器里打开（宽屏 + 鼠标时自动切换）：会话列表常驻左边，终端直接用键盘打字（多行粘贴整段发送），看屏幕用真鼠标键盘；适合出门在外用笔记本连回家里的电脑。键盘、鼠标按设备认，不看窗口宽度：窗口拉窄、开了显示缩放照样能用，手机 / 平板接了键盘或鼠标、触控板也一样（全屏程序里左中右键、拖动、双指滚动都能发过去）
- 新建标签页、拆分、关闭 pane、重命名标签页，在电脑上切到某个 pane；WezTerm 另支持调宽和均分标签页，Herdr 目前支持向右 / 向下拆分，暂不支持调宽与均分
- Claude Code / Codex：
  - 对话视图（按会话记录排版，比终端好读）
  - **分叉会话**：带着当前会话的全部上下文在新 pane 里开一个新会话（对话栏「分叉」、pane 菜单、拆分时都能选）
  - **恢复会话**：新建标签页时列出所选目录最近的 Claude 会话，点一条就在新 pane 里用 `--resume` 接着聊（已经开在某个 pane 里的直接切过去；还开在别处的，比如 Claude 桌面应用，改成带着上下文分叉一个新会话）
  - 同目录新开会话、常用斜杠命令
  - 会话里的定时任务面板：看排期和上次结果，一键立即执行 / 重启 / 停止
  - 焦点跑到后台 agent 列表时提醒并一键回到输入框
- 推送通知：某个 pane 在等你选择 / 确认、或者一轮做完时推到手机（你在电脑前时不推）
- 待办收件箱：所有在等你操作的 pane 集中处理
- 传文件到电脑、长按识别终端里的链接
- 自动重连 + 手动重连

**增强版模块**（按需开启）

| 模块 | 作用 | 开启 |
|---|---|---|
| 预览浏览器 | 手机上看电脑这边的网页（localhost、内网都行）和文件（文件夹、图片、视频、PDF、Markdown、代码），支持电脑模式（桌面 UA、横屏全屏）；网页里下载的文件、当前页（本机文件给原文件，网页存成 PDF）能存到手机 | 有 Chrome 时默认开；`pane-remote enable preview` |
| 网址转手机 | 电脑上打开链接时，如果你正在用手机，就转到手机的预览里打开 | `pane-remote enable openUrl` |
| Cursor 映射 | 手机上看和操作 Cursor IDE：会话、消息、待办 / 未读、命令输出、改动差异、内置浏览器 | `pane-remote enable cursor`，见 [docs/cursor.md](docs/cursor.md) |
| 看屏幕 | 手机上看和操作电脑屏幕（一块显示器或单个窗口）：点、拖、滚动、触控板模式、打字（含中文）、多指手势、后台打开 app。登录走系统自带的屏幕共享，画面由 ScreenCaptureKit 录、在电脑上转码后再传；还能关窗口、退出 app、改窗口大小、点到输入框自动弹键盘、锁屏时打字 | `pane-remote enable screen`，见 [docs/screen.md](docs/screen.md) |
| 这台电脑 | 手机上看电脑的性能（CPU、内存、占用最多的进程），让电脑用自带的 say 念一段话 | `pane-remote enable mac`，见 [docs/mac.md](docs/mac.md) |
| Agent 工具 | 从手机上开的 Claude Code / Codex / cursor-agent 加载 pane-remote 插件：做完推送、卡住了在手机上问你、把网页开到手机预览；开着的会话能「重启并注入」，重启前存快照、起来后恢复后台任务 | 默认可用，见 [docs/agent.md](docs/agent.md) |
| 问题报告 | 服务端、手机、电脑端脚本和 agent 发现的异常收到一处去重计数，推送问你要不要修；一键交给绑定的会话或新开的 agent 修，修完回报 | 默认可用，见 [docs/incidents.md](docs/incidents.md) |
| 插件平台 | 悬浮按钮打开插件抽屉：预览、这台电脑、看屏幕都是自带的插件，也能跑 uTools / whatevertools 格式的插件（`plugins/` 目录）；插件能用电脑上已登录的 Claude Code / Codex / cursor-agent 做 AI、读你允许的文件夹，每项能力都先在手机上问你 | 默认开；`pane-remote disable plugins` 关掉，见 [docs/plugins.md](docs/plugins.md) |
| pane-host | 电脑上的常驻服务：对话视图和事件改成推送，插件的 AI、电脑剪贴板、只读文件走它；不在线时自动回到老路 | `init` 装成 LaunchAgent，见 [docs/host.md](docs/host.md) |
| 中转模式 | 电脑本身跑不了 Tailscale 时，经一台在你 tailnet 里的服务器转发 | 见 [docs/relay.md](docs/relay.md) |
| 持久化 pane | WezTerm 窗口关了 pane 也不丢，手机照样能连 | 见 [docs/advanced.md](docs/advanced.md) |

## 需要什么

| | 说明 |
|---|---|
| 电脑 | macOS（Apple 芯片或 Intel） |
| 终端 | 默认 [WezTerm](https://wezfurlong.org/wezterm/)（安装脚本会装），也可选用 [Herdr](docs/herdr.md) |
| 网络 | [Tailscale](https://tailscale.com)，电脑和手机登录同一个账号。tailnet 要打开 **MagicDNS** 和 **HTTPS Certificates**（管理后台 → DNS）。自建的 Headscale 一般签不了 HTTPS 证书，用不了 |
| 手机 / 另一台电脑 | iPhone（iOS 16.4 以上才有推送）或 Android，装 Tailscale App；也可以是另一台电脑的浏览器（装 Tailscale） |
| 可选 | Claude Code、Codex（对话视图、分叉等功能）；Chrome（预览浏览器）；Cursor（Cursor 模块）；Xcode 命令行工具（看屏幕模块） |

默认安装脚本用 [Homebrew](https://brew.sh) 装 WezTerm 和 Tailscale；Herdr 用户先安装 Herdr、Tailscale，再使用下方的 `--no-brew --terminal herdr`。Node.js 用电脑上已有的（20 以上），没有就从 nodejs.org 下载官方版本并校验，只给 pane-remote 自己用。

## 安装

```bash
git clone <仓库地址> ~/pane-remote
cd ~/pane-remote
./install.sh
```

装完终端里会给出一个 `https://<电脑名>.<tailnet>.ts.net/` 地址（装了 qrencode 还会显示二维码）。手机上：

1. 打开 Tailscale App，登录和电脑同一个账号
2. Safari 打开那个地址
3. 分享 → 添加到主屏幕，从主屏幕打开（推送通知只在这种方式下能用），在右上角的铃铛里打开通知

**已经开着的 Claude / Codex 会话要重开一次**，新的 hook 才会生效（推送、对话视图要用）。用 Codex 的话，还要在 Codex 里确认信任新加的 hook。

常用参数：

```bash
./install.sh --yes                       # 全用默认选项
./install.sh --chrome                    # 没装 Chrome 又想用预览浏览器：用 Homebrew 装 Google Chrome
./install.sh --login you@example.com     # 允许访问的 Tailscale 账号（默认是电脑登录的账号；电脑是标签设备时必须指定）
./install.sh --no-brew                   # 自己装好所选终端后端、Tailscale，不用 Homebrew
./install.sh --no-brew --terminal herdr  # 使用已安装的 Herdr；默认连接本机默认会话
./install.sh --lang en                   # 命令行用英文（默认按系统语言）
```

## 日常命令

```bash
pane-remote doctor            # 自检：每一项有问题都会给出修复办法
pane-remote status            # 服务在不在跑
pane-remote restart | logs
pane-remote stop | start      # 停 / 开服务；stop 连预览用的 Chrome 一起关（下次用预览会自动再开）
pane-remote enable preview    # 开 / 关模块：preview、openUrl、cursor、screen、mac、plugins
pane-remote disable openUrl
pane-remote init              # 改了配置、换了电脑名、装了新的 Claude 配置目录后重跑一次（保留原有配置）
pane-remote uninstall         # 停服务、撤掉 tailscale serve、还原 hook；加 --purge 连配置和数据一起删
```

没有 `pane-remote` 命令时用 `~/pane-remote/bin/pane-remote`。

## 更新

```bash
pane-remote update --check     # 只看有没有新版本：列出新提交和改动的文件、要做的步骤（退出码 0 = 已是最新，10 = 有更新）
pane-remote update             # 预览后问你确认（y/N），再应用；不在终端里运行时要加 --yes
pane-remote update --rollback  # 回到上一次更新之前的版本
```

- **只从 `origin` 更新，而且必须是 https 地址。** 第一次 `init` / `update` 时把 origin 地址和分支记进配置的 `updateSource`；之后 origin 被改成别的地址就拒绝更新（确实是你自己改的，就同步改 `updateSource`）
- 你确认之前，不会执行拉下来的任何代码
- 工作区有改动、或者本地有上游没有的提交时拒绝更新，只做快进合并（`git merge --ff-only`），不会 reset / stash / 覆盖你的改动
- 只重做改动涉及的步骤：`package.json` / `package-lock.json` 变了重装 npm 依赖（和 `install.sh` 一样的参数；开了看屏幕模块会补装 sharp）；mousectl 的源码或安装脚本变了、并且开了看屏幕模块，重装 mousectl；命令行或 hook 脚本变了，重新合并 hook（只动已经装过的配置文件）和 `bridge.env`；服务端、网页、插件、电脑端脚本变了，重启后台服务；`host/`、依赖或会话记录解析变了，重启 pane-host
- 应用后跑一遍 `doctor`：某一步失败、或者比更新前多出了问题，就自动回到旧版本，再用旧版本把这些步骤重做一遍
- 看屏幕模块：没用 `--create-cert` 建签名证书时，安装脚本不会重编已有的 mousectl，update 会提示你；建了证书之后重编，授权不会掉（见 [docs/screen.md](docs/screen.md)）
- `install.sh`、`Brewfile` 变了不会自动重跑，update 会提示你看一下改动
- 中转模式：服务器那边要跟着更新时，update 最后会打印要执行的命令（也可以随时 `pane-remote relay server-update`），不会自动连服务器
- `pane-remote doctor` 会根据上次拉取的结果提示有没有新版本（不联网）

## 配置

`~/.config/pane-remote/config.json`（init 生成，改完 `pane-remote restart`）：

| 键 | 含义 |
|---|---|
| `terminalBackend` | 终端后端，默认 `wezterm`，也可选 `herdr`（见 [配置说明](docs/herdr.md)） |
| `paths.herdrSocket` | Herdr 会话的绝对 socket 路径 |
| `allowedLogins` | 允许访问的 Tailscale 登录名 |
| `serveHosts` | tailscale serve 的主机名（init 自动填） |
| `port` | 本机服务端口，默认 8787 |
| `presets` | 新建 pane 时可选的启动命令，比如 `{"label": "Claude Code", "command": "claude"}` |
| `claudeWrappers` | Claude 配置目录 → 启动命令。用多个 `CLAUDE_CONFIG_DIR` 时，分叉、恢复会话要用同一个配置目录启动 |
| `modules` | 模块开关 |
| `paneHost` | 连不连电脑上的 pane-host（默认 `true`，见 [docs/host.md](docs/host.md)） |

## 安全

- 服务只监听 `127.0.0.1`，由 `tailscale serve` 对你的 tailnet 提供 HTTPS，不暴露到公网
- 每个请求都要带 tailscale serve 注入的访问者身份（`Tailscale-User-Login`），不在 `allowedLogins` 里的一律拒绝；还要求 Host 是你电脑的 ts.net 主机名，挡住电脑上浏览器里的网页借 localhost 调接口
- 所有改动类请求（非 GET）都必须来自本站页面（校验 Origin / Sec-Fetch-Site），挡住别的网页借你的登录身份发请求
- 操作终端都经过 `agent/bridge`：只认固定的几种指令，参数逐个校验，不执行任意 shell
- 预览浏览器的文件服务只监听本机、地址带随机令牌，只能读家目录和 `/tmp`；生成的页面有严格的 CSP，Markdown 经 DOMPurify 清洗，脚本库都从本机提供；原始文件在沙箱里给出
- 预览里的 Markdown 只显示本机的图片，外网图片（徽章之类）不加载，避免打开文件时向外发请求
- **前提：这台 Mac 只有你自己在用。** 服务信任本机 127.0.0.1 上带的身份请求头，电脑上的其他用户或恶意程序能伪造它；预览用的无界面 Chrome 的调试端口也只靠「只监听本机」保护（不过能在你电脑上跑程序的话，本来也能直接操作你的终端）。中转模式下，中转服务器也要是你一个人专用的
- **这相当于用手机远程操作你的电脑终端**：别把 `allowedLogins` 加成别人的账号，别用 `tailscale funnel` 把它开到公网

## 常见问题

**打开地址显示 forbidden**：手机上 Tailscale 登录的账号不在 `allowedLogins` 里，或者你是通过 IP 而不是 ts.net 地址打开的。

**对话视图、推送没反应**：会话是装 hook 之前开的，重开一次；`pane-remote doctor` 看「hook 有在记录事件」那一项。

**终端上面有一条黄色提示，说这个 Claude 没在保存会话记录**：Claude 带着 `CLAUDE_CODE_CHILD_SESSION`（WezTerm 是在另一个 Claude 会话里打开的）或 `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 启动时不写会话记录，对话视图就出不来。⌘Q 退出 WezTerm、从程序坞重新打开，或者在 pane 里先 `unset CLAUDE_CODE_CHILD_SESSION` 再开 Claude；从手机上新开 / 分叉 / 重启的 Claude 会自动去掉前一个。`pane-remote doctor` 会查 WezTerm 和 mux 进程的环境里有没有这两个变量。

**WezTerm 连不上**：电脑上要开着 WezTerm 窗口；想关窗口也能用，见 [docs/advanced.md](docs/advanced.md) 的持久化配置。

**tailscale serve 失败**：tailnet 没开 HTTPS Certificates，或者 443 端口被别的服务占了（init 会自动改用 8443）。

## 目录

```
install.sh          一键安装
bin/pane-remote     命令入口（lib/cli.mjs）
server/             服务端（手机网页的后端）
host/               pane-host：电脑上的常驻服务（对话 / 事件推送、AI 提供方、插件的电脑端能力）
platform/           插件平台 core（权限、审计、能力表）
plugins/            插件目录（自带两个示例：hello、ai-demo）
agent/              电脑这边的脚本：bridge（操作终端的统一入口）、hook、会话记录解析、预览浏览器、Cursor 适配、看屏幕（screen/）、这台电脑（mac/）、agent 插件（plugin/、pane-agent）
web/                手机网页源码（Svelte），构建产物在 public/
relay/              中转模式的辅助命令
scripts/audit.mjs   发布前审计：查个人信息、内网地址和密钥
```

改了前端要重新构建：`npm run build`（会在 web/ 里装开发依赖）；`cd web && npm run size` 检查首屏体积（上限 150 KB gzip）。测试：`npm test`；改了前端或服务端，部署（重启服务）前再跑一次浏览器冒烟测试 `node scripts/smoke.mjs`（要 Chrome，在本机起一个临时服务端，不碰你在用的那个），不过就别上。

## 许可证

[MIT](LICENSE)
