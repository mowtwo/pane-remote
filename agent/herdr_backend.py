"""Herdr 0.9.5 socket adapter. No session discovery, server startup, or retries.

Wire format: https://herdr.dev/docs/socket-api/ (protocol 22).
The bridge exposes the existing pane-remote commands, never arbitrary API methods.
"""
import base64
import fcntl
import json
import os
import re
import socket
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

# Public numbers use Herdr’s base-32 alphabet (src/workspace.rs), not decimal.
PANE_RE = r"w[0-9A-HJKMNP-TV-Z]{1,13}:p[0-9A-HJKMNP-TV-Z]{1,13}"


def settings():
    config = {}
    file = os.environ.get("PANE_REMOTE_BRIDGE_ENV") or os.path.join(
        os.path.dirname(os.environ.get("PANE_REMOTE_CONFIG") or os.path.expanduser("~/.config/pane-remote/config.json")), "bridge.env")
    try:
        with open(file) as f:
            for line in f:
                key, sep, value = line.rstrip("\r\n").partition("=")
                if sep:
                    config[key] = value
    except FileNotFoundError:
        pass
    return config


def enabled():
    return settings().get("TERMINAL_BACKEND", "wezterm") == "herdr"


def valid_pane(pane):
    return bool(re.fullmatch(r"[0-9]{1,6}|" + PANE_RE, str(pane)))


def pane_value(pane):
    return int(pane) if str(pane).isdigit() else str(pane)


def current_pane():
    config = settings()
    if config.get("TERMINAL_BACKEND", "wezterm") == "herdr":
        pane = os.environ.get("HERDR_PANE_ID", "")
        target = config.get("HERDR_SOCKET") or os.path.expanduser("~/.config/herdr/herdr.sock")
        caller = os.environ.get("HERDR_SOCKET_PATH", "")
        # Different Herdr servers can both have w1:p1. Do not record their hooks here.
        if caller and os.path.realpath(caller) != os.path.realpath(target):
            return ""
        return pane if re.fullmatch(PANE_RE, pane) else ""
    pane = os.environ.get("WEZTERM_PANE", "")
    return pane if re.fullmatch(r"[0-9]{1,6}", pane) else ""


