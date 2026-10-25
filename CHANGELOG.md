# Changelog

All notable changes to pane-remote are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions were tagged retroactively. Version numbers start at 0.2.0 because
earlier work predates the public repository.

## [Unreleased]

### Fixed
- On a Mac without a monitor (screen sharing uses a virtual display) the screen view showed an empty display name. Displays without a name are now labelled with their number and resolution, e.g. "Display 1 · 1920×1080".
- Opaque cross-origin `Script error.` reports (no file, line or stack; they come from browser extensions or injected scripts, not pane-remote) are no longer recorded as incidents.
- On a slow network the page could be reported as stuck ("not mounted after 6s") while it was only waiting up to 5 seconds for the lease. The check now gives a page whose main script is already running another 6 seconds; it still waits for the lease before mounting, so streams never race the claim.
- A WezTerm restart (its mux socket briefly gone) is treated as the Mac being offline instead of raising an incident.
- `docs/relay.md`: new step 0 for the server — a regular service user, Node at `/usr/bin/node`, and the directories the systemd unit writes to created beforehand; without them the unit fails to start.

## [0.15.4] - 2026-10-25 — Switch accounts on restart

### Added
- Restarting a Claude session from the phone with another account's wrapper (`claude-<name>`, or an explicit `CLAUDE_CONFIG_DIR=`) copies the project's transcripts, memory and the session's tasks to that account after the old process exits and before the new one starts, so `--resume` finds the whole conversation.

### Fixed
- `pane-agent` reads process start times with `LC_ALL=C`, so they parse under a non-English locale.
- The terminal view threw `null is not an object (evaluating 'scrollHeight')` when a scroll event arrived just after it was closed.

## [0.15.3] - 2026-10-25 — Say why a Claude session has no chat view

### Fixed
- A Claude started with `CLAUDE_CODE_CHILD_SESSION` inherited (WezTerm opened from inside another Claude session) or with `CLAUDE_CODE_SKIP_PROMPT_HISTORY` set does not save a transcript, and does not write `sessions/<pid>.json` either. pane-remote then fell back to the transcript path recorded by the SessionStart hook, opened the chat view, and showed "no conversation yet" forever. `agent/pane-transcript` now reads the Claude process's environment, reports `noTranscript: child-session | skip-history`, and drops hook paths whose file does not exist; the phone shows a banner above the terminal with the cause and the fix.
- Claude sessions that pane-remote starts (new / fork from the phone, restart, start with tools) unset `CLAUDE_CODE_CHILD_SESSION` first. `CLAUDE_CODE_SKIP_PROMPT_HISTORY` is left alone, since it may be deliberate.
- On a phone or tablet with a hardware keyboard, the shortcut bar is hidden like on a computer.

### Added
- `pane-remote doctor` warns when the WezTerm GUI or the mux server was started with `CLAUDE_CODE_CHILD_SESSION` or `CLAUDE_CODE_SKIP_PROMPT_HISTORY` in its environment (every Claude opened inside it would save no transcript), and says how to fix it.

## [0.15.2] - 2026-10-25 — Mouse and trackpad in the terminal on any device

