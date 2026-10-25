# pane-remote

[中文](README.md) | English

View and control the terminals in WezTerm or Herdr on your Mac from your phone. Claude Code / Codex sessions get a dedicated chat view, push notifications and session management.
No third-party server is involved: phone and Mac talk over your own Tailscale network, and only your account can open it.

> The phone UI is in Chinese or English (follows the phone's language; switch in the ⋯ menu). Some labels below are quoted in Chinese with an English gloss.

## Terminal backends and agents

**WezTerm and Herdr are alternative terminal backends. Each pane-remote instance selects one, with WezTerm as the default.** Agents such as Codex and Claude Code run inside the panes they provide.

| Backend | List hierarchy | Setup |
|---|---|---|
| WezTerm (default) | Window → tab → pane | `pane-remote init --terminal wezterm` |
| Herdr | Workspace → tab → pane → its running agent | `pane-remote init --terminal herdr`; see [setup and limitations](docs/en/herdr.md) |

The list includes panes managed by the selected backend. Codex in other terminals and Codex desktop conversations are not automatically merged. Cursor IDE is a separate optional module. The Herdr list shows agent types and registered names; workspaces can collapse, and internal IDs remain in the action details.

Opening the page prioritizes a session specified in the URL, then the session last viewed in this browser, then the terminal's focused pane or the first available pane. Live output follows the viewed pane, but background status monitoring still scans all panes in the selected backend. Collapsing a workspace only affects presentation; per-workspace monitoring scope is not yet configurable.

## Features

**Basic** (available right after install)

- **One session list**: Panes from the selected terminal and (with the Cursor module) Cursor sessions in one list with the same status marks (waiting for you / done / running / new content); the address is the UI state (`#/s/p12`, `#/plugin/preview`), so pushes and the inbox jump straight there and the phone's back gesture works
- Panes with an agent session open in the chat view by default; 「原始画面」 (Raw screen) switches back to the terminal, remembered per pane
- **Model and reasoning effort**: the model chip in the session bar switches the model and effort of Claude Code / Codex / cursor-agent in one tap (only while the agent is idle; see [docs/en/agent.md](docs/en/agent.md#model-and-reasoning-effort))
- Live view of panes in the selected terminal backend; type and send keys from the phone (key bar, arrow joystick, Ctrl / Shift / Option), swipe to scroll, tap
- **Desktop layout**: open it in a browser on another computer (switches automatically on a wide screen with a mouse): the session list stays on the left, the terminal takes the keyboard directly (multi-line paste arrives as one block), and screen view uses the real mouse and keyboard. Handy for reaching your home computer from a laptop while travelling. Keyboard and mouse follow the device, not the window width: a narrow window or display scaling still works, and so does a phone or tablet with a keyboard, mouse or trackpad attached (full-screen programs get left / middle / right buttons, dragging and two-finger scrolling)
- Create tabs, split or close panes, rename tabs, and focus a pane on the Mac. WezTerm also supports width adjustment and equalizing a tab; Herdr currently supports right / down splits but not width adjustment or equalizing
- Claude Code / Codex:
  - Chat view (laid out from the session transcript, easier to read than the raw terminal)
  - **Fork session**: start a new session in a new pane with the full context of the current one (from the chat bar's 「分叉」 (Fork), the pane menu, or when splitting)
  - **Resume session**: the new-tab page lists recent Claude sessions in the chosen directory; tap one to continue it in a new pane with `--resume` (one already open in a pane just switches to it; one still running elsewhere, e.g. the Claude desktop app, is forked with its context instead)
  - New session in the same directory, common slash commands
  - Scheduled-task panel inside a session: see schedules and last results, run now / restart / stop
  - Warns when focus has moved to the background agent list and returns to the input box in one tap
- Push notifications when a pane is waiting for your choice / confirmation or a turn finishes (not sent while you are at the Mac)
- To-do inbox: handle every pane that is waiting on you in one place
- Upload files to the Mac, long-press to open links in terminal output
- Automatic and manual reconnect

**Optional modules**

| Module | What it does | How to enable |
|---|---|---|
| Preview browser | View web pages reachable from the Mac (localhost, intranet) and files (folders, images, video, PDF, Markdown, code) on the phone, with a desktop mode (desktop UA, landscape full screen); files downloaded in a page and the current page (a local file as-is, a web page as PDF) can be saved to the phone | On by default when Chrome is installed; `pane-remote enable preview` |
| Open URLs on phone | When something on the Mac opens a link while you are using the phone, open it in the phone's preview instead | `pane-remote enable openUrl` |
| Cursor mapping | View and drive the Cursor IDE from the phone: sessions, messages, to-do / unread, command output, change diffs, built-in browser | `pane-remote enable cursor`, see [docs/en/cursor.md](docs/en/cursor.md) |
| Screen view | View and control the Mac's screen (one display or a single window) from the phone: tap, drag, scroll, trackpad mode, typing (CJK included), multi-finger gestures, launching apps in the background. Signs in through macOS's built-in Screen Sharing; the picture is captured with ScreenCaptureKit and transcoded on the Mac before it travels. Also closes windows, quits apps, resizes windows, opens the keyboard on text fields and types on the lock screen | `pane-remote enable screen`, see [docs/en/screen.md](docs/en/screen.md) |
| This Mac | The Mac's performance on the phone (CPU, memory, top processes), and have the Mac read text aloud with the built-in say | `pane-remote enable mac`, see [docs/en/mac.md](docs/en/mac.md) |
| Agent tools | Claude Code / Codex / cursor-agent started from the phone load a pane-remote plugin: push when done, ask you on the phone when stuck, open pages in the phone preview; running sessions can "restart and load", with a snapshot before and background work restored after | Available by default, see [docs/en/agent.md](docs/en/agent.md) |
| Incident reports | Problems noticed by the server, the phone, Mac-side scripts and agents, deduplicated and counted; pushes asking whether to fix; one tap hands it to a bound session or a new agent, which reports back | Available by default, see [docs/en/incidents.md](docs/en/incidents.md) |
| Plugin platform | A floating button opens the plugin drawer: Preview, This Mac and Screen are built-in plugins, and uTools / whatevertools format plugins run too (`plugins/`); plugins can use the Claude Code / Codex / cursor-agent signed in on the Mac for AI and read folders you allow, each capability asked on the phone first | On by default; `pane-remote disable plugins` to turn off, see [docs/en/plugins.md](docs/en/plugins.md) |
| pane-host | Resident service on the Mac: pushes the chat view and events, and backs the plugins' AI, clipboard and read-only files; falls back automatically when offline | Installed as a LaunchAgent by `init`, see [docs/en/host.md](docs/en/host.md) |
| Relay mode | When the Mac itself can't run Tailscale, relay through a server in your tailnet | See [docs/en/relay.md](docs/en/relay.md) |
| Persistent panes | Panes survive closing the WezTerm window and stay reachable from the phone | See [docs/en/advanced.md](docs/en/advanced.md) |

## Requirements

| | |
|---|---|
| Computer | macOS (Apple silicon or Intel) |
| Terminal | [WezTerm](https://wezfurlong.org/wezterm/) by default (installed by the script), or [Herdr](docs/en/herdr.md) |
| Network | [Tailscale](https://tailscale.com), with Mac and phone signed in to the same account. Enable **MagicDNS** and **HTTPS Certificates** for the tailnet (admin console → DNS). Self-hosted Headscale usually can't issue HTTPS certificates and won't work |
| Phone / another computer | iPhone (iOS 16.4+ for push) or Android, with the Tailscale app; or a browser on another computer (with Tailscale) |
| Optional | Claude Code, Codex (chat view, fork, etc.); Chrome (preview browser); Cursor (Cursor module); Xcode command line tools (screen module) |

The default install script uses [Homebrew](https://brew.sh) for WezTerm and Tailscale. For Herdr, install Herdr and Tailscale yourself, then use `--no-brew --terminal herdr` as shown below. Node.js: the existing one (20+) is used; if there is none, the official build is downloaded from nodejs.org, checksum-verified, and used only by pane-remote.

## Install

```bash
git clone <repo-url> ~/pane-remote
cd ~/pane-remote
./install.sh
```

When it finishes, the terminal prints a `https://<mac-name>.<tailnet>.ts.net/` address (and a QR code if qrencode is installed). On the phone:

1. Open the Tailscale app and sign in with the same account as the Mac
2. Open that address in Safari
3. Share → Add to Home Screen, then open it from the home screen (push only works this way); turn on notifications from the bell in the top-right corner

**Restart any Claude / Codex sessions that were already open** so the new hooks take effect (needed for push and the chat view). For Codex, also confirm trust for the new hook inside Codex.

Common options:

```bash
./install.sh --yes                       # accept all defaults
./install.sh --chrome                    # no Chrome but want the preview browser: install Google Chrome via Homebrew
./install.sh --login you@example.com     # Tailscale account allowed to access (defaults to the Mac's account; required if the Mac is a tagged device)
./install.sh --no-brew                   # install your selected terminal backend and Tailscale yourself
./install.sh --no-brew --terminal herdr  # use an installed Herdr and its default local session
./install.sh --lang en                   # command-line output in English (defaults to the system language)
```

The language choice is saved in the config, so later `pane-remote` commands use it too. Every `pane-remote` command also accepts `--lang en|zh`, and the `PANE_REMOTE_LANG=en|zh` environment variable overrides the saved setting.

## Everyday commands

```bash
pane-remote doctor            # self-check; every problem comes with a fix
pane-remote status            # is the service running
pane-remote restart | logs
pane-remote stop | start      # stop / start the service; stop also closes the preview Chrome (it reopens next time you use preview)
pane-remote enable preview    # turn modules on / off: preview, openUrl, cursor, screen, mac, plugins
pane-remote disable openUrl
pane-remote init              # re-run after changing config, renaming the Mac or adding a Claude config dir (keeps existing config)
pane-remote uninstall         # stop the service, remove tailscale serve, restore hooks; --purge also deletes config and data
```

If the `pane-remote` command isn't on your PATH, use `~/pane-remote/bin/pane-remote`.

## Updating

```bash
pane-remote update --check     # only check: list incoming commits, changed files and the steps to run (exit code 0 = up to date, 10 = update available)
pane-remote update             # preview, ask for confirmation (y/N), then apply; add --yes when not running in a terminal
pane-remote update --rollback  # go back to the version before the last update
```

- **Updates only come from `origin`, and it must be an https URL.** The first `init` / `update` records the origin URL and branch as `updateSource` in the config; if origin is later changed to a different URL, update refuses (if you changed it on purpose, update `updateSource` too)
- Nothing from the fetched code runs before you confirm
- Update refuses when the working tree has local changes or local history has commits upstream doesn't have; it only fast-forwards (`git merge --ff-only`) and never resets, stashes or overwrites your changes
- Only the affected steps run: `package.json` / `package-lock.json` changed → reinstall npm dependencies (same flags as `install.sh`; sharp is added back when the screen module is on); mousectl source or installer changed and the screen module is on → reinstall mousectl; command line or hook script changed → re-merge the hooks (only in config files that already have them) and `bridge.env`; server, web UI, plugins or Mac-side scripts changed → restart the background service; `host/`, dependencies or transcript parsing changed → restart pane-host
- After applying, `doctor` runs: if a step fails or there are new problems compared with before the update, it rolls back to the old version automatically and redoes those steps with the old version
- Screen module: without a signing certificate from `--create-cert`, the installer won't rebuild an existing mousectl and update tells you so; with the certificate it rebuilds and the permissions survive (see [docs/en/screen.md](docs/en/screen.md))
- Changes to `install.sh` or `Brewfile` are not re-run automatically; update points you to the diff
- Relay mode: when the server needs updating too, update prints the commands to run at the end (also available any time as `pane-remote relay server-update`); it never connects to the server by itself
- `pane-remote doctor` mentions a new version based on the last fetch (no network access)

## Configuration

`~/.config/pane-remote/config.json` (created by init; run `pane-remote restart` after editing):

| Key | Meaning |
|---|---|
| `allowedLogins` | Tailscale login names allowed to access |
| `serveHosts` | Host names served by tailscale serve (filled in by init) |
| `port` | Local service port, default 8787 |
| `presets` | Launch commands offered when creating a pane, e.g. `{"label": "Claude Code", "command": "claude"}` |
| `claudeWrappers` | Claude config dir → launch command. With several `CLAUDE_CONFIG_DIR`s, forks and resumes must start with the same config dir |
| `modules` | Module switches |
| `paneHost` | Whether to connect to pane-host on the Mac (default `true`, see [docs/en/host.md](docs/en/host.md)) |

## Security

- The service listens only on `127.0.0.1`; `tailscale serve` provides HTTPS to your tailnet. Nothing is exposed to the public internet
- Every request must carry the visitor identity injected by tailscale serve (`Tailscale-User-Login`); anyone not in `allowedLogins` is rejected. The Host must also be your Mac's ts.net host name, which stops web pages in a browser on the Mac from calling the API through localhost
- Every state-changing (non-GET) request must come from the app's own pages (Origin / Sec-Fetch-Site checked), which stops other sites from riding on your identity
- All terminal operations go through `agent/bridge`: it accepts a fixed set of commands, validates every argument and never runs arbitrary shell
- The preview file server listens only locally, uses a random token in its URL and can read only your home directory and `/tmp`; generated pages have a strict CSP, Markdown is sanitized with DOMPurify, script libraries are served locally, and raw files are served in a sandbox
- Markdown in the preview only shows local images; remote images (badges etc.) are not loaded, so opening a file never makes outbound requests
- **Assumption: you are the only user of this Mac.** The service trusts identity headers on local 127.0.0.1 requests, which other users or malware on the Mac could forge; the headless Chrome used for preview (and Cursor's debug port when the Cursor module is on) is protected only by listening locally. (Then again, anything that can run programs on your Mac could drive your terminal directly.) In relay mode the relay server must also be yours alone
- **This is remote control of your Mac's terminal from your phone**: don't add other people's accounts to `allowedLogins`, and never expose it publicly with `tailscale funnel`

## FAQ

**The address shows "forbidden"**: the Tailscale account on the phone isn't in `allowedLogins`, or you opened it by IP instead of the ts.net address.

**Chat view or push does nothing**: the session was started before the hooks were installed; restart it. Check the hook item in `pane-remote doctor`.

**A yellow banner above the terminal says this Claude isn't saving its transcript**: Claude saves no transcript when it starts with `CLAUDE_CODE_CHILD_SESSION` (WezTerm was opened from inside another Claude session) or `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, so there is no chat view. Quit WezTerm with ⌘Q and reopen it from the Dock, or run `unset CLAUDE_CODE_CHILD_SESSION` in the pane before starting Claude; Claude sessions started, forked or restarted from the phone drop the first one automatically. `pane-remote doctor` checks the WezTerm and mux processes for both variables.

**Can't connect to WezTerm**: a WezTerm window must be open on the Mac; to work with windows closed, see the persistent setup in [docs/en/advanced.md](docs/en/advanced.md).

**tailscale serve fails**: HTTPS Certificates isn't enabled for the tailnet, or port 443 is taken by another service (init falls back to 8443 automatically).

## Layout

```
install.sh          one-step installer
bin/pane-remote     command entry (lib/cli.mjs)
server/             server (backend for the phone UI)
host/               pane-host: resident service on the Mac (pushed chat / events, AI providers, plugins' Mac-side capabilities)
platform/           plugin platform core (permissions, audit, capability table)
plugins/            plugin folder (two samples: hello, ai-demo)
agent/              Mac-side scripts: bridge (the shared terminal entry point), hooks, transcript parsing, preview browser, Cursor adapter, screen view (screen/), This Mac (mac/), agent plugin (plugin/, pane-agent)
web/                phone UI source (Svelte); build output goes to public/
relay/              helper commands for relay mode
scripts/audit.mjs   pre-release audit: personal info, internal addresses and secrets
docs/               extra docs (Chinese); docs/en/ has the English versions
```

After changing the frontend, rebuild with `npm run build` (installs dev dependencies in web/); `cd web && npm run size` checks the first-screen size (limit 150 KB gzip). Tests: `npm test`; after changing the frontend or the server, run the browser smoke test `node scripts/smoke.mjs` before restarting the service (needs Chrome; it starts a throwaway server locally and leaves yours alone), and don't ship if it fails.

## License

[MIT](LICENSE)
