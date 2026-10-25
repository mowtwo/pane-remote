// Host 接口：pane-host 里和操作系统 / 终端 / agent 绑定的部分。pane-host 的服务（transcript、events…）只通过它干活，
// 换一个平台（Linux + tmux / WezTerm）只要另写一个实现，见同目录 README.md。这里只有类型说明（JSDoc），没有代码。
//
// 现在用到 terminals / agents / events / desktop（剪贴板、打开网址）；ide、secrets 先占位，后面的能力（Cursor 映射、钥匙串）再填。

/**
 * @typedef {object} Terminal 一个终端 pane（和服务端 /api/panes 返回的形状一致，服务端可以原样转给手机）
 * @property {number|string} pane       pane 编号（同一个终端服务器里唯一）
 * @property {number|string} tab
 * @property {number|string} window
 * @property {string} workspace  WezTerm workspace；测试用的是 pane-remote-test
 * @property {{kind: string, name: string}|null} [terminalAgent] Herdr snapshot agent identity
 * @property {string} title
 * @property {string} tabTitle
 * @property {string} cwd        家目录缩写成 ~ 的路径（显示用）
 * @property {string} dir        绝对路径
 * @property {number} cols
 * @property {number} rows
 * @property {boolean} active
 * @property {{x: number, y: number, visible: boolean}} cursor
 */

/**
 * @typedef {object} AgentSession pane 里正在跑的 agent 会话（找不到就是 {}，或只有 agent）
 * @property {'claude'|'codex'|'cursor-agent'|'grok'} [agent]
 * @property {string} [session]     会话 ID
 * @property {string} [transcript]  会话记录文件（Claude / Codex 是 jsonl，cursor-agent 是 store.db）
 * @property {string} [configDir]
 * @property {string} [cwd]
 */

/**
 * @typedef {object} Message 对话消息（和服务端 /api/transcript 返回的一致）
 * @property {string} id
 * @property {'user'|'assistant'} role
 * @property {string} ts
 * @property {Array<{type: 'text', text: string} | {type: 'tool', name: string, summary: string, result: string|null, error: boolean}>} parts
 */

/**
 * @typedef {object} Host
 * @property {string} platform  'macos' | 'linux' …
 * @property {object} terminals
 * @property {() => Promise<Terminal[]>} terminals.list
 * @property {(pane: number|string, opts?: {lines?: number, escapes?: boolean}) => Promise<string>} terminals.text  画面文字（含最近若干行回滚）
 * @property {object} agents
 * @property {(pane: number|string) => Promise<AgentSession>} agents.session
 * @property {(s: AgentSession, n: number) => Promise<Message[]>} agents.messages  会话最近 n 条消息
 * @property {(s: AgentSession) => string[]} agents.watchFiles  会话记录变了要看哪些文件（fs.watch 用；SQLite 还要看 -wal）
 * @property {object} events
 * @property {string} events.log  hook 事件日志（JSON 行，只追加；超长时截掉前半，第一行写 {"base":截掉的字节数}，见 agent/pane-event）
 * @property {object} [ide]      以后：Cursor IDE 映射
 * @property {object} [desktop]  桌面：插件选了「用 Mac 的」剪贴板 / 打开网址时用（以后再加屏幕 / 键鼠）
 * @property {() => Promise<string>} desktop.clipboard.readText
 * @property {(text: string) => Promise<boolean>} desktop.clipboard.writeText
 * @property {(url: string) => Promise<boolean>} desktop.openUrl  在本机浏览器打开（只会收到 http(s)），不要经过会转回手机的 open 包装
 * @property {object} [secrets]  以后：钥匙串（launchd 起的进程能读，ssh 进来的不能）
 */
export {}