### Fixed
- Cursor 3.27 (`cursor` module): conversations stopped updating on the phone. Cursor has stored the message list three ways (`fullConversationHeadersOnly` in composerData, the agent transcript file in 3.26, `composerConvHeaders:<id>:<chunk>` with 256 headers per chunk in 3.27), and old conversations keep the old format. The adapter now reads all three and uses whichever is newest; it switches source only when the other one is more than a minute newer. While a run is going, 3.27 keeps the previous run's status in composerData, so the sidebar status decides whether the conversation is busy. `agent/test/cursor-sources.test.mjs` (part of `npm test`, skipped without `node:sqlite`) covers each format and the switch.
- Keyboard and mouse input in the terminal depended on the window being at least 1024px wide. A laptop with display scaling, or a narrow PWA window, got neither. Input now follows the device: a new device module (`web/src/lib/device.svelte.ts`) tells phone / tablet / computer apart from what the system reports (an iPad in desktop mode is recognised by its touch points), whether a mouse or trackpad is attached (including one connected to an iPhone or iPad), whether a hardware keyboard is in use, and whether each pointer event comes from a mouse or a finger. Window width now only decides the layout.
- In full-screen programs, the mouse and trackpad now send everything a terminal does: left, middle and right buttons, dragging (motion while held), trackpad two-finger scrolling (xterm's own viewport was swallowing wheel events), and Shift / Option / Control as modifier bits. Right-click no longer opens the browser menu there.
- Finger taps on a phone with a mouse attached are no longer sent twice: compatibility mouse events that follow a tap are ignored, in the terminal and in the screen view. The screen view takes the mouse whenever one is attached, not only in the desktop layout.
- `scripts/smoke.mjs` narrows the desktop window and checks that typing still goes to the pane.

## [0.15.1] - 2026-10-24 — Pages recover after a dropped connection

### Fixed
- When the connection dropped while a page or panel was loading (the terminal, chat, a sheet, a built-in plugin), that part stayed blank until the app was closed and reopened. It now waits for the network to come back and loads again; if retrying cannot help, the page reloads once.
- These failed loads are no longer reported as problems (each was also reported twice, once by the fallback reporter in index.html).
- `scripts/smoke.mjs` drops the terminal chunk on load and checks that the page recovers by itself.

## [0.15.0] - 2026-10-24 — Save files from the preview to the phone

### Added
- Files from the browser preview can be saved to the phone.
  - A download started inside the preview (a download link, or a URL that is a file) is kept on the computer, and the phone shows "Save to phone". Touch devices open the share sheet (Save to Files, Save Image, send to another app); desktops download the file.
  - "Save page" in the tabs panel: a local file opened in the file browser is sent as the original file; a web page is saved as PDF.
  - The file browser shows a "Download" link next to each file.
  - The tabs panel lists recent downloads, and tapping one saves it again. Files kept on the computer are deleted after a day.
- `GET /api/preview/file?id=…` streams a kept file as an attachment; the bridge reads it with the new `preview-get` command (works in local and relay mode).

## [0.14.0] - 2026-10-24 — Desktop layout

### Added
- Desktop layout, picked automatically on a wide screen with a mouse (at least 1024 px and a fine pointer); phones and tablets keep the touch layout.
  - The session list stays open on the left instead of a bottom sheet; panels open centered.
  - The terminal takes the physical keyboard directly (Ctrl keys, arrows, Esc). Multi-line paste is sent as a bracketed paste, so a shell or Claude Code receives it as one block. In full-screen programs the mouse wheel scrolls and clicks go through. The shortcut bar is hidden.
  - Screen view uses the real mouse (move, click, right click, drag, wheel) and the real keyboard (⌘ maps to Command). Shortcuts the browser keeps for itself (⌘W, ⌘T, ⌘Q) and IME text still go through the input bar.
- `scripts/smoke.mjs` checks the desktop layout: sidebar, typing into the terminal, bracketed paste, no shortcut bar.

## [0.13.3] - 2026-10-23 — Prompts from background subagents reach the phone

### Fixed
- A permission prompt that a background subagent raises right after the main turn ends is pushed; the 15-second cooldown after "done" no longer swallows it.
- Repeated confirmations with the same question (an MCP server asking "Run it on project …?" for each query) are pushed each time: prompts are told apart by the whole dialog, not just the question line.
- MCP confirmation dialogs (`❯ Accept    Decline`) and other selectors without numbers (the trust-folder prompt) get buttons on the phone; tapping one sends the arrow keys and Enter.
- The "Elicitation response …: accept" receipt Claude Code sends after you answer is no longer pushed as "waiting for you".

## [0.13.2] - 2026-10-23 — Todo list scoped to the calling session

### Changed
- `plugin_todo_list` without `project` now returns only the caller's own items (added or claimed by that session, or under its working directory) and just counts the rest (`others.count`); `project: "all"` lists everyone's. Agent instructions and the skill say to use "all" only when the user explicitly asks, and that "your tasks" means the session's own task list. Todo plugin 0.3.1.

## [0.13.1] - 2026-10-23 — Move a window to another display

### Added
- Screen module: move a window to another display, from the window list (monitor button on each row) or from More while viewing that window. Size is kept (shrunk if it doesn't fit) and so is its relative position; the window stream follows it. New `mousectl` command `w move <windowID> <display>`, bridge `screen-move`, endpoint `POST /api/screen/move`.

## [0.13.0] - 2026-10-23 — Agent tasks in Todo

### Added
- Todo: an "Agent tasks" tab showing each running Claude Code session's own task list (TaskCreate / TaskUpdate), live and read-only: grouped by session with counts, in-progress first with their status text, dependencies, completed ones folded. Tap a task to make it a todo (linked to the session and the task, no duplicates) or to ask that session for progress.
- Plugin API 0.6.0: `platform.sessions.tasks()`; pane-host `agents.tasks` reads `<config dir>/tasks/<session>/*.json` (home-directory `.claude*` config dirs only).

## [0.12.2] - 2026-10-23

### Fixed
- Opening the screen view could mark the phone as taken over: the takeover close code (4001) clashed with the screen proxy's "can't reach the computer". Takeover now uses 4409.
- The server crashed when a client reset its connection during a WebSocket upgrade (unhandled socket error).

### Added
- `scripts/smoke.mjs`: a browser smoke test on a throwaway local server (shell, takeover, WebSocket wrappers vs noVNC, terminal, plugins, todo, no uncaught errors). Optional modules that are off are skipped. Run it before restarting the service after frontend or server changes.

## [0.12.1] - 2026-10-23

### Fixed
- The screen view (VNC) could not connect since 0.8.0: the single-client wrapper replaced `WebSocket` with a subclass, and noVNC rejects a socket whose prototype doesn't list `send` / `close` / `binaryType` itself. The wrappers now return native `WebSocket` / `EventSource` instances.
- WebSockets now carry the client id too (the same-origin check compared `ws://` with `http://`), so taking over also closes the other device's WebSocket connections.
- Cursor conversations stopped updating on the phone (only old messages plus the final reply showed) when a list-only Cursor connection connected after the conversation view: the server now watches the most recent connection that is viewing a conversation.

## [0.12.0] - 2026-10-23 — Plugin schedules, overdue reminders

### Added
- Plugins can schedule work, the uTools way: `requestSchedule` (one-off timestamp or 5-field cron with optional start / end), `getSchedules`, `removeSchedule`, and `onScheduleTrigger` in the preload. Built on the whatevertools core `Scheduler`, stored in the server data directory, fired in the plugin's sandboxed tool runtime so the phone doesn't need the plugin open. Permission `schedule`.
- Todo: overdue reminder, on by default. Every day at a time you pick (default 09:00) it pushes the overdue and due-today items; switch it off under the view settings, or mute single items. The first open sets it up and asks for the schedule and notification permissions.
- Plugin API 0.5.0.

## [0.11.0] - 2026-10-23 — Todo collaboration

### Added
- Todo: who should do it (agent / needs the user / undecided), status in progress (with the claiming session) and waiting for you (the agent's question), due dates with overdue marking, links, an activity log, and a recycle bin (restore within 30 days, empty, delete forever). Deleting from the phone and the agent's `remove` both go to the trash.
- Todo: tap an item to run it or check it now; the prompt (with the item id and how to report back) goes to the session that created it, or once to another session you pick. Optional subagent mode is remembered. Running marks the item in progress.
- Todo: agents can claim items (`plugin_todo_start`, refuses if another live session has it), comment, and ask you (`plugin_todo_comment` with `needs_reply`: pushed to the phone; your reply is sent straight back to that session). New tools `get`, `start`, `comment`; `list` filters by status, who and overdue.
- Todo: what you do on the phone (done, reopen, edit, comment, delete, restore) is passed to the session that created or claimed the item, without interrupting it: it sees it with your next message or its next pane-remote tool call. Old items get their session id backfilled from the pane they were added in.
- Todo: quick filters (needs me, agent can do, in progress, undecided, overdue), sort (smart, due, priority, newest, recently updated, manual), group by project, tag, priority, status or who, and drag to reorder (manual order is synced).
- Todo: free-text input analyzed by AI (the plugin AI API) into operations (add, edit, done, delete, comment, run, check), shown for confirmation before they are applied.
- Plugin API 0.4.0: `platform.sessions.list / send / note` (permission `platform.sessions`). Session notes reach Claude Code through a UserPromptSubmit hook in the agent plugin (`agent/plugin/hooks/hooks.json`) and any agent through pane-remote tool results. Tool handlers get `ctx.caller.session`.

### Changed
- Permissions needed inside a plugin tool runtime (push, AI…) are asked with the phone card instead of being refused.

### Fixed
- Todo filter chips with no items no longer render as "null".

## [0.10.1] - 2026-10-23

### Changed
- Updates reach running agents without reconnecting their MCP server: `agent/plugin/mcp.mjs` is now a small launcher that runs the server (`mcp-server.mjs`) in a child process and hot-swaps it when the file changes (replaying `initialize`, letting the old process finish its requests, then sending `tools/list_changed`). A new version that fails to start is discarded and the old one keeps serving. Agents started before this version need one last reconnect.
- Plugin tool list changes are pushed to agents right away (server → pane-host topic `plugins.tools` → MCP) instead of being polled.

## [0.10.0] - 2026-10-23 — Plugin tools for agents, todo list

### Added
- Plugins can give tools to agents over MCP, the uTools way: declare them under `tools` in the manifest and implement them with `utools.registerTool` in the preload. Agents started in pane-remote see them as `plugin_<id>_<tool>`. The server runs the preload in a headless, sandboxed runtime (Node `--permission`, empty environment, no file or process access) when a tool is called, so the plugin does not need to be open on the phone. The first call asks for the `mcp` permission on the phone (always pushed); blocking hides the plugin's tools, an unanswered ask just fails that call.
- Tool handlers get `ctx.caller` (agent, pane, working directory).
- Plugin data now syncs live: changes made by a tool or another device reach open plugin pages, which get `utools.onDbPull` callbacks; pages resync after a dropped connection (`db.pull`).
- The **Todo** plugin: a todo list shared by all agents and shown on the phone. Agents add, list, update, complete and remove items (`plugin_todo_*`), with the agent, pane and project recorded; on the phone you can add, check off, edit, filter by status and project, delete, and undo.
- pane-host: `relay.serve` reverse channel and `plugins.tools.*` methods, so local programs (the agent MCP) can reach the server.
- Plugin API 0.3.0 (tools over MCP, `onDbPull`).

### Fixed
- The plugin connection has a 30 s heartbeat, so a phone whose app was backgrounded without closing its connection is no longer counted as "looking" (which suppressed pushes).
- The agent MCP no longer exits before answering when stdin closes right after the requests.

## [0.9.1] - 2026-10-23

### Changed
- The Mac stays awake for 30 minutes after the phone was last used (was about 2½ minutes), so an agent keeps working and the phone can reconnect; `PANE_AWAKE_SECS` changes it.
- AI calls through Codex use their own `CODEX_HOME` without `~/.codex/AGENTS.md` (about 2.1K fewer input tokens per call); the login is shared and kept in sync. `createAi({ codexHome: false })` turns it off.

## [0.9.0] - 2026-10-23 — Versions and changelog

### Added
- A version number for the whole system (root `package.json`), shown under More → What's new together with this changelog; after an update the app says which version it moved to.
- `GET /api/version` and `GET /api/changelog`.
- Plugin API version (currently 0.2.0), separate from the system version. Plugins can declare `paneRemote.requires` (e.g. `">=0.2.0"`) in `whatevertools.json`; plugins that need a newer API are not loaded and are listed with the reason.

### Changed
- The plugin platform reports the system version (`platform.info()`, `utools.getAppVersion()`) instead of a fixed 0.1.0, and adds `api` to `platform.info()`.

## [0.8.0] - 2026-10-22 — Single-client takeover

### Added
- One client at a time: opening the app on a device takes over; the previous device is told which device took over and gets a "continue on this device" button. The holder survives a restart.
- The controlled computer itself can no longer open the app (detected from pane-host's interface addresses and the client IP, independent of Tailscale); `ALLOW_HOST_ACCESS=1` turns this off.
- Browser preview and the screen module share one live input bar: keys go through as you type, IME-safe composition, phone-side paste, sticky ⌘⌥⌃⇧ modifiers and a shortcut panel.
- Preview handles Delete / Home / End / PgUp / PgDn / Space and passes ⌘A/C/X/V/Z as edit commands on macOS.

### Changed
- Plugin pages shrink with the iOS keyboard so bottom inputs stay visible.

### Fixed
- Concurrent preview restarts no longer fail with "Screencast is already active"; preview handles phone messages one at a time.
- Unreachable preview URLs show the host name and are no longer reported as incidents.
- Relay-mode tunnel self-heal works without sudo (e.g. inside a systemd unit with `NoNewPrivileges`) and reports when it cannot find the stuck session.

## [0.7.0] - 2026-10-22 — Direct TLS listener

### Added
- Optional direct TLS listener on the tailnet address instead of `tailscale serve`, so a phone waking from sleep reconnects at once (off by default).
- Cursor 3.26 support: messages from the agent transcript and a changes view for new sessions.
- Running Cursor `/loop` loops are shown above the composer.

### Changed
- Phone telemetry is queued during outages and replayed later; error toasts and connection drops are reported.
- A wedged connection (relay reachable, no frames) reloads the page automatically.
- The sessions sheet is capped at 85% height and has a close button.
- Cursor per-turn fork asks for confirmation first.

### Fixed
- Per-turn fork for new Cursor sessions.
- A slow Cursor debug-port probe no longer sticks at "not started for remote control".
- The screen module survives a mousectl restart, and one undecodable JPEG no longer freezes the view.

## [0.6.0] - 2026-10-21 — Plugin platform and pane-host

### Added
- pane-host: a resident service on the computer that pushes transcripts and events over one connection, with fallback to the bridge path; installed and managed by `init`, `start` / `stop` / `restart`, `doctor` and `update`.
- Plugin platform (`plugins` module, on by default): plugin drawer, capsule header and quit confirmation; Preview, This Mac and Screen become built-in plugins.
- Plugins can use AI (local Claude Code, Codex and cursor-agent as providers), the clipboard, open URLs and read files.
- Model and effort switching per session, for terminal agents and Cursor sessions.
- Hash routes: notifications and the inbox open one exact address.

### Changed
- One session list for panes and Cursor sessions; agent panes open in the chat view, with "Raw screen" for the terminal.
- Code-split web app with lazy-loaded panels.

### Fixed
- Relay mode self-heals a stuck tunnel that holds the tunnel port.
- The GUI fallback never auto-starts an empty mux server.
- Event offsets stay monotonic across log truncation.

## [0.5.0] - 2026-10-20 — Agent tools and incident reports

### Added
- Agent tools: a pane-remote plugin (MCP server + skill) for Claude Code, Codex and cursor-agent — notify or ask on the phone, open pages in the preview, read or send to other panes.
- Restart an idle agent session in place with the plugin loaded, restoring its background work afterwards.
- Incident reports: problems are collected, pushed to the phone and can be handed to an agent to fix; optional AI triage and a 10-minute canary.
- Resume a recent Claude session from the new-tab page (#1, thanks @Anduin9527).

### Changed
- Sends survive a phone waking up (warm-up request, retries for up to 20 s).

### Fixed
- The preview Chrome no longer keeps running after the service goes away (#2, thanks @Anduin9527).
- Screen module right and middle click work on a phone.
- Push notifications get a valid Topic for every tag.
- Events resume from the saved offset after a restart.
- Agent exit works even when Claude's exit dialog is clipped.

## [0.4.0] - 2026-10-20 — Screen module

### Added
- Screen module (optional, macOS): view and control the Mac's screen or a single window from the phone.
- Window tools: close windows, quit apps, resize; summon menu-bar apps and Spotlight.
- Optional auto keyboard when a text field is focused; typing works on the lock screen.
- `mac` module (optional): performance overview and text-to-speech.
- `pane-remote update`: safe, incremental updates from the https origin with preview, confirmation and automatic rollback.

### Changed
- Whole displays are captured with ScreenCaptureKit, falling back to Screen Sharing.
- A remotely unlocked session is kept for an hour after the phone leaves.
- Chat view transfers less data (304 when unchanged, gzip otherwise).

## [0.3.0] - 2026-10-18 — Cursor IDE support

### Added
- Cursor IDE module: mirror the running Cursor's sessions on the phone.
- Cursor chat actions: fork (whole chat or from a turn), pin / unpin, archive; shared time and copy row for Claude and Cursor replies.
- Cursor usage for the current billing cycle at the top of the session list.
- Change a pane's width on the computer from the phone (fit phone / ±10 / equalize the tab).
- English UI, CLI and docs.

### Fixed
- Network blips: send retry with dedupe and a 5 s heartbeat.
- Fullscreen detection tolerates up to 8 extra rows of size drift.
- The preview file browser keeps its address across agent restarts and opens relative paths against the session folder.

## [0.2.0] - 2026-10-17 — First public release

### Added
- Phone PWA to control WezTerm panes and Claude Code / Codex sessions, with a chat view built from the transcript.
- Basic mode (single Mac + `tailscale serve`) with installer, `doctor` and uninstall.
- Optional modules: browser preview, open-URL handoff to the phone, and an SSH-relay mode.
- MIT license.

### Changed
- iPhone: safe areas respected everywhere, toasts clear the notch, solid status bar, new-version notice in the header.
