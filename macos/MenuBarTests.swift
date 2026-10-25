// Compiled as a temporary main.swift by test.sh. All CLI calls use a private
// fixture; these tests never start/stop a real service or inspect terminal panes.
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = MenuApp()
delegate.zh = false
delegate.item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
delegate.rebuild()
precondition(delegate.item.menu!.items.contains { $0.title == "Hide menu bar icon" })
delegate.hideIcon()
precondition(!delegate.item.isVisible)
precondition(delegate.applicationShouldHandleReopen(app, hasVisibleWindows: false))
precondition(delegate.item.isVisible)

let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pane-menu-test-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: directory) }
let fixture = directory.appendingPathComponent("cli.sh")
let script = """
/bin/sleep 0.15
printf '%s\\n' "$*" >> "$0.calls"
case "$*" in
  *--url*) url='"https://fixture.example/"' ;;
  *) url=null ;;
esac
printf '{"configured":true,"loaded":true,"response":200,"backend":"herdr","mode":"local","lang":"en","url":%s,"configPath":"/fixture/config","logPath":"/fixture/log"}\\n' "$url"
"""
try script.write(to: fixture, atomically: true, encoding: .utf8)
delegate.settings = Settings(node: "/bin/sh", cli: fixture.path, configPath: directory.appendingPathComponent("config.json").path)
func drain() {
    let deadline = Date().addingTimeInterval(5)
    while (delegate.refreshing || delegate.busy || delegate.pendingURLRefresh) && Date() < deadline {
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
    }
    precondition(!delegate.refreshing && !delegate.busy && !delegate.pendingURLRefresh, "async refresh did not finish")
    precondition(delegate.lastError == nil, delegate.lastError ?? "")
}
// A stronger refresh arriving during a passive one must be delivered afterwards.
delegate.refresh()
delegate.refresh(includeURL: true)
precondition(delegate.pendingURLRefresh)
drain()
precondition(delegate.pageURL?.absoluteString == "https://fixture.example/")
let calls = try String(contentsOfFile: fixture.path + ".calls", encoding: .utf8).split(separator: "\n")
precondition(calls.count == 2 && !calls[0].contains("--url") && calls[1].contains("--url"))

// Refreshes and completed commands must not restore a deliberately hidden icon.
delegate.hideIcon()
delegate.perform(["restart"])
delegate.refresh(includeURL: true)
drain()
precondition(!delegate.item.isVisible)
_ = delegate.applicationShouldHandleReopen(app, hasVisibleWindows: false)
drain()
precondition(delegate.item.isVisible)
NSStatusBar.system.removeStatusItem(delegate.item)
print("Native menu tests passed: hide/reopen, queued URL refresh, hidden command completion")