class Herdr:
    def __init__(self, socket_path=None, timeout=5):
        self.socket_path = socket_path or settings().get("HERDR_SOCKET") or os.path.expanduser("~/.config/herdr/herdr.sock")
        if not os.path.isabs(self.socket_path):
            raise ValueError("HERDR_SOCKET must be an absolute path")
        self.timeout = timeout

    def call(self, method, **params):
        request = {"id": "pane-remote", "method": method, "params": params}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(self.timeout)
            conn.connect(self.socket_path)
            conn.sendall(json.dumps(request, ensure_ascii=False).encode() + b"\n")
            with conn.makefile("rb") as stream:
                line = stream.readline((16 << 20) + 1)
            if not line.endswith(b"\n") or len(line) > 16 << 20:
                raise RuntimeError("Herdr returned an incomplete or oversized response")
        response = json.loads(line)
        if response.get("id") != request["id"]:
            raise RuntimeError("Herdr response id mismatch")
        if "error" in response:
            error = response["error"]
            raise RuntimeError(f"Herdr {error.get('code', 'error')}: {error.get('message', '')}")
        return response["result"]

    def processes(self, pane):
        return self.call("pane.process_info", pane_id=pane)["process_info"]

    def list(self):
        snap = self.call("session.snapshot")["snapshot"]
        tabs = {t["tab_id"]: t for t in snap["tabs"]}
        agents = {a["pane_id"]: a for a in snap.get("agents", [])}
        workspaces = {w["workspace_id"]: w for w in snap["workspaces"]}
        rects = {p["pane_id"]: p["rect"] for layout in snap["layouts"] for p in layout["panes"]}
        # 0.9.5 returns tty:null; recover it from local shell processes in one ps call.
        processes = {}
        for p in snap["panes"]:
            try:
                processes[p["pane_id"]] = self.processes(p["pane_id"])
            except (OSError, RuntimeError):
                pass
        pids = {str(info["shell_pid"]) for info in processes.values()
                if not info.get("tty") and isinstance(info.get("shell_pid"), int) and info["shell_pid"] > 0}
        tty_by_pid = {}
        if pids:
            try:
                result = subprocess.run(["/bin/ps", "-o", "pid=,tty=", "-p", ",".join(sorted(pids))],
                                        capture_output=True, text=True, timeout=2)
                for line in result.stdout.splitlines():
                    fields = line.split()
                    if len(fields) == 2 and fields[0] in pids and re.fullmatch(r"[A-Za-z0-9/_-]+", fields[1]):
                        tty_by_pid[fields[0]] = "/dev/" + fields[1]
            except (OSError, subprocess.SubprocessError):
                pass
        out = []
        for p in snap["panes"]:
            rect = rects.get(p["pane_id"], {})
            cols, rows = rect.get("width", 80), rect.get("height", 24)
            tty = ""
            try:
                info = processes.get(p["pane_id"], {})
                tty = info.get("tty") or tty_by_pid.get(str(info.get("shell_pid")), "")
                if tty.startswith("/dev/"):
                    fd = os.open(tty, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
                    try:
                        height, width, _, _ = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
                        if width and height:
                            cols, rows = width, height
                    finally:
                        os.close(fd)
            except (OSError, RuntimeError):
                pass  # A pane may disappear between snapshot and process_info.
            cwd = p.get("foreground_cwd") or p.get("cwd") or ""
            agent = agents.get(p["pane_id"], {})
            kind = agent.get("agent") or p.get("agent")
            out.append({
                "pane_id": p["pane_id"], "tab_id": p["tab_id"], "window_id": p["workspace_id"],
                "workspace": workspaces.get(p["workspace_id"], {}).get("label", p["workspace_id"]),
                "title": p.get("label") or p.get("terminal_title_stripped") or p.get("title") or p.get("agent") or "",
                "tab_title": tabs.get(p["tab_id"], {}).get("label", ""),
                "cwd": (Path(cwd).as_uri() if cwd else ""), "tty_name": tty,
                "size": {"cols": cols, "rows": rows}, "is_active": p["pane_id"] == snap.get("focused_pane_id"),
                # The public snapshot has no terminal cursor coordinates.
                "cursor_x": 0, "cursor_y": 0, "cursor_visibility": "Hidden",
                "backend": "herdr", "capabilities": {"width": False},
                "terminal_agent": {"kind": kind, "name": agent.get("name") or ""} if kind else None,
            })
        return out

    def read(self, pane, lines=200, escapes=False, source="recent"):
        # Text/recent reads can make Herdr scroll an idle alternate-screen agent to
        # harvest history. ANSI snapshots stay passive; strip formatting locally.
        text = self.call("pane.read", pane_id=pane, source=source, lines=lines,
                         format="ansi", strip_ansi=False)["read"]["text"]
        if escapes:
            return text
        text = re.sub(r"\x1b\].*?(?:\x07|\x1b\\)|\x1b[P^_X].*?\x1b\\", "", text, flags=re.S)
        return re.sub(r"(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-Z\\-_]", "", text)

    def send(self, pane, text):
        # send_text writes raw UTF-8 bytes (unlike send_input's bracketed paste).
        return self.call("pane.send_text", pane_id=pane, text=text)


def decode(value, limit=4096):
    if not value or len(value) > limit:
        raise ValueError("bad base64")
    return base64.b64decode(value, validate=True).decode("utf-8")


def directory(value):
    d = decode(value)
    if not os.path.isabs(d) or any(c in d for c in "\r\n\0") or not os.path.isdir(d):
        raise ValueError("directory does not exist")
    return d


def main():
    args = os.environ.get("SSH_ORIGINAL_COMMAND", "").split()
    if not args:
        raise ValueError("missing command")
    command, *args = args
    counts = {"list": (0, 0), "cursor": (1, 1), "text": (1, 2), "ansi": (1, 2), "watch": (1, 2),
              "send": (2, 2), "tails": (0, 0), "fg": (1, 1), "spawn": (2, 2), "split": (3, 3),
              "kill": (1, 1), "title": (1, 2), "focus": (1, 1), "mode": (0, 0), "width": (2, 2)}
    if command not in counts or not counts[command][0] <= len(args) <= counts[command][1]:
        raise ValueError("unsupported command or arguments")
    if command not in ("list", "tails", "spawn", "mode") and not re.fullmatch(PANE_RE, args[0]):
        raise ValueError("bad Herdr pane id")
    h = Herdr()
    if command in ("list", "cursor"):
        print(json.dumps(h.list(), ensure_ascii=False))
    elif command in ("text", "ansi", "watch"):
        count = args[1] if len(args) > 1 else "200"
        if not re.fullmatch(r"[0-9]{1,5}", count):
            raise ValueError("bad line count")
        if command != "watch":
            sys.stdout.write(h.read(args[0], int(count), command == "ansi"))
            return
        previous, idle = None, 0
        while True:
            text = h.read(args[0], int(count), True)
            if text != previous:
                # Match WezTerm's framing; never allow content to inject frames/heartbeats.
                sys.stdout.write(text.replace("\x1d", "").replace("\x1f", "") + "\x1d")
                previous, idle = text, 0
            elif idle % 20 == 19:
                sys.stdout.write("\x1f")
            sys.stdout.flush()
            idle += 1
            time.sleep(0.1 if idle < 20 else 0.25 if idle < 60 else 0.5)
    elif command == "send":
        h.send(args[0], decode(args[1], 65536))
    elif command == "tails":
        idle = 1000000000
        try:
            output = subprocess.check_output(["/usr/sbin/ioreg", "-c", "IOHIDSystem"], timeout=2).decode()
            match = re.search(r'"HIDIdleTime" = ([0-9]+)', output)
            if match:
                idle = int(match[1]) // 1000000000
        except (OSError, subprocess.SubprocessError):
            pass
        panes = h.list()
        print(f"idle {idle}")
        print(json.dumps(panes, ensure_ascii=False))
        for p in panes:
            print("\x1e" + p["pane_id"])
            try:
                print(h.read(p["pane_id"], 25, source="visible").replace("\x1e", ""))
            except (OSError, RuntimeError):
                pass
    elif command == "fg":
        procs = h.processes(args[0])
        foreground = procs.get("foreground_processes", [])
        leader = next((p for p in foreground if p["pid"] == procs.get("foreground_process_group_id")), None)
        print(os.path.basename((leader or (foreground[0] if foreground else {})).get("name", "")))
    elif command == "spawn":
        cwd = directory(args[1])
        if args[0] == "new":
            result = h.call("workspace.create", cwd=cwd, focus=False)
        else:
            if not re.fullmatch(r"w[0-9A-HJKMNP-TV-Z]{1,13}", args[0]):
                raise ValueError("bad Herdr workspace id")
            result = h.call("tab.create", workspace_id=args[0], cwd=cwd, focus=False)
        print(result["root_pane"]["pane_id"])
    elif command == "split":
        if args[1] not in ("right", "bottom"):
            raise ValueError("Herdr supports right and bottom splits")
        result = h.call("pane.split", target_pane_id=args[0], direction="down" if args[1] == "bottom" else "right",
                        cwd=directory(args[2]), focus=False)
        print(result["pane"]["pane_id"])
    elif command == "title":
        title = decode(args[1]) if len(args) > 1 else ""
        if len(title) > 80 or any(c in title for c in "\r\n\0"):
            raise ValueError("bad title")
        pane = h.call("pane.get", pane_id=args[0])["pane"]
        h.call("tab.rename", tab_id=pane["tab_id"], label=title)
    elif command in ("kill", "focus"):
        h.call("pane.close" if command == "kill" else "pane.focus", pane_id=args[0])
    elif command == "width":
        raise ValueError("Herdr pane width adjustment is not supported")
    elif command == "mode":
        print("herdr")


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        os._exit(0)
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)
