# Herdr 终端后端

pane-remote 可以连接这台 Mac 上的一个 Herdr 会话。默认仍是 WezTerm；选用 Herdr 后不需要安装或打开 WezTerm。

## 启用

先安装 Herdr 并打开要管理的会话。已有 pane-remote 安装可以执行：

```bash
pane-remote init --terminal herdr
```

默认连接 `~/.config/herdr/herdr.sock`。命名会话需要明确指定 socket，例如 `work`：

```bash
pane-remote init --terminal herdr \
  --herdr-socket "$HOME/.config/herdr/sessions/work/herdr.sock"
```

首次安装时，自己装好 Herdr、Tailscale 后使用：

```bash
./install.sh --no-brew --terminal herdr
```

`--no-brew` 跳过默认 Brewfile 中的 WezTerm 安装。Herdr 必须由你启动；pane-remote 不启动、升级或停止 Herdr server，连接失败也不会切到其他会话。`pane-remote doctor` 可检查已选终端的连接。

也可以合并以下字段到 `~/.config/pane-remote/config.json`（保留其他配置）：

```json
{
  "terminalBackend": "herdr",
  "paths": {
    "herdrSocket": "/absolute/path/to/herdr.sock"
  }
}
```

手动改配置后执行 `pane-remote refresh bridge-env` 和 `pane-remote restart`，使 bridge 与 pane-host 使用同一配置。中转模式下，这些终端设置应写在被控制的 Mac 上；保留原有 relay 配置，不必重跑 local 模式的 init。

切回 WezTerm：`pane-remote init --terminal wezterm`。

## 支持的操作

- 按 workspace / tab 列出 pane，显示标题、目录、终端大小。
- 实时文本和 ANSI 画面、回滚内容、中文输入、回车、控制键及粘贴。
- 新建 tab、向右或向下拆分、关闭 pane、重命名 tab、切换电脑上的焦点。新建和拆分不抢焦点。
- 复用 Claude Code / Codex 的会话识别、对话记录、恢复和分叉流程；hook 事件沿用现有推送和收件箱流程。会话记录仍需 agent 本身保存。
- pane-host 与旧 bridge 通道使用同一个后端；MCP 和 hook 优先采用选定 Herdr 会话中的 pane 身份，不会误记为外层 WezTerm pane。

界面里的「窗口」对应 Herdr workspace；「新窗口」会创建 workspace。「标签页」对应 Herdr tab。pane ID 保留 Herdr 原始值，例如 `w1:p2`、`wA:pB`，链接形如 `#/s/pwA:pB`。

## 列表层级与默认打开的会话

Herdr 的层级是「工作区 → 标签页 → pane」；agent 运行在 pane 中。列表按这个层级缩进，显示 Codex、Claude Code 等类型，以及 Herdr 中已命名的 agent 名称。未识别到 agent 的 pane 显示为普通终端；名称和类型来自同一份 Herdr 快照，不按标题猜测。点击工作区标题可以折叠或展开。

这属于终端来源选择：选择 Herdr 后，只列出所选 Herdr server 管理的 pane，其中可以运行不同 agent。其他终端里的 Codex 或 Codex 桌面应用的会话不会自动并入。WezTerm 与 Herdr 当前按实例二选一，Cursor 是独立可选模块。

打开网页时，优先使用链接指定的会话，然后恢复这台浏览器上次查看的会话；找不到时选择终端当前聚焦的 pane，最后才用列表第一项。不会优先选择某种 agent。点击列表里的另一项会更新本机浏览器记忆；若收藏了带具体会话的链接，收藏链接仍优先。目前没有单独的固定首页会话设置。

折叠只改变界面显示，不缩小后台监控范围。实时终端画面按正在查看的 pane 连接，离开后最多保留 45 秒用于快速切回，最多保留 3 条这样的连接。手机正在使用或存在推送订阅时，后台仍定期扫描所选来源全部 pane 的末尾输出，用于状态和提醒；所以会话很多时仍有额外开销。目前还没有按工作区选择监控范围的设置。

## 当前边界

- 每个 pane-remote 实例选择一个终端后端、一个本机 Herdr socket，不聚合多个 Herdr server，也不通过 Herdr 的 machine 配置操作远程机器。
- 暂未适配 pane 调宽和均分，Herdr pane 的调宽按钮隐藏；左、上拆分会明确报错。可在 Herdr 本身调整布局。
- Herdr 0.9.5 的公开快照不提供终端光标坐标，因此不会绘制推测的光标位置。Herdr 返回的 TTY 为空时，按 shell PID 批量查询本机 TTY；终端尺寸优先从 TTY 读取，不可读时退回布局矩形。
- hook 会忽略 `HERDR_SOCKET_PATH` 与配置不一致的会话。使用自定义 pane-remote 配置时，agent 的 hook/MCP 进程也需要继承 `PANE_REMOTE_CONFIG` 或 `PANE_REMOTE_BRIDGE_ENV`。

## 开发验证

适配依据 [Herdr Socket API](https://herdr.dev/docs/socket-api/) 以及 Herdr **0.9.5 / protocol 22** 的内置 schema 和源码。测试运行真实的 pane-remote bridge、HTTP 服务、hook 和 host 适配器，对接临时目录里的协议模拟器，不会接入个人 Herdr 会话：

```bash
node --test agent/test/herdr.test.mjs
npm test
npm run check --prefix web
npm run build --prefix web
node scripts/smoke.mjs
```

浏览器冒烟测试需要 Chrome，覆盖含字母的 Herdr pane 路由和键盘输入。文本读取使用被动 ANSI 快照并在本地去除格式，避免 Herdr 的交互式历史采集滚动 agent 界面。模拟器测试不等于实际 Herdr 会话的端到端验收；发布前应在专用测试会话中再确认终端画面、输入、创建/关闭和真实 agent 的会话记录。
