# Herdr terminal backend

pane-remote can connect to one local Herdr session on macOS. WezTerm remains the default; selecting Herdr removes the requirement to install or run WezTerm.

## Setup

Install Herdr and start the session you want to control. For an existing pane-remote installation:

```bash
pane-remote init --terminal herdr
```

The default socket is `~/.config/herdr/herdr.sock`. Select a named session explicitly:

```bash
pane-remote init --terminal herdr \
  --herdr-socket "$HOME/.config/herdr/sessions/work/herdr.sock"
```

For a fresh installation, install Herdr and Tailscale first, then run `./install.sh --no-brew --terminal herdr`. The `--no-brew` option skips the default Brewfile, which installs WezTerm.

pane-remote never starts, upgrades or stops Herdr, and never falls back to another session on connection failure. Use `pane-remote doctor` to check the selected backend.

Alternatively, merge `"terminalBackend": "herdr"` and `"paths": {"herdrSocket": "/absolute/path/to/herdr.sock"}` into your existing `config.json`. Run `pane-remote refresh bridge-env` and `pane-remote restart` after editing. In relay mode, configure the backend on the controlled Mac, preserving its existing relay settings; do not rerun local-mode init.

Switch back with `pane-remote init --terminal wezterm`.

## Features and limits

- Lists panes by workspace/tab with titles, directories and terminal dimensions.
- Streams text/ANSI output and scrollback; sends UTF-8 text, Enter, control keys and paste bytes.
- Creates workspaces/tabs, splits right/down, closes panes, renames tabs and focuses a pane. Creation and splitting preserve desktop focus.
- Reuses Claude Code/Codex session discovery, transcripts, resume/fork and hook notifications. Transcripts still require the agent to save its history.
- Uses the same backend in pane-host and the bridge fallback. Hooks/MCP use the selected Herdr pane rather than the outer WezTerm pane.

A UI “window” maps to a Herdr workspace; “new window” creates a workspace. IDs remain opaque, including letters (`wA:pB`), with routes such as `#/s/pwA:pB`.

One instance selects one backend and one local socket. Multiple Herdr servers and Herdr machine forwarding are not aggregated. Width/equalize controls are hidden for Herdr; left/up splits are rejected. Adjust those layouts in Herdr. The public snapshot does not expose cursor coordinates; no cursor position is guessed. Dimensions come from the pane TTY when available, otherwise its layout rectangle.

Hooks from a different `HERDR_SOCKET_PATH` are ignored. With a custom pane-remote configuration, hook/MCP processes must inherit `PANE_REMOTE_CONFIG` or `PANE_REMOTE_BRIDGE_ENV` too.

## Verification

The adapter follows the [Herdr Socket API](https://herdr.dev/docs/socket-api/) and the schema/source for **Herdr 0.9.5, protocol 22**. `node --test agent/test/herdr.test.mjs` runs the real bridge, HTTP service, hooks and host adapter against a private socket fixture. `npm test` includes these tests. Run `npm run check --prefix web`, `npm run build --prefix web`, then `node scripts/smoke.mjs` (Chrome required) for frontend checks, including Herdr routes and keyboard input.

Protocol fixtures do not replace live acceptance testing. Before release, verify terminal display/input, pane creation/closure and real agent transcripts in a dedicated Herdr test session.

## Hierarchy and initial selection

The list follows Herdr's workspace → tab → pane hierarchy. A pane can host an agent; the agent type and optional registered name come from the same Herdr snapshot, rather than guesses based on the terminal title. Workspace headers can collapse their children.

Selecting Herdr includes only panes managed by the configured Herdr server. Codex or Claude Code can run inside those panes; Codex desktop conversations and agents in other terminals are not automatically merged. Each instance selects either Herdr or WezTerm; Cursor remains a separate optional module.

On opening the page, a session specified in the URL takes precedence, followed by the session last viewed in this browser, the terminal's focused pane, and finally the first available pane. Clicking a session updates the browser's remembered selection. A bookmark with a specific session continues to override that memory. There is currently no separate fixed home-session preference.

Collapsing a workspace only changes presentation. Terminal streams follow the viewed pane, with up to three previous streams retained for up to 45 seconds for quick switching. While the phone is active or push subscriptions exist, background status monitoring still periodically scans the end of every pane in the selected source. Per-workspace monitoring scope is not yet configurable.

Text reads use passive ANSI snapshots, stripping formatting locally, to avoid Herdr's interactive alternate-screen history harvesting. When Herdr omits TTY information, the adapter resolves it from local shell PIDs in one batch before reading the actual terminal dimensions.
